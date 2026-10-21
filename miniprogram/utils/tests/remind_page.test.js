/**
 * utils/tests/remind_page.test.js —— 「到期提醒」小程序端（pages/me 卡片 + pages/tasks 降级提示）。
 *
 * 跑法：
 *     node utils/tests/remind_page.test.js   # 只跑这一份（末尾打印通过数，失败退出码 1）
 *     node utils/tests/run.js                # 跑全部（注册那一行在 run.js 的串行链里）
 *
 * ===========================================================================
 * 【为什么这一份测试必须存在】云函数 remind 的自测（cloudfunctions/_selftest.js 第 10 节）
 * 只能证明"服务端算得对"，证明不了**前端有没有把它用对**。而这一半最容易错的地方恰好
 * 都在前端：
 *   1. **两层 ok** —— api.callCloudFunction 会把云函数返回值包一层成 `{ok,data,error}`，
 *      只判外层就会把 `{ok:false}` 当成成功，界面上出现一堆 0/空值，看着像"功能坏了"；
 *   2. **模板 ID 不许硬编码** —— 它只该来自 status（换模板只改云函数环境变量）；
 *      没配模板时**一个授权窗都不能弹**（弹了也没用，只会让用户以为小程序坏了）；
 *   3. **ack count 恒为 1** —— 一次性订阅是"授权一次只能发一条"，报多了等于骗服务端，
 *      真实下发必然 43101 失败；
 *   4. **reject / ban 不许 ack** —— 没授权却加额度 = 骗自己；
 *   5. **status 失败要静默** —— 进页面顺手读一次，失败弹"网络异常"纯属打扰；
 *   6. **24 小时内的判定口径** —— 降级提示是"收不到微信通知"时唯一的救命路径，
 *      口径错了（少算一条）用户就真的会错过截止。
 *
 * 【怎么测一个 Page】照 ai_page.test.js / edit_busy.test.js / me_import.test.js 的既有模式：
 * 加载期只捕获 `Page`，用例执行时才装 wx / getApp 桩，自己 H.report。
 *
 * 【不做的事】不 require 第三方库；不用 child_process（本环境沙箱禁止管道）；不联网。
 */

'use strict';

var fs = require('fs');
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
// 【加载期一律不许动全局、不许抛异常】—— ai_page.test.js 踩过这个坑：顶层直接给
// global.wx 赋值会把别的测试文件的桩冲掉（表现为"单独跑全绿、经 run.js 加载就崩"）。
// 所以这里加载期只捕获 Page 注册对象，真正的替换发生在 run() 里。
var toasts = [];
var modals = [];
var cloudCalls = [];
var cloudHandler = null;
/** 授权窗的返回：null = 正常弹；{ fail: {...} } = 调用就失败（不是用户拒绝） */
var subscribeAnswer = null;

// 【三点六新增】订阅设置 / 本地缓存 / 系统日历这三件事的桩状态。
// 默认一律取**最保守**的那一侧：设置里没有任何模板（= 用户没勾过"保持以上选择"，
// 于是静默补额度这条路必须一次都不调用）、缓存可用但为空、日历按成功返回。
// 用例要别的行为就自己改这几个变量。
var subscribeSetting = { subscriptionsSetting: { mainSwitch: true, itemSettings: {} } };
var storageMap = {};
var calendarCalls = [];
var calendarFailsAt = -1;
var calendarSupported = true;

var savedWx = global.wx;
var savedGetApp = global.getApp;

function useStub() {
  toasts = [];
  modals = [];
  cloudCalls = [];
  cloudHandler = null;
  subscribeAnswer = null;
  subscribed = [];
  subscribeSetting = { subscriptionsSetting: { mainSwitch: true, itemSettings: {} } };
  storageMap = {};
  calendarCalls = [];
  calendarFailsAt = -1;
  calendarSupported = true;

  global.wx = {
    showToast: function (options) { toasts.push((options && options.title) || ''); },
    showModal: function (options) { modals.push({ title: options && options.title, content: options && options.content }); },
    // 【这一条是本功能的核心】返回形状与微信一致：
    //   { errMsg: 'requestSubscribeMessage:ok', <templateId>: 'accept' | 'reject' | 'ban' }
    requestSubscribeMessage: function (options) {
      subscribed.push(options);
      if (subscribeAnswer && subscribeAnswer.fail) {
        if (options && typeof options.fail === 'function') options.fail(subscribeAnswer.fail);
        return;
      }
      var answer = (subscribeAnswer && subscribeAnswer.accept === false) ? 'reject' : 'accept';
      var res = { errMsg: 'requestSubscribeMessage:ok' };
      var ids = (options && options.tmplIds) || [];
      ids.forEach(function (id) { res[id] = answer; });
      if (subscribeAnswer && subscribeAnswer.raw) res = subscribeAnswer.raw(ids[0]);
      if (options && typeof options.success === 'function') options.success(res);
    },
    // 【三点六】订阅设置：真实形状是 { subscriptionsSetting: { mainSwitch, itemSettings } }。
    // 默认值是"设置页里没有任何模板" —— 也就是用户没勾过「总是保持以上选择，不再询问」。
    getSetting: function (options) {
      if (options && typeof options.success === 'function') options.success(subscribeSetting);
    },
    // 【三点六】本地缓存：节流（10 分钟一次）与"写过的日历不重复写"都靠它
    getStorageSync: function (key) { return storageMap[key] === undefined ? '' : storageMap[key]; },
    setStorageSync: function (key, value) { storageMap[key] = value; },
    // 【三点六】写系统日历（wx.addPhoneCalendar 一次只能加一个事件）
    canIUse: function (name) { return name === 'addPhoneCalendar' ? calendarSupported : true; },
    addPhoneCalendar: function (options) {
      var index = calendarCalls.length;
      calendarCalls.push(options);
      if (index === calendarFailsAt) {
        if (options && typeof options.fail === 'function') {
          options.fail({ errMsg: 'addPhoneCalendar:fail auth deny' });
        }
        return;
      }
      if (options && typeof options.success === 'function') {
        options.success({ errMsg: 'addPhoneCalendar:ok' });
      }
    },
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

/** 被弹过的授权窗（每个用例自己数） */
var subscribed = [];

// ---------------------------------------------------------------------------
// 取回两个页面的注册对象（加载期只调用一次 Page()，不碰 wx）
// ---------------------------------------------------------------------------
// 【必须清一次 require 缓存】pages/me/me.js 在本文件之前就已经被 me_import.test.js
// require 过了（它也在 run.js 的串行链里）。node 的 require 是**带缓存**的：再来一次
// 只会拿到缓存里那个 module，**不会**重新执行 `Page({...})`，于是我们什么也捕获不到
// —— 表现就是"单独跑全绿、经 run.js 加载却说页面加载失败"。
// 删掉缓存条目再 require，页面文件就会重新执行一次注册（它本身没有副作用，
// 只是把同一个对象再交给 Page()）。me_import.test.js 手里那份注册对象不受影响。
var ME_PATH = path.join(ROOT, 'pages', 'me', 'me.js');
var TASKS_PATH = path.join(ROOT, 'pages', 'tasks', 'tasks.js');

var me = null;
var meLoadError = null;
try {
  delete require.cache[require.resolve(ME_PATH)];
  global.Page = function (options) { me = options; };
  require(ME_PATH);
} catch (err) {
  meLoadError = err;
}

var tasks = null;
var tasksLoadError = null;
try {
  delete require.cache[require.resolve(TASKS_PATH)];
  global.Page = function (options) { tasks = options; };
  require(TASKS_PATH);
} catch (err) {
  tasksLoadError = err;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 造一个页面实例（复制注册对象 + 独立的 data 与 setData，与真机行为一致） */
function newPage(registered) {
  var page = {};
  Object.keys(registered).forEach(function (key) { page[key] = registered[key]; });
  page.data = JSON.parse(JSON.stringify(registered.data));
  page.setData = function (patch) {
    Object.keys(patch || {}).forEach(function (key) { page.data[key] = patch[key]; });
  };
  return page;
}

/** 等页面内部的 Promise 链跑完（多让几轮事件循环，两条链并行也够） */
function settle(rounds) {
  var n = rounds || 8;
  var p = Promise.resolve();
  for (var i = 0; i < n; i += 1) {
    p = p.then(function () { return new Promise(function (resolve) { setImmediate(resolve); }); });
  }
  return p;
}

function callsOf(action) {
  return cloudCalls.filter(function (item) { return item.data && item.data.action === action; });
}

function toastsText() { return toasts.join(' | '); }

function lastToast() { return toasts.length ? toasts[toasts.length - 1] : ''; }

/** 有没有哪条 toast 是"提醒设置没读到"这件事弹出来的（这是本次要守的那条红线） */
function hasRemindToast() {
  return toasts.some(function (text) { return text.indexOf('提醒设置') > -1; });
}

// ---------------------------------------------------------------------------
// 云函数桩（remind）
// ---------------------------------------------------------------------------
// `serveRemind(options)` 把状态与"动作返回"一次配好：
//   status  按当前 enabled / quota 现算（与云函数的语义一致：三个条件都满足 ready 才是 true）
//   ack     把传入的 count 原样回显，额度 +count（**故意回显**：这样"有没有传 2/3"一眼看得出）
//   config  只接受白名单档位，其余照云函数口径返回 ok:false
var REMIND_LEAD_OPTIONS = [15, 30, 60, 120, 1440];
var served = {
  templateId: 'TPL_TEST_1',
  enabled: false,
  quota: 0,
  leadMin: 60,
  maxQuota: 10,
  statusFails: false,
  acked: [],
  configs: [],
  // 这一页要用的任务列表（"写进手机日历"这条链会去读它；其余用例用不到，默认空）
  tasks: [],
};

function serveRemind(options) {
  var o = options || {};
  served.templateId = o.templateId === undefined ? 'TPL_TEST_1' : o.templateId;
  served.enabled = !!o.enabled;
  served.quota = Number(o.quota) || 0;
  served.leadMin = Number(o.leadMin) || 60;
  served.maxQuota = o.maxQuota === undefined ? 10 : o.maxQuota;
  served.statusFails = !!o.statusFails;
  served.acked = [];
  served.configs = [];
  served.tasks = Array.isArray(o.tasks) ? o.tasks : [];
  // 【三点七新增】扫描（action:'scan'）的桩：记下每次调用，返回一份可配的 summary。
  // 默认"扫到 1 人、什么都没发、没有跳过" —— 最安静的那一侧，不给旧用例添噪音。
  served.scans = [];
  served.scanFails = !!o.scanFails;
  served.scanResult = o.scanResult === undefined
    ? {
      scanned: 1,
      sent: 0,
      skipped: 0,
      failed: 0,
      quota_refunded: 0,
      downgraded: 0,
      errors: [],
      warnings: [],
      skipped_reasons: {},
      details: [],
      lead_min: Number(o.leadMin) || 60,
      now: '2026-10-21T19:40:00+08:00',
    }
    : o.scanResult;
  cloudCalls = [];
  subscribed = [];   // 每个场景自己数"弹了几次授权窗"

  cloudHandler = function (name, data) {
    // me 页 onLoad 还会顺手拉一次任务列表（给"替换课表会删几门课"用）。
    // 这里一并服务它，免得那次请求落到"unexpected"分支、把断言搅浑。
    if (name === 'tasks' && data && data.action === 'list') {
      return Promise.resolve({ ok: true, tasks: served.tasks, count: served.tasks.length });
    }
    if (name !== 'remind') return Promise.resolve({ ok: false, error: 'unexpected function: ' + name });
    var action = data && data.action;

    if (action === 'status') {
      if (served.statusFails) return Promise.resolve({ ok: false, error: '服务异常：数据库不可用' });
      var envReady = !!served.templateId;
      var ready = envReady && served.enabled && served.quota > 0;
      var reason = '';
      if (!envReady) reason = '服务端还没配置订阅消息模板 ID（请在云开发控制台给 remind 云函数加环境变量 REMIND_TEMPLATE_ID）';
      else if (!served.enabled) reason = '你还没开启到期提醒（打开开关后，微信会弹一次订阅授权）';
      else if (served.quota <= 0) reason = '授权次数已用完：一次性订阅是"授权一次只能发一条"，请重新点一次开启以补充授权';
      else reason = '已就绪：还能下发 ' + served.quota + ' 条';
      // 【形状：平铺】与云函数 ok() 一致（字段与 ok 同级），api.js 只包一层
      return Promise.resolve({
        ok: true,
        enabled: served.enabled,
        lead_min: served.leadMin,
        lead_options: REMIND_LEAD_OPTIONS.slice(),
        quota: served.quota,
        max_quota: served.maxQuota,
        template_id: served.templateId,
        page: '/pages/tasks/tasks',
        ready: ready,
        ready_reason: reason,
        has_authorized: served.quota > 0 || served.enabled,
        field_map: { thing1: 'title', time2: 'due', thing3: 'left' },
        max_per_scan: 3,
        grace_min: 10,
      });
    }

    if (action === 'ack') {
      served.acked.push(data.count);
      // 【服务端契约】count 只认 1..3 的**数字**（字符串会被拒）。这里照抄那条闸门，
      // 于是"页面有没有传错类型"在测试里当场现形。
      if (typeof data.count !== 'number' || !Number.isInteger(data.count)
        || data.count < 1 || data.count > 3) {
        return Promise.resolve({ ok: false, error: 'count 只能是 1..3 之间的数字，收到：' + JSON.stringify(data.count) });
      }
      var before = served.quota;
      served.quota = Math.min(served.maxQuota, before + data.count);
      served.enabled = true;
      return Promise.resolve({
        ok: true,
        enabled: true,
        quota: served.quota,
        added: served.quota - before,
        capped: served.quota - before < data.count,
        max_quota: served.maxQuota,
        lead_min: served.leadMin,
      });
    }

    if (action === 'config') {
      served.configs.push(data);
      if (data.lead_min !== undefined && REMIND_LEAD_OPTIONS.indexOf(Number(data.lead_min)) === -1) {
        return Promise.resolve({ ok: false, error: 'lead_min 只能是 15 / 30 / 60 / 120 / 1440 之一（分钟）' });
      }
      if (data.lead_min !== undefined) served.leadMin = Number(data.lead_min);
      if (data.enabled !== undefined) served.enabled = !!data.enabled;
      return Promise.resolve({
        ok: true,
        enabled: served.enabled,
        lead_min: served.leadMin,
        quota: served.quota,
        template_id: served.templateId,
      });
    }

    if (action === 'test') {
      // 默认不消耗额度（消费路径由云函数的自测覆盖），如实回 quota_consumed
      return Promise.resolve({
        ok: true,
        sent: true,
        quota_consumed: false,
        quota: served.quota,
        template_id: served.templateId,
        page: '/pages/tasks/tasks',
        preview: {},
        truncated: [],
        warnings: [],
      });
    }

    // 【三点七新增】扫描：与云函数 actionScan 同一个入口（定时触发器也走它）
    if (action === 'scan') {
      served.scans.push(data || {});
      if (served.scanFails) return Promise.resolve({ ok: false, error: '服务异常：数据库不可用' });
      var summary = served.scanResult || {};
      var out = {};
      Object.keys(summary).forEach(function (key) { out[key] = summary[key]; });
      out.ok = true;
      var sentCount = Math.max(0, Math.floor(Number(summary.sent) || 0));
      // 与云函数一致：真的发出去才扣额度（配置类失败会退回，桩不模拟那层）
      if (sentCount > 0) served.quota = Math.max(0, served.quota - sentCount);
      return Promise.resolve(out);
    }

    return Promise.resolve({ ok: false, error: 'unexpected action: ' + action });
  };
}

/** 只服务 tasks 的 list / update / remove：用来证明"降级提示一个 remind 请求都不发" */
function serveTasksOnly(list) {
  cloudCalls = [];
  cloudHandler = function (name, data) {
    var action = data && data.action;
    if (name === 'tasks' && action === 'list') {
      return Promise.resolve({ ok: true, tasks: list, count: list.length });
    }
    if (name === 'tasks' && action === 'update') {
      return Promise.resolve({ ok: true, updated: 1, id: data.id, patch: data.patch, rejected: [] });
    }
    if (name === 'tasks' && action === 'remove') {
      return Promise.resolve({ ok: true, removed: 1, removed_ids: [data.id], children: 0 });
    }
    return Promise.resolve({ ok: false, error: 'unexpected call: ' + name + '/' + action });
  };
}

// ---------------------------------------------------------------------------
// 时间口径：钉死一个"现在" —— 2026-10-16（周五）10:00 北京时间
// ---------------------------------------------------------------------------
// 业务判断口径是北京时间（与 remind 云函数一致），所以测试也按北京时间算，
// 与跑测试的机器的本地时区**无关**（这正是要守的那条口径）。
var NOW_MS = Date.UTC(2026, 9, 16, 10, 0, 0) - 8 * 60 * 60 * 1000;   // 2026-10-16 10:00 +08:00
var HOUR_MS = 60 * 60 * 1000;

/** 造一条任务（默认：未完成的 ddl） */
function task(overrides) {
  return Object.assign({
    _id: 't1',
    title: '任务',
    type: 'ddl',
    date: '2026-10-16',
    start_time: '',
    end_time: '23:00',
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

// 任务页那组固定数据（每个用例都重新喂一遍，断言才不依赖顺序）
var TASK_SOON = task({ _id: 'soon1', title: '23 小时后到期', date: '2026-10-17', end_time: '09:00' });
var TASK_SOON_2 = task({ _id: 'soon2', title: '刚过期 5 分钟', date: '2026-10-16', end_time: '09:55' });
var TASK_DONE = task({ _id: 'done1', title: '已完成的截止', date: '2026-10-16', end_time: '11:00', done: true });
var TASK_25H = task({ _id: 'far1', title: '25 小时后到期', date: '2026-10-17', end_time: '11:00' });
var TASK_STALE = task({ _id: 'old1', title: '过期很久了', date: '2026-10-15', end_time: '09:00' });
var TASK_NO_TIME = task({ _id: 'notime1', title: '没写截止时刻', date: '2026-10-17', end_time: '' });
var TASK_EVENT = task({ _id: 'ev1', title: '一条日程', type: 'event', date: '2026-10-16', end_time: '18:00' });
var TASK_BAD_DATE = task({ _id: 'bad1', title: '不存在的日期', date: '2026-02-30', end_time: '10:00' });

// ===========================================================================
// 正式用例
// ===========================================================================
function run() {
  useStub();          // 用例执行时才装桩（加载期不碰全局）
  var ctx = {};       // 跨 .then 步骤传递的页面实例一律挂 ctx

  // ---- 0. 页面文件可加载 ----
  block('remind 前端 —— 两个页面文件都能加载');
  isFalse(!!meLoadError, 'pages/me/me.js 加载期没有抛异常'
    + (meLoadError ? '（实际：' + meLoadError.message + '）' : ''));
  isTrue(!!me, 'me 页的 Page() 注册对象拿到了');
  isFalse(!!tasksLoadError, 'pages/tasks/tasks.js 加载期没有抛异常'
    + (tasksLoadError ? '（实际：' + tasksLoadError.message + '）' : ''));
  isTrue(!!tasks, 'tasks 页的 Page() 注册对象拿到了');
  if (meLoadError || !me) return Promise.resolve();   // 页面都加载不了，后面没意义

  var MT = me.__test;
  isTrue(!!MT, 'me 页通过 __test 暴露了纯函数（测的就是页面真正在用的那份实现）');
  isTrue(!!tasks && !!tasks.__test, 'tasks 页也暴露了 __test');

  // ---- 1. 纯函数 ----
  block('remind 前端 —— 纯函数（提前量文案 / 状态归一化）');
  eq(MT.leadTextOf(30), '提前 30 分钟', '30 → 提前 30 分钟');
  eq(MT.leadTextOf(60), '提前 1 小时', '60 → 提前 1 小时（不是"提前 60 分钟"）');
  eq(MT.leadTextOf(120), '提前 2 小时', '120 → 提前 2 小时');
  eq(MT.leadTextOf(1440), '提前 1 天', '1440 → 提前 1 天（不是"提前 1440 分钟"）');
  eq(MT.leadTextOf(15), '提前 15 分钟', '15 → 提前 15 分钟');
  eq(MT.leadTextOf(0), '', '0 → 空串（非法值不编文案）');
  eq(MT.describeLeadMinutes(2880), '2 天', '整天的说法也对');
  eq(MT.describeLeadMinutes(90), '90 分钟', '不是整小时就照分钟说（不编"1.5 小时"）');

  var opts = MT.normalizeLeadOptions([60, 15, 15, -5, 'abc', 1440, 30]);
  eq(opts.join(','), '15,30,60,1440', '候选档位：去重、丢掉非正数、按升序（picker 下标才对得上）');
  eq(MT.normalizeLeadOptions([]).join(','), '15,30,60,120,1440', '空数组 → 退回内置档位（卡片不会空掉）');
  eq(MT.normalizeLeadOptions('nonsense').join(','), '15,30,60,120,1440', '不是数组 → 退回内置档位');
  // 【这一组是本功能里最容易写错的一行】Number(null) / Number('') 都是 0，
  // 而 0 是合法下标 → 用 Number() 就会把"事件里没有 value"当成"用户选了第一档"，
  // 把人家设好的提前量悄悄改掉。所以 toPickerIndex 只认"非空数字"。
  eq(MT.toPickerIndex(0), 0, '数字 0 是合法下标（第一档）');
  eq(MT.toPickerIndex(3), 3, '数字 3 合法');
  eq(MT.toPickerIndex('2'), 2, "字符串 '2' 合法（picker 给的就是字符串）");
  eq(MT.toPickerIndex(null), null, '**null → 非法**（Number(null) 是 0，不能放过去）');
  eq(MT.toPickerIndex(''), null, "**空串 → 非法**（Number('') 也是 0）");
  eq(MT.toPickerIndex('  '), null, '纯空格 → 非法');
  eq(MT.toPickerIndex(undefined), null, 'undefined → 非法');
  eq(MT.toPickerIndex('abc'), null, '非数字串 → 非法');
  eq(MT.toPickerIndex(-1), null, '负数 → 非法');
  eq(MT.toPickerIndex(1.5), null, '小数 → 非法（下标只能是整数）');
  eq(MT.toPickerIndex(true), null, '布尔 → 非法');
  eq(MT.toPickerIndex({}), null, '对象 → 非法');
  eq(MT.REMIND_FUNCTION, 'remind', '云函数名是 remind（独立云函数，不是 tasks 的 action）');
  isTrue(MT.REMIND_NO_TEMPLATE_TIP.indexOf('docs/到期提醒.md') > -1,
    '没配模板的提示必须指向 docs/到期提醒.md：' + show(MT.REMIND_NO_TEMPLATE_TIP));

  // ---- 1b. 两层 ok：只有外层 ok 时必须当成失败 ----
  block('remind 前端 —— 两层 ok（只看外层会把失败当成功）');
  var innerFailed = MT.readRemindStatus({ ok: true, data: { ok: false, error: '云函数内部失败' }, error: null });
  isFalse(innerFailed.enabled, '外层 ok、云函数 data.ok=false → 不当成成功（enabled 仍是 false）');
  eq(innerFailed.quota, 0, '同上：额度不会显示成一个假的数字');
  isFalse(innerFailed.ready, '同上：ready 也不会是 true');
  var outerFailed = MT.readRemindStatus({ ok: false, data: null, error: '网络异常' });
  isFalse(outerFailed.enabled, '外层 ok=false → 一样当成失败');
  var good = MT.readRemindStatus({
    ok: true,
    data: { ok: true, enabled: true, quota: 2, max_quota: 10, lead_min: 30, lead_options: [15, 30], template_id: 'T', ready: true },
    error: null
  });
  isTrue(good.enabled, '两层都 ok 才取字段');
  eq(good.quota, 2, '字段从 data 上取（不是从外层）');
  eq(good.lead_min, 30, 'lead_min 正常取出');
  var leadNotInOptions = MT.readRemindStatus({
    ok: true,
    data: { ok: true, lead_min: 7, lead_options: [15, 30], enabled: true },
    error: null
  });
  eq(leadNotInOptions.lead_min, 15, 'lead_min 不在候选里 → 归到第一档（否则文案与 picker 选中项对不上）');

  // =========================================================================
  // 2. status 成功 → 卡片字段
  // =========================================================================
  block('me 页 · 到期提醒 —— status 成功：卡片字段正确渲染');
  serveRemind({ enabled: true, quota: 2, leadMin: 30, maxQuota: 10 });
  ctx.me1 = newPage(me);
  ctx.me1.onLoad();
  return settle().then(function () {
    var p = ctx.me1;
    var statusCalls = callsOf('status');
    eq(statusCalls.length, 1, '进页面读一次 status');
    eq(statusCalls[0].name, 'remind', '**调的是 remind 云函数**（不是 tasks 的 action）');
    eq(p.data.remindEnabled, true, '开关状态：已开启');
    eq(p.data.remindQuota, 2, '剩余可提醒次数 = 2');
    eq(p.data.remindQuotaText, '剩余可提醒次数 2 / 10', '额度文案带上上限：' + show(p.data.remindQuotaText));
    eq(p.data.remindLeadMin, 30, '当前提前量 = 30 分钟');
    eq(p.data.remindLeadText, '提前 30 分钟', '提前量显示成人话');
    eq(p.data.remindLeadIndex, 1, 'picker 选中项指向 30 那一档');
    eq(p.data.remindLeadTexts[1], '提前 30 分钟', 'picker 选项文案与档位一一对应');
    eq(p.data.remindReady, true, 'ready=true（模板配好 + 开关开着 + 有额度）');
    isTrue(p.data.remindReadyReason.indexOf('已就绪') > -1,
      'ready_reason 原样显示：' + show(p.data.remindReadyReason));
    eq(p.data.remindTestAvailable, true, '可以发测试提醒（模板已配 + 授权过）');
    eq(p.data.remindStatusType, 'on', '状态条是"已开启"样式');
    // 【只数"提醒"这一路的 toast】me 页 onLoad 还会读设置 / 拉任务（别的手写功能），
    // 它们失败时各自弹各自的提示是既有行为。这里要守的是"提醒这条链不额外弹"。
    isFalse(hasRemindToast(), '读提醒状态本身不弹任何提示（实际 toast：' + show(toastsText()) + '）');
    eq(p.data.remindHint, '', '没有任何灰字（读到了就不写灰字）');

    // =======================================================================
    // 3. status 失败 → 不弹 toast，只有灰字
    // =======================================================================
    block('me 页 · 到期提醒 —— status 失败：**不弹 toast**，只有一行灰字');
    serveRemind({ statusFails: true });
    ctx.me2 = newPage(me);
    ctx.me2.onLoad();
    return settle();
  }).then(function () {
    var p = ctx.me2;
    isFalse(hasRemindToast(), '**读提醒设置失败 → 一个"提醒"的 toast 都不弹**'
      + '（用户可能只是想看学期设置。实际 toast：' + show(toastsText()) + '）');
    eq(modals.length, 0, '也不弹任何模态框');
    isTrue(p.data.remindHint.indexOf('暂时读不到提醒设置') > -1,
      '只在卡片里写一行灰字：' + show(p.data.remindHint));
    eq(p.data.remindStatusType, '', '状态条不显示（不知道就说不知道）');
    eq(p.data.remindStatusText, '', '同上：不编一句"未开启"出来');
    eq(p.data.remindTestAvailable, false, '读不到状态 → 测试提醒按钮置灰（不知道能不能发）');
    eq(p.data.remindLoading, false, 'loading 要收敛，不能一直转');

    // =======================================================================
    // 4. template_id 为空 → 不弹授权窗 + 指向配置
    // =======================================================================
    block('me 页 · 到期提醒 —— 模板 ID 没配：不弹授权窗，提示指向配置文档');
    serveRemind({ templateId: '', enabled: false, quota: 0 });
    ctx.me3 = newPage(me);
    ctx.me3.onLoad();
    return settle();
  }).then(function () {
    var p = ctx.me3;
    eq(p.data.remindConfigError, true, '识别出"服务端没配模板"这种状态');
    eq(p.data.remindStatusType, 'warn', '状态条是警示样式（不是"未开启"，那不是用户的错）');
    eq(p.data.remindTestAvailable, false, '测试提醒按钮置灰');
    // 基线：这一次 onLoad 一次授权窗都没弹过
    eq(subscribed.length, 0, '（基线）读状态不会弹授权窗');
    toasts = [];
    modals = [];
    ctx.me3.onRemindEnable();
    return settle(2);
  }).then(function () {
    var p = ctx.me3;
    eq(subscribed.length, 0, '**一个授权窗都没弹**（没有 template_id，弹了也没用）');
    eq(callsOf('ack').length, 0, '也**没有**调 ack（没授权就不许加额度）');
    eq(modals.length, 1, '而是弹一个模态框把"下一步做什么"说清楚');
    isTrue(modals[0].content.indexOf('REMIND_TEMPLATE_ID') > -1,
      '用的是服务端给的 ready_reason（它已经指明了去控制台加环境变量）：' + show(modals[0].content));
    isTrue(p.data.remindResultText.indexOf('模板') > -1 || p.data.remindResultText.indexOf('REMIND_TEMPLATE_ID') > -1,
      '结果行上也留了一句（模态框关掉后还看得见）：' + show(p.data.remindResultText));

    // 兜底：status 根本没读到（remindTemplateId 为空）时，也必须指向 docs/到期提醒.md
    block('me 页 · 到期提醒 —— status 读不到时点按钮：仍不发请求，指向 docs/到期提醒.md');
    serveRemind({ statusFails: true });
    ctx.me3b = newPage(me);
    ctx.me3b.onLoad();
    return settle();
  }).then(function () {
    subscribed = [];
    modals = [];
    toasts = [];
    isTrue(ctx.me3b.data.remindHint.indexOf('暂时读不到提醒设置') > -1,
      '前置：status 读失败 → 卡片里只有灰字：' + show(ctx.me3b.data.remindHint));
    ctx.me3b.onRemindEnable();
    return settle(2);
  }).then(function () {
    eq(subscribed.length, 0, '**没读到 template_id 就不弹授权窗**');
    eq(callsOf('ack').length, 0, '也不 ack');
    eq(modals.length, 1, '弹模态框说明该怎么配置');
    isTrue(modals[0].content.indexOf('docs/到期提醒.md') > -1,
      '兜底文案必须指向 docs/到期提醒.md：' + show(modals[0].content));

    // =======================================================================
    // 5. 授权 accept → ack({count:1})
    // =======================================================================
    block('me 页 · 到期提醒 —— 授权 accept：调 ack({count:1}) 并刷新状态');
    serveRemind({ enabled: false, quota: 0 });
    ctx.me4 = newPage(me);
    ctx.me4.onLoad();
    return settle();
  }).then(function () {
    var p = ctx.me4;
    eq(p.data.remindEnabled, false, '前置：还没开启');
    eq(p.data.remindQuota, 0, '前置：额度 0');
    subscribed = [];
    toasts = [];
    subscribeAnswer = null;             // 用户在授权窗里点「允许」
    ctx.me4.onRemindEnable();
    return settle(2);
  }).then(function () {
    eq(subscribed.length, 1, '弹了一次订阅授权窗');
    eq(subscribed[0].tmplIds.length, 1, '只勾一个模板位');
    eq(subscribed[0].tmplIds[0], 'TPL_TEST_1', '**用的模板 ID 来自 status**（前端不硬编码）');
    return settle(6);
  }).then(function () {
    var p = ctx.me4;
    var acks = callsOf('ack');
    eq(acks.length, 1, 'accept → 调了一次 ack');
    eq(acks[0].name, 'remind', 'ack 发给 remind 云函数');
    eq(acks[0].data.count, 1, '**count 恒为 1**（一次性订阅：授权一次只能发一条）');
    eq(typeof acks[0].data.count, 'number', 'count 必须是**数字**（云函数拒字符串）');
    eq(p.data.remindQuota, 1, '刷新后额度变成 1（服务端返回的真值）');
    eq(p.data.remindEnabled, true, '开关跟着变成已开启（ack 里服务端把它置 true 了）');
    eq(p.data.remindReady, true, 'ready 变成 true：现在点一下就能收到一条提醒');
    isTrue(lastToast().indexOf('已增加 1 次') > -1, 'toast 说明"已增加 1 次提醒机会"：' + show(toastsText()));
    isTrue(p.data.remindResultText.indexOf('一次性订阅') > -1,
      '结果行里解释了为什么只能一次一次攒：' + show(p.data.remindResultText));

    // =======================================================================
    // 6. 授权 reject / ban → 不 ack，文案不同
    // =======================================================================
    block('me 页 · 到期提醒 —— 授权 reject：**不 ack**，文案与 ban 不同');
    serveRemind({ enabled: false, quota: 0 });
    ctx.me5 = newPage(me);
    ctx.me5.onLoad();
    return settle();
  }).then(function () {
    subscribed = [];
    toasts = [];
    // 用户在授权窗里点「拒绝」
    subscribeAnswer = { raw: function (id) { var r = { errMsg: 'requestSubscribeMessage:ok' }; r[id] = 'reject'; return r; } };
    ctx.me5.onRemindEnable();
    return settle(6);
  }).then(function () {
    var p = ctx.me5;
    eq(subscribed.length, 1, '授权窗弹了');
    eq(callsOf('ack').length, 0, '**reject → 一次 ack 都不发**（没授权就不许加额度）');
    eq(p.data.remindQuota, 0, '额度没有变');
    eq(p.data.remindEnabled, false, '开关也没被打开');
    isTrue(p.data.remindResultText.indexOf('拒绝了授权') > -1,
      '如实说明"你拒绝了授权"：' + show(p.data.remindResultText));
    isTrue(p.data.remindResultText.indexOf('收不到') > -1,
      '并说清后果（不授权就收不到提醒），但不责备用户');
    eq(p.data.remindBusy, false, 'busy 要收敛（否则按钮永远点不动）');
    ctx.rejectText = p.data.remindResultText;

    block('me 页 · 到期提醒 —— 授权 ban：**不 ack**，且指路微信设置');
    serveRemind({ enabled: false, quota: 0 });
    ctx.me5b = newPage(me);
    ctx.me5b.onLoad();
    return settle();
  }).then(function () {
    subscribed = [];
    subscribeAnswer = { raw: function (id) { var r = { errMsg: 'requestSubscribeMessage:ok' }; r[id] = 'ban'; return r; } };
    ctx.me5b.onRemindEnable();
    return settle(6);
  }).then(function () {
    var p = ctx.me5b;
    eq(callsOf('ack').length, 0, '**ban → 同样不 ack**');
    eq(p.data.remindQuota, 0, '额度不变');
    isTrue(p.data.remindResultText.indexOf('设置') > -1 && p.data.remindResultText.indexOf('订阅消息') > -1,
      'ban 的文案指向"微信设置 → 订阅消息"：' + show(p.data.remindResultText));
    isFalse(p.data.remindResultText === ctx.rejectText,
      'ban 与 reject 的提示**必须不一样**（用户要做的事不同）');

    // 授权窗本身就失败（不是用户拒绝）：errCode / errMsg 原样给出，别吞掉
    block('me 页 · 到期提醒 —— 授权窗调用失败：errCode/errMsg 原样给出，不吞');
    serveRemind({ enabled: false, quota: 0 });
    ctx.me5c = newPage(me);
    ctx.me5c.onLoad();
    return settle();
  }).then(function () {
    subscribed = [];
    toasts = [];
    subscribeAnswer = { fail: { errCode: 10001, errMsg: 'requestSubscribeMessage:fail not supported in devtools' } };
    ctx.me5c.onRemindEnable();
    return settle(6);
  }).then(function () {
    var p = ctx.me5c;
    eq(callsOf('ack').length, 0, '调用失败 → 不 ack');
    isTrue(p.data.remindResultText.indexOf('not supported in devtools') > -1,
      'errMsg 原样出现在结果行里：' + show(p.data.remindResultText));
    isTrue(p.data.remindResultText.indexOf('10001') > -1,
      'errCode 也带上（排障需要）：' + show(p.data.remindResultText));
    isTrue(toasts.length >= 1, '用户主动点的操作失败 → 必须有 toast（不许静默）');

    // =======================================================================
    // 7. 连点两下：只发一次 ack
    // =======================================================================
    block('me 页 · 到期提醒 —— 连点两下按钮：只弹一次窗、只 ack 一次');
    serveRemind({ enabled: false, quota: 0 });
    ctx.me6 = newPage(me);
    ctx.me6.onLoad();
    return settle();
  }).then(function () {
    subscribed = [];
    subscribeAnswer = null;
    ctx.me6.onRemindEnable();
    ctx.me6.onRemindEnable();          // 第二次点击：busy 应该挡住它
    return settle(6);
  }).then(function () {
    eq(subscribed.length, 1, '**授权窗只弹一次**（连点不会连弹）');
    eq(callsOf('ack').length, 1, 'ack 也只有一次（否则会重复上报、白白多算额度）');
    eq(callsOf('ack')[0].data.count, 1, '那一次也是 count:1');

    // =======================================================================
    // 8. 提前量 picker
    // =======================================================================
    block('me 页 · 到期提醒 —— 改提前量：调 config({lead_min}) 并就地更新');
    serveRemind({ enabled: true, quota: 5, leadMin: 60 });
    ctx.me7 = newPage(me);
    ctx.me7.onLoad();
    return settle();
  }).then(function () {
    var p = ctx.me7;
    eq(p.data.remindLeadMin, 60, '前置：当前提前 60 分钟');
    eq(p.data.remindLeadIndex, 2, '前置：picker 选中第 2 档（15/30/60）');
    p.onRemindLeadChange({ detail: { value: 1 } });   // 选第 1 档 = 30 分钟
    return settle(6);
  }).then(function () {
    var p = ctx.me7;
    var configs = callsOf('config');
    eq(configs.length, 1, '发了**一次** config 请求');
    eq(configs[0].name, 'remind', 'config 发给 remind 云函数');
    eq(configs[0].data.action, 'config', 'action 是 config');
    eq(configs[0].data.lead_min, 30, '提交的是**数字** 30（不是下标、不是字符串）');
    eq(p.data.remindLeadMin, 30, '就地更新成 30');
    eq(p.data.remindLeadIndex, 1, 'picker 选中项跟着走');
    eq(p.data.remindLeadText, '提前 30 分钟', '文案同步更新');
    eq(p.data.remindQuota, 5, '额度没被这次改动影响');
    isTrue(p.data.remindResultText.indexOf('提前 30 分钟') > -1,
      '结果行如实说改成了什么：' + show(p.data.remindResultText));

    // ---- 「改成没变化的那个值」：也不该发请求（省一次网络、界面也不会闪）----
    var beforeSame = callsOf('config').length;
    p.onRemindLeadChange({ detail: { value: 1 } });    // 还是 30
    return settle(4).then(function () {
      eq(callsOf('config').length, beforeSame, '选回当前这一档 → 不发请求');
      eq(p.data.remindLeadMin, 30, '值也没变');

      // ---- 非法值：一个请求都不发，且**不许把当前值改坏** ----
      // 【这两个断言是分开的】"不发请求"和"没改坏"是两件事：曾经把越界下标
      // 当成"某项的值"处理，结果 options[99] 是 undefined、页面自己变成未设置。
      block('me 页 · 到期提醒 —— 非法提前量：一个请求都不发，也不改坏当前值');
      var beforeBad = callsOf('config').length;
      p.onRemindLeadChange({ detail: { value: 99 } });       // 越界下标
      p.onRemindLeadChange({ detail: { value: -1 } });
      p.onRemindLeadChange({ detail: { value: 'abc' } });
      p.onRemindLeadChange({ detail: { value: null } });
      p.onRemindLeadChange({});                              // 连 detail 都没有
      p.onRemindLeadChange();                                // 连 event 都没有
      return settle(4).then(function () {
        eq(callsOf('config').length, beforeBad,
          '非法提前量**一个请求都不发**（服务端有白名单，发了也是白跑一趟网络）');
        eq(p.data.remindLeadMin, 30, '**当前值也没被改坏**（仍是 30）');
        eq(p.data.remindLeadIndex, 1, 'picker 仍停在 30 那一档');
        eq(p.data.remindLeadText, '提前 30 分钟', '文案也照旧');

        // =====================================================================
        // 9. 测试提醒
        // =====================================================================
        block('me 页 · 到期提醒 —— 发测试提醒：结果如实显示 + 明确没消耗额度');
        serveRemind({ enabled: true, quota: 5, leadMin: 60 });
        ctx.me8 = newPage(me);
        ctx.me8.onLoad();
        return settle();
      });
    });
  }).then(function () {
    var p = ctx.me8;
    eq(p.data.remindTestAvailable, true, '前置：模板已配 + 授权过 → 按钮可点');
    var before = callsOf('test').length;
    p.onRemindTest();
    return settle(6).then(function () {
      var tests = callsOf('test');
      eq(tests.length, before + 1, '调了一次 test');
      eq(tests[0].name, 'remind', 'test 发给 remind 云函数');
      eq(tests[0].data.action, 'test', 'action 是 test');
      isTrue(p.data.remindResultText.indexOf('测试提醒已发出') > -1,
        '如实说发出去了：' + show(p.data.remindResultText));
      isTrue(p.data.remindResultText.indexOf('没有消耗') > -1,
        '并明确"没有消耗可提醒次数"（云函数默认 quota_consumed:false）：' + show(p.data.remindResultText));
      eq(p.data.remindQuota, 5, '额度真的没动');

      // 没授权过（额度 0）→ 不发请求，先让用户去授权
      block('me 页 · 到期提醒 —— 没授权过就点测试：不发请求，先引导授权');
      serveRemind({ enabled: false, quota: 0 });
      ctx.me9 = newPage(me);
      ctx.me9.onLoad();
      return settle();
    });
  }).then(function () {
    toasts = [];
    var before = callsOf('test').length;
    ctx.me9.onRemindTest();
    return settle(4).then(function () {
      eq(ctx.me9.data.remindTestAvailable, false, '前置：没授权 → 按钮置灰');
      eq(callsOf('test').length, before, '**一个 test 请求都不发**（发了用户也收不到）');
      isTrue(toasts.length >= 1, '点了就有反馈');
      isTrue(ctx.me9.data.remindResultText.indexOf('授权') > -1,
        '结果行引导他去授权：' + show(ctx.me9.data.remindResultText));

      // =====================================================================
      // 10. tasks 页：24 小时内到期的降级提示（**纯前端**）
      // =====================================================================
      block('tasks 页 · 即将到期 —— 纯前端算，一个 remind 请求都不发');
      serveTasksOnly([TASK_SOON, TASK_DONE, TASK_25H, TASK_STALE]);
      ctx.tp1 = newPage(tasks);
      ctx.tp1.remindNowMs = NOW_MS;     // 钉死"现在"（2026-10-16 10:00 北京时间）
      return ctx.tp1.loadTasks();
    });
  }).then(function () {
    var p = ctx.tp1;
    eq(callsOf('status').length, 0, '**没有调 remind 的 status**（降级提示不依赖订阅消息）');
    eq(callsOf('test').length, 0, '也没有调 test');
    eq(callsOf('ack').length, 0, '也没有调 ack');
    var remindCalls = cloudCalls.filter(function (item) { return item.name === 'remind'; });
    eq(remindCalls.length, 0, '整页**一个 remind 云函数请求都没有**（只拉了 tasks/list）');
    eq(cloudCalls.length, 1, '只发了那一次 tasks/list（多一次都算"依赖了云端"）');

    // ---- 判定口径：包含 23 小时后的、不包含已完成 / 25 小时后 / 过期很久的 ----
    block('tasks 页 · 即将到期 —— 判定口径（23 小时内算，已完成/25 小时后/过期太久不算）');
    eq(p.data.dueSoonCount, 1, '只有"23 小时后到期"这一条算数');
    eq(p.data.dueSoonText, '今天有 1 个截止事项即将到期', '警示条文案：' + show(p.data.dueSoonText));
    eq(itemOf(p, 'soon1').isSoon, true, '23 小时后到期且未完成 → **算**');
    eq(itemOf(p, 'done1').isSoon, false, '**已完成的截止不算**（做完了还催就是骚扰）');
    eq(itemOf(p, 'far1').isSoon, false, '**25 小时后到期的还算早**（窗口是 24 小时，不含）');
    eq(itemOf(p, 'old1').isSoon, false, '**已经过期很久的不算**（"早该做完了"不是"即将到期"）');

    // ---- 组合数据：刚过期 5 分钟 / 没时刻 / 非 ddl / 非法日期 ----
    block('tasks 页 · 即将到期 —— 边界（刚过期 5 分钟算，缺时刻/非 ddl/非法日期不算）');
    serveTasksOnly([TASK_SOON, TASK_SOON_2, TASK_NO_TIME, TASK_EVENT, TASK_BAD_DATE, TASK_DONE]);
    ctx.tp2 = newPage(tasks);
    ctx.tp2.remindNowMs = NOW_MS;
    return ctx.tp2.loadTasks();
  }).then(function () {
    var p = ctx.tp2;
    eq(itemOf(p, 'soon2').isSoon, true, '刚过期 5 分钟 → **还算**（10 分钟宽限，用户刚打开小程序）');
    eq(itemOf(p, 'notime1').isSoon, false, '缺 end_time → 不算（**不瞎猜 23:59**，与云函数同款取舍）');
    eq(itemOf(p, 'ev1').isSoon, false, '日程（非 ddl）不算：只有截止事项才有"到期"');
    eq(itemOf(p, 'bad1').isSoon, false, '2026-02-30 这种不存在的日期不算（不许让 Date 自动进位）');
    eq(itemOf(p, 'done1').isSoon, false, '已完成不算（同上）');
    eq(p.data.dueSoonCount, 2, '合计 2 条：23 小时后 + 刚过期 5 分钟');
    eq(p.data.dueSoonText, '今天有 2 个截止事项即将到期', '文案里的数字跟着走');

    // ---- 精确边界：正好 24 小时 / 23:59:59 / 正好超宽限 1 分钟 ----
    block('tasks 页 · 即将到期 —— 精确边界（24 小时整**也算**，过期超宽限不算）');
    var MT2 = tasks.__test;
    eq(MT2.TASK_REMIND_WINDOW_MS, 24 * 60 * 60 * 1000, '窗口 = 24 小时');
    eq(MT2.TASK_REMIND_GRACE_MS, 10 * 60 * 1000, '宽限 = 10 分钟（与云函数 GRACE_MS 同值）');
    eq(MT2.BEIJING_OFFSET_MS, 8 * 60 * 60 * 1000, '北京时间偏移 = 8 小时（与云函数同值）');
    var ids24h = MT2.computeDueSoonIds([
      task({ _id: 'a', date: '2026-10-17', end_time: '10:00' }),   // 正好 24 小时
      task({ _id: 'b', date: '2026-10-17', end_time: '09:59' }),   // 23h59m
      task({ _id: 'c', date: '2026-10-16', end_time: '09:50' }),   // 正好过期 10 分钟
      task({ _id: 'd', date: '2026-10-16', end_time: '09:49' })    // 过期 11 分钟
    ], NOW_MS);
    // 【为什么"正好 24 小时"算**在**里面】口径是"24 小时内到期"，`dueAt - now <= 24h`
    // 是闭区间 —— 差一秒到 24 小时和正好 24 小时，用户看到的是同一件事。
    // 写成开区间会在边界上抖：同一件事在前一秒算、后一秒不算。
    eq(ids24h.join(','), 'a,b,c', '正好 24 小时算、23h59m 算、正好过期 10 分钟算、**过期 11 分钟不算**');
    eq(MT2.computeDueSoonIds([], NOW_MS).length, 0, '空列表 → 空结果（不抛异常）');
    eq(MT2.computeDueSoonIds(null, NOW_MS).length, 0, 'null → 空结果（不抛异常）');
    eq(MT2.computeDueSoonIds([TASK_NO_TIME], NOW_MS).length, 0, '缺时刻的任务不会混进来');
    eq(MT2.computeDueSoonIds([task({ _id: 'x', date: '', end_time: '' })], NOW_MS).length, 0,
      '日期与时刻都空 → 不算（"不瞎猜 23:59"，与云函数 dueInstantOf 同一取舍）');
    eq(MT2.computeDueSoonIds([task({ _id: 'y', start_time: '08:00', end_time: '' })], NOW_MS).length, 0,
      '只有 start_time 的 ddl 也不算（截止时刻必须在 end_time，与云函数一致）');
    eq(MT2.dueInstantOf(task({ _id: 'z', date: '2026-10-16', end_time: '24:00' })), null,
      'end_time=24:00（跨天写法）→ 算不出时刻（云函数也是这么拒的）');
    eq(MT2.dueInstantOf(task({ _id: 'z', date: '2026-10-16', end_time: '25:00' })), null,
      'end_time 越界 → null');
    eq(MT2.dueSoonText(0), '', '没有符合项时文案是空串 → WXML 里警示条整条不出现');

    // ---- 没有符合项：警示条不出现 ----
    block('tasks 页 · 即将到期 —— 没有符合项：警示条不出现');
    serveTasksOnly([TASK_25H, TASK_STALE, TASK_DONE]);
    ctx.tp3 = newPage(tasks);
    ctx.tp3.remindNowMs = NOW_MS;
    return ctx.tp3.loadTasks();
  }).then(function () {
    eq(ctx.tp3.data.dueSoonCount, 0, '一条都不符合');
    eq(ctx.tp3.data.dueSoonText, '', '**文案是空串 → 警示条不渲染**（不留一条空条占位置）');
    eq(ctx.tp3.data.taskFilter, 'pending', '默认筛选仍是「进行中」（没被这次改动影响）');
    eq(ctx.tp3.data.filterText, '进行中 · 2 条',
      '「进行中」只数未完成的那些（这一页有 25 小时后 + 过期很久两条未完成）：' + show(ctx.tp3.data.filterText));

    // ---- 点警示条 → 切到「即将到期」筛选 ----
    block('tasks 页 · 即将到期 —— 点警示条切筛选，只留下符合条件的那几条');
    serveTasksOnly([TASK_SOON, TASK_SOON_2, TASK_25H, TASK_DONE, TASK_STALE]);
    ctx.tp4 = newPage(tasks);
    ctx.tp4.remindNowMs = NOW_MS;
    return ctx.tp4.loadTasks();
  }).then(function () {
    var p = ctx.tp4;
    eq(p.data.dueSoonCount, 2, '前置：有 2 条即将到期');
    eq(p.data.taskFilter, 'pending', '前置：默认还是「进行中」');
    eq(p.data.visibleItems.length, 4, '前置：「进行中」下有 4 条（2 条即将到期 + 25 小时 + 过期很久）');
    p.onTapSoonBanner();
    eq(p.data.taskFilter, 'soon', '点了警示条 → 切到「即将到期」筛选');
    eq(p.data.visibleItems.length, 2, '**只剩那 2 条**（这正是"点一下就能看到它们"）');
    eq(p.data.visibleItems[0].id, 'soon1', '列表里第一条是 23 小时后那条');
    eq(p.data.filterText, '即将到期 · 2 条', '筛选行文字跟着变：' + show(p.data.filterText));
    isTrue(p.data.visibleItems.every(function (item) { return item.isSoon === true; }),
      '筛出来的每一条都带 isSoon 标记（列表项据此显示「即将到期」）');
    isTrue(p.data.visibleItems.every(function (item) { return item.done === false; }),
      '已完成的一条都不在（筛选口径里就排除了）');

    // 空态：切到「soon」但没有符合项时，说的是"24 小时内没有要到期的"
    p.applyFilter('soon', true);
    eq(p.data.visibleItems.length, 2, '（这一页确实有 2 条，先确认基线）');
    var emptyPage = newPage(tasks);
    emptyPage.remindNowMs = NOW_MS;
    emptyPage.applyFilter('soon', true);
    eq(emptyPage.data.emptyText, '24 小时内没有要到期的截止事项',
      '「即将到期」的空态文案是专用的（不是"没有进行中的任务"那种误导话）');

    // ---- 勾选完成后立即从不合格里剔除 ----
    block('tasks 页 · 即将到期 —— 勾完成之后不再是"即将到期"');
    serveTasksOnly([TASK_SOON, TASK_DONE]);
    ctx.tp5 = newPage(tasks);
    ctx.tp5.remindNowMs = NOW_MS;
    return ctx.tp5.loadTasks();
  }).then(function () {
    var p = ctx.tp5;
    eq(p.data.dueSoonCount, 1, '前置：1 条即将到期');
    p.applyFilter('soon', true);
    eq(p.data.visibleItems.length, 1, '前置：筛出来 1 条');
    p.onToggleDone({ currentTarget: { dataset: { id: 'soon1' } } });
    return settle(6);
  }).then(function () {
    var p = ctx.tp5;
    eq(itemOf(p, 'soon1').done, true, '勾上了');
    eq(itemOf(p, 'soon1').isSoon, false, '**勾完成后 isSoon 立刻变 false**（不能再把它算进"即将到期"）');
    p.applyFilter('soon', true);
    eq(p.data.visibleItems.length, 0, '「即将到期」里它消失了');
    eq(p.data.emptyText, '24 小时内没有要到期的截止事项', '并且给出正确的空态文案');

    // =====================================================================
    // 12. 三点六 · 一次补齐：点一下连弹到 3 条（用户"不想一个个点"的正解之一）
    // =====================================================================
    block('me 页 · 少点几次 —— 一次补齐：连弹 3 次，每次"允许"各 +1');
    serveRemind({ enabled: true, quota: 1 });
    ctx.top1 = newPage(me);
    ctx.top1.onLoad();
    return settle(6);
  }).then(function () {
    var p = ctx.top1;
    eq(p.data.remindTopUpLabel, '一次补齐 3 次（少点两次）', '没勾过保持选择 → 按钮说的是 3 次');
    eq(subscribed.length, 0, '（基线）读状态不弹授权窗');
    subscribeAnswer = null;                    // 用户在每一个窗里都点「允许」
    p.onRemindTopUpRound();
    return settle(14);
  }).then(function () {
    var p = ctx.top1;
    eq(subscribed.length, 3, '**一次点击弹了 3 次授权窗**（不用来回找同一颗按钮）');
    var acks = callsOf('ack');
    eq(acks.length, 3, '每一次"允许"各上报一次');
    eq(acks[0].data.count, 1, '每处 count 恒为 1（一次授权只能发一条）');
    eq(acks[1].data.count, 1, '第二处也是 1');
    eq(acks[2].data.count, 1, '第三处也是 1');
    eq(p.data.remindQuota, 4, '额度 1 → 4（服务端返回的真值）');
    isTrue(p.data.remindResultText.indexOf('增加 3 次') > -1,
      '结果行如实报数：' + show(p.data.remindResultText));
    isTrue(p.data.remindResultText.indexOf('弹了 3 次窗') > -1,
      '并说明"为什么弹了 3 次"（平台限制那句话不能省）：' + show(p.data.remindResultText));
    eq(p.data.remindTopUpBusy, false, 'busy 要收敛（否则按钮永远置灰）');

    // ---- 中途拒绝：停下 + 如实报数（不许假装 3 条都成了）----
    block('me 页 · 少点几次 —— 一次补齐：第 2 个窗被拒 → 停下并如实报数');
    serveRemind({ enabled: true, quota: 0 });
    ctx.top2 = newPage(me);
    ctx.top2.onLoad();
    return settle(6);
  }).then(function () {
    var p = ctx.top2;
    var seen = 0;
    subscribeAnswer = {
      raw: function (id) {
        seen += 1;
        var res = { errMsg: 'requestSubscribeMessage:ok' };
        res[id] = seen >= 2 ? 'reject' : 'accept';
        return res;
      },
    };
    p.onRemindTopUpRound();
    return settle(14);
  }).then(function () {
    var p = ctx.top2;
    eq(subscribed.length, 2, '**拒绝之后不再弹第 3 个窗**');
    eq(callsOf('ack').length, 1, '只上报了"允许"的那 1 次');
    isTrue(p.data.remindResultText.indexOf('已增加 1 次') > -1,
      '结果行说你补到了 1 次：' + show(p.data.remindResultText));
    isTrue(p.data.remindResultText.indexOf('拒绝') > -1,
      '并说明是因为中间拒绝了：' + show(p.data.remindResultText));
    eq(p.data.remindTopUpBusy, false, 'busy 收敛');
    subscribeAnswer = null;

    // ---- 勾过保持选择：只补 1 次（**不许虚报 3 条**）----
    block('me 页 · 少点几次 —— 勾过保持选择：一次补齐只补 1 次（宁可少攒，不可虚报）');
    serveRemind({ enabled: true, quota: 2 });
    subscribeSetting = { subscriptionsSetting: { mainSwitch: true, itemSettings: { TPL_TEST_1: 'accept' } } };
    ctx.top3 = newPage(me);
    ctx.top3.onLoad();
    return settle(6);
  }).then(function () {
    var p = ctx.top3;
    eq(p.data.remindTopUpLabel, '补充 1 次（不会弹窗）', '按钮文案如实降级（不再是"3 次"）');
    subscribed = [];
    p.onRemindTopUpRound();
    return settle(14);
  }).then(function () {
    var p = ctx.top3;
    eq(subscribed.length, 1, '**只调用一次**（静默那条路没有"逐次同意"的凭据）');
    eq(callsOf('ack').length, 1, '只上报 1 次');
    eq(p.data.remindQuota, 3, '额度只 +1');
    isTrue(p.data.remindResultText.indexOf('没有弹窗') > -1,
      '结果行说明全程没有弹窗：' + show(p.data.remindResultText));

    // =====================================================================
    // 13. 三点六 · 静默补额度：勾过之后，"点别的按钮"就能顺手攒
    // =====================================================================
    block('me 页 · 少点几次 —— 勾过保持选择：点别的按钮时顺手补 1 次（不弹窗、不打扰）');
    serveRemind({ enabled: true, quota: 1, leadMin: 60 });
    subscribeSetting = { subscriptionsSetting: { mainSwitch: true, itemSettings: { TPL_TEST_1: 'accept' } } };
    ctx.sil1 = newPage(me);
    ctx.sil1.onLoad();
    return settle(6);
  }).then(function () {
    var p = ctx.sil1;
    isTrue(p.data.remindSilentAllowed, '读出了"用户勾过保持选择"这个状态');
    isTrue(p.data.remindSilentText.indexOf('已开启自动补充') > -1,
      '文案说明会自动补充：' + show(p.data.remindSilentText));
    eq(subscribed.length, 0, '（基线）读状态本身不调用授权');
    subscribed = [];
    toasts = [];
    // 用户改提前量（一次真实点击）→ 收尾时顺手补一次
    p.onRemindLeadChange({ detail: { value: 1 } });    // 60 → 30 分钟
    return settle(14);
  }).then(function () {
    var p = ctx.sil1;
    eq(subscribed.length, 1, '**点击之后静默调用了一次**');
    eq(callsOf('ack').length, 1, '平台回 accept → 上报 1 次');
    eq(p.data.remindQuota, 2, '额度 +1');
    eq(toasts.length, 1, '**只有"已保存提前量"那一条 toast**，静默补充不额外弹：' + show(toastsText()));
    eq(lastToast(), '已保存提前量', '那条 toast 是这次点击本身的反馈');
    // 节流：10 分钟内再点一次不再调用
    subscribed = [];
    p.onRemindLeadChange({ detail: { value: 2 } });    // 30 → 60 分钟
    return settle(14);
  }).then(function () {
    eq(subscribed.length, 0, '**10 分钟内再点不会重复调用**（节流生效）');
    eq(callsOf('ack').length, 1, '也没有多上报');
    storageMap = {};   // 清掉节流记录，别影响后面的用例

    // ---- 没勾过：一次静默调用都不许发 ----
    block('me 页 · 少点几次 —— 没勾过保持选择：**一次静默调用都不许发**');
    serveRemind({ enabled: true, quota: 1, leadMin: 60 });
    subscribeSetting = { subscriptionsSetting: { mainSwitch: true, itemSettings: {} } };
    ctx.sil2 = newPage(me);
    ctx.sil2.onLoad();
    return settle(6);
  }).then(function () {
    var p = ctx.sil2;
    isFalse(p.data.remindSilentAllowed, '状态：没勾过');
    isTrue(p.data.remindSilentText.indexOf('总是保持以上选择') > -1,
      '文案告诉他怎么才能免打扰：' + show(p.data.remindSilentText));
    eq(p.data.remindTopUpLabel, '一次补齐 3 次（少点两次）', '按钮文案仍是 3 次');
    subscribed = [];
    p.onRemindLeadChange({ detail: { value: 1 } });
    return settle(14);
  }).then(function () {
    eq(subscribed.length, 0,
      '**没勾过 → 一次都不调用**（那时调用会弹窗：用户没点却看到授权窗就是骚扰）');
    eq(callsOf('ack').length, 0, '也没有上报');
    storageMap = {};

    // =====================================================================
    // 14. 三点六 · 授权成功后的引导：告诉他"勾一次以后就不用点"
    // =====================================================================
    block('me 页 · 少点几次 —— 授权成功后教他勾那个框；已经勾过的人不再念');
    serveRemind({ enabled: false, quota: 0 });
    subscribeSetting = { subscriptionsSetting: { mainSwitch: true, itemSettings: {} } };
    ctx.guide1 = newPage(me);
    ctx.guide1.onLoad();
    return settle(6);
  }).then(function () {
    subscribeAnswer = null;
    ctx.guide1.onRemindEnable();
    return settle(10);
  }).then(function () {
    var text = ctx.guide1.data.remindResultText;
    isTrue(text.indexOf('总是保持以上选择') > -1, '**结果行里教他勾那个框**：' + show(text));
    isTrue(text.indexOf('一次性订阅') > -1, '原来那句平台解释还在（没被顶掉）：' + show(text));

    serveRemind({ enabled: true, quota: 1 });
    subscribeSetting = { subscriptionsSetting: { mainSwitch: true, itemSettings: { TPL_TEST_1: 'accept' } } };
    ctx.guide2 = newPage(me);
    ctx.guide2.onLoad();
    return settle(6);
  }).then(function () {
    subscribeAnswer = null;
    ctx.guide2.onRemindEnable();
    return settle(10);
  }).then(function () {
    isFalse(ctx.guide2.data.remindResultText.indexOf('总是保持以上选择') > -1,
      '**已经勾过的人不再念这句**（他本来就做到了）：' + show(ctx.guide2.data.remindResultText));
    isTrue(ctx.guide2.data.remindResultText.indexOf('一次性订阅') > -1,
      '但平台解释照旧保留：' + show(ctx.guide2.data.remindResultText));

    // =====================================================================
    // 15. 三点六 · 写进手机系统日历（真正"全部放开"的那条路）
    // =====================================================================
    block('me 页 · 少点几次 —— 写进手机日历：只写"填了截止时刻的未完成截止事项"');
    serveRemind({
      enabled: true,
      quota: 0,
      tasks: [
        task({ _id: 'c1', title: '交实验报告', date: '2026-10-20', end_time: '23:59' }),
        task({ _id: 'c2', title: '没时刻的', date: '2026-10-21', end_time: '' }),
        task({ _id: 'c3', title: '做完了', date: '2026-10-22', end_time: '10:00', done: true }),
        task({ _id: 'c4', title: '过期了', date: '2026-10-01', end_time: '10:00' }),
        task({ _id: 'c5', title: '一条日程', type: 'event', date: '2026-10-23', start_time: '08:00', end_time: '10:00' }),
      ],
    });
    ctx.cal1 = newPage(me);
    ctx.cal1.onLoad();
    return settle(6);
  }).then(function () {
    var p = ctx.cal1;
    p.remindNowMs = NOW_MS;      // 钉死"现在"（与 tasks 页同一约定），结果与机器日期无关
    calendarCalls = [];
    p.onAddToCalendar();
    return settle(12);
  }).then(function () {
    var p = ctx.cal1;
    eq(calendarCalls.length, 1, '**5 条里只写了 1 条**（只有它既填了时刻、又没完成、又没过期）');
    eq(calendarCalls[0].title, '⏰ 截止：交实验报告', '标题带「⏰ 截止：」前缀（与 .ics 导出同一约定）');
    eq(new Date(calendarCalls[0].startTime * 1000).toISOString(), '2026-10-20T15:59:00.000Z',
      '**截止时刻按北京时间换算正确**（23:59 北京 = 15:59Z）');
    eq(calendarCalls[0].alarmOffset, p.data.remindLeadMin * 60, '提前量用的就是页面上那个提前量');
    isTrue(p.data.remindCalText.indexOf('已写入 1 条') > -1, '结果行报数：' + show(p.data.remindCalText));
    isTrue(p.data.remindCalText.indexOf('没填截止时刻') > -1,
      '并说明"有一条没填时刻、所以没写"：' + show(p.data.remindCalText));
    isTrue(p.data.remindCalText.indexOf('过期') > -1, '以及"有一条已过期"：' + show(p.data.remindCalText));
    eq(p.data.remindCalBusy, false, 'busy 收敛');
    var written = storageMap['remind_calendar_written'] || [];
    eq(written.length, 1, '把写成功的那条记进了防重复名单：' + show(written));

    // ---- 点第二次：不写第二份 ----
    block('me 页 · 少点几次 —— 写进手机日历：点第二次不会在日历里写第二份');
    calendarCalls = [];
    ctx.cal1.onAddToCalendar();
    return settle(12);
  }).then(function () {
    eq(calendarCalls.length, 0, '**第二次点击一条都不写**（日历里不会出现重复条目）');
    isTrue(ctx.cal1.data.remindCalText.indexOf('没有可以写进日历') > -1,
      '结果行说清"这次没有可写的"：' + show(ctx.cal1.data.remindCalText));
    isTrue(ctx.cal1.data.remindCalText.indexOf('之前已经写过') > -1,
      '并指出原因：之前写过');

    // ---- 一条都写不了：必须说清为什么 ----
    block('me 页 · 少点几次 —— 写进手机日历：一条都写不了时说清"为什么"');
    serveRemind({
      enabled: false,
      quota: 0,
      tasks: [task({ _id: 'n1', title: '没时刻', date: '2026-10-21', end_time: '' })],
    });
    ctx.cal2 = newPage(me);
    ctx.cal2.onLoad();
    return settle(6);
  }).then(function () {
    var p = ctx.cal2;
    p.remindNowMs = NOW_MS;
    calendarCalls = [];
    toasts = [];
    p.onAddToCalendar();
    return settle(12);
  }).then(function () {
    eq(calendarCalls.length, 0, '没有可写的 → 一次都不调用');
    isTrue(ctx.cal2.data.remindCalText.indexOf('没填截止时刻') > -1,
      '**把"为什么写不了"说清楚**（只说"失败"用户会以为按钮坏了）：' + show(ctx.cal2.data.remindCalText));
    isTrue(lastToast().indexOf('没有可写入') > -1, '也给一句短 toast：' + show(toastsText()));

    // ---- 基础库太低：明说，不静默 ----
    block('me 页 · 少点几次 —— 写进手机日历：基础库太低 → 明说需要什么版本');
    serveRemind({
      enabled: false,
      quota: 0,
      tasks: [task({ _id: 'c9', date: '2026-10-20', end_time: '23:59' })],
    });
    calendarSupported = false;    // canIUse('addPhoneCalendar') 返回 false
    ctx.cal3 = newPage(me);
    ctx.cal3.onLoad();
    return settle(6);
  }).then(function () {
    var p = ctx.cal3;
    calendarCalls = [];
    toasts = [];
    p.onAddToCalendar();
    return settle(4);
  }).then(function () {
    eq(calendarCalls.length, 0, '不支持 → 一次都不调用（不硬碰）');
    isTrue(ctx.cal3.data.remindCalText.indexOf('基础库') > -1,
      '说明需要的基础库版本：' + show(ctx.cal3.data.remindCalText));
    isTrue(lastToast().indexOf('微信版本') > -1, '也给一句 toast：' + show(toastsText()));
    calendarSupported = true;

    // ---- 授权被拒：指向"设置 → 授权管理"，且不记进防重复名单 ----
    block('me 页 · 少点几次 —— 写进手机日历：第一条就失败 → 立刻停 + 指出是权限问题');
    serveRemind({
      enabled: false,
      quota: 0,
      tasks: [
        task({ _id: 'd1', title: '甲', date: '2026-10-20', end_time: '23:59' }),
        task({ _id: 'd2', title: '乙', date: '2026-10-21', end_time: '23:59' }),
      ],
    });
    ctx.cal4 = newPage(me);
    ctx.cal4.onLoad();
    return settle(6);
  }).then(function () {
    var p = ctx.cal4;
    p.remindNowMs = NOW_MS;
    calendarCalls = [];
    calendarFailsAt = 0;          // 第一条就失败（模拟没允许「添加到日历」）
    p.onAddToCalendar();
    return settle(12);
  }).then(function () {
    var p = ctx.cal4;
    eq(calendarCalls.length, 1, '**第一条失败就停**（后面几条必然同样失败，不必连着弹）');
    isTrue(p.data.remindCalText.indexOf('授权管理') > -1,
      '指向"设置 → 授权管理"：' + show(p.data.remindCalText));
    var written = storageMap['remind_calendar_written'] || [];
    isFalse(written.some(function (key) { return key.indexOf('d1@') === 0; }),
      '**失败的那条没有被记进防重复名单**（下次还会再试）：' + show(written));
    calendarFailsAt = -1;

    // =====================================================================
    // 11. 静态自检（源码层面的红线）
    // =====================================================================
    block('remind 前端 —— 静态自检（不硬编码模板 ID / 不读错层级 / 不用对象展开）');
    var meSrc = fs.readFileSync(path.join(ROOT, 'pages', 'me', 'me.js'), 'utf8');
    var tasksSrc = fs.readFileSync(path.join(ROOT, 'pages', 'tasks', 'tasks.js'), 'utf8');
    var meWxml = fs.readFileSync(path.join(ROOT, 'pages', 'me', 'me.wxml'), 'utf8');

    // ① 模板 ID 一律来自 status；源码里不许出现真的模板 ID（形如 'Xk3nJ8…' 那种一长串）
    isTrue(meSrc.indexOf('remindTemplateId') > -1,
      '模板 ID 只从 status 取（源码里存成 this.remindTemplateId）');
    var hardCoded = meSrc.match(/template_id\s*[:=]\s*['"][A-Za-z0-9_-]{10,}['"]/g);
    eq(hardCoded, null, '**没有任何硬编码的模板 ID**（换模板只该改云函数环境变量）'
      + (hardCoded ? '，实际命中：' + show(hardCoded) : ''));

    // ② 两层 ok：判失败时不许只判外层
    isTrue(meSrc.indexOf('result.data.ok !== true') > -1,
      'me 页显式判了**内层** ok（data.ok）—— 只判外层会把失败当成功');
    isTrue(meSrc.indexOf('result.ok !== true') > -1, '外层 ok 也判了');

    // ③ ack 的 count 恒为 1：**调用处**的实参只能是 1。
    //    【为什么要从函数定义之后再找】源码里有两处 `remindAck(`：
    //      * 顶上的文档注释里举例写了 `function remindAck(count) {...}`；
    //      * 下面真正的函数定义。
    //    从**最后一处**定义之后开始找，剩下的才都是调用点（这里是 ackRemindAuthorized）。
    var ackDefIndex = meSrc.lastIndexOf('function remindAck(');
    isTrue(ackDefIndex > -1, '找得到 remindAck 的定义（否则这条静态检查是空转）');
    var ackCallPart = ackDefIndex === -1 ? '' : meSrc.slice(ackDefIndex);
    var ackArgs = ackCallPart.match(/remindAck\(([^)]*)\)/g) || [];
    // 第一处是定义本身（形参 count），它后面必须全是 remindAck(1)
    ackArgs.shift();
    isTrue(ackArgs.length >= 1, '至少有一处真的在调 remindAck（实际：' + show(ackArgs) + '）');
    var badAck = ackArgs.filter(function (text) { return text !== 'remindAck(1)'; });
    eq(badAck.join(','), '', '**每处调用都是 remindAck(1)**（一次授权只能发一条，报多了等于骗服务端）'
      + (badAck.length ? '，实际：' + show(badAck) : ''));

    // ④ 不许对象展开（小程序基础库对 ES6 展开的支持取决于构建工具版本，api.js 里也这么写）
    isFalse(/\.\.\.payload/.test(meSrc), 'me 页没有对 payload 用对象展开（改用 Object.assign）');
    isFalse(/return\s+callCloudFunction\([^)]*\{\s*\.\.\./.test(meSrc), '也没有展开进报文');

    // ⑤ 提醒相关的调用都发给 remind（不是 tasks 的 action）
    isTrue(/REMIND_FUNCTION\s*=\s*'remind'/.test(meSrc), '云函数名常量是 remind');
    isFalse(/api\.call\('(status|ack|config|test)'/.test(meSrc),
      'remind 的几个 action **没有被误当成 tasks 的 action**（那会以"未知 action"失败）');
    isTrue(tasksSrc.indexOf('remind') === -1 || /不依赖/.test(tasksSrc),
      'tasks 页不调用 remind（降级提示是纯前端的，源码里连这个名字都不该出现）');

    // ⑤ b. silent 的分工：进页面读一次要静默，**用户主动点出来的动作绝不许静默**
    //      （api.js 文件头那条红线：点了按钮就必须有反馈）
    //      【为什么要夹出"提醒段"再查】me.js 里别处（AI 设置）也在用 silent，
    //      整篇搜会把别人的用法算进来，这条检查就失效了。
    //      【起点要取**第二处**"三点五、到期提醒"】data 里也有一行同名的分组注释
    //      （`// --- 三点五、到期提醒 …`），它排在真正的方法实现之前，而且离实现很近，
    //      拿它当起点比猜方法签名稳（loadRemindStatus 的形参以后改一下都不会影响它）。
    var firstMark = meSrc.indexOf('三点五、到期提醒');
    var remindStart = meSrc.indexOf('三点五、到期提醒', firstMark + 1);
    var remindEnd = meSrc.indexOf('四、导入课表', remindStart);
    var remindSection = (remindStart > -1 && remindEnd > remindStart)
      ? meSrc.slice(remindStart, remindEnd) : '';
    isTrue(remindSection.length > 3000, '截出了提醒那一整段源码（否则下面几条是空转）');
    // 【正向：静默读取确实在用】进页面那次读必须走 silent（`loadRemindStatus({ silent: true })`），
    // 同时收尾刷新必须**允许**被显式要求不静默（`options.silent === false`）——
    // 这是"哪天需要在用户点击后刷新并让他看见失败"时的抓手。
    isTrue(remindSection.indexOf('loadRemindStatus({ silent: true })') > -1,
      '进页面那次读状态明确用 silent（失败只写灰字，不弹 toast）');
    isTrue(remindSection.indexOf('options.silent === false') > -1,
      'silent 的判定认显式的 false 值（收尾刷新可以要求"不许静默"）');
    // 【反向：三个用户主动发起的动作都不许静默】这三条才是真正的红线。
    isFalse(/remindAck\(1\)\.then\([^)]*silent/.test(remindSection),
      'ack（用户刚点过授权）这一路没有用 silent —— 上报失败必须让用户看见');
    isFalse(/remindTest\(\)\.then\([^)]*silent/.test(remindSection),
      'test（用户主动点的）也没有用 silent');
    isFalse(/remindConfig\([^)]*\)\.then\([^)]*silent/.test(remindSection),
      'config（用户改的提前量）也没有用 silent');
    isTrue(/remindAck\(1\)\.then\(/.test(remindSection), '（确认上面那条 ack 的检查不是空转）');
    isTrue(/remindTest\(\)\.then\(/.test(remindSection), '（确认上面那条 test 的检查不是空转）');
    isTrue(/remindConfig\(\{ lead_min/.test(remindSection), '（确认上面那条 config 的检查不是空转）');

    // ⑥ WXML 里三个关键交互都接对了方法名，且平台限制的解释真的在页面上
    isTrue(meWxml.indexOf('bindtap="onRemindEnable"') > -1, '开启按钮接的是 onRemindEnable');
    isTrue(meWxml.indexOf('bindtap="onRemindTest"') > -1, '测试按钮接的是 onRemindTest');
    isTrue(meWxml.indexOf('bindchange="onRemindLeadChange"') > -1, '提前量 picker 接的是 onRemindLeadChange');
    isTrue(meWxml.indexOf('授权一次只能收到一条提醒') > -1,
      '**页面上真的写了"授权一次只能收到一条提醒"**（不解释用户会以为功能坏了）');
    isTrue(meWxml.indexOf('{{remindReadyReason}}') > -1, 'ready_reason 被渲染出来了（服务端那句人话）');
    isTrue(meWxml.indexOf('{{remindQuotaText}}') > -1, '剩余次数被渲染出来了');

    // ⑦ 三点六的三条路都真的接在页面上（少任何一条，用户又得一个个点）
    isTrue(meWxml.indexOf('bindtap="onRemindTopUpRound"') > -1, '「一次补齐」按钮接的是 onRemindTopUpRound');
    isTrue(meWxml.indexOf('bindtap="onAddToCalendar"') > -1, '「写进手机日历」按钮接的是 onAddToCalendar');
    isTrue(meWxml.indexOf('remindTopUpLabel') > -1,
      '按钮文案跟着状态走（静默时不许还写着"3 次"）');
    isTrue(meWxml.indexOf('{{remindSilentText}}') > -1, '免打扰状态那行真的渲染出来了');
    isTrue(meWxml.indexOf('不消耗微信提醒次数') > -1, '写日历那条路明说了"不消耗额度"');
    isTrue(meSrc.indexOf('总是保持以上选择') > -1, '文案里明说了那个勾选框（免打扰的唯一开关）');
    isTrue(meSrc.indexOf('this.maybeSilentTopUp()') > -1, '点击顺手补额度真的被接上了');
    isFalse(meSrc.indexOf('withSubscriptions') > -1,
      'me 页**不自己**直接调 getSetting（走 utils/subscribe.js，那边带着 withSubscriptions）');

    // ⑧ 新模块那几条红线必须仍然写在源码里（有人"顺手删掉"这里就会红）
    var subSrc = fs.readFileSync(path.join(ROOT, 'utils', 'subscribe.js'), 'utf8');
    isTrue(subSrc.indexOf('canSilentTopUp(setting, tmplId)') > -1,
      '静默补额度之前必须过 canSilentTopUp 这道闸');
    isTrue(subSrc.indexOf('maxTimesForRound') > -1, '一次补齐的条数由 maxTimesForRound 决定');
    isTrue(subSrc.indexOf('addPhoneCalendar') > -1, '写系统日历走 wx.addPhoneCalendar');
    isTrue(subSrc.indexOf("toStr(task.type) !== 'ddl'") > -1,
      '写日历那条路只认 ddl（与云函数 dueInstantOf 同一判据）');

    // ⑨ 三点七：把"扫描"这件事做进页面 —— 不靠触发器、不靠日志也能自查
    //    （定时触发器在云端没建起来时，"提醒不响"原本在界面上完全看不出来）
    isTrue(meSrc.indexOf("action: 'scan'") > -1,
      '前端能调 action:scan（与定时触发器同一个入口，见 remindScan 的说明）');
    isTrue(meSrc.indexOf('maybeLazyScan') > -1, '进页面会顺手扫一次（触发器没建时的兜底）');
    isTrue(meSrc.indexOf('LAZY_SCAN_GAP_MS') > -1, '顺手扫描有节流常量（不许每次打开都打服务端）');
    isTrue(meSrc.indexOf('SCAN_REASON_TEXT') > -1, '跳过原因码有中文翻译表（no_due_instant 之类不能直接给人看）');
    isTrue(meWxml.indexOf('bindtap="onRemindSelfCheck"') > -1,
      '**「检查一次」按钮真的接在页面上了**（onRemindSelfCheck）');
    isTrue(meWxml.indexOf('{{remindSelfCheckText}}') > -1, '自查结果行渲染出来了');
    isFalse(/remindScan\(\)\.then\([^;]*silent/.test(meSrc), '（确认下面这条不是空转）');
    isTrue(/remindScan\(\)\.then\(/.test(meSrc), '扫描调用是通过 remindScan() 发的');
    return null;
  })

  // =====================================================================
  // 16. 三点七 · 「检查一次」：扫描返回值 → 人话（纯函数）
  // =====================================================================
  .then(function () {
    block('me 页 · 检查一次 —— 扫描结果必须翻译成"为什么没收到提醒"');
    var T = me.__test;
    isTrue(!!T && typeof T.selfCheckText === 'function',
      '取到 selfCheckText（拿不到的话下面几条全是空转）');

    // ① 一个用户都没扫到 —— 这是"开关其实没打开"，与"没有到期事项"完全不是一回事
    var t1 = T.selfCheckText({ scanned: 0, sent: 0, skipped: 0, failed: 0 });
    isTrue(t1.indexOf('扫描了 0 个用户') > -1, '扫到 0 人要如实说 0 个用户：' + show(t1));
    isTrue(t1.indexOf('开关') > -1,
      '**并且指出根因是开关没打开**（不能写成"没有需要提醒的事项"——那会把用户带偏）：' + show(t1));

    // ② 真发出去了
    var t2 = T.selfCheckText({ scanned: 1, sent: 2, skipped: 0, failed: 0 });
    isTrue(t2.indexOf('刚发出 2 条') > -1, '发出去几条要说清：' + show(t2));
    isTrue(t2.indexOf('服务通知') > -1, '并告诉他去微信「服务通知」看：' + show(t2));

    // ③ 发送失败：原始错误码要原样带上（不翻译成猜的语义），并说明不白扣额度
    var t3 = T.selfCheckText({
      scanned: 1, sent: 0, skipped: 0, failed: 1,
      errors: ['用户 ab 处理失败：47003 thing2 长度不合法'],
    });
    isTrue(t3.indexOf('发送失败') > -1, '失败要说"发送失败"：' + show(t3));
    isTrue(t3.indexOf('47003 thing2 长度不合法') > -1,
      '**服务端原话原样带上**（换成自己的说法就查不下去了）：' + show(t3));
    isTrue(t3.indexOf('额度') > -1, '并说清配置类失败会退额度：' + show(t3));

    // ④ 全被跳过：原因码要翻译成人话
    var t4 = T.selfCheckText({
      scanned: 1, sent: 0, skipped: 2, failed: 0,
      skipped_reasons: { no_due_instant: 2 },
    });
    isTrue(t4.indexOf('截止没填时刻 2 条') > -1,
      '**跳过原因翻译成人话**（这正是用户最常踩的那条）：' + show(t4));

    var t5 = T.selfCheckText({
      scanned: 1, sent: 0, skipped: 2, failed: 0,
      skipped_reasons: { too_early: 1, mystery_reason: 1 },
    });
    isTrue(t5.indexOf('还没到提前量窗口 1 条') > -1, '常见原因有中文说法：' + show(t5));
    isTrue(t5.indexOf('mystery_reason 1 条') > -1,
      '**认不出的原因码原样带上**（不吞掉、也不编一个说法）：' + show(t5));

    // ⑤ 什么都没发生
    var t6 = T.selfCheckText({ scanned: 1, sent: 0, skipped: 0, failed: 0, lead_min: 60 });
    isTrue(t6.indexOf('没有找到需要提醒的事项') > -1, '没事情也要给结论：' + show(t6));
    isTrue(t6.indexOf('提前量 60 分钟') > -1,
      '并带上当前提前量（"太早了"是最常见的误会）：' + show(t6));
    return null;
  })

  // =====================================================================
  // 17. 点「检查一次」：真的发 scan，结果落在卡片上
  // =====================================================================
  .then(function () {
    block('me 页 · 检查一次 —— 点一下就替服务端扫一遍');
    storageMap = {};
    serveRemind({
      enabled: true,
      quota: 3,
      scanResult: {
        scanned: 1, sent: 0, skipped: 1, failed: 0,
        skipped_reasons: { no_due_instant: 1 },
        errors: [], warnings: [], details: [], lead_min: 60,
      },
    });
    ctx.check1 = newPage(me);
    toasts = [];
    ctx.check1.onLoad();
    return settle(12);
  })
  .then(function () {
    var p = ctx.check1;
    eq(callsOf('scan').length, 1, '进页面顺手扫了一次（三点七的懒扫描）');
    eq(p.data.remindSelfCheckText, '', '**什么都没发出去 → 不打扰用户**（不写结果行）');

    toasts = [];
    p.onRemindSelfCheck();
    return settle(16);
  })
  .then(function () {
    var p = ctx.check1;
    eq(callsOf('scan').length, 2, '点「检查一次」再扫一次');
    isTrue(p.data.remindSelfCheckText.indexOf('截止没填时刻 1 条') > -1,
      '**结果行说出了真正的原因**：' + show(p.data.remindSelfCheckText));
    eq(p.data.remindSelfCheckType, 'warn', '没发出东西 → warn 样式（不是成功绿）');
    eq(lastToast(), '检查完成，结果见下方',
      'toast 只说"做完了"，结论在卡片上：' + show(toastsText()));

    // 真发出去一条：口径换成"补发了几条"，并且额度要重读
    storageMap = { remind_scan_at: Date.now() };   // 压掉懒扫描，只留按钮这一下
    serveRemind({
      enabled: true,
      quota: 3,
      scanResult: {
        scanned: 1, sent: 1, skipped: 0, failed: 0,
        skipped_reasons: {}, errors: [], warnings: [], details: [], lead_min: 60,
      },
    });
    ctx.check2 = newPage(me);
    toasts = [];
    ctx.check2.onLoad();
    return settle(12);
  })
  .then(function () {
    var p = ctx.check2;
    eq(callsOf('scan').length, 0, '（节流生效：进页面这次没扫）');
    // 跨 .then 一律挂 ctx：每个 .then 是独立函数作用域，var 传不过去（这里踩过一次）
    ctx.statusBefore = callsOf('status').length;
    toasts = [];
    p.onRemindSelfCheck();
    return settle(16);
  })
  .then(function () {
    var p = ctx.check2;
    isTrue(p.data.remindSelfCheckText.indexOf('刚发出 1 条') > -1,
      '发出去了就说发出去了：' + show(p.data.remindSelfCheckText));
    eq(p.data.remindSelfCheckType, 'ok', '这种情况用 ok 样式');
    eq(lastToast(), '补发了 1 条提醒', 'toast 报条数：' + show(toastsText()));
    isTrue(callsOf('status').length >= ctx.statusBefore + 1,
      '**收尾必须重读状态**（额度变了，卡片上的数字不能是旧的）');
    eq(p.data.remindQuota, 2, '额度按"真发出去 1 条"更新了');

    // 扫描自己失败：如实说，不许假装"检查完了没问题"
    storageMap = { remind_scan_at: Date.now() };
    serveRemind({ enabled: true, quota: 3, scanFails: true });
    ctx.check3 = newPage(me);
    ctx.check3.onLoad();
    return settle(12);
  })
  .then(function () {
    toasts = [];
    ctx.check3.onRemindSelfCheck();
    return settle(16);
  })
  .then(function () {
    var p = ctx.check3;
    isTrue(p.data.remindSelfCheckText.indexOf('检查失败') > -1,
      '失败要写"检查失败"：' + show(p.data.remindSelfCheckText));
    isTrue(p.data.remindSelfCheckText.indexOf('数据库不可用') > -1,
      '并带上服务端原话：' + show(p.data.remindSelfCheckText));
    eq(p.data.remindSelfCheckType, 'warn', 'warn 样式');
    return null;
  })

  // =====================================================================
  // 18. 懒扫描的三道闸：节流 / 没开提醒 / 存储不可用
  // =====================================================================
  .then(function () {
    block('me 页 · 懒扫描 —— 10 分钟一次；没开提醒不扫；读不到节流记录也不扫');
    storageMap = {};
    serveRemind({ enabled: true, quota: 2 });
    toasts = [];
    ctx.lazy1 = newPage(me);
    ctx.lazy1.onLoad();
    return settle(12);
  })
  .then(function () {
    eq(callsOf('scan').length, 1, '开了提醒 → 进页面扫一次');
    eq(toasts.filter(function (t) { return t.indexOf('提醒') > -1; }).length, 0,
      '**什么都没发出去 → 一声不吭**（不该冒"补发了 0 条"）：' + show(toastsText()));
    isTrue(Number(storageMap['remind_scan_at']) > 0, '记下了这次扫描的时间（节流用）');

    cloudCalls = [];
    ctx.lazy1.loadAll();
    return settle(12);
  })
  .then(function () {
    eq(callsOf('scan').length, 0,
      '**10 分钟内再进页面不重复扫**（否则每次打开都打服务端，额度也扛不住）');

    // 没开提醒：一次都不扫（扫了也发不出去）
    storageMap = {};
    serveRemind({ enabled: false, quota: 0 });
    ctx.lazy2 = newPage(me);
    ctx.lazy2.onLoad();
    return settle(12);
  })
  .then(function () {
    eq(callsOf('scan').length, 0, '**没开提醒就不扫**');

    // 存储不可用：fail-closed —— 读不到就"不知道上次什么时候扫的"，此时不许扫
    storageMap = {};
    serveRemind({ enabled: true, quota: 2 });
    ctx.savedGetStorage = global.wx.getStorageSync;
    global.wx.getStorageSync = function () { throw new Error('storage broken'); };
    ctx.lazy3 = newPage(me);
    ctx.lazy3.onLoad();
    return settle(12);
  })
  .then(function () {
    eq(callsOf('scan').length, 0,
      '**读不到节流记录就不扫**（宁可少扫一次，也不能让"每次打开都扫"悄悄没有上限）');
    global.wx.getStorageSync = ctx.savedGetStorage;   // 把桩还回去，不影响后续用例
    return null;
  });
}

/**
 * 从 tasks 页当前**全部**条目里按 id 取一条（找不到就返回带 MISSING 标记的对象，
 * 断言会给出清楚的失败信息）。
 *
 * 【为什么查 allItems 而不是 visibleItems】默认筛选是「进行中」，已完成的条目
 * **不在** visibleItems 里 —— 而要断言的恰恰包括"已完成的那条不算即将到期"，
 * 所以必须能看到全量列表。
 */
function itemOf(page, id) {
  var list = page.allItems || page.data.allItems || page.data.visibleItems || [];
  for (var i = 0; i < list.length; i += 1) {
    if (list[i].id === id) return list[i];
  }
  return { id: '(缺失:' + id + ')', isSoon: 'MISSING', done: 'MISSING' };
}

// ---------------------------------------------------------------------------
// 导出给 run.js 串行调用；单独跑时自己收尾
// ---------------------------------------------------------------------------
var done = Promise.resolve()
  .then(run)
  .then(function () {
    restoreGlobals();   // 用例跑完把全局还回去，不影响后面的测试文件
    if (require.main === module) H.report('pages/me 到期提醒卡片 + pages/tasks 即将到期降级提示');
  })
  .catch(function (err) {
    restoreGlobals();
    console.error('到期提醒前端测试自己崩了：', err);
    process.exit(2);
  });

module.exports = { done: done };
