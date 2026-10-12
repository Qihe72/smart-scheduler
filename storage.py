"""storage.py —— 多用户存储层：SQLite + 「空间码」隔离。

为什么这样设计
--------------
* 原来的 `data/schedules.json` 是**一个共享文件**：谁打开都看到同一份日程。
  单机自用没问题，一旦挂到公网给同学用就会互相串数据 —— 这是"让大家都能用"的真正拦路石。
  所以任务与设置都改成按「空间码（space）」隔离地存进 SQLite。
* 任务仍然以**整条 JSON** 存一行（而不是拆成字段列）：这样 `task` 字典的契约完全不变，
  `task_manager` 里的归一化、三种状态判定、周次规则一行都不用改，改动面最小、可以随时回退。
* 只用标准库 `sqlite3`：不引入新依赖；单文件数据库（`data/app.db`）好备份、好搬走。
* 打开 WAL + `busy_timeout`：Streamlit 每个浏览器会话是独立的执行流，
  多人同时写同一个库也不会互相锁死。

术语
----
空间码（space）—— 免注册的身份。第一次访问由程序生成并放进 URL（`?u=xxxx`），
手机"添加到主屏幕"之后就不用再输。**知道这个码的人 = 拥有那份日程**，没有密码。

诚实的边界
----------
空间码是"知道即拥有"，所以界面上会写明：别放敏感信息；同时提供
「导出我的数据」与「删除我的空间」两个出口。真要做账号密码，是这一层的升级版。
"""

import json
import logging
import os
import re
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime

try:  # pragma: no cover - 取决于调用方式
    from . import config
except ImportError:  # pragma: no cover
    import config

logger = logging.getLogger(__name__)

DB_FILENAME = "app.db"          # 数据库文件名（放在 config.DATA_DIR 下）
SPACE_PARAM = "u"               # URL 里的空间码参数名
SPACE_CODE_BYTES = 8            # 空间码随机字节数（token_urlsafe → 约 11 个字符）
DEFAULT_SPACE = "local"         # 没有多用户身份时的默认空间（本机自用）
SPACE_NAME_MAX = 24
SQL_TIMEOUT_SECONDS = 5.0       # 等锁时间：多人同时写时先等，而不是立刻报错

# 当前请求的空间码：每个 Streamlit 重跑由 main.py 设置一次
_current_space = {"code": None}

_FALLBACK_SETTINGS = {"semester_start": None, "period_times": {}}


# ---------------------------------------------------------------------------
# 连接与建表
# ---------------------------------------------------------------------------
def db_path() -> str:
    """数据库文件路径（读 config.DB_FILE，便于测试时改到隔离目录）。"""
    return getattr(config, "DB_FILE", os.path.join(config.DATA_DIR, DB_FILENAME))


def _connect() -> sqlite3.Connection:
    """打开数据库连接（自动建目录、开 WAL、设等锁时间）。"""
    os.makedirs(os.path.dirname(db_path()) or ".", exist_ok=True)
    conn = sqlite3.connect(db_path(), timeout=SQL_TIMEOUT_SECONDS)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")       # 读写并发更好，且崩溃更安全
    conn.execute("PRAGMA busy_timeout=5000")      # 被锁住时等 5 秒再放弃
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def _cursor():
    """打开连接 → 成功提交 / 异常回滚 → **一定关闭**。

    为什么不用 `with sqlite3.connect(...) as conn`：那个写法只管理事务，
    连接不会被关闭。每次读写都漏一个连接的话，Windows 上 sqlite 文件会一直被占用，
    测试里「删掉数据库重建」会直接报 WinError 32，长期跑也会堆积文件句柄。
    """
    conn = _connect()
    try:
        with conn:            # 事务边界：正常提交，异常回滚
            yield conn
    finally:
        conn.close()


def init_db() -> None:
    """建表（幂等，可以每次启动都调）。"""
    with _cursor() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS spaces (
                code         TEXT PRIMARY KEY,
                name         TEXT NOT NULL DEFAULT '',
                created_at   TEXT NOT NULL,
                last_seen_at TEXT
            );
            CREATE TABLE IF NOT EXISTS tasks (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                space      TEXT NOT NULL,
                payload    TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_tasks_space ON tasks(space);
            CREATE TABLE IF NOT EXISTS settings (
                space      TEXT PRIMARY KEY,
                payload    TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )


def _now() -> str:
    """当前时间字符串（YYYY-MM-DD HH:MM:SS）。"""
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# ---------------------------------------------------------------------------
# 空间（身份）
# ---------------------------------------------------------------------------
def normalize_space(code) -> str:
    """把用户给的空间码洗干净：只留 URL 安全字符，并限制长度。

    Args:
        code: 原始空间码（可能来自 URL、输入框）。

    Returns:
        str: 合法空间码；空/非法返回空字符串。
    """
    text = str(code or "").strip()
    text = re.sub(r"[^A-Za-z0-9_-]", "", text)
    if not text:
        return ""
    return text[:32]


def new_space_code() -> str:
    """生成一个没被占用的空间码。

    Returns:
        str: 形如 ``kQ3fZ_a91Bx`` 的空间码。
    """
    init_db()
    for _ in range(20):
        code = secrets.token_urlsafe(SPACE_CODE_BYTES)
        with _cursor() as conn:
            row = conn.execute("SELECT 1 FROM spaces WHERE code = ?", (code,)).fetchone()
        if row is None:
            return code
    # 极端情况：退回带时间戳的码，保证一定拿得到一个
    return f"{int(datetime.now().timestamp())}{secrets.token_hex(3)}"


def ensure_space(code=None, name: str = "") -> str:
    """确保空间存在（不存在就建），返回最终使用的空间码。

    Args:
        code: 想用的空间码；为空时使用 DEFAULT_SPACE。
        name: 可选昵称。

    Returns:
        str: 空间码；数据库不可用时返回传入的码（保证界面还能降级运行）。
    """
    target = normalize_space(code) or DEFAULT_SPACE
    try:
        init_db()
        with _cursor() as conn:
            row = conn.execute("SELECT code FROM spaces WHERE code = ?", (target,)).fetchone()
            if row is None:
                conn.execute(
                    "INSERT INTO spaces (code, name, created_at, last_seen_at) VALUES (?, ?, ?, ?)",
                    (target, str(name or "")[:SPACE_NAME_MAX], _now(), _now()),
                )
            else:
                conn.execute("UPDATE spaces SET last_seen_at = ? WHERE code = ?",
                             (_now(), target))
    except sqlite3.Error as exc:
        logger.error("ensure_space 失败（降级为直传空间码）：%s", exc)
    return target


def current_space() -> str:
    """当前请求的空间码（没设置过就用默认空间）。"""
    return _current_space["code"] or DEFAULT_SPACE


def set_current_space(code) -> str:
    """设置当前请求的空间码（main.py 每轮开局调一次）。

    Args:
        code: 空间码。

    Returns:
        str: 设置后的空间码。
    """
    _current_space["code"] = normalize_space(code) or DEFAULT_SPACE
    return _current_space["code"]


def space_info(code=None) -> dict:
    """取空间信息（给「我的空间」面板用）。

    Returns:
        dict: {"code", "name", "created_at", "task_count"}；查不到时 task_count 为 0。
    """
    target = normalize_space(code) or current_space()
    info = {"code": target, "name": "", "created_at": "", "task_count": 0}
    try:
        init_db()
        with _cursor() as conn:
            row = conn.execute(
                "SELECT name, created_at FROM spaces WHERE code = ?", (target,)
            ).fetchone()
            if row is not None:
                info["name"] = str(row["name"] or "")
                info["created_at"] = str(row["created_at"] or "")
            count = conn.execute(
                "SELECT COUNT(*) AS n FROM tasks WHERE space = ?", (target,)
            ).fetchone()
            info["task_count"] = int(count["n"]) if count else 0
    except sqlite3.Error as exc:
        logger.error("space_info 失败：%s", exc)
    return info


def rename_space(code, name) -> bool:
    """给空间起个名字（纯展示用，方便认领）。"""
    target = normalize_space(code) or current_space()
    try:
        with _cursor() as conn:
            conn.execute("UPDATE spaces SET name = ? WHERE code = ?",
                         (str(name or "")[:SPACE_NAME_MAX], target))
        return True
    except sqlite3.Error as exc:
        logger.error("rename_space 失败：%s", exc)
        return False


def delete_space(code=None) -> bool:
    """删掉一个空间及其全部任务与设置（不可恢复）。

    界面上有二次确认；这里也只做该做的事，不做额外保护。
    """
    target = normalize_space(code) or current_space()
    if target == DEFAULT_SPACE:
        logger.warning("拒绝删除默认空间 %s", DEFAULT_SPACE)
        return False
    try:
        with _cursor() as conn:
            conn.execute("DELETE FROM tasks WHERE space = ?", (target,))
            conn.execute("DELETE FROM settings WHERE space = ?", (target,))
            conn.execute("DELETE FROM spaces WHERE code = ?", (target,))
        return True
    except sqlite3.Error as exc:
        logger.error("delete_space 失败：%s", exc)
        return False


def list_spaces() -> list:
    """列出所有空间（只用于本机排查/运维，不在界面上暴露）。"""
    try:
        init_db()
        with _cursor() as conn:
            rows = conn.execute(
                "SELECT code, name, created_at, last_seen_at FROM spaces ORDER BY created_at"
            ).fetchall()
        return [dict(row) for row in rows]
    except sqlite3.Error as exc:
        logger.error("list_spaces 失败：%s", exc)
        return []


# ---------------------------------------------------------------------------
# 任务读写
# ---------------------------------------------------------------------------
def load_tasks(space=None) -> list:
    """读取某个空间的任务列表。

    Args:
        space: 空间码；不传则用当前空间。

    Returns:
        list: 任务 dict 列表（按写入顺序）；出错返回 []（不抛异常）。
    """
    target = normalize_space(space) or current_space()
    try:
        init_db()
        with _cursor() as conn:
            rows = conn.execute(
                "SELECT payload FROM tasks WHERE space = ? ORDER BY id", (target,)
            ).fetchall()
    except sqlite3.Error as exc:
        logger.error("读取任务失败（space=%s）：%s", target, exc)
        return []

    tasks = []
    for row in rows:
        try:
            item = json.loads(row["payload"])
        except (TypeError, ValueError):
            logger.warning("跳过一条损坏的任务记录（space=%s）", target)
            continue
        if isinstance(item, dict):
            tasks.append(item)
    return tasks


def save_tasks(tasks: list, space=None) -> bool:
    """整体覆盖写某个空间的任务列表（在同一个事务里删旧+插新）。

    Args:
        tasks: 完整任务列表。
        space: 空间码；不传则用当前空间。

    Returns:
        bool: 成功 True，失败 False（不抛异常）。
    """
    if not isinstance(tasks, list):
        logger.error("save_tasks 需要 list，收到 %s", type(tasks).__name__)
        return False
    target = normalize_space(space) or current_space()
    try:
        init_db()
        with _cursor() as conn:
            conn.execute("DELETE FROM tasks WHERE space = ?", (target,))
            conn.executemany(
                "INSERT INTO tasks (space, payload, updated_at) VALUES (?, ?, ?)",
                [(target, json.dumps(t, ensure_ascii=False), _now())
                 for t in tasks if isinstance(t, dict)],
            )
        return True
    except (sqlite3.Error, TypeError, ValueError) as exc:
        logger.error("写入任务失败（space=%s）：%s", target, exc)
        return False


# ---------------------------------------------------------------------------
# 设置读写（学期起点、校准后的作息 —— 也是每人一份）
# ---------------------------------------------------------------------------
def load_settings_raw(space=None) -> dict:
    """读取某个空间的原始设置 dict（校验交给调用方）。

    Returns:
        dict: 设置内容；没有记录或出错返回 {}（调用方用默认值兜底）。
    """
    target = normalize_space(space) or current_space()
    try:
        init_db()
        with _cursor() as conn:
            row = conn.execute(
                "SELECT payload FROM settings WHERE space = ?", (target,)
            ).fetchone()
    except sqlite3.Error as exc:
        logger.error("读取设置失败（space=%s）：%s", target, exc)
        return {}
    if row is None:
        return {}
    try:
        data = json.loads(row["payload"])
    except (TypeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_settings_raw(settings: dict, space=None) -> bool:
    """写入某个空间的设置（整体覆盖）。"""
    if not isinstance(settings, dict):
        logger.error("save_settings_raw 需要 dict")
        return False
    target = normalize_space(space) or current_space()
    try:
        init_db()
        with _cursor() as conn:
            conn.execute(
                "INSERT INTO settings (space, payload, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(space) DO UPDATE SET payload = excluded.payload, "
                "updated_at = excluded.updated_at",
                (target, json.dumps(settings, ensure_ascii=False), _now()),
            )
        return True
    except (sqlite3.Error, TypeError, ValueError) as exc:
        logger.error("写入设置失败（space=%s）：%s", target, exc)
        return False


# ---------------------------------------------------------------------------
# 旧数据迁移（一次性）
# ---------------------------------------------------------------------------
def _legacy_task_file() -> str:
    """旧版任务文件路径（data/schedules.json）。"""
    return getattr(config, "DATA_FILE", os.path.join(config.DATA_DIR, "schedules.json"))


def _legacy_settings_file() -> str:
    """旧版设置文件路径（data/settings.json）。"""
    return getattr(config, "SETTINGS_FILE", os.path.join(config.DATA_DIR, "settings.json"))


def _read_json_file(path: str):
    """读一个 JSON 文件；不存在/损坏返回 None（迁移用，失败就当没有旧数据）。"""
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8-sig") as fh:
            content = fh.read().strip()
        return json.loads(content) if content else None
    except (OSError, ValueError) as exc:
        logger.error("读取旧数据文件 %s 失败：%s", path, exc)
        return None


def migration_done(space=None) -> bool:
    """这个空间是否已经迁移过旧 JSON。"""
    target = normalize_space(space) or current_space()
    try:
        with _cursor() as conn:
            row = conn.execute("SELECT value FROM meta WHERE key = ?",
                               (f"migrated:{target}",)).fetchone()
        return row is not None
    except sqlite3.Error:
        return False


def migrate_legacy_json(space=None) -> dict:
    """把旧的 `data/schedules.json` 与 `data/settings.json` 一次性导进某个空间。

    设计取舍：
        * 只导**一次**：导完在 meta 里记一笔，重启多少次都不会重复导入（也就不会翻倍）；
        * **不删除也不改名**旧文件：留着当备份，符合项目一贯做法（数据只增不删）；
        * 目标空间里已经有数据时**跳过**导入，避免把用户后来录的日程冲掉。

    Args:
        space: 目标空间码；不传用当前空间。

    Returns:
        dict: {"migrated": bool, "tasks": 导入条数, "settings": bool, "reason": str}
    """
    target = normalize_space(space) or current_space()
    result = {"migrated": False, "tasks": 0, "settings": False, "reason": ""}

    # 旧 data/schedules.json 只属于**这台机器的主人**（默认空间）。
    # 多用户模式下新发的空间绝不能继承它 —— 否则每个新访客一打开就看见机主的真实课表。
    if target != DEFAULT_SPACE:
        result["reason"] = "只有默认空间会继承旧的本地数据（新空间必须是空的）"
        return result

    if migration_done(target):
        result["reason"] = "已经迁移过"
        return result

    tasks = _read_json_file(_legacy_task_file())
    settings = _read_json_file(_legacy_settings_file())

    if tasks is None and settings is None:
        result["reason"] = "没有旧数据文件"
        _mark_migrated(target)
        return result

    existing = load_tasks(target)
    if existing:
        result["reason"] = "目标空间已有数据，跳过导入（避免覆盖）"
        _mark_migrated(target)
        return result

    if isinstance(tasks, list) and tasks:
        if save_tasks([t for t in tasks if isinstance(t, dict)], target):
            result["tasks"] = len(tasks)
    if isinstance(settings, dict) and settings:
        if save_settings_raw(settings, target):
            result["settings"] = True

    _mark_migrated(target)
    result["migrated"] = bool(result["tasks"] or result["settings"])
    result["reason"] = "迁移完成" if result["migrated"] else "旧文件里没有可用数据"
    logger.info("旧 JSON 迁移到空间 %s：%s", target, result)
    return result


def _mark_migrated(space: str) -> None:
    """在 meta 表里记下「这个空间迁移过了」。"""
    try:
        with _cursor() as conn:
            conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
                         (f"migrated:{space}", _now()))
    except sqlite3.Error as exc:
        logger.error("记录迁移标记失败：%s", exc)


# ---------------------------------------------------------------------------
# 身份解析：这次请求用哪个空间
# ---------------------------------------------------------------------------
def multi_user_enabled() -> bool:
    """是否开启多用户模式。

    服务器上设 `SS_MULTIUSER=1` 打开；你自己的电脑上不设，就是单机自用模式
    （旧数据迁进默认空间 local，体验和以前一模一样）。
    """
    return str(os.environ.get("SS_MULTIUSER", "")).strip().lower() in ("1", "true", "yes", "on")


def resolve_space_code(url_code=None) -> tuple:
    """决定这次请求用哪个空间码。

    规则（顺序很重要）：
        1. URL 里带了 `?u=xxxx` → 用它（不存在就建一个）；
        2. 多用户模式且没带 → **生成一个新的**，由调用方写回 URL
           （这样每个新访客自动有自己的空间，不会看到别人的日程）；
        3. 单机模式且没带 → 用默认空间 `local`（旧数据就迁到这里）。

    Args:
        url_code: URL 里的空间码（可为 None）。

    Returns:
        tuple: (空间码, 是否是这次新生成的)
    """
    cleaned = normalize_space(url_code)
    if cleaned:
        return ensure_space(cleaned), False
    if multi_user_enabled():
        code = new_space_code()
        return ensure_space(code), True
    return ensure_space(DEFAULT_SPACE), False
