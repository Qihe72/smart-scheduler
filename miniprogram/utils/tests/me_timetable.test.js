/**
 * utils/tests/me_timetable.test.js —— 「我的 → 从教务系统导入」这个入口（页面侧）。
 *
 * 跑法：
 *     node utils/tests/me_timetable.test.js   # 只跑这一份
 *     node utils/tests/run.js                 # 跑全部（注册那一行在 run.js 的串行链里）
 *
 * ===========================================================================
 * 【为什么单独一份】解析规则本身由 utils/tests/timetable.test.js 覆盖（纯函数）。
 * 这一份只管**页面把这件事用对了没有**，也就是真机上最容易出问题的三件事：
 *   1. **读不到/空剪贴板** → 必须说清"先去复制"，而不是静默什么都不做；
 *   2. **认不出内容** → 必须指向「拍照识别课表」这条退路，而不是导入一堆空课程；
 *   3. **没设学期开始日期** → 必须让用户先设，**不许猜一个日期**（猜错会让整学期错位）。
 * 另外钉住一条承诺：这条路**不写库**（预览阶段只改 data，落库仍要点确认按钮）。
 *
 * 【怎么测一个 Page】照 ai_page.test.js / me_import.test.js 的既有模式：
 * 加载期只捕获 Page，用例执行时才装 wx / getApp 桩。**不调用 onLoad** ——
 * 这个入口是纯交互方法，直接调用它才能把断言集中在它自己身上。
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

var toasts = [];
var clipboardText = '';
var clipboardFails = false;
var cloudCalls = [];

var savedWx = global.wx;
var savedGetApp = global.getApp;

function useStub() {
  toasts = [];
  clipboardText = '';
  clipboardFails = false;
  cloudCalls = [];

  global.wx = {
    showToast: function (options) { toasts.push((options && options.title) || ''); },
    getClipboardData: function (options) {
      if (clipboardFails) {
        if (options && typeof options.fail === 'function') options.fail({ errMsg: 'getClipboardData:fail 系统错误' });
        return;
      }
      if (options && typeof options.success === 'function') {
        options.success({ data: clipboardText, errMsg: 'getClipboardData:ok' });
      }
    },
    cloud: {
      callFunction: function (options) {
        cloudCalls.push(options);
        return Promise.reject({ errMsg: 'no handler' });
      },
    },
    stopPullDownRefresh: function () {},
    navigateTo: function () {},
  };
  global.getApp = function () {
    return { globalData: { semesterStart: '', periodTimes: {}, envId: 'test-env' } };
  };
}

function restoreGlobals() {
  if (savedWx === undefined) delete global.wx; else global.wx = savedWx;
  if (savedGetApp === undefined) delete global.getApp; else global.getApp = savedGetApp;
}

var me = null;
var meLoadError = null;
try {
  delete require.cache[require.resolve(path.join(ROOT, 'pages', 'me', 'me.js'))];
  global.Page = function (options) { me = options; };
  require(path.join(ROOT, 'pages', 'me', 'me.js'));
} catch (err) {
  meLoadError = err;
}

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

/** 从真样本里摘的一段"复制的文本"（与 utils/tests/timetable.test.js 同一来源） */
var CLIP_TEXT = '课表查看 2026-2027学年第一学期 打印 下载 第 7 周 学期课表 '
  + '节次/星期 星期日 星期一 星期二 星期三 星期四 星期五 星期六 '
  + '1-2节 电子工艺实训[01] 杨拓,潘飞蹊 1-18周,星期2,1-2节,致腾楼316B '
  + '大学物理A（2）[05] 顾娟 1-18周,星期4,1-2节,致理楼L1-401 '
  + '3-4节 网球俱乐部[02] 刘少卓 1-18周,星期1,3-4节,至柔馆三楼网球场';

function run() {
  block('教务导入入口 —— 页面可加载');
  isFalse(!!meLoadError, 'pages/me/me.js 加载期没有抛异常'
    + (meLoadError ? '（实际：' + meLoadError.message + '）' : ''));
  isTrue(!!me, 'Page() 注册对象拿到了');
  if (meLoadError || !me) return Promise.resolve();
  isTrue(typeof me.onImportFromTimetable === 'function', '注册了 onImportFromTimetable 这个交互方法');

  useStub();

  // -------------------------------------------------------------------------
  block('教务导入入口 —— 成功路径：解析成待导入任务，但**不写库**');
  var p = newPage();
  p.setData({ semesterStart: '2026-08-31' });     // 作者 App 里第 7 周 = 10-12~10-18 反推
  clipboardText = CLIP_TEXT;
  p.onImportFromTimetable();
  // CLIP_TEXT 里有 3 门课：电子工艺实训、大学物理A（2）、网球俱乐部
  eq(p.pendingTasks ? p.pendingTasks.length : 0, 3, '3 门课进入待导入清单');
  eq(p.data.taskCount, 3, 'taskCount 与之一致（预览区要靠它显示条数）');
  eq(p.data.parsedCount, 3, 'parsedCount = 认出的课程数');
  eq(p.data.importing, false, 'loading 收敛（不能一直转圈）');
  isTrue(p.data.importResultText.indexOf('3 门课') > -1,
    '结果行如实报数：' + show(p.data.importResultText));
  isTrue(p.data.importResultText.indexOf('作息') > -1,
    '并说明上课时刻来自用户自己的节次作息：' + show(p.data.importResultText));
  isTrue(p.data.pickedFileName.indexOf('剪贴板') > -1,
    '预览区标出来源是"剪贴板"：' + show(p.data.pickedFileName));
  eq(p.data.previewItems.length, 3, '预览列了 3 条（不超过 8 条上限）');
  eq(p.data.warnings.length, 0, '真样本零警告');
  eq(cloudCalls.length, 0, '**预览阶段一次云函数都没调**（落库要点确认按钮）');

  var first = p.pendingTasks[0];
  eq(first.repeat, 'weekly', '课程按每周重复建');
  eq(first.periods, '1-2', '节次带过去');
  eq(first.week_start, 1, '周次起 1');
  eq(first.week_end, 18, '周次止 18');
  eq(first.date, '2026-09-01', '锚点 = 第 1 周的星期二（09-01）');
  eq(first.start_time, '', '时刻留空：由作息决定，不写死');

  // -------------------------------------------------------------------------
  block('教务导入入口 —— 剪贴板为空 / 读不到：说清"先去复制"');
  var pEmpty = newPage();
  pEmpty.setData({ semesterStart: '2026-08-31' });
  clipboardText = '   ';
  toasts = [];
  pEmpty.onImportFromTimetable();
  eq(pEmpty.pendingTasks ? pEmpty.pendingTasks.length : 0, 0, '空剪贴板 → 不产生任何待导入任务');
  isTrue(pEmpty.data.importResultText.indexOf('剪贴板是空的') > -1,
    '结果行告诉他先复制：' + show(pEmpty.data.importResultText));
  isTrue(pEmpty.data.importResultText.indexOf('Ctrl+A') > -1, '并给出具体操作（Ctrl+A / Ctrl+C）');
  eq(pEmpty.data.importing, false, 'loading 收敛');

  var pFail = newPage();
  pFail.setData({ semesterStart: '2026-08-31' });
  clipboardFails = true;
  toasts = [];
  pFail.onImportFromTimetable();
  isTrue(pFail.data.importResultText.indexOf('读剪贴板失败') > -1,
    '系统拒绝读取时如实说：' + show(pFail.data.importResultText));
  clipboardFails = false;

  // -------------------------------------------------------------------------
  block('教务导入入口 —— 认不出内容：指向「拍照识别课表」这条退路');
  var pWrong = newPage();
  pWrong.setData({ semesterStart: '2026-08-31' });
  clipboardText = '今天天气不错，随便复制了一段别的东西。';
  toasts = [];
  pWrong.onImportFromTimetable();
  eq(pWrong.data.taskCount, 0, '认不出 → 0 条可导入');
  isTrue(pWrong.data.importResultText.indexOf('没从剪贴板里认出课表') > -1,
    '明确说"没认出"：' + show(pWrong.data.importResultText));
  isTrue(pWrong.data.importResultText.indexOf('拍照识别课表') > -1,
    '**指向截图识别这条退路**（不把用户堵死）：' + show(pWrong.data.importResultText));
  isTrue(lastToast().indexOf('截图') > -1 || lastToast().indexOf('没认出') > -1,
    'toast 也如实说：' + show(toasts));

  // -------------------------------------------------------------------------
  block('教务导入入口 —— 没设学期开始日期：先让他设，**不许猜日期**');
  var pNoSemester = newPage();
  clipboardText = CLIP_TEXT;
  toasts = [];
  pNoSemester.onImportFromTimetable();
  eq(pNoSemester.data.importing, false, '没设学期日期时连"解析中"都不该进');
  eq(pNoSemester.pendingTasks ? pNoSemester.pendingTasks.length : 0, 0, '不产生待导入任务');
  isTrue(pNoSemester.data.importResultText.indexOf('学期开始日期') > -1,
    '直接要求先设置：' + show(pNoSemester.data.importResultText));
  isTrue(lastToast().indexOf('学期开始日期') > -1, 'toast 同样指路：' + show(toasts));
  eq(cloudCalls.length, 0, '没有偷偷去云端做任何事');

  // -------------------------------------------------------------------------
  block('教务导入入口 —— WXML 静态自检：入口真的在页面上，且承诺写清楚了');
  var wxml = fs.readFileSync(path.join(ROOT, 'pages', 'me', 'me.wxml'), 'utf8');
  isTrue(wxml.indexOf('bindtap="onImportFromTimetable"') > -1, '按钮绑定接对了方法');
  isTrue(wxml.indexOf('从教务系统导入') > -1, '函数区标题在页面上');
  isTrue(wxml.indexOf('Ctrl+A') > -1, '写明了复制步骤');
  isTrue(wxml.indexOf('学号密码不会被读取') > -1,
    '**写明凭据不会被读取**（这是这条路线的核心卖点，必须让用户看见）');
  isTrue(wxml.indexOf('拍照识别课表') > -1, '写明认不出时的退路');

  restoreGlobals();
  return Promise.resolve();
}

var done = Promise.resolve()
  .then(run)
  .then(function () {
    restoreGlobals();
    if (require.main === module) H.report('我的页 —— 从教务系统导入课表（入口）');
  })
  .catch(function (err) {
    restoreGlobals();
    console.error('教务导入入口测试自己崩了：', err && err.stack ? err.stack : err);
    process.exit(2);
  });

module.exports = { done: done };
