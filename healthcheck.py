"""healthcheck.py —— 容器健康检查（单机与多用户两种模式都适用）。

为什么要单独一个文件：
    镜像既可能被单机使用（健康端点是 ``/_stcore/health``），
    也可能被多用户部署使用（Streamlit 加了 ``--server.baseUrlPath=app``，
    端点变成 ``/app/_stcore/health``）。写死任何一个，都会在另一种模式下
    永远报 unhealthy —— 而 Docker 的 HEALTHCHECK 一旦长红，
    ``docker run`` 的编排、监控、告警全都会被带偏。

所以这里两个路径都试，任一返回 ``ok`` 就算健康；都失败才退出 1。
"""

import sys
import urllib.request

PATHS = ("/app/_stcore/health", "/_stcore/health")
BASE = "http://localhost:8501"
TIMEOUT_SECONDS = 4


def main() -> int:
    """探测健康端点。

    Returns:
        int: 0 = 健康；1 = 两个端点都没返回 ok。
    """
    for path in PATHS:
        try:
            body = urllib.request.urlopen(f"{BASE}{path}", timeout=TIMEOUT_SECONDS).read()
        except Exception:  # noqa: BLE001 - 连不上就试下一个
            continue
        if body.strip() == b"ok":
            print(f"healthy: {path}")
            return 0
    print("unhealthy: 两个健康端点都没有返回 ok")
    return 1


if __name__ == "__main__":
    sys.exit(main())
