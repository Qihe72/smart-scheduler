"""小程序工程验证脚本（我自己复跑，不只看子代理的汇报）。

检查项：
  1. 必需文件是否齐全（含五个页面的四件套）
  2. 所有 JSON 能否解析（app/sitemap/project.config/每页 .json/云函数 package.json）
  3. app.json 自检：五个页面已注册、tabBar 引用的页面存在且不引用缺失图片、cloud=true
  4. 每个 .js 过 node --check
  5. 跑 utils 单测与云函数自测，必须退出码 0
  6. 云函数依赖只允许 wx-server-sdk
  7. openid 安全：云函数里的 openid 只能来自 getWXContext
用法： python preview/verify_miniprogram.py <工程目录>
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ROOT = os.path.join(os.path.dirname(HERE), "miniprogram")

PAGES = ("week", "tasks", "edit", "ai", "me")
UTILS = ("periods.js", "planner.js", "tasks.js", "ics.js", "api.js")
FUNCS = ("tasks", "aiParse", "aiDecompose", "remind")

passed = failed = 0


def check(label: str, ok: bool, extra: str = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"  PASS  {label}")
    else:
        failed += 1
        print(f"  FAIL  {label}  {extra}")


def run(cmd: list, cwd: str) -> tuple:
    # 必须显式指定 utf-8：Windows 上 subprocess 默认用系统代码页（GBK）解码子进程输出，
    # 碰到中文会在读取线程里抛 UnicodeDecodeError，诊断信息全变成乱码或残缺。
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", shell=False)
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def main() -> int:
    root = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_ROOT
    print("工程目录:", root)
    if not os.path.isdir(root):
        print("!! 目录不存在")
        return 1

    # 1) 文件齐全
    required = ["app.json", "app.js", "app.wxss", "sitemap.json", "project.config.json", "README.md"]
    for page in PAGES:
        required += [f"pages/{page}/{page}.js", f"pages/{page}/{page}.json",
                     f"pages/{page}/{page}.wxml", f"pages/{page}/{page}.wxss"]
    required += [f"utils/{name}" for name in UTILS]
    for func in FUNCS:
        required += [f"cloudfunctions/{func}/index.js", f"cloudfunctions/{func}/package.json"]
    missing = [rel for rel in required if not os.path.exists(os.path.join(root, rel))]
    check(f"必需文件齐全（{len(required)} 项）", not missing, f"缺 {missing[:6]}")

    # 2) JSON 可解析
    json_files = []
    for base, _dirs, files in os.walk(root):
        for name in files:
            if name.endswith(".json"):
                json_files.append(os.path.join(base, name))
    bad = []
    for path in json_files:
        try:
            with open(path, encoding="utf-8") as fh:
                json.load(fh)
        except Exception as exc:  # noqa: BLE001
            bad.append(f"{os.path.relpath(path, root)}: {exc}")
    check(f"所有 JSON 可解析（{len(json_files)} 个）", not bad, bad[:3])

    # 3) app.json 自检
    app_path = os.path.join(root, "app.json")
    if os.path.exists(app_path):
        with open(app_path, encoding="utf-8") as fh:
            app = json.load(fh)
        pages_listed = app.get("pages") or []
        check("app.json 注册了五个页面", len(pages_listed) >= 5, pages_listed)
        check("app.json 声明 cloud=true", bool(app.get("cloud")))
        tab = app.get("tabBar") or {}
        items = tab.get("list") or []
        bad_tab = [it for it in items
                   if it.get("pagePath") not in pages_listed
                   or (it.get("iconPath") and not os.path.exists(os.path.join(root, it["iconPath"])))]
        check("tabBar 指向已注册页面且不引用缺失图片", not bad_tab, bad_tab)

    # 4) node --check
    js_files = []
    for base, _dirs, files in os.walk(root):
        if f"{os.sep}cloudfunctions{os.sep}" in base + os.sep and "node_modules" in base:
            continue
        for name in files:
            if name.endswith(".js"):
                js_files.append(os.path.join(base, name))
    syntax_bad = []
    for path in js_files:
        code, out = run(["node", "--check", path], root)
        if code != 0:
            syntax_bad.append(f"{os.path.relpath(path, root)}: {out.strip().splitlines()[:1]}")
    check(f"所有 JS 过 node --check（{len(js_files)} 个）", not syntax_bad, syntax_bad[:3])

    # 4b) 「重复声明」检查 —— node --check 查不出，但微信的编译链会拒收。
    #     真实踩过：cloudfunctions/aiParse/index.js 里 hasApiKey 被声明了两次
    #     （同作用域内重复的 `function` 声明在 JS 里**合法**，后者覆盖前者），
    #     所以跑起来不会错、测试也全绿，只有上传到微信时才报
    #     "Identifier 'hasApiKey' has already been declared"。
    #     办法：把文件当 **ES module** 解析一遍 —— 模块作用域里重复声明就是错误。
    esm_tmp = os.path.join(tempfile.gettempdir(), "_ss_esmcheck")
    os.makedirs(esm_tmp, exist_ok=True)
    dup_bad = []
    for path in js_files:
        mjs = os.path.join(esm_tmp, "check.mjs")
        try:
            shutil.copy2(path, mjs)
        except OSError as exc:
            dup_bad.append(f"{os.path.relpath(path, root)}: 无法复制（{exc}）")
            continue
        code, out = run(["node", "--check", mjs], root)
        if code != 0:
            tail = [ln for ln in out.strip().splitlines() if ln.strip()]
            dup_bad.append(f"{os.path.relpath(path, root)}: {(tail[-1] if tail else '')[:90]}")
    shutil.rmtree(esm_tmp, ignore_errors=True)
    check("没有重复声明（按 ES module 解析 —— 微信编译器同样严格）", not dup_bad, dup_bad[:3])

    # 5) 单测：utils/tests/ 下每个脚本都要能独立跑通（不写死文件名，避免新测试被漏掉）
    test_dir = os.path.join(root, "utils", "tests")
    test_scripts = sorted(n for n in os.listdir(test_dir)) if os.path.isdir(test_dir) else []
    # 排除两类：harness.js 是共用的断言框架（只定义不执行）；
    # 下划线开头的是开发期的临时诊断脚本（另有"没有遗留临时脚本"一项专门查它们，
    # 但不该拿它们当测试跑 —— 跑临时脚本可能有副作用）。
    test_scripts = [n for n in test_scripts
                    if n.endswith(".js") and n != "harness.js" and not n.startswith("_")]
    check(f"utils/tests 下有测试脚本（{len(test_scripts)} 个）", len(test_scripts) >= 3, test_scripts)

    # 每个被移植的模块都必须有配套单测 —— 目标里明确要求"移植 … 并带 node 单测"。
    # 早先这版只检查 utils/*.js 是否存在，从没检查过测试文件，
    # 结果 utils/tests/ics.test.js 一直缺失也没被发现。
    expected_tests = {
        "periods.js": "run.js",
        "planner.js": "planner.test.js",
        "tasks.js": "tasks.test.js",
        "ics.js": "ics.test.js",
    }
    missing_tests = [f"{mod} → 缺 {name}" for mod, name in expected_tests.items()
                     if not os.path.exists(os.path.join(test_dir, name))]
    check("每个移植模块都有配套单测", not missing_tests, missing_tests)
    for name in test_scripts:
        code, out = run(["node", os.path.join("utils", "tests", name)], root)
        tail = " | ".join(out.strip().splitlines()[-2:])
        check(f"单测 {name}（退出码 0）", code == 0, f"exit={code} {tail}")

    selftest = os.path.join("cloudfunctions", "_selftest.js")
    if os.path.exists(os.path.join(root, selftest)):
        code, out = run(["node", selftest], root)
        tail = " | ".join(out.strip().splitlines()[-3:])
        check("云函数自测（退出码 0）", code == 0, f"exit={code} {tail}")
    else:
        check("云函数自测（退出码 0）", False, "缺少 cloudfunctions/_selftest.js")

    # 6) 云函数依赖
    for func in FUNCS:
        pkg = os.path.join(root, "cloudfunctions", func, "package.json")
        if not os.path.exists(pkg):
            continue
        with open(pkg, encoding="utf-8") as fh:
            deps = (json.load(fh).get("dependencies") or {})
        check(f"{func} 依赖只有 wx-server-sdk", set(deps) <= {"wx-server-sdk"}, list(deps))

    # 6b) 「调用了但没导出」的静默断路
    #     真实踩过：tasks/index.js 调 N.normalizeAiConfig() / N.maskApiKey()，
    #     而 lib/normalize.js 的 module.exports 里没有它们 —— 函数明明定义了（689/727 行），
    #     导出对象上却是 undefined，只有运行到那一行才炸，用户看到的还是一句看不懂的英文。
    #     静态一查就能发现：把 index.js 里所有 `N.xxx(` 的 xxx 拿到 require 出来的对象上核对。
    checker = os.path.join(HERE, "_check_exports.js")
    # 【为什么把"检查器在不在"本身也变成一条检查】早先这里写的是 `if os.path.exists(checker):`
    # —— 把脚本从 preview/ 搬进仓库 tools/ 之后，这个辅助文件没跟着搬，于是这一条检查
    # **静默消失**：总数从 45 变成 44，而输出里全是 PASS，没人会注意到少了一条。
    # "少了一条检查"比"检查失败"危险得多，所以它的缺席必须自己报出来。
    check("导出检查器就位（_check_exports.js）", os.path.exists(checker),
          f"缺少 {checker}：下面那条「调用了但没导出」的检查会被整体跳过")
    if os.path.exists(checker):
        for func in FUNCS:
            index_js = os.path.join(root, "cloudfunctions", func, "index.js")
            lib_js = os.path.join(root, "cloudfunctions", func, "lib", "normalize.js")
            if not (os.path.exists(index_js) and os.path.exists(lib_js)):
                continue
            code, out = run(["node", checker, lib_js, index_js], root)
            try:
                info = json.loads(out.strip().splitlines()[-1])
            except (ValueError, IndexError):
                check(f"{func} 调用点与导出一致", False, out.strip()[:120])
                continue
            missing = info.get("missing") or []
            check(f"{func} 用到的 {info.get('checked')} 个 normalize 函数都已导出",
                  not missing, missing)

    # 6c) 「写了测试，但从来没跑过」——最危险的一种假绿灯
    #     每个测试文件都必须在 run.js 里有一行 loadTest(...) 才会被执行。
    #     文件躺在磁盘上，看起来"有覆盖"，实际一次都没跑；报告里还会写"测试全绿"。
    #     本轮同时新增了 edit_busy.test.js 与 ai_vision.test.js，正是最容易漏注册的时刻。
    tests_dir = os.path.join(root, "utils", "tests")
    run_js = os.path.join(tests_dir, "run.js")
    if os.path.isdir(tests_dir) and os.path.exists(run_js):
        on_disk = sorted(n for n in os.listdir(tests_dir)
                         if n.endswith(".js") and n not in ("run.js", "harness.js"))
        with open(run_js, encoding="utf-8") as fh:
            run_src = fh.read()
        loaded = set(re.findall(r"loadTest\(\s*['\"]([^'\"]+)['\"]", run_src))
        unregistered = [n for n in on_disk if n not in loaded]
        dangling = sorted(n for n in loaded
                          if not os.path.exists(os.path.join(tests_dir, n)))
        check(f"utils/tests 下 {len(on_disk)} 个测试文件都被 run.js 加载",
              not unregistered, f"没被加载（等于没跑）：{unregistered}")
        check(f"run.js 的 {len(loaded)} 个 loadTest 目标都存在", not dangling,
              f"不存在：{dangling}")

        # 6d) 云函数与自测的对应关系：新加的云函数必须被 _selftest.js 碰到
        #     否则它永远不会进入任何自动化流程（本轮新增的 remind 就属于这一类）。
        cf_dir = os.path.join(root, "cloudfunctions")
        selftest_js = os.path.join(cf_dir, "_selftest.js")
        if os.path.exists(selftest_js):
            with open(selftest_js, encoding="utf-8") as fh:
                selftest_src = fh.read()
            func_dirs = sorted(d for d in os.listdir(cf_dir)
                               if os.path.isfile(os.path.join(cf_dir, d, "index.js")))
            uncovered = [d for d in func_dirs
                         if f"'{d}'" not in selftest_src and f'"{d}"' not in selftest_src]
            check(f"{len(func_dirs)} 个云函数都被 _selftest.js 引用", not uncovered,
                  f"自测里找不到：{uncovered}")

        # 6e) 定时触发的云函数：config.json 必须**同时**有触发器和云调用权限
        #     少任何一个都不会当场报错，而是"功能静静地不工作"：
        #       缺 triggers                    → 扫描永远不跑，用户等不到提醒
        #       缺 subscribeMessage.send 权限  → 定时器跑了，下发那一步被云调用拒绝
        remind_cfg = os.path.join(cf_dir, "remind", "config.json")
        if os.path.exists(remind_cfg):
            with open(remind_cfg, encoding="utf-8") as fh:
                rcfg = json.load(fh)
            perms = (rcfg.get("permissions") or {}).get("openapi") or []
            trigs = rcfg.get("triggers") or []
            check("remind 声明了 subscribeMessage.send 云调用权限",
                  any("subscribeMessage" in str(p) for p in perms), str(perms))
            check("remind 配了 timer 定时触发器",
                  any(isinstance(t, dict) and t.get("type") == "timer" for t in trigs),
                  str(trigs))

    # 6f) 已修 bug 的"不许静默回退"钉子
    #     这几处一旦被改掉，用户报过的现象会原样回来，而单测**测不到**：
    #     单测测的是纯函数，测不到"页面到底有没有把算出来的结果存回去"。
    #     （导入后不落库 period_times 就是这样一个 bug：算得对，就是没存。）
    me_js = os.path.join(root, "pages", "me", "me.js")
    if os.path.exists(me_js):
        with open(me_js, encoding="utf-8") as fh:
            me_src = fh.read()
        check("我的页导入后确实把校准作息落库（saveSettings 带 period_times）",
              re.search(r"saveSettings\(\s*\{[^}]*period_times", me_src) is not None)

    week_wxml = os.path.join(root, "pages", "week", "week.wxml")
    week_wxss = os.path.join(root, "pages", "week", "week.wxss")
    if os.path.exists(week_wxml) and os.path.exists(week_wxss):
        with open(week_wxml, encoding="utf-8") as fh:
            wxml_src = fh.read()
        with open(week_wxss, encoding="utf-8") as fh:
            wxss_src = fh.read()
        # 「用了类名但样式表里根本没这个类」是 CSS 世界里最常见的静默失效：
        # 页面照常渲染，只是三种类型的角标长得一模一样，用户分不出截止和子任务。
        # 注意 WXML 里写的是 class 名本身（chip-ddl，可能出现在三目表达式里），
        # 样式表里才是带点的选择器（.chip-ddl），所以两边要分别匹配。
        undefined_cls = [cls for cls in ("chip-ddl", "chip-sub", "fallback-row")
                         if cls in wxml_src and f".{cls}" not in wxss_src]
        check("课表页用到的类型/兜底行类都有样式定义", not undefined_cls,
              f"用了但没定义：{undefined_cls}")

    # 7) 身份安全
    # 真正的威胁是「从 event 里读身份」（event 完全由前端控制），
    # 而不是"文件里出现了 openid 这个词"。
    # 早先这版按关键词扫描，把 IDENTITY_KEYS（要剥离的名单）、函数名 currentOpenId、
    # 以及正确的 context.OPENID 全报成了问题 —— 是假警报，改成按威胁特征匹配。
    event_identity = re.compile(
        r"event\s*(?:\.\s*|\[\s*['\"])(?:_?openid|openid|OPENID|user|user_id)", re.I)
    leaks = []
    for func in FUNCS:
        path = os.path.join(root, "cloudfunctions", func, "index.js")
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
        for lineno, line in enumerate(src.splitlines(), 1):
            if line.lstrip().startswith(("//", "*", "/*")):
                continue
            if event_identity.search(line):
                leaks.append(f"{func}:{lineno} {line.strip()[:70]}")
        # 按职责分别要求。
        # 注意：这里的前提**变过**。原设计里 AI 两个函数不碰数据库，所以"不取身份"是对的；
        # 现在加了「用户自填 Key」，AI 函数必须按 openid 去读该用户自己的配置，
        # 于是它们既需要身份、也必然会访问数据库 —— 旧的断言已经不成立了。
        # 新的要求变成：身份仍只能来自 getWXContext；且不接受前端传入的 baseUrl（否则成 SSRF 转发器）。
        if func == "tasks":
            check("tasks 身份来自 getWXContext", "getWXContext" in src)
        else:
            check(f"{func} 身份来自 getWXContext（读用户自填 Key 需要）", "getWXContext" in src)
            check(f"{func} 不接受前端传入的 baseUrl（防 SSRF）",
                  not re.search(r"event\s*(?:\.\s*|\[\s*['\"])(?:base_?url|endpoint|host)", src, re.I))
    check("云函数没有从 event 读身份（前端伪造的 openid 必须无效）", not leaks, leaks[:4])

    tasks_index = os.path.join(root, "cloudfunctions", "tasks", "index.js")
    if os.path.exists(tasks_index):
        with open(tasks_index, encoding="utf-8") as fh:
            tasks_src = fh.read()
        check("tasks 用 stripIdentity 剥离前端传入的身份字段", "stripIdentity" in tasks_src)

    # 7b) 到期提醒「少点几次」的三条路 —— 静态红线
    #     用户的原话是"为什么日程提醒要自己一个个手动申请啊，能不能全部放开"。
    #     平台规则一条都改不了（一次性订阅 = 授权一次只能发一条、授权窗必须由用户的
    #     点击行为触发、长期订阅只对特定行业类目开放），所以这三条路全都走在规则的缝里：
    #       ① 一次补齐：点一下连弹到 3 条；② 勾过「总是保持以上选择」后静默补额度；
    #       ③ 写进手机系统日历（不消耗微信额度、不限条数）。
    #     缝里最容易越界，于是把最关键的几行钉死在这里；行为级断言在
    #     utils/tests/subscribe.test.js 与 utils/tests/remind_page.test.js 里。
    subscribe_js = os.path.join(root, "utils", "subscribe.js")
    if os.path.exists(subscribe_js):
        with open(subscribe_js, encoding="utf-8") as fh:
            sub_src = fh.read()
        with open(os.path.join(root, "pages", "me", "me.js"), encoding="utf-8") as fh:
            me_page_src = fh.read()
        with open(os.path.join(root, "pages", "me", "me.wxml"), encoding="utf-8") as fh:
            me_page_wxml = fh.read()

        check("静默补额度之前必过 canSilentTopUp 这道闸",
              "canSilentTopUp(setting, tmplId)" in sub_src)
        check("读订阅设置带了 withSubscriptions:true（不带就查不到订阅状态）",
              "withSubscriptions: true" in sub_src)
        check("静默那条路一轮只补 1 条（宁可少攒，不可虚报额度）",
              re.search(r"return silentAllowed \? 1 : TOPUP_ROUND_MAX", sub_src) is not None)
        check("只有平台回答 accept 才允许上报额度",
              "answer.result !== 'accept'" in sub_src)
        check("写手机日历走 wx.addPhoneCalendar（不耗微信额度那条路）",
              "addPhoneCalendar" in sub_src)
        check("日历与微信提醒同一判据：非 ddl 不写",
              "toStr(task.type) !== 'ddl'" in sub_src)
        check("日历同样跳过缺 end_time 的事项（不瞎猜 23:59）",
              "'no-time'" in sub_src)
        check("me 页把三条路都接上了（一次补齐 / 写日历 / 免打扰状态）",
              all(k in me_page_wxml
                  for k in ("onRemindTopUpRound", "onAddToCalendar", "remindSilentText")))
        check("me 页不自己直接调 getSetting（统一走 utils/subscribe.js）",
              "withSubscriptions" not in me_page_src)
    else:
        # 【缺文件必须自己报出来】静默跳过会让这一整段检查凭空消失（总数少了几条，
        # 而输出全是 PASS）—— 这个脚本里已经踩过一次同款坑，见上面 6b 的注释。
        check("utils/subscribe.js 就位（少点几次的三条路都在里面）", False,
              "缺少 utils/subscribe.js：下面 9 条检查会被整体跳过")

    # 8) 交付卫生：临时/诊断脚本不能留在工程里
    scratch = []
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d != "node_modules"]
        for name in files:
            if name.startswith("__") or name.startswith("_diag") or name.startswith("_mock"):
                scratch.append(os.path.relpath(os.path.join(base, name), root))
    check("没有遗留临时脚本", not scratch, scratch[:6])

    # 8b) 编码损坏检查 —— 这个仓库里真实发生过两次：
    #     用 PowerShell 的 `Set-Content` 回写源码，默认按系统 ANSI 代码页写，
    #     中文与破折号被写坏（e2 80 94 → e2 80 3f），**不可逆**。
    #     损坏会留下痕迹：U+FFFD 替换字符，或文件不再是合法 UTF-8。
    #     `node --check` 只在语法层面报错、肉眼看 diff 也容易漏，所以单独查一遍。
    encoding_bad, bom_notes = [], []
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d != "node_modules"]
        for name in files:
            if not name.endswith((".js", ".json", ".wxml", ".wxss", ".md")):
                continue
            path = os.path.join(base, name)
            rel = os.path.relpath(path, root)
            try:
                with open(path, "rb") as fh:
                    raw = fh.read()
            except OSError:
                continue
            if b"\xef\xbf\xbd" in raw:
                encoding_bad.append(f"{rel}：含替换字符 U+FFFD（编码被写坏过）")
                continue
            try:
                raw.decode("utf-8")
            except UnicodeDecodeError:
                encoding_bad.append(f"{rel}：不是合法 UTF-8")
                continue
            if raw.startswith(b"\xef\xbb\xbf"):
                bom_notes.append(rel)
    check("所有文本文件都是干净 UTF-8（无替换字符 / 无乱码）", not encoding_bad, encoding_bad[:4])
    if bom_notes:
        print("  提示  带 BOM 的文件（JSON 带 BOM 有的解析器会报错，留意一下）："
              + "、".join(bom_notes[:4]))

    # 9) 密钥扫描：小程序代码会被反编译，任何硬编码 Key 都等于公开
    #    但要区分两类命中：**产品代码**里的命中是失败；**测试文件**里的命中通常是
    #    故意放的哨兵值 —— 「Key 不许泄漏」那类断言正是靠它工作的（拿一个假的 Key 形状
    #    去验证它不会出现在返回值/界面里）。早先不分青红皂白一律算失败，
    #    结果每次都被测试夹具顶红；一条永远在响的警报等于没有警报。
    secret_pattern = re.compile(r"sk-[A-Za-z0-9_\-]{16,}|[0-9a-f]{32}\.[0-9A-Za-z]{12,}")
    test_file_hint = re.compile(r"(^|[\\/])tests?[\\/]|_selftest|\.test\.js$|contract", re.I)

    product_hits, fixture_hits = [], []
    # 【为什么还要放过"占位符形状"的命中】这条检查曾经在**注释里的示例**上误报：
    # pages/me/me.js 用一行示例串解释"智谱 Key 长什么样"，形状恰好满足扫描正则，
    # 于是静态验收报"产品代码里硬编码了 API Key" —— 那是**假警报**，而且很吓人。
    # 判据：出现「例如 / 形如 / 示例 / example」或明显的占位符标记（<...>、xxxx、...）
    # 时，按说明性文字放过。真 Key 不会长成带尖括号或一串 x 的样子。
    placeholder_hint = re.compile(r"例如|形如|示例|举例|example|e\.g\.|<[^>]{2,}>|x{4,}|X{4,}|\.\.\.|…", re.I)
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d != "node_modules"]
        for name in files:
            if not name.endswith((".js", ".json", ".wxml", ".wxss", ".md", ".txt", ".yml")):
                continue
            path = os.path.join(base, name)
            rel = os.path.relpath(path, root)
            try:
                with open(path, encoding="utf-8", errors="ignore") as fh:
                    for lineno, line in enumerate(fh, 1):
                        if not secret_pattern.search(line):
                            continue
                        if placeholder_hint.search(line):
                            continue  # 说明性示例，不是真 Key
                        (fixture_hits if test_file_hint.search(rel) else product_hits).append(
                            f"{rel}:{lineno}")
            except OSError:
                continue
    check("产品代码里没有硬编码的 API Key", not product_hits, product_hits[:5])
    if fixture_hits:
        print("  提示  测试文件里出现 Key 形状的字符串（多半是故意的哨兵值，请人眼扫一眼）："
              + "、".join(fixture_hits[:4]))

    # 10) 提示项（不算失败）：这两处只能由用户本人替换
    #     注意看的是 ENV_ID 的**取值**，不是"文件里有没有出现过 YOUR-ENV-ID" ——
    #     哨兵常量 PLACEHOLDER_ENV_ID 本来就该一直在，早先按关键词查会每次误报"还没填"。
    placeholders = []
    cfg_path = os.path.join(root, "project.config.json")
    if os.path.exists(cfg_path):
        try:
            with open(cfg_path, encoding="utf-8") as fh:
                appid = str(json.load(fh).get("appid") or "")
            if appid in ("", "YOUR-APPID"):
                placeholders.append("project.config.json 的 appid")
        except (OSError, ValueError):
            pass
    appjs = os.path.join(root, "app.js")
    if os.path.exists(appjs):
        with open(appjs, encoding="utf-8") as fh:
            env_val = ""
            for line in fh:
                if line.strip().startswith("var ENV_ID"):
                    env_val = line.split("=", 1)[1].strip().rstrip(";").strip().strip("'\"")
                    break
        if not env_val or env_val == "YOUR-ENV-ID":
            placeholders.append("app.js 的 ENV_ID（云环境 ID）")
    print("  提示  需要你本人填写的占位符："
          + ("、".join(placeholders) if placeholders else "无 —— AppID 与云环境 ID 都已填好"))

    print(f"\n结果：{passed} 通过 / {failed} 失败")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
