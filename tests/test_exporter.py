"""`.ics` 导出：与自己导入器的往返一致性。

这是这个项目里少见的「一个模块的输出要喂给另一个模块」的地方，
所以断言写成端到端：导出 → importer.parse_ics() → 逐项核对。
"""

import unittest

from tests import _support

import config
import exporter
import importer

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


class ExportRoundTrip(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _support.use_isolated_data(reset=True)
        cls.ics = exporter.tasks_to_ics(SAMPLES, semester_start="2026-09-07")
        cls.parsed = importer.parse_ics(cls.ics)
        cls.tasks = cls.parsed.get("tasks") or []

    def test_ics_shape_and_folding(self):
        self.assertTrue(self.ics.startswith("BEGIN:VCALENDAR\r\n"))
        self.assertTrue(self.ics.endswith("END:VCALENDAR\r\n"))
        self.assertIn("VERSION:2.0", self.ics)
        self.assertIn("PRODID:", self.ics)
        for line in self.ics.split("\r\n"):
            self.assertLessEqual(len(line.encode("utf-8")), 75, line)

    def test_no_parse_errors(self):
        self.assertEqual(self.parsed.get("errors"), [])

    def test_titles_come_back(self):
        titles = {t["title"] for t in self.tasks}
        self.assertIn("高等数学", titles)
        self.assertIn("整理笔记（没定时间）", titles)

    def test_timed_course_survives(self):
        course = next(t for t in self.tasks if t["title"] == "高等数学")
        self.assertEqual(course["start_time"], "08:30")
        self.assertEqual(course["end_time"], "09:55")
        self.assertEqual(course["periods"], "1-2")
        self.assertEqual(course["location"], "致理楼L1-401")

    def test_weekly_course_round_trips(self):
        course = next(t for t in self.tasks if t["title"] == "高等数学")
        self.assertEqual(course.get("repeat"), config.REPEAT_WEEKLY)
        self.assertEqual(course.get("week_parity"), config.PARITY_ALL)
        self.assertEqual((course.get("week_start"), course.get("week_end")), (1, 16))

    def test_biweekly_course_round_trips(self):
        course = next(t for t in self.tasks if t["title"] == "双周实验")
        self.assertEqual(course.get("repeat"), config.REPEAT_WEEKLY)
        self.assertEqual(course.get("week_parity"), config.PARITY_ODD)
        self.assertEqual(course.get("week_start") % 2, 1)

    def test_ddl_keeps_its_moment(self):
        # 已知取舍：导入器只认「日程」，类型会变回 event，但截止时刻必须准确
        item = next(t for t in self.tasks if "交实验报告" in t["title"])
        self.assertEqual(item["end_time"], "23:59")

    def test_special_characters_survive(self):
        item = next((t for t in self.tasks if "分号" in t["title"]), None)
        self.assertIsNotNone(item)
        self.assertIn(",", item["title"])
        self.assertIn(";", item["title"])

    def test_all_day_item_parses(self):
        item = next((t for t in self.tasks if "没定时间" in t["title"]), None)
        self.assertIsNotNone(item)

    def test_occurrence_weeks_respects_parity(self):
        self.assertEqual(exporter.occurrence_weeks(1, 4, config.PARITY_ALL), [1, 2, 3, 4])
        self.assertEqual(exporter.occurrence_weeks(1, 6, config.PARITY_ODD), [1, 3, 5])
        self.assertEqual(exporter.occurrence_weeks(1, 6, config.PARITY_EVEN), [2, 4, 6])

    def test_rrule_only_for_weekly(self):
        self.assertEqual(exporter.build_rrule({"repeat": "none"}), "")
        self.assertIn("INTERVAL=2", exporter.build_rrule(SAMPLES[1]))
        self.assertNotIn("INTERVAL", exporter.build_rrule(SAMPLES[0]))
