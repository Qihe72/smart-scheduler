/**
 * utils/tests/harness.js —— 极简单测框架（零依赖、无副作用）。
 *
 * 【为什么单独一个文件】
 *   最初这些断言助手直接写在 run.js 里，结果是：tasks.test.js 想复用它们就得
 *   require run.js —— 而 run.js 的模块体**会立刻跑整份测试套件**，于是
 *   「单独跑 tasks.test.js」变成了「跑全部」，既看不出单独的结果，也容易被误解。
 *   所以把它抽成这个**只定义、不执行**的模块：
 *
 *     * 任何测试文件都可以 `require('./harness.js')` 拿到同一套断言与**同一个计数器**；
 *     * require 它不会打印任何东西、不会跑任何用例、不会 exit；
 *     * 汇总与退出码由**入口文件**（run.js 或各 *.test.js）自己负责。
 *
 * 【计数器为什么挂在 global 上】
 *   node 里同一个文件被不同路径 require（例如 './harness.js' 与绝对路径）时，
 *   模块缓存是按**解析后的绝对路径**算的，正常只会实例化一次；用 __dirname 做键是
 *   多一层保险，顺便避免和别的库撞名。
 */

'use strict';

var STATE_KEY = '__scheduler_test_state__' + __dirname;
var state = global[STATE_KEY];
if (!state) {
  state = { passed: 0, failed: 0, currentBlock: '(未分组)' };
  global[STATE_KEY] = state;
}

/** 开一个新的测试分组，只是为了让输出好读 */
function block(title) {
  state.currentBlock = title;
  console.log('\n── ' + title + ' ──');
}

/** JSON 化的展示（数组用 [] 表示，和断言里写的一致） */
function show(value) {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch (err) {
    return String(value);
  }
}

/** 记录一次断言结果 */
function record(ok, label, detail) {
  if (ok) {
    state.passed += 1;
    console.log('  PASS  ' + label);
  } else {
    state.failed += 1;
    console.log('  FAIL  ' + label);
    if (detail) console.log('        ' + detail);
  }
}

/** 断言：实际值 === 期望值（用 Object.is，能区分 0/-0 与 null/undefined） */
function eq(actual, expected, label) {
  record(Object.is(actual, expected), label,
    '期望 ' + show(expected) + '，实际 ' + show(actual) + '   [' + state.currentBlock + ']');
}

/** 断言：数组逐项相等（长度也要一致） */
function eqArr(actual, expected, label) {
  var ok = Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length;
  if (ok) {
    for (var i = 0; i < expected.length; i += 1) {
      if (!Object.is(actual[i], expected[i])) { ok = false; break; }
    }
  }
  record(ok, label,
    '期望 ' + show(expected) + '，实际 ' + show(actual) + '   [' + state.currentBlock + ']');
}

/** 断言：两个值 JSON 化之后完全一致（用来比较嵌套数组，例如整张行表） */
function eqJson(actual, expected, label) {
  record(show(actual) === show(expected), label,
    '期望 ' + show(expected) + '，实际 ' + show(actual) + '   [' + state.currentBlock + ']');
}

/** 断言：为 true / 为 false（分开写，失败信息更好读） */
function isTrue(actual, label) {
  record(actual === true, label, '期望 true，实际 ' + show(actual) + '   [' + state.currentBlock + ']');
}

function isFalse(actual, label) {
  record(actual === false, label, '期望 false，实际 ' + show(actual) + '   [' + state.currentBlock + ']');
}

/**
 * 打印总结并按需设置退出码 —— **只在入口文件里调用**。
 * @param {string} title 这份测试的名字（打印在总结上面）
 */
function report(title) {
  var total = state.passed + state.failed;
  console.log('\n──────────────────────────────────────────');
  if (title) console.log(title);
  console.log('通过 ' + state.passed + ' / ' + total + '，失败 ' + state.failed);
  if (state.failed) {
    console.log('FAILED');
    process.exit(1);
  }
  console.log('ALL PASS');
  process.exit(0);
}

module.exports = {
  state: state,
  block: block,
  show: show,
  record: record,
  eq: eq,
  eqArr: eqArr,
  eqJson: eqJson,
  isTrue: isTrue,
  isFalse: isFalse,
  report: report
};
