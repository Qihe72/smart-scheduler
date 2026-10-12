/**
 * utils/ics.js —— .ics（iCalendar）课表解析 / 导入
 * ===========================================================================
 * 这是 Python 版 `smart-scheduler/importer.py` 里 ICS 那半边的移植，**逐函数对齐原实现**
 * （不是按文档猜的；下面每个函数都标了 Python 的行号出处）：
 *
 *   Python 原实现                                  本文件
 *   ---------------------------------------------------------------------------
 *   importer.py:379 _unfold_ics_lines()            unfoldIcsLines()
 *   importer.py:390 _unescape_ics()                unescapeIcs()
 *   importer.py:400 _split_ics_line()              splitIcsLine()
 *   importer.py:417 _parse_ics_dt()                parseIcsDateTime()
 *   importer.py:450 _parse_rrule()                 parseRrule()
 *   importer.py:461 _expand_occurrences()          expandOccurrences()
 *   importer.py:502 _ics_events()                  extractVEvents() / collectTzOffsets()
 *   importer.py:577 parse_ics() 第 1、2、3 步      parseIcs()  → { events, warnings, ... }
 *   importer.py:626-674 第 3 步的产物（task dict） toTasks()   → [{ title, type, date, ... }]
 *   importer.py:686 _calibrate_periods()           calibratePeriods()
 *
 * 外加用到的 config.py：394 row_key、569 parse_period_label、689 monday_of、
 * 694 week_number_of、715 monday_of_week、682 PARITY_LABELS、666 WEEKS_PER_TERM、
 * 200 CLASS_PERIODS（只用节次号）。**注意 config.py:663 SEMESTER_START_DEFAULT 这条路
 * 用不到**：Python 的 parse_ics 是从数据里推断学期起点的（importer.py:617-622），
 * 设置里存的学期起点要由调用方通过 options.semesterStart 传进来才生效。
 *
 * ---------------------------------------------------------------------------
 * 两层接口（Python 是一层，这里为了"选文件 → 预览 → 确认入库"拆成两层）
 * ---------------------------------------------------------------------------
 *   parseIcs(text)          ICS 文本 → { events, warnings, ... }
 *   toTasks(events, opts)   events   → 能直接喂给云函数 tasks.bulk_add 的任务对象
 *
 * 两层的语义与 Python 完全一致：
 *   * parseIcs 已经把「同一个课程名 + 起止时间 + 地点 + 节次」的多个 VEVENT 归并成
 *     一门课（Python 第 1 步的分组），并按 Python 第 3 步的规则判定出
 *     repeat / weekStart / weekEnd / weekParity（"每周 / 单周 / 双周"）；
 *   * events[i].dates 是展开后的**真实日期**（Python 第 3 步的分类依据），
 *     events[i].repeat 等只是同一套判定结果的展示；
 *   * toTasks 对带 dates 的事件用**同一个** classifyDates() 再算一遍（所以两层不可能
 *     各说各话），只把字段名换成项目里的 snake_case，单次日程仍然一天一条。
 *
 * 与 Python 有意不同的地方，代码里都标了【有意不同】，全部登记在这里（改一处就要改这张表）：
 *
 * A. 只是"Python 会静默处理，这里说出来"（结果值一致，只多一条 warnings / notes）：
 *    A1. DTSTART / DTEND 解析不了、VEVENT 没有 END:VEVENT（文件截断）、RRULE 缺 FREQ 或
 *        FREQ 不是 WEEKLY、UNTIL 解析不了、COUNT=0（展开后一个日期都没有）、周次超过
 *        云函数上限 30 周、UTC 时间配了文件里没有的 TZID —— Python 全部默默咽下去，
 *        这里各给一条中文说明，用户才知道少了什么。
 * B. 取值口径（不是语义差异，是任务模型的规范形态）：
 *    B1. 不重复的条目，Python 的 task dict **不填** repeat / week_parity（读出来是空串），
 *        这里按任务模型的规范填 'none' / 'all'，week_start / week_end 填 null ——
 *        与云函数 lib/normalize.js（repeat 缺省 'none'、非法 parity → 'all'、
 *        非 weekly 时周次存 null）完全一致。**不要为了对齐 Python 改成空串**：
 *        bulk_add 的字段校验要的就是这个形态。
 *    B2. 多一个 estimate_min: 0（0 = "没估"，见 normalize.js）。Python 的 ICS 路径不产出
 *        这个键（只有 parse_json 带），但它是任务模型的字段，云函数也会补默认值。
 *    B3. events 多几个诊断字段（allDay / dates / sources / interval / byday / rruleRaw /
 *        line / tzid / semesterStart），Python 的中间结构里有等价物但没对外暴露。
 * C. 两处真正的行为修正（都是 Python 的实现与 RFC 原意不符的边角）：
 *    C1. `T` 与结尾 `Z` 的大小写：Python 的 `"T" in raw` / `endswith("Z")` 区分大小写，
 *        于是 `20260907t080000` 被当成"只有日期"（08:00 变 00:00）、小写 z 结尾时不加
 *        8 小时。这里 T/t、Z/z 一视同仁（strptime 本来就不区分大小写），否则会静默把
 *        上午的课挪到零点、或整体差 8 小时。
 *    C2. 输入开头的 UTF-8 BOM 会被去掉：Python 会把第一行认成 "\ufeffBEGIN"，
 *        运气不好（文件没有 VCALENDAR 外壳）整份解析不出来。
 *    C3. 空串：Python 的 parse_ics() 会说「没有解析到任何 VEVENT」，这里沿用用户入口
 *        parse_any() 的「内容为空」（importer.py:790-791）—— 命令式入口只有这一个，
 *        空文件说"没有 VEVENT"会让人以为文件格式坏了。
 * D. 拆成两层带来的：
 *    D1. 时刻只精确到分钟（Python 的 datetime 带秒）。所有输出路径最后都经过
 *        _fmt_time()（importer.py:125）格式化到 "HH:MM"，秒进不到任何结果里。
 *    D2. toTasks 的学期起点三级兜底（options → 事件上盖的章 → 自己按 importer.py:617
 *        推断）：调用方是单参数调用（pages/me/me.js:350）。parseIcs 的 semesterStart
 *        与 Python 完全一致，仍是从数据推断。
 *    D3. 手写的（不是 parseIcs 产出的）weekly 事件：toTasks 尊重它自带的
 *        week_start / week_end / week_parity，缺周次时按云函数默认的 1~20 周；带 dates 的
 *        （也就是 parseIcs 的产物）一律按 Python 第 3 步从日期重算。
 *
 * 本模块**零依赖**：不 require 任何东西（小程序里没有 fs/path/buffer，也不能靠它们）。
 */
'use strict';

// ---------------------------------------------------------------------------
// 一、常量（照抄 config.py / importer.py，改一处要两边一起改）
// ---------------------------------------------------------------------------
// 任务类型（config.py:146-148）
var TYPE_EVENT = 'event';
var TYPE_DDL = 'ddl';
var TYPE_SUBTASK = 'subtask';
var ALL_TYPES = [TYPE_EVENT, TYPE_DDL, TYPE_SUBTASK];

// 优先级（config.py:163-165）
var PRIORITY_HIGH = 'high';
var PRIORITY_MID = 'mid';
var PRIORITY_LOW = 'low';
var ALL_PRIORITIES = [PRIORITY_HIGH, PRIORITY_MID, PRIORITY_LOW];

// 重复方式（config.py:669-670）
var REPEAT_NONE = 'none';
var REPEAT_WEEKLY = 'weekly';
// 单双周（config.py:678-686）
var PARITY_ALL = 'all';
var PARITY_ODD = 'odd';
var PARITY_EVEN = 'even';
var ALL_PARITIES = [PARITY_ALL, PARITY_ODD, PARITY_EVEN];
// config.py:682 PARITY_LABELS —— 合并说明里的中文措辞要和 Python 一模一样
var PARITY_LABELS = { all: '每周', odd: '单周', even: '双周' };

// 一学期按多少周算（config.py:666）。只在"手写的 weekly 事件没写周次"时兜底，
// 与云函数 lib/normalize.js 的默认值（week_start=1 / week_end=20）保持一致。
var WEEKS_PER_TERM = 20;
// 云函数 lib/normalize.js:39 的上限：周次超过它入库会被截断，这里只用来提醒用户
var MAX_WEEK = 30;

// importer.py:48 展开 RRULE 的安全上限（防止写错的 RRULE 无限循环）
var MAX_OCCURRENCES = 400;
// importer.py:51 推算课间休息时长（分钟）
var BREAK_MINUTES = 5;
// importer.py:445 兜底时区：UTC+8 = 480 分钟（只在"Z 结尾 + 未知 TZID"时用到）
var UTC_OFFSET_DEFAULT_MINUTES = 480;

// importer.py:597 没有 SUMMARY 时的占位标题（措辞照抄 Python）
var UNNAMED_TITLE = '(未命名课程)';

// importer.py:65 ICS 的 BYDAY 缩写 → weekday()（0=周一）
var ICS_WEEKDAYS = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };
var WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

// config.py:200-214 CLASS_PERIODS 的**节次号**（只取号，不取时间：
// ICS 这条路一个作息时间常量都用不到 —— 上下课时间是从课表本身校准出来的，
// 见 calibratePeriods()；默认号只用于"校准结果按第几节排序"）
var DEFAULT_PERIOD_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

// 分组键的分隔符：Python 用的是 tuple，这里拼成字符串，用 NUL 保证不会和内容撞上
var KEY_SEP = '\u0000';

// ---------------------------------------------------------------------------
// 二、小工具
// ---------------------------------------------------------------------------
/** 任意值 → 字符串（对齐 Python 的 str(x or "")：null/undefined 当空串）。 */
function str(value) {
  return value === null || value === undefined ? '' : String(value);
}

function pad2(number) {
  return number < 10 ? '0' + number : String(number);
}

function pad4(number) {
  var text = String(number);
  while (text.length < 4) text = '0' + text;
  return text;
}

/** 严格取整：认不出返回 null（对齐 Python 的 int() + try/except）。 */
function intOrNull(value) {
  var text = str(value).trim();
  if (!/^[+-]?\d+$/.test(text)) return null;
  var number = parseInt(text, 10);
  return Number.isFinite(number) ? number : null;
}

/** 数组去重 + 升序（"YYYY-MM-DD" 的字典序就是时间序）。 */
function uniqueSorted(values) {
  var seen = {};
  var out = [];
  for (var i = 0; i < (values || []).length; i += 1) {
    var text = str(values[i]).trim();
    if (!text || seen[text]) continue;
    seen[text] = true;
    out.push(text);
  }
  out.sort();
  return out;
}

function pushWarning(sink, message) {
  if (sink && message) sink.push(message);
}

// ---------------------------------------------------------------------------
// 三、日期 / 时刻基元
//
// Python 用 datetime，这里用两个**不依赖本地时区**的东西：
//   * 日期     "YYYY-MM-DD"
//   * 时刻     { day: "YYYY-MM-DD", minutes: 0..1439, dateOnly: bool }
// 所有算术都走 UTC 天数序号，天然没有夏令时/时区偏移的坑。
// 【有意不同】Python 的 datetime 带秒，这里只留到分钟 —— 所有输出路径最后都经过
// _fmt_time()（importer.py:125）格式化到 "HH:MM"，秒进不到任何结果里。
// ---------------------------------------------------------------------------

/** 某月有几天（用于日历合法性校验，对齐 datetime.strptime 的严格校验）。 */
function daysInMonth(year, month) {
  if (month === 2) {
    var leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  var table = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 ? table[month - 1] : 0;
}

/** (年,月,日) → "YYYY-MM-DD"；日历上不存在（2026-02-30）返回 null。 */
function makeDay(year, month, day) {
  if (!(year >= 1) || month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return pad4(year) + '-' + pad2(month) + '-' + pad2(day);
}

/** "YYYY-MM-DD" → {y,m,d}；格式不对或日历上不存在返回 null。 */
function parseDayParts(value) {
  var text = str(value).trim();
  var matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!matched) return null;
  var year = parseInt(matched[1], 10);
  var month = parseInt(matched[2], 10);
  var day = parseInt(matched[3], 10);
  if (!makeDay(year, month, day)) return null;
  return { y: year, m: month, d: day };
}

function isValidDay(value) {
  return parseDayParts(value) !== null;
}

/** 日期 → 天数序号（1970-01-01 = 0）；非法返回 null。 */
function daySerial(day) {
  var parts = parseDayParts(day);
  if (!parts) return null;
  var probe = new Date(0);
  // setUTCFullYear 不会把 0-99 年当成 19xx（Date.UTC 会），年份再小也准
  probe.setUTCFullYear(parts.y, parts.m - 1, parts.d);
  probe.setUTCHours(0, 0, 0, 0);
  return Math.round(probe.getTime() / 86400000);
}

/** 天数序号 → "YYYY-MM-DD"。 */
function serialToDay(serial) {
  var probe = new Date(serial * 86400000);
  return pad4(probe.getUTCFullYear()) + '-' + pad2(probe.getUTCMonth() + 1) + '-' + pad2(probe.getUTCDate());
}

/** 星期几：0=周一 … 6=周日（对齐 Python 的 date.weekday()；1970-01-01 是周四）。 */
function weekdayOf(day) {
  var serial = daySerial(day);
  if (serial === null) return null;
  return ((serial + 3) % 7 + 7) % 7;
}

/** 某一天所在周的周一（config.py:689 monday_of）。 */
function mondayOf(day) {
  var serial = daySerial(day);
  var weekday = weekdayOf(day);
  if (serial === null || weekday === null) return null;
  return serialToDay(serial - weekday);
}

/** 某一天是开学第几周（config.py:694 week_number_of）；开学之前返回 null。 */
function weekNumberOf(day, semesterStart) {
  var target = mondayOf(day);
  var start = mondayOf(semesterStart);
  if (!target || !start) return null;
  var deltaDays = daySerial(target) - daySerial(start);
  if (deltaDays < 0) return null; // 开学之前，不算周次
  return Math.floor(deltaDays / 7) + 1;
}

/** 第 weekNo 周的周一（config.py:715 monday_of_week）。 */
function mondayOfWeek(weekNo, semesterStart) {
  var start = mondayOf(semesterStart);
  if (!start) return null;
  var week = intOrNull(weekNo);
  if (week === null) week = 1;
  return serialToDay(daySerial(start) + (Math.max(week, 1) - 1) * 7);
}

/** Python 的取模（结果永远非负），JS 的 % 对负数会返回负数。 */
function pyMod(a, b) {
  return ((a % b) + b) % b;
}

/** "HH:MM" → 当天分钟数；非法返回 null（importer.py:105 _to_minutes）。 */
function toMinutes(hhmm) {
  var parts = str(hhmm).trim().split(':');
  if (parts.length < 2) return null;
  var hour = intOrNull(parts[0]);
  var minute = intOrNull(parts[1]);
  if (hour === null || minute === null) return null;
  return hour * 60 + minute;
}

/** 分钟数 → "HH:MM"（importer.py:119 _minutes_to_hhmm）。 */
function minutesToHHMM(minutes) {
  var total = pyMod(Math.trunc(Number(minutes) || 0), 24 * 60);
  return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
}

/**
 * Python 的 round()：四舍五入，**.5 取偶**（银行家舍入）。
 * JS 的 Math.round 是 ".5 一律进一"，校准课间时间时会和 Python 差 5 分钟，所以自己实现。
 */
function roundHalfEven(value) {
  var floor = Math.floor(value);
  var diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** 四舍五入到 5 分钟的整数倍（importer.py:114 _round_to_5）。 */
function roundTo5(minutes) {
  return roundHalfEven(Number(minutes) / 5) * 5;
}

/** 时刻 → "HH:MM"（importer.py:125 _fmt_time）；没有时刻返回空串。 */
function momentHHMM(moment) {
  if (!moment) return '';
  return pad2(Math.floor(moment.minutes / 60)) + ':' + pad2(moment.minutes % 60);
}

/** 时刻 + 天数（跨天进位）。 */
function addMomentDays(moment, days) {
  return {
    day: serialToDay(daySerial(moment.day) + days),
    minutes: moment.minutes,
    dateOnly: moment.dateOnly,
  };
}

/** 时刻 + 分钟数（跨天进位：UTC→本地 +8h 经常跨天，Python 的 timedelta 也一样）。 */
function addMomentMinutes(moment, delta) {
  var total = moment.minutes + delta;
  var extraDays = Math.floor(total / 1440);
  return {
    day: serialToDay(daySerial(moment.day) + extraDays),
    minutes: pyMod(total, 1440),
    dateOnly: false,
  };
}

/** 比较两个时刻（对齐 Python 的 datetime 比较）：-1 / 0 / 1。 */
function compareMoment(a, b) {
  var left = daySerial(a.day);
  var right = daySerial(b.day);
  if (left !== right) return left < right ? -1 : 1;
  if (a.minutes !== b.minutes) return a.minutes < b.minutes ? -1 : 1;
  return 0;
}

/** 两个时刻的间隔分钟数（对齐 Python 的 timedelta）。 */
function momentSpan(from, to) {
  return (daySerial(to.day) - daySerial(from.day)) * 1440 + (to.minutes - from.minutes);
}

// ---------------------------------------------------------------------------
// 四、ICS 行级解析（importer.py:376-499）
// ---------------------------------------------------------------------------
/**
 * 还原折行：RFC5545 里超过 75 字节的行会折行，续行以空格或 Tab 开头
 * （importer.py:379 _unfold_ics_lines —— 先 CRLF/CR 统一成 LF 再拼回去）。
 */
function unfoldIcsLines(text) {
  var lines = [];
  var raw = str(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  for (var i = 0; i < raw.length; i += 1) {
    var line = raw[i];
    var head = line.charAt(0);
    if ((head === ' ' || head === '\t') && lines.length) lines[lines.length - 1] += line.slice(1);
    else lines.push(line);
  }
  return lines;
}

/**
 * 反转义 ICS 文本值：\n \N \, \; \\（importer.py:390 _unescape_ics）。
 * **顺序照抄 Python**，顺序变了结果就变：`\\n`（转义的反斜杠 + n）在 Python 里
 * 会先被当成换行处理，最后变成「反斜杠 + 换行」。
 */
function unescapeIcs(value) {
  return str(value)
    .split('\\n').join('\n')
    .split('\\N').join('\n')
    .split('\\,').join(',')
    .split('\\;').join(';')
    .split('\\\\').join('\\');
}

/**
 * 拆一行属性：`DTSTART;TZID=Asia/Shanghai:20260907T080000`
 *   → { name: 'DTSTART', params: { TZID: 'Asia/Shanghai' }, value: '20260907T080000' }
 * 没有 ":" 返回 null（importer.py:400 _split_ics_line）。属性名与参数名一律大写。
 */
function splitIcsLine(line) {
  var text = str(line);
  var colon = text.indexOf(':');
  if (colon === -1) return null;
  var head = text.slice(0, colon);
  var value = text.slice(colon + 1);
  var parts = head.split(';');
  var params = {};
  for (var i = 1; i < parts.length; i += 1) {
    var part = parts[i];
    var equal = part.indexOf('=');
    if (equal === -1) params[part.trim().toUpperCase()] = '';
    else params[part.slice(0, equal).trim().toUpperCase()] = part.slice(equal + 1).trim();
  }
  return { name: parts[0].trim().toUpperCase(), params: params, value: value };
}

/**
 * 解析 ICS 的日期时间（importer.py:417 _parse_ics_dt）：
 *   20260907T080000   本地时间，不动
 *   20260907T080000Z  UTC，要按 +8 小时换算成本地（跨天要进位）
 *   20260907          只有日期 → 当成当天 00:00（Python 也是这个结果，所以
 *                     全天事件的 start_time 是 "00:00" 而不是空串）
 * 解析不了返回 null（调用方负责记 warning，不抛异常）。
 */
function parseIcsDateTime(value, params, tzOffsets) {
  var raw = str(value).trim();
  var attributes = params || {};
  var offsets = tzOffsets || {};

  // 【有意不同】Python 只认大写 "Z"（`raw.endswith("Z")`），小写 z 会被当成本地时间，
  // 时间直接错 8 小时。这里 Z/z 都当 UTC（RFC 的原意），并在 extractVEvents 里说一声。
  var last = raw.slice(-1);
  var isUtc = last === 'Z' || last === 'z';
  if (isUtc) raw = raw.slice(0, -1);

  var moment = null;
  // 【有意不同】Python 用 `"T" in raw` 判断有没有时间（大小写敏感），所以
  // "20260907t080000" 会被它当成"只有日期"→ 00:00。这里 T/t 都算有时间（strptime 本来就
  // 忽略大小写），否则会把上午的课静默挪到零点。
  if (raw.indexOf('T') !== -1 || raw.indexOf('t') !== -1) {
    // Python 是 strptime(raw[:15], "%Y%m%dT%H%M%S")：只看前 15 个字符，
    // 多出来的部分（".000" 之类）被无声忽略 —— 这里照做。
    var head = raw.slice(0, 15);
    var matched = /^(\d{4})(\d{2})(\d{2})[Tt](\d{2})(\d{2})(\d{2})$/.exec(head);
    if (!matched) return null;
    var day = makeDay(parseInt(matched[1], 10), parseInt(matched[2], 10), parseInt(matched[3], 10));
    var hour = parseInt(matched[4], 10);
    var minute = parseInt(matched[5], 10);
    var second = parseInt(matched[6], 10);
    if (!day || hour > 23 || minute > 59 || second > 59) return null;
    moment = { day: day, minutes: hour * 60 + minute, dateOnly: false };
  } else {
    var dateParts = /^(\d{4})(\d{2})(\d{2})$/.exec(raw.slice(0, 8));
    if (!dateParts) return null;
    var dateOnly = makeDay(parseInt(dateParts[1], 10), parseInt(dateParts[2], 10), parseInt(dateParts[3], 10));
    if (!dateOnly) return null;
    moment = { day: dateOnly, minutes: 0, dateOnly: true };
  }

  if (isUtc) {
    // UTC → 本地：优先用文件里 VTIMEZONE 声明的偏移，其次按 Asia/Shanghai 兜底
    // （importer.py:440-446 —— 未知 TZID 且不是上海时 Python 按 0 处理，这个坑见 warning）
    var tzid = str(attributes.TZID);
    var offset = offsets[tzid];
    if (offset === undefined || offset === null) {
      offset = tzid.toLowerCase().indexOf('shanghai') !== -1 || !tzid ? UTC_OFFSET_DEFAULT_MINUTES : 0;
    }
    moment = addMomentMinutes(moment, offset);
  }
  return moment;
}

/** 解析 RRULE 成对象：`FREQ=WEEKLY;INTERVAL=2` → { FREQ:'WEEKLY', INTERVAL:'2' }（importer.py:450）。 */
function parseRrule(value) {
  var rule = {};
  var chunks = str(value).split(';');
  for (var i = 0; i < chunks.length; i += 1) {
    var chunk = chunks[i];
    var equal = chunk.indexOf('=');
    if (equal === -1) continue;
    rule[chunk.slice(0, equal).trim().toUpperCase()] = chunk.slice(equal + 1).trim();
  }
  return rule;
}

/**
 * 把 RRULE 里对本项目有用的信息抠出来（诊断 / 事件字段用）。
 * 注意：**单双周的判定不靠这里**，靠 parseIcs 按真实日期算出来的 weekStart/weekEnd/weekParity
 * （importer.py:641-666）；本函数只是把文件里写了什么如实报出来。
 */
function rruleInfo(rrule, tzOffsets) {
  var rule = rrule || {};
  var count = null;
  if (rule.COUNT) {
    count = intOrNull(rule.COUNT); // int() 失败 → null（Python 同）
  }
  var untilRaw = str(rule.UNTIL).trim();
  var until = null;
  if (untilRaw) {
    var parsed = parseIcsDateTime(untilRaw, {}, tzOffsets);
    until = parsed ? parsed.day : null;
  }
  var interval = 1;
  if (rule.INTERVAL) {
    var parsedInterval = intOrNull(rule.INTERVAL);
    interval = parsedInterval === null ? 1 : Math.max(parsedInterval, 1);
  }
  return {
    freq: str(rule.FREQ).toUpperCase(),
    count: count,
    until: until,
    untilRaw: untilRaw,
    interval: interval,
    byday: str(rule.BYDAY).trim(),
  };
}

/**
 * 把一条 VEVENT 展开成 [{ start, end }, ...]（importer.py:461 _expand_occurrences）。
 * 只处理 FREQ=WEEKLY（课表就是这种）；没有 RRULE 或不是 WEEKLY 时当作单次。
 */
function expandOccurrences(start, end, rrule, tzOffsets) {
  var rule = rrule || {};
  if (!rule.FREQ || str(rule.FREQ).toUpperCase() !== 'WEEKLY') {
    return [{ start: start, end: end || null }];
  }

  // interval：INTERVAL 缺失/空/非法 → 1，然后至少为 1（Python: max(int(...), 1)）
  var interval = 1;
  if (rule.INTERVAL) {
    var parsedInterval = intOrNull(rule.INTERVAL);
    if (parsedInterval !== null) interval = Math.max(parsedInterval, 1);
  }

  // UNTIL 是 UTC，转成本地再比较，否则会少算一周（importer.py:474-477，参数表是 {}）
  var until = null;
  if (rule.UNTIL) until = parseIcsDateTime(rule.UNTIL, {}, tzOffsets);

  // COUNT：注意 COUNT=0 会得到 0 次（Python 也是这样，一个日程都不产生）
  var count = null;
  if (rule.COUNT) {
    var parsedCount = intOrNull(rule.COUNT);
    if (parsedCount !== null) count = parsedCount;
  }

  // BYDAY 只有一个值时，用它作为星期锚点（importer.py:483-487）
  var anchor = start;
  var byday = str(rule.BYDAY).toUpperCase().split(',');
  var single = null;
  for (var i = 0; i < byday.length; i += 1) {
    var token = byday[i].trim();
    if (token) single = single === null ? token : false;
  }
  if (single && Object.prototype.hasOwnProperty.call(ICS_WEEKDAYS, single)) {
    var current = weekdayOf(anchor.day);
    var shift = ((ICS_WEEKDAYS[single] - current) % 7 + 7) % 7;
    if (shift) anchor = addMomentDays(anchor, shift);
  }

  // 时长：拿**锚点之后**的 dtstart 算（Python 同），dtend 缺失或时长为 0 → 没有结束时间
  var span = end ? momentSpan(anchor, end) : null;
  var occurrences = [];
  var cursor = anchor;
  for (var step = 0; step < MAX_OCCURRENCES; step += 1) {
    if (until && compareMoment(cursor, until) > 0) break;
    if (count !== null && occurrences.length >= count) break;
    occurrences.push({ start: cursor, end: span ? addMomentMinutes(cursor, span) : null });
    cursor = addMomentDays(cursor, 7 * interval);
  }
  return occurrences;
}

/** 收 VTIMEZONE 里声明的 UTC 偏移（importer.py:511-522：TZID 与 TZOFFSETTO 按出现顺序配对）。 */
function collectTzOffsets(lines) {
  var offsets = {};
  var currentTzid = null;
  for (var i = 0; i < lines.length; i += 1) {
    var parsed = splitIcsLine(lines[i]);
    if (!parsed) continue;
    if (parsed.name === 'TZID') {
      currentTzid = parsed.value.trim();
    } else if (parsed.name === 'TZOFFSETTO' && currentTzid) {
      // Python 只认 +HHMM（+08:00 / +080000 都不认），这里照做
      var matched = /^([+-])(\d{2})(\d{2})$/.exec(parsed.value.trim());
      if (matched) {
        offsets[currentTzid] = (matched[1] === '-' ? -1 : 1) * (parseInt(matched[2], 10) * 60 + parseInt(matched[3], 10));
      }
    }
  }
  return offsets;
}

/**
 * 解析出所有 VEVENT（importer.py:502 _ics_events）。
 * 只认 VEVENT 第一层的属性：VALARM 之类子组件里的 DESCRIPTION 不是课程描述，必须忽略
 * （Python 用 depth 计数，这里照做）。
 *
 * @returns {Array} 记录数组：{ line, title, description, location, start, end, allDay,
 *                             tzid, rrule, rruleRaw, periods, periodFirst, periodLast,
 *                             dates: ['YYYY-MM-DD', ...] }
 */
function extractVEvents(lines, tzOffsets, warnings) {
  var records = [];
  var inside = false;
  var depth = 0;
  var current = null;

  for (var i = 0; i < lines.length; i += 1) {
    var lineNo = i + 1;
    var parsed = splitIcsLine(lines[i]);
    if (!parsed) continue;
    var name = parsed.name;

    if (name === 'BEGIN') {
      var component = parsed.value.trim().toUpperCase();
      if (component === 'VEVENT') {
        inside = true;
        depth = 0;
        current = { line: lineNo };
      } else if (inside) {
        depth += 1; // 进入 VALARM 之类的子组件
      }
      continue;
    }

    if (name === 'END') {
      var closed = parsed.value.trim().toUpperCase();
      if (closed === 'VEVENT') {
        finishVEvent(records, current, tzOffsets, warnings);
        inside = false;
        depth = 0;
        current = null;
      } else if (inside && depth > 0) {
        depth -= 1;
      }
      continue;
    }

    // 只处理 VEVENT 第一层的属性（子组件里的同名属性会被忽略）
    if (!inside || depth > 0 || !name || !current) continue;

    if (name === 'SUMMARY') {
      current.title = unescapeIcs(parsed.value).trim();
    } else if (name === 'DTSTART') {
      current.dtstartLine = lineNo;
      current.dtstartRaw = parsed.value.trim();
      current.tzid = str(parsed.params.TZID);
      current.start = parseIcsDateTime(parsed.value, parsed.params, tzOffsets);
      // 解析失败的说明统一在 finishVEvent 里给（那里才知道 SUMMARY）
      if (current.start) checkUtcFallback(parsed, tzOffsets, warnings, lineNo, 'DTSTART');
    } else if (name === 'DTEND') {
      current.dtendLine = lineNo;
      current.dtendRaw = parsed.value.trim();
      current.end = parseIcsDateTime(parsed.value, parsed.params, tzOffsets);
      if (current.end) checkUtcFallback(parsed, tzOffsets, warnings, lineNo, 'DTEND');
    } else if (name === 'RRULE') {
      current.rruleLine = lineNo;
      current.rruleRaw = parsed.value.trim();
      current.rrule = parseRrule(parsed.value);
      checkRrule(current.rrule, warnings, lineNo, current.rruleRaw);
    } else if (name === 'LOCATION') {
      current.location = unescapeIcs(parsed.value).trim();
    } else if (name === 'DESCRIPTION') {
      current.description = unescapeIcs(parsed.value);
    }
  }

  // 文件被截断：最后一个 VEVENT 没有 END:VEVENT（Python 会静默丢掉，这里说一声）
  if (inside && current) {
    pushWarning(warnings, '第 ' + current.line + ' 行：这个 VEVENT 没有 END:VEVENT（文件被截断了？），整个事件已忽略');
  }
  return records;
}

/** 子组件/事件收尾：补节次、算展开日期、错了就记 warning。 */
function finishVEvent(records, current, tzOffsets, warnings) {
  if (!current) return;
  var label = current.title ? '（SUMMARY：' + current.title + '）' : '';

  if (!current.start) {
    if (current.dtstartRaw !== undefined) {
      // 【有意不同】Python 会把这种事件**无声丢掉**（importer.py:544 的 `if current.get("start")`），
      // 结果用户只看到一句「没有解析到任何 VEVENT」，不知道是哪一条坏了。
      pushWarning(warnings, '第 ' + current.dtstartLine + ' 行：DTSTART「' + current.dtstartRaw + '」无法解析，这个事件已跳过' + label);
    } else {
      pushWarning(warnings, '第 ' + current.line + ' 行：这个 VEVENT 没有 DTSTART，已跳过' + label);
    }
    return;
  }
  if (current.dtendRaw !== undefined && !current.end) {
    pushWarning(warnings, '第 ' + (current.dtendLine || current.line) + ' 行：DTEND「' + current.dtendRaw + '」无法解析，按「没有结束时间」处理' + label);
  }

  // 节次：从 DESCRIPTION 里抠「第7 - 9节」（importer.py:567-573 + config.py:569）
  var periods = '';
  var label2 = parsePeriodLabel(current.description);
  if (label2 && label2[0]) {
    periods = rowKey([label2[0], label2[1]]);
    current.periodFirst = label2[0];
    current.periodLast = label2[1];
  }
  current.periods = periods;

  // 【有意不同】全天事件标记：DTSTART 写的是「只有日期」（VALUE=DATE / 20260909）。
  // Python 没有这个概念（它会得到当天 00:00 的 datetime，start_time 就是 "00:00"），
  // 这里额外报一个 allDay，界面才不会把"全天的一件事"当成零点开始的课。
  current.allDay = !!(current.start && current.start.dateOnly);

  // 展开重复(如果有) —— Python 是在 parse_ics 第 1 步里展开的（importer.py:614），
  // 这里提前到记录上，结果还是同一个数组，parseIcs 归并时直接用。
  var occurrences = expandOccurrences(current.start, current.end, current.rrule, tzOffsets || {});
  current.occurrences = occurrences;
  current.dates = [];
  for (var i = 0; i < occurrences.length; i += 1) current.dates.push(occurrences[i].start.day);

  if (current.rrule && current.rrule.COUNT && !occurrences.length) {
    pushWarning(warnings, '第 ' + (current.rruleLine || current.line) + ' 行：RRULE 的 COUNT=0，这个事件不会产生任何日程' + label);
  }
  records.push(current);
}

/** RRULE 里 Python 会静默降级处理的几种情况，都如实报出来。 */
function checkRrule(rule, warnings, lineNo, raw) {
  if (!rule.FREQ) {
    pushWarning(warnings, '第 ' + lineNo + ' 行：RRULE「' + raw + '」没有 FREQ，按单次日程处理');
    return;
  }
  if (str(rule.FREQ).toUpperCase() !== 'WEEKLY') {
    pushWarning(warnings, '第 ' + lineNo + ' 行：RRULE 的 FREQ=' + str(rule.FREQ).toUpperCase() + ' 不支持（只支持 WEEKLY），按单次日程处理');
  }
  if (rule.UNTIL && !parseIcsDateTime(rule.UNTIL, {}, null)) {
    pushWarning(warnings, '第 ' + lineNo + ' 行：RRULE 的 UNTIL「' + str(rule.UNTIL) + '」无法解析，这个结束时间被忽略（次数可能变多）');
  }
}

/** "Z 结尾 + 未知 TZID"：Python 会按 0 偏移处理，时间会偏，必须说出来。 */
function checkUtcFallback(parsed, tzOffsets, warnings, lineNo, propName) {
  var raw = str(parsed.value).trim();
  var last = raw.slice(-1);
  if (last !== 'Z' && last !== 'z') return;
  var tzid = str(parsed.params.TZID);
  if (!tzid) return;
  var offsets = tzOffsets || {};
  if (offsets[tzid] !== undefined) return;
  if (tzid.toLowerCase().indexOf('shanghai') !== -1) return;
  pushWarning(warnings, '第 ' + lineNo + ' 行：' + propName + ' 是 UTC 时间但 TZID=' + tzid + ' 在文件里没有 VTIMEZONE 偏移，按 +00:00 处理，时刻可能偏了');
}

/**
 * 从文本里解析节次范围（config.py:569 parse_period_label）。
 * "第7 - 9节" → [7,9]、"第3节" → [3,3]、认不出 → null。
 */
function parsePeriodLabel(text) {
  var raw = str(text);
  var matched = /第?\s*(\d{1,2})\s*(?:[-~—–到至]\s*(\d{1,2}))?\s*节/.exec(raw);
  if (!matched) return null;
  var first = parseInt(matched[1], 10);
  var last = matched[2] ? parseInt(matched[2], 10) : first;
  if (last < first) {
    var swap = first;
    first = last;
    last = swap;
  }
  return [first, last];
}

/** 一行的短标识（config.py:394 row_key）：[7] → "7"、[1,2] → "1-2"。 */
function rowKey(row) {
  if (!row || !row.length) return '';
  if (row.length === 1) return String(row[0]);
  return String(row[0]) + '-' + String(row[row.length - 1]);
}

// ---------------------------------------------------------------------------
// 五、归并与「每周 / 单周 / 双周」判定（importer.py:596-674）
// ---------------------------------------------------------------------------

/**
 * 按真实日期判定重复方式（importer.py:641-666，逐字对齐）：
 *   * 所有日期必须落在同一个星期几；
 *   * 周次要么连续，要么单双一致；
 *     满足 → 一门每周重复的课（连续 = 每周；只同单双 = 单周/双周）
 *     不满足 → 单次日程（由 toTasks 一天一条）
 * 返回 { repeat, weekStart, weekEnd, weekParity }。
 */
function classifyDates(dates, semesterStart) {
  var weekdaySeen = {};
  var weekdayCount = 0;
  var weeks = [];
  for (var i = 0; i < dates.length; i += 1) {
    var weekday = weekdayOf(dates[i]);
    if (weekday !== null && !weekdaySeen[weekday]) {
      weekdaySeen[weekday] = true;
      weekdayCount += 1;
    }
    var week = weekNumberOf(dates[i], semesterStart);
    if (week !== null && weeks.indexOf(week) === -1) weeks.push(week);
  }
  weeks.sort(function (a, b) { return a - b; });

  if (weekdayCount === 1 && weeks.length && dates.length > 1) {
    var contiguous = true;
    for (var j = 0; j < weeks.length; j += 1) {
      if (weeks[j] !== weeks[0] + j) {
        contiguous = false;
        break;
      }
    }
    var paritySeen = {};
    for (var k = 0; k < weeks.length; k += 1) paritySeen[weeks[k] % 2] = true;
    var sameParity = Object.keys(paritySeen).length === 1;
    if (contiguous || sameParity) {
      return {
        repeat: REPEAT_WEEKLY,
        weekStart: weeks[0],
        weekEnd: weeks[weeks.length - 1],
        weekParity: contiguous ? PARITY_ALL : (weeks[0] % 2 ? PARITY_ODD : PARITY_EVEN),
      };
    }
  }
  return { repeat: REPEAT_NONE, weekStart: null, weekEnd: null, weekParity: PARITY_ALL };
}

/** 一学期第 1..N 周里，按单双周筛出来的周次（exporter.py:127 occurrence_weeks 的同一套口径）。 */
function occurrenceWeeks(weekStart, weekEnd, parity) {
  var first = intOrNull(weekStart);
  var last = intOrNull(weekEnd);
  if (first === null || last === null) return [];
  if (last < first) {
    var swap = first;
    first = last;
    last = swap;
  }
  var weeks = [];
  for (var week = Math.max(first, 1); week <= last; week += 1) {
    if (parity === PARITY_ODD && week % 2 === 0) continue;
    if (parity === PARITY_EVEN && week % 2 === 1) continue;
    weeks.push(week);
  }
  return weeks;
}

/**
 * 从课表推算每节课的上下课时间（importer.py:686 _calibrate_periods）。
 *
 * 一门课占了第 a~b 节、时间是 S~E，那么：
 *   * 第 a 节的开始时间就是 S     —— 精确值
 *   * 第 b 节的结束时间就是 E     —— 精确值
 *   * 中间几节按「每节等长、课间 5 分钟」均分 —— 近似值
 * 最后用精确值覆盖近似值，这样首尾一定和课表一致。
 *
 * @returns {Object} { '1': ['08:00','08:45'], ... }；没数据的节次不出现。
 */
function calibratePeriods(records) {
  var exactStart = {};
  var exactEnd = {};
  var guessStart = {};
  var guessEnd = {};

  for (var i = 0; i < (records || []).length; i += 1) {
    var record = records[i];
    if (!record || !record.periodFirst || !record.start) continue;
    var first = intOrNull(record.periodFirst);
    var last = intOrNull(record.periodLast || record.periodFirst);
    if (first === null) continue;
    if (last === null) last = first;

    var startText = momentHHMM(record.start);
    if (exactStart[first] === undefined || startText < exactStart[first]) exactStart[first] = startText;

    if (record.end) {
      var endText = momentHHMM(record.end);
      if (exactEnd[last] === undefined || endText > exactEnd[last]) exactEnd[last] = endText;

      // 近似：把这一段时长在 first~last 节之间均分
      var startMinutes = toMinutes(startText);
      var endMinutes = toMinutes(endText);
      var span = last - first + 1;
      if (startMinutes !== null && endMinutes !== null && span >= 1) {
        var length = (endMinutes - startMinutes - (span - 1) * BREAK_MINUTES) / span;
        if (length > 0) {
          var cursor = startMinutes;
          for (var number = first; number <= last; number += 1) {
            // 下一节从「取整后的下课时间 + 课间」开始，避免两节首尾相接没有课间
            var begin = roundTo5(cursor);
            var finish = roundTo5(cursor + length);
            if (guessStart[number] === undefined) guessStart[number] = minutesToHHMM(begin);
            if (guessEnd[number] === undefined) guessEnd[number] = minutesToHHMM(finish);
            cursor = finish + BREAK_MINUTES;
          }
        }
      }
    }
  }

  // 节次数不写死：按事件里真正出现过的节次来存（默认 1..13 ∪ 出现过的）
  var seen = [];
  [exactStart, guessStart, exactEnd, guessEnd].forEach(function (source) {
    Object.keys(source).forEach(function (key) {
      var number = intOrNull(key);
      if (number !== null && number > 0 && seen.indexOf(number) === -1) seen.push(number);
    });
  });
  for (var d = 0; d < DEFAULT_PERIOD_NUMBERS.length; d += 1) {
    if (seen.indexOf(DEFAULT_PERIOD_NUMBERS[d]) === -1) seen.push(DEFAULT_PERIOD_NUMBERS[d]);
  }
  seen.sort(function (a, b) { return a - b; });

  var periodTimes = {};
  for (var s = 0; s < seen.length; s += 1) {
    var key = seen[s];
    var start = exactStart[key] || guessStart[key] || '';
    var end = exactEnd[key] || guessEnd[key] || '';
    if (start || end) periodTimes[String(key)] = [start, end];
  }
  return periodTimes;
}

// ---------------------------------------------------------------------------
// 六、第一层：ICS 文本 → 结构化事件
// ---------------------------------------------------------------------------
function makeResult(events, warnings, notes, semesterStart, periodTimes, vevents) {
  return {
    events: events || [],
    warnings: warnings || [],
    notes: notes || [],
    semesterStart: semesterStart || null,
    periodTimes: periodTimes || {},
    vevents: vevents || [],
  };
}

/** 对外暴露的原始 VEVENT（诊断用，字段名与 events 对齐）。 */
function publicVEvent(record, tzOffsets) {
  var info = rruleInfo(record.rrule, tzOffsets);
  var dates = uniqueSorted(record.dates);
  return {
    index: record.index,
    line: record.line,
    title: str(record.title).trim(),
    description: str(record.description),
    location: str(record.location).trim(),
    date: record.start ? record.start.day : '',
    startTime: momentHHMM(record.start),
    endTime: record.end ? momentHHMM(record.end) : '',
    allDay: !!record.allDay,
    repeat: info.freq === 'WEEKLY' ? REPEAT_WEEKLY : REPEAT_NONE,
    weekStart: null,
    weekEnd: null,
    weekParity: PARITY_ALL,
    count: info.count,
    until: info.until,
    untilRaw: info.untilRaw,
    interval: info.interval,
    byday: info.byday,
    periods: str(record.periods),
    periodFirst: record.periodFirst === undefined ? null : record.periodFirst,
    periodLast: record.periodLast === undefined ? null : record.periodLast,
    tzid: str(record.tzid),
    rruleRaw: str(record.rruleRaw),
    dates: dates,
  };
}

/**
 * 第一层：解析 ICS 文本 → 结构化事件。
 *
 * 【不抛异常】任何看不懂的内容都进 warnings，能继续解析后面的就继续。
 * 与 Python 的对应关系：本函数 = importer.py:502 _ics_events()
 *                              + importer.py:596-674 的分组与重复判定
 *                              + importer.py:686 的作息校准。
 *
 * @param {string} text ICS 文件内容（不是路径）。
 * @param {{semesterStart?: string}} [options]
 *        semesterStart 传了就用它当"开学第一周的周一"来算周次；
 *        不传就按 Python 的做法从数据里推断（importer.py:617-622）。
 * @returns {{
 *   events: Array, warnings: string[], notes: string[],
 *   semesterStart: (string|null), periodTimes: Object, vevents: Array
 * }}
 *
 * events[i] 字段：
 *   title       课程名（没有 SUMMARY 时是 '(未命名课程)'）
 *   description DESCRIPTION 原文（已反转义；同一个课程取第一条非空的）
 *   location    地点（已反转义、已 trim；归并键的一部分）
 *   date        "YYYY-MM-DD"：这门课**最早一次**的日期（Python 的 min(dates)）
 *   startTime   "HH:MM"（全天事件是 "00:00"，与 Python 一致）
 *   endTime     "HH:MM"；没有 DTEND 时是 ""
 *   allDay      是否「只有日期」的全天事件（dateOnly；【有意不同】给出的额外信息）
 *   repeat      'none' | 'weekly'（Python 第 3 步的判定结果）
 *   weekStart   起始周（number）；repeat='none' 时是 null
 *   weekEnd     结束周（number，是**最后一次课**所在的周，不一定等于文件里写的周次上限）；repeat='none' 时是 null
 *   weekParity  'all' | 'odd' | 'even'
 *   count       RRULE 里的 COUNT（number|null，诊断用）
 *   until       RRULE 里的 UNTIL 换算到本地的日期（"YYYY-MM-DD"|null，诊断用）
 *   untilRaw    RRULE 里 UNTIL 的原文（'' 表示没有）
 *   interval    RRULE 的 INTERVAL（单双周时是 2；诊断用，判定看 weekParity）
 *   byday       RRULE 的 BYDAY 原文（'' 表示没有）
 *   periods     节次范围，例如 "7-9" / "7"（'' 表示没写）
 *   dates       展开后的全部日期（升序去重）—— 单次日程就是它里面的每一天
 *   line        第一个来源 VEVENT 的行号（逻辑行号，1 起）
 *   sources     归并了几个原始 VEVENT
 *   tzid        DTSTART 上的 TZID 参数（'' 表示没有）
 *   rruleRaw    第一条 RRULE 的原文
 *   semesterStart  算周次用的学期起点（就是返回结果里那个值）
 */
function parseIcs(text, options) {
  var opts = options || {};
  var warnings = [];
  var notes = [];
  var raw = text ? String(text) : '';

  // 空内容（importer.py:790 parse_any 的「内容为空」）
  if (!raw.trim()) return makeResult([], ['内容为空'], [], null, {}, []);

  // 【有意不同】去掉 UTF-8 BOM：有些导出工具会写 BOM，Python 版的 _split_ics_line
  // 会把第一行认成 "\ufeffBEGIN"，运气不好就整份文件解析不出来。
  if (raw.charAt(0) === '\uFEFF') raw = raw.slice(1);

  var lines = unfoldIcsLines(raw);
  var tzOffsets = collectTzOffsets(lines);
  var records = extractVEvents(lines, tzOffsets, warnings);

  // 一条 VEVENT 都没有（importer.py:587-589）
  if (!records.length) {
    pushWarning(warnings, '没有解析到任何 VEVENT（不是有效的 ICS 文件？）');
    return makeResult([], warnings, notes, null, {}, []);
  }

  // 1) 按「课程名 + 起止时间 + 地点 + 节次」归并（importer.py:596-615）
  var buckets = [];
  var index = {};
  for (var i = 0; i < records.length; i += 1) {
    var record = records[i];
    var title = str(record.title).trim() || UNNAMED_TITLE;
    var startTime = momentHHMM(record.start);
    var endTime = record.end ? momentHHMM(record.end) : '';
    var location = str(record.location).trim();
    var periods = str(record.periods);
    var key = [title, startTime, endTime, location, periods].join(KEY_SEP);

    var bucket = index[key];
    if (!bucket) {
      bucket = {
        title: title,
        description: str(record.description),
        location: location,
        periods: periods,
        startTime: startTime,
        endTime: endTime,
        line: record.line,
        tzid: str(record.tzid),
        allDay: !!record.allDay,
        rrule: record.rrule || null,
        rruleRaw: str(record.rruleRaw),
        dates: [],
        sources: 0,
      };
      index[key] = bucket;
      buckets.push(bucket);
    }
    bucket.sources += 1;
    // Python 的 bucket 不带 description（归并时丢了）；这里保留第一条非空的，
    // 纯粹为了让预览能看到"第几节 / 地点"（【有意不同】，不影响任何判定）
    if (!bucket.description && record.description) bucket.description = str(record.description);
    // 全天标记：只要有一个来源带具体时间，就算有时间的日程
    if (!record.allDay) bucket.allDay = false;
    if (!bucket.rruleRaw && record.rruleRaw) {
      bucket.rrule = record.rrule;
      bucket.rruleRaw = str(record.rruleRaw);
    }
    for (var d = 0; d < record.dates.length; d += 1) bucket.dates.push(record.dates[d]);
  }

  // 2) 学期起点：所有出现日期里最早那一周的周一（importer.py:617-622）
  var allDates = [];
  for (var b = 0; b < buckets.length; b += 1) {
    for (var e = 0; e < buckets[b].dates.length; e += 1) allDates.push(buckets[b].dates[e]);
  }
  var semesterStart = isValidDay(opts.semesterStart) ? opts.semesterStart : null;
  if (!semesterStart && allDates.length) {
    allDates.sort();
    semesterStart = mondayOf(allDates[0]);
  }

  // 3) 每个 bucket → 一个事件；规律 → 每周/单双周，不规律 → 单次日程（importer.py:626-674）
  var events = [];
  for (var g = 0; g < buckets.length; g += 1) {
    var item = buckets[g];
    var dates = uniqueSorted(item.dates);
    if (!dates.length) {
      // 【有意不同】Python 遇到这种情况（例如 COUNT=0）是静默不产生任务的，这里说一声
      pushWarning(warnings, '第 ' + item.line + ' 行：「' + item.title + '」展开后没有任何日期，已跳过');
      continue;
    }
    var info = rruleInfo(item.rrule, tzOffsets);
    var cls = classifyDates(dates, semesterStart);

    events.push({
      line: item.line,
      title: item.title,
      description: item.description,
      location: item.location,
      date: dates[0],
      startTime: item.startTime,
      endTime: item.endTime,
      allDay: item.allDay,
      repeat: cls.repeat,
      weekStart: cls.weekStart,
      weekEnd: cls.weekEnd,
      weekParity: cls.weekParity,
      count: info.count,
      until: info.until,
      untilRaw: info.untilRaw,
      interval: info.interval,
      byday: info.byday,
      periods: item.periods,
      dates: dates,
      sources: item.sources,
      tzid: item.tzid,
      rruleRaw: item.rruleRaw,
      // 这个事件是"按哪个学期起点"算出周次的。盖上章，调用方拿 events 的子集
      // （例如只传前几条）给 toTasks 时，周次基准也不会变。
      semesterStart: semesterStart,
    });

    // 合并说明（importer.py:661-665 / 673-674，措辞照抄）
    if (cls.repeat === REPEAT_WEEKLY) {
      notes.push(item.title + '：合并 ' + dates.length + ' 次为' + PARITY_LABELS[cls.weekParity]
        + '课（第 ' + cls.weekStart + '-' + cls.weekEnd + ' 周）');
      if (cls.weekEnd > MAX_WEEK) {
        pushWarning(warnings, '「' + item.title + '」的周次算到第 ' + cls.weekEnd + ' 周，超过云函数的上限 '
          + MAX_WEEK + ' 周，入库后会被截断到第 ' + MAX_WEEK + ' 周');
      }
    } else if (dates.length > 1) {
      notes.push(item.title + '：' + dates.length + ' 次时间不规律，按单次日程导入');
    }
  }

  // 4) 从「节次 + 起止时间」校准出每一节课的上下课时间（importer.py:676-677）
  var periodTimes = calibratePeriods(records);

  var vevents = [];
  for (var v = 0; v < records.length; v += 1) vevents.push(publicVEvent(records[v], tzOffsets));

  return makeResult(events, warnings, notes, semesterStart, periodTimes, vevents);
}

// ---------------------------------------------------------------------------
// 七、第二层：结构化事件 → 本项目任务对象（可直接 bulk_add）
// ---------------------------------------------------------------------------

/** 时刻文本规范化成 "HH:MM"（与云函数 lib/normalize.js:159 同一口径）。 */
function normalizeClock(value) {
  var text = str(value).trim();
  if (!text) return '';
  var matched = /^(\d{1,2}):(\d{1,2})$/.exec(text);
  if (!matched) return '';
  var hour = parseInt(matched[1], 10);
  var minute = parseInt(matched[2], 10);
  if (hour > 23 || minute > 59) return '';
  return pad2(hour) + ':' + pad2(minute);
}

/** 节次规范化成 "7-9" / "7"（与云函数 lib/normalize.js:365 同一口径）。 */
function normalizePeriods(value) {
  if (Array.isArray(value)) {
    var numbers = [];
    for (var i = 0; i < value.length; i += 1) {
      var parsed = intOrNull(value[i]);
      if (parsed !== null && parsed > 0) numbers.push(parsed);
    }
    if (!numbers.length) return '';
    var low = Math.min.apply(null, numbers);
    var high = Math.max.apply(null, numbers);
    return low === high ? String(low) : low + '-' + high;
  }
  var text = str(value).trim();
  if (!text) return '';
  var matched = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(text);
  if (matched) {
    var first = parseInt(matched[1], 10);
    var last = parseInt(matched[2], 10);
    if (first > 0 && last >= first) return first === last ? String(first) : first + '-' + last;
    return '';
  }
  var single = intOrNull(text);
  return single !== null && single > 0 ? String(single) : '';
}

/** 事件里的日期：优先用 parseIcs 展开好的 dates，其次从 date + 重复信息反推。 */
function datesOf(event, semesterStart) {
  if (Array.isArray(event.dates) && event.dates.length) return uniqueSorted(event.dates);

  var day = str(event.date).trim();
  if (!isValidDay(day)) return [];
  if (str(event.repeat).trim().toLowerCase() !== REPEAT_WEEKLY) return [day];

  // 手写的 weekly 事件：有周次就按周次展开（口径与 exporter.occurrence_weeks 一致），
  // 否则按 count 个星期，再不然就只有这一天（周次交给 week_start/week_end 表达）
  var parity = ALL_PARITIES.indexOf(str(event.weekParity)) !== -1 ? str(event.weekParity) : PARITY_ALL;
  var start = intOrNull(event.weekStart);
  var end = intOrNull(event.weekEnd);
  if (start !== null && end !== null && semesterStart) {
    var weeks = occurrenceWeeks(start, end, parity);
    var weekday = weekdayOf(day);
    var expanded = [];
    for (var i = 0; i < weeks.length; i += 1) {
      var monday = mondayOfWeek(weeks[i], semesterStart);
      if (monday) expanded.push(serialToDay(daySerial(monday) + weekday));
    }
    if (expanded.length) return uniqueSorted(expanded);
  }
  var count = intOrNull(event.count);
  if (count !== null && count > 0) {
    var repeated = [];
    for (var k = 0; k < Math.min(count, MAX_OCCURRENCES); k += 1) repeated.push(serialToDay(daySerial(day) + k * 7));
    return repeated;
  }
  return [day];
}

/**
 * toTasks 用的重复判定：
 *   * 事件带 dates（parseIcs 的产物）→ 按 Python 第 3 步从**真实日期**重算一遍
 *     （与 parseIcs 用的是同一个 classifyDates，所以两层结论一定一致）；
 *   * 事件只有 date/repeat（手写的）→ 尊重它自带的 repeat/week_start/week_end/week_parity，
 *     没写周次时按云函数的默认值 1~20 周。
 */
function classifyForTask(event, dates, semesterStart) {
  if (Array.isArray(event.dates) && event.dates.length) return classifyDates(dates, semesterStart);

  if (str(event.repeat).trim().toLowerCase() === REPEAT_WEEKLY) {
    var start = intOrNull(event.weekStart);
    var end = intOrNull(event.weekEnd);
    var parity = ALL_PARITIES.indexOf(str(event.weekParity)) !== -1 ? str(event.weekParity) : PARITY_ALL;
    if (start === null || start < 1) start = 1;
    if (end === null || end < 1) end = WEEKS_PER_TERM;
    if (end < start) end = start;
    return { repeat: REPEAT_WEEKLY, weekStart: start, weekEnd: end, weekParity: parity };
  }
  return { repeat: REPEAT_NONE, weekStart: null, weekEnd: null, weekParity: PARITY_ALL };
}

/**
 * 第二层：结构化事件 → 本项目的任务对象。
 * 字段名与取值范围和云函数 tasks.bulk_add（lib/normalize.js）完全对齐：
 *   { title, type, date, start_time, end_time, priority, done, parent_id,
 *     repeat, week_start, week_end, week_parity, periods, location, estimate_min }
 * 与 Python 的对应关系：importer.py:626-674 产出的 task dict（Python 一趟做完，
 * 这里因为要分开预览才拆成两层；单次日程仍然是一天一条）。
 *
 * @param {Array} events parseIcs() 的 events（手写的同形对象也收）。
 * @param {{semesterStart?: string, type?: string, priority?: string,
 *          estimate_min?: number, warnings?: string[]}} [options]
 *        semesterStart：算周次用的学期起点（手写事件按周次展开时需要）。
 *        type / priority / estimate_min：每条的默认值（默认 event / mid / 0，与 Python 一致）。
 *        warnings：传数组的话，这里发现的"看不懂"会往里追加（返回值仍然是任务数组）。
 * @returns {Array} 任务对象数组（可能为空；永远不会抛异常）。
 */
function toTasks(events, options) {
  var opts = options || {};
  var type = ALL_TYPES.indexOf(str(opts.type)) !== -1 ? str(opts.type) : TYPE_EVENT;
  var priority = ALL_PRIORITIES.indexOf(str(opts.priority)) !== -1 ? str(opts.priority) : PRIORITY_MID;
  var estimate = intOrNull(opts.estimate_min);
  if (estimate === null || estimate < 0) estimate = 0;
  var sink = Array.isArray(opts.warnings) ? opts.warnings : null;
  var list = Array.isArray(events) ? events : [];
  var tasks = [];

  // 学期起点：算周次（也就决定了"每周 / 单周 / 双周"）必须先有它。
  // 【踩过的坑】toTasks(events) 是单参数调用（pages/me/me.js:350），如果这里只认
  // options.semesterStart，学期起点就是 null → 周次全算不出来 → 每周重复的课会静默退化成
  // "一天一条"，一份 16 周的课表会变成 16 条任务。所以三级兜底：
  //   1) options.semesterStart（调用方在设置里存过的，最权威）
  //   2) 事件自带的 semesterStart（parseIcs 盖的章，取子集时也不会丢基准）
  //   3) 自己按 Python 的规则推断：所有出现日期里最早那一周的周一（importer.py:617-622）
  var semesterStart = isValidDay(opts.semesterStart) ? opts.semesterStart : null;
  var allDays = [];
  for (var a = 0; a < list.length; a += 1) {
    var probe = list[a];
    if (!probe || typeof probe !== 'object') continue;
    if (!semesterStart && isValidDay(probe.semesterStart)) semesterStart = probe.semesterStart;
    if (Array.isArray(probe.dates)) {
      for (var b = 0; b < probe.dates.length; b += 1) {
        if (isValidDay(probe.dates[b])) allDays.push(str(probe.dates[b]).trim());
      }
    } else if (isValidDay(probe.date)) {
      allDays.push(str(probe.date).trim());
    }
  }
  if (!semesterStart && allDays.length) {
    allDays.sort();
    semesterStart = mondayOf(allDays[0]);
  }

  for (var i = 0; i < list.length; i += 1) {
    var event = list[i];
    if (!event || typeof event !== 'object') {
      pushWarning(sink, '第 ' + (i + 1) + ' 个事件不是对象，已跳过');
      continue;
    }

    var title = str(event.title).trim() || UNNAMED_TITLE;
    var startTime = normalizeClock(event.startTime);
    var endTime = normalizeClock(event.endTime);
    if (str(event.startTime).trim() && !startTime) {
      pushWarning(sink, '「' + title + '」的 startTime「' + str(event.startTime) + '」不是合法时刻，已留空');
    }
    if (str(event.endTime).trim() && !endTime) {
      pushWarning(sink, '「' + title + '」的 endTime「' + str(event.endTime) + '」不是合法时刻，已留空');
    }

    var dates = datesOf(event, semesterStart);
    if (!dates.length) {
      pushWarning(sink, '「' + title + '」没有可用的日期（date 缺失或非法），已跳过');
      continue;
    }

    var base = {
      title: title,
      type: type,
      date: '',
      start_time: startTime,
      end_time: endTime,
      priority: priority,
      done: false,
      parent_id: null,
      repeat: REPEAT_NONE,
      week_start: null,
      week_end: null,
      week_parity: PARITY_ALL,
      periods: normalizePeriods(event.periods),
      location: str(event.location).trim(),
      estimate_min: estimate,
    };

    var cls = classifyForTask(event, dates, semesterStart);
    if (cls.repeat === REPEAT_WEEKLY) {
      tasks.push(Object.assign({}, base, {
        date: dates[0],
        repeat: REPEAT_WEEKLY,
        week_start: cls.weekStart,
        week_end: cls.weekEnd,
        week_parity: cls.weekParity,
      }));
      continue;
    }

    // 时间不规律 → 老老实实排成单次日程（Python importer.py:669-672）
    for (var d = 0; d < dates.length; d += 1) {
      tasks.push(Object.assign({}, base, { date: dates[d] }));
    }
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// 八、导出
// ---------------------------------------------------------------------------
module.exports = {
  // 两层接口
  parseIcs: parseIcs,
  toTasks: toTasks,

  // 细分出来的步骤（测试与排错用；语义与 Python 同名函数一一对应）
  unfoldIcsLines: unfoldIcsLines,
  unescapeIcs: unescapeIcs,
  splitIcsLine: splitIcsLine,
  parseIcsDateTime: parseIcsDateTime,
  parseRrule: parseRrule,
  rruleInfo: rruleInfo,
  expandOccurrences: expandOccurrences,
  collectTzOffsets: collectTzOffsets,
  extractVEvents: extractVEvents,
  calibratePeriods: calibratePeriods,
  classifyDates: classifyDates,
  occurrenceWeeks: occurrenceWeeks,
  parsePeriodLabel: parsePeriodLabel,
  rowKey: rowKey,

  // 日期/周次小工具（与 config.py 同名函数对齐）
  mondayOf: mondayOf,
  weekNumberOf: weekNumberOf,
  mondayOfWeek: mondayOfWeek,
  weekdayOf: weekdayOf,
  toMinutes: toMinutes,
  minutesToHHMM: minutesToHHMM,
  roundHalfEven: roundHalfEven,
  roundTo5: roundTo5,

  // 常量
  TYPE_EVENT: TYPE_EVENT,
  TYPE_DDL: TYPE_DDL,
  TYPE_SUBTASK: TYPE_SUBTASK,
  PRIORITY_HIGH: PRIORITY_HIGH,
  PRIORITY_MID: PRIORITY_MID,
  PRIORITY_LOW: PRIORITY_LOW,
  REPEAT_NONE: REPEAT_NONE,
  REPEAT_WEEKLY: REPEAT_WEEKLY,
  PARITY_ALL: PARITY_ALL,
  PARITY_ODD: PARITY_ODD,
  PARITY_EVEN: PARITY_EVEN,
  PARITY_LABELS: PARITY_LABELS,
  WEEKS_PER_TERM: WEEKS_PER_TERM,
  MAX_WEEK: MAX_WEEK,
  MAX_OCCURRENCES: MAX_OCCURRENCES,
  BREAK_MINUTES: BREAK_MINUTES,
  UTC_OFFSET_DEFAULT_MINUTES: UTC_OFFSET_DEFAULT_MINUTES,
  UNNAMED_TITLE: UNNAMED_TITLE,
  ICS_WEEKDAYS: ICS_WEEKDAYS,
  WEEKDAY_LABELS: WEEKDAY_LABELS,
};
