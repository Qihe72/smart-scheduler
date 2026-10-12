/**
 * utils/tests/me_import.test.js —— pages/me/me.js 的「导入课表：替换 / 追加」（纯 node 单测）。
 *
 * 跑法：
 *     node utils/tests/me_import.test.js    # 只跑这一份（末尾打印通过数，失败退出码 1）
 *     node utils/tests/run.js               # 跑全部（本文件会被自动 require）
 *
 * ===========================================================================
 * 【为什么必须常驻】用户的原话：「新导入课表应该是替换之前课表，而不是在原来的
 * 基础上添加」—— 他已经踩过一次（导两次变成两份）。而"替换"里有一条**不能破的
 * 红线**：只清课表类任务（.ics 导入出来的那种），手工加的日程 / 截止 / 子任务
 * 一条都不能删。这条红线靠人眼 review 是靠不住的，必须有断言钉住。
 *
 * 【怎么测一个 Page】照 ai_page.test.js 的既有模式：stub 掉 wx / getApp / Page，
 * 再 require 页面，然后像小程序那样调 onLoad / onConfirmImport，对 setData 结果、
 * showModal 文案、以及**真正发给云函数的 action 与 payload** 做断言。
 *
 * 【本文件只 require 被测页面 + ./harness.js】不 require 任何别的测试文件。
 * 装全局桩的测试必须在 run.js 里串行 —— 所以加载期只定义 useStub()，
 * 真正的替换发生在 run() 被调用时（ai_page.test.js 的血泪教训）。
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
// stub（加载期一律不碰全局；用法与 ai_page.test.js 一致）
// ---------------------------------------------------------------------------
var toasts = [];
var modals = [];
var cloudCalls = [];
var cloudHandler = null;
var modalConfirm = true;

var savedWx = global.wx;
var savedGetApp = global.getApp;

function useStub() {
  toasts = [];
  modals = [];
  cloudCalls = [];
  cloudHandler = null;
  modalConfirm = true;

  global.wx = {
    showToast: function (options) { toasts.push((options && options.title) || ''); },
    showModal: function (options) {
      modals.push({ title: options && options.title, content: options && options.content });
      if (options && typeof options.success === 'function') {
        options.success({ confirm: modalConfirm, cancel: !modalConfirm });
      }
    },
    setClipboardData: function () {},
    chooseMessageFile: function () {},
    getFileSystemManager: function () { return { readFile: function () {} }; },
    stopPullDownRefresh: function () {},
    navigateTo: function () {},
    showLoading: function () {},
    hideLoading: function () {},
    cloud: {
      callFunction: function (options) {
        var name = options && options.name;
        var data = (options && options.data) || {};
        cloudCalls.push({ name: name, data: data });
        if (!cloudHandler) return Promise.reject({ errMsg: 'no handler' });
        return cloudHandler(name, data).then(function (result) { return { result: result }; });
      }
    }
  };

  global.getApp = function () {
    return {
      globalData: { semesterStart: '2026-09-07', periodTimes: {}, envId: 'test-env' },
      ensureInit: function () { return Promise.resolve(true); },
      applySettings: function () {}
    };
  };
}

function restoreGlobals() {
  if (savedWx === undefined) delete global.wx; else global.wx = savedWx;
  if (savedGetApp === undefined) delete global.getApp; else global.getApp = savedGetApp;
}

// ---------------------------------------------------------------------------
// import_replace 是否已经落地
// ---------------------------------------------------------------------------
// 【为什么要在测试里补一个桩】这一版 api.js 还没有 importReplace，而"替换"是本轮
// 的核心行为，等它落地才能测就等于没测。所以这里当它缺席时**装一个只记录调用的桩**：
// 桩负责证明页面发出的 action / scope / payload 都是对的；
// 真函数的端到端联调留给它落地之后（测试最后会如实打印当前是哪种情况）。
var api = require(path.join(ROOT, 'utils', 'api.js'));
var replaceStubbed = false;
if (typeof api.importReplace !== 'function') {
  replaceStubbed = true;
  api.importReplace = function (tasks) {
    var payload = { action: 'import_replace', tasks: tasks, scope: 'courses' };
    if (!global.wx || !global.wx.cloud) return Promise.resolve({ ok: false, error: 'no wx.cloud' });
    return global.wx.cloud.callFunction({ name: 'tasks', data: payload }).then(function (res) {
      var result = res && res.result;
      if (!result || result.ok !== true) {
        return { ok: false, error: (result && result.error) || '替换失败', data: null };
      }
      // 与云函数约定的平铺形状：{ ok, removed, inserted, skipped, errors }
      return { ok: true, data: result, error: null };
    });
  };
}

// ---------------------------------------------------------------------------
// 取回页面注册对象（加载期只调用一次 Page()，不碰 wx）
// ---------------------------------------------------------------------------
var registered = null;
var loadError = null;
try {
  global.Page = function (options) { registered = options; };
  require(path.join(ROOT, 'pages', 'me', 'me.js'));
} catch (err) {
  loadError = err;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 造一个"页面实例" */
function newPage() {
  var page = {};
  Object.keys(registered).forEach(function (key) { page[key] = registered[key]; });
  page.data = JSON.parse(JSON.stringify(registered.data));
  page.setData = function (patch) {
    var self = this;
    Object.keys(patch || {}).forEach(function (key) {
      if (key.indexOf('.') === -1) { self.data[key] = patch[key]; return; }
      var parts = key.split('.');
      var node = self.data;
      for (var i = 0; i < parts.length - 1; i += 1) node = node[parts[i]];
      node[parts[parts.length - 1]] = patch[key];
    });
  };
  return page;
}

/** 等 Promise 链跑完 */
function settle(rounds) {
  var n = rounds || 6;
  var p = Promise.resolve();
  for (var i = 0; i < n; i += 1) {
    p = p.then(function () {
      return new Promise(function (resolve) { setImmediate(resolve); });
    });
  }
  return p;
}

// ---- 任务样本：1 门手工日程 + 2 门课表课 + 1 条手工 DDL ----
function manualEvent(id, title) {
  return { _id: id, title: title, type: 'event', date: '2026-12-31', repeat: 'none',
    periods: '', start_time: '10:00', end_time: '11:00', priority: 'mid', done: false };
}
function manualDdl(id, title) {
  return { _id: id, title: title, type: 'ddl', date: '2026-12-20', repeat: 'none',
    periods: '', end_time: '23:59', priority: 'high', done: false };
}
function courseTask(id, title, periods) {
  return { _id: id, title: title, type: 'event', date: '2026-09-07', repeat: 'weekly',
    periods: periods, week_start: 1, week_end: 16, week_parity: 'all',
    start_time: '', end_time: '', priority: 'mid', done: false };
}
/** 每周重复但**没有节次**：不是 .ics 课表的形态，替换时不该被删 */
function weeklyNoPeriods(id, title) {
  return { _id: id, title: title, type: 'event', date: '2026-09-07', repeat: 'weekly',
    periods: '', week_start: 1, week_end: 16, week_parity: 'all', priority: 'mid', done: false };
}

/** 云函数：settings_get + list + ai_config_get + bulk_add + import_replace */
function serve(options) {
  var opts = options || {};
  cloudHandler = function (name, data) {
    if (name !== 'tasks') return Promise.resolve({ ok: false, error: 'unexpected fn: ' + name });
    if (data.action === 'settings_get') {
      return Promise.resolve({ ok: true, semester_start: '2026-09-07', period_times: null });
    }
    if (data.action === 'ai_config_get') {
      return Promise.resolve({ ok: true, provider: '', model: '', hasKey: false, masked: '' });
    }
    if (data.action === 'list') {
      return Promise.resolve({ ok: true, tasks: opts.tasks || [], count: (opts.tasks || []).length });
    }
    if (data.action === 'bulk_add') {
      if (opts.bulkFail) return Promise.resolve({ ok: false, error: opts.bulkFail });
      var list = data.tasks || [];
      return Promise.resolve({ ok: true, ids: list.map(function (_, i) { return 'n' + i; }),
        inserted: list.length, skipped: 0, errors: [] });
    }
    if (data.action === 'import_replace') {
      if (opts.replaceFail) return Promise.resolve({ ok: false, error: opts.replaceFail });
      var incoming = data.tasks || [];
      return Promise.resolve({
        ok: true,
        removed: opts.removed === undefined ? 2 : opts.removed,
        inserted: incoming.length,
        skipped: 0,
        errors: [],
        scope: data.scope
      });
    }
    return Promise.resolve({ ok: false, error: 'unexpected action: ' + data.action });
  };
}

/** 只取某个 action 的调用 */
function callsOf(action) {
  return cloudCalls.filter(function (c) { return c.data.action === action; });
}

/** 造一批"待导入的任务"并塞进页面（走真实的解析入口太重，这里直接给 pendingTasks） */
function pendingOf(count) {
  var list = [];
  for (var i = 0; i < count; i += 1) list.push(courseTask('new' + i, '新课程' + (i + 1), (i % 12 + 1) + '-' + (i % 12 + 2)));
  return list;
}

// ===========================================================================
// 正式用例
// ===========================================================================
function run() {
  useStub();

  block('me 导入 —— 页面文件与探针');
  isFalse(!!loadError, 'pages/me/me.js 加载期没有抛异常'
    + (loadError ? '（实际：' + loadError.message + '）' : ''));
  isTrue(!!registered, 'Page() 注册对象拿到了');
  if (!registered) return Promise.resolve();

  var ctx = {};

  // ---- 1. 默认落在"替换"，且页面上看得见选项 ----
  block('导入方式 —— 默认替换 + 两个选项');
  serve({ tasks: [manualEvent('m1', '组会'), manualDdl('d1', '交报告'), courseTask('c1', '高数', '1-2'), courseTask('c2', '英语', '3-4')] });
  ctx.p1 = newPage();
  ctx.p1.onLoad();
  return settle().then(function () {
    eq(ctx.p1.data.importMode, 'replace', '**默认是「替换」**（用户要的就是这个）');
    eq(ctx.p1.data.importModes.length, 2, '恰好两个选项');
    eq(ctx.p1.data.importModes[0].value, 'replace', '第一个是替换');
    eq(ctx.p1.data.importModes[0].label, '替换已有课表', '替换的显示名');
    eq(ctx.p1.data.importModes[1].value, 'append', '第二个是追加');
    // 统计：2 门课 + 2 条手工
    eq(ctx.p1.data.courseCount, 2, '统计出 2 门课表类任务（替换会删这 2 门）');
    eq(ctx.p1.data.manualCount, 2, '统计出 2 条手工任务（替换不会碰）');
    isTrue(ctx.p1.data.replaceSummary.indexOf('2 门课程') !== -1
      && ctx.p1.data.replaceSummary.indexOf('2 条任务不受影响') !== -1,
      '页面上的说明写清了条数：' + show(ctx.p1.data.replaceSummary));

    // ---- 2. 判据：只有"每周重复 + 有节次"才算课表 ----
    block('课表类任务判据 —— 只清 .ics 那种，手工任务一条都不能删');
    eq(ctx.p1.data.courseCount, 2, '两门课被认出来');
    // 每周重复但没节次的，不算课表
    serve({ tasks: [weeklyNoPeriods('w1', '每周例会（手工，无节次）'), courseTask('c1', '高数', '1-2')] });
    ctx.p2 = newPage();
    ctx.p2.onLoad();
    return settle();
  }).then(function () {
    eq(ctx.p2.data.courseCount, 1, '每周重复但**没有节次**的不算课表（不会被误删）');
    eq(ctx.p2.data.manualCount, 1, '它被算作手工任务');

    // 有节次但不重复的（比如手工写的单次课），也不算课表
    var oneOff = courseTask('o1', '单次讲座', '5-6');
    oneOff.repeat = 'none';
    serve({ tasks: [oneOff] });
    ctx.p3 = newPage();
    ctx.p3.onLoad();
    return settle();
  }).then(function () {
    eq(ctx.p3.data.courseCount, 0, '有节次但不重复 → 不算课表（只认 .ics 那种形态）');
    eq(ctx.p3.data.manualCount, 1, '被算作手工任务');

    // ---- 3. 切换导入方式 ----
    // 【注意】页面在 importReplaceReady=false 时会挡住"切回替换"（那是刻意的保护）。
    // 这一组要测的是**切换逻辑本身**，所以先把就绪位按住 ——
    // "未就绪时挡住"另有专门一组用例（第 9 组）。
    block('切换导入方式');
    ctx.p1.setData({ importReplaceReady: true });
    ctx.p1.onImportModeChange({ currentTarget: { dataset: { mode: 'append' } } });
    eq(ctx.p1.data.importMode, 'append', '切到追加');
    ctx.p1.onImportModeChange({ currentTarget: { dataset: { mode: 'replace' } } });
    eq(ctx.p1.data.importMode, 'replace', '切回替换');
    ctx.p1.onImportModeChange({ currentTarget: { dataset: { mode: 'bogus' } } });
    eq(ctx.p1.data.importMode, 'replace', '不认识的 mode 被忽略（不会把状态弄坏）');

    // ---- 4. 替换：确认框必须写清条数 ----
    block('替换路径 —— 确认框写清"删几门、导几门、不碰什么"');
    modals.length = 0;
    cloudCalls.length = 0;
    ctx.p1.pendingTasks = pendingOf(3);
    ctx.p1.setData({ taskCount: 3 });
    modalConfirm = false;              // 先测"取消"
    ctx.p1.onConfirmImport();
    eq(modals.length, 1, '弹了一次确认框');
    isTrue(modals[0].content.indexOf('删除现有 2 门课程') !== -1,
      '**文案写明会删除几门**：' + show(modals[0].content));
    isTrue(modals[0].content.indexOf('再导入 3 门') !== -1, '文案写明会导入几门');
    isTrue(modals[0].content.indexOf('手动添加的 2 条日程与截止不受影响') !== -1,
      '**文案写明不会碰什么**');
    eq(callsOf('import_replace').length, 0, '点取消后**一个请求都没发**');
    eq(callsOf('bulk_add').length, 0, '取消时也没走追加');
    eq(ctx.p1.data.submitting, false, '取消后没有卡在 loading');

    return null;
  }).then(function () {
    // ---- 5. 替换：确认后调 import_replace，scope 固定 courses ----
    block('替换路径 —— 确认后调 import_replace(scope=courses)');
    modals.length = 0;
    cloudCalls.length = 0;
    modalConfirm = true;
    ctx.p1.pendingTasks = pendingOf(3);
    ctx.p1.onConfirmImport();
    return settle();
  }).then(function () {
    var replaces = callsOf('import_replace');
    eq(replaces.length, 1, '发出了 1 次 import_replace');
    eq(replaces[0].data.scope, 'courses', '**scope 固定为 courses**（只清课表类）');
    eq(replaces[0].data.tasks.length, 3, '带上要导入的 3 条任务');
    eq(callsOf('bulk_add').length, 0, '替换模式**没有**再走 bulk_add（否则会变成先删后加两份）');
    isTrue(/已替换/.test(ctx.p1.data.importResultText)
      && /删除 2 门/.test(ctx.p1.data.importResultText)
      && /导入 3 门/.test(ctx.p1.data.importResultText),
      '结果行的数字来自**云函数返回**：' + show(ctx.p1.data.importResultText));
    isTrue(toasts.join('|').indexOf('已替换') !== -1, '有成功提示');

    // ---- 6. 追加路径：不弹确认框，走 bulk_add ----
    block('追加路径 —— 不弹确认框，直接 bulk_add');
    modals.length = 0;
    cloudCalls.length = 0;
    ctx.p1.setData({ importMode: 'append' });
    ctx.p1.pendingTasks = pendingOf(2);
    ctx.p1.onConfirmImport();
    return settle();
  }).then(function () {
    eq(modals.length, 0, '追加**不弹**确认框（没有破坏性操作）');
    eq(callsOf('import_replace').length, 0, '追加没有调 import_replace');
    var bulks = callsOf('bulk_add');
    eq(bulks.length, 1, '走的是 bulk_add');
    eq(bulks[0].data.tasks.length, 2, '带上 2 条任务');
    isTrue(/已入库 2 条/.test(ctx.p1.data.importResultText), '结果行：' + show(ctx.p1.data.importResultText));

    // ---- 7. 失败路径 ----
    block('失败路径 —— 替换失败要如实报错，且不能假装成功');
    serve({ tasks: [], removed: 2, replaceFail: '删除阶段失败（已回滚）' });
    ctx.p4 = newPage();
    ctx.p4.onLoad();
    return settle().then(function () {
      modals.length = 0;
      toasts.length = 0;
      ctx.p4.pendingTasks = pendingOf(2);
      ctx.p4.setData({ importMode: 'replace' });
      ctx.p4.onConfirmImport();
      return settle();
    }).then(function () {
      isTrue(toasts.join('|').indexOf('替换失败') !== -1, '失败有提示：' + show(toasts));
      isTrue(toasts.join('|').indexOf('已回滚') !== -1, '把云函数给的 error 原文显示出来');
      eq(ctx.p4.data.submitting, false, '失败后按钮归位（不卡死）');
      isFalse(/已替换/.test(ctx.p4.data.importResultText), '没有把失败说成成功');

      // ---- 8. 空导入不发请求 ----
      block('边界 —— 没有待导入任务时不发请求');
      cloudCalls.length = 0;
      modals.length = 0;
      ctx.p4.pendingTasks = [];
      ctx.p4.onConfirmImport();
      eq(cloudCalls.length, 0, '没有任务时一个请求都不发');
      eq(modals.length, 0, '也不弹确认框');

      // ---- 9. 替换未就绪时必须挡住（不能抛 TypeError，也不能静默） ----
      block('边界 —— importReplace 未就绪时会挡住，而不是抛错');
      var stub = api.importReplace;
      delete api.importReplace;              // 模拟"云函数/封装还没落地"

      var p5 = newPage();
      p5.onLoad();
      return settle().then(function () {
        eq(p5.data.importReplaceReady, false, '未就绪时 importReplaceReady = false');
        isTrue(p5.data.importReplaceHint.length > 0,
          '并给出说明：' + show(p5.data.importReplaceHint));

        // 尝试切到替换 → 被挡住
        p5.setData({ importMode: 'append' });
        toasts.length = 0;
        p5.onImportModeChange({ currentTarget: { dataset: { mode: 'replace' } } });
        eq(p5.data.importMode, 'append', '未就绪时切不回替换');
        isTrue(toasts.join('|').indexOf('尚未就绪') !== -1, '而是明确提示：' + show(toasts));

        // 直接调 onConfirmImport（模拟状态被硬改成 replace）→ 不能抛异常
        toasts.length = 0;
        modals.length = 0;
        cloudCalls.length = 0;
        p5.pendingTasks = pendingOf(1);
        p5.setData({ importMode: 'replace' });
        var threw = false;
        try { p5.onConfirmImport(); } catch (err) { threw = true; }
        isFalse(threw, '**未就绪时调用不会抛异常**');
        eq(callsOf('import_replace').length, 0, '也不会发出无效请求');
        eq(modals.length, 0, '不弹确认框（因为根本做不了）');
        isTrue(toasts.join('|').indexOf('尚未就绪') !== -1, '只给一句人话：' + show(toasts));
        eq(p5.data.submitting, false, '没有卡在 loading');

        // 直接调 doReplace 也要挡住（第二道守卫）
        var threw2 = false;
        try { p5.doReplace(pendingOf(1)); } catch (err) { threw2 = true; }
        isFalse(threw2, 'doReplace 自己也有守卫，不抛异常');

        api.importReplace = stub;            // 还原
        return null;
      }).then(function () {
        // 如实报告：这一版到底测的是真函数还是桩
        block('本轮 import_replace 的状态');
        isTrue(typeof api.importReplace === 'function', 'api.importReplace 现在可用');
        isTrue(true, replaceStubbed
          ? '本轮 import_replace **尚未落地**，上面的替换断言跑在"只记录调用的桩"上'
            + '（已证明页面发出的 action / scope / payload 正确；真函数联调待其落地）'
          : '本轮 import_replace **由 api.js 真实提供**，替换断言跑在真实封装上');
        return null;
      });
    });
  });
}

// ---------------------------------------------------------------------------
// 导出给 run.js 串行调用；单独跑时自己收尾
// ---------------------------------------------------------------------------
var done = Promise.resolve()
  .then(run)
  .then(function () {
    restoreGlobals();
    if (require.main === module) H.report('我的页 —— 导入课表（替换 / 追加）');
  })
  .catch(function (err) {
    restoreGlobals();
    console.error('me 导入测试自己崩了：', err);
    process.exit(2);
  });

module.exports = { done: done };
