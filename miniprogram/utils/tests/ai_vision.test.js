/**
 * utils/tests/ai_vision.test.js —— 课表截图识别（云函数 aiParse 的 action:'parse_image'）
 * 的契约与容错（纯 node 单测，**零网络**）。
 *
 * 跑法：
 *     node utils/tests/ai_vision.test.js   # 只跑这一份（末尾打印通过数，失败退出码 1）
 *     node utils/tests/run.js              # 跑全部（本文件会被自动 require）
 *
 * 【这个功能要守住什么】用户拿**自己的 Key** 让多模态模型认课表截图，所以：
 *   1. 模型不支持识图时，必须**明确告诉他换模型**（而不是抛一句看不懂的服务端报错），
 *      并且**一个请求都不发**（省他的钱与时间）—— 事前名单 + 事后关键词，两条腿都要测；
 *   2. base64 是用户隐私，**不许进日志、不许进错误信息**（这里直接断言 error 里搜不到它）；
 *   3. 图片路径的超时必须与文本路径分开（45 秒 vs 15 秒），超时要能与其它失败区分开；
 *   4. 识别出的课程必须带 repeat:'weekly' + periods + week_*，否则课表页不会每周排它
 *      （课表类任务的判据在 cloudfunctions/tasks/lib/normalize.js 的 isCourseTask）。
 *
 * 【怎么做到零网络】把云函数内部的 `exports.postJson` 换掉（module.exports.postJson 是
 * 同一个函数对象，替换有效；chatCompletionVision 里刻意走 exports 调用就是为了这一步）。
 * 整条解析/归一化链路都真跑，但一个字节都不出网。
 *
 * 【加载期纪律（踩过坑）】本文件在**加载期只注册、不装全局桩、不启动异步链**：
 * 装桩与执行都推迟到 done 被 await 的那一刻。原因是 run.js 会串行加载多个要改
 * global.wx 的测试文件，顶层起链会让续体跑在别人的桩上（表现为"单独跑全绿、经 run.js 就崩"）。
 */

'use strict';

var path = require('path');
var fs = require('fs');
var H = require(path.join(__dirname, 'harness.js'));

var eq = H.eq;
var eqArr = H.eqArr;
var isTrue = H.isTrue;
var isFalse = H.isFalse;
var block = H.block;
var show = H.show;

var ROOT = path.join(__dirname, '..', '..');
var PAGE_PATH = path.join(ROOT, 'pages', 'ai', 'ai.js');
var AI_PARSE_PATH = path.join(ROOT, 'cloudfunctions', 'aiParse', 'index.js');

var aiParseFn = require(AI_PARSE_PATH);
var aiDecomposeFn = require(path.join(ROOT, 'cloudfunctions', 'aiDecompose', 'index.js'));
// tasks 云函数那份**真判据**（isCourseTask）：识别出的课程必须被判成"课表类任务"，
// 否则「替换课表」删不到它、周视图也不会把它当课程。引用它而不是自己再写一遍，
// 就是为了"两边判据不许漂移"这件事当场可见。
var tasksNormalize = require(path.join(ROOT, 'cloudfunctions', 'tasks', 'lib', 'normalize.js'));
// api.js 依赖全局 wx，但**加载期**不碰它（只在真正调用时才读 wx.cloud），所以 require 是安全的
var api = require(path.join(ROOT, 'utils', 'api.js'));

// ---------------------------------------------------------------------------
// 测试数据与小工具
// ---------------------------------------------------------------------------

/**
 * 一张"照片"的替身：真实 JPEG 的 base64 头（/9j/ = FF D8 FF）+ 一些填充字符。
 * 它不是真图片（服务商那边也不会真收到，postJson 被换掉了），但形状与真实产物一致。
 */
var SAMPLE_BASE64 = '/9j/' + new Array(400).join('A');

/** 云函数的 base64 上限（900000 字符） */
var MAX_CHARS = aiParseFn.MAX_IMAGE_BASE64_CHARS;

/** 会被临时改动的环境变量（每个用例跑完都要还原） */
var ENV_KEYS = ['ZHIPU_API_KEY', 'DEEPSEEK_API_KEY', 'LLM_PROVIDER', 'LLM_MODEL'];

/** 设置环境变量，返回"还原"函数（用后就调，别把改动留给别的测试） */
function withEnv(vars) {
  var saved = {};
  ENV_KEYS.forEach(function (name) { saved[name] = process.env[name]; });
  ENV_KEYS.forEach(function (name) { delete process.env[name]; });
  Object.keys(vars || {}).forEach(function (name) { process.env[name] = vars[name]; });
  return function restore() {
    ENV_KEYS.forEach(function (name) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    });
  };
}

/** 自测注入用的"配置"：假 Key（不会出网）+ 指定模型；disableDb = 不查用户自填的那条记录 */
function visionOptions(overrides) {
  return Object.assign({
    env: { ZHIPU_API_KEY: 'test-key-not-used', LLM_MODEL: 'glm-5.3-flash' },
    disableDb: true,
    openid: ''
  }, overrides || {});
}

/** 一次识图请求的入参（各用例只覆盖自己关心的字段） */
function imageEvent(overrides) {
  return Object.assign({
    action: 'parse_image',
    image_base64: SAMPLE_BASE64,
    mime_type: 'image/jpeg',
    week_monday: '2026-09-07',      // 周一
    semester_start: '2026-09-07',
    week_start: 1,
    week_end: 20,
    period_times: { '5': ['11:45', '12:25'] }
  }, overrides || {});
}

/**
 * 把云函数的 postJson 换成假的，并记录每次调用。
 * @param {Function} handler (index, url, payload) → Promise<{status, text}>
 * @returns {{calls: Array, restore: Function}}
 */
function stubPostJson(handler) {
  var state = { calls: [], restored: false };
  var real = aiParseFn.postJson;
  aiParseFn.postJson = function (url, payload, headers, timeoutMs) {
    state.calls.push({ url: url, payload: payload, headers: headers, timeoutMs: timeoutMs });
    return handler(state.calls.length - 1, url, payload);
  };
  state.restore = function () {
    if (state.restored) return;
    state.restored = true;
    aiParseFn.postJson = real;
  };
  return state;
}

/** 假的服务商成功响应（把一段文本当成模型的回答） */
function modelReply(text) {
  return Promise.resolve({
    status: 200,
    text: JSON.stringify({ choices: [{ message: { content: text } }] })
  });
}

/** 假的服务商失败响应 */
function httpFail(status, body) {
  return Promise.resolve({ status: status, text: body });
}

/** 跑一次识图：装桩 → 调云函数 → 无论成败都还原桩 */
function runVision(content, eventOverrides, optionsOverrides) {
  var stub = stubPostJson(function () { return modelReply(content); });
  return Promise.resolve()
    .then(function () {
      return aiParseFn.handleParseImage(imageEvent(eventOverrides), visionOptions(optionsOverrides));
    })
    .then(function (res) {
      stub.restore();
      return { res: res, calls: stub.calls };
    }, function (err) {
      stub.restore();
      throw err;
    });
}

/** 跑一次识图，postJson 返回指定的 HTTP 失败 */
function runVisionHttp(status, body, eventOverrides, optionsOverrides) {
  var stub = stubPostJson(function () { return httpFail(status, body); });
  return Promise.resolve()
    .then(function () {
      return aiParseFn.handleParseImage(imageEvent(eventOverrides), visionOptions(optionsOverrides));
    })
    .then(function (res) {
      stub.restore();
      return { res: res, calls: stub.calls };
    }, function (err) {
      stub.restore();
      throw err;
    });
}

/** 假模型回答：3 门课，覆盖"日期换算 / 节次 / 周次 / 时间从作息表补"几条路 */
var MODEL_JSON = JSON.stringify({
  courses: [
    { title: '高等数学', weekday: 1, periods: '1-2', weeks: '1-16', start_time: '08:00', end_time: '09:40', location: '教三201' },
    { title: '大学物理', weekday: 3, periods: '3-5', weeks: '1-16单', location: '致理楼305' },
    { title: '英语视听说', weekday: 7, periods: '7', weeks: '单周' }
  ],
  period_times: { '1': ['08:00', '08:45'], '2': ['08:55', '09:40'], '3': ['10:00', '10:45'], '5': ['14:00', '14:45'] },
  warnings: ['第 3 行有一门课被水印挡住，已跳过'],
  notes: '共识别出 3 门课'
});

// ---------------------------------------------------------------------------
// 页面注册对象：**必须缓存失效后重新 require**
// ---------------------------------------------------------------------------
// 为什么：pages/ai/ai.js 只 `Page({...})`、不导出 module.exports，所以只能靠桩函数接住它。
// 而 run.js 里 ai_page.test.js 已经先 require 过这个文件 —— require 缓存命中时不会再次
// 调用 Page()，我们就什么都拿不到。这里删掉那条缓存再 require 一次，让它在**我自己的桩**下
// 重新注册（ai_page.test.js 此时早已跑完，它手里留着自己那份对象，不受影响）。
// 加载期只做这一件事，且马上把 global.Page 还原。
var pageObj = null;
var pageError = null;
(function loadPage() {
  var savedPage = global.Page;
  try {
    delete require.cache[require.resolve(PAGE_PATH)];
    global.Page = function (options) { pageObj = options; };
    require(PAGE_PATH);
  } catch (err) {
    pageError = err;
  }
  if (savedPage === undefined) delete global.Page; else global.Page = savedPage;
})();

// ---------------------------------------------------------------------------
// 从云函数**源码文本**里抽数组（用来钉住"两边名单必须一致"）
// ---------------------------------------------------------------------------

/**
 * 把源码里所有 `键: [ "a", "b" ]` 里的字符串抽出来（并集）。
 *
 * 【为什么要读源码而不是读运行时导出】这条断言的意义正是"两边改不同步就红"：
 * 运行时导出只能证明云函数自己一致，证明不了 api.js 里那份抄得对不对。
 * 读源码文本，就等于把"云函数里真实存在的那几个名字"与 api.js 的名单直接对账。
 * 两个服务商各有一份（智谱非空、DeepSeek 为空），所以这里取并集。
 *
 * @param {string} source 源码文本
 * @param {string} key 字段名（visionModels / textOnlyModels）
 * @returns {string[]} 去重后的模型名
 */
function stringArraysFromSource(source, key) {
  var pattern = new RegExp(key + '\\s*:\\s*\\[([\\s\\S]*?)\\]', 'g');
  var found = [];
  var matched = pattern.exec(source);
  while (matched) {
    var inner = matched[1].match(/'([^']+)'|"([^"]+)"/g) || [];
    inner.forEach(function (quoted) {
      var name = quoted.slice(1, -1);
      if (found.indexOf(name) === -1) found.push(name);
    });
    matched = pattern.exec(source);
  }
  return found;
}

// ===========================================================================
// 正式用例
// ===========================================================================
function run() {
  var source = fs.readFileSync(AI_PARSE_PATH, 'utf8');
  // 跨 .then 传递的桩 / 页面实例（var 写在回调里会串作用域）
  var visionStub = null;
  var ctx = {};
  // 节次反推那组用到的固定数据（在 out4 那一步赋值，out18 那一步才用）
  var CALIBRATED = null;
  var NO_PERIOD_MODEL = '';

  // ---- 0. 文件可加载 ----
  block('识图 —— 文件可加载');
  isFalse(!!pageError, 'pages/ai/ai.js 加载期没有抛异常'
    + (pageError ? '（实际：' + pageError.message + '）' : ''));
  isTrue(!!pageObj, 'Page() 注册对象拿到了');
  var T = (pageObj && pageObj.__test) || {};
  isTrue(!!T.buildParseItems, '页面通过 __test 暴露了 buildParseItems');

  // ---- 1. 列表一致性（云函数源码 ↔ 云函数运行时 ↔ api.js）----
  block('识图 —— 识图模型名单：云函数源码 / 运行时 / api.js 三处必须一致');
  var visionFromSource = stringArraysFromSource(source, 'visionModels');
  var textOnlyFromSource = stringArraysFromSource(source, 'textOnlyModels');
  isTrue(visionFromSource.length > 0,
    '从云函数源码里抽到了"支持识图"的名单（抽不到就是正则失效，会变成假绿）：' + show(visionFromSource));
  isTrue(textOnlyFromSource.length > 0, '从云函数源码里抽到了"不支持识图"的名单');

  var runtimeVision = aiParseFn.visionModelLists('zhipu').vision;
  eq(visionFromSource.slice().sort().join(','), runtimeVision.slice().sort().join(','),
    '源码里那份 == 运行时 visionModelLists() 那份（证明上面那个正则确实读的是同一处）');
  eq(api.VISION_HINT_MODELS.slice().sort().join(','), visionFromSource.slice().sort().join(','),
    '**api.js 的 VISION_HINT_MODELS 与云函数的名单逐字一致**（只改一边这条就红）');
  eq(api.VISION_TEXT_ONLY_MODELS.slice().sort().join(','), textOnlyFromSource.slice().sort().join(','),
    '**api.js 的 VISION_TEXT_ONLY_MODELS 与云函数的名单逐字一致**');

  var visionNames = visionFromSource.join(',');
  ['glm-5.3-flash', 'glm-5.3-flashx', 'glm-ocr', 'glm-4v', 'glm-4v-plus', 'glm-4v-flash',
    'glm-4.1v-thinking-flash', 'glm-4.5v', 'glm-4.6v'].forEach(function (name) {
    isTrue(visionNames.indexOf(name) !== -1, '智谱的名单纯粹支持列表里有 ' + name);
  });
  isTrue(textOnlyFromSource.indexOf('glm-4.7-flash') !== -1,
    '项目当前的默认模型 glm-4.7-flash 在"不支持识图"名单里（它就是本需求要拦的那个例子）');
  eq(aiParseFn.PROVIDERS.deepseek.visionModels.length, 0,
    'DeepSeek 的识图支持列表是空的（它目前没有多模态模型）');
  eq(JSON.stringify(aiDecomposeFn.PROVIDERS), JSON.stringify(aiParseFn.PROVIDERS),
    '两个云函数的 PROVIDERS 表仍然逐字一致（_selftest 8b.1 的那条不变量）');

  // 运行时三态：纯函数，直接喂名字
  eq(aiParseFn.visionSupportOf('glm-5.3-flash', 'zhipu'), true, "visionSupportOf('glm-5.3-flash') → true");
  eq(aiParseFn.visionSupportOf('  GLM-OCR ', 'zhipu'), true, '大小写与空白不影响判定');
  eq(aiParseFn.visionSupportOf('glm-4.7-flash', 'zhipu'), false, "visionSupportOf('glm-4.7-flash') → false");
  eq(aiParseFn.visionSupportOf('deepseek-chat', 'deepseek'), false, "visionSupportOf('deepseek-chat') → false");
  eq(aiParseFn.visionSupportOf('', 'zhipu'), 'unknown', '空模型名 → unknown（不代表任何模型）');
  eq(aiParseFn.visionSupportOf('some-brand-new-vlm', 'zhipu'), 'unknown',
    '没收录的模型 → unknown（照常尝试，让服务端报错说话）');

  // api.js 那份三态判定必须与云函数同口径
  eq(api.classifyVisionModel('glm-5.3-flash'), true, 'api.classifyVisionModel 已知支持 → true');
  eq(api.classifyVisionModel('glm-4.7-flash'), false, 'api.classifyVisionModel 已知纯文本 → false');
  eq(api.classifyVisionModel('glm-4.7'), 'unknown', 'api.classifyVisionModel 没收录 → unknown');
  eq(api.classifyVisionModel(''), 'unknown', 'api.classifyVisionModel 空串 → unknown');
  eq(api.classifyVisionModel(null), 'unknown', 'api.classifyVisionModel null → unknown（不抛异常）');
  eq(api.classifyVisionModel('zhipu/glm-5.3-flash'), true, '带 provider/ 前缀也能认出来');
  eq(api.effectiveModelName('', ''), aiParseFn.PROVIDERS.zhipu.defaultModel,
    '用户没填模型时按智谱默认模型算（与云函数的默认值一致）');
  eq(api.effectiveModelName('deepseek', ''), aiParseFn.PROVIDERS.deepseek.defaultModel,
    'DeepSeek 没填模型时按 deepseek-chat 算');
  eq(api.effectiveModelName('zhipu', 'glm-5.3-flash'), 'glm-5.3-flash', '填了就用自己的');

  // ---- 2. 请求体：URL / 模型 / 参数 / 超时 / 图片传法 ----
  block('识图 —— 请求体构造（模型 + Base64 Data URL + 45 秒超时）');
  return runVision(MODEL_JSON).then(function (out) {
    var res = out.res;
    var calls = out.calls;
    eq(calls.length, 1, '恰好发了一次请求（桩确实被调用到，没静默绕过）');
    eq(calls[0].url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions', '打到白名单里的智谱端点');
    eq(calls[0].timeoutMs, 45000, '**图片路径用独立的 45 秒超时**（文本路径仍是 15 秒）');
    eq(aiParseFn.TIMEOUT_MS, 15000, '顺带钉住：文本路径的 15 秒没被这次改动动过');
    eq(calls[0].payload.model, 'glm-5.3-flash', '模型名来自配置（用户设置 / 环境变量），不是 event 里的');
    eq(calls[0].payload.temperature, 1, '智谱对 glm-5.3-flash 推荐的 temperature=1');
    eq(calls[0].payload.top_p, 0.95, '推荐的 top_p=0.95');
    isFalse(Object.prototype.hasOwnProperty.call(calls[0].payload, 'response_format'),
      '**不带 response_format**（thinking 只能 enabled，JSON 靠提示词约束 + 容错解析）');
    eq(calls[0].payload.stream, false, 'stream:false');
    eq(calls[0].headers.Authorization, 'Bearer test-key-not-used', 'Key 从服务端读出来（自测里是注入的假 Key）');

    var messages = calls[0].payload.messages;
    eq(messages.length, 2, 'system + user 两条消息');
    eq(messages[0].role, 'system', '第一条是 system');
    isTrue(messages[0].content.indexOf('2026-09-07') !== -1, '提示词里给了本周周一（日期基准）');
    isTrue(messages[0].content.indexOf('1-16') !== -1 && messages[0].content.indexOf('周次') !== -1,
      '提示词里给了周次要求与写法示例');
    isTrue(messages[0].content.indexOf('11:45') !== -1, '提示词里带上了用户已校准的作息');
    isTrue(messages[0].content.indexOf('不要输出日期') !== -1, '明确要求模型不要自己算日期');
    isTrue(messages[0].content.indexOf('"courses"') !== -1, '给了明确的输出字段说明与 JSON 示例');

    var content = messages[1].content;
    isTrue(Array.isArray(content), 'user 的 content 是数组（多模态写法）');
    eq(content.length, 2, '一段文字 + 一张图片');
    eq(content[1].type, 'image_url', '图片用 image_url 类型');
    eq(content[1].image_url.url.indexOf('data:image/jpeg;base64,'), 0,
      '图片按 **Base64 Data URL** 传（官方支持这种传法）');
    isTrue(content[1].image_url.url.indexOf(SAMPLE_BASE64) !== -1, 'Data URL 里就是那张图');

    // ---- 3. 成功响应的字段与归一化 ----
    block('识图 —— 成功响应的字段（events/deadlines/tasks 同长同序）');
    eq(res.ok, true, '成功 → ok:true');
    eq(Object.keys(res).sort().join(','),
      'deadlines,events,model,notes,ok,period_times,provider,tasks,warnings',
      '返回对象顶层字段与识图契约一致');
    eq(res.provider, 'zhipu', 'provider 回显');
    eq(res.model, 'glm-5.3-flash', 'model 回显');
    eq(res.events.length, 3, '认出 3 门课');
    eq(res.deadlines.length, 0, '课表截图里没有截止事项 → deadlines 恒为空数组');
    eq(res.tasks.length, res.events.length, '**tasks 与 events 同长**（前端按下标配对的前提）');
    isTrue(res.warnings.length >= 1, '把模型自己说的"哪里没看清"带回来了：' + show(res.warnings));
    eq(res.warnings[0], '第 3 行有一门课被水印挡住，已跳过', 'warnings 原样带给用户');
    eq(res.notes, '共识别出 3 门课', 'notes 原样带回');
    isTrue(!!res.period_times && res.period_times['1'][0] === '08:00',
      '截图里读出的作息一起返回（前端导入成功后落库）');

    // 【安全红线】base64 不许出现在任何返回内容里
    eq(JSON.stringify(res).indexOf(SAMPLE_BASE64.slice(0, 100)), -1,
      '**返回体里搜不到 base64**（图片只在这一次请求的内存里）');

    // ---- 4. weekday → date（服务端算，跨周不能串）----
    block('识图 —— weekday → date 由服务端换算（week_monday + weekday-1）');
    eq(res.events[0].date, '2026-09-07', 'weekday=1 → 本周周一当天');
    eq(res.events[1].date, '2026-09-09', 'weekday=3 → 周三');
    eq(res.events[2].date, '2026-09-13', '**weekday=7 → 周日 2026-09-13**（不跨到下一周的周一）');
    eq(aiParseFn.weekdayDate('2026-09-07', 7), '2026-09-13', 'weekdayDate 跨周换算');
    eq(aiParseFn.weekdayDate('2026-09-07', 1), '2026-09-07', 'weekdayDate 周一');
    eq(aiParseFn.weekdayDate('2026-09-07', 0), '', 'weekday=0 非法 → 空串');
    eq(aiParseFn.weekdayDate('2026-09-07', 8), '', 'weekday=8 非法 → 空串');
    eq(aiParseFn.weekdayDate('不是日期', 3), '', 'week_monday 非法 → 空串（不瞎算）');

    // ---- 5. 课程字段（课表类任务的判据）----
    block('识图 —— 课程字段：repeat/periods/week_*（课表页靠它们每周排课）');
    res.tasks.forEach(function (task, index) {
      eq(task.type, 'event', '第 ' + (index + 1) + ' 门课 type 固定 event');
      eq(task.repeat, 'weekly', '第 ' + (index + 1) + ' 门课 repeat=weekly');
      isTrue(!!task.periods, '第 ' + (index + 1) + ' 门课带 periods（空的话不算课表类任务）');
    });
    // 直接拿 tasks 云函数那份**真判据**来校验：识别出的课程必须被判成"课表类"，
    // 否则「替换课表」删不到它、也不会被当成课程（判据见 normalize.js 的 isCourseTask）
    res.tasks.forEach(function (task, index) {
      isTrue(tasksNormalize.isCourseTask(task),
        '第 ' + (index + 1) + ' 门课通过 tasks 云函数的 isCourseTask（repeat=weekly 且 periods 非空）');
    });
    isFalse(tasksNormalize.isCourseTask({ repeat: 'weekly', periods: '' }),
      '（反向自检）weekly 但没节次 → 不算课表类任务');
    eq(res.tasks[0].periods, '1-2', '节次原样归一化成 "1-2"');
    eq(res.tasks[1].periods, '3-5', '节次 "3-5"');
    eq(res.tasks[2].periods, '7', '单节写成 "7"（与云函数 tasks 的 normalizePeriods 同口径）');
    eq(res.tasks[0].week_start, 1, '"1-16" → week_start=1');
    eq(res.tasks[0].week_end, 16, '"1-16" → week_end=16');
    eq(res.tasks[0].week_parity, 'all', '"1-16" → all（每周）');
    eq(res.tasks[1].week_parity, 'odd', '"1-16单" → 单周');
    eq(res.tasks[2].week_parity, 'odd', '"单周" → 单周');
    eq(res.tasks[2].week_start, 1, '"单周"没写范围 → 用默认起始周');
    eq(res.tasks[2].week_end, 20, '"单周"没写范围 → 用请求里的默认结束周');
    eq(res.tasks[0].location, '教三201', '教室带上了');
    eq(res.tasks[0].priority, 'mid', '课程默认优先级 mid');
    eq(res.events[0].priority, '中', 'events 里的优先级是中文标签（界面上直接显示）');
    eq(res.events[0].repeat, 'weekly', 'events 也带 repeat（前端显示"每周"用）');
    eq(res.tasks[0].done, false, 'done 默认 false');
    eq(res.tasks[0].parent_id, null, 'parent_id 默认 null');
    eq(res.tasks[0].estimate_min, 0, '不猜耗时（截图里没有这个信息）');

    // 时间：模型写了的用模型的；没写的按节次查作息表
    eq(res.tasks[0].start_time, '08:00', '模型读出的开始时间原样保留');
    eq(res.tasks[0].end_time, '09:40', '模型读出的结束时间原样保留');
    eq(res.tasks[1].start_time, '10:00', '模型没写时间 → 按节次从作息表补（第 3 节 10:00）');
    eq(res.tasks[1].end_time, '12:25',
      '结束时间取第 5 节的下课时间，且**用户已校准的作息优先于截图里读出来的**');
    eq(res.tasks[1].start_time !== '' && res.tasks[1].end_time !== '', true, '第 2 门课有完整时间');

    // ---- 6. 三种"模型不老实"的回答都要能解析 ----
    block('识图 —— 容错解析：```json 围栏 / 前后有解释文字 / 字段缺失');
    var fenced = '```json\n' + MODEL_JSON + '\n```';
    var prose = '好的，我看到了这份课表，识别结果如下：\n' + MODEL_JSON + '\n以上。';
    return runVision(fenced).then(function (out2) {
      eq(out2.res.ok, true, 'Markdown 代码块围栏里的 JSON 能解出来');
      eq(out2.res.tasks.length, 3, '内容完整（3 门课）');
      return runVision(prose);
    }).then(function (out3) {
      eq(out3.res.ok, true, '前后带解释文字也能解出来');
      eq(out3.res.tasks[0].title, '高等数学', '解出来的课程名正确');

      // 字段缺失：不给 periods / weeks / 时间，外加两条脏条目（没课名 / 缺星期几）
      var missing = JSON.stringify({
        courses: [
          { title: '体育', weekday: 6 },
          { title: '只有星期几', weekday: 2 },
          { weekday: 4, periods: '9' },
          { title: '节次乱写', weekday: 5, periods: '第好几节', weeks: '看不懂的周次' }
        ]
      });
      return runVision(missing);
    }).then(function (out4) {
      var r = out4.res;
      eq(r.ok, true, '字段缺失时仍然 ok:true（能救的都救，救不了的进 warnings）');
      eq(r.tasks.length, 3, '4 条里留下 3 条（没课程名的那条被丢掉）');
      var titles = r.tasks.map(function (item) { return item.title; }).join(',');
      eq(titles, '体育,只有星期几,节次乱写', '丢掉的是"没有课程名"那条，其余保留');
      isTrue(r.warnings.join('|').indexOf('没有课程名') !== -1,
        '**被丢掉的条目进了 warnings**（不是静默消失）：' + show(r.warnings));
      isTrue(r.warnings.join('|').indexOf('节次') !== -1,
        '节次认不出来也给了提示：' + show(r.warnings));
      isTrue(r.warnings.join('|').indexOf('周次') !== -1, '周次认不出来也给了提示');
      eq(r.tasks[0].periods, '', '没写节次 → periods 留空（不瞎猜一个节次）');
      eq(r.tasks[0].week_start, 1, '没写周次 → 默认起始周 1');
      eq(r.tasks[0].week_end, 20, '没写周次 → 默认结束周 20');
      eq(r.tasks[2].periods, '', '节次写成"第好几节" → 留空');
      eq(r.tasks[2].week_parity, 'all', '周次乱写 → 退回默认（每周）');

      // ---- 7. weeks 文本归一化（纯函数逐条）----
      block('识图 —— weeks 文本归一化');
      var d = { week_start: 1, week_end: 20 };
      var w1 = aiParseFn.normalizeWeeksText('1-16', d);
      eq(w1.week_start, 1, '"1-16" → 起周 1');
      eq(w1.week_end, 16, '"1-16" → 止周 16');
      eq(w1.week_parity, 'all', '"1-16" → 每周');
      eq(w1.warning, '', '"1-16" 是标准写法 → 不报警');
      eq(aiParseFn.normalizeWeeksText('第1-16周', d).week_end, 16, '"第1-16周" 也认');
      eq(aiParseFn.normalizeWeeksText('双周', d).week_parity, 'even', '"双周" → even');
      eq(aiParseFn.normalizeWeeksText('单周', d).week_parity, 'odd', '"单周" → odd');
      eq(aiParseFn.normalizeWeeksText('3', d).week_start, 3, '只写一个数字 → 就那一周');
      eq(aiParseFn.normalizeWeeksText('1-16双', d).week_parity, 'even', '"1-16双" → 双周');
      eq(aiParseFn.normalizeWeeksText('１-１６', d).week_end, 16, '全角数字也认');
      var gap = aiParseFn.normalizeWeeksText('1-8,10-16', d);
      eq(gap.week_start, 1, '断档写法取最小起周');
      eq(gap.week_end, 16, '断档写法取最大止周');
      isTrue(gap.warning.indexOf('1-16') !== -1, '断档要**如实说明**按 1-16 导入：' + show(gap.warning));
      var junk = aiParseFn.normalizeWeeksText('随便写的', d);
      eq(junk.week_start, 1, '乱写 → 用默认起始周');
      eq(junk.week_end, 20, '乱写 → 用默认结束周');
      isTrue(junk.warning.length > 0, '**乱写要有 warning**，不能静默用默认值：' + show(junk.warning));
      var outOfRange = aiParseFn.normalizeWeeksText('1-99', d);
      eq(outOfRange.week_end, 20, '超出 1-30 周 → 退回默认范围');
      isTrue(outOfRange.warning.length > 0, '越界也有 warning');
      eq(aiParseFn.normalizeWeeksText('', { week_start: 5, week_end: 15 }).week_start, 5,
        '空周次 → 用请求给的默认范围（截图里没写周次是常态，不报警）');

      // ---- 7b. 节次反推：模型没认过节次、但给了时间 ----
      //   【为什么单列一组】不推的话这条记录是"删不掉的孤儿"：它 repeat=weekly 但没有
      //   periods，于是下次「替换课表」的判据（isCourseTask）认为它不是课程、删不掉，
      //   追加导入又会留下同名的第二份 —— 用户会看到"我点了替换怎么还多一条重的"。
      block('识图 —— 节次没认出来时按时间反推（否则「替换课表」下次删不掉它）');
      CALIBRATED = { '3': ['10:15', '10:55'], '4': ['11:00', '11:40'], '5': ['11:45', '12:25'] };
      NO_PERIOD_MODEL = JSON.stringify({
        courses: [
          { title: '没有节次的课', weekday: 2, start_time: '10:20', end_time: '11:30' },
          { title: '时间在课表外', weekday: 3, start_time: '06:00', end_time: '06:30' },
          { title: '只给了下课时间', weekday: 4, end_time: '12:00' },
          { title: '模型给了节次', weekday: 5, periods: '7-8', start_time: '10:20', end_time: '11:30' }
        ]
      });
      return runVision(NO_PERIOD_MODEL, { period_times: CALIBRATED });
    }).then(function (out18) {
      var r = out18.res;
      eq(r.ok, true, '反推这条链路整体仍然是 ok:true');
      eq(r.tasks[0].periods, '3-4', '**时间落在第 3-4 节 → 推成 "3-4"**');
      isTrue(tasksNormalize.isCourseTask(r.tasks[0]),
        '推出来的条目能被 tasks 的 isCourseTask 判成课程 → 下次「替换课表」删得掉它');
      isTrue(r.warnings.join('|').indexOf('已按时间推成第 3-4 节') !== -1,
        '**如实说明是推出来的**（不假装模型认出来了、也不静默改数据）：' + show(r.warnings));
      isTrue(r.warnings.join('|').indexOf('请确认') !== -1, '并请用户确认一句');
      eq(r.tasks[0].start_time, '10:20', '反推不影响模型给的时间');
      eq(r.tasks[0].end_time, '11:30', '（同上）');

      eq(r.tasks[1].periods, '', '**时间落在整张作息表之外 → 保持空串**（不硬塞一个节次）');
      isTrue(r.warnings.join('|').indexOf('不会排进课表格子') !== -1, '并且保留原来那句 warning');

      eq(r.tasks[2].periods, '5', '**只给了下课时间 12:00 → 按退化口径推成单个节次 "5"**');
      eq(r.tasks[2].periods.indexOf('-'), -1, '写法是 "5" 而不是 "5-5"');
      eq(r.tasks[2].start_time, '11:45', '顺手把这一节的开始时间补上（作息表里的值）');

      eq(r.tasks[3].periods, '7-8', '**模型给了合法节次就不许动它**（哪怕按时间推出来是 3-4）');
      isTrue(r.warnings.join('|').indexOf('「模型给了节次」的节次没认出来') === -1,
        '没覆盖模型的值时也不该报"没认出来"');

      eq(aiParseFn.derivePeriodsFromTimes('10:20', '11:30', CALIBRATED), '3-4', '纯函数：跨两节 → "3-4"');
      eq(aiParseFn.derivePeriodsFromTimes('10:20', '10:30', CALIBRATED), '3', '纯函数：只落在一节 → "3"');
      eq(aiParseFn.derivePeriodsFromTimes('', '12:00', CALIBRATED), '5', '纯函数：只有结束时间 → 按时刻落点');
      eq(aiParseFn.derivePeriodsFromTimes('10:20', '', CALIBRATED), '3', '纯函数：只有开始时间 → 按时刻落点');
      eq(aiParseFn.derivePeriodsFromTimes('06:00', '06:30', CALIBRATED), '', '纯函数：全在表外 → 空串');
      eq(aiParseFn.derivePeriodsFromTimes('', '', CALIBRATED), '', '纯函数：两个时间都没有 → 空串（不瞎猜）');
      eq(aiParseFn.derivePeriodsFromTimes('10:20', '11:30', null), '', '纯函数：没有作息表 → 空串');
      eq(aiParseFn.derivePeriodsFromTimes('11:30', '10:20', CALIBRATED), '4',
        '纯函数：时间倒挂（脏数据）→ 退回"按开始时刻落点"（11:30 在第 4 节），不返回倒挂区间');

      // 客户端没传 period_times → 不许凭内置默认作息瞎填
      return runVision(NO_PERIOD_MODEL, { period_times: null });
    }).then(function (out19) {
      var r = out19.res;
      eq(r.tasks[0].periods, '', '**没有 period_times 就不推导**（不能凭内置默认作息瞎填）');
      eq(r.tasks[2].periods, '', '（同上：只给下课时间的也不推）');
      isTrue(r.warnings.join('|').indexOf('不会排进课表格子') !== -1, '保持原来那句 warning');
      isTrue(r.warnings.join('|').indexOf('已按时间推成') === -1, '不出现"已推成"这种话');

      // ---- 8. 不支持识图：事前那条腿 ----
      block('识图 —— VISION_UNSUPPORTED（事前）：已知纯文本模型，一个请求都不发');
      return runVision(MODEL_JSON, {}, { env: { ZHIPU_API_KEY: 'test-key-not-used', LLM_MODEL: 'glm-4.7-flash' } });
    }).then(function (out5) {
      eq(out5.res.ok, false, '默认模型 glm-4.7-flash 识图 → ok:false');
      eq(out5.res.code, 'VISION_UNSUPPORTED', 'code 是 VISION_UNSUPPORTED');
      eq(out5.calls.length, 0, '**一个请求都没发**（省用户的钱和时间）');
      isTrue(out5.res.error.indexOf('glm-4.7-flash') !== -1,
        '文案里有**当前模型名**：' + show(out5.res.error));
      isTrue(out5.res.error.indexOf('glm-5.3-flash') !== -1 && out5.res.error.indexOf('glm-ocr') !== -1,
        '文案里给了**建议换的模型名**');
      isTrue(out5.res.error.indexOf('AI 设置') !== -1, '文案里说清了去哪儿改（我的 → AI 设置）');
      isTrue(out5.res.error.indexOf('文字录入') !== -1, '顺带给了退路：还可以继续用文字录入');

      // 用户自填配置那条路也要按**用户的模型**判（本需求的前提就是"用他们自己的 AI"）
      return loadSettingsDb();
    }).then(function (db) {
      isTrue(!!db, '借到了 cloudfunctions/_fake_db.js 的 createSettingsDb（用户自填配置要真读一遍库）');
      if (!db) return null;
      var settingsDb = db([
        { _openid: 'me', ai_provider: 'zhipu', ai_api_key: 'sk-user-own-key', ai_model: 'glm-4.7-flash' }
      ]);
      var stub = stubPostJson(function () { return modelReply(MODEL_JSON); });
      return aiParseFn.handleParseImage(imageEvent(), {
        env: {}, db: settingsDb, openid: 'me'
      }).then(function (res) {
        stub.restore();
        eq(res.ok, false, '用户自己填的 glm-4.7-flash 同样被事前拦下');
        eq(res.code, 'VISION_UNSUPPORTED', 'code 同样是 VISION_UNSUPPORTED');
        eq(stub.calls.length, 0, '按用户配置判定时也不发请求');
        isTrue(res.error.indexOf('glm-4.7-flash') !== -1, '文案里是用户自己的模型名');
      });
    }).then(function () {
      // ---- 9. 不支持识图：事后那条腿（服务端报错 → 关键词判定）----
      block('识图 —— VISION_UNSUPPORTED（事后）：服务端说"不支持图片输入"');
      isTrue(aiParseFn.isVisionUnsupportedError(aiParseFn.PROVIDERS.zhipu, 400,
        '{"error":{"code":"1210","message":"当前模型不支持图片输入"}}'),
        '关键词判定：400 + "不支持图片输入" → true');
      isTrue(aiParseFn.isVisionUnsupportedError(aiParseFn.PROVIDERS.zhipu, 400,
        '{"error":{"message":"invalid content type: image_url"}}'),
        '关键词判定：content type + image → true');
      isTrue(aiParseFn.isVisionUnsupportedError(aiParseFn.PROVIDERS.deepseek, 422,
        '{"error":{"message":"multimodal input is not supported"}}'),
        '关键词判定：422(HTTP) + multimodal → true（DeepSeek 没有业务码，靠状态码）');
      isFalse(aiParseFn.isVisionUnsupportedError(aiParseFn.PROVIDERS.zhipu, 500,
        '{"error":{"message":"internal error about image"}}'),
        '**5xx 不算**（服务端故障不该被说成"你的模型不能识图"）');
      isFalse(aiParseFn.isVisionUnsupportedError(aiParseFn.PROVIDERS.zhipu, 429,
        '{"error":{"code":"1302","message":"当前并发量过高"}}'),
        '**限流不算**（与图片无关）');
      isFalse(aiParseFn.isVisionUnsupportedError(aiParseFn.PROVIDERS.zhipu, 400,
        '{"error":{"code":"1210","message":"temperature 参数有误"}}'),
        '400 但语义词一个都没命中 → 不算');
      isFalse(aiParseFn.isVisionUnsupportedError(aiParseFn.PROVIDERS.zhipu, 200, ''),
        '空响应体 → 不算（不抛异常）');

      return runVisionHttp(400, '{"error":{"code":"1210","message":"当前模型不支持图片输入"}}', {},
        { env: { ZHIPU_API_KEY: 'test-key-not-used', LLM_MODEL: 'glm-4.6v' } });
    }).then(function (out6) {
      eq(out6.res.ok, false, '服务端拒绝 → ok:false');
      eq(out6.res.code, 'VISION_UNSUPPORTED', '**映射成 VISION_UNSUPPORTED**（而不是一句看不懂的参数错误）');
      eq(out6.calls.length, 1, '这条是事后判定：请求确实发过一次（在名单里的模型先放行）');
      isTrue(out6.res.error.indexOf('glm-4.6v') !== -1, '文案里有当前模型名：' + show(out6.res.error));
      isTrue(out6.res.error.indexOf('glm-5.3-flash') !== -1, '文案里有建议换的模型名');

      // 换成"图片太大"的报错：不能被误判成"不支持识图"
      return runVisionHttp(400, '{"error":{"code":"1210","message":"图片过大，请压缩后重试"}}');
    }).then(function (out7) {
      eq(out7.res.code, 'BAD_IMAGE', '"图片过大" → BAD_IMAGE（不是 VISION_UNSUPPORTED）');
      isTrue(out7.res.error.indexOf('图片太大') !== -1, '文案是"重新截图或先裁剪"：' + show(out7.res.error));

      // ---- 10. 其它失败码 ----
      block('识图 —— TIMEOUT / QUOTA / MODEL_MISSING 各自成码（超时要能与其它失败区分）');
      var stub = stubPostJson(function () {
        var err = new Error('请求超时（>45 秒）');
        err.code = 'TIMEOUT';
        return Promise.reject(err);
      });
      return aiParseFn.handleParseImage(imageEvent(), visionOptions()).then(function (res) {
        stub.restore();
        eq(res.ok, false, '超时 → ok:false');
        eq(res.code, 'TIMEOUT', 'code 是 TIMEOUT');
        isTrue(res.error.indexOf('45') !== -1, '文案里说清了等了多少秒：' + show(res.error));
        isTrue(res.error.indexOf('glm-ocr') !== -1, '建议换更快的 glm-ocr 或稍后重试');
      });
    }).then(function () {
      return runVisionHttp(429, '{"error":{"code":"1302","message":"当前并发量过高"}}');
    }).then(function (out8) {
      eq(out8.res.code, 'QUOTA', '429 / 业务码 1302 → QUOTA');
      isTrue(out8.res.error.indexOf('额度') !== -1, '文案里说的是额度/频率：' + show(out8.res.error));

      return runVisionHttp(400, '{"error":{"code":"1211","message":"模型不存在，请检查模型代码"}}');
    }).then(function (out9) {
      eq(out9.res.code, 'MODEL_MISSING', '业务码 1211 → MODEL_MISSING');
      isTrue(out9.res.error.indexOf('glm-5.3-flash') !== -1, '文案里给了识图推荐模型');

      // 拿到了回答但不是 JSON → PARSE_FAILED
      return runVision('这张图我看不清，可能不是课表。');
    }).then(function (out10) {
      eq(out10.res.ok, false, '模型没给 JSON → ok:false');
      eq(out10.res.code, 'PARSE_FAILED', 'code 是 PARSE_FAILED');
      isTrue(out10.res.error.indexOf('文字录入') !== -1, '文案里给了退路（换清晰截图 / 改用文字录入）');

      // ---- 11. 图片入参校验：BAD_IMAGE ----
      block('识图 —— BAD_IMAGE（缺图 / 超长 / 格式不对）且错误信息里没有 base64');
      var huge = '/' + new Array(MAX_CHARS + 10).join('/');
      return runVision(MODEL_JSON, { image_base64: huge });
    }).then(function (out11) {
      eq(out11.res.ok, false, '超长 base64 → ok:false');
      eq(out11.res.code, 'BAD_IMAGE', 'code 是 BAD_IMAGE');
      eq(out11.res.error, aiParseFn.IMAGE_TOO_LARGE_MESSAGE, '文案就是那句"重新截图或先裁剪"');
      eq(out11.calls.length, 0, '**超长图片不发请求**（省一趟白跑）');

      return runVision(MODEL_JSON, { mime_type: 'image/gif' });
    }).then(function (out12) {
      eq(out12.res.code, 'BAD_IMAGE', 'mime 不在白名单 → BAD_IMAGE');
      eq(out12.calls.length, 0, 'mime 非法不发请求');
      return runVision(MODEL_JSON, { mime_type: '' });
    }).then(function (out13) {
      eq(out13.res.code, 'BAD_IMAGE', 'mime 缺失 → BAD_IMAGE');
      return runVision(MODEL_JSON, { image_base64: '' });
    }).then(function (out14) {
      eq(out14.res.code, 'BAD_IMAGE', '缺 base64 → BAD_IMAGE');
      return runVision(MODEL_JSON, { image_base64: '这不是 base64!!' });
    }).then(function (out15) {
      eq(out15.res.code, 'BAD_IMAGE', '不是 base64 → BAD_IMAGE');
      eq(out15.calls.length, 0, '形状不对不发请求');

      // 【安全红线】错误信息里绝不能出现 base64（哪怕被截断的前缀）
      var shortSample = '/9j/' + new Array(120).join('B');
      return runVision(MODEL_JSON, { image_base64: shortSample, mime_type: 'image/gif' });
    }).then(function (out16) {
      eq(out16.res.error.indexOf('/9j/'), -1, '**错误信息里没有 base64 的内容**');
      eq(JSON.stringify(out16.res).indexOf('/9j/'), -1, '整个返回体里也没有 base64');

      // ---- 12. 白名单入参：前端塞进来的 Key / 地址一律不参与 ----
      block('识图 —— 入参白名单：apiKey / baseUrl 之类进不了报文，也不影响服务端取值');
      return runVision(MODEL_JSON, {
        apiKey: 'sk-ATTACKER', api_key: 'sk-ATTACKER', baseUrl: 'https://evil.example.com/steal',
        url: 'https://evil.example.com/steal', provider: 'deepseek', model: 'attacker-model'
      });
    }).then(function (out17) {
      eq(out17.calls.length, 1, '正常发了一次请求（恶意字段不影响主流程）');
      eq(out17.calls[0].url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        '**请求地址只从白名单映射**（event 里的 baseUrl 被忽略 → 不是 SSRF 跳板）');
      eq(out17.calls[0].payload.model, 'glm-5.3-flash', '模型名也不接受 event 指定');
      eq(out17.calls[0].headers.Authorization, 'Bearer test-key-not-used',
        '**Key 只从服务端读**（event 里的 apiKey 完全不参与）');
      eq(JSON.stringify(out17.calls[0].payload).indexOf('ATTACKER'), -1, '报文里没有攻击者传的 Key');
      eq(aiParseFn.findInjectedFields({ action: 'parse_image', apiKey: 'x', baseUrl: 'y' }).join(','),
        'apiKey,baseUrl', '注入字段仍然被识别出来（只记字段名、不记值）');

      // ---- 13. api.js 的封装：请求体构造 + 本地拦截 ----
      block('识图 —— api.aiParseImage 的请求体与本地拦截（不发无效请求）');
      return api.aiParseImage({});   // 缺图
    }).then(function (res) {
      eq(res.ok, false, 'api.aiParseImage 缺 base64 → ok:false');
      isTrue(res.error.indexOf('图片') !== -1, '给的是人话：' + show(res.error));
      eq(callLog.length, 0, '缺图**不发请求**');
      isTrue(toasts.length >= 1, '本地拦下时弹一次 toast（api.js 的既有约定）');
      return api.aiParseImage({ image_base64: SAMPLE_BASE64, mime_type: 'image/gif' });
    }).then(function (res) {
      eq(res.ok, false, 'mime 非法 → ok:false');
      eq(callLog.length, 0, 'mime 非法**不发请求**');
      return api.aiParseImage({ image_base64: '/' + new Array(MAX_CHARS + 10).join('/'), mime_type: 'image/jpeg' });
    }).then(function (res) {
      eq(res.ok, false, '超长 base64 → ok:false（本地先拦，不白跑一趟云函数）');
      eq(callLog.length, 0, '超长**不发请求**');
      // 成功路径：先把 postJson 换成假响应（否则会真的打到智谱去）
      visionStub = stubPostJson(function () { return modelReply(MODEL_JSON); });
      return api.aiParseImage({
        image_base64: 'data:image/jpeg;base64,' + SAMPLE_BASE64, // 误传 data URL 也要能用
        mime_type: 'image/jpeg',
        week_monday: '2026-09-07',
        semester_start: '2026-09-07',
        week_start: 1,
        week_end: 16,
        period_times: { '5': ['11:45', '12:25'] },
        apiKey: 'sk-SHOULD-NOT-SEND', junk: 'nope'
      });
    }).then(function (res) {
      visionStub.restore();
      eq(visionStub.calls.length, 1, '识图请求真的发出去了（桩被调用到，不是空跑）');
      eq(res.ok, true, '调用成功（桩把 aiParse 接到真的云函数上）');
      eq(callLog.length, 1, '发了一次');
      eq(lastCall().name, 'aiParse', '转发给 aiParse 云函数');
      eq(Object.keys(lastCall().data).sort().join(','),
        'action,image_base64,mime_type,period_times,semester_start,week_end,week_monday,week_start',
        '**报文恰好是契约里那几个字段**（apiKey / junk 一律不进报文）');
      eq(lastCall().data.action, 'parse_image', "action 是 'parse_image'");
      eq(lastCall().data.mime_type, 'image/jpeg', 'mime 归一化后传过去');
      eq(lastCall().data.image_base64, SAMPLE_BASE64, '**data URL 前缀被剥掉了**（契约要求纯 base64）');
      eq(lastCall().data.week_start, 1, 'week_start 原样传');
      eq(lastCall().data.week_end, 16, 'week_end 原样传');
      isTrue(JSON.stringify(lastCall().data).indexOf('SHOULD-NOT-SEND') === -1,
        '报文里没有调用方顺手塞进来的 Key（与云函数侧的注入闸门是前后两半）');
      eq(lastCall().data.period_times['5'][1], '12:25', '用户校准的作息带过去了');
      eq(res.data.ok, true, 'data.ok 为 true（平铺，前端直接读）');
      eq(res.data.tasks.length, 3, '识别出的课程已经是可以直接落库的 tasks');
      eq(api.AI_PARSE_ACTION_PARSE_IMAGE, aiParseFn.ACTION_PARSE_IMAGE,
        'api.js 与云函数的 action 名一致');

      // ---- 14. 页面：课程字段在路上不能丢 ----
      block('识图 —— 页面的 buildParseItems 把课程字段原样带到 task 上');
      var viaPage = T.buildParseItems(res.data);
      eq(viaPage.length, 3, '3 门课都进了勾选列表');
      eq(viaPage[0].task.repeat, 'weekly', 'repeat 没在路上丢');
      eq(viaPage[0].task.periods, '1-2', 'periods 没在路上丢（课表类任务判据的一半）');
      eq(viaPage[0].task.week_start, 1, 'week_start 没丢');
      eq(viaPage[0].task.week_end, 16, 'week_end 没丢');
      eq(viaPage[0].task.week_parity, 'all', 'week_parity 没丢');
      eq(viaPage[2].task.week_parity, 'odd', '单双周也没丢');
      eq(viaPage[0].task.date, '2026-09-07', '日期没丢');
      eq(viaPage[0].task.type, 'event', '类型是 event');
      isTrue(viaPage[0].courseText.indexOf('第1-2节') !== -1,
        '列表上给出了课程说明行：' + show(viaPage[0].courseText));
      isTrue(viaPage[0].courseText.indexOf('1-16周') !== -1, '说明行里带周次范围');
      eq(viaPage[1].timeText, '10:00-12:25', '时间文案取任务自己的时间');
      isTrue(viaPage.every(function (item) { return item.selected; }), '默认全选（用户可以逐条取消）');
      eq(T.buildParseItems({ events: [], deadlines: [], tasks: [] }).length, 0, '空结果不炸');

      // 普通日程不带课程说明行（不误伤文本解析那条路）
      var plain = T.buildParseItems({
        events: [{ title: '开组会', date: '2026-09-08', start_time: '15:00', end_time: '', priority: '中' }],
        deadlines: [],
        tasks: [{ title: '开组会', type: 'event', date: '2026-09-08', start_time: '15:00', end_time: '', priority: 'mid', repeat: 'none', periods: '' }]
      });
      eq(plain[0].courseText, '', '普通日程（repeat:none）没有课程说明行');
      eq(plain[0].task.repeat, 'none', '普通日程的 repeat 原样');

      // ---- 15. 页面：三态提示 / 课表类判据 / 作息合并 ----
      block('识图 —— 页面纯函数：模型提示三态 / 课表类判据 / 作息增量合并');
      var hintNo = T.visionHintOf('glm-4.7-flash');
      eq(hintNo.state, false, '纯文本模型 → state:false');
      eq(hintNo.level, 'danger', '纯文本模型 → 红字');
      isTrue(hintNo.text.indexOf('glm-4.7-flash') !== -1 && hintNo.text.indexOf('glm-5.3-flash') !== -1,
        '提示里同时有当前模型与建议模型：' + show(hintNo.text));
      var hintYes = T.visionHintOf('glm-5.3-flash');
      eq(hintYes.state, true, '支持的模型 → state:true');
      eq(hintYes.level, 'ok', '支持的模型 → 绿字');
      var hintUnknown = T.visionHintOf('glm-4.7');
      eq(hintUnknown.state, 'unknown', '没收录 → state:unknown');
      eq(hintUnknown.level, 'muted', '没收录 → 灰字（允许尝试）');
      isTrue(hintUnknown.text.indexOf('如果识别失败请更换模型') !== -1,
        '灰字文案就是那句"未在已知支持识图的列表里"：' + show(hintUnknown.text));

      isTrue(T.isCourseTask({ repeat: 'weekly', periods: '3-5' }), 'weekly + 有节次 → 课表类任务');
      isFalse(T.isCourseTask({ repeat: 'weekly', periods: '' }), 'weekly 但没节次 → 不算（手写日程的形态）');
      isFalse(T.isCourseTask({ repeat: 'none', periods: '3-5' }), '没重复 → 不算');
      isFalse(T.isCourseTask(null), 'null → 不算（不抛异常）');

      eqJsonLike(T.mergePeriodTimes({ '1': ['08:00', '08:45'] }, { '5': ['11:45', '12:25'] }),
        { '1': ['08:00', '08:45'], '5': ['11:45', '12:25'] },
        '作息合并：新增节次不动老节次');
      eqJsonLike(T.mergePeriodTimes({ '1': ['08:00', '08:45'], '5': ['14:00', '14:45'] }, { '5': ['11:45', '12:25'] }),
        { '1': ['08:00', '08:45'], '5': ['11:45', '12:25'] },
        '作息合并：**同名节次被新值覆盖**（用户刚校准过的时间更可信）');
      eq(T.mergePeriodTimes({ '1': ['08:00', '08:45'] }, null), null,
        '没有新校准 → null（调用方据此跳过保存，不去动设置）');
      eq(T.mergePeriodTimes(null, null), null, '两边都空 → null（不抛异常）');

      eq(T.mimeFromBase64('/9j/AAA'), 'image/jpeg', '魔数 /9j/ → jpeg');
      eq(T.mimeFromBase64('iVBORw0KGgo'), 'image/png', '魔数 iVBOR → png');
      eq(T.mimeFromBase64('UklGRg=='), 'image/webp', '魔数 UklGR → webp');
      eq(T.mimeFromBase64('AAAA'), '', '认不出 → 空串（交给后缀 / 默认值）');
      eq(T.mimeFromPath('/tmp/xx.PNG'), 'image/png', '路径后缀也能猜（大小写不敏感）');

      // ---- 15b. 页面：整条识图流程（识别 → 勾选 → 替换/追加 → 作息落库）----
      block('识图 —— 页面流程：识别 → 替换课表 / 追加导入 → 作息落库');
      ctx.page = newPage();
      ctx.page.onLoad({});
      return settle();
    }).then(function () {
      // onLoad 读到的模型是"纯文本"（tasks 桩返回 glm-4.7-flash）→ 「开始识别」必须直接拦
      eq(ctx.page.data.visionState, false, 'onLoad 之后识别状态是"不具备识图能力"');
      ctx.page._imageBase64 = SAMPLE_BASE64;
      ctx.page._imageMime = 'image/jpeg';
      reset();
      tasksStubModel = 'glm-4.7-flash';
      ctx.page.onRecognize();
      return settle();
    }).then(function () {
      eq(callLog.filter(function (one) { return one.name === 'aiParse'; }).length, 0,
        '**模型不支持识图时一个识图请求都不发**（省用户的钱和时间）');
      eq(JSON.stringify(ctx.page.data.visionError).indexOf('glm-5.3-flash') !== -1, true,
        '页面上直接写出"换成 glm-5.3-flash"那句人话：' + show(ctx.page.data.visionError));

      // 换成支持识图的模型，再走一遍完整流程
      // （真实场景：用户看到红字后去「我的 → AI 设置」换了模型再回来，所以这里把状态也改掉）
      reset();
      tasksStubModel = 'glm-5.3-flash';
      ctx.page.data.visionState = true;
      visionStub = stubPostJson(function () { return modelReply(MODEL_JSON); });
      ctx.page.onRecognize();
      eq(ctx.page.data.visionBusy, true, '识别中按钮进 loading');
      eq(ctx.page.data.visionElapsed, 0, '秒数从 0 开始计');
      isTrue(!!ctx.page._visionTimer, '起了计时器（真机上要让用户看到"已经等了几秒"）');
      return settle();
    }).then(function () {
      visionStub.restore();
      eq(ctx.page.data.visionBusy, false, '结束后退出 loading（**失败路径也一样**：见上面的拦截用例）');
      eq(ctx.page._visionTimer, null, '**计时器被清掉了**（不清会在真机上一直跑）');
      eq(ctx.page.data.visionElapsed, 0, '秒数复位');
      var parsed = ctx.page.data.parsed;
      isTrue(!!parsed && parsed.items.length === 3, '识别结果进了与文本解析同一套勾选列表');
      eq(ctx.page.data.parsedSource, 'image', '标了来源是识图（决定显示"替换课表"还是"确认添加"）');
      isTrue(ctx.page.data.visionWarnings.length >= 1, 'warnings 显示在页面上');
      isTrue(ctx.page.data.parsed.items[0].task.repeat === 'weekly'
        && ctx.page.data.parsed.items[0].task.periods === '1-2',
        '勾选列表里的 task 带着课程字段（落库那一步吃的就是它）');

      // 取消勾选一条：只导入勾上的
      ctx.page.onToggleItem({ currentTarget: { dataset: { index: 2 } } });
      eq(ctx.page.data.parsed.items[2].selected, false, '点一下就取消勾选');
      ctx.page.onToggleAll();
      var allOn = ctx.page.data.parsed.items.every(function (item) { return item.selected; });
      eq(allOn, true, '「全选 / 全不选」在取消后变成全选');
      ctx.page.onToggleItem({ currentTarget: { dataset: { index: 2 } } });
      ctx.page.onToggleItem({ currentTarget: { dataset: { index: 2 } } });
      // 上一步：取消 → 全选 → 再点一次变成取消 → 再点回来
      eq(ctx.page.data.parsed.items[2].selected, true, '再点回来又勾上（勾选状态可反复切换）');

      // 替换课表：先弹确认框，文案里必须有"删几门"和"不碰什么"
      ctx.page._allTasks = [
        { repeat: 'weekly', periods: '1-2' },
        { repeat: 'weekly', periods: '3-4' },
        { repeat: 'none', periods: '' }   // 手工日程：不算课表类，不该被算进"要删的"
      ];
      reset();
      ctx.page.onVisionReplace();
      eq(modals.length, 1, '弹了一次确认框（会删数据的事必须二次确认）');
      isTrue(modals[0].content.indexOf('将删除现有 2 门课程') !== -1,
        '确认文案里有真实的门数（按 repeat=weekly 且 periods 非空现算）：' + show(modals[0].content));
      isTrue(modals[0].content.indexOf('不受影响') !== -1, '并写清了什么不受影响');
      return settle();
    }).then(function () {
      eq(callLog.filter(function (one) { return one.data.action === 'import_replace'; }).length, 1,
        '确认之后才发 import_replace（点取消就什么都不做）');
      eq(callLog.filter(function (one) { return one.data.action === 'import_replace'; })[0].data.scope, 'courses',
        'scope 仍是写死的 courses（只删课表类任务）');
      eq(ctx.page.data.tip, '已替换：删除 2 门、导入 3 门', '结果文案与「我的」页一致：' + show(ctx.page.data.tip));
      eq(ctx.page.data.parsed, null, '导入后清空结果列表');
      isTrue(ctx.page.data.periodsSaveText.indexOf('并按截图校准了 4 节作息') !== -1,
        '截图里读出的作息落库了：' + show(ctx.page.data.periodsSaveText));
      var save = callLog.filter(function (one) { return one.data.action === 'settings_save'; })[0];
      isTrue(!!save, '确实调了 settings_save');
      eq(save.data.settings.period_times['1'][0], '08:00', '保存的是合并后的作息（新读到的节次进来了）');
      eq(save.data.settings.period_times['5'][1], '14:45',
        '**同名节次被新值覆盖**（截图里的第 5 节覆盖了设置里旧的 12:25）');
      eq(save.data.settings.period_times['9'][1], '19:45',
        '**未涉及的节次保留原值**（第 9 节不在截图里，没被动到）');
      eq(toasts.length >= 1, true, '成功也弹了一次 toast（用户主动点的操作必须有反馈）');

      // 追加导入那条路
      reset();
      visionStub = stubPostJson(function () { return modelReply(MODEL_JSON); });
      ctx.page._imageBase64 = SAMPLE_BASE64;
      ctx.page.data.visionState = true;
      ctx.page.onRecognize();
      return settle();
    }).then(function () {
      visionStub.restore();
      reset();
      ctx.page.onVisionAppend();
      return settle();
    }).then(function () {
      var bulk = callLog.filter(function (one) { return one.data.action === 'bulk_add'; });
      eq(bulk.length, 1, '「追加导入」走的是 bulk_add');
      eq(bulk[0].data.tasks.length, 3, '把 3 门课都提交了');
      eq(bulk[0].data.tasks[0].repeat, 'weekly', '提交的课程带着 repeat=weekly');
      eq(ctx.page.data.tip, '已入库 3 条', '追加导入的文案与「我的」页一致：' + show(ctx.page.data.tip));
      eq(ctx.page.data.parsed, null, '追加后也清空结果列表');

      // ---- 15c. 反向断言：用户主动发起的识图**失败时必须有 toast** ----
      //   （防止有人图省事给"用户点的操作"也加上 silent：那样失败了用户会以为没反应）
      block('识图 —— 反向断言：用户主动发起的识图失败时仍然弹 toast');
      reset();
      visionStub = stubPostJson(function () {
        return httpFail(429, '{"error":{"code":"1302","message":"当前并发量过高"}}');
      });
      return api.aiParseImage({ image_base64: SAMPLE_BASE64, mime_type: 'image/jpeg' })
        .then(function (res) {
          visionStub.restore();
          eq(res.ok, false, '限流 → ok:false');
          eq(res.data, null, '失败时 data 为 null');
          isTrue(toasts.length >= 1, '**用户主动发起的识图失败弹了 toast**（不是 silent）');
          isTrue(String(res.error).indexOf('额度') !== -1, '文案是后端那句可操作的人话：' + show(res.error));
        });
    }).then(function () {
      // ---- 16. action 路由 + 文本路径不受影响 ----
      block('识图 —— 入口路由：不认识的 action 不被当成文本解析；文本路径原样');
      return aiParseFn.main({ action: 'delete_everything', text: '明天三点开会' });
    }).then(function (routed) {
      eq(routed.ok, false, '不认识的 action → ok:false');
      eq(routed.code, 'BAD_ACTION', 'code 是 BAD_ACTION（不是默默按文本解析）');
      isTrue(routed.error.indexOf('delete_everything') !== -1, '把不认识的那个 action 原样报出来');

      // 文本路径（无 action）必须**一字不改**：仍然是 15 秒超时、不带 top_p、返回同样那 6 个字段
      var stub = stubPostJson(function () {
        return modelReply('{"events":[{"title":"开组会","date":"2026-09-08","start_time":"15:00",'
          + '"end_time":"","type":"日程","priority":"中"}],"deadlines":[],'
          + '"needs_clarification":false,"clarification_question":""}');
      });
      return aiParseFn.main({ text: '明天下午三点开组会' }).then(function (textRes) {
        stub.restore();
        eq(stub.calls.length, 1, '文本路径照常发请求');
        eq(stub.calls[0].timeoutMs, 15000, '**文本路径仍然是 15 秒超时**（只有图片路径是 45 秒）');
        isFalse(Object.prototype.hasOwnProperty.call(stub.calls[0].payload, 'top_p'),
          '文本路径的报文没有被这次改动动过（不带 top_p）');
        eq(stub.calls[0].payload.response_format.type, 'json_object', '文本路径仍然请求 JSON 模式');
        eq(Object.keys(textRes).sort().join(','),
          'clarification_question,deadlines,events,needs_clarification,ok,tasks',
          '文本路径的返回字段与改动前一致（没有混进识图那些字段）');
        eq(textRes.events.length, 1, '文本解析照常工作');
      });
    });
    // 【收尾的两行不能省】上面这条链是**嵌在** `.then(function (out) {...})` 里的：
    // 第一行 `});` 关掉最后一段 `.then(function (routed) {...})`，
    // 第二行 `});` 关掉最外层那个 `.then(function (out) {...})`，
    // 最后一行 `}` 才是 `function run()` 的。
  });
}

/** 借"内存假数据库"（云端同学提供的开发期工具模块）；借不到就返回 null，由断言如实报红 */
function loadSettingsDb() {
  try {
    // eslint-disable-next-line global-require
    var mod = require(path.join(ROOT, 'cloudfunctions', '_fake_db.js'));
    if (mod && typeof mod.createSettingsDb === 'function') return Promise.resolve(mod.createSettingsDb);
    console.warn('[ai_vision] cloudfunctions/_fake_db.js 没有导出 createSettingsDb');
    return Promise.resolve(null);
  } catch (err) {
    console.warn('[ai_vision] 未能 require cloudfunctions/_fake_db.js：' + ((err && err.message) || err));
    return Promise.resolve(null);
  }
}

/** 比较两个对象（JSON 化之后的顺序无关比较：键排序后再比） */
function eqJsonLike(actual, expected, label) {
  var norm = function (value) {
    if (!value || typeof value !== 'object') return value;
    var out = {};
    Object.keys(value).sort().forEach(function (key) { out[key] = value[key]; });
    return out;
  };
  eq(H.show(norm(actual)), H.show(norm(expected)), label);
}

// ---------------------------------------------------------------------------
// 全局桩：wx / getApp（与 ai_page / ai_contract 一样，**只在使用例时才装**）
// ---------------------------------------------------------------------------
var toasts = [];
var callLog = [];
var modals = [];
var tasksStubModel = 'glm-4.7-flash';   // tasks 桩里 ai_config_get 返回的模型名
var savedWx = global.wx;
var savedGetApp = global.getApp;

/** 最近一次云函数调用 */
function lastCall() { return callLog[callLog.length - 1]; }

/** 清空调用记录（每个用例开始前调一次，免得相互干扰） */
function reset() {
  toasts = [];
  callLog = [];
  modals = [];
}

/**
 * tasks 云函数的桩：**只验页面怎么调、文案对不对**，不重放云端逻辑
 * （tasks 的真实契约由 ai_contract.js 打内存假库验，那边才是权威）。
 * 形状与云端一致：全部**平铺**（字段与 ok 同级）。
 */
function tasksStub(data) {
  var action = data && data.action;
  if (action === 'list') {
    return { ok: true, tasks: [], count: 0 };
  }
  if (action === 'ai_config_get') {
    return { ok: true, provider: 'zhipu', model: tasksStubModel, hasKey: true, masked: '****test', updated_at: '' };
  }
  if (action === 'bulk_add') {
    var list = (data && data.tasks) || [];
    return { ok: true, ids: list.map(function (item, i) { return 'id' + i; }), inserted: list.length, skipped: 0, errors: [] };
  }
  if (action === 'import_replace') {
    var rows = (data && data.tasks) || [];
    return { ok: true, removed: 2, inserted: rows.length, skipped: 0, duplicates: 0, errors: [], partial: false };
  }
  if (action === 'settings_get') {
    // 基准里放两节：'5' 会被截图里的同名列覆盖，'9' 不该被动到
    return { ok: true, semester_start: '2026-09-07', period_times: { '5': ['11:45', '12:25'], '9': ['19:00', '19:45'] } };
  }
  if (action === 'settings_save') {
    var settings = (data && data.settings) || {};
    return { ok: true, semester_start: '2026-09-07', period_times: settings.period_times || {} };
  }
  return { ok: false, error: 'unexpected action: ' + action };
}

function useStub() {
  reset();
  global.wx = {
    showToast: function (options) { toasts.push((options && options.title) || ''); },
    showModal: function (options) {
      modals.push(options || {});
      // 自动点"确认"：本文件要验的是"确认之后做了什么"，不是弹窗本身
      if (options && typeof options.success === 'function') options.success({ confirm: true, cancel: false });
    },
    getFileSystemManager: function () {
      // 本组不走"选图 → 压缩 → 读 base64"那条真机路径（那条依赖 wx 的文件 API），
      // 直接把 base64 塞进页面实例再点识别；所以这里只要有个不炸的桩。
      return { readFile: function () {} };
    },
    cloud: {
      callFunction: function (options) {
        var name = options && options.name;
        var data = (options && options.data) || {};
        callLog.push({ name: name, data: data });
        // 把前端的报文**真的**送进云函数：入参名 / 归一化 / 返回形状当场对账
        if (name === 'aiParse') {
          return aiParseFn.main(data).then(function (result) { return { result: result }; });
        }
        if (name === 'tasks') {
          return Promise.resolve({ result: tasksStub(data) });
        }
        return Promise.reject({ errMsg: 'cloud function not found: ' + name });
      }
    }
  };
  global.getApp = function () {
    return {
      globalData: { semesterStart: '2026-09-07', periodTimes: { '5': ['11:45', '12:25'] } },
      ensureInit: function () { return Promise.resolve(true); }
    };
  };
}

function restoreGlobals() {
  if (savedWx === undefined) delete global.wx; else global.wx = savedWx;
  if (savedGetApp === undefined) delete global.getApp; else global.getApp = savedGetApp;
}

/** 造一个"页面实例"：复制注册对象、给独立的 data 与 setData（与 ai_page.test.js 同一套做法） */
function newPage() {
  var page = {};
  Object.keys(pageObj || {}).forEach(function (key) { page[key] = pageObj[key]; });
  page.data = JSON.parse(JSON.stringify(pageObj.data));
  page.setData = function (patch) {
    Object.keys(patch || {}).forEach(function (key) { page.data[key] = patch[key]; });
  };
  return page;
}

/** 等异步链跑完（页面内部用的是微任务 / Promise，让出几轮事件循环足够） */
function settle(rounds) {
  var n = rounds || 8;
  var p = Promise.resolve();
  for (var i = 0; i < n; i += 1) {
    p = p.then(function () { return new Promise(function (resolve) { setImmediate(resolve); }); });
  }
  return p;
}

// ---------------------------------------------------------------------------
// 导出给 run.js 串行调用；单独跑时自己收尾
// ---------------------------------------------------------------------------
var done = Promise.resolve()
  .then(function () {
    useStub();          // 用例真正开始时才装桩（加载期不碰全局）
    // 云函数侧凡是走 main() 的路径都要有环境变量（前端报文里没有 Key）
    var restore = withEnv({ ZHIPU_API_KEY: 'test-key-not-used', LLM_MODEL: 'glm-5.3-flash' });
    return run().then(function () { restore(); }, function (err) { restore(); throw err; });
  })
  .then(function () {
    restoreGlobals();   // 跑完立刻把全局还回去，不影响后面的测试文件
    if (require.main === module) H.report('课表截图识别（parse_image）契约');
  })
  .catch(function (err) {
    restoreGlobals();
    console.error('识图测试自己崩了：', err);
    process.exit(2);
  });

module.exports = { done: done };
