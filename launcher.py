"""
launcher.py —— 智能日程管家的一键启动脚本（由 启动.bat 调用，也可以直接 `python launcher.py`）。

它做四件事：
    1. 检查 Python 版本与依赖，缺依赖就自动 pip 安装（先走清华镜像，失败再走官方源）
    2. 检查 .env（没有就从 .env.example 生成一份，并提示要不要填 API Key）
    3. 选一个没被占用的端口（默认 8501，被占用就顺延）
    4. 启动 streamlit run main.py

说明：中文提示放在 Python 里而不是 .bat 里，是因为 cmd.exe 按系统 OEM 代码页解析
批处理文件的字节，UTF-8 的中文会把命令行拆坏（实测会报 "不是内部或外部命令"）。
"""

import importlib.util
import os
import shutil
import socket
import subprocess
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_PORT = 8501
PORT_TRIES = 10                      # 8501 被占用时依次试 8502...8510
MIRROR = "https://pypi.tuna.tsinghua.edu.cn/simple"

# 必需的第三方依赖（和 requirements.txt 保持一致）
REQUIRED_MODULES = (
    ("streamlit", "streamlit"),
    ("requests", "requests"),
    ("dotenv", "python-dotenv"),
)


def _say(message: str = "") -> None:
    """输出一行提示（实时刷新，避免被缓冲住看不到）。"""
    print(message, flush=True)


def check_python() -> bool:
    """检查 Python 版本是否够用（需要 3.10+）。

    Returns:
        bool: 版本满足要求返回 True。
    """
    major, minor = sys.version_info[:2]
    if (major, minor) < (3, 10):
        _say(f"[错误] 需要 Python 3.10 及以上，当前是 {major}.{minor}。")
        return False
    _say(f"[1/4] Python {major}.{minor}（{sys.executable}）")
    return True


def ensure_dependencies() -> bool:
    """检查依赖，缺了就自动安装。

    Returns:
        bool: 依赖齐全（或安装成功）返回 True。
    """
    missing = []
    for module_name, package_name in REQUIRED_MODULES:
        if importlib.util.find_spec(module_name) is None:
            missing.append(package_name)

    if not missing:
        _say("[2/4] 依赖已就绪。")
        return True

    _say(f"[2/4] 缺少依赖：{', '.join(missing)}，正在自动安装（首次启动需要一两分钟）...")
    requirements = str(BASE_DIR / "requirements.txt")

    for index, extra_index in enumerate((["-i", MIRROR], [])):
        cmd = [sys.executable, "-m", "pip", "install", "-r", requirements] + extra_index
        label = "清华镜像" if index == 0 else "官方源"
        _say(f"      使用{label}安装...")
        if subprocess.call(cmd, cwd=str(BASE_DIR)) == 0:
            # 安装完再确认一次，避免「装了一半」也算成功
            if all(importlib.util.find_spec(m) is not None for m, _ in REQUIRED_MODULES):
                _say("      依赖安装完成。")
                return True

    _say("[错误] 依赖安装失败，请手动执行：")
    _say(f"       {sys.executable} -m pip install -r requirements.txt")
    return False


def ensure_env_file() -> None:
    """确保存在 .env（不存在就从 .env.example 复制），并给出 Key 的提示。"""
    env_path = BASE_DIR / ".env"
    example_path = BASE_DIR / ".env.example"

    if not env_path.exists():
        if example_path.exists():
            shutil.copyfile(example_path, env_path)
            _say("[3/4] 已根据 .env.example 生成 .env 文件。")
        else:
            _say("[3/4] 没有找到 .env（AI 功能将不可用，手动模式正常）。")
            return
    else:
        _say("[3/4] 配置文件 .env 已存在。")

    # 读一下 Key 是否还是占位符
    try:
        content = env_path.read_text(encoding="utf-8-sig")
    except OSError:
        return

    # 任何一家服务商的 Key 填了都算数：config 会自动挑「配了 Key 的那一家」
    key = ""
    for line in content.splitlines():
        head = line.strip()
        if head.startswith("#") or "=" not in head:
            continue
        name, _, value = head.partition("=")
        if name.strip().endswith("_API_KEY") and value.strip():
            key = value.strip()
            break

    if not key or key == "your_api_key_here":
        _say("      提示：还没有填大模型 API Key（ZHIPU_API_KEY 或 DEEPSEEK_API_KEY），")
        _say("            手动添加 / 课程表导入 / 周视图都能正常用。")
        _say(f"            填法：编辑 {env_path} 把 your_api_key_here 换成你的 Key。")


def _port_available(port: int) -> bool:
    """检查端口是否空闲。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.4)
        return sock.connect_ex(("127.0.0.1", port)) != 0


def pick_port() -> int:
    """返回一个可用端口：优先 8501，被占用就往后找。

    Returns:
        int: 可用端口号。
    """
    for offset in range(PORT_TRIES):
        port = DEFAULT_PORT + offset
        if _port_available(port):
            if offset:
                _say(f"      端口 {DEFAULT_PORT} 被占用，改用 {port}。")
            return port
    return DEFAULT_PORT + PORT_TRIES


def main() -> int:
    """启动流程入口。

    Returns:
        int: 进程退出码（streamlit 的返回码）。
    """
    os.chdir(BASE_DIR)  # 无论从哪里调用，都切到项目目录

    _say("=" * 46)
    _say("            智能日程管家 Smart Scheduler")
    _say("=" * 46)

    if not check_python():
        return 1
    if not ensure_dependencies():
        return 1
    ensure_env_file()

    port = pick_port()
    _say(f"[4/4] 正在启动，浏览器会自动打开：http://localhost:{port}")
    _say("      关闭本窗口或按 Ctrl+C 即可停止服务。")
    _say("")

    cmd = [
        sys.executable, "-m", "streamlit", "run", str(BASE_DIR / "main.py"),
        "--server.port", str(port),
    ]
    # 自己开浏览器：不再依赖 Streamlit 的 headless 默认值（见问题 18）
    _open_browser_soon(port)
    try:
        return subprocess.call(cmd, cwd=str(BASE_DIR))
    except KeyboardInterrupt:
        _say("\n已停止。")
        return 0


def _open_browser_soon(port: int, delay: float = 3.0) -> None:
    """过几秒自动打开浏览器（放在后台线程里，不挡住服务启动）。

    为什么不用 Streamlit 的自动打开：那个行为由 `.streamlit/config.toml` 的 headless 决定，
    而部署（Docker / 云）要求 headless=true —— 一旦配置文件写成 true，
    本地双击启动就**静默**不再弹浏览器，用户看到的现象就是"打不开了"（问题 18）。
    所以这里自己开：配置文件怎么写都不影响本地体验。

    Args:
        port: Streamlit 正在监听的端口。
        delay: 等几秒再开，给服务一点启动时间。

    Returns:
        None
    """
    import threading
    import time
    import webbrowser

    def _open() -> None:
        time.sleep(delay)
        try:
            webbrowser.open(f"http://localhost:{port}")
        except Exception:  # noqa: BLE001 - 打不开浏览器不该影响服务本身
            pass

    threading.Thread(target=_open, daemon=True).start()


if __name__ == "__main__":
    sys.exit(main())
