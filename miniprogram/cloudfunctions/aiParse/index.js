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
 *         * DEEPSEEK_API_KEY → DeepSeek，默认模型 deepseek-chat（备选）
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
 * 入参：{ text }（**只认这一个字段**）
 * 返回：{ ok:true, events, deadlines, needs_clarification, clarification_question }
 *       或 { ok:false, error:'AI 服务暂不可用' }
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
  },
  deepseek: {
    name: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    // DeepSeek 走标准 HTTP 语义，没有业务码，所以这几组留空、由 HTTP 状态兜底
    quotaCodes: [],
    authCodes: [],
    modelMissingCodes: [],
    paramCodes: [],
  },
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

/**
 * 判断「当前是否具备调用 AI 的条件」（只看有没有可用的 Key）。
 * 注意：它**不保证**服务商名 / 模型名正确 —— 那些问题会在真正调用时以日志形式暴露。
 */
function hasApiKey() {
  return resolveProviderConfig().ok;
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
      repeat: 'none',
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
    {"title": "字符串", "date": "YYYY-MM-DD", "start_time": "HH:MM", "end_time": "HH:MM", "type": "日程", "priority": "中"}
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
8. 如果输入与日程完全无关，返回空的 events、deadlines，needs_clarification 设为 false。`;
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
  // 用户自填 Key 失败时给"可操作"的文案，预置 Key 失败仍走统一文案
  const failureMessage = source === 'user' ? USER_KEY_FAILED_MESSAGE : ERROR_MESSAGE;

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
    return { content: null, error: failureMessage, provider: provider.name, model, source, reason };
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
 * 这里把 OPENID 与 db 都解析好传给 handleParse —— Key 的读取全在
 * resolveEffectiveConfig() 里按 openid 完成；event 里的任何"凭证类"字段都不参与。
 */
exports.main = async (event) => {
  try {
    return await handleParse(event || {}, {
      db: resolveDb({}),
      openid: safeOpenId(),
    });
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
});
