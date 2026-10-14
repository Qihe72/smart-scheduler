/**
 * utils/tasks.js —— 任务的三种状态 + 前端归一化（逐函数移植自 Python 版 task_manager.py）。
 *
 * ===========================================================================
 * 【这个文件和 cloudfunctions/tasks/lib/normalize.js 是什么关系？（别删任何一份）】
 * ===========================================================================
 *   两份**都必须存在**，职责不同：
 *
 *   * cloudfunctions/tasks/lib/normalize.js —— **服务端校验**。
 *     它是入库前的最后一道闸门，跑在云函数里；服务端**永远不能信任前端**，
 *     所以它必须独立存在、独立演进。哪怕前端已经校验过一遍，云端也要再校验一遍。
 *
 *   * utils/tasks.js（本文件） —— **前端展示 / 预校验**。
 *     用途有两个：
 *       1. 列表页、课表页要当场判断「这条任务现在是待办 / 已完成 / 已结课」，
 *          不能为了显示一个标签就去问一次云函数；
 *       2. 编辑页在提交之前先归一化一遍，把明显不合法的字段拦在本地，
 *          省一次往返、也给用户更快的反馈。
 *
 *   两者**字段口径必须一致**（同样的字段名、同样的默认值），但实现各写各的。
 *   任何一边改了字段规则，另一边要跟着改 —— 这是刻意的重复，不是疏漏。
 *
 * ===========================================================================
 * 【与 Python 版 task_manager.py 的对应关系】
 * ===========================================================================
 *   is_task_finished()   → isTaskFinished(task, semesterStart, now)
 *   occurrence_passed()  → occurrencePassed(task, day, now)
 *   ends_this_week()     → endsThisWeek(task, semesterStart, now)
 *   _normalize_task()    → normalizeTask(raw)（+ 只归一化 patch 的 pickPatch）
 *   task_occurs_on()     → 用 utils/periods.js 的 taskOccursOn()（已实现，见那边）
 *   last_occurrence_date()→ 用 utils/periods.js 的 lastOccurrenceDate()（已实现）
 *
 * 日期一律按**本地时区**的日历日处理（和 Python 的 date 一样）；见 periods.js 文件头。
 */

'use strict';

var periods = require('./periods.js');

// ---------------------------------------------------------------------------
// 常量（与 periods.js / normalize.js 的取值保持一致）
// ---------------------------------------------------------------------------
var TYPE_EVENT = periods.TYPE_EVENT;              // 'event'
var TYPE_DDL = periods.TYPE_DDL;                  // 'ddl'
var TYPE_SUBTASK = periods.TYPE_SUBTASK;          // 'subtask'
var ALL_TYPES = periods.ALL_TYPES;                // ['event','ddl','subtask']
var TYPE_LABELS = periods.TYPE_LABELS;            // { event:'日程', ddl:'截止', subtask:'子任务' }

var ALL_PRIORITIES = periods.ALL_PRIORITIES;      // ['high','mid','low']
var PRIORITY_LABELS = periods.PRIORITY_LABELS;    // { high:'高', mid:'中', low:'低' }

var REPEAT_NONE = periods.REPEAT_NONE;            // 'none'
var REPEAT_WEEKLY = periods.REPEAT_WEEKLY;        // 'weekly'
var REPEAT_DAILY = periods.REPEAT_DAILY;          // 'daily'（打卡 / 习惯；含周末）
var ALL_REPEATS = periods.ALL_REPEATS;            // ['none','weekly','daily']（校验报错时列全）

var PARITY_ALL = periods.PARITY_ALL;              // 'all'
var PARITY_ODD = periods.PARITY_ODD;              // 'odd'
var PARITY_EVEN = periods.PARITY_EVEN;            // 'even'

/** 三种状态的取值（页面里直接拿来当 class 名 / 文案的键） */
var STATE_DONE = 'done';           // 手动勾选完成
var STATE_FINISHED = 'finished';   // 每周重复的课已经结课
var STATE_PENDING = 'pending';     // 待办

/** 状态的中文名（列表页的筛选按钮直接用） */
var STATE_LABELS = { done: '已完成', finished: '已结课', pending: '待办' };

/** 预计耗时上限：24 小时（与 normalize.js 的 MAX_ESTIMATE_MIN 一致） */
var MAX_ESTIMATE_MIN = 1440;

/** 周次取值范围（与 normalize.js 的 MIN_WEEK / MAX_WEEK 一致） */
var MIN_WEEK = 1;
var MAX_WEEK = 30;
var DEFAULT_WEEK_END = 20;   // periods.WEEKS_PER_TERM

/**
 * 入库字段白名单（与 normalize.js 的 TASK_FIELDS 完全一致）。
 * 名单之外的键一律进 rejected：包括 _id / _openid / created_at / updated_at
 * 这些**系统字段**（它们只能由云端管理，前端连传都不该传）。
 */
var TASK_FIELDS = [
  'title', 'type', 'date', 'start_time', 'end_time', 'priority', 'done',
  'parent_id', 'repeat', 'week_start', 'week_end', 'week_parity',
  'periods', 'location', 'estimate_min'
];

// ---------------------------------------------------------------------------
// 一、基础工具
// ---------------------------------------------------------------------------

/** 是不是「有内容的对象」（刻意不用 instanceof，跨包更稳） */
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 转成去空白的字符串；null / undefined / 对象一律变成 ""（与 normalize.js 的 toStr 一致） */
function toStr(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  return '';
}

/** 两位补零 */
function pad2(number) {
  return (number < 10 ? '0' : '') + number;
}

/** 容错整数：'60' / 60.4 / '60分钟' → 60（前缀取数）；非法 → fallback */
function safeInt(value, fallback) {
  if (typeof value === 'number') return isFinite(value) ? Math.trunc(value) : fallback;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'string') return fallback;
  var matched = value.trim().match(/^[+-]?\d+/);
  if (!matched) return fallback;
  var n = parseInt(matched[0], 10);
  return isNaN(n) ? fallback : n;
}

/** 今天的日期（本地时区，"YYYY-MM-DD"） */
function todayStr(base) {
  var d = base instanceof Date && !isNaN(base.getTime()) ? base : new Date();
  return periods.formatDate(d);
}

/** 现在（本地时区，"YYYY-MM-DD HH:MM"），用于 created_at / 展示 */
function nowStr(base) {
  var d = base instanceof Date && !isNaN(base.getTime()) ? base : new Date();
  return periods.formatDate(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/** 严格校验 YYYY-MM-DD，并且这个日期在日历上真实存在（挡掉 2026-02-30） */
function isValidDate(value) {
  return periods.parseDate(value) !== null;
}

/** 严格校验 HH:MM（00:00 ~ 23:59）；空字符串视为合法（表示"没填"） */
function isValidTime(value) {
  var text = toStr(value);
  if (!text) return true;
  var matched = text.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!matched) return false;
  var hour = Number(matched[1]);
  var minute = Number(matched[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

/** HH:MM 统一补零成两位（"9:5" → "09:05"）；非法返回 "" */
function normalizeTime(value) {
  var text = toStr(value);
  if (!text) return '';
  var matched = text.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!matched) return '';
  var hour = Number(matched[1]);
  var minute = Number(matched[2]);
  if (hour > 23 || minute > 59) return '';
  return pad2(hour) + ':' + pad2(minute);
}

/**
 * 把 now 参数统一成 Date（可注入，便于单测）。
 *
 * 接受三种写法：
 *   * Date 对象 —— 直接用（页面里通常传 new Date()）
 *   * "YYYY-MM-DD HH:MM" —— 手工构造**本地**时间，避免 Date 解析字符串时的时区坑
 *   * "HH:MM" —— 只给时刻（日期取今天）：专供"最后一次课就在今天，下课了没"这种分钟级边界
 * 其余（null / undefined / 乱码）→ 当前时刻。
 */
function toDate(value) {
  if (value instanceof Date) return isNaN(value.getTime()) ? new Date() : value;
  var text = toStr(value);
  if (!text) return new Date();

  var full = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{1,2})/);
  if (full) {
    return new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]),
      Number(full[4]), Number(full[5]), 0, 0);
  }
  var clock = text.match(/^(\d{1,2}):(\d{1,2})$/);
  if (clock) {
    var today = toDate(new Date());
    return new Date(today.getFullYear(), today.getMonth(), today.getDate(),
      Number(clock[1]), Number(clock[2]), 0, 0);
  }
  var onlyDate = periods.parseDate(text);
  if (onlyDate) return onlyDate;
  return new Date();
}

/** 取一个 Date 的「当天第几分钟」（用来做分钟级比较） */
function minutesOfDate(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/** "HH:MM" → 当天第几分钟；格式非法返回 null（null 表示"没法比"，一律按保守处理） */
function minutesOfTime(hhmm) {
  var text = toStr(hhmm);
  if (!text) return null;
  var matched = text.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!matched) return null;
  var hour = Number(matched[1]);
  var minute = Number(matched[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

// ---------------------------------------------------------------------------
// 二、三种状态：待办 / 已完成 / 已结课
// ---------------------------------------------------------------------------

/**
 * 归一化"重复方式"：认不出来按不重复。
 *
 * 【为什么直接委托给 periods】这里曾经自己写了一份 `text === 'weekly' ? weekly : none`。
 * 加"每天"时只改了 periods，这一份漏了 —— 结果界面能选每天、云端也能存，
 * **本地归一化却把它抹成单次**（保存完变成"不重复"）。判据只能有一份。
 */
function normalizeRepeat(value) {
  return periods.normalizeRepeat(value);
}

/** 归一化"单双周"：认不出来按每周（同上：直接委托，不抄第二份） */
function normalizeParity(value) {
  return periods.normalizeParity(value);
}

/** 这条任务是否被**手动**标记完成（done 为真） */
function isTaskDone(task) {
  if (!isPlainObject(task)) return false;
  var value = task.done;
  return value === true || value === 'true' || value === 1;
}

/**
 * 判断一条日程是不是「已经结课」了。对应 Python `is_task_finished()`。
 *
 * 只有**每周重复**的课（课表导入的课程）才会自动结课，判定依据是
 * **最后一次课有没有上完**，而不是简单地看周次：
 *
 *   * 最后一次课在昨天或更早           → 已结课
 *   * 最后一次课就在今天、且已下课     → 已结课（**没填下课时间则算还没结束**，保守）
 *   * 最后一次课还没到                 → 进行中
 *
 * 判定的**分支顺序**很关键（照抄 Python，别调换）：
 *   1. 不是 dict                        → false
 *   2. 不是每周重复                     → false（一次性日程靠手动完成或删除）
 *   3. **done 为真                      → false**（手动标记过的算「已完成」，不重复统计）
 *   4. 算不出最后一次课的日期           → false
 *   5. 最后一次课 < 今天                → true
 *   6. 最后一次课 > 今天                → false
 *   7. 最后一次课 == 今天：没填 end_time → false（保守）；填了则比较**分钟**
 *
 * 第 3 条是必须有的：少了它，一条"已勾选完成"的课会被同时算成「已完成」和「已结课」，
 * 统计口径会翻倍。（云函数 lib/normalize.js 的 isTaskFinished 没有这一条，
 * 因为它服务于统计口径；前端展示要区分三态，所以按 Python 版带这一条。）
 *
 * @param {Object} task 任务对象
 * @param {string} [semesterStart] 开学第一周的周一 "YYYY-MM-DD"
 * @param {Date|string} [now] 当前时刻（可注入，便于单测）：Date / "YYYY-MM-DD HH:MM" / "HH:MM"
 * @returns {boolean}
 */
function isTaskFinished(task, semesterStart, now) {
  if (!isPlainObject(task)) return false;
  if (normalizeRepeat(task.repeat) !== REPEAT_WEEKLY) return false;
  if (isTaskDone(task)) return false;   // 手动标记过完成的算「已完成」，不重复统计

  var lastDate = periods.lastOccurrenceDate(task, semesterStart);
  if (!lastDate) return false;

  var today = todayStr(toDate(now));
  if (lastDate < today) return true;    // "YYYY-MM-DD" 字典序 == 时间序
  if (lastDate > today) return false;

  // 最后一次课就在今天：下课时间过了才算结课
  var endMinutes = minutesOfTime(task.end_time);
  if (endMinutes === null) return false; // 没填下课时间 / 格式不对 → 保守算"还没结束"
  return minutesOfDate(toDate(now)) >= endMinutes;
}

/**
 * 三种状态。页面里显示「待办 / 已完成 / 已结课」只调这一个函数：
 *
 *   taskState(task) → 'done' | 'finished' | 'pending'
 *
 * 判定顺序（**done 优先**，与 Python 的统计口径 total - done - finished 一致）：
 *   1. done 为真                → 'done'（已完成）
 *   2. isTaskFinished 为真      → 'finished'（已结课，只有每周重复的课可能到这里）
 *   3. 其余                     → 'pending'（待办）
 *
 * @returns {string} 'done' | 'finished' | 'pending'
 */
function taskState(task, semesterStart, now) {
  if (isTaskDone(task)) return STATE_DONE;
  if (isTaskFinished(task, semesterStart, now)) return STATE_FINISHED;
  return STATE_PENDING;
}

/** 状态的中文名；认不出来的状态返回 '待办' */
function stateLabel(state) {
  return STATE_LABELS[toStr(state)] || STATE_LABELS[STATE_PENDING];
}

/** 待办（还没做完、也还没结课）→ 统计页顶部的"待办 N 件"用这个 */
function isTaskPending(task, semesterStart, now) {
  return taskState(task, semesterStart, now) === STATE_PENDING;
}

// ---------------------------------------------------------------------------
// 三、单次是否过点 / 是否本周结课（列表与课表上色用）
// ---------------------------------------------------------------------------

/**
 * 判断一条日程在 day 这一天的**那一次**是不是已经过去了。对应 Python `occurrence_passed()`。
 *
 * 与 isTaskFinished() 的区别：那个判断「整门课结课了没」，
 * 这个判断「这一次课 / 这件事过点了没」——
 * 比如下午三点时，今天早上 08:00-08:45 的课就已经算过去了。
 *
 * 规则（照抄 Python）：
 *   * 没有 start_time 的任务（例如 DDL）→ **不下结论**，返回 false（仍按普通样式显示）
 *   * day 在今天之前 → true；day 在今天之后 → false
 *   * day 就是今天 → 有 end_time 就比 end_time，只有 start_time 就比 start_time
 *
 * @param {Object} task 任务对象
 * @param {string} day 这一格对应的日期 "YYYY-MM-DD"
 * @param {Date|string} [now] 当前时刻（可注入）
 * @returns {boolean}
 */
function occurrencePassed(task, day, now) {
  if (!isPlainObject(task)) return false;
  var target = periods.parseDate(day);
  if (!target) return false;
  if (!toStr(task.start_time)) return false; // 没有具体时间的（DDL）不按「过点」处理

  var current = toDate(now);
  var today = todayStr(current);
  var dayText = periods.formatDate(target);
  if (dayText < today) return true;
  if (dayText > today) return false;

  // 就在今天：比下课时间（没有下课时间就比开始时间）
  var mark = minutesOfTime(task.end_time);
  if (mark === null) mark = minutesOfTime(task.start_time);
  if (mark === null) return false;
  return minutesOfDate(current) >= mark;
}

/**
 * 这门课是不是「本周结课」（最后一次课在今天到本周日之间）。对应 Python `ends_this_week()`。
 * 界面用它给快结束的课一个提示。
 *
 * 注意：done 为真、或已经结课的，都不算"本周结课"（Python 里就是这么写的）。
 *
 * @returns {boolean}
 */
function endsThisWeek(task, semesterStart, now) {
  var lastDate = periods.lastOccurrenceDate(task, semesterStart);
  if (!lastDate) return false;
  if (isTaskDone(task) || isTaskFinished(task, semesterStart, now)) return false;

  var current = toDate(now);
  var today = todayStr(current);
  // 本周日 = 今天 + (6 - 今天星期几)；periods.weekdayOf 是 0=周一 … 6=周日
  var weekday = periods.weekdayOf(current);
  var sunday = periods.formatDate(periods.addDays(current, 6 - (weekday === null ? 0 : weekday)));
  return today <= lastDate && lastDate <= sunday;
}

// ---------------------------------------------------------------------------
// 四、前端归一化（提交前预校验；服务端还会再校验一遍）
// ---------------------------------------------------------------------------

/** 预计耗时归一化：非法 / 负数 → 0，上限 24 小时 */
function normalizeEstimate(value) {
  var n = safeInt(value, 0);
  if (n < 0) n = 0;
  return Math.min(n, MAX_ESTIMATE_MIN);
}

/** done 归一化：只有 true / 'true' / 1 算完成 */
function normalizeDone(value) {
  return value === true || value === 'true' || value === 1;
}

/**
 * 节次范围归一化：数组 [7,9] → "7-9"；单节 [7] → "7"；非法 → ""
 * （与 normalize.js 的 normalizePeriods 行为一致：取最小与最大，中间不管）
 */
function normalizePeriods(value) {
  if (Array.isArray(value)) {
    var numbers = [];
    for (var i = 0; i < value.length; i += 1) {
      var n = safeInt(value[i], null);
      if (n !== null && n > 0) numbers.push(n);
    }
    if (!numbers.length) return '';
    var first = Math.min.apply(null, numbers);
    var last = Math.max.apply(null, numbers);
    return first === last ? String(first) : first + '-' + last;
  }
  var text = toStr(value);
  if (!text) return '';
  var matched = text.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (matched) {
    var a = Number(matched[1]);
    var b = Number(matched[2]);
    if (a > 0 && b >= a) return a === b ? String(a) : a + '-' + b;
    return '';
  }
  var single = safeInt(text, 0);
  return single > 0 ? String(single) : '';
}

/** 周次归一化：收敛到 [1,30]；非法 → fallback */
function normalizeWeek(value, fallback) {
  var n = safeInt(value, fallback);
  if (n < MIN_WEEK) n = MIN_WEEK;
  if (n > MAX_WEEK) n = MAX_WEEK;
  return n;
}

/** parent_id 归一化：空 → null；否则字符串（云数据库 _id 是字符串） */
function normalizeParentId(value) {
  if (value === null || value === undefined || value === '') return null;
  var text = toStr(value);
  return text || null;
}

/**
 * 归一化一条任务（提交给云函数之前的预校验）。对应 Python `_normalize_task()`，
 * 字段与默认值对齐 `cloudfunctions/tasks/lib/normalize.js` 的 normalizeTask()。
 *
 * 容错规则（能修的直接修，不报错）：
 *   * type 非法 → 'event'；priority 非法 → 'mid'
 *   * repeat 非法 → 'none'；单双周非法 → 'all'
 *   * date 缺失 → 补今天（与云端一致）；非法 → 进 errors 并保持空串
 *   * start_time / end_time 非法 → 进 errors 并清空；'9:5' → '09:05'
 *   * DDL 只留截止时刻：end_time 空但 start_time 有值 → 迁移过去，start_time 清空
 *   * estimate_min 负数 → 0；超过 1440 → 1440
 *   * 非每周重复：week_start / week_end 存 null（数据干净），parity 归 'all'
 *   * 每周重复：week_end < week_start → 取齐到 week_start
 *
 * 会进 errors 的只有两件"改不动"的事：**title 为空**、**date / 时间格式非法**。
 *
 * @param {Object} raw 前端表单拼出来的任务对象
 * @param {{today?: string|Date}} [options] 便于单测注入"今天"
 * @returns {{task: Object|null, errors: string[], rejected: string[]}}
 *          task 为 null 表示有 errors（title 为空或格式非法），不能提交；
 *          rejected 是白名单外的键（含 _id / _openid / created_at 等系统字段）。
 */
function normalizeTask(raw, options) {
  var opts = options || {};
  var errors = [];
  var rejected = [];

  if (!isPlainObject(raw)) {
    return { task: null, errors: ['task 必须是对象'], rejected: rejected };
  }

  var today = isValidDate(opts.today) ? toStr(opts.today) : todayStr(opts.today);

  // --- 标题：唯一的必填项 ---
  var title = toStr(raw.title).slice(0, 100);
  if (!title) errors.push('title 不能为空');

  // --- 类型 / 优先级：非法就退回默认值 ---
  var type = toStr(raw.type).toLowerCase();
  if (ALL_TYPES.indexOf(type) === -1) type = TYPE_EVENT;
  var priority = toStr(raw.priority).toLowerCase();
  if (ALL_PRIORITIES.indexOf(priority) === -1) priority = 'mid';

  // --- 日期：空值补今天（与云端一致），非法值报错 ---
  var date = toStr(raw.date);
  if (!date) {
    date = today;
  } else if (!isValidDate(date)) {
    errors.push('date 必须是 YYYY-MM-DD，收到：' + date);
  }

  // --- 起止时间 ---
  var startTime = toStr(raw.start_time);
  var endTime = toStr(raw.end_time);
  if (startTime && !isValidTime(startTime)) {
    errors.push('start_time 必须是 HH:MM，收到：' + startTime);
    startTime = '';
  }
  if (endTime && !isValidTime(endTime)) {
    errors.push('end_time 必须是 HH:MM，收到：' + endTime);
    endTime = '';
  }
  startTime = normalizeTime(startTime);
  endTime = normalizeTime(endTime);

  // DDL 的语义修正：截止只有一个时刻，没有开始时间
  if (type === TYPE_DDL) {
    if (!endTime && startTime) endTime = startTime;
    startTime = '';
  }

  // --- 重复方式 / 周次 / 单双周 ---
  var repeat = normalizeRepeat(raw.repeat);
  var weekStart = null;
  var weekEnd = null;
  var parity = PARITY_ALL;
  // 【每周与每天共用周次这一段】两种重复都要"第几周到第几周"，区别只在"哪天算数"
  // （见 periods.taskOccursOn）；单双周只对每周重复有意义。
  if (repeat === REPEAT_WEEKLY || repeat === REPEAT_DAILY) {
    weekStart = normalizeWeek(raw.week_start, MIN_WEEK);
    weekEnd = normalizeWeek(raw.week_end, DEFAULT_WEEK_END);
    if (weekEnd < weekStart) weekEnd = weekStart;
    if (repeat === REPEAT_WEEKLY) parity = normalizeParity(raw.week_parity);
  }

  // --- 白名单外的键一律拒绝（含 _id / _openid / created_at / updated_at） ---
  Object.keys(raw).forEach(function (key) {
    if (TASK_FIELDS.indexOf(key) === -1) rejected.push(key);
  });

  var task = {
    title: title,
    type: type,
    date: date,
    start_time: startTime,
    end_time: endTime,
    priority: priority,
    done: normalizeDone(raw.done),
    parent_id: normalizeParentId(raw.parent_id),
    repeat: repeat,
    week_start: weekStart,
    week_end: weekEnd,
    week_parity: parity,
    periods: normalizePeriods(raw.periods),
    location: toStr(raw.location).slice(0, 60),
    estimate_min: normalizeEstimate(raw.estimate_min)
  };

  return { task: errors.length ? null : task, errors: errors, rejected: rejected };
}

/**
 * 编辑页用的补丁归一化：只挑白名单字段，并把每个字段按同一套规则洗干净。
 * 与 normalizeTask 的区别：它**不需要 title**（改一条任务的 done 时不该被迫带上标题）。
 *
 * @param {Object} patch 待修改的字段
 * @returns {{patch: Object, errors: string[], rejected: string[]}}
 */
function pickPatch(patch) {
  var errors = [];
  var rejected = [];
  var clean = {};

  if (!isPlainObject(patch)) {
    return { patch: clean, errors: ['patch 必须是对象'], rejected: rejected };
  }

  Object.keys(patch).forEach(function (key) {
    if (TASK_FIELDS.indexOf(key) === -1) {
      rejected.push(key); // _id / _openid / created_at / updated_at 等
      return;
    }
    var value = patch[key];

    if (key === 'title') {
      var title = toStr(value).slice(0, 100);
      if (!title) errors.push('title 不能为空');
      else clean.title = title;
      return;
    }
    if (key === 'date') {
      var date = toStr(value);
      if (!isValidDate(date)) errors.push('date 必须是 YYYY-MM-DD，收到：' + date);
      else clean.date = date;
      return;
    }
    if (key === 'start_time' || key === 'end_time') {
      var time = toStr(value);
      if (time && !isValidTime(time)) errors.push(key + ' 必须是 HH:MM，收到：' + time);
      else clean[key] = normalizeTime(time);
      return;
    }
    if (key === 'type') {
      var type = toStr(value).toLowerCase();
      if (ALL_TYPES.indexOf(type) === -1) errors.push('type 只能是 ' + ALL_TYPES.join(' / '));
      else clean.type = type;
      return;
    }
    if (key === 'priority') {
      var priority = toStr(value).toLowerCase();
      if (ALL_PRIORITIES.indexOf(priority) === -1) {
        errors.push('priority 只能是 ' + ALL_PRIORITIES.join(' / '));
      } else clean.priority = priority;
      return;
    }
    if (key === 'done') {
      clean.done = normalizeDone(value);
      return;
    }
    if (key === 'parent_id') {
      clean.parent_id = normalizeParentId(value);
      return;
    }
    if (key === 'estimate_min') {
      clean.estimate_min = normalizeEstimate(value);
      return;
    }
    if (key === 'repeat') {
      var repeat = toStr(value).toLowerCase();
      if (repeat !== REPEAT_NONE && repeat !== REPEAT_WEEKLY && repeat !== REPEAT_DAILY) {
        errors.push('repeat 只能是 ' + ALL_REPEATS.join(' / '));
      } else clean.repeat = repeat;
      return;
    }
    if (key === 'week_parity') {
      var raw = toStr(value).toLowerCase();
      if ([PARITY_ALL, PARITY_ODD, PARITY_EVEN].indexOf(raw) === -1) {
        errors.push('week_parity 只能是 ' + PARITY_ALL + ' / ' + PARITY_ODD + ' / ' + PARITY_EVEN);
      } else clean.week_parity = raw;
      return;
    }
    if (key === 'week_start' || key === 'week_end') {
      clean[key] = normalizeWeek(value, MIN_WEEK);
      return;
    }
    if (key === 'periods') {
      clean.periods = normalizePeriods(value);
      return;
    }
    if (key === 'location') {
      clean.location = toStr(value).slice(0, 60);
      return;
    }
    rejected.push(key); // 理论上到不了这里，保险起见
  });

  // repeat 改成 none 时顺手清空周次；改成 weekly / daily 时补默认周次（与云端一致）
  if (clean.repeat === REPEAT_NONE) {
    clean.week_start = null;
    clean.week_end = null;
    clean.week_parity = PARITY_ALL;
  } else if (clean.repeat === REPEAT_WEEKLY || clean.repeat === REPEAT_DAILY) {
    if (clean.week_start === undefined || clean.week_start === null) clean.week_start = MIN_WEEK;
    if (clean.week_end === undefined || clean.week_end === null) clean.week_end = DEFAULT_WEEK_END;
    if (clean.week_end < clean.week_start) clean.week_end = clean.week_start;
    // 单双周只对每周重复有意义：改成每天时归 all，免得留下"每天、但只在单周"这种脏状态
    if (clean.repeat === REPEAT_DAILY) clean.week_parity = PARITY_ALL;
  }

  return { patch: clean, errors: errors, rejected: rejected };
}

// ---------------------------------------------------------------------------
// 五、展示用的小工具
// ---------------------------------------------------------------------------

/** 一条任务的展示标题：空标题给"(无标题)"，免得列表里出现空行 */
function displayTitle(task) {
  var title = toStr(task && task.title);
  return title || '(无标题)';
}

/** 时间范围文案：'09:00-09:45' / '09:00 起' / '09:45 前' / ''（都没填） */
function timeText(task) {
  if (!isPlainObject(task)) return '';
  var start = normalizeTime(task.start_time);
  var end = normalizeTime(task.end_time);
  if (start && end) return start + '-' + end;
  if (start) return start + ' 起';
  if (end) return end + ' 前';
  return '';
}

/** 状态 → 显示用的短标签（含 DDL 的"截止"语义） */
function stateText(task, semesterStart, now) {
  var state = taskState(task, semesterStart, now);
  if (state === STATE_PENDING && toStr(task && task.type) === TYPE_DDL) return '待完成';
  return stateLabel(state);
}

module.exports = {
  // 状态常量
  STATE_DONE: STATE_DONE,
  STATE_FINISHED: STATE_FINISHED,
  STATE_PENDING: STATE_PENDING,
  STATE_LABELS: STATE_LABELS,
  ALL_STATES: [STATE_PENDING, STATE_DONE, STATE_FINISHED],
  // 字段常量（与云端口径一致）
  TASK_FIELDS: TASK_FIELDS,
  MAX_ESTIMATE_MIN: MAX_ESTIMATE_MIN,
  MIN_WEEK: MIN_WEEK,
  MAX_WEEK: MAX_WEEK,
  TYPE_LABELS: TYPE_LABELS,
  PRIORITY_LABELS: PRIORITY_LABELS,

  // 三态判定
  taskState: taskState,
  isTaskFinished: isTaskFinished,
  isTaskDone: isTaskDone,
  isTaskPending: isTaskPending,
  stateLabel: stateLabel,
  stateText: stateText,
  endsThisWeek: endsThisWeek,
  occurrencePassed: occurrencePassed,

  // 归一化
  normalizeTask: normalizeTask,
  pickPatch: pickPatch,
  normalizeTime: normalizeTime,
  normalizePeriods: normalizePeriods,
  normalizeEstimate: normalizeEstimate,
  normalizeDone: normalizeDone,

  // 小工具
  isPlainObject: isPlainObject,
  toStr: toStr,
  safeInt: safeInt,
  pad2: pad2,
  todayStr: todayStr,
  nowStr: nowStr,
  toDate: toDate,
  isValidDate: isValidDate,
  isValidTime: isValidTime,
  minutesOfTime: minutesOfTime,
  displayTitle: displayTitle,
  timeText: timeText
};
