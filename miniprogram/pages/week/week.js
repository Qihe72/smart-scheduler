/**
 * pages/week/week.js —— 课表周视图（按节次排的一周 7 天）。
 *
 * 【这一页做什么】
 *   * 表头 7 列 = 周一 ~ 周日，显示「星期 + MM-DD」，今天那一列加高亮 class，
 *     并在表头显示这一天还有几节空着（「空闲 N 节」）。
 *   * 左侧 = 节次栏：节次名（第7节 / 午休 / 休息）与**校准后**的上下课时间。
 *   * 任务按 `task.periods`（如 "7-9"）或起止时间落到对应行；落在同一行的多条任务
 *     **并排展示**（每行最多两条，多了自动换行，绝不互相覆盖）。
 *   * 顶部「上一周 / 本周 / 下一周」用 `weekOffset` 变量 + setData 刷新。
 *   * 下拉刷新（onPullDownRefresh）、点击条目进 pages/edit/edit?id=xxx。
 *
 * 【为什么只依赖 utils/periods.js，不自己算时间】
 *   作息表、午休空档、周次这些口径在 Python 版（config.py）里已经定死了，
 *   utils/periods.js 是它的 JS 移植。这里只做「取数据 + 排版」，
 *   一行到底叫「午休」还是「第6节」完全交给 periods.rowLabel() 判断，避免两处口径打架。
 *
 * 【午休行的两条硬规矩】
 *   1. 单独一行（不是塞在某一节里），行内**不出现"空闲"字样**；
 *   2. **不计入空闲节数**（periods.breakLabel 命中即视为空档行，从空闲统计里剔除）。
 *
 * 【多节连堂为什么只画在起始行】
 *   "第7-9节" 是一件事。如果 7、8、9 三行都画一遍，同一个任务会在屏幕上出现三次，
 *   点上去也分不清点的是哪一个。所以这里**统一落在起始节次那一行**，
 *   并通过 chip 上的「第7-9节」文字把"它一直上到第9节"讲清楚。
 *   这样每个任务在一天里最多出现一次，空闲统计也不会被同一件事重复占掉三行。
 */

// 只依赖同事已约定的两个模块（签名见 utils/api.js / utils/periods.js）
const api = require('../../utils/api.js');
const periods = require('../../utils/periods.js');

/** 7 列的表头名（顺序固定：0 = 周一） */
const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 一周 7 天：用常量而不是到处写 7，免得哪天漏改一处造成索引错位 */
const DAYS_PER_WEEK = WEEKDAY_NAMES.length;

// ---------------------------------------------------------------------------
// 行高与卡片高度（必须与 week.wxss 里的 .board-row 高度一致！）
// ---------------------------------------------------------------------------
/**
 * 一行（一节课）的固定高度，单位 rpx。
 *
 * 【为什么必须固定】连堂的卡片要"占满它跨越的行"，高度就得是
 * `跨的节数 × 行高 − 间隙`。行高一旦是自适应的（由内容撑开），
 * JS 算出来的高度就和实际行高对不上 —— 卡片不是短一截，就是压住下一行。
 *
 * 【改这里必须同时改 week.wxss】`.board-row` 上写着同一个数值（wxss 里用注释标了
 * 「与 week.js 的 ROW_HEIGHT_RPX 必须一致」）。小程序里 JS 与 WXSS 没有共享常量的
 * 机制，所以两边各写一份、靠注释互相指认；测试里有一条断言把两者对起来，
 * 防止哪天只改了一边。
 *
 * 【为什么取 96】节次栏要放"节次名 + 上下课时间"两行：
 *   节次名 24rpx × 1.25 ≈ 30rpx，时间 20rpx × 1.2 = 24rpx，中间 4rpx 间隔 → 约 58rpx。
 *   96 减掉上下 padding（10 + 10）还剩 76rpx，放得下且不挤。
 * 单节卡片高度 = 96 − 8 = 88rpx，够放"标题一行 + 节次/时间一行"（22 + 18rpx 加间距）。
 */
const ROW_HEIGHT_RPX = 96;

/** 卡片与下一行之间的间隙：卡片高度 = 跨的节数 × 行高 − 这个间隙 */
const CHIP_GAP_RPX = 8;

/**
 * 一张卡片该占多高（rpx）。
 *
 * `跨 1 节 → 96 − 8 = 88`；`跨 3 节 → 288 − 8 = 280`。
 * 减掉间隙是为了让两个相邻的卡片之间留出一条细缝，不然连堂卡会和下一张卡糊在一起。
 *
 * @param {number} spanCount 跨越的节数（≥1）
 * @returns {number} rpx 高度
 */
function chipHeightOf(spanCount) {
  const spans = Math.max(Math.floor(Number(spanCount) || 1), 1);
  return spans * ROW_HEIGHT_RPX - CHIP_GAP_RPX;
}

/** 兜底行的 key：不在任何节次内、也没有时间的任务放这里（不计入空闲节数） */
const FALLBACK_ROW_KEY = 'other';

/** 兜底行的显示名 */
const FALLBACK_ROW_LABEL = '其他时段';

/** 一页最多渲染多少条（防止数据异常时把界面拖死） */
const MAX_TASKS = 600;

// 类型中文名与角标字（放文件顶部：下面几个函数是提升的，调它们时这些常量必须已初始化）
const TYPE_LABELS = { event: '日程', ddl: '截止', subtask: '子任务' };
const MARK_BY_TYPE = { event: '程', ddl: '止', subtask: '务' };

Page({
  data: {
    // --- 周次相关（表头） ---
    weekOffset: 0,          // 0 = 本周；-1 = 上一周；1 = 下一周
    semesterStart: '',      // 学期第一周的周一（YYYY-MM-DD），来自 settings
    weekNo: 0,              // 当前显示的是第几周；0 表示算不出来（没配开学日期）
    weekLabel: '',          // 「第 3 周」/「未设置开学日期」
    rangeText: '',          // 「09-07 ~ 09-13」
    headerText: '',         // 「本周 · 第 3 周 · 09-07 ~ 09-13」

    // --- 左列（节次栏）与网格 ---
    // rows / days 的结构见 buildGrid()：两者用 row.key 对齐，同一下标 = 同一行
    rows: [],
    days: [],

    // --- 页面状态 ---
    loading: true,          // 首次/切换周时的加载态
    errorText: '',          // 加载失败时的提示文案
    hintText: '',           // 非致命提示（例如「未设置开学日期，每周重复的课程不会显示」）
    todayDate: '',          // 今天（YYYY-MM-DD），用于判断哪一列高亮
  },

  /**
   * 生命周期：进入页面时加载一次。
   * 不做"每 60 秒自动刷新"之类的定时器 —— 周课表变化频率低，
   * 下拉刷新已经够用，定时器只会在后台白耗电。
   */
  onLoad() {
    this.loadWeek();
  },

  /** 下拉刷新：重新读任务与设置（保留当前 weekOffset，不把用户弹回本周） */
  onPullDownRefresh() {
    this.loadWeek().then(() => {
      wx.stopPullDownRefresh();
    }).catch(() => {
      wx.stopPullDownRefresh();
    });
  },

  // -------------------------------------------------------------------------
  // 数据加载
  // -------------------------------------------------------------------------

  /**
   * 读「设置 + 全部任务」，然后重算整周。
   *
   * 【为什么要判 ok】utils/api.js 约定「失败不 reject，而是 resolve {ok:false, error}」，
   * 并且失败时它自己已经弹过一次 toast。所以这里必须显式判 ok，
   * 否则请求失败会被当成"一周没有任何任务"，静默显示成空课表 —— 那比报错更难排查。
   *
   * @returns {Promise<void>}
   */
  loadWeek() {
    this.setData({ loading: true, errorText: '' });
    return Promise.all([api.listTasks(), api.getSettings()]).then((results) => {
      const listResult = results[0];
      const settingsResult = results[1];
      if (listResult && listResult.ok === false) throw new Error(describeError(listResult));
      if (settingsResult && settingsResult.ok === false) throw new Error(describeError(settingsResult));

      const tasks = extractTasks(listResult);
      const settings = extractSettings(settingsResult);
      this.tasks = tasks;
      this.semesterStart = settings.semester_start || '';
      this.periodTimes = settings.period_times || null;
      this.renderWeek();
      this.setData({ loading: false, errorText: '' });
    }).catch((err) => {
      // 服务端的 error 由 api.js 弹过 toast 了，这里只把失败落在页面上（不再重复弹一次）
      this.setData({
        loading: false,
        errorText: `加载失败：${describeError(err)}`,
      });
    });
  },

  // -------------------------------------------------------------------------
  // 周切换（weekOffset + setData 刷新）
  // -------------------------------------------------------------------------

  /** 上一周 */
  onPrevWeek() {
    this.shiftWeek(-1);
  },

  /** 下一周 */
  onNextWeek() {
    this.shiftWeek(1);
  },

  /** 回到本周 */
  onThisWeek() {
    this.shiftWeek(-this.data.weekOffset);
  },

  /**
   * 相对当前显示周平移。
   * 平移后**沿用已经取到的 tasks / settings** 直接重排，不再打一次云函数 ——
   * 翻周只是换个日期窗口看同一批任务，重复请求纯属浪费。
   */
  shiftWeek(delta) {
    const next = this.data.weekOffset + delta;
    // 允许往回看历史周，但不让用户翻到离谱的年份里
    if (next < -60 || next > 60) return;
    this.setData({ weekOffset: next });
    this.renderWeek();
  },

  // -------------------------------------------------------------------------
  // 排版
  // -------------------------------------------------------------------------

  /** 按当前 weekOffset 重算表头与网格 */
  renderWeek() {
    const today = todayStr();
    const todayMonday = mondayOf(today);
    const weekMonday = addDays(todayMonday, this.data.weekOffset * 7);
    const tasks = Array.isArray(this.tasks) ? this.tasks : [];
    const override = this.periodTimes;

    // 哪些任务属于这一天：一次性算好 7 天，避免每格重复过滤
    const perDay = [];
    for (let i = 0; i < DAYS_PER_WEEK; i += 1) {
      const date = addDays(weekMonday, i);
      perDay.push(tasks.filter((task) => this.taskOnDate(task, date)));
    }

    const built = buildGrid(perDay, override, weekMonday);

    // 表头：今天那列加高亮 + 显示「空闲 N 节」
    const days = built.days.map((day, index) => ({
      weekday: WEEKDAY_NAMES[index],
      date: day.date,
      short: day.date.slice(5),          // MM-DD
      isToday: day.date === today,
      freeCount: built.freeCounts[index],
      cells: day.cells,
    }));

    const weekNo = this.semesterStart
      ? (periods.weekNumberOf(weekMonday, this.semesterStart) || 0)
      : 0;
    const weekLabel = weekNo ? `第 ${weekNo} 周` : '未设置开学日期';
    const rangeText = `${shortDate(weekMonday)} ~ ${shortDate(addDays(weekMonday, 6))}`;
    const offsetLabel = this.data.weekOffset === 0
      ? '本周'
      : (this.data.weekOffset < 0 ? `上周（${-this.data.weekOffset} 周前）` : `下${this.data.weekOffset} 周`);

    let hintText = '';
    if (!this.semesterStart) {
      hintText = '还没设置开学日期，每周重复的课程不会出现在课表里。';
    }

    this.setData({
      days,
      rows: built.rows,
      weekNo,
      weekLabel,
      rangeText,
      headerText: `${offsetLabel} · ${weekLabel} · ${rangeText}`,
      todayDate: today,
      hintText,
    });
  },

  /**
   * 这条任务在不在某一天。
   *
   * 优先用 utils/periods.js 的 taskOccursOn（不重复的看 date；每周重复的看
   * "周几一致 + 不早于第一次上课 + 周次范围 + 单双周"）。
   * 注意**不要**因为"还没设置开学日期"就跳过它：taskOccursOn 在算不出周次时
   * 故意返回 true（宁可多显示也不把整张课表清空），跳过反而会把课全弄丢。
   * 万一那个函数在运行期不可用（版本不一致），退化成"日期相同"，至少不会白屏。
   */
  taskOnDate(task, date) {
    if (!task) return false;
    if (typeof periods.taskOccursOn === 'function') {
      try {
        return !!periods.taskOccursOn(task, date, this.semesterStart);
      } catch (err) {
        console.warn('[week] taskOccursOn 异常，退回按日期匹配：', err);
      }
    }
    return str(task.date) === date;
  },

  // -------------------------------------------------------------------------
  // 交互
  // -------------------------------------------------------------------------

  /** 点任务条目 → 编辑页 */
  onTapTask(event) {
    const id = event && event.currentTarget && event.currentTarget.dataset
      ? str(event.currentTarget.dataset.id)
      : '';
    if (!id) {
      wx.showToast({ title: '这条数据缺少 id', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: `/pages/edit/edit?id=${id}` });
  },

  /** 空态里的「去添加」按钮 → 新增页（不带 id） */
  onTapAdd() {
    wx.navigateTo({ url: '/pages/edit/edit' });
  },

  /**
   * 【仅测试用】把页面内部用到的纯函数挂出来，供 utils/tests/week_free.test.js 直接调用。
   *
   * 为什么挂在这里而不是另开一个模块：这样测试跑的就是**页面真正在用的那一份实现**，
   * 不会出现"测的是一份、跑的是另一份"。小程序框架只会调用它认识的生命周期与事件
   * 方法（onLoad/onShow/onXxx），这个下划线开头的键永远不会被触发。
   *
   * 【为什么必须常驻】「空闲节数」这个 bug 曾经在真机上活了一整个版本 ——
   * 当时六份测试文件全绿，但没有一条断言"空闲 = 总行数 − 被占用的行数"。
   * 只有把 buildGrid 暴露出来，才可能在纯 node 里对这条等式下断言。
   */
  __test: {
    buildGrid: buildGrid,
    occupiedRowsOfDay: occupiedRowsOfDay,
    periodSpanOf: periodSpanOf,
    locateRow: locateRow,
    chipHeightOf: chipHeightOf,
    ROW_HEIGHT_RPX: ROW_HEIGHT_RPX,
    CHIP_GAP_RPX: CHIP_GAP_RPX,
  },
});

// ---------------------------------------------------------------------------
// 网格计算（纯函数，方便单独推演；不碰 this，也不发请求）
// ---------------------------------------------------------------------------

/**
 * 把「每天的任务」排成「行 × 列」的网格。
 *
 * @param {Array<Array<object>>} perDay 恰好 DAYS_PER_WEEK（7）个数组，下标 0 = 周一
 * @param {object|null} override 校准过的作息表 {"5": ["11:45","12:25"], ...}
 * @param {string} weekMonday 本周周一（YYYY-MM-DD），用来兜底日期
 * @returns {{rows: Array, days: Array, freeCounts: Array<number>}}
 *          rows[i].key 与 days[d].cells[i].key 一一对应
 */
function buildGrid(perDay, override, weekMonday) {
  // 1) 行：默认作息 ∪ 校准到的节次 ∪ 任务里写过的节次（学校一天 13 / 14 节都可能）
  const extra = [];
  perDay.forEach((list) => {
    list.forEach((task) => {
      const span = periodSpanOf(task);
      if (span) {
        for (let n = span[0]; n <= span[1]; n += 1) extra.push(n);
      }
    });
  });
  const periodRows = periods.periodRows(override, extra);

  const rows = [];
  const rowIndexOfPeriod = {}; // 节次号 → 行下标（用于把 periods 映射到行）
  periodRows.forEach((row, index) => {
    const number = row[0];
    const label = periods.rowLabel(row, override) || `第${number}节`;
    const range = periods.rowTimeRange(row, override) || ['', ''];
    const isBreak = !!periods.breakLabel(number, override); // 只有左右紧邻两节都校准过才算
    rows.push({
      key: String(number),
      number,
      label,
      timeText: range[0] && range[1] ? `${range[0]}-${range[1]}` : (range[0] || range[1] || ''),
      isBreak,
    });
    rowIndexOfPeriod[number] = index;
  });

  // 2) 先把每条任务定位到「起始行」
  const buckets = [];
  for (let i = 0; i < rows.length; i += 1) buckets.push([]);
  let otherIndex = -1; // 「其他时段」行：有了才追加，没有就不占地方
  const ensureOtherRow = () => {
    if (otherIndex === -1) {
      otherIndex = rows.length;
      rows.push({
        key: FALLBACK_ROW_KEY,
        number: 0,
        label: FALLBACK_ROW_LABEL,
        timeText: '',
        isBreak: false,
      });
      buckets.push([]);
    }
    return otherIndex;
  };

  perDay.forEach((list, dayIndex) => {
    list.slice(0, MAX_TASKS).forEach((task) => {
      const target = locateRow(task, rowIndexOfPeriod, override);
      const index = target === -1 || buckets[target] === undefined ? ensureOtherRow() : target;
      buckets[index].push({ dayIndex, task });
    });
  });

  // 3) 空的「其他时段」行不留着（课表不该多一条永远空着的横线）
  if (otherIndex !== -1 && buckets[otherIndex].length === 0) {
    rows.pop();
    buckets.pop();
  }

  // 4) 铺成 7 列；同一行里多条任务都塞进同一个 cell，由 WXSS 并排排列
  const days = [];
  for (let d = 0; d < DAYS_PER_WEEK; d += 1) {
    const cells = rows.map((row, rowIndex) => ({
      key: row.key,
      tasks: buckets[rowIndex]
        .filter((item) => item.dayIndex === d)
        .map((item) => viewTask(item.task)),
    }));
    days.push({ date: addDays(weekMonday, d), cells });
  }

  // 5) 空闲节数 = 「真正的课」总行数 − 这一天**被占用的行数**
  //
  // 【为什么不能复用 buckets（血泪教训）】buckets 是"每个任务只放进**起始行**"的桶，
  // 那是给"画"用的规则（见文件头：连堂只画在起始行，避免同一件事出现三次）。
  // 但空闲统计如果也用它，一条「第3-4节」就只算占了 1 行 —— 第 4 节会被当成空着。
  // 真机上就是这样：周一显示"空闲 10 节"，而实际被占 5 节、空闲应该是 8 节，
  // 两列都恰好等于 「总行数 − 卡片数」，一眼就能看出数错了对象。
  // 所以这里**另算一份"被占用的行"**：一条任务覆盖到的每一行都算被占。
  //
  // 两条既有排除规则保持不变：
  //   * row.isBreak（午休 / 休息空档）不计入空闲
  //   * FALLBACK_ROW_KEY（"其他时段"兜底行）不计入空闲
  const freeCounts = [];
  for (let d = 0; d < DAYS_PER_WEEK; d += 1) {
    const occupied = occupiedRowsOfDay(buckets, rows, rowIndexOfPeriod, d);
    let free = 0;
    rows.forEach((row, rowIndex) => {
      if (row.isBreak || row.key === FALLBACK_ROW_KEY) return; // 空档行与兜底行都不算
      if (!occupied[rowIndex]) free += 1;
    });
    freeCounts.push(free);
  }

  return { rows, days, freeCounts };
}

/**
 * 算出某一天「被占用的行」——一条任务把它 span 覆盖到的**每一行**都标为占用。
 *
 * 与渲染用的 buckets 是两份数据，故意的：渲染要"连堂只画一次"，
 * 统计要"每一节都算真的被占了"（见上面第 5 步的长注释）。
 *
 * @param {Array<Array<{dayIndex: number, task: object}>>} buckets 每个任务只出现在它的起始行
 * @param {Array<object>} rows 行数组（用来索引）
 * @param {object} rowIndexOfPeriod 节次号 → 行下标
 * @param {number} dayIndex 0 = 周一
 * @returns {Array<boolean>} 长度与 rows 相同；true = 这一行在这一天被占了
 */
function occupiedRowsOfDay(buckets, rows, rowIndexOfPeriod, dayIndex) {
  const occupied = [];
  for (let i = 0; i < rows.length; i += 1) occupied.push(false);

  buckets.forEach((items) => {
    items.forEach((item) => {
      if (!item || item.dayIndex !== dayIndex) return;
      const span = periodSpanOf(item.task);
      if (!span) {
        // 没有 span 的（落进「其他时段」的兜底任务）不占任何课节行，保持原样
        return;
      }
      for (let n = span[0]; n <= span[1]; n += 1) {
        const index = rowIndexOfPeriod[n];
        // 越界的节次号（例如写了"第14节"但表里只有 13 行）安全忽略
        if (index !== undefined && occupied[index] !== undefined) occupied[index] = true;
      }
    });
  });

  return occupied;
}

/**
 * 任务落在哪一行。
 *   1. 有 periods（"7-9"）→ 用它的起始节次定位（最准，是用户/导入时明确写下的）
 *   2. 没有 periods 但有时间 → 用 periods.periodSpanFromTimes 反推起始节次
 *      （只填了结束时间也能定位，这是 Python 版的行为）
 *   3. 都没有 → -1，交给「其他时段」
 *
 * @returns {number} 行下标；定位不到返回 -1
 */
function locateRow(task, rowIndexOfPeriod, override) {
  let span = periodSpanOf(task);
  if (!span) {
    const startTime = str(task.start_time);
    const endTime = str(task.end_time);
    if (!startTime && !endTime) return -1;
    const derived = periods.periodSpanFromTimes(startTime, endTime, override);
    if (!derived) return -1;
    span = derived;
  }
  for (let n = span[0]; n <= span[1]; n += 1) {
    if (rowIndexOfPeriod[n] !== undefined) return rowIndexOfPeriod[n];
  }
  return -1;
}

/** 解析 task.periods（"7-9" / "7" / [7,9]）→ [起, 止]；解析不出来返回 null */
function periodSpanOf(task) {
  const raw = task ? task.periods : '';
  const span = periods.parsePeriodSpan(raw);
  if (span && span.length === 2) return span;
  // 极少数情况后端可能存成数组，多兜一层
  if (Array.isArray(raw) && raw.length) {
    const numbers = raw
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item) && item > 0);
    if (numbers.length) {
      return [Math.min.apply(null, numbers), Math.max.apply(null, numbers)];
    }
  }
  return null;
}

/**
 * 交给 WXML 的条目视图模型。
 * WXML 里不能写复杂表达式，所以标题截断、角标开关都在这里算好。
 */
function viewTask(task) {
  const span = periodSpanOf(task);
  let periodText = '';
  if (span) periodText = span[0] === span[1] ? `第${span[0]}节` : `第${span[0]}-${span[1]}节`;

  // 卡片高度按"跨了几节"算（连堂的卡要占满它跨过的行，否则看起来只上了一节）。
  // 没有 span 的（落进「其他时段」的兜底任务）就占一格。
  const spanCount = span ? (span[1] - span[0] + 1) : 1;
  const blockHeight = chipHeightOf(spanCount);

  const start = str(task.start_time);
  const end = str(task.end_time);
  let timeText = '';
  if (start && end) timeText = `${start}-${end}`;
  else if (start) timeText = start;
  else if (end) timeText = `${end} 前`; // 只填结束时间（例如「11:30 前完成」）

  const type = str(task.type) || 'event';

  return {
    id: str(task._id),
    title: str(task.title) || '(无标题)',
    shortTitle: truncate(str(task.title) || '(无标题)', 8),
    type,
    typeLabel: TYPE_LABELS[type] || '日程',
    done: task.done === true,
    priority: str(task.priority) || 'mid',
    periodText,
    timeText,
    metaText: [periodText, timeText].filter(Boolean).join(' · '),
    mark: MARK_BY_TYPE[type] || '程',
    isDdl: type === 'ddl',
    isSubtask: type === 'subtask',
    highPriority: str(task.priority) === 'high',
    spanCount,
    blockHeight,
    // top / 高度 / 层级都由 JS 给，这样"行高、间隙、卡片高度"只有一个来源。
    // position:relative 写在 inline 上（而不是靠 class）：卡片本来就在文档流里，
    // 只是多一个高度 + 层级，最坏情况（样式没生效）也只是退回一格高。
    blockStyle: `position:relative;top:${CHIP_GAP_RPX / 2}rpx;`
      + `height:${blockHeight}rpx;z-index:${spanCount > 1 ? 2 : 1};`,
    isBlock: spanCount > 1,
  };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 一律转成去空白的字符串（云数据库里字段类型不可控，渲染前统一一次） */
function str(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** 超长标题截断（完整标题靠点击进编辑页看） */
function truncate(text, max) {
  const raw = str(text);
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

/** "2026-09-07" → "09-07" */
function shortDate(dateStr) {
  const text = str(dateStr);
  return text.length >= 10 ? text.slice(5) : text;
}

/** 今天（本地时区的日历日，与 utils/periods.js 的口径一致） */
function todayStr() {
  return formatDay(new Date());
}

/** Date → "YYYY-MM-DD" */
function formatDay(date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function pad2(number) {
  return number < 10 ? `0${number}` : String(number);
}

/** "YYYY-MM-DD" → 本地 00:00 的 Date（不用 new Date(str)，那会按 UTC 解析） */
function parseDay(dateStr) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(dateStr));
  if (!matched) return null;
  const date = new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 某一天所在周的周一（YYYY-MM-DD） */
function mondayOf(dateStr) {
  const date = parseDay(dateStr);
  if (!date) return '';
  const weekday = (date.getDay() + 6) % 7; // 0 = 周一
  date.setDate(date.getDate() - weekday);
  return formatDay(date);
}

/** 日期加天数（YYYY-MM-DD） */
function addDays(dateStr, days) {
  const date = parseDay(dateStr);
  if (!date) return '';
  date.setDate(date.getDate() + Number(days || 0));
  return formatDay(date);
}

/**
 * 从 api.listTasks() 的返回值里取任务数组。
 * 约定是 {ok, data:{tasks:[...]}}，但为了不让"少一层/多一层"直接把页面搞白，
 * 这里把几种可能都认了。
 */
function extractTasks(result) {
  if (!result) return [];
  const data = result.data === undefined ? result : result.data;
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.tasks)) return data.tasks;
  if (Array.isArray(result.tasks)) return result.tasks;
  return [];
}

/** 从 api.getSettings() 的返回值里取 {semester_start, period_times} */
function extractSettings(result) {
  const empty = { semester_start: '', period_times: null };
  if (!result) return empty;
  const data = result.data === undefined ? result : result.data;
  if (!data || typeof data !== 'object') return empty;
  const start = str(data.semester_start);
  const times = data.period_times && typeof data.period_times === 'object' ? data.period_times : null;
  return {
    semester_start: /^\d{4}-\d{2}-\d{2}$/.test(start) ? start : '',
    period_times: times,
  };
}

/** 把异常/返回对象里的 error 变成一句能给用户看的话 */
function describeError(err) {
  if (!err) return '未知错误';
  if (typeof err === 'string') return err;
  if (err.errMsg) return str(err.errMsg);
  if (err.message) return str(err.message);
  if (err.error) return str(err.error);
  return '未知错误';
}
