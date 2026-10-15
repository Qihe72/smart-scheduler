/**
 * utils/tests/me_contact.test.js —— 「我的 → 联系与反馈」卡片。
 *
 * 跑法：
 *     node utils/tests/me_contact.test.js   # 只跑这一份（末尾打印通过数，失败退出码 1）
 *     node utils/tests/run.js               # 跑全部（注册那一行在 run.js 的串行链里）
 *
 * ===========================================================================
 * 【这一份钉住什么】作者要求"用的人能联系到我、能提问题和修改建议"
 * ===========================================================================
 * 这块功能本身很小，但有一类错误特别难看：**复制失败却提示成功** ——
 * 用户拿去粘，粘出来一片空白，然后以为作者给的号是错的。所以：
 *   1. 三个入口（微信号 / 邮箱 / 反馈模板）复制的**内容必须正确**，且都走同一个出口；
 *   2. 复制成功要有提示，**复制失败必须如实说**并给出"长按手动复制"这条退路；
 *   3. 联系方式**只有一份**（me.js 的 CONTACTS）：页面显示什么、复制什么，都得是它；
 *   4. dataset 缺失 / kind 认不出时**退回微信号**，不许复制空串、更不许崩；
 *   5. 页面上真的渲染了这张卡（WXML 静态自检），否则功能做了用户也看不见。
 *
 * 【不做的事】不 require utils/api.js；不联网；不用 child_process。
 */

'use strict';

var fs = require('fs');
var path = require('path');
var H = require(path.join(__dirname, 'harness.js'));
var ROOT = path.join(__dirname, '..', '..');

var eq = H.eq;
var isTrue = H.isTrue;
var isFalse = H.isFalse;
var block = H.block;
var show = H.show;

// ---------------------------------------------------------------------------
// 桩：加载期一律不碰全局（这是本仓库踩过的坑，见 ai_page.test.js 文件头）
// ---------------------------------------------------------------------------
var toasts = [];
var clipboard = [];        // 每次 setClipboardData 的入参
var clipboardFails = false;

var savedWx = global.wx;
var savedGetApp = global.getApp;

function useStub() {
  toasts = [];
  clipboard = [];
  clipboardFails = false;
  global.wx = {
    showToast: function (options) { toasts.push((options && options.title) || ''); },
    setClipboardData: function (options) {
      clipboard.push(options);
      if (clipboardFails) {
        if (options && typeof options.fail === 'function') options.fail({ errMsg: 'setClipboardData:fail 系统错误' });
        return;
      }
      if (options && typeof options.success === 'function') options.success({ errMsg: 'setClipboardData:ok' });
    },
    stopPullDownRefresh: function () {},
    navigateTo: function () {},
  };
  global.getApp = function () {
    return { globalData: { semesterStart: '2026-09-07', periodTimes: {}, envId: 'test-env' } };
  };
}

function restoreGlobals() {
  if (savedWx === undefined) delete global.wx; else global.wx = savedWx;
  if (savedGetApp === undefined) delete global.getApp; else global.getApp = savedGetApp;
}

// ---------------------------------------------------------------------------
// 取回页面注册对象（只捕获 Page，不碰 wx）
// ---------------------------------------------------------------------------
var me = null;
var meLoadError = null;
try {
  delete require.cache[require.resolve(path.join(ROOT, 'pages', 'me', 'me.js'))];
  global.Page = function (options) { me = options; };
  require(path.join(ROOT, 'pages', 'me', 'me.js'));
} catch (err) {
  meLoadError = err;
}

/** 造一个页面实例（复制注册对象 + 独立的 data 与 setData，与真机行为一致） */
function newPage() {
  var page = {};
  Object.keys(me).forEach(function (key) { page[key] = me[key]; });
  page.data = JSON.parse(JSON.stringify(me.data));
  page.setData = function (patch) {
    Object.keys(patch || {}).forEach(function (key) { page.data[key] = patch[key]; });
  };
  return page;
}

function lastToast() { return toasts.length ? toasts[toasts.length - 1] : ''; }

function run() {
  block('联系与反馈 —— 页面可加载 / 探针就位');
  isFalse(!!meLoadError, 'pages/me/me.js 加载期没有抛异常'
    + (meLoadError ? '（实际：' + meLoadError.message + '）' : ''));
  isTrue(!!me, 'Page() 注册对象拿到了');
  if (meLoadError || !me) return Promise.resolve();

  useStub();
  var T = me.__test;
  isTrue(!!T, '页面通过 __test 暴露了纯函数（测的就是页面真正在用的那份实现）');
  isTrue(!!(T && T.CONTACTS && typeof T.CONTACTS.wechat === 'string'),
    '导出了 CONTACTS（联系方式的唯一来源）');

  // -------------------------------------------------------------------------
  block('联系与反馈 —— 联系方式只有一份：页面显示的就是 CONTACTS');
  eq(T.CONTACTS.wechat, '19333181312', '微信号');
  eq(T.CONTACTS.email, '839933831@qq.com', '邮箱');

  var p = newPage();
  eq(p.data.contactWechat, T.CONTACTS.wechat, '页面 data 里的微信号来自 CONTACTS（不是另抄一份）');
  eq(p.data.contactEmail, T.CONTACTS.email, '页面 data 里的邮箱来自 CONTACTS');
  eq(T.contactOf('wechat'), T.CONTACTS.wechat, "contactOf('wechat') → 微信号");
  eq(T.contactOf('email'), T.CONTACTS.email, "contactOf('email') → 邮箱");
  eq(T.contactOf(''), T.CONTACTS.wechat, 'kind 为空 → 退回微信号（不返回空串）');
  eq(T.contactOf('微信'), T.CONTACTS.wechat, 'kind 认不出 → 退回微信号');

  // -------------------------------------------------------------------------
  block('联系与反馈 —— 点「复制」：内容正确 + 如实反馈');
  p.onCopyContact({ currentTarget: { dataset: { kind: 'wechat' } } });
  eq(clipboard.length, 1, '调用了一次剪贴板');
  eq(clipboard[0].data, '19333181312', '**复制的内容正好是微信号**');
  eq(lastToast(), '已复制微信号', 'toast 说清复制了什么：' + show(lastToast()));
  isTrue(p.data.contactResultText.indexOf('已复制微信号') === 0,
    '结果行也如实写：' + show(p.data.contactResultText));

  clipboard = [];
  toasts = [];
  p.onCopyContact({ currentTarget: { dataset: { kind: 'email' } } });
  eq(clipboard.length, 1, '邮箱：调用了一次剪贴板');
  eq(clipboard[0].data, '839933831@qq.com', '**复制的内容正好是邮箱**');
  eq(lastToast(), '已复制邮箱', 'toast 说明是邮箱');

  // dataset 缺失 / 空对象：不许崩，也不许复制空串
  clipboard = [];
  toasts = [];
  p.onCopyContact();
  eq(clipboard.length, 1, '没有 dataset 时也照常复制（退回微信号）');
  eq(clipboard[0].data, '19333181312', '**缺 dataset 时复制的是微信号**，不是空串');
  isFalse(clipboard[0].data === '', '反面对照：绝不能是空字符串');

  // -------------------------------------------------------------------------
  block('联系与反馈 —— 反馈模板：把定位问题需要的信息列成空位');
  clipboard = [];
  toasts = [];
  p.onCopyFeedbackTemplate();
  eq(clipboard.length, 1, '调用了一次剪贴板');
  var tpl = clipboard[0].data;
  isTrue(tpl.indexOf('问题 / 建议') > -1, '模板里有「问题 / 建议」');
  isTrue(tpl.indexOf('复现步骤') > -1, '有「复现步骤」（报 bug 最关键的一段）');
  isTrue(tpl.indexOf('手机型号') > -1 && tpl.indexOf('微信版本') > -1,
    '有手机型号与微信版本（真机问题基本靠这两项定位）');
  isTrue(tpl.indexOf('期望结果') > -1 && tpl.indexOf('实际结果') > -1, '有期望与实际对照');
  eq(lastToast(), '已复制反馈模板', 'toast 说清复制的是模板');
  eq(T.FEEDBACK_TEMPLATE, tpl, '页面复制的就是导出的那份模板（同一份实现）');

  // -------------------------------------------------------------------------
  block('联系与反馈 —— 复制失败：必须如实说，不许谎报成功');
  clipboard = [];
  toasts = [];
  clipboardFails = true;
  var pFail = newPage();
  pFail.onCopyContact({ currentTarget: { dataset: { kind: 'wechat' } } });
  eq(clipboard.length, 1, '确实尝试过复制');
  isTrue(toasts[0].indexOf('失败') > -1, '**toast 说的是失败**：' + show(toasts[0]));
  isTrue(pFail.data.contactResultText.indexOf('失败') > -1,
    '结果行也说失败：' + show(pFail.data.contactResultText));
  isTrue(pFail.data.contactResultText.indexOf('长按') > -1,
    '并给出退路（长按上面的文字手动复制），而不是把用户堵死：' + show(pFail.data.contactResultText));
  isFalse(pFail.data.contactResultText.indexOf('已复制') === 0, '反面对照：不能是"已复制…"');
  clipboardFails = false;

  // -------------------------------------------------------------------------
  block('联系与反馈 —— WXML 静态自检：这张卡真的渲染出来了');
  var wxml = fs.readFileSync(path.join(ROOT, 'pages', 'me', 'me.wxml'), 'utf8');
  isTrue(wxml.indexOf('联系与反馈') > -1, '卡片标题在页面上');
  isTrue(wxml.indexOf('{{contactWechat}}') > -1, '微信号渲染出来了（不是写在 WXML 里的写死值）');
  isTrue(wxml.indexOf('{{contactEmail}}') > -1, '邮箱渲染出来了');
  isTrue(wxml.indexOf('bindtap="onCopyContact"') > -1, '「复制」按钮接的是 onCopyContact');
  isTrue(wxml.indexOf('bindtap="onCopyFeedbackTemplate"') > -1, '「复制反馈模板」接的是 onCopyFeedbackTemplate');
  isTrue(wxml.indexOf('体验成员') > -1,
    '写明"体验版要加体验成员才能打开"（这正是用户最常来问的一件事）');
  // 联系方式不许硬编码进 WXML（否则就变成两份，改一处漏一处）
  isFalse(wxml.indexOf('19333181312') > -1, '**WXML 里没有写死微信号**（唯一来源是 CONTACTS）');
  isFalse(wxml.indexOf('839933831@qq.com') > -1, '**WXML 里没有写死邮箱**');

  restoreGlobals();
  return Promise.resolve();
}

var done = Promise.resolve()
  .then(run)
  .then(function () {
    restoreGlobals();
    if (require.main === module) H.report('我的页 —— 联系与反馈');
  })
  .catch(function (err) {
    restoreGlobals();
    console.error('联系与反馈测试自己崩了：', err && err.stack ? err.stack : err);
    process.exit(2);
  });

module.exports = { done: done };
