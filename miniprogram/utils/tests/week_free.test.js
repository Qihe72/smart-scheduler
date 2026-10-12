/**
 * utils/tests/week_free.test.js —— pages/week/week.js 的「空闲节数」统计（纯 node 单测）。
 *
 * 跑法：
 *     node utils/tests/week_free.test.js    # 只跑这一份（末尾打印通过数，失败退出码 1）
 *     node utils/tests/run.js               # 跑全部（本文件会被自动 require）
 *
 * ===========================================================================
 * 【这个文件为什么必须存在】
 * ===========================================================================
 *   「空闲 N 节」曾经在真机上错了整整一个版本：周一显示"空闲 10 节"，
 *   而卡片是 第3-4 / 第7-8 / 第11，被占 5 节 → 正确答案是 8。
 *   两列都恰好等于「总行数 − 卡片数」—— 因为它数的是"画了卡片的行"，
 *   而不是"被占用的行"：一条「第3-4节」只把任务放进**起始行**的桶，
 *   空闲统计却复用了同一批桶，于是第 4 节被当成了空着。
 *
 *   这个 bug 能溜过去的直接原因：当时六份测试全绿，但**没有任何一条断言**
 *   "空闲 = 总行数 − 被占用的行数"—— 所有人都在测"格子画得对不对"，
 *   没人测"等式成不成立"。所以本文件的核心就是那条不变式。
 *
 * 【怎么拿到被测代码】
 *   页面文件在加载期只调用一次 `Page({...})`，并把纯函数通过 `__test` 挂出来
 *   （见 week.js 末尾，做法与 pages/ai/ai.js 一致）。于是这里 stub 掉全局 Page
 *   再 require 页面，就能拿到**页面真正在用的那一份 buildGrid**，
 *   而不是复制粘贴一份到测试里（那种"测的是一份、跑的是另一份"最容易假绿）。
 *
 * 【本文件只 require 被测页面 + ./harness.js】不 require 任何别的测试文件。
 */

'use strict';

var path = require('path');
var H = require(path.join(__dirname, 'harness.js'));
var ROOT = path.join(__dirname, '..', '..');

var eq = H.eq;
var eqArr = H.eqArr;
var isTrue = H.isTrue;
var isFalse = H.isFalse;
var block = H.block;
var show = H.show;

// ---------------------------------------------------------------------------
// 加载被测页面（只 stub Page；加载期不碰 wx / getApp，也不发任何请求）
// ---------------------------------------------------------------------------
var registered = null;
var loadError = null;
try {
  global.Page = function (options) { registered = options; };
  require(path.join(ROOT, 'pages', 'week', 'week.js'));
} catch (err) {
  loadError = err;
}

var T = registered && registered.__test ? registered.__test : null;

// ---------------------------------------------------------------------------
// 测试数据与小工具
// ---------------------------------------------------------------------------

/** 一行 = 一节课的固定周一（这个值只用于给 buildGrid 生成日期串，不影响行结构） */
var WEEK_MONDAY = '2026-09-07';

/** 默认作息是第 1~13 节 —— 13 行，且没有任何空档行 */
var DEFAULT_ROWS = 13;

/** 校准出第 5 / 7 / 8 节 → 第 6 节成为「午休」空档（左右紧邻都校准过才会认定） */
var OVERRIDE_BREAK = {
  '5': ['11:45', '12:25'],
  '7': ['14:15', '15:00'],
  '8': ['15:10', '15:55']
};

/**
 * 造一条"只写了节次"的课表任务（与真机截图里那种卡片一致）。
 * 页面里落行只看 periods / 起止时间，所以这里给全 periods 就够了。
 */
function course(id, title, periods) {
  return {
    _id: id,
    title: title,
    type: 'event',
    date: WEEK_MONDAY,
    start_time: '',
    end_time: '',
    priority: 'mid',
    done: false,
    repeat: 'none',
    periods: periods
  };
}

/**
 * 把"某一天的任务"摆成 buildGrid 要的 perDay 形状。
 *
 * @param {Object} byDay { 0: [task...], 2: [task...] }  0 = 周一
 * @returns {Array<Array<object>>} 恰好 7 个数组（与 renderWeek 里的形状一致）
 */
function perDayOf(byDay) {
  var list = [];
  for (var i = 0; i < 7; i += 1) list.push(byDay[i] || []);
  return list;
}

/**
 * 从**渲染结果**里数出"这一天被占用了多少节"。
 *
 * 注意这是刻意绕一圈的：不看内部变量，而是把单元格里真正画出来的卡片
 * （periodText 形如 "第3-5节"）解析回 span，再展开成节次集合。
 * 这样断言的是"用户看到的东西"与"显示的数字"自洽。
 */
function occupiedPeriodsFromRender(days, rows, dayIndex) {
  var set = {};
  rows.forEach(function (row, rowIndex) {
    var cell = days[dayIndex].cells[rowIndex];
    (cell.tasks || []).forEach(function (task) {
      var m = /^第(\d+)(?:-(\d+))?节$/.exec(task.periodText || '');
      if (!m) return;
      var from = Number(m[1]);
      var to = Number(m[2] || m[1]);
      for (var n = from; n <= to; n += 1) set[n] = true;
    });
  });
  return Object.keys(set).length;
}

/** 计入空闲统计的行（排除午休/休息空档与「其他时段」兜底行）—— 与页面同一条规则 */
function countableRows(rows) {
  return rows.filter(function (row) {
    return !row.isBreak && row.key !== 'other';
  }).length;
}

/** 把某个 key 的行下标找出来 */
function rowIndexOf(rows, key) {
  for (var i = 0; i < rows.length; i += 1) {
    if (rows[i].key === key) return i;
  }
  return -1;
}

/** 某天某行画出来的卡片标题 */
function titlesAt(built, dayIndex, key) {
  var index = rowIndexOf(built.rows, key);
  if (index === -1) return ['(没有这一行)'];
  return (built.days[dayIndex].cells[index].tasks || []).map(function (t) { return t.title; });
}

// ===========================================================================
// 正式用例
// ===========================================================================
function run() {
  block('week 页 —— 页面文件与 __test 探针');
  isFalse(!!loadError, 'pages/week/week.js 加载期没有抛异常'
    + (loadError ? '（实际：' + loadError.message + '）' : ''));
  isTrue(!!registered, 'Page() 注册对象拿到了');
  isTrue(!!T, '页面通过 __test 暴露了纯函数（测的就是页面真正在用的那份实现）');

  if (!T) {
    // 探针都没有，后面的断言没有意义；直接返回，让汇总如实报红
    return;
  }
  isTrue(typeof T.buildGrid === 'function', '__test.buildGrid 是函数');
  isTrue(typeof T.occupiedRowsOfDay === 'function', '__test.occupiedRowsOfDay 是函数');
  isTrue(typeof T.periodSpanOf === 'function', '__test.periodSpanOf 是函数');

  // -------------------------------------------------------------------------
  // 用例 A：真机截图里的周一
  //   卡片 第3-4 / 第7-8 / 第11 → 被占 3,4,7,8,11 = 5 节 → 13 − 5 = 8
  // -------------------------------------------------------------------------
  block('空闲节数 —— 用例 A：周一 第3-4 / 第7-8 / 第11');
  var builtA = T.buildGrid(perDayOf({
    0: [course('a1', '电子电路实验', '3-4'), course('a2', '信号与系统', '7-8'), course('a3', '晚自习', '11')]
  }), null, WEEK_MONDAY);

  eq(countableRows(builtA.rows), DEFAULT_ROWS, '默认作息下计入空闲的行数 = 13');
  eq(builtA.freeCounts[0], 8, '**周一空闲 8 节**（截图里显示的是 10，那是 bug）');
  isFalse(builtA.freeCounts[0] === 10,
    '反面对照：不能等于「总行数 − 卡片数」= 10');
  eq(builtA.freeCounts[1], DEFAULT_ROWS, '周二没有任务 → 空闲 13');
  eq(builtA.freeCounts[6], DEFAULT_ROWS, '周日没有任务 → 空闲 13');

  // -------------------------------------------------------------------------
  // 用例 B：真机截图里的周三
  //   卡片 第3-5 / 第7-8 / 第9-10 / 第11 → 被占 3,4,5,7,8,9,10,11 = 8 → 13 − 8 = 5
  // -------------------------------------------------------------------------
  block('空闲节数 —— 用例 B：周三 第3-5 / 第7-8 / 第9-10 / 第11');
  var builtB = T.buildGrid(perDayOf({
    2: [
      course('b1', '数字电路', '3-5'),
      course('b2', '信号与系统', '7-8'),
      course('b3', '晚课', '9-10'),
      course('b4', '晚自习', '11')
    ]
  }), null, WEEK_MONDAY);

  eq(countableRows(builtB.rows), DEFAULT_ROWS, '计入空闲的行数 = 13');
  eq(builtB.freeCounts[2], 5, '**周三空闲 5 节**（截图里显示的是 9，那是 bug）');
  isFalse(builtB.freeCounts[2] === 9,
    '反面对照：不能等于「总行数 − 卡片数」= 9');

  // -------------------------------------------------------------------------
  // 核心不变式：7 天逐一核对  空闲 === 总行数 − 被占用的行数
  //   —— 这正是当年缺失的那条断言
  // -------------------------------------------------------------------------
  block('核心不变式 —— 空闲 = 计入行数 − 被占用的行数（7 天逐一）');
  [builtA, builtB].forEach(function (built, which) {
    for (var d = 0; d < 7; d += 1) {
      var occ = occupiedPeriodsFromRender(built.days, built.rows, d);
      var expect = countableRows(built.rows) - occ;
      eq(built.freeCounts[d], expect,
        '组' + (which === 0 ? 'A' : 'B') + ' 第' + (d + 1) + '天：' + built.freeCounts[d]
        + ' = ' + countableRows(built.rows) + ' − ' + occ);
    }
  });

  // -------------------------------------------------------------------------
  // 排除规则：午休/休息空档行 与「其他时段」行都不计入空闲
  // -------------------------------------------------------------------------
  block('排除规则 —— 午休行与「其他时段」行都不计入空闲');
  var builtC = T.buildGrid(perDayOf({
    4: [
      course('c1', '有节次的课', '1-2'),
      // 既没节次也没时间 → 落进「其他时段」兜底行
      { _id: 'c2', title: '随手记', type: 'event', date: WEEK_MONDAY, priority: 'low',
        repeat: 'none', done: false, periods: '', start_time: '', end_time: '' }
    ]
  }), OVERRIDE_BREAK, WEEK_MONDAY);

  var breakRowIndex = -1;
  builtC.rows.forEach(function (row, i) { if (row.isBreak) breakRowIndex = i; });
  isTrue(breakRowIndex !== -1, '校准出第 5/7/8 节后，第 6 节被认定为「午休」空档行');
  eq(builtC.rows[breakRowIndex].label, '午休', '空档行的显示名是「午休」');
  isTrue(rowIndexOf(builtC.rows, 'other') !== -1, '存在「其他时段」兜底行');

  eq(countableRows(builtC.rows), DEFAULT_ROWS - 1,
    '计入空闲的行数排除了午休行 → 13 − 1 = 12');
  eq(builtC.freeCounts[4], 12 - 2,
    '周五被占 1-2 两节 → 空闲 = 12 − 2 = 10（午休行与「其他时段」行都没被算进去）');
  isTrue(rowIndexOf(builtC.rows, 'other') !== -1
    && builtC.days[4].cells[rowIndexOf(builtC.rows, 'other')].tasks.length === 1,
    '「其他时段」行里确实画出了那张卡片');
  eq(occupiedPeriodsFromRender(builtC.days, builtC.rows, 4), 2,
    '按渲染结果反推，周五只被占 2 节（兜底行里的任务不算占课节）');

  // -------------------------------------------------------------------------
  // 连堂：只画在起始行，但空闲按"占满整个 span"算
  // -------------------------------------------------------------------------
  block('连堂 7-9 —— 只画在起始行，但空闲按占 3 节算');
  var builtD = T.buildGrid(perDayOf({
    0: [course('d1', '连堂课', '7-9')]
  }), null, WEEK_MONDAY);

  isTrue(titlesAt(builtD, 0, '7').indexOf('连堂课') !== -1,
    '第 7 节行（起始行）画出了这张卡片');
  eq(titlesAt(builtD, 0, '8').length, 0, '**第 8 节行没有卡片**（连堂不重复画）');
  eq(titlesAt(builtD, 0, '9').length, 0, '**第 9 节行也没有卡片**');
  eq(builtD.freeCounts[0], DEFAULT_ROWS - 3,
    '但空闲按"占了 3 节"算 → 13 − 3 = 10（若按起始行算会错成 12）');
  isFalse(builtD.freeCounts[0] === DEFAULT_ROWS - 1,
    '反面对照：不能只算 1 节');

  // -------------------------------------------------------------------------
  // 边界：任务写了超出课表的节次 / 脏 periods
  // -------------------------------------------------------------------------
  block('边界 —— 超出课表的节次与脏 periods 不炸');
  var builtE = T.buildGrid(perDayOf({
    0: [course('e1', '写飞了', '20-30')]
  }), null, WEEK_MONDAY);
  isTrue(builtE.freeCounts[0] >= 0 && builtE.freeCounts[0] <= countableRows(builtE.rows),
    '节次远超出课表（20-30）时，空闲数仍是合法值：' + builtE.freeCounts[0]);
  isTrue(typeof builtE.freeCounts[0] === 'number', '没有 NaN');

  var builtF = T.buildGrid(perDayOf({
    0: [course('f1', '脏数据', 'abc'), course('f2', '负节次', '-3')]
  }), null, WEEK_MONDAY);
  eq(builtF.freeCounts[0], DEFAULT_ROWS, 'periods 解析不出来的任务不占任何课节行（空闲仍是 13）');

  // -------------------------------------------------------------------------
  // 回归：行数与"每节课一行"这条基本结构没被改坏
  // -------------------------------------------------------------------------
  block('回归 —— 行结构');
  eq(builtA.rows.length, DEFAULT_ROWS, '默认作息 = 13 行（第 1~13 节）');
  eq(builtA.rows[6].label, '第7节', '第 7 行的显示名是「第7节」');
  eq(builtA.days.length, 7, '永远是 7 天（即使只有一天有任务）');
  eqArr(T.periodSpanOf(course('x', 'x', '7-9')), [7, 9], "periodSpanOf('7-9') → [7,9]");
  // 数组一律用 eqArr：eq 走的是 Object.is，比的是**引用**，两个内容相同的数组也会判不相等
  eqArr(T.periodSpanOf(course('x', 'x', '7')), [7, 7], "periodSpanOf('7') → [7,7]");
  eq(T.periodSpanOf(course('x', 'x', 'abc')), null,
    '脏 periods → null（不占任何行）—— 注意是 null，不是空数组');
  eq(T.locateRow(course('x', 'x', '3'), { 3: 2 }, null), 2, '有 periods 时按起始节次定位到行');
  eq(T.locateRow(course('x', 'x', ''), { 3: 2 }, null), -1,
    '既没节次也没时间 → -1（交给「其他时段」）');
}

// ---------------------------------------------------------------------------
// 导出给 run.js 串行调用；单独跑时自己收尾
// ---------------------------------------------------------------------------
// 【为什么用 done: Promise 而不是加载时直接跑】run.js 是入口，必须能等所有断言
// 结束再打印总结；而且这样"单独跑"与"经 run.js 跑"是**同一条代码路径**，
// 不会出现两边行为不一致（本文件第一版就踩过：done 与 require.main 各跑了一遍）。
var done = Promise.resolve()
  .then(function () { run(); })
  .then(function () {
    if (require.main === module) H.report('课表页空闲统计');
  })
  .catch(function (err) {
    console.error('week 空闲统计测试自己崩了：', err);
    process.exit(2);
  });

module.exports = { done: done, run: run };
