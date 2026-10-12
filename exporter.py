"""exporter.py —— 把日程导出成 `.ics`（能被本项目自己的导入器原样读回来）。

两个目标，缺一不可：
    1. **给日历软件用**：手机/系统日历能导入，逐条显示时间、地点、重复；
    2. **能被自己读回来**：`importer.parse_ics()` 解析后，标题 / 日期 / 起止 / 节次 / 地点 /
       单双周都还在 —— `tests/test_exporter.py` 就是拿这条链路做往返断言的。

所以格式选择都贴着导入器的实现走：
    * 本地时间用**浮动时间**（`YYYYMMDDTHHMMSS`，不带 Z、不带 TZID）——项目里所有时间本来
      就是本地时间；带上 Z 会被导入器按 UTC 偏移换算，平白引入一个时区 bug（见问题 7）；
    * 每周重复的课用 `RRULE:FREQ=WEEKLY;COUNT=n`，单双周再加 `INTERVAL=2`；
      `DTSTART` 落在**第一节课那一天** —— 导入器正是靠「DTSTART 的星期几 + 周次规律」还原课程的；
    * 节次写进 `DESCRIPTION`（`第3 - 5节`），这是导入器认节次的唯一来源（`parse_period_label`）；
    * 文本按 RFC5545 转义、长行折到 75 字节、行尾用 CRLF。

如实说明两处取舍：
    * 「截止(DDL)」导出成日历上的一个 30 分钟块（截止时刻前 30 分钟开始）。但导入器只认「日程」，
      所以读回来会变成一条普通日程：**时刻是准的，类型会变成 event**；
    * 没有具体时间的 DDL / 子任务按「全天事件」导出（`DTSTART;VALUE=DATE`），
      导入器会读成当天 00:00。
"""

import os
from datetime import date, datetime, time, timedelta

try:  # pragma: no cover - 取决于调用方式
    from . import config
except ImportError:  # pragma: no cover
    import config

PRODID = "-//smart-scheduler//智能日程管家//CN"
CAL_NAME = "智能日程管家"
MAX_LINE_BYTES = 75          # RFC5545 建议的单行上限（按字节算）
DDL_BLOCK_MINUTES = 30       # 截止类在日历上占的时长


# ---------------------------------------------------------------------------
# 基础工具：转义 / 折行 / 时间格式
# ---------------------------------------------------------------------------
def escape_text(value) -> str:
    """按 RFC5545 转义文本：反斜杠、逗号、分号、换行。

    Args:
        value: 任意值（会先转成字符串）。

    Returns:
        str: 转义后的单行文本（换行变成字面量 ``\\n``）。
    """
    text = str(value if value is not None else "")
    text = text.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\\n")
    return text


def fold_line(line: str, limit: int = MAX_LINE_BYTES) -> str:
    """把一行折成不超过 limit 字节（续行以空格开头）。

    折行按**字节**算且不能把一个多字节汉字切成两半，所以逐字符累加。

    Args:
        line: 原始行（不含换行符）。
        limit: 单行字节上限。

    Returns:
        str: 折行后的文本（含 ``\\r\\n``）。
    """
    pieces, current, size = [], "", 0
    for char in str(line):
        char_size = len(char.encode("utf-8"))
        if size + char_size > limit and current:
            pieces.append(current)
            current, size = " " + char, 1 + char_size   # 续行首个空格不计入内容
        else:
            current += char
            size += char_size
    pieces.append(current)
    return "\r\n".join(pieces)


def _fmt_local(moment) -> str:
    """datetime → 浮动本地时间 "YYYYMMDDTHHMMSS"。"""
    return moment.strftime("%Y%m%dT%H%M%S")


def _fmt_date(day: date) -> str:
    """date → "YYYYMMDD"（全天事件用）。"""
    return day.strftime("%Y%m%d")


def _stamp() -> str:
    """DTSTAMP：UTC 时间，固定带 Z（这是 RFC 要求，和事件时间无关）。"""
    return datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")


def _to_date(value, default: date = None):
    """把 "YYYY-MM-DD"（或 date/datetime）转成 date；失败返回 default。"""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value).strip()[:10])
    except (TypeError, ValueError):
        return default


def _to_time(value):
    """把 "HH:MM" 转成 time；失败返回 None。"""
    try:
        hour, minute = str(value).strip().split(":")[:2]
        return time(int(hour), int(minute))
    except (AttributeError, TypeError, ValueError):
        return None


def _combine(day: date, hhmm: str):
    """日期 + "HH:MM" → datetime；时间不合法返回 None。"""
    moment = _to_time(hhmm)
    if day is None or moment is None:
        return None
    return datetime.combine(day, moment)


# ---------------------------------------------------------------------------
# 重复规则
# ---------------------------------------------------------------------------
def occurrence_weeks(week_start, week_end, parity) -> list:
    """算出这门课实际出现在第几周（单双周要筛掉一半）。

    Args:
        week_start: 起始周（1 开始）。
        week_end: 结束周。
        parity: config.PARITY_ALL / ODD / EVEN。

    Returns:
        list: 周次列表；参数不合法时返回空列表。
    """
    try:
        first, last = int(week_start or 1), int(week_end or 1)
    except (TypeError, ValueError):
        return []
    if last < first:
        first, last = last, first
    weeks = []
    for week in range(max(first, 1), last + 1):
        if parity == config.PARITY_ODD and week % 2 == 0:
            continue
        if parity == config.PARITY_EVEN and week % 2 == 1:
            continue
        weeks.append(week)
    return weeks


def weekly_anchor(task: dict, semester_start: date = None):
    """算出「第一节课」是哪一天（RRULE 的 DTSTART）。

    数据里 `date` 存的就是第一次课的日期；但如果它落在一个与单双周不符的周次上，
    这里把它挪到范围内第一个符合的周 —— 否则导出的课会比课表上多一倍或少一半。

    Args:
        task: 任务 dict。
        semester_start: 开学第一周的周一（用于按周次换算日期）。

    Returns:
        date | None: 第一节课日期。
    """
    day = _to_date(task.get("date"))
    if day is None:
        return None
    weeks = occurrence_weeks(task.get("week_start"), task.get("week_end"),
                             task.get("week_parity"))
    if not weeks or semester_start is None:
        return day
    monday = semester_start + timedelta(weeks=weeks[0] - 1)
    return monday + timedelta(days=day.weekday())


def build_rrule(task: dict, semester_start: date = None) -> str:
    """拼出 RRULE 字符串；不是每周重复的课返回空字符串。"""
    if str(task.get("repeat") or "") != config.REPEAT_WEEKLY:
        return ""
    weeks = occurrence_weeks(task.get("week_start"), task.get("week_end"),
                             task.get("week_parity"))
    if not weeks:
        return ""
    parts = ["FREQ=WEEKLY", f"COUNT={len(weeks)}"]
    if task.get("week_parity") in (config.PARITY_ODD, config.PARITY_EVEN):
        parts.append("INTERVAL=2")
    return ";".join(parts)


# ---------------------------------------------------------------------------
# 单条事件
# ---------------------------------------------------------------------------
def resolve_times(task: dict):
    """决定一条任务在日历上的起止。

    Returns:
        tuple: (start_datetime, end_datetime, all_day)
               —— 全天事件返回 (day, None, True)，其余返回 datetime 对。
    """
    day = _to_date(task.get("date"), date.today())
    task_type = str(task.get("type") or config.TYPE_EVENT)
    start_text = str(task.get("start_time") or "").strip()
    end_text = str(task.get("end_time") or "").strip()

    if task_type == config.TYPE_DDL and end_text:
        # 截止是个时刻点：在日历上占「截止前 30 分钟」那一小块，肉眼能看见又不喧宾夺主
        finish = _combine(day, end_text)
        if finish is not None:
            return finish - timedelta(minutes=DDL_BLOCK_MINUTES), finish, False

    start = _combine(day, start_text)
    end = _combine(day, end_text)
    if start and end and end > start:
        return start, end, False
    if start and not end:
        return start, start + timedelta(hours=1), False
    if end and not start:
        return end - timedelta(hours=1), end, False
    return day, None, True


def build_vevent(task: dict, semester_start: date = None, stamp: str = None) -> list:
    """把一条任务变成 VEVENT 的若干行（未折行）。

    Args:
        task: 任务 dict。
        semester_start: 开学第一周的周一。
        stamp: DTSTAMP，默认取当前 UTC 时间。

    Returns:
        list: ICS 行；无法生成时返回空列表。
    """
    title = str(task.get("title") or "").strip()
    if not title:
        return []
    task_type = str(task.get("type") or config.TYPE_EVENT)
    start, end, all_day = resolve_times(task)

    summary = f"⏰ 截止：{title}" if task_type == config.TYPE_DDL else title
    lines = ["BEGIN:VEVENT",
             f"UID:{task.get('id') or abs(hash(title))}@smart-scheduler",
             f"DTSTAMP:{stamp or _stamp()}",
             f"SUMMARY:{escape_text(summary)}"]

    if all_day:
        lines.append(f"DTSTART;VALUE=DATE:{_fmt_date(start)}")
    else:
        lines.append(f"DTSTART:{_fmt_local(start)}")
        lines.append(f"DTEND:{_fmt_local(end)}")

    rrule = build_rrule(task, semester_start)
    if rrule and not all_day:
        lines.append(f"RRULE:{rrule}")

    location = str(task.get("location") or "").strip()
    if location:
        lines.append(f"LOCATION:{escape_text(location)}")

    description = []
    periods = str(task.get("periods") or "").strip()
    if periods:
        # 导入器用 parse_period_label 从 DESCRIPTION 里抓「第7 - 9节」这种写法
        if "-" in periods:
            first, _, last = periods.partition("-")
            description.append(f"第{first.strip()} - {last.strip()}节")
        else:
            description.append(f"第{periods}节")
    if location:
        description.append(location)
    if task_type == config.TYPE_DDL:
        description.append("截止")
    if description:
        lines.append(f"DESCRIPTION:{escape_text(chr(10).join(description))}")

    lines.append("END:VEVENT")
    return lines


# ---------------------------------------------------------------------------
# 对外接口
# ---------------------------------------------------------------------------
def semester_start_of(tasks: list, semester_start=None) -> date:
    """确定学期起点：优先用传入值，其次用最早任务那一周的周一。"""
    day = _to_date(semester_start)
    if day is not None:
        return day
    dates = [_to_date(t.get("date")) for t in (tasks or []) if isinstance(t, dict)]
    dates = [d for d in dates if d]
    if not dates:
        return None
    earliest = min(dates)
    return earliest - timedelta(days=earliest.weekday())


def tasks_to_ics(tasks: list, semester_start: str = None) -> str:
    """把任务列表导出成 `.ics` 文本。

    Args:
        tasks: task_manager.load_tasks() 得到的任务列表。
        semester_start: 开学第一周的周一 "YYYY-MM-DD"；不传则从任务里推断，
                        再不行就用 config.SEMESTER_START_DEFAULT。

    Returns:
        str: ICS 文本（行尾 CRLF）。
    """
    start_day = semester_start_of(tasks, semester_start)
    if start_day is None:
        start_day = _to_date(config.SEMESTER_START_DEFAULT)
    stamp = _stamp()

    lines = ["BEGIN:VCALENDAR",
             "VERSION:2.0",
             f"PRODID:{PRODID}",
             "CALSCALE:GREGORIAN",
             f"X-WR-CALNAME:{escape_text(CAL_NAME)}"]
    for task in tasks or []:
        if isinstance(task, dict):
            lines.extend(build_vevent(task, start_day, stamp))
    lines.append("END:VCALENDAR")
    return "\r\n".join(fold_line(line) for line in lines) + "\r\n"


def ics_bytes(tasks: list, semester_start: str = None) -> bytes:
    """导出成可直接下载的字节（UTF-8 + CRLF）。"""
    return tasks_to_ics(tasks, semester_start).encode("utf-8")


def write_ics(path: str, tasks: list, semester_start: str = None) -> bool:
    """把 `.ics` 写到磁盘（导出按钮拿不到时，脚本/测试用）。

    Returns:
        bool: 成功返回 True，失败返回 False（不抛异常）。
    """
    try:
        with open(path, "wb") as fh:
            fh.write(ics_bytes(tasks, semester_start))
        return True
    except OSError:
        return False
