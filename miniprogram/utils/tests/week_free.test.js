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
  // 连堂卡片的高度：跨 N 节就要占 N 行高
  // （真机上曾经只有一格高，用户说"明明两节课的时间只占了一节课的空格"）
  // -------------------------------------------------------------------------
  block('连堂卡片高度 —— 跨 N 节占 N 行高');
  isTrue(typeof T.chipHeightOf === 'function', '__test.chipHeightOf 暴露出来了');
  isTrue(typeof T.ROW_HEIGHT_RPX === 'number' && T.ROW_HEIGHT_RPX > 0,
    '行高常量可用：ROW_HEIGHT_RPX = ' + show(T.ROW_HEIGHT_RPX));
  isTrue(typeof T.CHIP_GAP_RPX === 'number' && T.CHIP_GAP_RPX >= 0,
    '间隙常量可用：CHIP_GAP_RPX = ' + show(T.CHIP_GAP_RPX));

  var ROW = T.ROW_HEIGHT_RPX;
  var GAP = T.CHIP_GAP_RPX;
  eq(T.chipHeightOf(1), ROW - GAP, '跨 1 节 → 行高 − 间隙 = ' + (ROW - GAP) + 'rpx');
  eq(T.chipHeightOf(2), 2 * ROW - GAP, '跨 2 节 → 2 × 行高 − 间隙 = ' + (2 * ROW - GAP) + 'rpx');
  eq(T.chipHeightOf(3), 3 * ROW - GAP, '跨 3 节 → 3 × 行高 − 间隙 = ' + (3 * ROW - GAP) + 'rpx');
  eq(T.chipHeightOf(4), 4 * ROW - GAP, '跨 4 节 → 4 × 行高 − 间隙 = ' + (4 * ROW - GAP) + 'rpx');
  eq(T.chipHeightOf(0), ROW - GAP, '非法跨数（0）按 1 节兜底，不给 0 或负高度');
  eq(T.chipHeightOf(-5), ROW - GAP, '负数同样兜底成 1 节');

  // 高度必须严格随节数线性增长：每多一节正好多一个行高
  eq(T.chipHeightOf(3) - T.chipHeightOf(2), ROW, '每多跨一节，高度正好多一个行高');
  eq(T.chipHeightOf(9) - T.chipHeightOf(1), 8 * ROW, '跨 1 → 跨 9：高度差 = 8 个行高');

  // 从**渲染结果**核：连堂卡的 inline style 高度确实 = 跨的节数 × 行高 − 间隙
  var builtSpan = T.buildGrid(perDayOf({
    0: [course('h1', '三节连堂', '3-5'), course('h2', '单节课', '7')]
  }), null, WEEK_MONDAY);
  var blockCard = builtSpan.days[0].cells[rowIndexOf(builtSpan.rows, '3')].tasks[0];
  eq(blockCard.spanCount, 3, '第 3-5 节的卡片 spanCount = 3');
  eq(blockCard.blockHeight, 3 * ROW - GAP, '它的 blockHeight = 3 × 行高 − 间隙');
  isTrue(blockCard.blockStyle.indexOf('height:' + (3 * ROW - GAP) + 'rpx') !== -1,
    'inline style 里真的带上了这个高度：' + show(blockCard.blockStyle));
  isTrue(blockCard.isBlock === true, '标记为跨节卡片（用于加阴影）');
  isTrue(blockCard.blockStyle.indexOf('z-index:2') !== -1, '跨节卡片 z-index 抬高，能盖住跨过的行');

  var singleCard = builtSpan.days[0].cells[rowIndexOf(builtSpan.rows, '7')].tasks[0];
  eq(singleCard.spanCount, 1, '单节课的卡片 spanCount = 1');
  eq(singleCard.blockHeight, ROW - GAP, '单节课仍然只占一格高');
  isTrue(singleCard.blockStyle.indexOf('z-index:1') !== -1, '单节卡片用基础层级');

  // 第 4、5 节那两行仍然**没有卡片**（既有设计：连堂只画在起始行）
  eq(titlesAt(builtSpan, 0, '4').length, 0, '第 4 节行没有卡片（连堂不重复画）');
  eq(titlesAt(builtSpan, 0, '5').length, 0, '第 5 节行没有卡片');
  isTrue(titlesAt(builtSpan, 0, '3').indexOf('三节连堂') !== -1, '只有起始行（第 3 节）画了那一张');

  // 冲突：连堂卡跨的行里另有别的课 —— 两张卡都不能消失
  block('连堂跨行冲突 —— 跨的行里另有别的课');
  var builtConflict = T.buildGrid(perDayOf({
    0: [course('k1', '三节连堂', '3-5'), course('k2', '插在第四节的课', '4')]
  }), null, WEEK_MONDAY);
  isTrue(titlesAt(builtConflict, 0, '3').indexOf('三节连堂') !== -1, '冲突时连堂卡仍在起始行');
  isTrue(titlesAt(builtConflict, 0, '4').indexOf('插在第四节的课') !== -1,
    '**第 4 节那门课也没有被吞掉**（它在自己格的 DOM 里，且后画的行层级更高）');
  eq(builtConflict.days[0].cells[rowIndexOf(builtConflict.rows, '4')].tasks.length, 1,
    '冲突格子里就是那 1 张卡');
  eq(builtConflict.freeCounts[0], DEFAULT_ROWS - 3, '冲突数据下空闲仍按并集算：13 − 3 = 10');
  isTrue(builtConflict.rows.length === DEFAULT_ROWS, '冲突不会多出行来');

  // -------------------------------------------------------------------------
  // 行高同源：JS 常量与 WXSS 里的 .board-row 高度必须一致
  // （小程序里 JS 与 WXSS 没法共享常量，只能靠这条断言把它们对起来）
  // -------------------------------------------------------------------------
  block('行高同源 —— week.js 的常量 vs week.wxss 的 .board-row');
  var fs = require('fs');
  var wxssPath = path.join(ROOT, 'pages', 'week', 'week.wxss');
  var wxss = fs.readFileSync(wxssPath, 'utf8');
  var rowBlock = /\.board-row\s*\{([^}]*)\}/.exec(wxss);
  isTrue(!!rowBlock, 'wxss 里能找到 .board-row 规则块');
  var rowHeightMatch = rowBlock ? /height:\s*(\d+)rpx/.exec(rowBlock[1]) : null;
  isTrue(!!rowHeightMatch, '.board-row 上写了固定高度');
  eq(rowHeightMatch ? Number(rowHeightMatch[1]) : -1, T.ROW_HEIGHT_RPX,
    '**两处的行高一致**（js=' + T.ROW_HEIGHT_RPX + 'rpx）');
  // 间隙也一样：卡片 margin-bottom（单节卡走流式布局时靠它留缝）
  var chipBlock = /\.chip\s*\{([^}]*)\}/.exec(wxss);
  var gapMatch = chipBlock ? /margin-bottom:\s*(\d+)rpx/.exec(chipBlock[1]) : null;
  isTrue(!!gapMatch, '.chip 上写了 margin-bottom');
  eq(gapMatch ? Number(gapMatch[1]) : -1, T.CHIP_GAP_RPX,
    '**两处的卡片间隙一致**（js=' + T.CHIP_GAP_RPX + 'rpx）');
  // 卡片是 relative 而不是 absolute：绝对定位一旦失效会让整格看起来是空的
  isTrue(/\.chip\s*\{[^}]*position:\s*relative/.test(wxss),
    '卡片用 position: relative（最坏情况只退回一格高，不会整格消失）');
  isFalse(/\.chip\s*\{[^}]*position:\s*absolute/.test(wxss),
    '卡片**不是**绝对定位（那是会灾难性降级的方案）');
  // 日期列不能有竖向 padding，否则卡片高度与行高对不上
  var dayBlock = /\.day-col\s*\{([^}]*)\}/.exec(wxss);
  isTrue(!!dayBlock, 'wxss 里能找到 .day-col 规则块');
  var paddingDecl = dayBlock ? /padding:\s*([^;]+);/.exec(dayBlock[1]) : null;
  isTrue(!!paddingDecl, '.day-col 写了 padding');
  isTrue(paddingDecl ? /^0\s/.test(paddingDecl[1].trim()) : false,
    '**日期列的竖向 padding 是 0**（否则卡片与行高对不上）：' + (paddingDecl ? show(paddingDecl[1].trim()) : '无'));

  // -------------------------------------------------------------------------
  // 「其他时段」兜底行的位置与下标对应（真机上它原本在最下面 → 等于"没显示"）
  // -------------------------------------------------------------------------
  block('兜底行位置 —— 必须在表头正下方第一行');
  var otherTask = { _id: 'o1', title: '没落在课节里的截止', type: 'ddl', date: WEEK_MONDAY,
    priority: 'high', repeat: 'none', done: false, periods: '', start_time: '', end_time: '' };
  var builtOther = T.buildGrid(perDayOf({ 0: [course('g1', '正常课', '3-4'), otherTask] }), null, WEEK_MONDAY);

  eq(builtOther.rows[0].key, 'other', '**兜底行在 rows[0]**（以前在最后一行，要滑到底才看得见）');
  eq(builtOther.rows[0].label, '其他时段', '它的显示名');
  isTrue(builtOther.rows[0].isFallback === true, '并打了 isFallback 标记（供模板加样式）');
  eq(builtOther.rows[1].key, '1', '它后面紧跟第 1 节（行顺序没错位）');
  eq(builtOther.rows.length, DEFAULT_ROWS + 1, '总行数 = 13 节 + 1 兜底行');

  // 同下标一一对应：rows[i] 与 days[d].cells[i] 的 key 必须逐项相同
  for (var dd = 0; dd < 7; dd += 1) {
    eq(builtOther.days[dd].cells.length, builtOther.rows.length,
      '第' + (dd + 1) + '天：cells 数与 rows 数相同');
    var keysMatch = builtOther.rows.every(function (row, i) {
      return builtOther.days[dd].cells[i].key === row.key;
    });
    isTrue(keysMatch, '第' + (dd + 1) + '天：**每个 cell 的 key 与 rows 逐项对应**（错位就会画到别的行）');
  }

  isTrue(titlesAt(builtOther, 0, 'other').indexOf('没落在课节里的截止') !== -1,
    '兜底任务画在兜底行的格子里');
  isTrue(titlesAt(builtOther, 0, '3').indexOf('正常课') !== -1,
    '**第 3 节的课仍然在第 3 节行**（说明 rowIndexOfPeriod 的偏移跟着一起改了）');

  eq(countableRows(builtOther.rows), DEFAULT_ROWS, '计入空闲的行数 = 13（兜底行不算进去）');
  eq(builtOther.freeCounts[0], DEFAULT_ROWS - 2, '周一被占 3-4 两节 → 空闲 11');

  // 空兜底行不出现（既有规则）
  var builtNoOther = T.buildGrid(perDayOf({ 0: [course('g2', '只有课', '3-4')] }), null, WEEK_MONDAY);
  eq(builtNoOther.rows.length, DEFAULT_ROWS, '全部任务都能落进课节时，**兜底行不出现**');
  eq(builtNoOther.rows[0].key, '1', '此时第一行就是第 1 节（没有多余的空行）');

  // 兜底行与午休行同时存在
  var builtBoth = T.buildGrid(perDayOf({
    0: [course('g3', '课', '1'), otherTask]
  }), OVERRIDE_BREAK, WEEK_MONDAY);
  eq(builtBoth.rows[0].key, 'other', '有午休行时兜底行依然在最前');
  isTrue(builtBoth.rows.some(function (r) { return r.isBreak; }), '午休行也在');
  eq(countableRows(builtBoth.rows), DEFAULT_ROWS - 1,
    '计入空闲的行数 = 13 − 1（午休）—— 兜底行与午休行都被排除');

  // -------------------------------------------------------------------------
  // 截止（ddl）不占节次 —— 与 utils/planner.js 的 busyRangesOfDay 同一口径
  // （编辑页的占用提示早就说"ddl 只有截止时刻 → 不占时间段"，
  //   课表页如果把它算成占了一节，同一个问题两个页面会给出相反答案）
  // -------------------------------------------------------------------------
  block('截止不占节次 —— 卡片照旧画出来，但不扣空闲');
  var CAL5 = {
    '1': ['08:30', '09:10'], '2': ['09:15', '09:55'], '3': ['10:15', '10:55'],
    '4': ['11:00', '11:40'], '5': ['11:45', '12:25']
  };

  // ① 一条 12:00 的 ddl（校准作息 → 第 5 节行）：卡片在第 5 节行，但空闲仍是 13
  var ddl1200b = { _id: 'ddl12b', title: '提交材料', type: 'ddl', date: WEEK_MONDAY,
    priority: 'high', repeat: 'none', done: false, periods: '', start_time: '', end_time: '12:00' };
  var builtDdl = T.buildGrid(perDayOf({ 0: [ddl1200b] }), CAL5, WEEK_MONDAY);
  isTrue(titlesAt(builtDdl, 0, '5').indexOf('提交材料') !== -1,
    '**ddl 的卡片照旧画在第 5 节行**（可见性不能退）');
  eq(builtDdl.freeCounts[0], DEFAULT_ROWS,
    '**空闲仍是 13，不是 12** —— 截止不占节次');
  isFalse(builtDdl.freeCounts[0] === DEFAULT_ROWS - 1,
    '反面对照：不能被当成占了一节');
  eq(rowIndexOf(builtDdl.rows, 'other'), -1, '它也照样定位到了课节行（没被推进兜底行）');

  // ② 同一天既有 ddl 又有 event（第 3-4 节）→ 空闲 = 13 − 2 = 11（ddl 不额外扣）
  var event34 = course('e34', '专业课', '3-4');
  var builtMix = T.buildGrid(perDayOf({ 0: [event34, ddl1200b] }), CAL5, WEEK_MONDAY);
  eq(builtMix.freeCounts[0], DEFAULT_ROWS - 2,
    '**同一天 event(3-4) + ddl → 空闲 11**（只扣 event 占的 2 节，ddl 不额外扣）');
  isFalse(builtMix.freeCounts[0] === DEFAULT_ROWS - 3, '反面对照：不是 10（那样就是 ddl 也被扣了）');
  isTrue(titlesAt(builtMix, 0, '3').indexOf('专业课') !== -1, 'event 照旧画在第 3 节行');
  isTrue(titlesAt(builtMix, 0, '5').indexOf('提交材料') !== -1, 'ddl 照旧画在第 5 节行');

  // ③ ddl 与 event 落在**同一行**时：空闲只扣 1
  var ddlSameRow = { _id: 'ddlSame', title: '同一节交材料', type: 'ddl', date: WEEK_MONDAY,
    priority: 'high', repeat: 'none', done: false, periods: '3-4', start_time: '', end_time: '11:40' };
  var event34b = course('e34b', '同一节的专业课', '3-4');
  var builtSameRow = T.buildGrid(perDayOf({ 0: [event34b, ddlSameRow] }), CAL5, WEEK_MONDAY);
  eq(builtSameRow.days[0].cells[rowIndexOf(builtSameRow.rows, '3')].tasks.length, 2,
    '两张卡都画在第 3 节那一格里（并排/竖排，都不消失）');
  eq(builtSameRow.freeCounts[0], DEFAULT_ROWS - 2,
    '**空闲只扣 1 行 × 2 节 = 11**（第 3-4 节被 event 占了；ddl 与之同行，不再多扣）');

  // ④ 一条 ddl 落进兜底行时：空闲仍是 13（兜底行本来就不计）
  //    注意时间要选**真的落在所有课节之外**的：默认作息最后一节是 22:30-23:15，
  //    所以 23:00 仍属第 13 节（periodNumberAt 取"结束时间最贴近"），23:30 才落空。
  var ddlLoose = { _id: 'ddlLoose', title: '很晚的截止', type: 'ddl', date: WEEK_MONDAY,
    priority: 'mid', repeat: 'none', done: false, periods: '', start_time: '', end_time: '23:30' };
  var builtDdlOther = T.buildGrid(perDayOf({ 0: [ddlLoose] }), null, WEEK_MONDAY);
  eq(rowIndexOf(builtDdlOther.rows, 'other'), 0, '23:30 落在兜底行（rows[0]）');
  eq(builtDdlOther.freeCounts[0], DEFAULT_ROWS, '**空闲仍是 13**（兜底行与 ddl 都不占节次）');

  // ⑤ 不变式：既有两类排除规则与连堂口径都没被这次改动破坏
  block('截止口径改动后 —— 既有不变式仍然成立');
  eq(countableRows(builtBoth.rows), DEFAULT_ROWS - 1, '计入行数仍是 13 − 1（午休被排除）');
  // builtBoth = [第 1 节的 event, 一条无 span 的 event（落兜底行）]
  // 无 span 的任务不占任何课节行（既有口径），所以被占的是"第 1 节"那 1 行。
  eq(builtBoth.freeCounts[0], countableRows(builtBoth.rows) - 1,
    '空闲 = 计入行数(12) − 被占行数(1) = 11（走任务的 event 占第 1 节；'
    + '落兜底行的那条无 span，不占课节）');
  var builtSpanAgain = T.buildGrid(perDayOf({ 0: [course('sp', '三连堂', '7-9')] }), null, WEEK_MONDAY);
  eq(builtSpanAgain.freeCounts[0], DEFAULT_ROWS - 3,
    '连堂仍按跨的节数算（13 − 3 = 10）—— 没有被 ddl 的改动带偏');
  var builtSub = T.buildGrid(perDayOf({
    0: [{ _id: 'sub1', title: '子任务', type: 'subtask', date: WEEK_MONDAY, priority: 'mid',
      repeat: 'none', done: false, periods: '3-4', start_time: '', end_time: '' }]
  }), CAL5, WEEK_MONDAY);
  eq(builtSub.freeCounts[0], DEFAULT_ROWS - 2,
    '**子任务仍然占节次**（只有 ddl 不占；子任务是有工作量的，不能一起放过）');
  eq(builtSpanAgain.freeCounts[0] === DEFAULT_ROWS - 2, false,
    '反面对照：连堂没被当成只占 1 节');

  // -------------------------------------------------------------------------
  // 落点选择：没有 periods 的任务按「与哪一节重叠最多」定行
  // （原来是 periodSpanFromTimes 的就位吸附，会把 0 重叠的一节当成落点，
  //   于是"时间写着 09:55-10:55、卡片却在第 4 节行"，又是一次时间与显示对不上）
  // -------------------------------------------------------------------------
  block('落点选择 —— 按"最大重叠"定行（无 periods 的任务）');
  isTrue(typeof T.bestOverlapPeriod === 'function', '__test.bestOverlapPeriod 暴露出来了');

  /** 造一条"只写起止时间、没有 periods"的任务（模拟手工/拆解生成的那种） */
  function timedTask(id, title, start, end, type) {
    return { _id: id, title: title, type: type || 'event', date: WEEK_MONDAY,
      priority: 'mid', repeat: 'none', done: false,
      periods: '', start_time: start, end_time: end };
  }
  /** 直接问页面：这条任务会被放到哪一行（-1 = 兜底行） */
  function rowKeyFor(task, override) {
    var built = T.buildGrid(perDayOf({ 0: [task] }), override, WEEK_MONDAY);
    var idx = -1;
    built.days[0].cells.forEach(function (cell, i) {
      if (cell.tasks.length) idx = i;
    });
    return idx === -1 ? '(没画出来)' : built.rows[idx].key;
  }

  // ①「09:55-10:55」默认作息：与第 3 节重叠 45 分钟、与第 4 节 0 分钟 → 第 3 节
  eq(rowKeyFor(timedTask('t1', '中间那件事', '09:55', '10:55'), null), '3',
    '**「09:55-10:55」落第 3 节行**（与第 3 节重叠 45 分钟；旧实现会错落第 4 节）');
  isFalse(rowKeyFor(timedTask('t1', '中间那件事', '09:55', '10:55'), null) === '4',
    '反面对照：不等于第 4 节（那是 0 重叠的吸附结果）');
  isFalse(rowKeyFor(timedTask('t1', '中间那件事', '09:55', '10:55'), null) === 'other',
    '反面对照：也不等于兜底行（它对第 3 节有 45 分钟真实重叠）');

  // ②「09:40-10:40」：起点被第 2 节包含（含端点）但重叠 0，第 3 节有 40 分钟 → 第 3 节
  eq(rowKeyFor(timedTask('t2', '跨课间的事', '09:40', '10:40'), null), '3',
    '**「09:40-10:40」落第 3 节行**（第 3 节 40 分钟 > 第 2 节 0 分钟 —— '
    + '按"起点所在节必须有重叠"判会把它误伤进兜底行）');
  isFalse(rowKeyFor(timedTask('t2', '跨课间的事', '09:40', '10:40'), null) === 'other',
    '反面对照：不进兜底行（它有 40 分钟实实在在落在第 3 节里）');

  // ③「12:25-13:25」校准作息：与第 6 节**午休行**（12:25-14:15）重叠 60 分钟 → 落午休行
  //    （空档行也是有真实区间的可见行，可以接任务 —— 见 bestOverlapPeriod 的注释。
  //      第 5 节 11:45-12:25 的重叠是 0，所以不该吸附到第 5 节。）
  var CAL_B = { '5': ['11:45', '12:25'], '7': ['14:15', '15:00'] };
  eq(rowKeyFor(timedTask('t3', '午休里的事', '12:25', '13:25'), CAL_B), '6',
    '**「12:25-13:25」落第 6 节（午休行）**（与午休区间 12:25-14:15 重叠 60 分钟）');
  isFalse(rowKeyFor(timedTask('t3', '午休里的事', '12:25', '13:25'), CAL_B) === '5',
    '反面对照：不等于第 5 节（与它的重叠是 0，那是就位吸附的结果）');
  isFalse(rowKeyFor(timedTask('t3', '午休里的事', '12:25', '13:25'), CAL_B) === 'other',
    '反面对照：不等于兜底行（它有一行真实区间可落，兜底行是"连行都没有"时才用）');

  // ④「12:00-13:00」默认作息（11:40–14:00 之间没有课）→ 兜底行
  eq(rowKeyFor(timedTask('t4', '午休里的事', '12:00', '13:00'), null), 'other',
    '**「12:00-13:00」默认作息落兜底行**（与任何一节都没有交集）');

  // ⑤「08:00-09:40」→ 第 1 节行（既有行为不变）
  eq(rowKeyFor(timedTask('t5', '早课', '08:00', '09:40'), null), '1',
    '「08:00-09:40」仍落第 1 节行（重叠 100%，既有行为不变）');

  // ⑥ 回归护栏（最大风险点）：只有 end_time 的 ddl **不走**最大重叠这条路
  var ddlOnlyEnd = { _id: 'ddlEnd', title: '提交材料', type: 'ddl', date: WEEK_MONDAY,
    priority: 'high', repeat: 'none', done: false, periods: '', start_time: '', end_time: '12:00' };
  eq(rowKeyFor(ddlOnlyEnd, CAL5), '5',
    '**只有 end_time 的截止仍落第 5 节行**（走的是"结束时刻包含判定"，'
    + '零长区间也照样吸附 —— 用户报的问题2 靠这条活着）');
  isFalse(rowKeyFor(ddlOnlyEnd, CAL5) === 'other',
    '反面对照：**绝不进兜底行**（这条一破，"截止与子任务不显示"就复活了）');

  // ⑦ 有 periods 的任务完全不经过这条路径
  eq(rowKeyFor(course('p1', '写了节次的课', '7-9'), null), '7',
    '有 periods 的照旧按 periods 定位（连堂仍落起始行）');
  eq(rowKeyFor(course('p2', '写了节次的课', '7-9'), null) === 'other', false,
    '有 periods 的**完全不过**最大重叠那道守卫');

  // ⑧ bestOverlapPeriod 自身的口径
  eq(T.bestOverlapPeriod('09:55', '10:55', null), 3, 'bestOverlapPeriod：45 分钟那节胜出');
  eq(T.bestOverlapPeriod('09:40', '10:40', null), 3, 'bestOverlapPeriod：0 分钟的那节不算命中');
  eq(T.bestOverlapPeriod('12:00', '13:00', null), null, 'bestOverlapPeriod：都不相交 → null');
  eq(T.bestOverlapPeriod('09:00', '', null), 2,
    'end 缺失时按零长区间处理（09:00 在第 2 节 08:55-09:40 内 → 第 2 节）');
  eq(T.bestOverlapPeriod('10:45', '10:00', null), 3,
    'end 早于 start 的脏数据按零长区间处理（10:45 在第 3 节内 → 第 3 节）');
  eq(T.bestOverlapPeriod('', '12:00', null), null, 'start 为空 → null（那条路径不归它管）');

  // ⑨ 卡片高度：没有 periods 的任务仍是一格高（高度由 periodSpanOf 决定，与落点无关）
  var builtTimed = T.buildGrid(perDayOf({
    0: [timedTask('t6', '中间那件事', '09:55', '10:55')]
  }), null, WEEK_MONDAY);
  eq(builtTimed.days[0].cells[rowIndexOf(builtTimed.rows, '3')].tasks[0].spanCount, 1,
    '没有 periods 的任务 spanCount 仍是 1（**一格高**）');
  eq(builtTimed.freeCounts[0], DEFAULT_ROWS - 1,
    '它占第 3 节那一行 → 空闲 12（落点变了，统计口径没变 —— '
    + '排版与统计共用 resolveSpan，不会出现"画在某行却没被算占用"）');

  // ⑩ 空档行**可以接任务** —— 保留 Python 版原意（config.py:225-234
  //    "让这段时间真的能接住任务"）。判据：午休行是 periodRows 生成的一行、
  //    有真实区间（12:25-14:15）、真的画在网格里；而且它不计入空闲，
  //    所以往里面放卡片不会污染「空闲 N 节」。
  //    （曾一度按"只考虑真实课节"的思路把它排除过，经复核已回退 —— 见
  //      bestOverlapPeriod 的注释里写的那段判据。）
  var lunchTask = timedTask('lunch', '午休里的事', '12:30', '13:10');
  var builtLunch = T.buildGrid(perDayOf({ 0: [lunchTask] }),
    { '5': ['11:45', '12:25'], '7': ['14:15', '15:00'] }, WEEK_MONDAY);
  var lunchBreakIdx = -1;
  builtLunch.rows.forEach(function (r, i) { if (r.isBreak) lunchBreakIdx = i; });
  isTrue(lunchBreakIdx !== -1, '第 6 节仍是「午休」空档行');
  eq(builtLunch.days[0].cells[lunchBreakIdx].tasks.length, 1,
    '**「12:30-13:10」的卡片就在午休行里**（这一行有真实区间、也真的画在网格上）');
  eq(builtLunch.rows[lunchBreakIdx].key, '6', '午休行就是第 6 节那一行');
  isTrue(titlesAt(builtLunch, 0, '6').indexOf('午休里的事') !== -1,
    '按 key 取也是同一张卡（确认没画错行）');
  eq(rowKeyFor(lunchTask, { '5': ['11:45', '12:25'], '7': ['14:15', '15:00'] }), '6',
    '落点就是午休行');
  isFalse(rowKeyFor(lunchTask, { '5': ['11:45', '12:25'], '7': ['14:15', '15:00'] }) === 'other',
    '反面对照：**≠ 兜底行**（有行可落就不该进兜底）');
  isFalse(rowKeyFor(lunchTask, { '5': ['11:45', '12:25'], '7': ['14:15', '15:00'] }) === '5',
    '反面对照：≠ 第 5 节');
  // ⚠️ 空闲是 12 而不是 13 —— 这不是"空档行被算法占用了"，而是：
  //   这条任务落在**第 6 节**那一行，而第 6 节本身就是"午休"（不是课）→ 不计入空闲。
  //   所以分母是 12（13 行里剔掉午休行），而那 12 行没有任何一行被占 → 空闲 12。
  //   13 那个数只在"默认作息（13 行全是课）"下才成立。
  eq(builtLunch.freeCounts[0], countableRows(builtLunch.rows),
    '**空闲 = 计入空闲的行数(12)** —— 任务落在午休行不额外扣任何课节');
  eq(builtLunch.freeCounts[0], DEFAULT_ROWS - 1,
    '数值上就是 13 − 1（那一行本身是午休，不是课）');
  isFalse(builtLunch.freeCounts[0] === DEFAULT_ROWS - 2,
    '反面对照：不是 11（那才说明它把某个**课节**也扣掉了）');
  eq(countableRows(builtLunch.rows), DEFAULT_ROWS - 1,
    '计入空闲的行数 = 13 − 1（午休行被排除）—— 与上面互为印证');

  // 对照：同样一条任务，若落在**真正的课节**行上，空闲就要少 1
  var onClassRow = timedTask('onclass', '落在第5节的事', '12:00', '12:20');
  var builtOnClass = T.buildGrid(perDayOf({ 0: [onClassRow] }),
    { '5': ['11:45', '12:25'], '7': ['14:15', '15:00'] }, WEEK_MONDAY);
  eq(rowKeyFor(onClassRow, { '5': ['11:45', '12:25'], '7': ['14:15', '15:00'] }), '5',
    '12:00-12:20 与第 5 节重叠 20 分钟 → 落第 5 节');
  eq(builtOnClass.freeCounts[0], DEFAULT_ROWS - 2,
    '**落在真课节上才扣空闲**：13 − 1（午休不计）− 1（第 5 节被占）= 11');

  // ⑪ 不变式复述：落点与统计同源，7 天都不会出现"画了却没算占用"
  var builtMixed = T.buildGrid(perDayOf({
    0: [timedTask('m1', '按时段的事', '09:55', '10:55'), course('m2', '有节次的课', '1-2')]
  }), null, WEEK_MONDAY);
  eq(builtMixed.freeCounts[0], DEFAULT_ROWS - 3,
    '按时段的占第 3 节 + 课程的占第 1-2 节 → 空闲 10（两件都被算进占用）');

  // -------------------------------------------------------------------------
  // 根因回归：12:00 的截止在两种作息下落在不同的行
  // （这正是"截止与子任务不出现在时间表里"那个真机问题）
  // -------------------------------------------------------------------------
  block('根因回归 —— 12:00 的截止：校准作息 → 第5节；默认作息 → 兜底行');
  // 真机导入课表时校准出的作息（用户 data/app.db 里那份的前 5 节）
  var CALIBRATED = {
    '1': ['08:30', '09:10'], '2': ['09:15', '09:55'], '3': ['10:15', '10:55'],
    '4': ['11:00', '11:40'], '5': ['11:45', '12:25']
  };
  // ddl「提交材料」：只填了截止时间 12:00
  var ddl1200 = { _id: 'ddl12', title: '提交材料', type: 'ddl', date: WEEK_MONDAY,
    priority: 'high', repeat: 'none', done: false, periods: '', start_time: '', end_time: '12:00' };

  var builtCal = T.buildGrid(perDayOf({ 0: [ddl1200] }), CALIBRATED, WEEK_MONDAY);
  eq(rowIndexOf(builtCal.rows, 'other'), -1,
    '**校准作息下压根没有兜底行**（12:00 落进第 5 节 11:45-12:25）');
  isTrue(titlesAt(builtCal, 0, '5').indexOf('提交材料') !== -1, '它落在**第 5 节行**');
  eq(builtCal.rows.length, DEFAULT_ROWS, '行数 = 13（没有多出兜底行）');

  var builtDef = T.buildGrid(perDayOf({ 0: [ddl1200] }), null, WEEK_MONDAY);
  eq(rowIndexOf(builtDef.rows, 'other'), 0,
    '**默认作息下落进兜底行**（12:00 在 11:40–14:00 之间没有课，定位不到节次）');
  isTrue(titlesAt(builtDef, 0, 'other').indexOf('提交材料') !== -1, '它出现在兜底行的格子里');
  eq(titlesAt(builtDef, 0, '5').length, 0, '默认作息下第 5 节行是空的');

  // 另一条真机任务：16:00-17:00 的子任务
  var sub1617 = { _id: 's1617', title: '写实验报告', type: 'subtask', date: WEEK_MONDAY,
    priority: 'mid', repeat: 'none', done: false, periods: '', start_time: '16:00', end_time: '17:00' };
  var builtSubCal = T.buildGrid(perDayOf({ 0: [sub1617] }), CALIBRATED, WEEK_MONDAY);
  var builtSubDef = T.buildGrid(perDayOf({ 0: [sub1617] }), null, WEEK_MONDAY);
  isTrue(titlesAt(builtSubDef, 0, '7').indexOf('写实验报告') !== -1,
    '默认作息下 16:00 落**第 7 节**（默认第 7 节 = 16:00-16:45）');
  // 校准作息里只给了第 1~5 节，16:00 不在任何校准区间内，
  // 于是退回默认作息的第 7 节 —— 同一个"第 7 节"在两种作息下含义不同：
  // 校准后第 9 节才是 16:00，这正是用户看到的"时间与自己导入的文件不符"。
  isTrue(titlesAt(builtSubCal, 0, '7').indexOf('写实验报告') !== -1,
    '只校准了前 5 节时，16:00 仍靠默认作息落到第 7 节（口径一致，没有凭空乱跳）');
  eq(builtSubCal.rows.length, DEFAULT_ROWS, '校准作息下同样是 13 行（没有兜底行）');
  // 全量校准（真机那份完整作息）下，16:00 应该落到第 9 节
  var FULL_CALIBRATED = {
    '1': ['08:30', '09:10'], '2': ['09:15', '09:55'], '3': ['10:15', '10:55'],
    '4': ['11:00', '11:40'], '5': ['11:45', '12:25'], '7': ['14:15', '15:00'],
    '8': ['15:05', '15:40'], '9': ['16:00', '16:40'], '10': ['16:45', '17:25']
  };
  var builtSubFull = T.buildGrid(perDayOf({ 0: [sub1617] }), FULL_CALIBRATED, WEEK_MONDAY);
  isTrue(titlesAt(builtSubFull, 0, '9').indexOf('写实验报告') !== -1,
    '**全量校准下 16:00 落第 9 节**（校准第 9 节 = 16:00-16:40）—— 与默认作息的第 7 节不同');

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
