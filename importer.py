"""
importer.py —— 课表 / 日程文件的多种格式导入。

支持格式（按扩展名或内容自动识别）：
    .ics    iCalendar（WakeUp 课程表、超级课程表、手机日历导出的都是这个）
    .csv    逗号分隔，本应用自带的模板
    .json   本应用导出的任务列表

统一入口是 :func:`parse_any`，返回一个 dict：

    {
      "format": "ics",                      # 识别出的格式
      "tasks": [ {...}, ... ],              # 可直接交给 task_manager.add_task
      "errors": ["第 3 行：..."],            # 逐行/逐事件的问题，不影响其它行
      "semester_start": "2026-08-31",       # 从数据推断的学期第一周周一（可能为 None）
      "period_ranges": {"1-2": ["08:30", "09:55"], ...},  # 推断出的作息，可写回设置
      "notes": ["已把 6 条零散事件合并为 1 门双周课"],       # 给用户看的说明
    }

关于 ICS 的几个坑（都在这里处理了）：
    * cmd 之外的编码：ICS 按行折叠，续行以空格/Tab 开头，需要先还原
    * ``DESCRIPTION`` 里的 ``\\n`` 是转义换行，``\\,`` ``\\;`` 也要反转义
    * ``DTSTART;TZID=Asia/Shanghai:20260901T083000`` 是本地时间，不能动；
      带 ``Z`` 结尾的才是 UTC，要按 VTIMEZONE 的偏移换算成本地时间
    * ``RRULE`` 里的 ``UNTIL=20270104T160000Z`` 是 UTC，直接和本地时间比会少算一周
    * 很多导出工具会把「双周课」拆成多条各自只覆盖一次的 VEVENT，
      所以这里会按「课程名 + 时间 + 地点」把出现过的时间点合并回一门课，
      再根据周次推断出「每周 / 单周 / 双周」与起止周
"""

import csv
import io
import json
import re
from datetime import date, datetime, time, timedelta

try:  # pragma: no cover - 取决于调用方式
    from . import config
except ImportError:  # pragma: no cover
    import config

# 识别结果里可能出现的格式
FORMAT_ICS = "ics"
FORMAT_CSV = "csv"
FORMAT_JSON = "json"

# 展开 RRULE 时的安全上限（防止写错的 RRULE 无限循环）
MAX_OCCURRENCES = 400

# 推算课间休息时长（分钟）：用来把「第3-5节 10:15-12:25」拆成三节课的时间
BREAK_MINUTES = 5

# 中文星期别名 → weekday()
WEEKDAY_ALIASES = {
    "周一": 0, "星期一": 0, "礼拜一": 0,
    "周二": 1, "星期二": 1, "礼拜二": 1,
    "周三": 2, "星期三": 2, "礼拜三": 2,
    "周四": 3, "星期四": 3, "礼拜四": 3,
    "周五": 4, "星期五": 4, "礼拜五": 4,
    "周六": 5, "星期六": 5, "礼拜六": 5,
    "周日": 6, "周天": 6, "星期日": 6, "星期天": 6, "礼拜日": 6, "礼拜天": 6,
}

# ICS 的 BYDAY 缩写 → weekday()
ICS_WEEKDAYS = {"MO": 0, "TU": 1, "WE": 2, "TH": 3, "FR": 4, "SA": 5, "SU": 6}


# ---------------------------------------------------------------------------
# 格式识别
# ---------------------------------------------------------------------------
def detect_format(text: str = "", filename: str = "") -> str:
    """识别导入内容的格式。

    先看扩展名，再看内容特征；都判断不出来时按 CSV 处理（最容易给出行级错误）。

    Args:
        text: 文件内容。
        filename: 文件名（可含路径）。

    Returns:
        str: "ics" / "csv" / "json"。
    """
    name = str(filename or "").lower()
    if name.endswith(".ics") or name.endswith(".ical"):
        return FORMAT_ICS
    if name.endswith(".json"):
        return FORMAT_JSON
    if name.endswith(".csv") or name.endswith(".txt"):
        # .txt 也可能是 ICS，继续按内容判断
        if "BEGIN:VCALENDAR" not in str(text or "").upper():
            return FORMAT_CSV

    sample = str(text or "").lstrip()
    upper_sample = sample[:2000].upper()
    if "BEGIN:VCALENDAR" in upper_sample or "BEGIN:VEVENT" in upper_sample:
        return FORMAT_ICS
    if sample.startswith("{") or sample.startswith("["):
        return FORMAT_JSON
    return FORMAT_CSV


# ---------------------------------------------------------------------------
# 通用小工具
# ---------------------------------------------------------------------------
def _to_minutes(hhmm: str):
    """把 "HH:MM" 转成分钟数；非法返回 None。"""
    try:
        hour, minute = str(hhmm).strip().split(":")[:2]
        return int(hour) * 60 + int(minute)
    except (ValueError, TypeError, AttributeError):
        return None


def _round_to_5(minutes: float) -> int:
    """把分钟数四舍五入到 5 分钟的整数倍（真实课表都是 5 分钟的倍数）。"""
    return int(round(float(minutes) / 5.0)) * 5


def _minutes_to_hhmm(minutes: int) -> str:
    """分钟数 → "HH:MM"。"""
    minutes = int(minutes) % (24 * 60)
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _fmt_time(value) -> str:
    """datetime/time → "HH:MM"。"""
    try:
        return value.strftime("%H:%M")
    except AttributeError:
        return ""


def normalize_time_cell(cell: str) -> str:
    """把 CSV 的时间列规范成 "HH:MM"；支持「第1-2节」写法。

    Args:
        cell: 单元格文本。

    Returns:
        str: "HH:MM"；识别不了返回空字符串。
    """
    text = str(cell or "").strip()
    if not text:
        return ""
    period_start, _ = config.parse_period_spec(text)
    if period_start:
        return period_start
    match = re.match(r"^(\d{1,2}):(\d{2})$", text)
    if match:
        return f"{int(match.group(1)):02d}:{match.group(2)}"
    # 只写「第3节」但没有对应作息时，parse_period_spec 会失败，这里再兜一层
    first, _ = config.parse_period_label(text)
    if first and first in config.PERIOD_TIMES:
        return config.PERIOD_TIMES[first][0]
    return ""


def normalize_end_time(cell: str, start_cell: str, start_time: str) -> str:
    """规范化结束时间列：支持 "HH:MM" 与「第1-2节」；留空时按大节/一节课推算。"""
    text = str(cell or "").strip()
    if text:
        _, period_end = config.parse_period_spec(text)
        if period_end:
            return period_end
        parsed = normalize_time_cell(text)
        if parsed:
            return parsed
    else:
        _, period_end = config.parse_period_spec(start_cell)
        if period_end:
            return period_end

    if start_time:
        minutes = _to_minutes(start_time)
        if minutes is not None:
            total = minutes + 45
            return f"{(total // 60) % 24:02d}:{total % 60:02d}"
    return ""


def _parse_flexible_date(cell, today: date = None):
    """解析日期列：2026-09-23 / 2026/9/23 / 9月23日 / 9-23 / 周三。

    Args:
        cell: 单元格文本。
        today: 基准日期，默认今天。

    Returns:
        date | None: 解析结果；失败返回 None。
    """
    today = today or date.today()
    text = str(cell or "").strip()
    if not text:
        return None

    normalized = text.replace("星期", "周").replace("礼拜", "周")
    if normalized in WEEKDAY_ALIASES:
        monday = today - timedelta(days=today.weekday())
        return monday + timedelta(days=WEEKDAY_ALIASES[normalized])

    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d", "%Y年%m月%d日"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue

    match = re.match(r"^(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*[日号]?$", text)
    if match:
        month, day = int(match.group(1)), int(match.group(2))
        for year in (today.year, today.year + 1):
            try:
                candidate = date(year, month, day)
            except ValueError:
                return None
            if candidate >= today:
                return candidate
    return None


# ---------------------------------------------------------------------------
# CSV
# ---------------------------------------------------------------------------
def parse_csv(text: str, today: date = None) -> dict:
    """解析课程表 CSV。

    每行一门课：
        课程名,日期(或星期),开始时间,结束时间,优先级,周次
    时间列可以写 "08:00"，也可以写「第1-2节」；
    周次列写「1-16」/「1-8单」/「1-16双周」，留空表示只在那一天。
    ``#`` 开头的行、空行、表头行会被忽略。

    Args:
        text: CSV 内容。
        today: 基准日期（用于把「周三」换算成本周日期）。

    Returns:
        dict: 与 parse_any 相同的结构（format="csv"）。
    """
    today = today or date.today()
    tasks, errors = [], []

    for lineno, raw_line in enumerate(str(text or "").splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        try:
            cells = next(csv.reader([line]))
        except (csv.Error, StopIteration):
            errors.append(f"第 {lineno} 行：无法解析")
            continue
        cells = [cell.strip() for cell in cells]

        if len(cells) < 3:
            errors.append(f"第 {lineno} 行：至少需要「课程名,日期,开始时间」三列")
            continue

        title, date_cell = cells[0], cells[1]
        start_cell = cells[2] if len(cells) > 2 else ""
        end_cell = cells[3] if len(cells) > 3 else ""
        priority = cells[4] if len(cells) > 4 else ""
        week_cell = cells[5] if len(cells) > 5 else ""
        location = cells[6] if len(cells) > 6 else ""

        if title in ("课程名", "课程", "科目", "标题") or date_cell in ("日期", "星期", "时间"):
            continue
        if not title:
            errors.append(f"第 {lineno} 行：课程名为空")
            continue

        parsed_date = _parse_flexible_date(date_cell, today)
        if not parsed_date:
            errors.append(f"第 {lineno} 行：无法识别日期「{date_cell}」")
            continue

        start_time = normalize_time_cell(start_cell)
        if not start_time:
            errors.append(f"第 {lineno} 行：无法识别开始时间「{start_cell}」（可写 08:00 或 第1-2节）")
            continue

        first_period, last_period = config.parse_period_label(start_cell)
        task = {
            "title": title,
            "type": config.TYPE_EVENT,
            "date": parsed_date.isoformat(),
            "start_time": start_time,
            "end_time": normalize_end_time(end_cell, start_cell, start_time),
            "priority": config.PRIORITY_MID,
            "done": False,
            "parent_id": None,
            "location": location,
            "periods": config.row_key((first_period, last_period)) if first_period else "",
        }
        if priority:
            task["priority"] = _priority_to_const(priority)

        week_spec = config.parse_week_spec(week_cell)
        if week_spec:
            task["repeat"] = config.REPEAT_WEEKLY
            task["week_start"], task["week_end"], task["week_parity"] = week_spec
        tasks.append(task)

    return _result(FORMAT_CSV, tasks, errors, today)


def _priority_to_const(text: str) -> str:
    """把「高/中/低」（也认 high/mid/low）转成内部常量。"""
    raw = str(text or "").strip().lower()
    if raw in ("高", "high", "紧急"):
        return config.PRIORITY_HIGH
    if raw in ("低", "low"):
        return config.PRIORITY_LOW
    return config.PRIORITY_MID


# ---------------------------------------------------------------------------
# JSON（本应用自己的导出格式）
# ---------------------------------------------------------------------------
def parse_json(text: str, today: date = None) -> dict:
    """解析 JSON 任务列表（本应用导出的格式，或形如 {"tasks": [...]}）。

    Args:
        text: JSON 文本。
        today: 基准日期。

    Returns:
        dict: 与 parse_any 相同的结构（format="json"）。
    """
    today = today or date.today()
    tasks, errors = [], []

    try:
        data = json.loads(str(text or ""))
    except (json.JSONDecodeError, TypeError) as exc:
        return _result(FORMAT_JSON, [], [f"JSON 解析失败：{exc}"], today)

    if isinstance(data, dict):
        data = data.get("tasks") or data.get("schedules") or []
    if not isinstance(data, list):
        return _result(FORMAT_JSON, [], ["JSON 顶层既不是列表，也没有 tasks 字段"], today)

    for index, row in enumerate(data, start=1):
        if not isinstance(row, dict):
            errors.append(f"第 {index} 条：不是对象，已跳过")
            continue
        title = str(row.get("title") or "").strip()
        if not title:
            errors.append(f"第 {index} 条：缺少 title，已跳过")
            continue
        parsed_date = _parse_flexible_date(row.get("date"), today)
        if not parsed_date:
            errors.append(f"第 {index} 条（{title}）：日期无法识别，已跳过")
            continue
        task = {
            "title": title,
            "type": row.get("type") or config.TYPE_EVENT,
            "date": parsed_date.isoformat(),
            "start_time": normalize_time_cell(row.get("start_time")) or "",
            "end_time": normalize_time_cell(row.get("end_time")) or "",
            "priority": row.get("priority") or config.PRIORITY_MID,
            "done": bool(row.get("done", False)),
            "parent_id": row.get("parent_id"),
            "periods": str(row.get("periods") or ""),
            "location": str(row.get("location") or ""),
            "estimate_min": row.get("estimate_min"),
        }
        # 重复设置原样带上（交给 task_manager 归一化）
        for key in ("repeat", "week_start", "week_end", "week_parity"):
            if row.get(key) is not None:
                task[key] = row[key]
        tasks.append(task)

    return _result(FORMAT_JSON, tasks, errors, today)


# ---------------------------------------------------------------------------
# ICS（iCalendar）
# ---------------------------------------------------------------------------
def _unfold_ics_lines(text: str) -> list:
    """还原 ICS 的折行：续行以空格或 Tab 开头。"""
    lines = []
    for raw in str(text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if raw[:1] in (" ", "\t") and lines:
            lines[-1] += raw[1:]
        else:
            lines.append(raw)
    return lines


def _unescape_ics(value: str) -> str:
    """反转义 ICS 文本值里的 \\n \\, \\; \\\\ 。"""
    return (
        str(value or "")
        .replace("\\n", "\n").replace("\\N", "\n")
        .replace("\\,", ",").replace("\\;", ";")
        .replace("\\\\", "\\")
    )


def _split_ics_line(line: str):
    """把一行拆成 (属性名, 参数, 值)，例如 DTSTART;TZID=X:20260101T080000。"""
    if ":" not in line:
        return None, {}, ""
    head, value = line.split(":", 1)
    parts = head.split(";")
    name = parts[0].strip().upper()
    params = {}
    for part in parts[1:]:
        if "=" in part:
            key, val = part.split("=", 1)
            params[key.strip().upper()] = val.strip()
        else:
            params[part.strip().upper()] = ""
    return name, params, value


def _parse_ics_dt(value: str, params: dict, tz_offsets: dict):
    """把 ICS 的日期时间字符串解析成本地 datetime。

    Args:
        value: 例如 20260901T083000 / 20260901T003000Z / 20260901。
        params: 该行的参数（可能含 TZID）。
        tz_offsets: VTIMEZONE 里的 TZID → 相对 UTC 的分钟偏移。

    Returns:
        datetime | None
    """
    raw = str(value or "").strip()
    is_utc = raw.endswith("Z")
    if is_utc:
        raw = raw[:-1]
    try:
        if "T" in raw:
            parsed = datetime.strptime(raw[:15], "%Y%m%dT%H%M%S")
        else:
            parsed = datetime.strptime(raw[:8], "%Y%m%d")
    except ValueError:
        return None

    if is_utc:
        # UTC → 本地：优先用文件里 VTIMEZONE 声明的偏移，其次按 Asia/Shanghai 兜底
        tzid = params.get("TZID", "")
        offset_minutes = tz_offsets.get(tzid)
        if offset_minutes is None:
            offset_minutes = 480 if ("shanghai" in tzid.lower() or not tzid) else 0
        parsed += timedelta(minutes=offset_minutes)
    return parsed


def _parse_rrule(value: str) -> dict:
    """解析 RRULE，例如 FREQ=WEEKLY;UNTIL=20270104T160000Z;INTERVAL=1。"""
    rule = {}
    for chunk in str(value or "").split(";"):
        if "=" not in chunk:
            continue
        key, val = chunk.split("=", 1)
        rule[key.strip().upper()] = val.strip()
    return rule


def _expand_occurrences(dtstart: datetime, dtend, rrule: dict, tz_offsets: dict) -> list:
    """把一条 VEVENT 展开成 [(开始, 结束), ...]。

    只处理 FREQ=WEEKLY（课表就是这种）；没有 RRULE 或不是 WEEKLY 时当作单次。
    """
    if not rrule or str(rrule.get("FREQ", "")).upper() != "WEEKLY":
        return [(dtstart, dtend)]

    try:
        interval = max(int(rrule.get("INTERVAL", 1) or 1), 1)
    except (TypeError, ValueError):
        interval = 1

    until = None
    if rrule.get("UNTIL"):
        # UNTIL 是 UTC，转成本地再比较，否则会少算一周
        until = _parse_ics_dt(rrule["UNTIL"], {}, tz_offsets)
    try:
        count = int(rrule["COUNT"]) if rrule.get("COUNT") else None
    except (TypeError, ValueError):
        count = None

    # BYDAY 只有一个值时，用它作为星期锚点
    byday = [d.strip().upper() for d in str(rrule.get("BYDAY", "")).split(",") if d.strip()]
    if len(byday) == 1 and byday[0] in ICS_WEEKDAYS:
        target = ICS_WEEKDAYS[byday[0]]
        dtstart = dtstart + timedelta(days=(target - dtstart.weekday()) % 7)

    span = (dtend - dtstart) if isinstance(dtend, datetime) else None
    occurrences = []
    current = dtstart
    for _ in range(MAX_OCCURRENCES):
        if until is not None and current > until:
            break
        if count is not None and len(occurrences) >= count:
            break
        occurrences.append((current, current + span if span else None))
        current += timedelta(weeks=interval)
    return occurrences


def _ics_events(text: str) -> tuple:
    """解析出所有 VEVENT。

    Returns:
        tuple: (events, tz_offsets)
            events: [{"summary", "start", "end", "rrule", "location", "description", "periods"}]
    """
    lines = _unfold_ics_lines(text)

    # 先收 VTIMEZONE 的偏移
    tz_offsets = {}
    current_tzid = None
    for line in lines:
        name, _, value = _split_ics_line(line)
        if name == "TZID":
            current_tzid = value.strip()
        elif name == "TZOFFSETTO" and current_tzid:
            match = re.match(r"^([+-])(\d{2})(\d{2})$", value.strip())
            if match:
                sign = 1 if match.group(1) == "+" else -1
                tz_offsets[current_tzid] = sign * (int(match.group(2)) * 60 + int(match.group(3)))

    events = []
    inside = False
    depth = 0          # VEVENT 内部的嵌套组件层数（VALARM 等）
    current = {}
    for line in lines:
        name, params, value = _split_ics_line(line)

        if name == "BEGIN":
            component = value.strip().upper()
            if component == "VEVENT":
                inside, depth, current = True, 0, {}
            elif inside:
                # 进入 VALARM 之类的子组件：里面的 DESCRIPTION 不是课程描述，必须忽略
                depth += 1
            continue

        if name == "END":
            component = value.strip().upper()
            if component == "VEVENT":
                inside, depth = False, 0
                if current.get("start"):
                    events.append(current)
            elif inside and depth > 0:
                depth -= 1
            continue

        # 只处理 VEVENT 第一层的属性（子组件里的同名属性会被忽略）
        if not inside or depth > 0 or not name:
            continue

        if name == "SUMMARY":
            current["summary"] = _unescape_ics(value).strip()
        elif name == "DTSTART":
            current["start"] = _parse_ics_dt(value, params, tz_offsets)
        elif name == "DTEND":
            current["end"] = _parse_ics_dt(value, params, tz_offsets)
        elif name == "RRULE":
            current["rrule"] = _parse_rrule(value)
        elif name == "LOCATION":
            current["location"] = _unescape_ics(value).strip()
        elif name == "DESCRIPTION":
            current["description"] = _unescape_ics(value)

    # 从 DESCRIPTION 里抠出节次（第7 - 9节）
    for event in events:
        first, last = config.parse_period_label(event.get("description", ""))
        if first:
            event["periods"] = config.row_key((first, last))
            event["period_first"] = first
            event["period_last"] = last
    return events, tz_offsets


def parse_ics(text: str, today: date = None) -> dict:
    """解析 ICS 课表，并把零散事件合并回「每周重复」的课程。

    Args:
        text: ICS 文本。
        today: 未使用（保留参数以统一调用方式）；学期起点从数据推断。

    Returns:
        dict: 与 parse_any 相同的结构（format="ics"）。
    """
    events, tz_offsets = _ics_events(text)
    if not events:
        return _result(FORMAT_ICS, [], ["没有解析到任何 VEVENT（不是有效的 ICS 文件？）"])

    errors = []
    notes = []

    # 1) 展开成一个个具体时间点，并按「课程名 + 时间段 + 地点」归并
    groups = {}
    for event in events:
        summary = str(event.get("summary") or "").strip() or "(未命名课程)"
        start = event.get("start")
        if not isinstance(start, datetime):
            errors.append(f"{summary}：DTSTART 无法解析，已跳过")
            continue
        end = event.get("end") if isinstance(event.get("end"), datetime) else None
        key = (summary, _fmt_time(start), _fmt_time(end) if end else "",
               str(event.get("location") or "").strip(), str(event.get("periods") or ""))

        bucket = groups.setdefault(key, {
            "summary": summary,
            "start_time": _fmt_time(start),
            "end_time": _fmt_time(end) if end else "",
            "location": str(event.get("location") or "").strip(),
            "periods": str(event.get("periods") or ""),
            "dates": [],
        })
        for occ_start, _ in _expand_occurrences(start, end, event.get("rrule") or {}, tz_offsets):
            bucket["dates"].append(occ_start.date())

    # 2) 推断学期起点：所有出现日期里最早那一周的周一
    all_dates = [d for bucket in groups.values() for d in bucket["dates"]]
    semester_start = None
    if all_dates:
        earliest = min(all_dates)
        semester_start = earliest - timedelta(days=earliest.weekday())

    # 3) 每门课还原成「每周重复（含单双周）」或若干单次日程
    tasks = []
    for bucket in groups.values():
        dates = sorted(set(bucket["dates"]))
        weekdays = {d.weekday() for d in dates}
        base = {
            "title": bucket["summary"],
            "type": config.TYPE_EVENT,
            "start_time": bucket["start_time"],
            "end_time": bucket["end_time"],
            "priority": config.PRIORITY_MID,
            "done": False,
            "parent_id": None,
            "periods": bucket["periods"],
            "location": bucket["location"],
        }

        weeks = []
        if semester_start:
            weeks = sorted({w for w in (config.week_number_of(d, semester_start) for d in dates)
                            if w is not None})

        # 同一星期几、且周次规律 → 合并成一门每周重复的课
        if len(weekdays) == 1 and weeks and len(dates) > 1:
            contiguous = weeks == list(range(weeks[0], weeks[-1] + 1))
            same_parity = len({w % 2 for w in weeks}) == 1
            if contiguous or same_parity:
                task = dict(base)
                task["date"] = min(dates).isoformat()
                task["repeat"] = config.REPEAT_WEEKLY
                task["week_start"] = weeks[0]
                task["week_end"] = weeks[-1]
                if contiguous:
                    task["week_parity"] = config.PARITY_ALL
                else:
                    task["week_parity"] = config.PARITY_ODD if weeks[0] % 2 else config.PARITY_EVEN
                tasks.append(task)
                if len(dates) > 1:
                    notes.append(
                        f"{bucket['summary']}：合并 {len(dates)} 次为"
                        f"{config.PARITY_LABELS[task['week_parity']]}课（第 {weeks[0]}-{weeks[-1]} 周）"
                    )
                continue

        # 时间不规律 → 老老实实排成单次日程
        for day in dates:
            task = dict(base)
            task["date"] = day.isoformat()
            tasks.append(task)
        if len(dates) > 1:
            notes.append(f"{bucket['summary']}：{len(dates)} 次时间不规律，按单次日程导入")

    # 4) 从「节次 + 起止时间」校准出每一节课的上下课时间
    period_times = _calibrate_periods(events)

    result = _result(FORMAT_ICS, tasks, errors, today)
    result["semester_start"] = semester_start.isoformat() if semester_start else None
    result["period_times"] = period_times
    result["notes"] = notes
    return result


def _calibrate_periods(events: list) -> dict:
    """从课表推算每节课的上下课时间。

    一门课占了第 a~b 节、时间是 S~E，那么：
        * 第 a 节的开始时间就是 S     —— 精确值
        * 第 b 节的结束时间就是 E     —— 精确值
        * 中间几节按「每节等长、课间 5 分钟」均分 —— 近似值
    最后用精确值覆盖近似值，这样首尾一定和课表一致。

    Args:
        events: _ics_events() 解析出来的原始事件（带 period_first/period_last）。

    Returns:
        dict: {"1": ["08:30", "09:10"], ...}，键是节次号；没数据的节次不出现。
    """
    exact_start, exact_end = {}, {}
    guess_start, guess_end = {}, {}

    for event in events:
        first, last = event.get("period_first"), event.get("period_last")
        start, end = event.get("start"), event.get("end")
        if not first or not isinstance(start, datetime):
            continue
        first = int(first)
        last = int(last or first)

        start_text = _fmt_time(start)
        current = exact_start.get(first)
        if current is None or start_text < current:
            exact_start[first] = start_text

        if isinstance(end, datetime):
            end_text = _fmt_time(end)
            current = exact_end.get(last)
            if current is None or end_text > current:
                exact_end[last] = end_text

            # 近似：把这一段时长在 first~last 节之间均分
            start_minutes, end_minutes = _to_minutes(start_text), _to_minutes(end_text)
            span = last - first + 1
            if start_minutes is not None and end_minutes is not None and span >= 1:
                total = end_minutes - start_minutes
                length = (total - (span - 1) * BREAK_MINUTES) / span
                if length > 0:
                    cursor = start_minutes
                    for number in range(first, last + 1):
                        # 上下课时间实际都是 5 分钟的整数倍，四舍五入到 5 分钟更好看也更接近真实；
                        # 下一节从「取整后的下课时间 + 课间」开始，避免出现两节首尾相接没有课间
                        begin = _round_to_5(cursor)
                        finish = _round_to_5(cursor + length)
                        guess_start.setdefault(number, _minutes_to_hhmm(begin))
                        guess_end.setdefault(number, _minutes_to_hhmm(finish))
                        cursor = finish + BREAK_MINUTES

    period_times = {}
    # 节次数不写死：按事件里真正出现过的节次来存。
    # 学校一天有 14 节的，只迭代默认的 13 节就会把第 14 节的时间永远学不到。
    seen = set(exact_start) | set(guess_start) | set(exact_end) | set(guess_end)
    for number in config.period_numbers(None, seen):
        start = exact_start.get(number) or guess_start.get(number)
        end = exact_end.get(number) or guess_end.get(number)
        if start or end:
            period_times[str(number)] = [start or "", end or ""]
    return period_times


# ---------------------------------------------------------------------------
# 统一入口
# ---------------------------------------------------------------------------
def _result(fmt: str, tasks: list, errors: list, today: date = None) -> dict:
    """组装统一的返回结构，并补上推断信息。"""
    semester_start = None
    if tasks:
        dates = []
        for task in tasks:
            try:
                dates.append(date.fromisoformat(str(task.get("date"))))
            except (ValueError, TypeError):
                continue
        if dates:
            earliest = min(dates)
            semester_start = earliest - timedelta(days=earliest.weekday())

    return {
        "format": fmt,
        "tasks": tasks,
        "errors": list(errors or []),
        "semester_start": semester_start.isoformat() if semester_start else None,
        "period_times": {},
        "notes": [],
    }


def parse_any(text: str, filename: str = "", today: date = None) -> dict:
    """按格式解析导入内容（统一入口）。

    Args:
        text: 文件内容。
        filename: 文件名（用于识别格式）。
        today: 基准日期（CSV 的「周三」等相对写法用）。

    Returns:
        dict: {"format", "tasks", "errors", "semester_start", "period_ranges", "notes"}
    """
    if not str(text or "").strip():
        return _result(detect_format(text, filename), [], ["内容为空"])

    fmt = detect_format(text, filename)
    if fmt == FORMAT_ICS:
        return parse_ics(text, today)
    if fmt == FORMAT_JSON:
        return parse_json(text, today)
    return parse_csv(text, today)
