/**
 * utils/timetable.js —— 从教务系统（深大 ehall）导入课表。
 *
 * ===========================================================================
 * 【为什么是"复制/保存网页"，而不是"填个网址就导入"】
 * ===========================================================================
 * 作者实测过（2026-10-15）：ehall 的课表页**一跳就跳去 authserver.szu.edu.cn**
 * （学校统一身份认证）—— 没有用户浏览器里的登录态，谁都取不到它。而小程序这一侧：
 *   * `wx.request` 只认自己拥有并能上传校验文件的「request 合法域名」，`ehall.szu.edu.cn`
 *     不是我们的，加不进去；
 *   * 个人主体**不能用 `web-view`**，企业主体配「业务域名」也要能往对方域名根目录传校验文件；
 *   * 云函数虽然能出网，但它没有用户的 Cookie，取回来只会是登录页。
 * 所以可行的形态只有一个：**用户在自己浏览器里登录 → 把课表内容交给小程序**。
 * 全程不碰学号密码，也不碰任何域名白名单。
 *
 * ===========================================================================
 * 【能认两种输入，自动识别】
 * ===========================================================================
 *   ① **保存的网页**（课表页 Ctrl+S → "网页，仅 HTML"）：格子上带
 *      `data-week` / `data-begin-unit` / `data-end-unit`，以及三个 div：
 *      `.mtt_item_kcmc`（课程名）/ `.mtt_item_jxbmc`（教师）/ `.mtt_item_room`（明细）。
 *      这是**最稳**的一种（节次、星期都是机器可读的）。
 *   ② **复制的纯文本**（在课表页 Ctrl+A / Ctrl+C）：明细行本身就把话说全了 ——
 *      `6-16周(双),星期2,7-9节,致原楼101`，前面紧挨着课程名与教师。
 *      所以纯文本也能解析，不必要求用户存文件。
 *
 * ===========================================================================
 * 【两个必须守住的坑（都是真样本里看清的）】
 * ===========================================================================
 *   1. **列的顺序**：ehall 的表头是「星期日、星期一 … 星期六」，而本项目周视图是
 *      「周一 … 周日」。**按下标硬套会让整张课表错位一天**。这里一律按 `data-week`
 *      （1=周一 … 7=周日）或表头文字映射，绝不按下标。
 *   2. **同一门课会跨多个格子**：「应用光学 3-5 节」在 3-4节 行与 5-5节 行各出现一次。
 *      两次的明细字符串完全相同，所以要按「课程名 + 明细」**合并**，并把节次并成 3-5 节，
 *      否则一门课会变成两三条任务。
 *
 * 【本文件只做"文本 → 课程/任务"，不碰 wx、不碰网络】所以能直接被 node 单测覆盖。
 */
'use strict';

/** 星期几的中文名（本项目内部一律用 1=周一 … 7=周日，与 data-week 一致） */
var WEEKDAY_NAMES = {
  1: '星期一', 2: '星期二', 3: '星期三', 4: '星期四', 5: '星期五', 6: '星期六', 7: '星期日',
};

/** 表头里出现这些字样就认为那一列是星期几（兼容"周日/星期天"等写法） */
var WEEKDAY_TEXT = {
  '星期一': 1, '周一': 1, '星期一': 1,
  '星期二': 2, '周二': 2,
  '星期三': 3, '周三': 3,
  '星期四': 4, '周四': 4,
  '星期五': 5, '周五': 5,
  '星期六': 6, '周六': 6,
  '星期日': 7, '星期天': 7, '周日': 7, '周天': 7,
};

/** 明细行：`1-18周` / `6-16周(双)` / `3-14周（单）` */
var WEEK_RANGE_RE = /(\d{1,2})\s*-\s*(\d{1,2})\s*周\s*[（(]?\s*([单双])?\s*[）)]?/;

/** 明细行里的星期：`星期2`（真样本就是数字，不是"星期二"） */
var WEEKDAY_IN_DETAIL_RE = /星期\s*([1-7])/;

/** 明细行里的节次：`1-2节` / `3-5节` / `5节` */
var PERIODS_RE = /(\d{1,2})\s*(?:-\s*(\d{1,2}))?\s*节/;

/** 课程名末尾的班级号：`应用光学[06]` → 去掉 `[06]`（与作者现有数据、WakeUp 导出的形态一致） */
var CLASS_SUFFIX_RE = /[\[［]\s*\d+\s*[\]］]\s*$/;

/**
 * 把一个 HTML 片段里的标签与实体去掉，留下可读文本。
 * 【为什么不用 DOM】小程序里没有 DOM；node 单测里也不想引第三方解析库（本仓库零依赖）。
 * 这份页面结构稳定（三个固定 class 的 div），用受控的正则足够，而且**出错时能被下面的
 * 校验发现**（解析不出课程会明确报"没认出格式"，不会静默变成空课表）。
 */
function stripTags(html) {
  var text = String(html === undefined || html === null ? '' : html);
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&nbsp;?/gi, ' ');
  text = text.replace(/&amp;/gi, '&');
  text = text.replace(/&lt;/gi, '<');
  text = text.replace(/&gt;/gi, '>');
  text = text.replace(/&quot;/gi, '"');
  return text;
}

/** 折叠空白（换行保留成一个空格；解析明细行时够用） */
function squeeze(text) {
  return String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
}

/** 取某个 class 的 div 里的文本（`.mtt_item_kcmc` 之类） */
function divText(html, className) {
  var re = new RegExp('<div[^>]*class="[^"]*' + className + '[^"]*"[^>]*>([\\s\\S]*?)</div>', 'i');
  var m = String(html).match(re);
  return m ? squeeze(stripTags(m[1])) : '';
}

/** 取某个属性的值（`data-week="2"`） */
function attrOf(tag, name) {
  var re = new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i');
  var m = String(tag).match(re);
  return m ? m[1].trim() : '';
}

/**
 * 解析明细行：`6-16周(双),星期2,7-9节,致原楼101` → 结构化。
 *
 * 【为什么以明细行为准，而不是以格子属性为准】明细行是**课程自己**的说明，出现在
 * 每个格子里都一模一样；格子属性只在保存的 HTML 里有。两条路都解析出来再互相校验，
 * 不一致时以明细行为准并记一条警告（明细行是服务端给的，格子属性是渲染时算的）。
 *
 * @param {string} raw 明细原文
 * @returns {{weekStart:number, weekEnd:number, parity:string, weekday:number, periods:string, location:string}|null}
 */
function parseDetail(raw) {
  var text = squeeze(raw);
  if (!text) return null;

  var weekMatched = text.match(WEEK_RANGE_RE);
  if (!weekMatched) return null;                    // 没有周次 → 不是我们要的明细行
  var weekStart = Number(weekMatched[1]);
  var weekEnd = Number(weekMatched[2]);
  if (!(weekStart >= 1) || !(weekEnd >= weekStart)) return null;

  var parity = 'all';
  if (weekMatched[3] === '单') parity = 'odd';
  else if (weekMatched[3] === '双') parity = 'even';

  var dayMatched = text.match(WEEKDAY_IN_DETAIL_RE);
  if (!dayMatched) return null;                     // 没有星期几 → 定不了日子
  var weekday = Number(dayMatched[1]);
  if (!(weekday >= 1 && weekday <= 7)) return null;

  var periodsMatched = text.match(PERIODS_RE);
  var periods = '';
  if (periodsMatched) {
    var from = Number(periodsMatched[1]);
    var to = periodsMatched[2] === undefined ? from : Number(periodsMatched[2]);
    if (from >= 1 && to >= from) periods = from === to ? String(from) : from + '-' + to;
  }

  // 地点 = 明细行里最后一个逗号之后的内容（可能为空、也可能是"无"）
  var parts = text.split(/[,，]/);
  var tail = parts.length ? squeeze(parts[parts.length - 1]) : '';
  var location = (tail === '无' || tail === '') ? '' : tail;
  // 末段要是还带着"周/节"字样，说明这行没有地点
  if (PERIODS_RE.test(location) || /周/.test(location)) location = '';

  return {
    weekStart: weekStart,
    weekEnd: weekEnd,
    parity: parity,
    weekday: weekday,
    periods: periods,
    location: location,
  };
}

/** 课程名去掉班级号：`应用光学[06]` → `应用光学`（与作者现有数据的形态一致） */
function cleanTitle(raw) {
  var title = squeeze(raw);
  if (CLASS_SUFFIX_RE.test(title)) title = squeeze(title.replace(CLASS_SUFFIX_RE, ''));
  return title;
}

/**
 * 从**保存的网页**里解析课程。
 *
 * 依据（真样本，2026-10-15 深大 ehall「我的课程表」）：
 *   <td data-role="item" data-week="2" data-begin-unit="1" data-end-unit="2">
 *     <div class="mtt_arrange_item" style="...">
 *       <div class="mtt_item_kcmc">电子工艺实训[01]</div>
 *       <div class="mtt_item_jxbmc">杨拓,潘飞蹊</div>
 *       <div class="mtt_item_room">1-18周,星期2,1-2节,致腾楼316B</div>
 *     </div>
 *   </td>
 * 一个格子里可能有**两个** mtt_arrange_item（同一时段、不同周次的两门课各占半学期），所以逐块解析。
 *
 * @param {string} html 网页原文
 * @param {Array<string>} warnings 追加警告
 * @returns {Array<object>} 课程数组（未合并）
 */
function parseHtmlCells(html, warnings) {
  var courses = [];
  var cellRe = /<td[^>]*data-role\s*=\s*"item"[^>]*>([\s\S]*?)<\/td>/gi;
  var match;
  while ((match = cellRe.exec(html)) !== null) {
    var tag = match[0].slice(0, match[0].indexOf('>') + 1);
    var inner = match[1];
    var cellWeek = Number(attrOf(tag, 'data-week'));
    // 注意：格子上还有 data-begin-unit / data-end-unit，但那是**粗粒度行**的节次
    // （行标签只有 1-2 / 3-4 / 5-5 / …），课程的精确跨度在明细行里，所以这里不用它们。

    var itemRe = /<div[^>]*class="[^"]*mtt_arrange_item[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="[^"]*mtt_arrange_item|<\/td>|$)/gi;
    var items = inner.match(/mtt_arrange_item/g);
    if (!items) continue;

    // 逐块切：用 mtt_item_kcmc 作为锚（每块必有一个课程名）
    var blocks = inner.split(/<div[^>]*class="[^"]*mtt_arrange_item/i).slice(1);
    blocks.forEach(function (block) {
      var title = cleanTitle(divText(block, 'mtt_item_kcmc'));
      var teacher = squeeze(divText(block, 'mtt_item_jxbmc'));
      var detailRaw = squeeze(divText(block, 'mtt_item_room'));
      if (!title) return;

      var detail = parseDetail(detailRaw);
      if (!detail) {
        if (warnings) warnings.push('「' + title + '」的说明「' + detailRaw + '」没看懂，这条已跳过');
        return;
      }
      // 【只交叉校验"星期"】格子的列（data-week）与明细行的"星期N"必须一致 ——
      // 不一致就说明我的列映射错了，那是会让整张课表错位一天的严重错误。
      //
      // 【为什么**不**校验节次】真样本里两者本来就不同：格子的行是**粗粒度**的
      // （行标签只有 `1-2节 / 3-4节 / 5-5节 / 7-8节 / 9-10节 / 11-12节 / 13-14节`），
      // 而明细行写的是课程的精确跨度（`3-5节`、`7-9节`、`11-13节`）。一门 3-5 节的课
      // 会同时出现在"3-4节"行与"5-5节"行里 —— 这是真实的渲染方式，不是数据矛盾。
      // 早先这里按"两者必须一致"报警，结果真样本上刷出 12 条噪音警告（自己吓自己）。
      if (cellWeek >= 1 && cellWeek <= 7 && cellWeek !== detail.weekday && warnings) {
        warnings.push('「' + title + '」的星期在格子上是 ' + cellWeek + '、在说明里是 '
          + detail.weekday + '，按说明处理');
      }
      courses.push({
        title: title,
        teacher: teacher,
        weekday: detail.weekday,
        periods: detail.periods,
        weekStart: detail.weekStart,
        weekEnd: detail.weekEnd,
        parity: detail.parity,
        location: detail.location,
        detailRaw: detailRaw,
      });
    });
  }
  return courses;
}

/**
 * 从**复制的纯文本**里解析课程。
 *
 * 真样本（可见文本，空白已被折叠）：
 *   `1-2节 电子工艺实训[01] 杨拓,潘飞蹊 1-18周,星期2,1-2节,致腾楼316B 大学物理A（2）[05] …`
 * 所以在文本里，一门课就是「课程名 → 教师 → 明细行」三连；明细行用正则就能定位。
 *
 * @param {string} text 复制的文本（或其 HTML 去掉标签后的文本）
 * @param {Array<string>} warnings 追加警告
 * @returns {Array<object>} 课程数组（未合并）
 */
function parsePlainText(text, warnings) {
  var flat = squeeze(stripTags(text));
  if (!flat) return [];
  var courses = [];
  // 明细行整段抓：`1-18周,星期2,1-2节,致腾楼316B`（真样本里它内部没有空格，用 \S* 抓全）
  // 【踩过的坑】早先用 `[^,，]*` 抓，结果在**第一个逗号**就停了，只拿到 `1-18周,星期2`，
  // 于是节次与地点全丢（真样本上一跑就现形）。逗号是这一段的**分隔符**，不是结束符。
  var re = /(\d{1,2}\s*-\s*\d{1,2}\s*周\s*[（(]?\s*[单双]?\s*[）)]?\s*[,，]\s*星期\s*[1-7]\s*[,，]?\S*)/g;
  var match;
  while ((match = re.exec(flat)) !== null) {
    var detailRaw = squeeze(match[1]);
    var detail = parseDetail(detailRaw);
    if (!detail) continue;
    var before = flat.slice(0, match.index).trim();
    var tokens = before.split(/\s+/).filter(Boolean);

    // 课程名在明细行前面第二个词（第一个词是教师）。若没有教师，就往前多退几个词，
    // 跳过"1-2节 / 星期X / 节次/星期"这类表头行标签 —— 否则会把标签当成课程名。
    var title = '';
    var teacher = '';
    for (var back = 1; back <= 3 && back < tokens.length; back += 1) {
      var candidate = cleanTitle(tokens[tokens.length - back]);
      if (!candidate) continue;
      if (/^节次\/星期$|^星期[一二三四五六日天]$|^\d{1,2}(\s*-\s*\d{1,2})?节$/.test(candidate)) continue;
      if (back === 1) {
        // 第一个词当教师（更靠前的那个才是课程名）——但也可能是"没有教师"的情况，
        // 那时它就是课程名本身；用"是否像教师名（短、含逗号分隔的姓名）"来判断。
        if (tokens.length >= 2) {
          teacher = candidate;
          continue;
        }
      }
      title = candidate;
      break;
    }
    if (!title) continue;
    courses.push({
      title: title,
      teacher: /[\u4e00-\u9fa5]/.test(teacher) ? teacher : '',
      weekday: detail.weekday,
      periods: detail.periods,
      weekStart: detail.weekStart,
      weekEnd: detail.weekEnd,
      parity: detail.parity,
      location: detail.location,
      detailRaw: detailRaw,
    });
  }
  if (!courses.length && warnings) {
    warnings.push('这段文本里没找到"周次,星期,节次,地点"这样的课程说明，可能不是课表页的内容');
  }
  return courses;
}

/**
 * 合并同一门课的多次出现。
 *
 * 【为什么必须合并】一门 3-5 节的课在课表里会同时出现在"3-4节"行与"5-5节"行
 * （行是粗粒度的，见 parseHtmlCells 里的说明）—— 两次的明细字符串**一字不差**。
 * 不合并的话一门课会变成两条任务，课表里就出现重复卡片。
 *
 * 【合并键 = 课程名 + 教师 + 明细行】**刻意带上明细行**：同一门课若有两段不同的
 * 时间（例如"1-9周 3-4节"与"10-18周 5节"），它们是两件不同的事，必须留成两条 ——
 * 只按课程名合并会把它们错误地压成一条。
 *
 * 【节次直接用明细行的】明细行给的是精确跨度（`3-5节`），格子给的是粗粒度行标签，
 * 所以不需要也不能"把格子的节次并起来"——早先那样做会把 `3-5` 拆成 3 和 5 两个端点，
 * 合并后输出成 `3,5`（真样本上实测到的 bug，已修）。
 */
function mergeCourses(courses) {
  var byKey = {};
  var order = [];
  (courses || []).forEach(function (course) {
    var key = course.title + '|' + course.teacher + '|' + course.detailRaw;
    if (!byKey[key]) {
      byKey[key] = Object.assign({}, course, { occurrences: 0 });
      order.push(key);
    }
    byKey[key].occurrences += 1;
  });
  return order.map(function (key) {
    var merged = byKey[key];
    return Object.assign({}, merged);
  });
}

/**
 * 解析课表（自动识别"保存的网页"还是"复制的文本"）。
 *
 * @param {string} input 网页原文或复制出来的文本
 * @returns {{format:string, courses:Array, warnings:Array<string>, weekNo:(number|null)}}
 *          format: 'ehall-html' | 'ehall-text' | 'unknown'
 */
function parseTimetable(input) {
  var text = String(input === undefined || input === null ? '' : input);
  var warnings = [];
  if (!squeeze(text)) {
    return { format: 'unknown', courses: [], warnings: ['内容是空的'], weekNo: null };
  }

  var isHtml = /<td|<table|<div/i.test(text);
  var courses = isHtml ? parseHtmlCells(text, warnings) : parsePlainText(text, warnings);
  var format = courses.length ? (isHtml ? 'ehall-html' : 'ehall-text') : 'unknown';

  if (!courses.length && isHtml) {
    // HTML 里没有 data-role="item" 的格子 → 可能是"课表未列出/暂无数据"，或者用户存错了页
    var flat = squeeze(stripTags(text));
    var maybe = parsePlainText(flat, null);
    if (maybe.length) {
      courses = maybe;
      format = 'ehall-text';
      warnings.push('这份 HTML 里没有课表格子，改用"从文字里找课程说明"的方式解析（结果请核对）');
    } else {
      warnings.push('没认出这是课表：既没有课表格子，也没有"周次,星期,节次,地点"这样的课程说明'
        + '（如果是"暂无数据"，说明当前学期还没有课）');
    }
  }

  var merged = mergeCourses(courses);

  // 页面上的"第 N 周"（用来兜底推算学期起点；解析不到就为 null）
  var weekNo = null;
  var weekMatched = squeeze(stripTags(text)).match(/第\s*(\d{1,2})\s*周/);
  if (weekMatched) weekNo = Number(weekMatched[1]);

  return { format: format, courses: merged, warnings: warnings, weekNo: weekNo };
}

/**
 * 课程数组 → 本项目能直接入库的任务数组（与 utils/ics.js 的 toTasks 同一套字段口径）。
 *
 * 【关键映射】
 *   * `repeat: 'weekly'` + `periods` + `week_start/week_end/week_parity` —— 这正是
 *     "课表类任务"的判据（cloudfunctions/tasks/lib/normalize.js 的 isCourseTask）；
 *   * `date` = **第一次上课那天**：学期第一周里该星期几的日期（weekly 靠它确定"周几"）；
 *   * `start_time` / `end_time` 留空：课程的时间由用户自己的**节次作息**决定，
 *     不该在这里写死（这也是全项目的口径：作息一处校准，处处生效）。
 *
 * @param {{courses:Array}} parsed parseTimetable 的结果
 * @param {{semesterStart:string, type?:string, priority?:string, warnings?:Array<string>}} options
 *        semesterStart：学期第一周的周一（"YYYY-MM-DD"）—— 必须给，否则算不出具体日期
 * @returns {{tasks:Array, warnings:Array<string>}}
 */
function toTasks(parsed, options) {
  var opts = options || {};
  var warnings = Array.isArray(opts.warnings) ? opts.warnings : [];
  var semesterStart = squeeze(opts.semesterStart);
  var type = squeeze(opts.type) || 'event';
  var priority = squeeze(opts.priority) || 'mid';
  var courses = (parsed && parsed.courses) || [];

  if (!/^\d{4}-\d{2}-\d{2}$/.test(semesterStart)) {
    warnings.push('没有学期开始日期就算不出课程的具体日期，这次没有生成任何课程');
    return { tasks: [], warnings: warnings };
  }

  var tasks = [];
  courses.forEach(function (course) {
    var anchor = addDays(semesterStart, course.weekday - 1);   // 第 1 周里那个星期几
    if (!anchor) {
      warnings.push('「' + course.title + '」的日期算不出来（学期开始日期格式不对）');
      return;
    }
    if (!course.periods) {
      warnings.push('「' + course.title + '」没写节次，落不进课表（已跳过）');
      return;
    }
    tasks.push({
      title: course.title,
      type: type,
      date: anchor,
      start_time: '',
      end_time: '',
      priority: priority,
      done: false,
      parent_id: null,
      repeat: 'weekly',
      week_start: course.weekStart,
      week_end: course.weekEnd,
      week_parity: course.parity,
      periods: course.periods,
      location: course.location || '',
      estimate_min: 0,
    });
  });
  return { tasks: tasks, warnings: warnings };
}

/**
 * "YYYY-MM-DD" + n 天（不依赖 Date 的时区解释，与 utils/ics.js / 云函数同一做法）。
 *
 * 【为什么必须回环校验】`Date.UTC(2026, 12, 1)` 会把"13 月"静默进位成 2027-01-01，
 * `2026-02-30` 同样会被悄悄改成 03-02 —— 那等于替用户编了一个日期。本项目在
 * `dueInstantOf`（云函数）里就是这么挡的，这里照同一条口径来。
 */
function addDays(day, days) {
  var matched = squeeze(day).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) return '';
  var year = Number(matched[1]);
  var month = Number(matched[2]);
  var date = Number(matched[3]);
  if (month < 1 || month > 12 || date < 1 || date > 31) return '';
  var base = Date.UTC(year, month - 1, date);
  var probe = new Date(base);
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== date) {
    return '';                                   // 2026-02-30 这种不存在的日期
  }
  var next = new Date(base + Number(days) * 24 * 60 * 60 * 1000);
  return next.toISOString().slice(0, 10);
}

module.exports = {
  parseTimetable: parseTimetable,
  toTasks: toTasks,
  parseDetail: parseDetail,
  cleanTitle: cleanTitle,
  mergeCourses: mergeCourses,
  addDays: addDays,
  stripTags: stripTags,
  WEEKDAY_NAMES: WEEKDAY_NAMES,
  WEEKDAY_TEXT: WEEKDAY_TEXT,
  CLASS_SUFFIX_RE: CLASS_SUFFIX_RE,
};
