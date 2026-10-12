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

module.exports = {
  // 常量
  MAX_DAY_MINUTES: MAX_DAY_MINUTES,
  // 主函数（与 planner.py 同名同义）
  taskEstimate: taskEstimate,
  formatMinutes: formatMinutes,
  rowMinutes: rowMinutes,
  freeMinutesByDay: freeMinutesByDay,
  splitDemand: splitDemand,
  planWeek: planWeek,
  // 内部工具（单测与页面都可能要用）
  adviceOf: adviceOf,
  minutesOf: minutesOf,
  toIntLoose: toIntLoose,
  /**
   * periods.formatMinutes 的别名：把「当天第几分钟」写成 "HH:MM"。
   * 放在这里是为了让调用方一眼看清两个同名函数的区别（见文件头【命名提醒】）。
   */
  formatTimeRange: periods.formatMinutes
};
