/**
 * cloudfunctions/_selftest.js —— 三个云函数「纯逻辑部分」的自测脚本。
 *
 * 跑法（不需要云环境、不需要 npm install）：
 *     node cloudfunctions/_selftest.js
 *
 * 覆盖范围：
 *   1. lib/normalize.js —— 字段归一化容错、白名单、级联删除 id 收集、stats 计算
 *   2. tasks/index.js    —— 用内存假数据库跑通 list（跨页取全）/ add / bulk_add /
 *                           update（白名单）/ remove（级联）/ stats / settings_*，
 *                           并验证"前端伪造 openid 无效"
 *   3. aiParse/index.js  —— 脏 JSON 容错解析、结果归一化
 *   4. aiDecompose/index.js —— 子任务归一化 + estimate_min 容错
 *
 * 退出码：全部通过 0；有任何失败 1。
 */

'use strict';

const path = require('path');

// 被测模块（都在本目录下：tasks/index.js 在没有 wx-server-sdk 时会降级，仍可 require）
const N = require(path.join(__dirname, 'tasks', 'lib', 'normalize.js'));
const tasksFn = require(path.join(__dirname, 'tasks', 'index.js'));
const aiParse = require(path.join(__dirname, 'aiParse', 'index.js'));
const aiDecompose = require(path.join(__dirname, 'aiDecompose', 'index.js'));

// ---------------------------------------------------------------------------
// 迷你测试框架
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];
let currentCase = '(未命名)';

function testCase(name, fn) {
  currentCase = name;
  try {
    fn();
  } catch (error) {
    failed += 1;
    failures.push(`[${name}] 抛出异常：${error && error.message}`);
  }
}

function ok(condition, message) {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`[${currentCase}] ${message}`);
  }
}

function eq(actual, expected, message) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (!same) {
    failed += 1;
    failures.push(`[${currentCase}] ${message} —— 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
    return;
  }
  passed += 1;
}

/** 异步用例（假数据库那一批） */
const asyncCases = [];
function testCaseAsync(name, fn) {
  asyncCases.push({ name, fn });
}

// ---------------------------------------------------------------------------
// 内存假数据库：已抽到 ./_fake_db.js
// ---------------------------------------------------------------------------
// 【为什么抽出去】前端 utils/tests/ai_contract.js 也要用这个假库。以前它只能把本文件
// 读成字符串、按字符位置切出 createFakeDb 再 eval —— 那种耦合断过两次（本文件一重构
// 位置就变）。现在两边统一 require 同一个模块，本文件怎么排版都不影响别人。
// 注意：_fake_db.js 放在 cloudfunctions/ 根下，**不在任何云函数目录里，不会被部署**。
const { createFakeDb, createSettingsDb } = require('./_fake_db.js');

function makeTask(overrides) {
  return Object.assign({
    _id: 'x',
    _openid: 'me',
    title: '任务',
    type: 'event',
    date: '2026-10-11',
    start_time: '',
    end_time: '',
    priority: 'mid',
    done: false,
    parent_id: null,
    repeat: 'none',
    week_start: null,
    week_end: null,
    week_parity: 'all',
    periods: '',
    location: '',
    estimate_min: 0,
    created_at: '2026-10-01T10:00:00+08:00',
    updated_at: '2026-10-01T10:00:00+08:00',
  }, overrides || {});
}

// ===========================================================================
// 1. 日期 / 时间基础工具
// ===========================================================================
testCase('1.1 日期校验：合法与非法', () => {
  ok(N.isValidDate('2026-10-11'), '2026-10-11 应当合法');
  ok(N.isValidDate('2026-02-28'), '2026-02-28 应当合法');
  ok(!N.isValidDate('2026-02-30'), '2026-02-30 应当非法（日历上不存在）');
  ok(!N.isValidDate('2026-13-01'), '月份 13 应当非法');
  ok(!N.isValidDate('2026/10/11'), '斜杠格式应当非法');
  ok(!N.isValidDate('2026-10-1'), '未补零应当非法');
  ok(!N.isValidDate(''), '空串应当非法');
  ok(!N.isValidDate(null), 'null 应当非法');
});

testCase('1.2 时间校验与补零', () => {
  ok(N.isValidTime('09:05'), '09:05 合法');
  ok(N.isValidTime('9:5'), '9:5 合法（会被补零）');
  ok(N.isValidTime(''), '空串合法（表示没填时间）');
  ok(!N.isValidTime('24:00'), '24:00 非法');
  ok(!N.isValidTime('09:60'), '09:60 非法');
  ok(!N.isValidTime('上午九点'), '中文描述非法');
  eq(N.normalizeTime('9:5'), '09:05', '9:5 补零');
  eq(N.normalizeTime('23:59'), '23:59', '23:59 原样');
  eq(N.normalizeTime('abc'), '', '垃圾值归空');
});

testCase('1.3 周次 / 单双周 / 周一计算（对齐 config.py）', () => {
  // 2026-09-07 是周一；2026-10-11 是周日
  eq(N.mondayOf('2026-10-11'), '2026-10-05', '2026-10-11（周日）所在周的周一是 10-05');
  eq(N.weekNumber('2026-09-07', '2026-09-07'), 1, '开学当天 = 第 1 周');
  eq(N.weekNumber('2026-10-11', '2026-09-07'), 5, '2026-10-11 = 第 5 周');
  eq(N.weekNumber('2026-09-06', '2026-09-07'), null, '开学之前返回 null');
  eq(N.weekParity(5), 'odd', '第 5 周是单周');
  eq(N.weekParity(4), 'even', '第 4 周是双周');
  eq(N.mondayOfWeek(5, '2026-09-07'), '2026-10-05', '第 5 周的周一是 10-05');
});

// ===========================================================================
// 2. normalizeTask：字段补全与容错
// ===========================================================================
testCase('2.1 空标题 / 非对象：errors 非空，task 仍尽量给出（由调用方决定不入库）', () => {
  const blank = N.normalizeTask({ title: '   ' });
  ok(blank.errors.length > 0, '空标题要报错');
  eq(blank.task.title, '', '仍然给出归一化结果（title 为空），而不是 null');
  ok(N.normalizeTask({ title: '' }).errors.length > 0, '应当给出错误说明');
  // 只有"根本不是对象"时 task 才是 null
  ok(N.normalizeTask(null).task === null, 'null 无法归一化 → task 为 null');
  ok(N.normalizeTask(null).errors.length > 0, 'null 也要报错');
  ok(N.normalizeTask('字符串').task === null, '非对象 → task 为 null');
});

testCase('2.2 类型 / 优先级非法 → 退回默认值', () => {
  const r1 = N.normalizeTask({ title: '开会', type: 'MEETING', priority: '紧急' });
  eq(r1.task.type, 'event', '非法 type 退回 event');
  eq(r1.task.priority, 'mid', '非法 priority 退回 mid');

  const r2 = N.normalizeTask({ title: '交报告', type: 'DDL', priority: 'HIGH' });
  eq(r2.task.type, 'ddl', '大写 DDL 应当被接受');
  eq(r2.task.priority, 'high', '大写 HIGH 应当被接受');

  const r3 = N.normalizeTask({ title: '子步骤', type: 'subtask' }, { defaultPriority: 'high' });
  eq(r3.task.priority, 'high', '可以指定默认优先级');
});

testCase('2.3 DDL 只留截止时刻（start_time 迁移到 end_time）', () => {
  const r = N.normalizeTask({ title: '交实验报告', type: 'ddl', date: '2026-10-16', start_time: '12:00' });
  eq(r.task.start_time, '', 'DDL 的 start_time 必须清空');
  eq(r.task.end_time, '12:00', '原 start_time 迁移为截止时刻');
  eq(r.errors, [], '迁移过程不应报错');

  const r2 = N.normalizeTask({ title: '交报告', type: 'ddl', date: '2026-10-16' });
  eq(r2.task.end_time, '', '没说时刻就留空，不瞎猜');
});

testCase('2.4 时间非法 → 报错，且该字段被清空（云函数据此拒绝写入）', () => {
  const bad = N.normalizeTask({ title: '开会', date: '2026-10-11', start_time: '25:00' });
  ok(bad.errors.join().indexOf('start_time') !== -1, '错误信息应指出 start_time');
  eq(bad.task.start_time, '', '越界的 start_time 被清空');
  eq(bad.task.title, '开会', '其它字段照常归一化');

  const badDate = N.normalizeTask({ title: '开会', date: '10月11号' });
  ok(badDate.errors.join().indexOf('date') !== -1, '错误信息应指出 date');

  const emptyDate = N.normalizeTask({ title: '开会' }, { today: '2026-10-11' });
  eq(emptyDate.task.date, '2026-10-11', '没给日期时补今天（与 Python 版一致）');
  eq(emptyDate.errors, [], '补默认值不算错误');

  // 关键：这些"有错误"的任务，云函数必须拒绝写库（见 7.7）
  eq(N.normalizeTask({ title: '', date: '2026-10-11' }).errors.length, 1, '空标题 → 1 条错误');
  eq(N.normalizeTask({ title: 'x', date: '2026-13-01' }).errors.length, 1, '非法日期 → 1 条错误');
});

testCase('2.5 estimate_min 容错：负数 / 字符串 / 缺失 / 超限', () => {
  eq(N.normalizeTask({ title: 'a', estimate_min: -30 }).task.estimate_min, 0, '负数 → 0');
  eq(N.normalizeTask({ title: 'a', estimate_min: '60' }).task.estimate_min, 60, '数字字符串 → 60');
  eq(N.normalizeTask({ title: 'a', estimate_min: '60分钟' }).task.estimate_min, 60, '带单位字符串 → 60');
  eq(N.normalizeTask({ title: 'a' }).task.estimate_min, 0, '缺失 → 0（不瞎猜）');
  eq(N.normalizeTask({ title: 'a', estimate_min: null }).task.estimate_min, 0, 'null → 0');
  eq(N.normalizeTask({ title: 'a', estimate_min: 'abc' }).task.estimate_min, 0, '垃圾字符串 → 0');
  eq(N.normalizeTask({ title: 'a', estimate_min: 999999 }).task.estimate_min, 1440, '超上限收敛到 1440');
  eq(N.normalizeTask({ title: 'a', estimate_min: 60.7 }).task.estimate_min, 60, '小数取整');
});

testCase('2.6 周次 / 单双周 / repeat 容错', () => {
  const weekly = N.normalizeTask({
    title: '高等数学', type: 'event', repeat: 'WEEKLY', week_start: '2', week_end: 16, week_parity: 'ODD',
  });
  eq(weekly.task.repeat, 'weekly', '大写 WEEKLY 接受');
  eq(weekly.task.week_start, 2, '字符串周次转数字');
  eq(weekly.task.week_end, 16, '周次数字保持');
  eq(weekly.task.week_parity, 'odd', '大写 ODD 接受');

  const brokenRange = N.normalizeTask({ title: '课', repeat: 'weekly', week_start: 10, week_end: 3 });
  eq(brokenRange.task.week_end, 10, 'week_end < week_start 时取齐到 week_start');

  const clamped = N.normalizeTask({ title: '课', repeat: 'weekly', week_start: 0, week_end: 999 });
  eq(clamped.task.week_start, 1, '周次下限收敛到 1');
  eq(clamped.task.week_end, 30, '周次上限收敛到 30');

  const noRepeat = N.normalizeTask({ title: '一次性日程', repeat: 'monthly', week_start: 5 });
  eq(noRepeat.task.repeat, 'none', '非法 repeat → none');
  eq(noRepeat.task.week_start, null, '不重复的任务不存周次');
  eq(noRepeat.task.week_end, null, '不重复的任务不存周次');
  eq(noRepeat.task.week_parity, 'all', '不重复的任务单双周归 all');
});

testCase('2.7 parent_id / periods / location / done 容错', () => {
  eq(N.normalizeTask({ title: 'a', parent_id: '' }).task.parent_id, null, '空 parent_id → null');
  eq(N.normalizeTask({ title: 'a', parent_id: undefined }).task.parent_id, null, 'undefined → null');
  eq(N.normalizeTask({ title: 'a', parent_id: 'abc123' }).task.parent_id, 'abc123', '字符串 id 保留');
  eq(N.normalizeTask({ title: 'a', done: 'true' }).task.done, true, '字符串 true → 布尔');
  eq(N.normalizeTask({ title: 'a', done: 1 }).task.done, true, '数字 1 → 布尔');
  eq(N.normalizeTask({ title: 'a' }).task.done, false, '默认未完成');
  eq(N.normalizeTask({ title: 'a', periods: [7, 9] }).task.periods, '7-9', '数组节次 → "7-9"');
  eq(N.normalizeTask({ title: 'a', periods: [7] }).task.periods, '7', '单节 → "7"');
  eq(N.normalizeTask({ title: 'a', periods: '7-9' }).task.periods, '7-9', '字符串节次保持');
  eq(N.normalizeTask({ title: 'a', periods: '乱写' }).task.periods, '', '垃圾节次归空');
  eq(N.normalizeTask({ title: 'a', location: '  致理楼 305  ' }).task.location, '致理楼 305', '地点去空白');
  ok(N.normalizeTask({ title: 'x'.repeat(500) }).task.title.length <= 100, '超长标题被截断');
});

// ===========================================================================
// 3. pickPatch：字段白名单
// ===========================================================================
testCase('3.1 白名单只放行业务字段', () => {
  const r = N.pickPatch({ title: '新标题', done: true, priority: 'high' }, { now: 'T' });
  eq(Object.keys(r.patch).sort(), ['done', 'priority', 'title', 'updated_at'], '只保留白名单字段 + updated_at');
  eq(r.errors, [], '合法字段不报错');
});

testCase('3.2 身份与系统字段一律拒绝（安全关键）', () => {
  const r = N.pickPatch({
    _openid: '别人的openid', _id: '别人的id', created_at: '伪造时间',
    openid: 'x', unionid: 'x', title: '合法标题',
  }, { now: 'T' });
  eq(r.patch.title, '合法标题', '合法字段仍然生效');
  ok(r.patch._openid === undefined, '_openid 必须被拒绝');
  ok(r.patch._id === undefined, '_id 必须被拒绝');
  ok(r.patch.created_at === undefined, 'created_at 必须被拒绝');
  ok(r.rejected.indexOf('_openid') !== -1, '被拒字段要在 rejected 里报告');
  eq(Object.keys(r.patch).sort(), ['title', 'updated_at'], '除白名单外一个都不放过');
});

testCase('3.3 白名单字段的值也做归一化', () => {
  const r = N.pickPatch({ priority: '超高', date: '明天' }, { now: 'T' });
  ok(r.errors.length === 2, '非法 priority 与非法 date 都要报错');
  eq(r.patch, {}, '有错时不应产出可写字段');

  const r2 = N.pickPatch({ start_time: '9:5', estimate_min: -5, week_start: 99 }, { now: 'T' });
  eq(r2.patch.start_time, '09:05', '时间补零');
  eq(r2.patch.estimate_min, 0, '负数归 0');
  eq(r2.patch.week_start, 30, '周次收敛');

  const r3 = N.pickPatch({ repeat: 'none' }, { now: 'T' });
  eq(r3.patch.week_start, null, '改成不重复时清空周次');
  eq(r3.patch.week_end, null, '改成不重复时清空周次');
  eq(r3.patch.week_parity, 'all', '改成不重复时单双周归 all');
});

// ===========================================================================
// 4. collectRemoveIds / chunk：级联删除的 id 收集
// ===========================================================================
const cascadeFixtures = [
  makeTask({ _id: 'p1', title: '写毕业论文', type: 'ddl', date: '2026-12-31' }),
  makeTask({ _id: 'c1', title: '查文献', parent_id: 'p1' }),
  makeTask({ _id: 'c2', title: '写提纲', parent_id: 'p1' }),
  makeTask({ _id: 'g1', title: '孙任务', parent_id: 'c1' }), // 只级联一层，不该被删
  makeTask({ _id: 'other', title: '别的任务', parent_id: null }),
  makeTask({ _id: 'p2', title: '另一个大任务' }),
  makeTask({ _id: 'c3', title: '它的子任务', parent_id: 'p2' }),
];

testCase('4.1 只级联一层，孙任务不动', () => {
  const plan = N.collectRemoveIds(cascadeFixtures, 'p1');
  eq(plan.ids.sort(), ['c1', 'c2', 'p1'], '删除自己 + 直接子任务');
  eq(plan.children.sort(), ['c1', 'c2'], 'children 只含直接子任务');
  ok(plan.ids.indexOf('g1') === -1, '孙任务不在删除范围内');
  ok(plan.ids.indexOf('other') === -1, '别人的任务不在范围内');
});

testCase('4.2 边界：没有子任务 / 空 id / 脏列表', () => {
  eq(N.collectRemoveIds(cascadeFixtures, 'other').ids, ['other'], '没有子任务时只删自己');
  eq(N.collectRemoveIds(cascadeFixtures, '').ids, [], '空 id 返回空');
  eq(N.collectRemoveIds(cascadeFixtures, '  ').ids, [], '空白 id 返回空');
  eq(N.collectRemoveIds(null, 'p1').ids, ['p1'], '列表脏数据时仍返回自己');
  eq(N.collectRemoveIds([null, 'x', { _id: 'k', parent_id: 'p1' }], 'p1').ids.sort(), ['k', 'p1'], '跳过非对象脏数据');
});

testCase('4.3 chunk 分批（批量写 20 条 / 删除 100 条）', () => {
  eq(N.chunk([1, 2, 3, 4, 5], 2).length, 3, '5 条按 2 切 → 3 批');
  eq(N.chunk([1, 2, 3, 4], 2).map((b) => b.length), [2, 2], '每批长度正确');
  eq(N.chunk([], 2), [], '空数组 → 空');
  eq(N.chunk([1, 2], 0).length, 2, 'size<=0 时退化为 1');
  eq(N.BULK_CHUNK, 20, '批量写上限 20');
  eq(N.PAGE_SIZE, 100, '单次读取上限 100');
});

// ===========================================================================
// 5. stats 计算
// ===========================================================================
// 开学日固定为 2026-09-07（周一）；下面的日期都按这个基准手工核过星期
//   第 1 周 = 09-07~09-13，第 4 周 = 09-28~10-04，第 5 周 = 10-05~10-11（含"今天"），第 16 周 = 12-21~12-27
const statsFixtures = [
  makeTask({ _id: 't1', type: 'ddl', date: '2026-10-16' }),
  makeTask({ _id: 't2', type: 'event', date: '2026-10-12', done: true }),
  makeTask({ _id: 't3', type: 'event', date: '2026-10-13' }),
  makeTask({ _id: 't4', type: 'event', date: '2026-10-14', estimate_min: 60 }), // 手工日程，不自动结束
  makeTask({
    _id: 'c1', title: '每周课A', date: '2026-09-10', repeat: 'weekly', // 周四的课
    week_start: 1, week_end: 16, week_parity: 'all', start_time: '08:00', end_time: '09:40',
  }), // 最后一次课 12-24，还没到 → 进行中
  makeTask({
    _id: 'c2', title: '每周课B', date: '2026-09-08', repeat: 'weekly', // 周二的课
    week_start: 1, week_end: 4, week_parity: 'all',
  }), // 最后一次课 09-29，早已过去 → 已结课
  makeTask({
    _id: 'c3', title: '周日课', date: '2026-09-13', repeat: 'weekly', // 周日的课
    week_start: 1, week_end: 5, week_parity: 'all', start_time: '16:00', end_time: '17:40',
  }), // week_end=5 → 最后一次课就是今天 10-11 → 未结束
  makeTask({
    _id: 'c4', title: '已结课单周', date: '2026-09-08', repeat: 'weekly', // 周二的课，单周
    week_start: 1, week_end: 4, week_parity: 'odd',
  }), // 第 4 周是双周 → 倒推到第 3 周（09-21~09-27），最后一次课 09-22 → 已结课
];

testCase('5.1 lastOccurrenceDate 按单双周倒推', () => {
  const semester = '2026-09-07';
  eq(N.lastOccurrenceDate(statsFixtures[4], semester), '2026-12-24', '第16周的周四 = 12-24');
  eq(N.lastOccurrenceDate(statsFixtures[5], semester), '2026-09-29', '第4周的周二 = 09-29');
  eq(N.lastOccurrenceDate(statsFixtures[6], semester), '2026-10-11', '第5周的周日 = 10-11（就是今天）');
  eq(N.lastOccurrenceDate(statsFixtures[7], semester), '2026-09-22', '双周 week_end 倒推到第3周 → 09-22');
  eq(N.lastOccurrenceDate(statsFixtures[0], semester), null, '一次性日程没有"最后一次课"');
  eq(N.lastOccurrenceDate({ repeat: 'weekly', date: '乱写', week_end: 5 }, semester), null, '日期脏 → null');
});

testCase('5.2 isTaskFinished：最后一次课过了才算结束', () => {
  const semester = '2026-09-07';
  const nowToday = new Date('2026-10-11T15:00:00+08:00'); // 今天是 2026-10-11
  eq(N.isTaskFinished(statsFixtures[4], semester, nowToday), false, '最后一次课 12-24 还没到 → 进行中');
  eq(N.isTaskFinished(statsFixtures[5], semester, nowToday), true, '最后一次课 09-29 已过 → 已结课');
  eq(N.isTaskFinished(statsFixtures[6], semester, nowToday), false, '最后一次课就是今天 10-11、还没下课 → 未结束');
  eq(N.isTaskFinished(statsFixtures[7], semester, nowToday), true, '最后一次课 09-22 已过 → 已结课');
  eq(N.isTaskFinished(statsFixtures[0], semester, nowToday), false, '手工 DDL 不会自动结束');

  // 最后一次课就是今天 = 2026-10-11（周日），下课时间 17:40（判定口径对齐 task_manager：
  // "last_date == today 时，下课时间过了才算结束"）
  const sundayCourse = statsFixtures[6];
  eq(N.isTaskFinished(sundayCourse, semester, new Date('2026-10-11T18:00:00+08:00')), true, '今天这节课已下课 → 结束');
  eq(N.isTaskFinished(sundayCourse, semester, new Date('2026-10-11T17:39:00+08:00')), false, '下课前一分钟 → 未结束');
  eq(sundayCourse.end_time, '17:40', '（确认下课时间确实是 17:40）');

  // 没填下课时间 → 保守地算「还没结束」，与 Python 版一致
  const noEndTime = makeTask({
    _id: 'c6', repeat: 'weekly', date: '2026-09-13', week_start: 1, week_end: 5, week_parity: 'all',
  });
  eq(N.isTaskFinished(noEndTime, semester, new Date('2026-10-11T23:00:00+08:00')), false, '没填下课时间 → 保守算未结束');
});

testCase('5.3 taskStats 汇总', () => {
  const stats = N.taskStats(statsFixtures, '2026-09-07', new Date('2026-10-11T15:00:00+08:00'));
  eq(stats.total, 8, '总数 8');
  eq(stats.done, 1, '手动完成 1');
  eq(stats.ddl, 1, 'DDL 1');
  eq(stats.finished, 2, '已结课 2（c2 最后一次课 09-29、c4 最后一次课 09-22）');
  eq(stats.pending, 8 - 1 - 2, 'pending = total - done - finished');

  const empty = N.taskStats(null, '', new Date());
  eq(empty, { total: 0, done: 0, ddl: 0, finished: 0, pending: 0 }, '空数据全 0');
  ok(N.taskStats([{ done: true }], '', new Date()).finished === 0, '缺字段的脏任务不炸');

  // 与 task_manager.is_task_finished 一致：手动标记完成的课算「已完成」，不重复计入 finished
  const doneCourse = makeTask({ _id: 'c9', repeat: 'weekly', date: '2026-09-08', week_end: 4, done: true });
  eq(N.isTaskFinished(doneCourse, '2026-09-07', new Date('2026-10-11T15:00:00+08:00')), false, 'done 的课不重复计 finished');
  const doneStats = N.taskStats([doneCourse], '2026-09-07', new Date('2026-10-11T15:00:00+08:00'));
  eq([doneStats.done, doneStats.finished, doneStats.pending], [1, 0, 0], 'done 与 finished 不重叠');
});

// ===========================================================================
// 6. settings 归一化
// ===========================================================================
testCase('6.1 settings 只认两个键，且做校验', () => {
  const r = N.normalizeSettings({ semester_start: '2026-09-09', period_times: { 1: ['8:00', '8:45'] }, 恶意字段: 1 });
  eq(r.errors, [], '合法设置不报错');
  eq(r.settings.semester_start, '2026-09-07', '开学日统一归到那一周的周一（09-09 是周三）');
  eq(Object.keys(r.settings).sort(), ['period_times', 'semester_start'], '多余的键被忽略');

  const bad = N.normalizeSettings({ semester_start: '9月7日' });
  ok(bad.errors.length === 1, '非法日期要报错');
  ok(bad.settings.semester_start === undefined, '非法值不写入');

  const partial = N.normalizeSettings({ period_times: { 1: ['08:00', '08:45'] } }, { partial: true });
  eq(Object.keys(partial.settings), ['period_times'], 'partial 模式不写入未提供的键');

  eq(N.normalizeSettings({}, { partial: true }).errors.length, 1, '一个可存字段都没有 → 报错');
});

testCase('6.2 period_times 逐条清洗 + 默认作息', () => {
  const r = N.normalizeSettings({
    period_times: { 1: ['08:00', '08:45'], 2: ['25:00', '09:40'], 3: ['乱写'], 99: ['10:00', '10:45'] },
  });
  eq(Object.keys(r.settings.period_times), ['1'], '非法时刻与越界节次被丢掉');

  const defaults = N.withSettingsDefaults(null);
  eq(defaults.semester_start, '', '没设置过 → 空');
  eq(defaults.period_times[1], ['08:00', '08:45'], '默认作息第 1 节');
  eq(defaults.period_times[13], ['22:30', '23:15'], '默认作息第 13 节');

  const custom = N.withSettingsDefaults({ semester_start: '2026-09-07', period_times: { 1: ['09:00', '09:45'] } });
  eq(custom.period_times[1], ['09:00', '09:45'], '用户自定义作息优先');
  eq(custom.semester_start, '2026-09-07', '开学日透传');
});

// ===========================================================================
// 6c. 静态一致性：tasks/index.js 用到的每个 N.xxx 都必须真的被导出
// ===========================================================================
testCase('6c.1 index.js 里所有 N.xxx() 调用点，normalize.js 都导出了', () => {
  // 【这条为什么重要】"函数定义了但忘了写进 module.exports"是**运行期才炸**的
  // 静默断路：代码读起来完全正常，一上线用户点按钮就得到
  // "N.xxx is not a function"。这里直接扫源码，把调用点与导出表对账。
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, 'tasks', 'index.js'), 'utf8');

  const used = [];
  const pattern = /\bN\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let matched = pattern.exec(source);
  while (matched) {
    if (used.indexOf(matched[1]) === -1) used.push(matched[1]);
    matched = pattern.exec(source);
  }

  ok(used.length >= 10, `确实扫到了调用点（${used.length} 个：${used.join(', ')}）`);

  const missing = used.filter((name) => typeof N[name] !== 'function');
  eq(missing, [], `这些被调用但没导出（或不是函数）：${missing.join(', ')}`);

  // 新加的 AI 配置函数必须都在（防止"扫不到但确实要用"的漏网）
  ['maskApiKey', 'stripSecrets', 'normalizeAiConfig', 'aiConfigView'].forEach((name) => {
    ok(typeof N[name] === 'function', `normalize.js 导出了 ${name}`);
  });

  // 反向也看一眼：导出表里不该有 undefined 的键（手滑写错变量名就是这样）
  const brokenKeys = Object.keys(N).filter((key) => N[key] === undefined);
  eq(brokenKeys, [], `导出表里有 undefined 的键：${brokenKeys.join(', ')}`);
});

testCase('6c.2 两个 AI 云函数的导出表也不能有 undefined 键', () => {
  // AI 函数同样存在"定义在闭包里、忘了放进 Object.assign(exports,...)"的风险
  [['aiParse', aiParse], ['aiDecompose', aiDecompose]].forEach((pair) => {
    const name = pair[0];
    const mod = pair[1];
    const brokenKeys = Object.keys(mod).filter((key) => mod[key] === undefined);
    eq(brokenKeys, [], `${name} 导出表里 undefined 的键：${brokenKeys.join(', ')}`);
    ok(typeof mod.main === 'function', `${name}.main 是函数`);
    ok(typeof mod.postJson === 'function', `${name}.postJson 是函数（契约测试的替换点）`);
    ok(typeof mod.resolveEffectiveConfig === 'function', `${name} 导出了 resolveEffectiveConfig`);
    ok(typeof mod.loadUserAiConfig === 'function', `${name} 导出了 loadUserAiConfig`);
    ok(typeof mod.findInjectedFields === 'function', `${name} 导出了 findInjectedFields`);
  });
});

// ===========================================================================
// 7. tasks/index.js：用假数据库跑通全部 action
// ===========================================================================
testCase('7.1 stripIdentity：前端伪造的身份字段被丢弃', () => {
  const clean = tasksFn.stripIdentity({ action: 'list', openid: '黑客', _openid: '黑客', user: 'x', text: 'hi' });
  eq(Object.keys(clean).sort(), ['action', 'text'], 'openid 类字段全部丢掉');
  ok(tasksFn.stripIdentity({ OPENID: 'x' }).OPENID === undefined, '大写 OPENID 也丢');
});

testCaseAsync('7.2 list：跨页取全（>100 条）', async () => {
  const rows = [];
  for (let i = 0; i < 250; i += 1) {
    rows.push(makeTask({ _id: `mine_${i}`, date: '2026-10-11', title: `我的任务${i}` }));
  }
  // 混入 3 条"别人"的任务，验证 _openid 条件
  rows.push(makeTask({ _id: 'other_1', _openid: 'someone-else' }));
  const db = createFakeDb({ tasks: rows });

  const result = await tasksFn.handleAction(db, 'me', { action: 'list', openid: 'someone-else' });
  ok(result.ok === true, '应当成功');
  eq(result.tasks.length, 250, '只拿到自己的 250 条');
  ok(result.tasks.every((t) => t._openid === 'me'), '结果里没有别人的任务');
  ok(db.stats.listGetCalls >= 3, `分页至少查 3 次（实际 ${db.stats.listGetCalls}）`);
});

testCaseAsync('7.3 add / update / remove（级联）走通', async () => {
  const db = createFakeDb({ tasks: [] });

  const added = await tasksFn.handleAction(db, 'me', {
    action: 'add',
    task: { title: '写毕业论文', type: 'ddl', date: '2026-12-31', start_time: '12:00', priority: '高' },
  });
  ok(added.ok === true && !!added.id, '新增成功并返回 id');
  eq(db.store.tasks[0]._openid, 'me', '_openid 由服务端写入');
  eq(db.store.tasks[0].type, 'ddl', '类型归一化');
  eq(db.store.tasks[0].priority, 'mid', '中文优先级不合法 → 退回 mid');
  eq(db.store.tasks[0].end_time, '12:00', 'DDL 时刻迁移');

  const parentId = added.id;
  const child = await tasksFn.handleAction(db, 'me', {
    action: 'add', task: { title: '查文献', parent_id: parentId, date: '2026-11-01' },
  });
  ok(child.ok === true, '子任务新增成功');

  // 登录用户改成别人 → 改不动这条任务（updated=0 ⇒ 一律按"无权修改"处理）
  const denied = await tasksFn.handleAction(db, 'hacker', { action: 'update', id: parentId, patch: { done: true } });
  ok(denied.ok === false, '别人改不动这条任务');
  eq(db.store.tasks.length, 2, '越权 update 不能凭空造出记录');
  eq(db.store.tasks.filter((t) => t._openid !== 'me').length, 0, '库里没有不属于自己的任务');
  eq(db.store.tasks[0].done, false, '越权 update 没有改动原任务');

  const updated = await tasksFn.handleAction(db, 'me', { action: 'update', id: parentId, patch: { done: true } });
  eq(updated.updated, 1, '本人可以改');
  eq(db.store.tasks[0].done, true, 'patch 落库');

  const badPatch = await tasksFn.handleAction(db, 'me', { action: 'update', id: parentId, patch: { _openid: 'hacker' } });
  ok(badPatch.ok === false, '只传非法字段 → 拒绝');

  const removed = await tasksFn.handleAction(db, 'me', { action: 'remove', id: parentId });
  eq(removed.removed, 2, '删除父任务时级联删掉子任务');
  eq(db.store.tasks.length, 0, '库已清空');
});

testCaseAsync('7.4 bulk_add：分 20 条一批 + 脏数据跳过', async () => {
  const db = createFakeDb({ tasks: [] });
  const batch = [];
  for (let i = 0; i < 45; i += 1) batch.push({ title: `课${i}`, date: '2026-10-12', type: 'event' });
  batch.push({ title: '', date: '2026-10-12' }); // 脏数据：没标题
  batch.push({ title: '脏日期', date: '下周' }); // 脏数据：日期非法

  const result = await tasksFn.handleAction(db, 'me', { action: 'bulk_add', tasks: batch });
  ok(result.ok === true, '批量导入成功');
  eq(result.inserted, 45, '45 条合法数据全部入库');
  eq(result.ids.length, 45, '返回 45 个 id');
  eq(result.skipped, 2, '2 条脏数据被跳过');
  eq(db.store.tasks.length, 45, '库里条数正确');
  ok(db.store.tasks.every((t) => t._openid === 'me'), '每条都带正确的 _openid');
  ok(result.errors.length === 2, '跳过原因有记录');

  const tooMany = await tasksFn.handleAction(db, 'me', { action: 'bulk_add', tasks: new Array(500).fill({ title: 'x' }) });
  ok(tooMany.ok === false, '超过 200 条直接拒绝');
});

testCaseAsync('7.5 stats / settings_get / settings_save', async () => {
  // 说明：stats 用的是"真实此刻"，所以这里刻意不写死 finished/pending 的期望值，
  //       只断言结构、口径关系与 5.3 已用注入时间核对过的算法。
  const db = createFakeDb({ tasks: statsFixtures.slice() });
  const stats = await tasksFn.handleAction(db, 'me', { action: 'stats' });
  ok(stats.ok === true, 'stats 成功');
  eq(stats.total, 8, '总数（不随时间变）');
  eq(stats.done, 1, '手动完成数（不随时间变）');
  eq(stats.ddl, 1, 'DDL 数（不随时间变）');
  ok(stats.finished >= 0 && stats.finished <= 8, 'finished 是合理值');
  eq(stats.pending, stats.total - stats.done - stats.finished, 'pending = total - done - finished');
  ok(/^\d{4}-\d{2}-\d{2}$/.test(stats.today), '返回今天的日期');

  const got = await tasksFn.handleAction(db, 'me', { action: 'settings_get' });
  eq(got.semester_start, '', '没设置过 → 空字符串');
  ok(got.period_times && got.period_times[1], '没设置过也能拿到默认作息');
  eq(db.store.settings.length, 0, '只是读取，不该写入任何记录');

  const saved = await tasksFn.handleAction(db, 'me', {
    action: 'settings_save',
    settings: { semester_start: '2026-09-07', period_times: { 1: ['08:30', '09:15'] }, openid: 'hacker' },
  });
  ok(saved.ok === true, '保存成功');
  eq(saved.semester_start, '2026-09-07', '开学日已保存');
  eq(db.store.settings.length, 1, 'settings 只落一条（首次保存自动创建）');
  eq(db.store.settings[0]._openid, 'me', 'settings 带 _openid');
  ok(db.store.settings[0].openid === undefined, 'settings 里不该出现前端传的 openid');

  // 保存过设置之后，stats 才可能有"已结课"（没有 semester_start 就算不出周次）
  const statsAfter = await tasksFn.handleAction(db, 'me', { action: 'stats' });
  eq(statsAfter.semester_start, '2026-09-07', 'stats 能读到刚保存的开学日');
  ok(statsAfter.finished >= 2, `2026-09-07 开学时 c2/c4 一定已结课（实际 finished=${statsAfter.finished}）`);

  const again = await tasksFn.handleAction(db, 'me', { action: 'settings_save', settings: { semester_start: '2026-09-14' } });
  eq(again.ok, true, '重复保存成功（update-and-set）');
  eq(db.store.settings.length, 1, '重复保存不新增记录（set 语义）');
  eq(db.store.settings[0].semester_start, '2026-09-14', '值被更新');
  eq(db.store.settings[0].period_times[1], ['08:30', '09:15'], 'partial 保存不会清掉没提到的键');

  const badSave = await tasksFn.handleAction(db, 'me', { action: 'settings_save', settings: { openid: 'hacker' } });
  ok(badSave.ok === false, '只传身份字段 → 拒绝');
});

testCaseAsync('7.7 有校验错误的 task 一律不写库（normalizeTask 会给出 task，但这里必须拦住）', async () => {
  const db = createFakeDb({ tasks: [] });

  // normalizeTask 现在即使有错也会返回 task（便于前端回填/提示）；
  // 但云函数必须只看 errors —— 否则空标题、非法日期就会进库。
  const blankTitle = await tasksFn.handleAction(db, 'me', {
    action: 'add', task: { title: '   ', date: '2026-10-11' },
  });
  ok(blankTitle.ok === false, '空标题被拒');
  ok(blankTitle.error.indexOf('title') !== -1, '错误信息点名 title');

  const badDate = await tasksFn.handleAction(db, 'me', {
    action: 'add', task: { title: '开会', date: '明天' },
  });
  ok(badDate.ok === false, '非法日期被拒');

  const badTime = await tasksFn.handleAction(db, 'me', {
    action: 'add', task: { title: '开会', date: '2026-10-11', start_time: '25:00' },
  });
  ok(badTime.ok === false, '非法时间被拒');

  const badBulk = await tasksFn.handleAction(db, 'me', {
    action: 'bulk_add',
    tasks: [
      { title: '合法', date: '2026-10-11' },
      { title: '', date: '2026-10-11' },          // 空标题
      { title: '非法日期', date: '下周' },          // 非法日期
      { title: '非法时间', date: '2026-10-11', end_time: '99:99' },
    ],
  });
  eq(badBulk.inserted, 1, '批量导入只入库 1 条合法数据');
  eq(badBulk.skipped, 3, '3 条有错误的被跳过');
  eq(db.store.tasks.length, 1, '库里只有 1 条（脏数据一条都没进去）');
  eq(db.store.tasks[0].title, '合法', '进去的正是那条合法的');
});

testCaseAsync('7.6 未知 action / 缺身份 / 缺数据库都给友好错误', async () => {
  const db = createFakeDb({ tasks: [] });
  const unknown = await tasksFn.handleAction(db, 'me', { action: 'drop_table' });
  ok(unknown.ok === false && unknown.error.indexOf('未知 action') !== -1, '未知 action 被拒绝');
  const noId = await tasksFn.handleAction(db, 'me', {});
  ok(noId.ok === false, '缺 action 被拒绝');
  const noUser = await tasksFn.handleAction(db, '', { action: 'list' });
  ok(noUser.ok === false && noUser.error.indexOf('身份') !== -1, '没有 openid 时拒绝服务');
  const noDb = await tasksFn.handleAction(null, 'me', { action: 'list' });
  ok(noDb.ok === false, '数据库不可用时给友好错误');
  // 云函数在没有云环境时调用 main，也应当是 {ok:false} 而不是抛异常
  const mainResult = await tasksFn.main({ action: 'list' });
  ok(mainResult.ok === false, '无云环境下 main 返回 ok:false');
});

// ===========================================================================
// 7b. ai_config_get / ai_config_save / ai_config_clear（用户自填 Key）
// ===========================================================================
testCaseAsync('7b.1 ai_config_save 成功路径 → 真实返回（只回掩码，绝不回原文）', async () => {
  const db = createFakeDb({ tasks: [] });
  const SECRET = 'sk-USER-SECRET-VALUE-9f8e';

  const saved = await tasksFn.handleAction(db, 'me', {
    action: 'ai_config_save',
    provider: 'zhipu',
    api_key: SECRET,
    model: 'glm-4.7-flash',
  });

  // 1) 成功，且返回形状是**平铺**的（与 list / settings_get 一致，不套 data）
  eq(saved.ok, true, 'ai_config_save 成功');
  eq(Object.keys(saved).sort(), ['hasKey', 'masked', 'model', 'ok', 'provider', 'updated_at'],
    '返回字段平铺：ok/provider/model/hasKey/masked/updated_at（**没有 data 包装**）');
  eq(saved.data, undefined, '明确断言：不带 data 包装');

  // 2) 只给掩码
  eq(saved.hasKey, true, 'hasKey=true');
  eq(saved.masked, '****9f8e', '掩码是末 4 位');
  eq(saved.provider, 'zhipu', 'provider 回显');
  eq(saved.model, 'glm-4.7-flash', 'model 回显');

  // 3) 整个返回对象里搜不到 Key 原文
  ok(JSON.stringify(saved).indexOf(SECRET) === -1, '返回体里没有 Key 原文');
  ok(JSON.stringify(saved).indexOf('sk-') === -1, '返回体里连前缀都没有');

  // 4) 真的落库了，而且挂在正确的 _openid 下
  eq(db.store.settings.length, 1, 'settings 落了一条');
  eq(db.store.settings[0]._openid, 'me', '记录归属正确');
  eq(db.store.settings[0].ai_api_key, SECRET, '库里存的是原文（集合权限仅创建者可读写）');
  eq(db.store.settings[0].ai_provider, 'zhipu', 'provider 落库');
  eq(db.store.settings[0].ai_model, 'glm-4.7-flash', 'model 落库');
  ok(!!db.store.settings[0].ai_updated_at, '记了 ai_updated_at');
});

testCaseAsync('7b.2 ai_config_get 不回传原文；clear 后 hasKey=false', async () => {
  const db = createFakeDb({ tasks: [] });
  const SECRET = 'sk-ANOTHER-SECRET-4321';

  await tasksFn.handleAction(db, 'me', { action: 'ai_config_save', provider: 'deepseek', api_key: SECRET });

  const got = await tasksFn.handleAction(db, 'me', { action: 'ai_config_get' });
  eq(got.ok, true, 'ai_config_get 成功');
  eq(got.hasKey, true, 'hasKey=true');
  eq(got.masked, '****4321', '掩码正确');
  eq(got.provider, 'deepseek', 'provider 正确');
  ok(JSON.stringify(got).indexOf(SECRET) === -1, 'get 不回传原文');
  eq(got.data, undefined, 'get 也不套 data 包装');
  eq(got.ai_api_key, undefined, '顶层没有 ai_api_key 字段');

  // 别人读不到我的配置（_openid 条件）
  const other = await tasksFn.handleAction(db, 'someone-else', { action: 'ai_config_get' });
  eq(other.hasKey, false, '别人读不到我的 Key');
  eq(other.masked, '', '别人拿到的掩码是空的');

  // 清除：provider / model / key 一起清掉
  const cleared = await tasksFn.handleAction(db, 'me', { action: 'ai_config_clear' });
  eq(cleared.ok, true, 'clear 成功');
  eq(cleared.provider, '', 'clear 后 provider 清空');
  eq(cleared.model, '', 'clear 后 model 清空');
  eq(cleared.hasKey, false, 'clear 后 hasKey=false');
  eq(cleared.masked, '', 'clear 后 masked 为空');
  eq(db.store.settings[0].ai_api_key, '', '库里的 Key 被清空');
  eq(db.store.settings.length, 1, 'clear 不新增记录，只改这一条');

  const afterClear = await tasksFn.handleAction(db, 'me', { action: 'ai_config_get' });
  eq(afterClear.hasKey, false, 'clear 之后 hasKey=false');

  // 空 Key 保存 == 清除
  await tasksFn.handleAction(db, 'me', { action: 'ai_config_save', api_key: SECRET });
  const clearedByEmpty = await tasksFn.handleAction(db, 'me', {
    action: 'ai_config_save', provider: 'zhipu', api_key: '   ',
  });
  eq(clearedByEmpty.hasKey, false, '传空白 api_key 等于清除');
  eq(db.store.settings[0].ai_api_key, '', '库里确实清空了');
});

testCaseAsync('7b.3 provider 白名单：非法值被拒绝（不静默走默认）', async () => {
  const db = createFakeDb({ tasks: [] });

  const bad = await tasksFn.handleAction(db, 'me', {
    action: 'ai_config_save', provider: 'openai', api_key: 'sk-abcdefgh',
  });
  ok(bad.ok === false, '非法 provider 被拒绝');
  ok(bad.error.indexOf('provider') !== -1, '错误信息点名 provider');
  ok(bad.error.indexOf('zhipu') !== -1, '错误信息列出允许的值');
  eq(db.store.settings.length, 0, '被拒绝时什么都没写库');

  // 大小写容错，但仍必须在白名单内
  const okUpper = await tasksFn.handleAction(db, 'me', {
    action: 'ai_config_save', provider: '  ZHIPU ', api_key: 'sk-abcdefgh',
  });
  eq(okUpper.ok, true, '大小写/空白容错后合法');
  eq(okUpper.provider, 'zhipu', '归一成小写');

  // 长度/字符校验
  const tooShort = await tasksFn.handleAction(db, 'me', {
    action: 'ai_config_save', provider: 'zhipu', api_key: 'sk-1',
  });
  ok(tooShort.ok === false && tooShort.error.indexOf('太短') !== -1, '过短的 Key 被拒绝');

  const withSpace = await tasksFn.handleAction(db, 'me', {
    action: 'ai_config_save', provider: 'zhipu', api_key: 'sk-abc def gh',
  });
  ok(withSpace.ok === false && withSpace.error.indexOf('空格') !== -1, '含空格的 Key 被拒绝');

  const badModel = await tasksFn.handleAction(db, 'me', {
    action: 'ai_config_save', provider: 'zhipu', api_key: 'sk-abcdefgh', model: 'bad model!',
  });
  ok(badModel.ok === false, '非法 model 被拒绝');
});

testCaseAsync('7b.4 Key 原文不会出现在任何 action 的返回里（全量扫描）', async () => {
  const db = createFakeDb({ tasks: [] });
  const SECRET = 'sk-CANARY-STRING-0001';

  const responses = [];
  responses.push(await tasksFn.handleAction(db, 'me', {
    action: 'ai_config_save', provider: 'zhipu', api_key: SECRET, model: 'glm-4.7-flash',
  }));
  responses.push(await tasksFn.handleAction(db, 'me', { action: 'ai_config_get' }));
  responses.push(await tasksFn.handleAction(db, 'me', { action: 'settings_get' }));
  responses.push(await tasksFn.handleAction(db, 'me', { action: 'list' }));
  responses.push(await tasksFn.handleAction(db, 'me', { action: 'stats' }));
  responses.push(await tasksFn.handleAction(db, 'me', { action: 'settings_save', settings: { semester_start: '2026-09-07' } }));
  responses.push(await tasksFn.handleAction(db, 'me', { action: 'ai_config_clear' }));

  const dump = JSON.stringify(responses);
  ok(dump.indexOf(SECRET) === -1, '所有 action 的返回拼起来也搜不到 Key 原文');
  ok(dump.indexOf('CANARY') === -1, '连 Key 里的一段都没有');
  // 掩码本身是可以出现的，但要确认它不是原文
  ok(dump.indexOf('****0001') !== -1, '掩码出现在 save/get 的返回里（这是预期）');

  // settings_save 也不能把 AI 配置带出去（它只回 semester_start / period_times）
  const settingsSave = responses[5];
  ok(settingsSave.data === undefined, 'settings_save 沿用原契约（字段平铺，没有 data 包装）');
  ok(JSON.stringify(settingsSave).indexOf('ai_api_key') === -1, 'settings_save 不回传 ai_api_key 字段名');
});

testCaseAsync('7b.5 未知 action 列表里已包含新的三个 action', async () => {
  const db = createFakeDb({ tasks: [] });
  const unknown = await tasksFn.handleAction(db, 'me', { action: 'nope' });
  ['ai_config_get', 'ai_config_save', 'ai_config_clear'].forEach((name) => {
    ok(unknown.error.indexOf(name) !== -1, `错误提示里列出了 ${name}`);
  });
});

// ===========================================================================
// 8. aiParse：脏 JSON 容错解析
// ===========================================================================
const CLEAN_JSON = '{"events":[{"title":"开组会","date":"2026-10-12","start_time":"15:00","end_time":"","type":"日程","priority":"中"}],"deadlines":[],"needs_clarification":false,"clarification_question":""}';

testCase('8.1 extractJsonObject：干净 JSON 与代码块包裹', () => {
  eq(aiParse.extractJsonObject(CLEAN_JSON).events[0].title, '开组会', '干净 JSON 直接解析');
  eq(aiParse.extractJsonObject('```json\n' + CLEAN_JSON + '\n```').events[0].title, '开组会', '剥掉 ```json 围栏');
  eq(aiParse.extractJsonObject('```\n' + CLEAN_JSON + '\n```').events[0].title, '开组会', '剥掉 ``` 围栏');
  eq(aiParse.extractJsonObject('```JSON\n' + CLEAN_JSON + '```').events[0].title, '开组会', '大写 JSON 围栏也能剥（正则带 i 标志）');
});

testCase('8.2 extractJsonObject：前后有解释文字 / 尾逗号 / 中文引号', () => {
  const withProse = `好的，我解析出来了：\n${CLEAN_JSON}\n还需要我做什么吗？`;
  eq(aiParse.extractJsonObject(withProse).events[0].title, '开组会', '截取第一个 { 到最后一个 }');

  const trailing = '{"events":[{"title":"开会","date":"2026-10-12","start_time":"15:00","end_time":"","type":"日程","priority":"中"},],"deadlines":[],"needs_clarification":false,}';
  eq(aiParse.extractJsonObject(trailing).events[0].title, '开会', '去掉多余尾逗号');

  const zhQuote = '{"events":[{"title":"开组会","date":"2026-10-12","start_time":"15:00",“end_time”:"","type":"日程","priority":"中"}],"deadlines":[],"needs_clarification":false,"clarification_question":""}';
  eq(aiParse.extractJsonObject(zhQuote).events[0].title, '开组会', '中文全角引号修复');
});

testCase('8.2b extractJsonObject：全角冒号 / 全角逗号（中文输入法的真实产物）', () => {
  // 模型用中文输入法时，键值分隔的冒号常常是全角 U+FF1A，逗号是 U+FF0C。
  // 它们在 JSON 里不是合法结构符号，必须转成半角才解得出来。
  const fullWidthColon = '好的，结果如下：{“events”：[{"title":"开会","date":"2026-09-08","start_time":"15:00","end_time":"","type":"日程","priority":"中"}],}';
  const parsed = aiParse.extractJsonObject(fullWidthColon);
  ok(parsed !== null, '全角冒号 + 中文引号 + 尾逗号 + 多余文字 → 能解出来');
  if (parsed) {
    eq(parsed.events.length, 1, '解出 1 条日程');
    eq(parsed.events[0].title, '开会', '标题正确');
    eq(parsed.events[0].date, '2026-09-08', '日期正确');
  }

  // aiDecompose 用同一套容错
  const decomposeMessy = '{"subtasks"：[{"title"："查文献"，"suggested_date"："2026-10-12"，"estimate_min"：60}]}';
  const decomposeParsed = aiDecompose.extractJsonObject(decomposeMessy);
  ok(decomposeParsed !== null, 'aiDecompose 也能解全角标点');
  if (decomposeParsed) eq(decomposeParsed.subtasks[0].estimate_min, 60, 'estimate_min 正确解出');

  // 关键：字符串**里面**的全角逗号是正文，必须原样保留，不能被换成半角
  const chineseText = '{"events":[{"title":"开会，讨论方案A与B","date":"2026-10-12"}],"deadlines":[]}';
  eq(aiParse.extractJsonObject(chineseText).events[0].title, '开会，讨论方案A与B',
    '标题里的全角逗号属于正文，原样保留');

  // 顺带确认两种修复可以叠加：全角 + 尾逗号 + 代码块围栏
  const combined = '```json\n{“subtasks”：[{"title"："查文献"，"estimate_min"：60}],}\n```';
  ok(aiDecompose.extractJsonObject(combined) !== null, '围栏 + 全角 + 尾逗号 三重叠加也能解');
});

testCase('8.3 extractJsonObject：模型返回数组 / 彻底解析失败', () => {
  const wrapped = `[${CLEAN_JSON}]`;
  eq(aiParse.extractJsonObject(wrapped).events[0].title, '开组会', '返回数组时取第一个对象');
  eq(aiParse.extractJsonObject('这不是 JSON，模型在胡说八道'), null, '完全不是 JSON → null');
  eq(aiParse.extractJsonObject(''), null, '空内容 → null');
  eq(aiParse.extractJsonObject(null), null, 'null → null');
  eq(aiParse.extractJsonObject(undefined), null, 'undefined → null');
  eq(aiParse.extractJsonObject(12345), null, '非字符串 → null');
});

testCase('8.4 normalizeParseResult：字段补全与脏类型清洗', () => {
  const messy = aiParse.normalizeParseResult({
    events: [
      { title: '  开组会  ', date: '2026-10-12', start_time: '15:00' },
      '这明显不是对象',
      { date: '2026-10-12' }, // 没标题 → 后面会被丢弃
      42,
    ],
    deadlines: [{ title: '交报告', date: '2026-10-16', start_time: '12:00' }], // 模型把时刻写进了 start_time
    needs_clarification: 'true',
    clarification_question: '  几点开始？  ',
  });
  // 注意：normalizeParseResult 只丢掉「不是对象」的条目（字符串 / 数字 / null），
  // 不负责过滤空标题 —— 那是 toTaskList / to_local_tasks 的活儿（见 8.5）
  eq(messy.events.length, 2, '非对象条目被丢掉，其余补齐');
  eq(messy.events[0].title, '开组会', '标题去空白');
  eq(messy.events[0].type, '日程', 'events 的类型默认「日程」');
  eq(messy.events[0].priority, '中', 'events 的优先级默认「中」');
  eq(messy.events[0].end_time, '', '缺失的时间补空串');
  eq(messy.events[1].title, '', '缺标题的条目仍会补齐成空串（留给 toTaskList 过滤）');
  eq(messy.deadlines.length, 1, 'deadlines 保留一条');
  eq(messy.deadlines[0].start_time, '', 'DDL 没有开始时间');
  eq(messy.deadlines[0].end_time, '12:00', '模型写在 start_time 的截止时刻被救回来');
  eq(messy.deadlines[0].priority, '高', 'DL 默认高优先级');
  eq(messy.needs_clarification, false, '字符串 true 不是真布尔 → 按 false 处理（与 Python 版一致）');
  eq(messy.clarification_question, '几点开始？', '追问去空白');

  const broken = aiParse.normalizeParseResult(null);
  eq(broken, { events: [], deadlines: [], needs_clarification: false, clarification_question: '' }, 'null 输入给默认结构');
  eq(aiParse.normalizeParseResult({ events: 'not-an-array' }).events, [], 'events 不是数组时归空');
});

testCase('8.5 toTaskList：AI 结果 → tasks 集合字段', () => {
  const parsed = aiParse.normalizeParseResult(JSON.parse(CLEAN_JSON));
  const rows = aiParse.toTaskList(parsed, 'parent-1');
  eq(rows.length, 1, '一条日程');
  eq(rows[0].type, 'event', '「日程」→ event');
  eq(rows[0].priority, 'mid', '「中」→ mid');
  eq(rows[0].date, '2026-10-12', '日期透传');
  eq(rows[0].parent_id, 'parent-1', 'parent_id 透传');
  eq(rows[0].done, false, '默认未完成');
  eq(rows[0].repeat, 'none', '默认不重复');
  eq(rows[0].title, '开组会', '标题透传');

  const withDeadline = aiParse.toTaskList(aiParse.normalizeParseResult({
    deadlines: [{ title: '交实验报告', date: '2026-10-16', end_time: '12:00', priority: '高' }],
  }));
  eq(withDeadline[0].type, 'ddl', 'DDL 类型');
  eq(withDeadline[0].priority, 'high', '「高」→ high');
  eq(withDeadline[0].start_time, '', 'DDL 无开始时间');
  eq(withDeadline[0].end_time, '12:00', '截止时刻保留');

  const dirty = aiParse.toTaskList({
    events: [{ title: '', date: '2026-10-12' }, { title: '有标题没日期', date: '' }],
    deadlines: [],
  });
  eq(dirty, [], '没标题 / 没日期的脏条目被过滤（与 to_local_tasks 一致）');
  eq(aiParse.toTaskList(null), [], 'null → 空数组');
});

testCase('8.6 buildPrompt：日期参考表与关键规则都在', () => {
  const today = '2026-10-11'; // 周日
  const reference = aiParse.buildDateReference(today);
  ok(reference.indexOf('- 今天：2026-10-11（周日）') !== -1, '参考表含今天与星期');
  ok(reference.indexOf('- 明天：2026-10-12') !== -1, '参考表含明天');
  ok(reference.indexOf('- 后天：2026-10-13') !== -1, '参考表含后天');
  ok(reference.indexOf('- 大后天：2026-10-14') !== -1, '参考表含大后天');
  ok(reference.indexOf('- 本周一：2026-10-05') !== -1, '本周一按周一算');
  ok(reference.indexOf('- 本周日：2026-10-11') !== -1, '本周日正确');
  ok(reference.indexOf('- 下周一：2026-10-12') !== -1, '下周一正确');
  ok(reference.indexOf('- 下周日：2026-10-18') !== -1, '下周日正确');

  const prompt = aiParse.buildSystemPrompt(today);
  ok(prompt.indexOf('只给了日期没给时间') !== -1, '包含「不乱猜时间」规则');
  ok(prompt.indexOf('不要瞎猜一个时间') !== -1, '包含「不乱猜时间」措辞');
  ok(prompt.indexOf(today) !== -1, '提示词含今天日期');
  // few-shot 示例里的相对日期也必须算成绝对日期
  const tomorrow = aiParse.addDays(today, 1);
  ok(prompt.indexOf(tomorrow) !== -1, '示例里的「明天」已换算成绝对日期');
  ok(prompt.indexOf('needs_clarification') !== -1, '要求模型输出的字段齐全');
  ok(prompt.indexOf('deadlines') !== -1, '包含 deadlines 结构');
});

testCase('8.7 参数与错误：超时设置 / 契约文案 / 输入上限', () => {
  eq(aiParse.TIMEOUT_MS, 15000, '超时 15 秒');
  eq(aiParse.ERROR_MESSAGE, 'AI 服务暂不可用', '统一失败文案');
  eq(aiParse.MAX_TEXT_LENGTH, 500, '输入长度上限');
  eq(aiParse.DEFAULT_PROVIDER, 'zhipu', '默认推荐服务商是智谱');
});

// ===========================================================================
// 8b. 服务商解析（智谱为主、DeepSeek 备选；谁配了 Key 用谁）
// ===========================================================================
/** 造一个"干净"的环境变量表：显式清空两个 Key，避免受本机真实环境变量影响 */
function envOf(overrides) {
  const base = {
    ZHIPU_API_KEY: '', DEEPSEEK_API_KEY: '', LLM_PROVIDER: '', LLM_MODEL: '',
  };
  const merged = Object.assign(base, overrides || {});
  // 空字符串对"未配置"的判断等价于 undefined，这里统一成 undefined 更贴近真实情况
  Object.keys(merged).forEach((key) => {
    if (merged[key] === '') delete merged[key];
  });
  return merged;
}

testCase('8b.1 服务商表：两家都在，默认模型名正确', () => {
  const names = aiParse.providerNames().sort();
  eq(names, ['deepseek', 'zhipu'], 'aiParse 支持两家');
  eq(aiDecompose.providerNames().sort(), ['deepseek', 'zhipu'], 'aiDecompose 也支持两家（两个函数都要读环境变量）');

  eq(aiParse.PROVIDERS.zhipu.defaultModel, 'glm-4.7-flash', '智谱默认模型');
  eq(aiParse.PROVIDERS.zhipu.apiKeyEnv, 'ZHIPU_API_KEY', '智谱环境变量名');
  eq(aiParse.PROVIDERS.zhipu.baseUrl, 'https://open.bigmodel.cn/api/paas/v4', '智谱 base 地址');
  eq(aiParse.PROVIDERS.deepseek.defaultModel, 'deepseek-chat', 'DeepSeek 默认模型');
  eq(aiParse.PROVIDERS.deepseek.apiKeyEnv, 'DEEPSEEK_API_KEY', 'DeepSeek 环境变量名');
  eq(aiParse.PROVIDERS.deepseek.baseUrl, 'https://api.deepseek.com/v1', 'DeepSeek base 地址');

  // 两个云函数各自独立部署、不能互相 require，所以表是各存一份 —— 断言两边不许漂移
  eq(aiDecompose.PROVIDERS, aiParse.PROVIDERS, '两个文件的 PROVIDERS 表必须完全一致');
  eq(aiDecompose.ENV_PROVIDER, aiParse.ENV_PROVIDER, '环境变量名一致（LLM_PROVIDER）');
  eq(aiDecompose.ENV_MODEL, aiParse.ENV_MODEL, '环境变量名一致（LLM_MODEL）');
  eq(aiParse.ENV_PROVIDER, 'LLM_PROVIDER', '指定服务商的环境变量名');
  eq(aiParse.ENV_MODEL, 'LLM_MODEL', '覆盖模型名的环境变量名');

  eq(aiParse.chatEndpoint(aiParse.PROVIDERS.zhipu), 'https://open.bigmodel.cn/api/paas/v4/chat/completions', '智谱端点');
  eq(aiParse.chatEndpoint(aiParse.PROVIDERS.deepseek), 'https://api.deepseek.com/v1/chat/completions', 'DeepSeek 端点');
  // base 末尾多写 / 也要能容错
  eq(aiParse.chatEndpoint({ baseUrl: 'https://x.example.com/v4//' }), 'https://x.example.com/v4/chat/completions', 'base 末尾斜杠容错');
});

testCase('8b.2 未指定服务商时「谁配了 Key 用谁」', () => {
  // 两个都没配 → 失败
  const none = aiParse.resolveProviderConfig(envOf());
  eq(none.ok, false, '两家都没配 Key → 不可用');
  eq(none.provider, null, '没有选中的服务商');
  ok(none.reason.indexOf('ZHIPU_API_KEY') !== -1 && none.reason.indexOf('DEEPSEEK_API_KEY') !== -1,
    '报错要同时点出两个环境变量名');

  // 只有 DeepSeek 有 Key → 必须用 DeepSeek（关键回归点：老用户不能因为换服务商而不可用）
  const onlyDeepseek = aiParse.resolveProviderConfig(envOf({ DEEPSEEK_API_KEY: 'sk-test-deepseek' }));
  eq(onlyDeepseek.ok, true, '只有 DeepSeek Key → 可用');
  eq(onlyDeepseek.provider.name, 'deepseek', '选中 DeepSeek');
  eq(onlyDeepseek.model, 'deepseek-chat', '用 DeepSeek 默认模型');

  // 只有智谱有 Key → 用智谱
  const onlyZhipu = aiParse.resolveProviderConfig(envOf({ ZHIPU_API_KEY: 'test-zhipu-key' }));
  eq(onlyZhipu.ok, true, '只有智谱 Key → 可用');
  eq(onlyZhipu.provider.name, 'zhipu', '选中智谱');
  eq(onlyZhipu.model, 'glm-4.7-flash', '用智谱默认模型');

  // 两家都有 → 推荐位 zhipu，并在 notices 里说明
  const both = aiParse.resolveProviderConfig(envOf({ ZHIPU_API_KEY: 'a', DEEPSEEK_API_KEY: 'b' }));
  eq(both.provider.name, 'zhipu', '两家都有 Key → 默认智谱');
  ok(both.notices.join().indexOf('多个服务商') !== -1, '两家都有 Key 时要有提示');

  // 空白字符串的 Key 等于没配
  const blank = aiParse.resolveProviderConfig(envOf({ ZHIPU_API_KEY: '   ' }));
  eq(blank.ok, false, 'Key 只有空格 → 视为没配');
});

testCase('8b.3 LLM_PROVIDER 显式指定', () => {
  // 指定 + 有 Key
  const zhipu = aiParse.resolveProviderConfig(envOf({ LLM_PROVIDER: 'zhipu', ZHIPU_API_KEY: 'k' }));
  eq(zhipu.ok, true, '指定智谱且有 Key');
  eq(zhipu.provider.name, 'zhipu', '选中智谱');

  const deepseek = aiParse.resolveProviderConfig(envOf({ LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'k' }));
  eq(deepseek.ok, true, '指定 DeepSeek 且有 Key');
  eq(deepseek.provider.name, 'deepseek', '选中 DeepSeek');

  // 大小写与空白容错
  const upper = aiParse.resolveProviderConfig(envOf({ LLM_PROVIDER: '  ZHIPU  ', ZHIPU_API_KEY: 'k' }));
  eq(upper.provider.name, 'zhipu', '服务商名大小写/空白容错');

  // 指定了一家但它没配 Key：不偷偷换一家，如实报错
  const specifiedNoKey = aiParse.resolveProviderConfig(envOf({ LLM_PROVIDER: 'zhipu', DEEPSEEK_API_KEY: 'k' }));
  eq(specifiedNoKey.ok, false, '指定智谱但只有 DeepSeek Key → 不可用（不静默换）');
  eq(specifiedNoKey.provider.name, 'zhipu', '仍如实指向用户指定的那家');
  ok(specifiedNoKey.reason.indexOf('ZHIPU_API_KEY') !== -1, '报错点名缺哪个环境变量');

  // 指定了不认识的名字：不静默走默认，给提示后退回自动挑选
  const unknown = aiParse.resolveProviderConfig(envOf({ LLM_PROVIDER: 'openai', DEEPSEEK_API_KEY: 'k' }));
  eq(unknown.ok, true, '服务商名不认识 → 退回自动挑选');
  eq(unknown.provider.name, 'deepseek', '自动挑到唯一配了 Key 的 deepseek');
  ok(unknown.notices.join().indexOf('不是支持的服务商') !== -1, '日志里要说清楚名字不认识');
  ok(unknown.notices.join().indexOf('deepseek') !== -1, '提示里要列出支持的服务商');

  const unknownNoFallback = aiParse.resolveProviderConfig(envOf({ LLM_PROVIDER: 'openai' }));
  eq(unknownNoFallback.ok, false, '名字不认识且没有可用 Key → 不可用');
});

testCase('8b.4 LLM_MODEL 覆盖模型名', () => {
  eq(aiParse.resolveProviderConfig(envOf({ ZHIPU_API_KEY: 'k', LLM_MODEL: 'glm-4.5-flash' })).model,
    'glm-4.5-flash', '覆盖智谱默认模型');
  eq(aiParse.resolveProviderConfig(envOf({ DEEPSEEK_API_KEY: 'k', LLM_MODEL: 'deepseek-reasoner' })).model,
    'deepseek-reasoner', '覆盖 DeepSeek 默认模型');
  eq(aiParse.resolveProviderConfig(envOf({ LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'k', LLM_MODEL: 'x' })).model,
    'x', '显式指定服务商时也能覆盖');
  eq(aiParse.resolveProviderConfig(envOf({ LLM_PROVIDER: 'zhipu', LLM_MODEL: 'y' })).model,
    'y', '即使 Key 没配，模型名也如实解析出来（便于日志定位）');
  // 空字符串不算覆盖
  eq(aiParse.resolveProviderConfig(envOf({ ZHIPU_API_KEY: 'k', LLM_MODEL: '   ' })).model,
    'glm-4.7-flash', '空白模型名不算覆盖');
});

testCase('8b.5 hasApiKey = 「至少一家可用」，且不泄漏 Key', () => {
  const saved = { Z: process.env.ZHIPU_API_KEY, D: process.env.DEEPSEEK_API_KEY };
  try {
    delete process.env.ZHIPU_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    eq(aiParse.hasApiKey(), false, '都没配 → false');
    process.env.ZHIPU_API_KEY = 'k';
    eq(aiParse.hasApiKey(), true, '配了智谱 → true');
    delete process.env.ZHIPU_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'k';
    eq(aiParse.hasApiKey(), true, '只有 DeepSeek 也 → true（兼容老用户）');
  } finally {
    if (saved.Z === undefined) delete process.env.ZHIPU_API_KEY; else process.env.ZHIPU_API_KEY = saved.Z;
    if (saved.D === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = saved.D;
  }

  // 解析结果里只允许出现"环境变量名"，绝不能出现 Key 的值
  const parsed = aiParse.resolveProviderConfig(envOf({ ZHIPU_API_KEY: 'SECRET-SHOULD-NOT-LEAK' }));
  const dump = JSON.stringify(parsed) + JSON.stringify(parsed.provider);
  ok(dump.indexOf('SECRET-SHOULD-NOT-LEAK') === -1, '解析结果里不能带 Key 的值');
  ok(dump.indexOf('ZHIPU_API_KEY') !== -1, '只出现环境变量名');
});

testCase('8b.6 错误码语义：智谱业务码 vs DeepSeek 标准 HTTP', () => {
  const zhipu = aiParse.PROVIDERS.zhipu;
  const deepseek = aiParse.PROVIDERS.deepseek;

  // 智谱：认证失败（1000/1001/1003）
  ok(aiParse.classifyHttpError(zhipu, 401, '{"error":{"code":"1000","message":"身份验证失败"}}', 'glm-4.7-flash')
    .indexOf('认证失败') !== -1, '智谱 1000 → 认证失败');
  ok(aiParse.classifyHttpError(zhipu, 401, '{"error":{"code":"1003","message":"Authentication Token 已过期"}}', 'm')
    .indexOf('认证失败') !== -1, '智谱 1003 → 认证失败');

  // 智谱：额度/限流（1113 欠费 / 1302 限流 / 1305 访问量过大 / 1308 超上限）
  ['1113', '1302', '1305', '1308'].forEach((code) => {
    const text = aiParse.classifyHttpError(zhipu, 429, `{"error":{"code":"${code}","message":"x"}}`, 'm');
    ok(text.indexOf('额度/频率受限') !== -1, `智谱 ${code} → 额度/频率受限`);
  });

  // 智谱：模型不存在是 **400 + 业务码 1211**（不是 HTTP 404，这是与 DeepSeek 最大的差异）
  const modelMissing = aiParse.classifyHttpError(zhipu, 400, '{"error":{"code":"1211","message":"模型不存在，请检查模型代码"}}', 'glm-4.7-flash');
  ok(modelMissing.indexOf('模型不存在') !== -1, '智谱 1211 → 模型不存在');
  ok(modelMissing.indexOf('glm-4.7-flash') !== -1, '日志里带上当前模型名，便于定位');
  ok(modelMissing.indexOf('LLM_MODEL') !== -1, '提示可以用 LLM_MODEL 覆盖');

  // 智谱：参数有误（1210/1213/1214）不能和"模型不存在"混为一谈
  ok(aiParse.classifyHttpError(zhipu, 400, '{"error":{"code":"1210","message":"API 调用参数有误"}}', 'm')
    .indexOf('请求参数有误') !== -1, '智谱 1210 → 参数有误');

  // 智谱：业务码缺失时退回 HTTP 语义
  ok(aiParse.classifyHttpError(zhipu, 401, 'no json here', 'm').indexOf('认证失败') !== -1, '智谱无业务码时按 HTTP 401 判定');
  ok(aiParse.classifyHttpError(zhipu, 500, 'oops', 'm').indexOf('服务商内部错误') !== -1, '智谱 5xx → 服务端错误');

  // DeepSeek：没有业务码，靠 HTTP 状态
  ok(aiParse.classifyHttpError(deepseek, 401, '{"error":{"message":"Authentication Fails"}}', 'deepseek-chat')
    .indexOf('认证失败') !== -1, 'DeepSeek 401 → 认证失败');
  ok(aiParse.classifyHttpError(deepseek, 429, '', 'deepseek-chat').indexOf('额度不足') !== -1, 'DeepSeek 429 → 频率/额度');
  ok(aiParse.classifyHttpError(deepseek, 400, '{"error":{"message":"Model Not Exist"}}', 'deepseek-chat')
    .indexOf('模型不存在') !== -1, 'DeepSeek 400 模型不存在');
  ok(aiParse.classifyHttpError(deepseek, 404, '', 'deepseek-chat').indexOf('模型不存在') !== -1, 'DeepSeek 404 → 模型/接口不存在');
  ok(aiParse.classifyHttpError(deepseek, 503, '', 'deepseek-chat').indexOf('服务商内部错误') !== -1, 'DeepSeek 5xx → 服务端错误');

  // 两家都必须把厂商原文包进日志文案，但对外文案恒为 ERROR_MESSAGE
  eq(aiParse.ERROR_MESSAGE, 'AI 服务暂不可用', '对外文案统一');
  eq(aiDecompose.ERROR_MESSAGE, 'AI 服务暂不可用', '两个函数对外文案一致');
});

testCaseAsync('8b.8 契约测试友好性：替换 exports.postJson 必须真的生效（禁止发真请求）', async () => {
  // 前端 utils/tests/ai_contract.js 靠替换 module.exports.postJson 来假装服务端响应，
  // 从而做到"零网络"跑通完整链路。如果内部直接调用本地 postJson、或整体替换了
  // module.exports，替换就会失效 → 测试会真的把请求发出去（既联网又必然失败）。
  // 这里把这个约定钉死：替换后必须被调用到，且 url/model 正确。
  const saved = process.env.ZHIPU_API_KEY;
  const realParsePost = aiParse.postJson;
  const realDecomposePost = aiDecompose.postJson;
  const seen = [];
  try {
    process.env.ZHIPU_API_KEY = 'test-key-not-used';
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_MODEL;

    const fakeContent = JSON.stringify({
      events: [{ title: '开组会', date: '2026-09-08', start_time: '15:00' }],
      deadlines: [], needs_clarification: false, clarification_question: '',
    });
    const fakeSubtask = JSON.stringify({
      task: 'x', deadline: '2026-12-31',
      subtasks: [{ title: '查文献', suggested_date: '2026-09-10', estimate_min: 120 }],
    });

    aiParse.postJson = (url, payload) => {
      seen.push({ fn: 'aiParse', url, model: payload.model });
      return Promise.resolve({ status: 200, text: JSON.stringify({ choices: [{ message: { content: fakeContent } }] }) });
    };
    aiDecompose.postJson = (url, payload) => {
      seen.push({ fn: 'aiDecompose', url, model: payload.model });
      return Promise.resolve({ status: 200, text: JSON.stringify({ choices: [{ message: { content: fakeSubtask } }] }) });
    };

    const parsed = await aiParse.main({ text: '明天下午三点开组会' });
    const decomposed = await aiDecompose.main({ title: '写毕业论文', deadline: '2026-12-31' });

    eq(seen.length, 2, '替换后的 postJson 各被调用一次（aiParse + aiDecompose）');
    eq(seen[0].fn, 'aiParse', 'aiParse 用的是被替换的那个');
    eq(seen[1].fn, 'aiDecompose', 'aiDecompose 用的是被替换的那个');
    eq(seen[0].model, 'glm-4.7-flash', '请求带上了正确的模型名');
    eq(seen[0].url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions', 'aiParse 打到智谱端点');
    eq(seen[1].url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions', 'aiDecompose 同样打到智谱端点');

    // 完整链路（解析 → 归一化）也要真的跑通，而且成功响应形状用智谱的 choices[0].message.content
    eq(parsed.ok, true, 'aiParse 成功路径走通');
    eq(parsed.events.length, 1, 'events 解析出来');
    eq(parsed.tasks.length, 1, 'tasks 也一并给出');
    eq(decomposed.ok, true, 'aiDecompose 成功路径走通');
    eq(decomposed.subtasks.length, 1, 'subtasks 解析出来');
    eq(decomposed.subtasks[0].estimate_min, 120, 'estimate_min 保留');
  } finally {
    aiParse.postJson = realParsePost;
    aiDecompose.postJson = realDecomposePost;
    if (saved === undefined) delete process.env.ZHIPU_API_KEY; else process.env.ZHIPU_API_KEY = saved;
  }
});

testCaseAsync('8b.9 智谱 400 + 业务码 1211（模型不存在）对外仍是统一文案', async () => {
  const saved = process.env.ZHIPU_API_KEY;
  const realPost = aiParse.postJson;
  try {
    process.env.ZHIPU_API_KEY = 'test-key-not-used';
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_MODEL;
    delete process.env.DEEPSEEK_API_KEY;

    // 第一次 400（模拟"模型名不对"）→ 实现会去掉 response_format 重试一次
    // → 第二次仍 400 → 最终对外统一文案
    const calls = [];
    aiParse.postJson = (url, payload) => {
      calls.push({ hasJsonMode: !!payload.response_format });
      return Promise.resolve({
        status: 400,
        text: '{"error":{"code":"1211","message":"模型不存在，请检查模型代码"}}',
      });
    };

    const result = await aiParse.main({ text: '明天三点开会' });
    eq(result.ok, false, '失败');
    eq(result.error, 'AI 服务暂不可用', '对外只给统一文案，不透传厂商报错');
    ok(JSON.stringify(result).indexOf('模型不存在') === -1, '厂商原文不能出现在返回体里');
    ok(JSON.stringify(result).indexOf('1211') === -1, '业务码也不能出现在返回体里');
    eq(calls.length, 2, '400 时去掉 response_format 重试了一次');
    eq(calls[0].hasJsonMode, true, '第一次请求带 response_format');
    eq(calls[1].hasJsonMode, false, '重试时不带 response_format');
  } finally {
    aiParse.postJson = realPost;
    if (saved === undefined) delete process.env.ZHIPU_API_KEY; else process.env.ZHIPU_API_KEY = saved;
  }
});

testCaseAsync('8b.7 chatCompletion：未配 Key 时不发请求，返回契约文案', async () => {
  // 注入"两个 Key 都没有"的环境变量；若实现有 bug 真的去联网，这里会因 DNS 失败而超时/抛错
  const result = await aiParse.chatCompletion(
    [{ role: 'user', content: 'hi' }], true, 0.2, envOf()
  );
  eq(result.content, null, '没有 content');
  eq(result.error, 'AI 服务暂不可用', '返回契约里的统一文案');
  ok(result.reason.indexOf('没有任何服务商配置了 API Key') !== -1, 'reason 里说明是没配 Key');

  // 指定了一家但没配 Key：同样不发请求
  const specified = await aiParse.chatCompletion(
    [{ role: 'user', content: 'hi' }], true, 0.2, envOf({ LLM_PROVIDER: 'zhipu' })
  );
  eq(specified.error, 'AI 服务暂不可用', '指定服务商但没 Key 也返回统一文案');
  ok(specified.reason.indexOf('ZHIPU_API_KEY') !== -1, 'reason 点名缺哪个环境变量');

  // aiDecompose 走同一条逻辑
  const decompose = await aiDecompose.chatCompletion(
    [{ role: 'user', content: 'hi' }], true, 0.3, envOf()
  );
  eq(decompose.error, 'AI 服务暂不可用', 'aiDecompose 同样返回统一文案');
});

// ===========================================================================
// 9. aiDecompose：子任务归一化
// ===========================================================================
testCase('9.1 normalizeSubtask：estimate_min 容错', () => {
  eq(aiDecompose.normalizeSubtask({ title: '查文献', estimate_min: 60 }).estimate_min, 60, '整数保留');
  eq(aiDecompose.normalizeSubtask({ title: 'a', estimate_min: '90' }).estimate_min, 90, '数字字符串');
  eq(aiDecompose.normalizeSubtask({ title: 'a', estimate_min: '60分钟' }).estimate_min, 60, '带单位字符串');
  eq(aiDecompose.normalizeSubtask({ title: 'a', estimate_min: -30 }).estimate_min, 0, '负数 → 0');
  eq(aiDecompose.normalizeSubtask({ title: 'a' }).estimate_min, 0, '缺失 → 0');
  eq(aiDecompose.normalizeSubtask({ title: 'a', estimate_min: null }).estimate_min, 0, 'null → 0');
  eq(aiDecompose.normalizeSubtask({ title: 'a', estimate_min: 'abc' }).estimate_min, 0, '垃圾字符串 → 0');
  eq(aiDecompose.normalizeSubtask({ title: 'a', estimate_min: 100000 }).estimate_min, 1440, '超上限收敛');
  eq(aiDecompose.normalizeSubtask({ title: '  写提纲  ', estimate_min: 30 }).title, '写提纲', '标题去空白');
  eq(aiDecompose.normalizeSubtask({ estimate_min: 30 }), null, '没标题 → null');
});

testCase('9.2 normalizeSubtask：suggested_date 必须落在 [今天, 截止日]', () => {
  const today = '2026-10-11';
  const deadline = '2026-10-20';
  eq(aiDecompose.normalizeSubtask({ title: 'a', suggested_date: '2026-10-15' }, today, deadline).suggested_date, '2026-10-15', '区间内保留');
  eq(aiDecompose.normalizeSubtask({ title: 'a', suggested_date: '2026-10-01' }, today, deadline).suggested_date, today, '早于今天 → 收到今天');
  eq(aiDecompose.normalizeSubtask({ title: 'a', suggested_date: '2026-11-01' }, today, deadline).suggested_date, deadline, '晚于截止 → 收到截止日');
  eq(aiDecompose.normalizeSubtask({ title: 'a', suggested_date: '下周' }, today, deadline).suggested_date, today, '日期非法 → 今天');
  eq(aiDecompose.normalizeSubtask({ title: 'a' }, today, deadline).suggested_date, today, '缺失 → 今天');
});

testCase('9.3 normalizeDecomposeResult：整体归一化', () => {
  const result = aiDecompose.normalizeDecomposeResult({
    subtasks: [
      { title: '查文献', suggested_date: '2026-10-12', estimate_min: 120 },
      { title: '', suggested_date: '2026-10-13', estimate_min: 60 }, // 没标题 → 丢
      { title: '写提纲', suggested_date: '2026-10-13', estimate_min: -5 },
      null,
      'not-an-object',
      { title: '定稿', suggested_date: '2026-12-31', estimate_min: '45' }, // 超截止 → 收到截止日
    ],
  }, '2026-10-11', '2026-10-20');
  eq(result.length, 3, '只保留合法子任务');
  eq(result.map((item) => item.title), ['查文献', '写提纲', '定稿'], '顺序与标题');
  eq(result[1].estimate_min, 0, '负数归 0');
  eq(result[2].suggested_date, '2026-10-20', '越界日期收敛到截止日');
  eq(result[2].estimate_min, 45, '字符串耗时转数字');
  eq(aiDecompose.normalizeDecomposeResult({ subtasks: 'nope' }, '2026-10-11', '2026-10-20'), [], 'subtasks 不是数组 → 空');
  eq(aiDecompose.normalizeDecomposeResult(null, '2026-10-11', '2026-10-20'), [], 'null → 空');
});

testCase('9.4 buildSystemPrompt：拆解规则与日期参考都在', () => {
  const prompt = aiDecompose.buildSystemPrompt('2026-10-11', '2026-10-20');
  ok(prompt.indexOf('3~8') !== -1 || prompt.indexOf('3-8') !== -1, '要求 3~8 步');
  ok(prompt.indexOf('动词开头') !== -1, '要求动词开头');
  ok(prompt.indexOf('15 的倍数') !== -1, '要求 estimate_min 是 15 的倍数');
  ok(prompt.indexOf('2026-10-11') !== -1 && prompt.indexOf('2026-10-20') !== -1, '含今天与截止日');
  ok(prompt.indexOf('estimate_min') !== -1, '含字段名');

  eq(aiDecompose.TIMEOUT_MS, 15000, '超时 15 秒');
  eq(aiDecompose.ERROR_MESSAGE, 'AI 服务暂不可用', '统一失败文案');
  eq(aiDecompose.DEFAULT_PROVIDER, 'zhipu', '默认推荐服务商是智谱');
  ok(aiDecompose.MAX_STEPS === 8, '最多 8 步');
});

testCase('9.5 validateInput：入参校验', () => {
  ok(aiDecompose.validateInput('写毕业论文', '2026-12-31') === '', '合法入参');
  ok(aiDecompose.validateInput('', '2026-12-31').indexOf('任务名称') !== -1, '空标题报错');
  ok(aiDecompose.validateInput('写论文', '').indexOf('截止日期') !== -1, '空截止日报错');
  ok(aiDecompose.validateInput('写论文', '12月31号').indexOf('YYYY-MM-DD') !== -1, '日期格式错报错');
  ok(aiDecompose.validateInput('x'.repeat(200), '2026-12-31').indexOf('过长') !== -1, '超长标题报错');
  eq(aiParse.validateText('').indexOf('请先输入'), 0, 'aiParse 空文本提示');
  ok(aiParse.validateText('x'.repeat(600)).indexOf('过长') !== -1, 'aiParse 超长文本提示');
});

testCase('9.6 两个函数的导出契约：postJson 必须是 exports 的自有属性', () => {
  // 前端 utils/tests/ai_contract.js 与 worker 都以 module.exports.postJson 为替换点。
  // 如果这里退化成"局部函数"，替换会静默失效 → 契约测试会真的联网（曾经就是这样）。
  ok(Object.prototype.hasOwnProperty.call(aiParse, 'postJson'), 'aiParse 导出了 postJson');
  ok(Object.prototype.hasOwnProperty.call(aiDecompose, 'postJson'), 'aiDecompose 导出了 postJson');
  eq(typeof aiParse.postJson, 'function', 'postJson 是函数');
  eq(typeof aiDecompose.postJson, 'function', 'postJson 是函数');
  // 纯函数导出也必须在（前端契约测试要用）
  ['extractJsonObject', 'toTaskList', 'estimateMinOf', 'handleParse', 'main', 'ERROR_MESSAGE']
    .forEach((key) => ok(aiParse[key] !== undefined, `aiParse 导出了 ${key}`));
  ['normalizeEstimate', 'normalizeSubtask', 'handleDecompose', 'main', 'ERROR_MESSAGE']
    .forEach((key) => ok(aiDecompose[key] !== undefined, `aiDecompose 导出了 ${key}`));
});

testCaseAsync('9.7 event 里传 apiKey / baseUrl / provider / model 一律被忽略（防"借额度"与 SSRF）', async () => {
  const USER_KEY = 'sk-USER-KEY-IN-DB-2468';
  const EVIL_URL = 'https://evil.example.com/steal';
  const db = createSettingsDb([
    { _openid: 'me', ai_provider: 'zhipu', ai_api_key: USER_KEY, ai_model: 'glm-4.7-flash' },
  ]);

  const cases = [
    ['aiParse', aiParse],
    ['aiDecompose', aiDecompose],
  ];

  for (let i = 0; i < cases.length; i += 1) {
    const fnName = cases[i][0];
    const mod = cases[i][1];
    const realPost = mod.postJson;
    const seen = [];
    try {
      mod.postJson = (url, payload, headers) => {
        seen.push({ url, model: payload.model, auth: headers.Authorization });
        return Promise.resolve({
          status: 200,
          text: JSON.stringify({ choices: [{ message: { content: '{"events":[],"deadlines":[],"subtasks":[]}' } }] }),
        });
      };

      // 恶意入参：既想"传自己的 Key 用别人额度"，又想把请求指到自己的服务器
      const event = fnName === 'aiParse'
        ? {
          text: '明天三点开会',
          apiKey: 'sk-ATTACKER-KEY',
          api_key: 'sk-ATTACKER-KEY',
          baseUrl: EVIL_URL,
          base_url: EVIL_URL,
          url: EVIL_URL,
          endpoint: EVIL_URL,
          host: 'evil.example.com',
          provider: 'deepseek',
          model: 'attacker-model',
        }
        : {
          title: '写毕业论文',
          deadline: '2026-12-31',
          apiKey: 'sk-ATTACKER-KEY',
          base_url: EVIL_URL,
          url: EVIL_URL,
          model: 'attacker-model',
        };

      // eslint-disable-next-line no-await-in-loop
      const result = await mod.handleParse
        ? await mod.handleParse(event, { db, openid: 'me', env: {} })
        : await mod.handleDecompose(event, { db, openid: 'me', env: {} });

      ok(result.ok === true, `${fnName}：忽略这些字段后仍然正常完成`);

      // --- 核心断言 1：请求地址只可能是白名单映射出来的那个 ---
      eq(seen.length, 1, `${fnName}：只发了一次请求`);
      eq(seen[0].url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        `${fnName}：请求打到白名单地址（不是 event 里给的 ${EVIL_URL}）`);
      ok(seen[0].url.indexOf('evil.example.com') === -1, `${fnName}：没有请求攻击者指定的主机`);

      // --- 核心断言 2：用的是**库里**的 Key，不是 event 里传的 ---
      eq(seen[0].auth, `Bearer ${USER_KEY}`, `${fnName}：用的是库里读出来的用户 Key`);
      ok(seen[0].auth.indexOf('sk-ATTACKER-KEY') === -1, `${fnName}：没有使用 event 里传的 Key`);

      // --- 核心断言 3：模型名也没被 event 覆盖（用户在库里没设 model 时用默认） ---
      eq(seen[0].model, 'glm-4.7-flash', `${fnName}：模型名来自配置，不是 event 里的 attacker-model`);
    } finally {
      mod.postJson = realPost;
    }
  }

  // findInjectedFields 本身也直接测一下：认出字段名，但**不返回它们的值**
  const detected = aiParse.findInjectedFields({
    text: 'x', apiKey: 'sk-X', baseUrl: EVIL_URL, provider: 'deepseek', 无关字段: 'ok',
  });
  eq(detected.sort(), ['apiKey', 'baseUrl', 'provider'], '认出不该由前端指定的字段');
  ok(JSON.stringify(detected).indexOf('sk-X') === -1, '返回的只是字段名，不含值');
  ok(JSON.stringify(detected).indexOf('evil') === -1, '不含地址值');
  eq(aiParse.findInjectedFields({ text: 'x' }), [], '正常入参不误报');
});

testCaseAsync('9.8 优先级：用户自填 > 服务端预置；来源标注正确', async () => {
  const USER_KEY = 'sk-USER-1111';
  const db = createSettingsDb([
    { _openid: 'me', ai_provider: 'zhipu', ai_api_key: USER_KEY, ai_model: 'user-chosen-model' },
  ]);
  const env = { ZHIPU_API_KEY: 'sk-SERVER-2222', DEEPSEEK_API_KEY: '' };

  const withUser = await aiParse.resolveEffectiveConfig({ db, openid: 'me', env });
  eq(withUser.ok, true, '可用');
  eq(withUser.source, 'user', '来源=用户自填');
  eq(withUser.apiKey, USER_KEY, '用的是用户 Key（不是服务端预置）');
  eq(withUser.provider.name, 'zhipu', '服务商来自用户配置');
  eq(withUser.model, 'user-chosen-model', '模型名来自用户配置');

  // 用户没配 → 回退服务端预置
  const emptyDb = createSettingsDb([]);
  const fallback = await aiParse.resolveEffectiveConfig({ db: emptyDb, openid: 'me', env });
  eq(fallback.ok, true, '回退后可用');
  eq(fallback.source, 'server', '来源=服务端环境变量');
  eq(fallback.apiKey, 'sk-SERVER-2222', '用的是服务端预置 Key');

  // 用户记录在、但 Key 是空的 → 也算没配 → 回退
  const blankDb = createSettingsDb([{ _openid: 'me', ai_provider: 'zhipu', ai_api_key: '' }]);
  const blank = await aiParse.resolveEffectiveConfig({ db: blankDb, openid: 'me', env });
  eq(blank.source, 'server', 'Key 为空视为没配置 → 回退');

  // 两级都没有 → 不可用
  const none = await aiParse.resolveEffectiveConfig({ db: emptyDb, openid: 'me', env: {} });
  eq(none.ok, false, '两级都没有 → 不可用');

  // 只填 Key 没选服务商 → 用默认推荐那家
  const noProviderDb = createSettingsDb([{ _openid: 'me', ai_api_key: 'sk-USER-3333' }]);
  const noProvider = await aiParse.resolveEffectiveConfig({ db: noProviderDb, openid: 'me', env: {} });
  eq(noProvider.provider.name, 'zhipu', '没选服务商时用默认推荐（zhipu）');
  eq(noProvider.model, 'glm-4.7-flash', '用该服务商的默认模型');

  // 读库失败不影响可用性（回退环境变量）
  const failingDb = createSettingsDb([], { fail: true });
  const failing = await aiParse.resolveEffectiveConfig({ db: failingDb, openid: 'me', env });
  eq(failing.ok, true, '读库失败也要能用（回退预置）');
  eq(failing.source, 'server', '回退来源标注正确');

  // 查询条件必须带 _openid
  const conds = JSON.stringify(db.state.queried);
  ok(conds.indexOf('_openid') !== -1, '读配置时 where 条件带 _openid');
  eq(JSON.parse(conds)[0]._openid, 'me', '条件里的 openid 正确');
});

testCaseAsync('9.9 用户自填 Key 失败 → 可操作文案；服务端预置失败 → 统一文案', async () => {
  const realParsePost = aiParse.postJson;
  const USER_KEY = 'sk-USER-BAD-9999';
  try {
    // 401 响应（模拟用户填了个错的 Key）
    const fail401 = () => Promise.resolve({
      status: 401,
      text: '{"error":{"code":"1000","message":"身份验证失败"}}',
    });

    // ① 用户自填 Key 失败 → 提示去 AI 设置
    aiParse.postJson = fail401;
    const userDb = createSettingsDb([{ _openid: 'me', ai_api_key: USER_KEY, ai_provider: 'zhipu' }]);
    const userFailed = await aiParse.handleParse({ text: '明天三点开会' }, { db: userDb, openid: 'me', env: {} });
    eq(userFailed.ok, false, '失败');
    eq(userFailed.error, aiParse.USER_KEY_FAILED_MESSAGE, '给的是"去 AI 设置"那句');
    ok(userFailed.error.indexOf('AI 设置') !== -1, '文案里点名去哪儿改');
    ok(userFailed.error.indexOf('401') === -1, '不透传厂商内部信息（没有 401）');
    ok(userFailed.error.indexOf('身份验证失败') === -1, '不透传厂商原始 message');
    ok(userFailed.error.indexOf(USER_KEY) === -1, '文案里不含 Key');

    // ② 服务端预置 Key 失败 → 仍然只给统一文案
    const serverFailed = await aiParse.handleParse(
      { text: '明天三点开会' },
      { db: createSettingsDb([]), openid: 'me', env: { ZHIPU_API_KEY: 'sk-SERVER-BAD' } }
    );
    eq(serverFailed.error, aiParse.ERROR_MESSAGE, '预置 Key 失败 → 统一文案');
    eq(serverFailed.error, 'AI 服务暂不可用', '就是契约里那句');

    // ③ aiDecompose 同样区分
    const realDecPost = aiDecompose.postJson;
    aiDecompose.postJson = fail401;
    try {
      const decUserFailed = await aiDecompose.handleDecompose(
        { title: '写毕业论文', deadline: '2026-12-31' },
        { db: userDb, openid: 'me', env: {} }
      );
      eq(decUserFailed.error, aiDecompose.USER_KEY_FAILED_MESSAGE, 'aiDecompose 用户 Key 失败文案一致');
      const decServerFailed = await aiDecompose.handleDecompose(
        { title: '写毕业论文', deadline: '2026-12-31' },
        { db: createSettingsDb([]), openid: 'me', env: { ZHIPU_API_KEY: 'sk-SERVER-BAD' } }
      );
      eq(decServerFailed.error, 'AI 服务暂不可用', 'aiDecompose 预置 Key 失败 → 统一文案');
    } finally {
      aiDecompose.postJson = realDecPost;
    }

    // ④ 两份文案都必须落在契约常量上（前端可能直接比对）
    ok(aiParse.USER_KEY_FAILED_MESSAGE.length > 0, 'USER_KEY_FAILED_MESSAGE 已定义');
    eq(aiDecompose.USER_KEY_FAILED_MESSAGE, aiParse.USER_KEY_FAILED_MESSAGE, '两个函数的文案一致');
  } finally {
    aiParse.postJson = realParsePost;
  }
});

testCaseAsync('9.10 成功路径的来源标注：日志里能区分，但两个函数都不写 Key', async () => {
  const USER_KEY = 'sk-USER-LOGCHECK-5150';
  const realPost = aiParse.postJson;
  try {
    const payloads = [];
    aiParse.postJson = (url, payload) => {
      payloads.push(payload);
      return Promise.resolve({
        status: 200,
        text: JSON.stringify({ choices: [{ message: { content: '{"events":[],"deadlines":[]}' } }] }),
      });
    };

    // chatCompletion 的返回值里带有 source，便于上层/日志区分（不含 Key）
    const userDb = createSettingsDb([{ _openid: 'me', ai_api_key: USER_KEY }]);
    const userCall = await aiParse.chatCompletion([{ role: 'user', content: 'hi' }], true, 0.2,
      { db: userDb, openid: 'me', env: {} });
    eq(userCall.source, 'user', '用户自填时 source=user');
    eq(userCall.error, null, '成功');
    ok(JSON.stringify(userCall).indexOf(USER_KEY) === -1, 'chatCompletion 返回值里不含 Key');

    const serverCall = await aiParse.chatCompletion([{ role: 'user', content: 'hi' }], true, 0.2,
      { db: createSettingsDb([]), openid: 'me', env: { ZHIPU_API_KEY: 'sk-SERVER-ENV' } });
    eq(serverCall.source, 'server', '预置时 source=server');
    ok(JSON.stringify(serverCall).indexOf('sk-SERVER-ENV') === -1, '同样不含 Key');

    // 请求体里带的是 Key（这是必须的），但模型永远是配置里的
    eq(payloads.length, 2, '发了两次请求');
    eq(payloads[0].model, 'glm-4.7-flash', '模型名');
    ok(payloads[0].response_format && payloads[0].response_format.type === 'json_object', '仍带 JSON 模式');
  } finally {
    aiParse.postJson = realPost;
  }
});

testCase('9.11 scrubSecret：万一服务商回显了请求头，日志里也要抹掉凭证', () => {
  const scrubbed1 = aiParse.scrubSecret('认证失败 Bearer sk-live-abcdefghijklmnop');
  ok(scrubbed1.indexOf('abcdefghijklmnop') === -1, 'Bearer 后面的凭证被抹掉');
  ok(scrubbed1.indexOf('Bearer ***') !== -1, '保留 Bearer 字样便于理解');

  const scrubbed2 = aiParse.scrubSecret('服务商说 sk-1234567890abcdef 无效');
  ok(scrubbed2.indexOf('1234567890abcdef') === -1, 'sk- 形状的长串被抹掉');

  ok(aiParse.scrubSecret('普通错误信息，没有凭证') === '普通错误信息，没有凭证', '正常文本不受影响');
  eq(aiDecompose.scrubSecret('Bearer abcdefghijklmnop'), 'Bearer ***', 'aiDecompose 用同一套');

  // 真实路径：服务商把请求头回显在 message 里时，日志文本必须不含 Key
  const leaked = aiParse.classifyHttpError(
    aiParse.PROVIDERS.zhipu, 401,
    '{"error":{"code":"1000","message":"bad header Bearer sk-live-SECRETVALUE123456"}}',
    'glm-4.7-flash'
  );
  ok(aiParse.scrubSecret(leaked).indexOf('SECRETVALUE123456') === -1,
    '即使服务商回显请求头，最终日志文本里也没有 Key');
});

// ===========================================================================
// 汇总
// ===========================================================================
(async () => {
  for (const item of asyncCases) {
    currentCase = item.name;
    try {
      // eslint-disable-next-line no-await-in-loop
      await item.fn();
    } catch (error) {
      failed += 1;
      failures.push(`[${item.name}] 抛出异常：${error && error.message}`);
    }
  }

  const total = passed + failed;
  console.log('==========================================');
  console.log(`自测结果：PASS ${passed} / ${total}，FAIL ${failed}`);
  console.log('==========================================');
  if (failed) {
    console.log('失败明细：');
    failures.forEach((line) => console.log(`  ✗ ${line}`));
    process.exit(1);
  }
  console.log('全部通过 ✅（归一化容错 / 字段白名单 / 级联删除 / stats / 脏 JSON 解析 / estimate 容错'
    + ' / 服务商选择规则 / 智谱与 DeepSeek 错误码分支 / 用户自填 Key 与掩码 / 忽略注入字段与 SSRF）');
})().catch((error) => {
  console.error('自测脚本自身异常：', error);
  process.exit(1);
});
