/**
 * 云函数 aiDecompose —— 把一个大任务拆解成若干带建议执行日期的子任务。
 *
 * 逻辑参考（逐条搬过来，只做 JS 化）：
 *   C:\Users\qihe\Desktop\日程安排\smart-scheduler\ai_parser.py 的 decompose_task()
 *     * 中文 system prompt：拆成 3~8 步、动词开头、粒度 30 分钟~半天
 *     * suggested_date 必须落在「今天 ~ 截止日期」之间，且按日期先后排序
 *     * 每步必须给 estimate_min（分钟、15 的倍数）——它会被用来算「这周还排得下吗」
 *     * 返回结果以调用方传入的 title / deadline 为准，不信模型改写
 *     * estimate_min 做容错：负数 / 字符串 / 缺失 → 0
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
 * 入参：{ title, deadline }（deadline 为 YYYY-MM-DD；**只认这两个字段**）
 * 返回：{ ok:true, subtasks:[{title, suggested_date, estimate_min}] }
 *       或 { ok:false, error:'AI 服务暂不可用' }
 */

'use strict';

const https = require('https');

// ---------------------------------------------------------------------------
// 云开发 SDK（只用来做两件事：拿 OPENID、按 openid 读用户自填的 AI 配置）
// ---------------------------------------------------------------------------
// 用 try 包一层：没有云环境时（例如本地自测）依然能 require 本文件测纯逻辑，
// 只是"读用户配置"会跳过、直接回退到环境变量。
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
 * 失败日志里会拼进服务商返回的原文，万一它回显了请求头，Key 就进日志了 ——
 * 统一把 `Bearer xxx` 与长 token 形状的串替换掉。
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
const ERROR_MESSAGE = 'AI 服务暂不可用';
const TEMPERATURE = 0.3; // 拆解类任务允许一点发散（与 Python 版一致）

/**
 * 【契约的一部分】用户**自填**的 Key 失败时给的文案。
 * 与服务端预置失败的文案不同：自填的 Key 用户自己能修，告诉他去哪儿改才有用。
 * 两句话都不泄露厂商内部信息。
 */
const USER_KEY_FAILED_MESSAGE = '你填的 AI Key 无法使用，请到「我的 → AI 设置」检查或重新填写';

/** 标题长度上限 / 最少最多步数 / 单步耗时上限 */
const MAX_TITLE_LENGTH = 100;
const MIN_STEPS = 3;
const MAX_STEPS = 8;
const MAX_ESTIMATE_MIN = 1440; // 24 小时

// ---------------------------------------------------------------------------
// 服务商表（与 aiParse/index.js **保持一致**；不写死任何一家）
// ---------------------------------------------------------------------------
/**
 * 两个云函数各自独立部署，不能互相 require，所以这张表在两边各存一份。
 * 改动时请**同时改两个文件**（自测里有一条断言专门比对两边的表是否一致）。
 *
 *   zhipu    —— 智谱开放平台，默认模型 glm-4.7-flash（目前免费），放在推荐位
 *   deepseek —— 备选；用户手上已有的 Key 继续可用，换服务商不会让功能变成不可用
 *
 * ⚠️ 模型名 / 价格会变，以各家官方文档为准；改模型不用改代码，设置 LLM_MODEL 即可。
 */
const PROVIDERS = {
  zhipu: {
    name: 'zhipu',
    label: '智谱开放平台',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4.7-flash',
    apiKeyEnv: 'ZHIPU_API_KEY',
    // 智谱错误码是响应体里的**业务码**（字符串数字），来自官方错误码文档：
    // https://docs.bigmodel.cn/cn/api/api-code
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
    // DeepSeek 走标准 HTTP 语义，没有业务码，由 HTTP 状态兜底
    quotaCodes: [],
    authCodes: [],
    modelMissingCodes: [],
    paramCodes: [],
  },
};

/** 环境变量名（与 aiParse 一致） */
const ENV_PROVIDER = 'LLM_PROVIDER';
const ENV_MODEL = 'LLM_MODEL';

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
 * 解析「这次该用哪个服务商 + 哪个模型」（规则与 aiParse 完全一致）。
 *
 *   1. LLM_PROVIDER 指定了且认得出 → 就用它（即使没配 Key 也照实用它，报错才准确）；
 *      模型取 LLM_MODEL，否则用这家的默认模型。
 *   2. 没指定 / 名字不认识 → 「谁配了 Key 用谁」；两家都配了用推荐位 zhipu；
 *      两家都没有 → ok:false（调用方回报 AI 服务暂不可用）。
 *   3. LLM_MODEL 在任何情况下都能覆盖模型名。
 *
 * **永不抛异常**，配置问题都进 reason。
 *
 * @param {object} [env] 便于自测注入；默认 process.env
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

/** 当前是否具备调用 AI 的条件（只看服务端预置，不查库） */
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

/** 取云数据库实例；没有云环境时返回 null（调用方据此跳过"读用户配置"） */
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
 * 按 openid 读用户自填的 AI 配置。条件里带 `_openid`（只能读到自己的）；
 * 读不到 / 出错一律返回 null，由调用方回退到环境变量。
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
    console.error(`[aiDecompose] 读取用户 AI 配置失败，回退到服务端预置：${(error && error.message) || error}`);
    return null;
  }
}

/**
 * 合并「用户自填」与「服务端预置」两级配置（规则与 aiParse 完全一致）。
 * 优先级：用户自填 > 环境变量预置 > 报未配置。
 */
async function resolveEffectiveConfig(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const db = resolveDb(opts);
  const openid = opts.openid === undefined ? safeOpenId() : opts.openid;

  const user = await loadUserAiConfig(db, openid);
  if (user) {
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
 * 把 HTTP 状态码 + 响应体映射成带服务商语义的中文说明（只用于日志）。
 * 业务码优先（智谱），再退回标准 HTTP 语义（两家通用）。对外一律只返回 ERROR_MESSAGE。
 */
function classifyHttpError(provider, status, bodyText, model) {
  const body = bodyText || '';
  const codeMatched = body.match(/"code"\s*:\s*"?([0-9A-Za-z_.-]{1,32})"?/);
  const messageMatched = body.match(/"message"\s*:\s*"([^"]{0,200})"/);
  const code = codeMatched ? codeMatched[1] : '';
  const message = messageMatched ? messageMatched[1] : '';
  const detail = [`HTTP ${status}`, code ? `业务码 ${code}` : '', message].filter(Boolean).join(' / ');

  const hasCode = (list) => !!code && list.indexOf(code) !== -1;

  if (hasCode(provider.quotaCodes)) return `额度/频率受限（${detail}）`;
  if (hasCode(provider.authCodes)) return `认证失败（${detail}）`;
  if (hasCode(provider.modelMissingCodes)) {
    return `模型不存在（当前模型 "${model}"，请检查模型名或改用 ${ENV_MODEL} 覆盖）（${detail}）`;
  }
  if (hasCode(provider.paramCodes)) return `请求参数有误（${detail}）`;

  if (status === 401) return `认证失败，API Key 无效或已过期（${detail}）`;
  if (status === 403) return `无权限访问该接口或模型（${detail}）`;
  if (status === 404) return `接口或模型不存在（当前模型 "${model}"）（${detail}）`;
  if (status === 429) return `请求过于频繁或额度不足（${detail}）`;
  if (status === 400) return `请求参数有误，或模型不存在（当前模型 "${model}"）（${detail}）`;
  if (status >= 500) return `服务商内部错误（${detail}）`;
  return `异常状态码（${detail}）`;
}

/** 星期几的中文名（下标 0 = 周一） */
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

/** 严格校验 YYYY-MM-DD（同时挡掉 2026-02-30 这类日历上不存在的日期） */
function isValidDate(value) {
  const matched = toStr(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) return false;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year
    && probe.getUTCMonth() + 1 === month
    && probe.getUTCDate() === day;
}

/** 某天是周几（0 = 周一 … 6 = 周日） */
function weekdayIndex(dayStr) {
  if (!isValidDate(dayStr)) return null;
  const text = toStr(dayStr);
  const date = new Date(`${text}T00:00:00Z`);
  return (date.getUTCDay() + 6) % 7;
}

/**
 * 入参校验：返回空字符串表示通过，否则是给用户看的提示。
 */
function validateInput(title, deadline) {
  const taskTitle = toStr(title);
  const deadlineText = toStr(deadline);
  if (!taskTitle) return '任务名称不能为空';
  if (taskTitle.length > MAX_TITLE_LENGTH) return `任务名称过长（最多 ${MAX_TITLE_LENGTH} 字）`;
  if (!deadlineText) return '截止日期不能为空';
  if (!isValidDate(deadlineText)) return '截止日期必须是 YYYY-MM-DD（例如 2026-12-31）';
  return '';
}

// ---------------------------------------------------------------------------
// 容错 JSON 解析（与 aiParse 保持同一套思路：围栏 / 多余文字 / 尾逗号 / 全角标点）
// ---------------------------------------------------------------------------
/**
 * 模型用中文输入法时，除了引号会写成 “ ”，**冒号/逗号也可能是全角**（：，）——
 * 它们在 JSON 里不是合法结构符号，不换掉就必然解析失败。这里一并转半角。
 */
function jsonLoadsTolerant(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const normalized = text
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\uff1a/g, ':')
    .replace(/\uff0c/g, ',');
  const candidates = [
    text,
    text.replace(/,\s*([}\]])/g, '$1'),
    normalized,
    normalized.replace(/,\s*([}\]])/g, '$1'),
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    try {
      return JSON.parse(candidates[i]);
    } catch (error) {
      // 试下一种修复
    }
  }
  return null;
}

/**
 * 从模型返回文本中提取 JSON 对象；失败返回 null。
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
    const data = jsonLoadsTolerant(candidates[i]);
    if (isPlainObject(data)) return data;
    if (Array.isArray(data) && data.length && isPlainObject(data[0])) return data[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

/** estimate_min 容错：负数 / 字符串 / 缺失 → 0；顺带收敛到 24 小时以内 */
function normalizeEstimate(value) {
  let estimate = 0;
  if (typeof value === 'number' && Number.isFinite(value)) estimate = Math.trunc(value);
  else if (typeof value === 'string') {
    const matched = value.trim().match(/^-?\d+/);
    if (matched) estimate = parseInt(matched[0], 10);
  }
  if (!Number.isFinite(estimate) || estimate < 0) return 0;
  return Math.min(estimate, MAX_ESTIMATE_MIN);
}

/**
 * 归一化一条子任务：标题必须非空；建议日期必须落在 [今天, 截止日]。
 *
 * @returns {{title, suggested_date, estimate_min}|null}
 */
function normalizeSubtask(item, today, deadline) {
  if (!isPlainObject(item)) return null;
  const title = toStr(item.title).slice(0, MAX_TITLE_LENGTH);
  if (!title) return null;

  const base = isValidDate(today) ? today : todayStr();
  const limit = isValidDate(deadline) ? deadline : base;
  let suggested = toStr(item.suggested_date);
  if (!isValidDate(suggested)) suggested = base; // 模型没给 / 给的是"下周三"这种写法 → 收到今天
  if (suggested < base) suggested = base; // 早于今天 → 收到今天
  if (suggested > limit) suggested = limit; // 晚于截止 → 收到截止日

  return {
    title,
    suggested_date: suggested,
    estimate_min: normalizeEstimate(item.estimate_min),
  };
}

/**
 * 归一化整个拆解结果：丢掉脏条目，最多保留 MAX_STEPS 步。
 */
function normalizeDecomposeResult(data, today, deadline) {
  if (!isPlainObject(data)) return [];
  const raw = data.subtasks;
  if (!Array.isArray(raw)) return [];
  const subtasks = [];
  raw.forEach((item) => {
    const clean = normalizeSubtask(item, today, deadline);
    if (clean) subtasks.push(clean);
  });
  return subtasks.slice(0, MAX_STEPS);
}

// ---------------------------------------------------------------------------
// Prompt 拼装（对齐 decompose_task 的 system prompt）
// ---------------------------------------------------------------------------
function buildSystemPrompt(today, deadline) {
  const base = isValidDate(today) ? today : todayStr();
  const limit = isValidDate(deadline) ? deadline : base;
  const weekday = WEEKDAY_CN[weekdayIndex(base)];

  return `你是一个中文任务拆解助手。请把用户给出的大任务拆解成 3~8 个具体、可执行、互不重叠的子任务。

今天是 ${base}（${weekday}），任务截止日期是 ${limit}。
请把子任务均匀地安排在「今天到截止日期之间」，越靠前的子任务日期越早，最后一个子任务的日期不晚于截止日期。

只输出一个 JSON 对象，不要输出解释、不要用 Markdown 代码块、不要添加额外字段。结构必须完全如下：
{
  "task": "任务名称",
  "deadline": "${limit}",
  "subtasks": [
    {"title": "子任务名称", "suggested_date": "YYYY-MM-DD", "estimate_min": 60}
  ]
}

规则：
1. "task" 原样返回用户给出的任务名称；"deadline" 原样返回 ${limit}。
2. 每个子任务都要是动词开头的具体动作，粒度控制在 30 分钟到半天能完成。
3. "suggested_date" 必须是绝对的 YYYY-MM-DD，且在 ${base} 到 ${limit} 之间。
4. 子任务按建议日期的先后顺序排列。
5. "estimate_min" 是这一步预计要花多少**分钟**（整数，15 的倍数，例如 30 / 60 / 120）——
   它会被用来算「这周还排得下吗」，所以要贴近真实耗时，不要都写一样的数。
6. 步数必须控制在 3~8 步之间：少于 3 步说明拆得不够细，多于 8 步说明拆得太碎。`;
}

// ---------------------------------------------------------------------------
// 调用 DeepSeek（只用内置 https，与 aiParse 同一套实现）
// ---------------------------------------------------------------------------
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
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
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
 * 调服务商的 Chat Completions（智谱 / DeepSeek 共用，只有 base 与 model 不同）。
 *
 * Key 走两级：**用户自填（按 openid 读库）> 服务端环境变量预置**。
 *
 * @param {object} [options] { env, db, openid } —— 便于自测注入
 * @returns {Promise<{content, error, provider, model, source, reason}>}
 */
async function chatCompletion(messages, jsonMode, temperature, options) {
  const opts = options || {};
  const config = await resolveEffectiveConfig(opts);

  if (config.notices) config.notices.forEach((notice) => console.warn(`[aiDecompose] ${notice}`));

  if (!config.ok) {
    console.warn(`[aiDecompose] 跳过 AI 调用（来源=服务端环境变量）：${config.reason}`);
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
  // 日志里的来源字样（只写这四个字，绝不写 Key 本身或它的前缀）
  const sourceLabel = source === 'user' ? '来源=用户自填' : '来源=服务端环境变量';
  // 用户自填 Key 失败 → 可操作文案；预置 Key 失败 → 统一文案
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
    const reason = describe(`请求失败：${(error && error.message) || error}`);
    console.error(`[aiDecompose] ${reason}`);
    return { content: null, error: failureMessage, provider: provider.name, model, source, reason };
  }

  // 不支持 response_format 的端点/模型会返回 400，去掉该字段重试一次（智谱靠这段兜底）
  if (response.status === 400 && jsonMode) {
    console.warn(`[aiDecompose] ${describe('拒绝了 response_format，去掉该字段重试一次')}`);
    delete payload.response_format;
    try {
      response = await exports.postJson(endpoint, payload, headers, TIMEOUT_MS);
    } catch (error) {
      const reason = describe(`重试失败：${(error && error.message) || error}`);
      console.error(`[aiDecompose] ${reason}`);
      return { content: null, error: failureMessage, provider: provider.name, model, source, reason };
    }
  }

  if (response.status !== 200) {
    const reason = describe(classifyHttpError(provider, response.status, response.text, model));
    console.error(`[aiDecompose] ${reason}`);
    return { content: null, error: failureMessage, provider: provider.name, model, source, reason };
  }

  let data;
  try {
    data = JSON.parse(response.text);
  } catch (error) {
    const reason = describe('返回的内容不是合法 JSON');
    console.error(`[aiDecompose] ${reason}`);
    return { content: null, error: failureMessage, provider: provider.name, model, source, reason };
  }

  // 两家成功响应形状一致：choices[0].message.content
  const content = data
    && data.choices && data.choices[0]
    && data.choices[0].message && data.choices[0].message.content;
  if (typeof content !== 'string' || !content.trim()) {
    const reason = describe('返回结构异常或内容为空');
    console.error(`[aiDecompose] ${reason}`);
    return { content: null, error: failureMessage, provider: provider.name, model, source, reason };
  }
  return { content, error: null, provider: provider.name, model, source, reason: '' };
}

// ---------------------------------------------------------------------------
// 对外主逻辑
// ---------------------------------------------------------------------------

/**
 * 第三方可能塞进来的"看起来像凭证/地址"的字段名（与 aiParse 同一份清单）。
 *
 * 【为什么显式忽略】若允许前端传 Key 或 baseUrl，云函数就成了"用别人额度"
 * 或"任意地址转发（SSRF）"的入口。这些字段一律不看，出现就记一笔日志。
 */
const IGNORED_INJECTION_FIELDS = [
  'apiKey', 'apikey', 'api_key', 'key', 'token', 'secret',
  'baseUrl', 'base_url', 'apiBase', 'endpoint', 'url', 'host',
  'provider', 'model', 'openid', '_openid',
];

/** 挑出 event 里不该由前端指定的字段（只为记日志，不参与业务） */
function findInjectedFields(event) {
  if (!event || typeof event !== 'object') return [];
  return IGNORED_INJECTION_FIELDS.filter((name) => (
    Object.prototype.hasOwnProperty.call(event, name) && toStr(event[name])
  ));
}

/**
 * @param {{title: string, deadline: string}} event **只认 title 与 deadline**
 *        （apiKey / baseUrl / provider / model 等一律忽略）
 * @param {{today?: string, env?: object, db?: object, openid?: string}} [options] 便于自测注入
 * @returns {Promise<object>} { ok:true, task, deadline, subtasks } 或 { ok:false, error }
 */
async function handleDecompose(event, options) {
  const opts = options || {};
  const title = toStr(event && event.title);
  const deadline = toStr(event && event.deadline);

  // 有"想传 Key / 传地址"的字段就记一笔 —— 只记字段名，**不记值**
  const injected = findInjectedFields(event);
  if (injected.length) {
    console.warn(
      `[aiDecompose] 入参里出现了不该由前端指定的字段（${injected.join(', ')}），已忽略；`
      + 'Key 只从数据库（用户自填）或环境变量（服务端预置）读取，请求地址只从白名单映射'
    );
  }

  const invalid = validateInput(title, deadline);
  if (invalid) return { ok: false, error: invalid };

  const today = opts.today || todayStr();
  const messages = [
    { role: 'system', content: buildSystemPrompt(today, deadline) },
    // 与 Python 版一致：把任务与截止日再在 user 消息里说一遍
    { role: 'user', content: `任务：${title}\n截止日期：${deadline}` },
  ];

  const completion = await chatCompletion(messages, true, TEMPERATURE, opts);
  if (completion.error) return { ok: false, error: completion.error };

  const parsed = extractJsonObject(completion.content);
  if (!parsed) {
    console.error('[aiDecompose] 无法从模型返回内容中解析出 JSON：', toStr(completion.content).slice(0, 200));
    return { ok: false, error: ERROR_MESSAGE };
  }

  // 以调用方传入的 title / deadline 为准，避免模型改写
  const subtasks = normalizeDecomposeResult(parsed, today, deadline);
  return { ok: true, task: title, deadline, subtasks, steps: subtasks.length };
}

/**
 * 云函数入口。
 *
 * 这里把 OPENID 与 db 都解析好传给 handleDecompose —— Key 的读取全在
 * resolveEffectiveConfig() 里按 openid 完成；event 里的任何"凭证类"字段都不参与。
 */
exports.main = async (event) => {
  try {
    return await handleDecompose(event || {}, {
      db: resolveDb({}),
      openid: safeOpenId(),
    });
  } catch (error) {
    console.error('[aiDecompose] 未预期异常：', (error && error.stack) || error);
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
  handleDecompose,
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
  normalizeEstimate,
  normalizeSubtask,
  normalizeDecomposeResult,
  buildSystemPrompt,
  validateInput,
  isValidDate,
  todayStr,
  weekdayIndex,
  hasApiKey,
  // 常量
  TIMEOUT_MS,
  ERROR_MESSAGE,
  USER_KEY_FAILED_MESSAGE,
  MAX_TITLE_LENGTH,
  MIN_STEPS,
  MAX_STEPS,
  MAX_ESTIMATE_MIN,
  TEMPERATURE,
  WEEKDAY_CN,
});
