/**
 * probe_ai_http.js —— aiHttp 云函数的本地自测（不需要云环境、不需要 npm install）
 *
 * 跑法：node tools/verify_ai_http.js
 * 输出只用 ASCII 标记，避免 Windows 控制台编码问题；失败时只打断言编号与期望/实际。
 *
 * 覆盖：CORS 预检、方法/口令/限流、请求体解析（含 base64）、字段校验、
 *       转发到哪个云函数、内层 {ok:false} 如何透传、字符串结果容错。
 */
'use strict';

const path = require('path');

const TARGET = path.join(__dirname, '..', 'miniprogram', 'cloudfunctions', 'aiHttp', 'index.js');
const fn = require(TARGET);
const T = fn.__test;

let passed = 0;
const failures = [];

function ok(id, condition, detail) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(id + (detail ? ' :: ' + detail : ''));
}

function body(res) {
  try {
    return JSON.parse(res.body);
  } catch (error) {
    return null;
  }
}

function resetRate() {
  T.hits.clear();
}

/** 记录被转发的调用 */
function makeCloud(inner) {
  const calls = [];
  const fake = {
    callFunction: async (options) => {
      calls.push(options);
      const result = typeof inner === 'function' ? inner(options) : inner;
      return { result: result };
    },
  };
  return { fake, calls };
}

async function main() {
  // ---------------------------------------------------------------- 1. CORS 预检
  let res = await fn.main({ httpMethod: 'OPTIONS', headers: {} });
  ok('P1-preflight-status', res.statusCode === 204, 'got ' + res.statusCode);
  ok('P2-preflight-origin', res.headers['Access-Control-Allow-Origin'] === '*', String(res.headers['Access-Control-Allow-Origin']));
  ok('P3-preflight-headers', /X-Web-AI-Token/i.test(res.headers['Access-Control-Allow-Headers'] || ''), String(res.headers['Access-Control-Allow-Headers']));
  ok('P4-preflight-methods', /POST/.test(res.headers['Access-Control-Allow-Methods'] || ''), String(res.headers['Access-Control-Allow-Methods']));

  // ---------------------------------------------------------------- 2. 方法与请求体
  res = await fn.main({ httpMethod: 'GET', headers: {} });
  ok('P5-get-405', res.statusCode === 405, 'got ' + res.statusCode);
  ok('P6-get-json', body(res) && body(res).ok === false, JSON.stringify(body(res)));

  res = await fn.main({ httpMethod: 'POST', headers: {}, body: '{not json' });
  ok('P7-bad-json-400', res.statusCode === 400, 'got ' + res.statusCode);

  res = await fn.main({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ action: 'parse' }) });
  ok('P8-no-text-400', res.statusCode === 400, 'got ' + res.statusCode);

  res = await fn.main({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ text: 'x'.repeat(501) }) });
  ok('P9-too-long-400', res.statusCode === 400, 'got ' + res.statusCode);

  res = await fn.main({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ text: '周五交报告', action: 'nope' }) });
  ok('P10-unknown-action-400', res.statusCode === 400, 'got ' + res.statusCode);

  resetRate();
  // ---------------------------------------------------------------- 3. 口令
  process.env.WEB_AI_TOKEN = 'S3CRET';
  res = await fn.main({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ text: '周五交报告' }) });
  ok('P11-token-missing-401', res.statusCode === 401, 'got ' + res.statusCode);
  res = await fn.main({ httpMethod: 'POST', headers: { 'X-Web-AI-Token': 'wrong' }, body: JSON.stringify({ text: '周五交报告' }) });
  ok('P12-token-wrong-401', res.statusCode === 401, 'got ' + res.statusCode);
  res = await fn.main({ httpMethod: 'POST', headers: { 'x-web-ai-token': 'S3CRET' }, body: JSON.stringify({ text: '周五交报告' }) });
  ok('P13-token-case-insensitive-passes', res.statusCode === 200, 'got ' + res.statusCode);
  delete process.env.WEB_AI_TOKEN;

  resetRate();
  // ---------------------------------------------------------------- 4. 转发落点
  const parseCloud = makeCloud({ ok: true, events: [{ title: '交报告' }], deadlines: [], needs_clarification: false });
  T.setCloud(parseCloud.fake);
  res = await fn.main({ httpMethod: 'POST', headers: { 'x-forwarded-for': '1.2.3.4' }, body: JSON.stringify({ text: '周五下午交报告' }) });
  const parsed = body(res);
  ok('P14-forward-status', res.statusCode === 200, 'got ' + res.statusCode);
  ok('P15-forward-ok', parsed && parsed.ok === true && parsed.data && parsed.data.events.length === 1, JSON.stringify(parsed));
  ok('P16-forward-fn-name', parseCloud.calls[0] && parseCloud.calls[0].name === 'aiParse', JSON.stringify(parseCloud.calls[0]));
  ok('P17-forward-payload', parseCloud.calls[0] && parseCloud.calls[0].data.text === '周五下午交报告', JSON.stringify(parseCloud.calls[0] && parseCloud.calls[0].data));

  resetRate();
  // ---------------------------------------------------------------- 5. 内层失败透传
  T.setCloud(makeCloud({ ok: false, error: 'AI 服务暂不可用' }).fake);
  res = await fn.main({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ text: '周五交报告' }) });
  const inner = body(res);
  ok('P18-inner-fail-200', res.statusCode === 200, 'got ' + res.statusCode);
  ok('P19-inner-fail-passthrough', inner && inner.ok === false && inner.error === 'AI 服务暂不可用', JSON.stringify(inner));

  resetRate();
  // ---------------------------------------------------------------- 6. 字符串结果 / 空结果容错
  T.setCloud(makeCloud(JSON.stringify({ ok: true, events: [], deadlines: [] })).fake);
  res = await fn.main({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ text: '乱说一句' }) });
  ok('P20-string-result-parsed', body(res) && body(res).ok === true, JSON.stringify(body(res)));

  T.setCloud(makeCloud(undefined).fake);
  res = await fn.main({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ text: '乱说一句' }) });
  ok('P21-empty-result-handled', body(res) && body(res).ok === false, JSON.stringify(body(res)));

  resetRate();
  // ---------------------------------------------------------------- 7. 拆解
  res = await fn.main({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ action: 'decompose' }) });
  ok('P22-decompose-no-title-400', res.statusCode === 400, 'got ' + res.statusCode);
  res = await fn.main({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ action: 'decompose', title: '写报告', deadline: '10月31日' }) });
  ok('P23-decompose-bad-date-400', res.statusCode === 400, 'got ' + res.statusCode);

  const decCloud = makeCloud({ ok: true, subtasks: [{ title: '算光路' }] });
  T.setCloud(decCloud.fake);
  res = await fn.main({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ action: 'decompose', title: '写报告', deadline: '2026-10-31' }) });
  ok('P24-decompose-ok', body(res) && body(res).ok === true, JSON.stringify(body(res)));
  ok('P25-decompose-fn', decCloud.calls[0] && decCloud.calls[0].name === 'aiDecompose', JSON.stringify(decCloud.calls[0]));
  ok('P26-decompose-payload', decCloud.calls[0] && decCloud.calls[0].data.deadline === '2026-10-31', JSON.stringify(decCloud.calls[0] && decCloud.calls[0].data));

  // ---------------------------------------------------------------- 8. 限流
  resetRate();
  process.env.WEB_AI_RPM = '3';
  T.setCloud(makeCloud({ ok: true, events: [] }).fake);
  let last = null;
  for (let i = 0; i < 4; i += 1) {
    last = await fn.main({ httpMethod: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' }, body: JSON.stringify({ text: '周五交报告' }) });
  }
  ok('P27-rate-limit-429', last && last.statusCode === 429, last && String(last.statusCode));
  // 换一个 IP 不受影响（限流是按 IP 的）
  const other = await fn.main({ httpMethod: 'POST', headers: { 'x-forwarded-for': '8.8.8.8' }, body: JSON.stringify({ text: '周五交报告' }) });
  ok('P28-rate-limit-per-ip', other.statusCode === 200, String(other.statusCode));
  delete process.env.WEB_AI_RPM;

  // ---------------------------------------------------------------- 9. base64 请求体
  resetRate();
  T.setCloud(makeCloud({ ok: true, events: [] }).fake);
  const raw = JSON.stringify({ text: '周六早上八点跑步' });
  res = await fn.main({ httpMethod: 'POST', headers: {}, body: Buffer.from(raw, 'utf8').toString('base64'), isBase64Encoded: true });
  ok('P29-base64-body', res.statusCode === 200 && body(res) && body(res).ok === true, JSON.stringify(body(res)));

  // ---------------------------------------------------------------- 10. 纯函数
  ok('P30-clientkey-unknown', T.clientKey({}) === 'unknown', T.clientKey({}));
  ok('P31-clientkey-forwarded', T.clientKey({ headers: { 'X-Forwarded-For': '5.6.7.8, 10.0.0.1' } }) === '5.6.7.8', T.clientKey({ headers: { 'X-Forwarded-For': '5.6.7.8, 10.0.0.1' } }));
  ok('P32-readbody-object', T.readBody({ body: { text: 'a' } }) !== null, 'object body');
  ok('P33-readbody-empty', T.readBody({ body: '' }) === null, 'empty body');

  // ---------------------------------------------------------------- 收尾
  const total = passed + failures.length;
  console.log('[probe_ai_http] ' + passed + '/' + total + ' passed');
  if (failures.length) {
    failures.forEach((item) => console.log('  FAIL ' + item));
    process.exitCode = 1;
    return;
  }
  console.log('[probe_ai_http] all green');
}

main().catch((error) => {
  console.log('[probe_ai_http] crashed: ' + ((error && error.message) || error));
  process.exitCode = 1;
});
