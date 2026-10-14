/**
 * utils/tests/ai_contract.js —— utils/api.js 的 **AI 契约联调**（留在仓库里做回归保护）。
 *
 * 跑法：
 *     node utils/tests/ai_contract.js      # 只跑这一份
 *     node utils/tests/run.js              # 跑全部（本文件会被自动 require）
 *
 * 【为什么需要它】api.js 依赖全局 `wx`，普通单测 require 不了它；但 action 名 /
 * 入参字段 / 返回形状三件事又最容易写错。这里的做法是：先把 `wx` 补上（用假实现），
 * 再让 api.js 的调用**真的走进云函数的 handleParse / handleDecompose / handleAction**，
 * 于是「前端传的字段」和「后端读的字段」当场对账。
 *
 * 【它是怎么做到不联网的】
 *   * `DEEPSEEK_API_KEY` / `ZHIPU_API_KEY` 临时清空 → 两个 AI 云函数在发请求之前就
 *     返回统一的 { ok:false, error:'AI 服务暂不可用' }。这条路径用来验**错误文案的透传**。
 *   * 「成功路径」把云函数内部的 postJson 换成假的模型响应（module.exports.postJson
 *     是同一个函数对象，替换有效），完整解析/归一化链路都会真跑，但一个字节都不出网。
 *
 * 【加载期纪律（踩过坑）】本文件在**加载期只注册、不装全局桩、不启动异步链**：
 *   装桩与执行都推迟到 `done` 被 await 的那一刻。原因是 run.js 会先 require 本文件、
 *   紧接着 require 另一个也要改 global.wx 的测试文件；若这里在顶层装桩并立刻起链，
 *   那些**排队的续体**就会跑在别人的桩上（表现为"单独跑全绿、经 run.js 就崩"）。
 *
 * 【这里断言的是契约，不是实现细节】字段名一律对着
 * cloudfunctions/aiParse/index.js、aiDecompose/index.js、tasks/index.js 写死。
 */

'use strict';

var path = require('path');
var H = require(path.join(__dirname, 'harness.js'));  // 只定义、不执行的断言助手

var eq = H.eq;
var eqArr = H.eqArr;
var isTrue = H.isTrue;
var isFalse = H.isFalse;
var block = H.block;
var show = H.show;

var ROOT = path.join(__dirname, '..', '..');
var aiParseFn = require(path.join(ROOT, 'cloudfunctions', 'aiParse', 'index.js'));
var aiDecomposeFn = require(path.join(ROOT, 'cloudfunctions', 'aiDecompose', 'index.js'));
var tasksFn = require(path.join(ROOT, 'cloudfunctions', 'tasks', 'index.js'));

// ---------------------------------------------------------------------------
// 环境变量开关
// ---------------------------------------------------------------------------
// 两个 AI 云函数支持多家服务商（zhipu / deepseek），只要**任意一家**配了 Key，
// 它们就真的会去发网络请求。单测必须零网络，所以：
//   * 走"报错路径"时把两家的 Key 都清掉 → 云函数在发请求之前就返回统一文案；
//   * 走"成功路径"时给一家塞个假 Key，同时把 postJson 换掉（见 contractOfSuccess）。
// 每个用例结束后都要还原，别把改动留给别的测试。
// ---------------------------------------------------------------------------
var KEY_ENVS = ['ZHIPU_API_KEY', 'DEEPSEEK_API_KEY', 'LLM_PROVIDER', 'LLM_MODEL'];

/** 记住当前所有相关环境变量 */
function rememberEnv() {
  var saved = {};
  KEY_ENVS.forEach(function (name) { saved[name] = process.env[name]; });
  return saved;
}

/** 还原环境变量（值为 undefined 的键要真的删掉，不能留空串） */
function restoreEnv(saved) {
  KEY_ENVS.forEach(function (name) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  });
}

/** 清掉两家的 Key（连带 LLM_PROVIDER / LLM_MODEL），返回还原用的快照 */
function clearAllKeys() {
  var saved = rememberEnv();
  delete process.env.ZHIPU_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.LLM_PROVIDER;
  delete process.env.LLM_MODEL;
  return saved;
}

/** 给某一家塞一个假 Key（成功路径会把 postJson 换掉，所以不会真的上网） */
function setFakeKey(name, value) {
  delete process.env.ZHIPU_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.LLM_PROVIDER;
  delete process.env.LLM_MODEL;
  process.env[name] = value;
}

// ---------------------------------------------------------------------------
// 调用记录（真正的 wx 桩在文件末尾的 done 里装，加载期一律不动全局）
// ---------------------------------------------------------------------------
var callLog = [];
var toasts = [];

// api.js 在加载期不碰 wx（只在真正调用时才读 wx.cloud.callFunction），require 是安全的
var api = require(path.join(ROOT, 'utils', 'api.js'));

/** 最后一次云函数调用的入参 */
function lastCall() { return callLog[callLog.length - 1]; }

/** 统一清空记录，避免相互干扰 */
function reset() { callLog = []; toasts = []; }

// ---------------------------------------------------------------------------
// 一、入参契约：前端传的字段 == 后端读的字段
// ---------------------------------------------------------------------------
function contractOfInputs() {
  block('AI 契约 —— 入参字段名（前端传的 == 后端读的）');

  var savedEnv = clearAllKeys();

  // aiParse：只认 { text }
  reset();
  return api.aiParse('明天下午三点开组会').then(function () {
    eq(callLog.length, 1, 'aiParse() 只发了一次云函数调用（桩确实被调用到）');
    eq(lastCall().name, 'aiParse', '云函数名是 aiParse（独立函数，不是 tasks 的 action）');
    eq(Object.keys(lastCall().data).sort().join(','), 'text',
      'aiParse 的入参**只有** text 一个键（没有 action）');
    eq(lastCall().data.text, '明天下午三点开组会', 'text 就是要解析的原话');
    isFalse(Object.prototype.hasOwnProperty.call(lastCall().data, 'action'),
      '不带 action 字段（带了也不会被 tasks 处理，两个函数是分开的）');

    reset();
    return api.aiParse('   明天 15:00 开会   ');
  }).then(function () {
    eq(lastCall().data.text, '明天 15:00 开会', 'aiParse 传出去之前先 trim');

    // aiDecompose：只认 { title, deadline }
    reset();
    return api.aiDecompose({ title: '写毕业论文', date: '2026-12-31' });
  }).then(function () {
    eq(lastCall().name, 'aiDecompose', '云函数名是 aiDecompose');
    eq(Object.keys(lastCall().data).sort().join(','), 'deadline,title',
      'aiDecompose 的入参**只有** title 与 deadline（没有 action）');
    eq(lastCall().data.title, '写毕业论文', 'title 原样传过去');
    eq(lastCall().data.deadline, '2026-12-31',
      '**任务的 date 映射成云函数的 deadline**（后端字段名是 deadline，不是 date）');

    // 本地拦截：空输入不发请求
    reset();
    return api.aiParse('   ');
  }).then(function (res) {
    eq(res.ok, false, 'aiParse("   ") → ok:false（本地拦截）');
    eq(callLog.length, 0, '空输入**不发**云函数请求');
    isTrue(res.error.indexOf('请先输入你的安排') > -1, '空输入给出"请先输入你的安排"');
    eq(toasts.length, 1, '空输入也弹了一次 toast');

    reset();
    return api.aiDecompose({ title: '', date: '2026-12-31' });
  }).then(function (res) {
    eq(res.ok, false, 'aiDecompose 缺 title → ok:false');
    eq(callLog.length, 0, '缺 title 不发请求');
    isTrue(res.error.indexOf('任务名称不能为空') > -1, '提示"任务名称不能为空，无法拆解"');

    reset();
    return api.aiDecompose({ title: '写论文' });   // 没有 date
  }).then(function (res) {
    eq(res.ok, false, 'aiDecompose 缺截止日 → ok:false');
    eq(callLog.length, 0, '缺截止日不发请求');
    isTrue(res.error.indexOf('没有日期') > -1, '提示"这条任务没有日期，无法拆解"');

    reset();
    return api.aiDecompose('不是对象');
  }).then(function (res) {
    eq(res.ok, false, 'aiDecompose 传非对象 → ok:false（不抛异常）');
    return api.aiParse(null);
  }).then(function (res) {
    eq(res.ok, false, 'aiParse(null) → ok:false（不抛异常）');
    restoreEnv(savedEnv);
  });
}

// ---------------------------------------------------------------------------
// 二、错误契约：后端那句统一文案要**原样**透传到前端
// ---------------------------------------------------------------------------
function contractOfErrors() {
  block('AI 契约 —— 没有任何服务商配 Key 时的统一错误文案（原样透传，不自己编原因）');

  var savedEnv = clearAllKeys();

  reset();
  return api.aiParse('明天三点开会').then(function (res) {
    eq(res.ok, false, '两家 Key 都没配 → ok:false');
    eq(res.data, null, '失败时 data 为 null');
    eq(res.error, aiParseFn.ERROR_MESSAGE, 'error 就是后端常量 ERROR_MESSAGE');
    eq(res.error, 'AI 服务暂不可用', "文案是 'AI 服务暂不可用'");
    isFalse(/Key|key|密钥|401|超时|智谱|glm|deepseek/i.test(res.error),
      '文案里**没有**"Key/密钥/超时/服务商名"之类更具体的原因（前端不许编造）');
    eq(toasts.length, 1, '弹了一次 toast');
    eq(toasts[0], 'AI 服务暂不可用', 'toast 文案与 error 一致');

    reset();
    return api.aiDecompose({ title: '写毕业论文', date: '2026-12-31' });
  }).then(function (res) {
    eq(res.ok, false, 'aiDecompose 没配 Key → ok:false');
    eq(res.error, aiDecomposeFn.ERROR_MESSAGE, '同样透传后端的统一文案');
    eq(toasts.length, 1, '同样弹了一次 toast');

    // 后端校验类错误也要原样透传（不是"统一文案"，而是后端写好的具体提示）
    reset();
    return api.aiParse(new Array(600).join('字'));   // 超过 500 字
  }).then(function (res) {
    eq(res.ok, false, '超长输入 → ok:false');
    isTrue(res.error.indexOf('输入过长') > -1, '后端的具体校验提示被原样透传：' + show(res.error));
    isTrue(res.error.indexOf('最多 500 字') > -1, '并且带着上限说明');

    reset();
    return api.aiDecompose({ title: '写论文', date: '2026/12/31' });   // 日期格式不对
  }).then(function (res) {
    eq(res.ok, false, '截止日格式非法 → ok:false');
    isTrue(res.error.indexOf('截止日期必须是 YYYY-MM-DD') > -1, '后端提示被原样透传：' + show(res.error));

    restoreEnv(savedEnv);
  });
}

// ---------------------------------------------------------------------------
// 三、成功契约：真的跑一遍解析/拆解链路（把 postJson 换成假响应，不出网）
// ---------------------------------------------------------------------------
function contractOfSuccess() {
  block('AI 契约 —— 成功路径的字段（假模型响应，零网络）');

  var savedEnv = rememberEnv();
  // 塞一个假 Key 让 resolveProviderConfig 认为"有服务商可用"；真正的网络调用
  // 被下面的 postJson 替换挡掉了，所以这个 key 只是占位符，不会出网。
  setFakeKey('ZHIPU_API_KEY', 'test-key-not-used');

  var realParsePost = aiParseFn.postJson;
  var realDecomposePost = aiDecomposeFn.postJson;
  var parseCalls = 0;
  var decomposeCalls = 0;

  /** 造一个 DeepSeek 风格的响应 */
  function fakeCompletion(jsonText) {
    return Promise.resolve({
      status: 200,
      text: JSON.stringify({ choices: [{ message: { content: jsonText } }] })
    });
  }

  aiParseFn.postJson = function () {
    parseCalls += 1;
    return fakeCompletion(JSON.stringify({
      events: [{ title: '开组会', date: '2026-09-08', start_time: '15:00', end_time: '', type: '日程', priority: '中' }],
      deadlines: [{ title: '交实验报告', date: '2026-09-11', end_time: '23:59', type: 'DDL', priority: '高' }],
      needs_clarification: false,
      clarification_question: ''
    }));
  };
  aiDecomposeFn.postJson = function () {
    decomposeCalls += 1;
    return fakeCompletion(JSON.stringify({
      task: '写毕业论文',
      deadline: '2026-12-31',
      subtasks: [
        { title: '查文献', suggested_date: '2026-09-10', estimate_min: 120 },
        { title: '写提纲', suggested_date: '2026-10-01', estimate_min: 60 },
        { title: '写初稿', suggested_date: '2026-12-01', estimate_min: 600 }
      ]
    }));
  };

  reset();
  return api.aiParse('明天下午三点开组会，周五前交实验报告').then(function (res) {
    eq(parseCalls, 1, '真调了一次假 postJson（桩没被静默绕过、也没真联网）');
    eq(res.ok, true, 'aiParse 成功 → ok:true');
    eq(res.error, null, '成功时 error 为 null');

    var d = res.data;
    eq(Object.keys(d).sort().join(','),
      'clarification_question,deadlines,events,needs_clarification,ok,tasks',
      '返回对象顶层字段与 aiParse 契约一致（ok/events/deadlines/needs_clarification/clarification_question/tasks）');
    eq(d.ok, true, 'data.ok 为 true（前端可直接用 res.data.ok 判断）');
    eq(d.events.length, 1, 'events 有 1 条');
    eq(Object.keys(d.events[0]).sort().join(','), 'date,end_time,priority,repeat,start_time,title,type',
      'events 条目字段：title/date/start_time/end_time/type/priority/repeat'
      + '（repeat 是为了"每天"新加的，少了它落库时会被抹成单次）');
    eq(d.events[0].type, '日程', 'events 的 type 是中文「日程」（后端原样返回）');
    eq(d.events[0].start_time, '15:00', 'events 的 start_time 是 HH:MM');
    eq(d.deadlines.length, 1, 'deadlines 有 1 条');
    eq(d.deadlines[0].type, 'DDL', 'deadlines 的 type 是「DDL」');
    eq(d.deadlines[0].start_time, '', 'deadlines 没有开始时间（截止只有一个时刻）');
    eq(d.deadlines[0].end_time, '23:59', 'deadlines 的 end_time 是截止时刻');
    eq(d.needs_clarification, false, 'needs_clarification 是布尔 false');
    eq(d.clarification_question, '', 'clarification_question 是空串');
    eq(d.tasks.length, 2, 'tasks 已经是可以直接落库的 2 条任务');

    // tasks[] 必须是 tasks.bulk_add 能吃的形态（type 已翻成 event/ddl）
    var types = d.tasks.map(function (t) { return t.type; }).join(',');
    eq(types, 'event,ddl', 'tasks[].type 被翻成内部常量 event / ddl（中文标签已转换）');
    eq(d.tasks[0].priority, 'mid', 'tasks[].priority 翻成 mid（中文「中」已转换）');
    eq(d.tasks[1].priority, 'high', 'DDL 的优先级是 high');
    eq(d.tasks[0].repeat, 'none', 'tasks[].repeat 默认 none');
    eq(d.tasks[1].start_time, '', 'DDL 的 start_time 是空串（与 normalize.js 的语义一致）');

    // 用 importParsedTasks() 落库：入参形状要正好是 bulk_add 要的
    reset();
    return api.importParsedTasks(d.tasks);
  }).then(function () {
    eq(lastCall().name, 'tasks', 'importParsedTasks() 调的是 tasks 云函数');
    eq(lastCall().data.action, 'bulk_add', 'action 是 bulk_add');
    eq(lastCall().data.tasks.length, 2, 'payload 是 { tasks: [...] }');

    reset();
    return api.aiDecompose({ title: '写毕业论文', date: '2026-12-31' });
  }).then(function (res) {
    eq(decomposeCalls, 1, '真调了一次假 postJson（拆解）');
    eq(res.ok, true, 'aiDecompose 成功 → ok:true');
    var d = res.data;
    eq(d.task, '写毕业论文', 'data.task 原样回显任务名');
    eq(d.deadline, '2026-12-31', 'data.deadline 原样回显截止日');
    eq(d.steps, 3, 'data.steps = subtasks.length');
    eq(d.subtasks.length, 3, 'subtasks 有 3 条');
    eq(Object.keys(d.subtasks[0]).sort().join(','), 'estimate_min,suggested_date,title',
      'subtasks 条目字段：title/suggested_date/estimate_min（没有 date！是 suggested_date）');
    // 【实测口径】normalizeSubtask 只允许 suggested_date 落在 [今天, 截止日]：
    //   模型给的 2026-09-10 早于"今天"（跑测试的当天）→ 被**收到今天**。
    //   所以这里不能断言它等于模型给的日期，只能断言"在合法区间内"，否则换一天跑就会红。
    var today = aiParseFn.todayStr();
    eq(d.subtasks[0].suggested_date, today, '建议日期早于今天 → 被收到今天（' + today + '）');
    isTrue(today <= d.subtasks[0].suggested_date && d.subtasks[0].suggested_date <= '2026-12-31',
      '建议日期落在 [今天, 截止日] 之间');
    isTrue(d.subtasks.every(function (item) {
      return item.suggested_date >= today && item.suggested_date <= '2026-12-31';
    }), '每一条子任务的建议日期都在 [今天, 截止日] 内');
    eq(d.subtasks[0].estimate_min, 120, 'estimate_min 是分钟数（planner.js 的需求就吃这个字段）');
  }).then(function () {
    // 还原，别把补丁留给别的测试
    aiParseFn.postJson = realParsePost;
    aiDecomposeFn.postJson = realDecomposePost;
    restoreEnv(savedEnv);
  });
}

// ---------------------------------------------------------------------------
// 三·五、模型说了"每天" → 一路传到落库的任务里（这条链最容易在映射层被抹平）
// ---------------------------------------------------------------------------
/**
 * 真机现场：用户输入「我要每天中午13:10-13:20都进行学习打卡」。早先这条链有两处会把
 * 重复方式吃掉：`normalizeParseResult` 的 events 里**根本没有 repeat 字段**，
 * 而 `toTaskList` 又写死 `repeat: 'none'` —— 结果是"AI 识别出来了，但存进去变成单次"。
 * 这一节从"模型返回"一路断言到"能落库的 tasks[]"，确保 daily 不再中途蒸发。
 */
function contractOfDailyRepeat() {
  block('AI 契约 —— 模型说「每天」：events 与 tasks[] 都必须是 daily');

  var savedParsePost = aiParseFn.postJson;
  var savedEnv = rememberEnv();
  setFakeKey('ZHIPU_API_KEY', 'test-key-not-used');

  /** 造一个 DeepSeek 风格的响应（contractOfSuccess 里那份在它自己的作用域内，这里要自带一份） */
  function fakeCompletion(jsonText) {
    return Promise.resolve({
      status: 200,
      text: JSON.stringify({ choices: [{ message: { content: jsonText } }] })
    });
  }

  aiParseFn.postJson = function () {
    return fakeCompletion(JSON.stringify({
      events: [
        // ① 每天（用户原话里的形态）
        { title: '学习打卡', date: '2026-10-15', start_time: '12:30', end_time: '12:40',
          type: '日程', priority: '中', repeat: 'daily' },
        // ② 每周三（模型按规则 9 应当输出 weekly）
        { title: '周三开会', date: '2026-10-21', start_time: '15:00', end_time: '16:00',
          type: '日程', priority: '中', repeat: 'weekly' },
        // ③ 模型偶尔会用中文回值 —— 也要认
        { title: '每天背单词', date: '2026-10-15', start_time: '07:30', end_time: '07:50',
          type: '日程', priority: '中', repeat: '每天' },
        // ④ 表达不了的重复（"工作日"）：**不许瞎猜成 daily**，落成 none
        { title: '工作日晨跑', date: '2026-10-16', start_time: '06:30', end_time: '07:00',
          type: '日程', priority: '中', repeat: '工作日' },
        // ⑤ 模型没给 repeat → none
        { title: '临时开会', date: '2026-10-17', start_time: '10:00', end_time: '11:00',
          type: '日程', priority: '中' }
      ],
      deadlines: [],
      needs_clarification: false,
      clarification_question: ''
    }));
  };

  reset();
  return api.aiParse('我要每天中午12:30到12:40学习打卡').then(function (res) {
    eq(res.ok, true, 'aiParse 成功');
    var ev = res.data.events;
    eq(ev.length, 5, 'events 5 条');
    eq(ev[0].repeat, 'daily', '**模型说 daily → events 里就是 daily**（不再被抹掉）');
    eq(ev[1].repeat, 'weekly', '每周三 → weekly');
    eq(ev[2].repeat, 'daily', '中文「每天」也认（模型有时直接回中文）');
    eq(ev[3].repeat, 'none',
      '**「工作日」这种表达不了的 → none**（宁可当单次，也不静默变成一种用户没要的重复）');
    eq(ev[4].repeat, 'none', '模型没给 repeat → 默认 none');

    var tasks = res.data.tasks;
    eq(tasks.length, 5, 'tasks[] 5 条（能直接交给 bulk_add）');
    eq(tasks.map(function (t) { return t.repeat; }).join(','), 'daily,weekly,daily,none,none',
      '**落库的 tasks[].repeat 与 events 一一对应**（这条链的中段就是以前吃掉 daily 的地方）');
    eq(tasks[0].week_start, null, '周次留空：默认值由 tasks 云函数的 normalize 补（单一来源，不在这里造第二套）');
    eq(tasks[0].week_parity, 'all', '单双周一律 all');
    eq(tasks[0].type, 'event', 'type 仍是内部常量 event');
  }).then(function () {
    aiParseFn.postJson = savedParsePost;
    restoreEnv(savedEnv);
  });
}

// ---------------------------------------------------------------------------
// 四、云函数没部署 / 网络异常时，前端要给出能看懂的提示
// ---------------------------------------------------------------------------
function contractOfBrokenCloud() {
  block('AI 契约 —— 云函数调用失败（没部署 / 断网）');

  var original = global.wx.cloud.callFunction;
  var savedEnv = rememberEnv();
  setFakeKey('ZHIPU_API_KEY', 'test-key-not-used');
  // 注意：这一组验的是"callFunction 本身就失败"（没部署 / 断网），
  // 云函数根本没跑起来，所以假 Key 不会带来任何网络行为。

  global.wx.cloud.callFunction = function () {
    return Promise.reject({ errMsg: 'cloud.callFunction:fail function not found' });
  };

  reset();
  return api.aiParse('明天三点开会').then(function (res) {
    eq(res.ok, false, '调用失败 → ok:false（不 reject）');
    eq(res.data, null, 'data 为 null');
    isTrue(res.error.indexOf('function not found') > -1, '把 errMsg 原样带给用户：' + show(res.error));
    eq(toasts.length, 1, '弹了一次 toast');

    // 云函数返回了非对象（例如被网关截断）
    global.wx.cloud.callFunction = function () { return Promise.resolve({}); };
    reset();
    return api.aiParse('明天三点开会');
  }).then(function (res) {
    eq(res.ok, false, '云函数没返回结果 → ok:false');
    isTrue(res.error.indexOf('aiParse') > -1, '提示里点明是哪个云函数没部署：' + show(res.error));

    global.wx.cloud.callFunction = original;
    restoreEnv(savedEnv);
  });
}

// ---------------------------------------------------------------------------
// 五、导入替换 import_replace（会删数据的那个接口）
// ---------------------------------------------------------------------------
// 【为什么单独盯它】它是唯一一个"会删用户数据"的写接口：
//   1. scope 必须**恒为 'courses'** —— 绝不能让它变成可传参的开关（那是删库口子）；
//   2. 返回是**平铺**的，partial 必须能被页面读到（"删成功但插不全"要如实告知）；
//   3. payload 形状要锁死，防止有人"顺手"再加一个可选开关进来。
// ---------------------------------------------------------------------------
function contractOfImportReplace() {
  block('导入替换契约 —— import_replace（会删数据，payload 必须锁死）');

  var factory = loadFakeDb();
  isTrue(typeof factory === 'function', 'require 到了 _fake_db.js（本组要打真实 handler）');
  if (typeof factory !== 'function') return Promise.resolve();

  var db = factory({ tasks: [], settings: [] });
  var originalCall = global.wx.cloud.callFunction;
  global.wx.cloud.callFunction = function (options) {
    var name = options && options.name;
    var data = (options && options.data) || {};
    callLog.push({ name: name, data: data });
    if (name === 'tasks') {
      return tasksFn.handleAction(db, 'me', data).then(function (r) { return { result: r }; });
    }
    return Promise.reject({ errMsg: 'cloud function not found: ' + name });
  };

  var sample = [
    { title: '高等数学', type: 'event', date: '2026-09-07', start_time: '08:00', end_time: '09:40',
      repeat: 'weekly', week_start: 1, week_end: 16, week_parity: 'odd', periods: '1-2' }
  ];

  // ---- 1. 入参契约：action 名、scope 恒为 'courses'、payload 形状 ----
  reset();
  return api.importReplace(sample).then(function (res) {
    eq(callLog.length, 1, 'importReplace() 发了一次请求（桩确实被调用到）');
    eq(lastCall().name, 'tasks', '转发给 tasks 云函数');
    eq(lastCall().data.action, 'import_replace', "action 是 'import_replace'");
    eq(lastCall().data.scope, 'courses', "**scope 恒为 'courses'**（写死，不做参数）");
    eq(Object.keys(lastCall().data).sort().join(','), 'action,scope,tasks',
      'payload 恰好是 {tasks, scope}（+ action）—— 没有别的可选开关');
    eq(lastCall().data.tasks.length, 1, 'tasks 原样带过去');
    eq(lastCall().data.tasks[0].title, '高等数学', 'tasks 内容没被加工');

    // ---- 2. 负向断言：不许出现 scope 以外的开关 ----
    //   （防止以后有人加 scope:'all' / force:true / wipe:true 这种口子）
    var ALLOWED = ['action', 'tasks', 'scope'];
    var extra = Object.keys(lastCall().data).filter(function (k) { return ALLOWED.indexOf(k) === -1; });
    eq(extra.join(','), '', '**没有任何 scope 以外的可选开关**（多出来的键：' + show(extra) + '）');
    eq(deepCarriesKey(lastCall().data), '', '顺带：payload 里也没有 Key 类字段（它不该碰 AI 配置）');

    // ---- 3. 返回形状：平铺在 data 上，字段齐全 ----
    eq(res.ok, true, '成功 → ok:true');
    eq(res.error, null, '成功时 error 为 null');
    var d = res.data || {};
    eq(d.ok, true, 'data.ok 为 true（平铺）');
    eq(d.data, undefined, '**data 上没有嵌套的 data**（平铺，不要去取 .data.data）');
    ['removed', 'inserted', 'skipped', 'duplicates', 'errors', 'partial'].forEach(function (key) {
      isTrue(Object.prototype.hasOwnProperty.call(d, key),
        'data 上必须有 ' + key + '（契约字段）');
    });
    isTrue(Number(d.inserted) >= 1, '真的插进去了至少 1 条（inserted=' + show(d.inserted) + '）');
    isTrue(Array.isArray(d.errors), 'errors 是数组');
    eq(typeof d.partial, 'boolean', 'partial 是布尔值');
    console.log('       （实测 import_replace 返回：' + Object.keys(d).sort().join(', ') + '）');

    // ---- 4. scope 传错必须被云函数拒（这里直接打 handler 验那条红线）----
    reset();
    return tasksFn.handleAction(db, 'me', { action: 'import_replace', tasks: sample, scope: 'all' });
  }).then(function (raw) {
    eq(raw.ok, false, "scope:'all' → ok:false（云函数只认 'courses'）");
    isTrue(String(raw.error).indexOf('scope') > -1, '错误文案点明 scope：' + show(raw.error));

    reset();
    return tasksFn.handleAction(db, 'me', { action: 'import_replace', tasks: sample, scope: 'COURSES' });
  }).then(function (raw) {
    eq(raw.ok, false, "scope:'COURSES' → ok:false（精确匹配、区分大小写，别指望大小写宽容）");

    // ---- 5. 失败形状：{ok:false, error} 且不 reject ----
    reset();
    global.wx.cloud.callFunction = function (options) {
      callLog.push({ name: options.name, data: options.data });
      return Promise.reject({ errMsg: 'cloud.callFunction:fail function not found' });
    };
    return api.importReplace(sample);
  }).then(function (res) {
    eq(res.ok, false, '调用失败 → ok:false（**不 reject**）');
    eq(res.data, null, '失败时 data 为 null');
    isTrue(typeof res.error === 'string' && res.error.length > 0, '带回了错误文案：' + show(res.error));
    isTrue(toasts.length >= 1, '弹了 toast（失败一定要让用户看见）');

    // ---- 6. 回归：bulk_add 的包装没被这次改动弄坏（回应那条"误报的 bug"）----
    //   有人报过"bulkAdd 没把 result 包进 data"——实测是误报：callCloudFunction 早就包了。
    //   这条断言把它钉住：一旦有人真去"补"第二层包装，这里立刻红。
    reset();
    global.wx.cloud.callFunction = originalCall;
    return api.bulkAdd(sample);
  }).then(function (res) {
    eq(lastCall().data.action, 'bulk_add', 'bulkAdd 的 action 没变');
    eq(res.ok, true, 'bulkAdd 成功 → ok:true');
    eq(res.data.data, undefined, '**bulkAdd 的 data 上也没有嵌套 data**（只有一层包装）');
    isTrue(Object.prototype.hasOwnProperty.call(res.data, 'inserted'),
      'bulkAdd 的 data.inserted 可以直接读到（me.js 就是读这个）');
    global.wx.cloud.callFunction = originalCall;
  });
}

// ---------------------------------------------------------------------------
// 六、纯函数层面：toTaskList / extractJsonObject 的容错（不经过 api.js）
// ---------------------------------------------------------------------------
function contractOfPureFunctions() {
  block('AI 契约 —— 纯函数容错（不经过 api.js）');

  // 模型把 JSON 包在代码块里 → 也要能解出来
  var fenced = '```json\n{"events":[],"deadlines":[],"needs_clarification":false,"clarification_question":""}\n```';
  var extracted = aiParseFn.extractJsonObject(fenced);
  isTrue(!!extracted && Array.isArray(extracted.events), '代码块围栏里的 JSON 能解出来');
  // 前后有多余文字（"好的，结果如下：{...}"）→ 截取第一个 { 到最后一个 } 也能解出来
  var wrapped = '好的，结果如下：{"events":[{"title":"开会"}],"deadlines":[]}';
  var wrappedOut = aiParseFn.extractJsonObject(wrapped);
  isTrue(!!wrappedOut && Array.isArray(wrappedOut.events), '前后有多余文字也能解出来');
  // 尾逗号能被修掉
  var trailing = '{"events":[{"title":"开会"},],"deadlines":[],}';
  isTrue(!!aiParseFn.extractJsonObject(trailing), '尾逗号能被修掉');
  // 中文全角引号 / 全角冒号（“events”：）也要能解出来：
  //   原理是先截取第一个 { 到最后一个 }，再把 “ ” 换成 "，尾逗号也顺手去掉。
  var fullWidth = '好的：{“events”：[{"title":"开会"}]}';
  var fullWidthOut = aiParseFn.extractJsonObject(fullWidth);
  isTrue(!!fullWidthOut && Array.isArray(fullWidthOut.events),
    '全角引号 + 全角冒号 + 前后文字也能解出来');
  eq(fullWidthOut && fullWidthOut.events[0].title, '开会', '解出来的内容正确');
  // 中文引号 + 尾逗号 + 多余文字，三样一起来（模型最常吐出来的脏格式）
  var messy = '好的，结果如下：{“events”：[{"title":"开会","date":"2026-09-08","start_time":"15:00","end_time":"","type":"日程","priority":"中"}],}';
  var messyOut = aiParseFn.extractJsonObject(messy);
  isTrue(!!messyOut && Array.isArray(messyOut.events), '中文引号 + 尾逗号 + 多余文字也能解出来');
  eq(messyOut && messyOut.events.length, 1, '解出来 1 条 event');
  eq(messyOut && messyOut.events[0].date, '2026-09-08', '日期字段原样保留');
  // 真的解不出来时必须是 null（不能抛异常、也不能返回半截对象）
  eq(aiParseFn.extractJsonObject('这段话里根本没有 JSON'), null, '完全不是 JSON → null');
  eq(aiParseFn.extractJsonObject(''), null, '空串 → null');
  eq(aiParseFn.extractJsonObject('[1,2,3]'), null, '顶层是数字数组 → null（要的是对象）');

  // toTaskList：没有标题或日期的脏条目要丢掉
  var rows = aiParseFn.toTaskList({
    events: [
      { title: '有标题有日期', date: '2026-09-08', type: '日程', priority: '中' },
      { title: '', date: '2026-09-08', type: '日程', priority: '中' },
      { title: '没日期', date: '', type: '日程', priority: '中' }
    ],
    deadlines: []
  });
  eq(rows.length, 1, 'toTaskList 丢掉缺标题/缺日期的条目');
  eq(rows[0].title, '有标题有日期', '留下的是完整那条');
  eq(rows[0].parent_id, null, '没有父任务时 parent_id 是 null');

  // estimate_min 容错：负数 / 字符串 / 缺失 → 0
  eq(aiParseFn.estimateMinOf({ estimate_min: -10 }), 0, 'estimate_min 负数 → 0');
  eq(aiParseFn.estimateMinOf({ estimate_min: '90' }), 90, "estimate_min '90' → 90");
  eq(aiParseFn.estimateMinOf({}), 0, 'estimate_min 缺失 → 0');
  eq(aiDecomposeFn.normalizeEstimate('abc'), 0, 'normalizeEstimate 非数字 → 0');
  eq(aiDecomposeFn.normalizeEstimate(9999), 1440, 'normalizeEstimate 收敛到 24 小时上限');

  // 拆解结果里，建议日期必须落在 [今天, 截止日]
  var fixed = aiDecomposeFn.normalizeSubtask(
    { title: '太早', suggested_date: '2000-01-01', estimate_min: 30 }, '2026-09-07', '2026-12-31');
  eq(fixed.suggested_date, '2026-09-07', '建议日期早于今天 → 收到今天');
  var late = aiDecomposeFn.normalizeSubtask(
    { title: '太晚', suggested_date: '2030-01-01', estimate_min: 30 }, '2026-09-07', '2026-12-31');
  eq(late.suggested_date, '2026-12-31', '建议日期晚于截止 → 收到截止日');
  eq(aiDecomposeFn.normalizeSubtask({ title: '' }, '2026-09-07', '2026-12-31'), null,
    '没有标题的子任务被丢掉');
}

// ---------------------------------------------------------------------------
// 六、AI Key 配置（三个 action：转发给 tasks 云函数）
// ---------------------------------------------------------------------------
// 【Key 的生命周期】只在上传那一次经过客户端；本组用例盯死三件事：
//   1. 入参名（provider / api_key / model）与返回字段名（provider / model / hasKey / masked）；
//   2. **永远不会把 Key 原文回给前端**（返回里只能有 masked）；
//   3. **AI 调用的 payload 里不许出现 Key**（防止有人"顺手"加回去 → Key 每次请求都上传）。
// ---------------------------------------------------------------------------

/**
 * 拿到「内存假数据库」的工厂函数（云端同学提供的**开发期工具模块**）。
 *
 * 【依赖方向】前端测试依赖云端的**开发期工具模块**，不依赖云端测试文件的内部结构。
 * 早先的写法是"读 `_selftest.js` 源码 → 按字符位置切出 `createFakeDb` → eval"，
 * 那等于把测试挂在**别人文件的排版**上：对方一改（93 KB、1600+ 行、天天在改），
 * slice 位置就错，报错五花八门（`Unexpected end of input` / `Unexpected token 'function'`）。
 * 现在只 require 一个正规模块，接口稳定；那种脆弱耦合已彻底删除，
 * 也**不留"require 失败就退回 eval"的兜底**。
 *
 * 【为什么包 try/catch】模块可能还没落地。require 不存在的文件会抛 MODULE_NOT_FOUND，
 * 任由它抛会把整个汇总入口带崩（这条教训我们踩过不止一次）。所以：
 * 抛错 → 返回 null，本组断言降级为"没借到，低保真模式"并**如实报红**；
 * 落地后 → 自动拿到真函数，本组自动升级为完整校验，测试一行都不用改。
 *
 * 【打包说明】`utils/tests/` 不被任何页面（pages/**）引用；小程序打包只跟随 app.json
 * 的 pages 与它们的 require 链，所以这个目录不进包体。`cloudfunctions/` 是云函数产物，
 * 与小程序包体本来就是两套。`_fake_db.js` 下划线开头、不进任何云函数 package.json，
 * 不会被部署。
 *
 * @returns {Function|null} createFakeDb(seed)；拿不到时返回 null
 */
function loadFakeDb() {
  try {
    // 测试专用路径：从 utils/tests/ 回到工程根，再进 cloudfunctions/
    // eslint-disable-next-line global-require
    var mod = require(path.join(ROOT, 'cloudfunctions', '_fake_db.js'));
    if (mod && typeof mod.createFakeDb === 'function') return mod.createFakeDb;
    console.warn('[ai_contract] cloudfunctions/_fake_db.js 没有导出 createFakeDb（导出的键：'
      + (mod ? Object.keys(mod).join(',') : '(无)') + '）');
    return null;
  } catch (err) {
    console.warn('[ai_contract] 未能 require cloudfunctions/_fake_db.js（该模块由云端同学提供）：'
      + ((err && err.message) || err));
    return null;
  }
}

/**
 * 从返回体里取出配置字段 —— **只认平铺**（字段与 `ok` 同级）。
 *
 * 【参数是 api 层的 res.data，不是整个 res】这里踩过一次：早期实现写的是
 * `result.data`（把整个 {ok,data} 传进来），而调用处传的是 `res.data`（载荷本身），
 * 于是它又去取了一层 `.data` → 永远拿到 undefined，所有字段断言一起红。
 * 现在明确约定：**传入的就是云函数返回的那个对象本身**（`res.data`）。
 *
 * 【为什么不兼容"嵌套"】云端这小时内"平铺 / 嵌套"翻过两次却没人发现，
 * 原因就是这里当时写了"两种都认"的兼容层 —— 它把契约漂移悄悄吞掉了。
 * 形状已钉死为**平铺**，依据是这个函数自己的实现：
 *   `ok(payload)` = `Object.assign({ ok: true }, payload)`（tasks/index.js）
 *   于是 list / stats / settings_get / ai_config_* 全是平铺。
 * 谁再套一层（`res.data.data`）→ 调用处的"形状"断言会**立刻变红**。
 *
 * @param {Object} payload 云函数返回体本身（= api 层的 res.data）
 * @returns {Object} 同一个对象；不是对象就给空对象（让断言去报红）
 */
function configFieldsOf(payload) {
  return (payload && typeof payload === 'object') ? payload : {};
}

/** 哪些键名算"Key 类字段" */
var KEY_LIKE_KEYS = ['api_key', 'apikey', 'key', 'token', 'secret', 'password'];

/**
 * **递归**扫描一个对象/数组，找出任何 Key 类字段名。
 *
 * 为什么必须递归：最初这版只看了一层（`Object.keys(data)`），于是当返回体是
 * **嵌套**的 `{ok:true, data:{...}}` 时，一个藏在 `data.api_key` 里的明文 Key
 * 会被直接漏过去 —— 断言照样"通过"，属于**假绿**。所以这里逐层下钻，
 * 并且配了自检断言证明它真的抓得住嵌套。
 *
 * @returns {string} '' 表示干净；否则返回形如 'data.api_key' 的路径
 */
function deepCarriesKey(value, trail) {
  var here = trail || '';
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i += 1) {
      var foundInArray = deepCarriesKey(value[i], here + '[' + i + ']');
      if (foundInArray) return foundInArray;
    }
    return '';
  }
  if (typeof value !== 'object') return '';

  var keys = Object.keys(value);
  for (var k = 0; k < keys.length; k += 1) {
    var key = keys[k];
    var path = here ? here + '.' + key : key;
    if (KEY_LIKE_KEYS.indexOf(String(key).toLowerCase()) !== -1) return path;
    var found = deepCarriesKey(value[key], path);
    if (found) return found;
  }
  return '';
}

/**
 * 扫描所有外发 payload，找出"带了 Key 字段"的调用。
 *
 * 为什么要有这条负向断言：Key 的设计是"只在保存那一次上传"。如果哪天有人图省事
 * 给 aiParse/aiDecompose 顺手加个 apiKey 参数，Key 就会变成**每次请求都上传** ——
 * 攻击面变大，而且不会有任何报错提示。这个函数就是那道闸门。
 *
 * @returns {string} '' 表示干净；否则返回第一个违规调用的描述
 */
function aiApiCallCarriesKey(calls) {
  var AI_FUNCTIONS = ['aiParse', 'aiDecompose'];
  for (var i = 0; i < (calls || []).length; i += 1) {
    var one = calls[i];
    if (AI_FUNCTIONS.indexOf(one.name) === -1) continue;
    var hit = deepCarriesKey(one.data);
    if (hit) return one.name + ' 的 payload 里出现了 ' + hit + '：' + JSON.stringify(one.data);
  }
  return '';
}

function contractOfAiConfig() {
  block('AI Key 配置契约 —— ai_config_get / ai_config_save / ai_config_clear');

  var savedEnv = clearAllKeys();

  /** 断言某次 payload 的键都在白名单里（守门员自身先自检，见下） */
  function keysAllowed(data, allowed) {
    return Object.keys(data).every(function (key) { return allowed.indexOf(key) !== -1; });
  }
  isTrue(keysAllowed({ provider: 'zhipu', api_key: 'k' }, ['provider', 'api_key']),
    '自检：守门员认得出合规 payload');
  isFalse(keysAllowed({ provider: 'zhipu', api_key: 'k' }, ['provider']),
    '自检：守门员抓得住多出来的键（api_key）');
  isFalse(keysAllowed({ action: 'x' }, []), '自检：空白名单下任何键都算多余');

  // 递归守门员的自检：**必须抓得住嵌套**，否则"藏一层就漏"会伪装成通过（假绿）
  eq(deepCarriesKey({ provider: 'zhipu', masked: '****9999' }), '',
    '自检：干净的配置体 → 不报');
  eq(deepCarriesKey({ ok: true, data: { provider: 'zhipu' } }), '',
    '自检：干净的两层结构 → 不报');
  eq(deepCarriesKey({ ok: true, data: { api_key: 'sk-1' } }), 'data.api_key',
    '自检：**藏在第二层的 api_key 必须被抓到**（旧版只看一层，会漏）');
  eq(deepCarriesKey({ ok: true, data: { list: [{ token: 'sk-1' }] } }), 'data.list[0].token',
    '自检：藏在数组元素里的 token 也要抓到');
  eq(deepCarriesKey({ API_KEY: 'sk-1' }), 'API_KEY', '自检：大小写不敏感');

  // 形状取值器的自检：**只认平铺**（参数是载荷本身，即 res.data）。
  //   嵌套输入必须取不到字段，这样"再套一层"会由调用处的形状断言报红，
  //   而不是被悄悄兼容掉 —— 这正是这次改动的目的。
  var flatProbe = configFieldsOf({ ok: true, provider: 'zhipu', model: 'm', hasKey: true, masked: '****1' });
  eq(flatProbe.provider, 'zhipu', '自检：平铺载荷能取到字段');
  eq(flatProbe.ok, true, '自检：平铺时 ok 与字段同级');
  var nestedProbe = configFieldsOf({ ok: true, data: { provider: 'zhipu', model: 'm', hasKey: true, masked: '****1' } });
  eq(nestedProbe.provider, undefined,
    '自检：**嵌套载荷取不到 provider**（不再兼容 → 会红，而不是被吞掉）');
  eq(configFieldsOf(null).provider, undefined, '自检：null → 空对象');

  // api.readAiConfig 与上面的口径一致：**只读平铺**
  var flatCfg = api.readAiConfig({ ok: true, provider: 'zhipu', model: 'm', hasKey: true, masked: '****1' });
  eq(flatCfg.provider, 'zhipu', 'api.readAiConfig 读平铺');
  eq(flatCfg.hasKey, true, 'api.readAiConfig 平铺时 hasKey 正确');
  var emptyCfg = api.readAiConfig(null);
  eq(emptyCfg.hasKey, false, 'api.readAiConfig(null) → hasKey:false（不抛异常）');
  eq(emptyCfg.provider, '', 'api.readAiConfig(null) → provider 空串');
  eq(deepCarriesKey(api.readAiConfig({ ok: true, provider: 'zhipu', hasKey: true })), '',
    'api.readAiConfig 的输出里永远不会有 Key 字段');

  // ---- 1. aiConfigGet：action 名与空入参 ----
  reset();
  return api.aiConfigGet().then(function (res) {
    eq(callLog.length, 1, 'aiConfigGet() 发了一次请求（桩确实被调用到了）');
    eq(lastCall().name, 'tasks', '转发给 **tasks** 云函数（不是 aiParse / aiDecompose）');
    eq(lastCall().data.action, 'ai_config_get', "action 是 'ai_config_get'");
    eq(Object.keys(lastCall().data).sort().join(','), 'action', 'ai_config_get 只带 action，没有多余入参');
    isTrue(keysAllowed(lastCall().data, ['action']), 'payload 键全部合法');
    isTrue(typeof res.ok === 'boolean', '返回了 {ok:boolean} 形状');
    isFalse(!!res.error, '成功时没有 error');

    // ---- 2. aiConfigSave：本地预校验 ----
    block('AI Key 配置契约 —— aiConfigSave 的本地预校验（拦住的都不发请求）');
    reset();
    return api.aiConfigSave({ provider: 'openai', api_key: 'sk-x' });
  }).then(function (res) {
    eq(res.ok, false, "provider='openai' → ok:false");
    eq(callLog.length, 0, '**不在白名单的 provider：一个请求都不发**');
    isTrue(res.error.indexOf('服务商') > -1, '提示让用户选服务商：' + show(res.error));
    eq(toasts.length, 1, '弹了一次 toast');

    reset();
    return api.aiConfigSave({});
  }).then(function () {
    eq(callLog.length, 0, 'provider 缺失 → 不发请求');
    reset();
    return api.aiConfigSave({ provider: '   ' });
  }).then(function () {
    eq(callLog.length, 0, 'provider 是空白 → 不发请求');
    reset();
    return api.aiConfigSave({ provider: 'ZHIPU', api_key: 'k' });
  }).then(function () {
    eq(callLog.length, 1, "provider 大小写不敏感：'ZHIPU' 归一成 'zhipu' 后放行");
    eq(lastCall().data.provider, 'zhipu', '发出去的 provider 已归一化为小写');

    reset();
    return api.aiConfigSave({ provider: 'zhipu', api_key: new Array(300).join('k') });
  }).then(function (res) {
    eq(res.ok, false, 'api_key 过长 → ok:false');
    eq(callLog.length, 0, '不发请求');
    isTrue(res.error.indexOf('API Key 过长') > -1, '提示"API Key 过长"：' + show(res.error));

    reset();
    return api.aiConfigSave({ provider: 'zhipu', api_key: 'k', model: new Array(100).join('m') });
  }).then(function (res) {
    eq(res.ok, false, 'model 过长 → ok:false');
    eq(callLog.length, 0, '不发请求');

    // ---- 3. aiConfigSave：入参名 / 空串 = 清除 / model 可选 ----
    block('AI Key 配置契约 —— aiConfigSave 的入参名与"空串 = 清除"');
    reset();
    return api.aiConfigSave({ provider: 'deepseek', api_key: '  sk-abc  ', model: '  deepseek-chat  ' });
  }).then(function () {
    eq(callLog.length, 1, '合法入参 → 发了一次请求');
    eq(lastCall().name, 'tasks', '转发给 tasks 云函数');
    eq(lastCall().data.action, 'ai_config_save', "action 是 'ai_config_save'");
    eq(Object.keys(lastCall().data).sort().join(','), 'action,api_key,model,provider',
      'payload 字段名就是 provider / api_key / model（+ action）');
    eq(lastCall().data.provider, 'deepseek', 'provider 原样（已归一化）');
    eq(lastCall().data.api_key, 'sk-abc', 'api_key 去掉了首尾空格');
    eq(lastCall().data.model, 'deepseek-chat', 'model 去掉了首尾空格');
    isTrue(keysAllowed(lastCall().data, ['action', 'provider', 'api_key', 'model']), 'payload 键全部合法');

    reset();
    return api.aiConfigSave({ provider: 'zhipu', api_key: '' });
  }).then(function () {
    eq(callLog.length, 1, 'api_key 为空串 → **仍然发请求**（空串=清除，与云函数语义一致）');
    eq(lastCall().data.api_key, '', '发出去的就是空串（把"清除"显式写进报文）');

    reset();
    return api.aiConfigSave({ provider: 'zhipu', api_key: 'k' });
  }).then(function () {
    eq(Object.keys(lastCall().data).sort().join(','), 'action,api_key,provider',
      '没给 model 就不带该字段（让云函数用它自己服务商的默认模型）');

    // ---- 4. aiConfigClear ----
    block('AI Key 配置契约 —— aiConfigClear');
    reset();
    return api.aiConfigClear();
  }).then(function () {
    eq(callLog.length, 1, 'aiConfigClear() 发了一次请求');
    eq(lastCall().data.action, 'ai_config_clear', "action 是 'ai_config_clear'");
    eq(Object.keys(lastCall().data).sort().join(','), 'action', 'ai_config_clear 只带 action');
    isTrue(keysAllowed(lastCall().data, ['action']), 'payload 键全部合法');

    // ---- 5. 负向断言：AI 调用的 payload 里不许有 Key ----
    block('AI Key 配置契约 —— 负向断言：AI 调用的 payload 里不许出现 Key');
    reset();
    setFakeKey('ZHIPU_API_KEY', 'test-key-not-used');
    return api.aiParse('明天三点开会');
  }).then(function () {
    var parseCalls = callLog.filter(function (c) { return c.name === 'aiParse'; });
    eq(parseCalls.length, 1, '确实调到了 aiParse（桩被调用，没有静默绕过）');
    eq(Object.keys(parseCalls[0].data).sort().join(','), 'text',
      'aiParse 的 payload 只有 text —— 没有 api_key / apiKey / key 之类的键');
    eq(aiApiCallCarriesKey(callLog), '', '扫描全部外发 payload：没有任何 Key 字段');

    reset();
    return api.aiDecompose({ title: '写论文', date: '2026-12-31' });
  }).then(function () {
    var decomposeCalls = callLog.filter(function (c) { return c.name === 'aiDecompose'; });
    eq(decomposeCalls.length, 1, '确实调到了 aiDecompose（桩被调用）');
    eq(Object.keys(decomposeCalls[0].data).sort().join(','), 'deadline,title',
      'aiDecompose 的 payload 只有 title + deadline');
    eq(aiApiCallCarriesKey(callLog), '', '扫描全部外发 payload：没有任何 Key 字段');

    // ---- 6. 打真实 tasks 云函数（用它的内存假库，验完整契约）----
    block('AI Key 配置契约 —— 打真实 tasks 云函数（返回值里不许有 Key 原文）');
    var factory = loadFakeDb();
    // 【这条断言的价值】它告诉你这次跑的是**低保真模式**还是全链路。
    //   借不到时**如实报红**（不放水）：_fake_db.js 由云端同学提供，落地后自动变绿。
    isTrue(typeof factory === 'function',
      'require 到了 cloudfunctions/_fake_db.js 的 createFakeDb（借到 = 全链路校验；'
      + '借不到 = 本组降级为低保真，预期红灯直到该模块落地）');
    if (typeof factory !== 'function') return null;

    var db = factory({ tasks: [], settings: [] });
    var originalCall = global.wx.cloud.callFunction;
    global.wx.cloud.callFunction = function (options) {
      var name = options && options.name;
      var data = (options && options.data) || {};
      callLog.push({ name: name, data: data });
      if (name === 'tasks') {
        // 身份由"云函数"侧决定：这里固定 'me'（真实链路里前端永远不传 openid）
        return tasksFn.handleAction(db, 'me', data).then(function (r) { return { result: r }; });
      }
      return Promise.reject({ errMsg: 'cloud function not found: ' + name });
    };

    reset();
    return api.aiConfigSave({ provider: 'zhipu', api_key: 'sk-secret-value-9999', model: 'glm-4.7-flash' })
      .then(function (saveRes) {
        eq(callLog.length, 1, 'aiConfigSave 走了一次请求');
        eq(lastCall().data.action, 'ai_config_save', 'action 正确');
        isTrue(typeof saveRes.ok === 'boolean', '返回了 {ok:boolean} 形状');

        if (saveRes.ok !== true) {
          // 云函数侧出错时：**不能**把"服务异常"当契约通过（那会掩盖真实故障），
          // 也不能让本文件崩 —— 如实断言失败形状（ok:false + error + data:null）。
          isTrue(typeof saveRes.error === 'string' && saveRes.error.length > 0,
            '失败时返回可读错误文案（不吞错）：' + show(saveRes.error));
          eq(saveRes.data, null, '失败时 data 为 null');
          return null;
        }

        // 【形状断言 —— 专门盯"有没有人再套一层"】
        //   约定：`ok(payload)` 把字段铺在顶层（tasks/index.js 的 ok() 实现），
        //   所以配置字段必须与 ok 同级。这一段存在的意义就是：一旦有人写回
        //   `ok({ data: ... })`，立刻变红，而不是被什么兼容层悄悄吞掉
        //   （这一小时内它翻过两次、都没被发现）。
        eq(saveRes.data.data, undefined,
          '**res.data 上没有嵌套的 data**（形状必须是平铺：字段与 ok 同级）');
        ['provider', 'model', 'hasKey', 'masked'].forEach(function (key) {
          isTrue(Object.prototype.hasOwnProperty.call(saveRes.data, key),
            'res.data 顶层必须有 ' + key + '（平铺约定）');
        });
        // 证据打印：把实测到的顶层字段列出来（保留这句，方便一眼看出形状漂移）
        console.log('       （实测 res.data 顶层字段：' + Object.keys(saveRes.data).sort().join(', ') + '）');

        var d = configFieldsOf(saveRes.data);
        ['provider', 'model', 'hasKey', 'masked'].forEach(function (key) {
          isTrue(Object.prototype.hasOwnProperty.call(d, key),
            '配置字段里必须有 ' + key + '（契约字段）');
        });
        eq(d.provider, 'zhipu', 'provider 回显');
        eq(d.model, 'glm-4.7-flash', 'model 回显');
        eq(d.hasKey, true, 'hasKey 为 true');
        isTrue(/^\*{4}.+$/.test(String(d.masked)),
          'masked 形如 ****xxxx（4 个星号 + 至少 1 个字符）：' + show(d.masked));
        eq(String(d.masked), '****9999', '掩码保留末 4 位、前段全星号（顺带钉住长度口径）');
        eq(String(d.masked).indexOf('secret'), -1, '**masked 里不含 Key 原文的任何片段**');
        eq(String(d.masked).indexOf('sk-'), -1, 'masked 里不含 sk- 前缀');
        eq(JSON.stringify(saveRes.data).indexOf('sk-secret-value-9999'), -1,
          '整个返回体（含嵌套）里都没有 Key 原文');
        // 递归扫描：任何层级出现 api_key / key / token 之类的字段都算泄漏
        eq(deepCarriesKey(saveRes.data), '',
          '递归扫描返回体：没有任何 Key 字段（' + show(deepCarriesKey(saveRes.data)) + '）');

        return api.aiConfigClear().then(function (clearRes) {
          eq(clearRes.ok, true, 'clear 成功');
          var c = configFieldsOf(clearRes.data);
          eq(c.hasKey, false, 'clear 之后 hasKey:false');
          eq(c.provider, '', "clear 之后 provider:''");
          eq(c.masked, '', "clear 之后 masked:''");
          eq(c.model, '', "clear 之后 model:''");
          return api.aiConfigGet();
        }).then(function (getRes) {
          eq(getRes.ok, true, 'clear 之后再 get 成功');
          var g = configFieldsOf(getRes.data);
          eq(g.hasKey, false, '读回来 hasKey:false（写读闭环）');
          eq(g.provider, '', '读回来 provider 为空');
          eq(g.masked, '', '读回来 masked 为空');
          eq(JSON.stringify(getRes.data).indexOf('sk-secret-value-9999'), -1, '读回来也没有 Key 原文');
          eq(deepCarriesKey(getRes.data), '', '读回来的返回体里也没有任何 Key 字段');
        });
      })
      .then(function () {
        // 【顺序很重要】所有请求都发完再还原桩，否则后面几步会打到真桩的 reject 分支上
        global.wx.cloud.callFunction = originalCall;
      });
  }).then(function () {
    restoreEnv(savedEnv);
  });
}

// ---------------------------------------------------------------------------
// 串行跑（都是异步的）
// ---------------------------------------------------------------------------
// 【为什么包在 useStub() 里面】加载期**只注册、不安装全局桩、不启动异步链**：
//   run.js 先 require 本文件（异步断言排队中），紧接着 require 了 ai_page.test.js
//   （它也要改 global.wx），于是本文件那些**排队的续体**跑在了别人的桩上 ——
//   callLog 空 → callLog[0].data 报 undefined。表现为"单独跑全绿、经 run.js 就崩"。
//   现在：装桩与启动都推迟到 done 被 await 的那一刻，谁来 await 都不会踩。
//
// 【为什么导出 Promise】run.js 是入口，它必须等这些异步断言**全部结束**才能打印
// 总结与退出码；否则会出现"报告说全绿、其实还有断言没跑完"的假绿。
var done = (function () {
  // 加载期只做这一件事：记下环境里已有的 wx（用后还原）
  var savedWx = global.wx;
  // 【假数据库只建一次，全组共用】这样"先 get 再 save 再 clear 再 get"是一条真实链路：
  //   settings 集合里的那条记录会被真的写、真的读回来（写读闭环才有意义）。
  var sharedDb = null;

  function useStub() {
    global.wx = {
      showToast: function (options) { toasts.push((options && options.title) || ''); },
      cloud: {
        callFunction: function (options) {
          var name = options && options.name;
          var data = (options && options.data) || {};
          callLog.push({ name: name, data: data });

          if (name === 'aiParse') return aiParseFn.main(data).then(function (r) { return { result: r }; });
          if (name === 'aiDecompose') return aiDecomposeFn.main(data).then(function (r) { return { result: r }; });
          if (name === 'tasks') {
            // tasks 也接到**真的** handleAction 上：action 名 / 入参校验 / 返回形状
            // 全都走真实代码路径，只是数据库是内存的（_fake_db.js，开发期工具）。
            var factory = loadFakeDb();
            if (typeof factory !== 'function') {
              return Promise.reject({ errMsg: 'cloud function not found: tasks（_fake_db.js 不可用）' });
            }
            if (!sharedDb) sharedDb = factory({ tasks: [], settings: [] });
            // 身份由"云函数"侧决定：固定 'me'（真实链路里前端永远不传 openid）
            return tasksFn.handleAction(sharedDb, 'me', data).then(function (r) { return { result: r }; });
          }
          return Promise.reject({ errMsg: 'cloud function not found: ' + name });
        }
      }
    };
  }

  function restoreGlobals() {
    if (savedWx === undefined) delete global.wx; else global.wx = savedWx;
  }

  return Promise.resolve()
    .then(function () {
      useStub();   // 用例真正开始时才装桩
      return contractOfInputs();
    })
    .then(contractOfErrors)
    .then(contractOfSuccess)
    .then(contractOfDailyRepeat)
    .then(contractOfBrokenCloud)
    .then(function () {
      contractOfPureFunctions();
    })
    .then(contractOfImportReplace)
    .then(contractOfAiConfig)
    .then(function () {
      restoreGlobals();   // 跑完立刻把全局还回去，不影响后面的测试文件
      // 被 run.js require 时不要抢着 exit，交给入口汇总
      if (require.main === module) H.report('AI 云函数契约联调');
    })
    .catch(function (err) {
      restoreGlobals();
      console.error('AI 契约测试自己崩了：', err);
      process.exit(2);
    });
})();

module.exports = { done: done };
