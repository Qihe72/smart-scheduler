/**
 * utils/api.js —— 小程序前端调用云函数的**唯一入口**。
 *
 * ===========================================================================
 * 【契约来源 1】cloudfunctions/tasks/index.js（不要自己发明 action 名）
 * ===========================================================================
 *   入参：`{ action, ...payload }`
 *   出参：`{ ok:true, ... }` 成功 / `{ ok:false, error }` 失败
 *
 *   HANDLERS（本文件只准用这几个）：
 *     list          → { tasks, count }
 *     add           → { id, task }                 payload: { task }
 *     bulk_add      → { ids, inserted, skipped, errors[] }   payload: { tasks: [] }
 *     update        → { updated, id, patch, rejected }       payload: { id, patch }
 *     remove        → { removed, removed_ids, children }     payload: { id }
 *     stats         → { total, done, ddl, finished, pending, today, week_no, semester_start }
 *     settings_get  → { semester_start, period_times }
 *     settings_save → { updated, created, semester_start, period_times }  payload: { settings }
 *
 * ===========================================================================
 * 【契约来源 2】两个 **独立** 的 AI 云函数（不是 tasks 的 action！）
 * ===========================================================================
 *   aiParse     入参 { text }            （**没有** action 字段）
 *               出参 { ok:true, events[], deadlines[], needs_clarification, clarification_question,
 *                      tasks[] }  / { ok:false, error:'AI 服务暂不可用' }
 *               其中 tasks[] 已经是能直接丢给 tasks.bulk_add 的形态。
 *   aiDecompose 入参 { title, deadline }  （deadline 是 "YYYY-MM-DD"）
 *               出参 { ok:true, task, deadline, subtasks:[{title,suggested_date,estimate_min}], steps }
 *                     / { ok:false, error:'AI 服务暂不可用' }
 *   两个函数都**只认自己的入参**：多传字段无害，但少了必填字段会直接返回 { ok:false, error }。
 *   未配 DEEPSEEK_API_KEY / 超时 / 非 200 时，error 都是后端那句统一文案
 *   'AI 服务暂不可用' —— 前端**原样展示**，不要自己编造更具体的原因（例如"Key 没配"）。
 *
 * 【身份边界】前端**永远不传 openid**。云函数只从 cloud.getWXContext().OPENID
 * 取身份，前端能指定身份就等于能读全库（见 index.js 顶部的安全铁律）。
 *
 * 【失败处理约定】所有函数**返回 Promise，且永不 reject**：
 *   失败时统一 `wx.showToast` 弹一句中文提示，并 resolve `{ ok:false, error }`。
 *   这样调用方只需要写 `.then(res => { if (!res.ok) return; ... })`，
 *   不用到处包 try/catch —— 页面里少一层缩进，也少一个漏 catch 的白屏。
 */
'use strict';

/** 云函数名（与 cloudfunctions/ 下的目录名一致） */
var CLOUD_FUNCTION_NAME = 'tasks';

/** 两个 AI 云函数的名字（各自独立部署，不是 tasks 的 action） */
var AI_PARSE_FUNCTION = 'aiParse';
var AI_DECOMPOSE_FUNCTION = 'aiDecompose';

/**
 * AI Key 配置相关的三个 action（都转发给 **tasks** 云函数，不是 AI 那两个函数）。
 *
 * 【架构：Key 只上传一次】用户填的 Key 只在"保存"那一次从客户端传到云端并落库
 * （按 openid 存），之后每次 AI 调用由**云函数自己**从数据库读，前端不再持有。
 * 所以：
 *   * aiParse / aiDecompose 的入参里**没有、也不允许有** Key（见那两个封装的注释）；
 *   * 本文件里**任何地方都不把 Key 写进 wx.setStorage / 本地缓存** —— 存的就是云数据库。
 */
var ACTION_AI_CONFIG_GET = 'ai_config_get';
var ACTION_AI_CONFIG_SAVE = 'ai_config_save';
var ACTION_AI_CONFIG_CLEAR = 'ai_config_clear';

/** 支持的服务商白名单（与云函数 PROVIDERS 的 key 一致；空串表示"还没配置"） */
var AI_PROVIDERS = ['zhipu', 'deepseek'];

/** 模型名长度上限（挡掉明显是误粘贴的整段文本） */
var MAX_MODEL_CHARS = 60;

/** Key 的长度上限（各家 Key 都远小于这个数；挡掉误粘贴长文本） */
var MAX_API_KEY_CHARS = 200;

/** 提示文案最长留多少字（toast 太长会被截断成省略号，不如自己先截） */
var MAX_TOAST_CHARS = 30;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 统一的错误文案：云函数给的 error 优先，兜底用调用方写好的中文话术 */
function errorText(result, fallback) {
  var text = result && result.error ? String(result.error) : '';
  return text || fallback || '操作失败，请稍后重试';
}

/** 弹一个不成功的提示；icon:'none' 是因为错误文案通常比较长，对勾图标反而占地方 */
function toastError(message) {
  var text = String(message || '操作失败，请稍后重试');
  if (text.length > MAX_TOAST_CHARS) text = text.slice(0, MAX_TOAST_CHARS) + '…';
  try {
    wx.showToast({ title: text, icon: 'none', duration: 2200 });
  } catch (err) {
    // 极少数情况下（例如页面正在卸载）弹窗会抛错，不能让它把业务错误吞掉
    console.warn('[api] showToast 失败：', err);
  }
}

/** 组装失败的返回值（同时弹提示） */
function failResult(message, extra) {
  var error = String(message || '操作失败，请稍后重试');
  toastError(error);
  return Object.assign({ ok: false, error: error }, extra || {});
}

/** wx.cloud 是否已经就绪（app.js 的 ensureInit() 里做的 wx.cloud.init） */
function cloudReady() {
  return !!(typeof wx !== 'undefined' && wx.cloud && typeof wx.cloud.callFunction === 'function');
}

// ---------------------------------------------------------------------------
// 核心：callCloudFunction(名字, 入参) —— 所有云函数调用的公共实现
// ---------------------------------------------------------------------------

/**
 * 调用任意一个云函数，并把结果统一成 { ok, data, error }。
 *
 * @param {string} functionName 云函数名（tasks / aiParse / aiDecompose）
 * @param {Object} data 入参对象（**不含** functionName）
 * @param {string} emptyHint 返回值不是对象时，提示里该说"哪个云函数没部署"
 * @returns {Promise<{ok: boolean, data: Object|null, error: string|null}>}
 *          data 就是云函数返回的**整个对象**（含 ok 字段），方便直接取
 *          `res.data.tasks` / `res.data.week_no` 之类；失败时 data 为 null。
 */
function callCloudFunction(functionName, data, emptyHint) {
  if (!cloudReady()) {
    // 大多是 app.js 里的 env 占位符没改成自己的云环境 ID —— 提示里直接点出来
    return Promise.resolve(failResult('云开发未初始化，请检查 app.js 里的云环境 ID'));
  }

  return wx.cloud
    .callFunction({ name: functionName, data: data || {} })
    .then(function (res) {
      // callFunction 的第一个参数是云函数 exports.main 的返回值
      var result = res && res.result;
      if (!result || typeof result !== 'object') {
        return failResult(emptyHint || ('云函数 ' + functionName + ' 没有返回结果，请确认已部署'), { data: null });
      }
      if (result.ok !== true) {
        // 【重要】AI 云函数的 error 是后端写好的统一文案（例如 'AI 服务暂不可用'），
        // 这里**原样透传**，前端不要自己编造更具体的原因。
        return failResult(errorText(result, '操作失败'), { data: null });
      }
      return { ok: true, data: result, error: null };
    })
    .catch(function (err) {
      // 走到这里通常是：没部署云函数 / 云环境 ID 写错 / 断网
      var message = (err && (err.errMsg || err.message)) || '网络异常，请稍后重试';
      console.error('[api] 调用云函数失败：', functionName, err);
      return failResult(message, { data: null });
    });
}

/**
 * 调用云函数 `tasks` 的一个 action。
 *
 * @param {string} action 见文件头的 HANDLERS 清单
 * @param {Object} [payload] 除 action 之外的入参（不要放 openid！）
 * @returns {Promise<{ok, data, error}>}
 */
function call(action, payload) {
  var name = String(action === null || action === undefined ? '' : action).trim();
  if (!name) {
    return Promise.resolve(failResult('缺少 action，无法调用云函数'));
  }

  // Object.assign 而不是 {...payload}：小程序基础库对 ES6 对象展开的支持
  // 取决于构建工具版本，用 ES5 写法最稳。
  var data = Object.assign({ action: name }, payload || {});
  return callCloudFunction(CLOUD_FUNCTION_NAME, data, '云函数没有返回结果，请确认 tasks 已部署');
}

// ---------------------------------------------------------------------------
// 任务相关（薄封装：让页面里读起来像业务，而不是在读 action 字符串）
// ---------------------------------------------------------------------------

/**
 * 取当前用户的全部任务（云函数已按 日期 → 开始时间 → 创建时间 排好序）。
 * @returns {Promise<{ok, data, error}>} 成功时 data.tasks / data.count
 */
function listTasks() {
  return call('list');
}

/**
 * 新增一条任务。
 *
 * @param {Object} task 任务对象。字段与云函数 TASK_FIELDS 对齐：
 *        { title, type, date, start_time, end_time, priority, done,
 *          parent_id, repeat, week_start, week_end, week_parity,
 *          periods, location, estimate_min }
 *        （title 必填；date 空则云端补今天；其余非法值云端会自动修正）
 * @returns {Promise<{ok, data, error}>} 成功时 data.id / data.task
 */
function addTask(task) {
  return call('add', { task: task });
}

/**
 * 批量新增（把一整份课表导入时用）。
 *
 * @param {Array<Object>} list 任务数组，**一次最多 200 条**（超出云函数直接报错），
 *        单条不合法只会被跳过并在 data.errors 里说明，不会整批失败。
 * @returns {Promise<{ok, data, error}>} 成功时 data.ids / data.inserted / data.skipped / data.errors
 */
function bulkAdd(list) {
  return call('bulk_add', { tasks: Array.isArray(list) ? list : [] });
}

/**
 * **替换式**导入：先删掉旧的课表类任务，再把新的插进去（云函数 tasks 的 import_replace）。
 *
 * ===========================================================================
 * 【⚠️ 这个调用会删数据】不是"追加"，是"替换"
 * ===========================================================================
 *   它只删「**每周重复 + 有节次**」的课表类任务（云函数侧的 scope='courses' 红线），
 *   一次性日程、DDL、子任务都**不受影响**。用户重新导一份正确课表时用它；
 *   只想补几门课的话用 bulkAdd()，别用这个。
 *
 * 【scope 为什么写死】它是"会删数据"的开关，暴露得越少越好：这里固定传 'courses'，
 *   不做成参数（云函数也只认这一个值，且是精确匹配 —— 'COURSES' / 'courses ' 都会被拒）。
 *
 * 【失败时可能已经删了】云函数会返回 partial:true 表示"旧的可能删掉了、但新的没插全"
 *   （实现上是靠"删除条数是否等于预期"来判断的）。**页面必须把 partial 如实告诉用户**，
 *   不能让用户以为"失败了就当没发生过"——那份课表此时可能已经被删掉一部分了。
 *
 * @param {Array<Object>} list 新的课表类任务数组（与 bulkAdd 同一套字段）
 * @returns {Promise<{ok, data, error}>} 成功时 data 是**平铺**的这些字段：
 *          removed    删掉了几条旧课表
 *          inserted   插入了几条
 *          skipped    因为不合法被跳过的条数
 *          duplicates 判定为重复、没重复插入的条数
 *          errors     被跳过/失败的具体原因（数组）
 *          partial    true = 删成功但插不全，**需要如实告知用户**
 */
function importReplace(list) {
  return call('import_replace', { tasks: Array.isArray(list) ? list : [], scope: 'courses' });
}

/**
 * 修改一条任务（部分字段）。
 *
 * @param {string} id 任务 _id
 * @param {Object} patch 只允许 TASK_FIELDS 里的字段；不在白名单里的键
 *        会被云函数丢掉并出现在 data.rejected 里（安全设计，见 normalize.js）。
 * @returns {Promise<{ok, data, error}>}
 */
function updateTask(id, patch) {
  var taskId = String(id === null || id === undefined ? '' : id).trim();
  if (!taskId) return Promise.resolve(failResult('缺少任务 id，无法修改'));
  return call('update', { id: taskId, patch: patch || {} });
}

/**
 * 删除一条任务（云函数会级联删掉它的直接子任务）。
 * @returns {Promise<{ok, data, error}>} 成功时 data.removed / data.removed_ids
 */
function removeTask(id) {
  var taskId = String(id === null || id === undefined ? '' : id).trim();
  if (!taskId) return Promise.resolve(failResult('缺少任务 id，无法删除'));
  return call('remove', { id: taskId });
}

/**
 * 概览统计（首页顶部那几个数字）。
 * @returns {Promise<{ok, data, error}>} 成功时 data.total / done / pending / ddl /
 *          finished / today / week_no / semester_start
 */
function stats() {
  return call('stats');
}

/**
 * 读设置（学期开始日期 + 校准过的作息表）。
 * @returns {Promise<{ok, data, error}>} 成功时 data.semester_start / data.period_times
 */
function getSettings() {
  return call('settings_get');
}

/**
 * 保存设置。只有 semester_start 与 period_times 两个键会被接受，其余静默忽略。
 *
 * @param {Object} s { semester_start: 'YYYY-MM-DD', period_times: { '1': ['08:00','08:45'], ... } }
 *        只想改一个字段时也可以只传那一个（partial update）。
 * @returns {Promise<{ok, data, error}>} 成功时 data.semester_start / data.period_times 是**保存后**的值
 */
function saveSettings(s) {
  return call('settings_save', { settings: s || {} });
}

// ---------------------------------------------------------------------------
// AI 相关（**独立云函数**，不是 tasks 的 action；入参里没有 action 字段）
// ---------------------------------------------------------------------------

/**
 * 自然语言 → 结构化日程 / 截止事项（云函数 aiParse）。
 *
 * @param {string} text 用户原话，例如「明天下午三点开组会，周五前交实验报告」。
 *        上限 500 字（超了云函数会返回 { ok:false, error:'输入过长…' }）。
 *        空串会被云函数当成"需要追问"，返回 ok:true + needs_clarification:true。
 * @returns {Promise<{ok, data, error}>} 成功时 data 里有：
 *          events[]                [{title, date, start_time, end_time, type:'日程', priority:'中'}]
 *          deadlines[]             [{title, date, start_time:'', end_time, type:'DDL', priority:'高'}]
 *          needs_clarification     boolean（只说了"开会"没说时间 → true）
 *          clarification_question  要追问的那句话
 *          tasks[]                 **已经可以直接丢给 bulkAdd() 的任务数组**
 *          failed 时 error 是后端那句统一文案（例如 'AI 服务暂不可用'），页面原样展示即可。
 */
function aiParse(text) {
  var input = String(text === null || text === undefined ? '' : text).trim();
  if (!input) {
    // 本地先拦一道：空输入没必要花一次云函数调用（云端也会返回"请描述一下你的安排"）
    return Promise.resolve(failResult('请先输入你的安排，例如：明天下午三点开组会'));
  }
  // 【注意】入参里**只有 text**，永远不带 Key：云函数按 openid 自己从数据库读。
  return callCloudFunction(AI_PARSE_FUNCTION, { text: input },
    'AI 云函数没有返回结果，请确认 aiParse 已部署');
}

/**
 * 把一个大任务拆成若干带建议执行日期的子任务（云函数 aiDecompose）。
 *
 * @param {Object} task 任务对象，**必须有 title 与 date（作为截止日）**：
 *        { title: '写毕业论文', date: '2026-12-31' }
 *        （date 为空 / 非法时云函数会返回 { ok:false, error:'截止日期必须是 YYYY-MM-DD…' }）
 * @returns {Promise<{ok, data, error}>} 成功时 data 里有：
 *          task       原样回显的任务名（不信模型改写）
 *          deadline   原样回显的截止日
 *          subtasks[] [{title, suggested_date, estimate_min}]（3~8 步，日期都落在今天~截止日之间）
 *          steps      subtasks.length
 *          想落库时：把每条 subtask 加上 parent_id 与 type:'subtask' 再调 addTask()。
 */
function aiDecompose(task) {
  var source = task && typeof task === 'object' ? task : {};
  var title = String(source.title === null || source.title === undefined ? '' : source.title).trim();
  var deadline = String(source.date === null || source.date === undefined ? '' : source.date).trim();
  if (!title) {
    return Promise.resolve(failResult('任务名称不能为空，无法拆解'));
  }
  if (!deadline) {
    // 拆解要求把子任务铺在「今天 ~ 截止日」之间，没有截止日就没法排
    return Promise.resolve(failResult('这条任务没有日期，无法拆解'));
  }
  return callCloudFunction(AI_DECOMPOSE_FUNCTION, { title: title, deadline: deadline },
    'AI 云函数没有返回结果，请确认 aiDecompose 已部署');
}

// ---------------------------------------------------------------------------
// AI Key 配置（转发给 tasks 云函数的三个 action）
// ---------------------------------------------------------------------------
// 【Key 的生命周期】只在这里被**上传一次**，落库由云函数完成（按 openid 存）。
// 前端不缓存、不落本地存储；之后的每次 AI 调用都由云函数自己读库。
// ---------------------------------------------------------------------------

/**
 * 校验 provider：必须是白名单里的服务商。
 * @returns {string} 归一化后的 provider；非法返回 ''
 */
function normalizeProvider(value) {
  var text = String(value === null || value === undefined ? '' : value).trim().toLowerCase();
  return AI_PROVIDERS.indexOf(text) === -1 ? '' : text;
}

/**
 * 把 ai_config_* 的返回体归一到"纯粹给页面渲染的配置对象"。
 *
 * 【形状：只认平铺】`tasks` 云函数的 `ok(payload)` 是
 * `Object.assign({ ok: true }, payload)`，所以配置字段与 `ok` **同级**：
 *     { ok:true, provider, model, hasKey, masked, updated_at }
 * 页面这样取：
 *
 *   api.aiConfigGet().then(function (res) {
 *     if (!res.ok) return;
 *     var cfg = api.readAiConfig(res.data);   // { provider, model, hasKey, masked, updated_at }
 *   });
 *
 * 【为什么不兼容"嵌套"】曾经这里同时认 `{ok, data:{...}}`。那是错的：形状漂移
 * （有人写回 `ok({ data: ... })`）会被兼容层**悄悄吞掉**，谁都不会发现。
 * 现在只认平铺，漂移会在 utils/tests/ai_contract.js 里当场报红。
 * 这里只留"字段缺失时给安全默认值"的兜底（那是防脏数据，不是兼容形状）。
 *
 * @param {Object} payload 云函数原始返回（也就是 res.data）
 * @returns {{provider, model, hasKey, masked, updated_at}} 取不到的字段给安全默认值
 *          （空串 / false），**永远不会**包含 Key 原文。
 */
function readAiConfig(payload) {
  var body = (payload && typeof payload === 'object') ? payload : {};
  var str = function (value) {
    return String(value === null || value === undefined ? '' : value);
  };
  return {
    provider: str(body.provider),
    model: str(body.model),
    hasKey: body.hasKey === true,
    masked: str(body.masked),
    updated_at: str(body.updated_at)
  };
}

/**
 * 读当前用户已保存的 AI 配置（云函数 tasks 的 ai_config_get）。
 *
 * @returns {Promise<{ok, data, error}>} 成功时 data 是**云函数原始返回**，
 *          配置字段与 `ok` 同级（平铺）：
 *            provider: 'zhipu' | 'deepseek' | ''   // 未配置时是空串
 *            model:    'glm-4.7-flash' | ''          // 已保存的模型名
 *            hasKey:   true | false                  // 有没有存过 Key
 *            masked:   '****abcd' | ''               // **永远不会有 Key 原文**
 *          **推荐用 `api.readAiConfig(res.data)` 取值**（省得每处都判空）。
 */
function aiConfigGet() {
  return call(ACTION_AI_CONFIG_GET);
}

/**
 * 保存 AI 配置（云函数 tasks 的 ai_config_save）。
 *
 * 【空 Key 的语义】`api_key` 传空串 = **清除已保存的 Key** —— 这与云函数完全一致
 * （那边也是"空串即清除"）。所以这里不报错、也不拦住调用，照样转发，
 * 免得出现"前端说不能为空、后端说这是清除"的两套口径。
 * 想显式清除时用 aiConfigClear() 更直观。
 *
 * 【本地预校验】失败的话**直接返回错误、不发请求**：
 *   * provider 不在白名单 → '请选择服务商（智谱 / DeepSeek）'
 *   * model 过长（>60）    → '模型名过长'
 *   * api_key 过长（>200） → 'API Key 过长，请检查是否粘贴错了'
 * 合法的 api_key 在这里只做 trim，不做其它加工，也不会写进任何本地存储。
 *
 * @param {{provider: string, api_key?: string, model?: string}} config
 *        provider 必填且必须是 'zhipu' / 'deepseek'
 *        api_key  空串或省略 = 清除
 *        model    可选；空串 = 让云函数用该服务商的默认模型
 * @returns {Promise<{ok, data, error}>} 成功时 data 与 aiConfigGet 同形状
 *          （provider / model / hasKey / masked），代表**保存之后**的状态。
 */
function aiConfigSave(config) {
  var source = config && typeof config === 'object' ? config : {};

  var provider = normalizeProvider(source.provider);
  if (!provider) {
    return Promise.resolve(failResult('请选择服务商（智谱 / DeepSeek）'));
  }

  // model：可省略；给了就 trim，过长直接拦（多半是误粘贴）
  var model = String(source.model === null || source.model === undefined ? '' : source.model).trim();
  if (model.length > MAX_MODEL_CHARS) {
    return Promise.resolve(failResult('模型名过长，请检查是否粘贴错了'));
  }

  // api_key：可省略；空串 = 清除（与云端一致）。只 trim，不做任何加工或本地留存。
  var apiKey = String(source.api_key === null || source.api_key === undefined ? '' : source.api_key).trim();
  if (apiKey.length > MAX_API_KEY_CHARS) {
    return Promise.resolve(failResult('API Key 过长，请检查是否粘贴错了'));
  }

  var payload = { provider: provider };
  // 只有确实填了 Key 才带这个字段；空串时也**明确带上**空串，
  // 让"清除"这件事在报文里是显式的（云函数对两者的处理一致）。
  payload.api_key = apiKey;
  if (model) payload.model = model;

  return call(ACTION_AI_CONFIG_SAVE, payload);
}

/**
 * 清除已保存的 AI 配置（云函数 tasks 的 ai_config_clear）。
 *
 * @returns {Promise<{ok, data, error}>} 成功时 data 一定是
 *          { provider: '', hasKey: false, masked: '', model: '' } 的形状。
 */
function aiConfigClear() {
  return call(ACTION_AI_CONFIG_CLEAR);
}

/**
 * 把 aiParse 返回的 tasks[] 直接落库（就是 bulk_add 的别名，语义更清楚）。
 * @param {Array<Object>} list 任务数组，一次最多 200 条
 * @returns {Promise<{ok, data, error}>}
 */
function importParsedTasks(list) {
  return bulkAdd(list);
}

module.exports = {
  // 核心
  call: call,
  callCloudFunction: callCloudFunction,
  // 任务
  listTasks: listTasks,
  addTask: addTask,
  bulkAdd: bulkAdd,
  importReplace: importReplace,
  updateTask: updateTask,
  removeTask: removeTask,
  stats: stats,
  // 设置
  getSettings: getSettings,
  saveSettings: saveSettings,
  // AI（独立云函数）
  aiParse: aiParse,
  aiDecompose: aiDecompose,
  importParsedTasks: importParsedTasks,
  // AI Key 配置（转发给 tasks 云函数；前端不缓存 Key）
  aiConfigGet: aiConfigGet,
  aiConfigSave: aiConfigSave,
  aiConfigClear: aiConfigClear,
  readAiConfig: readAiConfig,
  // 常量（页面里写提示文案时可以复用，免得两处各写一遍）
  CLOUD_FUNCTION_NAME: CLOUD_FUNCTION_NAME,
  AI_PARSE_FUNCTION: AI_PARSE_FUNCTION,
  AI_DECOMPOSE_FUNCTION: AI_DECOMPOSE_FUNCTION,
  AI_PROVIDERS: AI_PROVIDERS,
  ACTION_AI_CONFIG_GET: ACTION_AI_CONFIG_GET,
  ACTION_AI_CONFIG_SAVE: ACTION_AI_CONFIG_SAVE,
  ACTION_AI_CONFIG_CLEAR: ACTION_AI_CONFIG_CLEAR
};
