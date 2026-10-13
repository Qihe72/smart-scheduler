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
 *   5. remind/index.js   —— DDL 到期提醒：截止时刻合成（北京时间）/ 幂等键 / 提醒窗口 /
 *                            模板字段类型解析（thing / short_thing / date / time /
 *                            character_string …，按 key 前缀）与各自长度格式约束 /
 *                            **长度按"权重"算（汉字/全角 = 2，真机证实）**及其截断保证 /
 *                            默认映射对齐真实模板（thing2 + date4 + short_thing19）/
 *                            **date 形状候选表：逐个试 + 记住赢家（真机证实 date 不吃带时刻）**
 *                            47003 失败留痕能自证"哪个字段、发了什么值" /
 *                            配置类失败退回额度（不烧用户授权）/ 错误码分类
 *                            （43101 / 47003 / 40001）/ 额度绝不超发 / 单用户失败不中断整轮。
 *                            **注意**：成功路径的真实下发与定时触发器在本机无法验证，
 *                            下发走可替换出口打桩（详见第 10 节开头的边界说明）。
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
const remind = require(path.join(__dirname, 'remind', 'index.js'));

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

testCase('6.2 period_times 逐条清洗 + **不回填默认作息**（旧期望是错的，见用例名后的说明）', () => {
  const r = N.normalizeSettings({
    period_times: { 1: ['08:00', '08:45'], 2: ['25:00', '09:40'], 3: ['乱写'], 99: ['10:00', '10:45'] },
  });
  eq(Object.keys(r.settings.period_times), ['1'], '非法时刻与越界节次被丢掉');

  // ==========================================================================
  // 【为什么旧期望是错的 —— 别改回去】
  // 这里原本期望 `withSettingsDefaults(null)` 返回 13 节内置默认作息。
  // 那个"回填"会在真机上造成**数据污染**：
  //   settings_get 把 13 节默认值当成"用户的作息"回给客户端 →
  //   客户端把它当基准去做 .ics 合并（mergePeriodTimes）→
  //   内置默认值被当成"导入课表时自动校准的结果"**存进云上** →
  //   从此界面上第 6 节（14:55-15:40，正是内置默认值）永远显示"已校准"
  //   （而用户的课表里根本没有第 6 节），并且因为第 6 节"存在"，
  //   午休那一行永远不会出现。
  // 正确分工：服务端只回"用户真的存过什么"，默认作息由客户端 utils/periods.js 决定。
  // ==========================================================================
  const nothingStored = N.withSettingsDefaults(null);
  eq(nothingStored.semester_start, '', '没设置过 → 空');
  eq(nothingStored.period_times, null,
    '**没校准过就是 null**（不回填默认作息：回填会让默认值在下次导入时被当成真实校准持久化）');

  const emptyRow = N.withSettingsDefaults({ _openid: 'me' });
  eq(emptyRow.period_times, null, '记录存在但没存过 period_times → 同样是 null');

  const emptyObject = N.withSettingsDefaults({ period_times: {} });
  eq(emptyObject.period_times, null, '存了个空对象 → 也是 null（视同没校准）');

  // 真存过就原样透出，只有真的校准过的节次才在里面
  const custom = N.withSettingsDefaults({ semester_start: '2026-09-07', period_times: { 1: ['09:00', '09:45'] } });
  eq(custom.period_times, { 1: ['09:00', '09:45'] }, '用户自定义作息原样透出（只有这一节，不带第 6 节）');
  eq(custom.period_times[6], undefined, '**第 6 节不会凭空出现**');
  eq(custom.semester_start, '2026-09-07', '开学日透传');

  // DEFAULT_PERIOD_TIMES 仍然导出（作为文档/兼容常量），但不再被回填使用
  ok(N.DEFAULT_PERIOD_TIMES && N.DEFAULT_PERIOD_TIMES[6], '常量保留导出');
  eq(N.DEFAULT_PERIOD_TIMES[6], ['14:55', '15:40'], '它里面第 6 节就是 14:55-15:40（正是真机上被误标"已校准"的那个值）');
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
// 6d. 回归：新用户导入课表**不会**凭空多出内置默认作息（真机 bug 的教训）
// ===========================================================================
testCaseAsync('6d.1 新用户 → 保存 12 节校准 → 读回来仍然只有那 12 节（不凭空多出第 6 节）', async () => {
  // 真机故障复盘：用户「我的 → 作息表」显示"共 13 节"，其中第 6 节 14:55-15:40
  // 标着「已校准」，但他的课表里根本没有第 6 节 —— 那个值正是内置默认作息。
  // 链条：settings_get 回填默认 13 节 → 客户端当基准做 .ics 合并 → 存回云上 →
  // 默认值变成"校准结果"，且第 6 节"存在"导致午休行永不出现。
  // 这条断言把"新用户不该被污染"钉死。
  const db = createFakeDb({ tasks: [] });

  // 步骤 1：新用户先看一眼作息表（此时他什么都没存过）
  const first = await tasksFn.handleAction(db, 'me', { action: 'settings_get' });
  eq(first.period_times, null, '新用户：period_times 是 null（服务端不替客户端决定默认作息）');
  eq(db.store.settings.length, 0, '看一眼不应该写库');

  // 步骤 2：导入课表，校准结果只有 12 节（真实数据就是这样：不含第 6 节）
  const calibrated = {
    1: ['08:00', '08:45'], 2: ['08:55', '09:40'], 3: ['10:00', '10:45'], 4: ['10:55', '11:40'],
    5: ['14:00', '14:45'], 7: ['16:00', '16:45'], 8: ['16:55', '17:40'], 9: ['19:00', '19:45'],
    10: ['19:55', '20:40'], 11: ['20:50', '21:35'], 12: ['21:40', '22:25'], 13: ['22:30', '23:15'],
  };
  eq(Object.keys(calibrated).length, 12, '（前提）客户端给的确实是 12 节');
  ok(!calibrated[6], '（前提）这 12 节里没有第 6 节');

  const saved = await tasksFn.handleAction(db, 'me', {
    action: 'settings_save', settings: { period_times: calibrated },
  });
  eq(saved.ok, true, '保存成功');

  // 步骤 3：读回来 —— 必须**一模一样**，不能多出第 6 节
  const back = await tasksFn.handleAction(db, 'me', { action: 'settings_get' });
  eq(Object.keys(back.period_times).length, 12, '**读回来还是 12 节**（没有多出第 6 节）');
  eq(back.period_times[6], undefined, '第 6 节依然不存在 —— 它不该被凭空补上');
  eq(back.period_times, calibrated, '整套作息与客户端给的一模一样');

  // 步骤 4：云上真的只存了 12 节（持久化层面也没有被污染）
  eq(Object.keys(db.store.settings[0].period_times).length, 12, '库里存的也是 12 节');
  eq(db.store.settings[0].period_times[6], undefined, '库里没有第 6 节');

  // 步骤 5：再读一次（模拟用户反复进出页面）也不会"长出"默认值
  const again = await tasksFn.handleAction(db, 'me', { action: 'settings_get' });
  eq(Object.keys(again.period_times).length, 12, '反复读取不会让作息变多');
});

testCase('6d.2 组合口径：normalizeSettings 只存客户端给的键 + withSettingsDefaults 不回填', () => {
  // 单函数层面的口径（6d.1 测的是完整写读闭环，这里补"为什么"）
  const normalized = N.normalizeSettings(
    { period_times: { 1: ['08:00', '08:45'], 7: ['16:00', '16:45'] } },
    { partial: true }
  );
  eq(Object.keys(normalized.settings.period_times).sort(), ['1', '7'], '只保留客户端真的给了的节次');
  eq(normalized.settings.period_times[6], undefined, '客户端没给第 6 节 → 归一化后也没有');

  // 空 override → null（而不是 13 节默认）：
  // 这样客户端「已校准」标记只可能出现在真的校准过的节次上
  eq(N.withSettingsDefaults({ period_times: normalized.settings.period_times }).period_times,
    { 1: ['08:00', '08:45'], 7: ['16:00', '16:45'] }, '存过的原样透出');
  eq(N.withSettingsDefaults({ period_times: null }).period_times, null, '没存过 → null');
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
  // 【这条以前期望"能拿到默认作息"，那是错的】服务端回填默认值会让客户端把它
  // 当成"用户的作息"，下次导入课表时合并进去、持久化成"已校准"（真机 bug）。
  // 默认作息由客户端 utils/periods.js 显示时兜底，服务端只如实回"没校准过"。
  eq(got.period_times, null, '没校准过就是 null（不回填内置默认作息）');
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
// 7c. import_replace（替换导入）与 bulk_add 去重
// ===========================================================================
/** 造一条"课表类"任务：.ics 导入的产物 = repeat='weekly' + 有节次 */
function makeCourse(overrides) {
  return makeTask(Object.assign({
    type: 'event',
    repeat: 'weekly',
    periods: '3-4',
    week_start: 1,
    week_end: 16,
    week_parity: 'all',
    start_time: '10:00',
    end_time: '11:40',
    location: '致理楼 305',
  }, overrides || {}));
}

/** 造一条"手工日程"：repeat='none' + 没节次 —— 这类**绝不能**被替换删掉 */
function makeManual(overrides) {
  return makeTask(Object.assign({ type: 'event', repeat: 'none', periods: '' }, overrides || {}));
}

testCaseAsync('7c.1 import_replace：只删课表类，手工日程/DDL/子任务一条不动', async () => {
  // 3 条课表课 + 2 条手工日程 + 1 条 DDL + 1 条子任务，共 7 条
  const seed = [
    makeCourse({ _id: 'c1', title: '高等数学', date: '2026-09-07', periods: '1-2' }),
    makeCourse({ _id: 'c2', title: '大学物理', date: '2026-09-08', periods: '3-4' }),
    makeCourse({ _id: 'c3', title: '线性代数', date: '2026-09-09', periods: '5-6' }),
    makeManual({ _id: 'm1', title: '和导师开会', date: '2026-10-12', start_time: '15:00' }),
    makeManual({ _id: 'm2', title: '体检', date: '2026-10-15' }),
    makeTask({ _id: 'd1', title: '交实验报告', type: 'ddl', date: '2026-10-16', end_time: '23:59' }),
    makeTask({ _id: 's1', title: '查文献', type: 'subtask', date: '2026-10-13', parent_id: 'd1' }),
  ];
  const db = createFakeDb({ tasks: seed });

  const result = await tasksFn.handleAction(db, 'me', {
    action: 'import_replace',
    scope: 'courses',
    tasks: [makeCourse({ title: '高等数学', date: '2026-09-07', periods: '1-2' })],
  });

  eq(result.ok, true, '替换成功');
  eq(result.removed, 3, 'removed = 3（真实删掉的课表条数，前端拿它写确认框）');
  eq(result.inserted, 1, 'inserted = 1（新课表 1 条）');
  eq(result.partial, false, '不是 partial');

  const leftIds = db.store.tasks.map((t) => t._id).sort();
  // 4 条非课表类**逐条**断言还在
  ['d1', 'm1', 'm2', 's1'].forEach((id) => {
    ok(leftIds.indexOf(id) !== -1, `手工任务 ${id} 必须原样还在`);
  });
  // 3 条旧课被删掉
  ['c1', 'c2', 'c3'].forEach((id) => {
    ok(leftIds.indexOf(id) === -1, `旧课 ${id} 已被替换删掉`);
  });
  eq(db.store.tasks.length, 5, '库里剩 4 条手工 + 1 条新课');

  // 剩下的那条手工日程内容没被动过
  const manual = db.store.tasks.filter((t) => t._id === 'm1')[0];
  eq(manual.title, '和导师开会', '手工日程标题未被改动');
  eq(manual.start_time, '15:00', '手工日程时间未被改动');
  eq(manual.repeat, 'none', '手工日程仍是不重复');
});

testCaseAsync('7c.2 import_replace：判据边界 —— 手工的"每周重复但没节次"不算课表类', async () => {
  const db = createFakeDb({
    tasks: [
      makeCourse({ _id: 'c1', title: '有节次的课' }),
      // 手工建的每周重复日程，但**没填节次** → 不算课表类（宁可少删，不可误删）
      makeTask({ _id: 'w1', title: '每周组会', repeat: 'weekly', periods: '', week_end: 16 }),
      makeManual({ _id: 'm1', title: '买菜' }),
    ],
  });

  const result = await tasksFn.handleAction(db, 'me', {
    action: 'import_replace',
    scope: 'courses',
    tasks: [makeCourse({ title: '新课' })],
  });

  eq(result.removed, 1, '只删了那一条真正带节次的课');
  const leftIds = db.store.tasks.map((t) => t._id).sort();
  ok(leftIds.indexOf('w1') !== -1, '没节次的 weekly 日程没被删（边界：宁少删）');
  ok(leftIds.indexOf('m1') !== -1, '普通日程没被删');
});

testCaseAsync('7c.3 import_replace：scope 白名单（不提供"清空全部"的口子）', async () => {
  const db = createFakeDb({ tasks: [makeCourse({ _id: 'c1' })] });

  for (const value of ['all', 'tasks', '', 'COURSES', 'courses ', 'everything']) {
    // eslint-disable-next-line no-await-in-loop
    const bad = await tasksFn.handleAction(db, 'me', {
      action: 'import_replace', scope: value, tasks: [makeCourse({ title: 'x' })],
    });
    ok(bad.ok === false, `scope=${JSON.stringify(value)} 被拒绝`);
    ok(bad.error.indexOf('scope') !== -1, `scope=${JSON.stringify(value)} 的错误信息点名 scope`);
    ok(bad.error.indexOf('courses') !== -1, '错误信息说明只接受 courses');
  }
  eq(db.store.tasks.length, 1, '所有非法请求都没动库');
  eq(db.store.tasks[0]._id, 'c1', '原数据完好');

  // 合法值正常工作
  const good = await tasksFn.handleAction(db, 'me', {
    action: 'import_replace', scope: 'courses', tasks: [makeCourse({ title: '新课' })],
  });
  eq(good.ok, true, 'scope=courses 正常');
});

testCaseAsync('7c.4 import_replace：越权 —— 别人的课一条都不能被删', async () => {
  const db = createFakeDb({
    tasks: [
      makeCourse({ _id: 'mine1', title: '我的课' }),
      makeCourse({ _id: 'theirs1', title: '别人的课', _openid: 'other-user' }),
      makeCourse({ _id: 'theirs2', title: '别人的课2', _openid: 'other-user' }),
    ],
  });

  const result = await tasksFn.handleAction(db, 'me', {
    action: 'import_replace', scope: 'courses', tasks: [makeCourse({ title: '新课' })],
  });

  eq(result.removed, 1, '只删掉自己的那 1 条');
  const left = db.store.tasks.filter((t) => t._openid === 'other-user').map((t) => t._id).sort();
  eq(left, ['theirs1', 'theirs2'], '别人的课表课一条都没动');
  ok(db.store.tasks.filter((t) => t._id === 'mine1').length === 0, '自己的旧课已被替换');
});

testCaseAsync('7c.5 import_replace：空 tasks / 没有任何课表时的行为', async () => {
  const db = createFakeDb({ tasks: [makeManual({ _id: 'm1' })] });

  const empty = await tasksFn.handleAction(db, 'me', {
    action: 'import_replace', scope: 'courses', tasks: [],
  });
  ok(empty.ok === false, '空 tasks 被拒绝');
  ok(empty.error.indexOf('tasks') !== -1, '错误信息点名 tasks');
  eq(db.store.tasks.length, 1, '被拒绝时没动库');

  const missing = await tasksFn.handleAction(db, 'me', { action: 'import_replace', scope: 'courses' });
  ok(missing.ok === false, '缺 tasks 也被拒绝');

  // 库里没有任何课表类：removed 应该是 0，而不是报错
  const noCourses = await tasksFn.handleAction(db, 'me', {
    action: 'import_replace', scope: 'courses', tasks: [makeCourse({ title: '第一门课' })],
  });
  eq(noCourses.ok, true, '库里没课表时也能导入');
  eq(noCourses.removed, 0, 'removed = 0（首次导入没有旧课可删）');
  eq(noCourses.inserted, 1, '新导入 1 条');
  eq(db.store.tasks.length, 2, '手工那条 + 新课 1 条');

  const tooMany = await tasksFn.handleAction(db, 'me', {
    action: 'import_replace', scope: 'courses', tasks: new Array(500).fill(makeCourse({ title: 'x' })),
  });
  ok(tooMany.ok === false, '超过 200 条被拒绝');
});

testCaseAsync('7c.6 import_replace：删成功但插失败 → 如实返回 partial，不假装成功', async () => {
  const db = createFakeDb(
    { tasks: [makeCourse({ _id: 'c1', title: '旧课A' }), makeCourse({ _id: 'c2', title: '旧课B' })] },
    { failAddAfter: 0 } // 从第一次 add 开始就抛错
  );

  const result = await tasksFn.handleAction(db, 'me', {
    action: 'import_replace',
    scope: 'courses',
    tasks: [makeCourse({ title: '新课1' }), makeCourse({ title: '新课2' })],
  });

  // 删除是成功的（2 条旧课没了），插入全失败
  eq(result.removed, 2, 'removed 如实报告删掉的 2 条');
  eq(result.inserted, 0, 'inserted 如实报告 0 条');
  eq(result.partial, true, '**partial=true**：删成功但插失败，不能假装成功');
  ok(result.errors.length > 0, 'errors 里有说明');
  eq(db.store.tasks.length, 0, '库里确实空了（说明确实删了）—— 前端据此提示用户重新导入');
});

testCaseAsync('7c.7 bulk_add 去重：同一批内重复 + 与库里已有重复都只写一条', async () => {
  const db = createFakeDb({
    tasks: [makeManual({ _id: 'e1', title: '开组会', date: '2026-10-12', start_time: '15:00' })],
  });

  const result = await tasksFn.handleAction(db, 'me', {
    action: 'bulk_add',
    tasks: [
      { title: '开组会', date: '2026-10-12', start_time: '15:00' }, // 与库里已有重复
      { title: '新课A', date: '2026-10-13', start_time: '08:00' },  // 新
      { title: '新课A', date: '2026-10-13', start_time: '08:00' },  // 同一批内重复
      { title: '新课A', date: '2026-10-13', start_time: '08:00' },  // 又来一条
      { title: '新课B', date: '2026-10-13', start_time: '08:00' },  // 换个标题 → 新
    ],
  });

  eq(result.ok, true, '成功');
  eq(result.inserted, 2, '只写了 2 条（新课A + 新课B）');
  eq(result.duplicates, 3, 'duplicates = 3（1 条撞库里 + 2 条撞同一批）');
  eq(result.skipped, 3, 'skipped 把重复也算进去');
  eq(result.errors, [], '重复**不报错**（这是预期行为，不是错误）');
  eq(db.store.tasks.length, 3, '库里 = 原有 1 条 + 新写 2 条');
});

testCaseAsync('7c.8 bulk_add 去重：日期或开始时间不同就不算重复（别误杀）', async () => {
  const db = createFakeDb({ tasks: [] });

  const result = await tasksFn.handleAction(db, 'me', {
    action: 'bulk_add',
    tasks: [
      { title: '开会', date: '2026-10-12', start_time: '09:00' },
      { title: '开会', date: '2026-10-13', start_time: '09:00' }, // 换了一天 → 不是重复
      { title: '开会', date: '2026-10-12', start_time: '14:00' }, // 换了时刻 → 不是重复
      { title: '开会', date: '2026-10-12', start_time: '' },      // 没填时刻 → 与上面都不同
      { title: '开会', date: '2026-10-12', start_time: '09:00' }, // 与第一条完全相同 → 重复
    ],
  });

  eq(result.inserted, 4, '4 条都写进去了（只有最后那条重复）');
  eq(result.duplicates, 1, 'duplicates = 1');
  eq(db.store.tasks.length, 4, '库里 4 条');
});

testCaseAsync('7c.9 bulk_add 去重：键与归一化后的值比较（9:5 与 09:05 视为同一条）', async () => {
  const db = createFakeDb({ tasks: [] });

  const result = await tasksFn.handleAction(db, 'me', {
    action: 'bulk_add',
    tasks: [
      { title: '开会', date: '2026-10-12', start_time: '9:5' },
      { title: '  开会  ', date: '2026-10-12', start_time: '09:05' }, // 首尾空白 + 补零后同一条
    ],
  });

  eq(result.inserted, 1, '只有 1 条入库');
  eq(result.duplicates, 1, '识别为重复');
  eq(db.store.tasks[0].start_time, '09:05', '存的是归一化后的时刻');
  eq(db.store.tasks[0].title, '开会', '存的是裁掉空白的标题');
});

testCaseAsync('7c.10 bulk_add：不合法数据仍单独计数，与重复分得清', async () => {
  const db = createFakeDb({ tasks: [] });
  const result = await tasksFn.handleAction(db, 'me', {
    action: 'bulk_add',
    tasks: [
      { title: '正常', date: '2026-10-12' },
      { title: '', date: '2026-10-12' },        // 不合法
      { title: '正常', date: '2026-10-12' },     // 重复
    ],
  });
  eq(result.inserted, 1, '写入 1 条');
  eq(result.duplicates, 1, '重复 1 条');
  eq(result.errors.length, 1, '不合法 1 条且在 errors 里有说明');
  eq(result.skipped, 2, 'skipped = 不合法 + 重复');
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

testCase('8b.1 服务商表：两家都在，默认模型名正确（DeepSeek 旧名 deepseek-chat 已于 2026-07-24 停服 → 默认模型是 deepseek-flash）', () => {
  const names = aiParse.providerNames().sort();
  eq(names, ['deepseek', 'zhipu'], 'aiParse 支持两家');
  eq(aiDecompose.providerNames().sort(), ['deepseek', 'zhipu'], 'aiDecompose 也支持两家（两个函数都要读环境变量）');

  eq(aiParse.PROVIDERS.zhipu.defaultModel, 'glm-4.7-flash', '智谱默认模型');
  eq(aiParse.PROVIDERS.zhipu.apiKeyEnv, 'ZHIPU_API_KEY', '智谱环境变量名');
  eq(aiParse.PROVIDERS.zhipu.baseUrl, 'https://open.bigmodel.cn/api/paas/v4', '智谱 base 地址');
  // 【事实更新】DeepSeek 的默认模型换成 deepseek-flash（V4.1-Flash）：
  // 依据官方 changelog（2026-09-10 发布原生多模态的 V4.1-Flash；2026-07-24 起
  // deepseek-chat / deepseek-reasoner 停止服务），所以默认模型不能再是 deepseek-chat。
  eq(aiParse.PROVIDERS.deepseek.defaultModel, 'deepseek-flash', 'DeepSeek 默认模型（V4.1-Flash）');
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

testCase('8b.2 未指定服务商时「谁配了 Key 用谁」（DeepSeek 侧默认模型 = deepseek-flash；旧名 deepseek-chat 2026-07-24 起停服）', () => {
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
  eq(onlyDeepseek.model, 'deepseek-flash', '用 DeepSeek 默认模型（deepseek-flash）');

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
    // 【口径更新（真机 bug）】用户自填 Key 时，失败文案**优先用分类得出的具体原因**：
    // 401 这一类给"Key 无效/已过期"那句（仍属"去 AI 设置"那一类，只是更准确）。
    // 以前不分原因一律说"你填的 AI Key 无法使用"，会把"模型名写错"误导成"Key 有问题"。
    eq(userFailed.error, '你的 AI Key 无效或已过期，请到「我的 → AI 设置」检查或重新填写',
      '401 → 给的是"Key 无效/已过期"那句');
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
      eq(decUserFailed.error, '你的 AI Key 无效或已过期，请到「我的 → AI 设置」检查或重新填写',
        'aiDecompose 用户 Key 失败文案与 aiParse 一致（同样是 Key 类文案）');
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
// 10. remind/index.js —— DDL 到期提醒（订阅消息）
// ===========================================================================
// 【本节的边界，先说清楚】
//   1. 真实下发**没测**：本机没有 templateId，也没有云环境。所有下发都走
//      `remind.sendSubscribeMessage` 这个可替换出口，测的是「拿到什么返回就怎么处理」。
//   2. 定时触发器与云调用权限（config.json）**没测**：那是微信侧的东西，
//      本地 node 里没有任何东西能验证它。
//   3. 测的是三件最要紧的事：**什么时候该发**（纯函数）、**绝不重复发**（幂等）、
//      **没额度/被拒收时绝不硬发**（额度与错误分类）。

/** 北京时间 `YYYY-MM-DD` + `HH:MM` → 绝对毫秒（口径与 remind 云函数一致） */
function bjMs(day, clock) {
  const d = day.split('-').map(Number);
  const t = clock.split(':').map(Number);
  return Date.UTC(d[0], d[1] - 1, d[2], t[0], t[1], 0, 0) - remind.BEIJING_OFFSET_MS;
}

/** 绝对毫秒 → 北京时间的日期 / 时分（用来构造"相对 now"的测试数据，避免测试依赖当天几点） */
function bjDay(ms) {
  const s = new Date(ms + remind.BEIJING_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `${s.getUTCFullYear()}-${p(s.getUTCMonth() + 1)}-${p(s.getUTCDate())}`;
}
function bjClock(ms) {
  const s = new Date(ms + remind.BEIJING_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(s.getUTCHours())}:${p(s.getUTCMinutes())}`;
}

/** 造一条 DDL（date / end_time 都由调用方给绝对毫秒，省得手算日期） */
function ddlAt(ms, overrides) {
  return makeTask(Object.assign({
    type: 'ddl',
    date: bjDay(ms),
    start_time: '', // ddl 的 start_time 永远是空串（见 normalize.js 的 2.3）
    end_time: bjClock(ms),
    done: false,
  }, overrides || {}));
}

/** 固定的"现在"：2026-10-16（周五）10:00 北京时间。固定住时间，断言才可复现 */
const R_NOW = bjMs('2026-10-16', '10:00');
const MIN = 60 * 1000;

// --- 10.1 截止时刻 ---------------------------------------------------------
testCase('10.1 dueInstantOf：合法 ddl 按北京时间合成绝对时刻', () => {
  const task = makeTask({ type: 'ddl', date: '2026-10-16', start_time: '', end_time: '12:00' });
  eq(remind.dueInstantOf(task), bjMs('2026-10-16', '12:00'), 'date + end_time 按 UTC+8 合成');
  // 手算一遍，防止"两边都用同一个错公式"导致断言自洽却全错：
  // 北京 2026-10-16 12:00 = UTC 2026-10-16 04:00
  eq(remind.dueInstantOf(task), Date.UTC(2026, 9, 16, 4, 0, 0, 0), '等于 UTC 04:00（北京 -8h）');
  eq(new Date(remind.dueInstantOf(task)).toISOString(), '2026-10-16T04:00:00.000Z', 'ISO 串能对上');

  // H:MM 也认（与 normalize.js 的 isTime 口径一致）
  eq(remind.dueInstantOf(makeTask({ type: 'ddl', date: '2026-10-16', end_time: '9:05' })),
    bjMs('2026-10-16', '09:05'), '9:05 与 09:05 等价');
});

testCase('10.2 dueInstantOf：不该提醒的四种情况一律返回 null', () => {
  // ① 已完成
  eq(remind.dueInstantOf(makeTask({ type: 'ddl', date: '2026-10-16', end_time: '12:00', done: true })),
    null, 'done=true 不提醒');
  // ② 非 ddl（event 有明确时间也不算"到期"）
  eq(remind.dueInstantOf(makeTask({ type: 'event', date: '2026-10-16', end_time: '12:00' })),
    null, 'event 不提醒');
  eq(remind.dueInstantOf(makeTask({ type: 'subtask', date: '2026-10-16', end_time: '12:00' })),
    null, 'subtask 不提醒');
  // ③ 缺 end_time（ddl 的截止时刻只在 end_time 里，缺了不瞎猜 23:59）
  eq(remind.dueInstantOf(makeTask({ type: 'ddl', date: '2026-10-16', end_time: '' })),
    null, '缺 end_time → null');
  // ④ 缺 date
  eq(remind.dueInstantOf(makeTask({ type: 'ddl', date: '', end_time: '12:00' })),
    null, '缺 date → null');
  // 垃圾输入
  eq(remind.dueInstantOf(null), null, 'null → null');
  eq(remind.dueInstantOf('字符串'), null, '非对象 → null');
});

testCase('10.3 dueInstantOf：非法时间给 null 并记 warning（不瞎猜、不静默）', () => {
  const w1 = [];
  eq(remind.dueInstantOf(makeTask({ _id: 't1', type: 'ddl', date: '2026-10-16', end_time: '25:00' }), { warnings: w1 }),
    null, '25:00 越界 → null');
  ok(w1.length === 1, '记了 1 条 warning');
  ok(w1[0].indexOf('t1') !== -1, 'warning 里点名是哪条任务');
  ok(w1[0].indexOf('end_time') !== -1, 'warning 里点名是 end_time 的问题');

  const w2 = [];
  eq(remind.dueInstantOf(makeTask({ type: 'ddl', date: '2026-10-16', end_time: '12:60' }), { warnings: w2 }),
    null, '12:60 越界 → null');
  eq(w2.length, 1, '同样记 warning');

  // 日期非法 / 不存在的日期：Date.UTC 会把 02-30 静默进位成 03-02，必须自己挡住
  const w3 = [];
  eq(remind.dueInstantOf(makeTask({ type: 'ddl', date: '2026-02-30', end_time: '12:00' }), { warnings: w3 }),
    null, '2026-02-30 不是真实日期 → null');
  eq(w3.length, 1, '记 warning');

  const w4 = [];
  eq(remind.dueInstantOf(makeTask({ type: 'ddl', date: '2026/10/16', end_time: '12:00' }), { warnings: w4 }),
    null, '斜杠日期 → null');

  // 非 ddl 的脏数据**不**记 warning（那不是错误，是设计如此：我们不提醒 event）
  const w5 = [];
  eq(remind.dueInstantOf(makeTask({ type: 'event', date: '2026-13-99', end_time: '99:99' }), { warnings: w5 }),
    null, '非 ddl → null');
  eq(w5.length, 0, '非 ddl 不产生 warning（避免日志被无关数据刷屏）');
});

// --- 10.2 幂等键 -----------------------------------------------------------
testCase('10.4 dueKeyOf：幂等键 = 任务 id @ 日期 时刻', () => {
  const task = makeTask({ _id: 'abc', type: 'ddl', date: '2026-10-16', end_time: '12:00' });
  eq(remind.dueKeyOf(task), 'abc@2026-10-16 12:00', '键的格式');
  // 9:05 与 09:05 必须归一成同一个键，否则同一个截止时刻会有两个键 → 提醒两次
  eq(remind.dueKeyOf(makeTask({ _id: 'abc', date: '2026-10-16', end_time: '9:05' })),
    remind.dueKeyOf(makeTask({ _id: 'abc', date: '2026-10-16', end_time: '09:05' })),
    '9:05 与 09:05 归一到同一个键');
  // 改了截止时间 → 新键 → 允许再提醒（这是想要的语义：改期后要重新提醒）
  ok(remind.dueKeyOf(makeTask({ _id: 'abc', date: '2026-10-16', end_time: '13:00' }))
    !== remind.dueKeyOf(task), '改了时间就是新键');
  eq(remind.dueKeyOf(makeTask({ _id: '', date: '2026-10-16', end_time: '12:00' })), '', '缺 id → 空键（空键不进 sentKeys）');
});

// --- 10.3 计划（什么时候该发） ---------------------------------------------
testCase('10.5 planReminders：窗口内才进，按截止时刻升序，已提醒的排除', () => {
  const tasks = [
    ddlAt(R_NOW + 5 * MIN, { _id: 'in5' }), // 还剩 5 分钟 → 进
    ddlAt(R_NOW + 30 * MIN, { _id: 'in30' }), // 还剩 30 分钟（lead=60）→ 进
    ddlAt(R_NOW + 90 * MIN, { _id: 'in90' }), // 还剩 90 分钟（lead=60）→ 不进
    ddlAt(R_NOW - 3 * MIN, { _id: 'grace' }), // 刚过期 3 分钟，在 10 分钟宽限内 → 进
    ddlAt(R_NOW - 30 * MIN, { _id: 'stale' }), // 过期 30 分钟，超出宽限 → 不进
    makeTask({ _id: 'done1', type: 'ddl', date: bjDay(R_NOW), end_time: bjClock(R_NOW + 5 * MIN), done: true }),
    makeTask({ _id: 'ev1', type: 'event', date: bjDay(R_NOW), start_time: bjClock(R_NOW + 5 * MIN) }),
  ];
  const result = remind.planReminders({ now: R_NOW, tasks, sentKeys: [], leadMin: 60 });

  eq(result.items.map((item) => item.task._id), ['grace', 'in5', 'in30'], '入选的按截止时刻升序');
  eq(result.items.map((item) => item.minutesLeft), [-3, 5, 30], 'minutesLeft 如实给出（负数=刚过期）');
  eq(result.items[0].dueKey, `grace@${bjDay(R_NOW - 3 * MIN)} ${bjClock(R_NOW - 3 * MIN)}`, '每条都带幂等键');
  eq(result.items[0].dueAt, R_NOW - 3 * MIN, 'dueAt 就是截止时刻');

  const reasons = {};
  result.skipped.forEach((s) => { reasons[s.task._id] = s.reason; });
  eq(reasons.in90, 'too_early', '90 分钟 > lead 60 → too_early');
  eq(reasons.stale, 'too_late', '过期超宽限 → too_late（不补发"你早就过期了"）');
  eq(reasons.done1, 'no_due_instant', '已完成 → no_due_instant');
  eq(reasons.ev1, 'no_due_instant', '非 ddl → no_due_instant');

  // 幂等：把 in5 的键放进 sentKeys，它就必须被排除
  const again = remind.planReminders({
    now: R_NOW, tasks, sentKeys: [result.items[1].dueKey], leadMin: 60,
  });
  eq(again.items.map((item) => item.task._id), ['grace', 'in30'], 'sentKeys 命中的不再入选');
  eq(again.skipped.filter((s) => s.reason === 'already_sent').length, 1, '已提醒过的记为 already_sent');

  // sentKeys 也接受 Set（调用方手边有什么就给什么）
  const asSet = remind.planReminders({ now: R_NOW, tasks, sentKeys: new Set([result.items[1].dueKey]), leadMin: 60 });
  eq(asSet.items.map((item) => item.task._id), ['grace', 'in30'], '传 Set 结果一致');
});

testCase('10.6 planReminders：lead 精确边界 + 超过 MAX_PER_SCAN 时按时间升序截断', () => {
  // 边界：正好 60 分钟 → 进；61 分钟 → 不进（窗口是 <= leadMin 的闭区间）
  const edge = remind.planReminders({
    now: R_NOW,
    leadMin: 60,
    tasks: [ddlAt(R_NOW + 60 * MIN, { _id: 'exact' }), ddlAt(R_NOW + 61 * MIN, { _id: 'over' })],
  });
  eq(edge.items.map((item) => item.task._id), ['exact'], '正好 60 分钟的进，61 分钟的不进');

  // 5 条都符合条件 → 只发最急的 3 条（MAX_PER_SCAN），其余记 over_scan_limit
  const many = [];
  for (let i = 1; i <= 5; i += 1) many.push(ddlAt(R_NOW + i * MIN, { _id: `m${i}` }));
  const capped = remind.planReminders({ now: R_NOW, tasks: many, leadMin: 60 });
  eq(remind.MAX_PER_SCAN, 3, 'MAX_PER_SCAN 就是 3');
  eq(capped.items.map((item) => item.task._id), ['m1', 'm2', 'm3'], '最急的 3 条');
  eq(capped.skipped.filter((s) => s.reason === 'over_scan_limit').length, 2, '被截断的 2 条记为 over_scan_limit');

  // 显式传 max 可以覆盖（自测与调参用）
  eq(remind.planReminders({ now: R_NOW, tasks: many, leadMin: 60, max: 1 }).items.length, 1, 'max 可覆盖');
});

// --- 10.4 模板消息体 -------------------------------------------------------
testCase('10.7 默认映射对齐真实模板：thing2 / date4 / short_thing19 与各自类型约束', () => {
  const dueAt = bjMs('2026-09-28', '12:00');
  // now 显式注入（= 到期前 30 分钟）：让"还剩多久"这一栏可断言，而不是跟着当天时间跑
  const before30 = { now: dueAt - 30 * MIN };
  const built = remind.buildMessageData({ title: '提交实验报告', type: 'ddl' }, dueAt, null, before30);

  // 【关键回归】默认映射必须对齐用户实际申请到的模板，改回 thing1/time2/thing3 就是必 47003
  eq(Object.keys(remind.DEFAULT_FIELD_MAP).sort(), ['date4', 'short_thing19', 'thing2'],
    '默认映射的 key 恰好是 thing2 / date4 / short_thing19');
  eq(remind.DEFAULT_FIELD_MAP, { thing2: 'title', date4: 'due', short_thing19: 'category' }, '默认映射内容');
  eq(Object.keys(built.data).sort(), ['date4', 'short_thing19', 'thing2'], '产出的 data 就是这三个 key');

  // ① thing2「提醒内容」= 标题（**不带"（还剩 N 分钟）"尾巴**，理由见 10.8）
  eq(built.data.thing2.value, '提交实验报告', 'thing2 = 标题原文');
  ok(remind.fieldUnits(built.data.thing2.value) <= remind.THING_MAX, '权重在 thing 上限内（12 ≤ 20）');
  eq(built.data.thing2.value.indexOf('还剩'), -1, '标题栏不带"还剩…"（平台字段放不下，见 10.8）');
  // ② date4「日程时间」= 默认候选（纯日期，候选表第 1 项）
  eq(built.data.date4.value, '2026年9月28日', 'date4 = 默认候选（纯日期）');
  eq(built.date_style, 'date', '默认候选名是 date（候选表第 1 项）');
  ok(/^\d{4}年\d{1,2}月\d{1,2}日$/.test(built.data.date4.value),
    'date4 匹配 ^\\d{4}年\\d{1,2}月\\d{1,2}日$');
  ok(built.data.date4.value.indexOf('-') === -1, '不带 "2026-09-28" 那种内部格式的连字符');
  // ③ short_thing19「日程类别」= 中文标签，且**权重**不超 5
  eq(built.data.short_thing19.value, '截止', 'ddl 的类别是「截止」');
  eq(remind.fieldUnits(built.data.short_thing19.value), 4, '「截止」权重 = 4 ≤ 5');
  eq(built.truncated, [], '这个长度不该触发截断');

  // 这个模板 + 默认映射下，**只有**一条关于日期形状的提醒（不是配置错误，是"形状靠真机判定"）
  eq(built.warnings.length, 1, '恰好一条提醒');
  ok(built.warnings[0].indexOf('date4') !== -1, '提醒针对 date4');
  ok(built.warnings[0].indexOf('date') !== -1, '并且说清当前用的是哪个候选');
  ok(built.warnings[0].indexOf('真机') !== -1,
    '照实说明：date 类收哪种形状只能由真机判定，代码不假装知道');
  ok(built.warnings[0].indexOf('只能由真机判定') !== -1,
    '照实说明：date 类收哪种形状只能由真机判定，代码不假装知道');

  // 类别标签三类都与前端 utils/periods.js 的 TYPE_LABELS 一致
  eq(remind.typeLabelOf('ddl'), '截止', 'ddl → 截止');
  eq(remind.typeLabelOf('event'), '日程', 'event → 日程');
  eq(remind.typeLabelOf('subtask'), '子任务', 'subtask → 子任务');
  // 各标签在权重口径下的实际占用（short_thing 上限 5 权重 = 2 个汉字）
  eq(remind.fieldUnits('截止'), 4, '截止 = 4 权重（合规）');
  eq(remind.fieldUnits('日程'), 4, '日程 = 4 权重（合规）');
  eq(remind.fieldUnits('子任务'), 6, '子任务 = 6 权重（**超** short_thing 的 5 → 必须被截）');
  // 子任务虽然不会被提醒（只提醒 ddl），但映射一旦指向它也不能发出违规值
  const subBuilt = remind.buildMessageData({ title: 'x', type: 'subtask' }, dueAt, null, before30);
  ok(remind.fieldUnits(subBuilt.data.short_thing19.value) <= 5, '子任务标签也会被裁到 5 权重内');
  eq(subBuilt.data.short_thing19.value, '子…', '裁成「子…」');

  // 留痕必须齐：槽位 → key → 类型 → 最终值 + 权重（47003 排查就靠它）
  eq(built.fields.map((f) => `${f.slot}:${f.key}:${f.type}`),
    ['title:thing2:thing', 'due:date4:date', 'category:short_thing19:short_thing'],
    'fields 留痕是「槽位 → key → 类型」');
  eq(built.fields.map((f) => f.value), ['提交实验报告', '2026年9月28日', '截止'], '留痕里带最终值');
  eq(built.fields.map((f) => f.units), [12, 13, 4], '留痕里带权重（纯日期 date4 = 13 权重）');
  eq(remind.describeMessageFields(built.fields),
    'thing2=提交实验报告 | date4=[纯日期]2026年9月28日 | short_thing19=截止',
    'describeMessageFields 压成一行可读文本');

  // 空标题不留空 —— 微信不接受空 value
  eq(remind.buildMessageData({ title: '  ', type: 'ddl' }, dueAt, null, before30).data.thing2.value,
    '未命名任务', '空标题用占位文字（10 权重 ≤ 20）');
});

testCase('10.8 【真机证实】长度按权重算：汉字/全角算 2，去掉"还剩 N 分钟"尾巴', () => {
  // ===== 把真机被拒的那条字符串钉成回归用例 =====
  // 微信原文：should be 5-20 characters；当时发的是「提交实验报告（还剩30分钟）」，
  // 按码点只有 14，按权重是 26 → 26 > 20 被拒。以后有人改回按码点数，这条就会红。
  const rejected = '提交实验报告（还剩30分钟）';
  eq(Array.from(rejected).length, 14, '按码点数是 14（看着完全没超 20）');
  eq(remind.fieldUnits(rejected), 26, '按权重是 26 —— 与微信 should be 5-20 characters 吻合');
  ok(remind.fieldUnits(rejected) > remind.THING_MAX, '所以真机会被拒，这是已被证实的事实');

  // 口径本身：汉字/全角算 2，数字/字母/半角算 1
  eq(remind.fieldUnits('一'), 2, '汉字 = 2');
  eq(remind.fieldUnits('（'), 2, '全角括号 = 2');
  eq(remind.fieldUnits('，'), 2, '全角逗号 = 2');
  eq(remind.fieldUnits('a'), 1, '半角字母 = 1');
  eq(remind.fieldUnits('9'), 1, '半角数字 = 1');
  eq(remind.fieldUnits('a b'), 2, '半角空格**不计**（值的首尾会先 trim，见代码注释）');
  eq(remind.fieldUnits(' '), 0, '孤立的空格被 trim → 0');
  eq(remind.fieldUnits('…'), 2, '省略号按 2 权重算（保守口径，预算里必须减掉它）');
  eq(remind.ELLIPSIS_UNITS, 2, 'ELLIPSIS_UNITS 常量 = 2');
  eq(remind.fieldUnits('截止'), 4, '截止 = 4');
  eq(remind.fieldUnits(''), 0, '空串 = 0');
  eq(remind.fieldUnits(null), 0, 'null 安全');

  // ===== 默认映射下：30 个汉字的标题 → 权重 ≤ 20 且以 … 结尾 =====
  const dueAt = bjMs('2026-09-28', '12:00');
  const before30 = { now: dueAt - 30 * MIN };
  const longTitle = '一二三四五六七八九十'.repeat(3); // 30 个汉字 = 60 权重
  eq(remind.fieldUnits(longTitle), 60, '30 个汉字 = 60 权重');
  const built = remind.buildMessageData({ title: longTitle, type: 'ddl' }, dueAt, null, before30);
  const value = built.data.thing2.value;
  ok(remind.fieldUnits(value) <= remind.THING_MAX, `最终 thing2 权重 ${remind.fieldUnits(value)} ≤ 20`);
  eq(value.slice(-1), '…', '以省略号结尾（看得见被截了）');
  eq(value, '一二三四五六七八九十'.repeat(3).slice(0, 9) + '…', '前 9 个汉字 + 省略号');
  eq(remind.fieldUnits(value), 20, '正好用满 20 权重（不浪费预算）');
  eq(Array.from(value).length, 10, '10 个码点 —— **不是 20**，这正是权重与字符数的区别');
  eq(built.truncated.length, 1, 'truncated 里如实上报');
  ok(built.truncated[0].indexOf('thing2') !== -1, '点名 thing2');
  ok(built.truncated[0].indexOf('权重') !== -1, '并说清是按权重口径裁的');
  ok(built.truncated[0].indexOf('60') !== -1, '带上原始权重（方便判断裁得狠不狠）');

  // ===== 每个字段都要通过本地权重自检（多组脏输入跑一遍）=====
  const dirty = [
    '', '  ', '一', '一二三四五', '一'.repeat(30), 'a'.repeat(100),
    '混合abc中文123', '，。！？（）【】', '🎓'.repeat(30), 'x'.repeat(25) + '汉'.repeat(25),
    '提交实验报告（还剩30分钟）', 'ＡＢＣ全角字母', 'a b c', '　', '１', 'ｱ',
  ];
  let checkedFields = 0;
  dirty.forEach((title) => {
    [null, { thing1: 'title', short_thing2: 'title', phrase3: 'title' }].forEach((map) => {
      const out = remind.buildMessageData({ title, type: 'ddl' }, dueAt, map, before30);
      Object.keys(out.data).forEach((key) => {
        const type = remind.fieldTypeOf(key);
        const rule = remind.ruleForType(type);
        const check = remind.checkFieldCompliance(key, out.data[key].value, rule.max, type);
        ok(check.ok, `脏输入 ${JSON.stringify(title).slice(0, 14)} 的 ${key} 自检通过（${check.reason}）`);
        // 空值也不行：微信不接受空 value（用户没填标题时走占位文字，不会是空串）
        ok(String(out.data[key].value).length > 0, `${key} 不能是空串`);
        checkedFields += 1;
      });
    });
  });
  ok(checkedFields >= 40, `确实跑了多组输入（共检查 ${checkedFields} 个字段）`);

  // ===== emoji 截断不产生半个代理对 =====
  const emojiValue = remind.buildMessageData({ title: '🎓'.repeat(30), type: 'ddl' }, dueAt, null, before30)
    .data.thing2.value;
  ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emojiValue), '没有落单的高代理');
  ok(!/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emojiValue), '没有落单的低代理');
  ok(remind.fieldUnits(emojiValue) <= remind.THING_MAX, 'emoji 也按权重算且合规');

  // ===== truncateToUnits 的硬保证：任何输入都不会产出超限值 =====
  const budgets = [5, 6, 20, 32];
  budgets.forEach((max) => {
    dirty.forEach((text) => {
      const fitted = remind.truncateToUnits(text, max);
      ok(remind.fieldUnits(fitted.text) <= max,
        `truncateToUnits(${JSON.stringify(text).slice(0, 12)}, ${max}) 结果不超限`);
    });
  });
  // 预算小到放不下省略号时给空串（硬保证优先于"别留空"）
  eq(remind.truncateToUnits('一', 0).text, '', '预算 0 → 空串');
  eq(remind.truncateToUnits('一', 2).text, '一', '正好放得下就不截');
  eq(remind.truncateToUnits('一二', 2).text, '', '截了就会超 → 宁可给空串');

  // ===== 尾巴去掉这件事本身 =====
  eq(typeof remind.composeTitleWithLeft, 'undefined', '旧的"标题+尾巴"函数已移除（别再请回来）');
  eq(remind.composeTitle('提交实验报告', remind.THING_MAX).text, '提交实验报告', 'composeTitle 就是按权重收口的标题');
  // 用同一个输入比较两条路径，否则比的是两个不同字符串（这种"看着对其实没测到"的断言要避免）
  eq(remind.composeTitle(longTitle, remind.THING_MAX).text, value, 'composeTitle 与 buildMessageData 走同一口径');
  eq(remind.composeTitle('一'.repeat(30), 20).text, '一一一一一一一一一…', '纯汉字 30 个 → 9 个 + 省略号');
});

testCase('10.9 buildMessageData / resolveFieldMap：字段名映射与非法映射的容错', () => {
  const dueAt = bjMs('2026-09-28', '12:00');
  const before30 = { now: dueAt - 30 * MIN };

  // REMIND_FIELD_MAP 覆盖能力**保留**：换模板时只改这个环境变量
  const mapped = remind.buildMessageData({ title: '交报告', type: 'ddl' }, dueAt,
    { thing1: 'title', time2: 'left', phrase3: 'category' }, before30);
  eq(Object.keys(mapped.data).sort(), ['phrase3', 'thing1', 'time2'], '字段名跟着映射变');
  eq(mapped.data.thing1.value, '交报告', 'thing1 拿标题（不带尾巴）');
  // time 类：形状由类型决定（年月日 + 时刻），两种写法都收
  ok(/^\d{4}年\d{1,2}月\d{1,2}日$/.test(mapped.data.time2.value), 'time2 也是默认候选的纯日期形状');
  // phrase 类只允许 5 权重、**不允许空格** —— 给紧凑写法，且放不下就按权重裁
  eq(mapped.data.phrase3.value, '截止', 'phrase3 拿类别的紧凑写法（4 权重 ≤ 5）');
  eq(mapped.truncated, [], '这些值都没超各自类型的上限');

  // phrase 类上限 5 权重是硬约束：超了必须被我们截掉，而不是等微信回 47003
  const phraseOver = remind.buildMessageData({ title: '这是一个很长的标题', type: 'ddl' }, dueAt,
    { phrase1: 'title' }, before30);
  eq(phraseOver.data.phrase1.value, '这…', 'phrase1 被裁到 5 权重内（1 汉字 + 省略号 = 4）');
  ok(remind.fieldUnits(phraseOver.data.phrase1.value) <= 5, 'phrase 权重不超 5');
  eq(phraseOver.truncated.length, 1, '并且如实报告"我截了"（悄悄截短是不允许的）');

  // short_thing 上限同样是 5 权重（= 2 个汉字）
  const shortOver = remind.buildMessageData({ title: '这是一个很长的标题', type: 'ddl' }, dueAt,
    { short_thing1: 'title' }, before30);
  ok(remind.fieldUnits(shortOver.data.short_thing1.value) <= 5, 'short_thing 权重不超 5');
  eq(shortOver.data.short_thing1.value, '这…', '1 汉字 + 省略号 = 4 权重');
  ok(shortOver.data.short_thing1.value.indexOf(' ') === -1, 'short_thing 里不留空格');
  // 两个汉字 + 省略号会超（2+2+2=6 > 5），所以只能留一个汉字 —— 这正是权重口径的意义
  eq(remind.truncateToUnits('两个汉字', 5).text, '两…', '5 权重只放得下 1 个汉字 + 省略号');

  // 非法槽位（拼错）→ 忽略该字段 + warning，不静默改成默认语义
  const bad = remind.resolveFieldMap({ thing1: 'titel', time2: 'due' });
  eq(Object.keys(bad.fieldMap), ['time2'], '槽位写错的字段被忽略');
  ok(bad.warnings.length === 1, '给了一条 warning');
  ok(bad.warnings[0].indexOf('titel') !== -1, 'warning 点名那个不认识的槽位');

  // 字段名形状不对 → 忽略；全无效时回退默认映射（功能不整体挂掉）
  const badName = remind.resolveFieldMap({ 'thing-1': 'title' });
  eq(badName.fieldMap, remind.DEFAULT_FIELD_MAP, '全部无效时回退默认映射');
  eq(badName.warnings.length, 2, '一条说明字段名形状不对，一条说明已回退');
  ok(badName.warnings[0].indexOf('thing-1') !== -1, '警告里点名那个写错的字段');

  // JSON 串（环境变量只能是字符串）能解析
  eq(remind.resolveFieldMap('{"thing2":"title"}').fieldMap, { thing2: 'title' }, 'JSON 字符串可解析');
  // JSON 写坏了 → 回退默认 + warning
  const broken = remind.resolveFieldMap('{不是 JSON');
  eq(broken.fieldMap, remind.DEFAULT_FIELD_MAP, '坏 JSON 回退到默认映射');
  ok(broken.warnings.length === 1, '并且说明为什么');
  eq(remind.resolveFieldMap('').warnings, [], '空配置不产生警告');

  // 换成"不合适"的字段类型要给警告（character_string 放标题是典型的选错字段）
  const awkward = remind.resolveFieldMap({ character_string1: 'title' });
  ok(awkward.warnings.length === 1, 'character_string 放标题 → 一条警告');
  ok(awkward.warnings[0].indexOf('character_string1') !== -1, '点名那个字段');
});

// --- 10.5 错误分类 ---------------------------------------------------------
testCase('10.9 classifySendError：43101 / 47003 / 40001 / 42001 / 未知', () => {
  const rejected = remind.classifySendError({ errCode: 43101, errMsg: 'user refuse to accept the msg' });
  eq(rejected.kind, 'user_rejected', '43101 = 用户拒收');
  eq(rejected.disableUser, true, '43101 必须关掉该用户的提醒（否则每 5 分钟白跑）');
  eq(rejected.retry, false, '不重试');
  ok(rejected.hint.indexOf('43101') !== -1, '提示里带错误码，便于对照排查');

  const field = remind.classifySendError({ errCode: 47003, errMsg: 'argument invalid! data.thing1.value invalid' });
  eq(field.kind, 'invalid_field', '47003 = 模板参数不合规');
  eq(field.checkFieldMap, true, '47003 要提示去核对字段映射');
  eq(field.disableUser, false, '47003 是配置问题，不能关用户');
  ok(field.hint.indexOf('REMIND_FIELD_MAP') !== -1, '提示直指字段映射');
  ok(field.hint.indexOf('argument invalid') !== -1, '原文保留（这是唯一的线索）');

  const token = remind.classifySendError({ errCode: 40001 });
  eq(token.kind, 'token', '40001 = token 问题');
  eq(token.retry, true, '40001 要求重试一次');
  eq(remind.classifySendError({ errCode: 42001 }).kind, 'token', '42001 同类');
  eq(remind.classifySendError({ errCode: 42001 }).retry, true, '42001 同样重试');

  const unknown = remind.classifySendError({ errCode: 99999, errMsg: '某个没见过的错' });
  eq(unknown.kind, 'unknown', '其它码归为未知');
  eq(unknown.disableUser, false, '未知错误不关用户（不放大故障）');
  eq(unknown.retry, false, '未知错误不重试');
  ok(unknown.hint.indexOf('99999') !== -1, '原文与码都记下来');

  // 连码都拿不到（云调用不可用 / 网络断）→ 走 unknown，且原文是唯一线索
  const noCode = remind.classifySendError({ errMsg: 'connect ECONNREFUSED' });
  eq(noCode.code, null, '拿不到码');
  eq(noCode.kind, 'unknown', '也算未知');
  ok(noCode.hint.indexOf('ECONNREFUSED') !== -1, '保留原文');
});

testCase('10.10 extractErrCode / scrubSecrets：错误码形状与脱敏', () => {
  // 微信云调用的错误码可能藏在 errMsg 里，四种形状都要认得
  eq(remind.extractErrCode({ errCode: 43101 }), 43101, 'errCode');
  eq(remind.extractErrCode({ errcode: '47003' }), 47003, 'errcode 字符串');
  eq(remind.extractErrCode({ data: { errcode: 40001 } }), 40001, '嵌在 data 里');
  eq(remind.extractErrCode({ errMsg: 'errCode: 43101, errMsg: fail' }), 43101, '藏在 errMsg 文本里');
  eq(remind.extractErrCode({ errMsg: '没有数字' }), null, '挖不到就是 null');
  eq(remind.extractErrCode(null), null, 'null 安全');

  // 脱敏：错误信息会返回给前端展示，不能把任务标题 / 用户标识带出去
  ok(remind.scrubSecrets('access_token=abcdefghijklmn').indexOf('abcdefghijklmn') === -1, '抹掉 access_token');
  ok(remind.scrubSecrets('touser=oABCDEFGHIJKLMN').indexOf('oABCDEFGHIJKLMN') === -1, '抹掉 touser');
  const scrubbed = remind.scrubSecrets('argument invalid! data.thing1.value=保密标题');
  ok(scrubbed.indexOf('保密标题') === -1, '抹掉模板内容');
  ok(scrubbed.indexOf('thing1') !== -1, '但保留字段名（排查要用）');
  eq(remind.scrubSecrets('普通错误，没有凭证'), '普通错误，没有凭证', '正常文本不受影响');
});

testCase('10.11 sentKeysFromRows：只有**成功**的记录算"已提醒"', () => {
  const rows = [
    { due_key: 'a@1', ok: true },
    { due_key: 'b@2', ok: false, err_code: 47003 }, // 失败：用户改好模板后应该还能再发
    { due_key: 'c@3', ok: true },
    { due_key: '', ok: true },
    null,
  ];
  const keys = remind.sentKeysFromRows(rows);
  eq(keys.size, 2, '只收 ok:true 的 2 条');
  ok(keys.has('a@1') && keys.has('c@3'), '成功的在里面');
  ok(!keys.has('b@2'), '失败的**不**在里面（否则改好模板后这条提醒永远发不出去）');
  eq(remind.sentKeysFromRows(null).size, 0, 'null 安全');
});

// --- 10.6 纯函数小件 -------------------------------------------------------
testCase('10.12 humanizeLeft / formatDueText / truncateByCodePoint', () => {
  eq(remind.humanizeLeft(0), '不到 1 分钟', '0 分钟');
  eq(remind.humanizeLeft(5), '5 分钟', '分钟');
  eq(remind.humanizeLeft(60), '1 小时', '整小时不带 0 分钟');
  eq(remind.humanizeLeft(90), '1 小时 30 分钟', '小时 + 分钟');
  eq(remind.humanizeLeft(1440), '1 天', '24 小时进成 1 天');
  eq(remind.humanizeLeft(-5), '不到 1 分钟', '负数不出现"-5 分钟"');
  eq(remind.formatDueText(bjMs('2026-10-16', '09:05')), '2026-10-16 09:05', '补零');
  // emoji 不能被 slice 拦腰切断（半个代理对会让微信侧校验/显示出问题）
  const emoji = '🎓🎓🎓🎓🎓';
  eq(Array.from(remind.truncateByCodePoint(emoji, 3)).length, 3, '按码点截断');
  eq(remind.truncateByCodePoint(emoji, 3), '🎓🎓…', 'emoji 完整保留');
  eq(remind.truncateByCodePoint('abc', 20), 'abc', '没超长就不动它');
});

// --- 10.8 字段类型解析（微信订阅消息的 key 前缀决定类型） -------------------
testCase('10.12b fieldTypeOf：按 key 前缀解析类型（含带下划线的多词类型）', () => {
  // 【为什么这条单独立一个用例】类型由**前缀**决定，而前缀里有下划线
  // （short_thing19 / character_string1）—— 用 `[a-z]+` 去切会把它们切错，
  // 于是走错长度约束（5 字 vs 32 字），最后以 47003 的形式暴露在真机上。
  eq(remind.fieldTypeOf('thing2'), 'thing', 'thing2 → thing');
  eq(remind.fieldTypeOf('short_thing19'), 'short_thing', 'short_thing19 → short_thing');
  eq(remind.fieldTypeOf('date4'), 'date', 'date4 → date');
  eq(remind.fieldTypeOf('time2'), 'time', 'time2 → time');
  eq(remind.fieldTypeOf('character_string1'), 'character_string', 'character_string1 → character_string');
  eq(remind.fieldTypeOf('phrase5'), 'phrase', 'phrase5 → phrase');
  eq(remind.fieldTypeOf('number3'), 'number', 'number3 → number');
  eq(remind.fieldTypeOf('amount1'), 'amount', 'amount1 → amount');
  eq(remind.fieldTypeOf('name1'), 'name', 'name1 → name');
  eq(remind.fieldTypeOf('phone_number1'), 'phone_number', 'phone_number1 → phone_number');
  eq(remind.fieldTypeOf('car_number1'), 'car_number', 'car_number1 → car_number');
  eq(remind.fieldTypeOf('letter1'), 'letter', 'letter1 → letter');
  eq(remind.fieldTypeOf('symbol1'), 'symbol', 'symbol1 → symbol');

  // 各类型的长度上限（数值来自官方示例与通行规则，见代码注释里的诚实标注）
  eq(remind.THING_MAX, 20, 'thing ≤ 20');
  eq(remind.SHORT_THING_MAX, 5, 'short_thing ≤ 5');
  eq(remind.PHRASE_MAX, 5, 'phrase ≤ 5');
  eq(remind.CHARACTER_STRING_MAX, 32, 'character_string ≤ 32');
  eq(remind.ruleForType('thing').max, 20, 'thing 规则的 max');
  eq(remind.ruleForType('short_thing').max, 5, 'short_thing 规则的 max');
  eq(remind.ruleForType('short_thing').allowSpace, false, 'short_thing 不允许空格');
  eq(remind.ruleForType('thing').allowSpace, true, 'thing 允许空格');

  // 未知类型：**不抛错**，按"原样 + 只限长度"处理
  // 【为什么要直接测 ruleForType 而不是拼一个假字段名】resolveFieldMap 白名单在前，
  // "能过白名单但类型未知"这条路径在真实调用里到不了 —— 留 ruleForType 的兜底是为了
  // 将来有人往 FIELD_TYPE_RULES 里加类型时不会因为漏了分支而抛错。这里直接测这层兜底。
  const unknown = remind.ruleForType('some_future_type');
  eq(unknown.unknown, true, '未知类型被标记（调用方据此记 warning）');
  eq(unknown.max, remind.UNKNOWN_FIELD_MAX, '未知类型给保守上限，而不是不截断');
  eq(remind.UNKNOWN_FIELD_MAX, 5, '保守上限就是最严的 5');
  eq(remind.ruleForType('thing').unknown, undefined, '已知类型不会被标成 unknown');

  // 冷门但合法的类型（phone_number / car_number …）必须被正常接受，不能当成未知类型
  eq(remind.fieldTypeOf('phone_number1'), 'phone_number', 'phone_number1 解析正确');
  ok(!remind.ruleForType('phone_number').unknown, 'phone_number 是已知类型');
  ok(!remind.ruleForType('car_number').unknown, 'car_number 是已知类型');
  ok(!remind.ruleForType('amount').unknown, 'amount 是已知类型');
  const cold = remind.buildMessageData(
    { title: '提交实验报告', type: 'ddl' }, bjMs('2026-09-28', '12:00'),
    { thing1: 'title', phone_number1: 'title' }, { now: bjMs('2026-09-28', '12:00') }
  );
  eq(Object.keys(cold.data).sort(), ['phone_number1', 'thing1'], '冷门类型字段照样产出，不抛错');
  eq(cold.warnings, [], '冷门但合法的类型不该产生警告');
  // 每个类型都有自己的上限，逐条对一遍（数值错了就会在真机上以 47003 暴露）
  eq(remind.ruleForType('character_string').max, 32, 'character_string ≤ 32');
  eq(remind.ruleForType('number').max, 32, 'number ≤ 32');
  eq(remind.ruleForType('amount').max, 12, 'amount ≤ 12');
  eq(remind.ruleForType('name').max, 10, 'name ≤ 10');
  eq(remind.ruleForType('car_number').max, 8, 'car_number ≤ 8');
  eq(remind.ruleForType('letter').max, 6, 'letter ≤ 6');
  eq(remind.ruleForType('symbol').max, 5, 'symbol ≤ 5');
});

// --- 10.9 端到端（内存假数据库 + 打桩出口） --------------------------------

// --- 10.7 端到端（内存假数据库 + 打桩出口） --------------------------------
/**
 * 造一份"开好了提醒"的假库。
 *
 * @param {object} cfg { tasks, quota, leadMin, enabled, reminders }
 */
function remindWorld(cfg) {
  const c = cfg || {};
  const db = createFakeDb({
    settings: [Object.assign({
      _openid: 'me',
      remind_enabled: c.enabled === undefined ? true : c.enabled,
      remind_quota: c.quota === undefined ? 3 : c.quota,
      lead_min: c.leadMin === undefined ? 60 : c.leadMin,
    })],
    tasks: c.tasks || [],
  });
  db.store.reminders = c.reminders || []; // 幂等记录表（集合名与云函数里的常量一致）
  return db;
}

/** 打桩发送出口：把每次"发出去什么"记下来，并返回调用方指定的结果 */
function stubSender(outcomes) {
  const calls = [];
  const queue = Array.isArray(outcomes) ? outcomes.slice() : [{ ok: true }];
  const fn = async (openid, templateId, page, data) => {
    calls.push({ openid, templateId, page, data });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return Object.assign({ ok: true, errCode: null, errMsg: '', raw: null }, next || {});
  };
  fn.calls = calls;
  return fn;
}

/** 跑一轮扫描（固定 now，注入模板 ID 与打桩出口） */
async function runScan(db, sender, extra) {
  const realSend = remind.sendSubscribeMessage;
  remind.sendSubscribeMessage = sender;
  try {
    return await remind.actionScan(db, '', {}, Object.assign({
      now: R_NOW,
      env: { REMIND_TEMPLATE_ID: 'TPL-TEST-0001', REMIND_PAGE: '/pages/tasks/tasks' },
    }, extra || {}));
  } finally {
    remind.sendSubscribeMessage = realSend;
  }
}

testCaseAsync('10.13 端到端：发一条 → 扣额度 → 第二遍不再发（幂等）', async () => {
  const dueAt = R_NOW + 5 * MIN;
  const db = remindWorld({ quota: 3, tasks: [ddlAt(dueAt, { _id: 'tk1', title: '交实验报告' })] });
  const sender = stubSender([{ ok: true }]);

  const first = await runScan(db, sender);
  eq(first.ok, true, '第一轮成功');
  eq(first.scanned, 1, '扫了 1 个开了提醒的用户');
  eq(first.sent, 1, '发了 1 条');
  eq(first.failed, 0, '没有失败');
  eq(first.errors, [], 'errors 为空');
  eq(sender.calls.length, 1, '真的调了下发出口');
  eq(sender.calls[0].openid, 'me', '发给谁');
  eq(sender.calls[0].templateId, 'TPL-TEST-0001', '模板 ID 从环境变量来（前端不硬编码）');
  eq(sender.calls[0].page, '/pages/tasks/tasks', '跳转页');
  eq(sender.calls[0].data.thing2.value, '交实验报告', '模板 data 里的标题（不带尾巴）');
  eq(remind.fieldUnits(sender.calls[0].data.thing2.value) <= remind.THING_MAX, true, '标题权重合规');
  eq(sender.calls[0].data.date4.value, remind.formatDateByStyle(dueAt, 'date'), 'date4 是截止时刻（默认候选=纯日期）');
  eq(sender.calls[0].data.short_thing19.value, '截止', 'short_thing19 是任务类别');
  eq(db.store.settings[0].remind_quota, 2, '发一条扣一条额度');
  eq(db.store.reminders.length, 1, '落了一条已发记录');
  eq(db.store.reminders[0].ok, true, '记的是成功');
  eq(db.store.reminders[0].due_key, `tk1@${bjDay(dueAt)} ${bjClock(dueAt)}`, '记的键就是幂等键');
  eq(db.store.reminders[0]._openid, 'me', '记录带 _openid（服务端显式写入）');

  // 第二遍：同一批任务、同一个 now —— 幂等必须生效
  const second = await runScan(db, sender);
  eq(second.sent, 0, '第二遍 sent 必须为 0');
  eq(second.skipped_reasons.already_sent, 1, '唯一的候选被记为 already_sent');
  eq(sender.calls.length, 1, '没有第二次下发调用');
  eq(db.store.settings[0].remind_quota, 2, '额度没有再被扣');
  eq(db.store.reminders.length, 1, '没有重复落记录');
});

testCaseAsync('10.14 额度：quota=0 不发送；quota=1 发一条后变 0，第二条被跳过', async () => {
  // ① quota = 0：**绝不能**调用下发接口（调了会把用户的授权打穿）
  const zeroDue = R_NOW + 5 * MIN;
  const dbZero = remindWorld({ quota: 0, tasks: [ddlAt(zeroDue, { _id: 'z1' })] });
  const senderZero = stubSender([{ ok: true }]);
  const rZero = await runScan(dbZero, senderZero);
  eq(senderZero.calls.length, 0, 'quota=0 时一次都没调微信');
  eq(rZero.sent, 0, 'sent 为 0');
  eq(rZero.skipped_reasons.no_quota, 1, '如实记成 no_quota');
  eq(rZero.failed, 0, '这不算失败（是预期内的额度用完）');
  eq(dbZero.store.settings[0].remind_quota, 0, '额度没被扣成负数');
  eq(dbZero.store.reminders.length, 0, '不发送就不落"已发"记录（下次还有机会）');

  // ② quota = 1，两条候选：发第一条，第二条因额度耗尽被跳过
  const dbOne = remindWorld({
    quota: 1,
    tasks: [ddlAt(R_NOW + 5 * MIN, { _id: 'q1' }), ddlAt(R_NOW + 10 * MIN, { _id: 'q2' })],
  });
  const senderOne = stubSender([{ ok: true }]);
  const rOne = await runScan(dbOne, senderOne);
  eq(rOne.sent, 1, '只发出去 1 条');
  eq(senderOne.calls.length, 1, '只调了一次微信');
  eq(senderOne.calls[0].data.thing2.value.indexOf('任务') === 0, true, '发的是最急的那条');
  eq(rOne.skipped_reasons.no_quota, 1, '第二条记 no_quota');
  eq(dbOne.store.settings[0].remind_quota, 0, '额度归零');
  eq(dbOne.store.reminders.length, 1, '只落一条记录');
});

testCaseAsync('10.15 43101：用户拒收 → 关掉该用户的提醒、不抛异常、错误可读', async () => {
  const dueAt = R_NOW + 5 * MIN;
  const db = remindWorld({ quota: 3, tasks: [ddlAt(dueAt, { _id: 'r1' })] });
  const sender = stubSender([{ ok: false, errCode: 43101, errMsg: 'user refuse to accept the msg' }]);

  const result = await runScan(db, sender); // 不抛异常就是通过（抛了会被 testCaseAsync 记成失败）
  eq(result.ok, true, '整轮不炸');
  eq(result.sent, 0, '没发成功');
  eq(result.failed, 1, '记了 1 条失败');
  ok(result.errors.length === 1, 'errors 里有 1 条');
  ok(result.errors[0].indexOf('43101') !== -1, '错误里能看出是 43101');
  eq(db.store.settings[0].remind_enabled, false, '已把该用户的提醒关掉（否则每 5 分钟白跑一次）');
  ok(String(db.store.settings[0].remind_disabled_reason).indexOf('43101') !== -1, '关掉的原因写进库里，用户问起来有据可查');
  eq(db.store.reminders.length, 1, '失败也落记录');
  eq(db.store.reminders[0].ok, false, '记的是 failed');
  eq(db.store.reminders[0].err_code, 43101, '记下错误码');

  // 关掉之后下一轮不该再扫这个人（连查任务都省了）
  const sender2 = stubSender([{ ok: true }]);
  const second = await runScan(db, sender2);
  eq(second.scanned, 0, '被关掉的用户不再被扫描');
  eq(sender2.calls.length, 0, '不会再打扰微信');

  // 用户重新授权后应能再收到这条提醒：失败记录**不能**算作"已提醒"
  db.store.settings[0].remind_enabled = true;
  db.store.settings[0].remind_quota = 1;
  const sender3 = stubSender([{ ok: true }]);
  const third = await runScan(db, sender3);
  eq(third.sent, 1, '重新授权后这条提醒还能发出去（失败记录不挡幂等）');
});

testCaseAsync('10.16 47003：错误里能看出是模板字段问题', async () => {
  const db = remindWorld({ quota: 3, tasks: [ddlAt(R_NOW + 5 * MIN, { _id: 'f1' })] });
  const sender = stubSender([{
    ok: false,
    errCode: 47003,
    errMsg: 'argument invalid! data.thing3.value invalid rid: xxxxx',
  }]);

  const result = await runScan(db, sender);
  eq(result.ok, true, '整轮不炸');
  eq(result.failed, 1, '记了失败');
  const text = result.errors.join(' | ');
  ok(text.indexOf('47003') !== -1, '错误里带 47003');
  ok(text.indexOf('REMIND_FIELD_MAP') !== -1, '提示去核对字段映射');
  eq(db.store.settings[0].remind_enabled, true, '47003 是配置问题，**不**关用户的提醒');
  eq(db.store.reminders[0].err_code, 47003, '失败也留痕，便于事后排查');

  // ===== 核心：47003 必须能自证"哪个字段、发了什么值" =====
  // 模板字段的长度/格式约束是平台侧规则，本地无法完全预演 —— 这条留痕是唯一的自证手段。
  const record = db.store.reminders[0];
  const recordText = String(record.error);
  ok(recordText.indexOf('thing2=') !== -1, '失败记录里有 thing2 的字段名');
  ok(recordText.indexOf('date4=') !== -1, '失败记录里有 date4 的字段名');
  ok(recordText.indexOf('short_thing19=') !== -1, '失败记录里有 short_thing19 的字段名');
  ok(recordText.indexOf('任务') !== -1, '失败记录里带上**实际发出去的值**（这才是线索）');
  ok(recordText.indexOf('2026年') !== -1, '日期字段的值也在（能看出格式对不对）');
  ok(recordText.indexOf('本次发出的字段与值') !== -1, '并且明确标出这一段是什么');

  // 结构化留痕：逐字段列出，控制台里好核对
  ok(Array.isArray(record.sent_fields), 'sent_fields 是数组');
  eq(record.sent_fields.map((f) => `${f.key}:${f.type}`),
    ['thing2:thing', 'date4:date', 'short_thing19:short_thing'], 'sent_fields 含 key 与类型');
  eq(record.sent_fields[0].value, '任务', 'sent_fields 含最终值');

  // 安全：不能把 openid 明文或任何密钥带进失败记录 / 错误返回
  // 【注意断言的写法】不能简单找 'me' 子串 —— 任务标题默认就是"任务"，
  // 而 'me' 会撞上英文单词。这里直接找"身份字段"的形状。
  ok(recordText.indexOf('openid') === -1 && recordText.indexOf('_openid') === -1,
    '失败记录文本里不出现身份字段名，更不会有它的值');
  ok(recordText.indexOf('Tie4p47PRO5I8cuu8LktzXgjgfvTJL4HrkAXiZwHY2s') === -1, '失败记录里不含真实模板 ID 之外的任何密钥');
  ok(recordText.indexOf('access_token') === -1, '不含凭证字段');
  ok(String(record._openid) === 'me', 'openid 只出现在 _openid 字段（那是必需的归属字段，不是日志文本）');
  ok(text.indexOf('openid=me') === -1 && text.indexOf('_openid') === -1, '错误文本里不拼 openid');
  // 错误返回里也带上字段与值，用户在控制台点一次测试就能看到
  ok(text.indexOf('thing2=') !== -1, 'scan 的 errors 里同样带字段与值');
});

testCaseAsync('10.16b actionTest 的 47003 失败也能自证：返回与记录里都有字段与值', async () => {
  const deps = { env: { REMIND_TEMPLATE_ID: 'TPL-REAL' }, now: R_NOW };
  const realSend = remind.sendSubscribeMessage;
  try {
    const db = remindWorld({ quota: 2, tasks: [] });
    remind.sendSubscribeMessage = stubSender([{
      ok: false,
      errCode: 47003,
      errMsg: 'argument invalid! data.date4.value invalid rid: abcdef',
    }]);
    const failed = await remind.actionTest(db, 'me', {}, deps);
    eq(failed.ok, false, '如实报失败');
    ok(failed.error.indexOf('thing2=') !== -1, '失败返回里带 thing2 的值');
    ok(failed.error.indexOf('date4=') !== -1, '并且带 date4 的值（模板字段对照全靠它）');
    // 候选表会一路试下去，所以这里断言"值出现在 error 里"，不锁死是哪一种形状
    ok(/date4=(\[纯日期\])?\d{4}/.test(String(failed.error)), 'date4 的值是某种日期形状');

    const record = db.store.reminders[0];
    eq(record.ok, false, '失败记录');
    eq(record.type, 'test', '标明是测试');
    ok(String(record.error).indexOf('date4=') !== -1, '记录里也有字段与值');
    ok(Array.isArray(record.sent_fields) && record.sent_fields.length === 3, 'sent_fields 三个字段都在');
  } finally {
    remind.sendSubscribeMessage = realSend;
  }
});

testCaseAsync('10.16c 配置类失败要把额度还回去（否则模板配错会烧光用户授权）', async () => {
  // 【为什么这条重要】deliverOne 是"先扣额度再发送"。47003 这类参数/配置错误在微信侧
  // **根本没消耗额度**，扣掉就是白扣；模板配错一次，之后每轮扫描（每 5 分钟）都白扣一次，
  // 几轮就把用户的授权次数烧光 —— 等配置改对反而发不出去了。
  const dueAt = R_NOW + 5 * MIN;

  // ① 47003（配置/参数类）→ 还回去
  const db = remindWorld({ quota: 3, tasks: [ddlAt(dueAt, { _id: 'q1' })] });
  const sender = stubSender([{ ok: false, errCode: 47003, errMsg: 'thing2 invalid' }]);
  const result = await runScan(db, sender);
  eq(result.failed, 1, '记了 1 条失败');
  eq(result.quota_refunded, 1, 'scan 汇总里报告"退了 1 次"');
  eq(db.store.settings[0].remind_quota, 3, '额度被退回：还是 3（扣了又还）');
  const rec = db.store.reminders[0];
  eq(rec.quota_refunded_count, 1, '失败记录里标明额度已回退（否则"额度为什么没少"会查不出来）');
  ok(String(rec.error).indexOf('退回') !== -1 || String(result.errors[0]).indexOf('退回') !== -1,
    '错误文案里也说明了这次没占额度');
  // 分类函数本身
  eq(remind.shouldRefundQuota(remind.classifySendError({ errCode: 47003 })), true, '47003 → 退');
  eq(remind.shouldRefundQuota(remind.classifySendError({ errCode: 43101 })), false, '43101 → 不退（用户确实拒收）');
  eq(remind.shouldRefundQuota(remind.classifySendError({ errCode: 40001 })), false, '40001 → 不退（可能已消耗）');
  eq(remind.shouldRefundQuota(remind.classifySendError({ errCode: 99999 })), true, '未知错误 → 退（宁可多还，不白扣）');
  eq(remind.shouldRefundQuota(remind.classifySendError({ errMsg: '网络断了' })), true, '无码的网络类 → 退');

  // ② 网络/未知类失败**不还**（保持原来的"宁可少算不可多发"）
  const dbToken = remindWorld({ quota: 3, tasks: [ddlAt(dueAt, { _id: 'q2' })] });
  const tokenSender = stubSender([{ ok: false, errCode: 40001, errMsg: 'access_token expired' }]);
  const tokenResult = await runScan(dbToken, tokenSender);
  eq(tokenResult.failed, 1, 'token 失败也记失败');
  eq(tokenResult.quota_refunded, 0, 'token 类不退还');
  eq(dbToken.store.settings[0].remind_quota, 2, '额度保持在扣减后的 2');
  eq(dbToken.store.reminders[0].quota_refunded_count, 0, '记录里写明没退');

  // ③ 43101 也不退（用户拒收，额度本来就是无效的）
  const dbRej = remindWorld({ quota: 3, tasks: [ddlAt(dueAt, { _id: 'q3' })] });
  const rejSender = stubSender([{ ok: false, errCode: 43101, errMsg: 'user refuse' }]);
  const rejResult = await runScan(dbRej, rejSender);
  eq(rejResult.quota_refunded, 0, '43101 不退还');
  eq(dbRej.store.settings[0].remind_quota, 2, '额度保持在 2');
  eq(dbRej.store.settings[0].remind_enabled, false, '并且照旧关掉该用户的提醒');

  // ④ 退还不能越过总额上限（反复退不会把额度刷上去）
  const dbCap = remindWorld({ quota: remind.MAX_QUOTA, tasks: [ddlAt(dueAt, { _id: 'q4' })] });
  const capSender = stubSender([{ ok: false, errCode: 47003, errMsg: 'x' }]);
  await runScan(dbCap, capSender);
  eq(dbCap.store.settings[0].remind_quota, remind.MAX_QUOTA, '退回到封顶值就停住，不会越界');

  // ⑤ 连续两轮都失败：额度不减少（这正是"烧光授权"那个 bug 的回归）
  const dbTwice = remindWorld({ quota: 2, tasks: [ddlAt(dueAt, { _id: 'q5' })] });
  const twiceSender = stubSender([{ ok: false, errCode: 47003, errMsg: 'x' }]);
  await runScan(dbTwice, twiceSender);
  await runScan(dbTwice, twiceSender);
  eq(dbTwice.store.settings[0].remind_quota, 2, '连跑两轮 47003，额度仍是 2（没有被烧掉）');
});

testCaseAsync('10.16d date 形状候选表：逐个试 + 记住赢家（不再靠猜格式）', async () => {
  // ===========================================================================
  // 【真机三轮才逼出来的机制】
  //   第 1 轮：thing2 超长被拒 → 权重口径已修
  //   第 2 轮：2026年10月13日00:09（时刻补零）→ invalid value of property: data.date4
  //   第 3 轮：2026年10月13日0:21（时刻不补零）→ 仍然被拒
  // 微信**没给期望形状**，而每次往返都要"改一版 → 部署 → 点一次测试"。
  // 所以改成一次走完候选表：第一个成功的就是答案，记进 remind_date_style。
  // ===========================================================================
  const DATE4_REJECT = {
    ok: false,
    errCode: 47003,
    errMsg: 'openapi.subscribeMessage.send fail: argument invalid data format,'
      + ' invalid value of property: data.date4',
  };
  const dueAt = R_NOW + 5 * MIN;

  // ===== ① 候选表本身：有序、名字唯一、每项都能生成合规的值 =====
  const names = remind.DATE_STYLE_NAMES;
  eq(names.length >= 6, true, '候选表至少有 6 项');
  eq(names[0], 'date', '第 1 项是纯日期（最保守、真机唯一没试过的方向）');
  eq(names.indexOf('iso') !== -1, true, '含 ISO 形状');
  eq(names.indexOf('slash') !== -1, true, '含斜杠形状');
  eq(names.indexOf('dot') !== -1, true, '含点分形状');
  eq(names.indexOf('datetime_space') !== -1, true, '含"日期 空格 时刻"（用来区分是空格还是时刻的问题）');
  eq(names.indexOf('datetime_pad') !== -1, true, '含补零时刻（真机已拒那一种）');
  eq(new Set(names).size, names.length, '名字唯一（要拿它去落库与上报，重名会串）');
  eq(names.length, remind.DATE_STYLE_CANDIDATES.length, 'NAMES 与 CANDIDATES 一一对应');
  // 每项都要有名字/标签/依据/验证状态，且能生成一个符合**自己形状**的值
  names.forEach((name) => {
    const candidate = remind.DATE_STYLE_CANDIDATES.find((item) => item.name === name);
    ok(!!candidate && candidate.label.length > 0, `${name} 有可读标签`);
    ok(!!candidate && candidate.reason.length > 0, `${name} 写了依据`);
    ok(!!candidate && ['untried', 'rejected', 'verified'].indexOf(candidate.verified) !== -1,
      `${name} 标了真机验证状态（不假装知道）`);
    const value = remind.formatDateByStyle(dueAt, name);
    ok(String(value).length > 0, `${name} 能生成值`);
    const re = remind.DATE_STYLE_SHAPES[name];
    ok(!!re && re.test(value), `${name} 的值符合自己的形状：${value}`);
  });
  // 真机已拒的那两种要如实标出来（这是"证据"，不是"猜测"）
  eq(remind.dateCandidateOf('datetime_pad').verified, 'rejected', 'datetime_pad 标注"真机已拒绝"');
  eq(remind.dateCandidateOf('date').verified, 'untried', '纯日期标注"尚未在真机验证"（不能吹成已验证）');

  // ===== ② 前两个候选被拒 → 自动试第 3 个 → 成功 → 记住赢家（iso）=====
  // 用"依次返回"的桩：第 1、2 次失败，第 3 次成功 —— 这正是真机上一次测试会走的路
  const db = remindWorld({ quota: 3, tasks: [ddlAt(dueAt, { _id: 'd1' })] });
  const sender = stubSender([DATE4_REJECT, DATE4_REJECT, { ok: true }]);
  const result = await runScan(db, sender);

  eq(result.ok, true, '整轮不炸');
  eq(result.sent, 1, 'sent = 1（试到第 3 个候选才成功）');
  eq(result.failed, 0, '不算失败');
  eq(sender.calls.length, 3, '一共发了 3 次（候选表逐个试）');
  eq(sender.calls.map((c) => c.data.date4.value), [
    remind.formatDateByStyle(dueAt, 'date'),
    remind.formatDateByStyle(dueAt, 'datetime_space'),
    remind.formatDateByStyle(dueAt, 'datetime_pad'),
  ], '第 1/2/3 次分别用候选表的第 1/2/3 项');
  eq(sender.calls[0].data.date4.value, remind.formatDateByStyle(dueAt, 'date'), '第 1 次就是纯日期');
  eq(db.store.settings[0][remind.SETTINGS_DATE_STYLE], 'datetime_pad',
    '赢家（第 3 个候选 datetime_pad）已落库');

  // ===== ③ 额度：最终净扣 = 成功条数（这里成功 1 条 → 净扣 1）=====
  eq(db.store.settings[0].remind_quota, 2, '额度净变化 = -1（两次失败都退回了，只有成功那次真扣）');
  eq(result.quota_refunded, 2, '汇总里报告退了 2 次（前两个候选各一次）');
  eq(db.store.reminders.length, 1, '只落一条**成功**记录（失败尝试不算"已提醒"）');
  eq(db.store.reminders[0].ok, true, '记录是成功');
  eq(db.store.reminders[0].date_style, 'datetime_pad', '记录标明最终用的候选');
  eq(db.store.reminders[0].attempts, 3, '记录标明试了 3 次');

  // ===== ④ 已记住赢家 → 第一次就用它（不再重复试前面的候选）=====
  const db2 = remindWorld({ quota: 3, tasks: [ddlAt(dueAt, { _id: 'd2' })] });
  db2.store.settings[0][remind.SETTINGS_DATE_STYLE] = 'iso'; // 模拟"上次试出来的赢家"
  const sender2 = stubSender([{ ok: true }]);
  const result2 = await runScan(db2, sender2);
  eq(result2.sent, 1, '已记住时也发成功');
  eq(sender2.calls.length, 1, '**只发一次**（不重复试前面的候选）');
  eq(sender2.calls[0].data.date4.value, remind.formatDateByStyle(dueAt, 'iso'), '第一次就用 ISO 形状');
  ok(/^\d{4}-\d{2}-\d{2}$/.test(sender2.calls[0].data.date4.value), '确实是 ISO 形状（含 -）');
  eq(db2.store.settings[0].remind_quota, 2, '额度同样只扣一次');

  // ===== ⑤ 点名 thing2 → **一个候选都不换**（只发一次）=====
  const db3 = remindWorld({ quota: 3, tasks: [ddlAt(dueAt, { _id: 'd3' })] });
  const sender3 = stubSender([{
    ok: false, errCode: 47003, errMsg: 'invalid value of property: data.thing2',
  }]);
  const result3 = await runScan(db3, sender3);
  eq(sender3.calls.length, 1, '**只发生一次发送**（点名 thing2 时绝不换候选）');
  eq(result3.sent, 0, '没发成功');
  eq(result3.failed, 1, '如实记 1 条失败');
  eq(result3.quota_refunded, 1, '配置类失败照旧退额度');
  eq(db3.store.settings[0].remind_quota, 3, '额度没被扣');
  eq(db3.store.settings[0][remind.SETTINGS_DATE_STYLE], undefined, '**没有**写入 date style（不是日期的问题）');

  // ===== ⑥ 全部候选失败 → error 里**每个候选**的值都在 =====
  const db4 = remindWorld({ quota: 3, tasks: [ddlAt(dueAt, { _id: 'd4', title: '交报告' })] });
  const sender4 = stubSender([DATE4_REJECT]); // 桩只有一项 → 每次都返回它
  const result4 = await runScan(db4, sender4);
  eq(sender4.calls.length, remind.DATE_STYLE_NAMES.length,
    `试完了整个候选表（${remind.DATE_STYLE_NAMES.length} 个）`);
  eq(result4.failed, 1, '记失败');
  eq(result4.quota_refunded, remind.DATE_STYLE_NAMES.length, '每个候选失败都退了一次额度');
  eq(db4.store.settings[0].remind_quota, 3, '净变化 0（全失败）');
  eq(db4.store.settings[0][remind.SETTINGS_DATE_STYLE], undefined, '全失败 → 不记任何赢家');
  const errText = result4.errors.join(' | ');
  ok(errText.indexOf(`${remind.DATE_STYLE_NAMES.length} 个候选都失败`) !== -1, '错误里说明候选都试完了');
  // 关键：**每个候选的形状名与值**都要在，否则"试过哪几种"这个结论就丢了
  remind.DATE_STYLE_NAMES.forEach((name) => {
    ok(errText.indexOf(name) !== -1, `error 里带候选名 ${name}`);
    ok(errText.indexOf(remind.formatDateByStyle(dueAt, name)) !== -1, `error 里带 ${name} 的实际值`);
  });
  const rec4 = db4.store.reminders[0];
  eq(Array.isArray(rec4.attempts), true, '失败记录里有结构化 attempts');
  eq(rec4.attempts.length, remind.DATE_STYLE_NAMES.length, 'attempts 覆盖每个候选');
  eq(rec4.attempts.map((a) => a.date_style), remind.DATE_STYLE_NAMES.slice(), 'attempts 按候选顺序记录形状');
  ok(String(rec4.error).indexOf('个候选都失败') !== -1, '记录里也保留"候选都试完"这个结论');
  ok(rec4.attempts[0].sent_fields.find((f) => f.key === 'date4').value.length > 0,
    'attempts[0] 保留了第 1 个候选的实际值（这就是证据）');

  // ===== ⑦ 判定函数：换候选的条件卡得很死 =====
  const fm = remind.DEFAULT_FIELD_MAP;
  eq(remind.extractOffendingField('invalid value of property: data.date4'), 'date4', '认 property: data.xxx 形状');
  eq(remind.extractOffendingField('argument invalid! data.thing3.value invalid'), 'thing3', '也认 data.xxx.value 形状');
  eq(remind.extractOffendingField('没有字段名的一句话'), '', '挖不到就给空串（不瞎猜）');
  eq(remind.nextDateStyle('date'), 'datetime_space', '第 1 项之后是第 2 项');
  eq(remind.nextDateStyle('dot'), '', '最后一项之后没有下一项（不会绕回开头 → 不会死循环）');
  eq(remind.decideNextDateStyle({
    ok: false, errCode: 47003, errMsg: 'invalid value of property: data.date4', fieldMap: fm, style: 'date',
  }).advance, true, '点名 date4 → 换下一个候选');
  eq(remind.decideNextDateStyle({
    ok: false, errCode: 47003, errMsg: 'invalid value of property: data.thing2', fieldMap: fm, style: 'date',
  }).advance, false, '点名 thing2 → 不换');
  eq(remind.decideNextDateStyle({
    ok: false, errCode: 43101, errMsg: 'data.date4', fieldMap: fm, style: 'date',
  }).advance, false, '43101 不是参数问题 → 不换');
  eq(remind.decideNextDateStyle({
    ok: false, errCode: 47003, errMsg: 'invalid value of property: data.time9',
    fieldMap: { time9: 'due' }, style: 'date',
  }).advance, false, '点名的字段类型不是 date（是 time）→ 不换');
  eq(remind.decideNextDateStyle({
    ok: false, errCode: 47003, errMsg: 'invalid value of property: data.date9', fieldMap: fm, style: 'date',
  }).advance, false, '点名的 date9 不在当前映射里 → 不换');
  eq(remind.decideNextDateStyle({
    ok: false, errCode: 47003, errMsg: 'invalid value of property: data.date4', fieldMap: fm, style: 'dot',
  }).advance, false, '已经是最后一个候选 → 不换（试完就停）');

  // ===== ⑧ 两个带时刻的候选：值能生成且形状正确（本地自检，不依赖网络）=====
  const spaceValue = remind.formatDateByStyle(dueAt, 'datetime_space');
  const padValue = remind.formatDateByStyle(dueAt, 'datetime_pad');
  ok(/^\d{4}年\d{1,2}月\d{1,2}日 \d{1,2}:\d{2}$/.test(spaceValue), `datetime_space 形状正确：${spaceValue}`);
  ok(/^\d{4}年\d{1,2}月\d{1,2}日\d{2}:\d{2}$/.test(padValue), `datetime_pad 形状正确：${padValue}`);
  ok(spaceValue.indexOf(' ') !== -1, 'datetime_space 真的含那个空格');
  ok(padValue.indexOf(' ') === -1, 'datetime_pad 不含空格');
  // 这两个只在"时刻"上不同，正好用来区分"是空格的问题还是时刻的问题"
  eq(spaceValue.replace(' ', ''), padValue.replace(/(\d{4}年\d{1,2}月\d{1,2}日)(\d):/, '$10$2'), '两者只差一个空格与补零');
});

testCaseAsync('10.17 未配模板：不扫描、不下发，并说清原因', async () => {
  const db = remindWorld({ quota: 3, tasks: [ddlAt(R_NOW + 5 * MIN, { _id: 'n1' })] });
  const sender = stubSender([{ ok: true }]);
  const result = await runScan(db, sender, { env: {} }); // 环境变量里没有模板 ID

  eq(result.ok, false, '如实返回不作为');
  ok(result.error.indexOf('REMIND_TEMPLATE_ID') !== -1, '说清是缺哪个环境变量');
  eq(sender.calls.length, 0, '没配模板时不去调用微信（避免无谓的失败日志）');
  eq(result.scanned, 0, '连用户表都没扫');
  eq(db.store.settings[0].remind_quota, 3, '额度没被动过');
});

testCaseAsync('10.18 单个用户失败不中断整轮：坏用户之后的好用户照样收到', async () => {
  const dueAt = R_NOW + 5 * MIN;
  const db = createFakeDb({
    settings: [
      { _openid: 'bad', remind_enabled: true, remind_quota: 2, lead_min: 60 },
      { _openid: 'good', remind_enabled: true, remind_quota: 2, lead_min: 60 },
    ],
    tasks: [ddlAt(dueAt, { _id: 'g1', _openid: 'good', title: '好用户的任务' })],
  });
  db.store.reminders = [];
  // 让第一个用户的查询抛错（删掉他的集合入口 → 用 get 抛错的桩不好做，
  // 这里改成：损坏 bad 用户那条任务数据之后仍然要能继续 —— 用"读库抛错"的桩更直接）
  const realCollection = db.collection;
  let firstTasksRead = true;
  db.collection = (name) => {
    const col = realCollection(name);
    if (name === 'tasks' && firstTasksRead) {
      firstTasksRead = false;
      return Object.assign({}, col, {
        where() { throw new Error('模拟某个用户读库失败'); },
      });
    }
    return col;
  };

  const sender = stubSender([{ ok: true }]);
  const result = await runScan(db, sender);
  eq(result.failed, 1, '坏用户记 1 条失败');
  ok(result.errors.join(' ').indexOf('模拟某个用户读库失败') !== -1, '失败原因如实带出来');
  eq(result.sent, 1, '排在后面的好用户照样收到（整轮没被打断）');
  eq(sender.calls.length, 1, '下发出口被调了一次');
  eq(sender.calls[0].data.thing2.value.indexOf('好用户的任务') !== -1, true, '发的确实是好用户那条');
});

testCaseAsync('10.19 actionStatus：没配模板 → ready=false 且理由是**人话**；配了就把 template_id 透出来', async () => {
  const db = remindWorld({ quota: 2, tasks: [] });

  // ① 没配模板
  const notReady = await remind.actionStatus(db, 'me', { env: {} });
  eq(notReady.ok, true, 'status 本身是成功的');
  eq(notReady.ready, false, '没配模板 → 不能发');
  eq(notReady.template_id, '', 'template_id 为空（前端据此判断"服务端没配"）');
  ok(/[\u4e00-\u9fa5]/.test(notReady.ready_reason), 'ready_reason 是中文人话');
  ok(notReady.ready_reason.indexOf('REMIND_TEMPLATE_ID') !== -1, '并且指出缺哪个环境变量（照着做就能修）');

  // ② 配了模板、开着、有额度
  const ready = await remind.actionStatus(db, 'me', { env: { REMIND_TEMPLATE_ID: 'TPL-9' } });
  eq(ready.ready, true, '三个条件都满足 → ready');
  eq(ready.template_id, 'TPL-9', 'template_id 必须透出来（前端靠它弹授权窗，不硬编码）');
  eq(ready.enabled, true, '开关状态');
  eq(ready.quota, 2, '剩余可下发次数');
  eq(ready.lead_min, 60, '提前量');
  eq(ready.page, remind.DEFAULT_PAGE, '没配 REMIND_PAGE 时用默认页');
  ok(ready.lead_options.indexOf(1440) !== -1, '把允许的提前量一并给前端（前端不用自己写死选项）');

  // ③ 模板配了但额度为 0 → 仍要提醒用户"去补授权"
  const empty = await remind.actionStatus(remindWorld({ quota: 0 }), 'me', { env: { REMIND_TEMPLATE_ID: 'TPL-9' } });
  eq(empty.ready, false, '没额度 → 发不出去');
  ok(empty.ready_reason.indexOf('授权') !== -1, '理由说的是"授权"这件事');
  ok(empty.ready_reason.indexOf('一次性订阅') !== -1, '并解释一次性订阅的规则（用户看得懂为什么）');

  // ④ 开关关着
  const off = await remind.actionStatus(remindWorld({ enabled: false }), 'me', { env: { REMIND_TEMPLATE_ID: 'TPL-9' } });
  eq(off.ready, false, '开关关着 → not ready');
  ok(off.ready_reason.indexOf('开启') !== -1, '理由指向"去打开开关"');

  // ⑤ 从没配过的用户（settings 里没有这一行）也不能炸
  const blank = await remind.actionStatus(createFakeDb({ settings: [], tasks: [] }), 'nobody', { env: { REMIND_TEMPLATE_ID: 'TPL-9' } });
  eq(blank.ok, true, '没有 settings 行也返回成功');
  eq(blank.enabled, false, '默认关闭（绝不默认给没授权的人发消息）');
  eq(blank.quota, 0, '默认 0 条额度');
  eq(blank.lead_min, remind.DEFAULT_LEAD_MIN, '默认提前量');
});

testCaseAsync('10.20 actionConfig：非法 lead_min 被拒绝并给出允许列表', async () => {
  const db = remindWorld({ quota: 1, leadMin: 60, tasks: [] });
  const deps = { env: { REMIND_TEMPLATE_ID: 'TPL-9' } };

  // 非法值一律拒绝（**不静默改成默认值** —— 那会让用户以为设置生效了）
  for (const bad of [17, 0, -30, 1441, 'soon', null]) {
    const r = await remind.actionConfig(db, 'me', { lead_min: bad }, deps);
    eq(r.ok, false, `lead_min=${JSON.stringify(bad)} 必须被拒绝`);
    ok(r.error.indexOf('15') !== -1 && r.error.indexOf('1440') !== -1, '错误里列出允许值');
  }
  eq(db.store.settings[0].lead_min, 60, '被拒绝时不改库（原值 60 还在）');

  // 合法值写进去
  const okLead = await remind.actionConfig(db, 'me', { lead_min: 30 }, deps);
  eq(okLead.ok, true, '30 合法');
  eq(db.store.settings[0].lead_min, 30, '写进库了');
  eq(okLead.lead_min, 30, '返回里也告诉前端生效值');

  // enabled 必须是布尔
  eq((await remind.actionConfig(db, 'me', { enabled: 'yes' }, deps)).ok, false, 'enabled 传字符串被拒绝');
  const off = await remind.actionConfig(db, 'me', { enabled: false }, deps);
  eq(off.ok, true, '关掉是合法的');
  eq(db.store.settings[0].remind_enabled, false, '库里关掉了');
  eq((await remind.actionConfig(db, 'me', {}, deps)).ok, false, '什么都没给 → 拒绝（不白写一次库）');
});

testCaseAsync('10.21 actionAck：count 超过 3 被拒绝；合法时累加并开启提醒', async () => {
  const deps = { env: { REMIND_TEMPLATE_ID: 'TPL-9' } };

  // ① 越界 / 非整数一律拒绝（否则改过的客户端能把自己刷成无限额度）
  const db = remindWorld({ quota: 0, enabled: false, tasks: [] });
  for (const bad of [0, 4, 10, -1, 1.5, '3', null]) {
    const r = await remind.actionAck(db, 'me', { count: bad }, deps);
    eq(r.ok, false, `count=${JSON.stringify(bad)} 必须被拒绝`);
    ok(r.error.indexOf('3') !== -1, '错误里说明上限是 3');
  }
  eq(db.store.settings[0].remind_quota, 0, '被拒绝时额度纹丝不动');
  eq(db.store.settings[0].remind_enabled, false, '被拒绝时开关也不动');

  // 特别地：字符串 "3" 也必须被拒绝（ack 是唯一能给额度加数的入口，只认数字）
  const strCount = await remind.actionAck(db, 'me', { count: '3' }, deps);
  eq(strCount.ok, false, 'count 传字符串 "3" 也要拒绝（不允许静默转成数字）');
  ok(strCount.error.indexOf('数字') !== -1, '错误文案说清要的是数字');

  // ② 合法：+2，并且顺手打开开关
  const ack2 = await remind.actionAck(db, 'me', { count: 2 }, deps);
  eq(ack2.ok, true, 'count=2 合法');
  eq(ack2.quota, 2, '额度 = 2');
  eq(ack2.added, 2, '实际加上 2');
  eq(db.store.settings[0].remind_enabled, true, 'ack 成功即视为用户已授权 → 打开开关');
  eq(db.store.settings[0].remind_quota, 2, '库里也是 2');

  // ③ 不传 count 默认 +1
  eq((await remind.actionAck(db, 'me', {}, deps)).quota, 3, '缺省 count = 1');

  // ④ 封顶：反复授权不能无限攒（否则变成骚扰）
  const dbCap = remindWorld({ quota: 9, tasks: [] });
  const capped = await remind.actionAck(dbCap, 'me', { count: 3 }, deps);
  eq(remind.MAX_QUOTA, 10, '总额上限 10');
  eq(capped.quota, 10, '封顶到 10');
  eq(capped.capped, true, '如实告诉前端"被截断了"（不是加满了 3）');
  eq(capped.added, 1, '实际只加上 1');

  // ⑤ ack 里也能顺手改提前量，但同样走白名单
  const dbLead = remindWorld({ quota: 0, tasks: [] });
  eq((await remind.actionAck(dbLead, 'me', { count: 1, lead_min: 7 }, deps)).ok, false, 'ack 里的非法 lead_min 也要拒绝');
  eq((await remind.actionAck(dbLead, 'me', { count: 1, lead_min: 1440 }, deps)).ok, true, '合法 lead_min 一起写');
  eq(dbLead.store.settings[0].lead_min, 1440, '提前量写进去了');
});

testCaseAsync('10.22 actionTest：测试下发默认不消耗额度，失败时给出排查线索', async () => {
  const deps = { env: { REMIND_TEMPLATE_ID: 'TPL-9', REMIND_PAGE: '/pages/me/me' }, now: R_NOW };
  const realSend = remind.sendSubscribeMessage;
  try {
    // ① 成功且不消耗额度
    const db = remindWorld({ quota: 2, tasks: [] });
    const sender = stubSender([{ ok: true }]);
    remind.sendSubscribeMessage = sender;
    const sent = await remind.actionTest(db, 'me', {}, deps);
    eq(sent.ok, true, '测试发送成功');
    eq(sent.sent, true, 'sent=true');
    eq(sent.quota_consumed, false, '默认**不**消耗额度（配置阶段不该把额度试光）');
    eq(sent.quota, 2, '额度没变');
    eq(db.store.settings[0].remind_quota, 2, '库里也没变');
    eq(sender.calls.length, 1, '确实调了下发出口');
    eq(sender.calls[0].templateId, 'TPL-9', '用环境变量里的模板');
    eq(sender.calls[0].page, '/pages/me/me', '用配置的跳转页');
    // preview 回的就是真发出去的 data —— 字段对不上时前端拿它逐字对照
    eq(sent.preview, sender.calls[0].data, 'preview 与真发的 data 一致');
    ok(sent.preview.thing2.value.indexOf('测试') !== -1, 'data 里能看出是测试消息');
    eq(sent.preview.thing2.value.indexOf('还剩'), -1, '标题栏不带"还剩…"（权重预算放不下）');
    ok(/^\d{4}年\d{1,2}月\d{1,2}日/.test(sent.preview.date4.value), 'date4 是年月日形状');
    eq(sent.preview.short_thing19.value, '截止', 'short_thing19 是类别');
    // 留痕明细同样回给调用方（比 preview 更适合逐条对照模板）
    eq(sent.fields.map((f) => `${f.slot}:${f.key}:${f.type}`),
      ['title:thing2:thing', 'due:date4:date', 'category:short_thing19:short_thing'], 'fields 留痕齐全');
    ok(sent.fields_text.indexOf('thing2=') !== -1, 'fields_text 一行可读');

    // ② 显式要求走真实扣减路径
    const db2 = remindWorld({ quota: 2, tasks: [] });
    const sender2 = stubSender([{ ok: true }]);
    remind.sendSubscribeMessage = sender2;
    const consumed = await remind.actionTest(db2, 'me', { consume_quota: true }, deps);
    eq(consumed.quota_consumed, true, 'consume_quota=true 时如实说消耗了');
    eq(db2.store.settings[0].remind_quota, 1, '扣了 1 条');

    // ③ 额度为 0 又要消耗 → 在调用微信**之前**就中止
    const db3 = remindWorld({ quota: 0, tasks: [] });
    const sender3 = stubSender([{ ok: true }]);
    remind.sendSubscribeMessage = sender3;
    const noQuota = await remind.actionTest(db3, 'me', { consume_quota: true }, deps);
    eq(noQuota.ok, false, '如实拒绝');
    eq(sender3.calls.length, 0, '没额度就不去调微信');

    // ④ 模板字段不对 → 失败原因必须能指导排查，并留痕
    const db4 = remindWorld({ quota: 2, tasks: [] });
    remind.sendSubscribeMessage = stubSender([{ ok: false, errCode: 47003, errMsg: 'data.date4.value invalid' }]);
    const bad = await remind.actionTest(db4, 'me', {}, deps);
    eq(bad.ok, false, '如实报失败');
    ok(bad.error.indexOf('47003') !== -1, '带上错误码');
    ok(bad.error.indexOf('REMIND_FIELD_MAP') !== -1, '指向该改哪里');
    ok(bad.error.indexOf('date4=') !== -1, '并且带上"哪个字段、发了什么值"（否则用户无从下手）');
    eq(db4.store.reminders.length, 1, '测试失败也留痕（这正是排查最需要的线索）');
    eq(db4.store.reminders[0].type, 'test', '记录标明是测试');

    // ⑤ 没配模板时不去调微信
    const db5 = remindWorld({ quota: 2, tasks: [] });
    const sender5 = stubSender([{ ok: true }]);
    remind.sendSubscribeMessage = sender5;
    const noTpl = await remind.actionTest(db5, 'me', {}, { env: {} });
    eq(noTpl.ok, false, '没配模板 → 拒绝');
    eq(sender5.calls.length, 0, '不去调微信');
  } finally {
    remind.sendSubscribeMessage = realSend;
  }
});

testCaseAsync('10.23 handleAction：无 action 当 scan；未知 action 报错并列出支持项', async () => {
  const db = remindWorld({ quota: 1, tasks: [ddlAt(R_NOW + 5 * MIN, { _id: 'h1' })] });
  const sender = stubSender([{ ok: true }]);
  const realSend = remind.sendSubscribeMessage;
  remind.sendSubscribeMessage = sender;
  try {
    const deps = { now: R_NOW, env: { REMIND_TEMPLATE_ID: 'TPL-9' } };
    // 定时触发器塞进来的 event 没有 action（甚至是 {}）—— 两种都必须当 scan
    const asEmpty = await remind.handleAction(db, '', {}, deps);
    eq(asEmpty.ok, true, '{} 当 scan');
    eq(asEmpty.sent, 1, '并且真的发了');
    const asTimerShape = await remind.handleAction(db, '', { Type: 'Timer', TriggerName: 'remindScan' }, deps);
    eq(asTimerShape.ok, true, '定时器形状的 event 也当 scan');
    eq(asTimerShape.sent, 0, '同一批任务第二遍不再发（幂等）');

    // 未知 action：要说清支持哪些，别让人猜
    const unknown = await remind.handleAction(db, 'me', { action: 'nope' }, deps);
    eq(unknown.ok, false, '未知 action → 失败');
    ok(unknown.error.indexOf('status') !== -1 && unknown.error.indexOf('ack') !== -1, '列出支持的 action');

    // 个人动作必须有身份（定时器没有 openid，但 status 这种必须要有）
    const noUser = await remind.handleAction(db, '', { action: 'status' }, deps);
    eq(noUser.ok, false, '没有身份不能读个人配置');

    // 身份类字段被显式丢弃（前端伪造 _openid 无效）
    const forged = await remind.handleAction(db, 'me', { action: 'status', _openid: 'someone-else' }, deps);
    eq(forged.ok, true, '伪造身份不影响调用');
    eq(forged.quota, 0, '读到的仍是自己的额度（第一轮已把 1 条用掉）');

    // db 不可用
    eq((await remind.handleAction(null, 'me', { action: 'status' }, deps)).ok, false, 'db 不可用 → 如实报错');
  } finally {
    remind.sendSubscribeMessage = realSend;
  }
});

testCaseAsync('10.24 scan 返回结构完整（前端/日志靠它排查）', async () => {
  const db = remindWorld({
    quota: 3,
    tasks: [
      ddlAt(R_NOW + 5 * MIN, { _id: 's1', title: '要发的' }),
      ddlAt(R_NOW + 5 * MIN, { _id: 's2', title: '要发的2' }),
      ddlAt(R_NOW + 5 * MIN, { _id: 's3', title: '要发的3' }),
      ddlAt(R_NOW + 5 * MIN, { _id: 's4', title: '被截断的' }), // 超过 MAX_PER_SCAN
      ddlAt(R_NOW + 200 * MIN, { _id: 's5' }), // 还早
      makeTask({ _id: 's6', type: 'event', date: bjDay(R_NOW), start_time: '10:05' }), // 非 ddl
    ],
  });
  const sender = stubSender([{ ok: true }]);
  const result = await runScan(db, sender);

  eq(result.ok, true, 'ok');
  eq(result.scanned, 1, 'scanned = 用户数');
  eq(result.sent, 3, 'sent = 真发出去几条（MAX_PER_SCAN 封顶）');
  eq(result.sent + result.skipped + result.failed > result.sent, true, 'skipped/failed 也都有数');
  eq(result.skipped_reasons.over_scan_limit, 1, '第 4 条最急的被 over_scan_limit');
  eq(result.skipped_reasons.too_early, 1, '还早的那条 too_early');
  eq(result.skipped_reasons.no_due_instant, 1, '非 ddl 那条 no_due_instant');
  eq(result.failed, 0, '没有失败');
  eq(result.lead_min, 60, '返回里说明本轮用的提前量');
  ok(typeof result.now === 'string' && result.now.indexOf('+08:00') !== -1, 'now 是北京时间字符串（日志可读）');
  eq(result.warnings, [], '默认字段映射不产生配置警告');
  eq(result.details.length, 3, 'details 里逐条留痕');
  ok(result.details.every((d) => d.action === 'sent'), '三条都是 sent');
});

testCaseAsync('10.25 scan：REMIND_FIELD_MAP 生效（换模板字段名不改代码）', async () => {
  const dueAt = R_NOW + 5 * MIN;
  const db = remindWorld({ quota: 2, tasks: [ddlAt(dueAt, { _id: 'fm1', title: '换模板也要能发' })] });
  const sender = stubSender([{ ok: true }]);
  const result = await runScan(db, sender, {
    env: {
      REMIND_TEMPLATE_ID: 'TPL-2',
      REMIND_FIELD_MAP: '{"thing5":"title","time6":"due"}',
    },
  });

  eq(result.sent, 1, '发了');
  eq(Object.keys(sender.calls[0].data).sort(), ['thing5', 'time6'], 'data 的键按环境变量映射来');
  eq(sender.calls[0].data.thing5.value, '换模板也要能发', 'thing5 拿标题');
  eq(sender.calls[0].data.time6.value, remind.formatDateByStyle(dueAt, 'date'), 'time6 拿时刻（time 类用同一个默认候选）');
  eq(result.warnings, [], '合法映射没有警告');

  // 写坏的映射：回退默认 + 警告（功能不整体挂掉）
  const db2 = remindWorld({ quota: 2, tasks: [ddlAt(dueAt, { _id: 'fm2' })] });
  const sender2 = stubSender([{ ok: true }]);
  const result2 = await runScan(db2, sender2, {
    env: { REMIND_TEMPLATE_ID: 'TPL-2', REMIND_FIELD_MAP: '{坏 JSON' },
  });
  eq(result2.sent, 1, '坏映射也照样发（用默认映射兜底）');
  ok(result2.warnings.length === 1, '但把问题明确告诉调用方');
  ok(result2.warnings[0].indexOf('REMIND_FIELD_MAP') !== -1, 'warning 点名字段映射');
  eq(Object.keys(sender2.calls[0].data).sort(), Object.keys(remind.DEFAULT_FIELD_MAP).sort(), '用的是默认字段');
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
