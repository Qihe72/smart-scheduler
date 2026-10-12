"""拆解闭环：AI 拆步骤 → 人工确认 → 带 parent_id 落盘 → 父子可见 → 级联删除。

AI 全程 monkeypatch，不联网、不花钱、结果可复现。
"""

import json
import unittest

from tests import _support

import ai_parser
import config
import task_manager as tm
import ui_components as ui

PARENT_TITLE = "写毕业论文"
DEADLINE = "2026-10-30"


class DecomposeLogic(unittest.TestCase):
    def setUp(self):
        _support.use_isolated_data(reset=True)

    def test_to_local_tasks_keeps_parent_and_estimate(self):
        rows = ai_parser.to_local_tasks({"events": [
            {"title": "查文献", "date": "2026-09-26", "type": "子任务",
             "start_time": "", "end_time": "", "priority": "中", "estimate_min": 90},
        ]}, parent_id=42)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["parent_id"], 42)
        self.assertEqual(rows[0]["type"], config.TYPE_SUBTASK)
        self.assertEqual(rows[0]["estimate_min"], 90)

    def test_decompose_task_normalizes_dirty_estimates(self):
        fake = json.dumps({"task": PARENT_TITLE, "deadline": DEADLINE, "subtasks": [
            {"title": "A", "suggested_date": "2026-09-26", "estimate_min": "60"},
            {"title": "B", "suggested_date": "2026-09-27", "estimate_min": -30},
            {"title": "C", "suggested_date": "2026-09-28"},
        ]}, ensure_ascii=False)
        original = ai_parser._chat_completion
        ai_parser._chat_completion = lambda *a, **k: (fake, None)
        try:
            result = ai_parser.decompose_task(PARENT_TITLE, DEADLINE)
        finally:
            ai_parser._chat_completion = original
        self.assertFalse(result.get("error"))
        self.assertEqual([s["estimate_min"] for s in result["subtasks"]], [60, 0, 0])

    def test_relation_caption(self):
        parent = {"id": 1, "title": "写毕业论文", "parent_id": None}
        child = {"id": 2, "title": "查文献", "parent_id": 1}
        self.assertEqual(ui._relation_caption(child, [parent, child]), "↳ 属于：写毕业论文")
        self.assertEqual(ui._relation_caption(parent, [parent, child]), "↳ 含 1 个子任务：查文献")
        self.assertEqual(ui._relation_caption({"id": 9, "title": "孤零零"}, [parent, child]), "")

    def test_deleting_parent_removes_children(self):
        parent = {"title": "级联删除父", "date": "2026-10-01"}
        self.assertTrue(tm.add_task(parent))
        parent_id = parent["id"]
        for title in ("子1", "子2"):
            self.assertTrue(tm.add_task({"title": title, "type": config.TYPE_SUBTASK,
                                         "date": "2026-10-01", "parent_id": parent_id}))
        self.assertEqual(len([t for t in tm.load_tasks() if t.get("parent_id") == parent_id]), 2)
        self.assertTrue(tm.delete_task(parent_id))
        self.assertEqual(len([t for t in tm.load_tasks() if t.get("parent_id") == parent_id]), 0)


class DecomposeUI(unittest.TestCase):
    """真点击：🤖 → 确认面板 → 全部加入 → 检查落盘。"""

    def setUp(self):
        _support.use_isolated_data(reset=True)
        self.parent = {"title": PARENT_TITLE, "type": config.TYPE_DDL,
                       "date": DEADLINE, "end_time": "23:59"}
        self.assertTrue(tm.add_task(self.parent))
        ui.ai_parser.decompose_task = lambda title, deadline: {
            "task": title, "deadline": deadline,
            "subtasks": [
                {"title": "查文献", "suggested_date": "2026-09-26", "estimate_min": 90},
                {"title": "写提纲", "suggested_date": "2026-09-28", "estimate_min": 60},
                {"title": "写初稿", "suggested_date": "2026-10-10", "estimate_min": 240},
            ],
        }

    def _run_app(self):
        from streamlit.testing.v1 import AppTest
        at = AppTest.from_file(_support.os.path.join(_support.PROJECT_DIR, "main.py"),
                               default_timeout=300)
        at.run()
        self.assertFalse(at.exception, [str(e.value) for e in at.exception])
        return at

    def test_decompose_then_confirm_writes_children(self):
        at = self._run_app()
        parent_id = self.parent["id"]
        at.button(key=f"ss_manage_decomp_btn_{parent_id}").click().run()
        self.assertFalse(at.exception, [str(e.value) for e in at.exception])
        self.assertIn("拆解「写毕业论文」", " ".join(str(m.value) for m in at.markdown))
        self.assertIn("AI 拆出 3 步", " ".join(str(c.value) for c in at.caption))

        at.button(key=f"ss_decomp_form_{parent_id}").click().run()
        self.assertFalse(at.exception, [str(e.value) for e in at.exception])
        children = [t for t in tm.load_tasks() if t.get("parent_id") == parent_id]
        self.assertEqual(sorted(t["title"] for t in children), ["写初稿", "写提纲", "查文献"])
        self.assertTrue(all(t["type"] == config.TYPE_SUBTASK for t in children))
        self.assertEqual(sorted(t["estimate_min"] for t in children), [60, 90, 240])

    def test_cancel_writes_nothing(self):
        at = self._run_app()
        parent_id = self.parent["id"]
        at.button(key=f"ss_manage_decomp_btn_{parent_id}").click().run()
        at.button(key=f"ss_decomp_cancel_{parent_id}").click().run()
        self.assertEqual(len([t for t in tm.load_tasks() if t.get("parent_id") == parent_id]), 0)

    def test_relation_caption_on_page(self):
        parent_id = self.parent["id"]
        tm.add_task({"title": "查文献", "type": config.TYPE_SUBTASK,
                     "date": "2026-09-26", "parent_id": parent_id})
        at = self._run_app()
        captions = " ".join(str(c.value) for c in at.caption)
        self.assertIn("含 1 个子任务：查文献", captions)
        self.assertIn("属于：写毕业论文", captions)
