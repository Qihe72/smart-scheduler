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

// ===========================================================================
// 12. 占用检测（第八节）：busyRangesOfDay / findConflicts / suggestFreeSlot
// ===========================================================================
// 这一节测的是「新建任务时提示这段时间已被占用」背后的纯逻辑。
// 边界都是父任务点名要求的，改动这里之前先想清楚为什么：
//   * 半开区间 [start, end)：首尾相接不算撞（08:00-09:00 与 09:00-10:00 可以接着排）；
//   * ddl（截止）只有一个时刻，**不是**一段忙碌 → 不产生占用；
//   * done=true 默认不算占用，includeDone:true 时算；
//   * 编辑自己不算冲突；
//   * suggestFreeSlot 给的是"最早能放下"的那一段（在只往后的前提下＝离期望时刻最近）。
var BUSY_DAY = '2026-09-07';   // 周一（和上面的 DAYS[0] 同一天）

/** 造一条"某天某段时间有事"的任务（字段给全，免得每个用例都要写一遍） */
function busyTask(overrides) {
  return Object.assign({
    _id: 'busy', title: '某件事', type: 'event', date: BUSY_DAY, repeat: 'none', done: false,
    start_time: '', end_time: '', periods: '', estimate_min: 0
  }, overrides || {});
}

block('planner.busyRangesOfDay —— 只填了 end_time 的 ddl 不算占用');
// 【本项目的语义】ddl 的"截止时刻"存在 end_time，start_time 是空串（见 edit.js 的 buildPayload）。
// "23:59 前交报告"不是"23:00-23:59 被占住了"——把截止时刻当忙碌会把整晚都报成冲突。
var ddlOnlyEnd = busyTask({ _id: 'ddl1', title: '交实验报告', type: 'ddl', end_time: '23:59' });
eq(PL.busyRangesOfDay([ddlOnlyEnd], BUSY_DAY, null).length, 0, 'ddl 只有截止时刻 → 不产生占用区间');
eq(PL.busyRangesOfDay([ddlOnlyEnd], BUSY_DAY, null, { includeDone: true }).length, 0,
  'includeDone 也不会把截止时刻变成一段忙碌');
eq(PL.findConflicts({ id: 'c', type: 'ddl', date: BUSY_DAY, end_time: '09:00' },
  [busyTask({ _id: 'e1', title: '早课', start_time: '08:00', end_time: '10:00' })], null).conflicts.length, 0,
  '8:00-10:00 有课，"9:00 截止"也不算冲突（截止不是占用）');
var ddlFound = PL.findConflicts({ id: 'c', type: 'ddl', date: BUSY_DAY, end_time: '23:59' }, [], null);
eq(ddlFound.start, null, '候选是"只有截止时刻"的 ddl → 自己的区间算不出来（start 为 null）');
eq(ddlFound.end, null, '同上，end 也是 null');
eq(ddlFound.conflicts.length, 0, '自己的区间都没有 → 不可能有冲突');

block('planner.busyRangesOfDay —— 时间优先，精确到分钟');
var timeRanges = PL.busyRangesOfDay([busyTask({ _id: 'e1', title: '光学实训', start_time: '08:30', end_time: '09:55' })], BUSY_DAY, null);
eq(timeRanges.length, 1, '一条日程 → 一段占用');
eq(timeRanges[0].start, 510, '08:30 → 当天第 510 分钟');
eq(timeRanges[0].end, 595, '09:55 → 第 595 分钟（不是"按课时粗算"）');
eq(timeRanges[0].start_time, '08:30', '顺带给出 "HH:MM" 写法（页面直接拿去拼文案）');
eq(timeRanges[0].end_time, '09:55', '同上');
eq(timeRanges[0].title, '光学实训', '带着标题');
eq(timeRanges[0].id, 'e1', '带着 _id（编辑时要靠它排除自己）');
eq(timeRanges[0].type, 'event', '带着类型（页面按类型说"与 N 条日程重叠"）');
eq(timeRanges[0].source, 'time', "来源标记：'time' = 用户填了起止时间");
isFalse(timeRanges[0].estimated, '填了起止时间 → 不是估算的');

// 只写了开始时间、没写预计耗时 → 按 30 分钟兜底，并且必须**说出来**是估的
var onlyStart = PL.busyRangesOfDay([busyTask({ _id: 'e2', title: '小组讨论', start_time: '14:00' })], BUSY_DAY, null)[0];
eq(onlyStart.end - onlyStart.start, 30, '只有开始时间、没写预计耗时 → 按 30 分钟兜底');
eq(onlyStart.end_time, '14:30', '14:00 + 30 分钟 = 14:30');
isTrue(onlyStart.estimated, '兜底出来的长度必须标成 estimated（不能当成用户填的）');
eq(onlyStart.source, 'estimate', "来源标记：'estimate' = 按预计耗时推的");
// 写了预计耗时 → 用它，且不算估算
var withEstimate = PL.busyRangesOfDay([busyTask({ _id: 'e3', title: '写报告', start_time: '14:00', estimate_min: 90 })], BUSY_DAY, null)[0];
eq(withEstimate.end - withEstimate.start, 90, '写了预计耗时（90）就用它');
isFalse(withEstimate.estimated, '用了用户填的预计耗时 → 不是估算');
// 结束早于开始属于脏数据：不倒挂，退回"起点 + 预计耗时"
var dirtyRange = PL.busyRangesOfDay([busyTask({ _id: 'e4', title: '时间填反了', start_time: '16:00', end_time: '08:00' })], BUSY_DAY, null)[0];
eq(dirtyRange.end - dirtyRange.start, 30, '结束早于开始（脏数据）→ 退回"起点 + 30 分钟"，不算出一段负数时间');
isTrue(dirtyRange.estimated, '兜底时同样标成估算');
// 非 ddl 的"到 X 点为止"：按预计耗时往前推
var endOnly = PL.busyRangesOfDay([busyTask({ _id: 'e5', title: '到 18:00 为止', type: 'event', end_time: '18:00' })], BUSY_DAY, null)[0];
eqArr([endOnly.start_time, endOnly.end_time], ['17:30', '18:00'], '非 ddl 只填结束时间 → 往前推 30 分钟（17:30-18:00）');
// 没填时间的任务不占用
eq(PL.busyRangesOfDay([busyTask({ _id: 'e6', title: '什么都没填' })], BUSY_DAY, null).length, 0, '没有时间也没有节次 → 不占用');

block('planner.busyRangesOfDay —— 只有节次的任务（校准作息 / 默认作息）');
var periodTask = busyTask({ _id: 'p1', title: '实验课', periods: '3-5' });
var periodDefault = PL.busyRangesOfDay([periodTask], BUSY_DAY, null)[0];
eq(periodDefault.start, 600, '默认作息：第 3 节 10:00 开始 → 600');
eq(periodDefault.end, 885, '默认作息：第 5 节 14:45 结束 → 885（中间那段午休也算在里面）');
eq(periodDefault.source, 'periods', "来源标记：'periods' = 按节次换算的");
eqArr([periodDefault.start_time, periodDefault.end_time], ['10:00', '14:45'], '"3-5" → 10:00-14:45');
// 同一份 periods，换一组真实校准作息（第 5 节 11:45-12:25）→ 区间必须跟着变
var periodCalibrated = PL.busyRangesOfDay([periodTask], BUSY_DAY, OVERRIDE_40)[0];
eq(periodCalibrated.start, 600, '校准后起点不变（第 3 节没被校准，仍 10:00）');
eq(periodCalibrated.end, 745, '校准后第 5 节是 11:45-12:25 → 结束 745（不再是默认的 885）');
isTrue(periodDefault.end !== periodCalibrated.end, '同一份 periods 在两种作息下算出的占用区间不同（校准作息必须真的生效）');
// 单节写法
var singlePeriod = PL.busyRangesOfDay([busyTask({ _id: 'p2', title: '高数', periods: '7' })], BUSY_DAY, null)[0];
eqArr([singlePeriod.start_time, singlePeriod.end_time], ['16:00', '16:45'], "periods '7' → 16:00-16:45");
// 节次写得不规范（解析不出来）→ 不算占用，而不是瞎猜
eq(PL.busyRangesOfDay([busyTask({ _id: 'p3', title: '乱写的节次', periods: '第7节 周一' })], BUSY_DAY, null).length, 0,
  '节次解析不出来 → 不算占用（算不准就不猜）');

block('planner.findConflicts —— 半开区间 [start, end)');
var nineToTen = [busyTask({ _id: 'b1', title: '高等数学', start_time: '09:00', end_time: '10:00' })];
var touchAfter = PL.findConflicts({ id: 'c1', type: 'event', date: BUSY_DAY, start_time: '08:00', end_time: '09:00' }, nineToTen, null);
eq(touchAfter.conflicts.length, 0, '08:00-09:00 与 09:00-10:00 首尾相接 → 不冲突（半开区间）');
eq(touchAfter.start, 480, '候选自己的区间照样算出来（08:00 → 480），页面拿它当"期望时刻"');
eq(touchAfter.end, 540, '候选自己的区间 09:00 → 540');
var touchBefore = PL.findConflicts({ id: 'c2', type: 'event', date: BUSY_DAY, start_time: '10:00', end_time: '11:00' }, nineToTen, null);
eq(touchBefore.conflicts.length, 0, '接在后面（10:00 开始）同样不算撞');
var oneMinuteOver = PL.findConflicts({ id: 'c3', type: 'event', date: BUSY_DAY, start_time: '08:00', end_time: '09:01' }, nineToTen, null);
eq(oneMinuteOver.conflicts.length, 1, '08:00-09:01 与 09:00-10:00 重叠 1 分钟 → 冲突');
eq(oneMinuteOver.conflicts[0].title, '高等数学', '冲突项带着那条任务的标题');
eq(PL.findConflicts({ id: 'c4', type: 'event', date: BUSY_DAY, start_time: '08:00', end_time: '11:00' }, nineToTen, null).conflicts.length, 1,
  '已有任务被候选整个包住 → 也算冲突');
eq(PL.findConflicts({ id: 'c5', type: 'event', date: BUSY_DAY, start_time: '11:00', end_time: '12:00' }, nineToTen, null).conflicts.length, 0,
  '完全不相交 → 不冲突');

block('planner.findConflicts —— 编辑自己 / 别人的日期 / 多条排序');
var selfTask = busyTask({ _id: 'self1', title: '正在编辑的这条', start_time: '08:00', end_time: '09:00' });
var selfFound = PL.findConflicts({ id: 'self1', type: 'event', date: BUSY_DAY, start_time: '08:00', end_time: '09:00' }, [selfTask], null);
eq(selfFound.conflicts.length, 0, '候选 id 与已有任务相同 → 排除自己（否则编辑自己的时间会永远在撞自己）');
eq(selfFound.start, 480, '自己的区间还是算出来了（红字不出现，但"期望时刻"仍可用）');
eq(PL.findConflicts({ id: 'new1', type: 'event', date: BUSY_DAY, start_time: '08:00', end_time: '09:00' }, [selfTask], null).conflicts.length, 1,
  '换成新增（id 不同）→ 同样的时间就该报冲突');
eq(PL.findConflicts({ id: 'c6', type: 'event', date: BUSY_DAY, start_time: '08:00', end_time: '09:00' },
  [busyTask({ _id: 'other', title: '明天的课', date: '2026-09-08', start_time: '08:00', end_time: '09:00' })], null).conflicts.length, 0,
  '别的日期的任务不参与这一天的冲突');
var manyFound = PL.findConflicts({ id: 'c7', type: 'event', date: BUSY_DAY, start_time: '08:00', end_time: '14:00' }, [
  busyTask({ _id: 'm2', title: '第二件', start_time: '10:00', end_time: '11:00' }),
  busyTask({ _id: 'm1', title: '第一件', start_time: '08:30', end_time: '09:30' }),
  busyTask({ _id: 'm3', title: '第三件', start_time: '13:00', end_time: '14:00' })
], null);
eq(manyFound.conflicts.length, 3, '三条都撞上 → conflicts 3 条');
eqArr(manyFound.conflicts.map(function (item) { return item.id; }), ['m1', 'm2', 'm3'],
  'conflicts 按开始时间升序（页面"只列前 2 条 + 等 N 条"才是稳定的前 2 条）');

block('planner.busyRangesOfDay —— 已完成 / 每周重复 / 空日期');
var doneTask = busyTask({ _id: 'd1', title: '已经做完的事', done: true, start_time: '08:00', end_time: '09:00' });
eq(PL.busyRangesOfDay([doneTask], BUSY_DAY, null).length, 0, 'done=true 默认不算占用（做完了就不再占时间）');
eq(PL.busyRangesOfDay([doneTask], BUSY_DAY, null, { includeDone: true }).length, 1, 'includeDone: true 时算占用');
eq(PL.busyRangesOfDay([doneTask], BUSY_DAY, null, { includeDone: true })[0].start, 480, '算进来时区间还是 08:00-09:00');
eq(PL.busyRangesOfDay([busyTask({ _id: 'd2', title: '状态没归一化', done: 'true', start_time: '08:00', end_time: '09:00' })], BUSY_DAY, null).length, 1,
  'done 不是严格的 true（没归一化的脏数据）→ 仍按「没完成」算：宁可多提示一句，也不要漏报');
// 每周重复的课：换一周的同一天照样占时间（与 pages/week 共用 periods.taskOccursOn 的口径）
var weeklyBusy = busyTask({
  _id: 'w1', title: '高等数学', date: '2026-09-07', start_time: '08:00', end_time: '09:40',
  repeat: 'weekly', week_start: 1, week_end: 16, week_parity: 'all'
});
eq(PL.busyRangesOfDay([weeklyBusy], '2026-09-14', null, { semesterStart: '2026-09-07' }).length, 1,
  '每周重复的课在下周的周一照样占时间');
eq(PL.busyRangesOfDay([weeklyBusy], '2026-09-15', null, { semesterStart: '2026-09-07' }).length, 0,
  '同一周的周二不占（课在周一）');
eq(PL.busyRangesOfDay([weeklyBusy], '2026-12-28', null, { semesterStart: '2026-09-07' }).length, 0,
  '第 17 周超出 week_end=16 → 不再占时间');
// 没有日期的输入
eq(PL.busyRangesOfDay([busyTask({ _id: 'e1', start_time: '08:00', end_time: '09:00' })], '', null).length, 0,
  '日期为空 → 空数组（没有"这一天"可言）');
eq(PL.busyRangesOfDay(null, BUSY_DAY, null).length, 0, 'tasks 为 null → 空数组');
eq(PL.busyRangesOfDay(['不是对象', null, 42], BUSY_DAY, null).length, 0, '脏数据（非对象）跳过');

block('planner.suggestFreeSlot —— 离期望时刻最近的空闲课节');
eq(PL.DEFAULT_BUSY_MINUTES, 30, 'DEFAULT_BUSY_MINUTES = 30（与"没写预计耗时按 30 分钟兜底"是同一个数）');
var morningBusy = [busyTask({ _id: 'b1', title: '早课', start_time: '08:00', end_time: '10:00' })];
// 【父任务点名的用例】08:00-10:00 被占、期望 08:30 开始、要 60 分钟 → 最近的空闲课节是 10:00-11:00
var nearest = PL.suggestFreeSlot(BUSY_DAY, 60, morningBusy, null, { after: '08:30' });
eqJson(nearest, { start_time: '10:00', end_time: '11:00', minutes: 60 },
  '08:00-10:00 被占、期望 08:30 开始、要 60 分钟 → 10:00-11:00（第 3 节开始）');
eq(PL.findConflicts({ id: 'c', type: 'event', date: BUSY_DAY, start_time: nearest.start_time, end_time: nearest.end_time }, morningBusy, null).conflicts.length, 0,
  '建议的时段与已有占用不重叠（用同一个模块自检，避免两处口径打架）');
eq(PL.findConflicts({ id: 'c', type: 'event', date: BUSY_DAY, start_time: '09:55', end_time: '10:55' }, morningBusy, null).conflicts.length, 1,
  '再早 5 分钟（09:55 开始）就会撞上早课 → 10:00 确实是最早的可行**课节**起点');
// 起点贴着别人结束的时刻（半开区间：10:00 正好是早课结束的那一刻）
eqJson(PL.suggestFreeSlot(BUSY_DAY, 60, [busyTask({ _id: 'y', title: '紧接着的事', start_time: '11:00', end_time: '12:00' })], null, { after: '10:00' }),
  { start_time: '10:00', end_time: '11:00', minutes: 60 }, '10:00-11:00 与 11:00 开始的事首尾相接 → 允许（半开区间）');
// 期望时刻本身就在空档里 → 原地就是最近的一段
eqJson(PL.suggestFreeSlot(BUSY_DAY, 60, [busyTask({ _id: 'm', title: '下午的会', start_time: '14:00', end_time: '15:00' })], null, { after: '10:00' }),
  { start_time: '10:00', end_time: '11:00', minutes: 60 }, '期望 10:00 开始、10:00 到 14:00 都空着 → 就填 10:00-11:00');
// 不给 after → 从当天第一节（08:00）开始找
eqJson(PL.suggestFreeSlot(BUSY_DAY, 60, [busyTask({ _id: 'm', title: '下午的会', start_time: '14:00', end_time: '15:00' })], null),
  { start_time: '08:00', end_time: '09:00', minutes: 60 }, '不给 after → 从当天第一节 08:00 开始找');
// 期望时刻落在两节之间 → 往后推到**下一节开始**（不再给 08:35 这种网格时刻）
eqJson(PL.suggestFreeSlot(BUSY_DAY, 30, [busyTask({ _id: 'm', title: '下午的会', start_time: '14:00', end_time: '15:00' })], null, { after: '08:33' }),
  { start_time: '08:55', end_time: '09:25', minutes: 30 }, '期望 08:33（第 1 节还没下课）→ 起点是下一节开始 08:55，不是网格上的 08:35');
// 时长没给 / 非法 → 按 30 分钟算（和占用检测的兜底是同一个数）
eqJson(PL.suggestFreeSlot(BUSY_DAY, 0, morningBusy, null, { after: '08:30' }),
  { start_time: '10:00', end_time: '10:30', minutes: 30 }, '时长没给或非法 → 按 30 分钟找');
// 前面几个课节装不下就继续往后找（注意：09:20-12:00 的会把 10:00 那一节也盖住）
eqJson(PL.suggestFreeSlot(BUSY_DAY, 60, [
  busyTask({ _id: 'x1', title: '早课', start_time: '08:45', end_time: '09:00' }),
  busyTask({ _id: 'x2', title: '上午的会', start_time: '09:20', end_time: '12:00' })
], null, { after: '08:00' }), { start_time: '14:00', end_time: '15:00', minutes: 60 },
  '08:00（已上课）/ 08:55（撞早课）/ 10:00、10:55（都被上午的会盖住）→ 落到下一个课节 14:00');
// 已完成的任务不挡路；includeDone 时才挡
eqJson(PL.suggestFreeSlot(BUSY_DAY, 60, [doneTask], null),
  { start_time: '08:00', end_time: '09:00', minutes: 60 }, '已完成的任务默认不挡路 → 还是从 08:00 起');
eqJson(PL.suggestFreeSlot(BUSY_DAY, 60, [doneTask], null, { includeDone: true }),
  { start_time: '10:00', end_time: '11:00', minutes: 60 },
  'includeDone: true 时它挡路 → 08:55 起跑不掉那 60 分钟 → 下一个课节 10:00');
// 校准作息会让"同一份 periods"空出来的时间不一样，建议的课节跟着变
var periodOnly = [busyTask({ _id: 'p1', title: '实验课', periods: '3-5' })];
eqJson(PL.suggestFreeSlot(BUSY_DAY, 120, periodOnly, null, { after: '11:00' }),
  { start_time: '14:55', end_time: '16:55', minutes: 120 },
  '默认作息："3-5"一直占到 14:45 → 14:00 那一节也被盖住 → 起点是第 6 节 14:55');
eqJson(PL.suggestFreeSlot(BUSY_DAY, 120, periodOnly, OVERRIDE_40, { after: '11:00' }),
  { start_time: '14:55', end_time: '16:55', minutes: 120 },
  '校准作息：第 5 节 12:25 下课，但 12:25-14:00 那段午休**不属于任何一节**（不能建议）→ 同样是第 6 节 14:55');
// 找不到 → null（页面据此把按钮置灰、明说"今天没有整段的空闲课节"）
eq(PL.suggestFreeSlot(BUSY_DAY, 30, [busyTask({ _id: 'all', title: '占满一天', start_time: '08:00', end_time: '23:15' })], null), null,
  '第一节到最后一节全被占 → 返回 null');
eq(PL.suggestFreeSlot(BUSY_DAY, 60, [], null, { after: '23:00' }), null, '23:00 之后已经没有课节开始了 → null');
eq(PL.suggestFreeSlot(BUSY_DAY, 1440, [], null), null, '要整整 24 小时 → 当天放不下 → null');
eq(PL.suggestFreeSlot('', 60, [], null), null, '没有日期 → null');
// 别的日期的占用不影响这一天
eqJson(PL.suggestFreeSlot(BUSY_DAY, 60, [busyTask({ _id: 'n', title: '明天的课', date: '2026-09-08', start_time: '08:00', end_time: '10:00' })], null),
  { start_time: '08:00', end_time: '09:00', minutes: 60 }, '别的日期的占用不影响这一天的找空档');

block('planner.suggestFreeSlot —— 候选起点**只有课节开始时刻**');
// 【为什么要有这一组】候选起点必须能被 periods.periodNumberAt 的包含判定命中，
// 否则周视图（week.js 的 locateRow）会把它画到别的行 —— 用户点了"换到最近的空闲课节"，
// 卡片却落在跟时间对不上的行上。所以**不放占用结束时刻、不放 5 分钟网格**。
var candidates = PL.freeSlotCandidates(null);
isTrue(candidates.indexOf(480) > -1, '候选里包含第 1 节开始 08:00');
isTrue(candidates.indexOf(535) > -1, '候选里包含第 2 节开始 08:55');
isTrue(candidates.indexOf(600) > -1, '候选里包含第 3 节开始 10:00');
isTrue(candidates.indexOf(840) > -1, '候选里包含第 5 节开始 14:00（默认作息）');
eq(candidates.length, 13, '默认作息 13 节 → 候选正好 13 个（不再掺进网格或占用结束时刻）');
eq(candidates[0], 480, '第一个候选是当天第一节开始 08:00');
eq(candidates[candidates.length - 1], 1350, '最后一个候选是最后一节的**开始** 22:30（不是 23:15 结束）');
isTrue(candidates.every(function (m, i) { return i === 0 || m > candidates[i - 1]; }), '候选升序且不重复');
isFalse(candidates.indexOf(485) > -1, '5 分钟网格上的 08:05 不在候选里（网格不是课表语义）');
isFalse(candidates.indexOf(1395) > -1, '当天最后一节的结束时刻 23:15 也不在候选里（它不是任何一节的开始）');
// 校准作息里那些"不在 5 分钟刻度上"的节次开始时刻照样要进来
var oddCandidates = PL.freeSlotCandidates({ '3': ['10:02', '10:47'] });
isTrue(oddCandidates.indexOf(602) > -1, '校准作息第 3 节 10:02 开始 → 10:02 进候选（这种时刻不在网格上）');
// 被认定成"午休/休息"的空档行，开始时刻取自它自己的区间（12:25-14:15 → 12:25），
// 而且 12:25 确实被这一节包含 —— 不会被误伤
var breakCandidates = PL.freeSlotCandidates({ '5': ['11:45', '12:25'], '7': ['14:15', '15:00'] });
isTrue(breakCandidates.indexOf(745) > -1, '午休行（第 6 节 12:25-14:15）的开始时刻 12:25 也进候选');
isTrue(P.periodNumberAt('12:25', { '5': ['11:45', '12:25'], '7': ['14:15', '15:00'] }, 'start') !== null,
  '而且 12:25 能被包含判定命中（属于午休那一节）→ 起点仍然"在某一节里"');

// 【不变式】不管什么场景，返回的 start_time 都必须被某一节包含 —— 这是周视图画对行的前提
// 这两组"占用的尾巴落在课间/午休里"的任务在下面反复用到，先造好
var busyUpTo0957 = [busyTask({ _id: 'y1', title: '早课', start_time: '08:00', end_time: '09:57' })];
var busyUpTo1207 = [busyTask({ _id: 'x1', title: '上午的会', start_time: '10:00', end_time: '12:07' })];
var invariantCases = [
  { label: '整天都空', tasks: [], after: '08:00', duration: 60, table: null },
  { label: '早上有课（08:00-09:57）', tasks: busyUpTo0957, after: '09:30', duration: 60, table: null },
  { label: '上午的会开到 12:07', tasks: busyUpTo1207, after: '10:00', duration: 60, table: null },
  { label: '校准作息第 3 节 10:02 开始', tasks: [busyTask({ _id: 'c1', title: '早课', start_time: '08:00', end_time: '10:00' })], after: '08:30', duration: 30, table: { '3': ['10:02', '10:47'] } },
  { label: '午饭前有课（校准作息）', tasks: [busyTask({ _id: 'c2', title: '实验课', periods: '3-5' })], after: '11:00', duration: 120, table: OVERRIDE_40 }
];
invariantCases.forEach(function (item) {
  var slot = PL.suggestFreeSlot(BUSY_DAY, item.duration, item.tasks, item.table, { after: item.after });
  isTrue(!!slot, '[' + item.label + '] 找得到空闲课节');
  if (!slot) return;
  isTrue(P.periodNumberAt(slot.start_time, item.table, 'start') !== null,
    '[' + item.label + '] 起点 ' + slot.start_time + ' 被某一节包含（不变式：周视图能画对行）');
  isTrue(PL.slotPeriods(slot.start_time, slot.end_time, item.table) !== '',
    '[' + item.label + '] 因此 slotPeriods 必然给得出节次：' + PL.slotPeriods(slot.start_time, slot.end_time, item.table));
  eq(PL.findConflicts({ id: 'chk', type: 'event', date: BUSY_DAY, start_time: slot.start_time, end_time: slot.end_time }, item.tasks, item.table, { semesterStart: '2026-09-07' }).conflicts.length, 0,
    '[' + item.label + '] 建议的课节与已有占用不重叠');
});

// 占用到 09:57 结束：起点是**下一个课节开始 10:00**，不是 09:57
eqJson(PL.suggestFreeSlot(BUSY_DAY, 60, busyUpTo0957, null, { after: '09:30' }),
  { start_time: '10:00', end_time: '11:00', minutes: 60 },
  '占用到 09:57（课间）→ 起点 10:00（第 3 节开始），绝不是 09:57');
// 占用到 12:07 结束：午休里没有课节 → 起点跳到下一个课节开始 14:00
eqJson(PL.suggestFreeSlot(BUSY_DAY, 60, busyUpTo1207, null, { after: '10:00' }),
  { start_time: '14:00', end_time: '15:00', minutes: 60 },
  '占用到 12:07（午休里）→ 起点跳到下一个课节开始 14:00，不是 12:07 也不是 12:10');
eq(PL.slotPeriods('14:00', '15:00', null), '5-6',
  '于是节次给得出"5-6"（14:00 在第 5 节、15:00 已进第 6 节）—— 周视图画在这一段行上，与时间对得上');
// 反面教材留档：09:57 / 12:07 这种起点"谁都推不出来"
eq(PL.slotPeriods('09:57', '10:57', null), '', '09:57 在课间 → 推不出节次（所以它不能当候选起点）');
eq(PL.slotPeriods('12:07', '13:07', null), '', '12:07 在午休 → 同样推不出节次');

block('planner.slotPeriods —— 起点不属于任何一节就不写节次（防御性兜底）');
// 【为什么单列一组】避让会把节次一起填进表单，而周视图按节次排版（week.js 的 locateRow）：
// 写错一个号，卡片就被画到跟它自己的时间对不上的一行 —— 那是我们亲手造的"时间与显示不符"。
// 正常路径下候选起点全是课节开始时刻，所以下面的空串分支只是防御（见函数注释）。
eq(PL.slotPeriods('10:00', '11:00', null), '3-4', '10:00-11:00 跨第 3、4 节 → "3-4"');
eq(PL.slotPeriods('09:00', '09:40', null), '2', '整段在第 2 节里 → "2"');
eq(PL.slotPeriods('09:55', '10:55', null), '', '起点 09:55 在课间 → **留空**，不写节次');
eqArr(P.periodSpanFromTimes('09:55', '10:55', null), [4, 4],
  '对照：periodSpanFromTimes 会把 09:55 就近吸到第 4 节 —— 这正是避让不能直接用它、也不能让课间时刻当起点的原因');
eq(PL.slotPeriods('11:50', '12:20', OVERRIDE_40), '5', '校准作息下 11:50-12:20 属于第 5 节 → "5"');
eq(PL.slotPeriods('11:50', '12:20', null), '', '同一段时间在默认作息里不属于任何一节（11:40-14:00 没课）→ 留空');
eq(PL.slotPeriods('10:00', '10:50', null), '3', '终点落在课间（10:45-10:55）→ 收敛成起点那一节，不写 "3-4"');
eq(PL.slotPeriods(600, 660, null), '3-4', '也接受分钟数（页面传字符串，单测里两种都钉住）');
eq(PL.slotPeriods('', '', null), '', '没有时间 → 空串');
eq(PL.slotPeriods(null, null, null), '', 'null → 空串（不抛异常）');

// ---------------------------------------------------------------------------
// 汇总：单独跑本文件时打印通过数并给退出码；被 run.js require 时由入口汇总
// ---------------------------------------------------------------------------
if (require.main === module) H.report('planner.js 单测');
