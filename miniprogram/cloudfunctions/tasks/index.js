/**
 * 云函数 tasks —— 智能日程管家的任务管家（增删改查 / 统计 / 设置）。
 *
 * ===========================================================================
 * 【安全铁律】用户身份只从 cloud.getWXContext().OPENID 取
 * ===========================================================================
 *   1. 身份来源唯一：`cloud.getWXContext().OPENID` 由微信云托管在调用链路上注入，
 *      前端**无法伪造**。本函数从头到尾**不接受**任何形式的用户身份参数
 *      （event.openid / event._openid / event.user 之类一律忽略）。
 *   2. 每条查询与每次更新都必须带 `_openid: OPENID` 条件：
 *        - 查：`where({ _openid: OPENID, ... })`
 *        - 改：`where({ _openid: OPENID, _id: id }).update(...)`
 *        - 删：`where({ _openid: OPENID, _id: _.in(ids) }).remove()`
 *      哪怕前端传了别人的 _id，条件里带上 _openid 之后也只会"匹配不到"，
 *      不会越权读写别人的数据。
 *   3. `_openid` 字段只由云数据库在写入时自动注入（客户端写）或这里显式写入，
 *      永远不从前端 patch 里读 —— 见 lib/normalize.js 的 PATCH_WHITELIST。
 *   4. 为什么前端连"自己的 openid"都不该传：一旦前端可以指定身份，
 *      攻击者改一个字段就能读全库。openid 属于**服务端可信信息**，不参与前端入参。
 *
 * 集合：tasks / settings，两者权限都设为「仅创建者可读写」（见 docs/数据库与索引.md）。
 * 依赖：只用内置的 wx-server-sdk，不引入任何其它 npm 包（见 package.json）。
 *
 * 入参：{ action, ...payload }；返回：{ ok:true, ... } 或 { ok:false, error }
 */

'use strict';

// wx-server-sdk 由云函数运行环境提供。这里用 try 包一层，好处是：
// 在没有云环境的机器上（例如 cloudfunctions/_selftest.js）也能 require 本文件，
// 只测里面的纯逻辑，而不会因为缺依赖直接崩掉。
let cloud = null;
let sdkError = null;
try {
  // eslint-disable-next-line global-require
  cloud = require('wx-server-sdk');
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
} catch (error) {
  cloud = null;
  sdkError = error;
}

// 纯逻辑全在 lib/normalize.js 里（可被 _selftest.js 直接 require）
const N = require('./lib/normalize');

const COLLECTION_TASKS = 'tasks';
const COLLECTION_SETTINGS = 'settings';

/** 一次请求最多接收的任务条数（防滥用：前端一次性导入整学期课表也够用） */
const MAX_BULK_INPUT = 200;

/** 一次请求最多处理多少个待删 id（自己 + 子任务） */
const MAX_REMOVE_IDS = 200;

/** 解析入参时忽略的身份类字段（列出来是为了"显式忽略"，不是要用它们） */
const IDENTITY_KEYS = ['openid', '_openid', 'OPENID', 'user', 'user_id', 'unionid', 'uid'];

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 统一的成功返回 */
function ok(payload) {
  return Object.assign({ ok: true }, payload || {});
}

/** 统一的失败返回 */
function fail(error) {
  return { ok: false, error: String(error || '未知错误') };
}

/** 去除入参里所有身份类字段，避免"看起来能用"的错觉（安全兜底，日志也更干净） */
function stripIdentity(payload) {
  const clean = {};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return clean;
  Object.keys(payload).forEach((key) => {
    if (IDENTITY_KEYS.indexOf(key) !== -1) return; // 显式丢弃
    clean[key] = payload[key];
  });
  return clean;
}

/** 取当前调用者的 openid（唯一可信来源） */
function currentOpenId() {
  if (!cloud) return '';
  try {
    const context = cloud.getWXContext() || {};
    return String(context.OPENID || '').trim();
  } catch (error) {
    return '';
  }
}

/** 任务排序：先按日期，再按开始时间，最后按创建时间，保证列表顺序稳定 */
function sortTasks(tasks) {
  const list = Array.isArray(tasks) ? tasks.slice() : [];
  list.sort((a, b) => {
    const dateA = N.toStr(a && a.date);
    const dateB = N.toStr(b && b.date);
    if (dateA !== dateB) return dateA < dateB ? -1 : 1;
    const startA = N.toStr(a && a.start_time);
    const startB = N.toStr(b && b.start_time);
    if (startA !== startB) return startA < startB ? -1 : 1;
    const createdA = N.toStr(a && a.created_at);
    const createdB = N.toStr(b && b.created_at);
    if (createdA !== createdB) return createdA < createdB ? -1 : 1;
    return 0;
  });
  return list;
}

/**
 * 分页取全（云数据库单次最多 100 条，必须循环取）。
 *
 * @param {object} query 已带 `_openid` 条件的查询对象
 * @returns {Promise<Array>} 全部记录
 */
async function fetchAll(query) {
  const all = [];
  let skip = 0;
  // 上限 100 轮 = 10000 条，防止 where 条件写错时死循环
  for (let round = 0; round < 100; round += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await query.skip(skip).limit(N.PAGE_SIZE).get();
    const batch = (result && result.data) || [];
    all.push.apply(all, batch);
    if (batch.length < N.PAGE_SIZE) break;
    skip += N.PAGE_SIZE;
  }
  return all;
}

/** 查当前用户的全部任务（内部通用） */
async function fetchMyTasks(db, openid) {
  return fetchAll(db.collection(COLLECTION_TASKS).where({ _openid: openid }));
}

/** 读设置（没有记录时返回带默认值的空设置） */
async function loadSettings(db, openid) {
  const result = await db.collection(COLLECTION_SETTINGS).where({ _openid: openid }).limit(1).get();
  const row = ((result && result.data) || [])[0] || {};
  return N.withSettingsDefaults(row);
}

/** 读 settings 的**原始行**（AI 配置要看原始字段，不能套默认值） */
async function loadSettingsRow(db, openid) {
  const result = await db.collection(COLLECTION_SETTINGS).where({ _openid: openid }).limit(1).get();
  return ((result && result.data) || [])[0] || null;
}

/**
 * 写 settings 的若干字段（update-and-set 语义：没有记录就创建一条属于自己的）。
 *
 * 【为什么所有 settings 写入都走这里】对 settings 的每次写都必须带 `_openid` 条件，
 * 集中一处就不会漏；也保证"先 update，updated===0 才显式 add"这套口径只有一份实现。
 *
 * @returns {Promise<{updated:number, created:number}>}
 */
async function writeSettingsFields(db, openid, fields, now) {
  const stamp = now || N.nowIso();
  const data = Object.assign({}, fields, { updated_at: stamp });
  const result = await db.collection(COLLECTION_SETTINGS)
    .where({ _openid: openid })
    .update({ data });
  const updated = (result && (result.stats ? result.stats.updated : result.updated)) || 0;
  let created = 0;
  if (!updated) {
    // 第一次保存：显式 add 一条属于自己的（绝不复用 where 条件里的 _id）
    await db.collection(COLLECTION_SETTINGS).add({
      data: Object.assign({}, data, { _openid: openid, created_at: stamp }),
    });
    created = 1;
  }
  return { updated, created };
}

// ---------------------------------------------------------------------------
// 各 action 的实现
// ---------------------------------------------------------------------------

/** list：取当前用户的全部任务 */
async function actionList(db, openid) {
  const tasks = await fetchMyTasks(db, openid);
  return ok({ tasks: sortTasks(tasks), count: tasks.length });
}

/** add：新增一条任务（归一化后入库） */
async function actionAdd(db, openid, payload) {
  const normalized = N.normalizeTask(payload.task, { today: N.todayStr() });
  // 【注意】normalizeTask 即使有校验错误也会返回一个尽量纠正过的 task（方便前端回填与提示），
  // 所以这里**必须**用 errors 判定能不能入库 —— 否则空标题、非法日期就会进库。
  if (!normalized.task || normalized.errors.length) {
    return fail(`任务不合法：${normalized.errors.join('；') || '参数错误'}`);
  }
  const now = N.nowIso();
  const doc = Object.assign({}, normalized.task, {
    _openid: openid, // 显式归属，双保险（云数据库也会自动写入）
    created_at: now,
    updated_at: now,
  });
  const added = await db.collection(COLLECTION_TASKS).add({ data: doc });
  const id = (added && (added._id || added.id)) || '';
  return ok({ id, task: Object.assign({ _id: id }, doc) });
}

/** bulk_add：批量新增（一次最多 20 条，自动分批） */
async function actionBulkAdd(db, openid, payload) {
  const input = Array.isArray(payload.tasks) ? payload.tasks : [];
  if (!input.length) return fail('tasks 不能为空');
  if (input.length > MAX_BULK_INPUT) return fail(`一次最多导入 ${MAX_BULK_INPUT} 条任务`);

  const now = N.nowIso();
  const ready = [];
  const errors = [];
  input.forEach((raw, index) => {
    const normalized = N.normalizeTask(raw, { today: N.todayStr() });
    // 同 actionAdd：有校验错误的一律跳过（单条不合法不影响整批）
    if (!normalized.task || normalized.errors.length) {
      errors.push(`第 ${index + 1} 条：${normalized.errors.join('；') || '参数错误'}`);
      return;
    }
    ready.push(Object.assign({}, normalized.task, {
      _openid: openid,
      created_at: now,
      updated_at: now,
    }));
  });

  const ids = [];
  const batches = N.chunk(ready, N.BULK_CHUNK);
  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    // 云数据库没有"批量插入"接口，只能逐条 add；这里串行执行避免触发并发写限流
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all(batch.map((doc) => db.collection(COLLECTION_TASKS).add({ data: doc })));
    results.forEach((added) => {
      ids.push((added && (added._id || added.id)) || '');
    });
  }

  return ok({ ids, inserted: ids.length, skipped: errors.length, errors });
}

/** update：只允许改白名单字段 */
async function actionUpdate(db, openid, payload) {
  const id = N.toStr(payload.id);
  if (!id) return fail('缺少 id');

  const picked = N.pickPatch(payload.patch, { now: N.nowIso() });
  if (picked.errors.length) return fail(`字段不合法：${picked.errors.join('；')}`);
  if (!Object.keys(picked.patch).length) {
    return fail('patch 里没有可修改的字段（字段不在白名单内或值为空）');
  }

  // where 同时带 _openid 与 _id：别人的任务永远匹配不到
  const result = await db.collection(COLLECTION_TASKS)
    .where({ _openid: openid, _id: id })
    .update({ data: picked.patch });

  const updated = (result && (result.stats ? result.stats.updated : result.updated)) || 0;
  if (!updated) return fail('任务不存在或无权修改');
  return ok({ updated, id, patch: picked.patch, rejected: picked.rejected });
}

/** remove：删除该任务及其直接子任务（级联） */
async function actionRemove(db, openid, payload) {
  const id = N.toStr(payload.id);
  if (!id) return fail('缺少 id');

  const tasks = await fetchMyTasks(db, openid);
  const target = tasks.filter((task) => N.toStr(task._id) === id)[0];
  if (!target) return fail('任务不存在或无权删除');

  const plan = N.collectRemoveIds(tasks, id);
  const ids = plan.ids.slice(0, MAX_REMOVE_IDS);

  let removed = 0;
  const batches = N.chunk(ids, N.PAGE_SIZE); // 单次 remove 上限 100 条
  for (let i = 0; i < batches.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await db.collection(COLLECTION_TASKS)
      .where({ _openid: openid, _id: db.command.in(batches[i]) })
      .remove();
    removed += (result && (result.stats ? result.stats.removed : result.removed)) || 0;
  }

  return ok({ removed, removed_ids: ids, children: plan.children.length });
}

/** stats：概览统计 */
async function actionStats(db, openid) {
  const tasks = await fetchMyTasks(db, openid);
  const settings = await loadSettings(db, openid);
  const stats = N.taskStats(tasks, settings.semester_start, new Date());
  const today = N.todayStr();
  const weekNo = N.weekNumber(today, settings.semester_start);
  return ok(Object.assign({}, stats, { today, week_no: weekNo, semester_start: settings.semester_start }));
}

/** settings_get：读设置 */
async function actionSettingsGet(db, openid) {
  const settings = await loadSettings(db, openid);
  return ok({ semester_start: settings.semester_start, period_times: settings.period_times });
}

/** settings_save：只接受 semester_start 与 period_times */
async function actionSettingsSave(db, openid, payload) {
  const normalized = N.normalizeSettings(payload.settings, { partial: true });
  if (normalized.errors.length) return fail(`设置不合法：${normalized.errors.join('；')}`);

  // 写入统一走 writeSettingsFields（带 _openid、先 update 后 add）
  const result = await writeSettingsFields(db, openid, normalized.settings);
  const saved = await loadSettings(db, openid);
  return ok({
    updated: result.updated,
    created: result.created,
    semester_start: saved.semester_start,
    period_times: saved.period_times,
  });
}

// ---------------------------------------------------------------------------
// AI 配置（用户自填 Key）—— 三个 action
// ---------------------------------------------------------------------------
/**
 * 【这套 action 的设计要点，改之前先读完】
 *
 * 1. **Key 只在"保存"这一次从客户端上来**。存好之后，`aiParse` / `aiDecompose`
 *    是**自己按 openid 去数据库读**的，不需要前端每次把 Key 带上来。
 *    所以前端只需要在"我的 → AI 设置"里调一次 `ai_config_save`。
 * 2. **永远不回传 Key 原文**，只回 `masked`（末 4 位）与 `hasKey`。
 *    返回对象一律过 `N.stripSecrets()`，不靠"记得别写"。
 * 3. **日志里绝不出现 Key**，连前缀也不行。要看来源就打印"来源=用户自填"这种字面量。
 * 4. provider 走**白名单**：不认识就报错，不静默走默认（否则前端会以为设置生效了）。
 */

/**
 * 【返回形状：**平铺**，与 tasks 云函数的整体约定一致】
 *
 *     {ok:true, provider, model, hasKey, masked, updated_at}
 *
 * 本云函数的 `ok(payload)` 就是把 payload 平铺到 `{ok:true}` 上，
 * `list`（`{ok, tasks, count}`）与 `settings_get`（`{ok, semester_start, period_times}`）
 * 都是这么返回的，这三个 AI 配置 action 也照同一个约定 —— 不要再套一层 `data`
 * （套了会让前端多写一层解包，而且和同文件其它 action 不一致）。
 */

/**
 * ai_config_get：读当前用户的 AI 配置（**不含 Key 原文**）。
 * @returns {Promise<{ok:true, provider, model, hasKey, masked, updated_at}>}
 */
async function actionAiConfigGet(db, openid) {
  const row = await loadSettingsRow(db, openid);
  // stripSecrets 是最后一道保险：aiConfigView 本身就不产出 Key 字段
  return ok(N.stripSecrets(N.aiConfigView(row)));
}

/**
 * ai_config_save：保存用户自填的 AI 配置。
 * @param payload {{provider?:string, api_key?:string, model?:string}}
 *        api_key 为空串 = 清除（与 ai_config_clear 等价）
 * @returns {Promise<{ok:true, provider, model, hasKey, masked, updated_at}>}
 */
async function actionAiConfigSave(db, openid, payload) {
  const normalized = N.normalizeAiConfig({
    provider: payload.provider,
    api_key: payload.api_key,
    model: payload.model,
  });
  if (normalized.errors.length) return fail(normalized.errors.join('；'));

  const now = N.nowIso();
  const { provider, api_key: apiKey, model } = normalized.config;

  if (normalized.clearing) {
    // 空 Key = 清除：把 provider / model 一并清掉，不留"半套配置"
    await writeSettingsFields(db, openid, {
      ai_provider: '', ai_api_key: '', ai_model: '', ai_updated_at: now,
    }, now);
    console.log('[tasks] ai_config_save：已清除自填 Key（来源=用户自填）');
    const row = await loadSettingsRow(db, openid);
    return ok(N.stripSecrets(N.aiConfigView(row)));
  }

  await writeSettingsFields(db, openid, {
    ai_provider: provider,
    ai_api_key: apiKey, // 明文入库：集合权限是「仅创建者可读写」，且云函数是唯一读出口
    ai_model: model,
    ai_updated_at: now,
  }, now);

  // 日志只记录"来源"与"填了哪家 / 模型名 / 掩码"，**绝不打印 Key 原文**（连前缀都不打）
  console.log(
    `[tasks] ai_config_save：已保存用户自填 Key（来源=用户自填，`
    + `provider=${provider || '(未指定，用默认)'}，model=${model || '(默认)'}，`
    + `masked=${N.maskApiKey(apiKey) || '(太短不显示掩码)'}）`
  );

  const row = await loadSettingsRow(db, openid);
  return ok(N.stripSecrets(N.aiConfigView(row)));
}

/**
 * ai_config_clear：清除用户自填的 Key（恢复到"用服务端预置 Key"的状态）。
 * @returns {Promise<{ok:true, provider:'', model:'', hasKey:false, masked:'', updated_at}>}
 */
async function actionAiConfigClear(db, openid) {
  const now = N.nowIso();
  await writeSettingsFields(db, openid, {
    ai_provider: '', ai_api_key: '', ai_model: '', ai_updated_at: now,
  }, now);
  console.log('[tasks] ai_config_clear：用户已清除自填 Key，回退到服务端预置（来源=服务端环境变量）');
  const row = await loadSettingsRow(db, openid);
  return ok(N.stripSecrets(N.aiConfigView(row)));
}

const HANDLERS = {
  list: actionList,
  add: actionAdd,
  bulk_add: actionBulkAdd,
  update: actionUpdate,
  remove: actionRemove,
  stats: actionStats,
  settings_get: actionSettingsGet,
  settings_save: actionSettingsSave,
  // AI 配置（用户自填 Key）
  ai_config_get: actionAiConfigGet,
  ai_config_save: actionAiConfigSave,
  ai_config_clear: actionAiConfigClear,
};

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 处理一次调用（纯逻辑 + 数据库操作，db 由外部注入，便于测试）。
 *
 * @param {object} db 云数据库实例（cloud.database()）
 * @param {string} openid 当前用户（只来自 getWXContext）
 * @param {object} event 原始入参
 * @returns {Promise<object>} { ok, ... }
 */
async function handleAction(db, openid, event) {
  if (!db) return fail('数据库不可用：请确认已开通云开发并正确 init');
  if (!openid) return fail('无法识别用户身份，请在小程序内调用');

  const action = N.toStr(event && event.action);
  const handler = HANDLERS[action];
  if (!handler) {
    return fail(`未知 action：${action || '(空)'}；支持 ${Object.keys(HANDLERS).join(' / ')}`);
  }

  // 【关于 api_key】它**不在** IDENTITY_KEYS 里 —— 因为 ai_config_save 确实需要它。
  // 但它是"只进不出"的字段：只有 ai_config_save 会消费它，写进数据库后
  // 任何返回给前端的对象都要过 N.stripSecrets()（见该 action 与 normalize.js）。
  // 其余 action 即便收到 api_key 也不会用它，更不会回传。
  const payload = stripIdentity(event); // 身份类字段显式丢弃
  return handler(db, openid, payload);
}

/** 云函数入口 */
exports.main = async (event) => {
  try {
    if (!cloud) {
      return fail(`云函数依赖未就绪，请在云环境内运行（${sdkError ? sdkError.message : 'wx-server-sdk 缺失'}）`);
    }
    const action = N.toStr(event && event.action);
    if (!action) return fail('缺少 action');
    const openid = currentOpenId();
    return await handleAction(cloud.database(), openid, event);
  } catch (error) {
    // 统一兜底：不把堆栈抛给前端，日志里留全量信息方便排查
    console.error('[tasks] 执行失败：', error && error.stack ? error.stack : error);
    return fail(`服务异常：${(error && error.message) || error}`);
  }
};

// 暴露纯函数给 cloudfunctions/_selftest.js（不依赖 wx-server-sdk 即可测试）
module.exports = {
  main: exports.main,
  handleAction,
  sortTasks,
  fetchAll,
  stripIdentity,
  currentOpenId,
  loadSettings,
  loadSettingsRow,
  writeSettingsFields,
  // AI 配置
  actionAiConfigGet,
  actionAiConfigSave,
  actionAiConfigClear,
  HANDLERS,
  COLLECTION_TASKS,
  COLLECTION_SETTINGS,
  MAX_BULK_INPUT,
};
