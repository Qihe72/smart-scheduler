/**
 * utils/tests/timetable.test.js —— 从教务系统导入课表（utils/timetable.js）。
 *
 * 跑法：
 *     node utils/tests/timetable.test.js   # 只跑这一份（末尾打印通过数，失败退出码 1）
 *     node utils/tests/run.js              # 跑全部（注册那一行在 run.js 的串行链里）
 *
 * ===========================================================================
 * 【这一份钉住什么】样本是**真的**：2026-10-15 作者从深大 ehall「我的课程表」
 * 另存下来的网页（`我的课程表.html`）里截出来的结构，一字未改（见 SAMPLE_HTML）。
 * ===========================================================================
 * 真样本里有三个"看起来像细节、实际会错一整天/多一门课"的坑，这一份逐个钉住：
 *   1. **列的顺序**：ehall 的表头是「星期日、星期一 … 星期六」，本项目周视图是
 *      「周一 … 周日」。**按下标硬套会整张表错位一天** → 断言星期日那列的课
 *      解析出来的 weekday 是 7（不是 1）。
 *   2. **行是粗粒度的**：行标签只有 `1-2节 / 3-4节 / 5-5节 / …`，而课程的精确跨度在
 *      明细行里（`3-5节`）。所以一门 3-5 节的课会同时出现在"3-4节"行与"5-5节"行 →
 *      解析必须以明细行为准，并且**合并成一条**（否则课表里出现重复卡片）。
 *   3. **明细行是自足的**：`6-16周(双),星期2,7-9节,致原楼101` 一句话里周次、单双周、
 *      星期、节次、地点全有 —— 所以"复制的纯文本"（没有 HTML）也必须能解析。
 *
 * 【为什么单测里放切片、另跑全量】真文件 51 KB 且含大量无关标记，塞进单测不好读也不好改；
 * 而"规则对不对"的最终依据是**全量真数据**，所以另有一支探针
 * `preview/probe_timetable.js` 直接跑那份文件（2026-10-15 实测：17 门课、0 警告，
 * 且与页面可见文本独立数出来的 17 门一致）。
 *
 * 【不做的事】不联网；不 require wx 相关模块（本模块是纯函数）。
 */

'use strict';

var path = require('path');
var H = require(path.join(__dirname, 'harness.js'));
var T = require(path.join(__dirname, '..', 'timetable.js'));

var eq = H.eq;
var isTrue = H.isTrue;
var isFalse = H.isFalse;
var block = H.block;
var show = H.show;

// ---------------------------------------------------------------------------
// 真样本切片（结构与作者那份 我的课程表.html 完全一致，只去掉无关行）
//   注意：第一列是 **星期日**（data-week="7"）——这正是最容易错位的地方。
// ---------------------------------------------------------------------------
var SAMPLE_HTML = [
  '<table class="mtt_table">',
  '<tr>',
  '<td class="mtt_bgcolor_grey">节次/星期</td>',
  '<td class="mtt_bgcolor_grey" style="width:13%" data-week="7">星期日</td>',
  '<td class="mtt_bgcolor_grey" style="width:13%" data-week="1">星期一</td>',
  '<td class="mtt_bgcolor_grey" style="width:13%" data-week="2">星期二</td>',
  '<td class="mtt_bgcolor_grey" style="width:13%" data-week="3">星期三</td>',
  '<td class="mtt_bgcolor_grey" style="width:13%" data-week="4">星期四</td>',
  '<td class="mtt_bgcolor_grey" style="width:13%" data-week="5">星期五</td>',
  '<td class="mtt_bgcolor_grey" style="width:13%" data-week="6">星期六</td>',
  '</tr>',
  '<tr>',
  '<td>1-2节</td>',
  '<td></td>',
  '<td></td>',
  '<td data-role="item" data-week="2" data-begin-unit="1" data-end-unit="2">',
  '<div class="mtt_arrange_item " style="background-color:#D9F2D9;">',
  '<div class="mtt_item_tzkcicon"> </div>',
  '<div class="mtt_item_kcmc">电子工艺实训[01]</div>',
  '<div class="mtt_item_jxbmc">杨拓,潘飞蹊</div>',
  '<div class="mtt_item_room">1-18周,星期2,1-2节,致腾楼316B</div>',
  '</div></td>',
  '<td data-role="item" data-week="4" data-begin-unit="1" data-end-unit="2">',
  '<div class="mtt_arrange_item " style="background-color:#DBEEFD;">',
  '<div class="mtt_item_tzkcicon"> </div>',
  '<div class="mtt_item_kcmc">大学物理A（2）[05]</div>',
  '<div class="mtt_item_jxbmc">顾娟</div>',
  '<div class="mtt_item_room">1-18周,星期4,1-2节,致理楼L1-401</div>',
  '</div></td>',
  '<td></td><td></td>',
  '</tr>',
  '<tr>',
  '<td>3-4节</td>',
  '<td></td>',
  '<td data-role="item" data-week="1" data-begin-unit="3" data-end-unit="4">',
  '<div class="mtt_arrange_item " style="background-color:#DBEEFD;">',
  '<div class="mtt_item_kcmc">网球俱乐部[02]</div>',
  '<div class="mtt_item_jxbmc">刘少卓</div>',
  '<div class="mtt_item_room">1-18周,星期1,3-4节,至柔馆三楼网球场</div>',
  '</div></td>',
  '<td></td>',
  '<td data-role="item" data-week="3" data-begin-unit="3" data-end-unit="4">',
  '<div class="mtt_arrange_item " style="background-color:#DBEEFD;">',
  '<div class="mtt_item_kcmc">大学物理实验（2）[05]</div>',
  '<div class="mtt_item_jxbmc">张文静</div>',
  '<div class="mtt_item_room">3-14周,星期3,3-5节,无</div>',
  '</div></td>',
  '<td data-role="item" data-week="5" data-begin-unit="3" data-end-unit="4">',
  '<div class="mtt_arrange_item " style="background-color:#DBEEFD;">',
  '<div class="mtt_item_kcmc">应用光学[06]</div>',
  '<div class="mtt_item_jxbmc">王金章</div>',
  '<div class="mtt_item_room">1-18周,星期5,3-5节,致理楼L3-313</div>',
  '</div></td>',
  '<td></td><td></td>',
  '</tr>',
  '<tr>',
  '<td>5-5节</td>',
  '<td></td><td></td><td></td>',
  '<td data-role="item" data-week="3" data-begin-unit="5" data-end-unit="5">',
  '<div class="mtt_arrange_item " style="background-color:#DBEEFD;">',
  '<div class="mtt_item_kcmc">大学物理实验（2）[05]</div>',
  '<div class="mtt_item_jxbmc">张文静</div>',
  '<div class="mtt_item_room">3-14周,星期3,3-5节,无</div>',
  '</div></td>',
  '<td data-role="item" data-week="5" data-begin-unit="5" data-end-unit="5">',
  '<div class="mtt_arrange_item " style="background-color:#DBEEFD;">',
  '<div class="mtt_item_kcmc">应用光学[06]</div>',
  '<div class="mtt_item_jxbmc">王金章</div>',
  '<div class="mtt_item_room">1-18周,星期5,3-5节,致理楼L3-313</div>',
  '</div></td>',
  '<td></td><td></td>',
  '</tr>',
  '<tr>',
  '<td>7-8节</td>',
  '<td></td>',
  '<td data-role="item" data-week="2" data-begin-unit="7" data-end-unit="8">',
  '<div class="mtt_arrange_item " style="background-color:#FDEEE5;">',
  '<div class="mtt_item_kcmc">应用光学实验[02]</div>',
  '<div class="mtt_item_jxbmc">高成</div>',
  '<div class="mtt_item_room">6-16周(双),星期2,7-9节,致原楼101</div>',
  '</div></td>',
  '<td data-role="item" data-week="7" data-begin-unit="7" data-end-unit="8">',
  '<div class="mtt_arrange_item " style="background-color:#DBEEFD;">',
  '<div class="mtt_item_kcmc">周日晚自习[01]</div>',
  '<div class="mtt_item_jxbmc">李老师</div>',
  '<div class="mtt_item_room">1-18周,星期7,7-8节,致理楼L1-101</div>',
  '</div></td>',
  '<td></td><td></td><td></td><td></td>',
  '</tr>',
  '</table>',
].join('\n');

/** 真样本里"复制出来的文本"是什么形态（空白被折叠；明细行本身是自足的） */
var SAMPLE_TEXT = [
  '课表查看 2026-2027学年第一学期 打印 下载 第 7 周 学期课表 周课表',
  '节次/星期 星期日 星期一 星期二 星期三 星期四 星期五 星期六',
  '1-2节 电子工艺实训[01] 杨拓,潘飞蹊 1-18周,星期2,1-2节,致腾楼316B '
    + '大学物理A（2）[05] 顾娟 1-18周,星期4,1-2节,致理楼L1-401',
  '3-4节 网球俱乐部[02] 刘少卓 1-18周,星期1,3-4节,至柔馆三楼网球场 '
    + '大学物理实验（2）[05] 张文静 3-14周,星期3,3-5节,无 应用光学[06] 王金章 1-18周,星期5,3-5节,致理楼L3-313',
].join(' ');

function run() {
  // -------------------------------------------------------------------------
  block('教务导入 —— 解析保存的网页（真样本切片）');
  var parsed = T.parseTimetable(SAMPLE_HTML);
  eq(parsed.format, 'ehall-html', '识别成"保存的网页"格式');
  eq(parsed.weekNo, null, '这份切片里没有"第 N 周"，weekNo 为 null（不瞎猜）');
  eq(parsed.warnings.join(' | '), '', '真样本切片解析**零警告**：' + show(parsed.warnings));
  eq(parsed.courses.length, 7,
    '7 门课（大学物理实验与应用光学各跨两行 → 合并成 1 条，所以不是 9 条）');

  var byTitle = {};
  parsed.courses.forEach(function (c) { byTitle[c.title] = c; });

  // ---- 坑 1：星期日那一列绝不能错位 ----
  eq(byTitle['周日晚自习'].weekday, 7, '**星期日那列的课 → weekday 7**（不是 1，按下标套就错一天）');
  eq(byTitle['网球俱乐部'].weekday, 1, '星期一那列 → weekday 1');
  eq(byTitle['电子工艺实训'].weekday, 2, '星期二那列 → weekday 2');
  eq(byTitle['大学物理A（2）'].weekday, 4, '星期四那列 → weekday 4');

  // ---- 坑 2：行是粗粒度的，节次以明细行为准 ----
  eq(byTitle['应用光学'].periods, '3-5', '**应用光学在"3-4节"行里，但它是 3-5 节**（按明细行）');
  eq(byTitle['应用光学'].occurrences, 2, '它在 3-4节 与 5-5节 两行都出现（真样本就是这样）');
  eq(byTitle['大学物理实验（2）'].periods, '3-5', '大学物理实验（2）同样是 3-5 节');
  eq(parsed.courses.filter(function (c) { return c.title === '应用光学'; }).length, 1,
    '**跨两行的同一门课只留一条**（不合并的话课表里会出现重复卡片）');

  // ---- 周次 / 单双周 / 地点 ----
  eq(byTitle['应用光学'].weekStart, 1, '周次起 1');
  eq(byTitle['应用光学'].weekEnd, 18, '周次止 18');
  eq(byTitle['应用光学'].parity, 'all', '没写单双周 → all');
  eq(byTitle['应用光学实验'].parity, 'even', '**「6-16周(双)」→ even（双周）**');
  eq(byTitle['应用光学实验'].periods, '7-9', '双周课 7-9 节');
  eq(byTitle['大学物理实验（2）'].weekStart, 3, '「3-14周」→ 起 3');
  eq(byTitle['大学物理实验（2）'].weekEnd, 14, '「3-14周」→ 止 14');
  eq(byTitle['大学物理实验（2）'].location, '', '**地点写「无」→ 存空串**，不把"无"当地点');
  eq(byTitle['应用光学'].location, '致理楼L3-313', '正常地点照抄');
  eq(byTitle['电子工艺实训'].teacher, '杨拓,潘飞蹊', '教师原样带出来（多个教师用逗号连着）');

  // ---- 班级号剥离（与作者现有数据、WakeUp 导出的形态一致）----
  eq(byTitle['应用光学'].title, '应用光学', '**课程名末尾的 [06] 被剥掉**');
  eq(T.cleanTitle('大学物理A（2）[05]'), '大学物理A（2）', '带全角括号的课名同样处理');
  eq(T.cleanTitle('高等数学'), '高等数学', '没有班级号的不动');
  eq(T.cleanTitle('课程[abc]'), '课程[abc]', '不是数字的方括号不动（那是课程名的一部分）');

  // -------------------------------------------------------------------------
  block('教务导入 —— 解析复制的纯文本（没有 HTML 也要能认）');
  var textParsed = T.parseTimetable(SAMPLE_TEXT);
  eq(textParsed.format, 'ehall-text', '识别成"复制的文本"格式');
  eq(textParsed.weekNo, 7, '文本里的「第 7 周」被读出来了（可用来兜底推算学期起点）');
  var textTitles = textParsed.courses.map(function (c) { return c.title; }).sort().join(',');
  isTrue(textTitles.indexOf('电子工艺实训') > -1, '文本模式也认出了电子工艺实训：' + show(textTitles));
  isTrue(textTitles.indexOf('应用光学') > -1, '以及应用光学');
  isTrue(textTitles.indexOf('网球俱乐部') > -1, '以及网球俱乐部');
  var textOptics = textParsed.courses.filter(function (c) { return c.title === '应用光学'; })[0];
  eq(textOptics.periods, '3-5', '文本模式同样给出精确节次 3-5');
  eq(textOptics.weekday, 5, '文本模式同样给出星期 5');
  eq(textOptics.location, '致理楼L3-313', '文本模式同样给出地点');

  // -------------------------------------------------------------------------
  block('教务导入 —— 认不出就说清楚，绝不静默变成空课表');
  var empty = T.parseTimetable('');
  eq(empty.format, 'unknown', '空输入 → unknown');
  isTrue(empty.warnings.join('|').indexOf('空') > -1, '并说明"内容是空的"');

  var wrong = T.parseTimetable('<html><body><h1>深圳大学</h1><p>首页</p></body></html>');
  eq(wrong.format, 'unknown', '不是课表的网页 → unknown');
  isTrue(wrong.warnings.length >= 1 && wrong.warnings.join('|').indexOf('课表') > -1,
    '**明确说"这不是课表页"**，而不是返回空数组让人以为"这学期没课"：' + show(wrong.warnings[0]));

  var noData = T.parseTimetable('<table><tr><td>暂无数据</td></tr></table>');
  eq(noData.format, 'unknown', '「暂无数据」的课表页 → 认不出（如实说）');

  // -------------------------------------------------------------------------
  block('教务导入 —— 星期交叉校验：格子与明细不一致时要报出来');
  var mismatched = SAMPLE_HTML.replace('data-week="7" data-begin-unit="7" data-end-unit="8"',
    'data-week="1" data-begin-unit="7" data-end-unit="8"');
  var mismatchedParsed = T.parseTimetable(mismatched);
  var mismatchWarn = mismatchedParsed.warnings.join(' | ');
  isTrue(mismatchWarn.indexOf('周日晚自习') > -1 && mismatchWarn.indexOf('星期') > -1,
    '**格子上的星期与明细行不一致 → 有警告**（那意味着列映射错了，必须让人看见）：' + show(mismatchWarn));
  var mismatchCourse = mismatchedParsed.courses.filter(function (c) { return c.title === '周日晚自习'; })[0];
  eq(mismatchCourse.weekday, 7, '冲突时以**明细行**为准（它是服务端给的）');

  // -------------------------------------------------------------------------
  block('教务导入 —— 变成任务：weekly + 节次 + 周次，锚点日期按学期起点算');
  var SEMESTER = '2026-08-31';                 // 周一（作者 App 里第 7 周 = 10-12~10-18 反推）
  var built = T.toTasks(parsed, { semesterStart: SEMESTER });
  eq(built.warnings.length, 0, '切片样本生成任务零警告');
  eq(built.tasks.length, 7, '7 门课 → 7 条任务');
  var taskByTitle = {};
  built.tasks.forEach(function (t) { taskByTitle[t.title] = t; });

  eq(taskByTitle['网球俱乐部'].repeat, 'weekly', '课程 → repeat weekly（"课表类任务"的判据之一）');
  eq(taskByTitle['网球俱乐部'].periods, '3-4', '节次带过去');
  eq(taskByTitle['网球俱乐部'].date, '2026-08-31', '**星期一的课锚定在第 1 周的周一**');
  eq(taskByTitle['电子工艺实训'].date, '2026-09-01', '星期二的课锚定在 09-01');
  eq(taskByTitle['周日晚自习'].date, '2026-09-06', '**星期日的课锚定在 09-06**（第 1 周的周日）');
  eq(taskByTitle['应用光学实验'].week_parity, 'even', '双周课带 even');
  eq(taskByTitle['应用光学实验'].week_start, 6, '双周课 6-16 周');
  eq(taskByTitle['应用光学实验'].week_end, 16, '同上');
  eq(taskByTitle['大学物理实验（2）'].location, '', '地点空着就空着');
  eq(taskByTitle['应用光学'].start_time, '', '**时刻留空**：课程时间由用户自己的节次作息决定');
  eq(taskByTitle['应用光学'].end_time, '', '同上');
  eq(taskByTitle['应用光学'].type, 'event', '类型是日程');
  eq(taskByTitle['应用光学'].done, false, '未完成');
  eq(taskByTitle['应用光学'].parent_id, null, '没有父任务');
  eq(Object.keys(taskByTitle['应用光学']).length, 15, '字段与云函数的白名单一一对应（不多传）');

  // 没有学期起点 → 明确警告且不生成（不猜一个日期）
  var noSemester = T.toTasks(parsed, {});
  eq(noSemester.tasks.length, 0, '**没给学期开始日期 → 一条都不生成**');
  isTrue(noSemester.warnings.join('|').indexOf('学期开始日期') > -1,
    '并说明原因：' + show(noSemester.warnings[0]));

  // 没有节次的课 → 跳过并说明
  var noPeriods = T.toTasks({ courses: [{ title: '没节次的课', weekday: 3, periods: '', weekStart: 1, weekEnd: 18, parity: 'all' }] },
    { semesterStart: SEMESTER });
  eq(noPeriods.tasks.length, 0, '没节次 → 不生成（落不进课表）');
  isTrue(noPeriods.warnings.join('|').indexOf('没写节次') > -1, '并说明原因');

  // addDays 的边界（跨月、跨年、以及**不许 Date 静默进位**）
  eq(T.addDays('2026-08-31', 6), '2026-09-06', '跨月');
  eq(T.addDays('2026-12-30', 3), '2027-01-02', '跨年');
  eq(T.addDays('2026-13-01', 1), '', '13 月 → 空串（**不许静默进位成下一年**）');
  eq(T.addDays('2026-02-30', 1), '', '2026-02-30 不存在 → 空串（与云函数 dueInstantOf 同一条口径）');
  eq(T.addDays('2026-2-3', 1), '', '没补零的日期 → 空串（只认 YYYY-MM-DD）');
  eq(T.addDays('2024-02-28', 1), '2024-02-29', '闰年 2 月 29 日是真的（不许挡错）');

  return Promise.resolve();
}

var done = Promise.resolve()
  .then(run)
  .then(function () {
    if (require.main === module) H.report('教务系统课表导入（ehall）');
  })
  .catch(function (err) {
    console.error('教务导入测试自己崩了：', err && err.stack ? err.stack : err);
    process.exit(2);
  });

module.exports = { done: done };
