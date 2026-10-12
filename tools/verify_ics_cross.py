#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""跨语言一致性验证：同一份 .ics，Python 与 JavaScript 必须解析出同样的结果。

## 这是什么、为什么值得看

这个项目有两个前端（Python/Streamlit 版与微信小程序版），共用一套业务规则。
小程序里跑不了 Python，所以 `miniprogram/utils/` 下的四个模块是把 Python 的纯逻辑
**逐条移植**成 JS 的。移植最容易出的问题是"两边各自的测试都全绿，合起来却不一样"——
所以这里不测"某一侧对不对"，而是把**同一份输入同时喂给两边，逐字段比对**。
判据是 Python 侧（`importer.parse_ics`），JS 与它不一致就是 JS 错。

`.ics` 由项目自己的 `exporter.py` 生成，所以这同时也是"导出 → 导入"往返在 JS 侧的复现。

## 怎么跑

在仓库根目录（或任意位置）执行，需要 `python3` 与 `node`，**不需要联网、不需要装任何依赖**：

    python tools/verify_ics_cross.py

退出码 0 = 全部一致；非 0 = 有字段对不上（会逐条打印 Python 与 JS 各自的值）。

## 关于「有意差异」

两边有几处**刻意不同**的地方（主要是：Python 对"不重复 / 不分单双周"的条目留空字符串，
而 JS 直接填任务模型里的规范默认值 `none` / `all`；两者归一化后完全等价）。
这类差异**照实打印出来**、不算失败，也不会被悄悄忽略 —— 见文末「已登记的等价差异」。

## 可选的第二个参数

默认比对仓库里的 `miniprogram/utils/ics.js`；传入一个路径可以改用它（例如比对开发中的副本）：

    python tools/verify_ics_cross.py /path/to/another/miniprogram
"""

import json
import os
import subprocess
import sys

# 脚本放在 <仓库根>/tools/ 下，所以仓库根是它的上一级目录。
# 刻意不写死绝对路径 —— 别人克隆下来就能跑。
HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
PROBE = os.path.join(HERE, "ics_probe.js")
SEMESTER = "2026-09-07"

MINIPROGRAM = sys.argv[1] if len(sys.argv) > 1 else os.path.join(PROJECT, "miniprogram")

# 与 tests/test_exporter.py 的 SAMPLES 完全一致 —— 用项目自己验证过的样本
SAMPLES = [
    {"id": 1, "title": "高等数学", "type": "event", "date": "2026-09-07",
     "start_time": "08:30", "end_time": "09:55", "periods": "1-2",
     "location": "致理楼L1-401", "priority": "mid", "repeat": "weekly",
     "week_start": 1, "week_end": 16, "week_parity": "all"},
    {"id": 2, "title": "双周实验", "type": "event", "date": "2026-09-07",
     "start_time": "14:15", "end_time": "16:40", "periods": "7-9",
     "location": "致原楼101", "priority": "mid", "repeat": "weekly",
     "week_start": 1, "week_end": 16, "week_parity": "odd"},
    {"id": 3, "title": "交实验报告", "type": "ddl", "date": "2026-09-28",
     "end_time": "23:59", "priority": "high"},
    {"id": 4, "title": "写周报, 含;分号", "type": "event", "date": "2026-09-08",
     "start_time": "19:00", "end_time": "20:00", "priority": "mid"},
    {"id": 5, "title": "整理笔记（没定时间）", "type": "subtask", "date": "2026-09-09"},
]

# 要逐项对比的字段（其余字段如 id / created_at 是本地生成的，不该拿来比）
FIELDS = ["title", "type", "date", "start_time", "end_time", "repeat",
          "week_start", "week_end", "week_parity", "periods", "location"]

# 任务模型的合法字段全集（判据是模型本身，不是"Python 这份样本恰好吐出了哪些键"）
TASK_FIELDS = {"id", "title", "type", "date", "start_time", "end_time", "priority",
               "done", "parent_id", "created_at", "repeat", "week_start", "week_end",
               "week_parity", "periods", "location", "estimate_min"}

# 已登记的等价差异：Python 的 importer 对「不重复 / 不分单双周」的条目留空字符串，
# 而 JS 直接填任务模型的规范默认值。两者经归一化后完全等价 —— 登记为"有意差异"。
EMPTY_EQUIV = {"repeat": "none", "week_parity": "all"}

passed = failed = 0


def norm(value) -> str:
    return "" if value is None else str(value)


def check(label: str, ok: bool, extra: str = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"  PASS  {label}")
    else:
        failed += 1
        print(f"  FAIL  {label}" + (f"\n        {extra}" if extra else ""))


def main() -> int:
    print("=" * 78)
    print("跨语言一致性：Python importer  vs  JS miniprogram/utils/ics.js")
    print("=" * 78)
    print(f"仓库根：{PROJECT}")
    print(f"JS 模块：{os.path.join(MINIPROGRAM, 'utils', 'ics.js')}")

    ics_js = os.path.join(MINIPROGRAM, "utils", "ics.js")
    if not os.path.exists(ics_js):
        print(f"\n!! 找不到 {ics_js} —— 请在仓库根目录运行，或用第二个参数指定工程目录")
        return 1
    if not os.path.exists(PROBE):
        print(f"\n!! 找不到探针脚本 {PROBE}")
        return 1

    os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    sys.path.insert(0, PROJECT)
    import exporter  # noqa: E402
    import importer  # noqa: E402

    ics_text = exporter.tasks_to_ics(SAMPLES, semester_start=SEMESTER)
    print(f"\n已用 exporter.py 生成 .ics（{len(ics_text)} 字符，"
          f"{ics_text.count('BEGIN:VEVENT')} 个 VEVENT）")

    py = importer.parse_ics(ics_text)
    py_tasks = py.get("tasks") or []
    check(f"Python 侧解析出 {len(SAMPLES)} 条任务", len(py_tasks) == len(SAMPLES),
          f"实际 {len(py_tasks)} 条；errors={py.get('errors')}")
    check("Python 侧无解析错误", not (py.get("errors") or []), str(py.get("errors"))[:200])

    # 把 .ics 文本从 stdin 递给 node —— 不落临时文件，所以没有清理问题
    proc = subprocess.run(
        ["node", PROBE, ics_js],
        input=ics_text, capture_output=True, text=True, encoding="utf-8", timeout=120,
    )
    if proc.returncode != 0:
        print("!! 探针执行失败：", (proc.stderr or "").strip()[:400])
        return 1
    try:
        js = json.loads(proc.stdout)
    except ValueError:
        print("!! 探针输出不是 JSON：", proc.stdout[:300])
        return 1

    if js.get("loadError"):
        check("utils/ics.js 能被 require", False, js["loadError"])
        return 1
    check("utils/ics.js 能被 require", True)
    if js.get("throwError"):
        check("parseIcs 不抛异常", False, js["throwError"])
        return 1
    check("parseIcs 不抛异常", True)
    if js.get("toTasksError"):
        check("toTasks(events) 单参数可调用", False, js["toTasksError"])
        return 1
    check("toTasks(events) 单参数可调用", True)

    print(f"\n  JS 侧：{js['eventCount']} 个事件 / {js['taskCount']} 条任务 / "
          f"{js['warningCount']} 条警告")

    check(f"事件条数与 Python 一致（{len(py_tasks)}）", js["eventCount"] == len(py_tasks),
          f"Python {len(py_tasks)} vs JS {js['eventCount']}")
    check("JS 侧没有产生解析警告", js["warningCount"] == 0,
          f"{js['warningCount']} 条，前几条见上")

    extra_keys = sorted(set(js.get("taskKeys") or []) - TASK_FIELDS)
    check("JS 任务对象的字段都在任务模型内", not extra_keys,
          f"模型外的键：{extra_keys}")

    js_by_title = {norm(t.get("title")): t for t in (js.get("tasks") or [])}
    print("\n逐条对比（判据 = Python importer.parse_ics）：")
    noted = []
    for item in py_tasks:
        title = norm(item.get("title"))
        other = js_by_title.get(title)
        if other is None:
            check(f"JS 解析出「{title}」", False, "JS 结果里找不到这个标题")
            continue
        diffs = []
        for field in FIELDS:
            a, b = norm(item.get(field)), norm(other.get(field))
            if a == b:
                continue
            if a == "" and b == EMPTY_EQUIV.get(field):
                noted.append(f"{title}.{field}: Python 留空 ≡ JS '{b}'（模型规范默认值）")
                continue
            diffs.append(f"{field}: Python={a!r} JS={b!r}")
        check(f"「{title}」逐字段一致（{len(FIELDS)} 项）", not diffs, "；".join(diffs))

    if noted:
        print("\n已登记的等价差异（有意为之，不算失败）：")
        for line in noted:
            print("  · " + line)

    print("\n" + "=" * 78)
    print(f"通过 {passed} 项，失败 {failed} 项")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
