/**
 * tools/week_placement_probe.js —— 用真实数据检查课表落点的不变式。
 *
 * 【为什么需要它】课表页把一条任务放到哪一行，靠的是"节次 → 行"的换算；
 * 这个换算出过一次真机事故：一条 12:00 的截止在默认作息里落在午休空档、
 * 任何一节都接不住，于是掉进「其他时段」，用户以为"截止不显示"。
 * 单测用的是构造数据，证明的是逻辑；这个探针证明的是**你自己那堆真实数据**上不变量成立。
 *
 * 【不变量】只要一条任务**有时间、且没有写死节次**，它落进的那一行必须真的接住它：
 *   * 有区间的（有起有止）→ 与那一行**重叠 > 0**；
 *   * 只有一个时刻的（例如截止只有 "12:00 前"，语义是"一个时刻"而不是一段时间）
 *     → 那一行必须**包含**这个时刻（含首尾）。
 *   **不允许"落在第 N 节、但跟第 N 节零重叠"**。
 *
 * 【为什么要为"一个时刻"单列一种判据】第一版探针把这种情况也按"重叠 > 0"判，
 * 结果把**正确的**行为报成了违反：一条 12:00 的截止落在「第 5 节」(11:45-12:25)，
 * 它的零长区间与第 5 节的重叠确实是 0，但 12:00 就落在这一节里面 —— 这正是
 * 「截止只有一个时刻」的项目口径（`utils/planner.js` 与课表页都按它实现）。
 * 校验脚本的错误判据比没有校验更危险，所以这条注释留着，别改回去。
 *
 * 【接口】从 stdin 读一段 JSON（由 tools/verify_week_placement.py 从 data/app.db 导出）：
 *   { "tasks": [...], "period_times": {...} }
 * 用法（一般由 python 那头调用，不用手敲）：
 *   node tools/week_placement_probe.js <miniprogram目录> < 数据.json
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MP = process.argv[2] || path.join(__dirname, '..', 'miniprogram');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (err) {
    return '';
  }
}

/** 在 node 里加载真实的课表页实现（只桩掉 Page，取它的 __test 探针） */
function loadWeekPage() {
  const pagePath = path.resolve(MP, 'pages', 'week', 'week.js');
  let captured = null;
  global.Page = (options) => { captured = options; };
  global.wx = { getStorageSync: () => '', setStorageSync: () => {}, showToast: () => {} };
  global.getApp = () => ({ globalData: {}, applySettings: () => {} });
  delete require.cache[require.resolve(pagePath)];
  require(pagePath);
  if (!captured || !captured.__test) throw new Error('没拿到 week.js 的 __test 探针');
  return captured.__test;
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return addDays(dateStr, -((d.getUTCDay() + 6) % 7));
}

/** "HH:MM" → 分钟 */
function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 行标签里的时间区间（"08:30-09:10"）→ [起, 止]；空档行的标签是"午休"没有区间 */
function rowRangeOf(label, rowTimeText) {
  const m = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(String(rowTimeText || '').trim());
  if (!m) return null;
  return [minutesOf(m[1]), minutesOf(m[2])];
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) {
    console.error('没有从 stdin 读到数据（应由 tools/verify_week_placement.py 提供）');
    process.exit(2);
  }
  const data = JSON.parse(raw);
  const tasks = (data.tasks || []).filter((t) => t && t.date);
  const override = data.period_times || null;
  const t = loadWeekPage();

  const mondays = Array.from(new Set(tasks.map((x) => mondayOf(x.date)))).sort();
  const violations = [];
  let checked = 0;

  mondays.forEach((monday) => {
    const perDay = [];
    for (let i = 0; i < 7; i += 1) {
      const day = addDays(monday, i);
      perDay.push(tasks.filter((task) => String(task.date || '') === day));
    }
    const built = t.buildGrid(perDay, override, monday);

    built.rows.forEach((row, rowIndex) => {
      built.days.forEach((day, dayIndex) => {
        (day.cells[rowIndex].tasks || []).forEach((view) => {
          // 只检查"没有写死节次、但有时间"的任务 —— 写死节次的按其节次定位，不在此列
          const src = perDay[dayIndex].filter((x) => x.title === view.title)[0];
          if (!src || String(src.periods || '').trim()) return;
          const start = minutesOf(src.start_time);
          const end = minutesOf(src.end_time);
          if (start === null && end === null) return;
          if (row.key === 'other') return; // 兜底行是合法去处
          const range = rowRangeOf(row.label, row.timeText);
          if (!range) return;
          checked += 1;
          const lo = start === null ? end : start;
          const hi = end === null ? lo : Math.max(end, lo);
          // 有区间按"重叠 > 0"；只有一个时刻（截止）按"这一行包含这个时刻"
          const degenerate = (lo === hi);
          const fits = degenerate
            ? (range[0] <= lo && lo <= range[1])
            : (Math.min(hi, range[1]) - Math.max(lo, range[0]) > 0);
          if (!fits) {
            violations.push({ monday, title: src.title, time: `${src.start_time || ''}-${src.end_time || ''}`,
              row: row.label, rowRange: row.timeText, degenerate: degenerate });
          }
        });
      });
    });
  });

  console.log(`检查了 ${mondays.length} 个周、${tasks.length} 条真实任务；`);
  console.log(`其中"有时间但没写死节次"的落点共核对 ${checked} 处。`);
  if (violations.length) {
    console.log('\n违反不变式（落点与时间零重叠）：');
    violations.forEach((v) => {
      console.log(`  ${v.monday}  「${v.title}」 ${v.time} → 落在「${v.row}」(${v.rowRange})`);
    });
  } else {
    console.log('\n不变式成立：没有任何一条任务被排到与它时间零重叠的那一行。');
  }
  // 末行给 python 解析用
  console.log('RESULT ' + JSON.stringify({ checked: checked, violations: violations.length }));
}

main();
