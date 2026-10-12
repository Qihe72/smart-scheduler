/**
 * utils/periods.js —— 移植自 Python 版 `config.py`（作息表 / 节次 / 学期周次部分）。
 *
 * 刻意与 Python 行为保持一致的几点：
 *   1. 节次表 CLASS_PERIODS 与"每节一行"的 PERIOD_ROWS 完全照抄，行数不写死：
 *      periodRows() = 默认作息 ∪ 校准到的节次 ∪ 任务里写过的节次（学校一天 13/14 节都可能）。
 *   2. periodTimeRange() 的 override 语义照抄：校准值只填了一侧时，另一侧退回默认作息；
 *      两侧拼不出合法区间（start >= end）时，**只显示确实推断出来的那一侧**，不给默认值。
 *   3. gapPeriodRange()（午休规则）严格"算不准就不猜"：只有左右**紧邻**两节都校准过、
 *      且中间恰好缺这一节时才认定为空档；缺一边、或连着缺好几节都返回 ("", "")。
 *   4. periodNumberAt() 不是"取第一个命中"，而是按 prefer="start"/"end" 取**最贴近**的那一节
 *      （校准作息与默认作息可能重叠）。
 *   5. periodSpanFromTimes() 保留"只填了结束时间也能定位"的行为。
 *   6. 日期一律按**本地时区**的日历日处理（和 Python 的 date 一样）。
 *      JS 里 `new Date('2026-09-07')` 会按 UTC 解析，所以这里全部用
 *      `new Date(y, m - 1, d)` 手工构造本地日期，避免时区把星期几算错。
 *   7. taskOccursOn() / lastOccurrenceDate() 是与**云函数**共用的口径：
 *      对齐 cloudfunctions/tasks/lib/normalize.js 的 lastOccurrenceDate()，
 *      保证"课表里排不排这节课"和"列表里算不算已结束"永远同一个答案。
 *
 * 返回值的类型约定（贴近 Python）：
 *   - 日期：Date（本地 00:00）或 "YYYY-MM-DD" 字符串都能传入；内部统一转 Date。
 *   - periodTimeRange / effectivePeriodRange / gapPeriodRange：返回 [开始, 结束] 数组，算不出为 ["", ""]。
 *   - parsePeriodSpan / parsePeriodLabel / parsePeriodSpec：返回 [起, 止] 或 null。
 *   - parseWeekSpec：返回 [起周, 止周, 单双周] 或 null（= 不重复）。
 *   - taskOccursOn：返回 boolean；lastOccurrenceDate：返回 "YYYY-MM-DD" 或 null。
 *
 * 导出用 CommonJS，node 可以直接 require 来跑单测。
 */

// ---------------------------------------------------------------------------
// 一、业务常量（照抄 config.py 第四、五节的取值）
// ---------------------------------------------------------------------------
var TYPE_EVENT = 'event';        // 日程：有明确起止时间的一件事
var TYPE_DDL = 'ddl';            // 截止：某个时间点之前必须完成
var TYPE_SUBTASK = 'subtask';    // 子任务：挂在某个日程/截止下的拆解步骤
var ALL_TYPES = [TYPE_EVENT, TYPE_DDL, TYPE_SUBTASK];
var TYPE_LABELS = { event: '日程', ddl: '截止', subtask: '子任务' };

var PRIORITY_HIGH = 'high';
var PRIORITY_MID = 'mid';
var PRIORITY_LOW = 'low';
var ALL_PRIORITIES = [PRIORITY_HIGH, PRIORITY_MID, PRIORITY_LOW];
var PRIORITY_LABELS = { high: '高', mid: '中', low: '低' };
// 数字越小越靠前（high 排最前面）
var PRIORITY_ORDER = { high: 0, mid: 1, low: 2 };

var REPEAT_NONE = 'none';
var REPEAT_WEEKLY = 'weekly';
var ALL_REPEATS = [REPEAT_NONE, REPEAT_WEEKLY];
var REPEAT_LABELS = { none: '不重复', weekly: '每周重复（课程）' };

var PARITY_ALL = 'all';
var PARITY_ODD = 'odd';
var PARITY_EVEN = 'even';
var ALL_PARITIES = [PARITY_ALL, PARITY_ODD, PARITY_EVEN];
var PARITY_LABELS = { all: '每周', odd: '单周', even: '双周' };

// 学期与周次
var SEMESTER_START_DEFAULT = '2026-09-07';   // 开学第一周的周一（与 config.py 一致）
var WEEKS_PER_TERM = 20;                     // 一学期按多少周算

// 中文星期名（Python 的 weekday()：0=周一 … 6=周日）
var WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

// ---------------------------------------------------------------------------
// 二、作息表：把一天切成"一节课一节课"（照抄 config.py CLASS_PERIODS）
// ---------------------------------------------------------------------------
var CLASS_PERIODS = [
  [1, '08:00', '08:45'],
  [2, '08:55', '09:40'],
  [3, '10:00', '10:45'],
  [4, '10:55', '11:40'],
  [5, '14:00', '14:45'],
  [6, '14:55', '15:40'],
  [7, '16:00', '16:45'],
  [8, '16:55', '17:40'],
  [9, '19:00', '19:45'],
  [10, '19:55', '20:40'],
  [11, '20:50', '21:35'],
  [12, '21:40', '22:25'],
  [13, '22:30', '23:15']
];

// 节次号 → [开始, 结束]
var PERIOD_TIMES = {};
for (var _i = 0; _i < CLASS_PERIODS.length; _i++) {
  PERIOD_TIMES[CLASS_PERIODS[_i][0]] = [CLASS_PERIODS[_i][1], CLASS_PERIODS[_i][2]];
}

// 周视图的**默认**行：每节课一行（真实行要用 periodRows() 算）
var PERIOD_ROWS = CLASS_PERIODS.map(function (item) { return [item[0]]; });

// ---------------------------------------------------------------------------
// 三、小工具
// ---------------------------------------------------------------------------
/** 转整数；失败返回 null（对应 Python 的 try: int(...) except: return None）。 */
function toInt(value) {
  if (value === null || value === undefined || value === '') return null;
  var text = String(value).trim();
  if (!/^[+-]?\d+$/.test(text)) return null;
  var n = parseInt(text, 10);
  return isNaN(n) ? null : n;
}

/** "HH:MM" → 当天第几分钟；格式非法返回 null。 */
function toMinutes(hhmm) {
  if (hhmm === null || hhmm === undefined) return null;
  var parts = String(hhmm).trim().split(':');
  if (parts.length < 2) return null;
  var hour = toInt(parts[0]);
  var minute = toInt(parts[1]);
  if (hour === null || minute === null) return null;
  return hour * 60 + minute;
}

/** 当天第几分钟 → "HH:MM"。 */
function toHHMM(minutes) {
  var n = Math.trunc(Number(minutes) || 0);
  var hour = Math.floor(n / 60);
  var minute = n % 60;
  return (hour < 10 ? '0' + hour : String(hour)) + ':' + (minute < 10 ? '0' + minute : String(minute));
}

/**
 * 当天第几分钟 → "HH:MM"（toHHMM 的别名，页面里叫 formatMinutes 更顺口）。
 *
 * 容错：null / undefined / 非数字 / 空串一律返回 ""（而不是 "00:00"），
 * 这样页面可以直接用 `formatMinutes(x) || '--:--'` 判断"没填时间"。
 */
function formatMinutes(minutes) {
  if (minutes === null || minutes === undefined || minutes === '') return '';
  var n = Number(minutes);
  if (!isFinite(n)) return '';
  return toHHMM(n);
}

/** "YYYY-MM-DD" → 本地 00:00 的 Date；非法返回 null（等价 Python date.fromisoformat 的失败）。 */
function parseDate(value) {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : new Date(value.getFullYear(), value.getMonth(), value.getDate());
  var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value === null || value === undefined ? '' : value).trim());
  if (!match) return null;
  var year = parseInt(match[1], 10);
  var month = parseInt(match[2], 10);
  var day = parseInt(match[3], 10);
  var date = new Date(year, month - 1, day);
  // 回读校验，挡掉 2026-02-30 这种"会自动进位"的非法日期
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

/** Date → "YYYY-MM-DD"。 */
function formatDate(date) {
  var d = parseDate(date);
  if (!d) return '';
  var month = d.getMonth() + 1;
  var day = d.getDate();
  return d.getFullYear() + '-' + (month < 10 ? '0' + month : month) + '-' + (day < 10 ? '0' + day : day);
}

/** 把 Date / "YYYY-MM-DD" 统一成 Date；失败返回 null。 */
function toDate(value) {
  return parseDate(value);
}

/** 日期加天数，返回新的本地 Date。 */
function addDays(date, days) {
  var d = parseDate(date);
  if (!d) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + Math.trunc(Number(days) || 0));
}

/** 用"年月日"算出的整数天序号：不受夏令时影响（时区安全）。 */
function dayIndex(date) {
  var d = parseDate(date);
  if (!d) return null;
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}

/** Python 的 weekday()：0=周一 … 6=周日。 */
function weekdayOf(date) {
  var d = parseDate(date);
  if (!d) return null;
  return (d.getDay() + 6) % 7;
}

// ---------------------------------------------------------------------------
// 四、节次时间与校准（config.py 第六节）
// ---------------------------------------------------------------------------
/**
 * 返回第 N 节课的起止时间。对应 Python period_time_range()。
 * @param {number|string} number 节次号
 * @param {Object} override 校准表 {"1": ["08:30","09:10"], ...}
 * @returns {Array<string>} [开始, 结束]
 */
function periodTimeRange(number, override) {
  var n = toInt(number);
  if (n === null) return ['', ''];
  var fallback = PERIOD_TIMES[n] || ['', ''];
  var defaultStart = fallback[0] || '';
  var defaultEnd = fallback[1] || '';

  if (override && typeof override === 'object') {
    var saved = override[String(n)];
    if (Array.isArray(saved) && saved.length === 2) {
      // 空值退回默认作息（Python 的 `saved[0] or default_start`）
      var start = String(saved[0] || defaultStart || '');
      var end = String(saved[1] || defaultEnd || '');
      var startMin = toMinutes(start);
      var endMin = toMinutes(end);
      if (startMin !== null && endMin !== null && startMin < endMin) return [start, end];
      // 校准值和默认值拼不出合法区间时，只显示确实推断出来的那一侧
      return [String(saved[0] || ''), String(saved[1] || '')];
    }
  }
  return [defaultStart, defaultEnd];
}

/**
 * 把校准表里"起止都合法"的节次挑出来。对应 Python calibrated_periods()。
 * @returns {Object} {节次号: [开始分钟, 结束分钟]}
 */
function calibratedPeriods(override) {
  var result = {};
  if (!override || typeof override !== 'object') return result;
  var keys = Object.keys(override);
  for (var i = 0; i < keys.length; i++) {
    var number = toInt(keys[i]);
    if (number === null) continue;
    var value = override[keys[i]];
    if (!Array.isArray(value) || value.length !== 2) continue;
    var start = toMinutes(value[0]);
    var end = toMinutes(value[1]);
    if (start === null || end === null || start >= end) continue;
    result[number] = [start, end];
  }
  return result;
}

/**
 * 没校准到的节次：用左右**紧邻**两节的校准值夹出中间那段空档（典型例子是午休）。
 * 对应 Python gap_period_range()：算不出来就返回 ["", ""]，交给默认作息兜底，不瞎猜。
 */
function gapPeriodRange(number, override) {
  var n = toInt(number);
  if (n === null) return ['', ''];
  var calibrated = calibratedPeriods(override);
  if (Object.prototype.hasOwnProperty.call(calibrated, n)) return ['', ''];
  var previous = n - 1;
  var following = n + 1;
  if (!Object.prototype.hasOwnProperty.call(calibrated, previous)) return ['', ''];
  if (!Object.prototype.hasOwnProperty.call(calibrated, following)) return ['', ''];
  var gapStart = calibrated[previous][1];
  var gapEnd = calibrated[following][0];
  if (gapStart >= gapEnd) return ['', ''];
  return [toHHMM(gapStart), toHHMM(gapEnd)];
}

/** 这个节次是不是"没课的空档"（例如午休）。 */
function isBreakPeriod(number, override) {
  return !!gapPeriodRange(number, override)[0];
}

/** 空档行的显示名：中午那段叫"午休"，其他时段叫"休息"；不是空档返回 ""。 */
function breakLabel(number, override) {
  var gap = gapPeriodRange(number, override);
  var start = gap[0] ? toMinutes(gap[0]) : null;
  if (start === null) return '';
  return (start >= 11 * 60 && start < 15 * 60) ? '午休' : '休息';
}

/** 一节"实际占哪段时间"：中间空档（午休）→ 校准值 → 默认作息。匹配时刻和画课表走同一口径。 */
function effectivePeriodRange(number, override) {
  var gap = gapPeriodRange(number, override);
  if (gap[0]) return gap;
  return periodTimeRange(number, override);
}

/** 课表一行的起止时间（行 = 一节课）。 */
function rowTimeRange(row, override) {
  try {
    if (!row || row.length === 0) return ['', ''];
    return effectivePeriodRange(row[0], override);
  } catch (err) {
    return ['', ''];
  }
}

/** 一行的显示名：例如 [7] → "第7节"；没校准到的空档行 → "午休"。 */
function rowLabel(row, override) {
  try {
    if (!row || row.length === 0) return '';
    if (row.length === 1) return breakLabel(row[0], override) || ('第' + row[0] + '节');
    return '第' + row[0] + '-' + row[row.length - 1] + '节';
  } catch (err) {
    return '';
  }
}

/** 一行的短标识：[7] → "7"；[1,2] → "1-2"（用作设置里的键）。 */
function rowKey(row) {
  try {
    if (!row || row.length === 0) return '';
    if (row.length === 1) return String(row[0]);
    return row[0] + '-' + row[row.length - 1];
  } catch (err) {
    return '';
  }
}

/** 课表到底有哪几节：默认作息 ∪ 校准到的节次 ∪ 额外指定的节次，升序。 */
function periodNumbers(override, extra) {
  var numbers = [];
  for (var i = 0; i < CLASS_PERIODS.length; i++) numbers.push(CLASS_PERIODS[i][0]);
  var sources = [override || {}, extra || []];
  for (var s = 0; s < sources.length; s++) {
    var source = sources[s];
    var keys;
    if (Array.isArray(source)) {
      keys = source;
    } else if (source && typeof source === 'object') {
      keys = Object.keys(source);
    } else {
      continue;
    }
    for (var k = 0; k < keys.length; k++) {
      var number = toInt(keys[k]);
      if (number === null || number <= 0) continue;
      if (numbers.indexOf(number) === -1) numbers.push(number);
    }
  }
  numbers.sort(function (a, b) { return a - b; });
  return numbers;
}

/** 课表的行：一天有哪几节就有几行，例如 [[1],[2],…,[13],[14]]。 */
function periodRows(override, extra) {
  return periodNumbers(override, extra).map(function (number) { return [number]; });
}

/** 返回包含某个节次的行，例如 [7]；没有则 null。 */
function rowForPeriod(number, rows) {
  var n = toInt(number);
  if (n === null) return null;
  var table = rows || PERIOD_ROWS;
  for (var i = 0; i < table.length; i++) {
    if (table[i].indexOf(n) !== -1) return table[i];
  }
  return null;
}

/** 某个节次对应的行下标；不在表里返回 null。 */
function rowIndexOfPeriod(number, rows) {
  var table = rows || PERIOD_ROWS;
  var row = rowForPeriod(number, table);
  if (row === null) return null;
  for (var i = 0; i < table.length; i++) {
    if (table[i] === row) return i;
  }
  return null;
}

/**
 * 判断某个时刻属于第几节课。对应 Python period_number_at()。
 * 不是取第一个命中的，而是按"最贴近"选：prefer="start" 取开始时间最接近的，
 * prefer="end" 取结束时间最接近的。命中并列时取节次号小的（等价 Python 对 (距离, 节次) 排序）。
 */
function periodNumberAt(hhmm, override, prefer) {
  var minutes = toMinutes(hhmm);
  if (minutes === null) return null;
  var mode = prefer === 'end' ? 'end' : 'start';
  var numbers = periodNumbers(override);
  var hits = [];
  for (var i = 0; i < numbers.length; i++) {
    var range = effectivePeriodRange(numbers[i], override);
    var begin = toMinutes(range[0]);
    var finish = toMinutes(range[1]);
    if (begin === null || finish === null) continue;
    if (begin <= minutes && minutes <= finish) {
      var distance = mode === 'end' ? Math.abs(finish - minutes) : Math.abs(begin - minutes);
      hits.push([distance, numbers[i]]);
    }
  }
  if (!hits.length) return null;
  hits.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
  return hits[0][1];
}

/**
 * 解析"节次范围"字段，例如 "7-9" / "第7-9节" / "7"。
 * 要求整串就是节次，不会在长文本里乱抓数字（那是 parsePeriodLabel 的活）。
 */
function parsePeriodSpan(text) {
  var raw = String(text === null || text === undefined ? '' : text).trim();
  if (!raw) return null;
  var match = /^第?\s*(\d{1,2})\s*(?:[-~—–到至]\s*(\d{1,2}))?\s*节?$/.exec(raw);
  if (!match) return null;
  var first = parseInt(match[1], 10);
  var last = match[2] ? parseInt(match[2], 10) : first;
  if (last < first) { var tmp = first; first = last; last = tmp; }
  return [first, last];
}

/**
 * 按起止时间反推这条日程占哪几节课。
 * 只填了结束时间（例如"11:30 前完成"）时，按结束时刻所在的那节课定位，不当成"没有时间"。
 */
function periodSpanFromTimes(startTime, endTime, override) {
  var first = periodNumberAt(startTime, override, 'start');
  if (first === null) {
    var onlyEnd = periodNumberAt(endTime, override, 'end');
    if (onlyEnd === null) return null;
    return [onlyEnd, onlyEnd];
  }
  var last = endTime ? periodNumberAt(endTime, override, 'end') : null;
  if (last === null || last < first) last = first;
  return [first, last];
}

/** 从课表描述里解析节次范围，例如 "第7 - 9节" → [7,9]、"第3节" → [3,3]。 */
function parsePeriodLabel(text) {
  var raw = String(text === null || text === undefined ? '' : text);
  var match = /第?\s*(\d{1,2})\s*(?:[-~—–到至]\s*(\d{1,2}))?\s*节/.exec(raw);
  if (!match) return null;
  var first = parseInt(match[1], 10);
  var last = match[2] ? parseInt(match[2], 10) : first;
  if (last < first) { var tmp = first; first = last; last = tmp; }
  return [first, last];
}

/**
 * 判断某个开始时间落在课表的哪一行（行 = 一节课）。
 * 同时落在多行（校准作息可能有重叠）时取**起点最接近**的那一行；
 * 没有时间或不在任何节次内返回 null（由界面放进"其他时段"）。
 */
function periodRowIndex(startTime, override) {
  var minutes = toMinutes(startTime);
  if (minutes === null) return null;
  var rows = periodRows(override);
  var hits = [];
  for (var index = 0; index < rows.length; index++) {
    var range = effectivePeriodRange(rows[index][0], override);
    var begin = toMinutes(range[0]);
    var finish = toMinutes(range[1]);
    if (begin === null || finish === null) continue;
    if (begin <= minutes && minutes <= finish) hits.push([Math.abs(begin - minutes), index]);
  }
  if (!hits.length) return null;
  hits.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
  return hits[0][1];
}

/** 按节次号定位课表行（导入的课表自带节次时用这个，比按时间猜更准）。 */
function periodRowIndexByPeriod(number, override) {
  return rowIndexOfPeriod(number, periodRows(override));
}

/** 把"第1-2节 / 1-2 / 第3节 / 3"解析成 [开始时间, 结束时间]（用**默认作息**，不看校准表）。 */
function parsePeriodSpec(text) {
  var raw = String(text === null || text === undefined ? '' : text).trim();
  if (!raw) return null;
  var match = /^第?\s*(\d{1,2})\s*(?:[-~—到至]\s*(\d{1,2}))?\s*节?$/.exec(raw);
  if (!match) return null;
  var first = parseInt(match[1], 10);
  var last = match[2] ? parseInt(match[2], 10) : first;
  if (!PERIOD_TIMES[first] || !PERIOD_TIMES[last] || last < first) return null;
  return [PERIOD_TIMES[first][0], PERIOD_TIMES[last][1]];
}

// ---------------------------------------------------------------------------
// 五、学期与周次（config.py 第七节）
// ---------------------------------------------------------------------------
/** 返回某一天所在周的周一（Date）。 */
function mondayOf(day) {
  var d = parseDate(day);
  if (!d) return null;
  return addDays(d, -weekdayOf(d));
}

/** 计算某一天是开学第几周（第 1 周 = 开学第一周的周一那一周）；开学前返回 null。 */
function weekNumberOf(day, semesterStart) {
  var start = mondayOf(semesterStart);
  var target = mondayOf(day);
  if (!start || !target) return null;
  var deltaDays = dayIndex(target) - dayIndex(start);
  if (deltaDays < 0) return null;   // 开学之前，不算周次
  return Math.floor(deltaDays / 7) + 1;
}

/** 返回第 weekNo 周的周一（Date）。 */
function mondayOfWeek(weekNo, semesterStart) {
  var start = mondayOf(semesterStart);
  if (!start) return null;
  var week = Math.max(toInt(weekNo) === null ? 1 : toInt(weekNo), 1);
  return addDays(start, (week - 1) * 7);
}

/** 返回某一周是单周还是双周。 */
function weekParity(weekNo) {
  return (toInt(weekNo) || 0) % 2 === 1 ? PARITY_ODD : PARITY_EVEN;
}

/**
 * 解析课程表里的"周次"写法。
 * 支持：1-16 / 1-16周 / 第1-16周 / 1-8单 / 1-16双周 / 3 / 单周
 * @returns {Array|null} [起周, 止周, 单双周]；表示"不重复"时返回 null。
 */
function parseWeekSpec(text) {
  var raw = String(text === null || text === undefined ? '' : text).trim();
  if (!raw) return null;
  if (raw === '全部' || raw === '每周' || raw === '全周' || raw === '每周重复') return null;

  // 只写了"单周 / 双周"：默认整学期
  if (raw === '单' || raw === '单周') return [1, WEEKS_PER_TERM, PARITY_ODD];
  if (raw === '双' || raw === '双周') return [1, WEEKS_PER_TERM, PARITY_EVEN];

  var match = /^第?\s*(\d{1,2})\s*(?:[-~—–到至]\s*(\d{1,2}))?\s*周?\s*(单|双)?\s*周?$/.exec(raw);
  if (!match) return null;
  var first = parseInt(match[1], 10);
  var last = match[2] ? parseInt(match[2], 10) : first;
  if (last < first) { var tmp = first; first = last; last = tmp; }
  var parity = PARITY_ALL;
  if (match[3] === '单') parity = PARITY_ODD;
  else if (match[3] === '双') parity = PARITY_EVEN;
  return [first, last, parity];
}

/**
 * ===========================================================================
 * 六、重复规则："这节课今天上不上" + "最后一次课是哪天"
 * ===========================================================================
 * 这一节的口径必须和云函数里的 lib/normalize.js **完全一致**，否则会出现
 * "列表里显示已结束、课表里却还在排课"这种自相矛盾的界面。
 *
 * 任务里和重复有关的字段（都是 normalize.js 归一化后落库的形态）：
 *   date         锚点日期 "YYYY-MM-DD"。**非每周重复时它就是那一天本身**；
 *                每周重复时它决定"周几上课"，同时是这门课第一次上课的日子。
 *   repeat       'none'（只在那一天）| 'weekly'（每周重复，课程）
 *   week_start   起始周（1 起，只有 weekly 才有值，其余为 null）
 *   week_end     结束周（1 起，只有 weekly 才有值，其余为 null）
 *   week_parity  'all' 每周 | 'odd' 单周 | 'even' 双周
 * ===========================================================================
 */

/** 归一化"重复方式"：认不出来按不重复处理（与 normalize.js 的容错一致）。 */
function normalizeRepeat(value) {
  return String(value === null || value === undefined ? '' : value).trim().toLowerCase() === REPEAT_WEEKLY
    ? REPEAT_WEEKLY
    : REPEAT_NONE;
}

/** 归一化"单双周"：认不出来按每周处理。 */
function normalizeParity(value) {
  var text = String(value === null || value === undefined ? '' : value).trim().toLowerCase();
  if (text === PARITY_ODD) return PARITY_ODD;
  if (text === PARITY_EVEN) return PARITY_EVEN;
  return PARITY_ALL;
}

/** 取"第几周"：越界（<1 或 >30）时返回 null，交给调用方兜底。 */
function weekWithinTerm(value) {
  var n = toInt(value);
  if (n === null || n < 1 || n > 30) return null;
  return n;
}

/** 某一天在这一年里"是第几天"（时区安全，只用来比大小）。 */
function daySerial(dateStr) {
  return dayIndex(dateStr);
}

/**
 * 这门课在这一天到底上不上？对应 Python 版 schedule_manager 里的 occurs_on()。
 *
 * 判断顺序（任一步不满足就返回 false）：
 *   1. 不是每周重复 → 只有 date 与 dateStr 是同一天才成立；
 *   2. 星期几要和锚点日期的星期几一致；
 *   3. 不能早于锚点日期（第一次上课之前当然没有课）；
 *   4. 算不出周次（学期开始日期没设置 / 在开学之前）→ **宁可显示也不漏课**，返回 true；
 *   5. 周次必须落在 [week_start, week_end] 内；
 *   6. 单双周要匹配（单周课只在奇数周上）。
 *
 * @param {Object} task 任务对象（云数据库里那一条）
 * @param {string} dateStr 要判断的日期 "YYYY-MM-DD"
 * @param {string} semesterStart 开学第一周的周一 "YYYY-MM-DD"（可为空）
 * @returns {boolean}
 */
function taskOccursOn(task, dateStr, semesterStart) {
  if (!task || typeof task !== 'object') return false;

  var day = parseDate(dateStr);
  if (!day) return false;

  // 1. 不重复：只有那一天算数
  if (normalizeRepeat(task.repeat) !== REPEAT_WEEKLY) {
    var anchorOnly = parseDate(task.date);
    return !!anchorOnly && dayIndex(anchorOnly) === dayIndex(day);
  }

  var anchor = parseDate(task.date);
  if (!anchor) return false; // 每周重复却没有锚点日期 → 无法判断周几，当作不上

  // 2. 周几要一致（date 是这门课第一次上课的那天）
  if (weekdayOf(anchor) !== weekdayOf(day)) return false;

  // 3. 第一次上课之前没有课
  if (daySerial(day) < daySerial(anchor)) return false;

  // 4. 周次算不出来（没设开学日期 / 在开学之前）时不过滤，避免整张课表变空
  var weekNo = weekNumberOf(dateStr, semesterStart);
  if (weekNo === null) return true;

  // 5. 周次范围：缺省 start=1、end=20（与 normalize.js 的默认值一致）
  var weekStart = weekWithinTerm(task.week_start);
  var weekEnd = weekWithinTerm(task.week_end);
  if (weekStart !== null && weekNo < weekStart) return false;
  if (weekEnd !== null && weekNo > weekEnd) return false;

  // 6. 单双周
  var parity = normalizeParity(task.week_parity);
  if (parity === PARITY_ALL) return true;
  return weekParity(weekNo) === parity;
}

/**
 * 每周重复的这门课"最后一次上课"是哪天；不是每周重复 / 数据不全返回 null。
 *
 * 与云函数 lib/normalize.js 的 lastOccurrenceDate() **逐字对齐**：
 * 从 week_end 往前退，退到第一个单双周匹配的周；退到 week_start 之前
 * 说明按这个单双周它一次也上不了，返回 null。
 *
 * @param {Object} task 任务对象
 * @param {string} semesterStart 开学第一周的周一
 * @returns {string|null} "YYYY-MM-DD"
 */
function lastOccurrenceDate(task, semesterStart) {
  if (!task || typeof task !== 'object') return null;
  if (normalizeRepeat(task.repeat) !== REPEAT_WEEKLY) return null;

  var anchor = parseDate(task.date);
  if (!anchor) return null; // 没有原始日期就不知道是星期几

  var weekEnd = weekWithinTerm(task.week_end);
  if (weekEnd === null) return null;

  var weekStart = weekWithinTerm(task.week_start);
  if (weekStart === null) weekStart = 1;

  var parity = normalizeParity(task.week_parity);
  var week = weekEnd;
  if (parity !== PARITY_ALL) {
    var guard = 0;
    // 最多退 31 次足够了（一学期最多 30 周），防止脏数据把这里变成死循环
    while (week >= weekStart && weekParity(week) !== parity && guard < 31) {
      week -= 1;
      guard += 1;
    }
    if (week < weekStart) return null; // 按这个单双周要求，它一次也上不了
  }

  var monday = mondayOfWeek(week, semesterStart);
  if (!monday) return null;
  var index = weekdayOf(anchor);
  if (index === null) return null;
  // 用"第一次上课那天是周几"推出最后一次课落在那一周的哪一天
  var last = addDays(monday, index);
  return last ? formatDate(last) : null;
}

module.exports = {
  // 常量
  TYPE_EVENT: TYPE_EVENT,
  TYPE_DDL: TYPE_DDL,
  TYPE_SUBTASK: TYPE_SUBTASK,
  ALL_TYPES: ALL_TYPES,
  TYPE_LABELS: TYPE_LABELS,
  PRIORITY_HIGH: PRIORITY_HIGH,
  PRIORITY_MID: PRIORITY_MID,
  PRIORITY_LOW: PRIORITY_LOW,
  ALL_PRIORITIES: ALL_PRIORITIES,
  PRIORITY_LABELS: PRIORITY_LABELS,
  PRIORITY_ORDER: PRIORITY_ORDER,
  REPEAT_NONE: REPEAT_NONE,
  REPEAT_WEEKLY: REPEAT_WEEKLY,
  ALL_REPEATS: ALL_REPEATS,
  REPEAT_LABELS: REPEAT_LABELS,
  PARITY_ALL: PARITY_ALL,
  PARITY_ODD: PARITY_ODD,
  PARITY_EVEN: PARITY_EVEN,
  ALL_PARITIES: ALL_PARITIES,
  PARITY_LABELS: PARITY_LABELS,
  SEMESTER_START_DEFAULT: SEMESTER_START_DEFAULT,
  WEEKS_PER_TERM: WEEKS_PER_TERM,
  WEEKDAY_LABELS: WEEKDAY_LABELS,
  CLASS_PERIODS: CLASS_PERIODS,
  PERIOD_TIMES: PERIOD_TIMES,
  PERIOD_ROWS: PERIOD_ROWS,

  // 工具
  toInt: toInt,
  toMinutes: toMinutes,
  toHHMM: toHHMM,
  formatMinutes: formatMinutes,
  parseDate: parseDate,
  formatDate: formatDate,
  toDate: toDate,
  addDays: addDays,
  dayIndex: dayIndex,
  weekdayOf: weekdayOf,

  // 作息 / 节次
  periodTimeRange: periodTimeRange,
  calibratedPeriods: calibratedPeriods,
  gapPeriodRange: gapPeriodRange,
  isBreakPeriod: isBreakPeriod,
  breakLabel: breakLabel,
  effectivePeriodRange: effectivePeriodRange,
  rowTimeRange: rowTimeRange,
  rowLabel: rowLabel,
  rowKey: rowKey,
  periodNumbers: periodNumbers,
  periodRows: periodRows,
  rowForPeriod: rowForPeriod,
  rowIndexOfPeriod: rowIndexOfPeriod,
  periodNumberAt: periodNumberAt,
  parsePeriodSpan: parsePeriodSpan,
  periodSpanFromTimes: periodSpanFromTimes,
  parsePeriodLabel: parsePeriodLabel,
  periodRowIndex: periodRowIndex,
  periodRowIndexByPeriod: periodRowIndexByPeriod,
  parsePeriodSpec: parsePeriodSpec,

  // 学期 / 周次
  mondayOf: mondayOf,
  weekNumberOf: weekNumberOf,
  mondayOfWeek: mondayOfWeek,
  weekParity: weekParity,
  parseWeekSpec: parseWeekSpec,

  // 重复规则（口径与云函数 lib/normalize.js 对齐）
  taskOccursOn: taskOccursOn,
  lastOccurrenceDate: lastOccurrenceDate
};
