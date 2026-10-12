/* ===========================================================================
 * sw.js —— Service Worker：只缓存「静态壳」，绝不缓存应用
 * ===========================================================================
 *
 * 【刻意取舍：为什么 /app 一个字节都不缓存】
 *   这个应用是**多用户**的：谁的日程存在服务器上，靠 URL 里的空间码（?u=xxxx）
 *   区分，服务端渲染出来的 HTML 里就带着那个人的日程内容。如果 SW 把 /app
 *   的响应缓存下来：
 *     · 用户 A 在这台手机上打开过，之后 B 用同一台手机打开，可能看到 A 的页面；
 *     · 用户自己改了日程，再打开却看到缓存里的旧日程（还以为没保存成功）；
 *     · 空间码是"知道即拥有"，缓存把页面留在设备上等于把访问凭证也留了下来。
 *   所以：/app 开头的所有请求**直接放行给网络**，不读缓存也不写缓存。
 *   代价是：离线时应用打不开（这是对的 —— 离线看到的是错的数据）。
 *
 *   我们只缓存 4 个几乎不变的静态文件（启动页、manifest、两个图标）：
 *   它们让「添加到主屏幕」那一下能秒开，且完全不含任何个人数据。
 * ===========================================================================
 */

// 改这里的版本号 = 强制刷新静态壳缓存（旧缓存会在 activate 时被删掉）
const SHELL_CACHE = "ss-shell-v1";

// 静态壳：只有这 4 个文件进缓存。都是 Caddy 直接发的静态文件。
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

// ---------------------------------------------------------------------------
// 安装：把静态壳预缓存下来
// ---------------------------------------------------------------------------
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // 逐个 add，单个失败不拖垮整个安装（比如图标还没传到服务器）
      await Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch((err) => {
            console.warn("[sw] 预缓存跳过：", url, err);
          })
        )
      );
      // 新 SW 立刻接管，不用等所有旧标签页关掉
      await self.skipWaiting();
    })()
  );
});

// ---------------------------------------------------------------------------
// 激活：删掉旧版本缓存
// ---------------------------------------------------------------------------
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith("ss-shell-") && n !== SHELL_CACHE)
          .map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

// ---------------------------------------------------------------------------
// 拦截：/app 直接放行；静态壳走「缓存优先 + 后台更新」
// ---------------------------------------------------------------------------
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // 只处理 GET；POST（Streamlit 的上传、表单）一律走网络
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // 跨域请求（比如字体、CDN）不插手
  if (url.origin !== self.location.origin) return;

  // ==== 关键规则：应用一律不缓存 ====
  // /app、/app/*、以及 Caddy 兜底跳转产生的任何应用内请求，全部交给网络。
  // 这里用 return 而不是 event.respondWith(...) —— 不拦截 = 浏览器原生行为，
  // 最不容易出岔子（尤其是 Streamlit 的 WebSocket 与长轮询）。
  if (url.pathname === "/app" || url.pathname.startsWith("/app/")) {
    return;
  }

  // Streamlit 的健康检查 / 静态资源也在 /app 下，上面的规则已经覆盖；
  // 再挡一次下划线开头的内部路径，防止将来路径改动漏网。
  if (url.pathname.startsWith("/_stcore")) return;

  // 静态壳：缓存优先，同时后台悄悄更新（stale-while-revalidate）
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(req, { ignoreSearch: true });

      const network = fetch(req)
        .then((res) => {
          // 只缓存正常的同源响应，别把 404/500 存进去
          if (res && res.ok && res.type === "basic") {
            cache.put(req, res.clone()).catch(() => {});
          }
          return res;
        })
        .catch(() => null);

      if (cached) return cached;               // 有缓存先给，快
      const fresh = await network;
      if (fresh) return fresh;                 // 没缓存就用网络结果

      // 网络也挂了：至少把启动页给出来（它自己会说"正在加载…"）
      const fallback = await cache.match("/index.html");
      if (fallback) return fallback;

      return new Response("离线，且没有可用缓存。", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    })()
  );
});
