"""部署产物自检：清单必填字段、图标是真 PNG、service worker 不缓存应用、Caddy 路由完整。

这些产物是"部署能不能成"的第一道防线，所以让它们也进 `python -m unittest`，
而不是只靠人工看一眼。
"""

import json
import os
import struct
import unittest

from tests import _support

PROJECT = _support.PROJECT_DIR
DEPLOY = os.path.join(PROJECT, "deploy")


def _read(rel: str) -> str:
    with open(os.path.join(DEPLOY, rel), encoding="utf-8") as fh:
        return fh.read()


class PwaAssets(unittest.TestCase):
    def test_manifest_has_required_fields(self):
        data = json.loads(_read("manifest.webmanifest"))
        for key in ("name", "short_name", "start_url", "display", "icons", "theme_color"):
            self.assertIn(key, data)
        self.assertEqual(data["display"], "standalone")
        sizes = [icon["sizes"] for icon in data["icons"]]
        self.assertIn("192x192", sizes)
        self.assertIn("512x512", sizes)

    def test_icons_are_real_png_of_announced_size(self):
        for size in (192, 512):
            with open(os.path.join(DEPLOY, "icons", f"icon-{size}.png"), "rb") as fh:
                blob = fh.read()
            self.assertEqual(blob[:8], b"\x89PNG\r\n\x1a\n")
            width, height = struct.unpack(">II", blob[16:24])
            self.assertEqual((width, height), (size, size))
            self.assertGreater(len(blob), 500)

    def test_service_worker_passes_the_app_through(self):
        """应用（/app 与 /_stcore）必须直接放行 —— 缓存它就会看到过期日程。"""
        js = _read("sw.js")
        self.assertIn("/app", js)
        self.assertTrue('url.pathname === "/app"' in js or 'startsWith("/app")' in js)
        self.assertIn("respondWith", js)          # 静态壳仍然要缓存

    def test_launcher_page_wires_manifest_and_app(self):
        html = _read("index.html")
        self.assertIn('rel="manifest"', html)
        self.assertIn('src="/app"', html)         # iframe 嵌子路径应用
        self.assertIn("apple-touch-icon", html)


class ServerAssets(unittest.TestCase):
    def test_caddyfile_routes_app_and_static(self):
        caddy = _read("Caddyfile")
        self.assertIn("handle /app*", caddy)
        self.assertIn("reverse_proxy app:8501", caddy)
        self.assertIn("file_server", caddy)
        self.assertIn("example.com", caddy)        # 提醒用户必须改域名

    def test_compose_has_persistent_volume_and_multiuser(self):
        compose = _read("docker-compose.yml")
        self.assertIn("scheduler-data:/app/data", compose)   # 数据必须落到卷里
        self.assertIn("SS_MULTIUSER", compose)
        self.assertIn("baseUrlPath=app", compose)
        self.assertIn("caddy:2", compose)
        for port in ("80:80", "443:443"):
            self.assertIn(port, compose)

    def test_guide_covers_the_honest_limits(self):
        guide = _read("部署指南-多用户.md")
        self.assertIn("/app/_stcore/health", guide)          # 验证命令
        self.assertIn("down -v", guide)                      # 别删卷
        self.assertIn("没有密码", guide)                      # 空间码的诚实说明
        self.assertIn("Streamlit Cloud", guide)              # 为什么不能用免费云

    def test_dockerfile_copies_every_module(self):
        """每个 .py 模块都必须被 Dockerfile COPY —— 漏一个会静默失效（见 README 问题 17）。"""
        with open(os.path.join(PROJECT, "Dockerfile"), encoding="utf-8") as fh:
            dockerfile = fh.read()
        modules = sorted(name for name in os.listdir(PROJECT)
                         if name.endswith(".py") and not name.startswith("test_"))
        missing = [name for name in modules if name not in dockerfile]
        self.assertEqual(missing, [], f"这些模块没被 COPY 进镜像：{missing}")


class ContainerHealthcheck(unittest.TestCase):
    """镜像自带的健康检查必须同时适配单机与多用户两种路径。"""

    def test_healthcheck_script_probes_both_paths(self):
        path = os.path.join(PROJECT, "healthcheck.py")
        self.assertTrue(os.path.exists(path), "healthcheck.py 应该由 Dockerfile 使用")
        with open(path, encoding="utf-8") as fh:
            script = fh.read()
        self.assertIn("/app/_stcore/health", script)
        self.assertIn("/_stcore/health", script)
        self.assertIn('== b"ok"', script)

    def test_dockerfile_uses_that_script(self):
        with open(os.path.join(PROJECT, "Dockerfile"), encoding="utf-8") as fh:
            dockerfile = fh.read()
        self.assertIn("HEALTHCHECK", dockerfile)
        self.assertIn("healthcheck.py", dockerfile)
        # 不能在 HEALTHCHECK 里写死单个端点（多用户模式下会永远 unhealthy）
        self.assertNotIn('== b\'ok\'', dockerfile)


class AppPackaging(unittest.TestCase):
    """手机 App 打包的配套（PWABuilder 路线）。"""

    def test_assetlinks_template_is_valid_json(self):
        path = os.path.join(DEPLOY, ".well-known", "assetlinks.json")
        self.assertTrue(os.path.exists(path), "TWA 去掉地址栏要用这个文件")
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        self.assertIsInstance(data, list)
        target = data[0]["target"]
        self.assertEqual(target["namespace"], "android_app")
        self.assertIn("package_name", target)
        self.assertIn("sha256_cert_fingerprints", target)

    def test_caddy_serves_well_known(self):
        caddy = _read("Caddyfile")
        self.assertIn(".well-known", caddy)

    def test_compose_mounts_well_known(self):
        compose = _read("docker-compose.yml")
        self.assertIn(".well-known", compose)

    def test_manifest_has_id_for_installability(self):
        data = json.loads(_read("manifest.webmanifest"))
        self.assertIn("id", data)

    def test_packaging_guide_covers_both_platforms(self):
        guide = _read("打包成App-图文步骤.md")
        for keyword in ("pwabuilder.com", "assetlinks", "Safari", "未知来源", "空间码"):
            self.assertIn(keyword, guide)
