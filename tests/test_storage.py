"""多用户存储层：空间隔离、旧数据迁移、并发写。"""

import json
import os
import threading
import unittest

from tests import _support

import config
import storage
import task_manager as tm


class SpaceIsolation(unittest.TestCase):
    def setUp(self):
        _support.use_isolated_data(reset=True)

    def test_new_space_code_is_url_safe_and_unique(self):
        first, second = storage.new_space_code(), storage.new_space_code()
        self.assertNotEqual(first, second)
        self.assertRegex(first, r"^[A-Za-z0-9_-]+$")

    def test_normalize_rejects_garbage(self):
        self.assertEqual(storage.normalize_space("  ab/../cd!!  "), "abcd")
        self.assertEqual(storage.normalize_space(None), "")

    def test_default_space_used_when_unset(self):
        storage.set_current_space("")
        self.assertEqual(storage.current_space(), storage.DEFAULT_SPACE)

    def test_two_spaces_do_not_see_each_other(self):
        space_a = storage.ensure_space(storage.new_space_code())
        space_b = storage.ensure_space(storage.new_space_code())

        storage.set_current_space(space_a)
        self.assertTrue(tm.add_task({"title": "A 的日程", "date": "2026-09-22"}))
        storage.set_current_space(space_b)
        self.assertTrue(tm.add_task({"title": "B 的日程", "date": "2026-09-23"}))

        storage.set_current_space(space_a)
        self.assertEqual([t["title"] for t in tm.load_tasks()], ["A 的日程"])
        storage.set_current_space(space_b)
        self.assertEqual([t["title"] for t in tm.load_tasks()], ["B 的日程"])

    def test_settings_are_per_space(self):
        space_a = storage.ensure_space(storage.new_space_code())
        space_b = storage.ensure_space(storage.new_space_code())
        storage.set_current_space(space_a)
        tm.save_settings({"semester_start": "2026-09-07"})
        storage.set_current_space(space_b)
        tm.save_settings({"semester_start": "2027-02-22"})

        storage.set_current_space(space_a)
        self.assertEqual(tm.load_settings()["semester_start"], "2026-09-07")
        storage.set_current_space(space_b)
        self.assertEqual(tm.load_settings()["semester_start"], "2027-02-22")

    def test_delete_space_removes_its_data_only(self):
        space_a = storage.ensure_space(storage.new_space_code())
        space_b = storage.ensure_space(storage.new_space_code())
        for space, title in ((space_a, "留下"), (space_b, "删掉")):
            storage.set_current_space(space)
            tm.add_task({"title": title, "date": "2026-09-22"})

        self.assertTrue(storage.delete_space(space_b))
        storage.set_current_space(space_a)
        self.assertEqual([t["title"] for t in tm.load_tasks()], ["留下"])
        self.assertFalse(storage.delete_space(storage.DEFAULT_SPACE))  # 默认空间拒删

    def test_space_info_counts_only_its_own(self):
        space = storage.ensure_space(storage.new_space_code())
        storage.set_current_space(space)
        tm.add_task({"title": "一条", "date": "2026-09-22"})
        self.assertEqual(storage.space_info(space)["task_count"], 1)


class LegacyMigration(unittest.TestCase):
    """旧 JSON 迁移：只对默认空间生效，且只做一次。"""

    def setUp(self):
        _support.use_isolated_data(reset=True)

    def _legacy_count(self) -> int:
        if not os.path.exists(config.DATA_FILE):
            return 0
        with open(config.DATA_FILE, encoding="utf-8-sig") as fh:
            data = json.loads(fh.read() or "[]")
        return len(data) if isinstance(data, list) else 0

    def test_migrates_once_and_does_not_double(self):
        expected = self._legacy_count()
        storage.set_current_space(storage.DEFAULT_SPACE)
        result = storage.migrate_legacy_json()
        self.assertEqual(len(storage.load_tasks()), expected)
        if expected:
            self.assertTrue(result["migrated"])

        again = storage.migrate_legacy_json()          # 第二次不该再导一遍
        self.assertFalse(again["migrated"])
        self.assertEqual(len(storage.load_tasks()), expected)

    def test_does_not_overwrite_existing_default_space(self):
        storage.set_current_space(storage.DEFAULT_SPACE)
        storage.save_tasks([{"title": "空间里已有的", "date": "2026-09-22"}])
        result = storage.migrate_legacy_json()
        self.assertEqual(result["tasks"], 0)
        self.assertEqual([t["title"] for t in storage.load_tasks()], ["空间里已有的"])

    def test_new_space_never_inherits_legacy_data(self):
        """多用户模式下的新空间必须是空的 —— 否则会泄露机主的课表。"""
        fresh = storage.ensure_space(storage.new_space_code())
        before = len(storage.load_tasks(fresh))
        result = storage.migrate_legacy_json(fresh)
        self.assertFalse(result["migrated"])
        self.assertEqual(result["tasks"], 0)
        self.assertEqual(len(storage.load_tasks(fresh)), before)

    def test_legacy_files_are_left_untouched(self):
        before = _support.sha256(config.DATA_FILE)
        storage.set_current_space(storage.DEFAULT_SPACE)
        storage.migrate_legacy_json()
        self.assertEqual(_support.sha256(config.DATA_FILE), before)

    def test_settings_come_along(self):
        storage.set_current_space(storage.DEFAULT_SPACE)
        storage.migrate_legacy_json()
        legacy = {}
        if os.path.exists(config.SETTINGS_FILE):
            with open(config.SETTINGS_FILE, encoding="utf-8-sig") as fh:
                legacy = json.loads(fh.read() or "{}")
        stored = storage.load_settings_raw()
        if isinstance(legacy, dict) and legacy.get("semester_start"):
            self.assertEqual(stored.get("semester_start"), legacy["semester_start"])


class Concurrency(unittest.TestCase):
    def setUp(self):
        _support.use_isolated_data(reset=True)

    def test_parallel_writes_to_different_spaces(self):
        spaces = [storage.ensure_space(storage.new_space_code()) for _ in range(4)]
        errors = []

        def writer(space: str) -> None:
            try:
                for index in range(10):
                    storage.save_tasks([{"title": f"{space}-{index}", "date": "2026-09-22"}],
                                       space)
            except Exception as exc:  # noqa: BLE001 - 测试里就是想抓住任何异常
                errors.append(exc)

        threads = [threading.Thread(target=writer, args=(space,)) for space in spaces]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(errors, [])
        for space in spaces:
            self.assertEqual(len(storage.load_tasks(space)), 1)


class SingleUserModeStillSeesLegacyData(unittest.TestCase):
    """单机模式：旧 data/schedules.json 会被迁进默认空间，界面照样看得到。"""

    def setUp(self):
        _support.use_isolated_data(reset=True)

    def test_default_space_migrates_legacy_tasks(self):
        if not os.path.exists(config.DATA_FILE):
            self.skipTest("没有旧数据文件")
        with open(config.DATA_FILE, encoding="utf-8-sig") as fh:
            expected = json.loads(fh.read() or "[]")
        if not expected:
            self.skipTest("旧数据是空的")

        storage.set_current_space("")            # 单机模式：没有 ?u= 参数
        code, is_new = storage.resolve_space_code(None)
        self.assertFalse(is_new)                 # 单机模式不新发空间码
        self.assertEqual(code, storage.DEFAULT_SPACE)
        storage.migrate_legacy_json(code)
        self.assertEqual(len(tm.load_tasks()), len(expected))

    def test_multi_user_mode_issues_a_new_space(self):
        os.environ["SS_MULTIUSER"] = "1"
        try:
            code, is_new = storage.resolve_space_code(None)
        finally:
            os.environ.pop("SS_MULTIUSER", None)
        self.assertTrue(is_new)
        self.assertNotEqual(code, storage.DEFAULT_SPACE)
        self.assertTrue(storage.normalize_space(code))
