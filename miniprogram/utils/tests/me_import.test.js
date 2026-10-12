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
/** 最近一次 settings_save 收到的 settings（用来断言作息合并结果） */
var savedSettings = null;
/** 当前生效的作息（settings_get 返回它，也是合并的基准） */
var currentPeriodTimes = null;

var savedWx = global.wx;
var savedGetApp = global.getApp;

function useStub() {
  toasts = [];
  modals = [];
  cloudCalls = [];
  cloudHandler = null;
  modalConfirm = true;
  savedSettings = null;
  currentPeriodTimes = null;

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
// import_replace 的落地状态
// ---------------------------------------------------------------------------
// api.js 已经提供了真实的 importReplace（走 call('import_replace', {tasks, scope:'courses'})），
// 所以本文件**不需要桩**：页面发出的 action / scope / payload 会被 cloudHandler 记下来，
// 断言跑在真实封装上。这里只留一个标记，末尾如实打印用的是哪一路。
var api = require(path.join(ROOT, 'utils', 'api.js'));
var replaceIsReal = (typeof api.importReplace === 'function');

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
}function manualDdl(id, title) {
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
      return Promise.resolve({ ok: true, semester_start: '2026-09-07', period_times: currentPeriodTimes });
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
    // 作息保存：settings_save 只接受 semester_start / period_times，
    // 返回**保存后**的值（这里模拟服务端把 period_times 原样回传）
    if (data.action === 'settings_save') {
      savedSettings = data.settings || {};
      if (opts.settingsFail) {
        return Promise.resolve({ ok: false, error: opts.settingsFail });
      }
      return Promise.resolve({
        ok: true,
        updated: 1,
        created: 0,
        semester_start: savedSettings.semester_start || '',
        period_times: savedSettings.period_times || null
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
      // 【为什么这段要"临时删除、用后立刻在同一个 then 里还原"】
      // 本文件第一版把还原写在了后面另一段用例里，而 api.js 后来又补上了真实的
      // importReplace → "还原"其实是把 undefined 赋了回去，导致后面的替换用例整段
      // 静默地跑在"未就绪"分支上（测试看着绿，其实什么都没测）。
      // 现在改成"借出→用完马上还"，中间不跨任何用例。
      block('边界 —— importReplace 未就绪时会挡住，而不是抛错');
      var savedImportReplace = api.importReplace;
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

        // 【立刻还原】就在同一个 then 里还回去，后面的替换用例才跑在真实封装上
        api.importReplace = savedImportReplace;
        isTrue(typeof api.importReplace === 'function', 'importReplace 已还原成真函数');
        return null;
      }).then(function () {
        // =====================================================================
        // 根因修复：导入成功后把校准作息增量存回 settings
        // （不存 → 课表页按默认作息算"这个时间属于第几节" → 截止/子任务落错行或掉进兜底行）
        // =====================================================================
        block('作息落库 —— 追加路径：调 saveSettings 且合并结果正确');

        // 基准作息（settings 里已有的），合并必须以它为基准
        currentPeriodTimes = { '1': ['08:00', '08:45'], '7': ['16:00', '16:45'] };
        // 本次文件校准出来的（第 1 节被**覆盖**，第 5 节是**新增**）
        var incoming = { '1': ['08:30', '09:10'], '5': ['11:45', '12:25'] };

        var p6 = newPage();
        p6.onLoad();
        return settle().then(function () {
          eq(p6.periodTimes['1'][0], '08:00', 'onLoad 后页面拿到了当前作息（合并基准）');

          // 模拟"选完文件解析完"：pendingTasks + pendingPeriodTimes 都已就位
          p6.pendingTasks = pendingOf(2);
          p6.pendingPeriodTimes = incoming;
          p6.setData({ importMode: 'append' });
          savedSettings = null;
          cloudCalls.length = 0;
          p6.onConfirmImport();
          return settle().then(function () {
            isTrue(cloudCalls.some(function (c) { return c.data.action === 'bulk_add'; }),
              '追加路径确实导入了');
            eq(callsOf('settings_save').length, 1,
              '**追加路径也调了 settings_save**（两条路径都要存作息）');
            isTrue(!!savedSettings && !!savedSettings.period_times, '带上了 period_times');
            var merged = (savedSettings && savedSettings.period_times) || {};
            eq(merged['1'][0], '08:30',
              '**新导入的节次覆盖同名节次**：第 1 节 08:00 → 08:30');
            eq(merged['1'][1], '09:10', '第 1 节的结束时间也被覆盖成 09:10');
            eq(merged['5'][0], '11:45', '**未涉及的新节次被并入**：第 5 节新增进来了');
            eq(merged['7'][0], '16:00',
              '**未涉及的原有节次原样保留**：第 7 节仍是 16:00（没被空对象抹掉）');
            eq(Object.keys(merged).length, 3, '合并结果是 3 个节次（1/5/7）：'
              + show(Object.keys(merged)));
            isTrue(/并按导入课表校准了 2 节作息/.test(p6.data.periodSaveText),
              '给了一句独立文案：' + show(p6.data.periodSaveText));
            isFalse(p6.data.periodSaveFailed, '并标记为成功（绿色那行）');
            isTrue(/已入库 2 条/.test(p6.data.importResultText),
              '导入文案照旧不受影响：' + show(p6.data.importResultText));
            return null;
          });
        });
      }).then(function () {
        // ---- 替换路径（用真实的 api.importReplace）----
        block('作息落库 —— 替换路径同样存作息');
        var incoming2 = { '1': ['08:30', '09:10'], '5': ['11:45', '12:25'] };
        currentPeriodTimes = { '1': ['08:00', '08:45'] };
        // 【必须重新 serve】cloudHandler 是上一组用例（替换失败那条）留下的，
        // 它还带着 replaceFail —— 不重设的话这组会静默地跑在"替换失败"分支上，
        // 断言全红却看不出原因。（本文件第二次栽在"忘了重置桩状态"上了）
        serve({ tasks: [] });
        var p7 = newPage();
        p7.onLoad();
        return settle().then(function () {
          p7.pendingTasks = pendingOf(3);
          p7.pendingPeriodTimes = incoming2;
          p7.setData({ importMode: 'replace' });
          savedSettings = null;
          cloudCalls.length = 0;
          modalConfirm = true;
          eq(p7.data.importReplaceReady, true, '真函数在位 → 替换可用');
          p7.onConfirmImport();
          return settle().then(function () {
            isTrue(cloudCalls.some(function (c) { return c.data.action === 'import_replace'; }),
              '替换路径确实走了 import_replace');
            eq(callsOf('settings_save').length, 1, '**替换路径同样调了 settings_save**');
            var m2 = (savedSettings && savedSettings.period_times) || {};
                eq(m2['1'][0], '08:30', '替换路径的合并结果同样覆盖第 1 节');
                eq(m2['5'][0], '11:45', '替换路径也并入了第 5 节');
                isTrue(/已替换/.test(p7.data.importResultText),
                  '替换的导入文案照旧：' + show(p7.data.importResultText));
                isTrue(/校准了 2 节作息/.test(p7.data.periodSaveText), '也给了作息那句：' + show(p7.data.periodSaveText));

                // ---- 解耦：作息保存失败不能把导入说成失败 ----
                block('作息落库 —— 保存失败时导入文案照旧，并提示「未保存」');
                var p8 = newPage();
                currentPeriodTimes = { '1': ['08:00', '08:45'] };
                serve({ tasks: [], settingsFail: '设置服务异常' });
                p8.onLoad();
                return settle().then(function () {
                  p8.pendingTasks = pendingOf(2);
                  p8.pendingPeriodTimes = incoming2;
                  p8.setData({ importMode: 'append' });
                  toasts.length = 0;
                  p8.onConfirmImport();
                  return settle().then(function () {
                    isTrue(/已入库 2 条/.test(p8.data.importResultText),
                      '**导入仍然报成功**（课程确实已经进库了）：' + show(p8.data.importResultText));
                    isFalse(/失败/.test(p8.data.importResultText),
                      '导入文案里没有出现"失败"');
                    isTrue(/作息校准未保存/.test(p8.data.periodSaveText),
                      '**单独提示作息未保存**：' + show(p8.data.periodSaveText));
                    isTrue(/课程已导入/.test(p8.data.periodSaveText),
                      '并说明课程其实已经导入成功了');
                    isTrue(p8.data.periodSaveFailed === true, '标了失败标记（橙色那行）');
                    isFalse(toasts.join('|').indexOf('入库失败') !== -1,
                      '没有弹"入库失败"的 toast（那会误导用户以为课没进去）');

                    // ---- 没有可校准信息：不调 saveSettings，也不提示 ----
                    block('作息落库 —— 文件里没有可校准信息时不写库、不提示');
                    var p9 = newPage();
                    currentPeriodTimes = { '1': ['08:00', '08:45'] };
                    serve({ tasks: [] });
                    p9.onLoad();
                    return settle().then(function () {
                      p9.pendingTasks = pendingOf(2);
                      p9.pendingPeriodTimes = null;   // 文件里没有可校准信息
                      p9.setData({ importMode: 'append' });
                      cloudCalls.length = 0;
                      p9.onConfirmImport();
                      return settle().then(function () {
                        eq(callsOf('settings_save').length, 0,
                          '**没有可校准信息 → 一次 settings_save 都不发**');
                        eq(p9.data.periodSaveText, '', '也不显示任何作息提示');
                        isTrue(/已入库 2 条/.test(p9.data.importResultText), '导入照常完成');
                        return null;
                      });
                    });
                  });
                });
              });
            });
          });
        });
      }).then(function () {
        // 如实报告：替换断言跑在真实封装上还是桩上
        block('本轮 import_replace 的状态');
        isTrue(typeof api.importReplace === 'function', 'api.importReplace 现在可用');
        isTrue(true, replaceIsReal
          ? '本轮 import_replace **由 api.js 真实提供**，替换断言跑在真实封装上'
            + '（action=import_replace、scope=courses、payload 都经过真函数）'
          : '⚠️ api.importReplace 缺席，替换相关断言未生效');
        return null;
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
