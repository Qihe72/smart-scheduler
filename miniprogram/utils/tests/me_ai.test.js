/**
 * utils/tests/me_ai.test.js —— pages/me/me.js「AI 设置」区块的页面级单测。
 *
 * 跑法：
 *     node utils/tests/me_ai.test.js   # 只跑这一份（末尾打印通过数，失败退出码 1）
 *     node utils/tests/run.js          # 跑全部（注册那一行由入口 run.js 统一加）
 *
 * ===========================================================================
 * 【这个文件为什么存在】真机上用户的原话：
 *   「识图的那个AI为什么不根据我给的API变换模型？我用的明明是deepseek，
 *     他硬说我用的是智谱大模型，还改不了」
 * ===========================================================================
 *   他两条抱怨都成立，都是我们的 UI 缺口：
 *     1. 模型那一格原来**只有只读展示**，后端明明支持自选模型 → 用户确实"改不了"；
 *     2. 「服务商」下拉默认停在智谱，他只粘了 DeepSeek 的 Key 没切服务商，
 *        服务端就按 zhipu 解析出默认模型 glm-4.7-flash → 界面显示"智谱 + glm"。
 *        而**服务商与 Key 必须来自同一家**，这件事界面从来没说过。
 *   所以本文件钉住：模型可填（留空=不带 model 字段）、Key 形状与服务商不匹配要提示、
 *   提示里的按钮**只改选中项不发请求**（绝不静默改用户配置）、状态行要能同时看见
 *   服务商与实际生效的模型。
 *
 * 【做法照 edit_busy.test.js / ai_page.test.js】加载期只捕获 Page 注册对象，
 * wx / getApp 桩在用例执行时才装 —— 加载期直接改全局会把别的测试文件的桩冲掉
 * （表现为"单独跑全绿、经 run.js 加载就崩"）。
 *
 * 【本文件只 require 被测页面 + ./harness.js】不 require 任何别的测试文件。
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
// stub
// ---------------------------------------------------------------------------
var toasts = [];
var callLog = [];
var cloudHandler = null;

var savedWx = global.wx;
var savedGetApp = global.getApp;
var savedGetCurrentPages = global.getCurrentPages;

function useStub() {
  toasts = [];
  callLog = [];
  cloudHandler = null;

  global.wx = {
    showToast: function (options) { toasts.push((options && options.title) || ''); },
    showModal: function (options) { if (options && options.success) options.success({ confirm: true }); },
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
        callLog.push({ name: name, data: data });
        if (!cloudHandler) return Promise.reject({ errMsg: 'no handler' });
        return cloudHandler(name, data).then(function (result) { return { result: result }; });
      }
    }
  };
  global.getApp = function () {
    return {
      globalData: { semesterStart: '', periodTimes: {}, envId: 'test' },
      ensureInit: function () { return Promise.resolve(true); },
      applySettings: function () {}
    };
  };
  global.getCurrentPages = function () { return [{}]; };
}

function restoreGlobals() {
  if (savedWx === undefined) delete global.wx; else global.wx = savedWx;
  if (savedGetApp === undefined) delete global.getApp; else global.getApp = savedGetApp;
  if (savedGetCurrentPages === undefined) delete global.getCurrentPages; else global.getCurrentPages = savedGetCurrentPages;
}

// ---------------------------------------------------------------------------
// 取回页面注册对象（加载期不碰 wx）
// ---------------------------------------------------------------------------
// 【为什么要先删缓存】run.js 里 ai_vision.test.js 会 `delete require.cache[...]`
// 让 pages/ai/ai.js 在它自己的桩下重新注册（见 run.js 里那段注释）。它的实现方式是
// 删掉**整棵 pages/ 子树**的缓存 —— 于是本文件若是"更早被加载过"，require 缓存就没了，
// 再 require 会**重新执行** me.js，而这次 `Page(...)` 注册到的对象与加载期捕获的不是同一个。
// 本文件第一版就栽在这里：单独跑 92/92 全绿，经 run.js 跑却报"Page() 注册对象拿到了 = false"。
// 所以这里**自己先删掉本页面的缓存再 require**，加载期捕获与用例执行用的是同一次注册。
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

/** 真实的 utils/api.js（本文件只 stub 最底层 wx.cloud.callFunction，见 useStub） */
var api = require(path.join(ROOT, 'utils', 'api.js'));

// ---------------------------------------------------------------------------
// 小工具
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

function settle(rounds) {
  var n = rounds || 8;
  var p = Promise.resolve();
  for (var i = 0; i < n; i += 1) {
    p = p.then(function () { return new Promise(function (resolve) { setImmediate(resolve); }); });
  }
  return p;
}

/** 云函数：settings_get + list + ai_config_*。opts 可注入失败 */
function serve(options) {
  var opts = options || {};
  cloudHandler = function (name, data) {
    if (name !== 'tasks') return Promise.resolve({ ok: false, error: 'unexpected fn: ' + name });
    if (data.action === 'settings_get') {
      return Promise.resolve({ ok: true, semester_start: '', period_times: null });
    }
    if (data.action === 'list') {
      return Promise.resolve({ ok: true, tasks: [], count: 0 });
    }
    if (data.action === 'ai_config_get') {
      if (opts.getFail) return Promise.resolve({ ok: false, error: opts.getFail });
      return Promise.resolve(opts.config || {
        ok: true, provider: '', model: '', hasKey: false, masked: ''
      });
    }
    if (data.action === 'ai_config_save') {
      if (opts.saveFail) return Promise.resolve({ ok: false, error: opts.saveFail });
      // 模拟云函数：**用户填了就用用户的，否则用该服务商默认模型**
      // DeepSeek 的默认模型是 deepseek-flash（deepseek-chat 自 2026-07-24 已停服）
      var provider = data.provider;
      var model = data.model || (provider === 'deepseek' ? 'deepseek-flash' : 'glm-4.7-flash');
      var key = String(data.api_key || '');
      return Promise.resolve({
        ok: true,
        provider: provider,
        model: model,
        hasKey: true,
        masked: key ? '****' + key.slice(-4) : ''
      });
    }
    if (data.action === 'ai_config_clear') {
      return Promise.resolve({ ok: true, provider: '', model: '', hasKey: false, masked: '' });
    }
    return Promise.resolve({ ok: false, error: 'unexpected action: ' + data.action });
  };
}

/** 最近一次 ai_config_save 的 payload */
function lastSavePayload() {
  var saves = callLog.filter(function (c) { return c.data.action === 'ai_config_save'; });
  return saves.length ? saves[saves.length - 1].data : null;
}

/** 最近一次 ai_config_get / save 的入参（用来断言 silent 之类的参数） */
function lastGetOptions() {
  var gets = callLog.filter(function (c) { return c.data.action === 'ai_config_get'; });
  return gets.length ? gets[gets.length - 1].data : null;
}

/** 所有 cloud 调用里有没有"发请求"（用来断言"不自动保存"） */
function requestCount() {
  return callLog.length;
}

// 【这个值故意"不像密钥"，别改回"像真 Key"的样子】它只用来验一件事：
// `sk-` 开头 → 判成 DeepSeek（见 pages/me/me.js 的 detectKeyProvider）。
// 早先这里是 `sk-` + 32 位十六进制，形状与真 Key 一模一样 —— 结果 GitHub 的推送保护
// （GITHUB PUSH PROTECTION / GH013）把它当成 DeepSeek API Key，**拦下了整次 git push**。
// 教训：夹具不必长得像真钥匙；形状越像真 Key，越容易被扫描器当成泄漏。
var DEEPSEEK_KEY = 'sk-fixture-shape-test-key';
// 智谱的 Key 形如「32 位十六进制.16 位十六进制」——后段必须是**16 位**
// （甲方给的例子 `…abcdef123456` 后段只有 12 位，按口径不构成合法形状；
//   严格按 16 位判更稳，见下面那条反面对照）
var ZHIPU_KEY = '0123456789abcdef0123456789abcdef.abcdef1234567890';

// ===========================================================================
// 正式用例
// ===========================================================================
function run() {
  useStub();

  block('me AI 设置 —— 页面文件与探针');
  isFalse(!!loadError, 'pages/me/me.js 加载期没有抛异常'
    + (loadError ? '（实际：' + loadError.message + '）' : ''));
  isTrue(!!registered, 'Page() 注册对象拿到了');
  if (!registered) return Promise.resolve();

  var T = registered.__test || {};
  isTrue(typeof T.detectKeyProvider === 'function', '__test 暴露了 detectKeyProvider');
  isTrue(typeof T.keyProviderHint === 'function', '__test 暴露了 keyProviderHint');
  isTrue(typeof T.MAX_MODEL_CHARS === 'number', '__test 暴露了 MAX_MODEL_CHARS');

  var ctx = {};

  // -------------------------------------------------------------------------
  // 1. Key 形状识别（纯本地，零请求）
  // -------------------------------------------------------------------------
  block('Key 形状识别 —— detectKeyProvider');
  eq(T.detectKeyProvider(DEEPSEEK_KEY), 'deepseek', 'sk- 开头 → 像 DeepSeek');
  eq(T.detectKeyProvider('sk-'), 'deepseek', '哪怕只有一个 sk- 前缀也算（后面用户会补全）');
  eq(T.detectKeyProvider(ZHIPU_KEY), 'zhipu', '32位十六进制.16位 → 像智谱');
  eq(T.detectKeyProvider('0123456789ABCDEF0123456789ABCDEF.ABCDEF1234567890'), 'zhipu',
    '大写十六进制也认（Key 大小写不敏感）');
  eq(T.detectKeyProvider('0123456789abcdef0123456789abcdef.abcdef123456'), '',
    '**后段不足 16 位 → 认不出**（严格按口径判；甲方给的例子后段只有 12 位，'
    + '放宽会让"看着像但不是"的值也命中）');
  eq(T.detectKeyProvider(''), '', '空串 → 认不出（不提示）');
  eq(T.detectKeyProvider('   '), '', '纯空白 → 认不出');
  eq(T.detectKeyProvider('随便乱写的东西'), '', '乱写的 → 认不出（**绝不瞎猜服务商**）');
  eq(T.detectKeyProvider('0123456789abcdef0123456789abcdef'), '',
    '只有前半段（没那个点）→ 认不出，不乱认成智谱');
  eq(T.detectKeyProvider('abcdef0123456789abcdef0123456789.abcdef123456'), '',
    '格式对但长度不对 → 认不出');
  eq(T.detectKeyProvider(null), '', 'null → 不抛异常，返回空');
  eq(T.detectKeyProvider(undefined), '', 'undefined → 空');

  // -------------------------------------------------------------------------
  // 2. 形状与服务商是否匹配（提示文案 + 该切到哪家）
  // -------------------------------------------------------------------------
  block('形状 vs 所选服务商 —— 不一致才提示');
  var same = T.keyProviderHint(DEEPSEEK_KEY, 'deepseek');
  isFalse(same.mismatch, '**一致 → 不提示**');
  eq(same.message, '', '一致时文案为空');
  eq(same.fixIndex, -1, '一致时不给"切到"按钮');

  var cross = T.keyProviderHint(DEEPSEEK_KEY, 'zhipu');
  isTrue(cross.mismatch, '**DeepSeek 的 Key + 选了智谱 → 提示**（真机上就是这个组合）');
  eq(cross.detected, 'deepseek', '认出是 deepseek');
  isTrue(cross.message.indexOf('DeepSeek') > -1, '文案里点出真正该用的那家：'
    + show(cross.message.slice(0, 50)) + '…');
  isTrue(cross.message.indexOf('必须一致') > -1, '并说明"服务商与 Key 必须一致"');
  isTrue(cross.message.indexOf('身份验证失败') > -1, '并说清后果：会报身份验证失败');
  isTrue(cross.fixIndex >= 0, '给了"切到"按钮的下标');
  eq(registered.data.providers[cross.fixIndex].value, 'deepseek', '按钮指向的正是 deepseek');

  var cross2 = T.keyProviderHint(ZHIPU_KEY, 'deepseek');
  isTrue(cross2.mismatch, '智谱的 Key + 选了 DeepSeek → 也提示');
  eq(cross2.detected, 'zhipu', '认出是 zhipu');
  eq(registered.data.providers[cross2.fixIndex].value, 'zhipu', '按钮指向 zhipu');

  var unknown = T.keyProviderHint('乱写的', 'zhipu');
  isFalse(unknown.mismatch, '**认不出形状 → 不提示**（不瞎猜）');
  eq(unknown.fixIndex, -1, '也不给按钮');
  isFalse(T.keyProviderHint('', 'zhipu').mismatch, '空 Key → 不提示');

  // -------------------------------------------------------------------------
  // 3. 输入框联动：打字就提示；切服务商要重算
  // -------------------------------------------------------------------------
  block('页面联动 —— 打字出提示、切服务商重算');
  serve({ config: { ok: true, provider: 'zhipu', model: 'glm-4.7-flash', hasKey: false, masked: '' } });
  ctx.p1 = newPage();
  ctx.p1.onLoad();
  return settle().then(function () {
    eq(ctx.p1.data.aiProviderValue, 'zhipu', '初始服务商是智谱（服务端返回的）');
    eq(ctx.p1.data.aiKeyShapeHint, '', '刚进页面没有形状提示');

    // 粘一个 DeepSeek 的 Key（服务商还停在智谱）
    ctx.p1.onAiKeyInput({ detail: { value: DEEPSEEK_KEY } });
    isTrue(ctx.p1.data.aiKeyShapeHint.indexOf('DeepSeek') > -1,
      '**粘上 DeepSeek 的 Key 立刻出黄字提示**');
    isTrue(ctx.p1.data.aiKeyShapeHint.indexOf('智谱') > -1, '并点出当前选的是智谱');
    isTrue(ctx.p1.data.aiKeyShapeFixIndex >= 0, '给了按钮下标');
    isTrue(ctx.p1.data.aiKeyShapeFixLabel.indexOf('DeepSeek') > -1,
      '按钮文案指名道姓：' + show(ctx.p1.data.aiKeyShapeFixLabel));

    // 切服务商 → 提示必须重算（切过去之后就不该再提示）
    var before = requestCount();
    ctx.p1.onAiProviderChange({ detail: { value: 1 } });
    eq(ctx.p1.data.aiProviderValue, 'deepseek', '切到 DeepSeek 生效');
    eq(ctx.p1.data.aiKeyShapeHint, '',
      '**切换服务商后提示重算 → 现在一致了，黄字消失**');
    eq(ctx.p1.data.aiKeyShapeFixIndex, -1, '按钮也收起来');
    eq(requestCount(), before, '切服务商**不发任何请求**（纯本地）');

    // 切回去 → 提示回来
    ctx.p1.onAiProviderChange({ detail: { value: 0 } });
    isTrue(ctx.p1.data.aiKeyShapeHint.indexOf('DeepSeek') > -1,
      '切回智谱后提示重新出现（重算两个方向都对）');

    // -----------------------------------------------------------------------
    // 4. 「切到 X」按钮：只改选中项，不发请求、不自动保存
    // -----------------------------------------------------------------------
    block('「切到 X」按钮 —— 只改选中项，绝不自动保存');
    var beforeFix = requestCount();
    ctx.p1.onAiFixProvider();
    eq(ctx.p1.data.aiProviderValue, 'deepseek', '按钮把服务商切到了 DeepSeek');
    eq(requestCount(), beforeFix, '**点按钮一个请求都不发**（没有自动保存、没有自动提交）');
    eq(ctx.p1.data.aiKeyShapeHint, '', '切完提示消失（形状对上了）');
    eq(ctx.p1.data.aiHasKey, false, '也**没有**偷偷把 Key 存进去');
    eq(toasts.length, 0, '点按钮不弹任何提示（安静地改选中项就够了）');

    // -----------------------------------------------------------------------
    // 5. 模型输入：留空不带 model 字段；填了就带 trim 的值
    // -------------------------------------------------------------------------
    block('模型输入 —— 留空不带 model，填了带 trim 的值');
    // 先回到智谱 + 填好 Key，避免形状提示干扰
    ctx.p1.onAiProviderChange({ detail: { value: 0 } });
    ctx.p1.onAiKeyInput({ detail: { value: ZHIPU_KEY } });
    eq(ctx.p1.data.aiKeyShapeHint, '', '智谱的 Key + 智谱服务商 → 没有提示');

    callLog.length = 0;
    ctx.p1.setData({ aiModelInput: '' });          // 留空
    ctx.p1.onAiConfigSave();
    return settle().then(function () {
      var payload = lastSavePayload();
      isTrue(!!payload, '留空也能保存（模型不是必填）');
      isFalse(Object.prototype.hasOwnProperty.call(payload, 'model'),
        '**留空 → payload 里完全不带 model 字段**（不是空串）：'
        + show(Object.keys(payload)));
      eq(payload.provider, 'zhipu', '服务商照常带上');
      isTrue(!!payload.api_key, 'Key 照常带上');
      eq(ctx.p1.data.aiModel, 'glm-4.7-flash',
        '保存后状态行显示的是**服务端返回的**模型（而不是本地拼的）');
      eq(ctx.p1.data.aiKeyInput, '', '**保存成功后 Key 输入框清空**（本地不留存）');
      eq(ctx.p1.data.aiModelInput, '', '模型输入框也清空（它现在只是"本次要填的值"）');

      // 填一个带空格的自定义模型 → trim 后提交
      ctx.p1.onAiProviderChange({ detail: { value: 1 } });
      ctx.p1.onAiKeyInput({ detail: { value: DEEPSEEK_KEY } });
      ctx.p1.onAiModelInput({ detail: { value: '  deepseek-reasoner  ' } });
      callLog.length = 0;
      ctx.p1.onAiConfigSave();
      return settle();
    }).then(function () {
      var payload2 = lastSavePayload();
      isTrue(!!payload2, '填了模型照样保存');
      eq(payload2.model, 'deepseek-reasoner', '**model 是 trim 后的值**');
      eq(payload2.provider, 'deepseek', '服务商是 deepseek（Key 形状一致，无提示）');
      eq(ctx.p1.data.aiModel, 'deepseek-reasoner',
        '状态行显示服务端返回的自定义模型');

      // ---------------------------------------------------------------------
      // 6. 超长模型名：本地拦下、不发请求、给人话
      // ---------------------------------------------------------------------
      block('超长模型名 —— 本地拦下，不发请求');
      ctx.p1.onAiKeyInput({ detail: { value: DEEPSEEK_KEY } });
      ctx.p1.onAiModelInput({ detail: { value: new Array(T.MAX_MODEL_CHARS + 5).join('x') } });
      var beforeLong = requestCount();
      toasts.length = 0;
      ctx.p1.onAiConfigSave();
      eq(requestCount(), beforeLong, '**超长时一个请求都不发**（本地就拦下了）');
      isTrue(/过长/.test(ctx.p1.data.aiResultText), '结果行给人话：'
        + show(ctx.p1.data.aiResultText));
      isTrue(ctx.p1.data.aiResultText.indexOf(String(T.MAX_MODEL_CHARS)) > -1,
        '并说明上限是多少字');
      eq(ctx.p1.data.aiKeyInput, DEEPSEEK_KEY,
        '拦下后 Key 输入框内容保留（不用重新粘一遍）');

      // 正好等于上限 → 放行
      ctx.p1.onAiModelInput({ detail: { value: new Array(T.MAX_MODEL_CHARS + 1).join('y') } });
      callLog.length = 0;
      ctx.p1.onAiConfigSave();
      return settle();
    }).then(function () {
      var payload3 = lastSavePayload();
      isTrue(!!payload3, '正好等于上限时不拦，正常提交');
      eq(String(payload3.model).length, T.MAX_MODEL_CHARS, '提交的就是上限长度');

      // ---------------------------------------------------------------------
      // 7. 状态行：服务商 + 实际生效模型；没填 Key 时的口径
      // ---------------------------------------------------------------------
      block('状态行 —— 服务商与实际生效的模型要同时看得见');
      serve({ config: { ok: true, provider: 'deepseek', model: 'deepseek-flash', hasKey: true, masked: '****abcd' } });
      ctx.p2 = newPage();
      ctx.p2.onLoad();
      return settle();
    }).then(function () {
      isTrue(ctx.p2.data.aiStatusDetail.indexOf('DeepSeek') > -1,
        '状态行里有服务商：' + show(ctx.p2.data.aiStatusDetail));
      isTrue(ctx.p2.data.aiStatusDetail.indexOf('deepseek-flash') > -1,
        '状态行里也有实际生效的模型');
      isTrue(ctx.p2.data.aiStatusDetail.indexOf('服务商') > -1
        && ctx.p2.data.aiStatusDetail.indexOf('模型') > -1,
        '两件事都在同一行里（用户一眼能对上）—— 这正是他抱怨"改不了/说错了"的根因');
      // 【回归点】DeepSeek 的默认模型是 deepseek-flash；
      // deepseek-chat / deepseek-reasoner 自 2026-07-24 已停止服务，**绝不能再显示给用户**
      isFalse(ctx.p2.data.aiStatusDetail.indexOf('deepseek-chat') > -1,
        '**状态行里不出现已停服的 deepseek-chat**：' + show(ctx.p2.data.aiStatusDetail));

      // 用户填了自定义模型时，状态行显示**服务端返回**的那个
      serve({ config: { ok: true, provider: 'deepseek', model: 'deepseek-v4-pro', hasKey: true, masked: '****abcd' } });
      ctx.p3 = newPage();
      ctx.p3.onLoad();
      return settle();
    }).then(function () {
      isTrue(ctx.p3.data.aiStatusDetail.indexOf('deepseek-v4-pro') > -1,
        '自定义模型也如实显示：' + show(ctx.p3.data.aiStatusDetail));
      // 模型输入框仍然是空的（当前生效的模型不等于"本次要填的模型"）
      eq(ctx.p3.data.aiModelInput, '', '模型输入框仍为空（当前值在状态行，不预填）');

      // 没填 Key 时的口径
      serve({ config: { ok: true, provider: '', model: '', hasKey: false, masked: '' } });
      ctx.p4 = newPage();
      ctx.p4.onLoad();
      return settle();
    }).then(function () {
      eq(ctx.p4.data.aiStatusType, 'none', '没填 Key → none 态');
      isTrue(/还没填 Key/.test(ctx.p4.data.aiStatusText),
        '文案明确说"还没填 Key"：' + show(ctx.p4.data.aiStatusText));
      isTrue(/预置/.test(ctx.p4.data.aiStatusText), '并说明默认走程序预置的 Key');
      isFalse(/用不了|不可用/.test(ctx.p4.data.aiStatusText),
        '**仍然不出现"用不了/不可用"那类断言**（那是我们刻意避开的）');

      // ---------------------------------------------------------------------
      // 8. 底部"免费获取"跟着服务商变
      // ---------------------------------------------------------------------
      block('底部免费入口 —— 跟着选中的服务商变');
      var zhipuUrl = ctx.p4.data.aiKeyUrl;
      var deepseekIdx = -1;
      registered.data.providers.forEach(function (p, i) { if (p.value === 'deepseek') deepseekIdx = i; });
      isTrue(deepseekIdx >= 0, '找到 deepseek 的下标');
      ctx.p4.onAiProviderChange({ detail: { value: deepseekIdx } });
      isTrue(ctx.p4.data.aiKeyUrl !== zhipuUrl, '**链接跟着换了**：'
        + show(zhipuUrl) + ' → ' + show(ctx.p4.data.aiKeyUrl));
      isTrue(/deepseek/i.test(ctx.p4.data.aiKeyUrl), '换成了 DeepSeek 的地址');
      isTrue(/DeepSeek/.test(ctx.p4.data.aiKeyUrlLabel),
        '平台名也跟着换：' + show(ctx.p4.data.aiKeyUrlLabel));
      isFalse(/智谱开放平台/.test(ctx.p4.data.aiKeyUrlLabel),
        '**不会在选了 DeepSeek 时还只提智谱**');
      isTrue(ctx.p4.data.aiDefaultModelText.indexOf('deepseek-flash') > -1,
        '默认模型提示也跟着换：' + show(ctx.p4.data.aiDefaultModelText));
      // 【这次的事实更正 · 回归点】DeepSeek 的 deepseek-chat / deepseek-reasoner
      // 自 2026-07-24 停止服务。用户看到的这一格正是他抱怨"模型不对"的那一格，
      // 所以"绝不能出现已停服的名字"要在**整页所有展示文案**上钉死。
      var dump4 = JSON.stringify(ctx.p4.data);
      isFalse(dump4.indexOf('deepseek-chat') > -1,
        '**选了 DeepSeek 时，整页 data 里不出现已停服的 deepseek-chat**');
      isFalse(dump4.indexOf('deepseek-reasoner') > -1,
        '也不出现同样已停服的 deepseek-reasoner');
      isTrue(dump4.indexOf('deepseek-flash') > -1, '出现的是现在的 deepseek-flash');
      // hint 文案里顺带说清"这家也能识图"（回应他"识图必须换智谱吗"的困惑）
      isTrue(/多模态|识图/.test(ctx.p4.data.aiProviderHint),
        'DeepSeek 的 hint 里写明它也能识图：' + show(ctx.p4.data.aiProviderHint));

      // ---------------------------------------------------------------------
      // 9. 读配置失败：静默口径（不弹 toast，只灰字）
      // ---------------------------------------------------------------------
      block('读配置失败 —— 不弹 toast，只灰字（沿用本页既有口径）');
      serve({ getFail: 'AI 设置服务暂不可用' });
      toasts.length = 0;          // 清掉前面用例攒下的 toast，只看这一次
      ctx.p5 = newPage();
      ctx.p5.onLoad();
      return settle();
    }).then(function () {
      isTrue(/读取 AI 设置失败/.test(ctx.p5.data.aiResultText),
        '结果行如实说明：' + show(ctx.p5.data.aiResultText));
      isTrue(/AI 设置服务暂不可用/.test(ctx.p5.data.aiResultText), '并带上服务端原话');
      eq(toasts.length, 0,
        '**没有弹 toast**（进页面顺手读一次的辅助信息失败不打扰用户）');
      // 【这条是真机上漏过的】"静默"是**端到端**验的：本文件用的是**真实的
      // utils/api.js**（只 stub 了最底层 wx.cloud.callFunction），而 api.js 的
      // callCloudFunction 在非静默失败时**自己会弹 toast** —— 所以上面那句
      // "toasts.length === 0" 就是 silent 真的生效的证据。
      // ⚠️ 附带发现：api.js 的 `aiConfigGet(options)` 声明了形参却**没把 options
      //    传给 call()**（utils/api.js:662），所以那个开关**没法通过它使用**。
      //    本页因此改用 api.js 公开导出的核心 `api.call('ai_config_get', null, {silent:true})`。
      //    这里断言的就是"我们走的是那条能生效的路"。
      var gets = callLog.filter(function (c) { return c.data.action === 'ai_config_get'; });
      isTrue(gets.length > 0, '确实发过一次 ai_config_get');
      isTrue(typeof api.call === 'function',
        'api.js 导出了核心 call()（本页靠它把 silent 传下去）');

      // ---------------------------------------------------------------------
      // 10. 安全口径没变：本地不留存原文、只回掩码
      // ---------------------------------------------------------------------
      block('安全口径 —— 原文不上屏、提交后清空、只留掩码');
      serve({});
      ctx.p6 = newPage();
      ctx.p6.onLoad();
      return settle().then(function () {
        ctx.p6.onAiKeyInput({ detail: { value: DEEPSEEK_KEY } });
        ctx.p6.onAiProviderChange({ detail: { value: 1 } });
        ctx.p6.onAiConfigSave();
        return settle();
      }).then(function () {
        var dump = JSON.stringify(ctx.p6.data);
        isFalse(dump.indexOf(DEEPSEEK_KEY) > -1, '**页面 data 里不出现 Key 原文**');
        isFalse(dump.indexOf(DEEPSEEK_KEY.slice(3)) > -1, '也不出现原文片段');
        isTrue(dump.indexOf('****' + DEEPSEEK_KEY.slice(-4)) > -1 || dump.indexOf('****') > -1, '只有掩码');
        eq(ctx.p6.data.aiKeyInput, '', '提交后输入框清空');
        eq(ctx.p6.data.aiHasKey, true, '状态变成"已填自己的 Key"');
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
    if (require.main === module) H.report('我的页 —— AI 设置（模型可填 / Key 与服务商匹配）');
  })
  .catch(function (err) {
    restoreGlobals();
    console.error('me AI 设置测试自己崩了：', err);
    process.exit(2);
  });

module.exports = { done: done };
