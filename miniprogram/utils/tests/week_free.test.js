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
 *
 * ===========================================================================
 * 【第二个必须存在的理由：卡片高度 = 时间跨度】
 *   同上，另一条"断言替 bug 背书"的例子：本文件曾经断言「没有 periods 的任务
 *   就是 1 行高」并配文"高度由 periodSpanOf 决定，与落点无关"。那句话没错，
 *   但它把**卡片高度**与**时间跨度**解耦了 —— 于是真机上「参加双选会 14:00-18:00」
 *   只画了一格高，用户问"这个双选会的篇幅是不是起码要覆盖到第八节课呢"。
 *   现在的高度口径是 `rowSpanFromTimes`（半开区间求交），而落点、占用行数、
 *   卡片高度**三者共用它**。对应的断言组：
 *     * 「真机用例 —— 双选会 14:00-18:00 要撑满第5~8节」
 *     * 「反面 —— 短任务不许被撑高」「反面 —— 10:00-14:30 连续跨过午休行」
 *     * 「反面 —— 写了 periods 的任务高度/占用完全不变」
 *     * 「反面 —— 截止（只有 end_time）高度 1 行且不占任何行」
 *     * 「反面 —— 只有开始时间时按 estimate_min 定跨度」
 *   这些断言是不是摆设，用下面这条自检证明（本次改动实测过）：
 *     ① 把 week.js 的 viewTask 里 spanCount 的映射临时改回"恒为 1" → **恰好红 8 条**，
 *        全是"卡片高度/spanCount"那几条；
 *     ② 把 resolveSpan 末尾的 `occupiedRows: occupied` 临时改回
 *        `occupiedRows: [occupied[0]]`（只占落点那一行）→ **恰好红 10 条**，
 *        全是"空闲 N 节/占用行数"那几条；
 *     ③ 把 resolveSpan 末尾的 `landingRow: blockRows[0]` + `blockRows: blockRows`
 *        临时改回 `landingRow: occupied[0]` + `blockRows: occupied`
 *        （即"锚点=跨度第一行、高度=整段行数"）→ **恰好红 13 条**，
 *        全是「① 双选会落点/高度/不在午休行」那几条，**②③④⑤⑥ 一条不红**
 *        （这正是"这一处逻辑只影响那一种情形"的证据）。
 *   三组红的集合互不重叠，说明"高度"、"占用"、"锚点"各自都被测住了，没有互相掩护。
 *
 * ===========================================================================
 * 【第三段必须存在的理由：锚点与高度也要只看真实课节行】
 *   第二轮真机反馈：用户的校准作息里**午休行是 12:25-14:15**，而双选会 14:00 开始 ——
 *   14:00 落在午休行**里面**，于是"跨度第一行"把锚点定到了午休行：卡片从 12:25
 *   那一行开始画，而卡上时间文字写着 14:00-18:00。用户原话是
 *   "视觉上等于暗示这个活动 12:25 就开始了"。
 *   ⇒ 锚点/高度只在 isClass 行之间取（heightFrom/heightTo）；占用跨度保持含空档
 *     （from/to），所以「空闲 N 节」不变。两组关键断言：
 *     * 「真机用例（第二轮）—— 校准作息下午休行只压 15 分钟，锚点必须是第7节」
 *     * 「回归护栏 —— 整段时间都在空档里的任务，仍落空档行」
 *   第 1 轮与第 2 轮**不是反复无常**：第 1 轮解决"一格高"，第 2 轮解决"从头错位"，
 *   两轮的判据都写在 pages/week/week.js 的 rowSpanFromTimes 注释里。
 *
 * ===========================================================================
 * 【探针】preview/probe_span.js 是用户写的核对脚本（走 buildGrid 这个真实入口，
 *   打印六条场景）。它只打印、不会红，所以「探针六条」那一组把它的结论钉成了断言。
 * ===========================================================================
 *
 * 【当前基线】本文件 341 条断言；跑全量 run.js 是 2656 条
 *   （本文件上一次改动时分别是 274 / 2286；再往前是 201 / 2213）。
 *   数字变了不一定有问题，但**通过数突然下降**要当成"有断言没跑到"来查
 *   （本文件就出过一次：`testOnShow();` 漏了 return，整批异步断言一条没跑还全绿）。
 *   全量的另外两份大头是「我的」页：me_import 142 条、me_periods 217 条
 *   （各自的自检方法与基线写在它们自己的文件头里）。
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

/**
 * 某天某行里画出来的**卡片本身**（要读 spanCount / blockHeight / blockStyle 时用它）。
 * 断言卡片高度用不着解析 inline style —— spanCount 是它的唯一来源，
 * 而 blockHeight = chipHeightOf(spanCount) 又已经被前面那组逐一验过。
 */
function cardsAt(built, dayIndex, key) {
  var index = rowIndexOf(built.rows, key);
  if (index === -1) return [];
  return built.days[dayIndex].cells[index].tasks || [];
}

// ===========================================================================
// onShow 刷新（这一组需要真实跑页面的加载链路：要 stub 最底层 wx.cloud.callFunction）
// ===========================================================================
/**
 * 【为什么单独一段】前面所有断言都是纯函数（buildGrid / locateRow…），一行网络都不碰。
 * 而 onShow 这件事的本质是"**什么时候发请求、发几次**"，只能在页面级验：
 *   * 首次显示（loadedOnce 为假）→ **不许**再拉一次；
 *   * 之后每次显示 → 必须重拉并重画，而且网格要按**新数据**变。
 * 做法照 ai_page.test.js：stub 掉 wx / getApp / Page，require 页面，调用生命周期方法。
 * 用的是**真实的 utils/api.js**（只 stub 最底层 wx.cloud.callFunction），
 * 这样"发了几个请求"是真的从云函数调用次数上数出来的。
 *
 * ---------------------------------------------------------------------------
 * 【本组怎么证明自己不是摆设 —— 后人请保留这段自检方式】
 *   把 `pages/week/week.js` 里 `onShow` 的刷新那行**临时注释掉**再跑本组，
 *   应当恰好红 3 条：「加载过之后再显示没重拉」「删掉后卡片没消失」「新增后卡片没出现」
 *   —— 与真机用户反馈的两个现象一字对应。恢复后必须立刻转绿。
 *   断言要么是**有效载荷**，要么就只是装饰；这条自检就是它们属于前者的证据。
 *
 * 【⚠️ 假绿警告：调用异步用例必须 return / await】
 *   本文件第一版写的是 `testOnShow();` —— 没接住它返回的 Promise，于是这一整批断言
 *   **一条都没执行**，通过数停在 181，报告却全绿。**这种假绿比红更危险**：
 *   红至少会有人过来看，假绿会让所有人以为这块已经被测住了。
 *   同理，文件末尾 `done` 链里那句也必须写成 `.then(function () { return run(); })` ——
 *   少了 return，report 会赶在断言之前打印。
 *   写异步用例时请确认：**每一个异步分支都被 return 或 await 串回主链**。
 * ---------------------------------------------------------------------------
 */
function testOnShow() {
  var savedWx = global.wx;
  var savedGetApp = global.getApp;
  var savedCurrentPages = global.getCurrentPages;

  // 【为什么这里用"真实本周"而不是 WEEK_MONDAY】renderWeek 画的是**当前真实那一周**
  // （它自己按 today + weekOffset 算周一起点）。本文件第一版把任务日期写成固定的
  // 2026-09-07，而真机此刻是 10 月 → taskOnDate 判 false → 卡片当然画不出来，
  // 我却以为是 onShow 没生效。凡是走页面的用例，日期必须锚在真实这一周。
  function fmtDay(d) {
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  var now = new Date();
  var realMonday = fmtDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7)));

  var callLog = [];
  var tasksReply = [];
  var settingsReply = { ok: true, semester_start: realMonday, period_times: null };

  global.wx = {
    showToast: function () {},
    showModal: function () {},
    stopPullDownRefresh: function () {},
    navigateTo: function () {},
    showLoading: function () {},
    hideLoading: function () {},
    cloud: {
      callFunction: function (options) {
        var data = (options && options.data) || {};
        callLog.push(data.action);
        if (data.action === 'list') {
          return Promise.resolve({ result: { ok: true, tasks: tasksReply, count: tasksReply.length } });
        }
        if (data.action === 'settings_get') {
          return Promise.resolve({ result: settingsReply });
        }
        return Promise.resolve({ result: { ok: false, error: 'unexpected ' + data.action } });
      }
    }
  };
  global.getApp = function () {
    return { globalData: { semesterStart: realMonday, periodTimes: {} }, applySettings: function () {} };
  };
  global.getCurrentPages = function () { return [{}]; };

  // 重新 require 页面，让 Page() 在**本组自己的桩**下注册一次
  var pagePath = path.join(ROOT, 'pages', 'week', 'week.js');
  delete require.cache[require.resolve(pagePath)];
  var captured = null;
  global.Page = function (options) { captured = options; };
  try {
    require(pagePath);
  } catch (err) {
    H.record(false, 'week.js 能在桩下加载', '抛异常：' + ((err && err.message) || err));
  }

  var restore = function () {
    if (savedWx === undefined) delete global.wx; else global.wx = savedWx;
    if (savedGetApp === undefined) delete global.getApp; else global.getApp = savedGetApp;
    if (savedCurrentPages === undefined) delete global.getCurrentPages; else global.getCurrentPages = savedCurrentPages;
    delete require.cache[require.resolve(pagePath)];
    global.Page = function (options) { registered = options; };   // 还原给别的用例用
  };

  if (!captured) {
    restore();
    return;
  }

  isTrue(typeof captured.onShow === 'function',
    '**week.js 暴露了 onShow**（tab 页切回来靠它刷新；没有它 = 编辑页的增删都看不到）');

  /** 造一个页面实例（setData 要认 'a.b' 这种带点的键） */
  function makePage() {
    var page = {};
    Object.keys(captured).forEach(function (key) { page[key] = captured[key]; });
    page.data = JSON.parse(JSON.stringify(captured.data));
    page.setData = function (patch) {
      Object.keys(patch || {}).forEach(function (key) {
        if (key.indexOf('.') === -1) { page.data[key] = patch[key]; return; }
        var parts = key.split('.');
        var target = page.data;
        for (var i = 0; i < parts.length - 1; i += 1) target = target[parts[i]];
        target[parts[parts.length - 1]] = patch[key];
      });
    };
    return page;
  }

  function settle() {
    return new Promise(function (resolve) { setTimeout(resolve, 40); });
  }

  /** 网格里有没有这张卡片（按标题找） */
  function hasCard(page, title) {
    return page.data.days.some(function (day) {
      return day.cells.some(function (cell) {
        return (cell.tasks || []).some(function (t) { return t.title === title; });
      });
    });
  }

  var oneTask = {
    _id: 'c1', title: '要删掉的课', type: 'event', date: realMonday, periods: '3-4',
    priority: 'mid', repeat: 'none', done: false, start_time: '', end_time: ''
  };

  tasksReply = [oneTask];
  var page = makePage();
  page.onLoad();
  return settle().then(function () {
    eq(callLog.filter(function (a) { return a === 'list'; }).length, 1,
      'onLoad 拉了一次任务列表');
    isTrue(page.loadedOnce === true, '加载成功后标记 loadedOnce');
    isTrue(hasCard(page, '要删掉的课'), '**卡片画出来了**（准备验它会不会消失）');

    // ① 首次显示：不该重复拉
    // 【小程序真实生命周期】onLoad 之后紧跟一次 onShow，而小程序**不会等 onLoad 里的
    // 异步请求跑完**才触发 onShow。所以"首次显示"那一刻 loadedOnce 还是 false ——
    // 这一点必须用一个**刚创建、还没加载完**的页面来测。
    // 本文件第一版在这里用"onLoad 已经 settle 过的页面"验它，那时 loadedOnce 已是 true，
    // 于是它按契约**应该**重拉，我却断言它不该拉 —— 是测试建模错了，不是代码错了
    // （真机上用户先看到页面、请求随后才回来，不会连发两次）。
    var freshPage = makePage();
    callLog.length = 0;
    freshPage.onLoad();                    // onLoad 里发第一次请求，loadedOnce 还没置位
    eq(freshPage.loadedOnce === true, false, 'onLoad 刚调用时 loadedOnce 还是 false（还没加载完）');
    var duringLoad = callLog.length;
    freshPage.onShow();                    // 首次显示（紧随 onLoad）
    eq(callLog.length, duringLoad,
      '**首次 onShow 不重复加载**：onLoad 正在拉的请求没有被再拉一遍'
      + '（实际新增调用：' + show(callLog.length - duringLoad) + '）');

    // 这里再等第一个页面把 onLoad 的请求跑完 —— 顺便验证它 settle 后 loadedOnce 置位
    return settle().then(function () {
      isTrue(freshPage.loadedOnce === true, 'onLoad 的请求 settle 后 loadedOnce 置为 true');
      isTrue(hasCard(freshPage, '要删掉的课'), '这个新页面也把卡片画出来了');

      // ② 之后每次显示：必须重拉
      //    此时 freshPage 已经是"加载过一次"的页面，再显示就该重拉 —— 这正是
      //    用户"从编辑页切回课表"时发生的那一次 onShow。
      callLog.length = 0;
      // 【静默刷新：切 tab 回来不许闪骨架态】tab 切换是高频动作，
      // 每次重拉都先置 loading 的话，用户每次切回来都闪一下"正在加载课表"。
      isFalse(freshPage.data.loading === true, '重拉之前 loading 就是 false（页面已有内容）');
      freshPage.onShow();
      isFalse(freshPage.data.loading === true,
        '**非首次 onShow 重拉时 loading 始终为 false**（不闪骨架态）');
      return settle().then(function () {
        isFalse(freshPage.data.loading === true, '拉到数据之后 loading 仍是 false');
        eq(callLog.filter(function (a) { return a === 'list'; }).length, 1,
          '**加载过之后再显示 → 重新拉了一次任务列表**（切回课表刷新靠的就是它）');

        // ③ 端到端：外部把任务删掉 → onShow → 网格里那张卡片消失（用户报的现象）
        tasksReply = [];               // 模拟"在编辑页把它删了"
        freshPage.onShow();
        return settle().then(function () {
          isFalse(hasCard(freshPage, '要删掉的课'),
            '**删掉后切回课表：那张卡片消失了**（这正是用户报的「删除后没变化」）');

          // ④ 端到端：外部新增 → onShow → 卡片出现
          tasksReply = [oneTask, {
            _id: 'c2', title: '刚加的日程', type: 'event', date: realMonday, periods: '7-8',
            priority: 'mid', repeat: 'none', done: false, start_time: '', end_time: ''
          }];
          freshPage.onShow();
          return settle().then(function () {
            isTrue(hasCard(freshPage, '刚加的日程'),
              '**新增后切回课表：卡片出现了**（这正是用户报的「新加的日程不显示」）');
            isTrue(hasCard(freshPage, '要删掉的课'), '原先那条也还在（数据是整份替换，不是追加）');

            // ④b 【最重要的一条】非首次刷新**失败**时：保留旧内容，不许清空
            //     用户已经看到课表了，一次后台刷新失败不该把它变成整页错误态 ——
            //     "切个 tab 回来课表没了"比"看到的是旧数据"严重得多。
            tasksReply = [];
            var failMode = false;
            var origFetch = global.wx.cloud.callFunction;
            global.wx.cloud.callFunction = function (o) {
              if (failMode) return Promise.resolve({ result: { ok: false, error: '模拟刷新失败' } });
              return origFetch.apply(null, arguments);
            };
            failMode = true;
            freshPage.onShow();            // 这次一定失败
            return settle().then(function () {
              failMode = false;
              global.wx.cloud.callFunction = origFetch;
              isTrue(freshPage.data.errorText === '',
                '**非首次刷新失败：errorText 仍为空**（不把整页变成错误态）：'
                + show(freshPage.data.errorText));
              isFalse(freshPage.data.loading === true, '失败后也不会卡在 loading');
              isTrue(hasCard(freshPage, '刚加的日程'),
                '**旧的网格内容还在**（刷新失败没有把用户看到的课表清掉）');
              isTrue(hasCard(freshPage, '要删掉的课'), '两条旧卡片都还在');

              // ⑤ 加载失败时不标记 loadedOnce（下次切回来还会重试）
              tasksReply = [];
              var page2 = makePage();
              var origHandler = global.wx.cloud.callFunction;
              global.wx.cloud.callFunction = function () {
                return Promise.resolve({ result: { ok: false, error: '模拟失败' } });
              };
              page2.onLoad();
              return settle().then(function () {
                global.wx.cloud.callFunction = origHandler;
                isTrue(/加载失败/.test(page2.data.errorText), '首次加载失败 → 照旧是整页错误态：'
                  + show(page2.data.errorText));
                isFalse(page2.loadedOnce === true,
                  '**失败时不标记 loadedOnce** —— 下次切回本页还会再试一次');
                restore();
              });
            });
          });
        });
      });
    });
  });
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
  // builtBoth = [第 1 节的 event, 一条既没节次也没时间的 event（落兜底行）]
  // 【口径更新】那条"什么都没有"的任务现在算**占住兜底行本身**（它确实画在那儿，
  //   说它不占任何行会让「画了却没被算占用」再现）。但兜底行本来就不计入空闲，
  //   所以下面的数字与旧口径完全一样 —— 这条断言是"两种口径在数字上一致"的见证。
  eq(builtBoth.freeCounts[0], countableRows(builtBoth.rows) - 1,
    '空闲 = 计入行数(12) − 被占行数(1) = 11（走任务的 event 占第 1 节；'
    + '落兜底行的那条占的是兜底行，而兜底行不计入空闲）');
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
  eq(T.bestOverlapPeriod('10:45', '10:00', { estimateMin: 30 }), 4,
    'end 早于 start 的脏数据：按 start + 30 分钟推成 10:45-11:15 → 与第 4 节（10:55-11:40）'
    + '重叠 15 分钟、与第 3 节（10:00-10:45）重叠 0 分钟 → **第 4 节**'
    + '（旧版把倒挂当成"一个点"→ 会吸附到第 3 节；那条口径与"算跨度"那条路不一致，已统一）');
  eq(T.bestOverlapPeriod('10:45', '10:00', null), 4,
    '不传 estimateMin 时用 30 分钟兜底，结果同上');
  eq(T.bestOverlapPeriod('', '12:00', null), null, 'start 为空 → null（那条路径不归它管）');

  // ⑨ 卡片高度：**这一条 09:55-10:55 确实只跨 1 行**，所以它应该是一格高。
  //
  //    ⚠️ 【这条注释改过一次，请别再改回去】原文写的是"高度由 periodSpanOf 决定，
  //    与落点无关"—— 那句话把"卡片高度"和"时间跨度"彻底解耦了，于是 14:00-18:00
  //    那样的四节课时长也被画成一格高（真机反馈：用户问"篇幅是不是该覆盖到第八节"）。
  //    现在的口径是：**没有 periods 的任务，高度 = 它按时间真正跨的行数**，
  //    由 buildGrid 第 4 步统一算好交给 viewTask。
  //    这一条之所以还成立，是因为 09:55-10:55 真的只与第 3 节相交（不是"没 periods 就 1 行"）。
  //    配套的反面约束见下面「真机用例」与「反面 —— 短任务不许被撑高」两组。
  var builtTimed = T.buildGrid(perDayOf({
    0: [timedTask('t6', '中间那件事', '09:55', '10:55')]
  }), null, WEEK_MONDAY);
  eq(builtTimed.days[0].cells[rowIndexOf(builtTimed.rows, '3')].tasks[0].spanCount, 1,
    '09:55-10:55 只跨 1 行 → spanCount = 1（**是"真的只跨一行"，不是"没 periods 就一格"**）');
  eq(builtTimed.freeCounts[0], DEFAULT_ROWS - 1,
    '它占第 3 节那一行 → 空闲 12（落点与统计共用 resolveSpan，'
    + '不会出现"画在某行却没被算占用"）');

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

  // ===========================================================================
  // 真机反馈（第 1 轮）：周四「参加双选会 14:00-18:00」只画了一格高
  //   用户原话："这个双选会的篇幅是不是起码要覆盖到第八节课呢"
  //
  // 【为什么这一组必须存在】上面第 ⑨ 条断言当时写的是"没有 periods 的任务
  //   一格高"，还配了一句"（高度由 periodSpanOf 决定，与落点无关）" ——
  //   那句话就是把**卡片高度**与**时间跨度**锁死的元凶：只要没写 periods，
  //   哪怕时间是 14:00-18:00，也永远只有一格高。断言本身没写错，
  //   它只是把 bug 当成了规格（**断言也能替 bug 背书**，这是本组存在的理由）。
  //
  // 【口径】这里用**默认作息**（13 行全是课，没有空档行）—— 它是"高度 = 跨度行数"
  //   最干净的一档：没有 isClass/isBreak 之分，heightFrom/heightTo 与 from/to 相同。
  //   "空档行夹在中间"那一档见下一组（默认作息里没有空档行，测不到）。
  //   行高常量 ROW / GAP 在上一组已经取好，这里直接复用。
  // ===========================================================================
  block('真机用例 —— 双选会 14:00-18:00 要撑满第5~8节');

  /** 周四（下标 3）的双选会：没有 periods，只有起止时间 */
  var fairTask = timedTask('fair', '参加双选会', '14:00', '18:00');
  var builtFair = T.buildGrid(perDayOf({ 3: [fairTask] }), null, WEEK_MONDAY);

  eq(builtFair.rows.length, DEFAULT_ROWS, '默认作息下仍是 13 行（没有多出行来）');
  eq(rowIndexOf(builtFair.rows, 'other'), -1,
    '它完整落在课节里 → 不该出现「其他时段」兜底行');
  isTrue(T.bestOverlapPeriod('14:00', '18:00', null) === 5,
    '**落点 = 第 5 节**（14:00-18:00 与第 5 节 14:00-14:45 重叠 45 分钟，是并列最大的那一节里最小的）');

  // 【半开区间】18:00 与第 8 节（16:55-17:40）相交、与第 9 节（19:00-19:45）不相交 →
  //   跨的是第 5、6、7、8 节共 4 行，**不含第 9 节**
  var fairSpan = T.rowSpanFromTimes(fairTask, builtFair.rows, null);
  isTrue(!!fairSpan, 'rowSpanFromTimes 算得出它的行跨度');
  eq(fairSpan ? (fairSpan.to - fairSpan.from + 1) : -1, 4,
    '**真实跨度 = 4 行**（第 5/6/7/8 节）');
  eq(fairSpan ? builtFair.rows[fairSpan.from].key : '?', '5', '跨度从第 5 节行开始');
  eq(fairSpan ? builtFair.rows[fairSpan.to].key : '?', '8', '跨度到第 8 节行结束');
  isFalse(fairSpan ? builtFair.rows[fairSpan.to].key === '9' : true,
    '反面对照：**不覆盖第 9 节**（18:00 早于第 9 节 19:00 开始，半开区间不算相交）');

  // 卡片高度（用户真正看到的东西）
  var fairCard = cardsAt(builtFair, 3, '5')[0];
  isTrue(!!fairCard, '卡片画在第 5 节那一行');
  eq(fairCard ? fairCard.title : '(没有卡片)', '参加双选会', '画出来的就是它');
  eq(fairCard ? fairCard.spanCount : -1, 4, '**卡片 spanCount = 4 行**（修复前恒为 1）');
  eq(fairCard ? fairCard.blockHeight : -1, 4 * ROW - GAP,
    '**卡片高度 = 4 × 行高 − 间隙 = ' + (4 * ROW - GAP) + 'rpx**');
  isTrue(fairCard ? fairCard.isBlock === true : false,
    '标记为跨节卡片（会加阴影、抬高层级，盖住它跨过的行）');
  eq(titlesAt(builtFair, 3, '6').length, 0, '连堂只画在起始行：第 6 节行没有第二张卡');
  eq(titlesAt(builtFair, 3, '7').length, 0, '第 7 节行也没有');
  eq(titlesAt(builtFair, 3, '8').length, 0, '第 8 节行也没有');

  // 占用（「空闲 N 节」这个数字）
  eq(builtFair.freeCounts[3], DEFAULT_ROWS - 4,
    '**周四空闲 = 13 − 4 = 9 节**（修复前是 13 − 1 = 12，凭空多出 3 节空闲）');
  isFalse(builtFair.freeCounts[3] === DEFAULT_ROWS - 1,
    '反面对照：**不是 12** —— 那正是"只按落点那一节扣"的旧算法');
  // 同一份口径的两个出口：占用行数 = 卡片跨的行数（默认作息没有空档行，两者必然相等）
  var fairResolved = T.spanFor({ task: fairTask, rows: builtFair.rows, override: null });
  eq((fairResolved.occupiedRows || []).length, fairCard ? fairCard.spanCount : -1,
    '**"画几行"与"占几行"都来自 rowSpanFromTimes**（默认作息下两者相等）');
  eq((fairResolved.occupiedRows || []).join(','),
    [fairSpan.from, fairSpan.from + 1, fairSpan.from + 2, fairSpan.to].join(','),
    '占用的就是连续那 4 行：' + (fairResolved.occupiedRows || []).join(','));
  eq((fairResolved.blockRows || []).length, 4, 'blockRows（卡片要盖的行）= 4 行');
  eq(fairResolved.landingRow, fairSpan.from, '落点 = 跨度的第一行（默认作息下两者同源）');

  // ===========================================================================
  // 真机反馈（第 2 轮）：**用户那份真实校准作息**下，双选会的锚点落到了「午休」行
  //
  //   校准作息里第 6 节（午休）是 12:25-14:15，而双选会 14:00 开始 ——
  //   14:00 落在午休行**里面**（重叠 15 分钟）。于是"跨度第一行"把锚点定到了午休行：
  //   卡片从 12:25 那一行开始画，而卡上的时间文字写着 14:00-18:00。
  //   用户原话："视觉上等于暗示这个活动 12:25 就开始了"。
  //
  //   【修法】锚点与高度**只在真实课节行（isClass）之间取**；占用跨度保持含空档。
  //     ⇒ 落点 = 第 7 节（14:15，第一条与它相交的真课）、高度 4 行（第 7~10 节）、
  //       「空闲仍 8」不变（午休那 15 分钟照旧算占，只是卡片不再盖它）。
  //
  //   【为什么"高度"和"占用"可以不相等】占用 = "这段时间被占住了"；
  //     高度 = "卡片要盖住几节课"。硬绑成一个数，就只能在"从午休行开始画"和
  //     "少扣一节空闲"之间二选一 —— 而这两个都是错的。
  // ===========================================================================
  block('真机用例（第二轮）—— 校准作息下午休行只压 15 分钟，锚点必须是第7节');

  /** 用户真机那份校准作息（preview/probe_span.js 里那份，13 节全给） */
  var REAL_CAL = {
    '1': ['08:30', '09:10'], '2': ['09:15', '09:55'], '3': ['10:15', '10:55'],
    '4': ['11:00', '11:40'], '5': ['11:45', '12:25'], '7': ['14:15', '15:00'],
    '8': ['15:05', '15:40'], '9': ['16:00', '16:40'], '10': ['16:45', '17:25'],
    '11': ['19:00', '19:40'], '12': ['19:45', '20:20'], '13': ['20:30', '21:10']
  };
  var builtReal = T.buildGrid(perDayOf({ 3: [fairTask] }), REAL_CAL, WEEK_MONDAY);

  var realBreakIdx = rowIndexOf(builtReal.rows, '6');
  // 【为什么点名叫第 6 节】这份作息现在有**两个**空档行：第 6 节的「午休」（缺号夹出来的）
  // 和第 10~11 节之间 17:25-19:00 的「休息」（按时间空隙合成出来的，见下一个 block）。
  // 所以不能再用"最后一个 isBreak 行"来找午休行 —— 那会指到晚饭那行去。
  isTrue(realBreakIdx !== -1 && builtReal.rows[realBreakIdx].isBreak,
    '第 6 节被认定为「午休」空档行（第 5 / 7 节都校准过）');
  eq(builtReal.rows[realBreakIdx] ? builtReal.rows[realBreakIdx].key : '?', '6',
    '午休行就是第 6 节那一行');
  eq(builtReal.rows[realBreakIdx] ? builtReal.rows[realBreakIdx].timeText : '?', '12:25-14:15',
    '它的区间是 12:25-14:15 —— 所以 14:00 开始的双选会**确实压住了它 15 分钟**');
  isTrue(builtReal.rows[realBreakIdx] ? builtReal.rows[realBreakIdx].isClass === false : false,
    '它被标记成 isClass=false（不参与锚点与高度，但仍参与占用跨度）');
  eq(countableRows(builtReal.rows), DEFAULT_ROWS - 1, '计入空闲的行数 = 12（午休被排除）');

  var realSpan = T.rowSpanFromTimes(fairTask, builtReal.rows, REAL_CAL);
  isTrue(!!realSpan, 'rowSpanFromTimes 算得出跨度');
  // 占用跨度：含午休行 —— 5 行
  eq(realSpan ? builtReal.rows[realSpan.from].key : '?', '6',
    '占用跨度**确实从午休行开始**（14:00 压在 12:25-14:15 里）—— 占用口径没变');
  // 占用跨度按"区间相交"算 —— 第 10~11 节之间那条 17:25-19:00 的「休息」行
  // 与 14:00-18:00 相交 35 分钟，所以占用到它为止（口径没变：占用**含空档行**；
  // 卡片高度不受影响，它只看 isClass 行，见下面两条）。
  eq(realSpan ? builtReal.rows[realSpan.to].key : '?', 'break-17:25-19:00',
    '占用到 17:25-19:00 的「休息」行为止（它也是这条任务覆盖到的行）');
  eq(realSpan ? (realSpan.to - realSpan.from + 1) : -1, 6, '占用 6 行（午休 + 第 7~10 节 + 晚饭空档）');
  // 高度跨度：只看真实课节 —— 4 行
  eq(realSpan ? builtReal.rows[realSpan.heightFrom].key : '?', '7',
    '**高度从第 7 节行开始**（第一条与它相交的**真课**，14:15）');
  eq(realSpan ? builtReal.rows[realSpan.heightTo].key : '?', '10', '高度到第 10 节行结束');
  eq(realSpan ? (realSpan.heightTo - realSpan.heightFrom + 1) : -1, 4,
    '**高度 = 4 行**（第 7/8/9/10 节）');

  var realCard = cardsAt(builtReal, 3, '7')[0];
  isTrue(!!realCard, '**卡片画在第 7 节那一行**（不再是午休行）');
  isFalse(!!cardsAt(builtReal, 3, '6').length,
    '反面对照：**午休行里没有这张卡**（这正是用户报的错位）');
  eq(realCard ? realCard.spanCount : -1, 4, '**spanCount = 4**（不是 5）');
  isFalse(realCard ? realCard.spanCount === 5 : true,
    '反面对照：**不等于 5 行** —— 那意味着卡片从午休行一直盖到第 10 节');
  eq(realCard ? realCard.blockHeight : -1, 4 * ROW - GAP,
    '卡片高度 = 4 × 行高 − 间隙 = ' + (4 * ROW - GAP) + 'rpx');
  // 卡片盖住的行 = 第 7~10 节那 4 行，正好对上它自己的时间文字 14:00-18:00
  var realResolved = T.spanFor({ task: fairTask, rows: builtReal.rows, override: REAL_CAL });
  eq(realResolved.landingRow, realSpan ? realSpan.heightFrom : -1,
    '**落点 = 高度跨度的第一行**（口径只有一条）');
  eq((realResolved.blockRows || []).length, 4, 'blockRows = 4 行');
  eq((realResolved.occupiedRows || []).length, 6,
    'occupiedRows = 6 行（午休 + 第 7~10 节 + 晚饭空档）—— 占用不跟着高度一起缩');
  isTrue((realResolved.occupiedRows || []).indexOf(realBreakIdx) !== -1,
    '午休行仍在占用里（那 15 分钟确实被占了）');
  isTrue((realResolved.blockRows || []).indexOf(realBreakIdx) === -1,
    '但**不在 blockRows 里**（卡片不再从午休行画起）—— 两个集合故意不同');
  eq(builtReal.days[3].cells[realBreakIdx].tasks.length, 0,
    '渲染结果印证：午休行那一格是空的');
  eq(builtReal.freeCounts[3], DEFAULT_ROWS - 1 - 4,
    '**周四空闲仍是 8**（12 − 4）—— 换了锚点、数字不变，'
    + '因为第 6 节本来就不在"可计行数"的分母里');
  eq(builtReal.freeCounts[3], 8, '数值上就是 8（与探针一致）');

  // ===========================================================================
  // 反面 6：**空档行仍然能接任务**（本次改动最大的误伤风险）
  //   新规则是"有真课可落时，空档行不参与定锚点"—— 很容易顺手写成"空档行不接任务"，
  //   那会把上一轮特意保留的行为弄丢（见 bestOverlapPeriod 的注释：Python 版
  //   config.py:225-234 "让这段时间真的能接住任务"）。
  //   判据：一条**整段时间都在空档里**的任务必须照旧落在空档行。
  //   用户那份校准作息里午休是 12:25-14:15，所以 12:30-13:10 落在它里面。
  // ===========================================================================
  block('回归护栏 —— 整段时间都在空档里的任务，仍落空档行');
  var inGap = timedTask('ingap', '午休里的事', '12:30', '13:10');
  var builtGap = T.buildGrid(perDayOf({ 3: [inGap] }), REAL_CAL, WEEK_MONDAY);
  // 同样是点名叫第 6 节那行（这份作息有两个空档行，见上）
  var gapBreakIdx = rowIndexOf(builtGap.rows, '6');
  isTrue(gapBreakIdx !== -1 && builtGap.rows[gapBreakIdx].isBreak, '校准作息下第 6 节是「午休」');
  var gapSpan = T.rowSpanFromTimes(inGap, builtGap.rows, REAL_CAL);
  isTrue(!!gapSpan, '它算得出跨度（与午休行有 40 分钟交集）');
  eq(gapSpan ? gapSpan.from : -1, gapBreakIdx, '跨度就是午休那一行');
  eq(gapSpan ? gapSpan.heightFrom : -2, gapBreakIdx,
    '**高度起点也退回午休行**（没有真课可落时，空档行照旧是它的位置）');
  eq(gapSpan ? (gapSpan.heightTo - gapSpan.heightFrom + 1) : -1, 1, '高度 1 行');
  var gapCard = cardsAt(builtGap, 3, '6')[0];
  isTrue(!!gapCard, '**卡片仍然画在午休行**（这条一破，12:30 的午休安排就消失了）');
  isFalse(!!cardsAt(builtGap, 3, '7').length,
    '反面对照：**不会**被推到第 7 节（那会凭空把它挪到 14:15）');
  eq(gapCard ? gapCard.spanCount : -1, 1, '一格高');
  var gapResolved = T.spanFor({ task: inGap, rows: builtGap.rows, override: REAL_CAL });
  eq(gapResolved.landingRow, gapBreakIdx, '落点 = 午休行');
  eq(builtGap.freeCounts[3], DEFAULT_ROWS - 1,
    '**空闲仍是 12**（午休行不计入空闲，往里面放卡片不扣任何课节）');
  isFalse(builtGap.freeCounts[3] === DEFAULT_ROWS - 2,
    '反面对照：不是 11（那才说明它扣掉了一个真课节）');

  // ===========================================================================
  // 探针六条 —— 把 preview/probe_span.js 的六个场景**逐条钉成断言**
  //
  // 【为什么值得再写一遍】探针里那六条是用户随手跑的核对清单，覆盖了这次改动的
  // 全部分支（真课锚点/空档锚点/截止/periods/两种作息）。探针的输出只是打印，
  // 谁改了代码都不会红 —— 这里把它们变成断言，才是"改坏了会被拦下来"。
  // 探针本身不用改：它走的是 buildGrid 这个页面真正在用的入口。
  // ===========================================================================
  block('探针六条 —— 逐条钉住（真课锚点 / 空档锚点 / 截止 / periods / 两种作息）');

  // ① 双选会（真机那条，无 periods）：真课锚点被午休行"咬掉"15 分钟
  eq(realSpan ? builtReal.rows[realSpan.heightFrom].key : '?', '7', '① 落点 = 第 7 节');
  eq(realCard ? realCard.spanCount : -1, 4, '① spanCount = 4');
  eq(realCard ? realCard.blockHeight : -1, 4 * ROW - GAP, '① blockHeight = 472rpx（4 行）');
  isFalse(realCard ? realCard.spanCount === 5 : true, '① 反面：不是 5 行');
  eq(builtReal.freeCounts[3], 8, '① 周四空闲 = 8');
  eq(builtReal.days[3].cells[realBreakIdx].tasks.length, 0, '① 反面：卡片不在「午休」行里');

  // ② 短任务 09:55-10:55（校准作息）：只压第 3 节
  var shortReal = timedTask('shortReal', '短任务', '09:55', '10:55');
  var builtShortReal = T.buildGrid(perDayOf({ 3: [shortReal] }), REAL_CAL, WEEK_MONDAY);
  eq(cardsAt(builtShortReal, 3, '3')[0] ? cardsAt(builtShortReal, 3, '3')[0].spanCount : -1, 1,
    '② 落第 3 节、1 行');
  eq(builtShortReal.freeCounts[3], 11, '② 空闲 = 11（12 − 1）');

  // ③ 跨午休 10:00-14:30（校准作息）：锚点第 3 节、连续到第 7 节
  var crossReal = timedTask('crossReal', '跨午休', '10:00', '14:30');
  var builtCrossReal = T.buildGrid(perDayOf({ 3: [crossReal] }), REAL_CAL, WEEK_MONDAY);
  var crossRealSpan = T.rowSpanFromTimes(crossReal, builtCrossReal.rows, REAL_CAL);
  eq(crossRealSpan ? builtCrossReal.rows[crossRealSpan.heightFrom].key : '?', '3',
    '③ 落点仍是第 3 节');
  eq(crossRealSpan ? builtCrossReal.rows[crossRealSpan.heightTo].key : '?', '7',
    '③ 高度仍覆盖到第 7 节');
  eq(cardsAt(builtCrossReal, 3, '3')[0] ? cardsAt(builtCrossReal, 3, '3')[0].spanCount : -1, 5,
    '③ spanCount 仍是 5（中途的午休行仍在跨度里）');
  eq(builtCrossReal.freeCounts[3], 8, '③ 空闲 = 8');

  // ④ 截止（只有 end_time）：1 行高、且不占时间
  var ddlReal = { _id: 'ddlReal', title: '交材料', type: 'ddl', date: WEEK_MONDAY,
    priority: 'high', repeat: 'none', done: false, periods: '', start_time: '', end_time: '12:00' };
  var builtDdlReal = T.buildGrid(perDayOf({ 3: [ddlReal] }), REAL_CAL, WEEK_MONDAY);
  eq(T.rowSpanFromTimes(ddlReal, builtDdlReal.rows, REAL_CAL), null,
    '④ rowSpanFromTimes → null（没有开始时间就不是一段时间）');
  var ddlRealCard = cardsAt(builtDdlReal, 3, '5')[0];
  isTrue(!!ddlRealCard, '④ 卡片画在第 5 节行（12:00 在 11:45-12:25 里）');
  eq(ddlRealCard ? ddlRealCard.spanCount : -1, 1, '④ 高度 1 行');
  eq(builtDdlReal.freeCounts[3], 12, '④ 空闲 = 12（截止一格都不占）');

  // ⑤ 连堂 periods 7-9：高度与占用都不许变
  var perReal = course('perReal', '连堂课', '7-9');
  var builtPerReal = T.buildGrid(perDayOf({ 3: [perReal] }), REAL_CAL, WEEK_MONDAY);
  eq(cardsAt(builtPerReal, 3, '7')[0] ? cardsAt(builtPerReal, 3, '7')[0].spanCount : -1, 3,
    '⑤ spanCount = 3（periods 口径一行没动）');
  isTrue(titlesAt(builtPerReal, 3, '7').indexOf('连堂课') !== -1, '⑤ 画在第 7 节行');
  eq(builtPerReal.freeCounts[3], 9, '⑤ 空闲 = 12 − 3 = 9');

  // ⑥ 同一条双选会放在默认作息下：4 行、空闲 9（默认 13 节全是课）
  eq(rowIndexOf(builtFair.rows, 'other'), -1, '⑥ 默认作息下没有兜底行');
  eq(fairCard ? fairCard.spanCount : -1, 4, '⑥ 仍是 4 行');
  eq(builtFair.freeCounts[3], 9, '⑥ 空闲 = 13 − 4 = 9');

  // ===========================================================================
  // 反面 1：**别把短任务也撑高** —— 09:55-10:55 只与第 3 节相撞，仍是 1 行
  //   （这条与上面那条一起构成"要么是真跨了，要么不许变高"的双向约束。
  //     只加"双选会要变高"而不加这条，下次有人把跨度算法写成"取 start 到 end
  //     经过的所有节次"就会把 45 分钟的课也画成两行，而且没人会红。）
  // ===========================================================================
  block('反面 —— 短任务不许被撑高（09:55-10:55 仍是 1 行）');
  var shortTask = timedTask('short', '中间那件事', '09:55', '10:55');
  var builtShort = T.buildGrid(perDayOf({ 0: [shortTask] }), null, WEEK_MONDAY);
  var shortSpan = T.rowSpanFromTimes(shortTask, builtShort.rows, null);
  eq(shortSpan ? (shortSpan.to - shortSpan.from + 1) : -1, 1,
    '09:55-10:55 只与第 3 节（10:00-10:45）相交 → **1 行**'
    + '（与第 4 节 10:55 是首尾相接，半开区间不算重叠）');
  eq(shortSpan ? (shortSpan.heightTo - shortSpan.heightFrom + 1) : -1, 1,
    '高度跨度也是 1 行（没有空档行可夹）');
  eq(cardsAt(builtShort, 0, '3')[0] ? cardsAt(builtShort, 0, '3')[0].spanCount : -1, 1,
    '卡片 spanCount = 1（一格高）');
  eq(builtShort.freeCounts[0], DEFAULT_ROWS - 1, '它只占第 3 节那一行 → 空闲 12');
  isFalse(builtShort.freeCounts[0] === DEFAULT_ROWS - 2,
    '反面对照：**不是 11**（不是 2 行）');
  eq(cardsAt(builtShort, 0, '3')[0] ? cardsAt(builtShort, 0, '3')[0].isBlock : true, false,
    '单行卡片不标 isBlock（不会去抬层级、加阴影）');

  // ===========================================================================
  // 反面 2：跨午休的任务 —— 卡片**连续**跨过午休行，但午休行不算"课"
  //   两件事必须同时成立，否则要么卡片断开，要么「空闲 N 节」被空档行污染。
  //   判据同前面 ⑩：午休行是 periodRows 生成的一行、有真实区间、真的画在网格里，
  //   它本来就不计入空闲（分母已经扣掉它），所以卡片占它不会让数字变错。
  //
  //   【本组与上一组的区别 —— 这就是"两个端点集"存在的意义】
  //     * 上一组（双选会 14:00 开始）：任务的**起点落在午休行内部** ⇒ 锚点必须跳过去，
  //       高度 4 < 占用 5，两个集合**不同**；
  //     * 本组（10:00 开始）：任务的**起点就在第 3 节里** ⇒ 锚点本来就是真课行，
  //       高度 5 = 占用 5，两个集合**相同**（午休行只是夹在中间）。
  //   两组合起来才说明新规则不是"一律跳过午休"（那会把本组的锚点也推走）。
  // ===========================================================================
  block('反面 —— 10:00-14:30 连续跨过午休行，但午休行不计入空闲');
  var CROSS_CAL = { '5': ['11:45', '12:25'], '7': ['14:15', '15:00'] };  // 第 6 节 = 午休
  var crossTask = timedTask('cross', '跨午休的事', '10:00', '14:30');
  var builtCross = T.buildGrid(perDayOf({ 0: [crossTask] }), CROSS_CAL, WEEK_MONDAY);

  var crossBreakIdx = -1;
  builtCross.rows.forEach(function (r, i) { if (r.isBreak) crossBreakIdx = i; });
  isTrue(crossBreakIdx !== -1, '校准第 5/7 节后，第 6 节被认定为「午休」空档行');
  eq(countableRows(builtCross.rows), DEFAULT_ROWS - 1, '计入空闲的行数 = 13 − 1（午休被排除）');

  var crossSpan = T.rowSpanFromTimes(crossTask, builtCross.rows, CROSS_CAL);
  isTrue(!!crossSpan, 'rowSpanFromTimes 算得出跨度');
  eq(crossSpan ? builtCross.rows[crossSpan.from].key : '?', '3',
    '从第 3 节行开始（10:00 是默认第 3 节的起点）');
  eq(crossSpan ? builtCross.rows[crossSpan.to].key : '?', '7', '一直到第 7 节行（14:15-15:00）');
  eq(crossSpan ? (crossSpan.to - crossSpan.from + 1) : -1, 5, '占用 5 行');
  isTrue(crossSpan ? crossSpan.from < crossBreakIdx && crossBreakIdx < crossSpan.to : false,
    '**午休行夹在跨度中间**（下标 ' + crossBreakIdx + ' 落在 ['
    + (crossSpan ? crossSpan.from : '?') + ',' + (crossSpan ? crossSpan.to : '?')
    + '] 里）→ 卡片连续，不被空档行切断');
  // 起点就在真课行上 ⇒ 高度跨度与占用跨度**完全一样**（午休行只在中间）
  eq(crossSpan ? crossSpan.heightFrom : -1, crossSpan ? crossSpan.from : -2,
    '**高度起点 = 占用起点**（任务是 10:00 开始的，锚点不用跳过任何空档行）');
  eq(crossSpan ? crossSpan.heightTo : -1, crossSpan ? crossSpan.to : -2,
    '高度终点 = 占用终点');
  eq(crossSpan ? (crossSpan.heightTo - crossSpan.heightFrom + 1) : -1, 5,
    '**高度仍是 5 行**（与改动前一致，中途的午休行仍在跨度里）');

  var crossCard = cardsAt(builtCross, 0, '3')[0];
  isTrue(!!crossCard, '**卡片锚在第 3 节行**（跨度与高度的共同起点）');
  eq(crossCard ? crossCard.spanCount : -1, 5, '卡片高度 5 行');
  eq(crossCard ? crossCard.blockHeight : -1, 5 * ROW - GAP,
    'blockHeight = 5 × 行高 − 间隙 = ' + (5 * ROW - GAP) + 'rpx');

  var crossResolved = T.spanFor({ task: crossTask, rows: builtCross.rows, override: CROSS_CAL });
  isTrue((crossResolved.occupiedRows || []).indexOf(crossBreakIdx) !== -1,
    '午休行**被标记为"被占"**（那 110 分钟确实被占了）');
  eq(crossResolved.landingRow, crossSpan ? crossSpan.from : -1,
    '**落点 = 跨度的第一行**（不是"重叠最多的那一行"—— 重叠最多的其实是午休行）');
  eq((crossResolved.occupiedRows || []).length, crossCard ? crossCard.spanCount : -1,
    '本组里"画几行"与"占几行"相等（两个集合重合的见证）');
  // 【注意两个集合在"午休行夹在中间"时的差别】blockRows 是**卡片真正盖住的那一段连续行**，
  // 它**包含**夹在中间的午休行（卡片就是压着那一格往下盖的）；它排除午休行只在一种情形：
  // 午休行在锚点**之前**（双选会那种从午休行内部开始的任务）。所以这里断言的是"含"。
  isTrue((crossResolved.blockRows || []).indexOf(crossBreakIdx) !== -1,
    'blockRows **包含**夹在中间的午休行（卡片确实压着那一格）');
  var builtCrossBase = T.buildGrid(perDayOf({ 0: [] }), CROSS_CAL, WEEK_MONDAY);
  eq(builtCross.freeCounts[0], builtCrossBase.freeCounts[0] - 4,
    '**空闲从 12 减到 8**：占用的 5 行里只有 4 行是"课"（午休行本来就不在分母里，不重复扣）'
    + ' —— 实际 ' + builtCross.freeCounts[0]);

  // ===========================================================================
  // 反面 3：写了 periods 的任务 —— 高度与占用**一个字节都不许变**
  //   （这次改动碰的是"没有 periods"那条分支。periods 是全项目最老的口径，
  //     编辑页的冲突提示、导入、AI 解析全都依赖它。）
  // ===========================================================================
  block('反面 —— 写了 periods 的任务高度/占用完全不变');
  var byPeriods = course('per79', '三节连堂', '7-9');
  var builtByPeriods = T.buildGrid(perDayOf({ 0: [byPeriods] }), null, WEEK_MONDAY);
  eq(cardsAt(builtByPeriods, 0, '7')[0] ? cardsAt(builtByPeriods, 0, '7')[0].spanCount : -1, 3,
    "periods='7-9' → spanCount 仍是 3（既有口径）");
  eq(cardsAt(builtByPeriods, 0, '7')[0] ? cardsAt(builtByPeriods, 0, '7')[0].blockHeight : -1,
    3 * ROW - GAP, '高度仍是 3 × 行高 − 间隙');
  eq(titlesAt(builtByPeriods, 0, '8').length, 0, '连堂仍只画在起始行');
  eq(builtByPeriods.freeCounts[0], DEFAULT_ROWS - 3, '空闲仍按 3 节扣：13 − 3 = 10');
  var perResolved = T.spanFor({ task: byPeriods, rows: builtByPeriods.rows,
    rowIndexOfPeriod: { 7: 6, 8: 7, 9: 8 } });
  eq((perResolved.occupiedRows || []).length, 3, 'occupiedRows = 3 个行下标');
  eq((perResolved.occupiedRows || []).join(','), '6,7,8', '就是第 7/8/9 节那三行（下标 6,7,8）');
  isFalse(perResolved.degenerate, '不是退化区间');

  // ===========================================================================
  // 反面 4：只有 end_time 的截止（ddl）—— 高度仍是 1 行，**而且一行都不占**
  //   （这是本次改动最容易误伤的一条：ddl 只有结束时刻，若让跨度算法把它当成
  //     "从 00:00 到 12:00 的一段"，它会撑满整个上午并把空闲全扣光。）
  // ===========================================================================
  block('反面 —— 截止（只有 end_time）高度 1 行且不占任何行');
  var ddlOnly = { _id: 'ddlOnlyEnd', title: '提交材料', type: 'ddl', date: WEEK_MONDAY,
    priority: 'high', repeat: 'none', done: false, periods: '', start_time: '', end_time: '12:00' };
  var builtDdlOnly = T.buildGrid(perDayOf({ 0: [ddlOnly] }), CAL5, WEEK_MONDAY);
  eq(rowIndexOf(builtDdlOnly.rows, 'other'), -1, '校准作息下它定位到课节行（不进兜底行）');
  var ddlCard = cardsAt(builtDdlOnly, 0, '5')[0];
  isTrue(!!ddlCard, '卡片画在第 5 节行（可见性不能退）');
  eq(ddlCard ? ddlCard.spanCount : -1, 1, '**截止卡片恒为 1 行高**');
  eq(ddlCard ? ddlCard.isBlock : true, false, '它不是跨节卡片');
  eq(T.rowSpanFromTimes(ddlOnly, builtDdlOnly.rows, CAL5), null,
    'rowSpanFromTimes：没有开始时间 → **null**（不撑成一段）');
  var ddlResolved = T.spanFor({ task: ddlOnly, rows: builtDdlOnly.rows, override: CAL5 });
  eq((ddlResolved.occupiedRows || []).length, 0, '**occupiedRows 是空数组 → 一行都不占**');
  isTrue(ddlResolved.degenerate, '标记为退化区间（零长，只标一个时刻）');
  eq(builtDdlOnly.freeCounts[0], DEFAULT_ROWS, '**空闲仍是 13** —— 截止不扣任何节次');

  // ===========================================================================
  // 反面 5：只有 start_time（没写结束时间）—— 按 start + estimate_min 定跨度
  //   兜底 30 分钟与 utils/planner.js 的 DEFAULT_BUSY_MINUTES 同一个数。
  //
  //   ⚠️ 这一组的期望值**是从默认作息表逐节算出来的**，不是"看着差不多"填的：
  //     第 10 节 19:55-20:40、第 11 节 20:50-21:35、第 12 节 21:40-22:25。
  //     第一版我把「20:00 + 90 分钟」写成"跨第 10、11 两节"，实际 21:30 落在
  //     第 11 节（20:50-21:35）**里面**，离第 12 节（21:40）还差 10 分钟 → 只有 1 行。
  //     写这种断言前先查 CLASS_PERIODS，否则测的只是自己脑子里的那张作息表。
  // ===========================================================================
  block('反面 —— 只有开始时间时按 estimate_min 定跨度（缺省 30 分钟）');
  // ① 20:30 + 90 分钟 = 22:00 → 与第 10 节（19:55-20:40）相交、
  //    与第 11 节（20:50-21:35）相交、与第 12 节（21:40-22:25）相交 → 3 行
  var openEnded = timedTask('open', '开放结束的事', '20:30', '');
  openEnded.estimate_min = 90;
  var builtOpen = T.buildGrid(perDayOf({ 0: [openEnded] }), null, WEEK_MONDAY);
  var openSpan = T.rowSpanFromTimes(openEnded, builtOpen.rows, null);
  eq(openSpan ? builtOpen.rows[openSpan.from].key : '?', '10',
    '起点 20:30 → 第 10 节行（19:55-20:40，20:30 落在它里面）');
  eq(openSpan ? builtOpen.rows[openSpan.to].key : '?', '12',
    '**终点 = 20:30 + 90 分钟 = 22:00 → 第 12 节行**（21:40-22:25）');
  eq(openSpan ? (openSpan.to - openSpan.from + 1) : -1, 3, '所以卡片跨 3 行（第 10/11/12 节）');
  eq(cardsAt(builtOpen, 0, '10')[0] ? cardsAt(builtOpen, 0, '10')[0].spanCount : -1, 3,
    '卡片高度 3 行（不再是不管写多久都一格高）');
  eq(builtOpen.freeCounts[0], DEFAULT_ROWS - 3, '空闲 = 13 − 3 = 10');

  // ② 没写 estimate 的：兜底 30 分钟 → 08:00-08:30 只与第 1 节（08:00-08:45）相交 → 1 行
  var openShort = timedTask('open2', '没写耗时的事', '08:00', '');
  var builtOpenShort = T.buildGrid(perDayOf({ 0: [openShort] }), null, WEEK_MONDAY);
  var shortOpenSpan = T.rowSpanFromTimes(openShort, builtOpenShort.rows, null);
  eq(shortOpenSpan ? (shortOpenSpan.to - shortOpenSpan.from + 1) : -1, 1,
    '缺省 30 分钟（与 planner.DEFAULT_BUSY_MINUTES 同值）→ 只跨 1 行');
  eq(builtOpenShort.freeCounts[0], DEFAULT_ROWS - 1, '空闲 = 13 − 1 = 12');
  eq(cardsAt(builtOpenShort, 0, '1')[0] ? cardsAt(builtOpenShort, 0, '1')[0].spanCount : -1, 1,
    '卡片仍是一格高');
  isFalse(shortOpenSpan ? shortOpenSpan.to > shortOpenSpan.from : true,
    '反面对照：**没有因为"缺结束时间"就撑到当天结束**');

  // ③ 有 end_time 时**绝不用** estimate：写 08:00-08:45 + estimate 120 仍只跨 1 行
  //    （否则"预计耗时"会把用户明确写下的结束时间顶掉 —— 那是更难查的一类错）
  var bothGiven = timedTask('both', '既写了结束又写了耗时', '08:00', '08:45');
  bothGiven.estimate_min = 120;
  var builtBothGiven = T.buildGrid(perDayOf({ 0: [bothGiven] }), null, WEEK_MONDAY);
  var bothSpan = T.rowSpanFromTimes(bothGiven, builtBothGiven.rows, null);
  eq(bothSpan ? (bothSpan.to - bothSpan.from + 1) : -1, 1,
    '**end_time 优先于 estimate_min**（120 分钟的预计耗时不许顶掉 08:45 这个结束时间）');
  eq(builtBothGiven.freeCounts[0], DEFAULT_ROWS - 1, '空闲 = 13 − 1 = 12');

  // ④ 结束时间**倒挂**（09:00 → 08:30 的脏数据）：
  //    统一走 endMinuteOf —— 倒挂时按 start + estimate 往前推（不是当成"一个点"）。
  //    【为什么】修这条之前，倒挂区间在"算跨度"那条路上按 30 分钟/estimate 撑开，
  //    在"算吸附落点"那条路上却按零长的一个点处理 —— 同一张卡片于是
  //    **落点在一行、跨的却是另外几行**。现在两条路共用一个结束分钟数函数。
  var reversed = timedTask('rev', '时间写反了', '09:00', '08:30');
  reversed.estimate_min = 120;   // 09:00 + 120 分钟 = 11:00 → 第 2、3、4 节
  var builtReversed = T.buildGrid(perDayOf({ 0: [reversed] }), null, WEEK_MONDAY);
  var revSpan = T.rowSpanFromTimes(reversed, builtReversed.rows, null);
  eq(revSpan ? (revSpan.to - revSpan.from + 1) : -1, 3,
    '**倒挂 + estimate 120 → 按 09:00-11:00 算，跨 3 行**（第 2/3/4 节；'
    + '不再"算跨度时用 estimate、算落点时当一个点"）');
  eq(revSpan ? builtReversed.rows[revSpan.from].key : '?', '2', '起点 09:00 → 第 2 节行');
  var revResolved = T.spanFor({ task: reversed, rows: builtReversed.rows, override: null });
  eq(revResolved.landingRow, revSpan ? revSpan.from : -1,
    '**落点 = 跨度的第一行**（与跨度同源，不会画歪）');
  eq((revResolved.occupiedRows || []).length, 3, '占 3 行');
  isTrue(revResolved.degenerate, '仍标记为 degenerate（结束时间不可信），但不再退化成 0 长度');
  var revCard = cardsAt(builtReversed, 0, '2')[0];
  isTrue(!!revCard, '卡片画在第 2 节行');
  eq(revCard ? revCard.spanCount : -1, 3, '高度 3 行 —— 与占用行数完全一致');
  eq(builtReversed.freeCounts[0], DEFAULT_ROWS - 3, '空闲 = 13 − 3 = 10');
  isFalse(builtReversed.freeCounts[0] < DEFAULT_ROWS - 3,
    '反面对照：**没有把倒挂的时间算成一大段**（那会凭空扣掉十几节）');

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
  // onShow 刷新（真机反馈：「删除后没变化」「新加的日程不显示」）
  //   pages/week 是 **tabBar 页**，切走再切回**不会重跑 onLoad**，
  //   所以必须靠 onShow 补一次重拉 + 重画；否则编辑页里的增删都看不到。
  // -------------------------------------------------------------------------
  block('onShow 刷新 —— tab 页切回来必须重拉');
  // ⚠️ 这一组是**异步**的（要等真实的 Promise 链跑完），所以它的 Promise 必须被接住。
  // 本文件第一版写成 `testOnShow();` 而没接住 —— 那批断言**一条都没跑到**，
  // 通过数停在 181 看着却是全绿（典型的假绿：报告里没有失败，因为断言根本不存在）。
  // 注意：本函数结尾要 `return` 它，所以这段之后**不能再有同步断言**（会被 return 跳过）。

  // -------------------------------------------------------------------------
  // 回归：行数与"每节课一行"这条基本结构没被改坏
  // （放在 onShow 那组之前，确保它一定会跑）
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
  eq(T.spanFor({ task: course('x', 'x', '3'), rowIndexOfPeriod: { 3: 2 } }).landingRow, 2,
    '有 periods 时按起始节次定位到行');
  eq(T.spanFor({ task: course('x', 'x', ''), rowIndexOfPeriod: { 3: 2 } }).landingRow, -1,
    '既没节次也没时间 → -1（交给「其他时段」）');

  // ===========================================================================
  // 空档行（真机反馈第三轮）—— 补录了缺的那一节之后，午休行不能消失
  //   用户那份作息第 6 节是空的（文件里没有 13:30 那节课）→ 第 6 行一直是「午休」。
  //   他补录成 13:30-14:10 之后节次号齐了，可 12:25 到 13:30 之间那 65 分钟仍然该
  //   显示成「午休」—— 于是 periodRows() 改成按**时间空隙**插一行合成空档行。
  //   这一组钉住四件事：缺号那条路不许回退 / 补录后多出正确的一行 /
  //   合成行不进 rowIndexOfPeriod 与空闲分母 / 时间落点的任务（含截止）仍能被它接住。
  // ===========================================================================
  block('空档行（真机第三轮）—— 补录缺的节次后，午休行不能消失');

  var FILLED_CAL = {
    '1': ['08:30', '09:10'], '2': ['09:15', '09:55'], '3': ['10:15', '10:55'],
    '4': ['11:00', '11:40'], '5': ['11:45', '12:25'], '6': ['13:30', '14:10'],
    '7': ['14:15', '15:00'], '8': ['15:05', '15:40'], '9': ['16:00', '16:40'],
    '10': ['16:45', '17:25'], '11': ['19:00', '19:40'], '12': ['19:45', '20:20'],
    '13': ['20:30', '21:10']
  };
  var gMiss = T.buildGrid(perDayOf({}), REAL_CAL, WEEK_MONDAY);
  var gFill = T.buildGrid(perDayOf({}), FILLED_CAL, WEEK_MONDAY);
  var LUNCH_KEY = 'break-12:25-13:30';
  var DINNER_KEY = 'break-17:25-19:00';

  // ① 缺号时：一行都不许变
  var missSix = rowIndexOf(gMiss.rows, '6');
  eq(gMiss.rows[missSix] ? gMiss.rows[missSix].label : '?', '午休', '缺号时第 6 节那行仍是「午休」');
  eq(gMiss.rows[missSix] ? gMiss.rows[missSix].timeText : '?', '12:25-14:15', '区间仍是 12:25-14:15（不许回退）');
  eq(countableRows(gMiss.rows), DEFAULT_ROWS - 1, '计入空闲的行数 = 12（缺号午休行不算课）');
  eq(gMiss.freeCounts[0], DEFAULT_ROWS - 1, '没有任务 → 空闲 12');

  // ② 补录第 6 节之后：第 5 节与第 6 节之间多一行「午休 12:25-13:30」
  var lunchIdx = rowIndexOf(gFill.rows, LUNCH_KEY);
  isTrue(lunchIdx !== -1, '多出一行合成空档行 ' + LUNCH_KEY);
  eq(gFill.rows[lunchIdx] ? gFill.rows[lunchIdx].label : '?', '午休', '它叫「午休」（起点 12:25 在 11:00~15:00）');
  eq(gFill.rows[lunchIdx] ? gFill.rows[lunchIdx].timeText : '?', '12:25-13:30', '区间 12:25-13:30');
  eq(gFill.rows[lunchIdx] ? gFill.rows[lunchIdx].isBreak : null, true, '走空档行的样式（灰底）');
  eq(gFill.rows[lunchIdx] ? gFill.rows[lunchIdx].isSynthetic : null, true, '并标明是合成行（不是节次行）');
  eq(gFill.rows[lunchIdx] ? gFill.rows[lunchIdx].number : -1, null, '它没有节次号');
  eq(gFill.rows.length, gMiss.rows.length + 1, '总行数比缺号时**多 1**（就多这一行）');
  var fillSix = rowIndexOf(gFill.rows, '6');
  eq(gFill.rows[fillSix] ? gFill.rows[fillSix].timeText : '?', '13:30-14:10', '第 6 节显示补录的 13:30-14:10');
  eq(fillSix, lunchIdx + 1, '午休行紧挨在第 6 节前面');
  // 分母：补录后第 6 节是**真实课节**（13 行），合成行不进分母
  eq(countableRows(gFill.rows), DEFAULT_ROWS, '计入空闲的行数 = 13（合成行不算课）');
  eq(gFill.freeCounts[0], DEFAULT_ROWS, '没有任务 → 空闲 13');

  // ③ 合成行不参与 rowIndexOfPeriod：写了 periods 的任务照旧按节次落
  var sixTask = course('six', '第6节的事', '6');
  var gSix = T.buildGrid(perDayOf({ 0: [sixTask] }), FILLED_CAL, WEEK_MONDAY);
  eq(cardsAt(gSix, 0, '6').length, 1, 'periods:"6" 的任务落在第 6 节行');
  eq(cardsAt(gSix, 0, LUNCH_KEY).length, 0, '**不会**落到合成午休行（合成行没有节次号）');
  eq(gSix.freeCounts[0], DEFAULT_ROWS - 1, '占 1 节 → 空闲 12（13 − 1）');

  // ④ 整段时间都落在合成午休里的任务，仍被它接住（与缺号午休行同一口径）
  var lunchTask = timedTask('lunch2', '午休里的事', '12:30', '13:10');
  var gLunch = T.buildGrid(perDayOf({ 0: [lunchTask] }), FILLED_CAL, WEEK_MONDAY);
  eq(cardsAt(gLunch, 0, LUNCH_KEY).length, 1, '12:30-13:10 落在合成午休行');
  eq(gLunch.freeCounts[0], DEFAULT_ROWS, '空档行不计入空闲 → 仍是 13');

  // ⑤ 13:00 的截止也被它接住：合成行没有节次号，节次口径永远找不到它
  var ddl1300 = { _id: 'ddl13', title: '提交材料', type: 'ddl', date: WEEK_MONDAY,
    priority: 'high', repeat: 'none', done: false, periods: '', start_time: '', end_time: '13:00' };
  var gDdl = T.buildGrid(perDayOf({ 0: [ddl1300] }), FILLED_CAL, WEEK_MONDAY);
  eq(rowIndexOf(gDdl.rows, 'other'), -1, '它不落「其他时段」兜底行');
  eq(cardsAt(gDdl, 0, LUNCH_KEY).length, 1, '落在合成午休行里');
  eq(gDdl.freeCounts[0], DEFAULT_ROWS, '截止不占节次 → 空闲仍是 13');

  // ⑥ 晚饭那种空隙也插一行，标签是「休息」
  //   （取行时必须先判下标：这一行不存在的时候要让断言干净地红一条，
  //    而不是在这里抛 TypeError —— 那会把本文件后面的断言全部跳过，变成"假绿"）
  var dinnerIdx = rowIndexOf(gFill.rows, DINNER_KEY);
  isTrue(dinnerIdx !== -1, '17:25→19:00 之间也插了一行');
  eq(gFill.rows[dinnerIdx] ? gFill.rows[dinnerIdx].label : '?', '休息', '它叫「休息」（不在中午那段）');

  // ⑦ 边界与默认作息
  var b44 = T.buildGrid(perDayOf({}), { '5': ['11:45', '12:25'], '6': ['13:09', '13:50'] }, WEEK_MONDAY);
  var b45 = T.buildGrid(perDayOf({}), { '5': ['11:45', '12:25'], '6': ['13:10', '13:50'] }, WEEK_MONDAY);
  eq(b44.rows.length, DEFAULT_ROWS, '空隙 44 分钟 → 不插（13 行）');
  isTrue(rowIndexOf(b45.rows, 'break-12:25-13:10') !== -1, '空隙恰好 45 分钟 → 插一行');
  eq(T.buildGrid(perDayOf({}), null, WEEK_MONDAY).rows.length, DEFAULT_ROWS,
    '默认作息不插合成行（它不是这所学校的作息；默认第 4~5 节之间空着 140 分钟也不插）');

  // 最后才跑异步那组，并把它的 Promise 交出去（run() 的调用方会等它）
  return testOnShow();
}

// ---------------------------------------------------------------------------
// 导出给 run.js 串行调用；单独跑时自己收尾
// ---------------------------------------------------------------------------
// 【为什么用 done: Promise 而不是加载时直接跑】run.js 是入口，必须能等所有断言
// 结束再打印总结；而且这样"单独跑"与"经 run.js 跑"是**同一条代码路径**，
// 不会出现两边行为不一致（本文件第一版就踩过：done 与 require.main 各跑了一遍）。
var done = Promise.resolve()
  .then(function () { return run(); })   // ⚠️ 必须 return：run() 现在会返回异步那组的 Promise
  .then(function () {
    if (require.main === module) H.report('课表页空闲统计');
  })
  .catch(function (err) {
    console.error('week 空闲统计测试自己崩了：', err);
    process.exit(2);
  });

module.exports = { done: done, run: run };
