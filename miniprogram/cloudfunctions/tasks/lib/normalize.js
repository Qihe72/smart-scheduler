/**
 * lib/normalize.js —— 任务字段的「校验 / 归一化 / 统计」纯函数集合。
 *
 * 【这个文件为什么单独存在】
 * index.js 里混着云数据库调用，没法单独测试；把纯逻辑抽到这里之后：
 *   * cloudfunctions/_selftest.js 可以直接 require 它，用 node 跑断言；
 *   * 前端若要复用同一套字段规则，也可以把这份文件拷过去（无任何依赖）。
 *
 * 【安全铁律（与 index.js 一致）】
 * 本文件**不碰用户身份**，也绝不读取任何形式的 openid 参数。
 * 用户身份只在 index.js 里从 cloud.getWXContext().OPENID 取，
 * 这里的每个函数都只负责「把一条任务数据洗干净」。
 *
 * 【与 Python 参考实现的关系】
 * 逻辑对齐 C:\Users\qihe\Desktop\日程安排\smart-scheduler\task_manager.py 的
 * _normalize_task() / get_task_stats() / is_task_finished()，取舍见 docs/数据库与索引.md 末尾。
 */

'use strict';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 任务类型：日程 / 截止 / 子任务 */
const TYPES = ['event', 'ddl', 'subtask'];

/** 优先级 */
const PRIORITIES = ['high', 'mid', 'low'];

/** 重复方式 */
const REPEATS = ['none', 'weekly'];

/** 单双周 */
const PARITIES = ['all', 'odd', 'even'];

/** 周次取值范围（第 1 ~ 30 周，够一个学期用） */
const MIN_WEEK = 1;
const MAX_WEEK = 30;

/** 预计耗时上限（分钟）：24 小时，防止脏数据把统计撑爆 */
const MAX_ESTIMATE_MIN = 1440;

/** add / bulk_add 入库时允许的字段全集（多余字段一律丢弃） */
const TASK_FIELDS = [
  'title', 'type', 'date', 'start_time', 'end_time', 'priority', 'done',
  'parent_id', 'repeat', 'week_start', 'week_end', 'week_parity',
  'periods', 'location', 'estimate_min',
];

/**
 * update 允许修改的白名单字段。
 *
 * 【为什么必须有白名单】update 的入参是前端给的 patch，如果直接
 * `db.collection('tasks').doc(id).update({data: patch})`，前端就能顺手改
 * `_openid`（把任务从自己名下"过户"给别人）、`created_at`（伪造时间）等字段。
 * 所以这里显式列出「业务字段」，其余键（含 _openid / _id / created_at /
 * updated_at）由 pickPatch() 直接扔掉。
 */
const PATCH_WHITELIST = TASK_FIELDS.slice();

/** 一天最多 100 条：云数据库单次 get/remove 的硬上限 */
const PAGE_SIZE = 100;

/** 批量写限制：一次 add 最多 20 条（实测超过会报错） */
const BULK_CHUNK = 20;

/** 星期几的中文名（下标 0 = 周一，与 Python date.weekday() 一致） */
const WEEKDAY_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 云函数跑在腾讯云机房，容器时区是 UTC；这里统一按北京时间（UTC+8）算「今天」 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

/** 是不是「有内容的对象」（刻意不用 instanceof，跨包更稳） */
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 转成去空白的字符串；null / undefined / 对象一律变成 "" */
function toStr(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  return '';
}

/** 容错整数：'60' / 60.0 / '60分钟' → 60；非法 → fallback */
function safeInt(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const matched = value.trim().match(/^-?\d+/);
    if (matched) return parseInt(matched[0], 10);
  }
  return fallback;
}

/** 取两位补零的数字字符串 */
function pad2(number) {
  return String(number).padStart(2, '0');
}

/**
 * 把任意「日期或时间戳」转成北京时间下的 {y, m, d}。
 * @param {Date} [base] 默认当前时刻
 */
function beijingParts(base) {
  const shifted = new Date((base ? base.getTime() : Date.now()) + BEIJING_OFFSET_MS);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() };
}

/**
 * 今天（北京时间的 YYYY-MM-DD）。
 * 云函数容器是 UTC，直接用 new Date().toISOString() 会在北京时间 0:00~8:00
 * 之间差一天，所以必须 +8 小时再取 UTC 字段。
 */
function todayStr(base) {
  const { y, m, d } = beijingParts(base);
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** 现在（北京时间，毫秒精度 ISO 字符串），用于 created_at / updated_at */
function nowIso() {
  const shifted = new Date(Date.now() + BEIJING_OFFSET_MS);
  return shifted.toISOString().replace('Z', '+08:00');
}

/** 严格校验 YYYY-MM-DD，并且这个日期在日历上真实存在（挡掉 2026-02-30） */
function isValidDate(value) {
  const text = toStr(value);
  const matched = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) return false;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  // Date.UTC 会把 2 月 30 日"溢出"成 3 月 2 日，所以回读一遍比对
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year
    && probe.getUTCMonth() + 1 === month
    && probe.getUTCDate() === day;
}

/** 严格校验 HH:MM（00:00 ~ 23:59）；空字符串视为合法（表示"没填"） */
function isValidTime(value) {
  const text = toStr(value);
  if (!text) return true; // 只给日期不给时间 → 允许留空，不瞎猜
  const matched = text.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!matched) return false;
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

/** HH:MM 统一补零成两位（"9:5" → "09:05"） */
function normalizeTime(value) {
  const text = toStr(value);
  if (!text) return '';
  const matched = text.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!matched) return '';
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  if (hour > 23 || minute > 59) return '';
  return `${pad2(hour)}:${pad2(minute)}`;
}

/** "YYYY-MM-DD" → Date（UTC 语义，配合 getUTCDay 使用）；非法返回 null */
function parseDay(value) {
  if (!isValidDate(value)) return null;
  const text = toStr(value);
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 某天是周几（0 = 周一 … 6 = 周日），与 Python weekday() 一致 */
function weekdayIndex(value) {
  const date = parseDay(value);
  if (!date) return null;
  return (date.getUTCDay() + 6) % 7; // JS: 0=周日 → 0=周一
}

/** 日期加减天数，返回 YYYY-MM-DD */
function addDays(dayStr, days) {
  const date = parseDay(dayStr);
  if (!date) return '';
  date.setUTCDate(date.getUTCDate() + safeInt(days, 0));
  const { y, m, d } = { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** 某一天所在周的周一 */
function mondayOf(dayStr) {
  const index = weekdayIndex(dayStr);
  if (index === null) return '';
  return addDays(dayStr, -index);
}

/**
 * 计算某一天是开学第几周（第 1 周 = 开学第一周的周一那一周）。
 * 与 task_manager 一致：开学之前返回 null。
 */
function weekNumber(dayStr, semesterStart) {
  const monday = mondayOf(dayStr);
  const startMonday = mondayOf(semesterStart);
  if (!monday || !startMonday) return null;
  const deltaDays = Math.round((parseDay(monday) - parseDay(startMonday)) / 86400000);
  if (deltaDays < 0) return null;
  return Math.floor(deltaDays / 7) + 1;
}

/** 第 weekNo 周的周一 */
function mondayOfWeek(weekNo, semesterStart) {
  const startMonday = mondayOf(semesterStart);
  if (!startMonday) return '';
  return addDays(startMonday, (Math.max(safeInt(weekNo, 1), 1) - 1) * 7);
}

/** 第 weekNo 周是单周还是双周 */
function weekParity(weekNo) {
  return weekNo % 2 === 1 ? 'odd' : 'even';
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

/**
 * 归一化一条任务（对齐 task_manager._normalize_task）。
 *
 * 容错规则（放宽的不报错，直接修正）：
 *   * type 非法 → 'event'；priority 非法 → 'mid'
 *   * repeat 非法 → 'none'；单双周非法 → 'all'
 *   * week_start / week_end 非数字 → 1 / 20；week_end < week_start → 取齐
 *   * estimate_min 负数或非数字 → 0（0 表示"没估"，绝不瞎猜）
 *   * DDL 只留截止时刻：end_time 为空但 start_time 有值 → 迁移过去，start_time 清空
 *   * 非每周重复的任务：week_start / week_end 存 null，数据干净
 *
 * 会报错（errors 非空）的情况只有两类，它们都是"改不动"的：
 *   * title 为空
 *   * date 不是合法的 YYYY-MM-DD / start_time / end_time 不是合法的 HH:MM
 *
 * 【errors 非空时仍然返回 task】这样调用方既能拿到"哪些字段有问题"，也能拿到
 * 已经尽量纠正过的结果（页面可以提示"end_time 不合法，已清空"）。
 * **是否入库由调用方决定**：云函数在 errors 非空时一律拒绝写入（见 index.js），
 * 免得脏数据进库；前端可以拿 task 做表单回填与错误提示。
 *
 * @param {object} raw 前端或 AI 传来的任务对象
 * @param {{today?: string, now?: string, defaultType?: string, defaultPriority?: string}} [options]
 * @returns {{task: object|null, errors: string[]}} task 为 null 只表示"传进来的根本不是对象"
 */
function normalizeTask(raw, options) {
  const opts = options || {};
  const today = isValidDate(opts.today) ? opts.today : todayStr();
  const errors = [];

  if (!isPlainObject(raw)) {
    return { task: null, errors: ['task 必须是对象'] };
  }

  // --- 标题：唯一的必填项 ---
  const title = toStr(raw.title).slice(0, 100);
  if (!title) errors.push('title 不能为空');

  // --- 类型 / 优先级：非法就退回默认值 ---
  let type = toStr(raw.type).toLowerCase();
  if (TYPES.indexOf(type) === -1) {
    type = TYPES.indexOf(opts.defaultType) === -1 ? 'event' : opts.defaultType;
  }
  let priority = toStr(raw.priority).toLowerCase();
  if (PRIORITIES.indexOf(priority) === -1) {
    priority = PRIORITIES.indexOf(opts.defaultPriority) === -1 ? 'mid' : opts.defaultPriority;
  }

  // --- 日期：空值补今天（与 Python 版一致），非法值报错 ---
  let date = toStr(raw.date);
  if (!date) {
    date = today;
  } else if (!isValidDate(date)) {
    errors.push(`date 必须是 YYYY-MM-DD，收到：${date}`);
  }

  // --- 起止时间 ---
  let startTime = toStr(raw.start_time);
  let endTime = toStr(raw.end_time);
  if (startTime && !isValidTime(startTime)) {
    errors.push(`start_time 必须是 HH:MM，收到：${startTime}`);
    startTime = '';
  }
  if (endTime && !isValidTime(endTime)) {
    errors.push(`end_time 必须是 HH:MM，收到：${endTime}`);
    endTime = '';
  }
  startTime = normalizeTime(startTime);
  endTime = normalizeTime(endTime);

  // DDL 的语义修正：截止只有一个时刻，没有开始时间
  if (type === 'ddl') {
    if (!endTime && startTime) endTime = startTime;
    startTime = '';
  }

  // --- parent_id：只接受非空字符串（云数据库 _id 是字符串） ---
  let parentId = null;
  if (raw.parent_id !== null && raw.parent_id !== undefined && raw.parent_id !== '') {
    parentId = toStr(raw.parent_id);
    if (!parentId) parentId = null;
  }
  // 自己做自己的父任务是无意义的自环，直接丢掉
  if (parentId && parentId === toStr(raw._id)) parentId = null;

  // --- 预计耗时：负数 / 字符串 / 缺失 → 0 ---
  let estimateMin = safeInt(raw.estimate_min, 0);
  if (!Number.isFinite(estimateMin) || estimateMin < 0) estimateMin = 0;
  if (estimateMin > MAX_ESTIMATE_MIN) estimateMin = MAX_ESTIMATE_MIN;

  // --- 重复方式 / 周次 / 单双周 ---
  let repeat = toStr(raw.repeat).toLowerCase();
  if (REPEATS.indexOf(repeat) === -1) repeat = 'none';

  let weekStart = null;
  let weekEnd = null;
  let parity = toStr(raw.week_parity).toLowerCase();
  if (PARITIES.indexOf(parity) === -1) parity = 'all';

  if (repeat === 'weekly') {
    weekStart = safeInt(raw.week_start, 1);
    if (!Number.isFinite(weekStart)) weekStart = 1;
    weekStart = Math.min(Math.max(weekStart, MIN_WEEK), MAX_WEEK);

    weekEnd = safeInt(raw.week_end, 20);
    if (!Number.isFinite(weekEnd)) weekEnd = 20;
    weekEnd = Math.min(Math.max(weekEnd, MIN_WEEK), MAX_WEEK);
    if (weekEnd < weekStart) weekEnd = weekStart;
  } else {
    // 不重复的任务不需要周次信息，存 null 保持数据干净
    parity = 'all';
  }

  // --- 节次范围：接受 "7-9" / [7, 9] / "7" ---
  const periods = normalizePeriods(raw.periods);

  // --- 地点 ---
  const location = toStr(raw.location).slice(0, 60);

  const task = {
    title,
    type,
    date,
    start_time: startTime,
    end_time: endTime,
    priority,
    done: raw.done === true || raw.done === 'true' || raw.done === 1,
    parent_id: parentId,
    repeat,
    week_start: weekStart,
    week_end: weekEnd,
    week_parity: parity,
    periods,
    location,
    estimate_min: estimateMin,
  };

  return { task, errors };
}

/** 节次范围归一化：数组 [7,9] → "7-9"；单节 [7] → "7" */
function normalizePeriods(value) {
  if (Array.isArray(value)) {
    const numbers = value
      .map((item) => safeInt(item, NaN))
      .filter((item) => Number.isFinite(item) && item > 0);
    if (!numbers.length) return '';
    const first = Math.min.apply(null, numbers);
    const last = Math.max.apply(null, numbers);
    return first === last ? String(first) : `${first}-${last}`;
  }
  const text = toStr(value);
  if (!text) return '';
  const matched = text.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (matched) {
    const first = Number(matched[1]);
    const last = Number(matched[2]);
    if (first > 0 && last >= first) return first === last ? String(first) : `${first}-${last}`;
    return '';
  }
  const single = safeInt(text, 0);
  return single > 0 ? String(single) : '';
}

/**
 * 过滤 update 的 patch：只保留白名单字段，并对每个字段做归一化。
 *
 * @param {object} patch 前端传来的待改字段
 * @param {{now?: string}} [options]
 * @returns {{patch: object, rejected: string[], errors: string[]}}
 *          patch 为空对象表示"没有可改的字段"
 */
function pickPatch(patch, options) {
  const opts = options || {};
  const now = opts.now || nowIso();
  const rejected = [];
  const errors = [];
  const clean = {};

  if (!isPlainObject(patch)) {
    return { patch: clean, rejected, errors: ['patch 必须是对象'] };
  }

  Object.keys(patch).forEach((key) => {
    if (PATCH_WHITELIST.indexOf(key) === -1) {
      rejected.push(key); // 含 _openid / _id / created_at / updated_at 等
      return;
    }
    const value = patch[key];

    if (key === 'title') {
      const title = toStr(value).slice(0, 100);
      if (!title) errors.push('title 不能为空');
      else clean.title = title;
      return;
    }
    if (key === 'date') {
      const date = toStr(value);
      if (!isValidDate(date)) errors.push(`date 必须是 YYYY-MM-DD，收到：${date}`);
      else clean.date = date;
      return;
    }
    if (key === 'start_time' || key === 'end_time') {
      const time = toStr(value);
      if (time && !isValidTime(time)) errors.push(`${key} 必须是 HH:MM，收到：${time}`);
      else clean[key] = normalizeTime(time);
      return;
    }
    if (key === 'type') {
      const type = toStr(value).toLowerCase();
      if (TYPES.indexOf(type) === -1) errors.push(`type 只能是 ${TYPES.join(' / ')}`);
      else clean.type = type;
      return;
    }
    if (key === 'priority') {
      const priority = toStr(value).toLowerCase();
      if (PRIORITIES.indexOf(priority) === -1) errors.push(`priority 只能是 ${PRIORITIES.join(' / ')}`);
      else clean.priority = priority;
      return;
    }
    if (key === 'done') {
      clean.done = value === true || value === 'true' || value === 1;
      return;
    }
    if (key === 'parent_id') {
      const parentId = value === null || value === undefined || value === '' ? null : toStr(value);
      clean.parent_id = parentId || null;
      return;
    }
    if (key === 'estimate_min') {
      let estimate = safeInt(value, 0);
      if (!Number.isFinite(estimate) || estimate < 0) estimate = 0;
      clean.estimate_min = Math.min(estimate, MAX_ESTIMATE_MIN);
      return;
    }
    if (key === 'repeat') {
      const repeat = toStr(value).toLowerCase();
      if (REPEATS.indexOf(repeat) === -1) errors.push(`repeat 只能是 ${REPEATS.join(' / ')}`);
      else clean.repeat = repeat;
      return;
    }
    if (key === 'week_parity') {
      const parity = toStr(value).toLowerCase();
      if (PARITIES.indexOf(parity) === -1) errors.push(`week_parity 只能是 ${PARITIES.join(' / ')}`);
      else clean.week_parity = parity;
      return;
    }
    if (key === 'week_start' || key === 'week_end') {
      let week = safeInt(value, MIN_WEEK);
      if (!Number.isFinite(week)) week = MIN_WEEK;
      clean[key] = Math.min(Math.max(week, MIN_WEEK), MAX_WEEK);
      return;
    }
    if (key === 'periods') {
      clean.periods = normalizePeriods(value);
      return;
    }
    if (key === 'location') {
      clean.location = toStr(value).slice(0, 60);
      return;
    }
    // 理论上到不了这里（白名单已挡），保险起见拒绝掉
    rejected.push(key);
  });

  // repeat 改成 none 时，顺手把周次清空；改成 weekly 时补默认周次
  if (clean.repeat === 'none') {
    clean.week_start = null;
    clean.week_end = null;
    clean.week_parity = 'all';
  } else if (clean.repeat === 'weekly') {
    if (clean.week_start === undefined || clean.week_start === null) clean.week_start = MIN_WEEK;
    if (clean.week_end === undefined || clean.week_end === null) clean.week_end = 20;
    if (clean.week_end < clean.week_start) clean.week_end = clean.week_start;
  }

  if (Object.keys(clean).length) clean.updated_at = now;

  return { patch: clean, rejected, errors };
}

// ---------------------------------------------------------------------------
// 级联删除 / 分页
// ---------------------------------------------------------------------------

/**
 * 收集「删除某个任务时需要一并删掉的 id」：它自己 + 直接子任务。
 *
 * 这是纯函数（不查库），index.js 拿到 id 列表后按 100 一批删除。
 * 云数据库单次 remove 最多 100 条，所以这里刻意返回数组而不是布尔值。
 *
 * @param {Array} allTasks 当前用户的全部任务
 * @param {string} id 要删除的任务 _id
 * @returns {{ids: string[], children: string[]}}
 */
function collectRemoveIds(allTasks, id) {
  const target = toStr(id);
  const ids = [];
  const children = [];
  if (!target) return { ids, children };
  if (!Array.isArray(allTasks)) return { ids: [target], children };

  ids.push(target);
  allTasks.forEach((task) => {
    if (!isPlainObject(task)) return;
    if (toStr(task.parent_id) && toStr(task.parent_id) === target) {
      const childId = toStr(task._id);
      if (childId && childId !== target) {
        children.push(childId);
        ids.push(childId);
      }
    }
  });
  return { ids, children };
}

/** 把数组按 size 切成多批（批量写 20 条一批；删除 100 条一批） */
function chunk(list, size) {
  const step = Math.max(safeInt(size, 1) || 1, 1);
  const out = [];
  if (!Array.isArray(list)) return out;
  for (let i = 0; i < list.length; i += step) {
    out.push(list.slice(i, i + step));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------

/**
 * 推算「每周重复」的这门课最后一次上课的日期（对齐 last_occurrence_date）。
 *
 * 按 week_end 和单双周倒推：双周课如果 week_end 落在单周，实际最后一周要往前挪。
 *
 * @returns {string|null} YYYY-MM-DD；不是每周重复的课 / 数据不全 → null
 */
function lastOccurrenceDate(task, semesterStart) {
  if (!isPlainObject(task)) return null;
  if (toStr(task.repeat) !== 'weekly') return null;

  const anchor = parseDay(task.date);
  if (!anchor) return null; // 没有原始日期就不知道是星期几

  const weekEnd = safeInt(task.week_end, NaN);
  if (!Number.isFinite(weekEnd) || weekEnd < MIN_WEEK) return null;

  let weekStart = safeInt(task.week_start, MIN_WEEK);
  if (!Number.isFinite(weekStart) || weekStart < MIN_WEEK) weekStart = MIN_WEEK;

  const parity = PARITIES.indexOf(toStr(task.week_parity)) === -1 ? 'all' : toStr(task.week_parity);
  let week = weekEnd;
  if (parity !== 'all') {
    let guard = 0;
    while (week >= weekStart && weekParity(week) !== parity && guard < MAX_WEEK + 1) {
      week -= 1;
      guard += 1;
    }
    if (week < weekStart) return null; // 按这个单双周要求，它一次也上不了
  }

  const monday = mondayOfWeek(week, semesterStart);
  if (!monday) return null;
  // 用 anchor（课程第一次上课那天）是周几，推出最后一次课落在那一周的哪一天
  const index = weekdayIndex(task.date);
  if (index === null) return null;
  return addDays(monday, index);
}

/**
 * 判断一条任务是否「已经结束」（对齐 is_task_finished）。
 *
 * 只有每周重复的课才会自动结束，判定依据是**最后一次课有没有上完**：
 *   * 最后一次课在过去      → 已结束
 *   * 最后一次课就是今天且已过下课时间 → 已结束（没填下课时间则算没结束）
 *   * 最后一次课还没到      → 进行中
 *
 * 手动添加的一次性日程不会自动结束（免得把还没做的事吞掉）。
 */
function isTaskFinished(task, semesterStart, now) {
  if (!isPlainObject(task)) return false;
  // 与 task_manager.is_task_finished 一致：手动标记过完成的算「已完成」，不重复统计
  if (task.done === true) return false;

  const lastDate = lastOccurrenceDate(task, semesterStart);
  if (!lastDate) return false;

  const reference = now instanceof Date ? now : new Date();
  const today = todayStr(reference);
  if (lastDate < today) return true;
  if (lastDate > today) return false;

  // 最后一次课就是今天：看下课时间过没过
  const endTime = normalizeTime(task.end_time);
  if (!endTime) return false; // 没填下课时间 → 保守地算「还没结束」
  const { y, m, d } = beijingParts(reference);
  const endMoment = Date.UTC(y, m - 1, d, Number(endTime.slice(0, 2)), Number(endTime.slice(3, 5)));
  return reference.getTime() + BEIJING_OFFSET_MS >= endMoment;
}

/**
 * 任务概览统计（对齐 get_task_stats）。
 *
 * @param {Array} tasks 当前用户的全部任务
 * @param {string} semesterStart 开学第一周的周一
 * @param {Date} [now] 便于测试注入的"现在"
 * @returns {{total, done, pending, ddl, finished}}
 */
function taskStats(tasks, semesterStart, now) {
  const list = Array.isArray(tasks) ? tasks.filter(isPlainObject) : [];
  const total = list.length;
  let done = 0;
  let ddl = 0;
  let finished = 0;

  list.forEach((task) => {
    if (task.done === true) done += 1;
    if (toStr(task.type) === 'ddl') ddl += 1;
    if (isTaskFinished(task, semesterStart, now)) finished += 1;
  });

  return { total, done, ddl, finished, pending: Math.max(total - done - finished, 0) };
}

// ---------------------------------------------------------------------------
// AI 配置（用户自填 Key）—— settings 集合里的 ai_provider / ai_api_key / ai_model
// ---------------------------------------------------------------------------
/**
 * 允许用户选择的服务商白名单。
 *
 * 【为什么必须是白名单】服务商名最终会映射到**写死的**接口地址（见两个 AI 云函数里的
 * PROVIDERS 表）。如果允许任意值，就等于让前端指定请求目标 —— 云函数会变成任意请求
 * 转发器（SSRF）。所以这里不认识的值一律**报错拒绝**，不"忽略后走默认"。
 */
const AI_PROVIDERS = ['zhipu', 'deepseek'];

/** 用户可填的 Key 长度范围（只做基本校验，不联网验证格式） */
const MIN_API_KEY_LENGTH = 8;
const MAX_API_KEY_LENGTH = 512;

/** 模型名长度上限 */
const MAX_MODEL_LENGTH = 64;

/** 掩码里保留的末位字符数 */
const MASK_TAIL = 4;

/** 绝不回传 / 绝不写进日志的字段名（集中在一处，方便审阅） */
const SECRET_FIELDS = ['ai_api_key', 'api_key', 'apiKey', 'ai_apikey'];

/**
 * 生成脱敏展示串：保留末 4 位，前面固定 4 个星号（如 `****abcd`）。
 *
 * 【为什么是固定 4 个星号而不是"长度-4"个】后者会暴露 Key 的真实长度，
 * 而长度本身也是一种（虽然很弱的）信息，没必要给。结果里**永远不含**前缀。
 *
 * Key 太短（<= 4 位）时不生成掩码 —— 否则等于把整个 Key 显示出来。
 *
 * @returns {string} 掩码；无法安全生成时返回空串
 */
function maskApiKey(apiKey) {
  const key = toStr(apiKey);
  if (!key) return '';
  if (key.length <= MASK_TAIL) return ''; // 太短：给掩码就等于泄密
  return `****${key.slice(-MASK_TAIL)}`;
}

/**
 * 剔除对象里所有"绝不能回传前端"的字段。
 *
 * 【为什么单独做一层】不能只靠 normalizeTask 的字段白名单 —— 那份白名单管的是**任务**，
 * 而 Key 存在于 settings 的 AI 配置里。任何要返回给前端的对象都先过一遍这里，
 * 免得哪天顺手 `ok({ ...row })` 就把 Key 带出去了。
 *
 * @param {object} row 数据库行或任意要回传的对象
 * @returns {object} 去掉敏感字段的浅拷贝
 */
function stripSecrets(row) {
  if (!isPlainObject(row)) return {};
  const clean = {};
  Object.keys(row).forEach((key) => {
    if (SECRET_FIELDS.indexOf(key) !== -1) return;
    clean[key] = row[key];
  });
  return clean;
}

/**
 * 归一化「用户自填的 AI 配置」。
 *
 * 规则：
 *   * provider 必须是白名单里的值；不认识 → 报错（不静默走默认）
 *   * model 可空（空 = 用该服务商的默认模型）
 *   * api_key 去首尾空白后做长度/字符校验；**空串 = 清除**（与 clear 等价）
 *
 * @param {object} raw 前端传来的 {provider, api_key, model}
 * @returns {{config: {provider:string, api_key:string, model:string}, clearing:boolean, errors:string[]}}
 */
function normalizeAiConfig(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const errors = [];

  // --- provider：白名单硬校验 ---
  let provider = toStr(source.provider).toLowerCase();
  if (provider && AI_PROVIDERS.indexOf(provider) === -1) {
    errors.push(`provider 只能是 ${AI_PROVIDERS.join(' / ')}，收到：${toStr(source.provider)}`);
  }

  // --- model：可空，做长度与字符校验 ---
  let model = toStr(source.model);
  if (model.length > MAX_MODEL_LENGTH) {
    errors.push(`model 过长（最多 ${MAX_MODEL_LENGTH} 字符）`);
  } else if (model && !/^[A-Za-z0-9._:-]+$/.test(model)) {
    // 模型名只会进请求体，但仍不该接受奇怪字符（也顺带挡住注入式输入）
    errors.push('model 只能包含字母、数字、点、下划线、冒号与连字符');
  }

  // --- api_key：去首尾空白；空串 = 清除 ---
  const apiKey = toStr(source.api_key);
  const clearing = !apiKey;
  if (!clearing) {
    if (apiKey.length < MIN_API_KEY_LENGTH) {
      errors.push(`api_key 太短（至少 ${MIN_API_KEY_LENGTH} 位）`);
    } else if (apiKey.length > MAX_API_KEY_LENGTH) {
      errors.push(`api_key 过长（最多 ${MAX_API_KEY_LENGTH} 位）`);
    } else if (/\s/.test(apiKey)) {
      // Key 里不该出现空白（多半是复制时带进了换行/空格）
      errors.push('api_key 不能包含空格或换行，请检查是否复制完整');
    }
  }

  // 清除时把 provider / model 一并清掉，避免留下"半套配置"
  if (clearing) {
    if (provider && AI_PROVIDERS.indexOf(provider) === -1) provider = '';
    return { config: { provider: '', api_key: '', model: '' }, clearing: true, errors };
  }

  return {
    config: { provider, api_key: apiKey, model },
    clearing: false,
    errors: errors.length ? errors : [],
  };
}

/**
 * 把 settings 行整理成「给前端看的 AI 配置」——**绝不含 Key 原文**。
 *
 * @param {object} row settings 集合里的记录（可能没有）
 * @returns {{provider:string, model:string, hasKey:boolean, masked:string, updated_at:string}}
 */
function aiConfigView(row) {
  const source = isPlainObject(row) ? row : {};
  const apiKey = toStr(source.ai_api_key);
  return {
    provider: toStr(source.ai_provider),
    model: toStr(source.ai_model),
    hasKey: !!apiKey,
    masked: maskApiKey(apiKey),
    updated_at: toStr(source.ai_updated_at),
  };
}

// ---------------------------------------------------------------------------
// 设置（settings 集合）
// ---------------------------------------------------------------------------

/** 默认作息：与 config.py 的 CLASS_PERIODS 一致（第 1 ~ 13 节） */
const DEFAULT_PERIOD_TIMES = {
  1: ['08:00', '08:45'],
  2: ['08:55', '09:40'],
  3: ['10:00', '10:45'],
  4: ['10:55', '11:40'],
  5: ['14:00', '14:45'],
  6: ['14:55', '15:40'],
  7: ['16:00', '16:45'],
  8: ['16:55', '17:40'],
  9: ['19:00', '19:45'],
  10: ['19:55', '20:40'],
  11: ['20:50', '21:35'],
  12: ['21:40', '22:25'],
  13: ['22:30', '23:15'],
};

/** settings 里的业务键（不含系统字段与 AI 配置） */
const SETTINGS_KEYS = ['semester_start', 'period_times'];

/**
 * 归一化 settings（只接受 semester_start 与 period_times）。
 *
 * @param {object} raw 前端传来的设置
 * @param {{partial?: boolean, now?: Date}} [options] partial=true 时用于 update，
 *        未提供的键不写入
 * @returns {{settings: object, errors: string[]}}
 */
function normalizeSettings(raw, options) {
  const opts = options || {};
  const partial = opts.partial === true;
  const errors = [];
  const settings = {};

  if (!isPlainObject(raw)) {
    return { settings, errors: ['settings 必须是对象'] };
  }

  // 只挑认识的两个键，其它键静默忽略（不报错，方便前端多传）
  SETTINGS_KEYS.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) {
      if (!partial) settings[key] = null;
      return;
    }
    const value = raw[key];
    if (key === 'semester_start') {
      const text = toStr(value);
      if (!text) {
        settings.semester_start = null; // 允许清空（清空后周次统计退化为 0）
        return;
      }
      if (!isValidDate(text)) {
        errors.push(`semester_start 必须是 YYYY-MM-DD，收到：${text}`);
        return;
      }
      // 统一存成"那一周的周一"，与 Python 的 monday_of 语义一致
      settings.semester_start = mondayOf(text);
      return;
    }
    // period_times：{"1": ["08:00","08:45"], ...}
    if (value === null || value === undefined) {
      settings.period_times = null;
      return;
    }
    if (!isPlainObject(value)) {
      errors.push('period_times 必须是对象，如 {"1": ["08:00","08:45"]}');
      return;
    }
    const cleaned = {};
    Object.keys(value).forEach((num) => {
      const periodNo = safeInt(num, 0);
      if (periodNo < 1 || periodNo > 20) return; // 一天最多 20 节，挡掉脏键
      const pair = value[num];
      if (!Array.isArray(pair) || pair.length < 2) return;
      const start = normalizeTime(pair[0]);
      const end = normalizeTime(pair[1]);
      if (!start || !end) return;
      cleaned[String(periodNo)] = [start, end];
    });
    settings.period_times = Object.keys(cleaned).length ? cleaned : null;
  });

  // 一个字段都没给 → 明确报错，避免前端静默什么都没改还以为成功了
  if (partial && !Object.keys(settings).length && !errors.length) {
    errors.push('settings 里没有可保存的字段（只支持 semester_start / period_times）');
  }

  return { settings, errors };
}

// ---------------------------------------------------------------------------
// 课表类任务 / 去重键
// ---------------------------------------------------------------------------

/**
 * 判断一条任务是不是「**课表类任务**」（`.ics` 导入产生的那种）。
 *
 * 【判据：`repeat === 'weekly'` **且** `periods` 非空】
 *
 * 为什么是这两个条件、以及它的已知边界（**文档里必须照实写，不能含糊**）：
 *   * `.ics` 导入出来的课一定是 `repeat:'weekly'`（RRULE FREQ=WEEKLY），
 *     并且会带节次 `periods`（如 `'3-4'`，来自 DESCRIPTION）。
 *   * 用户**手工**添加的日程 / DDL / 子任务默认是 `repeat:'none'` 或 `periods:''`，
 *     因此不会被误删 —— 这是 `import_replace` 敢按这个判据删数据的前提。
 *   * ⚠️ 已知边界一：用户**手工**建的"每周重复 + 填了节次"的课，长得和课表一样，
 *     会被一并替换掉。这是接受的代价（见 docs/数据库与索引.md）。
 *   * ⚠️ 已知边界二：`.ics` 里**没写节次**的 weekly 课（`periods === ''`）**不算**课表类，
 *     因此不会被 `import_replace` 删掉 —— 宁可少删（用户手工删一条），
 *     也不能因为"猜"而多删（那会悄悄吞掉用户的数据）。
 *     想清理这种残留，只能手工删或用 `remove`。
 *
 * @param {object} task 任务
 * @returns {boolean}
 */
function isCourseTask(task) {
  if (!isPlainObject(task)) return false;
  return toStr(task.repeat) === 'weekly' && toStr(task.periods) !== '';
}

/**
 * 计算任务的「去重键」：**标题 + 日期 + 开始时间**。
 *
 * 【为什么用这三个字段】
 *   * 它们一起构成"用户眼里的同一条日程"：同一件事、同一天、同一时刻。
 *     重复导入课表时，这三样必然完全相同，所以能稳定认出重复。
 *   * 不把 `type` 放进去：同样一件事换个类型仍是同一条（而且类型容错后会归一）。
 *   * 不把 `end_time` / `location` / `estimate_min` 放进去：这些是"细节"，
 *     用户改了结束时间不该算成新的一条（否则去重会失效，又翻倍）。
 *   * 不把 `repeat` / `week_*` 放进去：同一门课改周次仍是同一门课。
 *   * **`start_time` 参与**：同一天同名但上午一场、下午一场是两件真事，不能误杀。
 *
 * 返回空串表示"这条没有可比性"（缺标题，调用方通常已经先拦掉了）。
 *
 * @param {object} task 任务（**应该先归一化**，否则 `9:5` 与 `09:05` 会被当成两条）
 * @returns {string} 形如 `开会\u0000 2026-10-12\u000009:00`
 */
function taskDedupeKey(task) {
  if (!isPlainObject(task)) return '';
  const title = toStr(task.title);
  if (!title) return '';
  // 用 \u0000 分隔：标题里不可能出现它，避免"开会 2026"这种拼接歧义
  return [title, toStr(task.date), toStr(task.start_time)].join('\u0000');
}

/** 读取设置并补默认值（settings 集合里没有记录时也能用） */
function withSettingsDefaults(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const semesterStart = isValidDate(source.semester_start) ? toStr(source.semester_start) : '';
  const periodTimes = isPlainObject(source.period_times) && Object.keys(source.period_times).length
    ? source.period_times
    : DEFAULT_PERIOD_TIMES;
  return { semester_start: semesterStart, period_times: periodTimes };
}

module.exports = {
  // 常量
  TYPES,
  PRIORITIES,
  REPEATS,
  PARITIES,
  TASK_FIELDS,
  PATCH_WHITELIST,
  SETTINGS_KEYS,
  PAGE_SIZE,
  BULK_CHUNK,
  MIN_WEEK,
  MAX_WEEK,
  MAX_ESTIMATE_MIN,
  WEEKDAY_CN,
  DEFAULT_PERIOD_TIMES,
  // AI 配置（用户自填 Key）——常量
  AI_PROVIDERS,
  SECRET_FIELDS,
  MASK_TAIL,
  MIN_API_KEY_LENGTH,
  MAX_API_KEY_LENGTH,
  MAX_MODEL_LENGTH,
  // 工具
  isPlainObject,
  toStr,
  safeInt,
  pad2,
  todayStr,
  nowIso,
  isValidDate,
  isValidTime,
  normalizeTime,
  parseDay,
  weekdayIndex,
  addDays,
  mondayOf,
  weekNumber,
  mondayOfWeek,
  weekParity,
  // 归一化
  normalizeTask,
  normalizePeriods,
  pickPatch,
  normalizeSettings,
  withSettingsDefaults,
  // AI 配置（用户自填 Key）——函数
  maskApiKey,
  stripSecrets,
  normalizeAiConfig,
  aiConfigView,
  // 删除 / 分页
  collectRemoveIds,
  chunk,
  // 课表类任务 / 去重
  isCourseTask,
  taskDedupeKey,
  // 统计
  lastOccurrenceDate,
  isTaskFinished,
  taskStats,
};
