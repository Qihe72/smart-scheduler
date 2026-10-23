/**
 * aiHttp —— 给 H5 网页版用的 AI 转发入口（HTTP 触发）
 *
 * 为什么需要它：个人主体小程序的「深度合成」类目申请不到，官方建议把 AI 功能放到
 * H5 / 公众号里。而 H5 页面**不能直接拿着 API Key 去调厂商接口**（Key 会暴露在浏览器、
 * 且厂商接口基本不发 CORS 头），所以中间必须有一层服务端转发 —— 就是这一个云函数。
 *
 * 它自己**不含任何 AI 逻辑**：只做校验、限流、转发，真正的解析仍然交给
 * aiParse（文本 / 识图）和 aiDecompose（拆解），提示词与模型配置都只有那一份。
 *
 * 入参（JSON body）：
 *   { action: 'parse',      text }                  → 转 aiParse { text }
 *   { action: 'decompose',  title, deadline }       → 转 aiDecompose { title, deadline }
 * 出参：{ ok:true, data:{...} } / { ok:false, error:'人话' }
 *
 * 部署：云开发控制台 → 云函数 → 上传并部署后，在「HTTP 访问服务 / 云接入」里
 *       把路径（例如 /ai）绑到本函数。两种触发形态的 event 形状都能吃（见 readRequest）。
 *
 * 环境变量（都可选）：
 *   WEB_AI_ORIGIN  允许的来源，默认 '*'（把这个 H5 放在别人的页面上时建议收紧成具体域名）
 *   WEB_AI_TOKEN   设了就要求请求头带上同一个值（防被人白嫖额度）
 *   WEB_AI_RPM     每 IP 每分钟上限，默认 12
 */
/**
 * 与仓库其它云函数一致：没有 node_modules（本地自测）时降级为 null，
 * 让 `node cloudfunctions/_selftest.js` 这类脚本不需要 npm install 也能 require 本文件。
 */
let cloud = null;
try {
  cloud = require('wx-server-sdk');
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
} catch (error) {
  cloud = null;
}

const AI_PARSE_FUNCTION = 'aiParse';
const AI_DECOMPOSE_FUNCTION = 'aiDecompose';

const MAX_TEXT_LEN = 500;
const MAX_TITLE_LEN = 100;
const RATE_WINDOW_MS = 60 * 1000;
const DEFAULT_RPM = 12;

/** 进程内限流表：只在本实例内有效，够挡住手滑连点，挡不住真正的分布式刷 —— 如实写明。 */
const hits = new Map();

function toStr(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function envInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function corsHeaders() {
  const origin = toStr(process.env.WEB_AI_ORIGIN) || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Web-AI-Token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function reply(statusCode, payload) {
  return {
    statusCode,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, corsHeaders()),
    body: JSON.stringify(payload),
  };
}

function fail(statusCode, error) {
  return reply(statusCode, { ok: false, error });
}

/** 同时兼容腾讯云 HTTP 访问服务（body 是字符串）和微信云开发 HTTP 触发（body 可能已被解析）。 */
function readBody(event) {
  const raw = event && event.body;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw) return null;
  let text = raw;
  if (event.isBase64Encoded) {
    try {
      text = Buffer.from(raw, 'base64').toString('utf8');
    } catch (error) {
      return null;
    }
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    return null;
  }
}

function headerOf(event, name) {
  const headers = (event && (event.headers || (event.requestContext && event.requestContext.headers))) || {};
  const want = name.toLowerCase();
  const keys = Object.keys(headers);
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i].toLowerCase() === want) return toStr(headers[keys[i]]);
  }
  return '';
}

function clientKey(event) {
  const direct = headerOf(event, 'x-forwarded-for') || headerOf(event, 'x-real-ip');
  const first = direct.split(',')[0].trim();
  if (first) return first;
  const ctx = (event && event.requestContext) || {};
  return toStr(ctx.sourceIp) || toStr(ctx.identity && ctx.identity.sourceIp) || 'unknown';
}

function overRate(key) {
  const limit = envInt('WEB_AI_RPM', DEFAULT_RPM);
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= limit) {
    hits.set(key, list);
    return true;
  }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 2000) hits.clear(); // 防止实例长跑时无限增长
  return false;
}

/** 调另一个云函数并摊平成 { ok, data } —— 内层 {ok:false} 不打成 5xx，让人话能显示到网页上。 */
async function callFunction(name, data) {
  if (!cloud) {
    return { ok: false, error: '云环境不可用（本地自测时属正常现象）' };
  }
  let result;
  try {
    result = await cloud.callFunction({ name, data });
  } catch (error) {
    const message = (error && (error.errMsg || error.message)) || '调用失败';
    return { ok: false, error: 'AI 云函数调用失败：' + message };
  }
  const payload = result && result.result;
  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload);
      return normalizeInner(parsed);
    } catch (error) {
      return { ok: false, error: 'AI 云函数返回了看不懂的内容' };
    }
  }
  return normalizeInner(payload);
}

function normalizeInner(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'AI 云函数没有返回结果' };
  }
  if (payload.ok === false) {
    return { ok: false, error: toStr(payload.error) || '没能解析，换个说法试试' };
  }
  return { ok: true, data: payload };
}

/** 文本解析：入参只有 text，与小程序完全一致（多传字段无害，少传直接拒） */
async function handleParse(body) {
  const text = toStr(body.text);
  if (!text) return fail(400, '请先写一句话，例如「周五下午三点交实验报告」');
  if (text.length > MAX_TEXT_LEN) {
    return fail(400, `一句话最多 ${MAX_TEXT_LEN} 个字，现在是 ${text.length} 个`);
  }
  const outcome = await callFunction(AI_PARSE_FUNCTION, { text });
  if (!outcome.ok) return reply(200, { ok: false, error: outcome.error });
  return reply(200, { ok: true, data: outcome.data });
}

/** 任务拆解：deadline 是 'YYYY-MM-DD'，与 aiDecompose 契约一致 */
async function handleDecompose(body) {
  const title = toStr(body.title);
  const deadline = toStr(body.deadline);
  if (!title) return fail(400, '请先写要拆解的任务名');
  if (title.length > MAX_TITLE_LEN) {
    return fail(400, `任务名最多 ${MAX_TITLE_LEN} 个字`);
  }
  if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
    return fail(400, '截止日期要写成 2026-10-31 这种格式');
  }
  const outcome = await callFunction(AI_DECOMPOSE_FUNCTION, { title, deadline });
  if (!outcome.ok) return reply(200, { ok: false, error: outcome.error });
  return reply(200, { ok: true, data: outcome.data });
}

exports.main = async (event) => {
  const method = toStr(event && (event.httpMethod || event.method)).toUpperCase() || 'POST';
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (method !== 'POST') {
    return fail(405, '只接受 POST');
  }

  const expected = toStr(process.env.WEB_AI_TOKEN);
  if (expected && headerOf(event, 'x-web-ai-token') !== expected) {
    return fail(401, '口令不对');
  }

  if (overRate(clientKey(event))) {
    return fail(429, '太频繁了，歇一分钟再试');
  }

  const body = readBody(event);
  if (!body) {
    return fail(400, '请求体得是一段 JSON');
  }

  const action = toStr(body.action) || 'parse';
  if (action === 'parse') return handleParse(body);
  if (action === 'decompose') return handleDecompose(body);
  return fail(400, '不认识的 action：' + action);
};

/** 给本地联调/自测用：不经过云环境也能验证校验与转发逻辑 */
exports.__test = {
  readBody,
  headerOf,
  clientKey,
  overRate,
  normalizeInner,
  hits,
  /** 自测专用：替换 cloud 句柄，验证"转发给哪个函数、参数对不对" */
  setCloud: (fake) => {
    cloud = fake;
  },
  currentCloud: () => cloud,
};
