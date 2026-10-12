"""tests/_support.py —— 所有测试共用的「数据安全」脚手架。

原则：**测试绝不读写真实的 data/*.json**。
做法：把真实数据复制到一份隔离目录，再把 config.DATA_FILE / config.SETTINGS_FILE 指过去；
     跑完用 real_data_untouched() 核对真实文件一个字节都没变。

隔离目录默认在系统临时目录下（smart-scheduler-tests）；如果所在环境只允许写某个目录
（例如沙箱），用环境变量指定：

    Windows PowerShell:  $env:SS_TEST_DATA_DIR='D:\\tmp\\ss-tests'
    bash:                SS_TEST_DATA_DIR=/tmp/ss-tests python -m unittest discover -s tests
"""

import hashlib
import os
import shutil
import sys
import tempfile

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_DIR not in sys.path:
    sys.path.insert(0, PROJECT_DIR)

import config  # noqa: E402 - 必须先把项目目录加进 sys.path

DATA_NAMES = ("schedules.json", "settings.json")
REAL_FILES = {name: os.path.join(config.DATA_DIR, name) for name in DATA_NAMES}


def sha256(path: str) -> str:
    """文件的 SHA256；文件不存在返回 "MISSING"。"""
    if not os.path.exists(path):
        return "MISSING"
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


# 导入时就记下真实数据的指纹，之后任何时刻都能对比
REAL_SHA = {name: sha256(path) for name, path in REAL_FILES.items()}

_override = os.environ.get("SS_TEST_DATA_DIR")
FIXTURE_DIR = os.path.abspath(_override) if _override else os.path.join(
    tempfile.gettempdir(), "smart-scheduler-tests"
)


def _reset_database() -> None:
    """删掉隔离目录里的数据库（含 WAL 副文件），并把当前空间重置为默认空间。

    不这么做的话，上一个用例的空间与任务会留到下一个用例里 —— 测试就不可复现了。
    """
    import storage  # 延迟导入：避免 _support 在设置路径之前就把 storage 拉起来

    for suffix in ("", "-wal", "-shm"):
        path = config.DB_FILE + suffix
        if os.path.exists(path):
            os.remove(path)
    storage.set_current_space(storage.DEFAULT_SPACE)


def use_isolated_data(reset: bool = False) -> str:
    """把 config 的数据路径切到隔离目录。

    Args:
        reset: True 时重新从真实数据复制一份（每个用例开始都该 reset，
               免得上一个用例写进去的脏数据影响下一个）。

    Returns:
        str: 隔离目录的绝对路径。
    """
    os.makedirs(FIXTURE_DIR, exist_ok=True)
    for name, real in REAL_FILES.items():
        target = os.path.join(FIXTURE_DIR, name)
        if reset or not os.path.exists(target):
            if os.path.exists(real):
                shutil.copy2(real, target)
            else:
                with open(target, "w", encoding="utf-8") as fh:
                    fh.write("[]" if name == "schedules.json" else "{}")
    config.DATA_FILE = os.path.join(FIXTURE_DIR, "schedules.json")
    config.SETTINGS_FILE = os.path.join(FIXTURE_DIR, "settings.json")
    # 多用户版的数据库也必须指到隔离目录，否则测试会写到项目真实的 data/app.db
    config.DB_FILE = os.path.join(FIXTURE_DIR, "app.db")

    # 护栏：三个路径都必须在隔离目录里。写错一次就可能把测试数据灌进真实数据，
    # 所以这里直接断言，宁可测试报错也不要静默污染。
    for name in ("DATA_FILE", "SETTINGS_FILE", "DB_FILE"):
        value = os.path.abspath(getattr(config, name))
        if not value.startswith(os.path.abspath(FIXTURE_DIR) + os.sep):
            raise RuntimeError(f"{name} 没有指到隔离目录：{value}")

    if reset:
        _reset_database()
    return FIXTURE_DIR


def real_data_untouched() -> bool:
    """真实数据是否一个字节都没变。"""
    return {name: sha256(path) for name, path in REAL_FILES.items()} == REAL_SHA


# 导入 _support 即生效：后面 import task_manager / ui_components 时已经指向隔离目录
use_isolated_data(reset=True)
