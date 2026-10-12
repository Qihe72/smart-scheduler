/**
 * utils/tests/planner.test.js —— utils/planner.js 的纯 node 单测。
 *
 * 跑法：
 *     node utils/tests/planner.test.js     # 只跑这一份
 *     node utils/tests/run.js              # 跑全部（本文件会被自动 require）
 *
 * 断言口径全部来自 Python 版 planner.py（逐函数对照移植），
 * 所以这里既是在测 JS 实现，也是在守"两边算出来必须是同一个数"。
 *
 * 【必覆盖的六项】（父任务点名要求）：
 *   1. 需求 > 空闲（正缺口）
 *   2. 需求 < 空闲（负缺口）
 *   3. 恰好相等
 *   4. 某天全被课占满
 *   5. 任务跨周重复时的需求展开
 *   6. estimate 缺失时的默认值
 */

'use strict';

var path = require('path');
var H = require(path.join(__dirname, 'harness.js'));  // 只定义、不执行的断言助手
var PL = require(path.join(__dirname, '..', 'planner.js'));
var P = require(path.join(__dirname, '..', 'periods.js'));

var eq = H.eq;
var eqArr = H.eqArr;
var eqJson = H.eqJson;
var isTrue = H.isTrue;
var isFalse = H.isFalse;
var block = H.block;

/** 一周 7 天（2026-09-07 是周一） */
var DAYS = [
  '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10',
  '2026-09-11', '2026-09-12', '2026-09-13'
];

/** 一节课占的行：{行下标: 分钟}。默认作息下第 1 节 45 分钟、第 7 节 45 分钟 */
var CLASS_45 = { 0: 45, 6: 45 };              // 每天空档 90 分钟 → 一周 630 分钟
var OVERRIDE_40 = { '5': ['11:45', '12:25'] };// 第 5 节 = 40 分钟（用来测校准作息）

/** 造一条任务 */
function task(overrides) {
  return Object.assign({ title: '任务', estimate_min: 0, done: false, date: '2026-09-07' }, overrides || {});
}

// ===========================================================================
// 1. taskEstimate —— estimate 缺失时的默认值
// ===========================================================================
block('planner.taskEstimate —— 预计耗时（缺失 / 非法 / 负数的默认值）');
eq(PL.taskEstimate({ estimate_min: 60 }), 60, '正常值 60 → 60');
eq(PL.taskEstimate({ estimate_min: 0 }), 0, '0 → 0（0 表示还没估）');
eq(PL.taskEstimate({}), 0, '字段缺失 → 0');
eq(PL.taskEstimate({ estimate_min: null }), 0, 'null → 0');
eq(PL.taskEstimate({ estimate_min: undefined }), 0, 'undefined → 0');
eq(PL.taskEstimate({ estimate_min: '' }), 0, '空串 → 0');
eq(PL.taskEstimate({ estimate_min: -30 }), 0, '负数 → 0（绝不瞎猜成 30）');
eq(PL.taskEstimate({ estimate_min: 'abc' }), 0, '非数字字符串 → 0');
eq(PL.taskEstimate({ estimate_min: '90' }), 90, "数字字符串 '90' → 90（与 Python int('90') 一致）");
eq(PL.taskEstimate({ estimate_min: ' 120 ' }), 120, '带空格的字符串 → 120');
eq(PL.taskEstimate({ estimate_min: 45.9 }), 45, '浮点 → 截断成 45（与 Python int() 一致）');
eq(PL.taskEstimate({ estimate_min: '60分钟' }), 0, "带单位的中文串 → 0（Python int('60分钟') 会报错）");
eq(PL.taskEstimate(null), 0, 'null 任务 → 0');
eq(PL.taskEstimate(undefined), 0, 'undefined 任务 → 0');
eq(PL.taskEstimate('不是对象'), 0, '非对象 → 0');
eq(PL.taskEstimate([1, 2]), 0, '数组 → 0');

// ===========================================================================
// 2. formatMinutes —— 人话
// ===========================================================================
block('planner.formatMinutes —— 分钟数写成人话');
eq(PL.formatMinutes(40), '40 分钟', '40 → "40 分钟"');
eq(PL.formatMinutes(1), '1 分钟', '1 → "1 分钟"');
eq(PL.formatMinutes(59), '59 分钟', '59 → "59 分钟"');
eq(PL.formatMinutes(60), '1 小时', '60 → "1 小时"');
eq(PL.formatMinutes(90), '1.5 小时', '90 → "1.5 小时"');
eq(PL.formatMinutes(120), '2 小时', '120 → "2 小时"');
eq(PL.formatMinutes(125), '2.1 小时', '125 → "2.1 小时"（偏差超过 0.05 小时就保留一位小数）');
eq(PL.formatMinutes(0), '—', '0 → "—"');
eq(PL.formatMinutes(-5), '—', '负数 → "—"');
eq(PL.formatMinutes(null), '—', 'null → "—"');
eq(PL.formatMinutes(undefined), '—', 'undefined → "—"');
eq(PL.formatMinutes('abc'), '—', '非数字 → "—"');
eq(PL.formatMinutes('120'), '2 小时', '数字字符串也能转');

// ===========================================================================
// 3. rowMinutes —— 一节课多少分钟
// ===========================================================================
block('planner.rowMinutes —— 一节（一行）多少分钟');
eq(PL.rowMinutes([1], null), 45, '默认作息第 1 节 08:00-08:45 → 45 分钟');
eq(PL.rowMinutes([7], null), 45, '默认作息第 7 节 16:00-16:45 → 45 分钟');
eq(PL.rowMinutes([5], OVERRIDE_40), 40, '校准后第 5 节 11:45-12:25 → 40 分钟（不是默认的 45）');
// 第 6 节在 OVERRIDE_40 里没校准、左右也不紧邻（缺第 7 节）→ 不是空档行
// → 回退默认作息 14:55-15:40 = 45 分钟（行本身有效，只是没被认定为午休）
eq(PL.rowMinutes([6], OVERRIDE_40), 45, '未校准且不构成午休的第 6 节回退默认作息 → 45 分钟');
// 左右紧邻、中间恰好缺一节 → 这一行是"午休空档 12:25-14:15" = 110 分钟
var overrideBreak = { '5': ['11:45', '12:25'], '7': ['14:15', '15:00'] };
eq(PL.rowMinutes([6], overrideBreak), 110, '午休空档行 12:25-14:15 → 110 分钟');
eq(PL.rowMinutes([99], null), 0, '不在作息表里的行 → 0');
eq(PL.rowMinutes(null, null), 0, 'row 为空 → 0');
eq(PL.rowMinutes([], null), 0, 'row 为空数组 → 0');
eq(PL.rowMinutes('不是行', null), 0, 'row 不是数组 → 0');
eq(PL.rowMinutes([1], { '1': ['09:00', '09:00'] }), 0, '起止相同（0 分钟）→ 0');
eq(PL.rowMinutes([1], { '1': ['09:00', '08:00'] }), 0, '起止倒挂 → 0');
// 注意：校准值是空串时，periods.periodTimeRange 会退回默认作息（"只显示确实推断出来的那一侧"
// 的前提是"另一侧有默认值"）—— 这与 Python 的 period_time_range 行为完全一致，
// 所以这里如实断言 45，而不是想当然的 0。
eq(PL.rowMinutes([1], { '1': ['', ''] }), 45, "校准值两侧都是空串 → 退回默认作息 → 45（与 Python 一致）");

// ===========================================================================
// 4. freeMinutesByDay —— 每天空档
// ===========================================================================
block('planner.freeMinutesByDay —— 每天剩多少分钟空档');
var freeEmpty = PL.freeMinutesByDay(DAYS, CLASS_45, {});
eqJson(freeEmpty, {
  '2026-09-07': 90, '2026-09-08': 90, '2026-09-09': 90, '2026-09-10': 90,
  '2026-09-11': 90, '2026-09-12': 90, '2026-09-13': 90
}, '没有任何任务占用 → 每天 45+45 = 90 分钟，7 天共 630');

// 周一第 0 行被任务占了 → 那天只剩 45 分钟，其它天不变
var freeTaken = PL.freeMinutesByDay(DAYS, CLASS_45, { '2026-09-07': [0] });
eq(freeTaken['2026-09-07'], 45, '周一第 0 行被占 → 周一空档 45');
eq(freeTaken['2026-09-08'], 90, '其它天不受影响（仍 90）');
// 对象写法 {0:true} 也要认
var freeTakenObj = PL.freeMinutesByDay(DAYS, CLASS_45, { '2026-09-09': { 0: true, 6: true } });
eq(freeTakenObj['2026-09-09'], 0, '占用表写成对象 {0:true,6:true} 也能认 → 0');
// 占用表里有"根本不存在的行下标" → 不影响结果
eq(PL.freeMinutesByDay(DAYS, CLASS_45, { '2026-09-07': [42] })['2026-09-07'], 90,
  '占用了不存在的行下标 → 不影响空档');
// 没有课表 → 每天 0
eq(PL.freeMinutesByDay(DAYS, {}, {})['2026-09-07'], 0, '没有课表（空表） → 每天 0');
eq(PL.freeMinutesByDay([], CLASS_45, {}) && Object.keys(PL.freeMinutesByDay([], CLASS_45, {})).length, 0,
  '空的天列表 → 返回空对象');
eq(PL.freeMinutesByDay(null, CLASS_45, {}) && Object.keys(PL.freeMinutesByDay(null, CLASS_45, {})).length, 0,
  'days 为 null → 返回空对象');

// 需求 > 空闲（正缺口）用到的口径：周一到周三全是课，后面 4 天没课
var freeMixedClasses = PL.freeMinutesByDay(
  DAYS,
  { 0: 45, 1: 45, 2: 45 },                     // 只排了 3 节"课"，都在周一到周三
  { '2026-09-07': [0, 1, 2] }                  // 而且周一这三节还被任务占满
);
eq(freeMixedClasses['2026-09-07'], 0, '周一两节课全被占满 → 0（当天一行空闲都不剩）');
eq(freeMixedClasses['2026-09-08'], 135, '周二没被占 → 3 节 × 45 = 135');
eq(freeMixedClasses['2026-09-13'], 135, '周日 3 节 × 45 = 135');

// ===========================================================================
// 5. splitDemand —— 估过的 / 没估的
// ===========================================================================
block('planner.splitDemand —— 需求拆分');
var splitEmpty = PL.splitDemand([]);
eq(splitEmpty.total, 0, '空数组 → 需求 0');
eq(splitEmpty.estimated.length, 0, '空数组 → estimated 为空');
eq(splitEmpty.unestimated.length, 0, '空数组 → unestimated 为空');
eq(PL.splitDemand(null).total, 0, 'null → 需求 0');

var splitMixed = PL.splitDemand([
  task({ title: 'A', estimate_min: 60 }),
  task({ title: 'B' }),                  // 没估
  task({ title: 'C', estimate_min: 30 }),
  task({ title: 'D', estimate_min: 0 }), // 0 = 没估
  task({ title: 'E', estimate_min: -10 }),// 负数 = 没估
  '不是对象',                              // 脏数据：跳过
  null
]);
eq(splitMixed.total, 90, '只累加估过的：60 + 30 = 90（没估的不计入需求）');
eq(splitMixed.estimated.length, 2, 'estimated 有 2 条');
eqArr(splitMixed.estimated[0], [splitMixed.estimated[0][0], 60], '第一条是 A/60');
eq(splitMixed.estimated[0][0].title, 'A', 'estimated 里带着原任务对象');
eq(splitMixed.unestimated.length, 3, 'unestimated 有 3 条（B / D / E）—— 脏数据不算');

// ===========================================================================
// 6. planWeek —— 需求 > 空闲（正缺口）
// ===========================================================================
block('planner.planWeek —— ① 需求 > 空闲（正缺口）');
// 一周空档 630 分钟，需求 700 分钟 → 缺口 +70
var planOver = PL.planWeek(DAYS, [
  task({ title: '写论文', estimate_min: 700 })
], CLASS_45, {});
eq(planOver.free_total, 630, 'free_total = 7 天 × 90 = 630');
eq(planOver.demand_minutes, 700, 'demand_minutes = 700');
eq(planOver.gap_minutes, 70, 'gap_minutes = 700 − 630 = +70（正数 = 这周排不下）');
isTrue(planOver.gap_minutes > 0, '正缺口：gap > 0');
eq(planOver.busiest_day, '2026-09-07', '空档最多的是周一（并列时取 days 里更靠前的那天）');
eq(planOver.busiest_free_minutes, 90, '那天 90 分钟');
eq(planOver.estimated.length, 1, 'estimated 1 条');
eq(planOver.unestimated.length, 0, 'unestimated 0 条');
eq(planOver.advice.length, 3, 'advice：结论 + 建议 + 空档最多的那天 = 3 句');
isTrue(planOver.advice[0].indexOf('⚠️ 这周排不下') === 0, '第 1 句以「⚠️ 这周排不下」开头');
isTrue(planOver.advice[0].indexOf('还差 1.2 小时') > -1, '第 1 句写明"还差 1.2 小时"（70 分钟）');
isTrue(planOver.advice[1].indexOf('要么把不急的挪到下周') > -1, '第 2 句是"挪时间 / 先做最近截止的"');
isTrue(planOver.advice[2].indexOf('空档最多的是 2026-09-07') > -1, '第 3 句指出空档最多的那天');

// 正缺口 + 有没估的任务 → 多一句提醒
var planOverUnestimated = PL.planWeek(DAYS, [
  task({ title: '写论文', estimate_min: 700 }),
  task({ title: '没估的事' })
], CLASS_45, {});
eq(planOverUnestimated.advice.length, 4, '正缺口 + 1 件没估 → 4 句（结论 + 建议 + 没估提醒 + 空档最多）');
isTrue(planOverUnestimated.advice[2].indexOf('另有 1 件没写预计耗时') > -1,
  '第 3 句提醒"另有 1 件没写预计耗时，没有计入上面的需求"');
isTrue(planOverUnestimated.advice[2].indexOf('结论可能偏乐观') > -1, '并点明"结论可能偏乐观"');

// ===========================================================================
// 7. planWeek —— 需求 < 空闲（负缺口）
// ===========================================================================
block('planner.planWeek —— ② 需求 < 空闲（负缺口 / 还有余量）');
var planUnder = PL.planWeek(DAYS, [
  task({ title: '背单词', estimate_min: 120 })
], CLASS_45, {});
eq(planUnder.free_total, 630, 'free_total = 630');
eq(planUnder.demand_minutes, 120, 'demand_minutes = 120');
eq(planUnder.gap_minutes, -510, 'gap_minutes = 120 − 630 = −510（负数 = 排得下，余 510 分钟）');
isFalse(planUnder.gap_minutes > 0, '负缺口：gap 不大于 0');
isTrue(planUnder.advice[0].indexOf('✅ 这周还排得下') === 0, '第 1 句以「✅ 这周还排得下」开头');
isTrue(planUnder.advice[0].indexOf('余 8.5 小时') > -1, '写明"余 8.5 小时"（510 分钟）');

// ===========================================================================
// 8. planWeek —— 恰好相等（gap === 0，走"排得下"分支，余 0 分钟）
// ===========================================================================
block('planner.planWeek —— ③ 需求 == 空闲（恰好排满）');
var planExact = PL.planWeek(DAYS, [
  task({ title: '刚好排满', estimate_min: 630 })
], CLASS_45, {});
eq(planExact.free_total, 630, 'free_total = 630');
eq(planExact.demand_minutes, 630, 'demand_minutes = 630');
eq(planExact.gap_minutes, 0, 'gap_minutes = 0（既不是正也不是负）');
isFalse(planExact.gap_minutes > 0, 'gap === 0 时 gap > 0 为 false → 走"排得下"分支（与 Python 的 `if gap > 0` 一致）');
isTrue(planExact.advice[0].indexOf('✅ 这周还排得下') === 0, '恰好相等也报"✅ 这周还排得下"');
isTrue(planExact.advice[0].indexOf('余 —') > -1, '余量为 0 → format_minutes(0) 给出 "—"（和 Python 一样不写"0 分钟"）');

// ===========================================================================
// 9. planWeek —— 某天全被课占满
// ===========================================================================
block('planner.planWeek —— ④ 某天全被课占满');
// 周一到周三各有两节课、且全被任务占满；周四到周日没课
var busyOccupied = {
  '2026-09-07': [0, 6],
  '2026-09-08': [0, 6],
  '2026-09-09': [0, 6]
};
var planBusy = PL.planWeek(DAYS, [], CLASS_45, busyOccupied);
eq(planBusy.free_minutes_by_day['2026-09-07'], 0, '周一全被占满 → 0 分钟空档');
eq(planBusy.free_minutes_by_day['2026-09-08'], 0, '周二全被占满 → 0');
eq(planBusy.free_minutes_by_day['2026-09-09'], 0, '周三全被占满 → 0');
eq(planBusy.free_minutes_by_day['2026-09-10'], 90, '周四没被占 → 90');
eq(planBusy.free_total, 360, 'free_total = 4 天 × 90 = 360');
// 空档最多的那天：周四是 days 里第一个 90 分的日子（并列取更靠前的）
eq(planBusy.busiest_day, '2026-09-10', 'busiest_day 是周四（并列时取更靠前的）');
eq(planBusy.demand_minutes, 0, '没有待办 → 需求 0');
eq(planBusy.gap_minutes, -360, 'gap = 0 − 360 = −360');
eq(planBusy.advice.length, 2, '需求为 0 → 只提示"填上耗时才有判断" + busiest 那句');
isTrue(planBusy.advice[0].indexOf('本周还没有带「预计耗时」的待办') === 0, '第 1 句提示去填预计耗时');
isTrue(planBusy.advice[1].indexOf('空档最多的是 2026-09-10') > -1, '第 2 句指向空档最多的周四');

// 整周全被占满（连"空档最多的那天"都是 0）→ 不该再出现"适合放整块时间的事"那句
var planAllBusy = PL.planWeek(DAYS, [], CLASS_45,
  { '2026-09-07': [0, 6], '2026-09-08': [0, 6], '2026-09-09': [0, 6], '2026-09-10': [0, 6],
    '2026-09-11': [0, 6], '2026-09-12': [0, 6], '2026-09-13': [0, 6] });
eq(planAllBusy.free_total, 0, '整周占满 → free_total = 0');
eq(planAllBusy.busiest_free_minutes, 0, 'busiest_free_minutes = 0');
eq(planAllBusy.advice.length, 1, 'busiest 的分钟数为 0 → 不追加"适合放整块时间的事"那句（与 Python `busiest[1] > 0` 一致）');
isFalse(planAllBusy.advice[0].indexOf('空档最多的是') > -1, '结论里没有"空档最多的是"');

// ===========================================================================
// 10. planWeek —— 任务跨周重复时的需求展开
// ===========================================================================
block('planner.planWeek —— ⑤ 每周重复的任务，需求只算本周这一次');
// 每周重复的课：estimate_min 是"一次课"的耗时。调用方（页面）只把**本周真正发生**
// 的任务传进来，所以需求 = 本周发生次数 × 单次耗时，而不是"跨了整个学期 × 20 周"。
var weeklyCourse = task({
  title: '高等数学', type: 'event', date: '2026-09-07', start_time: '08:00', end_time: '09:40',
  repeat: 'weekly', week_start: 1, week_end: 16, week_parity: 'all', estimate_min: 100
});
var planWeekly = PL.planWeek(DAYS, [weeklyCourse], CLASS_45, {});
eq(planWeekly.demand_minutes, 100, '一门跨 16 周的每周课，本周需求就是单次 100 分钟（不是 1600）');
eq(planWeekly.estimated.length, 1, 'estimated 只有 1 条');

// 单双周：本周是单周 → 只展开单周那几门；构造"本周发生"的集合交给 planWeek
var oddOnly = [
  task({ title: '单周课', repeat: 'weekly', week_parity: 'odd', estimate_min: 60 }),
  task({ title: '单周课2', repeat: 'weekly', week_parity: 'odd', estimate_min: 40 })
];
eq(PL.planWeek(DAYS, oddOnly, CLASS_45, {}).demand_minutes, 100, '本周是单周 → 只有两门单周课计入（60+40）');
var evenOnly = [task({ title: '双周课', repeat: 'weekly', week_parity: 'even', estimate_min: 300 })];
eq(PL.planWeek(DAYS, evenOnly, CLASS_45, {}).demand_minutes, 300, '本周是双周 → 双周课计入 300');
// 同一个任务对象出现在多天（页面按天展开时可能出现）→ 需求按"条"累加，由调用方去重
var repeatedSameTask = PL.planWeek(DAYS, [weeklyCourse, weeklyCourse], CLASS_45, {});
eq(repeatedSameTask.demand_minutes, 200, '同一条任务传两次 → 计两次（需求是按传入的条目累加，去重由调用方负责）');
// 用 periods 判断"本周是否发生"，再交给 planner —— 两个模块的口径必须对得上
isTrue(P.taskOccursOn(weeklyCourse, '2026-09-07', '2026-09-07'), 'periods.taskOccursOn 说这门课 2026-09-07 上');
isFalse(P.taskOccursOn(weeklyCourse, '2026-09-08', '2026-09-07'), 'periods.taskOccursOn 说 09-08 不上（课在周一）');

// ===========================================================================
// 11. planWeek —— 边界与口径
// ===========================================================================
block('planner.planWeek —— 边界 / 口径');
// advice 的第一条永远是结论（哪怕什么都没得说）
eq(PL.planWeek(DAYS, [], {}, {}).advice.length, 1, '没课表没任务 → 只有 1 句结论');
eq(PL.planWeek(DAYS, [], {}, {}).free_total, 0, '没课表 → 空档 0');
eq(PL.planWeek([], [], CLASS_45, {}).free_total, 0, '没天 → 空档 0');
eq(PL.planWeek([], [], CLASS_45, {}).busiest_day, '', '没天 → busiest_day 是空串');
eq(PL.planWeek(DAYS, null, CLASS_45, {}).demand_minutes, 0, 'pendingTasks 为 null → 需求 0');
// 返回结构齐全（页面按这几个键取值）
var planShape = PL.planWeek(DAYS, [], CLASS_45, {});
var keys = Object.keys(planShape).sort().join(',');
eq(keys,
  'advice,busiest_day,busiest_free_minutes,demand_minutes,estimated,free_minutes_by_day,free_total,gap_minutes,unestimated',
  '返回值 9 个键与 planner.py 的 plan_week 完全一致');
eq(PL.MAX_DAY_MINUTES, 1440, 'MAX_DAY_MINUTES = 24 小时');
// 缺口与三个量之间必须自洽：gap = demand − free_total
isTrue(planOver.gap_minutes === planOver.demand_minutes - planOver.free_total, 'gap = demand − free_total（正缺口）');
isTrue(planUnder.gap_minutes === planUnder.demand_minutes - planUnder.free_total, 'gap = demand − free_total（负缺口）');
isTrue(planExact.gap_minutes === planExact.demand_minutes - planExact.free_total, 'gap = demand − free_total（恰好相等）');

// ---------------------------------------------------------------------------
// 汇总：单独跑本文件时打印通过数并给退出码；被 run.js require 时由入口汇总
// ---------------------------------------------------------------------------
if (require.main === module) H.report('planner.js 单测');
