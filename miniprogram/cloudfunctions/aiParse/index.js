/**
 * 云函数 aiParse —— 自然语言 → 结构化日程 / 截止事项。
 *
 * 逻辑参考（逐条搬过来，只做 JS 化）：
 *   C:\Users\qihe\Desktop\日程安排\smart-scheduler\ai_parser.py
 *     * parse_natural_input() 的中文 system prompt（含日期换算规则 / 时间换算规则 / few-shot 示例）
 *     * _build_date_reference()  先在本函数里把「今天/明天/本周X/下周X」算成绝对日期，再拼进 prompt
 *     * _build_examples()        few-shot 示例里的日期同样按今天动态算好
 *     * _json_loads_tolerant() / _extract_json()  容错解析（代码块围栏 / 多余文字 / 尾逗号 / 中文引号）
 *     * _normalize_parse_result() / to_local_tasks()  字段补全与标签映射
 *
 * 【依赖】只用 Node.js 内置的 https（不装 axios / node-fetch 等任何 npm 包），
 *         整个云函数只依赖运行环境自带的 wx-server-sdk（package.json 里唯一依赖）。
 *
 * 【服务商】不写死任何一家，由环境变量决定（详见文件里的 PROVIDERS 表）：
 *         * ZHIPU_API_KEY    → 智谱开放平台，默认模型 glm-4.7-flash（推荐，目前免费）
 *         * DEEPSEEK_API_KEY → DeepSeek，默认模型 deepseek-flash（V4.1-Flash，原生多模态；
 *                              deepseek-chat / deepseek-reasoner 自 2026-07-24 起已停止服务）
 *         * LLM_PROVIDER     → 显式指定服务商（zhipu / deepseek）
 *         * LLM_MODEL        → 覆盖模型名，试新模型不用改代码
 *         没显式指定时「谁配了 Key 用谁」，两家都没配才报 AI 服务暂不可用。
 *
 * 【密钥来源：两级】优先级 「用户自填 > 服务端预置 > 报未配置」
 *         1. **用户自填**：用户在「我的 → AI 设置」里填的 Key，存在 settings 集合
 *            （每人一条），本函数按 `_openid` 读出来用 —— **不是前端每次传上来的**。
 *         2. **服务端预置**：环境变量 ZHIPU_API_KEY / DEEPSEEK_API_KEY，作为兜底。
 *         3. 两者都没有 → `AI 服务暂不可用`。
 *         无论哪一级，Key 都**只存在于服务端**：前端拿不到、日志里也绝不出现
 *         （日志只写 `来源=用户自填` / `来源=服务端环境变量`）。
 *         请求体里**不接受** apiKey 字段（传了会被忽略并记一笔日志）。
 *
 * 【禁止自定义 baseUrl】服务商只能从白名单映射到写死的地址。绝不会因为 event 里
 *         带了地址就去请求它 —— 那等于把云函数变成任意请求转发器（SSRF）。
 *
 * 入参（**两个入口，靠 action 区分**）：
 *   ① 文本解析（默认，无 action）：{ text }（**只认这一个字段**）
 *      返回 { ok:true, events, deadlines, needs_clarification, clarification_question, tasks }
 *           或 { ok:false, error:'AI 服务暂不可用' }
 *   ② 课表截图识别：{ action:'parse_image', image_base64, mime_type, week_monday,
 *                     semester_start, week_start, week_end, period_times }
 *      返回 { ok:true, provider, model, events, deadlines, tasks, period_times, warnings, notes }
 *           或 { ok:false, code, error }（code 见下面「识图」一节的 CODE_* 常量）
 *      详见本文件「识图：课表截图 → 课程」那一节。
 */

'use strict';

const https = require('https');

// ---------------------------------------------------------------------------
// 云开发 SDK（只用来做两件事：拿 OPENID、按 openid 读用户自填的 AI 配置）
// ---------------------------------------------------------------------------
// 用 try 包一层：这样在没有云环境的机器上（例如 cloudfunctions/_selftest.js）
// 依然能 require 本文件测纯逻辑，只是"读用户配置"会跳过、直接回退到环境变量。
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

/** 用户自填 AI 配置所在的集合（复用现有的 settings，不新建集合） */
const COLLECTION_SETTINGS = 'settings';

/**
 * 日志用的最后一道保险：把可能混进文本里的凭证抹掉。
 *
 * 为什么需要它：失败日志里会拼进**服务商返回的原文**（错误 message）。正常情况它只有
 * 错误码和一句中文，但万一哪天服务商把请求头回显出来，Key 就直接进日志了。
 * 这里统一把 `Bearer xxx` 与长 token 形状的串替换掉 —— 日志宁可少点信息，也不能漏 Key。
 *
 * @param {string} text 准备写进日志的文本
 * @returns {string} 抹掉凭证痕迹后的文本
 */
function scrubSecret(text) {
  return toStr(text)
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***')
    .replace(/\b(sk|api|key)[-_][A-Za-z0-9._\-]{12,}/gi, '$1-***');
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const TIMEOUT_MS = 15000; // 按需求固定 15 秒
const ERROR_MESSAGE = 'AI 服务暂不可用'; // 未配 key / 超时 / 网络失败 / 非 200 统一返回这句
const PARSE_ERROR_MESSAGE = 'AI 服务暂不可用'; // 解析不出 JSON 时同样走统一文案（日志里有细节）
const MAX_TEXT_LENGTH = 500;
const TEMPERATURE = 0.2; // 解析类任务用低温更稳定（与 Python 版一致）

/**
 * 【契约的一部分】用户**自填**的 Key 失败时给的文案。
 *
 * 为什么与服务端预置的失败文案不同：自填的 Key 是用户自己能修的东西，
 * 告诉他"去哪儿改"才有用；而预置 Key 失败他无能为力，说"AI 服务暂不可用"就够了。
 * 两句话都**不泄露**厂商内部信息（不提 401、不提额度、不提模型名）。
 */
const USER_KEY_FAILED_MESSAGE = '你填的 AI Key 无法使用，请到「我的 → AI 设置」检查或重新填写';

// ---------------------------------------------------------------------------
// 服务商表（不写死任何一家；Key 只从云函数环境变量读，绝不进代码/日志/返回体）
// ---------------------------------------------------------------------------
/**
 * 支持的服务商。两家都是 OpenAI 兼容接口：请求体、成功响应形状
 * （choices[0].message.content）完全一致，所以只换 base / model 即可；
 * 差异集中在**错误码**上，见 classifyHttpError()。
 *
 *   zhipu    —— 智谱开放平台，默认模型 glm-4.7-flash（目前免费），放在推荐位
 *   deepseek —— 备选；用户手上已有的 Key 继续可用，换服务商不会让功能变成不可用
 *
 * ⚠️ 模型名 / 价格会变，以各家官方文档为准；改模型不用改代码，设置环境变量
 *    LLM_MODEL 即可（例如 LLM_MODEL=glm-4.5-flash）。
 */
const PROVIDERS = {
  zhipu: {
    name: 'zhipu',
    label: '智谱开放平台',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4.7-flash',
    apiKeyEnv: 'ZHIPU_API_KEY',
    // 智谱的错误码是**响应体里的业务码**（字符串数字），HTTP 状态码只是外层的壳。
    // 下面几组来自官方「错误码」文档（https://docs.bigmodel.cn/cn/api/api-code）：
    quotaCodes: ['1113', '1302', '1305', '1308', '1309'], // 欠费 / 限流 / 超额度
    authCodes: ['1000', '1001', '1003', '1005'], // 身份验证失败
    modelMissingCodes: ['1211'], // 模型不存在，请检查模型代码
    paramCodes: ['1210', '1212', '1213', '1214', '1215', '1221', '1222', '1261'],
    // 【识图能力】见 visionSupportOf()。判定只三态：true / false / 'unknown' —— 没收录的
    // 一律 'unknown' 并**照常尝试**，让服务端报错说话（新模型层出不穷，硬说"不支持"会挡人）。
    // 列表来源：智谱官方文档的多模态（VLM）模型页；改动时请只增减名字，不要改结构。
    visionModels: [
      'glm-5.3-flash', 'glm-5.3-flashx', 'glm-ocr',
      'glm-4v', 'glm-4v-plus', 'glm-4v-flash',
      'glm-4.1v-thinking-flash', 'glm-4.5v', 'glm-4.6v',
    ],
    // 只把**确定**是纯文本的写进来：判成 false 就一个请求都不发（省用户的钱），
    // 所以宁可漏写（漏写只会退化成 'unknown'，照样试），也不能写错。
    textOnlyModels: ['glm-4.7-flash'],
  },
  deepseek: {
    name: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    // 2026-09-10 发布的 DeepSeek-V4.1-Flash 是**原生多模态**（图像输入进了主模型），
    // API 模型名就是 deepseek-flash —— 所以这里的默认模型也跟着换。
    // 依据：DeepSeek 官方 changelog https://api-docs.deepseek.com/updates/ 与官方视觉指南。
    // ⚠️ 我们**没有**在真机上打过这个接口（见文件末尾「未验证」说明），模型名以官方文档为准。
    defaultModel: 'deepseek-flash',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    // DeepSeek 走标准 HTTP 语义，没有业务码，所以这几组留空、由 HTTP 状态兜底
    quotaCodes: [],
    authCodes: [],
    modelMissingCodes: [],
    paramCodes: [],
    // 【识图能力】DeepSeek 有原生多模态模型（V4.1-Flash）→ 支持列表**不再为空**。
    // deepseek-v4-flash-vision-exp 官方已下线，但为了兼容仍临时路由到 V4.1-Flash，所以也认。
    visionModels: ['deepseek-flash', 'deepseek-v4-flash-vision-exp'],
    // 【已停用】这两个名字自 2026-07-24 起**停止服务**（官方 changelog）—— 它们不是
    // "不支持识图"，而是"这个模型名已经没了"。文案上必须区分开（见 visionUnsupportedMessage）。
    textOnlyModels: ['deepseek-chat', 'deepseek-reasoner'],
  },
};

/**
 * 已停用（官方公告停止服务）的模型名 → 建议改用的模型名。
 *
 * 【为什么要单独一张表】"不支持识图"和"这个名字已经停服了"是两件事，给用户的下一步也不同：
 * 前者是"换个模型"，后者是"你存的名字已经不被服务了，改成 X"。
 * 依据：DeepSeek 官方 changelog（2026-07-24 起 deepseek-chat / deepseek-reasoner 停止服务）。
 */
const RETIRED_MODELS = {
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
};

/** 环境变量名（集中在这里，方便与文档、自测对齐） */
const ENV_PROVIDER = 'LLM_PROVIDER'; // 显式指定服务商
const ENV_MODEL = 'LLM_MODEL'; // 覆盖模型名

/** 默认服务商：未显式指定时，两家都配了 Key 就优先用它 */
const DEFAULT_PROVIDER = 'zhipu';

/** 拼出 chat/completions 端点（base 末尾多写 / 也能容错） */
function chatEndpoint(provider) {
  return `${String(provider.baseUrl).replace(/\/+$/, '')}/chat/completions`;
}

/** 支持的服务商名列表（日志提示用） */
function providerNames() {
  return Object.keys(PROVIDERS);
}

/** 某服务商是否配了 Key（只判断非空，绝不读取/打印 Key 本身） */
function providerHasKey(provider, env) {
  const source = env || process.env;
  return !!((source[provider.apiKeyEnv] || '').trim());
}

/**
 * 解析「这次该用哪个服务商 + 哪个模型」。
 *
 * 规则（与 docs/部署云函数.md 的表格一一对应）：
 *   1. LLM_PROVIDER 指定了且认得出 → 就用它（**即使它没配 Key 也照实用它**），
 *      这样报错会准确说"你指定的那家没配 Key"，而不是偷偷换一家让人困惑。
 *      模型取 LLM_MODEL，否则用这家的默认模型。
 *   2. 没指定 / 指定了不认识的名字 → 按「**谁配了 Key 用谁**」自动挑：
 *        只有 zhipu 有 Key    → zhipu
 *        只有 deepseek 有 Key → deepseek
 *        两家都有 Key         → zhipu（推荐位）
 *        两家都没有 Key       → 返回 ok:false（调用方回报 AI 服务暂不可用）
 *   3. LLM_MODEL 在任何情况下都能覆盖模型名（试新模型不用改代码）。
 *
 * **永不抛异常**：配置问题都变成返回值里的 reason，由调用方决定怎么记日志。
 *
 * @param {object} [env] 便于自测注入的环境变量表；默认 process.env
 * @returns {{ok:boolean, provider:object|null, model:string, reason:string, notices:string[]}}
 */
function resolveProviderConfig(env) {
  const source = env || process.env;
  const notices = [];

  const providerName = toStr(source[ENV_PROVIDER]).toLowerCase();
  const modelOverride = toStr(source[ENV_MODEL]);

  let chosen = null;
  if (providerName) {
    if (!Object.prototype.hasOwnProperty.call(PROVIDERS, providerName)) {
      // 不认识的服务商名：**不静默走默认**，日志里说清楚，再退回自动挑选
      notices.push(
        `${ENV_PROVIDER}="${providerName}" 不是支持的服务商，已忽略并改为自动挑选`
        + `（支持：${providerNames().join(' / ')}）`
      );
      chosen = null;
    } else {
      chosen = PROVIDERS[providerName];
    }
  }

  if (!chosen) {
    const withKey = providerNames().filter((name) => providerHasKey(PROVIDERS[name], source));
    if (withKey.length) {
      const pick = withKey.indexOf(DEFAULT_PROVIDER) !== -1 ? DEFAULT_PROVIDER : withKey[0];
      chosen = PROVIDERS[pick];
      if (withKey.length > 1) {
        notices.push(
          `检测到多个服务商都配了 Key（${withKey.join(' / ')}），`
          + `已选用默认推荐的 ${pick}；想换一家请设置 ${ENV_PROVIDER}`
        );
      }
    }
  }

  const model = modelOverride || (chosen ? chosen.defaultModel : '');

  if (!chosen) {
    const envNames = providerNames().map((name) => PROVIDERS[name].apiKeyEnv).join(' 或 ');
    return {
      ok: false,
      provider: null,
      model,
      reason: `没有任何服务商配置了 API Key（请配置 ${envNames}）`,
      notices,
    };
  }

  if (!providerHasKey(chosen, source)) {
    return {
      ok: false,
      provider: chosen,
      model,
      reason: `${ENV_PROVIDER} 指定了 ${chosen.name}（${chosen.label}），但它没有配置 ${chosen.apiKeyEnv}`,
      notices,
    };
  }

  return { ok: true, provider: chosen, model, reason: '', notices };
}

// ---------------------------------------------------------------------------
// 用户自填 Key（存在 settings 集合里，按 openid 读）
// ---------------------------------------------------------------------------

/** 从云上下文里取 OPENID；没有云环境（本地自测）时返回空串 */
function safeOpenId() {
  if (!cloud) return '';
  try {
    const context = cloud.getWXContext() || {};
    return String(context.OPENID || '').trim();
  } catch (error) {
    return '';
  }
}

/**
 * 取云数据库实例；没有云环境时返回 null（调用方据此跳过"读用户配置"）。
 * 可注入 db 便于自测。
 */
function resolveDb(options) {
  const opts = options || {};
  if (opts.db) return opts.db;
  if (opts.disableDb) return null;
  if (!cloud) return null;
  try {
    return cloud.database();
  } catch (error) {
    return null;
  }
}

/**
 * 按 openid 读用户自填的 AI 配置。
 *
 * 【权限】条件里带 `_openid`，只能读到自己的那一条；读不到 / 出错一律返回 null，
 * 由调用方回退到环境变量（**绝不因为读库失败就整个报错**）。
 *
 * @returns {Promise<{provider:string, apiKey:string, model:string}|null>}
 */
async function loadUserAiConfig(db, openid) {
  if (!db || !openid) return null;
  try {
    const result = await db.collection(COLLECTION_SETTINGS)
      .where({ _openid: openid })
      .limit(1)
      .get();
    const row = ((result && result.data) || [])[0];
    if (!row) return null;
    const apiKey = toStr(row.ai_api_key);
    if (!apiKey) return null; // 没填 Key 等于没配置
    return {
      provider: toStr(row.ai_provider).toLowerCase(),
      apiKey,
      model: toStr(row.ai_model),
    };
  } catch (error) {
    // 读库失败不影响可用性：记一笔日志，回退到服务端预置 Key
    console.error(`[aiParse] 读取用户 AI 配置失败，回退到服务端预置：${(error && error.message) || error}`);
    return null;
  }
}

/**
 * 合并「用户自填」与「服务端预置」两级配置。
 *
 * 优先级：用户自填 > 环境变量预置 > 报未配置。
 * 用户只填了 Key 没选服务商时，用默认推荐服务商（zhipu）。
 *
 * @returns {Promise<{ok:boolean, provider:object|null, model:string, source:string, reason:string}>}
 */
async function resolveEffectiveConfig(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const db = resolveDb(opts);
  const openid = opts.openid === undefined ? safeOpenId() : opts.openid;

  const user = await loadUserAiConfig(db, openid);
  if (user) {
    // 用户填了自己偏好的服务商就用它；没填则用默认推荐的那家
    const name = user.provider || DEFAULT_PROVIDER;
    const provider = Object.prototype.hasOwnProperty.call(PROVIDERS, name)
      ? PROVIDERS[name]
      : PROVIDERS[DEFAULT_PROVIDER];
    return {
      ok: true,
      provider,
      model: user.model || provider.defaultModel,
      apiKey: user.apiKey,
      source: 'user',
      reason: '',
    };
  }

  const server = resolveProviderConfig(env);
  return {
    ok: server.ok,
    provider: server.provider,
    model: server.model,
    apiKey: server.ok ? toStr(env[server.provider.apiKeyEnv]) : '',
    source: 'server',
    reason: server.reason,
    notices: server.notices,
  };
}

/**
 * 当前是否具备调用 AI 的条件 —— 只看服务端预置（同步、不查库）。
 * 真正的可用性判断在 resolveEffectiveConfig()（它还要问一次数据库）。
 */
function hasApiKey() {
  return resolveProviderConfig().ok;
}

/**
 * 把 HTTP 状态码 + 响应体映射成**带服务商语义**的中文说明（只用于日志）。
 *
 * 两家差异：
 *   * 智谱：HTTP 之外还有**响应体业务码**（error.code 为字符串数字），例如
 *     1113=欠费、1210=参数有误、**1211=模型不存在**、1302/1305/1308=限流或超额度。
 *     同样是 429，"欠费"与"限流"的原因完全不同，所以业务码优先判定。
 *   * DeepSeek：基本只用标准 HTTP 语义（401 认证失败 / 429 频率或额度 / 404 模型不存在）。
 *
 * 无论哪家、无论什么原因，**对外都只返回 ERROR_MESSAGE**，厂商原文只进日志。
 *
 * @returns {string} 形如 `认证失败（HTTP 401 / 业务码 1000 / 身份验证失败）`
 */
function classifyHttpError(provider, status, bodyText, model) {
  const body = bodyText || '';
  // 智谱错误体：{"error":{"code":"1211","message":"模型不存在，请检查模型代码"}}
  const codeMatched = body.match(/"code"\s*:\s*"?([0-9A-Za-z_.-]{1,32})"?/);
  const messageMatched = body.match(/"message"\s*:\s*"([^"]{0,200})"/);
  const code = codeMatched ? codeMatched[1] : '';
  const message = messageMatched ? messageMatched[1] : '';
  const detail = [`HTTP ${status}`, code ? `业务码 ${code}` : '', message].filter(Boolean).join(' / ');

  const hasCode = (list) => !!code && list.indexOf(code) !== -1;

  // 服务商专属业务码优先：同一个 HTTP 状态可能对应完全不同的原因
  if (hasCode(provider.quotaCodes)) return `额度/频率受限（${detail}）`;
  if (hasCode(provider.authCodes)) return `认证失败（${detail}）`;
  if (hasCode(provider.modelMissingCodes)) {
    return `模型不存在（当前模型 "${model}"，请检查模型名或改用 ${ENV_MODEL} 覆盖）（${detail}）`;
  }
  if (hasCode(provider.paramCodes)) return `请求参数有误（${detail}）`;

  // 再退回标准 HTTP 语义
  if (status === 401) return `认证失败，API Key 无效或已过期（${detail}）`;
  if (status === 403) return `无权限访问该接口或模型（${detail}）`;
  if (status === 404) return `接口或模型不存在（当前模型 "${model}"）（${detail}）`;
  if (status === 429) return `请求过于频繁或额度不足（${detail}）`;
  if (status === 400) return `请求参数有误，或模型不存在（当前模型 "${model}"）（${detail}）`;
  if (status >= 500) return `服务商内部错误（${detail}）`;
  return `异常状态码（${detail}）`;
}

/** 星期几的中文名（下标 0 = 周一，与 Python date.weekday() 一致） */
const WEEKDAY_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

// ---------------------------------------------------------------------------
// 模型名的"宣传名"纠正（真机踩过的坑）
// ---------------------------------------------------------------------------
/**
 * 【会被误填的宣传名】归一化后的键（小写、去掉 . - _ 空格）→ 它真正对应的 API 模型名。
 *
 * 真机案例：用户在「我的 → AI 设置」的模型框里填了 `deepseek-V4.1-Flash`（DeepSeek 的宣传名），
 * 服务端回"模型不存在"，而当时的文案却让他去查 Key —— 他反复换 Key，问题依旧。
 * 所以：**先把名字改对**，再谈别的。
 *
 * 【为什么是"扁平数组 + 一个目标名"而不是对象】utils/tests 的一致性断言用
 * "从源码文本里抽字符串数组"的办法把云侧/前端两张表对账（与 PROVIDERS 的名单同一套做法），
 * 数组形式能被直接抽出来，对象不行。
 *
 * 【只写真的会失败的写法】大小写差异（GLM-5.3-Flash 之类）不提示 —— 那多半能正常调用，
 * 提示了反而是噪音；没有把握的一律不写（不瞎猜）。
 */
const MODEL_ALIAS_TARGET = 'deepseek-flash';
const MODEL_ALIAS_KEYS = [
  'deepseekv41flash',   // deepseek-v4.1-flash / deepseek-V4.1-Flash / deepseek_v4_1_flash
  'deepseekv41',        // deepseek-v4.1
  'deepseekflashv41',   // deepseek-flash-v4.1
  'v41flash',           // v4.1-flash
];

/** 归一化成"只看字母数字"的键：小写 + 去掉 . - _ 空格（分隔符写法因人而异） */
function aliasKeyOf(model) {
  return normalizeModelKey(model).replace(/[.\-_\s]/g, '');
}

/**
 * 这个模型名是不是"宣传名"？是的话给一句纠正建议，否则返回 ''（**不瞎猜**）。
 *
 * @param {string} model 用户填的模型名
 * @returns {string} '' = 没什么可说的；否则是一句给人看的建议
 */
function modelAliasAdvice(model) {
  const key = aliasKeyOf(model);
  if (!key || MODEL_ALIAS_KEYS.indexOf(key) === -1) return '';
  return `DeepSeek 的 API 模型名是 ${MODEL_ALIAS_TARGET}（V4.1-Flash 是它的宣传名）`;
}

/**
 * 把 HTTP 失败翻译成**给用户看**的那句话（不含厂商原文、不含业务码）。
 *
 * 与 classifyHttpError 的分工：
 *   * classifyHttpError      → 日志用，允许带厂商细节（业务码、原文 message）
 *   * userFacingHttpError    → 用户用，只说"哪一类问题 + 去哪儿改"，并尽量带上模型名
 * 两条口径必须同源（同一个业务码集合），否则会出现"日志说模型不存在、界面说 Key 有问题"。
 *
 * @returns {string} '' = 归类不出具体原因（超时/网络/5xx 等），由调用方用通用文案兜底
 */
function userFacingHttpError(provider, status, bodyText, model) {
  const body = toStr(bodyText);
  const codeMatched = body.match(/"code"\s*:\s*"?([0-9A-Za-z_.-]{1,32})"?/);
  const code = codeMatched ? codeMatched[1] : '';
  const hasCode = (list) => !!code && (list || []).indexOf(code) !== -1;
  const current = toStr(model);
  const advice = modelAliasAdvice(current);
  const tail = advice ? `。${advice}` : '';

  if (hasCode(provider && provider.modelMissingCodes) || status === 404
    || /模型不存在|model not exist|model not found/i.test(body)) {
    return `模型不存在：当前模型「${current}」这个模型名服务端不认，`
      + '请到「我的 → AI 设置」检查模型名' + tail;
  }
  if (hasCode(provider && provider.quotaCodes) || status === 429) {
    return 'AI 额度不足或请求过于频繁，请稍后重试；也可以到「我的 → AI 设置」检查你这个 Key 的额度';
  }
  if (hasCode(provider && provider.authCodes) || status === 401 || status === 403) {
    return '你的 AI Key 无效或已过期，请到「我的 → AI 设置」检查或重新填写';
  }
  if (hasCode(provider && provider.paramCodes) || status === 400 || status === 422) {
    return `请求参数有误（当前模型「${current}」）：请到「我的 → AI 设置」确认模型名与参数` + tail;
  }
  return '';
}
/** 云函数容器时区是 UTC，这里统一按北京时间（UTC+8）算「今天」 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toStr(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  return '';
}

function pad2(number) {
  return String(number).padStart(2, '0');
}

/** 今天（北京时间的 YYYY-MM-DD） */
function todayStr(base) {
  const shifted = new Date((base ? base.getTime() : Date.now()) + BEIJING_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/** 某天是周几（0 = 周一 … 6 = 周日） */
function weekdayIndex(dayStr) {
  const matched = toStr(dayStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) return null;
  const date = new Date(Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3])));
  if (Number.isNaN(date.getTime())) return null;
  return (date.getUTCDay() + 6) % 7;
}

/** 日期加减天数，返回 YYYY-MM-DD */
function addDays(dayStr, days) {
  const matched = toStr(dayStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) return '';
  const date = new Date(Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3])));
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** 某一天所在周的周一 */
function mondayOf(dayStr) {
  const index = weekdayIndex(dayStr);
  if (index === null) return '';
  return addDays(dayStr, -index);
}

/** 入参校验：返回空字符串表示通过，否则是给用户看的提示 */
function validateText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return '请先输入你的安排，例如：明天下午三点开组会';
  }
  if (text.trim().length > MAX_TEXT_LENGTH) {
    return `输入过长（最多 ${MAX_TEXT_LENGTH} 字），请分几次输入`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// 容错 JSON 解析（对齐 _json_loads_tolerant / _extract_json）
// ---------------------------------------------------------------------------

/**
 * 带常见修复的 JSON.parse 包装。
 * 修复顺序与 Python 版一致：原样 → 去尾逗号 → 全角标点转半角 → 两者都做。
 *
 * 关于全角标点：模型用中文输入法时，除了会把引号写成 “ ”，还常常把
 * **键值分隔的冒号写成全角 `：`（U+FF1A）**、把逗号写成 `，`（U+FF0C）。
 * 这两种字符在 JSON 里不是合法的结构符号，不换掉就必然解析失败，
 * 所以这里一并转成半角（U+FF1A→':'、U+FF0C→','）。
 *
 * @returns {object|Array|null} 解析失败返回 null（不抛异常）
 */
function jsonLoadsTolerant(text) {
  if (typeof text !== 'string' || !text.trim()) return null;

  // 全角 → 半角：引号、冒号、逗号
  const normalized = text
    .replace(/[\u201c\u201d]/g, '"') // “ ”
    .replace(/[\u2018\u2019]/g, "'") // ‘ ’
    .replace(/\uff1a/g, ':') // ：全角冒号
    .replace(/\uff0c/g, ','); // ，全角逗号
  const candidates = [
    text, // 原样
    text.replace(/,\s*([}\]])/g, '$1'), // 去尾逗号
    normalized, // 全角转半角
    normalized.replace(/,\s*([}\]])/g, '$1'), // 两者都做
  ];

  for (let i = 0; i < candidates.length; i += 1) {
    try {
      return JSON.parse(candidates[i]);
    } catch (error) {
      // 继续试下一种修复
    }
  }
  return null;
}

/**
 * 从模型返回的文本里提取 JSON 对象（对齐 _extract_json）。
 *   1) 直接解析整段文本
 *   2) 剥掉 Markdown 代码块围栏（```json ... ``` / ``` ... ```）
 *   3) 截取第一个 { 到最后一个 } 之间的内容（应对「好的，结果如下：{...}」）
 *   4) 全都失败 → null（调用方据此返回友好错误）
 * 另外：模型偶尔会返回数组（例如 [{...}]），此时取第一个对象。
 *
 * @returns {object|null}
 */
function extractJsonObject(content) {
  if (typeof content !== 'string' || !content.trim()) return null;

  const text = content.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const stripped = fenced ? fenced[1].trim() : '';

  const candidates = [text, stripped];
  [stripped, text].forEach((base) => {
    if (!base) return;
    const start = base.indexOf('{');
    const end = base.lastIndexOf('}');
    if (start !== -1 && end > start) candidates.push(base.slice(start, end + 1));
  });

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (!candidate) continue;
    const data = jsonLoadsTolerant(candidate);
    if (isPlainObject(data)) return data;
    // 模型返回 [{...}] 这种数组：取第一个对象
    if (Array.isArray(data) && data.length && isPlainObject(data[0])) return data[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// 结果归一化（对齐 _normalize_parse_result / to_local_tasks）
// ---------------------------------------------------------------------------

/** AI 返回的中文标签 → 内部常量 */
const TYPE_CN_TO_CONST = {
  日程: 'event', event: 'event',
  ddl: 'ddl', 截止: 'ddl',
  子任务: 'subtask', subtask: 'subtask',
};

const PRIORITY_CN_TO_CONST = {
  高: 'high', high: 'high',
  中: 'mid', mid: 'mid',
  低: 'low', low: 'low',
};

/** 容错查表：先精确匹配，再统一小写匹配（模型大小写不稳定） */
function lookupLabel(mapping, value, fallback) {
  const key = toStr(value);
  if (!key) return fallback;
  if (Object.prototype.hasOwnProperty.call(mapping, key)) return mapping[key];
  const lowered = key.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(mapping, lowered)) return mapping[lowered];
  return fallback;
}

/** 预计耗时：非法 / 负数 / 缺失一律 0（= 没估，绝不瞎猜） */
function estimateMinOf(item) {
  if (!isPlainObject(item)) return 0;
  const raw = item.estimate_min;
  let value = 0;
  if (typeof raw === 'number' && Number.isFinite(raw)) value = Math.trunc(raw);
  else if (typeof raw === 'string') {
    const matched = raw.trim().match(/^-?\d+/);
    if (matched) value = parseInt(matched[0], 10);
  }
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

/**
 * 模型给的"重复方式" → 本项目的白名单值。
 *
 * 【为什么必须过白名单】模型偶尔会把"工作日""每两周"糊成 daily/weekly。宁可落成单次
 * （用户看得见、能自己改），也不要静默变成一种他没要的重复 —— 那比不识别更糟。
 * 中文值也认（模型有时直接回"每天"）。
 *
 * @param {*} value 模型返回的 repeat
 * @returns {'none'|'daily'|'weekly'}
 */
function normalizeRepeatValue(value) {
  const text = toStr(value).toLowerCase();
  if (text === 'daily' || text === '每天' || text === '每日' || text === '天天') return 'daily';
  if (text === 'weekly' || text === '每周') return 'weekly';
  return 'none';
}

/**
 * 把模型返回的对象补齐成固定结构（缺字段 / 类型不对都不炸）。
 * @returns {{events: Array, deadlines: Array, needs_clarification: boolean, clarification_question: string}}
 */
function normalizeParseResult(data) {
  const result = { events: [], deadlines: [], needs_clarification: false, clarification_question: '' };
  if (!isPlainObject(data)) return result;

  const rawEvents = data.events;
  if (Array.isArray(rawEvents)) {
    rawEvents.forEach((item) => {
      if (!isPlainObject(item)) return;
      result.events.push({
        title: toStr(item.title),
        date: toStr(item.date),
        start_time: toStr(item.start_time),
        end_time: toStr(item.end_time),
        type: toStr(item.type) || '日程',
        priority: toStr(item.priority) || '中',
        // 【必须原样带过去】早先这里没有 repeat，于是"每天打卡"在落库时被抹成单次
        // （toTaskList 那时写死 repeat:'none'）—— 用户看到的是"识别出来了但没生效"。
        repeat: normalizeRepeatValue(item.repeat),
      });
    });
  }

  const rawDeadlines = data.deadlines;
  if (Array.isArray(rawDeadlines)) {
    rawDeadlines.forEach((item) => {
      if (!isPlainObject(item)) return;
      // 【容错】按 prompt 要求 DDL 只有 end_time；万一模型把截止时刻写进 start_time，
      //         这里顺手迁移过来，前端就不会看到一个"没有时间的截止"。
      let endTime = toStr(item.end_time);
      const startTime = toStr(item.start_time);
      if (!endTime && startTime) endTime = startTime;
      // 兼容模型把 ddl 混在 deadlines 数组里但 type 写成别的值
      const type = lookupLabel(TYPE_CN_TO_CONST, item.type, 'ddl');
      result.deadlines.push({
        title: toStr(item.title),
        date: toStr(item.date),
        start_time: '',
        end_time: endTime,
        type: type === 'ddl' ? 'DDL' : toStr(item.type),
        priority: toStr(item.priority) || '高',
      });
    });
  }

  // 与 Python 版一致：只有拿到真正的布尔 true 才算需要追问
  result.needs_clarification = data.needs_clarification === true;
  result.clarification_question = toStr(data.clarification_question);
  return result;
}

/**
 * 把解析结果转换成 tasks 集合可用的任务数组（对齐 to_local_tasks）。
 * 前端拿到后可以直接交给 tasks 云函数的 bulk_add。
 *
 * @param {object} parseResult normalizeParseResult() 的返回值
 * @param {string} [parentId] 可选的父任务 _id
 * @returns {Array} 任务数组（没有标题或日期的脏条目会被过滤）
 */
function toTaskList(parseResult, parentId) {
  if (!isPlainObject(parseResult) || parseResult.error) return [];
  const rows = [];

  (parseResult.events || []).forEach((item) => {
    if (!isPlainObject(item)) return;
    rows.push({
      title: toStr(item.title),
      type: lookupLabel(TYPE_CN_TO_CONST, item.type, 'event'),
      date: toStr(item.date),
      start_time: toStr(item.start_time),
      end_time: toStr(item.end_time),
      priority: lookupLabel(PRIORITY_CN_TO_CONST, item.priority, 'mid'),
      done: false,
      parent_id: parentId === undefined ? null : parentId,
      // 【重复方式照搬模型给的（已过白名单）】周次留空由 tasks 云函数的 normalize 补默认值
      // （1~20 周），单一来源在那边，这里不自己造一套。
      repeat: normalizeRepeatValue(item.repeat),
      week_start: null,
      week_end: null,
      week_parity: 'all',
      periods: '',
      location: toStr(item.location),
      estimate_min: estimateMinOf(item),
    });
  });

  (parseResult.deadlines || []).forEach((item) => {
    if (!isPlainObject(item)) return;
    rows.push({
      title: toStr(item.title),
      type: lookupLabel(TYPE_CN_TO_CONST, item.type, 'ddl'),
      date: toStr(item.date),
      // 截止类没有起始时间，只有截止时刻
      start_time: '',
      end_time: toStr(item.end_time),
      priority: lookupLabel(PRIORITY_CN_TO_CONST, item.priority, 'high'),
      done: false,
      parent_id: parentId === undefined ? null : parentId,
      repeat: 'none',
      week_start: null,
      week_end: null,
      week_parity: 'all',
      periods: '',
      location: toStr(item.location),
      estimate_min: estimateMinOf(item),
    });
  });

  // 过滤掉没有标题或日期的脏数据
  return rows.filter((row) => row.title && row.date);
}

// ---------------------------------------------------------------------------
// Prompt 拼装（对齐 _build_date_reference / _build_examples / parse_natural_input）
// ---------------------------------------------------------------------------

/**
 * 生成「相对日期 → 绝对日期」的参考表。
 *
 * 相对日期由模型换算容易出错，这里先在程序里算好，让模型照抄，
 * 这样「明天 / 后天 / 本周三 / 下周三」等表达就有了确定的唯一答案。
 */
function buildDateReference(today) {
  const base = toStr(today) || todayStr();
  const thisMonday = mondayOf(base);
  const nextMonday = addDays(thisMonday, 7);
  const lines = [
    `- 今天：${base}（${WEEKDAY_CN[weekdayIndex(base)]}）`,
    `- 明天：${addDays(base, 1)}`,
    `- 后天：${addDays(base, 2)}`,
    `- 大后天：${addDays(base, 3)}`,
  ];
  for (let i = 0; i < WEEKDAY_CN.length; i += 1) {
    lines.push(`- 本${WEEKDAY_CN[i]}：${addDays(thisMonday, i)}`);
  }
  for (let i = 0; i < WEEKDAY_CN.length; i += 1) {
    lines.push(`- 下${WEEKDAY_CN[i]}：${addDays(nextMonday, i)}`);
  }
  return lines.join('\n');
}

/** 生成 4 条 few-shot 示例，日期全部按今天动态算好（与 Python 版一一对应） */
function buildExamples(today) {
  const base = toStr(today) || todayStr();
  const tomorrow = addDays(base, 1);
  const nextMonday = addDays(mondayOf(base), 7);

  // 本周五；如果本周五已经过去（<今天），就理解为下周五（与规则 2 一致）
  const thisMonday = mondayOf(base);
  let friday = addDays(thisMonday, 4);
  if (friday < base) friday = addDays(friday, 7);

  return [
    '示例 1：',
    '输入：明天下午三点开组会',
    `输出：{"events":[{"title":"开组会","date":"${tomorrow}","start_time":"15:00","end_time":"","type":"日程","priority":"中"}],"deadlines":[],"needs_clarification":false,"clarification_question":""}`,
    '',
    '示例 2：',
    '输入：这周五前交实验报告',
    `输出：{"events":[],"deadlines":[{"title":"交实验报告","date":"${friday}","type":"DDL","priority":"高"}],"needs_clarification":false,"clarification_question":""}`,
    '',
    '示例 3：',
    '输入：10月15号上午九点半体检',
    `输出：{"events":[{"title":"体检","date":"${nearestMonthDay(base, 10, 15)}","start_time":"09:30","end_time":"","type":"日程","priority":"中"}],"deadlines":[],"needs_clarification":false,"clarification_question":""}`,
    '',
    '示例 4（注意：截止只有一个时刻，没有开始时间）：',
    '输入：下周一中午十二点前交项目申报书',
    `输出：{"events":[],"deadlines":[{"title":"交项目申报书","date":"${nextMonday}","end_time":"12:00","type":"DDL","priority":"高"}],"needs_clarification":false,"clarification_question":""}`,
  ].join('\n');
}

/**
 * 「X 月 Y 号」取今天之后最近的那一个（今年已过就取下一年）。
 * 注意：这里用今天算示例日期，所以示例里的月份日期永远不是"过去的日期"。
 */
function nearestMonthDay(today, month, day) {
  const base = toStr(today) || todayStr();
  const year = Number(base.slice(0, 4));
  const candidate = `${year}-${pad2(month)}-${pad2(day)}`;
  return candidate < base ? `${year + 1}-${pad2(month)}-${pad2(day)}` : candidate;
}

/**
 * 拼装 system prompt。
 * 【重要】日期参考表与 few-shot 示例都用「今天」现算，模型只需照抄，不需要自己做日期运算。
 */
function buildSystemPrompt(today) {
  const base = toStr(today) || todayStr();
  const weekday = WEEKDAY_CN[weekdayIndex(base)];

  return `你是一个中文日程解析助手。你的任务是把用户的自然语言输入解析成严格的 JSON。

今天是 ${base}（${weekday}）。请严格依据下面的日期参考表换算所有相对日期：
${buildDateReference(base)}

【日期换算规则】逐条遵守，这是本任务最容易出错的地方：
1. 「明天 / 后天 / 大后天 / 下周X / 本周X」直接查上面的参考表，不要自己推算。
2. 「这周五 / 本周五 / 周五」：如果本周的那一天还没过（≥今天），就用本周的；如果已经过去，就用下周的那一天。
3. 「三天后 / 一周后 / 两天以后」：今天 + 3 天 / 今天 + 7 天 / 今天 + 2 天。
4. 「10月15号 / 10-15 / 10/15 / 十月十五」：年份取今天之后最近的那一年（今年该日期已过则取下一年）。
5. 「月底 / 月初」：本月最后一天 / 本月第一天。「下个月X号」：下个月的 X 号。
6. 只说了月份日期、没说年份时，一律按「今天之后最近的这一天」处理，不要输出过去的日期。

【时间换算规则】：
1. 24 小时制、HH:MM 补零输出：上午九点 → 09:00；下午三点 → 15:00；晚上八点半 → 20:30；中午十二点 → 12:00。
2. 十二小时制换算：上午/早上/清晨 保持小时不变；下午/傍晚/晚上/夜里 小时 +12；凌晨 0-5 点保持原样。
3. 「半」= 30 分，「一刻」= 15 分，「三刻」= 45 分，「整」= 00 分。
4. 只给了日期没给时间 → start_time 与 end_time 都填空字符串 ""，不要瞎猜一个时间。

${buildExamples(base)}

只输出一个 JSON 对象，不要输出解释、不要用 Markdown 代码块、不要添加额外字段。结构必须完全如下：
{
  "events": [
    {"title": "字符串", "date": "YYYY-MM-DD", "start_time": "HH:MM", "end_time": "HH:MM", "type": "日程", "priority": "中", "repeat": "none"}
  ],
  "deadlines": [
    {"title": "字符串", "date": "YYYY-MM-DD", "end_time": "HH:MM", "type": "DDL", "priority": "高"}
  ],
  "needs_clarification": false,
  "clarification_question": ""
}

其他规则：
1. 有明确开始时间的具体安排放进 events；「某时间点之前必须完成」类（截止、DDL、交作业、提交报告）放进 deadlines。
2. events 的 type 固定为 "日程"；deadlines 的 type 固定为 "DDL"。
3. 【重要】deadlines 表示的是一个**截止时刻**，不是一段时间：没有 start_time 字段，不要编造开始时间。
   用户说了具体时刻（「中午十二点」「下午五点前」「23:59 前」）就填进 end_time；
   只说了日期（「10月15号交」）就把 end_time 留空字符串，表示「当天结束前截止」。
4. priority 只能取 "高"、"中"、"低"：用户明确说了紧急/重要就用 "高"，DDL 默认 "高"，其余默认 "中"。
5. 所有 date 必须是绝对的 YYYY-MM-DD（月份日期补零，如 2026-10-05），禁止输出"明天""这周五""10月15号"这类写法。
6. 一句话里可能包含多件事（例如"明天三点开会，周五前交报告"），请全部解析出来，不要漏。
7. 只有标题、缺少必要时间信息（例如只说"开会"而没说什么时候）时，把 needs_clarification 设为 true，并在 clarification_question 里用一句简短中文追问；这时 events 和 deadlines 可以为空数组。
8. 如果输入与日程完全无关，返回空的 events、deadlines，needs_clarification 设为 false。
9. events 里的 repeat 只能取三个值，**严格按用户原话判断，不要自己推测**：
   * "none"：一次性安排（没提重复时的默认值）。
   * "daily"：用户说了"每天 / 每日 / 天天 / 每天都"这类天天都发生的安排
     （例如"我要每天中午12:30到12:40学习打卡"）。这时 date 填**第一次发生的那天**（通常是今天或用户指定的起始日），
     start_time / end_time 照常填。
   * "weekly"：用户说了固定星期几的重复（例如"每周三下午三点开会"）。这时 date 填**最近的那个周三**。
10. 表达不了的重复**不要硬套**：用户说"工作日""每隔一天""每两周""每月"时，
    不要把它当成 daily 或 weekly；按单次安排输出，并把 needs_clarification 设为 true，
    在 clarification_question 里说明目前支持"每天"与"每周X"，问他想建成哪一种。`;
}

// ---------------------------------------------------------------------------
// 调用 DeepSeek（只用内置 https）
// ---------------------------------------------------------------------------

/**
 * POST JSON，返回 {status, body}；网络错误 / 超时抛异常。
 * 不依赖任何第三方 http 库，超时靠 req.setTimeout + req.destroy 实现。
 */
function postJson(url, payload, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = Buffer.from(JSON.stringify(payload), 'utf8');

    const req = https.request({
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': body.length,
      }, headers || {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') });
      });
    });

    req.setTimeout(timeoutMs, () => {
      const error = new Error(`请求超时（>${timeoutMs / 1000} 秒）`);
      error.code = 'TIMEOUT';
      req.destroy(error);
    });
    req.on('error', (error) => reject(error));
    req.write(body);
    req.end();
  });
}

/**
 * 调服务商的 Chat Completions（智谱 / DeepSeek 共用这一套，只有 base 与 model 不同）。
 *
 * Key 走两级：**用户自填（按 openid 读库）> 服务端环境变量预置**。
 *
 * @param {Array} messages OpenAI 格式消息列表
 * @param {boolean} jsonMode 是否请求 response_format=json_object
 * @param {number} temperature 采样温度
 * @param {object} [options] { env, db, openid } —— 便于自测注入
 * @returns {Promise<{content: string|null, error: string|null, provider: string, model: string,
 *                    source: string, reason: string}>}
 *          error 要么是 ERROR_MESSAGE，要么（用户自填 Key 失败时）是 USER_KEY_FAILED_MESSAGE
 */
async function chatCompletion(messages, jsonMode, temperature, options) {
  const opts = options || {};
  const config = await resolveEffectiveConfig(opts);

  if (config.notices) config.notices.forEach((notice) => console.warn(`[aiParse] ${notice}`));

  if (!config.ok) {
    // 没有任何可用 Key / 指定了一家但没配 Key：不发任何网络请求
    console.warn(`[aiParse] 跳过 AI 调用（来源=服务端环境变量）：${config.reason}`);
    return {
      content: null, error: ERROR_MESSAGE, provider: '', model: config.model,
      source: config.source, reason: config.reason,
    };
  }

  const provider = config.provider;
  const model = config.model;
  const endpoint = chatEndpoint(provider);
  const apiKey = config.apiKey;
  const source = config.source;
  // 日志里的来源字样（**只写这四个字，绝不写 Key 本身或它的前缀**）
  const sourceLabel = source === 'user' ? '来源=用户自填' : '来源=服务端环境变量';
  // 【用户自填 Key 的失败文案】分两档：
  //   * 能被 classifyHttpError 归类（模型不存在 / 额度 / 参数 / 认证）→ 用户可见的就是**那句具体的**；
  //   * 归类不了（超时 / 网络 / 返回不合法 / 内容为空）→ 才回通用的那句。
  //
  // 【为什么必须这样】真机上踩过：用户把 DeepSeek 的宣传名 `deepseek-V4.1-Flash` 填进模型框，
  // 服务端回"模型不存在"，而我们一律显示「你填的 AI Key 无法使用」—— 于是他去反复换 Key，
  // 而真正错的是模型名。**通用文案会把"参数错"误导成"凭证错"**，这是最贵的一类误导。
  // 预置 Key 那条路径保持统一文案不变（用户对服务端预置的 Key 无能为力，说了也改不了）。
  const failureMessage = source === 'user' ? USER_KEY_FAILED_MESSAGE : ERROR_MESSAGE;
  const failureFor = (specific) => ((source === 'user' && specific) ? specific : failureMessage);

  const payload = {
    model, // 模型名来自白名单映射或用户设置，**不接受 event 里传的模型/地址**
    messages,
    temperature: typeof temperature === 'number' ? temperature : TEMPERATURE,
    stream: false,
  };
  if (jsonMode) payload.response_format = { type: 'json_object' };

  const headers = { Authorization: `Bearer ${apiKey}` };
  // 所有日志文本都过一遍 scrubSecret（第二道保险，第一道是"根本不拼 Key 进去"）
  const describe = (error) => scrubSecret(`${provider.name}/${model}（${sourceLabel}）${error}`);

  // 【为什么写 exports.postJson 而不是 postJson】前端契约测试会临时替换
  // module.exports.postJson 来假装服务端响应（零网络回归测试）。直接调用本地的
  // postJson 会让替换失效、真的把请求发出去，所以这里刻意走 exports 这个"活引用"。
  let response;
  try {
    response = await exports.postJson(endpoint, payload, headers, TIMEOUT_MS);
  } catch (error) {
    // 超时 / DNS 失败 / 连接被重置都走这里；日志记原因，但**绝不打印 Key**
    const reason = describe(`请求失败：${(error && error.message) || error}`);
    console.error(`[aiParse] ${reason}`);
    return { content: null, error: failureMessage, provider: provider.name, model, source, reason };
  }

  // 个别端点/模型不支持 response_format 时会返回 400，此时去掉该字段重试一次
  // （智谱对 JSON 模式的支持就靠这段兜底）
  if (response.status === 400 && jsonMode) {
    console.warn(`[aiParse] ${describe('拒绝了 response_format，去掉该字段重试一次')}`);
    delete payload.response_format;
    try {
      response = await exports.postJson(endpoint, payload, headers, TIMEOUT_MS);
    } catch (error) {
      const reason = describe(`重试失败：${(error && error.message) || error}`);
      console.error(`[aiParse] ${reason}`);
      return { content: null, error: failureMessage, provider: provider.name, model, source, reason };
    }
  }

  if (response.status !== 200) {
    // 认证失败 / 额度不足 / 模型不存在 / 参数有误 各自成一条明确日志
    const reason = describe(classifyHttpError(provider, response.status, response.text, model));
    console.error(`[aiParse] ${reason}`);
    // 用户可见的那句：归类得出具体原因就用它（不含厂商原文/业务码，见 userFacingHttpError）
    const specific = userFacingHttpError(provider, response.status, response.text, model);
    return {
      content: null, error: failureFor(specific), provider: provider.name, model, source, reason,
    };
  }

  let data;
  try {
    data = JSON.parse(response.text);
  } catch (error) {
    const reason = describe('返回的内容不是合法 JSON');
    console.error(`[aiParse] ${reason}`);
    return { content: null, error: failureMessage, provider: provider.name, model, source, reason };
  }

  // 智谱与 DeepSeek 的成功响应形状一致：choices[0].message.content
  // （智谱在开启思维链时另有 message.reasoning_content，这里只取 content）
  const content = data
    && data.choices && data.choices[0]
    && data.choices[0].message && data.choices[0].message.content;
  if (typeof content !== 'string' || !content.trim()) {
    const reason = describe('返回结构异常或内容为空');
    console.error(`[aiParse] ${reason}`);
    return { content: null, error: failureMessage, provider: provider.name, model, source, reason };
  }
  return { content, error: null, provider: provider.name, model, source, reason: '' };
}

// ---------------------------------------------------------------------------
// 识图：课表截图 → 课程（action: 'parse_image'）
// ---------------------------------------------------------------------------
/**
 * ===========================================================================
 * 这一节与上面的文本解析（handleParse）是**两条独立入口**，共享的只有三样：
 *   1. 服务商表与 Key 的两级来源（resolveEffectiveConfig：用户自填 > 环境变量）
 *   2. 容错 JSON 解析（extractJsonObject）与常量映射（TYPE_CN_TO_CONST / PRIORITY_CN_TO_CONST）
 *   3. 出网方式（exports.postJson —— 契约测试替换它才能做到零网络回归）
 *
 * 刻意**不共享**的三件事，每条都有原因：
 *   * 【超时】VISION_TIMEOUT_MS = 45 秒，文本路径仍是既成的 15 秒。识图要传图、
 *     而 glm-5.3-flash 会先"思考"再答，15 秒几乎必然超时。两条路径的超时互相独立，
 *     改一个不会动到另一个。
 *   * 【不带 response_format】glm-5.3-flash 的 thinking 只能 enabled，官方也没承诺
 *     JSON 模式一定生效，带上反而可能吃 400。所以 JSON 靠提示词约束 + 容错解析兜底。
 *   * 【失败分码】文本路径对外只有一句统一文案；识图必须让用户知道"该换模型 / 该换小图 /
 *     该稍后重试"，所以返回 { ok:false, code, error }。
 *
 * 【三条安全红线（改动时不许破）】
 *   1. base64 **绝不进日志、绝不进错误信息**：日志里只允许出现「mime + 字节数」。
 *      厂商的报错原文也要过 scrubImagePayload() 把长 base64 串抹掉再写日志。
 *   2. 图片**只在内存里活这一次请求**：不落库、不上云存储、不缓存。
 *   3. Key 仍只从服务端读（用户自填按 openid 查库 > 环境变量），前端传什么都不认。
 * ===========================================================================
 */

/** 识图入口的 action 名（前端 utils/api.js 的 AI_PARSE_ACTION_PARSE_IMAGE 必须一致） */
const ACTION_PARSE_IMAGE = 'parse_image';

/** 图片路径的超时：45 秒（文本路径保持 TIMEOUT_MS = 15 秒不动） */
const VISION_TIMEOUT_MS = 45000;

/** base64 字符数上限：900000 ≈ 660 KB 原图。再大基本不是课表截图，直接拒 */
const MAX_IMAGE_BASE64_CHARS = 900000;

/** 只认这三种 MIME（与前端 wx.chooseMedia + wx.compressImage 的产物一致） */
const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** 识图采样参数：智谱官方对 glm-5.3-flash 的推荐值 */
const VISION_TEMPERATURE = 1;
const VISION_TOP_P = 0.95;

/** 文案里推荐的识图模型（真正的"支持列表"是 PROVIDERS[*].visionModels） */
const VISION_RECOMMENDED_MODELS = ['glm-5.3-flash', 'glm-ocr'];

/** 失败码：前端按 code 决定给哪句话；error 永远是人话 */
const CODE_VISION_UNSUPPORTED = 'VISION_UNSUPPORTED'; // 模型不支持识图（本需求的核心）
const CODE_NO_API_KEY = 'NO_API_KEY';                 // 没有可用的 Key
const CODE_BAD_IMAGE = 'BAD_IMAGE';                   // 图片格式/尺寸不合法
const CODE_TIMEOUT = 'TIMEOUT';                       // 模型太慢（区别于其它失败）
const CODE_QUOTA = 'QUOTA';                           // 欠费 / 限流 / 超额度
const CODE_MODEL_MISSING = 'MODEL_MISSING';           // 模型名不存在
const CODE_PARSE_FAILED = 'PARSE_FAILED';             // 拿到了回答但不是可用的 JSON
const CODE_AUTH = 'AUTH';                             // Key 无效 / 无权限
const CODE_FAILED = 'FAILED';                         // 其它失败（网络 / 5xx / 参数）
const CODE_BAD_ACTION = 'BAD_ACTION';                 // 不认识的 action

/** 图片相关的人话文案（**任何一条都不许把 base64 拼进来**） */
const IMAGE_TOO_LARGE_MESSAGE = '图片太大，请重新截图或先裁剪，只保留课表部分';
const IMAGE_INVALID_MESSAGE = '这张图没能识别：格式不支持或数据不完整，请用 JPG / PNG 的清晰截图';
const IMAGE_EMPTY_MESSAGE = '没有收到图片数据，请重新拍照或从相册选一张课表截图';
const NO_API_KEY_MESSAGE = '还没有可用的 AI Key，请到「我的 → AI 设置」填写后再识别图片';
const PARSE_FAILED_MESSAGE = '没能从这张截图里读出课表，换一张更清晰、只含课表的截图，或改用文字录入';
const VISION_QUOTA_MESSAGE = 'AI 额度不足或请求过于频繁，请稍后重试；也可以到「我的 → AI 设置」检查这个 Key 的额度';
const VISION_AUTH_MESSAGE = 'AI Key 验证失败，请到「我的 → AI 设置」检查 Key 是否有效';
const VISION_TIMEOUT_MESSAGE = `识别超时：等了 ${VISION_TIMEOUT_MS / 1000} 秒模型还没返回。`
  + '可以换成 glm-ocr 试试（它更快），或稍后重试';

/**
 * 服务端报错里出现这些词，说明"这次请求带了图片，但模型/接口不认它"。
 *
 * 【为什么要靠关键词】各家对"模型不支持图片输入"的报错五花八门（有的 400、有的 422、
 * 有的把它归进参数错误业务码），官方文档也没给一个稳定的错误码。所以先用关键词兜底，
 * 并且要求**同时**满足"HTTP 400/415/422 或业务码属于参数类"，避免把 5xx、限流误判成它。
 */
const VISION_KEYWORDS = [
  '不支持', '图片', '图像', '视觉', '识图', '多模态',
  'image', 'vision', 'multimodal', 'content type', 'content-type', 'content_type',
];

/** 服务端说"图太大"的关键词（要先于 VISION_KEYWORDS 判：它同样含"图片"二字） */
const IMAGE_TOO_LARGE_PATTERN = /(too large|too big|exceed|size limit|过大|尺寸|大小超|超出[^,，]{0,6}(大小|尺寸|限制))/i;

/**
 * 日志用的图片脱敏：把可能被厂商回显出来的长 base64 串换成占位符。
 *
 * 【为什么必须有】错误信息里会拼进服务端返回的原文。正常情况它只有一句中文报错，
 * 但"参数有误"类的报错常常会**回显出错字段的内容**（例如 messages[1].content[1].image_url）。
 * 一张 900 KB 的 base64 写进日志既会撑爆日志，也可能带上用户的隐私（课表截图）。
 */
function scrubImagePayload(text) {
  return scrubSecret(text)
    .replace(/[A-Za-z0-9+/]{60,}={0,2}/g, '<base64 已省略>') // base64 长串
    .replace(/data:image\/[a-z+]+;base64,[^\s"']*/gi, 'data:image/<已省略>');
}

/** 模型名归一化：去空白、转小写，并容忍 `provider/model`、`model:free` 这类网关写法 */
function normalizeModelKey(model) {
  let text = toStr(model).toLowerCase();
  const slash = text.lastIndexOf('/');
  if (slash !== -1) text = text.slice(slash + 1);
  const colon = text.indexOf(':');
  if (colon !== -1) text = text.slice(0, colon);
  return text.trim();
}

/**
 * 取某个服务商的"已知支持识图 / 已知不支持识图"名单。
 * providerName 认不出来时，把**所有**服务商的名单合起来看（宁可判得出，也不要漏判）。
 *
 * @param {string} providerName 'zhipu' / 'deepseek' / 其它
 * @returns {{vision: string[], textOnly: string[]}}
 */
function visionModelLists(providerName) {
  const name = toStr(providerName).toLowerCase();
  const names = Object.prototype.hasOwnProperty.call(PROVIDERS, name) ? [name] : providerNames();
  const vision = [];
  const textOnly = [];
  names.forEach((one) => {
    (PROVIDERS[one].visionModels || []).forEach((item) => {
      if (vision.indexOf(item) === -1) vision.push(item);
    });
    (PROVIDERS[one].textOnlyModels || []).forEach((item) => {
      if (textOnly.indexOf(item) === -1) textOnly.push(item);
    });
  });
  return { vision, textOnly };
}

/**
 * 【本需求的核心】这个模型能不能识图？**三态**，不要简化成布尔。
 *
 *   true      已知支持（白名单里）→ 照常发请求
 *   false     已知**不支持**（纯文本模型）→ **一个请求都不发**，直接回 VISION_UNSUPPORTED
 *             （省用户的钱和时间：拿 glm-4.7-flash 传图，必然是白跑一次 + 一句看不懂的错）
 *   'unknown' 没收录 → 照常尝试。模型迭代太快，把没见过的名字当成"不支持"会挡住能用的人；
 *             真不支持时由服务端报错，再看事后那条关键词判定。
 *
 * @param {string} model 模型名（可带 provider/ 前缀或 :tag 后缀）
 * @param {string} [providerName] 服务商名（'' = 不知道，按全部服务商合并看）
 * @returns {boolean|'unknown'}
 */
function visionSupportOf(model, providerName) {
  const key = normalizeModelKey(model);
  if (!key) return 'unknown'; // 空模型名不代表任何模型（调用方会先按"没配模型"处理）
  const lists = visionModelLists(providerName);
  if (lists.vision.indexOf(key) !== -1) return true;
  if (lists.textOnly.indexOf(key) !== -1) return false;
  return 'unknown';
}

/**
 * 「换一个能识图的模型」这句人话 —— 必须带**当前模型名**与**建议换的模型名**，
 * 用户才知道去哪儿改、改成什么。
 *
 * 【关键：建议只在**同一家服务商**里挑，绝不劝人换服务商】
 * 早先版本以为 DeepSeek 没有多模态，于是对 DeepSeek 用户说"换服务商 + 换 Key" ——
 * 那是**错的**（DeepSeek 的 V4.1-Flash 就是原生多模态）。现在建议直接从
 * `PROVIDERS[provider].visionModels` 里取，天然就是"同一家、不用换 Key"。
 *
 * 【已停用的模型名要先说清】deepseek-chat / deepseek-reasoner 自 2026-07-24 停止服务，
 * 这不是"模型不支持识图"，而是"你存的名字已经没了"，所以单独一句、给的是替代名字。
 *
 * @param {string} model 当前模型名
 * @param {string} providerName 当前服务商
 * @returns {string}
 */
function visionUnsupportedMessage(model, providerName) {
  const key = normalizeModelKey(model);
  if (RETIRED_MODELS[key]) {
    return `当前模型 ${toStr(model)} 自 2026-07-24 起已停止服务，请到「我的 → AI 设置」`
      + `把模型改成 ${RETIRED_MODELS[key]}（DeepSeek V4.1-Flash，自带识图能力），也可以继续用文字录入。`;
  }

  // 建议里**排除当前模型**（否则会出现"把 deepseek-v4-flash-vision-exp 换成 deepseek-v4-flash-vision-exp"）
  const suggestion = visionSuggestions(providerName)
    .filter((name) => normalizeModelKey(name) !== key);
  if (!suggestion.length) {
    return `当前模型 ${toStr(model)} 不具备识图能力，无法识别图片。`
      + '请到「我的 → AI 设置」换一个支持识图的模型（同一家服务商里换就行，不用换 Key），'
      + '也可以继续用文字录入。';
  }
  const listText = suggestion
    .map((name) => (name === 'glm-ocr' ? `${name}（专做图文解析）` : `${name}（原生多模态）`))
    .join('或');
  return `当前模型 ${toStr(model)} 不具备识图能力，无法识别图片。请到「我的 → AI 设置」`
    + `把模型换成 ${listText}；换同一家的模型就行，不用换 Key。也可以继续用文字录入。`;
}

/**
 * 给某个服务商挑两个"能识图的模型"作为建议（优先官方推荐的智谱那两个，其余按名单顺序）。
 * 只在该服务商自己的 visionModels 里挑 —— 这是"不劝人换服务商"的技术保证。
 *
 * @param {string} providerName
 * @returns {string[]} 最多 2 个模型名；这家一个都没有时返回空数组（调用方给通用文案）
 */
function visionSuggestions(providerName) {
  const lists = visionModelLists(providerName);
  const preferred = VISION_RECOMMENDED_MODELS.filter((name) => lists.vision.indexOf(name) !== -1);
  const rest = lists.vision.filter((name) => preferred.indexOf(name) === -1);
  return preferred.concat(rest).slice(0, 2);
}

/** 从报错体里抠出业务码（智谱是 error.code 的字符串数字） */
function businessCodeOf(bodyText) {
  const matched = toStr(bodyText).match(/"code"\s*:\s*"?([0-9A-Za-z_.-]{1,32})"?/);
  return matched ? matched[1] : '';
}

/**
 * 【事后那条腿】服务端报错看起来是"不接受图片输入"吗？**纯函数**，好单独测。
 *
 * 判定要**同时**成立两件事，缺一不可：
 *   1. 语义词命中（不支持 / 图片 / image / multimodal / content type …）
 *   2. 属于"参数类"错误：HTTP 400 / 415 / 422，或业务码在 provider.paramCodes 里
 * 只看关键词会把 5xx、限流误判成"模型不支持识图"，那会把用户引到错误的方向。
 *
 * @param {object} provider 服务商对象（用它的 paramCodes）
 * @param {number} status HTTP 状态码
 * @param {string} bodyText 响应体原文
 * @returns {boolean}
 */
function isVisionUnsupportedError(provider, status, bodyText) {
  const body = toStr(bodyText).toLowerCase();
  if (!body) return false;
  const code = businessCodeOf(body);
  const paramCodes = (provider && provider.paramCodes) || [];
  const paramLike = status === 400 || status === 415 || status === 422
    || (!!code && paramCodes.indexOf(code) !== -1);
  if (!paramLike) return false;
  return VISION_KEYWORDS.some((word) => body.indexOf(word.toLowerCase()) !== -1);
}

/** 服务端说"图太大"吗？（同样要求参数类状态码，避免把别处的"超出"误判） */
function isImageTooLargeError(status, bodyText) {
  const body = toStr(bodyText);
  if (!body) return false;
  if (status !== 400 && status !== 413 && status !== 422) return false;
  return IMAGE_TOO_LARGE_PATTERN.test(body);
}

/**
 * 把识图请求的失败（HTTP 状态 + 响应体）翻译成 { code, error }。
 * 纯函数：不碰网络、不碰日志，便于单测直接把各种报错喂进来。
 *
 * @param {object} provider 服务商对象
 * @param {number} status HTTP 状态码
 * @param {string} bodyText 响应体
 * @param {string} model 当前模型名（文案里要用）
 * @returns {{code:string, error:string}}
 */
function classifyVisionFailure(provider, status, bodyText, model) {
  const providerName = (provider && provider.name) || '';
  // 顺序有讲究：先排"图太大"（它同样含"图片"二字），再排"不支持图片输入"
  if (isImageTooLargeError(status, bodyText)) {
    return { code: CODE_BAD_IMAGE, error: IMAGE_TOO_LARGE_MESSAGE };
  }
  if (isVisionUnsupportedError(provider, status, bodyText)) {
    return { code: CODE_VISION_UNSUPPORTED, error: visionUnsupportedMessage(model, providerName) };
  }

  const code = businessCodeOf(bodyText);
  const hasCode = (list) => !!code && (list || []).indexOf(code) !== -1;
  const suggestions = `识图推荐 ${VISION_RECOMMENDED_MODELS.join(' / ')}`;

  if (hasCode(provider && provider.modelMissingCodes) || status === 404
    || /模型不存在|model not exist|model not found/i.test(toStr(bodyText))) {
    // 模型名写错时，若它是"宣传名"，把正确写法一起给出来（真机踩过：用户填 deepseek-V4.1-Flash）
    const advice = modelAliasAdvice(model);
    return {
      code: CODE_MODEL_MISSING,
      error: `当前模型 ${toStr(model)} 不存在或不可用，请到「我的 → AI 设置」检查模型名（${suggestions}）`
        + (advice ? `。${advice}` : ''),
    };
  }
  if (hasCode(provider && provider.quotaCodes) || status === 429) {
    return { code: CODE_QUOTA, error: VISION_QUOTA_MESSAGE };
  }
  if (hasCode(provider && provider.authCodes) || status === 401 || status === 403) {
    return { code: CODE_AUTH, error: VISION_AUTH_MESSAGE };
  }
  if (status >= 500) {
    return { code: CODE_FAILED, error: 'AI 服务出错了，请稍后重试（也可以换 glm-ocr 试试）' };
  }
  return {
    code: CODE_FAILED,
    error: `这张截图服务端没有接受（HTTP ${status}），可以换一张更小更清晰的截图，或改用文字录入`,
  };
}

// ---------------------------------------------------------------------------
// 识图：入参校验与归一化（全部是纯函数）
// ---------------------------------------------------------------------------

/**
 * 校验图片入参。**先校验再花任何额度**：格式不对、太大，都在这里拒。
 *
 * @param {object} event 云函数入参
 * @returns {{ok:true, base64:string, mime:string, bytes:number}|{ok:false, code:string, error:string}}
 */
function normalizeImageInput(event) {
  const raw = event && typeof event.image_base64 === 'string' ? event.image_base64 : '';
  // 去掉换行/空格：base64 里混进空白是常见的手工拼接产物，清掉不影响解码
  const base64 = raw.replace(/\s+/g, '');
  if (!base64) return { ok: false, code: CODE_BAD_IMAGE, error: IMAGE_EMPTY_MESSAGE };
  if (base64.length > MAX_IMAGE_BASE64_CHARS) {
    return { ok: false, code: CODE_BAD_IMAGE, error: IMAGE_TOO_LARGE_MESSAGE };
  }
  // 必须是纯 base64（契约里明确"不带 data: 前缀"）：形状不对就别往服务商那边送
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return { ok: false, code: CODE_BAD_IMAGE, error: IMAGE_INVALID_MESSAGE };
  }
  const mime = toStr(event && event.mime_type).toLowerCase();
  if (ALLOWED_IMAGE_MIME_TYPES.indexOf(mime) === -1) {
    return { ok: false, code: CODE_BAD_IMAGE, error: IMAGE_INVALID_MESSAGE };
  }
  return { ok: true, base64, mime, bytes: Math.round((base64.length * 3) / 4) };
}

/** 半角化：全角数字与全角逗号（模型/ OCR 常吐全角） */
function toHalfWidth(text) {
  return toStr(text)
    .replace(/[\uff10-\uff19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\uff0c/g, ',');
}

/** 把 "9:05" / "9：05" 补成 "09:05"；非法返回 ''（不瞎猜） */
function normalizeClock(value) {
  const raw = toHalfWidth(value).replace(/[：:]/g, ':').replace(/\s+/g, '');
  const matched = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!matched) return '';
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  if (hour > 23 || minute > 59) return '';
  return `${pad2(hour)}:${pad2(minute)}`;
}

/**
 * 节次文本归一化：与云函数 tasks 的 normalizePeriods 同一口径 —— "3-5" / "7"（不合法给 ''）。
 * 认不出时返回 ''，由调用方**保留时间**并记一条 warning（时间才是定位课节的依据）。
 */
function normalizePeriodsText(value) {
  const source = Array.isArray(value) ? value.join('-') : value;
  const raw = toHalfWidth(source).replace(/第|节|\s+/g, '');
  if (!raw) return '';
  const matched = raw.match(/^(\d{1,2})(?:[-~—–到至](\d{1,2}))?$/);
  if (!matched) return '';
  let first = parseInt(matched[1], 10);
  let last = matched[2] ? parseInt(matched[2], 10) : first;
  if (!(first >= 1 && first <= 30) || !(last >= 1 && last <= 30)) return '';
  if (last < first) { const tmp = first; first = last; last = tmp; }
  return first === last ? String(first) : `${first}-${last}`;
}

/**
 * 周次文本归一化：把模型读出来的 "1-16" / "1-8,10-16" / "单周" / "双周" / "第1-16周"
 * 变成任务模型要的 week_start / week_end / week_parity 三个字段。
 *
 * 【断档怎么办】"1-8,10-16" 这种在任务模型里表达不了（只有起止 + 单双周），
 * 所以取**最小起周 ~ 最大止周**，并回一条 warning 如实说明"中间没课的那几周也会排课"。
 * 宁可多显示几周也不漏课 —— 用户可以在任务里改，而漏掉的课他很难发现。
 *
 * @param {*} value 模型给的周次文本
 * @param {{week_start:number, week_end:number}} defaults 缺省范围（来自请求）
 * @returns {{week_start:number, week_end:number, week_parity:string, warning:string}}
 */
function normalizeWeeksText(value, defaults) {
  const base = defaults || {};
  const fallback = {
    week_start: base.week_start || 1,
    week_end: base.week_end || 20,
    week_parity: 'all',
    warning: '',
  };
  const shown = toStr(value);
  if (!shown) return fallback; // 截图里没写周次是常态，用默认范围，不打扰用户

  const raw = toHalfWidth(shown).replace(/\s+/g, '');
  const cleaned = raw.replace(/第|周/g, '');
  if (/^(单|单数)$/.test(cleaned)) return Object.assign({}, fallback, { week_parity: 'odd' });
  if (/^(双|双数)$/.test(cleaned)) return Object.assign({}, fallback, { week_parity: 'even' });

  const bad = (why) => Object.assign({}, fallback, {
    warning: `「${shown}」的周次没能认出来（${why}），已按第 ${fallback.week_start}-${fallback.week_end} 周导入`,
  });

  let parity = 'all';
  let body = cleaned;
  if (/单$/.test(body)) { parity = 'odd'; body = body.replace(/单$/, ''); }
  else if (/双$/.test(body)) { parity = 'even'; body = body.replace(/双$/, ''); }
  if (!body) return bad('只有一个单双周字样');

  const segments = body.split(',').filter(Boolean);
  if (!segments.length) return bad('空');

  let first = null;
  let last = null;
  for (let i = 0; i < segments.length; i += 1) {
    const matched = segments[i].match(/^(\d{1,2})(?:[-~—–到至](\d{1,2}))?$/);
    if (!matched) return bad(`看不懂「${segments[i]}」`);
    let begin = parseInt(matched[1], 10);
    let finish = matched[2] ? parseInt(matched[2], 10) : begin;
    if (finish < begin) { const tmp = begin; begin = finish; finish = tmp; }
    if (!(begin >= 1 && begin <= 30) || !(finish >= 1 && finish <= 30)) {
      return bad(`「${segments[i]}」超出 1-30 周`);
    }
    first = first === null ? begin : Math.min(first, begin);
    last = last === null ? finish : Math.max(last, finish);
  }

  const warning = segments.length > 1
    ? `「${shown}」是不连续的周次，已按第 ${first}-${last} 周导入（中间没课的那几周也会排课，可在任务里改）`
    : '';
  return { week_start: first, week_end: last, week_parity: parity, warning };
}

/**
 * 作息表归一化：{"1": ["08:00","08:45"], ...}。非法时刻/越界节次一律丢掉（不瞎猜）。
 * @returns {object|null} 一条都没剩下时返回 null（契约里就是 null）
 */
function normalizePeriodTimesValue(value) {
  if (!isPlainObject(value)) return null;
  const result = {};
  Object.keys(value).forEach((key) => {
    const number = parseInt(toHalfWidth(key), 10);
    if (!(number >= 1 && number <= 30)) return;
    const range = value[key];
    if (!Array.isArray(range) || range.length < 2) return;
    const start = normalizeClock(range[0]);
    const end = normalizeClock(range[1]);
    if (!start || !end || start >= end) return;
    result[String(number)] = [start, end];
  });
  return Object.keys(result).length ? result : null;
}

/** 按节次从作息表里取 [开始, 结束]（取第一天的开始 / 最后一天的结束） */
function timesForPeriods(periods, table) {
  const span = toStr(periods).match(/^(\d{1,2})(?:-(\d{1,2}))?$/);
  if (!span || !isPlainObject(table)) return { start: '', end: '' };
  const first = span[1];
  const last = span[2] || span[1];
  const head = table[first];
  const tail = table[last];
  return {
    start: Array.isArray(head) ? normalizeClock(head[0]) : '',
    end: Array.isArray(tail) ? normalizeClock(tail[1]) : '',
  };
}

/** "HH:MM" → 当天第几分钟；非法返回 null（与 utils/periods.js 的 toMinutes 同口径） */
function clockMinutes(value) {
  const clock = normalizeClock(value);
  if (!clock) return null;
  const parts = clock.split(':');
  return (Number(parts[0]) * 60) + Number(parts[1]);
}

/**
 * 把一条课程的时间换算成"拿去和作息表求重叠"的区间。
 *
 * 【退化口径照抄 utils/periods.js 的 periodSpanFromTimes，不另立一套】
 *   * 两个时间都有 → 半开区间 [开始, 结束)
 *   * 只有一个（或两个都有但倒挂）→ 退化成一个**时刻**：按"这一刻落在哪一节里"判断，
 *     含首尾。periods.js 里"只填了结束时间也能定位到课节"用的就是这条口径；
 *     倒挂时取**开始**那一刻（periods.js 对倒挂数据也是收敛成开始那一节）。
 *
 * @returns {{from:number, to:number, point:boolean}|null} 时间都非法 → null
 */
function buildOverlapQuery(startTime, endTime) {
  const start = clockMinutes(startTime);
  const end = clockMinutes(endTime);
  if (start !== null && end !== null && end > start) return { from: start, to: end, point: false };
  const only = start !== null ? start : end;
  if (only === null) return null;
  return { from: only, to: only, point: true };
}

/** 查询区间与某一节的重叠分钟数（退化成一个时刻时：落在这一节里算 1 分钟，否则 0） */
function overlapMinutesOf(query, begin, finish) {
  if (query.point) return (begin <= query.from && query.from <= finish) ? 1 : 0;
  const from = Math.max(query.from, begin);
  const to = Math.min(query.to, finish);
  return to > from ? to - from : 0;
}

/**
 * 模型没给出（或给歪了）节次、但给了上课时间时，**用时间反推节次**。
 *
 * ===========================================================================
 * 【为什么必须推这一下】不推的话这条记录会变成"删不掉的孤儿"：
 *   课表类任务的判据是 `repeat === 'weekly'` **且** `periods` 非空
 *   （cloudfunctions/tasks/lib/normalize.js 的 isCourseTask，前端「替换课表」的
 *   确认框里那个 N 也按它算）。于是"有周次、没节次"的条目：
 *     * 下一次「替换课表」**删不掉它**（判据认为它不是课程）；
 *     * 追加导入时又会留下同名的第二份 → 用户看到"我明明点了替换，怎么多出来一条重的"。
 *   而它本来是有时间的（时间才是定位课节的依据），所以这里补一次推导，让判据能覆盖它。
 * ===========================================================================
 *
 * 【口径为什么是"重叠 > 0 的最小/最大节次"】这就是课表页把任务放进哪几行的口径
 * （按时间落在第几节），不引入新算法；连堂/跨节次自然得到 "3-5" 这样的区间。
 *
 * 【只用客户端传上来的作息表】那张表是用户校准过的、也是课表页落点用的同一张；
 * 截图里读出来的作息（模型自己的读数）不作数 —— 拿它推等于用模型的第二个猜测去补第一个失误。
 *
 * @param {string} startTime 归一化后的开始时间（可为 ''）
 * @param {string} endTime 归一化后的结束时间（可为 ''）
 * @param {object|null} table 客户端传上来的作息表 {'3': ['10:15','10:55'], ...}
 * @returns {string} '3-4' / '5' / ''（一个节次都不重叠 → 空串，调用方保留原来那句 warning）
 */
function derivePeriodsFromTimes(startTime, endTime, table) {
  const query = buildOverlapQuery(startTime, endTime);
  if (!query || !isPlainObject(table)) return '';

  let first = null;
  let last = null;
  Object.keys(table).forEach((key) => {
    const number = parseInt(toHalfWidth(key), 10);
    if (!(number >= 1 && number <= 30)) return;
    const range = table[key];
    if (!Array.isArray(range) || range.length < 2) return;
    const begin = clockMinutes(range[0]);
    const finish = clockMinutes(range[1]);
    if (begin === null || finish === null || begin >= finish) return;
    if (overlapMinutesOf(query, begin, finish) <= 0) return;
    first = first === null ? number : Math.min(first, number);
    last = last === null ? number : Math.max(last, number);
  });

  if (first === null) return '';
  return first === last ? String(first) : `${first}-${last}`;
}

/** 把 "周三第3节" 换算成具体日期：本周周一 + (weekday-1)。非法 weekday 返回 '' */
function weekdayDate(weekMonday, weekday) {
  const index = Number(weekday);
  if (!(index >= 1 && index <= 7)) return '';
  return addDays(toStr(weekMonday), index - 1);
}

/** warning 用的短标题（太长会把提示刷屏） */
function shortTitle(title) {
  const text = toStr(title);
  return text.length > 12 ? `${text.slice(0, 12)}…` : text;
}

// ---------------------------------------------------------------------------
// 识图：提示词
// ---------------------------------------------------------------------------

/** 作息表的可读文本（拼进提示词；没有就说明"没校准过"） */
function periodTimesPromptText(table) {
  if (!isPlainObject(table) || !Object.keys(table).length) {
    return '（用户还没校准过作息，节次对应的具体时间以截图里写的为准；读不出时间就留空字符串）';
  }
  return Object.keys(table)
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => `第${key}节 ${table[key][0]}-${table[key][1]}`)
    .join('；');
}

/**
 * 拼装识图的 system prompt。
 *
 * 【为什么把日期基准写进提示词】和文本解析同一个道理：日期由**服务端**算，
 * 模型只负责认字（课程名 / 星期几 / 节次 / 周次）。所以这里明确告诉它"不要输出日期"。
 *
 * @param {object} ctx buildVisionContext() 的结果
 * @returns {string}
 */
function buildVisionSystemPrompt(ctx) {
  const semester = ctx.semester_start
    ? `学期第一周的周一：${ctx.semester_start}`
    : '学期起始日期：用户还没设置（不影响你识别，照抄截图里的周次即可）';
  return `你是一个课表截图识别助手。用户上传的是一张课程表截图（教务系统导出的表格、App 截图或拍照都可能有）。
请把截图里**每一门课**提取成结构化数据，只输出一个 JSON 对象。

【日期基准（由系统换算，你不要自己算日期）】
- 本周的周一是 ${ctx.week_monday}。
- ${semester}
- 周次默认范围：第 ${ctx.week_start} ~ ${ctx.week_end} 周。
- 当前作息（节次 → 上课时间）：${periodTimesPromptText(ctx.period_times)}

【输出格式】必须严格如下（**不要输出日期字段**）：
{
  "courses": [
    {"title": "高等数学", "weekday": 1, "periods": "1-2", "weeks": "1-16",
     "start_time": "08:00", "end_time": "09:40", "location": "教三201"}
  ],
  "period_times": {"1": ["08:00", "08:45"], "2": ["08:55", "09:40"]},
  "warnings": ["第 3 行第 5 列有一门课被水印挡住，看不出课程名"],
  "notes": "共识别出 12 门课"
}

【字段说明】
1. title：课程名（必填；实在认不出**不要猜**，跳过它并在 warnings 里说明）。
2. weekday：1~7，1=周一、2=周二 …… 7=周日。表格的列就是星期几，**照抄即可**。
3. periods：节次。连堂写 "3-5"（第3到第5节），单节写 "7"；看不出节次就写空字符串 ""。
4. weeks：周次原文，例如 "1-16"、"1-8,10-16"、"单周"、"双周"、"1-16周"；没写就写 ""。
5. start_time / end_time：24 小时制 HH:MM。**只有截图里确实写了时间才填**，否则写 ""。
6. location：上课地点（教室）；截图里有老师姓名的话，一并写在 location 里（如 "教三201 张老师"）。
7. period_times：截图里若有一张"节次-时间"对照表，按节次号填进来；没有就给 null。
8. warnings：看不清 / 被遮挡 / 判断不了的行列，用一句简短中文说明；没有就给空数组 []。
9. notes：一句话概括你识别了什么（可留空字符串 ""）。

【其他规则】
1. 只输出 JSON：不要解释、不要用 Markdown 代码块、不要加别的字段。
2. 同一门课出现在多个时间段（例如周一第1-2节、周三第3-4节）就输出**多条**，每条一个 weekday + periods。
3. 合并单元格里写着 "高等数学（1-16周）" 这类信息时，把课程名放进 title、周次放进 weeks。
4. 不要输出 date / 日期字段（日期由系统按 weekday 计算）；不要编造截图上没有的课。
5. 一门课都没认出来时，返回空的 courses 数组，并在 warnings 里说明原因。`;
}

// ---------------------------------------------------------------------------
// 识图：上下文（日期基准 / 默认周次 / 作息）
// ---------------------------------------------------------------------------

/**
 * 组装识图上下文。入参全部来自 event，逐条给安全默认值（**不抛异常**）。
 *
 * @param {object} event 云函数入参
 * @param {object} [options] { today } 便于自测注入
 * @returns {{week_monday, semester_start, week_start, week_end, period_times}}
 */
function buildVisionContext(event, options) {
  const opts = options || {};
  const payload = event || {};
  const today = toStr(opts.today) || todayStr();

  // week_monday：契约里它就该是"本周周一"。合法就照用（日期 = 它 + (weekday-1) 天），
  // 缺失/非法才退回服务器本周周一 —— 少一个字段不该让整次识别失败。
  let weekMonday = toStr(payload.week_monday);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekMonday) || weekdayIndex(weekMonday) === null) {
    weekMonday = mondayOf(today);
    console.warn(`[aiParse] 识图入参 week_monday 缺失或非法，已按服务器本周周一 ${weekMonday} 换算日期`);
  }

  let semesterStart = toStr(payload.semester_start);
  if (semesterStart && weekdayIndex(semesterStart) === null) semesterStart = ''; // 只做格式校验

  const weekStart = clampWeek(payload.week_start, 1);
  const weekEnd = Math.max(clampWeek(payload.week_end, 20), weekStart);

  return {
    week_monday: weekMonday,
    semester_start: semesterStart,
    week_start: weekStart,
    week_end: weekEnd,
    period_times: normalizePeriodTimesValue(payload.period_times), // 用户已校准的作息（可空）
  };
}

/** 周次取值：只认 1~30 的整数，其余用默认值 */
function clampWeek(value, fallback) {
  const number = typeof value === 'number' ? Math.trunc(value) : parseInt(toHalfWidth(value), 10);
  if (!Number.isFinite(number) || number < 1 || number > 30) return fallback;
  return number;
}

// ---------------------------------------------------------------------------
// 识图：结果归一化（模型 JSON → events / tasks）
// ---------------------------------------------------------------------------

/**
 * 把模型认出来的课表归一化成 events + tasks（**同长同序，下标一一对应**）。
 *
 * 【为什么要两次 map 而不是一次】前端 buildParseItems 是按 `tasks[cursor]` 与
 * events/deadlines 按下标配对的（见 pages/ai/ai.js 的顺序契约）。所以这里先算出
 * 一份干净的课程数组，再分别投影成 events 与 tasks —— 任何脏条目都在**投影之前**
 * 就被剔掉并记进 warnings，绝不会出现"显示了 5 条、只有 4 条能落库"的错位。
 *
 * 【丢弃的条目去哪了】title 为空、weekday 非法的条目会变成一条中文 warning
 * （用户看得见"哪一行没认出来"），而不是静默消失。
 *
 * @param {object} data extractJsonObject() 的结果
 * @param {object} ctx buildVisionContext() 的结果
 * @returns {{events:Array, deadlines:Array, tasks:Array, period_times:object|null, warnings:string[], notes:string}}
 */
function normalizeVisionResult(data, ctx) {
  const warnings = [];
  const notes = toStr(isPlainObject(data) ? data.notes : '').slice(0, 200);

  // 模型自己说的"哪里没看清"原样带给用户（截断，免得被刷屏）
  const saidWarnings = isPlainObject(data) && Array.isArray(data.warnings) ? data.warnings : [];
  saidWarnings.forEach((item) => {
    const text = toStr(item).slice(0, 200);
    if (text) warnings.push(text);
  });

  // 作息：截图里读出来的 + 用户已校准的（**用户的优先** —— 他手动校过的比截图更可信）
  const fromImage = normalizePeriodTimesValue(isPlainObject(data) ? data.period_times : null);
  const timeTable = Object.assign({}, fromImage || {}, ctx.period_times || {});

  const rawCourses = isPlainObject(data) && Array.isArray(data.courses)
    ? data.courses
    // 容错：模型偶尔把 courses 写成 events（它也可能给 events 数组）
    : (isPlainObject(data) && Array.isArray(data.events) ? data.events : []);

  const courses = [];
  rawCourses.forEach((item, index) => {
    if (!isPlainObject(item)) return;
    const title = toStr(item.title || item.name || item.course);
    if (!title) {
      warnings.push(`第 ${index + 1} 条没有课程名，已跳过`);
      return;
    }
    const label = shortTitle(title);

    const weekday = Number(toHalfWidth(item.weekday));
    const date = weekdayDate(ctx.week_monday, weekday);
    if (!date) {
      warnings.push(`「${label}」没认出是星期几，已跳过（可手动补一条）`);
      return;
    }

    const weeks = normalizeWeeksText(item.weeks, ctx);
    if (weeks.warning) warnings.push(`「${label}」${weeks.warning}`);

    // 时间：模型写了的用模型的；没写就按节次查作息表补（两条都没有就留空，
    // 课表页按 periods 排课，不靠时间也能落对行）
    let start = normalizeClock(item.start_time);
    let end = normalizeClock(item.end_time);

    // 节次：先信模型给的；模型没给（或给歪了）但给了时间，就用**客户端传上来的作息表**
    // 按时间反推一次（见 derivePeriodsFromTimes 的说明：不推的话这条记录下次「替换课表」
    // 删不掉，追加导入还会留一份重的）。推导只在"模型没给出合法节次"时发生，绝不覆盖模型的值。
    let periods = normalizePeriodsText(item.periods);
    let derivedPeriods = '';
    if (!periods && (start || end)) {
      derivedPeriods = derivePeriodsFromTimes(start, end, ctx.period_times);
      if (derivedPeriods) periods = derivedPeriods;
    }

    if (!start || !end) {
      const fromTable = timesForPeriods(periods, timeTable);
      if (!start) start = fromTable.start;
      if (!end) end = fromTable.end;
    }
    if (periods && !start && !end) {
      warnings.push(`「${label}」只有节次没有具体时间，课表里会按节次排（时间可在任务里补）`);
    }
    if (!periods) {
      // 【关键】节次确实定不下来时**留空但保留时间**：宁可不把它当课程，也不能瞎填一个节次
      warnings.push(`「${label}」的节次没能认出来，已按时间导入（不会排进课表格子）`);
    } else if (derivedPeriods) {
      // 【如实说】这是系统按时间推的，不是模型认出来的 —— 请用户确认一句，
      // 但**不静默改数据**（推错了用户在任务里一眼能看见并改掉）
      warnings.push(`「${label}」的节次没认出来，已按时间推成第 ${derivedPeriods} 节，请确认`);
    }

    // 优先级的口径与文本解析一致：events 用中文标签，tasks 用内部常量
    const priorityCn = toStr(item.priority) || '中';
    const priority = lookupLabel(PRIORITY_CN_TO_CONST, priorityCn, 'mid');

    courses.push({
      title,
      date,
      start_time: start,
      end_time: end,
      periods: periods || '',
      location: toStr(item.location || item.room).slice(0, 100),
      priorityCn,
      priority,
      week_start: weeks.week_start,
      week_end: weeks.week_end,
      week_parity: weeks.week_parity,
    });
  });

  if (!courses.length && !warnings.length) warnings.push('这张截图里没认出任何课程');

  // events 与 tasks 都由同一份 courses 投影而来 → 长度与顺序必然一致
  const events = courses.map((one) => ({
    title: one.title,
    date: one.date,
    start_time: one.start_time,
    end_time: one.end_time,
    periods: one.periods,
    location: one.location,
    priority: one.priorityCn,
    // 课程固定每周重复（带上 week_* 与 periods，课表页才会每周排出来）
    repeat: 'weekly',
    week_start: one.week_start,
    week_end: one.week_end,
    week_parity: one.week_parity,
  }));

  const tasks = courses.map((one) => ({
    title: one.title,
    type: 'event', // 课程统一 event（识别结果天然是课程，不给别的类型）
    date: one.date,
    start_time: one.start_time,
    end_time: one.end_time,
    priority: one.priority,
    done: false,
    parent_id: null,
    repeat: 'weekly',
    week_start: one.week_start,
    week_end: one.week_end,
    week_parity: one.week_parity,
    periods: one.periods,
    location: one.location,
    // 【不猜耗时】截图里没有这个信息，填 0（= 没估），别拿节数瞎算
    estimate_min: 0,
  }));

  return {
    events,
    deadlines: [], // 课表截图里没有"截止事项"，保持空数组（前端按下标配对时要靠它）
    tasks,
    period_times: fromImage,
    warnings,
    notes,
  };
}

// ---------------------------------------------------------------------------
// 识图：调用模型
// ---------------------------------------------------------------------------

/**
 * 识图专用的 Chat Completions 调用。
 *
 * 【为什么另写一个而不是复用 chatCompletion】
 *   1. 超时不同（45 秒 vs 15 秒），而复用就得改 chatCompletion 的签名 —— 那条路径是
 *      既成契约（自测里断言了 15 秒、断言了 400 时去掉 response_format 重试一次），
 *      不值得为识图去动它；
 *   2. 失败要**分码**（换模型 / 换小图 / 稍后重试 / 超时），chatCompletion 只回一句统一文案。
 *
 * @param {Array} messages OpenAI 格式消息（content 可以是数组，含 image_url）
 * @param {object} [options] { env, db, openid, config } —— config 已解析过就直接用（少读一次库）
 * @returns {Promise<{content:string|null, error:string|null, code:string|null,
 *                    provider:string, model:string, source:string, reason:string}>}
 */
async function chatCompletionVision(messages, options) {
  const opts = options || {};
  const config = opts.config || await resolveEffectiveConfig(opts);

  if (config.notices) config.notices.forEach((notice) => console.warn(`[aiParse] ${notice}`));

  if (!config.ok) {
    console.warn(`[aiParse] 跳过识图调用（来源=服务端环境变量）：${config.reason}`);
    return {
      content: null, error: NO_API_KEY_MESSAGE, code: CODE_NO_API_KEY,
      provider: '', model: config.model, source: config.source, reason: config.reason,
    };
  }

  const provider = config.provider;
  const model = config.model;
  const endpoint = chatEndpoint(provider);
  const source = config.source;
  const sourceLabel = source === 'user' ? '来源=用户自填' : '来源=服务端环境变量';

  const payload = {
    model,
    messages,
    temperature: VISION_TEMPERATURE,
    top_p: VISION_TOP_P,
    stream: false,
    // 【刻意不带 response_format】见本节开头：thinking 只能 enabled 时 JSON 模式不保证生效
  };

  // 【按服务商分支的字段】DeepSeek 的视觉接口支持 image_url.detail（low / high(别名 original) / auto），
  // 官方对"密集小字"场景（课表截图正是）建议 high；智谱那边没有这个字段，**绝不能带**
  // （未知字段可能被判成参数错误）。放在 image_url 里面是 OpenAI 兼容接口的位置（DeepSeek 同形）。
  // ⚠️ 未经真机/真接口验证：detail 的确切位置与 deepseek-flash 的实际行为都还没打过真实请求。
  //    若官方文档写的是请求体顶层，把下面这段改成 `payload.detail = 'high';` 即可（断言位置一并改）。
  if (provider.name === 'deepseek') {
    messages.forEach((message) => {
      if (!message || !Array.isArray(message.content)) return;
      message.content.forEach((part) => {
        if (!part || part.type !== 'image_url' || !part.image_url) return;
        part.image_url.detail = 'high';
      });
    });
  }

  // 日志一律过 scrubImagePayload：宁可少点信息，也不能把 base64 或 Key 写进日志
  const describe = (error) => scrubImagePayload(`[识图] ${provider.name}/${model}（${sourceLabel}）${error}`);

  let response;
  try {
    response = await exports.postJson(endpoint, payload, { Authorization: `Bearer ${config.apiKey}` }, VISION_TIMEOUT_MS);
  } catch (error) {
    const reason = describe(`请求失败：${(error && error.message) || error}`);
    console.error(`[aiParse] ${reason}`);
    // 【区分超时】超时是"模型太慢"，用户能做的是换更快的模型（glm-ocr）或稍后重试，
    // 与配额、参数错误完全是两码事，所以单独给一个码和一句文案。
    const isTimeout = (error && error.code === 'TIMEOUT') || /超时/.test(String((error && error.message) || ''));
    return {
      content: null,
      error: isTimeout ? VISION_TIMEOUT_MESSAGE : '识别失败：网络异常或服务商不可达，请稍后重试',
      code: isTimeout ? CODE_TIMEOUT : CODE_FAILED,
      provider: provider.name, model, source, reason,
    };
  }

  if (response.status !== 200) {
    const failure = classifyVisionFailure(provider, response.status, response.text, model);
    console.error(`[aiParse] ${describe(`识别失败（${failure.code}）：${response.status} ${toStr(response.text).slice(0, 300)}`)}`);
    return {
      content: null, error: failure.error, code: failure.code,
      provider: provider.name, model, source, reason: failure.code,
    };
  }

  let data;
  try {
    data = JSON.parse(response.text);
  } catch (error) {
    const reason = describe('返回的内容不是合法 JSON');
    console.error(`[aiParse] ${reason}`);
    return {
      content: null, error: '识别失败：服务商返回的内容看不懂，请稍后重试', code: CODE_FAILED,
      provider: provider.name, model, source, reason,
    };
  }

  const content = data
    && data.choices && data.choices[0]
    && data.choices[0].message && data.choices[0].message.content;
  if (typeof content !== 'string' || !content.trim()) {
    const reason = describe('返回结构异常或内容为空');
    console.error(`[aiParse] ${reason}`);
    return {
      content: null, error: PARSE_FAILED_MESSAGE, code: CODE_PARSE_FAILED,
      provider: provider.name, model, source, reason,
    };
  }
  return { content, error: null, code: null, provider: provider.name, model, source, reason: '' };
}

// ---------------------------------------------------------------------------
// 识图：主逻辑
// ---------------------------------------------------------------------------

/**
 * 识图主逻辑（action: 'parse_image'）。
 *
 * 顺序（每一步都能省下一次请求或一笔额度）：
 *   ① 校验图片（格式 / 大小）→ ② 解析配置 → ③ **事前**判模型能力（明确不支持就直接拒，
 *   一个请求都不发）→ ④ 发请求（45 秒超时）→ ⑤ 失败分码 / 成功归一化。
 *
 * 【Key 从哪来】只从服务端读：用户自填（settings 集合，按 openid）> 环境变量。
 * 前端传上来的 apiKey / baseUrl / model 等字段一律忽略并记日志（见 findInjectedFields）。
 *
 * @param {object} event 云函数入参（契约见文件头）
 * @param {object} [options] { today, env, db, openid } —— 便于自测注入
 * @returns {Promise<object>} 成功 { ok:true, provider, model, events, deadlines, tasks,
 *                                   period_times, warnings, notes }
 *                            失败 { ok:false, code, error }
 */
async function handleParseImage(event, options) {
  const opts = options || {};
  const payload = event || {};

  // 有人想传 Key / 传地址：只记字段名，**不记值**（与文本路径同一道闸门）
  const injected = findInjectedFields(payload);
  if (injected.length) {
    console.warn(
      `[aiParse] 识图入参里出现了不该由前端指定的字段（${injected.join(', ')}），已忽略；`
      + 'Key 只从数据库（用户自填）或环境变量（服务端预置）读取，请求地址只从白名单映射'
    );
  }

  const image = normalizeImageInput(payload);
  if (!image.ok) {
    console.warn(`[aiParse] 识图入参被拒（${image.code}）：mime=${toStr(payload.mime_type)}`);
    return { ok: false, code: image.code, error: image.error };
  }

  const config = await resolveEffectiveConfig(opts);
  if (config.notices) config.notices.forEach((notice) => console.warn(`[aiParse] ${notice}`));

  const providerName = config.provider ? config.provider.name : '';
  const support = visionSupportOf(config.model, providerName);
  if (support === false) {
    // 【事前那条腿】已知纯文本模型：直接拒，**不发请求**（省用户的钱和时间）。
    // 这条判定先于"有没有 Key"：模型不行这件事与 Key 无关，先说清楚最有用。
    console.warn(
      `[aiParse] 拒绝识图：模型 ${config.model} 在已知"不支持识图"名单里，未发请求`
      + `（建议换成 ${VISION_RECOMMENDED_MODELS.join(' / ')}）`
    );
    return {
      ok: false,
      code: CODE_VISION_UNSUPPORTED,
      error: visionUnsupportedMessage(config.model, providerName),
    };
  }

  const ctx = buildVisionContext(payload, opts);
  // 【安全红线】日志里只允许出现 mime + 字节数，绝不出现 base64 本身
  console.log(
    `[aiParse] 开始识图：${image.mime}、约 ${Math.round(image.bytes / 1024)} KB、`
    + `模型 ${config.model || '(未设置)'}（${config.source === 'user' ? '来源=用户自填' : '来源=服务端环境变量'}）`
  );

  const completion = await chatCompletionVision([
    { role: 'system', content: buildVisionSystemPrompt(ctx) },
    {
      role: 'user',
      content: [
        { type: 'text', text: '这是我这一学期的课表截图，请按系统提示的 JSON 结构把课程全部提取出来。' },
        { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } },
      ],
    },
  ], Object.assign({}, opts, { config }));

  if (completion.error) {
    return { ok: false, code: completion.code || CODE_FAILED, error: completion.error };
  }

  const parsed = extractJsonObject(completion.content);
  if (!parsed) {
    // 只记开头一小段，用于排查"模型到底回了什么"（**不含 base64**：那是我们发出去的，不是它回的）
    console.error('[aiParse] 识图结果解析不出 JSON：', toStr(completion.content).slice(0, 200));
    return { ok: false, code: CODE_PARSE_FAILED, error: PARSE_FAILED_MESSAGE };
  }

  const result = normalizeVisionResult(parsed, ctx);
  console.log(
    `[aiParse] 识图完成：认到 ${result.events.length} 门课、`
    + `${result.warnings.length} 条提示（模型 ${completion.model}）`
  );
  return {
    ok: true,
    provider: completion.provider,
    model: completion.model,
    events: result.events,
    deadlines: result.deadlines,
    tasks: result.tasks,
    period_times: result.period_times,
    warnings: result.warnings,
    notes: result.notes,
  };
}

/**
 * 第三方可能塞进来的"看起来像凭证/地址"的字段名。
 *
 * 【为什么要显式忽略它们】如果哪天有人发现"传个 apiKey 就能用别人的额度"、
 * 或者"传个 baseUrl 就能让云函数替我请求任意地址"，那这个云函数就变成了
 * 免费代理 / SSRF 跳板。所以这些字段**一律不看**，出现就记一笔日志。
 */
const IGNORED_INJECTION_FIELDS = [
  'apiKey', 'apikey', 'api_key', 'key', 'token', 'secret',
  'baseUrl', 'base_url', 'apiBase', 'endpoint', 'url', 'host',
  'provider', 'model', 'openid', '_openid',
];

/**
 * 把 event 里那些"不该由前端指定"的字段挑出来（只为记日志，返回值本身不参与业务）。
 * @returns {string[]} 命中的字段名
 */
function findInjectedFields(event) {
  if (!event || typeof event !== 'object') return [];
  return IGNORED_INJECTION_FIELDS.filter((name) => (
    Object.prototype.hasOwnProperty.call(event, name) && toStr(event[name])
  ));
}

/**
 * 对外主逻辑。
 *
 * @param {{text: string}} event **只认 text 一个字段**
 *        （apiKey / baseUrl / provider / model 等一律忽略，见 IGNORED_INJECTION_FIELDS）
 * @param {{today?: string, env?: object, db?: object, openid?: string}} [options] 便于自测注入
 * @returns {Promise<object>} { ok:true, events, deadlines, needs_clarification, clarification_question }
 */
async function handleParse(event, options) {
  const opts = options || {};
  const text = toStr(event && event.text);

  // 有"想传 Key / 传地址"的字段就记一笔 —— 只记字段名，**不记值**
  const injected = findInjectedFields(event);
  if (injected.length) {
    console.warn(
      `[aiParse] 入参里出现了不该由前端指定的字段（${injected.join(', ')}），已忽略；`
      + 'Key 只从数据库（用户自填）或环境变量（服务端预置）读取，请求地址只从白名单映射'
    );
  }

  // 空输入直接本地拦掉，不必浪费一次请求
  if (!text) {
    return {
      ok: true,
      events: [],
      deadlines: [],
      needs_clarification: true,
      clarification_question: '请描述一下你的安排，例如：明天 15:00 开会。',
    };
  }

  const invalid = validateText(text);
  if (invalid) return { ok: false, error: invalid };

  const today = opts.today || todayStr();
  const messages = [
    { role: 'system', content: buildSystemPrompt(today) },
    { role: 'user', content: text },
  ];

  const completion = await chatCompletion(messages, true, TEMPERATURE, opts);
  if (completion.error) return { ok: false, error: completion.error };

  const parsed = extractJsonObject(completion.content);
  if (!parsed) {
    console.error('[aiParse] 无法从模型返回内容中解析出 JSON：', toStr(completion.content).slice(0, 200));
    return { ok: false, error: PARSE_ERROR_MESSAGE };
  }

  const result = normalizeParseResult(parsed);
  return {
    ok: true,
    events: result.events,
    deadlines: result.deadlines,
    needs_clarification: result.needs_clarification,
    clarification_question: result.clarification_question,
    tasks: toTaskList(result), // 方便前端直接丢给 tasks 云函数的 bulk_add
  };
}

/**
 * 云函数入口。
 *
 * 【两个入口靠 action 区分】
 *   无 action（或空）→ 文本解析 handleParse（**保持原样**：入参只认 text）
 *   action:'parse_image' → 课表截图识别 handleParseImage
 *   其它 action → 明确回一句"不认识的操作"，**不要**当成文本解析
 *   （那会返回"请描述一下你的安排"，让人一头雾水地查半天）。
 *
 * 这里把 OPENID 与 db 都解析好传下去 —— Key 的读取全在
 * resolveEffectiveConfig() 里按 openid 完成；event 里的任何"凭证类"字段都不参与。
 */
exports.main = async (event) => {
  try {
    const payload = event || {};
    const action = toStr(payload.action);
    const options = { db: resolveDb({}), openid: safeOpenId() };

    if (action === ACTION_PARSE_IMAGE) {
      return await handleParseImage(payload, options);
    }
    if (action) {
      console.warn(`[aiParse] 不认识的 action：${action}`);
      return { ok: false, code: CODE_BAD_ACTION, error: `不认识的操作「${action}」` };
    }
    return await handleParse(payload, options);
  } catch (error) {
    console.error('[aiParse] 未预期异常：', (error && error.stack) || error);
    return { ok: false, error: ERROR_MESSAGE };
  }
};

// 暴露纯函数给 cloudfunctions/_selftest.js（不依赖 wx-server-sdk 即可测试）
//
// 【必须用 Object.assign(exports, ...) 而不是 module.exports = {...}】
// chatCompletion 里是通过 exports.postJson(...) 调用的（好让契约测试能替换它），
// 这里如果整体替换 module.exports，闭包里的 exports 就指向旧对象、替换会失效。
Object.assign(exports, {
  main: exports.main,
  handleParse,
  chatCompletion,
  postJson,
  // 服务商解析
  resolveProviderConfig,
  resolveEffectiveConfig,
  loadUserAiConfig,
  safeOpenId,
  resolveDb,
  findInjectedFields,
  scrubSecret,
  providerHasKey,
  providerNames,
  chatEndpoint,
  classifyHttpError,
  userFacingHttpError,
  modelAliasAdvice,
  aliasKeyOf,
  MODEL_ALIAS_TARGET,
  MODEL_ALIAS_KEYS,
  PROVIDERS,
  DEFAULT_PROVIDER,
  ENV_PROVIDER,
  ENV_MODEL,
  IGNORED_INJECTION_FIELDS,
  COLLECTION_SETTINGS,
  // 纯函数
  jsonLoadsTolerant,
  extractJsonObject,
  normalizeParseResult,
  toTaskList,
  estimateMinOf,
  lookupLabel,
  buildDateReference,
  buildExamples,
  buildSystemPrompt,
  nearestMonthDay,
  validateText,
  hasApiKey,
  todayStr,
  addDays,
  mondayOf,
  weekdayIndex,
  // 常量
  TIMEOUT_MS,
  ERROR_MESSAGE,
  USER_KEY_FAILED_MESSAGE,
  MAX_TEXT_LENGTH,
  TEMPERATURE,
  WEEKDAY_CN,
  // 识图（action: 'parse_image'）
  handleParseImage,
  chatCompletionVision,
  visionSupportOf,
  visionModelLists,
  visionUnsupportedMessage,
  visionSuggestions,
  RETIRED_MODELS,
  isVisionUnsupportedError,
  isImageTooLargeError,
  classifyVisionFailure,
  normalizeImageInput,
  normalizePeriodsText,
  normalizeWeeksText,
  normalizePeriodTimesValue,
  normalizeVisionResult,
  buildVisionContext,
  buildVisionSystemPrompt,
  weekdayDate,
  timesForPeriods,
  derivePeriodsFromTimes,
  buildOverlapQuery,
  overlapMinutesOf,
  clockMinutes,
  normalizeClock,
  businessCodeOf,
  scrubImagePayload,
  ACTION_PARSE_IMAGE,
  VISION_TIMEOUT_MS,
  MAX_IMAGE_BASE64_CHARS,
  ALLOWED_IMAGE_MIME_TYPES,
  VISION_RECOMMENDED_MODELS,
  VISION_TEMPERATURE,
  VISION_TOP_P,
  CODE_VISION_UNSUPPORTED,
  CODE_NO_API_KEY,
  CODE_BAD_IMAGE,
  CODE_TIMEOUT,
  CODE_QUOTA,
  CODE_MODEL_MISSING,
  CODE_PARSE_FAILED,
  CODE_AUTH,
  CODE_FAILED,
  IMAGE_TOO_LARGE_MESSAGE,
  IMAGE_INVALID_MESSAGE,
  NO_API_KEY_MESSAGE,
  PARSE_FAILED_MESSAGE,
  VISION_TIMEOUT_MESSAGE,
});
