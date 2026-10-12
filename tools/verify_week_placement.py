# -*- coding: utf-8 -*-
"""tools/verify_week_placement.py —— 用**真实数据**验证课表落点的不变式。

它回答的是一个具体问题：**你那堆真实任务里，有没有哪一条被排到了跟它自己时间
零重叠的那一行**？这正是真机事故的形态（12:00 的截止在默认作息下没有一节接得住，
结果掉进「其他时段」，用户以为"截止不显示"）。

做法：
  1. 以**只读**方式打开 data/app.db，导出真实任务与校准作息；
  2. 把 JSON 通过 stdin 交给 node 探针；
  3. node 探针加载 `miniprogram/pages/week/week.js` 里**页面真正在用的那份实现**
     （通过它的 __test 探针），对这些数据跑一遍排版，逐条核对重叠；
  4. 打印报告，并按不变式给出退出码。

为什么用 python 编排、node 干活：排版逻辑只有一份实现（在小程序工程里），
复制到 python 就会变成"测的是一份、跑的是另一份"。

用法：
    python tools/verify_week_placement.py [--db data/app.db] [--miniprogram miniprogram]
退出码：0 = 不变式成立；1 = 有违反；2 = 环境/数据问题。
"""

import argparse
import json
import os
import sqlite3
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # 仓库根（tools/ 的上一层）


def load_real(db_path: str) -> dict:
    con = sqlite3.connect("file:" + db_path.replace("\\", "/") + "?mode=ro", uri=True)
    try:
        row = con.execute("SELECT payload FROM settings LIMIT 1").fetchone()
        settings = json.loads(row[0]) if row and row[0] else {}
        tasks = [json.loads(r[0]) for r in con.execute("SELECT payload FROM tasks ORDER BY id")]
    finally:
        con.close()
    return {"tasks": tasks, "period_times": settings.get("period_times") or None}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.join(ROOT, "data", "app.db"))
    ap.add_argument("--miniprogram", default=os.path.join(ROOT, "miniprogram"))
    args = ap.parse_args()

    if not os.path.exists(args.db):
        print("!! 找不到数据库：", args.db)
        print("   （单机版第一次运行后才会生成 data/app.db；没有数据时这个检查无从谈起）")
        return 2
    probe = os.path.join(HERE, "week_placement_probe.js")
    if not os.path.exists(probe):
        print("!! 找不到探针：", probe)
        return 2

    data = load_real(args.db)
    n_tasks = len(data["tasks"])
    n_periods = len(data["period_times"] or {})
    print(f"数据来源：{args.db}")
    print(f"真实任务 {n_tasks} 条；校准作息 {n_periods} 节"
          + ("（没有校准作息，课表会退回内置默认作息）" if not n_periods else ""))
    print("-" * 78)

    proc = subprocess.run(["node", probe, args.miniprogram],
                          input=json.dumps(data, ensure_ascii=False),
                          capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = (proc.stdout or "") + (proc.stderr or "")
    print(out.rstrip())

    result = None
    for line in (proc.stdout or "").splitlines():
        if line.startswith("RESULT "):
            try:
                result = json.loads(line[len("RESULT "):])
            except ValueError:
                result = None
    if proc.returncode != 0 or result is None:
        print("\n!! 探针没有正常跑完（退出码 %s）" % proc.returncode)
        return 2

    print("\n" + "=" * 78)
    if result["violations"]:
        print(f"不变式**不成立**：{result['violations']} 处落点与时间零重叠（核对了 {result['checked']} 处）")
        return 1
    print(f"不变式成立：核对 {result['checked']} 处落点，没有一条被排到与它时间零重叠的行")
    return 0


if __name__ == "__main__":
    sys.exit(main())
