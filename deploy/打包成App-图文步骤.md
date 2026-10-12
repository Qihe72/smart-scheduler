# 把「智能日程管家」打包成手机 App

> 目标：**Android** 得到一个能安装的安装包（APK）；**iPhone** 得到一个主屏图标（点开就是全屏，像 App 一样）。
>
> **前置（硬性）**：服务已经上线，能用 `https://你的域名` 打开 —— 见 [`部署指南-多用户.md`](部署指南-多用户.md)。
> 原因：PWABuilder 是拿你的**网址**去生成安装包的，没有公网地址它无从下手。

---

## 一、先确认你的站点"够格当 App"（3 条命令）

```bash
# ① 清单能打开（应输出一段 JSON）
curl -s https://你的域名/manifest.webmanifest | head -5

# ② service worker 能打开（应输出 JS）
curl -s https://你的域名/sw.js | head -3

# ③ 应用本身健康（应输出 ok）
curl -s https://你的域名/app/_stcore/health
```

再用**手机浏览器**打开 `https://你的域名`，看菜单里有没有「安装应用 / 添加到主屏幕」。
没有的话按顺序查：是不是 **https**（http 不行）→ 清单的 `start_url` 能不能打开 → `sw.js` 是不是 404。

> 这三样我们都已经备好了：`deploy/manifest.webmanifest`、`deploy/sw.js`、`deploy/icons/`（192 与 512 的真 PNG）。
> `sw.js` **刻意不缓存 `/app`** —— 应用数据在服务器上且多人共享，缓存它只会让人看到过期日程。

---

## 二、Android：用 PWABuilder 出安装包（约 10 分钟）

1. 打开 **https://www.pwabuilder.com**
2. 粘贴 `https://你的域名` → **Start**
3. 它会自动检测清单与 service worker 并打分（本项目已就绪，通常直接可用）
4. 点 **Package for stores** → 选 **Android** → **Download**
   - *Package ID*：建议 `com.你的名字.smartscheduler`（发布之后**不要再改**，否则等于另一个 App）
   - *App name / Short name*：`智能日程管家` / `日程管家`
   - *签名*：选 **Create new** —— 它会生成一个 keystore，**务必下载并长期保存**；
     以后想更新 App，必须用同一个 keystore 签名，否则手机不认、只能卸载重装
5. 解压下载的 zip，里面有两个文件：
   - `*.apk` —— 直接装到手机上用（个人/同学之间发这个）
   - `*.aab` —— 要上架 Google Play 才用（个人项目一般用不到）
6. 把 zip 或 apk 发到手机（微信文件传输助手 / 数据线 / 网盘都行）
7. 手机点开 APK → 系统提示"未知来源" → 允许安装 → 完成，桌面出现图标

### 2.1 去掉顶部那条网址（Digital Asset Links，强烈建议）

TWA（PWABuilder 打的包）默认在顶部显示网址条。要让 App **全屏、像原生一样**，
需要让**服务器认领这个 App**：

1. PWABuilder 打包完成后会给你一段 `assetlinks.json`（里面含 `package_name` 与 `sha256_cert_fingerprints`）；
2. 把它贴进本仓库的 `deploy/.well-known/assetlinks.json`（已放好模板，替换里面两处括号说明）；
3. 重启 Caddy：
   ```bash
   docker compose -f deploy/docker-compose.yml restart caddy
   ```
4. 验证：
   ```bash
   curl -s https://你的域名/.well-known/assetlinks.json    # 应返回你贴的那段 JSON
   ```
5. 手机上**卸载重装**这个 App（或等几小时），再打开就没有地址栏了。

> 不做这一步也能正常用，只是顶部多一条网址 —— 演示时想好看就做一下。

---

## 三、iPhone：添加到主屏幕（不需要 Mac）

1. **必须用 Safari**（Chrome / 微信内置浏览器都不行）
2. 打开 `https://你的域名` → 底部**分享**按钮 → **添加到主屏幕**
3. 名字改成「日程管家」→ 添加 → 桌面出现图标，点开即全屏

**iOS 的限制（苹果的规矩，不是本项目的问题）**：

- 不能像 Android 那样装 APK：上架 App Store 需要 **Mac + Xcode + 开发者账号（$99/年）**；
- 主屏 Web App 收不到推送通知、后台不常驻；
- 但日常"看课表 / 记 DDL / 改日程"完全够用。

---

## 四、把 App 发给同学

| 对方手机 | 你发什么 | 他做什么 |
|---|---|---|
| Android | APK 文件（或含 APK 的 zip） | 点开 → 允许"安装未知应用" → 装上即可 |
| iPhone | 一句 **`https://你的域名`** + "用 Safari 打开，分享 → 添加到主屏幕" | 30 秒搞定 |

**第一次打开**：链接里带着**空间码**（`?u=...`），App 会一直记住它；同学的链接里没有码就会自动领一个**新空间**，
所以**每个人看到的是自己的日程**，互相看不到。空间码在应用里「🔑 我的空间」面板可以随时查看/复制/扫码。

---

## 五、常见问题

| 现象 | 原因 / 处理 |
|---|---|
| PWABuilder 说找不到 manifest | 站点没上线，或路径不在根，或 Caddy 没配静态路由（对照 `deploy/Caddyfile` 里的 `@static`） |
| 打包后 App 打开是白屏 | 先确认网址本身能用（第一节三条命令）；再确认 WebSocket 没被挡（Caddy 的 `handle /app*`） |
| 装了但顶部有网址条 | 没做 2.1 的 assetlinks（可选，不影响使用） |
| 网站更新了 App 还是旧的 | App 内下拉刷新；必要时在系统设置里清该 App 的缓存 |
| 想换图标 / 名字 | 换 `deploy/icons/*.png`（保持 192/512）后重新部署，再用 PWABuilder 重新打包 |
| 想上架 Google Play | 需要一次性 $25 的开发者账号，用 zip 里的 `.aab` 上传；个人项目一般没必要 |
| 同学装完看到的是空白日程 | 正常：那是他自己的新空间；点「🔑 我的空间 → 导出/进入」或用带 `?u=` 的链接才能看到别人的空间 |
