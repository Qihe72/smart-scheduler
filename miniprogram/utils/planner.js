/**
 * utils/planner.js —— 排期决策：把「这周还剩多少空档」和「这周还有多少事」算在一起。
 *
 * 逐函数移植自 Python 版 `smart-scheduler/planner.py`（只做 JS 化，语义不改）：
 *   task_estimate      → taskEstimate
 *   format_minutes     → formatMinutes
 *   row_minutes        → rowMinutes
 *   free_minutes_by_day→ freeMinutesByDay
 *   split_demand       → splitDemand
 *   plan_week          → planWeek
 *   _advice（私有）     → adviceOf（私有，分支条件逐条照抄）
 *
 * 三个概念（下面的结论就是用它们拼出来的）：
 *   空档 free   —— 课表里既没课、也没被排任务的**节次**能提供的分钟数；
 *   需求 demand —— 本周内待办任务自己写的「预计耗时」（estimate_min，分钟）之和；
 *   缺口 gap    —— 需求 − 空闲；大于 0 表示这周排不下，得挪时间或砍事情。
 *   （注意 gap 是**带符号**的：为负表示排得下，余量就是它的绝对值。）
 *
 * 刻意「不猜」：没写预计耗时的任务**不计入需求**，只单独数出来提醒你。
 * 宁可说「有 3 件没估，这个判断还不准」，也不替用户编一个耗时 ——
 * 这和项目里「算不准就不猜」（午休认定、默认作息）是同一条原则。
 *
 * 本模块与 planner.py 一样是**纯函数**：不碰界面、不读文件、不联网，
 * 所以 node 里可以直接 require 来跑单测。
 *
 * 【命名提醒】本模块的 formatMinutes(m) 是 Python 的 format_minutes ——
 * 把**分钟数**写成「40 分钟 / 1.5 小时」；而 utils/periods.js 里同名的
 * formatMinutes 是把「当天第几分钟」写成 "HH:MM"。两者语义不同，
 * 这里额外导出 formatTimeRange 作为 periods 那个的别名，避免调用方搞混。
 *
 * 【第八节是后来加的】busyRangesOfDay / findConflicts / suggestFreeSlot 三个函数
 * 不在 Python 版 planner.py 里，是为了「新建任务时提示这段时间已被占用」新写的；
 * 它们同样是纯函数，语义与坑都写在第八节开头。
 */

'use strict';

var periods = require('./periods.js');

/** 一天最多按 24 小时算，防止手填出离谱的数字把结论带偏 */
var MAX_DAY_MINUTES = 24 * 60;

// ---------------------------------------------------------------------------
// 基础工具（对应 Python 里 int(...) / try-except 的那些转换）
// ---------------------------------------------------------------------------

/**
 * Python `int(x)` 的容错版：整数、浮点（截断取整）、纯数字字符串都认；
 * 其余（空串、空白、null、undefined、对象、NaN、Infinity）返回 fallback。
 *
 * 用 parseFloat 而不是 parseInt，是为了让「'120.7'」也能像 Python 那样变成 120；
 * parseInt('12abc') 会得到 12 而 Python int('12abc') 直接报错，所以先用正则卡死格式。
 */
function toIntLoose(value, fallback) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : fallback;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'string') return fallback;
  var text = value.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) return fallback;
  var n = parseFloat(text);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** "HH:MM" → 当天第几分钟；格式不对返回 0（planner.py 的 _minutes_of 语义）。 */
function minutesOf(hhmm) {
  if (typeof hhmm !== 'string') return 0;
  var parts = hhmm.trim().split(':');
  if (parts.length < 2) return 0;
  var hour = toIntLoose(parts[0], null);
  var minute = toIntLoose(parts[1], null);
  if (hour === null || minute === null) return 0;
  return hour * 60 + minute;
}

// ---------------------------------------------------------------------------
// 一、taskEstimate
// ---------------------------------------------------------------------------

/**
 * 取一条任务的预计耗时（分钟）。对应 Python task_estimate()。
 *
 * 没写、非法、负数一律当 0（= 还没估）。
 *
 * @param {Object} task 任务对象
 * @returns {number} 大于等于 0 的分钟数
 */
function taskEstimate(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return 0;
  // Python 的 `task.get("estimate_min") or 0`：空串 / 0 / None 全落到 0
  var raw = task.estimate_min;
  var value = toIntLoose(raw === null || raw === undefined || raw === '' ? 0 : raw, 0);
  return value > 0 ? value : 0;
}

// ---------------------------------------------------------------------------
// 二、formatMinutes
// ---------------------------------------------------------------------------

/**
 * 把分钟数写成人话：40 分钟 / 1.5 小时 / 2 小时。对应 Python format_minutes()。
 *
 * 0 或非法值返回 "—"（破折号，表示"没数"）；不小于 60 分钟时，
 * 与整小时的偏差小于 0.05 小时就显示整数小时，否则保留一位小数。
 *
 * @param {number} minutes 分钟数
 * @returns {string} 人话
 */
function formatMinutes(minutes) {
  var value = toIntLoose(minutes, null);
  if (value === null) return '—';
  if (value <= 0) return '—';
  if (value < 60) return value + ' 分钟';
  var hours = value / 60;
  var rounded = Math.round(hours);
  if (Math.abs(hours - rounded) < 0.05) return rounded + ' 小时';
  return hours.toFixed(1) + ' 小时';
}

// ---------------------------------------------------------------------------
// 三、rowMinutes
// ---------------------------------------------------------------------------

/**
 * 一节课有多少分钟（用校准过的作息算）。对应 Python row_minutes()。
 *
 * 时间解析走 utils/periods.js 的 rowTimeRange（与课表显示同一口径：
 * 中间空档（午休）→ 校准值 → 默认作息），所以「左侧写着午休」和
 * 「这一行算几分钟」说的永远是同一件事。
 *
 * @param {Array} row 课表的一行，例如 [7]
 * @param {Object} [periodTimes] 校准过的作息表
 * @returns {number} 分钟数；作息缺失或起止不合法时返回 0（这种行不计入空档）
 */
function rowMinutes(row, periodTimes) {
  var range;
  try {
    range = periods.rowTimeRange(row, periodTimes);
  } catch (err) {
    return 0;
  }
  if (!range || !range.length) return 0;
  var begin = minutesOf(range[0]);
  var finish = minutesOf(range[1]);
  // begin <= 0 当作"没解析出来"（与 Python 一致：00:00 开始的行不计入）
  if (begin <= 0 || finish <= begin) return 0;
  return Math.min(finish - begin, MAX_DAY_MINUTES);
}

// ---------------------------------------------------------------------------
// 四、freeMinutesByDay
// ---------------------------------------------------------------------------

/**
 * 算出每天还剩多少分钟空档。对应 Python free_minutes_by_day()。
 *
 * 只数**真正的课**：被任务占掉的行算忙，其余的行按各自的时长累加。
 * 午休那种「空档行」由调用方排除在 classRowMinutes 之外，所以不算空闲时间。
 *
 * @param {Array<string>} days 这一周 7 天的日期（"YYYY-MM-DD"）
 * @param {Object} classRowMinutes {行下标: 该节多少分钟}，只包含算作「课」的行
 * @param {Object} occupiedRowsByDay {"2026-09-25": [2,3,4] 或 {2:true}}，被任务占掉的行下标
 * @returns {Object} {日期字符串: 空档分钟数}
 */
function freeMinutesByDay(days, classRowMinutes, occupiedRowsByDay) {
  var result = {};
  var list = Array.isArray(days) ? days : [];
  var minutesTable = classRowMinutes && typeof classRowMinutes === 'object' ? classRowMinutes : {};

  for (var i = 0; i < list.length; i += 1) {
    var day = String(list[i]);
    var taken = occupiedRowsByDay && typeof occupiedRowsByDay === 'object'
      ? occupiedRowsByDay[day]
      : null;
    // 同时接受数组 [2,3] 与对象 {2:true,3:true} 两种写法（页面里两种都顺手）
    var takenKeys = {};
    if (Array.isArray(taken)) {
      for (var a = 0; a < taken.length; a += 1) takenKeys[String(taken[a])] = true;
    } else if (taken && typeof taken === 'object') {
      Object.keys(taken).forEach(function (key) {
        if (taken[key]) takenKeys[String(key)] = true;
      });
    }

    var free = 0;
    Object.keys(minutesTable).forEach(function (index) {
      if (takenKeys[String(index)]) return; // 这一行被任务占了
      var value = Number(minutesTable[index]);
      if (Number.isFinite(value)) free += value;
    });
    result[day] = free;
  }
  return result;
}

// ---------------------------------------------------------------------------
// 五、splitDemand
// ---------------------------------------------------------------------------

/**
 * 把待办分成「估过工时的」和「没估的」。对应 Python split_demand()。
 *
 * @param {Array<Object>} pendingTasks 本周发生、且还没完成的任务
 * @returns {{total: number, estimated: Array<Array>, unestimated: Array<Object>}}
 *          total = 需求总分钟；estimated = [[任务, 分钟], ...]；unestimated = [没估的任务, ...]
 */
function splitDemand(pendingTasks) {
  var estimated = [];
  var unestimated = [];
  var total = 0;
  var list = Array.isArray(pendingTasks) ? pendingTasks : [];

  for (var i = 0; i < list.length; i += 1) {
    var task = list[i];
    if (!task || typeof task !== 'object' || Array.isArray(task)) continue;
    var minutes = taskEstimate(task);
    if (minutes) {
      estimated.push([task, minutes]);
      total += minutes;
    } else {
      unestimated.push(task);
    }
  }
  return { total: total, estimated: estimated, unestimated: unestimated };
}

// ---------------------------------------------------------------------------
// 六、_advice（私有）—— 分支条件逐条照抄 Python
// ---------------------------------------------------------------------------

/**
 * 把数字翻译成能照做的几句话（第一条是结论，其余是补充）。
 * 对应 Python _advice()，**分支顺序和文案口径与 Python 完全一致**：
 *
 *   1. demand > 0 且 gap > 0   → ⚠️ 排不下（差多少）+ 「要么挪、要么先做最靠近截止的」
 *   2. demand > 0 且 gap <= 0  → ✅ 还排得下（余多少）—— **恰好相等也走这一支**（余 0 分钟）
 *   3. demand == 0             → 提示"还没有带预计耗时的待办"
 *   4. 有没估的 → 追加一句"没有计入上面的需求，结论可能偏乐观"
 *   5. 空档最多的那天 > 0 → 追加一句"适合放需要整块时间的事"
 *
 * @returns {Array<string>} 建议文案
 */
function adviceOf(freeTotal, demand, gap, unestimated, busiest) {
  var lines = [];
  if (demand) {
    if (gap > 0) {
      lines.push('⚠️ 这周排不下：要做 ' + formatMinutes(demand)
        + '，课表只剩 ' + formatMinutes(freeTotal)
        + '，还差 ' + formatMinutes(gap) + '。');
      lines.push('要么把不急的挪到下周，要么先做最靠近截止的那一件。');
    } else {
      lines.push('✅ 这周还排得下：要做 ' + formatMinutes(demand)
        + '，课表剩 ' + formatMinutes(freeTotal)
        + '（余 ' + formatMinutes(freeTotal - demand) + '）。');
    }
  } else {
    lines.push('本周还没有带「预计耗时」的待办 —— 给任务填上耗时，这里才会给判断。');
  }
  if (unestimated && unestimated.length) {
    lines.push('另有 ' + unestimated.length + ' 件没写预计耗时，**没有**计入上面的需求，所以结论可能偏乐观。');
  }
  if (busiest && busiest.length > 1 && busiest[1] > 0) {
    lines.push('空档最多的是 ' + busiest[0] + '（' + formatMinutes(busiest[1]) + '），适合放需要整块时间的事。');
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 七、planWeek
// ---------------------------------------------------------------------------

/**
 * 把「空档」和「需求」算成一份可以照做的结论。对应 Python plan_week()。
 *
 * @param {Array<string>} days 这一周 7 天的日期（"YYYY-MM-DD"）
 * @param {Array<Object>} pendingTasks 本周发生、还没完成的任务（由调用方筛好，保持本函数纯粹）
 * @param {Object} classRowMinutes {行下标: 该节多少分钟}，只包含算作「课」的行
 * @param {Object} occupiedRowsByDay 每天被任务占掉的行下标集合
 * @returns {Object} {
 *   free_minutes_by_day: {日期: 分钟},
 *   free_total:          本周空档合计（分钟）,
 *   demand_minutes:      本周需求合计（分钟，只算估过的）,
 *   gap_minutes:         需求 − 空闲（> 0 表示排不下；< 0 表示还有余量）,
 *   busiest_day:         空档最多的那天（日期字符串，可能为 ""）,
 *   busiest_free_minutes: 那天的空档分钟数,
 *   estimated:           [[任务, 分钟], ...],
 *   unestimated:         [没写耗时的任务, ...],
 *   advice:              [结论, 补充, ...]
 * }
 */
function planWeek(days, pendingTasks, classRowMinutes, occupiedRowsByDay) {
  var freeEach = freeMinutesByDay(days, classRowMinutes, occupiedRowsByDay);

  var freeTotal = 0;
  Object.keys(freeEach).forEach(function (key) { freeTotal += freeEach[key]; });

  var demandSplit = splitDemand(pendingTasks);
  var demand = demandSplit.total;
  var gap = demand - freeTotal;

  // Python 的 max(dict.items(), key=...) 在并列时取**先出现**的那个，
  // 也就是 days 里更靠前的那天；这里显式用 > 比较，保持同样的取舍。
  var busiest = ['', 0];
  Object.keys(freeEach).forEach(function (key) {
    if (freeEach[key] > busiest[1]) busiest = [key, freeEach[key]];
  });

  return {
    free_minutes_by_day: freeEach,
    free_total: freeTotal,
    demand_minutes: demand,
    gap_minutes: gap,
    busiest_day: busiest[0],
    busiest_free_minutes: busiest[1],
    estimated: demandSplit.estimated,
    unestimated: demandSplit.unestimated,
    advice: adviceOf(freeTotal, demand, gap, demandSplit.unestimated, busiest)
  };
}

// ---------------------------------------------------------------------------
// 八、占用检测（"这段时间已经有事了"）
// ---------------------------------------------------------------------------
/**
 * 这一节的三个函数是给「新建 / 编辑任务时提示该时间段已被占用」用的，都是**纯函数**：
 * 只吃参数、只用 periods.js 的换算，不碰 wx、不读 this、不发请求 ——
 * 所以 node 里可以直接断言（见 utils/tests/planner.test.js）。
 *
 * 与第七节 planWeek 的区别（别把两者混起来用）：
 *   planWeek 算的是「**节次级**」的空档 —— 一节课算一格，给"这周还剩多少空档"用；
 *   这一节算的是「**分钟级**」的占用区间 —— "08:30 到 09:55 有课"必须精确到分钟，
 *   按节次粗粒度算会把 08:30 那一刻明明空着的时间也报成占用。
 *
 * 【一条任务怎么算占用区间】按"时间优先、节次兜底"：
 *   1. 有 start_time + end_time → 直接用（时间比节次精确）；
 *   2. 只有 start_time → 用 estimate_min 往后推；没写预计耗时按 30 分钟兜底，
 *      并在返回值里用 estimated:true 说清"这段长度是估出来的"；
 *   3. 只有 end_time 且不是 ddl → 用 estimate_min 往前推（"到 X 点为止"的那类事）；
 *   4. 完全没有时间、只有 periods（"3-5"）→ 用 effectivePeriodRange 换算成时间区间。
 *
 * 【为什么 ddl 不算占用】本项目的 ddl（截止）语义是"**只有一个时刻**"：它存在
 * end_time 里，start_time 是空串（见 pages/edit/edit.js 的 buildPayload）。
 * 一个"截止时刻"不是一段忙碌 —— 有人 23:59 前要交报告，不代表 23:00-23:59 被占住了。
 * 所以 ddl 只要没有 start_time 就一律不产生占用区间（只有历史脏数据才可能两者都有，
 * 那种按普通区间算）。
 *
 * 【与 pages/week 的口径差异（刻意如此，不是不一致）】周视图给任务"排版"时优先看
 * periods（用户/导入时明确写下的节次最准，见 week.js 的 locateRow），而这里算"占用"
 * 优先看时间；周视图的"空闲 N 节"也会数到 ddl 那行，而这里 ddl 不占时间。
 * 一个是排版问题、一个是时间问题，两者不必一致。
 *
 * 【"换到最近的空闲课节"的两条硬规矩】都踩过坑，别顺手"优化"回去：
 *   1. suggestFreeSlot 的候选起点**只有当天各节次的开始时刻**（见 freeSlotCandidates）。
 *      原因：候选起点必须能被 periods.periodNumberAt 的**包含判定**命中，否则周视图
 *      （week.js 的 locateRow）会把它画到别的行 —— 用户点了"换到最近的空闲课节"，
 *      卡片却落在跟时间对不上的行上，跟他最早报的"课程时间与导入文件不符"是同一类问题。
 *      所以**不要**把"占用区间的结束时刻"放进候选（占用到 09:57 结束就会给出 09:57，
 *      而 09:57 在课间、不属于任何一节），也**不要**用 5 分钟网格（网格不是课表语义，
 *      会产出用户看不懂、课表也放不对的时间）。
 *   2. 落下来的起止时间要写成节次时，一律走 slotPeriods()，**不要**用
 *      periodSpanFromTimes()：后者是"就近吸附"，会把 09:55 这种课间起点吸到第 4 节
 *      （见下面那条对照断言），周视图于是把卡片画到跟时间对不上的一行去。
 *
 * 代价与取舍：候选变少之后，"整段的空闲课节"可能不存在（例如只剩午休那种不属于任何
 * 一节的空档，或者一个课节都装不下），这时 suggestFreeSlot 返回 null，页面把按钮置灰
 * 并明说"今天没有整段的空闲课节" —— 宁可明说没有，也不给一个会把卡片画错行的建议。
 */

/** 没写预计耗时（estimate_min）时，估算一段占用长度用的兜底分钟数 */
var DEFAULT_BUSY_MINUTES = 30;

/** 取字符串（null / undefined / 对象一律当空串），任务字段经常是脏的 */
function strOf(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * "HH:MM" → 当天第几分钟；解析不出来返回 null。
 *
 * 【为什么不用本文件上面的 minutesOf】那是 Python `_minutes_of` 的移植：格式不对
 * 返回 0。可 0 正好是"00:00"这个合法时刻 —— 占用检测里"没填时间"和"填了 00:00"
 * 必须能分开（否则一条没填时间的 ddl 会凭空占掉 00:00 之后的一段），
 * 所以这里用 periods.toMinutes（失败返回 null）并顺手挡住越界值。
 */
function parseHHMM(value) {
  var text = strOf(value);
  if (!text) return null;
  var minutes = periods.toMinutes(text);
  if (minutes === null) return null;
  if (minutes < 0 || minutes > MAX_DAY_MINUTES) return null;  // '25:00' 这类直接丢掉
  return minutes;
}

/** 分钟数或 "HH:MM" 都解析成"当天第几分钟"；解析不出来返回 null */
function parseMoment(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    var number = Math.trunc(value);
    return (number < 0 || number > MAX_DAY_MINUTES) ? null : number;
  }
  return parseHHMM(value);
}

/**
 * 拼一条占用区间（内部用）。除了约定里的 start/end/title/id/type，
 * 还会把 "HH:MM" 写法、来源、是否估算一并算好 —— 页面直接拿去用，
 * 不必每处都 format 一遍，也不会把"估的"说成"填的"。
 */
function makeBusyRange(start, end, task, source, estimated) {
  return {
    start: start,
    end: end,
    title: strOf(task.title),
    id: strOf(task._id),
    type: strOf(task.type) || 'event',
    start_time: periods.formatMinutes(start),
    end_time: periods.formatMinutes(end),
    // 这段区间是怎么来的：'time'（填了起止）| 'estimate'（按预计耗时推的）| 'periods'（按节次换算的）
    source: source,
    // true = 这条没写预计耗时，长度是按 DEFAULT_BUSY_MINUTES 估的（页面要如实说明）
    estimated: estimated === true
  };
}

/** 解析 task.periods："3-5" / "3" 都认；极少数后端存成数组的也兜一层（与 week.js 的 periodSpanOf 同口径） */
function spanOfTask(task) {
  var span = periods.parsePeriodSpan(task.periods);
  if (span) return span;
  if (!Array.isArray(task.periods) || !task.periods.length) return null;
  var numbers = [];
  for (var i = 0; i < task.periods.length; i += 1) {
    var number = toIntLoose(task.periods[i], null);
    if (number !== null && number > 0) numbers.push(number);
  }
  if (!numbers.length) return null;
  return [Math.min.apply(null, numbers), Math.max.apply(null, numbers)];
}

/**
 * 一条任务占掉的时间段；算不出来（没有可用的时间信息）返回 null。
 *
 * @param {Object} task 任务对象
 * @param {Object} [periodTimes] 校准作息（settings.period_times）
 * @returns {Object|null} 见 makeBusyRange
 */
function busyRangeOfTask(task, periodTimes) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return null;

  var type = strOf(task.type) || 'event';
  var startMin = parseHHMM(task.start_time);
  var endMin = parseHHMM(task.end_time);
  var estimate = taskEstimate(task);
  var fallback = estimate > 0 ? estimate : DEFAULT_BUSY_MINUTES;

  // ddl 的"截止时刻"不是一段忙碌（见本节开头的解释）：没有 start_time 就不算占用
  if (type === 'ddl' && startMin === null) return null;

  // 1. 有头有尾：直接用。结束早于/等于开始属于脏数据，退到第 2 条按起点往后推
  if (startMin !== null && endMin !== null && endMin > startMin) {
    return makeBusyRange(startMin, endMin, task, 'time', false);
  }
  // 2. 只有开始时间 → 往后推（没写预计耗时就是估的，得如实标出来）
  if (startMin !== null) {
    return makeBusyRange(startMin, Math.min(startMin + fallback, MAX_DAY_MINUTES),
      task, 'estimate', estimate <= 0);
  }
  // 3. 只有结束时间（非 ddl 的"到 X 点为止"）→ 往前推
  if (endMin !== null) {
    return makeBusyRange(Math.max(endMin - fallback, 0), endMin, task, 'estimate', estimate <= 0);
  }
  // 4. 一个时间都没有，只剩节次可用
  var span = spanOfTask(task);
  if (!span) return null;
  var begin = parseHHMM(periods.effectivePeriodRange(span[0], periodTimes)[0]);
  var finish = parseHHMM(periods.effectivePeriodRange(span[1], periodTimes)[1]);
  if (begin === null || finish === null || finish <= begin) return null;
  return makeBusyRange(begin, finish, task, 'periods', false);
}

/**
 * 某一天已经被占用的时间段，按开始时间升序。
 *
 * 【为什么在函数里筛"这一天"】调用方（编辑页）手里是**全部**任务（api.listTasks 一次给全），
 * 让每个页面自己先筛一遍容易长出第二套口径。这里统一用 periods.taskOccursOn 判断
 * "这条任务这一天发生吗"：不重复的看 date 是不是同一天；每周重复的看星期几与周次范围
 * （给了 semesterStart 就按周次过滤，没给就"宁可多提示也不漏课"——与 pages/week 一致）。
 *
 * @param {Array<Object>} tasks 全部任务（函数自己筛日期，不用调用方先筛）
 * @param {string} date 要看的日期 "YYYY-MM-DD"；为空返回空数组（没有"这一天"可言）
 * @param {Object} [periodTimes] 校准作息，给"只有节次"的任务换算用
 * @param {Object} [opts] {
 *          includeDone:  true 时连已完成的任务也算占用（默认 false —— 做完了就不再占时间）,
 *          semesterStart: 'YYYY-MM-DD' 算每周重复的周次用
 *        }
 * @returns {Array<Object>} [{start, end, title, id, type, start_time, end_time, source, estimated}, ...]
 */
function busyRangesOfDay(tasks, date, periodTimes, opts) {
  var options = opts || {};
  var day = strOf(date);
  if (!day) return [];
  var list = Array.isArray(tasks) ? tasks : [];
  var semesterStart = strOf(options.semesterStart);
  var ranges = [];

  for (var i = 0; i < list.length; i += 1) {
    var task = list[i];
    if (!task || typeof task !== 'object' || Array.isArray(task)) continue;
    // 已完成的事默认不再占时间（云函数把 done 归一成严格的 true/false，这里跟着用 === true）
    if (task.done === true && options.includeDone !== true) continue;
    if (!periods.taskOccursOn(task, day, semesterStart)) continue;
    var range = busyRangeOfTask(task, periodTimes);
    if (range) ranges.push(range);
  }

  // 起点相同时再按结束时间排：保证页面"只列前 2 条"时顺序是稳定的
  ranges.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
  return ranges;
}

/**
 * 正在填的那条任务（candidate）与当天已有任务的冲突。
 *
 * 【半开区间 [start, end)】首尾相接不算撞：08:00-09:00 和 09:00-10:00 是可以接着排的，
 * 只有真正重叠（08:00-09:01 vs 09:00-10:00）才算冲突。判定式两端都取严格小于：
 * `a.start < b.end && b.start < a.end`。
 *
 * 【编辑自己不算冲突】candidate.id（或 _id）命中的那条会被跳过 ——
 * 不跳的话"编辑自己的时间"会永远在撞自己，红字就永远消不掉。
 *
 * @param {Object} candidate { id, type, date, start_time, end_time, estimate_min, periods }
 * @param {Array<Object>} tasks 全部任务
 * @param {Object} [periodTimes] 校准作息
 * @param {Object} [opts] 透传给 busyRangesOfDay（includeDone / semesterStart）
 * @returns {{start: number|null, end: number|null, conflicts: Array<Object>}}
 *          start / end 是候选**自己**的区间（算不出来时为 null，例如只填了截止时刻的 ddl），
 *          页面正好拿它当"期望时刻 + 时长"去问 suggestFreeSlot，两处不会各算一套。
 */
function findConflicts(candidate, tasks, periodTimes, opts) {
  var source = candidate && typeof candidate === 'object' ? candidate : {};
  var selfId = strOf(source.id) || strOf(source._id);
  var mine = busyRangeOfTask(source, periodTimes);
  if (!mine) return { start: null, end: null, conflicts: [] };

  var busy = busyRangesOfDay(tasks, strOf(source.date), periodTimes, opts);
  var conflicts = [];
  for (var i = 0; i < busy.length; i += 1) {
    var item = busy[i];
    if (selfId && item.id === selfId) continue;                        // 排除自己
    if (item.start < mine.end && mine.start < item.end) conflicts.push(item);
  }
  return { start: mine.start, end: mine.end, conflicts: conflicts };
}

/**
 * 当天的搜索窗口：第一节开始 ~ 最后一节结束。
 * 用 periodRows 而不是写死"第 1 节 ~ 第 13 节"：课表有几节就是几节（行数不写死）。
 */
function dayWindow(periodTimes) {
  var rows = periods.periodRows(periodTimes);
  if (!rows.length) return null;
  var first = periods.rowTimeRange(rows[0], periodTimes) || ['', ''];
  var last = periods.rowTimeRange(rows[rows.length - 1], periodTimes) || ['', ''];
  var start = parseHHMM(first[0]);
  var end = parseHHMM(last[1]);
  if (start === null || end === null || end <= start) return null;
  return { start: start, end: end };
}

/** 窗口内没被占用的空档（[start, end) 的补集），按开始时间升序 */
function freeGaps(windowStart, windowEnd, busyRanges) {
  var gaps = [];
  var cursor = windowStart;
  for (var i = 0; i < busyRanges.length; i += 1) {
    var item = busyRanges[i];
    if (item.end <= cursor) continue;        // 完全在游标左边（或正好接上：半开区间不算重叠）
    if (item.start >= windowEnd) break;      // 整段都在窗口右边
    if (item.start > cursor) gaps.push({ start: cursor, end: item.start });
    cursor = Math.max(cursor, item.end);
    if (cursor >= windowEnd) break;
  }
  if (cursor < windowEnd) gaps.push({ start: cursor, end: windowEnd });
  return gaps;
}

/**
 * 找空闲课节时的**候选起点**：当天各节次的开始时刻（升序、去重）。
 *
 * 【为什么只有节次开始时刻】候选起点必须能被 periods.periodNumberAt 的**包含判定**
 * 命中 —— 周视图（week.js 的 locateRow）就是按节次行来摆卡片的。一旦给出一个
 * "谁都不包含"的时刻（课间、午休里的任意分钟），周视图只能靠 periodSpanFromTimes
 * 就近吸附，卡片就会落在跟这条日程自己写的时间对不上的一行。所以：
 *   * **不放"占用区间的结束时刻"**：占用到 09:57 结束，09:57 就在课间，不属于任何一节；
 *   * **不放 5 分钟网格**：网格不是课表语义，会产出用户看不懂、课表也放不对的时间
 *     （而且"08:33 起"这种建议本身也没有任何现实含义）。
 * 用 effectivePeriodRange 取开始时刻还有一个好处：被认定成"午休/休息"的空档行
 * （例如校准后左右紧邻的第 6 节 = 12:25-14:15）开始时刻同样落在它自己那一节里，
 * periodNumberAt 命中得到 —— 不会被误伤。
 *
 * @param {Object} [periodTimes] 校准作息
 * @returns {Array<number>} 升序、去重的候选起点（分钟）
 */
function freeSlotCandidates(periodTimes) {
  var marks = {};
  var numbers = periods.periodNumbers(periodTimes);
  for (var i = 0; i < numbers.length; i += 1) {
    var begin = parseHHMM(periods.effectivePeriodRange(numbers[i], periodTimes)[0]);
    if (begin !== null) marks[begin] = true;
  }
  return Object.keys(marks)
    .map(function (key) { return Number(key); })
    .sort(function (a, b) { return a - b; });
}

/**
 * 从 start 起放 duration 分钟，能不能整段落在某个空档里。
 * （空档是升序的：一旦发现 start 比某个空档的开始还早，后面只会更晚，可以直接收工。）
 */
function fitsInGaps(start, duration, gaps) {
  for (var i = 0; i < gaps.length; i += 1) {
    var gap = gaps[i];
    if (start < gap.start) return false;
    if (start < gap.end && start + duration <= gap.end) return true;
  }
  return false;
}

/**
 * 把一段起止时间写成节次字段（"3" / "3-5"）；起点不属于任何一节时返回空串。
 *
 * 【为什么不能直接用 periodSpanFromTimes】那个函数是"就近吸附"的（取最贴近的一节），
 * 09:55 这种落在课间/午休里的起点会被吸到第 4 节上 —— 周视图于是把这条日程画到
 * 第 4 节那一行，跟它自己写的 09:55 对不上，等于我们亲手造了一个"时间与显示不符"。
 * 所以这里改成：起点必须真的被某一节包含（periods.periodNumberAt 的包含判定），
 * 否则宁可不写节次（留空让用户自己填），也不写一个会把卡片画到别处的号。
 * 注意：**不改 periods.js 的判定口径** —— 那是全项目共用的，改了会动课表排版。
 *
 * 【空串这条分支现在只是防御】suggestFreeSlot 的候选起点已经全是节次开始时刻，
 * 正常路径下起点必然被某一节包含 → 这里必然给得出节次。留着它是为了防止将来
 * 有人改宽了候选集（或拿别处的时刻来调这个函数）时悄无声息地写错号。
 *
 * @param {string|number} startValue 起点（"HH:MM" 或分钟数）
 * @param {string|number} endValue 终点（同上）
 * @param {Object} [periodTimes] 校准作息
 * @returns {string} "3" / "3-5"；推不出来返回 ''（调用方应当把节次留空）
 */
function slotPeriods(startValue, endValue, periodTimes) {
  var start = parseMoment(startValue);
  if (start === null) return '';
  var first = periods.periodNumberAt(periods.formatMinutes(start), periodTimes, 'start');
  if (first === null) return '';   // 起点在课间/午休里：不猜（防御性分支，见上）

  var end = parseMoment(endValue);
  var last = end === null ? null : periods.periodNumberAt(periods.formatMinutes(end), periodTimes, 'end');
  // 终点不在任何一节里（例如正好停在两节中间）就收敛成起点那一节，绝不倒挂
  if (last === null || last < first) last = first;
  return first === last ? String(first) : first + '-' + last;
}

/**
 * 当天**整段的空闲课节**里，离期望时刻最近的那一段。
 *
 * 【只往后找】给了 opts.after 就从那个时刻往后找（"我不想更早"是用户的真实约束），
 * 没给就从当天第一节开始找。
 *
 * 【起点怎么挑】候选起点 = 当天各节次的开始时刻（见 freeSlotCandidates），升序取
 * 第一个满足三条的：起点 ≥ after、整段 [起点, 起点+时长) 落在同一个空档里、
 * 且不越过当天最后一节结束。**刻意不用 5 分钟网格、也不用占用结束时刻** ——
 * 理由写在 freeSlotCandidates 与本节开头：候选必须是"某一节真正包含的时刻"，
 * 否则周视图会把卡片画到别的行上。
 *
 * 【找不到就是找不到】一个候选都装不下时返回 null（页面据此把按钮置灰、明说
 * "今天没有整段的空闲课节"）。宁可告诉用户没有，也不给一个会把卡片画错行的建议。
 *
 * @param {string} date 日期 "YYYY-MM-DD"
 * @param {number} durationMin 要放下的时长（分钟）；没给 / 非法时按 DEFAULT_BUSY_MINUTES
 * @param {Array<Object>} tasks 全部任务
 * @param {Object} [periodTimes] 校准作息
 * @param {Object} [opts] { after: 'HH:MM' 或分钟数（从这个时刻往后找）,
 *                          includeDone / semesterStart 同 busyRangesOfDay }
 * @returns {{start_time: string, end_time: string, minutes: number}|null}
 *          找不到返回 null。返回的 start_time 一定是某一节的开始时刻，
 *          **要不要写 periods 交给 slotPeriods()**（正常路径下它必然给得出节次）。
 */
function suggestFreeSlot(date, durationMin, tasks, periodTimes, opts) {
  var options = opts || {};
  var day = strOf(date);
  if (!day) return null;

  var duration = toIntLoose(durationMin, null);
  if (duration === null || duration <= 0) duration = DEFAULT_BUSY_MINUTES;
  duration = Math.min(duration, MAX_DAY_MINUTES);

  var window = dayWindow(periodTimes);
  if (!window) return null;

  var from = parseMoment(options.after);
  if (from === null) from = window.start;
  from = Math.max(from, window.start);

  var busy = busyRangesOfDay(tasks, day, periodTimes, options);
  var gaps = freeGaps(window.start, window.end, busy);
  var starts = freeSlotCandidates(periodTimes);

  for (var i = 0; i < starts.length; i += 1) {
    var start = starts[i];
    if (start < from) continue;                            // 只往后找
    if (!fitsInGaps(start, duration, gaps)) continue;       // duration > 0，不会"零长度也算放下"
    return {
      start_time: periods.formatMinutes(start),
      end_time: periods.formatMinutes(start + duration),
      minutes: duration
    };
  }
  return null;
}

module.exports = {
  // 常量
  MAX_DAY_MINUTES: MAX_DAY_MINUTES,
  DEFAULT_BUSY_MINUTES: DEFAULT_BUSY_MINUTES,
  // 主函数（与 planner.py 同名同义）
  taskEstimate: taskEstimate,
  formatMinutes: formatMinutes,
  rowMinutes: rowMinutes,
  freeMinutesByDay: freeMinutesByDay,
  splitDemand: splitDemand,
  planWeek: planWeek,
  // 占用检测（第八节）：给"新建任务时提示该时间段已被占用"用，全是纯函数
  busyRangesOfDay: busyRangesOfDay,
  findConflicts: findConflicts,
  suggestFreeSlot: suggestFreeSlot,
  /** 把避让出来的起止时间写成节次字段；起点落在课间/午休里时返回 ''（页面就该留空） */
  slotPeriods: slotPeriods,
  // 内部工具（单测与页面都可能要用）
  adviceOf: adviceOf,
  minutesOf: minutesOf,
  toIntLoose: toIntLoose,
  busyRangeOfTask: busyRangeOfTask,
  dayWindow: dayWindow,
  freeGaps: freeGaps,
  freeSlotCandidates: freeSlotCandidates,
  /**
   * periods.formatMinutes 的别名：把「当天第几分钟」写成 "HH:MM"。
   * 放在这里是为了让调用方一眼看清两个同名函数的区别（见文件头【命名提醒】）。
   */
  formatTimeRange: periods.formatMinutes
};
