"""planner.py 的单元测试：预计耗时、空档、缺口、建议。"""

import unittest

from tests import _support  # noqa: F401 - 导入即把数据路径切到隔离目录

import planner
import task_manager as tm
from datetime import date, timedelta

PT = {"5": ["11:45", "12:25"], "7": ["14:15", "15:00"], "8": ["15:05", "15:40"]}
DAYS = [date(2026, 9, 21) + timedelta(days=i) for i in range(7)]


class FormatMinutes(unittest.TestCase):
    def test_human_readable(self):
        self.assertEqual(planner.format_minutes(40), "40 分钟")
        self.assertEqual(planner.format_minutes(60), "1 小时")
        self.assertEqual(planner.format_minutes(90), "1.5 小时")
        self.assertEqual(planner.format_minutes(120), "2 小时")

    def test_zero_and_garbage(self):
        self.assertEqual(planner.format_minutes(0), "—")
        self.assertEqual(planner.format_minutes("坏值"), "—")


class TaskEstimate(unittest.TestCase):
    def test_accepts_numbers_and_numeric_strings(self):
        self.assertEqual(planner.task_estimate({"estimate_min": 45}), 45)
        self.assertEqual(planner.task_estimate({"estimate_min": "90"}), 90)

    def test_never_negative(self):
        self.assertEqual(planner.task_estimate({"estimate_min": -30}), 0)
        self.assertEqual(planner.task_estimate({}), 0)
        self.assertEqual(planner.task_estimate(None), 0)


class RowMinutes(unittest.TestCase):
    def test_uses_calibrated_times(self):
        self.assertEqual(planner.row_minutes((7,), PT), 45)
        self.assertEqual(planner.row_minutes((8,), PT), 35)

    def test_falls_back_to_default_timetable(self):
        self.assertEqual(planner.row_minutes((1,), {}), 45)

    def test_rejects_reversed_range(self):
        self.assertEqual(planner.row_minutes((7,), {"7": ["15:00", "14:00"]}), 0)


class PlanWeek(unittest.TestCase):
    def test_free_minutes_by_day(self):
        occupied = {DAYS[0].isoformat(): {1}}
        free = planner.free_minutes_by_day(DAYS[:2], {0: 45, 1: 40, 2: 45}, occupied)
        self.assertEqual(free[DAYS[0].isoformat()], 90)
        self.assertEqual(free[DAYS[1].isoformat()], 130)

    def test_split_demand(self):
        total, estimated, unestimated = planner.split_demand(
            [{"estimate_min": 60}, {"estimate_min": 0}, {"estimate_min": 30}])
        self.assertEqual(total, 90)
        self.assertEqual(len(estimated), 2)
        self.assertEqual(len(unestimated), 1)

    def test_overbooked_week(self):
        plan = planner.plan_week(DAYS[:1], [{"estimate_min": 600}],
                                 {0: 45, 1: 45, 2: 45, 3: 45}, {})
        self.assertEqual(plan["free_total"], 180)
        self.assertEqual(plan["gap_minutes"], 420)
        self.assertTrue(plan["advice"][0].startswith("⚠️"))

    def test_week_that_fits(self):
        plan = planner.plan_week(DAYS[:1], [{"estimate_min": 60}], {0: 45, 1: 45}, {})
        self.assertEqual(plan["gap_minutes"], -30)
        self.assertTrue(plan["advice"][0].startswith("✅"))

    def test_counts_unestimated_honestly(self):
        plan = planner.plan_week(DAYS[:1], [{"estimate_min": 60}, {"title": "没估的"}],
                                 {0: 45, 1: 45}, {})
        self.assertEqual(len(plan["unestimated"]), 1)
        self.assertTrue(any("没写预计耗时" in line for line in plan["advice"]))

    def test_nothing_estimated(self):
        plan = planner.plan_week(DAYS[:1], [{"title": "只有标题"}], {0: 45}, {})
        self.assertEqual(plan["demand_minutes"], 0)
        self.assertIn("还没有带", plan["advice"][0])


class EstimateField(unittest.TestCase):
    """字段要真的进数据、能读回来。"""

    def setUp(self):
        _support.use_isolated_data(reset=True)

    def test_normalize(self):
        self.assertEqual(tm._normalize_task({"title": "写报告", "estimate_min": "90"})["estimate_min"], 90)
        self.assertEqual(tm._normalize_task({"title": "x", "estimate_min": -5})["estimate_min"], 0)
        self.assertEqual(tm._normalize_task({"title": "x"})["estimate_min"], 0)
        self.assertEqual(tm._normalize_task({"title": "x", "estimate_min": "坏"})["estimate_min"], 0)

    def test_round_trip_through_file(self):
        task = {"title": "缺口字段往返测试", "estimate_min": 75, "date": "2026-09-22"}
        self.assertTrue(tm.add_task(task))
        found = [t for t in tm.load_tasks() if t.get("title") == "缺口字段往返测试"]
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["estimate_min"], 75)
        self.assertTrue(tm.delete_task(found[0]["id"]))
        self.assertEqual([t for t in tm.load_tasks() if t.get("title") == "缺口字段往返测试"], [])

    def test_ai_parser_keeps_estimate(self):
        import ai_parser
        rows = ai_parser.to_local_tasks({
            "events": [{"title": "写实验报告", "date": "2026-09-22", "estimate_min": 120}],
            "deadlines": [{"title": "交报告", "date": "2026-09-23", "end_time": "23:59",
                           "estimate_min": 30}],
        })
        self.assertEqual([r["estimate_min"] for r in rows], [120, 30])

    def test_importer_json_keeps_estimate(self):
        import importer
        result = importer.parse_json(
            '[{"title": "写周报", "date": "2026-09-22", "type": "event",'
            ' "start_time": "09:00", "estimate_min": 45}]')
        self.assertEqual(result["tasks"][0]["estimate_min"], 45)
