'use strict';

/**
 * 「缺时刻·不会提醒」标记（pages/tasks）与编辑页那条拦截的**口径一致性**。
 *
 * 事情的来龙去脉（2026-10-21 真机实测）：
 *   用户点了「检查一次」，界面如实报出：「扫描 1 人，有 27 条该提醒的都被跳过了：
 *   截止没填时刻 25 条、已经过了提醒点 1 条、还没到提前量窗口 1 条。」
 *   25/27 都是同一个原因：截止只填了日期，没填时刻。
 *
 *   这不是 bug —— cloudfunctions/remind 的 dueInstantOf 刻意不替用户猜 23:59
 *   （猜了就可能在人家已经准备睡的时候才提醒，或者反过来漏掉）。
 *   但产品上说不通：用户以为「我设了截止」，系统却在后台默默跳过它。
 *
 * 所以两侧各补一刀，而且**判据必须同一口径**：
 *   * 列表（pages/tasks.js）：`needsTime` → 打「缺时刻·不会提醒」标；
 *   * 编辑（pages/edit/edit.js）：保存前问一句，可一键补当天 23:59。
 *   两边不一致会很难解释：列表说不提醒、编辑页却说你已经设好了。
 *
 * 这个文件只管 tasks 侧（编辑侧的拦截在 edit_busy.test.js 第 11 节），
 * 外加一条跨两侧的交叉断言：补上 23:59 之后，列表必须不再标它。
 */

var path = require('path');
var fs = require('fs');
var H = require(path.join(__dirname, 'harness.js'));

var eq = H.eq;
var isTrue = H.isTrue;
var isFalse = H.isFalse;
var block = H.block;
var show = H.show;

var ROOT = path.join(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// 取回 pages/tasks 的注册对象（加载期只临时借用 global.Page，立刻还原）
// ---------------------------------------------------------------------------
var savedPage = global.Page;
var savedWx = global.wx;
var savedGetApp = global.getApp;
var registered = null;
var loadError = null;
var tasksPath = path.join(ROOT, 'pages', 'tasks', 'tasks.js');
try {
  global.Page = function (options) { registered = options; };
  // 【必须先清缓存】run.js 是串行链，如果前面哪个测试文件已经 require 过这个页面，
  // 这里再 require 会直接拿缓存、**不会重新执行 Page(...)** —— 表现是"单独跑全绿、
  // 进 run.js 就说注册对象拿不到"。清掉缓存让它真的重新执行一遍。
  try { delete require.cache[require.resolve(tasksPath)]; } catch (cacheErr) { /* 没进过缓存就不用清 */ }
  require(tasksPath);
} catch (err) {
  loadError = err;
} finally {
  if (savedPage === undefined) delete global.Page; else global.Page = savedPage;
  if (savedWx === undefined) delete global.wx; else global.wx = savedWx;
  if (savedGetApp === undefined) delete global.getApp; else global.getApp = savedGetApp;
}

var viewTask = null;
if (registered && registered.__test) viewTask = registered.__test.viewTask;

/**
 * 造一条任务。默认造"真的会触发问题"的那一种：截止 + 有日期 + 一个时刻都没有。
 * @param {Object} over 覆盖字段
 */
function task(over) {
  return Object.assign({
    _id: 'd1', title: '交实验报告', type: 'ddl', date: '2026-10-20',
    start_time: '', end_time: '', periods: '', estimate_min: 0,
    done: false, priority: 'mid', repeat: 'none'
  }, over || {});
}

// 2026-10-20 是周二；今天固定成 2026-10-19（周一）以便 isToday 可预期
var TODAY = '2026-10-19';
var SEMESTER = '2026-08-31';

function view(over) {
  return viewTask(task(over), {}, TODAY, SEMESTER);
}

block('ddl 缺时刻 —— pages/tasks.js 能加载，探针在位');
isFalse(!!loadError, 'pages/tasks/tasks.js 加载期没有抛异常'
  + (loadError ? '（实际：' + loadError.message + '）' : ''));
isTrue(!!registered, 'Page() 注册对象拿到了');
isTrue(typeof viewTask === 'function',
  '页面通过 __test 暴露了 viewTask（导出名写错会直接 ReferenceError，整个页面都打不开）');
if (typeof viewTask !== 'function') {
  // 加载都失败就没法往下测；给个明确的失败，不要假装全绿
  isTrue(false, 'viewTask 拿不到，后面的断言无法进行');
} else {
  block('缺时刻的截止 —— 该标的标、不该标的不标');
  isTrue(view({}).needsTime === true,
    '截止 + 有日期 + 一个时刻都没填 → 标（这正是那 25 条的形状）');
  isFalse(view({ end_time: '18:00' }).needsTime === true, '有 end_time → 不标（提醒认的就是它）');
  isFalse(view({ start_time: '18:00' }).needsTime === true,
    '只有 start_time 的老数据 → 不标（保存时会被迁移到 end_time，提醒收得到）');
  isFalse(view({ type: 'event' }).needsTime === true, '日程 → 不标（提醒只认截止）');
  isFalse(view({ type: 'subtask' }).needsTime === true, '子任务 → 不标');
  isFalse(view({ done: true }).needsTime === true, '已完成 → 不标（都做完了提醒它干嘛）');
  isFalse(view({ date: '' }).needsTime === true,
    '没有日期 → 不标（日期本身是另一个问题，列表已经用「未定日期」显示它了）');
  eq(view({ date: '' }).dateText, '未定日期', '顺带确认「未定日期」还是原来那套显示，没被这刀改坏');

  block('缺时刻的截止 —— 补上 23:59 之后必须不再标（与编辑页那条一键修复对齐）');
  // 编辑页填的就是 '23:59'（FILL_TIME）。这里用字面量，不 import 页面，避免两页互相依赖；
  // 一致性由下面那条"改回空就重新标"的反向断言来兜底。
  var filled = view({ end_time: '23:59' });
  isFalse(filled.needsTime === true, '补成 23:59 → 不再标（用户点一下就能修掉）');
  isTrue(filled.whenText.indexOf('23:59') > -1,
    '并且列表里能看见这个时刻：' + show(filled.whenText));
  isTrue(view({}).needsTime === true && filled.needsTime === false,
    '同一份数据只差一个 end_time，标记必须翻转（不然这标就是摆设）');

  block('缺时刻的截止 —— 这个标记不该影响别的字段');
  var plain = view({});
  eq(plain.typeLabel, '截止', '类型还是「截止」');
  eq(plain.done, false, 'done 没被影响');
  eq(plain.whenText, '', 'whenText 仍为空（没时刻就不编一个出来）');
  eq(plain.isSoon, false, 'isSoon 默认 false（由 loadTasks 统一填，与这个标记互不干扰）');
}

block('缺时刻 —— WXML/WXSS 真的接上了（防止只改 js 忘了界面）');
var wxml = fs.readFileSync(path.join(ROOT, 'pages', 'tasks', 'tasks.wxml'), 'utf8');
var wxss = fs.readFileSync(path.join(ROOT, 'pages', 'tasks', 'tasks.wxss'), 'utf8');
isTrue(wxml.indexOf('item.needsTime') > -1, '列表渲染里有 wx:if="{{item.needsTime}}"');
isTrue(wxml.indexOf('缺时刻·不会提醒') > -1, '标记文案就是「缺时刻·不会提醒」');
isTrue(wxml.indexOf('缺时刻') > wxml.indexOf('item.isSoon'),
  '它排在「即将到期」之后（先报紧急的，再报"这条根本不会提醒"的）');
isTrue(wxss.indexOf('.meta-notime') > -1, '样式类 .meta-notime 存在');
isTrue(wxss.indexOf('#fdf1d8') > -1,
  '用的是琥珀底色（不是「即将到期」那套红 —— 两者语义不同，不能抢同一种颜色）');

// 编辑页的反向接线（那边第 11 节测行为，这里只钉住"两处都存在"这一事实）
var editWxml = fs.readFileSync(path.join(ROOT, 'pages', 'edit', 'edit.wxml'), 'utf8');
isTrue(editWxml.indexOf('onFill2359') > -1 && wxml.indexOf('缺时刻·不会提醒') > -1,
  '两条路都在：列表能看见、编辑页能一键补（只做一半用户照样收不到提醒）');

// 单独跑时自己收尾；被 run.js require 时由入口汇总（本文件全是同步断言，没有异步链）
if (require.main === module) H.report('缺时刻·不会提醒（tasks 标记 × edit 拦截）');

module.exports = { done: Promise.resolve() };
