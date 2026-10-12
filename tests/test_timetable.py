"""课表规则：午休空档、节次跨度、不写死节次数、渲染结构不变量。"""

import re
import unittest

from tests import _support

import config
import ui_components as ui

PT = {"1": ["08:30", "09:10"], "2": ["09:15", "09:55"], "3": ["10:15", "10:55"],
      "4": ["11:00", "11:40"], "5": ["11:45", "12:25"], "7": ["14:15", "15:00"],
      "8": ["15:05", "15:40"], "9": ["16:00", "16:40"], "10": ["16:45", "17:25"],
      "11": ["19:00", "19:40"], "12": ["19:45", "20:20"], "13": ["20:30", "21:10"]}


class NoonBreak(unittest.TestCase):
    """没校准到的节次，用左右紧邻两节夹出的空档 = 午休。"""

    def test_gap_is_noon(self):
        self.assertEqual(config.gap_period_range(6, PT), ("12:25", "14:15"))
        self.assertEqual(config.break_label(6, PT), "午休")
        self.assertEqual(config.row_label((6,), PT), "午休")

    def test_effective_range_matches_gap(self):
        self.assertEqual(config.effective_period_range(6, PT), ("12:25", "14:15"))
        self.assertEqual(config.effective_period_range(5, PT), ("11:45", "12:25"))

    def test_tasks_land_in_noon(self):
        self.assertEqual(config.period_number_at("12:30", PT, prefer="start"), 6)
        self.assertEqual(config.period_span_from_times("12:00", "13:30", PT), (5, 6))
        self.assertEqual(config.period_span_from_times("12:30", "13:00", PT), (6, 6))

    def test_afternoon_not_stolen(self):
        self.assertEqual(config.period_number_at("15:10", PT, prefer="start"), 8)
        self.assertEqual(config.period_number_at("16:20", PT, prefer="start"), 9)

    def test_never_guess_when_unsure(self):
        self.assertEqual(config.break_label(6, {}), "")
        self.assertEqual(config.row_label((6,), {}), "第6节")
        self.assertEqual(config.break_label(6, dict(PT, **{"6": ["12:30", "13:10"]})), "")
        sparse = {"2": ["09:15", "09:55"], "7": ["14:15", "15:00"]}
        for number in (3, 4, 5, 6):
            self.assertEqual(config.gap_period_range(number, sparse), ("", ""))
        self.assertEqual(config.gap_period_range(1, PT), ("", ""))


class PeriodCount(unittest.TestCase):
    """一天有几节课不写死：默认 ∪ 校准到 ∪ 任务里写过的。"""

    def test_defaults(self):
        self.assertEqual(config.period_numbers(PT), tuple(range(1, 14)))
        self.assertEqual(len(config.PERIOD_ROWS), 13)

    def test_calibration_can_add_period_14(self):
        pt14 = dict(PT, **{"14": ["21:45", "22:30"]})
        rows = config.period_rows(pt14)
        self.assertEqual(len(rows), 14)
        self.assertEqual(config.row_index_of_period(14, rows), 13)

    def test_task_can_add_period_14(self):
        self.assertIn(14, config.period_numbers(PT, [14]))

    def test_backward_compatible(self):
        self.assertIsNone(config.row_index_of_period(14))


class TableInvariants(unittest.TestCase):
    """真渲染出来的表格：结构不变量（这些是踩过坑的地方）。"""

    @classmethod
    def setUpClass(cls):
        _support.use_isolated_data(reset=True)
        from streamlit.testing.v1 import AppTest
        cls.at = AppTest.from_file(_support.os.path.join(_support.PROJECT_DIR, "main.py"),
                                   default_timeout=300)
        cls.at.run()
        cls.html = next((b.value for b in cls.at.markdown
                         if "ss-table" in (b.value or "") and "<style>" not in (b.value or "")), "")

    def test_page_renders_without_exception(self):
        self.assertFalse(self.at.exception, [str(e.value) for e in self.at.exception])
        self.assertTrue(len(self.html) > 1000)

    def test_no_cell_has_card_and_idle_text(self):
        tds = re.split(r"(?=<td)", self.html)
        self.assertEqual([t[:60] for t in tds if "ss-card" in t and "空闲" in t], [])

    def test_multi_card_cells_use_columns(self):
        tds = re.split(r"(?=<td)", self.html)
        bad = [t[:60] for t in tds
               if "ss-td-block" in t and t.count("ss-card ") > 1 and "ss-block-cols" not in t]
        self.assertEqual(bad, [])

    def test_columns_tile_the_cell_exactly(self):
        tds = re.split(r"(?=<td)", self.html)
        for cell in tds:
            if "ss-block-cols" not in cell:
                continue
            span = int(re.search(r'rowspan="(\d+)"', cell).group(1))
            for part in cell.split('<div class="ss-block-col">')[1:]:
                grows = [int(x) for x in re.findall(r"flex-grow:(\d+)", part)]
                if grows:
                    self.assertEqual(sum(grows), span, grows)

    def test_weekday_header_has_free_count(self):
        self.assertIn("空闲", self.html)
