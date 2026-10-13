/**
 * utils/subscribe.js —— 「别让我一个个点」：订阅授权的少点几次 + 写进手机系统日历。
 *
 * ===========================================================================
 * 【这个文件为什么存在】用户的原话是"为什么日程提醒要自己一个个手动申请"
 * ===========================================================================
 * 微信订阅消息的硬规则（完整版见 docs/到期提醒.md）：
 *   1. **一次性订阅 = 授权一次，服务端只能下发一条** —— 额度是消耗品，用完得再征得同意；
 *   2. **授权窗必须由用户的点击行为触发**。官方原话：「用户发生点击行为或者发起支付回调后，
 *      才可以调起订阅消息界面」—— 所以"进小程序时自动弹一堆授权窗"平台压根不允许；
 *   3. **长期订阅**（一次授权、永久可发）只对政务民生/医疗/交通/金融/教育等类目开放，
 *      工具类小程序申请不到；
 *   4. 一次调用最多带 3 个模板位，但**同标题的模板只保留一个** —— 所以"同一个模板填 3 遍
 *      薅 3 条额度"是无效的，只能靠多次弹窗。
 *
 * 规则改不了，但"不想一个个点"这个诉求是合理的。于是本文件提供三件事：
 *   A. `addCalendarEvents` —— 把截止事项写进**手机系统日历**（wx.addPhoneCalendar）。
 *      不消耗微信额度、不限条数、离线也响、还能设提前量。这才是真正意义的"全部放开"。
 *   B. `requestSubscribeOnce` —— 授权窗的一层薄封装，供页面"点一次、连弹到 3 条"用。
 *   C. `silentTopUpOnce` —— 用户勾过弹窗里的「总是保持以上选择，不再询问」之后，再调用
 *      就不会弹窗了（官方文档：勾选后模板会出现在小程序设置页，可用 getSetting 读状态）。
 *      `canSilentTopUp` 判定的就是这个状态；成立时，页面上的任意一次点击都能顺手补额度。
 *
 * ===========================================================================
 * 【两条不许越过的红线】
 * ===========================================================================
 * 1. **只有平台回答 `accept` 才允许上报额度。**没授权却加额度 = 骗服务端，
 *    下次真实下发必然 43101 失败 —— 那是把用户的提醒玩坏，不是"省事"。
 * 2. **静默那条路一轮只补 1 条。**有弹窗时，"用户点了几次允许"就是逐次同意的凭据；
 *    静默时平台只回了一个 accept，并没有"几次"这回事（勾选框到底能不能累积额度，
 *    官方文档没有写，我们也没有真机证据）。所以宁可少攒、不可虚报：
 *    `maxTimesForSilent()` 返回 1，页面据此把"一次补齐 3 次"降级成"补 1 次"。
 *
 * ===========================================================================
 * 【为什么不 require utils/api.js】
 * ===========================================================================
 * 本文件只封装 wx 能力，**不碰网络**：ack 由调用方以回调注入（见 silentTopUpOnce 的
 * onAccept）。这样 utils/tests/subscribe.test.js 不需要云环境、也不需要 api.js 的桩
 * 就能把每条分支跑完。
 */
'use strict';

/**
 * 北京时间偏移。为什么不用 `new Date(date + ' ' + time)`：那会按容器/设备时区解释，
 * 结果整体差 8 小时。与 cloudfunctions/remind/index.js 的 dueInstantOf 同一算法。
 */
var BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 写日历要的授权 scope（微信「添加到日历」权限；首次调用会弹一次系统授权） */
var CAL_SCOPE = 'scope.addPhoneCalendar';

/** wx.addPhoneCalendar 从基础库 2.15.0 起支持（官方文档），低版本要能优雅降级 */
var CAL_MIN_SDK = '2.15.0';

/** 写进日历的事件默认时长（分钟）：截止事项只有一个时刻，给它一个短块只是为了在日历里看得见 */
var CAL_EVENT_MINUTES = 30;

/** 一次最多写多少条：日历是用户的私人空间，不能一次灌进去几百条 */
var CAL_MAX_EVENTS = 50;

/** 默认提前量（分钟）：拿不到服务端配置又非要写日历时用它，0 = 事件开始时提醒 */
var CAL_DEFAULT_LEAD_MIN = 60;

/** 记住"已经写过的 DDL"用的 storage key：防止用户点两次就在日历里出现两份 */
var CAL_WRITTEN_KEY = 'remind_calendar_written';

/** 已写记录的保留条数上限（只是防重复，不需要无限增长） */
var CAL_WRITTEN_MAX = 200;

/** 静默补额度的最小间隔：这是给用户的"省心"，不是给我们的"刷量" */
var TOPUP_MIN_GAP_MS = 10 * 60 * 1000;

/** 上次静默补额度的时间戳（毫秒）存在这个 key 里 */
var TOPUP_STORAGE_KEY = 'remind_topup_at';

/** 「一次补齐」最多弹几次授权窗（微信一次调用最多 3 个模板位，我们只勾 1 个 → 最多弹 3 次） */
var TOPUP_ROUND_MAX = 3;

/** 取全局 wx（拿不到就返回 null，所有调用方都要能容忍"环境里没有 wx"） */
function getWx() {
  return (typeof wx !== 'undefined' && wx) ? wx : null;
}

/** 宽松转字符串：undefined / null 一律当空串（与 pages/me 的 str 同口径） */
function toStr(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/** 把微信 API 的错误对象变成一句能写进日志/结果行的话（不猜语义，只如实带上原话） */
function describeWxError(err) {
  if (!err) return '未知原因';
  var message = toStr(err.errMsg) || toStr(err.message) || '未知原因';
  var code = err.errCode === undefined || err.errCode === null ? '' : String(err.errCode);
  return code ? message + '（errCode ' + code + '）' : message;
}

/** 非负整数（分钟/秒这类量）：非法输入返回 null，绝不静默变成 0 */
function toCount(value, min) {
  var n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  n = Math.floor(n);
  return n >= min ? n : null;
}

// ---------------------------------------------------------------------------
// 一、订阅状态：用户勾过「总是保持以上选择，不再询问」吗
// ---------------------------------------------------------------------------

/**
 * 归一化 `wx.getSetting({withSubscriptions:true})` 的返回值。
 *
 * 【为什么只认 itemSettings 里有值的模板】官方文档：只有用户勾选了订阅面板里的
 * 「总是保持以上选择，不再询问」，该模板才会被加进用户的小程序设置页 ——
 * 也就是说 itemSettings 里出现这个模板 = 之后再调用不会再弹窗。
 *
 * @param {object} res wx.getSetting 的 success 参数
 * @returns {{ok:boolean, mainSwitch:boolean, itemSettings:object, reason:string}}
 */
function normalizeSubscribeSetting(res) {
  var settings = (res && res.subscriptionsSetting) || {};
  var items = (settings && settings.itemSettings) || {};
  // mainSwitch 缺省视为"开着"：拿不到不代表用户关掉了（关掉时微信会明确给 false）
  return {
    ok: true,
    mainSwitch: settings.mainSwitch !== false,
    itemSettings: (items && typeof items === 'object' && !Array.isArray(items)) ? items : {},
    reason: '',
  };
}

/**
 * 读一次订阅设置。**永不 reject**：拿不到就返回 `{ok:false}`，
 * 调用方据此走"不能静默补额度"的安全分支（而不是抛异常把页面打崩）。
 *
 * @returns {Promise<{ok:boolean, mainSwitch:boolean, itemSettings:object, reason:string}>}
 */
function readSubscribeSetting() {
  var w = getWx();
  return new Promise(function (resolve) {
    if (!w || typeof w.getSetting !== 'function') {
      resolve({ ok: false, mainSwitch: true, itemSettings: {}, reason: '当前环境不支持 wx.getSetting' });
      return;
    }
    try {
      w.getSetting({
        withSubscriptions: true,
        success: function (res) { resolve(normalizeSubscribeSetting(res)); },
        fail: function (err) {
          resolve({ ok: false, mainSwitch: true, itemSettings: {}, reason: describeWxError(err) });
        },
      });
    } catch (err) {
      resolve({ ok: false, mainSwitch: true, itemSettings: {}, reason: describeWxError(err) });
    }
  });
}

/**
 * 能不能对这个模板**静默**补额度（调用后不弹窗）。
 *
 * 三个条件都要满足：读到了设置、主开关没关、这个模板出现在设置页里（= 用户勾过保持选择）。
 * 主开关关掉时调用会被微信直接拒（errCode 20004），所以提前挡住，别做无用功。
 *
 * @param {object} setting readSubscribeSetting 的返回值
 * @param {string} tmplId 模板 ID（来自云函数 status，前端不硬编码）
 * @returns {boolean}
 */
function canSilentTopUp(setting, tmplId) {
  if (!setting || setting.ok !== true) return false;
  if (setting.mainSwitch === false) return false;
  var id = toStr(tmplId);
  if (!id) return false;
  return toStr(setting.itemSettings[id]) === 'accept';
}

// ---------------------------------------------------------------------------
// 二、授权窗：一次调用 / 一轮补齐 / 静默补 1 条
// ---------------------------------------------------------------------------

/** 把授权窗的返回值归一成固定的几种结果（其余一律 unknown，不猜） */
function normalizeAnswer(answer) {
  var text = toStr(answer);
  if (text === 'accept' || text === 'reject' || text === 'ban' || text === 'filter') return text;
  return 'unknown';
}

/**
 * 弹一次授权窗。**永不 reject**，结果用 `{result}` 表达，调用方按它分流。
 *
 * 【注意 tmplIds 里的键就是它自己】回调里要用**同一个** template_id 去取结果，
 * 所以下面判 `res[tmplId]` —— 写死判断整个 res 是错的（这是本项目踩过的坑）。
 *
 * @param {string} tmplId 模板 ID
 * @returns {Promise<{result:'accept'|'reject'|'ban'|'filter'|'unknown'|'fail'|'unsupported'|'no-template', detail:string, errCode:(number|undefined)}>}
 */
function requestSubscribeOnce(tmplId) {
  var w = getWx();
  var id = toStr(tmplId);
  return new Promise(function (resolve) {
    if (!w || typeof w.requestSubscribeMessage !== 'function') {
      resolve({ result: 'unsupported', detail: '当前环境不支持 wx.requestSubscribeMessage' });
      return;
    }
    if (!id) {
      resolve({ result: 'no-template', detail: '还没拿到模板 ID（服务端没配好时不该弹窗）' });
      return;
    }
    try {
      w.requestSubscribeMessage({
        tmplIds: [id],
        success: function (res) {
          var answer = normalizeAnswer(res && res[id]);
          resolve({ result: answer, detail: '', raw: res });
        },
        fail: function (err) {
          resolve({ result: 'fail', detail: describeWxError(err), errCode: err && err.errCode });
        },
      });
    } catch (err) {
      resolve({ result: 'fail', detail: describeWxError(err) });
    }
  });
}

/**
 * 静默那一路一轮最多补几条。**恒为 1**（见文件头红线 2）。
 * 单独做成函数是为了让"一次补齐"的调用方拿到同一份判据，而不是各自写一个 3。
 *
 * @param {boolean} silentAllowed canSilentTopUp 的结果
 * @returns {number} 1（静默）或 TOPUP_ROUND_MAX（会弹窗，用户逐次点允许）
 */
function maxTimesForRound(silentAllowed) {
  return silentAllowed ? 1 : TOPUP_ROUND_MAX;
}

/**
 * 节流状态：距上次静默补额度够久了没有。
 *
 * 【为什么不 fail-open】读不到 storage 时返回"不许补"：静默补额度是**额外**的便利，
 * 拿不准的时候什么都不做才是对的（宁可少攒，不可变成一个每点一次就调用一次的刷子）。
 *
 * @param {number} nowMs 当前毫秒时间戳（测试可注入）
 * @param {number} minGapMs 最小间隔
 * @returns {{allowed:boolean, lastAt:number, waitMs:number, reason:string}}
 */
function topUpSlotState(nowMs, minGapMs) {
  var w = getWx();
  var now = typeof nowMs === 'number' ? nowMs : Date.now();
  var gap = toCount(minGapMs, 0);
  if (gap === null) gap = TOPUP_MIN_GAP_MS;
  if (!w || typeof w.getStorageSync !== 'function') {
    return { allowed: false, lastAt: 0, waitMs: 0, reason: '当前环境读不到本地缓存，不做静默补充' };
  }
  var raw = null;
  try {
    raw = w.getStorageSync(TOPUP_STORAGE_KEY);
  } catch (err) {
    return { allowed: false, lastAt: 0, waitMs: 0, reason: '读本地缓存失败：' + describeWxError(err) };
  }
  var lastAt = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(lastAt) || lastAt <= 0) {
    return { allowed: true, lastAt: 0, waitMs: 0, reason: '' };
  }
  var passed = now - lastAt;
  if (passed >= gap) return { allowed: true, lastAt: lastAt, waitMs: 0, reason: '' };
  return { allowed: false, lastAt: lastAt, waitMs: gap - passed, reason: '刚补过不久' };
}

/** 占用一次节流名额（真的写 storage）；返回 false 表示这次不许补 */
function takeTopUpSlot(nowMs, minGapMs) {
  var w = getWx();
  var state = topUpSlotState(nowMs, minGapMs);
  if (!state.allowed) return false;
  if (!w || typeof w.setStorageSync !== 'function') return false;
  try {
    w.setStorageSync(TOPUP_STORAGE_KEY, typeof nowMs === 'number' ? nowMs : Date.now());
  } catch (err) {
    // 写不进去就别补了：否则每次点击都会再试一次，等于没节流
    return false;
  }
  return true;
}

/**
 * 静默补 1 条额度：判定 → 节流 → 调用 → 平台说 accept 才让调用方 ack。
 *
 * 【顺序不能换】先判"能不能静默"（不能就别浪费节流名额），再占节流名额，最后才调用。
 * 调用的结果只有 accept 会走 onAccept；reject / ban / fail 一律**不 ack**。
 *
 * @param {{tmplId:string, onAccept:function, minGapMs?:number, nowMs?:number}} options
 *        onAccept：无参函数，返回 Promise（由页面注入它自己的 ack 通道）
 * @returns {Promise<{done:boolean, result:string, reason:string, detail:string}>}
 */
function silentTopUpOnce(options) {
  var opts = options || {};
  var tmplId = toStr(opts.tmplId);
  if (!tmplId) {
    return Promise.resolve({ done: false, result: 'no-template', reason: 'no-template', detail: '' });
  }
  return readSubscribeSetting().then(function (setting) {
    if (!canSilentTopUp(setting, tmplId)) {
      // 没勾"保持以上选择"时调用会弹窗 —— 那是打扰，不是省心
      return { done: false, result: 'not-allowed', reason: 'not-allowed', detail: '' };
    }
    if (!takeTopUpSlot(opts.nowMs, opts.minGapMs)) {
      return { done: false, result: 'throttled', reason: 'throttled', detail: '' };
    }
    return requestSubscribeOnce(tmplId).then(function (answer) {
      if (answer.result !== 'accept') {
        return { done: false, result: answer.result, reason: 'not-accepted', detail: answer.detail };
      }
      if (typeof opts.onAccept !== 'function') {
        return { done: true, result: 'accept', reason: '', detail: '' };
      }
      return Promise.resolve(opts.onAccept()).then(function () {
        return { done: true, result: 'accept', reason: '', detail: '' };
      }).catch(function (err) {
        // 授权成功但上报失败：**不能当成成功**（服务端没有额度，下发时还是会失败）
        return { done: false, result: 'accept', reason: 'ack-failed', detail: describeWxError(err) };
      });
    });
  });
}

// ---------------------------------------------------------------------------
// 三、写进手机系统日历（wx.addPhoneCalendar）
// ---------------------------------------------------------------------------

/** 当前环境能不能写系统日历（基础库 2.15.0+） */
function calendarSupported() {
  var w = getWx();
  if (!w) return false;
  if (typeof w.canIUse === 'function') {
    try {
      if (!w.canIUse('addPhoneCalendar')) return false;
    } catch (err) {
      return false;
    }
  }
  return typeof w.addPhoneCalendar === 'function';
}

/**
 * 按北京时间把日期 + 时刻合成为 **unix 秒**（wx.addPhoneCalendar 要秒，不是毫秒）。
 *
 * 校验口径与云函数 `dueInstantOf` 完全一致（这是**有意**的）：
 *   * 必须是 YYYY-MM-DD 且真实存在（2026-02-30 不许被 Date 静默进位）；
 *   * 时刻必须是 H:MM / HH:MM，且 00:00 ~ 23:59（跨天请建成第二天，不在这里替用户 +1 天）。
 *
 * @param {string} dateText 'YYYY-MM-DD'
 * @param {string} timeText 'HH:MM'
 * @returns {number|null} unix 秒；非法返回 null
 */
function beijingSeconds(dateText, timeText) {
  var dateMatched = toStr(dateText).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatched) return null;
  var timeMatched = toStr(timeText).match(/^(\d{1,2}):(\d{2})$/);
  if (!timeMatched) return null;

  var year = Number(dateMatched[1]);
  var month = Number(dateMatched[2]);
  var day = Number(dateMatched[3]);
  var hour = Number(timeMatched[1]);
  var minute = Number(timeMatched[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59) return null;

  var dayUtc = Date.UTC(year, month - 1, day);
  var roundTrip = new Date(dayUtc);
  if (roundTrip.getUTCFullYear() !== year
    || roundTrip.getUTCMonth() + 1 !== month
    || roundTrip.getUTCDate() !== day) {
    return null;
  }
  return Math.floor((dayUtc + (hour * 60 + minute) * 60 * 1000 - BEIJING_OFFSET_MS) / 1000);
}

/** DDL 的幂等键（与云函数的 dueKeyOf 同构：同一个任务的同一个截止时刻只算一条） */
function calendarKeyOf(task) {
  var id = toStr(task && (task.id || task._id));
  var dateText = toStr(task && task.date);
  var timeText = toStr(task && task.end_time);
  if (!id || !dateText || !timeText) return '';
  return id + '@' + dateText + ' ' + timeText;
}

/**
 * 一条任务 → 一个日历事件。**纯函数**，不碰 wx，方便单测。
 *
 * 【口径与微信提醒那条通道必须一致】云函数只提醒 `type==='ddl'` 且**填了截止时刻**的
 * 事项（缺 end_time 一律跳过，"不瞎猜 23:59"）。日历这条通道照抄同一套判据 ——
 * 两条通道对同一条数据给出不同答案，比两条都不做还糟。
 *
 * @param {object} task 任务文档
 * @param {{leadMin?:number, nowMs?:number}} [opts] leadMin：提前多少分钟提醒
 * @returns {{ok:true, event:object, key:string}|{ok:false, reason:string}}
 */
function ddlToCalendarEvent(task, opts) {
  var options = opts || {};
  if (!task || typeof task !== 'object' || Array.isArray(task)) return { ok: false, reason: 'not-task' };
  if (toStr(task.type) !== 'ddl') return { ok: false, reason: 'not-ddl' };
  if (task.done === true) return { ok: false, reason: 'done' };

  var dateText = toStr(task.date);
  var timeText = toStr(task.end_time);
  if (!dateText) return { ok: false, reason: 'no-date' };
  if (!timeText) return { ok: false, reason: 'no-time' };

  var startSeconds = beijingSeconds(dateText, timeText);
  if (startSeconds === null) return { ok: false, reason: 'invalid-time' };

  var leadMin = toCount(options.leadMin, 0);
  if (leadMin === null) leadMin = CAL_DEFAULT_LEAD_MIN;

  var title = toStr(task.title) || '未命名截止事项';
  var where = toStr(task.location);
  var description = '智能日程管家 · 截止 ' + dateText + ' ' + timeText
    + (where ? ' · ' + where : '');

  return {
    ok: true,
    key: calendarKeyOf(task),
    event: {
      // 标题前缀与 .ics 导出（utils/ics.js / tools/exporter.py）保持一致：
      // 两个导出通道在日历里长得一样，用户才不会以为是两件事
      title: '⏰ 截止：' + title,
      startTime: startSeconds,
      endTime: startSeconds + CAL_EVENT_MINUTES * 60,
      alarm: true,
      alarmOffset: leadMin * 60,
      description: description,
      location: where,
    },
  };
}

/**
 * 一批任务 → 一批日历事件。**纯函数**。
 *
 * @param {Array} tasks 任务数组
 * @param {{leadMin?:number, nowMs?:number, skipKeys?:Array<string>, max?:number}} [opts]
 * @returns {{events:Array, keys:Array<string>, skipped:object, truncated:boolean, kept:number}}
 *          skipped 里按原因分好类，界面据此说清"另外几条为什么没写"
 */
function calendarEventsOf(tasks, opts) {
  var options = opts || {};
  var list = Array.isArray(tasks) ? tasks : [];
  var nowSeconds = Math.floor(
    (typeof options.nowMs === 'number' ? options.nowMs : Date.now()) / 1000
  );
  var skip = {};
  (Array.isArray(options.skipKeys) ? options.skipKeys : []).forEach(function (key) {
    var text = toStr(key);
    if (text) skip[text] = true;
  });
  var max = toCount(options.max, 1);
  if (max === null) max = CAL_MAX_EVENTS;

  var events = [];
  var keys = [];
  var skipped = { notDdl: 0, done: 0, noDate: 0, noTime: 0, invalid: 0, past: 0, already: 0 };
  var truncated = false;

  list.forEach(function (task) {
    var built = ddlToCalendarEvent(task, options);
    if (!built.ok) {
      if (built.reason === 'not-ddl' || built.reason === 'not-task') skipped.notDdl += 1;
      else if (built.reason === 'done') skipped.done += 1;
      else if (built.reason === 'no-date') skipped.noDate += 1;
      else if (built.reason === 'no-time') skipped.noTime += 1;
      else skipped.invalid += 1;
      return;
    }
    // 已经过去的截止时刻写进日历没有意义（闹钟只会立刻响或者不响）
    if (built.event.startTime <= nowSeconds) { skipped.past += 1; return; }
    if (built.key && skip[built.key]) { skipped.already += 1; return; }
    if (events.length >= max) { truncated = true; return; }
    // 键**挂在事件自己身上**再排序：两个数组各自排序一旦不同步，
    // "写成功的键"和"真写进去的事件"就会错位，防重复名单随之失效。
    built.event.key = built.key;
    events.push(built.event);
  });

  // 按时间升序：用户点"写进日历"时，先写最近要到的
  events.sort(function (a, b) { return a.startTime - b.startTime; });
  events.forEach(function (item) { if (item.key) keys.push(item.key); });

  return { events: events, keys: keys, skipped: skipped, truncated: truncated, kept: events.length };
}

/**
 * 把**一条**事件写进系统日历。
 *
 * 【为什么必须逐条调】wx.addPhoneCalendar 一次只能加一个事件，没有批量接口。
 * 授权只在第一次弹（scope.addPhoneCalendar），之后就是静默写入。
 *
 * @param {object} event ddlToCalendarEvent 产出的 event
 * @returns {Promise<{ok:boolean, error:string}>}
 */
function addCalendarEvent(event) {
  var w = getWx();
  return new Promise(function (resolve) {
    if (!calendarSupported()) {
      resolve({ ok: false, error: '当前微信版本不支持写系统日历（需要基础库 ' + CAL_MIN_SDK + ' 及以上）' });
      return;
    }
    if (!event || typeof event !== 'object') {
      resolve({ ok: false, error: '事件内容为空' });
      return;
    }
    try {
      var payload = {
        title: toStr(event.title) || '截止事项',
        startTime: event.startTime,
        endTime: event.endTime === undefined ? event.startTime : event.endTime,
        alarm: event.alarm !== false,
        alarmOffset: typeof event.alarmOffset === 'number' ? event.alarmOffset : 0,
      };
      var description = toStr(event.description);
      if (description) payload.description = description;
      var location = toStr(event.location);
      if (location) payload.location = location;
      w.addPhoneCalendar(Object.assign(payload, {
        success: function () { resolve({ ok: true, error: '' }); },
        fail: function (err) { resolve({ ok: false, error: describeWxError(err) }); },
      }));
    } catch (err) {
      resolve({ ok: false, error: describeWxError(err) });
    }
  });
}

/**
 * 把一批事件**串行**写进系统日历。
 *
 * 【为什么串行不并发】授权弹窗只会在第一条上出现，并发调用会让"哪一条需要授权"变得不可知；
 * 而且失败时要能停下来说清楚"写到第几条断的"。串行慢一点，但用户看得懂发生了什么。
 *
 * @param {Array} events 事件数组
 * @param {{onEach?:function, maxFailures?:number}} [opts]
 * @returns {Promise<{added:number, failed:number, stopped:boolean, firstError:string, authDenied:boolean, okIndexes:Array<number>}>}
 *          okIndexes：**真的写成功**的那些事件在入参数组里的下标。调用方靠它记"已经写过的键"——
 *          只记成功的，失败的下次还会再试。
 */
function addCalendarEvents(events, opts) {
  var options = opts || {};
  var list = Array.isArray(events) ? events : [];
  var maxFailures = toCount(options.maxFailures, 1);
  if (maxFailures === null) maxFailures = 1;   // 第一条就失败（多半是没授权）→ 立刻停，别连着弹 N 次
  var added = 0;
  var failed = 0;
  var firstError = '';
  var authDenied = false;
  var okIndexes = [];
  var index = 0;

  function done(stopped) {
    return {
      added: added,
      failed: failed,
      stopped: stopped === true,
      firstError: firstError,
      authDenied: authDenied,
      okIndexes: okIndexes,
    };
  }

  function step() {
    if (index >= list.length) return Promise.resolve(done(false));
    var current = list[index];
    var currentIndex = index;
    index += 1;
    return addCalendarEvent(current).then(function (result) {
      if (result.ok) {
        added += 1;
        okIndexes.push(currentIndex);
      } else {
        failed += 1;
        if (!firstError) firstError = result.error;
        // 授权被拒的信号（scope 相关）—— 后面几条必然同样失败，不必再弹
        if (/auth|deny|denied|permission|scope/i.test(result.error)) authDenied = true;
      }
      if (typeof options.onEach === 'function') {
        try {
          options.onEach({ index: index, total: list.length, ok: result.ok, error: result.error });
        } catch (err) { /* 回调出错不影响写入 */ }
      }
      if (failed >= maxFailures) return done(true);
      return step();
    });
  }

  return step();
}

/** 读"已经写过日历的 DDL"键列表（读不到就当空，不抛异常） */
function readWrittenKeys() {
  var w = getWx();
  if (!w || typeof w.getStorageSync !== 'function') return [];
  try {
    var raw = w.getStorageSync(CAL_WRITTEN_KEY);
    return Array.isArray(raw) ? raw.filter(function (key) { return !!toStr(key); }) : [];
  } catch (err) {
    return [];
  }
}

/** 记住这一轮写过的键（超过上限就丢最旧的，只用于防重复，不需要无限增长） */
function rememberWrittenKeys(keys) {
  var w = getWx();
  if (!w || typeof w.setStorageSync !== 'function') return;
  var merged = readWrittenKeys().concat(Array.isArray(keys) ? keys : []);
  var unique = [];
  merged.forEach(function (key) {
    var text = toStr(key);
    if (text && unique.indexOf(text) === -1) unique.push(text);
  });
  if (unique.length > CAL_WRITTEN_MAX) unique = unique.slice(unique.length - CAL_WRITTEN_MAX);
  try {
    w.setStorageSync(CAL_WRITTEN_KEY, unique);
  } catch (err) {
    // 记不住只会导致下次可能重复写入，不影响这次的结果
  }
}

module.exports = {
  BEIJING_OFFSET_MS: BEIJING_OFFSET_MS,
  CAL_SCOPE: CAL_SCOPE,
  CAL_MIN_SDK: CAL_MIN_SDK,
  CAL_EVENT_MINUTES: CAL_EVENT_MINUTES,
  CAL_MAX_EVENTS: CAL_MAX_EVENTS,
  CAL_WRITTEN_KEY: CAL_WRITTEN_KEY,
  CAL_WRITTEN_MAX: CAL_WRITTEN_MAX,
  TOPUP_MIN_GAP_MS: TOPUP_MIN_GAP_MS,
  TOPUP_STORAGE_KEY: TOPUP_STORAGE_KEY,
  TOPUP_ROUND_MAX: TOPUP_ROUND_MAX,
  normalizeSubscribeSetting: normalizeSubscribeSetting,
  readSubscribeSetting: readSubscribeSetting,
  canSilentTopUp: canSilentTopUp,
  normalizeAnswer: normalizeAnswer,
  requestSubscribeOnce: requestSubscribeOnce,
  maxTimesForRound: maxTimesForRound,
  topUpSlotState: topUpSlotState,
  takeTopUpSlot: takeTopUpSlot,
  silentTopUpOnce: silentTopUpOnce,
  calendarSupported: calendarSupported,
  beijingSeconds: beijingSeconds,
  calendarKeyOf: calendarKeyOf,
  ddlToCalendarEvent: ddlToCalendarEvent,
  calendarEventsOf: calendarEventsOf,
  addCalendarEvent: addCalendarEvent,
  addCalendarEvents: addCalendarEvents,
  readWrittenKeys: readWrittenKeys,
  rememberWrittenKeys: rememberWrittenKeys,
};
