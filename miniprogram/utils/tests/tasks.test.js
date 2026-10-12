/**
 * utils/tests/tasks.test.js —— utils/tasks.js 的纯 node 单测。
 *
 * 跑法：
 *     node utils/tests/tasks.test.js     # 只跑这一份（末尾打印通过数，失败退出码 1）
 *     node utils/tests/run.js            # 跑全部（本文件会被自动 require）
 *
 * 零依赖：不 require 任何 npm 包，也**不用 child_process**
 * （本环境沙箱禁止进程管道，捕获子进程输出会直接 EPERM）。
 *
 * 【必覆盖的几项】（父任务点名要求）
 *   1. 待办 / 已完成 / 已结课 三态各一例
 *   2. 最后一次课就在今天：已下课 / 未下课（**分钟级**边界）
 *   3. 没填下课时间 → 保守算未结束
 *   4. 单双周课的结课判定
 *   5. 归一化对脏数据的纠正
 *
 * 所有时间点都是**写死注入**的（now 参数），不依赖"今天"是哪天，所以随时跑都稳定。
 */

'use strict';

var path = require('path');
var H = require(path.join(__dirname, 'harness.js'));  // 只定义、不执行的断言助手
var TK = require(path.join(__dirname, '..', 'tasks.js'));
var P = require(path.join(__dirname, '..', 'periods.js'));

var eq = H.eq;
var eqArr = H.eqArr;
var eqJson = H.eqJson;
var isTrue = H.isTrue;
var isFalse = H.isFalse;
var block = H.block;
var show = H.show;

// ---------------------------------------------------------------------------
// 测试数据
// ---------------------------------------------------------------------------
// 学期第一周的周一 = 2026-09-07（周一）。
//   * 第 9 周的周一 = 2026-09-07 + 8×7 = 2026-11-02  ← 单周
//   * 第 14 周的周一 = 2026-09-07 + 13×7 = 2026-12-07 ← 双周
var SEMESTER_START = '2026-09-07';

/** 造一条每周重复的课（默认：每周、第 1~9 周、周一 08:00-09:40） */
function course(overrides) {
  return Object.assign({
    _id: 'c1',
    title: '高等数学',
    type: 'event',
    date: '2026-09-07',      // 锚点：决定周几（周一）
    start_time: '08:00',
    end_time: '09:40',
    priority: 'mid',
    done: false,
    repeat: 'weekly',
    week_start: 1,
    week_end: 9,
    week_parity: 'all'
  }, overrides || {});
}

/** 造一条一次性任务 */
function once(overrides) {
  return Object.assign({
    _id: 't1',
    title: '交报告',
    type: 'ddl',
    date: '2026-11-05',
    start_time: '',
    end_time: '23:59',
    priority: 'high',
    done: false,
    repeat: 'none',
    week_start: null,
    week_end: null,
    week_parity: 'all'
  }, overrides || {});
}

// ===========================================================================
// 1. 三种状态各一例
// ===========================================================================
block('tasks.taskState —— 待办 / 已完成 / 已结课 三态');

// ① 待办：最后一次课 2026-11-02，问的是 2026-10-12（第 6 周，还在上课）
var pendingCourse = course({ week_end: 9 });
eq(TK.taskState(pendingCourse, SEMESTER_START, new Date(2026, 9, 12, 10, 0)),
  'pending', '① 每周课还没上完 → pending（待办）');
isFalse(TK.isTaskFinished(pendingCourse, SEMESTER_START, new Date(2026, 9, 12, 10, 0)),
  'isTaskFinished 同为 false');
isTrue(TK.isTaskPending(pendingCourse, SEMESTER_START, new Date(2026, 9, 12, 10, 0)),
  'isTaskPending 为 true');

// ② 已完成：手动勾选 done 的课，哪怕它早就该结课了，也只算「已完成」
var doneCourse = course({ week_end: 9, done: true });
eq(TK.taskState(doneCourse, SEMESTER_START, new Date(2026, 11, 1, 12, 0)),
  'done', '② 手动勾选完成 → done（已完成）');
isTrue(TK.isTaskDone(doneCourse), 'isTaskDone 为 true');
isFalse(TK.isTaskFinished(doneCourse, SEMESTER_START, new Date(2026, 11, 1, 12, 0)),
  '**done 的任务不算已结课**（Python task_manager.py:659 的那条分支，别漏）');
eq(TK.taskState(once({ done: true }), SEMESTER_START, new Date(2026, 11, 1, 12, 0)),
  'done', '一次性任务勾选完成 → done');

// ③ 已结课：最后一次课 2026-11-02 已经过去
var finishedCourse = course({ week_end: 9 });
eq(TK.taskState(finishedCourse, SEMESTER_START, new Date(2026, 10, 3, 12, 0)),
  'finished', '③ 最后一次课（2026-11-02）已过 → finished（已结课）');
isTrue(TK.isTaskFinished(finishedCourse, SEMESTER_START, new Date(2026, 10, 3, 12, 0)),
  '2026-11-03 判断已结课');
isTrue(TK.isTaskFinished(finishedCourse, SEMESTER_START, new Date(2026, 10, 2, 23, 59)),
  '最后一课当天 23:59（早下课了）也算已结课');
isFalse(TK.isTaskFinished(finishedCourse, SEMESTER_START, new Date(2026, 10, 2, 9, 39)),
  '最后一课当天 09:39（还没下课）算未结束');
isFalse(TK.isTaskFinished(finishedCourse, SEMESTER_START, new Date(2026, 10, 1, 23, 59)),
  '最后一课的前一天算未结束');
// 一次性任务永远不自动结课：手动完成或删除更稳妥
eq(TK.taskState(once({ date: '2026-09-01' }), SEMESTER_START, new Date(2026, 11, 1, 12, 0)),
  'pending', '一次性任务过期了也不自动结课 → 仍是 pending（Python 的语义）');
isFalse(TK.isTaskFinished(once(), SEMESTER_START, new Date(2027, 0, 1, 0, 0)),
  'isTaskFinished 对非每周重复的任务恒为 false');
// 三态互斥且齐全
var states = [
  TK.taskState(pendingCourse, SEMESTER_START, new Date(2026, 9, 12, 10, 0)),
  TK.taskState(doneCourse, SEMESTER_START, new Date(2026, 9, 12, 10, 0)),
  TK.taskState(finishedCourse, SEMESTER_START, new Date(2026, 10, 3, 12, 0))
];
eq(states.join(','), 'pending,done,finished', '三态取值就是 pending / done / finished');
eqArr(TK.ALL_STATES, ['pending', 'done', 'finished'], 'ALL_STATES 顺序：待办 → 已完成 → 已结课');

// ===========================================================================
// 2. 最后一次课就在今天：分钟级边界
// ===========================================================================
block('tasks.isTaskFinished —— 最后一次课就在今天（分钟级边界）');

// course({week_end:9}) 的最后一次课 = 第 9 周周一 = 2026-11-02，下课时间 09:40
var lastDay = '2026-11-02';
eq(P.lastOccurrenceDate(course({ week_end: 9 }), SEMESTER_START), lastDay,
  '先确认口径：最后一次课就是 2026-11-02（第 9 周周一）');

isFalse(TK.isTaskFinished(course({ week_end: 9 }), SEMESTER_START, new Date(2026, 10, 2, 9, 40 - 1)),
  '09:39（下课前一分钟）→ 未结束');
isTrue(TK.isTaskFinished(course({ week_end: 9 }), SEMESTER_START, new Date(2026, 10, 2, 9, 40)),
  '09:40（正好下课）→ 已结课');
isTrue(TK.isTaskFinished(course({ week_end: 9 }), SEMESTER_START, new Date(2026, 10, 2, 9, 41)),
  '09:41（下课一分钟后）→ 已结课');
isFalse(TK.isTaskFinished(course({ week_end: 9 }), SEMESTER_START, new Date(2026, 10, 2, 0, 0)),
  '当天 00:00（还没上课）→ 未结束');
// 用字符串注入 now 也要认（两种格式都支持）
isTrue(TK.isTaskFinished(course({ week_end: 9 }), SEMESTER_START, '2026-11-02 09:40'),
  'now 传 "YYYY-MM-DD HH:MM" 字符串 → 09:40 已结课');
isFalse(TK.isTaskFinished(course({ week_end: 9 }), SEMESTER_START, '2026-11-02 09:39'),
  'now 传字符串 09:39 → 未结束');
// 下课时间跨零点的极端值不做，但 23:59 要能正常比
isFalse(TK.isTaskFinished(course({ week_end: 9, end_time: '23:59' }), SEMESTER_START,
  new Date(2026, 10, 2, 23, 58)), 'end_time=23:59 时 23:58 → 未结束');
isTrue(TK.isTaskFinished(course({ week_end: 9, end_time: '23:59' }), SEMESTER_START,
  new Date(2026, 10, 2, 23, 59)), 'end_time=23:59 时 23:59 → 已结课');

// ===========================================================================
// 3. 没填下课时间 → 保守算未结束
// ===========================================================================
block('tasks.isTaskFinished —— 没填下课时间时保守处理');
isFalse(TK.isTaskFinished(course({ week_end: 9, end_time: '' }), SEMESTER_START,
  new Date(2026, 10, 2, 23, 59)),
  '最后一课当天、没填 end_time → **未结束**（保守，宁可多显示也不误吞）');
isFalse(TK.isTaskFinished(course({ week_end: 9, end_time: null }), SEMESTER_START,
  new Date(2026, 10, 2, 23, 59)), 'end_time 为 null → 同样未结束');
isFalse(TK.isTaskFinished(course({ week_end: 9, end_time: '晚上' }), SEMESTER_START,
  new Date(2026, 10, 2, 23, 59)), 'end_time 格式非法 → 未结束（不瞎猜）');
isFalse(TK.isTaskFinished(course({ week_end: 9, end_time: '25:00' }), SEMESTER_START,
  new Date(2026, 10, 2, 23, 59)), 'end_time 越界（25:00）→ 未结束');
// 第二天照样结课（日期比较不依赖时间）
isTrue(TK.isTaskFinished(course({ week_end: 9, end_time: '' }), SEMESTER_START,
  new Date(2026, 10, 3, 0, 0)), '到了第二天，没填下课时间也结课了（按日期判）');

// ===========================================================================
// 4. 单双周课的结课判定
// ===========================================================================
block('tasks.isTaskFinished —— 单双周课');
// 双周课：week_end=16（双周）→ 最后一次课是第 16 周周一 = 2026-12-21
var evenCourse = course({ week_start: 2, week_end: 16, week_parity: 'even' });
eq(P.lastOccurrenceDate(evenCourse, SEMESTER_START), '2026-12-21',
  '双周课 week_end=16 → 最后一次课 2026-12-21（第 16 周周一）');
isFalse(TK.isTaskFinished(evenCourse, SEMESTER_START, new Date(2026, 11, 20, 23, 0)),
  '2026-12-20（最后一次课之前）→ 未结束');
isTrue(TK.isTaskFinished(evenCourse, SEMESTER_START, new Date(2026, 11, 22, 0, 0)),
  '2026-12-22（最后一次课之后）→ 已结课');
// 关键：中间那些"不该上课"的双周，不能因为"这周没课"就判结课
isFalse(TK.isTaskFinished(evenCourse, SEMESTER_START, new Date(2026, 10, 9, 12, 0)),
  '单周（2026-11-09）不算结课 —— 双周课在单周本来就不上，但课还没结束');

// 双周课但 week_end=15（单周）→ 倒推到第 14 周周一 = 2026-12-07
var evenCourseBack = course({ week_start: 2, week_end: 15, week_parity: 'even' });
eq(P.lastOccurrenceDate(evenCourseBack, SEMESTER_START), '2026-12-07',
  '双周课 week_end=15 落在单周 → 最后一次课倒推到第 14 周 2026-12-07');
isFalse(TK.isTaskFinished(evenCourseBack, SEMESTER_START, new Date(2026, 11, 6, 23, 59)),
  '2026-12-06 → 未结束');
isTrue(TK.isTaskFinished(evenCourseBack, SEMESTER_START, new Date(2026, 11, 8, 0, 0)),
  '2026-12-08 → 已结课');

// 单周课：week_end=16 → 倒推到第 15 周周一 = 2026-12-14
var oddCourse = course({ week_start: 1, week_end: 16, week_parity: 'odd' });
eq(P.lastOccurrenceDate(oddCourse, SEMESTER_START), '2026-12-14',
  '单周课 week_end=16 → 最后一次课 2026-12-14（第 15 周周一）');
isFalse(TK.isTaskFinished(oddCourse, SEMESTER_START, new Date(2026, 11, 13, 23, 59)),
  '2026-12-13 → 未结束');
isTrue(TK.isTaskFinished(oddCourse, SEMESTER_START, new Date(2026, 11, 15, 0, 0)),
  '2026-12-15 → 已结课');

// 单双周要求让它"一次也上不了"（week_start = week_end = 1 但要求双周）→ 永远不结课
var impossible = course({ week_start: 1, week_end: 1, week_parity: 'even' });
eq(P.lastOccurrenceDate(impossible, SEMESTER_START), null, '算不出最后一次课（这个单双周它一次也上不了）');
isFalse(TK.isTaskFinished(impossible, SEMESTER_START, new Date(2027, 5, 1, 12, 0)),
  '算不出最后一次课 → 永远不判结课（不瞎猜）');
eq(TK.taskState(impossible, SEMESTER_START, new Date(2027, 5, 1, 12, 0)), 'pending',
  '这种任务一直是 pending，靠手动完成或删除');

// 缺 week_end / 没有学期开始日期 → 同样不判结课
isFalse(TK.isTaskFinished(course({ week_end: null }), SEMESTER_START, new Date(2027, 5, 1, 12, 0)),
  '缺 week_end → 不判结课');
isFalse(TK.isTaskFinished(course({ week_end: 9, date: '不是日期' }), SEMESTER_START,
  new Date(2027, 5, 1, 12, 0)), '锚点日期非法（不知道周几）→ 不判结课');

// ===========================================================================
// 5. 归一化对脏数据的纠正
// ===========================================================================
block('tasks.normalizeTask —— 脏数据纠正');
// 第一组：**全部都能修**的脏数据 → 0 错误，直接给出洗干净的任务
// （注意中文类型名/中文单双周不在白名单里，所以退回 event / all）
var repairable = TK.normalizeTask({
  title: '  写论文  ',
  type: '  日程  ',                 // 中文类型名 → 不在白名单 → 退回 event
  priority: 'URGENT',               // 非法优先级 → mid
  date: '',                         // 空 → 补今天
  start_time: '9:5',                // 补零
  end_time: '11:30',
  done: 'true',                     // 字符串 true → 布尔 true
  repeat: 'WEEKLY',                 // 大小写归一
  week_start: 0,                    // 越界 → 收敛到 1
  week_end: 999,                    // 越界 → 收敛到 30
  week_parity: '双周',               // 中文 → 不在白名单 → all
  estimate_min: -30,                // 负数 → 0
  periods: [2, 7],                  // 数组 → "2-7"
  location: '  图书馆  ',
  parent_id: '',
  _id: 'hack',                      // 系统字段 → rejected
  _openid: 'hack',                  // 系统字段 → rejected
  created_at: '2020-01-01'
}, { today: '2026-10-11' });

eq(repairable.errors.length, 0, '能修的都不报错（0 条）');
eq(repairable.rejected.sort().join(','), '_id,_openid,created_at', '系统字段全被 rejected');
isTrue(!!repairable.task, '给出归一化后的任务');
var t = repairable.task;
eq(t.title, '写论文', 'title 首尾空格被裁掉');
eq(t.type, 'event', "非法 type '日程' → event");
eq(t.priority, 'mid', "非法 priority 'URGENT' → mid");
eq(t.date, '2026-10-11', 'date 缺失 → 补注入的今天');
eq(t.start_time, '09:05', "'9:5' → '09:05'");
eq(t.end_time, '11:30', '合法 end_time 原样保留');
eq(t.done, true, "done: 'true' → 布尔 true");
eq(t.repeat, 'weekly', "repeat 'WEEKLY' → 'weekly'");
eq(t.week_start, 1, 'week_start 0 → 1');
eq(t.week_end, 30, 'week_end 999 → 30（MAX_WEEK）');
eq(t.week_parity, 'all', "非法 week_parity '双周' → all");
eq(t.estimate_min, 0, '负数 estimate_min → 0');
eq(t.periods, '2-7', '数组 [2,7] → "2-7"');
eq(t.location, '图书馆', 'location 首尾空格被裁掉');
eq(t.parent_id, null, "parent_id '' → null");

// 第二组：格式**改不动**的脏数据 → 报错，并且 task 为 null（不能提交）
// 报错时不给 task，是为了让页面必须停下来说清楚，而不是揣着一份残缺数据去提交。
var dirty = TK.normalizeTask({
  title: '写论文', date: '2026-10-11', start_time: '08:00', end_time: '25:00'
}, { today: '2026-10-11' });
eq(dirty.errors.length, 1, '只有 end_time 格式不对这一条错：' + show(dirty.errors));
isTrue(dirty.errors[0].indexOf('end_time') > -1, '错误信息点名 end_time');
eq(dirty.task, null, '格式非法 → task 为 null（不能提交，与云端口径一致）');

// title 为空 = 唯一"改不动"的错 → task 为 null
var noTitle = TK.normalizeTask({ title: '   ', date: '2026-10-11' }, { today: '2026-10-11' });
eq(noTitle.task, null, 'title 为空 → task 为 null（不能提交）');
eq(noTitle.errors.length, 1, '给出 1 条错误');
isTrue(noTitle.errors[0].indexOf('title') > -1, '错误信息点名 title');
eq(TK.normalizeTask(null).task, null, '传 null → task 为 null + 报错');
eqJson(TK.normalizeTask('不是对象').errors, ['task 必须是对象'], '传非对象 → 明确报错');

// 非法日期也要报错（改不动）
var badDate = TK.normalizeTask({ title: '开会', date: '2026/10/11' }, { today: '2026-10-11' });
eq(badDate.task, null, '日期格式非法 → task 为 null');
isTrue(badDate.errors[0].indexOf('YYYY-MM-DD') > -1, '提示要求的格式');

block('tasks.normalizeTask —— 干净数据要原样通过');
var clean = TK.normalizeTask({
  title: '高等数学', type: 'event', date: '2026-09-07', start_time: '08:00', end_time: '09:40',
  priority: 'high', done: false, parent_id: null, repeat: 'weekly',
  week_start: 1, week_end: 16, week_parity: 'odd', periods: '1-2', location: '教三楼 201',
  estimate_min: 60
}, { today: '2026-10-11' });
eq(clean.errors.length, 0, '干净数据 0 错误');
eq(clean.rejected.length, 0, '干净数据 0 个被拒字段');
isTrue(!!clean.task, '给出归一化结果');
eq(clean.task.week_end, 16, '每周重复时保留 week_end');
eq(clean.task.estimate_min, 60, '保留 estimate_min');

block('tasks.normalizeTask —— 不重复的任务要清空周次');
var onceTask = TK.normalizeTask({
  title: '交报告', type: 'ddl', date: '2026-11-05', start_time: '18:00',
  repeat: 'none', week_start: 3, week_end: 9, week_parity: 'odd'
}, { today: '2026-10-11' });
eq(onceTask.task.repeat, 'none', "repeat 'none'");
eq(onceTask.task.week_start, null, '不重复 → week_start 存 null（数据干净）');
eq(onceTask.task.week_end, null, '不重复 → week_end 存 null');
eq(onceTask.task.week_parity, 'all', '不重复 → parity 归 all');
eq(onceTask.task.start_time, '', 'DDL 的 start_time 被清空');
eq(onceTask.task.end_time, '18:00', 'DDL 把 start_time 迁移成截止时刻 end_time');

// 每周重复时 week_end < week_start → 取齐
var fixWeeks = TK.normalizeTask({
  title: '课', date: '2026-09-07', repeat: 'weekly', week_start: 8, week_end: 3
}, { today: '2026-10-11' });
eq(fixWeeks.task.week_start, 8, 'week_start 保留 8');
eq(fixWeeks.task.week_end, 8, 'week_end 3 < 8 → 取齐成 8');

// ===========================================================================
// 6. pickPatch（编辑页只改一个字段时用）
// ===========================================================================
block('tasks.pickPatch —— 补丁归一化');
var patch = TK.pickPatch({ done: 1, _openid: 'hack', _id: 'x', created_at: 'y', estimate_min: -5 });
eq(patch.patch.done, true, 'done: 1 → 布尔 true');
eq(patch.patch.estimate_min, 0, 'estimate_min 负数 → 0');
eq(patch.rejected.sort().join(','), '_id,_openid,created_at', '系统字段被 rejected');
eq(patch.errors.length, 0, '没有错误');
eqJson(TK.pickPatch({ done: false }).patch, { done: false }, '只改 done 时 patch 里只有 done');
var patchRepeat = TK.pickPatch({ repeat: 'none' });
eq(patchRepeat.patch.week_start, null, "repeat 改成 none → 顺手清空 week_start");
eq(patchRepeat.patch.week_parity, 'all', '并把 parity 归 all');
eq(TK.pickPatch({ title: '  ' }).errors.length, 1, 'patch 里 title 为空 → 报错');
eq(TK.pickPatch({ type: 'xxx' }).errors.length, 1, '非法 type → 报错（不静默吞掉）');
eqJson(TK.pickPatch(null).errors, ['patch 必须是对象'], 'null patch → 明确报错');

// ===========================================================================
// 7. 展示用的小工具
// ===========================================================================
block('tasks —— 展示小工具');
eq(TK.displayTitle({ title: ' 开会 ' }), '开会', 'displayTitle 裁空格');
eq(TK.displayTitle({ title: '' }), '(无标题)', '空标题显示 (无标题)');
eq(TK.timeText({ start_time: '08:00', end_time: '09:40' }), '08:00-09:40', '起止都有 → 区间');
eq(TK.timeText({ start_time: '08:00', end_time: '' }), '08:00 起', '只有开始 → "08:00 起"');
eq(TK.timeText({ start_time: '', end_time: '23:59' }), '23:59 前', '只有截止 → "23:59 前"');
eq(TK.timeText({}), '', '都没填 → 空串');
eq(TK.stateLabel('pending'), '待办', "stateLabel('pending')");
eq(TK.stateLabel('done'), '已完成', "stateLabel('done')");
eq(TK.stateLabel('finished'), '已结课', "stateLabel('finished')");
eq(TK.stateLabel('乱写'), '待办', '认不出的状态退回"待办"');
eq(TK.stateText(once({ type: 'ddl' }), SEMESTER_START, new Date(2026, 10, 1, 12, 0)),
  '待完成', 'DDL 的待办态显示"待完成"');
eq(TK.stateText(course({ week_end: 9 }), SEMESTER_START, new Date(2026, 10, 3, 12, 0)),
  '已结课', '结课的课显示"已结课"');
eq(TK.normalizeTime('9:5'), '09:05', 'normalizeTime 补零');
eq(TK.normalizeTime('25:00'), '', 'normalizeTime 越界 → 空串');
eq(TK.normalizePeriods([7]), '7', '单节数组 → "7"');
eq(TK.normalizePeriods('7-9'), '7-9', '字符串原样');
eq(TK.normalizePeriods('9-7'), '', '倒挂的区间 → 空串（不瞎猜）');
eq(TK.normalizeEstimate(99999), 1440, 'estimate 上限 24 小时');
eq(TK.nowStr(new Date(2026, 9, 11, 9, 5)), '2026-10-11 09:05', 'nowStr 格式');
eq(TK.todayStr(new Date(2026, 9, 11, 23, 59)), '2026-10-11', 'todayStr 取本地日历日');

// ===========================================================================
// 8. occurrencePassed / endsThisWeek（课表上色用）
// ===========================================================================
block('tasks.occurrencePassed —— 这一次过点了没');
var morning = course({ end_time: '09:40', start_time: '08:00' });
isTrue(TK.occurrencePassed(morning, '2026-09-08', new Date(2026, 8, 10, 10, 0)),
  'day 在今天之前 → 已过去');
isFalse(TK.occurrencePassed(morning, '2026-09-20', new Date(2026, 8, 10, 10, 0)),
  'day 在今天之后 → 还没到');
isTrue(TK.occurrencePassed(morning, '2026-09-10', new Date(2026, 8, 10, 10, 0)),
  '就是今天、已过下课时间 09:40 → true');
isFalse(TK.occurrencePassed(morning, '2026-09-10', new Date(2026, 8, 10, 9, 39)),
  '就是今天、还没下课 → false');
isFalse(TK.occurrencePassed(
  { start_time: '', end_time: '23:59', type: 'ddl' }, '2026-09-10', new Date(2026, 8, 10, 23, 59)),
  '没有 start_time 的 DDL → 不下结论（false）');
isTrue(TK.occurrencePassed(course({ end_time: '', start_time: '08:00' }), '2026-09-10',
  new Date(2026, 8, 10, 8, 0)), '只有开始时间：过了开始时间就算过点');
isFalse(TK.occurrencePassed(morning, '乱写', new Date(2026, 8, 10, 10, 0)), 'day 非法 → false');

block('tasks.endsThisWeek —— 是不是本周结课');
// 2026-10-11 是周日；这一天所在周的周日就是它自己
eq(P.weekdayOf('2026-10-11'), 6, '先确认 2026-10-11 是周日');
// 第 6 周的周一是 2026-10-12，也就是 2026-10-11 的**下一天（下周一）**
isFalse(TK.endsThisWeek(course({ week_end: 6 }), SEMESTER_START, new Date(2026, 9, 11, 12, 0)),
  '最后一次课在下周一 → 从周日看不算"本周结课"');
isTrue(TK.endsThisWeek(course({ week_end: 6 }), SEMESTER_START, new Date(2026, 9, 12, 8, 30)),
  '站到 2026-10-12（周一，最后一课当天）→ 是"本周结课"');
isFalse(TK.endsThisWeek(course({ week_end: 6 }), SEMESTER_START, new Date(2026, 9, 13, 12, 0)),
  '2026-10-13：已经结课了 → 不再提示"本周结课"');
isFalse(TK.endsThisWeek(course({ week_end: 6, done: true }), SEMESTER_START, new Date(2026, 9, 12, 8, 30)),
  '手动完成的课也不再提示"本周结课"');
isFalse(TK.endsThisWeek(once(), SEMESTER_START, new Date(2026, 9, 12, 8, 30)),
  '一次性任务没有"结课"概念 → false');

// ===========================================================================
// 9. 与 periods.js 的口径自洽（防两边各写一套）
// ===========================================================================
block('tasks × periods 口径自洽');
var c = course({ week_end: 9 });
var last = P.lastOccurrenceDate(c, SEMESTER_START);
isTrue(P.taskOccursOn(c, last, SEMESTER_START), '最后一次课那天，periods.taskOccursOn 也说上这课');
isFalse(P.taskOccursOn(c, P.formatDate(P.addDays(last, 7)), SEMESTER_START),
  '最后一次课的后一周，taskOccursOn 说不上了');
eq(TK.taskState(c, SEMESTER_START, new Date(2026, 10, 2, 9, 40)), 'finished',
  '最后一课当天、下课后 → finished（与 taskOccursOn 的口径一致）');

// ---------------------------------------------------------------------------
// 汇总：单独跑本文件时打印通过数并给退出码；被 run.js require 时由入口汇总
// ---------------------------------------------------------------------------
if (require.main === module) H.report('tasks.js 单测');
