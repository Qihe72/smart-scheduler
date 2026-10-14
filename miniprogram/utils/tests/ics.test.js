/**
 * utils/tests/ics.test.js —— utils/ics.js（.ics 课表导入）单测
 * ===========================================================================
 * 跑法：`node utils/tests/ics.test.js`（纯 node，不联网、不写文件、不启子进程）
 * 约定：只 require 被测模块与 ./harness.js；被 run.js require 时**不**重复打印汇总。
 *
 * 【判据】Python 版 importer.py 是唯一真源，所以每条断言后面都写了它依据的 Python 位置：
 *   importer.py:379 _unfold_ics_lines   importer.py:390 _unescape_ics
 *   importer.py:400 _split_ics_line     importer.py:417 _parse_ics_dt
 *   importer.py:450 _parse_rrule        importer.py:461 _expand_occurrences
 *   importer.py:502 _ics_events         importer.py:577-683 parse_ics（1~3 步）
 *   importer.py:686 _calibrate_periods  importer.py:114 _round_to_5
 *   config.py:394/569/689/694/715       exporter.py:127/178（单双周的另一半）
 * 这些期望值不是手算的：是先跑 Python 的 importer.parse_ics() 拿到结果，再抄进来的
 * （同一份文本同时喂给两边逐字段对比，见交付说明里的差分验证）。
 */
'use strict';

var H = require('./harness.js');
var ics = require('../ics.js');

var CRLF = '\r\n';

// ---------------------------------------------------------------------------
// 造 ICS 文本的小工具
// ---------------------------------------------------------------------------
function icsText(lines) {
  return lines.join(CRLF) + CRLF;
}

/** 包一层 VCALENDAR（BEGIN:VCALENDAR / END:VCALENDAR，importer.py:531-548） */
function cal() {
  var out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//CN'];
  for (var i = 0; i < arguments.length; i += 1) {
    out = out.concat(arguments[i]);
  }
  out.push('END:VCALENDAR');
  return icsText(out);
}

var uidSeq = 0;
/** 造一个 VEVENT；start/end 直接写整行（要测 TZID/VALUE=DATE 这些参数） */
function vevent(opts) {
  var o = opts || {};
  uidSeq += 1;
  var out = ['BEGIN:VEVENT', 'UID:u' + uidSeq + '@test', 'DTSTAMP:20260101T000000Z'];
  if (o.summary !== undefined) out.push('SUMMARY:' + o.summary);
  if (o.start) out.push(o.start);
  if (o.end) out.push(o.end);
  if (o.rrule) out.push('RRULE:' + o.rrule);
  if (o.location) out.push('LOCATION:' + o.location);
  if (o.description !== undefined) out.push('DESCRIPTION:' + o.description);
  if (o.extra) out = out.concat(o.extra);
  out.push('END:VEVENT');
  return out;
}

function byTitle(list, title) {
  for (var i = 0; i < list.length; i += 1) {
    if (list[i].title === title) return list[i];
  }
  return null;
}

function titlesOf(list) {
  return list.map(function (item) { return item.title; });
}

function datesOf(list) {
  return list.map(function (item) { return item.date; });
}

/** UTF-8 字节数（exporter.py:55 fold_line 是按字节折行的；测试里不能用 Buffer） */
function utf8Len(text) {
  var size = 0;
  for (var i = 0; i < text.length; i += 1) {
    var code = text.charCodeAt(i);
    if (code < 0x80) size += 1;
    else if (code < 0x800) size += 2;
    else size += 3; // 汉字/⏰ 之类都在 BMP 里，测试够用
  }
  return size;
}

// ---------------------------------------------------------------------------
// 固定样本：**项目自己的 exporter.py 原样产出的 .ics**
//
// 由 tests/test_exporter.py 的 SAMPLES 经 exporter.tasks_to_ics(SAMPLES,
// semester_start="2026-09-07") 生成（990 字符、5 个 VEVENT、CRLF、行尾无折行），
// 只把 5 行 DTSTAMP 换成固定值（DTSTAMP 与事件时间无关，导入器也不看它）。
// 要重新生成：import exporter; exporter.tasks_to_ics(SAMPLES, semester_start="2026-09-07")
// ---------------------------------------------------------------------------
var EXPORTER_ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//smart-scheduler//\u667a\u80fd\u65e5\u7a0b\u7ba1\u5bb6//CN\r\nCALSCALE:GREGORIAN\r\nX-WR-CALNAME:\u667a\u80fd\u65e5\u7a0b\u7ba1\u5bb6\r\nBEGIN:VEVENT\r\nUID:1@smart-scheduler\r\nDTSTAMP:20260101T000000Z\r\nSUMMARY:\u9ad8\u7b49\u6570\u5b66\r\nDTSTART:20260907T083000\r\nDTEND:20260907T095500\r\nRRULE:FREQ=WEEKLY;COUNT=16\r\nLOCATION:\u81f4\u7406\u697cL1-401\r\nDESCRIPTION:\u7b2c1 - 2\u8282\\n\u81f4\u7406\u697cL1-401\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:2@smart-scheduler\r\nDTSTAMP:20260101T000000Z\r\nSUMMARY:\u53cc\u5468\u5b9e\u9a8c\r\nDTSTART:20260907T141500\r\nDTEND:20260907T164000\r\nRRULE:FREQ=WEEKLY;COUNT=8;INTERVAL=2\r\nLOCATION:\u81f4\u539f\u697c101\r\nDESCRIPTION:\u7b2c7 - 9\u8282\\n\u81f4\u539f\u697c101\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:3@smart-scheduler\r\nDTSTAMP:20260101T000000Z\r\nSUMMARY:\u23f0 \u622a\u6b62\uff1a\u4ea4\u5b9e\u9a8c\u62a5\u544a\r\nDTSTART:20260928T232900\r\nDTEND:20260928T235900\r\nDESCRIPTION:\u622a\u6b62\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:4@smart-scheduler\r\nDTSTAMP:20260101T000000Z\r\nSUMMARY:\u5199\u5468\u62a5\\, \u542b\\;\u5206\u53f7\r\nDTSTART:20260908T190000\r\nDTEND:20260908T200000\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:5@smart-scheduler\r\nDTSTAMP:20260101T000000Z\r\nSUMMARY:\u6574\u7406\u7b14\u8bb0\uff08\u6ca1\u5b9a\u65f6\u95f4\uff09\r\nDTSTART;VALUE=DATE:20260909\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

// ===========================================================================
H.block('一、折行还原（importer.py:379 _unfold_ics_lines；折行规则见 exporter.py:55）');

(function () {
  // 续行以空格或 Tab 开头 → 拼回上一行；第一行就是续行时按新行处理（Python 的 `and lines`）
  H.eqJson(
    ics.unfoldIcsLines(['A:1', ' 续', '\t续2', 'B:2'].join('\n')),
    ['A:1续续2', 'B:2'],
    'unfoldIcsLines：空格/Tab 续行都拼回上一行'
  );
  H.eqJson(ics.unfoldIcsLines(' X:1'.split('\n')), [' X:1'], '第一行以空格开头时不当续行（Python: and lines）');
  H.eqJson(ics.unfoldIcsLines('A:1\r\nB:2\rC:3'), ['A:1', 'B:2', 'C:3'], 'CRLF / CR 都当换行');

  // 端到端：按 exporter.fold_line 的规则真的折一次，再让解析器还原
  var title = '移动应用开发与微信小程序实践课程名称超长测试（计算机科学与技术二班）';
  var line = 'SUMMARY:' + title;
  H.isTrue(utf8Len(line) > 75, '样本行确实超过 75 字节（不然测不到折行）');

  var folded = [];
  var current = '';
  var size = 0;
  for (var i = 0; i < line.length; i += 1) {
    var char = line.charAt(i);
    var charSize = utf8Len(char);
    if (size + charSize > 75 && current) {
      folded.push(current);
      current = ' ' + char;          // 续行首个空格不计入内容（exporter.py:73）
      size = 1 + charSize;
    } else {
      current += char;
      size += charSize;
    }
  }
  folded.push(current);

  var text = cal(vevent({
    start: 'DTSTART:20260907T080000',
    end: 'DTEND:20260907T084500',
    extra: folded,
  }));
  var parsed = ics.parseIcs(text);
  H.eq(parsed.events.length, 1, '折行的 VEVENT 仍解析出 1 个事件');
  H.eq(parsed.events[0].title, title, '折行还原后标题完整（一个字不多一个字不少）');
  H.eq(ics.toTasks(parsed.events).length, 1, '折行还原后照样能出任务');

  // DESCRIPTION 用 Tab 续行（Python 的 raw[:1] in (" ", "\t")）
  var tabText = cal(vevent({
    summary: 'Tab续行',
    start: 'DTSTART:20260907T080000',
    description: '第一段',
    extra: ['\t第二段'],
  }));
  H.eq(ics.parseIcs(tabText).events[0].description, '第一段第二段', 'Tab 续行也拼回去');
})();

// ===========================================================================
H.block('二、转义还原（importer.py:390 _unescape_ics，顺序照抄 Python）');

(function () {
  H.eq(ics.unescapeIcs('第1 - 2节\\n致理楼'), '第1 - 2节\n致理楼', '\\n → 真换行');
  H.eq(ics.unescapeIcs('\\N大写'), '\n大写', '\\N 也认（Python 第二个 replace）');
  H.eq(ics.unescapeIcs('A\\,B'), 'A,B', '\\, → 逗号');
  H.eq(ics.unescapeIcs('A\\;B'), 'A;B', '\\; → 分号');
  H.eq(ics.unescapeIcs('C:\\\\tmp'), 'C:\\tmp', '\\\\ → 一个反斜杠');

  // 顺序：Python 先换 \\n 再还原 \\\\，所以「\\n」（转义反斜杠 + n）会变成「反斜杠 + 换行」
  H.eq(ics.unescapeIcs('x\\\\ny'), 'x\\\ny', '顺序照抄：\\\\n 先当换行，再剩一个反斜杠');

  var text = cal(vevent({
    summary: '写周报\\, 含\\;分号',
    start: 'DTSTART:20260908T190000',
    end: 'DTEND:20260908T200000',
    location: 'A\\,B\\;C',
    description: '第一行\\n第二行\\\\反斜杠\\,逗号',
  }));
  var event = ics.parseIcs(text).events[0];
  H.eq(event.title, '写周报, 含;分号', 'SUMMARY 里的 \\, \\; 还原（test_exporter.py:80 同一场景）');
  H.eq(event.location, 'A,B;C', 'LOCATION 里的 \\, \\; 还原');
  H.eq(event.description, '第一行\n第二行\\反斜杠,逗号', 'DESCRIPTION 里 \\n \\\\ \\, 一起还原');
})();

// ===========================================================================
H.block('三、Z 结尾的 UTC → +8 小时（importer.py:417-447，兜底偏移见 importer.py:445）');

(function () {
  var midnight = ics.parseIcsDateTime('20260907T000000Z', {}, {});
  H.eq(midnight.day, '2026-09-07', 'UTC 00:00 换算后仍是 9/7');
  H.eq(ics.parseIcsDateTime('20260907T000000Z', {}, {}).minutes, 8 * 60, 'UTC 00:00 → 本地 08:00（+480 分钟）');

  // 跨天：20:00Z + 8h = 次日 04:00（Python 的 timedelta 会跨天，日期一起变）
  var rolled = ics.parseIcsDateTime('20260907T200000Z', {}, {});
  H.eq(rolled.day, '2026-09-08', 'UTC 20:00 换算后跨到次日');
  H.eq(ics.minutesToHHMM(rolled.minutes), '04:00', '跨天后时刻是 04:00');

  var text = cal(
    vevent({ summary: '跨天', start: 'DTSTART:20260907T200000Z', end: 'DTEND:20260907T210000Z' }),
    vevent({ summary: '零点', start: 'DTSTART:20260907T000000Z', end: 'DTEND:20260907T010000Z' })
  );
  var parsed = ics.parseIcs(text);
  var crossed = byTitle(parsed.events, '跨天');
  var zero = byTitle(parsed.events, '零点');
  H.eq(crossed.date, '2026-09-08', '事件日期跟着跨天');
  H.eq(crossed.startTime, '04:00', '事件开始时间 04:00');
  H.eq(crossed.endTime, '05:00', '事件结束时间 05:00');
  H.eq(zero.date, '2026-09-07', '另一个事件仍是 9/7');
  H.eq(zero.startTime, '08:00', '另一个事件 08:00');

  var tasks = ics.toTasks(parsed.events);
  H.eq(byTitle(tasks, '跨天').date, '2026-09-08', 'toTasks 也用换算后的日期');
  H.eq(byTitle(tasks, '跨天').start_time, '04:00', 'toTasks 也用换算后的时刻');
})();

// ===========================================================================
H.block('四、TZID 与「只有日期」（importer.py:417-447 / 567-573）');

(function () {
  // 本地时间：带 TZID 但不是 Z 结尾 → 原样不动（Python 只在 is_utc 时换算）
  var local = cal(vevent({
    summary: '本地时间',
    start: 'DTSTART;TZID=Asia/Shanghai:20260907T080000',
    end: 'DTEND;TZID=Asia/Shanghai:20260907T093000',
  }));
  var localEvent = ics.parseIcs(local).events[0];
  H.eq(localEvent.startTime, '08:00', 'TZID 本地时间不动（不 +8）');
  H.eq(localEvent.endTime, '09:30', 'TZID 本地时间结束也不动');
  H.eq(localEvent.tzid, 'Asia/Shanghai', 'TZID 参数被记下来');

  // VTIMEZONE 里声明的偏移优先于上海兜底（importer.py:511-522）
  var vtimezone = cal(
    ['BEGIN:VTIMEZONE', 'TZID:Asia/Shanghai', 'BEGIN:STANDARD',
      'TZOFFSETFROM:+0800', 'TZOFFSETTO:+0800', 'END:STANDARD', 'END:VTIMEZONE'],
    vevent({
      summary: '时区表',
      start: 'DTSTART;TZID=Asia/Shanghai:20260907T000000Z',
      end: 'DTEND;TZID=Asia/Shanghai:20260907T010000Z',
    })
  );
  H.eq(ics.parseIcs(vtimezone).events[0].startTime, '08:00', 'VTIMEZONE +0800 用在 Z 时间上');
  H.eqJson(ics.collectTzOffsets(ics.unfoldIcsLines(vtimezone)), { 'Asia/Shanghai': 480 }, 'TZID→偏移 480 分钟');

  // 只有日期：Python 会得到当天 00:00 的 datetime，所以 start_time 是 "00:00"（不是空串）
  var dateOnly = cal(
    vevent({ summary: '全天一件', start: 'DTSTART;VALUE=DATE:20260909' }),
    vevent({ summary: '全天两件', start: 'DTSTART;VALUE=DATE:20260910', end: 'DTEND;VALUE=DATE:20260912' })
  );
  var parsed = ics.parseIcs(dateOnly);
  var one = byTitle(parsed.events, '全天一件');
  var two = byTitle(parsed.events, '全天两件');
  H.eq(one.date, '2026-09-09', '只有日期的事件日期');
  H.eq(one.startTime, '00:00', '只有日期 → start_time "00:00"（Python 的 00:00 datetime）');
  H.eq(one.endTime, '', '没有 DTEND → end_time 空串');
  H.isTrue(one.allDay, 'allDay 标出来（本移植额外给的字段，Python 没有这个概念）');
  H.eq(two.endTime, '00:00', 'DTEND;VALUE=DATE 也解析成 00:00');
  H.eq(ics.toTasks(parsed.events).length, 2, '两个全天事件 → 2 条任务');
  H.eq(byTitle(ics.toTasks(parsed.events), '全天一件').start_time, '00:00', '全天任务的 start_time 也是 00:00');
})();

// ===========================================================================
H.block('五、RRULE：每周 / 单双周 / COUNT / UNTIL / BYDAY（importer.py:450-499、641-666）');

(function () {
  // 16 周的每周课 → **只出 1 条任务**（这是本项目任务模型的根本：一门课一条）
  var sixteenWeeks = cal(vevent({
    summary: '高等数学', start: 'DTSTART:20260907T083000', end: 'DTEND:20260907T095500',
    rrule: 'FREQ=WEEKLY;COUNT=16', description: '第1 - 2节',
  }));
  var parsed16 = ics.parseIcs(sixteenWeeks);
  var tasks16 = ics.toTasks(parsed16.events);
  H.eq(parsed16.events.length, 1, '16 周的课是 1 个事件（不是 16 个）');
  H.eq(parsed16.events[0].dates.length, 16, '展开后的真实日期有 16 个（Python 第 1 步）');
  H.eq(tasks16.length, 1, '16 周的每周课 → toTasks 只出 1 条（钉死：不许展开成 16 条）');
  H.eq(tasks16[0].repeat, 'weekly', 'repeat=weekly');
  H.eq(tasks16[0].week_start, 1, 'week_start=1');
  H.eq(tasks16[0].week_end, 16, 'week_end=16（连续 16 周 → week_parity=all）');
  H.eq(tasks16[0].week_parity, 'all', '连续周 → 每周');
  H.eq(tasks16[0].date, '2026-09-07', 'date 是**第一次课**的日期（不是最后一次）');

  // INTERVAL=2 → 单双周（这条最容易错：绝不能退化成"每周"）
  var oddText = cal(vevent({
    summary: '单周课', start: 'DTSTART:20260907T080000', end: 'DTEND:20260907T084500',
    rrule: 'FREQ=WEEKLY;COUNT=8;INTERVAL=2',
  }));
  var oddEvent = ics.parseIcs(oddText).events[0];
  var oddTasks = ics.toTasks(ics.parseIcs(oddText).events);
  H.eq(oddEvent.dates.length, 8, 'INTERVAL=2 且 COUNT=8 → 8 次课');
  H.eq(oddEvent.dates[1], '2026-09-21', '第二次课隔两周（9/7 → 9/21）');
  H.eq(oddTasks.length, 1, '单周课也是 1 条任务');
  H.eq(oddTasks[0].week_parity, 'odd', 'INTERVAL=2 且从第 1 周起 → 单周');
  H.eq(oddTasks[0].week_start, 1, '单周课 week_start=1');
  H.eq(oddTasks[0].week_end, 15, 'week_end=15（最后一次课在第 15 周，不是文件里的 COUNT 上限）');

  // 偶数周起步：另一门课把学期起点顶到第 1 周，这门课从第 2 周起 → 双周
  var evenText = cal(
    vevent({ summary: '每周课', start: 'DTSTART:20260907T080000', end: 'DTEND:20260907T084500',
      rrule: 'FREQ=WEEKLY;COUNT=4' }),
    vevent({ summary: '双周课', start: 'DTSTART:20260914T100000', end: 'DTEND:20260914T104500',
      rrule: 'FREQ=WEEKLY;COUNT=3;INTERVAL=2' })
  );
  var evenTasks = ics.toTasks(ics.parseIcs(evenText).events);
  H.eq(byTitle(evenTasks, '双周课').week_parity, 'even', '从第 2 周起步 → 双周');
  H.eq(byTitle(evenTasks, '双周课').week_start, 2, '双周课 week_start=2');
  H.eq(byTitle(evenTasks, '双周课').week_end, 6, '双周课 week_end=6（2/4/6）');

  // UNTIL 是 UTC，要先换算成本地再比（importer.py:474-477，少算一周的坑）
  function untilWeeks(until) {
    var text = cal(vevent({
      summary: '到为止', start: 'DTSTART:20260907T080000', end: 'DTEND:20260907T084500',
      rrule: 'FREQ=WEEKLY;UNTIL=' + until,
    }));
    var parsed = ics.parseIcs(text);
    return { dates: parsed.events[0].dates.length, task: ics.toTasks(parsed.events)[0] };
  }
  H.eq(untilWeeks('20260921T000000Z').dates, 3, 'UNTIL=9/21 00:00Z → 本地 9/21 08:00，含 9/21 那次 → 3 次');
  H.eq(untilWeeks('20260921T000000Z').task.week_end, 3, 'UNTIL（Z）→ week_end=3');
  H.eq(untilWeeks('20260921T160000Z').dates, 3, 'UNTIL=9/21 16:00Z → 本地 9/22 00:00 → 还是 3 次');
  H.eq(untilWeeks('20260921').dates, 2, 'UNTIL 只写日期 → 本地 9/21 00:00，不含 9/21 那次 → 2 次');
  H.eq(untilWeeks('20260921').task.week_end, 2, 'UNTIL（只有日期）→ week_end=2');

  // BYDAY 只有一个值时当星期锚点，且**只往后挪**（importer.py:483-487）
  var byday = cal(vevent({
    summary: '锚到周一', start: 'DTSTART:20260909T080000', end: 'DTEND:20260909T084500',
    rrule: 'FREQ=WEEKLY;COUNT=3;BYDAY=MO',
  }));
  var bydayEvent = ics.parseIcs(byday).events[0];
  H.eq(bydayEvent.date, '2026-09-14', '周三的 DTSTART + BYDAY=MO → 往后锚到下一个周一（9/14）');
  H.eq(bydayEvent.dates.length, 3, 'BYDAY 锚点后仍是 3 次');
  H.eq(bydayEvent.dates[0], '2026-09-14', '第一次课是 9/14');
  H.eq(bydayEvent.weekParity, 'all', '锚点后三周连续 → 每周');

  // COUNT=0：Python 一次都不产生（importer.py:495），这里另外给一条 warning
  var zero = ics.parseIcs(cal(vevent({
    summary: '零次', start: 'DTSTART:20260907T080000', end: 'DTEND:20260907T084500',
    rrule: 'FREQ=WEEKLY;COUNT=0',
  })));
  H.eq(zero.events.length, 0, 'COUNT=0 → 没有事件（展开后一个日期都没有）');
  H.eq(zero.warnings.length, 2, 'COUNT=0 给两条说明（RRULE + 事件）');

  // 没写 COUNT/UNTIL 的每周课：Python 展开到 MAX_OCCURRENCES=400（importer.py:48）
  var unbounded = ics.parseIcs(cal(vevent({
    summary: '无限每周', start: 'DTSTART:20260907T080000', end: 'DTEND:20260907T084500',
    rrule: 'FREQ=WEEKLY',
  })));
  H.eq(unbounded.events[0].dates.length, 400, '没有 COUNT/UNTIL → 展开上限 400 次（Python 同）');
  H.eq(ics.toTasks(unbounded.events)[0].week_end, 400, 'week_end=400（Python 不截断；云函数入库时会截到 30）');
  H.isTrue(unbounded.warnings.length >= 1, '周次超过 30 周要给用户说明');
})();

// ===========================================================================
H.block('六、多个 VEVENT / 大小写 / CRLF / 归并回一门课（importer.py:502-548、596-674）');

(function () {
  var three = cal(
    vevent({ summary: '甲', start: 'DTSTART:20260907T080000', end: 'DTEND:20260907T084500' }),
    vevent({ summary: '乙', start: 'DTSTART:20260908T100000', end: 'DTEND:20260908T104500' }),
    vevent({ summary: '丙', start: 'DTSTART:20260909T140000', end: 'DTEND:20260909T144500' })
  );
  var parsedThree = ics.parseIcs(three);
  H.eq(parsedThree.events.length, 3, '3 个 VEVENT → 3 个事件');
  H.eqJson(titlesOf(ics.toTasks(parsedThree.events)), ['甲', '乙', '丙'], '3 条任务，顺序与文件一致');
  H.eqJson(datesOf(ics.toTasks(parsedThree.events)), ['2026-09-07', '2026-09-08', '2026-09-09'], '日期各自对');

  // CRLF 与 LF 结果必须完全一样（RFC5545 要求 CRLF，但很多工具写 LF）
  var lf = three.replace(/\r\n/g, '\n');
  H.eqJson(ics.toTasks(ics.parseIcs(lf).events), ics.toTasks(parsedThree.events), 'LF 行尾与 CRLF 结果相同');

  // 属性名/参数名大小写不敏感（importer.py:407 name.upper()），BEGIN 的值也不敏感
  var lower = icsText(['begin:vcalendar', 'begin:vevent', 'summary:小写',
    'dtstart:20260907T080000', 'dtend:20260907T084500', 'rrule:freq=weekly;count=2',
    'end:vevent', 'end:vcalendar']);
  var parsedLower = ics.parseIcs(lower);
  H.eq(parsedLower.events.length, 1, '小写属性名照样认');
  H.eq(parsedLower.events[0].title, '小写', 'SUMMARY 的值保持原样（不 upper）');
  H.eq(ics.toTasks(parsedLower.events)[0].repeat, 'weekly', '小写 rrule 也认（键 upper，值 upper 后比较）');

  // 「双周课被拆成 8 条各自只覆盖一次的 VEVENT」—— Python 文档点名的坑（importer.py:26-28）
  // 8 个周一：9/7、9/21、10/5、10/19、11/2、11/16、11/30、12/14（每隔一周）
  var splitDays = ['20260907', '20260921', '20261005', '20261019',
    '20261102', '20261116', '20261130', '20261214'];
  var split = cal.apply(null, splitDays.map(function (day) {
    return vevent({
      summary: '离散数学',
      start: 'DTSTART:' + day + 'T101500',
      end: 'DTEND:' + day + 'T114000',
      location: '致理楼202',
      description: '第3 - 4节\\n致理楼202',
    });
  }));
  var splitParsed = ics.parseIcs(split);
  var splitTasks = ics.toTasks(splitParsed.events);
  H.eq(splitParsed.events.length, 1, '8 条零散 VEVENT 归并成 1 个事件');
  H.eq(splitParsed.events[0].sources, 8, '1 个事件来自 8 个 VEVENT');
  H.eq(splitTasks.length, 1, '8 条零散 VEVENT → 1 条任务');
  H.eq(splitTasks[0].week_parity, 'odd', '它们全是单周 → week_parity=odd');
  H.eq(splitTasks[0].week_start, 1, 'week_start=1');
  H.eq(splitTasks[0].week_end, 15, 'week_end=15');
  H.eq(splitTasks[0].periods, '3-4', '节次从 DESCRIPTION 里抠出来');
  H.eq(splitTasks[0].location, '致理楼202', '地点保留');

  // 同一门课一周上两次（周一 + 周三）→ Python 老老实实排单次日程（importer.py:668-672）
  var twice = cal(
    vevent({ summary: '一门两上', start: 'DTSTART:20260907T080000', end: 'DTEND:20260907T084500' }),
    vevent({ summary: '一门两上', start: 'DTSTART:20260909T080000', end: 'DTEND:20260909T084500' }),
    vevent({ summary: '一门两上', start: 'DTSTART:20260914T080000', end: 'DTEND:20260914T084500' }),
    vevent({ summary: '一门两上', start: 'DTSTART:20260916T080000', end: 'DTEND:20260916T084500' })
  );
  var twiceTasks = ics.toTasks(ics.parseIcs(twice).events);
  H.eq(twiceTasks.length, 4, '两个星期几 → 4 条单次日程（Python 的兜底，不是"展开重复"）');
  H.eqJson(datesOf(twiceTasks), ['2026-09-07', '2026-09-09', '2026-09-14', '2026-09-16'], '单次日程一天一条');
  H.eq(twiceTasks[0].repeat, 'none', '单次日程 repeat=none');
  H.isTrue(ics.parseIcs(twice).notes[0].indexOf('时间不规律') !== -1, '说明里写明「时间不规律，按单次日程导入」');

  // 周次不连续且单双不一致 → 也是单次日程（Python: contiguous or same_parity 都不满足）
  var irregular = cal(
    vevent({ summary: '不规律', start: 'DTSTART:20260907T080000', end: 'DTEND:20260907T084500' }),
    vevent({ summary: '不规律', start: 'DTSTART:20260921T080000', end: 'DTEND:20260921T084500' }),
    vevent({ summary: '不规律', start: 'DTSTART:20260928T080000', end: 'DTEND:20260928T084500' })
  );
  H.eq(ics.toTasks(ics.parseIcs(irregular).events).length, 3, '第 1/3/4 周 → 3 条单次日程');

  // VALARM 里的 DESCRIPTION 不是课程描述（importer.py:531-538 的 depth 计数）
  var alarm = cal(vevent({
    summary: '有闹钟', start: 'DTSTART:20260907T080000', end: 'DTEND:20260907T084500',
    extra: ['BEGIN:VALARM', 'DESCRIPTION:第1 - 2节', 'TRIGGER:-PT10M', 'END:VALARM'],
  }));
  H.eq(ics.toTasks(ics.parseIcs(alarm).events)[0].periods, '', 'VALARM 里的节次不算（depth>0 忽略）');

  // 没有 SUMMARY → Python 的占位标题
  var unnamed = cal(vevent({ start: 'DTSTART:20260907T080000', end: 'DTEND:20260907T084500' }));
  H.eq(ics.toTasks(ics.parseIcs(unnamed).events)[0].title, '(未命名课程)', '没有 SUMMARY → (未命名课程)');
})();

// ===========================================================================
H.block('七、空输入 / 烂输入：一律走 warnings，绝不抛异常（importer.py:544、587-589、790）');

(function () {
  ['', '   \n\t\n', null, undefined].forEach(function (bad, index) {
    var parsed = ics.parseIcs(bad);
    H.eq(parsed.events.length, 0, '空输入 #' + index + ' → 0 个事件');
    H.eqJson(parsed.warnings, ['内容为空'], '空输入 #' + index + ' → warnings=["内容为空"]');
  });

  // 不是 ICS（例如 CSV）→ 一条「没有解析到任何 VEVENT」
  var csv = ics.parseIcs('课程名,日期,开始时间\n语文,周三,08:00\n');
  H.eq(csv.events.length, 0, 'CSV 文本 → 0 个事件');
  H.eqJson(csv.warnings, ['没有解析到任何 VEVENT（不是有效的 ICS 文件？）'], 'CSV 文本 → 明确说没解析到 VEVENT');

  // 截断（有 BEGIN:VEVENT 没有 END:VEVENT）→ 不崩，说清楚
  var truncated = icsText(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:截断', 'DTSTART:20260907T080000']);
  var truncatedParsed = ics.parseIcs(truncated);
  H.eq(truncatedParsed.events.length, 0, '截断的 ICS → 0 个事件');
  H.isTrue(truncatedParsed.warnings.join('|').indexOf('没有 END:VEVENT') !== -1, '截断的 ICS → 提示 END:VEVENT 缺失');

  // 坏数据夹在好数据中间：坏的跳过、后面的照常解析（容错的核心）
  var mixed = cal(
    vevent({ summary: '坏的', start: 'DTSTART:20261345T990000', end: 'DTEND:20260907T090000' }),
    vevent({ summary: '好的', start: 'DTSTART:20260907T080000', end: 'DTEND:20260907T084500' })
  );
  var mixedParsed = ics.parseIcs(mixed);
  H.eq(mixedParsed.events.length, 1, '坏 DTSTART 的事件被跳过');
  H.eq(mixedParsed.events[0].title, '好的', '后面的好事件照常解析');
  H.eq(ics.toTasks(mixedParsed.events).length, 1, '烂数据不影响出任务');
  H.isTrue(mixedParsed.warnings.join('|').indexOf('无法解析') !== -1, '坏的 DTSTART 有中文说明');

  // DTEND 坏了 → 当没有结束时间（Python: end=None）
  var badEnd = ics.parseIcs(cal(vevent({
    summary: '坏DTEND', start: 'DTSTART:20260907T080000', end: 'DTEND:2026-09-07T09:00:00',
  })));
  H.eq(badEnd.events[0].endTime, '', 'DTEND 解析不了 → endTime 空串');
  H.eq(ics.toTasks(badEnd.events)[0].end_time, '', '任务里 end_time 也是空串');
  H.isTrue(badEnd.warnings.length >= 1, 'DTEND 坏了有说明');

  // RRULE 没有 FREQ → 当单次（Python: 不是 WEEKLY 就单次）
  var noFreq = ics.parseIcs(cal(vevent({
    summary: '没FREQ', start: 'DTSTART:20260907T080000', end: 'DTEND:20260907T084500', rrule: 'COUNT=3',
  })));
  H.eq(noFreq.events[0].dates.length, 1, '没有 FREQ → 只当一次');
  H.isTrue(noFreq.warnings.join('|').indexOf('没有 FREQ') !== -1, '没有 FREQ 有说明');

  // FREQ=DAILY：**现在支持**（每天重复 / 打卡）。
  //   刻意**不展开成 N 条**：一天的数据 + repeat='daily' 就够表达"每天"，
  //   展开成 30 条任务既浪费又会出现"删一条还剩 29 条"的尴尬。
  var daily = ics.parseIcs(cal(vevent({
    summary: '每天', start: 'DTSTART:20260907T080000', end: 'DTEND:20260907T084500', rrule: 'FREQ=DAILY;COUNT=3',
  })));
  H.eq(daily.events[0].dates.length, 1, '**FREQ=DAILY 只展开出一天**（"每天"由 repeat 表达）');
  H.eq(daily.events[0].repeat, 'daily', '事件被标成 daily');
  H.isFalse(daily.warnings.join('|').indexOf('不支持') !== -1,
    '**不再报"不支持"**（它已经是支持的了）: ' + daily.warnings.join(' | '));
  var dailyTasks = ics.toTasks(daily.events, { semesterStart: '2026-09-07' });
  H.eq(dailyTasks.length, 1, 'FREQ=DAILY → **一条任务**（不是 3 条）');
  H.eq(dailyTasks[0].repeat, 'daily', "落库的 repeat = 'daily'");
  H.eq(dailyTasks[0].date, '2026-09-07', '锚点 = 第一次发生的那天');
  H.eq(dailyTasks[0].week_start, 1, '起始周 1');
  H.eq(dailyTasks[0].week_end, 20, '没给 UNTIL → 默认整学期 20 周');
  H.eq(dailyTasks[0].week_parity, 'all', '单双周一律 all（每天不参与单双周）');

  // UNTIL 给了就用它算结束周。**注意 UNTIL 是 UTC**（本文件开头就写着"否则会少算一周"）：
  //   学期起点 09-07（周一）→ 第 1 周 09-07~09-13、第 2 周 09-14~09-20、第 3 周 09-21~09-27。
  //   UNTIL=20260927T000000Z → 北京时间 09-27 08:00 → 落在第 3 周。
  var dailyUntil = ics.parseIcs(cal(vevent({
    summary: '打卡到第三周', start: 'DTSTART:20260907T080000', end: 'DTEND:20260907T084500',
    rrule: 'FREQ=DAILY;UNTIL=20260927T000000Z',
  })));
  var dailyUntilTasks = ics.toTasks(dailyUntil.events, { semesterStart: '2026-09-07' });
  H.eq(dailyUntilTasks[0].repeat, 'daily', 'UNTIL 版也是每天');
  H.eq(dailyUntilTasks[0].week_end, 3, 'UNTIL 落在第 3 周（09-21~09-27）→ 结束周 3');

  // 时区边界（与"每周"那组同一条口径）：UNTIL=20260927T160000Z 换算成北京时间是 09-28 00:00，
  // 已经跨进第 4 周 —— 少算 8 小时就会把它算成第 3 周，那正是这条断言要挡的。
  var untilCross = ics.parseIcs(cal(vevent({
    summary: '跨周边界', start: 'DTSTART:20260907T080000', end: 'DTEND:20260907T084500',
    rrule: 'FREQ=DAILY;UNTIL=20260927T160000Z',
  })));
  H.eq(ics.toTasks(untilCross.events, { semesterStart: '2026-09-07' })[0].week_end, 4,
    '**UNTIL 按 UTC→北京时间换算**（09-27 16:00Z = 09-28 00:00 北京 → 第 4 周）');

  // 仍然不支持的是别的 FREQ：如实报出来，不静默
  var monthly = ics.parseIcs(cal(vevent({
    summary: '每月', start: 'DTSTART:20260907T080000', end: 'DTEND:20260907T084500', rrule: 'FREQ=MONTHLY;COUNT=3',
  })));
  H.isTrue(monthly.warnings.join('|').indexOf('FREQ=MONTHLY') !== -1,
    'MONTHLY 仍然如实说"不支持"（只支持 WEEKLY / DAILY）');
  H.eq(ics.toTasks(monthly.events, { semesterStart: '2026-09-07' })[0].repeat, 'none',
    '不支持的 FREQ → 当单次（不瞎猜）');

  // 零长度 / 结束早于开始：Python 原样带出来，这里也照做（别自作聪明改数据）
  var zeroLen = ics.toTasks(ics.parseIcs(cal(vevent({
    summary: '零长度', start: 'DTSTART:20260907T080000', end: 'DTEND:20260907T080000',
  }))).events)[0];
  H.eq(zeroLen.end_time, '08:00', 'DTSTART==DTEND → end_time 就是 08:00（Python 的 datetime 之差为 0）');
  var reverse = ics.toTasks(ics.parseIcs(cal(vevent({
    summary: '倒着', start: 'DTSTART:20260907T090000', end: 'DTEND:20260907T080000',
  }))).events)[0];
  H.eq(reverse.start_time, '09:00', '结束早于开始时开始时间照常');
  H.eq(reverse.end_time, '08:00', '结束早于开始时结束时间照原样');

  // toTasks 的容错：不是数组 / 元素不是对象 / 没有日期 —— 都不许抛
  H.eqJson(ics.toTasks(undefined), [], 'toTasks(undefined) → []');
  H.eqJson(ics.toTasks(null), [], 'toTasks(null) → []');
  H.eqJson(ics.toTasks([]), [], 'toTasks([]) → []');
  H.eqJson(ics.toTasks('不是数组'), [], 'toTasks(字符串) → []');
  var messy = [];
  try {
    messy = ics.toTasks([null, 5, 'x', {}, { title: '没日期' }]);
  } catch (err) {
    H.record(false, 'toTasks 遇到烂元素不抛异常', String(err && err.message));
  }
  H.eqJson(messy, [], 'toTasks 过滤掉烂元素，返回 []');
})();

// ===========================================================================
H.block('八、与 exporter.py 往返：导出的 .ics 读回来必须等价（tests/test_exporter.py 的 SAMPLES）');

(function () {
  H.eq(EXPORTER_ICS.length, 990, '样本就是 exporter 原样产出的那 990 个字符');
  H.isTrue(EXPORTER_ICS.indexOf('RRULE:FREQ=WEEKLY;COUNT=8;INTERVAL=2') !== -1, '样本里有 INTERVAL=2 的双周课');

  var parsed = ics.parseIcs(EXPORTER_ICS);
  var tasks = ics.toTasks(parsed.events);

  H.eq(parsed.events.length, 5, '5 个 VEVENT → 5 个事件');
  H.eq(tasks.length, 5, '5 个 VEVENT → 5 条任务（Python importer.parse_ics 也是 5 条）');
  H.eqJson(parsed.warnings, [], '往返全程没有警告');
  H.eq(parsed.semesterStart, '2026-09-07', '推断出的学期起点 = 第一周的周一');

  var math = byTitle(tasks, '高等数学');
  H.eq(math.repeat, 'weekly', '高等数学 repeat=weekly');
  H.eq(math.week_start, 1, '高等数学 week_start=1');
  H.eq(math.week_end, 16, '高等数学 week_end=16（COUNT=16，连续 → 每周）');
  H.eq(math.week_parity, 'all', '高等数学 week_parity=all');
  H.eq(math.start_time, '08:30', '高等数学 08:30 起');
  H.eq(math.end_time, '09:55', '高等数学 09:55 止');
  H.eq(math.periods, '1-2', '高等数学 节次来自 DESCRIPTION（test_exporter.py:60）');
  H.eq(math.location, '致理楼L1-401', '高等数学 地点');

  var biweekly = byTitle(tasks, '双周实验');
  H.eq(biweekly.repeat, 'weekly', '双周实验 repeat=weekly');
  H.eq(biweekly.week_parity, 'odd', 'INTERVAL=2 的课必须是单周，不能变成 all（test_exporter.py:69-73）');
  H.eq(biweekly.week_start, 1, '双周实验 week_start=1');
  H.eq(biweekly.week_end, 15, '双周实验 week_end=15（8 次课落在第 1~15 周）');
  H.eq(biweekly.periods, '7-9', '双周实验 节次 7-9');
  H.eq(biweekly.location, '致原楼101', '双周实验 地点');

  var ddl = byTitle(tasks, '⏰ 截止：交实验报告');
  H.eq(ddl.end_time, '23:59', 'DDL 的截止时刻准确（test_exporter.py:75-78）');
  H.eq(ddl.type, 'event', '已知取舍：导入只认日程，类型回到 event（exporter.py:17-18）');

  var special = byTitle(tasks, '写周报, 含;分号');
  H.eq(special.title, '写周报, 含;分号', '标题里的 , 和 ; 原样回来（test_exporter.py:80-84）');

  var allDay = byTitle(tasks, '整理笔记（没定时间）');
  H.eq(allDay.start_time, '00:00', '没定时间的条目按全天导出 → 读回来是 00:00（exporter.py:19-20）');
  H.isTrue(byTitle(parsed.events, '整理笔记（没定时间）').allDay, '全天事件被标出来');

  // 节次校准：一门课占第 a~b 节、时间 S~E → 第 a 节从 S 开始、第 b 节到 E 结束（importer.py:686-749）
  H.eqJson(parsed.periodTimes, {
    '1': ['08:30', '09:10'], '2': ['09:15', '09:55'],
    '7': ['14:15', '15:00'], '8': ['15:05', '15:50'], '9': ['15:55', '16:40'],
  }, '校准出的作息与 Python 一致（精确值覆盖近似值）');

  // 给用户看的合并说明，措辞与 Python 相同（importer.py:661-665）
  H.eqJson(parsed.notes, [
    '高等数学：合并 16 次为每周课（第 1-16 周）',
    '双周实验：合并 8 次为单周课（第 1-15 周）',
  ], '合并说明与 Python 的 notes 一致');
})();

// ===========================================================================
H.block('九、toTasks 的字段与取值范围（对齐 cloudfunctions/tasks/lib/normalize.js）');

(function () {
  var TASK_FIELDS = ['date', 'done', 'end_time', 'estimate_min', 'location', 'parent_id',
    'periods', 'priority', 'repeat', 'start_time', 'title', 'type', 'week_end',
    'week_parity', 'week_start'];
  var parsed = ics.parseIcs(EXPORTER_ICS);
  var tasks = ics.toTasks(parsed.events);

  H.eqJson(Object.keys(tasks[0]).sort(), TASK_FIELDS, '任务对象的字段与云函数白名单逐个对上（多一个少一个都不行）');

  var allowedType = ['event', 'ddl', 'subtask'];
  var allowedPriority = ['high', 'mid', 'low'];
  var allowedRepeat = ['none', 'weekly'];
  var allowedParity = ['all', 'odd', 'even'];
  var badDate = [];
  var badTime = [];
  var badType = [];
  var badPriority = [];
  var badRepeat = [];
  var badParity = [];
  var badWeeks = [];
  var badPeriods = [];
  tasks.forEach(function (task) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(task.date)) badDate.push(task.date);
    if (task.start_time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(task.start_time)) badTime.push(task.start_time);
    if (task.end_time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(task.end_time)) badTime.push(task.end_time);
    if (allowedType.indexOf(task.type) === -1) badType.push(task.type);
    if (allowedPriority.indexOf(task.priority) === -1) badPriority.push(task.priority);
    if (allowedRepeat.indexOf(task.repeat) === -1) badRepeat.push(task.repeat);
    if (allowedParity.indexOf(task.week_parity) === -1) badParity.push(task.week_parity);
    if (task.periods && !/^\d{1,2}(-\d{1,2})?$/.test(task.periods)) badPeriods.push(task.periods);
    if (task.repeat === 'weekly') {
      var startOk = typeof task.week_start === 'number' && task.week_start >= 1;
      var endOk = typeof task.week_end === 'number' && task.week_end >= task.week_start;
      if (!startOk || !endOk) badWeeks.push(task.title);
    } else if (task.week_start !== null || task.week_end !== null || task.week_parity !== 'all') {
      badWeeks.push(task.title); // 不重复的任务不带周次（normalize.js 的规范形态）
    }
  });
  H.eqJson(badDate, [], 'date 全是 YYYY-MM-DD');
  H.eqJson(badTime, [], 'start_time / end_time 全是 HH:MM 或空串');
  H.eqJson(badType, [], 'type 取值合法');
  H.eqJson(badPriority, [], 'priority 取值合法');
  H.eqJson(badRepeat, [], 'repeat 取值合法');
  H.eqJson(badParity, [], 'week_parity 取值合法');
  H.eqJson(badWeeks, [], 'weekly 带合法周次；不重复的周次为 null / parity=all');
  H.eqJson(badPeriods, [], 'periods 是 "7-9" / "7" / 空串');

  H.isTrue(tasks.every(function (t) { return t.done === false; }), 'done 全是 false（新导入的都没做完）');
  H.isTrue(tasks.every(function (t) { return t.parent_id === null; }), 'parent_id 全是 null');
  H.isTrue(tasks.every(function (t) { return t.estimate_min === 0; }), 'estimate_min 默认 0（0 = 没估，不瞎猜）');
  H.isTrue(tasks.every(function (t) { return t.title !== ''; }), 'title 都不为空（bulk_add 的必填项）');

  // 单参数调用（pages/me/me.js:350 就是这么调的）
  H.eq(ics.toTasks(parsed.events).length, 5, 'toTasks(events) 单参数可调用');
  // options 缺省值以外还能显式给（本移植的附加能力，默认行为与 Python 一致）
  var custom = ics.toTasks(parsed.events, { priority: 'high', estimate_min: 45, type: 'subtask' });
  H.eq(custom[0].priority, 'high', 'options.priority 生效');
  H.eq(custom[0].estimate_min, 45, 'options.estimate_min 生效');
  H.eq(custom[0].type, 'subtask', 'options.type 生效');

  // 手写的（没有 dates 的）事件：尊重自带的 repeat/周次
  var handmade = ics.toTasks([
    { title: '手写每周', date: '2026-09-07', startTime: '08:00', endTime: '08:45',
      repeat: 'weekly', weekStart: 1, weekEnd: 16, weekParity: 'odd' },
    { title: '手写单次', date: '2026-09-08' },
  ]);
  H.eq(handmade.length, 2, '手写事件也各出 1 条');
  H.eq(handmade[0].repeat, 'weekly', '手写的 weekly 保留');
  H.eq(handmade[0].week_end, 16, '手写的 week_end 保留');
  H.eq(handmade[0].week_parity, 'odd', '手写的单双周保留');
  H.eq(handmade[1].repeat, 'none', '手写的单次是 none');

  // 节次/时刻的容错（对齐 normalize.js 的 normalizePeriods / normalizeTime）
  var loose = ics.toTasks([{ title: '零散写法', date: '2026-09-07', startTime: '8:5', periods: [7, 9] }]);
  H.eq(loose[0].start_time, '08:05', '"8:5" 补零成 08:05');
  H.eq(loose[0].periods, '7-9', '节次数组 [7,9] → "7-9"');
})();

// ===========================================================================
H.block('十、日期/周次工具与 banker 舍入（config.py:689-732、importer.py:114-116）');

(function () {
  // config.py:663 SEMESTER_START_DEFAULT = "2026-09-07"，它必须是周一
  H.eq(ics.weekdayOf('2026-09-07'), 0, '2026-09-07 是周一（0=周一，Python weekday()）');
  H.eq(ics.mondayOf('2026-09-09'), '2026-09-07', '周三所在的周一是 9/7（config.py:689）');
  H.eq(ics.weekNumberOf('2026-10-05', '2026-09-07'), 5, '10/5 是第 5 周（config.py:694）');
  H.eq(ics.weekNumberOf('2026-08-31', '2026-09-07'), null, '开学之前的日期没有周次（返回 null）');
  H.eq(ics.mondayOfWeek(3, '2026-09-07'), '2026-09-21', '第 3 周的周一是 9/21（config.py:715）');
  H.eqArr(ics.occurrenceWeeks(1, 16, 'odd'), [1, 3, 5, 7, 9, 11, 13, 15], '单周课实际出现在 1~15 的单周（exporter.py:127）');

  // Python 的 round() 是「.5 取偶」，Math.round 是「.5 进一」——差这 5 分钟就对不上 Python
  H.eq(ics.roundHalfEven(100.5), 100, 'round(100.5)=100（取偶）');
  H.eq(ics.roundHalfEven(101.5), 102, 'round(101.5)=102（取偶）');
  H.eq(ics.roundHalfEven(2.5), 2, 'round(2.5)=2');
  H.eq(ics.roundHalfEven(3.5), 4, 'round(3.5)=4');
  H.eq(ics.roundTo5(502.5), 500, '502.5 分钟 → 500（08:20，不是 Math.round 的 505/08:25）');

  // 端到端校准：一门 08:00-08:50 的两节课，均分时长正好落在 .5 上（Python: 08:20 / 08:50）
  var tie = ics.parseIcs(cal(vevent({
    summary: '对半分', start: 'DTSTART:20260907T080000', end: 'DTEND:20260907T085000',
    description: '第1 - 2节',
  })));
  H.eqJson(tie.periodTimes, { '1': ['08:00', '08:20'], '2': ['08:25', '08:50'] }, '两节课均分：与 Python 的取偶结果一致');

  // 三连堂：首尾用精确值，中间按「等长 + 课间 5 分钟」近似（importer.py:686-749）
  var three = ics.parseIcs(cal(vevent({
    summary: '三连堂', start: 'DTSTART:20260907T161000', end: 'DTEND:20260907T175000',
    description: '第7 - 9节',
  })));
  H.eqJson(three.periodTimes, {
    '7': ['16:10', '16:40'], '8': ['16:45', '17:15'], '9': ['17:20', '17:50'],
  }, '三连堂校准：第 7 节从 16:10 起、第 9 节到 17:50 止');

  // 没有节次信息时不瞎猜（Python 的 periods 只来自 DESCRIPTION）
  H.eqJson(ics.parseIcs(cal(vevent({
    summary: '没写节次', start: 'DTSTART:20260907T080000', end: 'DTEND:20260907T084500',
  }))).periodTimes, {}, 'DESCRIPTION 没写节次 → 不校准、不瞎猜');

  // 只写了「第3节」（没有范围）也要认（config.py:569 的 parse_period_label）
  H.eqJson(ics.parsePeriodLabel('第3节'), [3, 3], '单节写法');
  H.eqJson(ics.parsePeriodLabel('第7 - 9节'), [7, 9], '范围写法（exporter 就是这么写的）');
  H.eqJson(ics.parsePeriodLabel('7-9节'), [7, 9], '不带"第"也认');
  H.eqJson(ics.parsePeriodLabel('第9 - 7节'), [7, 9], '写反了自动换回来');
  H.eq(ics.parsePeriodLabel('没有节次'), null, '认不出来返回 null');
  H.eq(ics.rowKey([7, 9]), '7-9', 'row_key（config.py:394）');
  H.eq(ics.rowKey([7]), '7', '单节的 row_key');
})();

// ---------------------------------------------------------------------------
// 汇总：只有**直接跑这个文件**时才打印并设置退出码；
// 被 run.js require 时安静通过（计数照样加进同一套 state）。
// ---------------------------------------------------------------------------
if (require.main === module) H.report('ics.js 单测（.ics 导入）');
