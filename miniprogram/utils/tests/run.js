/**
 * utils/tests/run.js —— 纯 node 单测入口（无框架、无第三方库）。
 *
 * 跑法（在小程序根目录，也就是本文件的上上级目录）：
 *     node utils/tests/run.js           # 跑全部：periods + planner + AI 契约
 * 全过 → 退出码 0，末尾打印 "ALL PASS"；有失败 → 退出码 1（方便接 CI）。
 *
 * 【为什么单测里不 require utils/api.js】
 * api.js 依赖全局的 `wx`（wx.cloud.callFunction / wx.showToast），node 里没有这个
 * 全局对象，require 进来一调用就崩。api.js 的**真实契约**由同目录的
 * `ai_contract.js` 负责（它会先把 wx 补上再 require），`planner.test.js` 覆盖
 * planner.js 的全部纯函数。
 *
 * 【本入口覆盖的几条重点】
 *   * periodSpanFromTimes('12:00','13:30', override) 的跨度（含午休口径）
 *   * 午休只在"左右紧邻两节都校准过、中间恰好缺一节"时才认定（两组数据：认定 / 不认定）
 *   * weekNumberOf / weekParity
 *   * parsePeriodSpan('7-9')
 *   * taskOccursOn（每周重复 / 单双周 / 不重复）
 *   * formatMinutes
 */

'use strict';

var path = require('path');
var P = require(path.join(__dirname, '..', 'periods.js'));

// ---------------------------------------------------------------------------
// 极简单测框架（在 harness.js 里，require 它不会有任何副作用）
// ---------------------------------------------------------------------------
// 各测试文件共用同一个计数器，所以下面的 require 顺序不影响总数。
// 单独跑某一个文件也用同一套：node utils/tests/tasks.test.js
var H = require('./harness.js');
var state = H.state;
var block = H.block;
var eq = H.eq;
var eqArr = H.eqArr;
var eqJson = H.eqJson;
var isTrue = H.isTrue;
var isFalse = H.isFalse;

// 本文件仍然导出 periods（历史原因：早期测试文件写的是 T.periods），
// 断言助手请统一从 harness.js 取 —— 那边是唯一的真源。
module.exports = { periods: P };

// ---------------------------------------------------------------------------
// 测试数据
// ---------------------------------------------------------------------------
// 默认作息（periods.js 里抄自 config.py CLASS_PERIODS）：
//   1 08:00-08:45 / 2 08:55-09:40 / 3 10:00-10:45 / 4 10:55-11:40
//   5 14:00-14:45 / 6 14:55-15:40 / 7 16:00-16:45 / 8 16:55-17:40
//   9 19:00-19:45 / 10 19:55-20:40 / 11 20:50-21:35 / 12 21:40-22:25 / 13 22:30-23:15

/** 学期第一周的周一（config.py 的 SEMESTER_START_DEFAULT） */
var SEMESTER_START = '2026-09-07';

/** 一、认定的午休：只校准了第 5 节和第 7 节，中间恰好缺第 6 节 → 第 6 节 = 12:25-14:15 */
var OVERRIDE_BREAK = {
  '5': ['11:45', '12:25'],
  '7': ['14:15', '15:00']
};

/** 二、不认定的"空档"：只校准了第 5 节和第 8 节，中间缺了 6、7 两节 → 没法判断怎么分，不猜 */
var OVERRIDE_MULTI_GAP = {
  '5': ['11:45', '12:25'],
  '8': ['16:15', '17:00']
};

/** 三、连第 6 节都校准了 → 它就不是空档了，得按真时间走 */
var OVERRIDE_NO_GAP = {
  '5': ['11:45', '12:25'],
  '6': ['12:30', '13:15'],
  '7': ['14:15', '15:00']
};

// 2026-08-31 是周一；2026-09-07 是周一；9-07 + 7 天 = 9-14，+14 天 = 9-21
var DAY_BEFORE_TERM = '2026-08-31';  // 开学前一周的周一
var WEEK1_MON = '2026-09-07';        // 第 1 周周一（单周）
var WEEK1_WED = '2026-09-09';        // 第 1 周周三
var WEEK2_MON = '2026-09-14';        // 第 2 周周一（双周）
var WEEK3_MON = '2026-09-21';        // 第 3 周周一（单周）

// planner.test.js 要用的两组数据：一周 7 天、以及一份"第 5 节 40 分钟"的作息
// （第 5 节 = 11:45-12:25，一共 40 分钟；默认作息的第 5 节是 14:00-14:45，45 分钟）
var WEEK_DAYS = [
  '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10',
  '2026-09-11', '2026-09-12', '2026-09-13'
];
var OVERRIDE_PLAN = { '5': ['11:45', '12:25'] };

// ===========================================================================
// 1. periodSpanFromTimes：按起止时间反推占哪几节（默认作息）
// ===========================================================================
block('periodSpanFromTimes —— 默认作息下按时间反推节次');
// 12:00 / 13:30 两个时刻在默认作息里都是"课间空档"（11:40-14:00 之间没有课），
// 所以这里用默认作息是算不出来的 —— 这本身就说明了"默认作息接不住午休"，
// 也正是下面的 override 要解决的问题。
eq(P.periodNumberAt('12:00', null, 'start'), null, '12:00 在默认作息里不属于任何一节');
eq(P.periodNumberAt('13:30', null, 'end'), null, '13:30 在默认作息里不属于任何一节');
eq(P.periodSpanFromTimes('12:00', '13:30', null), null, '两者都算不出 → 返回 null');

// 换成校准过第 5/7 节的作息：第 6 节被认定为"午休 12:25-14:15"，
// 12:00 仍是第 5 节的下课区间，13:30 落进午休。
// 注意 prefer 的方向：12:00 按"开始时间最贴近"→ 第 5 节(11:45)，13:30 按"结束时间最贴近"→ 第 6 节(14:15)。
eq(P.periodNumberAt('12:00', OVERRIDE_BREAK, 'start'), 5, '12:00 按 prefer=start 最贴近第 5 节');
eq(P.periodNumberAt('13:30', OVERRIDE_BREAK, 'end'), 6, '13:30 按 prefer=end 最贴近第 6 节（午休）');
eqArr(P.periodSpanFromTimes('12:00', '13:30', OVERRIDE_BREAK), [5, 6],
  "periodSpanFromTimes('12:00','13:30', override) → [5,6]（跨过午休）");

// 再换一组：午休行真的开始于 12:25（而不是 12:00），跨度收窄成同一节
eqArr(P.periodSpanFromTimes('12:30', '13:30', OVERRIDE_BREAK), [6, 6],
  "periodSpanFromTimes('12:30','13:30', override) → [6,6]（整段都在午休里）");

// 只填了结束时间（"13:30 前完成"）：按结束时刻所在的那节定位，不能当成"没有时间"
eqArr(P.periodSpanFromTimes('', '13:30', OVERRIDE_BREAK), [6, 6], "只给结束时间 → [6,6]");
eqArr(P.periodSpanFromTimes('12:00', '', OVERRIDE_BREAK), [5, 5], '只给开始时间 → [5,5]（end 缺失按同一节算）');
// 结束时间早于开始时间属于脏数据：不倒挂，收敛成同一节
eqArr(P.periodSpanFromTimes('16:00', '08:00', null), [7, 7], '结束早于开始 → 收敛成 [7,7]，不倒挂');
eq(P.periodSpanFromTimes('', '', null), null, '两个时间都空 → null');

// 正常跨节：第 7 节 16:00 开始、第 9 节 19:45 下课
eqArr(P.periodSpanFromTimes('16:00', '19:45', null), [7, 9], '16:00 → 19:45 跨 [7,9]');
eqArr(P.periodSpanFromTimes('08:00', '09:40', null), [1, 2], '08:00 → 09:40 跨 [1,2]');

// 一、认定午休：左右紧邻两节都校准过，且中间**恰好**缺一节
block('午休规则（一）—— 左右紧邻 → 认定');
eqArr(P.gapPeriodRange(6, OVERRIDE_BREAK), ['12:25', '14:15'], '第 6 节被认定为午休 12:25-14:15');
eq(P.breakLabel(6, OVERRIDE_BREAK), '午休', '第 6 节的显示名是"午休"（开始时间在 11:00~15:00 之间）');
eq(P.rowLabel([6], OVERRIDE_BREAK), '午休', '课表第 6 行显示"午休"而不是"第6节"');
eqArr(P.rowTimeRange([6], OVERRIDE_BREAK), ['12:25', '14:15'], '第 6 行的时间取午休区间，而不是默认作息');
eqArr(P.periodTimeRange(6, OVERRIDE_BREAK), ['14:55', '15:40'],
  'periodTimeRange 仍是默认值（午休只体现在 gap/row/effective 口径里）');
eq(P.isBreakPeriod(6, OVERRIDE_BREAK), true, 'isBreakPeriod(6) 为 true');

// 二、不认定午休：中间缺了两节，没法判断这段怎么分 → 交给默认作息兜底
block('午休规则（二）—— 中间缺两节 / 缺一边 → 不认定');
eqArr(P.gapPeriodRange(6, OVERRIDE_MULTI_GAP), ['', ''],
  '缺第 6、7 两节 → 第 6 节不认定（分不清这两节怎么占）');
eqArr(P.gapPeriodRange(7, OVERRIDE_MULTI_GAP), ['', ''], '第 7 节同样不认定');
eq(P.breakLabel(7, OVERRIDE_MULTI_GAP), '', '不认定时空档名为空串');
eq(P.rowLabel([7], OVERRIDE_MULTI_GAP), '第7节', '不认定时第 7 行回退成"第7节"');
eqArr(P.rowTimeRange([7], OVERRIDE_MULTI_GAP), ['16:00', '16:45'], '不认定时第 7 行用默认作息');
// 左边缺一边：只校准了第 7 节，第 6 节的左邻居（第 5 节）没校准
eqArr(P.gapPeriodRange(6, { '7': ['14:15', '15:00'] }), ['', ''], '左邻居没校准 → 不认定');
// 右邻居也没校准
eqArr(P.gapPeriodRange(6, { '5': ['11:45', '12:25'] }), ['', ''], '右邻居没校准 → 不认定');
// 左边空档 > 右边开始（时间倒挂）→ 不认定
eqArr(P.gapPeriodRange(6, { '5': ['11:45', '16:00'], '7': ['14:15', '15:00'] }), ['', ''],
  '左结束晚于右开始（脏数据）→ 不认定');

// 三、第 6 节自己也校准了 → 它不再是空档
block('午休规则（三）—— 这一节自己校准过 → 不是空档');
eqArr(P.gapPeriodRange(6, OVERRIDE_NO_GAP), ['', ''], '已校准的节次不算空档');
eqArr(P.rowTimeRange([6], OVERRIDE_NO_GAP), ['12:30', '13:15'], '按校准值走');
eq(P.rowLabel([6], OVERRIDE_NO_GAP), '第6节', '显示名回到"第6节"');
// 非中午的空档叫"休息"（第 2 节：08:45-10:00 在 11:00 之前）
eqArr(P.gapPeriodRange(2, { '1': ['08:00', '08:45'], '3': ['10:00', '10:45'] }), ['08:45', '10:00'],
  '第 2 节空档 = 08:45-10:00');
eq(P.breakLabel(2, { '1': ['08:00', '08:45'], '3': ['10:00', '10:45'] }), '休息',
  '不在 11:00~15:00 的空档叫"休息"而不是"午休"');

// ===========================================================================
// 2. parsePeriodSpan：整串就是节次才认
// ===========================================================================
block('parsePeriodSpan —— "7-9" 等写法');
eqArr(P.parsePeriodSpan('7-9'), [7, 9], "parsePeriodSpan('7-9') → [7,9]");
eqArr(P.parsePeriodSpan('第7-9节'), [7, 9], '第7-9节');
eqArr(P.parsePeriodSpan('第 7 ~ 9 节'), [7, 9], '带空格与 ~ 分隔');
eqArr(P.parsePeriodSpan('7'), [7, 7], '单节 7 → [7,7]');
eqArr(P.parsePeriodSpan('第3节'), [3, 3], '第3节');
eqArr(P.parsePeriodSpan('9-7'), [7, 9], '写反了自动翻转');
eqArr(P.parsePeriodSpan('7到9'), [7, 9], '"到"也算分隔符');
eq(P.parsePeriodSpan(''), null, '空串 → null');
eq(P.parsePeriodSpan(null), null, 'null → null');
eq(P.parsePeriodSpan('第7节 周一 1-16周'), null, '长文本不当节次解析（那是 parsePeriodLabel 的活）');
eq(P.parsePeriodSpan('abc'), null, '非数字 → null');

// ===========================================================================
// 3. 周次与单双周
// ===========================================================================
block('weekNumberOf / weekParity');
eq(P.weekNumberOf(WEEK1_MON, SEMESTER_START), 1, '开学第一周的周一 → 第 1 周');
eq(P.weekNumberOf(WEEK1_WED, SEMESTER_START), 1, '同一周的周三 → 第 1 周（按周一对齐）');
eq(P.weekNumberOf(WEEK2_MON, SEMESTER_START), 2, '第 2 周');
eq(P.weekNumberOf(WEEK3_MON, SEMESTER_START), 3, '第 3 周');
eq(P.weekNumberOf(DAY_BEFORE_TERM, SEMESTER_START), null, '开学之前 → null（不算周次）');
eq(P.weekNumberOf(WEEK1_MON, ''), null, '没设学期开始日期 → null');
eq(P.weekNumberOf('2026-13-01', SEMESTER_START), null, '非法日期 → null');
// 开学日期给成周三，也应该先归到那一周的周一
eq(P.weekNumberOf('2026-09-11', '2026-09-09'), 1, '开学日期给成周三也能对齐到那一周');
eq(P.weekParity(1), 'odd', '第 1 周是单周');
eq(P.weekParity(2), 'even', '第 2 周是双周');
eq(P.weekParity(15), 'odd', '第 15 周是单周');
eq(P.weekParity(16), 'even', '第 16 周是双周');

// ===========================================================================
// 4. taskOccursOn / lastOccurrenceDate：重复规则
// ===========================================================================
block('taskOccursOn —— 不重复的任务');
var onceTask = { title: '交报告', type: 'ddl', date: WEEK1_WED, repeat: 'none', end_time: '23:59' };
isTrue(P.taskOccursOn(onceTask, WEEK1_WED, SEMESTER_START), '只在那一天 → 那天为 true');
isFalse(P.taskOccursOn(onceTask, WEEK1_MON, SEMESTER_START), '前一天为 false');
isFalse(P.taskOccursOn(onceTask, WEEK2_MON, SEMESTER_START), '下一周周一为 false');
isFalse(P.taskOccursOn(onceTask, '2026-09-16', SEMESTER_START), '下一周的周三为 false');
isFalse(P.taskOccursOn(null, WEEK1_WED, SEMESTER_START), '任务为空 → false');
isFalse(P.taskOccursOn(onceTask, 'not-a-date', SEMESTER_START), '日期非法 → false');

block('taskOccursOn —— 每周重复（单周课）');
// 单周课：第 1~16 周，每周一 08:00（锚点日期 2026-09-07 恰好是周一）
var oddCourse = {
  title: '高等数学', type: 'event', date: WEEK1_MON, start_time: '08:00', end_time: '09:40',
  repeat: 'weekly', week_start: 1, week_end: 16, week_parity: 'odd'
};
isTrue(P.taskOccursOn(oddCourse, WEEK1_MON, SEMESTER_START), '第 1 周周一（单周）上');
isTrue(P.taskOccursOn(oddCourse, WEEK3_MON, SEMESTER_START), '第 3 周周一（单周）上');
isFalse(P.taskOccursOn(oddCourse, WEEK2_MON, SEMESTER_START), '第 2 周周一（双周）不上');
isFalse(P.taskOccursOn(oddCourse, WEEK1_WED, SEMESTER_START), '同周周三不上（课在周一）');
isFalse(P.taskOccursOn(oddCourse, DAY_BEFORE_TERM, SEMESTER_START), '开学前不上');
isFalse(P.taskOccursOn(oddCourse, '2026-09-28', SEMESTER_START), '第 4 周（双周、超出范围内）不上');

block('taskOccursOn —— 每周重复（双周课 / 每周课 / 边界）');
var evenCourse = {
  title: '大学物理', type: 'event', date: WEEK1_MON, start_time: '14:00', end_time: '15:40',
  repeat: 'weekly', week_start: 2, week_end: 16, week_parity: 'even'
};
isFalse(P.taskOccursOn(evenCourse, WEEK1_MON, SEMESTER_START), '第 1 周：既在起始周之前，又是单周 → 不上');
isTrue(P.taskOccursOn(evenCourse, WEEK2_MON, SEMESTER_START), '第 2 周（双周、起始周）上');
isTrue(P.taskOccursOn(evenCourse, '2026-09-28', SEMESTER_START), '第 4 周（双周）上');
isFalse(P.taskOccursOn(evenCourse, WEEK3_MON, SEMESTER_START), '第 3 周（单周）不上');

var weeklyCourse = {
  title: '英语', type: 'event', date: WEEK1_MON, start_time: '10:00', end_time: '11:40',
  repeat: 'weekly', week_start: 1, week_end: 16, week_parity: 'all'
};
isTrue(P.taskOccursOn(weeklyCourse, WEEK2_MON, SEMESTER_START), '每周课在双周也上');
isTrue(P.taskOccursOn(weeklyCourse, WEEK3_MON, SEMESTER_START), '每周课在单周也上');
// 第 17 周的周一 = 2026-09-07 + 16*7 = 2026-12-28
isFalse(P.taskOccursOn(weeklyCourse, '2026-12-28', SEMESTER_START), '第 17 周超出 week_end=16 → 不上');
isTrue(P.taskOccursOn(weeklyCourse, '2026-12-21', SEMESTER_START), '第 16 周（结束周）上');
// 没有学期开始日期时算不出周次：**宁可多显示也不漏课**
isTrue(P.taskOccursOn(weeklyCourse, '2027-03-01', ''), '算不出周次时不过滤（返回 true）');

block('lastOccurrenceDate —— 最后一次课是哪天');
// 双周课、week_end=16（偶数周，正好匹配）
eq(P.lastOccurrenceDate({
  date: WEEK1_MON, repeat: 'weekly', week_start: 2, week_end: 16, week_parity: 'even'
}, SEMESTER_START), '2026-12-21', '双周课 week_end=16 → 第 16 周周一 2026-12-21');
// 双周课但 week_end=15（单周）→ 往前退到第 14 周
eq(P.lastOccurrenceDate({
  date: WEEK1_MON, repeat: 'weekly', week_start: 2, week_end: 15, week_parity: 'even'
}, SEMESTER_START), '2026-12-07', '双周课 week_end=15 → 退到第 14 周 2026-12-07');
// 每周课：直接用 week_end 那一周
eq(P.lastOccurrenceDate({
  date: WEEK1_MON, repeat: 'weekly', week_start: 1, week_end: 16, week_parity: 'all'
}, SEMESTER_START), '2026-12-21', '每周课 week_end=16 → 第 16 周周一');
// 单周课 week_end=16 → 退到第 15 周
eq(P.lastOccurrenceDate({
  date: WEEK1_MON, repeat: 'weekly', week_start: 1, week_end: 16, week_parity: 'odd'
}, SEMESTER_START), '2026-12-14', '单周课 week_end=16 → 退到第 15 周 2026-12-14');
// 不是每周重复 → null
eq(P.lastOccurrenceDate(onceTask, SEMESTER_START), null, '不重复的任务 → null');
eq(P.lastOccurrenceDate({ date: WEEK1_MON, repeat: 'weekly' }, SEMESTER_START), null, '缺 week_end → null');
eq(P.lastOccurrenceDate(null, SEMESTER_START), null, '任务为空 → null');
// lastOccurrenceDate 与 taskOccursOn 必须自洽：最后一天一定"上"
var lastDate = P.lastOccurrenceDate({
  date: WEEK1_MON, repeat: 'weekly', week_start: 2, week_end: 16, week_parity: 'even'
}, SEMESTER_START);
isTrue(P.taskOccursOn({
  date: WEEK1_MON, repeat: 'weekly', week_start: 2, week_end: 16, week_parity: 'even'
}, lastDate, SEMESTER_START), '最后一次课那天 taskOccursOn 也必须为 true（两个口径自洽）');

// ===========================================================================
// 5. formatMinutes（toHHMM 的别名）
// ===========================================================================
block('formatMinutes');
eq(P.formatMinutes(0), '00:00', '0 → 00:00');
eq(P.formatMinutes(9), '00:09', '9 → 00:09');
eq(P.formatMinutes(540), '09:00', '540 → 09:00');
eq(P.formatMinutes(725), '12:05', '725 → 12:05');
eq(P.formatMinutes(1439), '23:59', '1439 → 23:59');
eq(P.formatMinutes(1440), '24:00', '1440 → 24:00（不截断，交给调用方判断）');
eq(P.formatMinutes('600'), '10:00', '字符串数字也能转');
eq(P.formatMinutes(null), '', 'null → 空串（表示"没填时间"）');
eq(P.formatMinutes(undefined), '', 'undefined → 空串');
eq(P.formatMinutes(''), '', '空串 → 空串');
eq(P.formatMinutes('abc'), '', '非数字 → 空串');
// 与 toMinutes 互为逆运算
eq(P.formatMinutes(P.toMinutes('07:05')), '07:05', 'toMinutes/formatMinutes 可逆');

// ===========================================================================
// 6. 行与节次表（顺带守住"行数不写死"这条）
// ===========================================================================
block('行 / 节次表');
eq(P.PERIOD_ROWS.length, 13, '默认 13 行（第 1~13 节）');
eqArr(P.PERIOD_ROWS[6], [7], '第 7 行是 [7]（每节课一行）');
eqJson(P.periodRows(null), P.PERIOD_ROWS, 'periodRows(null) 等于默认行');
eq(P.periodRows(OVERRIDE_BREAK).length, 13, '只校准了已有节次 → 行数不变');
eq(P.periodRows({ '14': ['08:00', '08:45'] }).length, 14, '课表里有第 14 节 → 自动多一行（行数不写死）');
eq(P.rowLabel([7], null), '第7节', '默认第 7 行叫"第7节"');
eq(P.rowLabel([1], null), '第1节', '第 1 行叫"第1节"');
eq(P.periodNumbers({ '14': ['08:00', '08:45'] }).length, 14, 'periodNumbers 也把第 14 节并进来');

// ===========================================================================
// 合成空档行 —— 按**时间空隙**插行（真机反馈：补录了缺的那一节之后，午休行就消失了）
//
// 用户那份作息是第 1~5、7~13 节（第 6 节空着），所以第 6 节那行一直是「午休 12:25-14:15」。
// 他在「我的」页把第 6 节补录成 13:30-14:10 之后节次号就齐了 —— 12:25 到 13:30
// 之间那 65 分钟仍然该显示成「午休」，可旧规则只看"缺没缺号"，于是那一行直接不见了。
// 新规则：相邻两行空隙 ≥ BREAK_MIN_GAP_MINUTES 就插一行合成空档行（['break',开始,结束]）。
// "缺号"只是时间空隙的一种特例，两种空档行走同一套读取函数与同一条标签规则。
// ===========================================================================
block('合成空档行 —— 按时间空隙插行（缺号只是特例）');

/** 真机那份完整作息（13 节都给，第 6 节缺） */
var REAL_CAL = {
  '1': ['08:30', '09:10'], '2': ['09:15', '09:55'], '3': ['10:15', '10:55'],
  '4': ['11:00', '11:40'], '5': ['11:45', '12:25'], '7': ['14:15', '15:00'],
  '8': ['15:05', '15:40'], '9': ['16:00', '16:40'], '10': ['16:45', '17:25'],
  '11': ['19:00', '19:40'], '12': ['19:45', '20:20'], '13': ['20:30', '21:10']
};
/** 同上，但把缺的第 6 节补录成 13:30-14:10（「我的」页补录入口的效果） */
var FILLED_CAL = {
  '1': ['08:30', '09:10'], '2': ['09:15', '09:55'], '3': ['10:15', '10:55'],
  '4': ['11:00', '11:40'], '5': ['11:45', '12:25'], '6': ['13:30', '14:10'],
  '7': ['14:15', '15:00'], '8': ['15:05', '15:40'], '9': ['16:00', '16:40'],
  '10': ['16:45', '17:25'], '11': ['19:00', '19:40'], '12': ['19:45', '20:20'],
  '13': ['20:30', '21:10']
};
var rowsMiss = P.periodRows(REAL_CAL);
var rowsFill = P.periodRows(FILLED_CAL);
var LUNCH = ['break', '12:25', '13:30'];
var DINNER = ['break', '17:25', '19:00'];

eq(P.BREAK_MIN_GAP_MINUTES, 45, '阈值 = 45 分钟（一节课的长度量级，比它短只是课间）');

// ① 缺号那条路一行都不许动（既有行为）
eq(P.rowLabel([6], REAL_CAL), '午休', '缺号时第 6 节那行仍是「午休」');
eqArr(P.rowTimeRange([6], REAL_CAL), ['12:25', '14:15'], '它的区间仍是 12:25-14:15');
eq(P.isUncalibratedRow([6], REAL_CAL), true,
  '第 6 节没有校准值 → isUncalibratedRow=true（补录入口据此提示用户）');
eq(P.isUncalibratedRow([6], FILLED_CAL), false, '补录之后它就有校准值了 → false');
eq(P.isUncalibratedRow([1], null), true, '默认作息下每一节都没有校准值 → true');

// ② 补录第 6 节之后：第 5 节与第 6 节之间多出一行「午休」
eq(rowsFill.length, rowsMiss.length + 1, '总行数比缺号时多 1（就多这一行）');
eqJson(rowsFill[5], LUNCH, '它正好插在第 5 节与第 6 节之间');
eqJson(rowsFill[6], [6], '后一行仍是第 6 节自己');
isTrue(P.isSyntheticRow(LUNCH), '第一项不是数字 → 认得出是合成空档行');
eq(P.rowPeriodNumber(LUNCH), null, '合成行没有节次号');
eq(P.rowKey(LUNCH), 'break-12:25-13:30', '合成行的 key 与节次号不可能撞，也不会两行重名');
eq(P.rowLabel(LUNCH, FILLED_CAL), '午休', '标签按起点判定：12:25 落在 11:00~15:00 →「午休」');
eqArr(P.rowTimeRange(LUNCH, FILLED_CAL), ['12:25', '13:30'], '它自己的时间区间');
eq(P.isBreakRow(LUNCH, FILLED_CAL), true, '它是空档行（灰底、不计入空闲）');
eq(P.isUncalibratedRow(LUNCH, FILLED_CAL), false,
  '合成行**不是**"未校准的节次"：它压根不是节次，没什么可补录的');
eqArr(P.rowTimeRange([6], FILLED_CAL), ['13:30', '14:10'],
  '第 6 节显示补录进去的 13:30-14:10（不再是默认作息）');
eq(P.rowIndexOfPeriod(6, rowsFill), 6, '第 6 节的 rowIndexOfPeriod 仍指向第 6 节那一行');
eqJson(P.rowForPeriod(6, rowsFill), [6], '合成行里没有节次号 6，抢不走它的定位');

// ③ 晚饭那种空隙也插一行，但标签是「休息」（起点 17:25 不在 11:00~15:00）
eqJson(rowsFill[11], DINNER, '第 10 节（17:25 下课）与第 11 节（19:00 上课）之间插了一行');
eq(P.rowLabel(DINNER, FILLED_CAL), '休息', '它叫「休息」');
eq(P.isUncalibratedRow(DINNER, FILLED_CAL), false, '合成行同样不是"未校准的节次"');

// ④ 边界：44 分钟不插、恰好 45 分钟插
var GAP_44 = { '5': ['11:45', '12:25'], '6': ['13:09', '13:50'] };
var GAP_45 = { '5': ['11:45', '12:25'], '6': ['13:10', '13:50'] };
eq(P.periodRows(GAP_44).length, 13, '空隙 44 分钟 → 不插（13 行）');
eq(P.periodRows(GAP_45).length, 14, '空隙恰好 45 分钟 → 插（14 行）');
eqJson(P.periodRows(GAP_45)[5], ['break', '12:25', '13:10'], '插出来的就是 12:25-13:10 那一行');

// ⑤ 内置默认作息**不插**合成行：它不是这所学校的作息，拿它推空档就是瞎猜
//    （默认作息第 4 节 11:40 下课、第 5 节 14:00 上课，中间空 140 分钟 —— 若不过滤，
//      默认作息会凭空多出一行"午休"，L296/L297 那两条既有断言也会跟着红）
eqJson(P.periodRows(null), P.PERIOD_ROWS, 'periodRows(null) 仍是默认 13 行，一行不多');
eq(P.periodRows(OVERRIDE_BREAK).length, 13, '只校准了第 5 / 7 节时也不插（第 6 节缺号那条路已经给出午休）');

// ---------------------------------------------------------------------------
// 追加：planner.js / tasks.js 单测 + AI 云函数契约 + AI 页入口 + 课表页空闲统计
// ---------------------------------------------------------------------------
// 只有**入口**（本文件）才 require 别的测试文件；每个测试文件自己只 require
// 被测模块与 ./harness.js —— 这样任何一个文件坏了都不会连坐，逐个单独跑也等价。
// 单独跑：node utils/tests/{planner,tasks,week_free}.test.js | ai_contract.js | ai_page.test.js
//
// 【两条规矩，都是踩过坑换来的】
//   1. 加载期不许抛异常：loadTest() 包一层，某个文件顶层出错或文件缺失时只记一条
//      明确的失败，其余文件照跑 —— 否则一个低级笔误会让整个入口显得"到处都坏"。
//   2. **装全局桩的测试文件必须串行**：ai_contract.js 与 ai_page.test.js 都要改
//      global.wx。如果同时加载，先加载那个的异步续体会跑在别人的桩上。所以这里
//      等前一个的 done 落定，**再 require 下一个**（require 是同步的，放进 then 里
//      调用即可，加载时机就变成了"前一个跑完之后"）。
var fs = require('fs');
var loaded = [];
var skipped = [];

/** 加载一个测试文件；返回它的 module（不存在 / 抛错都返回 null） */
function loadTest(file) {
  var full = path.join(__dirname, file);
  if (!fs.existsSync(full)) {
    // 【刻意不算失败】"文件还没建好"和"文件坏了"是两件事：
    //   缺文件只记一句"未包含"（不算失败，否则一个还没写的文件会让整个入口变红）；
    //   加载期抛异常则**必须**报红（那是真的坏了）。
    skipped.push(file);
    console.log('  （跳过）' + file + '：文件不存在（未包含）');
    return null;
  }
  try {
    var mod = require(full);
    loaded.push(file);
    return mod;
  } catch (err) {
    H.record(false, '加载测试文件 ' + file, '加载期抛异常：' + ((err && err.message) || err));
    return null;
  }
}

/** 取一个 module 的 done（可能是 Promise），没有就返回 resolved */
function waitFor(mod) {
  if (mod && mod.done && typeof mod.done.then === 'function') return mod.done;
  return Promise.resolve();
}

// 同步的两份（纯同步用例，加载即跑完，不装全局桩）
loadTest('planner.test.js');
loadTest('tasks.test.js');

// 装全局桩的两份：**严格串行**，一个跑完再加载下一个
var chain = Promise.resolve();

chain = chain.then(function () {
  var aiContract = loadTest('ai_contract.js');
  return waitFor(aiContract);
}).then(function () {
  var aiPage = loadTest('ai_page.test.js');
  return waitFor(aiPage);
}).then(function () {
  // 课表页的空闲统计（纯函数探针，不装全局桩）。
  // 它是「空闲 N 节」那个真机 bug 的常驻回归测试 —— 当年六份测试全绿却漏了它。
  var weekFree = loadTest('week_free.test.js');
  return waitFor(weekFree);
}).then(function () {
  // 我的页：导入课表的"替换 / 追加"（装全局桩，所以放在这条串行链里）。
  // 它钉住的红线：替换时**只清课表类任务**，用户手工加的日程一条都不能删。
  var meImport = loadTest('me_import.test.js');
  return waitFor(meImport);
}).then(function () {
  // 别人的文件（ICS 解析）如果存在就一起跑；不存在就明确说"未包含"，不算失败。
  // 这样"文件还没建好"和"文件坏了"是两件能分清的事。
  var ics = loadTest('ics.test.js');
  return waitFor(ics);
}).then(function () {
  // 编辑页的"占用提示与一键避让"（同样装全局桩，所以也在这条串行链里）。
  // 【注册规矩】utils/tests 下的每个测试文件都必须在这里出现一行 —— 落了文件却没注册，
  // 等于它一条断言都没跑，报告却是绿的（这正是"假绿"的一种）。
  var editBusy = loadTest('edit_busy.test.js');
  return waitFor(editBusy);
}).then(function () {
  // 课表截图识别（parse_image）：装全局桩 + 要往云函数里递真实报文，所以同样放在串行链里。
  // 【必须排在这条链的最后】它会删掉 require 缓存、让 pages/ai/ai.js 在**自己的桩**下
  // 重新注册一次（否则 ai_page.test.js 已经加载过、require 缓存命中就拿不到注册对象）。
  // 放在最后，前面几个文件的 registered 早就拿到手了，不受影响。
  var vision = loadTest('ai_vision.test.js');
  return waitFor(vision);
}).then(function () {
  // 到期提醒的小程序端（「我的」页卡片 + 任务页的降级提示）。装全局桩，所以也在这条串行链里。
  // 它钉住的红线：两层 ok / 模板 ID 不许硬编码 / ack count 恒为 1 / reject·ban 不许 ack /
  // status 失败要静默 / 「24 小时内到期」的北京时间口径。云函数那一半由
  // cloudfunctions/_selftest.js 覆盖，两边合起来才是完整的一条链。
  var remindPage = loadTest('remind_page.test.js');
  return waitFor(remindPage);
}).then(function () {
  // 我的页 · AI 设置：模型可填 + Key 形状与服务商匹配。
  // 真机上用户抱怨"我用的明明是 deepseek，它硬说我用的是智谱大模型，还改不了" ——
  // 这个文件钉住那次 UI 缺口的修复（模型输入框、不匹配提示、按钮只改选中项不自动保存）。
  var meAi = loadTest('me_ai.test.js');
  return waitFor(meAi);
}).then(function () {
  // 我的页 · 节次作息：未校准标记 + 补录 / 清除。
  // 真机上用户问"第6节应该是 13:30-14:10，为什么显示 14:55-15:40"——
  // 因为他课表里第 6 节没有课，自动校准推不出时间、回落到内置默认作息，
  // 而当时的作息表是**只读**的，他连个入口都没有。
  // 这个文件钉住那次产品缺口的修复，并守住"补一节不许把别的作息冲掉"。
  var mePeriods = loadTest('me_periods.test.js');
  return waitFor(mePeriods);
}).then(function () {
  // 订阅授权"少点几次"（静默补额度 / 一次补齐 / 写系统日历）。
  // 用户的真话："为什么日程提醒要自己一个个手动申请啊，能不能全部放开" —— 平台规则改不了，
  // 这个文件钉住缝里的那几条红线：没勾「保持以上选择」时一次静默调用都不许发、
  // 静默那条路一轮只补 1 条（宁可少攒不可虚报）、只有平台回 accept 才上报、
  // 写日历的口径与微信提醒完全一致（缺 end_time 的 DDL 两边都不处理）。
  var subscribeTest = loadTest('subscribe.test.js');
  return waitFor(subscribeTest);
});

// ---------------------------------------------------------------------------
// 汇总（必须等异步用例跑完，否则会打印出一个"假绿"的报告）
// ---------------------------------------------------------------------------
chain.then(function () {
  console.log('\n已加载的测试文件：' + loaded.join(', '));
  if (skipped.length) console.log('未包含（文件不存在）：' + skipped.join(', '));
  H.report('periods + planner + tasks + AI 契约 + AI 页入口 + 课表页空闲统计 + 我的页导入 + 订阅少点几次');
});
