/**
 * utils/tests/ai_page.test.js —— pages/ai/ai.js 的入口与自动选中逻辑（纯 node 单测）。
 *
 * 跑法：
 *     node utils/tests/ai_page.test.js   # 只跑这一份（末尾打印通过数，失败退出码 1）
 *     node utils/tests/run.js            # 跑全部（本文件会被自动 require）
 *
 * 【为什么可以这样测一个 Page】
 * 页面文件只用 `Page({...})` 注册、并调用全局的 `wx` / `getApp`。所以这里先把
 * 这两个全局补上（stub），再 require 页面文件，就能拿到**页面真正的那份实现**，
 * 然后像小程序那样调 onLoad / loadCourses / resolvePendingPick，并对 setData 的
 * 结果与 toast 文案做断言。
 *
 * 【为什么导出 { done: Promise } 而不是在加载时就跑】
 *   1. run.js 是入口，必须能等所有异步断言结束再打印总结（否则会出现"假绿"）；
 *   2. 本文件与 ai_contract.js **都要改全局 wx**。同时挂上会互相冲掉，两边的断言
 *      都会莫名其妙地红。所以这里不主动抢，由 run.js 先跑完 ai_contract，
 *      再执行本文件的 run()（见 run.js 末尾的串行编排）。
 *
 * 【重点覆盖】父任务点名的那条竞态：任务列表是异步来的，onLoad 跑完时列表还没到，
 * 必须验证"数据到位后自动选中"真的发生，而不是靠人眼在开发者工具里点一下。
 *
 * 【不做的事】不 require 任何第三方库；不用 child_process（本环境沙箱禁止管道）。
 */

'use strict';

var path = require('path');
var H = require(path.join(__dirname, 'harness.js'));
var ROOT = path.join(__dirname, '..', '..');

var eq = H.eq;
var isTrue = H.isTrue;
var isFalse = H.isFalse;
var block = H.block;
var show = H.show;

// ---------------------------------------------------------------------------
// stub：wx / getApp / Page
// ---------------------------------------------------------------------------
// 【关键】**加载期一律不许动全局、不许抛异常**。
//   这里曾经在顶层直接给 global.wx 赋值，结果把 ai_contract.js 的 wx 桩冲掉了 ——
//   表现是"ai_contract 单独跑全绿、经 run.js 加载就在异步链上崩"。
//   现在改成：加载期只定义 useStub()，真正的替换发生在 run() 被调用时。
// ---------------------------------------------------------------------------
var toasts = [];
var callLog = [];
var cloudHandler = null;   // 由每个用例设置：function(name, data) → Promise<{ok,...}>

/** 记住加载时环境里已有的 wx / getApp（用后还原，不污染别人） */
var savedWx = global.wx;
var savedGetApp = global.getApp;

/**
 * 装上本文件需要的 wx / getApp 桩。
 * 必须在**用例执行时**调用（不能放加载期），否则会盖掉别的测试文件的桩。
 */
function useStub() {
  toasts = [];
  callLog = [];
  cloudHandler = null;

  global.wx = {
    showToast: function (options) { toasts.push((options && options.title) || ''); },
    navigateTo: function () {},
    switchTab: function () {},
    cloud: {
      callFunction: function (options) {
        var name = options && options.name;
        var data = (options && options.data) || {};
        callLog.push({ name: name, data: data });
        if (!cloudHandler) return Promise.reject({ errMsg: 'no handler' });
        return cloudHandler(name, data).then(function (result) { return { result: result }; });
      }
    }
  };
  global.getApp = function () {
    return {
      globalData: { semesterStart: '2026-09-07', periodTimes: {} },
      ensureInit: function () { return Promise.resolve(true); }
    };
  };
}

/** 还原加载时已有的全局（没有的就删掉） */
function restoreGlobals() {
  if (savedWx === undefined) delete global.wx; else global.wx = savedWx;
  if (savedGetApp === undefined) delete global.getApp; else global.getApp = savedGetApp;
}

// ---------------------------------------------------------------------------
// 取回页面注册对象
// ---------------------------------------------------------------------------
// 页面文件在加载期只调用一次 Page({...})，本身不碰 wx；但为了让"加载期绝不抛异常"
// 这条规矩真正成立，这里用 try/catch 兜住：万一页面文件将来出问题，
// 本文件会明确报出来，而不是把 run.js 整个入口带崩。
var registered = null;
var loadError = null;
try {
  global.Page = function (options) { registered = options; };
  require(path.join(ROOT, 'pages', 'ai', 'ai.js'));
} catch (err) {
  loadError = err;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 造一个"页面实例"：复制注册对象、给独立的 data 与 setData（和真机行为一致） */
function newPage() {
  var page = {};
  Object.keys(registered).forEach(function (key) { page[key] = registered[key]; });
  page.data = JSON.parse(JSON.stringify(registered.data));
  page.setData = function (patch) {
    Object.keys(patch || {}).forEach(function (key) { page.data[key] = patch[key]; });
  };
  return page;
}

/** 等 Promise 链跑完（页面内部用的是微任务，让出几轮事件循环足够） */
function settle(rounds) {
  var n = rounds || 6;
  var p = Promise.resolve();
  for (var i = 0; i < n; i += 1) {
    p = p.then(function () { return new Promise(function (resolve) { setImmediate(resolve); }); });
  }
  return p;
}

/** 造一条任务（默认：未完成、有日期、可拆解） */
function task(overrides) {
  return Object.assign({
    _id: 't1',
    title: '写毕业论文',
    type: 'event',
    date: '2026-12-31',
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
    estimate_min: 0
  }, overrides || {});
}

/** 让 cloud 的 tasks/list 返回给定任务数组 */
function serveTasks(list) {
  cloudHandler = function (name, data) {
    if (name === 'tasks' && data.action === 'list') {
      return Promise.resolve({ ok: true, tasks: list, count: list.length });
    }
    return Promise.resolve({ ok: false, error: 'unexpected call: ' + name + '/' + data.action });
  };
}

function reset() { toasts = []; callLog = []; cloudHandler = null; }

/** 断言最近一次 toast 包含某段文字 */
function lastToastHas(text, label) {
  var last = toasts.length ? toasts[toasts.length - 1] : '';
  isTrue(last.indexOf(text) > -1, label + '（实际 toast：' + show(last) + '）');
}

// 可复用的固定任务
var OK_TASK = task({ _id: 'ok1', title: '写毕业论文', date: '2026-12-31' });
var DONE_TASK = task({ _id: 'done1', title: '已经做完的事', date: '2026-12-20', done: true });
var SUBTASK = task({ _id: 'sub1', title: '查文献', type: 'subtask', date: '2026-11-01', parent_id: 'ok1' });
var NO_DATE_TASK = task({ _id: 'nodate1', title: '没有日期的任务', date: '' });
// 「有时间但没日期」——任务页的按钮会放行这种任务（见 tasks.js 的 decomposeInfo），
// 所以 ai.js 也必须放行，否则用户点了按钮进来会说"没找到"。
var TIME_ONLY_TASK = task({ _id: 'time1', title: '只有时间的任务', date: '', start_time: '09:00', end_time: '10:00' });
var FINISHED_COURSE = task({
  _id: 'course1', title: '高等数学', date: '2026-09-07', end_time: '09:40',
  repeat: 'weekly', week_start: 1, week_end: 2, week_parity: 'all'
});

// ===========================================================================
// 正式用例
// ===========================================================================
function run() {
  // 用例执行时才装桩（加载期不碰全局，见文件头说明）
  useStub();

  // 每个用例的页面实例都挂在 ctx 上，跨 .then 步骤传递（var 在回调里声明会串作用域）
  var ctx = {};

  // ---- 0. 加载期是否出过问题（例如页面文件被改坏）----
  block('ai 页 —— 页面文件可加载');
  isFalse(!!loadError, 'pages/ai/ai.js 加载期没有抛异常'
    + (loadError ? '（实际：' + loadError.message + '）' : ''));
  isTrue(!!registered, 'Page() 注册对象拿到了');
  isTrue(!!registered && typeof registered.onLoad === 'function', 'onLoad 存在');
  isTrue(!!registered && typeof registered.onShow === 'function', 'onShow 存在');
  if (loadError || !registered) {
    // 页面都加载不了，后面的用例没有意义；直接返回，让汇总如实报红
    return Promise.resolve();
  }
  // ---- 1. 纯函数 ----
  block('ai 页 —— 纯函数（id 合法性 / 不能拆解的原因）');
  var T = registered.__test;
  isTrue(!!T, '页面通过 __test 暴露了纯函数（测的就是页面真正在用的那份实现）');
  isTrue(T.isValidTaskId('abc123'), '普通 id → 合法');
  isTrue(T.isValidTaskId('  abc123  '), '带空格 → trim 后合法');
  isTrue(T.isValidTaskId('5f2b-9c_1A'), '含 - 与 _ → 合法');
  isFalse(T.isValidTaskId(''), '空串 → 非法');
  isFalse(T.isValidTaskId('   '), '纯空格 → 非法');
  isFalse(T.isValidTaskId('ab'), '过短（<3）→ 非法');
  isFalse(T.isValidTaskId('undefined'), "字符串 'undefined' → 非法");
  isFalse(T.isValidTaskId('null'), "字符串 'null' → 非法");
  isFalse(T.isValidTaskId('has space'), '含空格 → 非法');
  isFalse(T.isValidTaskId(null), 'null → 非法');
  isFalse(T.isValidTaskId(undefined), 'undefined → 非法');
  isFalse(T.isValidTaskId({}), '对象 → 非法');

  eq(T.decomposeBlockedReason(OK_TASK, 'pending'), '', '普通未完成任务 → 可以拆解');
  eq(T.decomposeBlockedReason(DONE_TASK, 'done'), '这条任务已完成，不用再拆解了', '已完成 → 给出原因');
  eq(T.decomposeBlockedReason(SUBTASK, 'pending'), '这本身就是一个子任务，不能再拆', '是子任务 → 给出原因');
  eq(T.decomposeBlockedReason(NO_DATE_TASK, 'pending'), '先补上日期，AI 才能把子任务排开',
    '既没日期也没时间 → 给出原因（与任务页同一句话）');
  eq(T.decomposeBlockedReason(TIME_ONLY_TASK, 'pending'), '',
    '**有时间但没日期 → 允许拆解**（与任务页 decomposeInfo 的判据对齐，差这一条就会"有按钮却说没找到"）');
  eq(T.decomposeBlockedReason(task({ date: '', start_time: '09:00' }), 'pending'), '',
    '只有 start_time 也放行');
  eq(T.decomposeBlockedReason(task({ date: '', end_time: '18:00' }), 'pending'), '',
    '只有 end_time 也放行');
  eq(T.decomposeBlockedReason(task({ date: '2026/01/01' }), 'pending'), '先补上日期，AI 才能把子任务排开',
    '日期格式非法且没有时间 → 拦下（isValidDate 会判否）');
  eq(T.decomposeBlockedReason(task({ date: '2026/01/01', start_time: '09:00' }), 'pending'), '',
    '日期格式非法但有时间 → 仍放行（宽容，和任务页一致）');
  eq(T.decomposeBlockedReason(FINISHED_COURSE, 'finished'), '这门课已经结课，不用再拆解了',
    '已结课 → 给出原因');
  eq(T.decomposeBlockedReason(task({ title: '' }), 'pending'), '这条任务没有标题，无法拆解',
    '没标题 → 给出原因');
  isTrue(T.decomposeBlockedReason(null, 'pending').length > 0, 'null 任务 → 给出原因（不抛异常）');
  eq(T.decomposeBlockedReason(task({ type: 'subtask', done: true }), 'done'),
    '这条任务已完成，不用再拆解了', '已完成 + 子任务 → 分支顺序上先报"已完成"');

  // ---- 1. 入口①：合法 id → 自动选中（含异步竞态）----
  block('ai 页面入口 —— ① onLoad({mode:"decompose", id: 合法任务})');
  reset();
  serveTasks([OK_TASK, DONE_TASK, SUBTASK]);
  ctx.p1 = newPage();
  ctx.p1.onLoad({ mode: 'decompose', id: 'ok1' });
  // onLoad 返回时列表还没到：此时绝不该已经"选中"（否则就是瞎选的）
  eq(ctx.p1.data.mode, 'decompose', 'onLoad 立刻切到拆解模式');
  eq(ctx.p1.data.pickedId, '', 'onLoad 返回时还没选中（列表还在路上）→ 证明选中发生在数据到位之后');
  eq(ctx.p1.data.picking, true, '标记为"读取任务中"');
  isTrue(callLog.length >= 1 && callLog[0].data.action === 'list', '立刻向云函数要了任务列表');

  return settle().then(function () {
    eq(ctx.p1.data.picking, false, '数据到位后结束 loading');
    eq(ctx.p1.data.courses.length, 1, '只有 1 条可拆解（已完成 / 子任务都被挡在列表外）');
    eq(ctx.p1.data.courses[0]._id, 'ok1', '候选就是那条可拆解的任务');
    eq(ctx.p1.data.pickedId, 'ok1', '**自动选中了该任务**（竞态已解决）');
    eq(ctx.p1.data.pickedTitle, '写毕业论文', '选中后标题就位，可直接点「拆解」');
    eq(ctx.p1.data.pickedDate, '2026-12-31', '选中后截止日期就位');
    eq(ctx.p1.data.subtasks.length, 0, '清空上一次的子任务结果');
    eq(ctx.p1.data.decomposeError, '', '没有错误');
    eq(toasts.length, 1, '提示了一次（告诉用户已选中）');
    lastToastHas('已选中', 'toast 说明"已选中"');
    eq(ctx.p1._pendingPickId, '', 'pending 意图已清空（不会反复弹提示）');

    // ---- 2. 入口②：已完成 ----
    block('ai 页面入口 —— ② id 指向"已完成"的任务（不可拆解）');
    reset();
    serveTasks([OK_TASK, DONE_TASK, SUBTASK]);
    ctx.p2 = newPage();
    ctx.p2.onLoad({ mode: 'decompose', id: 'done1' });
    return settle();
  }).then(function () {
    eq(ctx.p2.data.mode, 'decompose', '仍在拆解模式（模式没被改）');
    eq(ctx.p2.data.pickedId, '', '**没有假装选中**');
    eq(ctx.p2.data.pickedTitle, '', '标题也没被填上');
    eq(ctx.p2.data.courses.length, 1, '退回普通列表（只列出可拆的那 1 条）');
    eq(ctx.p2.data.courses[0]._id, 'ok1', '列表内容正确');
    eq(toasts.length, 1, '**如实提示了一次**（没有静默忽略）');
    lastToastHas('已完成', 'toast 说明真实原因："已完成"');
    isFalse(!!ctx.p2.data.tip, '没有把原因塞进 tip 条（用 toast 就够了）');

    // ---- 2b. 入口② b：子任务 ----
    block('ai 页面入口 —— ② b  id 指向"子任务"（不可拆解）');
    reset();
    serveTasks([OK_TASK, SUBTASK]);
    ctx.p2b = newPage();
    ctx.p2b.onLoad({ mode: 'decompose', id: 'sub1' });
    return settle();
  }).then(function () {
    eq(ctx.p2b.data.pickedId, '', '仍没有选中');
    lastToastHas('子任务', 'toast 说明真实原因："这本身就是一个子任务"');

    // ---- 2c. 「有时间没日期」的任务：任务页会放行，这里必须也能选中 ----
    block('ai 页面入口 —— ② c  id 指向"有时间但没日期"的任务（任务页放行 → 这里也要放行）');
    reset();
    serveTasks([OK_TASK, TIME_ONLY_TASK]);
    ctx.p2c = newPage();
    ctx.p2c.onLoad({ mode: 'decompose', id: 'time1' });
    return settle();
  }).then(function () {
    eq(ctx.p2c.data.courses.length, 2, '候选列表包含这条"有时间没日期"的任务（两边口径一致）');
    eq(ctx.p2c.data.pickedId, 'time1', '成功自动选中（不会出现"按了按钮却说没这条"）');
    eq(ctx.p2c.data.pickedDate, '', '它自己的日期确实是空的（展示用字段）');
    isTrue(/^\d{4}-\d{2}-\d{2}$/.test(ctx.p2c.data.pickedDeadline),
      '传给云函数的截止日被兜底成合法日期：' + show(ctx.p2c.data.pickedDeadline));
    eq(ctx.p2c.data.pickedDeadline, require(path.join(ROOT, 'utils', 'tasks.js')).todayStr(),
      '没日期时按"今天"当截止日（唯一不会把子任务排到过去的解释）');
    lastToastHas('已选中', '同样提示"已选中"');

    // 真的点一次「拆解」：验证发给云函数的 deadline 不是空串
    reset();
    ctx.httpCalls = [];      // 跨 .then 传递的变量一律挂 ctx（var 写在回调里会串作用域）
    cloudHandler = function (name, data) {
      ctx.httpCalls.push({ name: name, data: data });
      if (name === 'aiDecompose') {
        return Promise.resolve({ ok: true, task: data.title, deadline: data.deadline, subtasks: [], steps: 0 });
      }
      return Promise.resolve({ ok: false, error: 'unexpected' });
    };
    ctx.p2c.onDecompose();
    return settle();
  }).then(function () {
    eq(ctx.httpCalls.length, 1, '点「拆解」只发了一次云函数调用');
    eq(ctx.httpCalls[0].name, 'aiDecompose', '调的是 aiDecompose');
    isTrue(/^\d{4}-\d{2}-\d{2}$/.test(String(ctx.httpCalls[0].data.deadline)),
      '**deadline 是合法日期而不是空串**（' + show(ctx.httpCalls[0].data.deadline) + '）'
      + ' —— 否则云函数会返回"截止日期不能为空"');
    eq(ctx.httpCalls[0].data.title, '只有时间的任务', 'title 原样传过去');

    // ---- 3. 入口③：id 不存在 ----
    block('ai 页面入口 —— ③ id 在列表里找不到（已删除 / 不是自己的）');
    reset();
    serveTasks([OK_TASK, DONE_TASK]);
    ctx.p3 = newPage();
    ctx.p3.onLoad({ mode: 'decompose', id: 'ghost999' });
    return settle();
  }).then(function () {
    eq(ctx.p3.data.pickedId, '', '没有选中');
    eq(ctx.p3.data.courses.length, 1, '退回普通列表');
    eq(toasts.length, 1, '提示了一次');
    lastToastHas('没找到', 'toast 说明"没找到这条任务"');
    return null;
  })
    // ---- 4. 入口④：无参数 / 参数非法 ----
    .then(function () {
      block('ai 页面入口 —— ④ a  onLoad({}) → 普通入口');
      reset();
      serveTasks([OK_TASK]);
      ctx.p4 = newPage();
      ctx.p4.onLoad({});
      return settle();
    })
    .then(function () {
      eq(ctx.p4.data.mode, 'parse', '无参数 → 默认进「录入」模式');
      eq(ctx.p4.data.pickedId, '', '没有选中任何任务');
      eq(toasts.length, 0, '**不弹任何提示**（不报错）');
      eq(ctx.p4.data.decomposeError, '', '没有错误态');

      block('ai 页面入口 —— ④ b  onLoad() 连 options 都不传');
      reset();
      serveTasks([OK_TASK]);
      ctx.p4b = newPage();
      ctx.p4b.onLoad();
      return settle();
    })
    .then(function () {
      eq(ctx.p4b.data.mode, 'parse', 'options 为 undefined 也不炸，默认录入模式');
      eq(toasts.length, 0, '不弹提示');

      block('ai 页面入口 —— ④ c  mode 不认识');
      reset();
      serveTasks([OK_TASK]);
      ctx.p4c = newPage();
      ctx.p4c.onLoad({ mode: 'unknown', id: 'ok1' });
      return settle();
    })
    .then(function () {
      eq(ctx.p4c.data.mode, 'parse', '不认识的 mode → 当普通入口（不进拆解）');
      eq(ctx.p4c.data.pickedId, '', '不认识的 mode 下不自动选中（即使 id 有效）');
      eq(toasts.length, 0, '不弹提示');

      block('ai 页面入口 —— ④ d  拆解模式但 id 为空 / id 非法');
      reset();
      serveTasks([OK_TASK]);
      ctx.p4d = newPage();
      ctx.p4d.onLoad({ mode: 'decompose', id: '' });
      return settle();
    })
    .then(function () {
      eq(ctx.p4d.data.mode, 'decompose', 'id 为空时仍按 mode 进拆解模式');
      eq(ctx.p4d.data.pickedId, '', '但没有选中任何东西');
      eq(toasts.length, 0, '不弹提示（参数缺失就是普通入口）');
      eq(ctx.p4d.data.courses.length, 1, '普通列表照常可用');

      reset();
      serveTasks([OK_TASK]);
      ctx.p4e = newPage();
      ctx.p4e.onLoad({ mode: 'decompose', id: 'ab' });
      return settle();
    })
    .then(function () {
      eq(ctx.p4e.data.pickedId, '', 'id 非法（过短）→ 不选中');
      eq(toasts.length, 0, '不弹提示（非法 id 当没传，不打扰用户）');

      // ---- 5. 加载失败不误报 + 恢复后补选中 ----
      block('ai 页面入口 —— 加载失败不误报"没找到" / 恢复后补选中');
      reset();
      cloudHandler = function () { return Promise.resolve({ ok: false, error: '网络异常' }); };
      ctx.p5 = newPage();
      ctx.p5.onLoad({ mode: 'decompose', id: 'ok1' });
      return settle();
    })
    .then(function () {
      eq(ctx.p5.data.decomposeError, '网络异常', '列表加载失败时把错误显示出来');
      eq(ctx.p5.data.pickedId, '', '没有选中');
      // 【口径】加载失败时 api.js 会按既有约定弹一次 toast（那是"请求失败"提示，正确行为）；
      // 要守的是：**不能出现"没找到这条任务"**那种把失败说成不存在的文案。
      eq(toasts.length, 1, '只有 api.js 那一条"请求失败"的提示');
      isFalse(toasts.join('|').indexOf('没找到') > -1,
        '**不误报"没找到"**（加载失败 ≠ 任务不存在），实际 toast：' + show(toasts));
      eq(ctx.p5._pendingPickId, 'ok1', 'pending 意图被保留，等数据到位再兑现');

      reset();
      serveTasks([OK_TASK]);
      ctx.p5.loadCourses();      // 模拟网络恢复后重新拉取
      return settle();
    })
    .then(function () {
      eq(ctx.p5.data.pickedId, 'ok1', '恢复后自动选中成功（重载 / onShow 兜底路径有效）');
      eq(ctx.p5.data.decomposeError, '', '错误已清空');
      lastToastHas('已选中', '这次提示"已选中"');

      // ---- 6. onShow 补选中 ----
      block('ai 页面入口 —— onShow 补选中（已在本页时再次跳转的路径）');
      reset();
      serveTasks([OK_TASK]);
      ctx.p6 = newPage();
      ctx.p6._pendingPickId = 'ok1';       // 模拟"意图记下了但这次没兑现"
      ctx.p6._pendingFromLink = true;
      ctx.p6.onShow();                      // 列表还是空的 → 什么都不做，也不能报错
      eq(ctx.p6.data.pickedId, '', 'onShow 时列表为空 → 不慌、不报错');
      eq(toasts.length, 0, '不弹提示');
      eq(ctx.p6._pendingPickId, 'ok1', '意图还在，等数据');

      ctx.p6.loadCourses();
      return settle();
    })
    .then(function () {
      eq(ctx.p6.data.pickedId, 'ok1', '数据到位后选中成功');
      eq(ctx.p6._pendingPickId, '', '意图消费掉了，不会重复提示');

      // ---- 7. 回归：录入模式 ----
      block('ai 页面入口 —— 回归：录入模式不受影响');
      reset();
      serveTasks([OK_TASK]);
      ctx.p7 = newPage();
      ctx.p7.onLoad({});
      return settle();
    })
    .then(function () {
      eq(ctx.p7.data.mode, 'parse', '默认录入模式');
      eq(ctx.p7.data.courses.length, 1, '候选列表也照常准备好了（切过去即可用）');
      return null;
    });
}

// ---------------------------------------------------------------------------
// 导出给 run.js 串行调用；单独跑时自己收尾
// ---------------------------------------------------------------------------
var done = Promise.resolve()
  .then(run)
  .then(function () {
    restoreGlobals();   // 用例跑完就把全局还回去，不影响后面的测试文件
    if (require.main === module) H.report('pages/ai/ai.js 入口逻辑');
  })
  .catch(function (err) {
    restoreGlobals();
    console.error('ai 页测试自己崩了：', err);
    process.exit(2);
  });

module.exports = { done: done };
