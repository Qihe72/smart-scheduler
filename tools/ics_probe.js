/**
 * 跨语言一致性验证的探针：把一份 .ics 文本喂给 miniprogram/utils/ics.js，把结果打成 JSON。
 *
 * 它属于**验证工具**（`tools/` 下），不是小程序工程的一部分 —— 所以可以放心用 fs：
 * 小程序端的 `utils/ics.js` 自己不许用任何 Node 内置模块（小程序里没有）。
 *
 * .ics 文本从 **stdin** 读入（不落临时文件）；结果写 stdout。
 *
 * 用法：node tools/ics_probe.js <ics.js 的路径>   < 某个.ics
 */
'use strict';

const modulePath = process.argv[2];

if (!modulePath) {
  process.stderr.write('用法: node ics_probe.js <ics.js 路径>   （.ics 从 stdin 读）\n');
  process.exit(2);
}

const fs = require('fs');

let ics;
try {
  ics = require(modulePath);
} catch (err) {
  process.stdout.write(JSON.stringify({ loadError: String((err && err.message) || err) }));
  process.exit(0);
}

// 0 = stdin。用 readFileSync 同步读，避免异步与下面的流程交错。
let text = '';
try {
  text = fs.readFileSync(0, 'utf8');
} catch (err) {
  process.stdout.write(JSON.stringify({ inputError: String((err && err.message) || err) }));
  process.exit(0);
}

let parsed;
try {
  parsed = ics.parseIcs(text);
} catch (err) {
  process.stdout.write(JSON.stringify({ throwError: String((err && err.message) || err) }));
  process.exit(0);
}

const events = (parsed && parsed.events) || [];
const warnings = (parsed && parsed.warnings) || [];

let tasks = [];
let toTasksError = '';
try {
  tasks = ics.toTasks(events) || [];
} catch (err) {
  toTasksError = String((err && err.message) || err);
}

process.stdout.write(JSON.stringify({
  eventCount: events.length,
  warningCount: warnings.length,
  warnings: warnings.slice(0, 5),
  taskCount: tasks.length,
  taskKeys: tasks.length ? Object.keys(tasks[0]).sort() : [],
  toTasksError: toTasksError,
  tasks: tasks,
  exported: Object.keys(ics).sort()
}));
