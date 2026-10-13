/**
 * utils/tests/me_periods.test.js —— pages/me/me.js「节次作息」区块的页面级单测。
 *
 * 跑法：
 *     node utils/tests/me_periods.test.js   # 只跑这一份（末尾打印通过数，失败退出码 1）
 *     node utils/tests/run.js               # 跑全部（注册那一行由入口 run.js 统一加）
 *
 * ===========================================================================
 * 【这个文件为什么存在】真机上用户的原话：
 *   「第6节应该是 13:30-14:10，不知道为什么显示的是 14:55-15:40」
 * ===========================================================================
 *   他两条信息都对，而这**不是算错**：
 *     * 他的课表里**第 6 节没有课**（文件里就没有排在 13:30 的那节课），
 *       而"校准"是靠课表里的课反推上下课时间的 —— 没有课，就推不出时间；
 *     * 于是第 6 节退回了程序内置的默认作息 14:55-15:40（config.py 的 CLASS_PERIODS）。
 *   这是**产品缺口**：程序永远不可能知道"一节没有任何课的时间"，只能让用户自己补录。
 *   而当时的作息表是**只读**的 —— 他连个入口都没有。
 *
 *   所以本文件钉住四件事：
 *     1. 未校准的行必须**明说**「未校准」（不能让用户以为程序算错了）；
 *     2. 未校准的行能「设定时间」，保存的 payload 里**只有那一节**被动、
 *        **其余节次原值不变**（这条最重要 —— 补一节不该把别的作息冲掉）；
 *     3. 保存失败**只说人话**，且已有的作息与页面一个字节都不许坏；
 *     4. 已校准的行能「清除」回未校准（填错了得能退回去），清除前有确认。
 *
 * 【做法照 me_ai.test.js】加载期只捕获 Page 注册对象，wx / getApp 桩在用例执行时才装
 * —— 加载期直接改全局会把别的测试文件的桩冲掉（表现为"单独跑全绿、经 run.js 加载就崩"）。
 *
 * ===========================================================================
 * 【第四件事：行有两种，别再按 row[0] 当节次号】
 *   utils/periods.js 现在会在"相邻两行之间空隙 ≥ 45 分钟"时插一行**合成空档行**
 *   `['break','12:25','13:30']`（key 是 `break-12:25-13:30`，**不是节次号**）。
 *   于是 renderPeriods 有三处会静默出错，同事特意点名提醒过：
 *     ① `breakLabel(row[0])` 对合成行返回空串 → 那一行**不会被标成空档**，底色失效；
 *     ② 计数口径：`calibratedCount === list.length` 永远不成立，`list.length` 也不再是节数
 *        （缺号时 13、补录满 15 行）→ 只数节次行（periods.rowPeriodNumber 过滤）；
 *     ③ 合成行**不能有**「设定时间 / 清除」按钮（它不是节次，period_times 里也没有它的键）。
 *   本文件用「合成空档行」「计数口径」两组钉住它们，各自都做过反面自检：
 *     * 把 `isBreak: rowIsBreak(row, override)` 改回 `breakLabel(number)` → 恰好红 2 条
 *       （都是"合成行带空档样式"）；
 *     * 把统计里的 `list.filter(item => !item.isGapRow)` 去掉 → 恰好红 10 条
 *       （全是"共 N 节"，红的时候打印出来的就是 `共 14 节` 这种错数）。
 *
 * 【本文件只 require 被测页面 + ./harness.js】不 require 任何别的测试文件。
 *
 * 【当前基线】本文件 217 条断言；跑全量 run.js 是 2656 条
 *   （同一批「我的」页改动里，me_import 从 111 涨到 142 —— 那边加了根因回归；
 *     me_ai 未动，111）。数字变了不一定有问题，但**通过数突然下降**
 *   要当成"有断言没跑到"来查（本仓库出过一次假绿：漏了 return，整批断言没跑还全绿）。
 */

'use strict';

var path = require('path');
var H = require(path.join(__dirname, 'harness.js'));
var ROOT = path.join(__dirname, '..', '..');

var eq = H.eq;
var eqArr = H.eqArr;
var eqJson = H.eqJson;
var isTrue = H.isTrue;
var isFalse = H.isFalse;
var block = H.block;
var show = H.show;

// ---------------------------------------------------------------------------
// stub
// ---------------------------------------------------------------------------
var toasts = [];
var modals = [];          // 每次 showModal 的入参（用来断言"有没有确认框"）
var modalAnswer = true;   // 桩里用户点的是"确定"还是"取消"
var callLog = [];
var settingsData = null;  // settings_get 返回什么
var saveHandler = null;   // settings_save 的应答（可注入失败）

var savedWx = global.wx;
var savedGetApp = global.getApp;
var savedGetCurrentPages = global.getCurrentPages;

/** 真机那条数据：第 1-5 节 + 第 7-13 节有课，**第 6 节没有** */
var REAL_PERIOD_TIMES = {
  '1': ['08:30', '09:10'], '2': ['09:15', '09:55'], '3': ['10:15', '10:55'],
  '4': ['11:00', '11:40'], '5': ['11:45', '12:25'], '7': ['14:15', '15:00'],
  '8': ['15:05', '15:40'], '9': ['16:00', '16:40'], '10': ['16:45', '17:25'],
  '11': ['19:00', '19:40'], '12': ['19:45', '20:20'], '13': ['20:30', '21:10']
};

/**
 * 默认作息 13 节（periods.js 里抄自 config.py CLASS_PERIODS）。
 * ⚠️ 只有"从没导入过课表"那一组会得到 13 行 —— 一旦有校准数据，
 * periodRows 会多插空档行（真机那份是 13 节 + 1 行「休息」= 14 行，见 REAL_ROW_COUNT）。
 */
var DEFAULT_ROWS = 13;

/**
 * 真机那份校准作息渲染出来是 **14 行**：13 个节次 + 1 个「休息」空档行。
 *   第 6 节（14:55-15:40 默认）夹在第 5 / 7 节之间 → 被判成「午休」；
 *   第 10 节（17:25 结束）与第 11 节（19:00 开始）之间空得久 → 额外生成一行「休息」。
 * 那个「休息」行的 key 是 `break-17:25-19:00`（**不是节次号**），所以它不给补录按钮。
 */
var REAL_ROW_COUNT = 14;

var applySettingsCalls = [];

function useStub() {
  toasts = [];
  modals = [];
  modalAnswer = true;
  callLog = [];
  settingsData = null;
  saveHandler = null;
  applySettingsCalls = [];

  global.wx = {
    showToast: function (options) { toasts.push((options && options.title) || ''); },
    showModal: function (options) {
      modals.push(options || {});
      // 桩里**同步**回调：页面代码不必等，测试也就不用猜层级
      if (options && options.success) options.success({ confirm: modalAnswer, cancel: !modalAnswer });
    },
    setClipboardData: function () {},
    chooseMessageFile: function () {},
    getFileSystemInfo: function () { return {}; },
    getFileSystemManager: function () { return { readFile: function () {} }; },
    stopPullDownRefresh: function () {},
    navigateTo: function () {},
    showLoading: function () {},
    hideLoading: function () {},
    cloud: {
      callFunction: function (options) {
        var data = (options && options.data) || {};
        callLog.push({ name: options && options.name, data: data });
        var result = null;
        // 【云函数的返回是**平铺**的】`ok(payload)` 就是 Object.assign({ok:true}, payload)，
        // 所以 semester_start / period_times 与 ok **同级** —— 这正是 utils/api.js 的
        // extractSettings 那样写的原因（api.js 的注释：「只认平铺」）。
        // 这里必须照真实形状造桩，否则测的是"我以为的契约"。
        if (data.action === 'settings_get') {
          result = settingsData || { ok: true, semester_start: '', period_times: null };
        } else if (data.action === 'settings_save') {
          if (saveHandler) result = saveHandler(data);
          else {
            // 模拟服务端：把 period_times 归一化后**原样回传**（与导入那条路同一口径）
            var incoming = (data.settings && data.settings.period_times) || null;
            result = { ok: true, semester_start: '', period_times: incoming };
          }
        } else {
          result = { ok: true };
        }
        if (result && typeof result.then === 'function') {
          return result.then(function (r) { return { result: r }; });
        }
        return Promise.resolve({ result: result });
      }
    }
  };
  global.getApp = function () {
    return {
      globalData: { semesterStart: '', periodTimes: null, envId: 'test' },
      ensureInit: function () { return Promise.resolve(true); },
      applySettings: function (data) { applySettingsCalls.push(data); }
    };
  };
  global.getCurrentPages = function () { return [{}]; };
}

function restoreGlobals() {
  if (savedWx === undefined) delete global.wx; else global.wx = savedWx;
  if (savedGetApp === undefined) delete global.getApp; else global.getApp = savedGetApp;
  if (savedGetCurrentPages === undefined) delete global.getCurrentPages;
  else global.getCurrentPages = savedGetCurrentPages;
}

// ---------------------------------------------------------------------------
// 取回页面注册对象（加载期不碰 wx）
// ---------------------------------------------------------------------------
// 【为什么要先删缓存】原因与 me_ai.test.js 那段一模一样：run.js 里 ai_vision.test.js
// 会 `delete require.cache[...]` 让 pages/ai/ai.js 重新注册，而它删的是**整棵 pages/
// 子树** —— 本文件若是更早被加载过，再 require me.js 会重新执行一遍，
// 于是 `Page(...)` 注册到的对象与加载期捕获的不是同一个（表现为单独跑全绿、经 run.js 跑报"注册对象没拿到"）。
var PAGE_PATH = path.join(ROOT, 'pages', 'me', 'me.js');
delete require.cache[require.resolve(PAGE_PATH)];

var registered = null;
var loadError = null;
try {
  global.Page = function (options) { registered = options; };
  require(PAGE_PATH);
} catch (err) {
  loadError = err;
}

/** 真实的 utils/api.js（本文件只 stub 最底层 wx.cloud.callFunction） */
var api = require(path.join(ROOT, 'utils', 'api.js'));
var periods = require(path.join(ROOT, 'utils', 'periods.js'));

// ---------------------------------------------------------------------------
// 小工具
//
// 【为什么按 key（节次号）找行，而不是按 label】校准作息下缺掉的那一节会被判成
// **空档行**、label 变成「午休」而不是「第6节」—— 而这一节恰恰就是本文件的主角
// （用户课表里第 6 节没有课，所以它既未校准、又显示成午休）。按 label 找会直接找不到。
// ---------------------------------------------------------------------------
function newPage() {
  var page = {};
  Object.keys(registered).forEach(function (key) { page[key] = registered[key]; });
  page.data = JSON.parse(JSON.stringify(registered.data));
  page.setData = function (patch) {
    var self = this;
    Object.keys(patch || {}).forEach(function (key) {
      if (key.indexOf('.') === -1) { self.data[key] = patch[key]; return; }
      var parts = key.split('.');
      var target = self.data;
      for (var i = 0; i < parts.length - 1; i += 1) target = target[parts[i]];
      target[parts[parts.length - 1]] = patch[key];
    });
  };
  return page;
}

function rowOf(page, number) {
  var list = page.data.periodRows || [];
  var key = String(number);
  for (var i = 0; i < list.length; i += 1) if (String(list[i].key) === key) return list[i];
  return null;
}

function rowIndexOf(page, number) {
  var list = page.data.periodRows || [];
  var key = String(number);
  for (var i = 0; i < list.length; i += 1) if (String(list[i].key) === key) return i;
  return -1;
}

function uncalibratedOf(page) {
  return (page.data.periodRows || []).filter(function (r) { return r.uncalibrated; });
}

function settle(rounds) {
  var n = rounds || 8;
  var p = Promise.resolve();
  for (var i = 0; i < n; i += 1) {
    p = p.then(function () { return new Promise(function (resolve) { setImmediate(resolve); }); });
  }
  return p;
}

/** 最近一次 settings_save 的 payload */
function lastSavePayload() {
  var saves = callLog.filter(function (c) { return c.data.action === 'settings_save'; });
  return saves.length ? saves[saves.length - 1].data : null;
}

function saveCount() {
  return callLog.filter(function (c) { return c.data.action === 'settings_save'; }).length;
}

/**
 * 从**此刻**开始数保存次数 —— 与 saveCount() 的区别是它归零。
 *
 * 【为什么要它】callLog 是全局的，跨用例一直累积。第 1c 组（计数口径）里也有一次
 * 补录保存，于是后面那组的 `eq(saveCount(), 0, '改 picker 不自动保存')` 会看到 2 ——
 * 断言本身没错，是**它数错了范围**。这类"计数不归零"的断言最坑：
 * 它红的时候看起来像功能坏了，其实只是把别人家的请求算进来了。
 */
function markRequests() {
  return requestCount();
}

function requestCount() { return callLog.length; }

/** 打开某一节的补录弹层（模拟点「设定时间」） */
function openEditor(page, number) {
  var idx = rowIndexOf(page, number);
  page.onTapPeriodSet({ currentTarget: { dataset: { index: idx } } });
  return idx;
}

/** 启动页面并等设置读完 */
function bootPage(periodTimes) {
  settingsData = { ok: true, semester_start: '2026-09-07', period_times: periodTimes || null };
  var page = newPage();
  page.onLoad();
  return settle().then(function () { return page; });
}

// ===========================================================================
// 正式用例
// ===========================================================================
function run() {
  useStub();

  block('me 节次作息 —— 页面文件与探针');
  isFalse(!!loadError, 'pages/me/me.js 加载期没有抛异常'
    + (loadError ? '（实际：' + loadError.message + '）' : ''));
  isTrue(!!registered, 'Page() 注册对象拿到了');
  if (!registered) return Promise.resolve();

  var T = registered.__test || {};
  isTrue(typeof T.isUncalibrated === 'function', '__test 暴露了 isUncalibrated');
  isTrue(typeof T.rowNumberOf === 'function', '__test 暴露了 rowNumberOf');
  isTrue(typeof T.rowIsBreak === 'function', '__test 暴露了 rowIsBreak');
  isTrue(typeof T.periodRowPatch === 'function', '__test 暴露了 periodRowPatch');
  isTrue(typeof T.dropPeriodKey === 'function', '__test 暴露了 dropPeriodKey');
  isTrue(typeof T.mergePeriodTimes === 'function', '__test 暴露了 mergePeriodTimes（补录复用它）');
  isTrue(typeof registered.onTapPeriodSet === 'function', '页面注册了 onTapPeriodSet');
  isTrue(typeof registered.onTapPeriodSave === 'function', '页面注册了 onTapPeriodSave');
  isTrue(typeof registered.onTapPeriodClear === 'function', '页面注册了 onTapPeriodClear');
  isTrue(typeof registered.onPeriodStartChange === 'function', '页面注册了 onPeriodStartChange');
  isTrue(typeof registered.onPeriodEndChange === 'function', '页面注册了 onPeriodEndChange');

  // -------------------------------------------------------------------------
  // 0. 纯函数：行形状 / 未校准判定 / 增量 / 删除
  //    （先把口径钉死，后面页面级的不变量才有意义）
  // -------------------------------------------------------------------------
  // 【为什么先测这两个包装】行有两种（节次行 / 合成空档行），而"按 row[0] 当节次号"
  // 这个写法在合成行上会静默出错（row[0] 是字符串 'break'）。
  // 同事为此在 week.js 上吃过 8 条红，所以这里把口径单独钉一遍。
  block('行形状 —— rowNumberOf / rowIsBreak 必须认两种行');
  eq(T.rowNumberOf([6]), 6, '节次行 [6] → 6');
  eq(T.rowNumberOf([7]), 7, '节次行 [7] → 7');
  eq(T.rowNumberOf(['break', '12:25', '13:30']), null,
    "**合成空档行 ['break','12:25','13:30'] → null**（它不是节次）");
  eq(T.rowNumberOf([]), null, '空行 → null（不炸）');
  eq(T.rowNumberOf(null), null, 'null → null');
  eqJson([T.rowNumberOf('6'), T.rowNumberOf(['6'])], [null, 6],
    '**只有"行"才算**：裸字符串 "6" 不是行 → null；["6"] 是行 → 6'
    + '（这一步挡的是"调用方传错形状"，宁可返回 null 也不要瞎认）');

  isFalse(T.rowIsBreak([7], REAL_PERIOD_TIMES), '第 7 节（已校准、有课）→ 不是空档行');
  isTrue(T.rowIsBreak([6], REAL_PERIOD_TIMES),
    '**第 6 节（缺号夹出来的「午休」）→ 是空档行**（breakLabel 那条老路也认）');
  isTrue(T.rowIsBreak(['break', '17:25', '19:00'], REAL_PERIOD_TIMES),
    '**合成空档行 → 是空档行**（这正是 breakLabel(row[0]) 判不出来的那种：'
    + "row[0] 是 'break'，old 写法会返回 false，底色样式全失效）");

  block('未校准判定 —— 用 periods.isUncalibratedRow，拿不到就退回本地口径');
  isTrue(T.isUncalibrated([6], REAL_PERIOD_TIMES),
    '**第 6 节不在 override 里 → 未校准**（真机那条数据）');
  isFalse(T.isUncalibrated([5], REAL_PERIOD_TIMES), '第 5 节在校准表里 → 已校准');
  isFalse(T.isUncalibrated([7], REAL_PERIOD_TIMES), '第 7 节在校准表里 → 已校准');
  isTrue(T.isUncalibrated([1], null), '整个 override 都没有 → 未校准');
  isFalse(T.isUncalibrated(['break', '12:25', '13:30'], REAL_PERIOD_TIMES),
    '**合成空档行 → false（不算未校准）** —— 它不是节次，没什么可补录的；'
    + '它要是被判成未校准，界面上会多出一个不该有的补录入口');
  isFalse(T.isUncalibrated(['break', '12:25', '13:30'], null),
    '整个 override 都没有时，合成行**仍然不是**未校准（判据与 override 无关这一点也要对）');
  isFalse(T.isUncalibrated({ number: 6, label: '午休' }, REAL_PERIOD_TIMES),
    '**传视图模型（对象）→ 一律 false**（那个函数用 Array.isArray 挡了一道）——'
    + '所以页面里必须传标准行，这条钉住"别传错形状"');

  // 同事的判据函数存在时**以他的为准**
  var hadFn = typeof periods.isUncalibratedRow === 'function';
  var savedFn = periods.isUncalibratedRow;
  periods.isUncalibratedRow = function () { return false; };
  isFalse(T.isUncalibrated([6], REAL_PERIOD_TIMES),
    '**periods.isUncalibratedRow 存在时以它为准**（本页不另立一套口径）');
  periods.isUncalibratedRow = function () { throw new Error('判据函数内部炸了'); };
  isTrue(T.isUncalibrated([6], REAL_PERIOD_TIMES),
    '**它抛异常时退回本地口径、不冒泡**（拿不到判据不该让整页崩）');
  if (hadFn) periods.isUncalibratedRow = savedFn; else delete periods.isUncalibratedRow;
  isTrue(T.isUncalibrated([6], REAL_PERIOD_TIMES), '还原后本地口径照旧');

  block('补录增量 —— 只含被改的那一节');
  var patch6 = T.periodRowPatch(6, '13:30', '14:10');
  isTrue(patch6.ok, '起止都给全 → 可以保存');
  eqJson(patch6.patch, { '6': ['13:30', '14:10'] },
    "**payload 里 period_times['6'] = ['13:30','14:10']**，且只有这一个键");
  isFalse(T.periodRowPatch(6, '13:30', '').ok, '**只填开始 → 拒绝**');
  isTrue(T.periodRowPatch(6, '13:30', '').error.indexOf('都要填') > -1,
    '并说明原因：' + show(T.periodRowPatch(6, '13:30', '').error));
  isFalse(T.periodRowPatch(6, '', '14:10').ok, '**只填结束 → 拒绝**');
  isFalse(T.periodRowPatch(6, '  ', '14:10').ok, '纯空白也算没填');
  isFalse(T.periodRowPatch(6, '14:10', '13:30').ok, '结束早于开始 → 拒绝（那是脏数据）');
  isTrue(T.periodRowPatch(6, '14:10', '13:30').error.indexOf('晚于') > -1,
    '并说清哪里不对：' + show(T.periodRowPatch(6, '14:10', '13:30').error));
  isTrue(T.periodRowPatch(6, '13:30', '13:30').ok === false, '首尾相同 → 拒绝（零长的一节没有意义）');

  block('清除 —— 去掉一个 key，其余原样');
  var dropped = T.dropPeriodKey(REAL_PERIOD_TIMES, 6);
  // ⚠️ REAL_PERIOD_TIMES 里**本来就没有 '6'**（这正是真机那条数据：
  //    他课表里第 6 节没有课，所以校准不出时间）。所以"清第 6 节"是空操作 ——
  //    removed 必须是 false，界面不该说"已清除"（否则用户会以为自己删掉了什么）。
  isFalse(dropped.removed,
    '**要清的那一节本来就没校准 → removed = false**（空操作不许报成"已清除"）');
  isFalse(Object.prototype.hasOwnProperty.call(dropped.times, '6'), '结果里当然也没有第 6 节');
  eq(Object.keys(dropped.times).length, Object.keys(REAL_PERIOD_TIMES).length,
    '键数不变（它本来就不在里面）');
  // 真正有东西可清的情形
  var dropped5 = T.dropPeriodKey(REAL_PERIOD_TIMES, 5);
  isTrue(dropped5.removed, '**清一个已校准的节次 → removed = true**');
  isFalse(Object.prototype.hasOwnProperty.call(dropped5.times, '5'), '第 5 节被移除了');
  eq(Object.keys(dropped5.times).length, Object.keys(REAL_PERIOD_TIMES).length - 1,
    '少了一个键');
  eqArr(dropped5.times['4'], ['11:00', '11:40'], '第 4 节原值不变');
  eqArr(dropped5.times['7'], ['14:15', '15:00'], '第 7 节原值不变');
  eqJson(dropped5.times['13'], REAL_PERIOD_TIMES['13'], '最后一节也原值不变');
  isTrue(Object.prototype.hasOwnProperty.call(REAL_PERIOD_TIMES, '5'),
    '入参本身没有被改动（dropPeriodKey 是纯函数）');
  var allGone = T.dropPeriodKey({ '6': ['13:30', '14:10'] }, 6);
  eq(Object.keys(allGone.times).length, 0, '把唯一一节也清掉 → 空对象（不是 null，交给服务端归一化）');
  isTrue(allGone.removed, 'removed = true');

  var chain = Promise.resolve();

  // -------------------------------------------------------------------------
  // 1. 渲染：未校准的行必须明说「未校准」，已校准的显示「已校准」
  // -------------------------------------------------------------------------
  chain = chain.then(function () {
    block('渲染 —— 未校准 / 已校准 两种标记');
    return bootPage(REAL_PERIOD_TIMES).then(function (page) {
      eq(page.data.periodRows.length, REAL_ROW_COUNT,
        '作息表 14 行 = 13 个节次 + 1 个「休息」空档行（第 10/11 节之间空得久）');
      var r6 = rowOf(page, 6);
      isTrue(!!r6, '找得到第 6 节那一行');
      eq(r6.timeText, '14:55-15:40',
        '**第 6 节显示的是内置默认时间 14:55-15:40**（真机上用户看到的就是它）');
      isTrue(r6.uncalibrated, '**它被标成"未校准"**（不能被当成用户课表里的时间）');
      isFalse(r6.calibrated, '不是已校准');
      eq(r6.actionText, '设定时间', '未校准的行给「设定时间」按钮');
      isTrue(r6.editable === true, 'editable = true（有节次号，能补录）');

      var r5 = rowOf(page, 5);
      isFalse(r5.uncalibrated, '第 5 节已校准 → 不标未校准');
      isTrue(r5.calibrated, '第 5 节标「已校准」');
      eq(r5.timeText, '11:45-12:25', '显示的是**校准后的**时间，不是默认的 14:00-14:45');
      eq(r5.actionText, '修改', '已校准的行按钮文案是「修改」');

      // 未校准的只有第 6 节那一节（「休息」空档行不算 —— 它没有节次号，无处可存）
      var uncal = uncalibratedOf(page);
      eq(uncal.length, 1, '**未校准的正好 1 节**（就是第 6 节）');
      eq(uncal[0] ? String(uncal[0].key) : '?', '6', '就是第 6 节');
      // 【这一条是本次真机问题的另一个侧面】缺掉的那一节会被判成**空档行**，
      // 所以它的名字不是「第6节」而是「午休」—— 用户看到的正是"午休 14:55-15:40"，
      // 一个既没课、时间又不对的怪行。未校准标记就是给他解释这一行的。
      eq(uncal[0] ? uncal[0].label : '?', '午休',
        '它同时被认定成空档行（label = 午休）—— 因为左邻第 5 节、右邻第 7 节都校准过');
      isTrue(uncal[0] ? uncal[0].isBreak === true : false, '带 isBreak 标记（模板据此换底色）');

      // 「休息」空档行：有正确的推出来的时间，但没有节次号 → 不给补录入口
      var gapRow = null;
      page.data.periodRows.forEach(function (r) {
        if (r.isGapRow) gapRow = r;
      });
      isTrue(!!gapRow, '存在一行 isGapRow（第 10/11 节之间的「休息」）');
      eq(gapRow ? gapRow.label : '?', '休息', '它的名字是「休息」');
      eq(gapRow ? gapRow.timeText : '?', '17:25-19:00',
        '它的时间是从左右两节**推出来的**（17:25 到 19:00），不是内置默认值');
      isFalse(gapRow ? gapRow.uncalibrated : true,
        '**它不算"未校准"**（时间是正确的，只是没有节次号）');
      isFalse(gapRow ? gapRow.editable : true, '**editable = false → 不给「设定时间」按钮**');
      eq(gapRow ? gapRow.actionText : '?', '', '它的按钮文案是空的（模板据此不渲染按钮）');
      isFalse(gapRow ? gapRow.calibrated : true,
        '也没有「已校准」标记（period_times 里没有它的键）');
      isTrue(String(gapRow ? gapRow.key : '').indexOf('break') === 0,
        '它的 key 不是节次号而是 break-…：' + show(gapRow ? gapRow.key : ''));

      isTrue(page.data.periodOverrideText.indexOf('未校准') > -1,
        '卡片里有「未校准」的解释句');
      isTrue(page.data.periodOverrideText.indexOf('内置默认时间') > -1,
        '**并且说清"显示的是内置默认时间，不是你课表里的时间"**：'
        + show(page.data.periodOverrideText));
      isTrue(page.data.periodOverrideText.indexOf('1 节') > -1,
        '数量对得上（1 节，不是把「休息」行也算进去）：'
        + show(page.data.periodOverrideText));
      isTrue(page.data.periodSourceText.indexOf('默认作息') > -1,
        '来源行也说明了当前是"默认作息 + 已校准的 N 节"');

      isTrue(page.data.periodGapHint.indexOf('午休') > -1,
        '卡片里有"空隙会自动显示成午休行"的预期提示');
      isTrue(page.data.periodGapHint.indexOf('45') > -1,
        '并写清阈值（短于 45 分钟只是课间）');

      eq(page.data.periodEditVisible, false, '刚进页面弹层是关着的');
    });
  });

  // ===========================================================================
  // 1b. **合成空档行**：两节之间空得久（≥45 分钟）时 periodRows 会插一行
  //     `['break','12:25','13:30']`，key 是 `break-12:25-13:30`（**不是节次号**）。
  //
  //   这一组是本文件最"面向同事改动"的一组 —— 他点名提醒的三处都在这里：
  //     ① breakLabel(row[0]) 对合成行返回空串 → 底色/样式失效（必须走 isBreakRow）；
  //     ② 计数口径里 list.length 不再等于节数（必须只数节次行）；
  //     ③ 合成行**不能有**「设定时间 / 清除」按钮（它不是节次，没什么可补录的）。
  //   反面自检（同事做过）：把合成行也当成未校准节次 → 会多出一个不该有的补录入口。
  // ===========================================================================
  block('合成空档行 —— 渲染成空档、没有补录按钮、不计入节数');

  /**
   * 两处空隙都 ≥45 分钟 → 第 6/7 节之间（12:35→13:30）与第 9/10 节之间（16:30→19:00）
   * 各插一行合成空档。
   *
   * ⚠️ 阈值是 **45 分钟**（BREAK_MIN_GAP_MINUTES）。第一版我把第 6/7 节写成
   * 12:40→13:30（只空 50 分钟… 实际先写成 12:40-13:25 / 13:30 起，只有 5 分钟），
   * 于是只插出 1 行、断言全红。这类"差几分钟"的边界最容易写错，改时间前先算一遍。
   */
  var GAP_CAL = {
    '1': ['08:00', '08:45'], '2': ['08:55', '09:40'], '3': ['10:00', '10:45'],
    '4': ['10:55', '11:40'], '5': ['11:50', '12:35'], '6': ['12:40', '13:25'],
    '7': ['13:30', '14:15'], '8': ['14:20', '15:05'], '9': ['15:10', '16:30'],
    '10': ['19:00', '19:45'], '11': ['19:50', '20:35'], '12': ['20:40', '21:25'],
    '13': ['21:30', '22:15']
  };
  var GAP_TOTAL_ROWS = 14;   // 13 个节次 + 1 行合成空档（16:30-19:00）

  chain = chain.then(function () {
    return bootPage(GAP_CAL).then(function (page) {
      var synth = page.data.periodRows.filter(function (r) { return r.isGapRow; });
      eq(page.data.periodRows.length, GAP_TOTAL_ROWS,
        '13 个节次 + 1 行合成空档 = 14 行（合成行**确实出现在这份作息表里**）');
      eq(synth.length, 1, '合成行正好 1 行（16:30-19:00 那段空隙）');
      isTrue(synth.length > 0, '前提成立：确实有合成空档行');

      // ---- ① 空档样式：必须走 isBreakRow，不能读 row[0] ----
      synth.forEach(function (r) {
        isTrue(r.isBreak === true,
          '**合成行「' + r.label + ' ' + r.timeText + '」带空档样式（isBreak = true）**'
          + ' —— 老写法 breakLabel(row[0]) 对它是空串，底色会失效');
      });
      var gap1 = null;
      var gap2 = null;
      synth.forEach(function (r) {
        if (r.timeText === '16:30-19:00') gap1 = r;
        if (r.timeText === '12:35-13:30') gap2 = r;
      });
      isTrue(!!gap1, '找得到 16:30-19:00 那一行合成空档（第 9/10 节之间）');
      isFalse(!!gap2, '反面对照：第 6/7 节之间只空 5 分钟 → **不该插空档行**'
        + '（阈值是 45 分钟，短于它的只是课间）');
      eq(gap1 ? gap1.timeText : '?', '16:30-19:00',
        '**合成行显示的是它自己的区间**（rowTimeRange 对合成行返回 [row[1], row[2]]）');
      isTrue(String(gap1 ? gap1.key : '').indexOf('break') === 0,
        '它的 key 是 break-… 而不是节次号：' + show(gap1 ? gap1.key : ''));

      // ---- ③ 没有按钮（本次改动的核心） ----
      synth.forEach(function (r) {
        isFalse(r.editable === true,
          '**合成行「' + r.label + '」editable = false → 不给按钮**');
        eq(r.actionText, '', '它的按钮文案是空的（模板 wx:if 据此不渲染按钮）');
        isFalse(r.calibrated === true, '也没有「已校准」标记');
        isFalse(r.uncalibrated === true,
          '**也不算「未校准」** —— 它要是被判成未校准，界面上会多出一个补录入口');
        isTrue(r.number === null || r.number === undefined,
          '它的 number 不是节次号：' + show(r.number));
      });
      // 反面对照：节次行仍然有按钮（别把整列按钮都关掉了）
      var r5 = rowOf(page, 5);
      isTrue(r5 && r5.editable === true, '反面对照：第 5 节（节次行）**仍然可编辑**');
      isFalse(!!r5 && r5.isGapRow === true, '它不是合成行');
      isFalse(!!r5 && r5.isBreak === true, '它也不是空档行（有课）');

      // 点合成行（哪怕硬传下标）→ 读不出上下文，不发请求、不开弹层
      var synthIndex = -1;
      page.data.periodRows.forEach(function (r, i) { if (r.isGapRow) synthIndex = i; });
      isTrue(synthIndex >= 0, '拿到一个合成行的下标：' + synthIndex);
      var beforeReq = requestCount();
      page.onTapPeriodSet({ currentTarget: { dataset: { index: synthIndex } } });
      eq(page.data.periodEditVisible, false,
        '**点合成行不会打开补录弹层**（它没有节次号，readPeriodRow 直接返回 null）');
      eq(requestCount(), beforeReq, '也没有发任何请求');
      isTrue(toasts.length > 0, '给了一句人话提示：' + show(toasts[toasts.length - 1]));

      // ---- ② 计数口径：只数节次行 ----
      eq(page.data.periodSourceText.indexOf('13 节') > -1, true,
        '**来源行的 N 只数节次行**（13 节，不是 14 行）：'
        + show(page.data.periodSourceText));
      isFalse(page.data.periodSourceText.indexOf('14 节') > -1,
        '反面对照：**不能把合成行也算成一节**');
      isTrue(page.data.periodOverrideText.indexOf('空档行') > -1,
        '卡片里解释了"空档行是自动插的、不用填"：'
        + show(page.data.periodOverrideText));
    });
  });

  // ===========================================================================
  // 1c. 计数口径 —— 「已校准的 N 节」在"缺号"与"补录后"两种数据下都要对
  //
  //   以前这句是 `calibratedCount === list.length`，合成行一出现就永远不成立，
  //   而且 list.length 也不再是节数。这两条断言分别钉住两种数据。
  // ===========================================================================
  block('计数口径 —— 缺号 / 补录后，"校准的 N 节"都只数节次行');

  chain = chain.then(function () {
    // ① 缺号数据：真机那份（第 6 节缺）+ 一行合成空档 → 13 节 / 12 已校准 / 1 未校准
    return bootPage(REAL_PERIOD_TIMES).then(function (page) {
      var periodRows = page.data.periodRows.filter(function (r) { return !r.isGapRow; });
      var gapRows = page.data.periodRows.filter(function (r) { return r.isGapRow; });
      eq(page.data.periodRows.length, REAL_ROW_COUNT, '总渲染 14 行');
      eq(periodRows.length, 13, '**节次行 = 13**（合成行不算）');
      eq(gapRows.length, REAL_ROW_COUNT - 13, '合成行 = 1（17:25-19:00 那段空隙）');
      isTrue(page.data.periodSourceText.indexOf('12 节') > -1,
        '**「已校准的 12 节」**（他给了 12 个节次的时间）：'
        + show(page.data.periodSourceText));
      isTrue(page.data.periodSourceText.indexOf('共 13 节') > -1,
        '**「共 13 节」**（分母只数节次行）：' + show(page.data.periodSourceText));
      isFalse(page.data.periodSourceText.indexOf('共 14') > -1,
        '反面对照：分母不是 14 行');
      eq(periodRows.filter(function (r) { return r.calibrated; }).length, 12,
        '已校准的节次行正好 12');
      eq(periodRows.filter(function (r) { return r.uncalibrated; }).length, 1,
        '未校准的节次行正好 1（第 6 节）');

      // 补第 6 节 → 13/13，文案要转成"全部来自自动校准"
      openEditor(page, 6);
      page.onPeriodStartChange({ detail: { value: '13:30' } });
      page.onPeriodEndChange({ detail: { value: '14:10' } });
      page.onTapPeriodSave();
      return settle().then(function () {
        var rows2 = page.data.periodRows.filter(function (r) { return !r.isGapRow; });
        eq(rows2.length, 13, '补录后节次行仍是 13');
        eq(rows2.filter(function (r) { return r.uncalibrated; }).length, 0, '没有未校准的节次了');
        isTrue(page.data.periodSourceText.indexOf('共 13 节') > -1,
          '**补满 13 节后文案变成"全部来自自动校准（共 13 节）"**：'
          + show(page.data.periodSourceText));
        isFalse(page.data.periodSourceText.indexOf('默认作息 +') > -1,
          '**不再说"默认作息 + 已校准的 N 节"** —— 那句等式以前靠 list.length，'
          + '合成行一出现就永远进不去这个分支');
      });
    });
  });

  chain = chain.then(function () {
    // ② 补录后（14 行：13 节 + 1 合成行）→ 仍然"共 13 节"
    return bootPage(GAP_CAL).then(function (page) {
      var periodRows = page.data.periodRows.filter(function (r) { return !r.isGapRow; });
      eq(periodRows.length, 13, '14 行里数出 13 个节次行');
      eq(page.data.periodSourceText.indexOf('共 13 节') > -1, true,
        '**"共 13 节"在 14 行的列表里仍然正确**：' + show(page.data.periodSourceText));
      isFalse(page.data.periodSourceText.indexOf('共 14') > -1,
        '反面对照：不是"共 14 节"');
      // 清掉一节（第 5 节）→ 12/13，未校准回到 1 节
      var idx5 = rowIndexOf(page, 5);
      page.onTapPeriodClear({ currentTarget: { dataset: { index: idx5 } } });
      return settle().then(function () {
        var rows2 = page.data.periodRows.filter(function (r) { return !r.isGapRow; });
        eq(rows2.filter(function (r) { return r.calibrated; }).length, 12,
          '清掉一节后已校准 12 节');
        eq(rows2.filter(function (r) { return r.uncalibrated; }).length, 1,
          '未校准 1 节');
        isTrue(page.data.periodSourceText.indexOf('共 13 节') > -1,
          '分母仍是 13（清一节不会让总数变成 12 行）：'
          + show(page.data.periodSourceText));
        isTrue(page.data.periodSourceText.indexOf('12 节') > -1, '分子是 12');
      });
    });
  });

  // ===========================================================================
  // 1d. 防御：isBreakRow / rowPeriodNumber 缺席时页面照常工作（typeof 守卫）
  //     接口"现在确实存在"，但这一层守卫要保留 —— 老版本 utils 或接口改名时，
  //     页面必须退化成"还能用"，而不是白屏。
  // ===========================================================================
  chain = chain.then(function () {
    block('isBreakRow / rowPeriodNumber 缺席 —— typeof 守卫照常工作');
    var hadBreak = typeof periods.isBreakRow === 'function';
    var hadNumber = typeof periods.rowPeriodNumber === 'function';
    var savedBreak = periods.isBreakRow;
    var savedNumber = periods.rowPeriodNumber;
    delete periods.isBreakRow;
    delete periods.rowPeriodNumber;
    var threw = false;
    return bootPage(REAL_PERIOD_TIMES).catch(function (err) {
      threw = true;
      console.error('缺行形状接口时页面崩了：', err);
    }).then(function (page) {
      isFalse(threw, '**两个接口都不在时页面照常渲染**（不抛异常）');
      if (hadBreak) periods.isBreakRow = savedBreak;
      if (hadNumber) periods.rowPeriodNumber = savedNumber;

      eq(page.data.errorText, '', '页面没有进入错误态');
      eq(page.data.periodRows.length, REAL_ROW_COUNT, '行数照旧（14 行）');
      var r6 = rowOf(page, 6);
      isTrue(r6 && r6.uncalibrated === true,
        '本地口径接管：第 6 节仍被标成未校准');
      isTrue(r6 && r6.isBreak === true,
        '兜底判据也把第 6 节认成空档行（breakLabel 那条老路）');
      var gapRow = null;
      page.data.periodRows.forEach(function (r) { if (r.isGapRow) gapRow = r; });
      isTrue(!!gapRow, '合成行仍然被识别出来（isGapRow）');
      isTrue(gapRow && gapRow.isBreak === true,
        '兜底的 rowIsBreak 也把合成行当空档（没有节次号 → 直接算空档）');
      isFalse(gapRow && gapRow.editable === true, '合成行仍然不给按钮');
      isTrue(page.data.periodSourceText.indexOf('13 节') > -1,
        '计数口径照旧（13 节）—— 兜底路径没有把合成行算进去');
    });
  });

  // -------------------------------------------------------------------------
  // 2. 补录：选 13:30/14:10 → payload 只动第 6 节，其余原值不变
  //    （**本文件最重要的一条**：补一节不许把别的作息冲掉）
  // -------------------------------------------------------------------------
  chain = chain.then(function () {
    block('补录第6节 —— payload 只动这一节，其余原值不变');
    return bootPage(REAL_PERIOD_TIMES).then(function (page) {
      var before = requestCount();
      // 【保存次数的基线要从"此刻"取】callLog 是全局累积的（前面的组也保存过），
      // 所以这里记下"打开弹层前一共发过几次请求"，后面用它做增量比较。
      var savesBefore = saveCount();
      openEditor(page, 6);
      eq(page.data.periodEditVisible, true, '点「设定时间」→ 弹层打开');
      eq(page.data.periodEditLabel, '午休',
        '弹层标题用的是这一行的显示名（校准作息下第 6 节叫「午休」）');
      eq(page.data.periodEditStart, '14:55', '初值 = 当前显示的开始时间（省得用户重填）');
      eq(page.data.periodEditEnd, '15:40', '初值 = 当前显示的结束时间');
      eq(requestCount(), before, '**打开弹层不发任何请求**（纯本地）');

      // 选时间（两个 picker 的 change 事件）
      page.onPeriodStartChange({ detail: { value: '13:30' } });
      page.onPeriodEndChange({ detail: { value: '14:10' } });
      eq(page.data.periodEditStart, '13:30', '开始时间记为 13:30');
      eq(page.data.periodEditEnd, '14:10', '结束时间记为 14:10');
      eq(saveCount(), savesBefore,
        '**改 picker 不自动保存**（相对打开弹层前没有新增保存；要用户按保存）');

      page.onTapPeriodSave();
      return settle().then(function () {
        var payload = lastSavePayload();
        isTrue(!!payload, '发出了 settings_save');
        eq(payload.action, 'settings_save', '走的是 settings_save action');
        // lastSavePayload() 返回的就是云函数入参本身：{ action:'settings_save', settings:{ period_times } }
        // （不是 {name,data} 那一层 —— 那层由 callLog 的元素包着）
        var sent = payload.settings && payload.settings.period_times;
        isTrue(!!sent, 'payload 里带 period_times');
        eqJson(sent['6'], ['13:30', '14:10'],
          "**period_times['6'] === ['13:30','14:10']**");
        // 其余节次**逐个**核对（不是只看键数）：补一节不该动任何别的节次
        var others = Object.keys(REAL_PERIOD_TIMES);
        var sameCount = 0;
        others.forEach(function (key) {
          if (JSON.stringify(sent[key]) === JSON.stringify(REAL_PERIOD_TIMES[key])) sameCount += 1;
        });
        eq(sameCount, others.length,
          '**其余 ' + others.length + ' 节全部原值不变**（一个都没被冲掉）');
        eq(Object.keys(sent).length, others.length + 1,
          '键数 = 原有 ' + others.length + ' + 新的 1（没有凭空多出别的键）');
        isFalse(JSON.stringify(sent['5']) !== JSON.stringify(REAL_PERIOD_TIMES['5']),
          '反面对照：第 5 节没被写成默认值 14:00-14:45');

        // 成功后：本页那一行变成已校准 + 弹层关掉 + globalData 同步
        eq(page.data.periodEditVisible, false, '成功后弹层关掉');
        var r6 = rowOf(page, 6);
        isTrue(r6.calibrated, '**本页第 6 节立刻变成「已校准」**');
        isFalse(r6.uncalibrated, '不再是未校准');
        eq(r6.timeText, '13:30-14:10', '**显示的时间也换成了 13:30-14:10**');
        eq(page.data.periodSaveFailed, false, '结果文案不是失败态');
        isTrue(page.data.periodSaveText.indexOf('已保存') > -1,
          '有一句成功回执：' + show(page.data.periodSaveText));
        isTrue(applySettingsCalls.length > 0, '**调用了 app.applySettings 同步 globalData**');
        var synced = applySettingsCalls[applySettingsCalls.length - 1];
        eqJson(synced.period_times['6'], ['13:30', '14:10'],
          '同步过去的作息里第 6 节就是新值（课表页读的就是它）');
        eq(page.data.periodRows.filter(function (r) { return r.uncalibrated; }).length, 0,
          '现在没有任何未校准的节次了');
      });
    });
  });

  // -------------------------------------------------------------------------
  // 3. 保存失败：只说人话、页面与已有作息一个字节都不许坏
  // -------------------------------------------------------------------------
  chain = chain.then(function () {
    block('保存失败 —— 人话 + 不把已有作息改坏');
    return bootPage(REAL_PERIOD_TIMES).then(function (page) {
      // 注入失败
      saveHandler = function () { return { ok: false, error: '数据库连接超时' }; };
      var rowsBefore = JSON.stringify(page.data.periodRows);
      var timesBefore = JSON.stringify(page.periodTimes);
      // 【先把计数清零】onLoad 读设置成功后本来就会同步一次 globalData（那是既有的
      // 正确行为）。这里要断言的是"**保存失败**这一路不许再同步一次"，所以从零开始数。
      applySettingsCalls = [];

      openEditor(page, 6);
      page.onPeriodStartChange({ detail: { value: '13:30' } });
      page.onPeriodEndChange({ detail: { value: '14:10' } });
      page.onTapPeriodSave();
      return settle().then(function () {
        isTrue(page.data.periodSaveFailed, '标记成失败态');
        isTrue(page.data.periodSaveText.indexOf('数据库连接超时') > -1,
          '**失败原因如实给人看**：' + show(page.data.periodSaveText));
        isTrue(page.data.periodSaveFailed === true, 'WXML 能据此显示黄字');
        eqJson(page.data.periodRows, JSON.parse(rowsBefore),
          '**本页作息表一行都没变**（失败不许把界面改成"好像成功了"）');
        // 【为什么也要 JSON.parse】timesBefore 存的是**快照字符串** ——
        // 直接拿对象去 eq 一个字符串永远不等，那种断言测的是类型、不是行为。
        eqJson(page.periodTimes, JSON.parse(timesBefore),
          '**内存里的 periodTimes 也没被覆盖**');
        var r6 = rowOf(page, 6);
        isTrue(r6.uncalibrated, '第 6 节仍是未校准（没被 optimistic 更新成已校准）');
        eq(r6.timeText, '14:55-15:40', '显示的时间也没变');
        eq(page.data.periodSaving, false, '不会卡在"保存中"');
        isTrue(page.data.periodEditVisible, true,
          '弹层**保持打开**（用户填的东西还在，可以直接重试）');
        eq(applySettingsCalls.length, 0,
          '**保存失败时不再同步 globalData**（计数已从 onLoad 之后清零）');

        // 服务端回一个空对象（归一化没做完）→ 也不能把用户已有作息清空
        saveHandler = function () { return { ok: true, semester_start: '', period_times: {} }; };
        // 【为什么要重新打开弹层】上面那次失败之后弹层还开着，但**弹层里那一次保存
        // 已经用掉了它的上下文** —— 这一段要测的是"服务端回空对象"，不是"失效弹层"
        // （后者是第 8 组的事）。重新 openEditor 一次，让这一段的起点是干净的。
        openEditor(page, 6);
        page.onPeriodStartChange({ detail: { value: '13:30' } });
        page.onPeriodEndChange({ detail: { value: '14:10' } });
        page.onTapPeriodSave();
        return settle().then(function () {
          eqJson(page.periodTimes['5'], REAL_PERIOD_TIMES['5'],
            '**服务端回空对象时，已有的第 5 节作息仍在**（宁可保留本地算好的）');
          eqJson(page.periodTimes['6'], ['13:30', '14:10'],
            '而且这一节的新值也进去了（不是整份丢掉）');
        });
      });
    });
  });

  // -------------------------------------------------------------------------
  // 4. 清除：payload 里该 key 被移除、其余保留；且必须有确认框
  // -------------------------------------------------------------------------
  chain = chain.then(function () {
    block('清除第5节 —— 先确认，再从 payload 里移除该 key');
    return bootPage(REAL_PERIOD_TIMES).then(function (page) {
      saveHandler = null;
      var before = saveCount();
      openEditor(page, 5);
      eq(page.data.periodEditStart, '11:45', '已校准的行打开时初值是**已保存的值**（方便改）');
      page.onTapPeriodCancel();
      eq(page.data.periodEditVisible, false, '取消能关掉弹层');

      var idx5 = rowIndexOf(page, 5);
      var beforeModals = modals.length;
      page.onTapPeriodClear({ currentTarget: { dataset: { index: idx5 } } });
      eq(modals.length, beforeModals + 1, '**弹了一次确认框**（改配置不是改一条任务）');
      var modal = modals[modals.length - 1];
      isTrue(String(modal.title).indexOf('清除') > -1, '标题是"清除…？"：' + show(modal.title));
      isTrue(String(modal.content).indexOf('未校准') > -1,
        '说明后果：清除后回到未校准');
      eq(modal.confirmText, '清除', '确认按钮写「清除」（不用"确定"糊过去）');

      return settle().then(function () {
        eq(saveCount(), before + 1, '确认后发出了一次保存');
        var payload = lastSavePayload();
        // lastSavePayload() 返回的就是云函数入参本身：{ action:'settings_save', settings:{ period_times } }
        // （不是 {name,data} 那一层 —— 那层由 callLog 的元素包着）
        var sent = payload.settings && payload.settings.period_times;
        isFalse(Object.prototype.hasOwnProperty.call(sent, '5'),
          '**payload 里第 5 节这个 key 被移除了**');
        eq(Object.keys(sent).length, Object.keys(REAL_PERIOD_TIMES).length - 1,
          '其余节次都还在（键数 −1）');
        eqJson(sent['7'], REAL_PERIOD_TIMES['7'], '第 7 节原值不变');
        eqJson(sent['1'], REAL_PERIOD_TIMES['1'], '第 1 节原值不变');
        eqJson(sent['13'], REAL_PERIOD_TIMES['13'], '第 13 节原值不变');
        isFalse(JSON.stringify(sent['5']) === JSON.stringify(REAL_PERIOD_TIMES['5']),
          '反面对照：第 5 节没有被原值留着（那就是"没删掉"）');

        var r5 = rowOf(page, 5);
        isTrue(r5.uncalibrated, '**清除后第 5 节回到「未校准」**');
        isFalse(r5.calibrated, '不再是已校准');
        eq(r5.timeText, '14:00-14:45', '显示回到内置默认时间');
      });
    });
  });

  // 取消确认 → 什么都不做
  chain = chain.then(function () {
    block('清除确认框点「取消」—— 一个请求都不发');
    return bootPage(REAL_PERIOD_TIMES).then(function (page) {
      modalAnswer = false;
      var before = requestCount();
      var idx5 = rowIndexOf(page, 5);
      page.onTapPeriodClear({ currentTarget: { dataset: { index: idx5 } } });
      return settle().then(function () {
        eq(requestCount(), before, '**点取消不发任何请求**');
        var r5 = rowOf(page, 5);
        isTrue(r5.calibrated, '第 5 节仍是已校准（没被删）');
        eq(r5.timeText, '11:45-12:25', '时间也没变');
      });
    });
  });

  // -------------------------------------------------------------------------
  // 5. 本地校验：只填一个时间 / 倒挂 → 不发请求 + 给人话
  // -------------------------------------------------------------------------
  chain = chain.then(function () {
    block('只填一个时间 —— 不发请求，给出原因');
    return bootPage(REAL_PERIOD_TIMES).then(function (page) {
      var before = requestCount();
      openEditor(page, 6);
      page.onPeriodStartChange({ detail: { value: '13:30' } });
      page.onPeriodEndChange({ detail: { value: '' } });
      page.onTapPeriodSave();
      return settle().then(function () {
        eq(requestCount(), before, '**一个请求都不发**（本地就能判的错不必麻烦服务端）');
        isTrue(page.data.periodEditError.indexOf('都要填') > -1,
          '弹层里给出原因：' + show(page.data.periodEditError));
        eq(page.data.periodEditVisible, true, '弹层保持打开让他补完');
        var r6 = rowOf(page, 6);
        isTrue(r6.uncalibrated, '第 6 节仍是未校准（没被改坏）');
        eq(r6.timeText, '14:55-15:40', '时间没变');

        // 倒挂
        page.onPeriodEndChange({ detail: { value: '13:00' } });
        page.onTapPeriodSave();
        return settle().then(function () {
          eq(requestCount(), before, '倒挂同样不发请求');
          isTrue(page.data.periodEditError.indexOf('晚于') > -1,
            '给出的原因是"结束要晚于开始"：' + show(page.data.periodEditError));
        });
      });
    });
  });

  // -------------------------------------------------------------------------
  // 6. 同事的判据函数不存在时：页面照常渲染、不报错、退化成本地口径
  //    【接口现在确实存在】（periods.js 已导出 isUncalibratedRow / isBreakRow /
  //      rowPeriodNumber），这一组守的是**老版本 utils** 与**接口改名**这两件事：
  //      那种环境下页面必须还能用，而不是白屏。所以 typeof 守卫要一直留着。
  //    （第 1d 组用同样的办法守 isBreakRow / rowPeriodNumber。）
  // -------------------------------------------------------------------------
  chain = chain.then(function () {
    block('isUncalibratedRow 缺席 —— 用本地口径照常工作（typeof 守卫）');
    var had = typeof periods.isUncalibratedRow === 'function';
    var saved = periods.isUncalibratedRow;
    delete periods.isUncalibratedRow;
    var threw = false;
    return bootPage(REAL_PERIOD_TIMES).catch(function (err) {
      // 页面把异常吞在 onLoad 的 catch 里会变成 errorText，所以这里同时看两者
      threw = true;
      console.error('缺判据函数时页面崩了：', err);
    }).then(function () {
      isFalse(threw, '**判据函数不存在时页面照常渲染**（不抛异常）');
      // 【为什么要重新 boot 一次】上一句的页面是在"判据函数不存在"的状态下渲染的，
      // 下面要断言的就是**那一次渲染的结果**，所以把它再取一遍。
      return bootPage(REAL_PERIOD_TIMES);
    }).then(function (p) {
      if (had) periods.isUncalibratedRow = saved;
      eq(p.data.errorText, '', '页面没有进入错误态');
      eq(p.data.periodRows.length, REAL_ROW_COUNT, '作息表仍然 14 行（13 节 + 1 休息行）');
      var r6 = rowOf(p, 6);
      isTrue(!!r6, '第 6 节那一行照旧渲染');
      isTrue(r6.uncalibrated === true,
        '**本地口径接管：第 6 节仍被标成未校准**（功能不因为同事没落地而消失）');
      var r5 = rowOf(p, 5);
      isFalse(r5.uncalibrated, '第 5 节不受影响');
      isTrue(rowOf(p, 13) !== null, '第 13 节也在（没有多出或少掉行）');
      // 而且补录照样能用（不是"只是显示对了、功能没了"）
      openEditor(p, 6);
      eq(p.data.periodEditVisible, true, '缺判据函数时也能打开补录弹层');
    });
  });

  // -------------------------------------------------------------------------
  // 7. 全默认（从没导入过课表）：13 节全部未校准，每一节都能补
  // -------------------------------------------------------------------------
  chain = chain.then(function () {
    block('从没校准过 —— 13 节全是「未校准」，都能设定时间');
    return bootPage(null).then(function (page) {
      // 没有任何校准数据 → periodRows 就是 13 个节次，**一行空档都不会插**
      eq(page.data.periodRows.length, DEFAULT_ROWS, '13 行（没有校准数据时不插空档行）');
      var uncal = uncalibratedOf(page);
      eq(uncal.length, DEFAULT_ROWS, '**13 节全部标成未校准**');
      eq(page.data.periodRows.filter(function (r) { return r.actionText === '设定时间'; }).length,
        DEFAULT_ROWS, '每一节都有「设定时间」入口');
      isTrue(page.data.periodSourceText.indexOf('内置默认作息') > -1,
        '来源行说明当前用的是内置默认作息');

      // 补任意一节（第 3 节）：payload 只含它自己
      openEditor(page, 3);
      eq(page.data.periodEditStart, '10:00', '默认作息下第 3 节初值 = 10:00');
      page.onPeriodStartChange({ detail: { value: '10:15' } });
      page.onPeriodEndChange({ detail: { value: '10:55' } });
      page.onTapPeriodSave();
      return settle().then(function () {
        var sent = lastSavePayload().settings.period_times;   // 入参形状见最后一组上面的说明
        eqJson(sent, { '3': ['10:15', '10:55'] },
          '**只提交被改的那一节**（其余本来就没有值）');
        isTrue(rowOf(page, 3).calibrated, '保存后第 3 节变成已校准');
        eq(page.data.periodRows.filter(function (r) { return r.uncalibrated; }).length,
          DEFAULT_ROWS - 1, '未校准的剩下 12 节');
      });
    });
  });

  // -------------------------------------------------------------------------
  // 8. 脏输入：下标非法 / 行不存在的弹层保存 —— 不许崩、不许乱存
  // -------------------------------------------------------------------------
  chain = chain.then(function () {
    block('脏输入 —— 非法下标与失效弹层都不许崩');
    return bootPage(REAL_PERIOD_TIMES).then(function (page) {
      var before = requestCount();
      var threw = false;
      try {
        page.onTapPeriodSet({ currentTarget: { dataset: { index: 999 } } });
      } catch (err) { threw = true; }
      isFalse(threw, '下标越界 → 不抛异常');
      eq(page.data.periodEditVisible, false, '也不打开弹层');
      isTrue(toasts.length > 0, '给一句人话提示：' + show(toasts[toasts.length - 1]));

      // 弹层开着但那一行不见了（列表被刷新过）→ 保存要拦住
      openEditor(page, 6);
      page.data.periodRows = [];
      page.onTapPeriodSave();
      return settle().then(function () {
        eq(requestCount(), before, '**行已失效时不发请求**');
        isTrue(page.data.periodEditError.indexOf('不在列表里') > -1,
          '并说明原因：' + show(page.data.periodEditError));
      });
    });
  });

  return chain;
}

// ---------------------------------------------------------------------------
// 导出给 run.js 串行调用；单独跑时自己收尾
// ---------------------------------------------------------------------------
// 【假绿警告】`done` 必须把 run() 的 Promise 串回主链 —— 少了它，report 会赶在
// 异步断言之前打印（本仓库已经出过一次：通过数停在某个数、报告却全绿）。
var done = Promise.resolve()
  .then(run)
  .then(function () {
    restoreGlobals();
    if (require.main === module) H.report('我的页 —— 节次作息（未校准标记 / 补录 / 清除）');
  })
  .catch(function (err) {
    restoreGlobals();
    console.error('me 节次作息测试自己崩了：', err);
    process.exit(2);
  });

module.exports = { done: done };
