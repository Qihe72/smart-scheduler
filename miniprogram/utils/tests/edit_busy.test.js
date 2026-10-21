/**
 * utils/tests/edit_busy.test.js —— pages/edit/edit.js「该时间段已被占用 / 一键避让」的页面级单测。
 *
 * 跑法：
 *     node utils/tests/edit_busy.test.js   # 只跑这一份（末尾打印通过数，失败退出码 1）
 *     node utils/tests/run.js              # 跑全部（注册那一行由入口 run.js 统一加）
 *
 * 【为什么页面逻辑必须单独测】planner.js 的单测只能证明"算得对"，证明不了页面
 * **什么时候算、算完往哪写**：refreshBusy 挂在哪几个交互上、候选要不要按类型丢掉
 * start_time、避让落地时 periods 怎么填、列表/设置读不到还能不能保存 ——
 * 这些都是页面级联线，漏一根就是线上可见的 bug。做法照 ai_page.test.js：
 * stub 掉 Page / wx / getApp，require 页面文件，拿到**页面真正的那份实现**再断言。
 *
 * 【本文件钉住的五条红线】
 *   1. 触发点：日期 / 开始 / 结束 / 时长 / 类型 / 节次 任一变化都要重算，且**不发请求**；
 *   2. ddl：候选按 buildPayload 的口径丢掉 start_time（截止只有一个时刻，不是一段忙碌）；
 *   3. 避让：起止时间落到 suggestFreeSlot 的结果上，节次走 planner.slotPeriods
 *      （起点落在课间就留空 —— 写一个"就近吸附"出来的号会把卡片画到别的一行）；
 *   4. 降级：任务列表 / 设置读失败都只是"这次不提示"，绝不阻塞保存；
 *   5. 作息口径：设置里的 period_times 必须真的被用上 —— 同一段时间在校准作息下算占用、
 *      在默认作息下不算（结论翻转），这是"拿默认作息当校准作息用"那个老 bug 的回归测试。
 *
 * 【不做的事】不 require 第三方库；不用 child_process（本环境沙箱禁止管道）。
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
// 【加载期一律不许动全局、不许抛异常】—— 这条是 ai_page.test.js 踩坑换来的：
// 在顶层直接给 global.wx 赋值会把别的测试文件的桩冲掉（表现为"单独跑全绿、
// 经 run.js 加载就在异步链上崩"）。所以这里加载期只捕获 Page 注册对象，
// 真正的 wx / getApp 替换发生在用例执行时（useStub）。
var toasts = [];
var callLog = [];
var cloudHandler = null;   // function(name, data) → Promise<{ok,...}>

var savedWx = global.wx;
var savedGetApp = global.getApp;
var savedGetCurrentPages = global.getCurrentPages;

/** 页面实例的"当前生效作息"由 stub 的 getApp 提供（默认空 = 内置默认作息） */
var appGlobalData = { semesterStart: '', periodTimes: {} };

function useStub() {
  toasts = [];
  callLog = [];
  cloudHandler = null;
  appGlobalData = { semesterStart: '', periodTimes: {} };

  global.wx = {
    showToast: function (options) { toasts.push((options && options.title) || ''); },
    showModal: function () {},
    navigateBack: function () {},
    redirectTo: function () {},
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
      globalData: appGlobalData,
      getPeriodTimes: function () { return appGlobalData.periodTimes || {}; },
      getSemesterStart: function () { return appGlobalData.semesterStart || ''; },
      ensureInit: function () { return Promise.resolve(true); }
    };
  };
  // 保存成功后页面会 setTimeout(600ms) 回列表页：不 stub 的话那个定时器会炸在测试之外
  global.getCurrentPages = function () { return [{}]; };
}

function restoreGlobals() {
  if (savedWx === undefined) delete global.wx; else global.wx = savedWx;
  if (savedGetApp === undefined) delete global.getApp; else global.getApp = savedGetApp;
  if (savedGetCurrentPages === undefined) delete global.getCurrentPages; else global.getCurrentPages = savedGetCurrentPages;
}

// ---------------------------------------------------------------------------
// 取回页面注册对象
// ---------------------------------------------------------------------------
var registered = null;
var loadError = null;
try {
  global.Page = function (options) { registered = options; };
  require(path.join(ROOT, 'pages', 'edit', 'edit.js'));
} catch (err) {
  loadError = err;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 造一个页面实例；setData 要认 'form.start_time' 这种带点的键（编辑页大量在用） */
function newPage() {
  var page = {};
  Object.keys(registered).forEach(function (key) { page[key] = registered[key]; });
  page.data = JSON.parse(JSON.stringify(registered.data));
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

/** 等页面内部的 Promise 链跑完（列表 + 设置两条并行链，多让几轮事件循环） */
function settle(rounds) {
  var n = rounds || 8;
  var p = Promise.resolve();
  for (var i = 0; i < n; i += 1) {
    p = p.then(function () { return new Promise(function (resolve) { setImmediate(resolve); }); });
  }
  return p;
}

/** 造一条任务 */
function task(overrides) {
  return Object.assign({
    _id: 't1', title: '任务', type: 'event', date: '2026-09-07',
    start_time: '', end_time: '', periods: '', estimate_min: 0, done: false, repeat: 'none'
  }, overrides || {});
}

/**
 * 云函数桩：一次配好 list / settings_get / add / update 的返回。
 * @param {Object} options { tasks, settings:{semester_start, period_times},
 *                           listFails, settingsFails }
 */
var served = { tasks: [], settings: null, listFails: false, settingsFails: false, saved: [] };

function serve(options) {
  var o = options || {};
  served.tasks = o.tasks || [];
  served.settings = o.settings === undefined ? { semester_start: '', period_times: null } : o.settings;
  served.listFails = !!o.listFails;
  served.settingsFails = !!o.settingsFails;
  served.saved = [];
  // 每个场景自己从零数请求：不然"这一块发了几次 add"会被前面几块的历史搅浑
  callLog = [];

  cloudHandler = function (name, data) {
    var action = data && data.action;
    if (name !== 'tasks') return Promise.resolve({ ok: false, error: 'unexpected function: ' + name });
    if (action === 'list') {
      if (served.listFails) return Promise.resolve({ ok: false, error: '数据库不可用' });
      return Promise.resolve({ ok: true, tasks: served.tasks, count: served.tasks.length });
    }
    if (action === 'settings_get') {
      if (served.settingsFails) return Promise.resolve({ ok: false, error: '设置服务异常' });
      var settings = served.settings || {};
      return Promise.resolve({
        ok: true,
        semester_start: settings.semester_start || '',
        period_times: settings.period_times || null
      });
    }
    if (action === 'add') { served.saved.push(data.task); return Promise.resolve({ ok: true, id: 'new-id' }); }
    if (action === 'update') { served.saved.push(data.patch); return Promise.resolve({ ok: true, updated: 1, id: data.id }); }
    if (action === 'remove') return Promise.resolve({ ok: true, removed: 1 });
    return Promise.resolve({ ok: false, error: 'unexpected action: ' + action });
  };
}

/** 数一数某类请求发了几次 */
function callsOf(action) {
  return callLog.filter(function (item) { return item.data && item.data.action === action; });
}

var DAY = '2026-09-07';                       // 周一
var OPTICAL = task({ _id: 'e1', title: '光学实训', start_time: '08:30', end_time: '09:55' });
var COURSE_P5 = task({ _id: 'p5', title: '大学物理', type: 'event', periods: '5' });   // 只有节次
var PERIODS_35 = task({ _id: 'p35', title: '实验课', type: 'event', periods: '3-5' });
var CALIBRATED = { '5': ['11:45', '12:25'] };                                          // 第 5 节被校准到午休前

// ===========================================================================
// 正式用例
// ===========================================================================
function run() {
  useStub();   // 用例执行时才装桩（加载期不碰全局）

  var ctx = {};   // 跨 .then 传递的页面实例一律挂 ctx（var 写在回调里会串作用域）

  // ---- 0. 页面文件加载情况 ----
  block('edit 页 —— 页面文件可加载');
  isFalse(!!loadError, 'pages/edit/edit.js 加载期没有抛异常'
    + (loadError ? '（实际：' + loadError.message + '）' : ''));
  isTrue(!!registered, 'Page() 注册对象拿到了');
  isTrue(!!registered && typeof registered.onLoad === 'function', 'onLoad 存在');
  isTrue(!!registered && typeof registered.onAvoidBusy === 'function', 'onAvoidBusy 存在');
  isTrue(!!registered && typeof registered.refreshBusy === 'function', 'refreshBusy 存在');
  if (loadError || !registered) return Promise.resolve();   // 页面都加载不了，后面没意义

  // ---- 1. 触发点：日期 / 开始 / 结束 / 时长 / 类型 / 节次 ----
  block('占用提示的触发点 —— 六个交互都要重算，而且不发请求');
  serve({
    tasks: [
      task({ _id: 'm1', title: '小组讨论', start_time: '09:20', end_time: '09:30' }),
      PERIODS_35
    ],
    settings: { semester_start: '2026-09-07', period_times: null }
  });
  ctx.p1 = newPage();
  ctx.p1.onLoad({});
  eq(ctx.p1.data.busyHint, '', 'onLoad 时表单是空的 → 不提示');
  eq(callsOf('list').length, 1, '新增模式下会拉一次任务列表（占用检测要拿它对比）');
  eq(callsOf('settings_get').length, 1, '同时拉一次设置（作息不能靠默认表猜，见 loadPeriodSettings）');

  return settle().then(function () {
    var page = ctx.p1;
    eq(page.allTasks.length, 2, '列表到位');
    eq(page.data.busyHint, '', '数据到位但仍没填时间 → 不提示');

    page.onDateChange({ detail: { value: DAY } });
    eq(page.data.busyHint, '', '只填日期、没填时间/节次 → 不提示');

    page.onStartTimeChange({ detail: { value: '09:00' } });
    isTrue(page.data.busyHint.indexOf('已被占用') > -1,
      '填了开始时间（没写耗时就按 30 分钟兜底 09:00-09:30）→ 与 09:20-09:30 撞上：' + show(page.data.busyHint));
    isTrue(page.data.busyHint.indexOf('小组讨论') > -1, '红字里有那条任务的名字');

    page.onDurationChange({ detail: { value: 1 } });          // 预设下标 1 = 15 分钟
    eq(page.data.form.estimate_min, 15, '先确认耗时真的改成了 15 分钟');
    eq(page.data.busyHint, '', '**改时长是触发点**：09:00-09:15 不再重叠 → 红字消失');

    page.onDurationChange({ detail: { value: 4 } });          // 预设下标 4 = 60 分钟
    isTrue(page.data.busyHint.indexOf('已被占用') > -1, '改成 60 分钟 → 红字回来');

    page.onClearStart();
    eq(page.data.busyHint, '', '**清除开始时间是触发点** → 红字消失');

    page.onStartTimeChange({ detail: { value: '09:00' } });
    page.onEndTimeChange({ detail: { value: '09:10' } });
    eq(page.data.busyHint, '', '09:00-09:10 不撞 → 不提示');
    page.onEndTimeChange({ detail: { value: '09:25' } });
    isTrue(page.data.busyHint.indexOf('已被占用') > -1, '**改结束时间是触发点** → 09:00-09:25 撞上');
    page.onClearEnd();
    isTrue(page.data.busyHint.indexOf('已被占用') > -1, '清除结束时间后又按"起点 + 30 分钟"兜底 → 仍撞');

    page.onTypeChange({ detail: { value: 1 } });              // 1 = 截止
    eq(page.data.isDdl, true, '切到「截止」');
    eq(page.data.busyHint, '', '**改类型是触发点**：截止只有一个时刻 → 不占时间、不提示');
    page.onTypeChange({ detail: { value: 0 } });              // 0 = 日程
    isTrue(page.data.busyHint.indexOf('已被占用') > -1, '改回「日程」→ 红字回来');

    page.onClearStart();
    eq(page.data.busyHint, '', '清掉时间 → 不提示');
    page.onPeriodsInput({ detail: { value: '3-5' } });
    isTrue(page.data.busyHint.indexOf('已被占用') > -1 && page.data.busyHint.indexOf('实验课') > -1,
      '**填节次是触发点**：只有节次的任务也能算出占用（3-5 → 10:00-14:45）');
    page.onPeriodsInput({ detail: { value: '' } });
    eq(page.data.busyHint, '', '清掉节次 → 红字消失');

    eq(callsOf('list').length, 1, '**上面这一串交互一次请求都没发**（占用是同步算的）');
    eq(callsOf('settings_get').length, 1, '设置也只拉了那一次');

    // ---- 2. ddl 的候选口径：按 buildPayload 丢掉 start_time ----
    block('ddl —— 候选按保存口径丢掉 start_time（截止不占时间）');
    serve({ tasks: [OPTICAL], settings: { semester_start: '2026-09-07', period_times: null } });
    ctx.p2 = newPage();
    ctx.p2.onLoad({});
    return settle();
  }).then(function () {
    var page = ctx.p2;
    page.onDateChange({ detail: { value: DAY } });
    page.onStartTimeChange({ detail: { value: '08:30' } });
    page.onEndTimeChange({ detail: { value: '09:00' } });
    isTrue(page.data.busyHint.indexOf('已被占用') > -1, '日程 08:30-09:00 撞上光学实训 → 红字');
    page.onTypeChange({ detail: { value: 1 } });
    eq(page.data.busyHint, '',
      '**切成截止后红字必须消失**：保存时 start_time 会被清掉（只剩截止时刻 09:00），红字不能说得比事实严重');
    page.onTitleInput({ detail: { value: '交实验报告' } });
    served.saved = [];
    page.onSave();
    return settle();
  }).then(function () {
    eq(served.saved.length, 1, '存了一条');
    eq(served.saved[0].start_time, '', '提交的 start_time 是空串（截止只有一个时刻）');
    eq(served.saved[0].end_time, '09:00', '那一刻落在 end_time 上');
    eq(served.saved[0].type, 'ddl', '类型是 ddl');

    // ---- 3. 一键避让：只给"整段的空闲课节"----
    block('一键避让 —— 起点只能是某一节的开始（09:30-10:30 撞课后 → 10:00）');
    serve({ tasks: [OPTICAL], settings: { semester_start: '2026-09-07', period_times: null } });
    ctx.p3 = newPage();
    ctx.p3.onLoad({});
    return settle();
  }).then(function () {
    var page = ctx.p3;
    page.onDateChange({ detail: { value: DAY } });
    page.onStartTimeChange({ detail: { value: '09:30' } });
    page.onEndTimeChange({ detail: { value: '10:30' } });
    isTrue(page.data.busyHint.indexOf('已被占用') > -1, '09:30-10:30 撞上 08:30-09:55');
    isTrue(page.data.canAvoid === true, '能找到空闲课节 → 按钮可点');
    toasts = [];
    page.onAvoidBusy();
    eq(page.data.form.start_time, '10:00',
      '避让后起点 = 第 3 节开始（不是 09:55，也不是网格上的 10:05 —— 只有节次开始时刻能当起点）');
    eq(page.data.form.end_time, '11:00', '时长保持 60 分钟');
    eq(page.data.startPicker, '10:00', 'picker 的显示值跟着走（否则"改"按钮还停在旧时刻）');
    eq(page.data.endPicker, '11:00', '同上');
    eq(page.data.form.periods, '3-4',
      '起点被第 3 节包含 → 节次推得出来，周视图会把它画在第 3-4 节那一段上（与写的时间一致）');
    eq(page.data.busyHint, '', '换完之后红字消失（新时段不再撞）');
    eq(toasts.length, 1, '给了一句 toast');
    isTrue(toasts[0].indexOf('已换到 10:00-11:00') > -1, 'toast 说明换到了哪：' + show(toasts[0]));
    isTrue(toasts[0].indexOf('节次请自己填') === -1, '节次推得出来时不再提醒"自己填"');

    block('一键避让 —— 起点落在某一节里时节次一起填（08:00 撞课后 → 08:55）');
    serve({
      tasks: [task({ _id: 'e2', title: '早课', start_time: '08:00', end_time: '08:40' })],
      settings: { semester_start: '2026-09-07', period_times: null }
    });
    ctx.p3b = newPage();
    ctx.p3b.onLoad({});
    return settle();
  }).then(function () {
    var page = ctx.p3b;
    page.onDateChange({ detail: { value: DAY } });
    page.onStartTimeChange({ detail: { value: '08:00' } });
    isTrue(page.data.busyHint.indexOf('已被占用') > -1, '08:00（+30 分钟兜底）撞上 08:00-08:40');
    toasts = [];
    page.onAvoidBusy();
    eq(page.data.form.start_time, '08:55', '起点 = 下一节开始（第 1 节 08:45 才下课，起不来）');
    eq(page.data.form.end_time, '09:25', '时长 30 分钟');
    eq(page.data.form.periods, '2', '起点落在第 2 节里 → 节次填 "2"');
    isTrue(toasts[0].indexOf('节次请自己填') === -1, '推得出节次时就不再提醒这件事');

    // ---- 4. 找不到整段空闲课节：置灰 + 说清原因 ----
    block('一键避让 —— 找不到整段的空闲课节');
    serve({
      tasks: [task({ _id: 'full', title: '占满一天', start_time: '08:00', end_time: '23:15' })],
      settings: { semester_start: '2026-09-07', period_times: null }
    });
    ctx.p4 = newPage();
    ctx.p4.onLoad({});
    return settle();
  }).then(function () {
    var page = ctx.p4;
    page.onDateChange({ detail: { value: DAY } });
    page.onStartTimeChange({ detail: { value: '09:00' } });
    page.onEndTimeChange({ detail: { value: '10:00' } });
    isTrue(page.data.busyHint.indexOf('已被占用') > -1, '整天被占 → 出红字');
    isFalse(page.data.canAvoid, '一个课节都装不下 → 按钮置灰（canAvoid false）');
    isTrue(page.data.avoidTip.indexOf('今天没有整段的空闲课节') > -1, '并给出原因：' + show(page.data.avoidTip));
    toasts = [];
    page.onAvoidBusy();
    eq(toasts.join('|'), '今天没有整段的空闲课节', '点了也不会默默无反应');
    eq(page.data.form.start_time, '09:00', '不会把用户填的时间改坏');
    eq(page.data.form.periods, '', '也不会顺手塞一个节次进去');

    // ---- 5. 读不到数据时的降级（都只影响提示，不影响保存）----
    block('降级 —— 任务列表读不到：没有提示，但照样能建任务');
    serve({ tasks: [OPTICAL], listFails: true });
    ctx.p5 = newPage();
    ctx.p5.onLoad({});
    return settle();
  }).then(function () {
    var page = ctx.p5;
    eq(page.data.errorText, '', '拉列表失败**不写 errorText**（那会把整张表单变成错误页）');
    eq(page.data.loading, false, '也不停在 loading');
    page.onDateChange({ detail: { value: DAY } });
    page.onStartTimeChange({ detail: { value: '08:30' } });
    page.onEndTimeChange({ detail: { value: '09:00' } });
    eq(page.data.busyHint, '', '拉不到列表 → 没有占用提示（如实"不知道"，不瞎报）');
    page.onTitleInput({ detail: { value: '照常保存' } });
    served.saved = [];
    toasts = [];
    page.onSave();
    return settle();
  }).then(function () {
    eq(served.saved.length, 1, '**列表读不到也照样能新建**');
    isTrue(toasts.indexOf('已添加') > -1, '保存成功的 toast 照常：' + show(toasts));

    block('降级 —— 编辑模式下任务列表读不到：仍然报错（老行为没被改坏）');
    serve({ tasks: [OPTICAL], listFails: true });
    ctx.p5b = newPage();
    ctx.p5b.onLoad({ id: 'e1' });
    return settle();
  }).then(function () {
    isTrue(ctx.p5b.data.errorText.indexOf('读取失败') > -1,
      '编辑模式读不到就是读不到，要如实说：' + show(ctx.p5b.data.errorText));

    // ---- 6. 作息口径：用设置里的 period_times，而不是内置默认作息 ----
    block('作息口径 —— 校准作息下算占用、默认作息下不算（结论必须翻转）');
    // 只有节次的"大学物理 · 第 5 节"：默认作息 14:00-14:45；校准后 11:45-12:25
    serve({ tasks: [COURSE_P5], settings: { semester_start: '2026-09-07', period_times: CALIBRATED } });
    eq(Object.keys(appGlobalData.periodTimes).length, 0,
      '前提：globalData 里**没有**作息（模拟冷启动/深链，app.js 那次同步还没回来）');
    ctx.p6 = newPage();
    ctx.p6.onLoad({});
    return settle();
  }).then(function () {
    var page = ctx.p6;
    eq(page.data.busyHint, '', '（还没填时间，先确认基线不提示）');
    page.onDateChange({ detail: { value: DAY } });
    page.onStartTimeChange({ detail: { value: '12:00' } });
    page.onEndTimeChange({ detail: { value: '12:20' } });
    isTrue(page.data.busyHint.indexOf('已被占用') > -1 && page.data.busyHint.indexOf('大学物理') > -1,
      '**设置里的校准作息生效了**：12:00-12:20 撞上校准后的第 5 节 11:45-12:25：' + show(page.data.busyHint));

    block('作息口径 —— 设置里没有 period_times 时按默认作息（同上输入，结论相反）');
    serve({ tasks: [COURSE_P5], settings: { semester_start: '2026-09-07', period_times: null } });
    ctx.p6b = newPage();
    ctx.p6b.onLoad({});
    return settle();
  }).then(function () {
    var page = ctx.p6b;
    page.onDateChange({ detail: { value: DAY } });
    page.onStartTimeChange({ detail: { value: '12:00' } });
    page.onEndTimeChange({ detail: { value: '12:20' } });
    eq(page.data.busyHint, '',
      '**同一段时间，默认作息下（第 5 节是 14:00）不撞** —— 两种情况结论不同，说明真的按设置算');

    block('作息口径 —— 设置迟到：拿到之后必须补算一次（冷启动/深链的真实时序）');
    // 真实时序：onLoad 里两个请求都还没回来，用户就已经把时间填好了。
    // 这时页面手上的作息还是"默认表"、任务列表还是空的 → 结论没意义；
    // 等列表与设置陆续到位，**必须**各自再算一次，否则用户看到的是一个错的结论。
    serve({ tasks: [COURSE_P5], settings: { semester_start: '2026-09-07', period_times: CALIBRATED } });
    ctx.p6d = newPage();
    ctx.p6d.onLoad({});                       // 故意不 settle：模拟"请求还在路上"
    ctx.p6d.onDateChange({ detail: { value: DAY } });
    ctx.p6d.onStartTimeChange({ detail: { value: '12:00' } });
    ctx.p6d.onEndTimeChange({ detail: { value: '12:20' } });
    eq(ctx.p6d.data.busyHint, '', '列表与设置都还没到 → 此时算不出占用（如实"还不知道"）');
    return settle();
  }).then(function () {
    isTrue(ctx.p6d.data.busyHint.indexOf('已被占用') > -1,
      '**数据到位后自动补算**：校准作息 + 任务列表都到齐 → 红字出来了：' + show(ctx.p6d.data.busyHint));

    // ---- 6e. 设置读失败：不阻塞保存，只是提示可能不准 ----
    block('作息口径 —— 设置读失败：不阻塞保存，只是提示可能不准');
    serve({ tasks: [COURSE_P5], settingsFails: true });
    ctx.p6c = newPage();
    ctx.p6c.onLoad({});
    return settle();
  }).then(function () {
    var page = ctx.p6c;
    eq(page.data.errorText, '', '设置读失败不写 errorText');
    page.onDateChange({ detail: { value: DAY } });
    page.onStartTimeChange({ detail: { value: '12:00' } });
    eq(page.data.busyHint, '', '按默认作息算 → 这次没有提示（可能不准，但绝不放任用户卡住）');
    page.onTitleInput({ detail: { value: '设置读不到也要能建' } });
    served.saved = [];
    toasts = [];
    page.onSave();
    return settle();
  }).then(function () {
    eq(served.saved.length, 1, '**设置读失败不影响保存**');
    isTrue(toasts.indexOf('已添加') > -1, '保存照常成功：' + show(toasts));

    // ---- 7. semester_start 也要真的传下去（每周重复的课靠它算周次）----
    block('作息口径 —— semester_start 生效：第 17 周的课不再占时间');
    // 【踩坑】var 写在 .then 回调里，下一个 .then 是看不到的（函数作用域），
    // 所以跨步骤用的东西一律挂 ctx —— 与 ai_page.test.js 同一条教训。
    ctx.weekly = task({
      _id: 'w1', title: '高等数学', date: '2026-09-07', start_time: '08:00', end_time: '09:40',
      repeat: 'weekly', week_start: 1, week_end: 16, week_parity: 'all'
    });
    serve({ tasks: [ctx.weekly], settings: { semester_start: '2026-09-07', period_times: null } });
    ctx.p7 = newPage();
    ctx.p7.onLoad({});
    return settle();
  }).then(function () {
    var page = ctx.p7;
    // 2026-12-28 是第 17 周的周一（2026-09-07 + 16 周），超出 week_end=16 → 这门课不上
    page.onDateChange({ detail: { value: '2026-12-28' } });
    page.onStartTimeChange({ detail: { value: '08:00' } });
    page.onEndTimeChange({ detail: { value: '09:00' } });
    eq(page.data.busyHint, '',
      '设置了学期开始日期 → 能算出第 17 周 → 这门课不再占时间（说明 semester_start 真的传给了检测）');

    block('作息口径 —— 算不出周次时宁可多提示（semester_start 缺失的兜底）');
    serve({ tasks: [ctx.weekly], settings: { semester_start: '', period_times: null } });
    ctx.p7b = newPage();
    ctx.p7b.onLoad({});
    return settle();
  }).then(function () {
    var page = ctx.p7b;
    page.onDateChange({ detail: { value: '2026-12-28' } });
    page.onStartTimeChange({ detail: { value: '08:00' } });
    page.onEndTimeChange({ detail: { value: '09:00' } });
    isTrue(page.data.busyHint.indexOf('已被占用') > -1,
      '没有学期开始日期 → 算不出周次 → 宁可提示"这段时间有课"（与课表页同一取舍）');

    // ---- 8. 编辑模式：不算自己 + 保存走 update ----
    block('编辑模式 —— 排除自己，保存走 update');
    serve({
      tasks: [PERIODS_35, OPTICAL],
      settings: { semester_start: '2026-09-07', period_times: null }
    });
    ctx.p8 = newPage();
    ctx.p8.onLoad({ id: 'p35' });
    return settle();
  }).then(function () {
    var page = ctx.p8;
    eq(page.data.form.periods, '3-5', '编辑模式读到了那条只有节次的任务');
    eq(page.data.busyHint, '', '**编辑自己不撞自己**（候选 id = 这条任务的 _id，已被排除）');
    page.onStartTimeChange({ detail: { value: '08:30' } });
    page.onEndTimeChange({ detail: { value: '09:00' } });
    isTrue(page.data.busyHint.indexOf('已被占用') > -1, '改成与"光学实训"重叠的时间 → 照样能报出来');
    served.saved = [];
    page.onSave();
    return settle();
  }).then(function () {
    eq(callsOf('update').length, 1, '编辑模式保存走 update');
    eq(callsOf('add').length, 0, '不会是 add');
    eq(served.saved.length, 1, '提交了一份 patch');
    eq(served.saved[0].start_time, '08:30', 'patch 里带着新的开始时间');

    // ---- 9. 估算出来的长度要如实说明 ----
    block('估算附注 —— 没写预计耗时的占用要说清"按 30 分钟估算"');
    serve({
      tasks: [task({ _id: 'guess', title: '没写耗时的事', start_time: '10:00' })],
      settings: { semester_start: '2026-09-07', period_times: null }
    });
    ctx.p9 = newPage();
    ctx.p9.onLoad({});
    return settle();
  }).then(function () {
    var page = ctx.p9;
    page.onDateChange({ detail: { value: DAY } });
    page.onStartTimeChange({ detail: { value: '10:10' } });
    isTrue(page.data.busyHint.indexOf('已被占用') > -1, '撞上"10:00 + 30 分钟兜底"的那段');
    isTrue(page.data.busyNote.indexOf('按 30 分钟估算') > -1,
      '并附注说明这条的长度是估的：' + show(page.data.busyNote));

    // 【为什么最后要空等 700ms】保存成功后页面会 setTimeout(600ms) 回列表页（backToList）。
    // 那个定时器会在本文件"跑完之后"才触发；要是此时已经 restoreGlobals() 把
    // getCurrentPages / wx 还原成 undefined，回调就会抛 TypeError —— 在 run.js 里
    // 那是**未捕获异常**，会把整个测试入口带崩（不是本文件的失败，是所有人的失败）。
    // 所以这里等它先烧完，再交还全局。别顺手删掉这一句。
    return new Promise(function (resolve) { setTimeout(resolve, 700); });
  }).then(function () {
    // -------------------------------------------------------------------------
    // 10. buildPayload —— "表单 → 交给云函数的那份数据"（真正决定存下去什么）
    // -------------------------------------------------------------------------
    // 这一层以前只在别处的注释里被提到过，没有断言直接盯着它。加"每天重复"时最典型的
    // 漏法就是这里少写一个分支：界面上选了"每天"，存下去却变成"不重复" ——
    // 而 utils/tasks.js 与云端那两层的测试**都不会红**（它们收到的输入已经错了）。
    block('编辑页提交载荷 —— buildPayload：不重复 / 每周 / 每天三种都要对');
    var T = registered.__test;
    isTrue(!!T && typeof T.buildPayload === 'function', '页面通过 __test 暴露了 buildPayload');
    eq(T.REPEATS.map(function (r) { return r.value; }).join(','), 'none,weekly,daily',
      '编辑页的重复选项有且只有这三种（顺序也钉住，picker 下标与它一一对应）');

    function formOf(over) {
      return Object.assign(T.emptyForm(), {
        title: '学习打卡', type: 'event', date: '2026-09-07',
        start_time: '12:30', end_time: '12:40', priority: 'mid',
        week_start: 1, week_end: 20, week_parity: 'all'
      }, over || {});
    }

    var noneForm = T.buildPayload(formOf({ repeat: 'none' })).task;
    eq(noneForm.repeat, 'none', '不重复 → none');
    eq(noneForm.week_start, null, '不重复 → 不带周次（让云端存 null，数据干净）');
    eq(noneForm.week_parity, 'all', '不重复 → 单双周 all');

    var weeklyForm = T.buildPayload(formOf({
      repeat: 'weekly', week_start: 3, week_end: 16, week_parity: 'odd'
    })).task;
    eq(weeklyForm.repeat, 'weekly', '每周 → weekly');
    eq(weeklyForm.week_start, 3, '每周 → 起始周照传');
    eq(weeklyForm.week_end, 16, '每周 → 结束周照传');
    eq(weeklyForm.week_parity, 'odd', '每周 → 单双周照传');

    var dailyForm = T.buildPayload(formOf({ repeat: 'daily', week_start: 2, week_end: 18 })).task;
    eq(dailyForm.repeat, 'daily', '**每天 → daily**（少写这个分支就会静默存成"不重复"）');
    eq(dailyForm.week_start, 2, '每天 → 周次范围照传（"第 2~18 周每天"）');
    eq(dailyForm.week_end, 18, '每天 → 结束周照传');
    eq(dailyForm.week_parity, 'all', '**每天 → 单双周一律 all**');
    eq(T.buildPayload(formOf({ repeat: 'daily', week_parity: 'odd' })).task.week_parity, 'all',
      '每天 + 单周 → 仍然 all（与 utils/tasks.js 的补丁清理同一口径）');
    eq(dailyForm.start_time, '12:30', '每天的时间照传');
    eq(dailyForm.date, '2026-09-07', 'date 就是"第一次发生的那天"（每天由 repeat 表达）');
    return null;
  }).then(function () {
    // -------------------------------------------------------------------------
    // 11. 缺时刻的截止 —— 什么该问、什么不该问
    // -------------------------------------------------------------------------
    // 真实事故（2026-10-21）：用户 27 条"该提醒"的截止里有 25 条是"截止没填时刻"，
    // 被规划器按设计跳过（云函数 dueInstantOf 刻意不替用户猜 23:59）。
    // 界面上原本一点都看不出来 —— 他以为"设了截止"就等于"会有提醒"。
    // 所以两处补：列表打「缺时刻·不会提醒」标 + 存之前问一句。
    block('缺时刻的截止 —— 判据（哪一批会永远收不到提醒）');
    var T2 = registered.__test;
    isTrue(!!T2 && typeof T2.needsTimePrompt === 'function', '页面通过 __test 暴露了 needsTimePrompt');
    eq(T2.FILL_TIME, '23:59', '补的时刻钉住是 23:59（不是 00:00 —— 截止是"这一天结束前"）');
    isTrue(T2.needsTimePrompt({ type: 'ddl', date: DAY, start_time: '', end_time: '' }) === true,
      '截止 + 日期 + 一个时刻都没有 → 要问（这种一定收不到提醒）');
    isFalse(T2.needsTimePrompt({ type: 'ddl', date: DAY, start_time: '', end_time: '18:00' }) === true,
      '有 end_time → 不问（dueInstantOf 认的就是它）');
    isFalse(T2.needsTimePrompt({ type: 'ddl', date: DAY, start_time: '18:00', end_time: '' }) === true,
      '只有 start_time 的老数据 → 不问（buildPayload 会把它迁移到 end_time，提醒收得到）');
    isFalse(T2.needsTimePrompt({ type: 'event', date: DAY }) === true,
      '日程不进到期提醒（提醒只认 ddl）→ 不该被问');
    isFalse(T2.needsTimePrompt({ type: 'subtask', date: DAY }) === true, '子任务不问');
    isFalse(T2.needsTimePrompt(null) === true, 'null 不炸');
    return null;
  }).then(function () {
    // 页面级：先把 p7 备好（新增一条没有时刻的截止），下一段再按三种回答各存一次
    block('缺时刻的截止 —— 保存时真的会问，三种回答都要能存下去');
    serve({ tasks: [], settings: { semester_start: DAY, period_times: null } });
    ctx.p7 = newPage();
    // 【别让那个 600ms 回列表的定时器活到 restoreGlobals 之后】本文件末尾专门写过这个坑；
    // 这一段在末尾那次等待之后，所以直接把跳转换成空函数。
    ctx.p7.backToList = function () {};
    ctx.p7.onLoad({});
    return settle();
  }).then(function () {
    var page = ctx.p7;
    ctx.modals = [];
    ctx.answer = { confirm: true, cancel: false };
    global.wx.showModal = function (options) {
      ctx.modals.push(options);
      if (options && typeof options.success === 'function') options.success(ctx.answer);
    };
    var modals = ctx.modals;

    page.onTypeChange({ detail: { value: 1 } });                     // 下标 1 = 截止
    page.onTitleInput({ detail: { value: '交实验报告' } });
    page.onDateChange({ detail: { value: DAY } });
    eq(page.data.form.type, 'ddl', '类型切到了截止');
    eq(page.data.form.end_time, '', '先确认：时刻确实是空的');

    // ---- ① 点「自动填」→ 表单里出现 23:59，存下去的也是 23:59 ----
    page.onSave();
    eq(modals.length, 1, '缺时刻 → 保存会被拦下来问一句（不是默默存掉）');
    eq(modals[0].confirmText, '自动填', '按钮一：自动填');
    eq(modals[0].cancelText, '原样存', '按钮二：原样存（不拦死正当用法）');
    isTrue(String(modals[0].content).indexOf('23:59') > -1, '弹窗里写清了会补成 23:59');
    isTrue(String(modals[0].content).indexOf('提醒') > -1, '也写清了后果：不填就没有提醒');
    eq(page.data.form.end_time, '23:59', '**确认之后表单里真的出现了 23:59**（不是偷偷改）');
    return settle();
  }).then(function () {
    var page = ctx.p7;
    eq(served.saved.length, 1, '确认完才真的发起保存');
    eq(served.saved[0].end_time, '23:59', '**交给云函数的那份数据里也是 23:59**（这才是提醒能响的前提）');
    eq(served.saved[0].type, 'ddl', '类型照旧是截止');
    return null;
  }).then(function () {
    // ---- ② 点「原样存」→ 不补时刻，照样存下去 ----
    var page = ctx.p7;
    ctx.answer = { confirm: false, cancel: true };
    // ①把表单里的时刻填成 23:59 了，这里先清回去（测的是"原样存"，不是同一个表单连存两次）
    page.setData({ saving: false, 'form.end_time': '' });
    page.onDateChange({ detail: { value: DAY } });
    page.onSave();
    return settle().then(function () {
      eq(ctx.modals.length, 2, '第二条缺时刻的截止照样会问');
      eq(served.saved.length, 2, '"原样存"也照存（没有把人拦死）');
      eq(served.saved[1].end_time, '', '存下去的就是空的（尊重"我只想记个日期"）');
      return null;
    });
  }).then(function () {
    // ---- ③ 弹窗自己失败（比如被别的东西挡住）→ 也必须能存 ----
    var page = ctx.p7;
    global.wx.showModal = function (options) {
      if (options && typeof options.fail === 'function') options.fail({ errMsg: 'showModal:fail' });
    };
    page.setData({ saving: false });
    page.onDateChange({ detail: { value: DAY } });
    page.onSave();
    return settle().then(function () {
      eq(served.saved.length, 3, '**弹窗失败不该让人连保存都做不了**');
      return null;
    });
  }).then(function () {
    // ---- ④ 已经有时刻的截止 → 一次都别问 ----
    var page = ctx.p7;
    var asked = 0;
    global.wx.showModal = function () { asked += 1; };
    page.setData({ saving: false, 'form.end_time': '18:00' });
    page.onDateChange({ detail: { value: DAY } });
    page.onSave();
    return settle().then(function () {
      eq(asked, 0, '有时刻 → 不问（否则每次保存都弹，成了骚扰）');
      eq(served.saved.length, 4, '直接存掉');
      eq(served.saved[3].end_time, '18:00', '时刻原样带着');
      return null;
    });
  }).then(function () {
    // ---- ⑤ 界面上那条提示 + 小链接（静态检查，防止只改了 js 忘了 wxml） ----
    var fs = require('fs');
    var wxml = fs.readFileSync(path.join(ROOT, 'pages', 'edit', 'edit.wxml'), 'utf8');
    var wxss = fs.readFileSync(path.join(ROOT, 'pages', 'edit', 'edit.wxss'), 'utf8');
    isTrue(wxml.indexOf('onFill2359') > -1, '编辑页有时间提示里的小链接（catchtap="onFill2359"）');
    isTrue(wxml.indexOf('微信提醒会跳过它') > -1, '提示里直说后果（微信提醒会跳过它）');
    isTrue(wxml.indexOf('设为当天 23:59') > -1, '小链接文案写着 23:59');
    isTrue(wxml.indexOf('isDdl && !form.end_time && !form.start_time') > -1,
      '提示的显示条件与 needsTimePrompt 同一口径（含 start_time，老数据不误报）');
    isTrue(wxss.indexOf('.hint-warn') > -1 && wxss.indexOf('.hint-link') > -1,
      '两个新样式类都在（琥珀色 + 可点链接）');
    return null;
  });
}

// ---------------------------------------------------------------------------
// 导出给 run.js 串行调用；单独跑时自己收尾
// ---------------------------------------------------------------------------
var done = Promise.resolve()
  .then(run)
  .then(function () {
    restoreGlobals();   // 用例跑完把全局还回去，不影响别的测试文件
    if (require.main === module) H.report('pages/edit/edit.js 占用提示与一键避让');
  })
  .catch(function (err) {
    restoreGlobals();
    console.error('edit 占用提示测试自己崩了：', err);
    process.exit(2);
  });

module.exports = { done: done };
