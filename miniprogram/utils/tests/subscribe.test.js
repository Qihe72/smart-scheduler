/**
 * utils/tests/subscribe.test.js —— 订阅授权的"少点几次" + 写进手机系统日历（utils/subscribe.js）。
 *
 * 跑法：
 *     node utils/tests/subscribe.test.js   # 只跑这一份（末尾打印通过数，失败退出码 1）
 *     node utils/tests/run.js              # 跑全部（注册那一行在 run.js 的串行链里）
 *
 * ===========================================================================
 * 【这一份钉住的是什么】用户的原话："为什么日程提醒要自己一个个手动申请啊，能不能全部放开"
 * ===========================================================================
 * 平台规则改不了（一次性订阅 = 授权一次只能发一条、授权窗必须由点击触发、长期订阅要类目），
 * 所以这个模块的每一行都是在规则的缝里找空间。缝里的东西最容易越界，于是下面每条红线都钉死：
 *
 *   1. **没勾「总是保持以上选择」时，一次静默调用都不许发** —— 那时候 requestSubscribeMessage
 *      会**弹窗**，用户没点按钮却看到授权窗，就是骚扰（这是本次改动最大的风险点）；
 *   2. **静默那条路一轮只补 1 条** —— 弹窗时有"用户点了几次允许"作凭据，静默时没有。
 *      宁可少攒、不可虚报：虚报的额度下发时必然 43101 失败，等于把用户的提醒玩坏；
 *   3. **只有平台回答 accept 才允许上报**；reject / ban / fail 一律不 ack；
 *   4. **节流要真的挡住**（10 分钟内不重复调用），读不到缓存时**保守地不补**；
 *   5. **写日历的口径必须与微信提醒那条通道一致**：缺 end_time 的 DDL 两边都不处理
 *      （"不瞎猜 23:59" 是云函数 dueInstantOf 的既定取舍，见 remind_page.test.js:802/829）；
 *   6. **events 与 keys 必须一一对应** —— 两个数组各自排序一旦错位，
 *      "写成功的键"和"真写进去的事件"就对不上，防重复名单会静默失效。
 *
 * 【不做的事】不 require utils/api.js（本模块不碰网络，ack 是回调注入的）；
 * 不联网；不用 child_process。
 */

'use strict';

var path = require('path');
var H = require(path.join(__dirname, 'harness.js'));
var S = require(path.join(__dirname, '..', 'subscribe.js'));

var eq = H.eq;
var isTrue = H.isTrue;
var isFalse = H.isFalse;
var block = H.block;
var show = H.show;

/** 固定的"现在"：2026-10-15 18:00 北京时间（用例不依赖真实时钟） */
var NOW = Date.UTC(2026, 9, 15, 10, 0, 0);
var TPL = 'TPL_TEST_1';
var TPL2 = 'TPL_TEST_2';

// ---------------------------------------------------------------------------
// wx 桩
// ---------------------------------------------------------------------------
// 【加载期不许动全局】照 remind_page.test.js 的规矩：顶层只保存/恢复，替换发生在 run() 里。
var savedWx = global.wx;

/**
 * 造一个 wx 桩。
 *
 * @param {object} [options]
 *   itemSettings   传给 getSetting 的订阅设置；键是模板 ID，值是 accept/reject/ban
 *                  **不传 = 连 subscriptionsSetting 都不给**（老客户端/工具里就是这样）
 *   mainSwitch     false = 主开关被关掉
 *   noGetSetting   true = 环境里没有 getSetting
 *   getSettingFails true = getSetting 走 fail 回调
 *   noStorage      true = 没有 getStorageSync / setStorageSync
 *   storage        初始缓存内容
 *   answer         'accept'（默认）| 'reject' | 'ban' | 'unknown' | 'fail'
 *   failError      answer='fail' 时的错误对象
 *   noSubscribe    true = 环境里没有 requestSubscribeMessage
 *   noCalendar     true = 环境里没有 addPhoneCalendar
 *   canIUseCal     false = canIUse('addPhoneCalendar') 返回 false
 *   calendarFails  函数 (index) => true 表示第 index 次写日历要失败（从 0 数）
 *   calendarError  写日历失败时的 errMsg
 */
function makeStub(options) {
  var o = options || {};
  var storage = {};
  Object.keys(o.storage || {}).forEach(function (key) { storage[key] = o.storage[key]; });
  var calls = { getSetting: 0, subscribe: [], calendar: [], storageWrites: [], withSubscriptions: [] };
  var calendarIndex = 0;

  var stub = {
    calls: calls,
    __storage: storage,

    getSetting: function (opts) {
      var hasSubscriptions = !!(opts && opts.withSubscriptions === true);
      calls.getSetting += 1;
      calls.withSubscriptions.push(hasSubscriptions);
      if (!hasSubscriptions) {
        // 【必须带这个开关】不带就查不到订阅状态，本模块的所有判定都会退化 —— 直接报错，
        // 免得哪天有人"顺手"去掉了它而测试还是绿的。
        throw new Error('getSetting 必须带 withSubscriptions:true');
      }
      if (o.getSettingFails) {
        if (opts && opts.fail) opts.fail({ errMsg: 'getSetting:fail 系统错误' });
        return;
      }
      var res = { errMsg: 'getSetting:ok' };
      if (o.itemSettings !== undefined) {
        res.subscriptionsSetting = {
          mainSwitch: o.mainSwitch !== false,
          itemSettings: o.itemSettings,
        };
      }
      if (opts && opts.success) opts.success(res);
    },

    requestSubscribeMessage: function (opts) {
      calls.subscribe.push(opts);
      var answer = o.answer === undefined ? 'accept' : o.answer;
      if (answer === 'fail') {
        if (opts && opts.fail) opts.fail(o.failError || { errCode: 10005, errMsg: 'requestSubscribeMessage:fail 无法展示' });
        return;
      }
      var res = { errMsg: 'requestSubscribeMessage:ok' };
      var ids = (opts && opts.tmplIds) || [];
      ids.forEach(function (id) { res[id] = answer === 'unknown' ? '' : answer; });
      if (opts && opts.success) opts.success(res);
    },

    canIUse: function (name) {
      if (name === 'addPhoneCalendar') return o.canIUseCal !== false;
      return true;
    },

    addPhoneCalendar: function (opts) {
      var index = calendarIndex;
      calendarIndex += 1;
      calls.calendar.push(opts);
      var shouldFail = typeof o.calendarFails === 'function' ? o.calendarFails(index) : false;
      if (shouldFail) {
        if (opts && opts.fail) opts.fail({ errMsg: o.calendarError || 'addPhoneCalendar:fail auth deny' });
        return;
      }
      if (opts && opts.success) opts.success({ errMsg: 'addPhoneCalendar:ok' });
    },
  };

  if (!o.noStorage) {
    stub.getStorageSync = function (key) {
      return storage[key] === undefined ? '' : storage[key];   // 与真机一致：没有的键返回空串
    };
    stub.setStorageSync = function (key, value) {
      storage[key] = value;
      calls.storageWrites.push(key);
    };
  }
  if (o.noGetSetting) delete stub.getSetting;
  if (o.noSubscribe) delete stub.requestSubscribeMessage;
  if (o.noCalendar) delete stub.addPhoneCalendar;

  return stub;
}

function install(stub) {
  if (stub === null) delete global.wx; else global.wx = stub;
}

function restoreGlobals() {
  if (savedWx === undefined) delete global.wx; else global.wx = savedWx;
}

/** 一个只在内存里记账的 ack（模拟页面注入的上报通道） */
function makeAck(options) {
  var o = options || {};
  var state = { calls: 0 };
  state.fn = function () {
    state.calls += 1;
    if (o.fails) return Promise.reject(new Error('服务异常：数据库不可用'));
    return Promise.resolve({ ok: true });
  };
  return state;
}

// ---------------------------------------------------------------------------
// 一、订阅设置：归一化 + 「能不能静默补」的判定
// ---------------------------------------------------------------------------
function testSettingJudgement() {
  block('一、订阅设置：归一化 + 能不能静默补（红线 1 的入口）');

  // ---- normalizeSubscribeSetting：脏数据不许把判定带偏 ----
  var full = S.normalizeSubscribeSetting({
    subscriptionsSetting: { mainSwitch: true, itemSettings: { a: 'accept' } },
  });
  isTrue(full.ok, '正常结构 → ok:true');
  isTrue(full.mainSwitch, 'mainSwitch:true 原样带出');
  eq(full.itemSettings.a, 'accept', 'itemSettings 原样带出');

  var empty = S.normalizeSubscribeSetting(undefined);
  isTrue(empty.ok, 'undefined → 也是一个合法结果（不抛异常）');
  eq(Object.keys(empty.itemSettings).length, 0, '没有 subscriptionsSetting → itemSettings 是空对象');
  isTrue(empty.mainSwitch, 'mainSwitch 缺省视为开着（拿不到不代表用户关了）');

  var noSwitch = S.normalizeSubscribeSetting({ subscriptionsSetting: { mainSwitch: false } });
  isFalse(noSwitch.mainSwitch, 'mainSwitch:false 如实带出');

  var arrayItems = S.normalizeSubscribeSetting({ subscriptionsSetting: { itemSettings: ['accept'] } });
  eq(Object.keys(arrayItems.itemSettings).length, 0, '**itemSettings 是数组时按空处理**（不能把下标当模板 ID）');

  var stringItems = S.normalizeSubscribeSetting({ subscriptionsSetting: { itemSettings: 'accept' } });
  eq(Object.keys(stringItems.itemSettings).length, 0, 'itemSettings 是字符串时按空处理');

  // ---- canSilentTopUp：只有"设置页里这个模板 = accept"才放行 ----
  var setting = S.normalizeSubscribeSetting({
    subscriptionsSetting: { mainSwitch: true, itemSettings: { TPL_TEST_1: 'accept', TPL_TEST_2: 'reject' } },
  });
  isTrue(S.canSilentTopUp(setting, TPL), '勾过「保持选择」的那个模板 → 可以静默补');
  isFalse(S.canSilentTopUp(setting, TPL2), '**同一个设置里 reject 的模板不许静默补**');
  isFalse(S.canSilentTopUp(setting, 'TPL_NOT_THERE'), '**设置页里没有的模板不许静默补**（没勾过就会弹窗）');
  isFalse(S.canSilentTopUp(setting, ''), '没有模板 ID → 不许');
  isFalse(S.canSilentTopUp({ ok: false, mainSwitch: true, itemSettings: { TPL_TEST_1: 'accept' } }, TPL),
    '**读设置失败（ok:false）→ 一律不许**（安全的那一侧）');
  isFalse(S.canSilentTopUp(S.normalizeSubscribeSetting({
    subscriptionsSetting: { mainSwitch: false, itemSettings: { TPL_TEST_1: 'accept' } },
  }), TPL), '主开关被关掉 → 不许（调了也会被微信拒，errCode 20004）');
  isFalse(S.canSilentTopUp(S.normalizeSubscribeSetting({
    subscriptionsSetting: { itemSettings: { TPL_TEST_1: 'ban' } },
  }), TPL), 'ban 的模板 → 不许');
  isFalse(S.canSilentTopUp(S.normalizeSubscribeSetting({
    subscriptionsSetting: { itemSettings: { TPL_TEST_1: 'filter' } },
  }), TPL), 'filter（同标题被过滤）→ 不许');
}

// ---------------------------------------------------------------------------
// 二、静默补额度：三道闸
// ---------------------------------------------------------------------------
function testSilentGates() {
  block('二、静默补额度：不许弹窗、不许刷、不许虚报');

  var cases = [];

  // ① 没勾过（设置里没有这个模板）→ 一次调用都不许发
  cases.push(function () {
    var stub = makeStub({ itemSettings: {} });
    install(stub);
    var ack = makeAck();
    return S.silentTopUpOnce({ tmplId: TPL, onAccept: ack.fn, nowMs: NOW }).then(function (result) {
      eq(stub.calls.subscribe.length, 0, '**没勾过「保持选择」→ 一个授权窗都不弹**（弹了就是骚扰）');
      eq(result.done, false, '结果如实是"没补"');
      eq(result.reason, 'not-allowed', '原因：not-allowed');
      eq(ack.calls, 0, '**没有上报**（没授权就没有额度）');
    });
  });

  // ② 环境里没有 getSetting → 同样不许
  cases.push(function () {
    var stub = makeStub({ noGetSetting: true });
    install(stub);
    var ack = makeAck();
    return S.silentTopUpOnce({ tmplId: TPL, onAccept: ack.fn, nowMs: NOW }).then(function (result) {
      eq(stub.calls.subscribe.length, 0, '**读不到设置 → 不调用**（判不出来就别动）');
      eq(result.reason, 'not-allowed', '原因：not-allowed');
      eq(ack.calls, 0, '没有上报');
    });
  });

  // ③ getSetting 失败 → 同样不许
  cases.push(function () {
    var stub = makeStub({ getSettingFails: true });
    install(stub);
    var ack = makeAck();
    return S.silentTopUpOnce({ tmplId: TPL, onAccept: ack.fn, nowMs: NOW }).then(function (result) {
      eq(stub.calls.subscribe.length, 0, '**getSetting 失败 → 不调用**');
      eq(result.reason, 'not-allowed', '原因：not-allowed');
      eq(ack.calls, 0, '没有上报');
    });
  });

  // ④ 没有 storage（读不到节流记录）→ 保守地不补
  cases.push(function () {
    var stub = makeStub({ itemSettings: { TPL_TEST_1: 'accept' }, noStorage: true });
    install(stub);
    var ack = makeAck();
    return S.silentTopUpOnce({ tmplId: TPL, onAccept: ack.fn, nowMs: NOW }).then(function (result) {
      eq(stub.calls.subscribe.length, 0, '**读不到本地缓存 → 不补**（宁可少攒，不可变成刷子）');
      eq(result.reason, 'throttled', '原因：throttled（节流那一步挡住的）');
      eq(ack.calls, 0, '没有上报');
    });
  });

  // ⑤ 勾过 + 首次 → 调用一次 + 上报一次
  cases.push(function () {
    var stub = makeStub({ itemSettings: { TPL_TEST_1: 'accept' } });
    install(stub);
    var ack = makeAck();
    return S.silentTopUpOnce({ tmplId: TPL, onAccept: ack.fn, nowMs: NOW }).then(function (result) {
      eq(stub.calls.subscribe.length, 1, '勾过 → 调用一次');
      eq(stub.calls.subscribe[0].tmplIds.length, 1, '只勾一个模板位');
      eq(stub.calls.subscribe[0].tmplIds[0], TPL, '用的就是那个模板 ID');
      isTrue(result.done, '结果：补上了');
      eq(result.result, 'accept', '结果：accept');
      eq(ack.calls, 1, '**上报了一次**（accept 才上报）');
      isTrue(stub.__storage.remind_topup_at === NOW, '把这次的时间写进了节流记录');
    });
  });

  // ⑥ 10 分钟内再点 → 挡住（不调用、不上报）
  cases.push(function () {
    var stub = makeStub({
      itemSettings: { TPL_TEST_1: 'accept' },
      storage: { remind_topup_at: NOW },
    });
    install(stub);
    var ack = makeAck();
    return S.silentTopUpOnce({ tmplId: TPL, onAccept: ack.fn, nowMs: NOW + 5 * 60 * 1000 }).then(function (result) {
      eq(stub.calls.subscribe.length, 0, '**5 分钟后不再调用**（节流生效）');
      eq(result.reason, 'throttled', '原因：throttled');
      eq(ack.calls, 0, '没有上报');
    });
  });

  // ⑦ 超过 10 分钟 → 又能补一次
  cases.push(function () {
    var stub = makeStub({
      itemSettings: { TPL_TEST_1: 'accept' },
      storage: { remind_topup_at: NOW },
    });
    install(stub);
    var ack = makeAck();
    return S.silentTopUpOnce({ tmplId: TPL, onAccept: ack.fn, nowMs: NOW + 11 * 60 * 1000 }).then(function (result) {
      eq(stub.calls.subscribe.length, 1, '**11 分钟后可以再补一次**');
      isTrue(result.done, '补上了');
      eq(ack.calls, 1, '上报了一次');
    });
  });

  // ⑧ 平台回 reject / ban / unknown / fail → 一律不上报
  ['reject', 'ban', 'unknown'].forEach(function (answer) {
    cases.push(function () {
      var stub = makeStub({ itemSettings: { TPL_TEST_1: 'accept' }, answer: answer });
      install(stub);
      var ack = makeAck();
      return S.silentTopUpOnce({ tmplId: TPL, onAccept: ack.fn, nowMs: NOW }).then(function (result) {
        eq(stub.calls.subscribe.length, 1, '调用了（' + answer + '）');
        eq(result.done, false, '**' + answer + ' → 不算补上**');
        eq(ack.calls, 0, '**' + answer + ' → 绝不上报**（没授权却加额度 = 骗服务端）');
      });
    });
  });

  cases.push(function () {
    var stub = makeStub({
      itemSettings: { TPL_TEST_1: 'accept' },
      answer: 'fail',
      failError: { errCode: 10005, errMsg: 'requestSubscribeMessage:fail 小程序退后台了' },
    });
    install(stub);
    var ack = makeAck();
    return S.silentTopUpOnce({ tmplId: TPL, onAccept: ack.fn, nowMs: NOW }).then(function (result) {
      eq(result.done, false, '调用失败 → 没补上');
      eq(result.result, 'fail', '结果：fail');
      isTrue(result.detail.indexOf('10005') > -1, '原始错误带上 errCode：' + result.detail);
      eq(ack.calls, 0, '**失败绝不上报**');
    });
  });

  // ⑨ 上报失败 → 不许当成成功（否则服务端没有额度，下次下发必然 43101）
  cases.push(function () {
    var stub = makeStub({ itemSettings: { TPL_TEST_1: 'accept' } });
    install(stub);
    var ack = makeAck({ fails: true });
    return S.silentTopUpOnce({ tmplId: TPL, onAccept: ack.fn, nowMs: NOW }).then(function (result) {
      eq(ack.calls, 1, '上报被调用了一次');
      eq(result.done, false, '**上报失败 → 整体算没补上**');
      eq(result.reason, 'ack-failed', '原因：ack-failed');
      isTrue(result.detail.indexOf('数据库') > -1, '原始错误如实带出：' + result.detail);
    });
  });

  // ⑩ 没有模板 ID / 环境没有 requestSubscribeMessage
  cases.push(function () {
    install(makeStub({ itemSettings: { TPL_TEST_1: 'accept' } }));
    var ack = makeAck();
    return S.silentTopUpOnce({ tmplId: '', onAccept: ack.fn, nowMs: NOW }).then(function (result) {
      eq(result.reason, 'no-template', '没有模板 ID → no-template，什么都不做');
      eq(ack.calls, 0, '没有上报');
    });
  });

  cases.push(function () {
    var stub = makeStub({ itemSettings: { TPL_TEST_1: 'accept' }, noSubscribe: true });
    install(stub);
    var ack = makeAck();
    return S.silentTopUpOnce({ tmplId: TPL, onAccept: ack.fn, nowMs: NOW }).then(function (result) {
      eq(result.done, false, '环境不支持 → 没补上');
      eq(result.result, 'unsupported', '结果：unsupported（如实说，不假装成功）');
      eq(ack.calls, 0, '没有上报');
    });
  });

  // ⑪ 没有全局 wx → 全程不崩
  cases.push(function () {
    install(null);
    var ack = makeAck();
    return S.silentTopUpOnce({ tmplId: TPL, onAccept: ack.fn, nowMs: NOW }).then(function (result) {
      eq(result.done, false, '没有 wx → 没补上（且不抛异常）');
      eq(ack.calls, 0, '没有上报');
    });
  });

  return cases.reduce(function (chain, item) {
    return chain.then(item);
  }, Promise.resolve());
}

// ---------------------------------------------------------------------------
// 三、一次补齐的条数判据（红线 2）
// ---------------------------------------------------------------------------
function testRoundMax() {
  block('三、一次补齐：会弹窗时 3 条，静默时只 1 条（宁可少攒不可虚报）');
  eq(S.TOPUP_ROUND_MAX, 3, '会弹窗那条路一轮最多 3 次（微信一次调用最多 3 个模板位）');
  eq(S.maxTimesForRound(false), 3, '没勾「保持选择」→ 3 次（每次都有用户逐次点允许的凭据）');
  eq(S.maxTimesForRound(true), 1, '**勾过 → 只 1 次**（静默调用只回一个 accept，没有"几次"这回事）');
  eq(S.TOPUP_MIN_GAP_MS, 10 * 60 * 1000, '静默补充的最小间隔 = 10 分钟');

  // 节流状态本身：读不到环境/缓存时**保守地不许补**。
  // 【为什么必须显式 install(null)】这一份断言不依赖"上一个用例留下的桩长什么样"。
  install(null);
  var state = S.topUpSlotState(NOW, 10 * 60 * 1000);
  isFalse(state.allowed, '**读不到 wx → 不许补**（保守的那一侧：宁可少攒，不可变成刷子）');
  isTrue(state.reason.indexOf('缓存') > -1, '原因指向"读不到本地缓存"：' + state.reason);
  eq(state.lastAt, 0, 'lastAt 如实是 0（不是瞎编一个时间）');
}

// ---------------------------------------------------------------------------
// 四、北京时间 → unix 秒
// ---------------------------------------------------------------------------
function testBeijingSeconds() {
  block('四、北京时间 → unix 秒（设备时区不许影响结果）');

  var sec = S.beijingSeconds('2026-10-15', '23:59');
  eq(new Date(sec * 1000).toISOString(), '2026-10-15T15:59:00.000Z',
    '**2026-10-15 23:59（北京）= 15:59Z**（UTC 比北京晚 8 小时）');

  var sec2 = S.beijingSeconds('2026-09-28', '12:00');
  eq(new Date(sec2 * 1000).toISOString(), '2026-09-28T04:00:00.000Z', '2026-09-28 12:00（北京）= 04:00Z');

  eq(S.beijingSeconds('2026-09-07', '9:05'), S.beijingSeconds('2026-09-07', '09:05'),
    'H:MM 与 HH:MM 等价（与 normalize.js 的 normalizeTime 同口径）');
  eq(new Date(S.beijingSeconds('2026-09-07', '00:00') * 1000).toISOString(), '2026-09-06T16:00:00.000Z',
    '00:00 → 前一天的 16:00Z（跨日边界不能算错）');
  eq(typeof S.beijingSeconds('2026-09-07', '23:59'), 'number', '23:59 是合法值（不是把它当越界挡掉）');

  // 非法输入一律 null，绝不"猜一个"
  eq(S.beijingSeconds('2026-09-07', '24:00'), null, '24:00 → null（跨天请建成第二天，不替用户 +1 天）');
  eq(S.beijingSeconds('2026-09-07', '23:60'), null, '23:60 → null');
  eq(S.beijingSeconds('2026-02-30', '12:00'), null, '**2026-02-30 → null**（不许被 Date 静默进位成 3-02）');
  eq(S.beijingSeconds('2026-13-01', '12:00'), null, '13 月 → null');
  eq(S.beijingSeconds('2026/09/07', '12:00'), null, '斜杠日期 → null（只认 YYYY-MM-DD）');
  eq(S.beijingSeconds('', '12:00'), null, '空日期 → null');
  eq(S.beijingSeconds('2026-09-07', ''), null, '空时刻 → null');
  eq(S.beijingSeconds(null, undefined), null, 'null/undefined → null（不抛异常）');

  // 闰年：2028-02-29 真实存在
  eq(new Date(S.beijingSeconds('2028-02-29', '08:00') * 1000).toISOString(), '2028-02-29T00:00:00.000Z',
    '2028-02-29 是真实日期（闰年规则没挡错）');
  eq(S.beijingSeconds('2026-02-29', '08:00'), null, '2026-02-29 不存在 → null');
}

// ---------------------------------------------------------------------------
// 五、DDL → 日历事件（与云函数 dueInstantOf 同口径）
// ---------------------------------------------------------------------------
function testDdlToEvent() {
  block('五、DDL → 日历事件：口径必须与微信提醒那条通道一致');

  var task = {
    id: 't1',
    type: 'ddl',
    title: '交实验报告',
    date: '2026-10-20',
    end_time: '23:59',
    location: '致原楼',
    done: false,
  };
  var built = S.ddlToCalendarEvent(task, { leadMin: 60 });
  isTrue(built.ok, '正常 DDL → 能写');
  eq(built.event.title, '⏰ 截止：交实验报告', '标题带前缀（与 .ics 导出同一个约定）');
  eq(new Date(built.event.startTime * 1000).toISOString(), '2026-10-20T15:59:00.000Z', '截止时刻准确');
  eq(built.event.endTime - built.event.startTime, S.CAL_EVENT_MINUTES * 60, '结束时间 = 开始 + 30 分钟');
  eq(built.event.alarmOffset, 3600, '提前量 60 分钟 → alarmOffset 3600 秒');
  isTrue(built.event.alarm, '默认带提醒');
  isTrue(built.event.description.indexOf('2026-10-20 23:59') > -1, '说明里有截止时刻：' + built.event.description);
  eq(built.event.location, '致原楼', '地点带过去');
  eq(built.key, 't1@2026-10-20 23:59', '幂等键 = id@日期 时刻');

  // ---- 该跳过的必须跳过（每一条都对应一个真实错误用法）----
  eq(S.ddlToCalendarEvent({ type: 'ddl', date: '2026-10-20' }, {}).reason, 'no-time',
    '**缺 end_time → 不写**（"不瞎猜 23:59"，与云函数 dueInstantOf 同一取舍）');
  eq(S.ddlToCalendarEvent({ type: 'ddl', end_time: '23:59' }, {}).reason, 'no-date', '缺 date → 不写');
  eq(S.ddlToCalendarEvent({ type: 'ddl', date: '2026-10-20', end_time: '23:59', done: true }, {}).reason, 'done',
    '**已完成 → 不写**（做完了还提醒就是骚扰）');
  eq(S.ddlToCalendarEvent({ type: 'event', date: '2026-10-20', end_time: '23:59' }, {}).reason, 'not-ddl',
    '**日程不是"到期"，不写进日历**（type 判据与云函数一致）');
  eq(S.ddlToCalendarEvent({ type: 'subtask', date: '2026-10-20', end_time: '23:59' }, {}).reason, 'not-ddl',
    '子任务同样不写');
  eq(S.ddlToCalendarEvent({ type: 'ddl', date: '2026-02-30', end_time: '12:00' }, {}).reason, 'invalid-time',
    '非法日期 → 不写（不猜）');
  eq(S.ddlToCalendarEvent({ type: 'ddl', date: '2026-10-20', end_time: '24:00' }, {}).reason, 'invalid-time',
    '越界时刻 → 不写');
  eq(S.ddlToCalendarEvent(null, {}).reason, 'not-task', '空任务 → 不写');
  eq(S.ddlToCalendarEvent([], {}).reason, 'not-task', '数组 → 不写（不许把数组当任务）');

  // ---- 提前量的脏数据不许变成"负闹钟"或 undefined ----
  eq(S.ddlToCalendarEvent(task, { leadMin: -5 }).event.alarmOffset, 60 * 60,
    '负数提前量 → 回落默认 60 分钟（不是负数）');
  eq(S.ddlToCalendarEvent(task, { leadMin: 'abc' }).event.alarmOffset, 60 * 60, '字符串垃圾 → 回落默认');
  eq(S.ddlToCalendarEvent(task, { leadMin: 0 }).event.alarmOffset, 0, '0 是合法值（= 事件开始时提醒）');
  eq(S.ddlToCalendarEvent(task, {}).event.alarmOffset, 60 * 60, '不传 → 默认 60 分钟');
  eq(S.ddlToCalendarEvent({ type: 'ddl', title: '', date: '2026-10-20', end_time: '08:00' }, {}).event.title,
    '⏰ 截止：未命名截止事项', '没有标题也要有一个能认出来的名字');
  eq(S.ddlToCalendarEvent({ _id: 'x9', type: 'ddl', date: '2026-10-20', end_time: '08:00' }, {}).key,
    'x9@2026-10-20 08:00', '任务文档用 _id 时也能生成幂等键');
}

// ---------------------------------------------------------------------------
// 六、批量：跳过原因 + 排序 + 截断 + events/keys 一一对应
// ---------------------------------------------------------------------------
function testBatch() {
  block('六、批量转换：跳过原因要分类、排序要对、events 与 keys 不许错位');

  // 基准时间：2026-10-15 18:00 北京
  var tasks = [
    { id: 'late', type: 'ddl', title: '晚的', date: '2026-10-20', end_time: '23:59' },
    { id: 'early', type: 'ddl', title: '早的', date: '2026-10-16', end_time: '09:00' },
    { id: 'notime', type: 'ddl', title: '没时刻', date: '2026-10-18' },
    { id: 'done', type: 'ddl', title: '做完了', date: '2026-10-19', end_time: '10:00', done: true },
    { id: 'past', type: 'ddl', title: '过期了', date: '2026-10-01', end_time: '10:00' },
    { id: 'event', type: 'event', title: '日程', date: '2026-10-19', start_time: '10:00', end_time: '12:00' },
    { id: 'bad', type: 'ddl', title: '格式错', date: '2026-10-19', end_time: '25:00' },
  ];
  var built = S.calendarEventsOf(tasks, { leadMin: 30, nowMs: NOW });

  eq(built.events.length, 2, '7 条里只有 2 条能写');
  eq(built.events[0].title, '⏰ 截止：早的', '**按时间升序**：最近要到的排第一');
  eq(built.events[1].title, '⏰ 截止：晚的', '第二条是晚的那条');
  eq(built.skipped.noTime, 1, '缺时刻记 1 条');
  eq(built.skipped.done, 1, '已完成记 1 条');
  eq(built.skipped.past, 1, '已过期记 1 条');
  eq(built.skipped.invalid, 1, '格式非法记 1 条');
  eq(built.skipped.notDdl, 1, '非 DDL 记 1 条');
  eq(built.skipped.already, 0, '没传 skipKeys 时没有"已写过"');
  isFalse(built.truncated, '没到上限');
  eq(built.kept, 2, 'kept 与 events 长度一致');
  eq(built.keys.length, built.events.length, 'keys 与 events 长度一致');
  eq(built.keys[0], built.events[0].key, '**keys[0] 就是 events[0] 的键**（排序后不许错位）');
  eq(built.keys[1], built.events[1].key, '**keys[1] 就是 events[1] 的键**');

  // 已经写过的跳过（防"点两次写两份"）
  var again = S.calendarEventsOf(tasks, { nowMs: NOW, skipKeys: built.keys });
  eq(again.events.length, 0, '把上一轮的 keys 传进来 → 一条都不再写');
  eq(again.skipped.already, 2, '两条都记成"已写过"');

  // 上限截断
  var many = [];
  for (var i = 0; i < 5; i += 1) {
    many.push({ id: 'm' + i, type: 'ddl', title: '第' + i, date: '2026-11-0' + (i + 1), end_time: '10:00' });
  }
  var capped = S.calendarEventsOf(many, { nowMs: NOW, max: 2 });
  eq(capped.events.length, 2, 'max:2 → 只给 2 条');
  isTrue(capped.truncated, '**截断了要如实标出来**（界面才能说"其余的再点一次"）');
  eq(capped.skipped.noTime + capped.skipped.past + capped.skipped.done, 0, '被截断的不算"跳过"（不是数据问题）');

  // 脏输入不许崩
  eq(S.calendarEventsOf(null, {}).events.length, 0, 'null → 空数组，不抛异常');
  eq(S.calendarEventsOf('not-an-array', {}).events.length, 0, '字符串 → 空数组');
  eq(S.calendarEventsOf([null, 1, 'x'], { nowMs: NOW }).skipped.notDdl, 3, '非对象元素记成 notDdl');

  eq(S.CAL_MAX_EVENTS, 50, '一次最多 50 条（日历是私人空间，不能一次灌几百条）');
}

// ---------------------------------------------------------------------------
// 七、写进系统日历：能力判定 + 载荷形状 + 串行 + 失败即停
// ---------------------------------------------------------------------------
function testCalendarWrite() {
  block('七、写系统日历：能力判定、载荷形状、串行与失败即停');

  var cases = [];

  // ① 基础库太低（canIUse 说没有）→ 不调用、给一句人话
  cases.push(function () {
    var stub = makeStub({ canIUseCal: false });
    install(stub);
    return S.addCalendarEvent({ title: 'x', startTime: 1 }).then(function (result) {
      isFalse(result.ok, '不支持 → 失败');
      eq(stub.calls.calendar.length, 0, '**一条都不许调**');
      isTrue(result.error.indexOf(S.CAL_MIN_SDK) > -1, '错误里说明需要的基础库版本：' + result.error);
    });
  });

  // ② 环境里没有 addPhoneCalendar → 同样
  cases.push(function () {
    var stub = makeStub({ noCalendar: true });
    install(stub);
    isFalse(S.calendarSupported(), 'calendarSupported() 为 false');
    return S.addCalendarEvent({ title: 'x', startTime: 1 }).then(function (result) {
      isFalse(result.ok, '失败');
      eq(stub.calls.calendar.length, 0, '没有调用');
    });
  });

  // ③ 成功路径：载荷形状（多了字段微信会报错，少了又写不进去）
  cases.push(function () {
    var stub = makeStub({});
    install(stub);
    isTrue(S.calendarSupported(), '支持（canIUse + 函数都在）');
    var event = S.ddlToCalendarEvent({
      id: 'c1', type: 'ddl', title: '交报告', date: '2026-10-20', end_time: '23:59', location: '致原楼',
    }, { leadMin: 120 }).event;
    return S.addCalendarEvent(event).then(function (result) {
      isTrue(result.ok, '写成功');
      eq(stub.calls.calendar.length, 1, '调用了一次');
      var payload = stub.calls.calendar[0];
      eq(payload.title, '⏰ 截止：交报告', 'title');
      eq(payload.startTime, event.startTime, 'startTime 是 unix 秒');
      eq(payload.endTime, event.endTime, 'endTime');
      isTrue(payload.alarm, 'alarm:true');
      eq(payload.alarmOffset, 7200, 'alarmOffset = 120 分钟');
      eq(payload.location, '致原楼', 'location 只在有值时才带上');
      isTrue(payload.description.indexOf('智能日程管家') > -1, 'description 里注明来源');
      isTrue(typeof payload.success === 'function' && typeof payload.fail === 'function',
        '两个回调都给了（不给自己留"不知道成没成"的余地）');
    });
  });

  // ④ 空事件对象 → 不调用
  cases.push(function () {
    var stub = makeStub({});
    install(stub);
    return S.addCalendarEvent(null).then(function (result) {
      isFalse(result.ok, 'null → 失败');
      eq(stub.calls.calendar.length, 0, '没有调用');
    });
  });

  // ⑤ 串行写 3 条 + onEach 回调
  cases.push(function () {
    var stub = makeStub({});
    install(stub);
    var seen = [];
    var events = [
      { title: 'A', startTime: 100, endTime: 200, alarm: true, alarmOffset: 60 },
      { title: 'B', startTime: 300, endTime: 400 },
      { title: 'C', startTime: 500, endTime: 600 },
    ];
    return S.addCalendarEvents(events, { onEach: function (p) { seen.push(p.index + '/' + p.total); } }).then(function (summary) {
      eq(summary.added, 3, '三条都写成功');
      eq(summary.failed, 0, '没有失败');
      isFalse(summary.stopped, '没有中途停下');
      eq(summary.okIndexes.length, 3, 'okIndexes 有 3 个');
      eq(stub.calls.calendar.length, 3, '调用三次（wx.addPhoneCalendar 没有批量接口）');
      eq(stub.calls.calendar[0].title, 'A', '**串行：顺序与传入一致**');
      eq(stub.calls.calendar[1].title, 'B', '第二条是 B');
      eq(stub.calls.calendar[2].title, 'C', '第三条是 C');
      eq(seen.join(','), '1/3,2/3,3/3', '进度回调按顺序报（界面靠它显示"正在写入 N / M"）');
    });
  });

  // ⑥ 第 2 条失败 → 立刻停（默认 maxFailures=1），okIndexes 只含成功的
  cases.push(function () {
    var stub = makeStub({ calendarFails: function (index) { return index === 1; }, calendarError: 'addPhoneCalendar:fail auth deny' });
    install(stub);
    var events = [
      { title: 'A', startTime: 100 },
      { title: 'B', startTime: 200 },
      { title: 'C', startTime: 300 },
    ];
    return S.addCalendarEvents(events).then(function (summary) {
      eq(summary.added, 1, '只成功了 1 条');
      eq(summary.failed, 1, '失败 1 条');
      isTrue(summary.stopped, '**失败就停**（后面几条必然同样失败，不必再弹）');
      isTrue(summary.authDenied, '识别出这是授权被拒（界面据此指向"设置 → 授权管理"）');
      isTrue(summary.firstError.indexOf('auth deny') > -1, '原始错误带上：' + summary.firstError);
      eq(stub.calls.calendar.length, 2, '只调用了 2 次（第 3 条没有硬碰）');
      eq(summary.okIndexes.join(','), '0', '**okIndexes 只含真的写成功的下标**（记防重复名单只记这些）');
    });
  });

  // ⑦ onEach 回调自己抛异常 → 不影响写入
  cases.push(function () {
    var stub = makeStub({});
    install(stub);
    return S.addCalendarEvents([{ title: 'A', startTime: 1 }, { title: 'B', startTime: 2 }], {
      onEach: function () { throw new Error('回调炸了'); },
    }).then(function (summary) {
      eq(summary.added, 2, '**回调抛异常不影响写入**（它只是显示进度用的）');
    });
  });

  // ⑧ 空列表
  cases.push(function () {
    var stub = makeStub({});
    install(stub);
    return S.addCalendarEvents([]).then(function (summary) {
      eq(summary.added, 0, '空列表 → 0 条，不调用');
      eq(stub.calls.calendar.length, 0, '没有调用');
    });
  });

  // ⑨ 防重复名单：读 / 记 / 去重 / 上限
  cases.push(function () {
    var stub = makeStub({});
    install(stub);
    eq(S.readWrittenKeys().length, 0, '一开始是空的');
    S.rememberWrittenKeys(['a', 'b']);
    eq(S.readWrittenKeys().join(','), 'a,b', '记住了两个键');
    S.rememberWrittenKeys(['b', 'c']);
    eq(S.readWrittenKeys().join(','), 'a,b,c', '**重复的键只留一份**');
    var many = [];
    for (var i = 0; i < S.CAL_WRITTEN_MAX + 20; i += 1) many.push('k' + i);
    S.rememberWrittenKeys(many);
    eq(S.readWrittenKeys().length, S.CAL_WRITTEN_MAX, '**超过上限就裁剪**（只用于防重复，不需要无限增长）');
    isTrue(S.readWrittenKeys()[S.CAL_WRITTEN_MAX - 1] === 'k' + (S.CAL_WRITTEN_MAX + 19),
      '裁掉的是最旧的那些（最新的留着）');
    return Promise.resolve();
  });

  cases.push(function () {
    var stub = makeStub({ noStorage: true });
    install(stub);
    eq(S.readWrittenKeys().length, 0, '没有 storage 时读成空数组（不抛异常）');
    S.rememberWrittenKeys(['a']);   // 不该抛
    eq(S.readWrittenKeys().length, 0, '写不进去也只是"下次可能重复写"，不影响这次结果');
    return Promise.resolve();
  });

  cases.push(function () {
    install(null);
    isFalse(S.calendarSupported(), '没有 wx → 不支持（不抛异常）');
    return S.addCalendarEvent({ title: 'x', startTime: 1 }).then(function (result) {
      isFalse(result.ok, '失败而不是崩溃');
    });
  });

  return cases.reduce(function (chain, item) {
    return chain.then(item);
  }, Promise.resolve());
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function run() {
  testSettingJudgement();
  testRoundMax();
  testBeijingSeconds();
  testDdlToEvent();
  testBatch();
  return Promise.resolve()
    .then(testSilentGates)
    .then(testCalendarWrite);
}

var done = Promise.resolve()
  .then(run)
  .then(function () {
    restoreGlobals();
    if (require.main === module) H.report('订阅授权少点几次（静默补额度 / 一次补齐 / 写系统日历）');
  })
  .catch(function (err) {
    restoreGlobals();
    console.error('subscribe 测试自己崩了：', err && err.stack ? err.stack : err);
    process.exit(2);
  });

module.exports = { done: done };
