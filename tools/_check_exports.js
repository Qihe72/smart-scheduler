/**
 * 静态检查「调用了但没导出」的静默断路。
 *
 * 真实踩过：cloudfunctions/tasks/index.js 调 N.normalizeAiConfig() 与 N.maskApiKey()，
 * 而 lib/normalize.js 的 module.exports 里没有它们 —— 两个函数明明定义了，
 * 导出对象上却是 undefined，**只有运行到那一行才会炸**，而且用户看到的是一句
 * 「N.normalizeAiConfig is not a function」这种谁也看不懂的话。
 *
 * 这类问题静态一查就能发现：把 index.js 里所有 `N.xxx(` 的 xxx 收集起来，
 * 逐个拿到 require 出来的对象上核对类型。
 *
 * 用法：node _check_exports.js <lib 路径> <调用方路径>
 * 输出：一行 JSON {"checked": n, "missing": [...]}
 */
'use strict';

const libPath = process.argv[2];
const callerPath = process.argv[3];

if (!libPath || !callerPath) {
  process.stderr.write('用法: node _check_exports.js <lib> <caller>\n');
  process.exit(2);
}

const fs = require('fs');

let lib;
try {
  lib = require(libPath);
} catch (err) {
  process.stdout.write(JSON.stringify({ loadError: String((err && err.message) || err) }));
  process.exit(0);
}

const src = fs.readFileSync(callerPath, 'utf8');

// 不用正则：逐字符扫描 `N.` 后面紧跟的标识符，且后面必须紧跟 `(`。
// 这样既不会漏（N.foo(）也不会误报（N.foo 只取属性、或注释里的 N.foo）。
const names = new Set();
src.split('\n').forEach(function (line) {
  // 跳过整行注释，免得注释里举例的 N.xxx( 被算进来
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;

  let pos = 0;
  while ((pos = line.indexOf('N.', pos)) !== -1) {
    // 【关键】必须确认这个 N 是一个**独立的标识符**，而不是别的名字的结尾。
    // 真实踩过：`JSON.stringify(scope)` 里的 "N." 被当成了"调用 N.stringify"，
    // 于是这条静态检查报了一个**根本不存在的**"normalize.js 没导出 stringify"。
    // 差一步就去给 normalize.js 加一个没人用的死函数 —— 假阳性同样会让人改错东西。
    const prev = pos > 0 ? line[pos - 1] : '';
    if (prev && /[A-Za-z0-9_$]/.test(prev)) {
      pos += 2;
      continue;
    }
    let j = pos + 2;
    let id = '';
    while (j < line.length && /[A-Za-z0-9_$]/.test(line[j])) {
      id += line[j];
      j += 1;
    }
    if (id && line[j] === '(') names.add(id);
    pos = j;
  }
});

const checked = Array.from(names).sort();
const missing = checked.filter(function (name) {
  return typeof lib[name] !== 'function';
});

process.stdout.write(JSON.stringify({ checked: checked.length, missing: missing }));
