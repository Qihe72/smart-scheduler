"""「我的空间」面板：渲染、输码切换、两步删除。

测试走真正的多用户路径：SS_MULTIUSER=1 + URL 里带 ?u=<空间码>，
这样 main.py 会解析到测试指定的空间（单机模式下它会用默认空间 local）。
"""

import os
import unittest

from tests import _support

import storage
import task_manager as tm
import ui_components as ui  # noqa: F401 - 确保面板函数已注册


class SpacePanel(unittest.TestCase):
    def setUp(self):
        _support.use_isolated_data(reset=True)
        os.environ["SS_MULTIUSER"] = "1"
        self.addCleanup(lambda: os.environ.pop("SS_MULTIUSER", None))
        self.space = storage.ensure_space(storage.new_space_code())
        storage.set_current_space(self.space)
        tm.add_task({"title": "面板里的日程", "date": "2026-09-22"})

    def _run_app(self, space: str = None):
        from streamlit.testing.v1 import AppTest
        at = AppTest.from_file(os.path.join(_support.PROJECT_DIR, "main.py"),
                              default_timeout=300)
        at.query_params[storage.SPACE_PARAM] = space or self.space
        at.run()
        self.assertFalse(at.exception, [str(e.value) for e in at.exception])
        return at

    def test_panel_shows_space_code_and_honest_warning(self):
        at = self._run_app()
        page = " ".join(str(m.value) for m in at.markdown)
        captions = " ".join(str(c.value) for c in at.caption)
        expanders = " ".join(str(e.label) for e in at.expander)
        self.assertIn("我的空间", expanders)
        self.assertIn(self.space, page + captions)      # 空间码要露出来
        self.assertIn("没有密码", captions)              # 诚实提示必须在

    def test_switching_space_by_code(self):
        other = storage.ensure_space(storage.new_space_code())
        storage.save_tasks([{"title": "另一个空间的日程", "date": "2026-09-22"}], other)

        at = self._run_app()                              # 先用 self.space
        at.text_input(key="ss_space_input").set_value(other)
        at.button(key="ss_space_switch_btn").click().run()
        self.assertFalse(at.exception, [str(e.value) for e in at.exception])

        storage.set_current_space(other)
        self.assertEqual([t["title"] for t in tm.load_tasks()], ["另一个空间的日程"])
        # 原来的空间不受影响
        self.assertEqual([t["title"] for t in storage.load_tasks(self.space)],
                         ["面板里的日程"])

    def test_two_step_delete_then_fresh_space(self):
        at = self._run_app()
        at.button(key="ss_space_delete_ask").click().run()
        warnings = " ".join(str(w.value) for w in at.warning)
        self.assertIn("不可恢复", warnings)

        at.button(key="ss_space_delete_yes").click().run()
        self.assertFalse(at.exception, [str(e.value) for e in at.exception])
        self.assertEqual(storage.load_tasks(self.space), [])
        self.assertEqual(storage.space_info(self.space)["task_count"], 0)
        # 删完之后应用给了一个新的空空间
        self.assertEqual(list(tm.load_tasks()), [])
