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
 *
 * ===========================================================================
 * 【"占几行"只有一个口径：resolveSpan / rowSpanFromTimes】
 * ===========================================================================
 *   一个任务的**落点行、占用行数、卡片高度**必须来自同一个函数，
 *   否则就会出现这一页历史上反复出现的三种症状（每一种都在真机上活过）：
 *     * 卡片画在第 3 节行，第 3 节却仍算空闲；
 *     * 卡片明明跨两节课，却只有一格高；
 *     * 「参加双选会 14:00-18:00」跨第 5~8 节，却画成一格高、只扣 1 节空闲。
 *   现在的调用关系（改这里之前请先读完）：
 *     resolveSpan ─┬─ locateRow（落点）          ← buildGrid 第 2 步
 *                  ├─ occupiedRows（被占的行）    ← occupiedRowsOfDay → freeCounts
 *                  └─ blockRows（卡片盖的行） ───→ buildGrid 第 4 步 → viewTask 的 spanCount
 *   三条边都从 rowSpanFromTimes 拿行下标，**没有任何一处自己重算**。
 *   但注意 `occupiedRows` 与 `blockRows` **可以不是同一个集合**（这是故意的，详见
 *   rowSpanFromTimes 的注释）：占用算的是"这段时间被占住了"（含午休那 15 分钟），
 *   卡片高度算的是"盖住几节真课"（从 14:15 的第 7 节画起）。
 *   把两者硬绑成一个数，就只能在"卡片从午休行开始画"和"少扣一节空闲"之间二选一 ——
 *   而这两个都是错的（两轮真机反馈各证明了其中一个）。
 *   "结束分钟数"（缺 end / 倒挂怎么办）也只有一个来源：endMinuteOf + busyLengthOf，
 *   数值口径与 utils/planner.js 的 busyRangeOfTask 一致（那边也是"有 start 就往后推"）。
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

/**
 * 只有开始时间、又没写预计耗时时，往后推多少分钟算它的长度。
 * 与 utils/planner.js 的 DEFAULT_BUSY_MINUTES 保持一致（那边"没写预计耗时按 30 分钟兜底"）。
 */
const DEFAULT_BUSY_MINUTES = 30;

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

  /**
   * 【切回本页时重新拉一次 —— 这条不能删】
   *
   * pages/week 是 **tabBar 页**，而 tab 页在切走再切回时**不会重新执行 onLoad**
   * （页面实例一直活着，只是被切到后台）。所以"在编辑页删掉一条子任务/截止"
   * 或"新增一条日程"之后切回课表，卡片当然还是旧的 —— 真机上用户报的
   * 「删除后没变化」「新加的日程不显示」就是这个根因，两条现象同一个原因。
   *
   * 写法与 pages/tasks/tasks.js 的 onShow 完全一致：
   * 用 loadedOnce 挡住**首次**显示（onLoad 已经拉过一次，不然启动就连发两次请求），
   * 之后每次显示都重拉并重画网格。
   */
  onShow() {
    // 首次 onLoad 已经拉过一次；这里用 loadedOnce 避免刚进页面连发两次请求
    if (this.loadedOnce) this.loadWeek();
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
   * ===========================================================================
   * 【首次加载 vs 之后的静默刷新 —— 两种失败要区别对待】
   * ===========================================================================
   *   tab 切换是**高频动作**：每次切回课表都会走一次 onShow → loadWeek。
   *   如果每次重拉都先置 `loading: true`，用户每次切回来都会闪一下"正在加载课表"
   *   的骨架态 —— 页面明明已经有内容了，闪一下比"短暂看到旧数据"更难受。
   *   所以：
   *     * **首次**加载（loadedOnce 还是 false，页面上什么都没有）→ 照旧显示 loading；
   *     * **之后的**刷新 → 不动 `loading`，保持当前内容，拉到新数据再**一次性重画**
   *       （renderWeek 里是整体 setData，不会出现半新半旧）。
   *
   *   失败同理要分开：
   *     * 首次失败 → 整页错误态（页面上本来就没内容，必须告诉他）；
   *     * 之后刷新失败 → **保留用户已经看到的课表**，只把一句轻提示挂在 errorText 之外，
   *       绝不用"刷新失败"把已经渲染好的网格清掉。
   *       （服务端的 error 由 api.js 弹过 toast，所以这里连 toast 都不用再补。）
   *
   * @returns {Promise<void>}
   */
  loadWeek() {
    // 首次加载才显示骨架态；之后的刷新静默替换（见上面那段取舍）。
    // 判据就用 loadedOnce：onLoad 调它时还是 false，onShow 重拉时已经是 true。
    const firstLoad = this.loadedOnce !== true;

    if (firstLoad) {
      this.setData({ loading: true, errorText: '' });
    }
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
      // 标记"已经加载过一次"：onShow 靠它区分"首次显示"（onLoad 刚拉过，不重复拉）
      // 与"从别的页面切回来"（必须重拉，否则看不到别处的增删）
      this.loadedOnce = true;
      this.setData({ loading: false, errorText: '' });
    }).catch((err) => {
      const message = describeError(err);
      if (firstLoad) {
        // 服务端的 error 由 api.js 弹过 toast 了，这里只把失败落在页面上（不再重复弹一次）
        this.setData({ loading: false, errorText: `加载失败：${message}` });
        return;
      }
      // 【之后的刷新失败：保留旧内容】不置 errorText（那会把整页变成错误态、
      // 把用户已经看到的课表清掉），只在控制台留一条线索。
      this.setData({ loading: false });
      console.warn('[week] 静默刷新失败，保留已有课表：', message);
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
    // 卡片高度的唯一来源：测试要直接对"跨了几行"下断言，而不是只看渲染结果
    resolveSpan: resolveSpan,
    spanFor: spanFor,
    rowSpanFromTimes: rowSpanFromTimes,
    viewTask: viewTask,
    bestOverlapPeriod: bestOverlapPeriod,
    chipHeightOf: chipHeightOf,
    ROW_HEIGHT_RPX: ROW_HEIGHT_RPX,
    CHIP_GAP_RPX: CHIP_GAP_RPX,
    // 加载链路的两个取值口：onShow 那组断言要按真实契约喂数据
    // （{ok:true, data:{tasks}} / {ok:true, ...settings}），而不是测试里另抄一份形状
    extractTasks: extractTasks,
    extractSettings: extractSettings,
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
      // 【真实课节 vs 空档行】isBreak 是"这一行在模板上长什么样"（灰底、写「午休」），
      // isClass 是"这一行算不算一节课"。现在两者互补，但**不要合并成一个字段**：
      // 模板只关心外观，跨度计算只关心"算不算课" —— 哪天想让空档行换个样式，
      // 不该顺手把跨度口径也改掉。跨度两端只在 isClass 行之间取（见 rowSpanFromTimes）。
      isClass: !isBreak,
      // 显式给 false：模板里用 row.isFallback 区分「其他时段」兜底行，
      // 字段先在 data 里初始化好，免得渲染出 undefined（本页一直遵守这条）
      isFallback: false,
    });
    rowIndexOfPeriod[number] = index;
  });

  // 2) 先把每条任务定位到「起始行」
  const buckets = [];
  for (let i = 0; i < rows.length; i += 1) buckets.push([]);
  /**
   * 「其他时段」兜底行：**放在表头正下方（rows[0]）**，不放最后。
   *
   * 【为什么必须挪到最前】放最后时，用户得把 13 行课节全滑到底才看得见它 ——
   * 真机上就等于"截止和子任务没显示出来"（那些时间落在默认作息的午休空档里，
   * 定位不到课节行，全被兜到这里）。挪到第一行，它们一进页面就看得见。
   *
   * 【挪动时必须一起维护的东西】rows 与 buckets 是**同下标并行**的两份数组，
   * rowIndexOfPeriod 又是"节次号 → 行下标"的映射：
   *   * 用 unshift 同时给 rows 与 buckets 头部插一项 → 两者仍然一一对应；
   *   * 插完把 rowIndexOfPeriod 里所有下标 +1，否则课节行会全部错位一行。
   * 这三件事任何一件漏掉，卡片就会画到别的行上去。
   */
  let otherIndex = -1;
  const ensureOtherRow = () => {
    if (otherIndex === -1) {
      rows.unshift({
        key: FALLBACK_ROW_KEY,
        number: 0,
        label: FALLBACK_ROW_LABEL,
        timeText: '',
        isBreak: false,
        // 兜底行不是课、也不是"空档"，它是"放不进任何一行"的收容所：
        // isClass=false 让它不参与跨度的两端（否则它会把锚点吸到表头第一行）。
        isClass: false,
        isFallback: true,
      });
      buckets.unshift([]);
      Object.keys(rowIndexOfPeriod).forEach((number) => {
        rowIndexOfPeriod[number] += 1;
      });
      otherIndex = 0;
    }
    return otherIndex;
  };

  perDay.forEach((list, dayIndex) => {
    list.slice(0, MAX_TASKS).forEach((task) => {
      const target = locateRow(task, rows, rowIndexOfPeriod, override);
      const index = target === -1 || buckets[target] === undefined ? ensureOtherRow() : target;
      buckets[index].push({ dayIndex, task });
    });
  });

  // 3) 空的「其他时段」行不留着（课表不该多一条永远空着的横线）
  //    它在最前面，所以摘掉要用 shift；同时把 rowIndexOfPeriod 的下标减回去，
  //    让"节次号 → 行下标"这个映射始终是准的。
  if (otherIndex !== -1 && buckets[otherIndex].length === 0) {
    rows.shift();
    buckets.shift();
    Object.keys(rowIndexOfPeriod).forEach((number) => {
      rowIndexOfPeriod[number] -= 1;
    });
    otherIndex = -1;
  }

  // 4) 【卡片要画多高】没有 periods 的任务，按它**真正跨了几节真实课**来定高度。
  //
  // 真机反馈：周四「参加双选会 14:00-18:00」（手工/AI 加进来的日程，没有 periods）
  // 被画成**一格高**，而它实际跨了第 5~8 节共 4 行。用户的原话是
  // "这个双选会的篇幅是不是起码要覆盖到第八节课呢" —— 这是对的：
  // 卡片高度过去只来自 task.periods，没写 periods 就一律 1 行。
  //
  // 【高度取 heightFrom/heightTo，不是 from/to】用户的校准作息里午休行是 12:25-14:15，
  // 而双选会 14:00 开始 —— 14:00 落在午休行里面。取 from/to 会把卡片从**午休行**
  // 开始画（暗示"12:25 就开始了"）；取 heightFrom/heightTo 则从第 7 节（14:15）画起，
  // 高度 4 行。占用仍是含午休的整段（from/to），所以「空闲 N 节」不变。
  //
  // 【为什么在这里算、而不是在 viewTask 里现算】rowSpanFromTimes 要拿**最终的行列表**
  // （这时「其他时段」兜底行该插的插了、该摘的摘了，行下标才是最终下标）。
  // viewTask 是纯的"一条任务 → 一个视图模型"，不该反过来依赖整张网格；
  // 所以由 buildGrid 先算好一张 task._id → 行数 的表交给它。
  //
  // 【口径】与 occupiedRowsOfDay 的占用行、resolveSpan 的落点**同一个来源**
  // （都是 rowSpanFromTimes），这样"画多高"和"占几行"不可能再各自算飞。
  const rowSpans = {};
  perDay.forEach((list) => {
    list.forEach((task) => {
      const id = str(task && task._id);
      if (!id || rowSpans[id] !== undefined) return;
      if (periodSpanOf(task)) return;           // 写了 periods 的走既有口径，一行都不动
      const span = rowSpanFromTimes(task, rows, override);
      // 定位不到（进「其他时段」的）保持 1 行：兜底行里只有一格的容身之处
      rowSpans[id] = span ? (span.heightTo - span.heightFrom + 1) : 1;
    });
  });

  // 5) 铺成 7 列；同一行里多条任务都塞进同一个 cell，由 WXSS 并排排列
  const days = [];
  for (let d = 0; d < DAYS_PER_WEEK; d += 1) {
    const cells = rows.map((row, rowIndex) => ({
      key: row.key,
      tasks: buckets[rowIndex]
        .filter((item) => item.dayIndex === d)
        .map((item) => viewTask(item.task, rowSpans)),
    }));
    days.push({ date: addDays(weekMonday, d), cells });
  }

  // 6) 空闲节数 = 「真正的课」总行数 − 这一天**被占用的行数**
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
    const occupied = occupiedRowsOfDay(buckets, rows, rowIndexOfPeriod, d, override);
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
 * 统计要"每一节都算真的被占了"（见上面第 6 步的长注释）。
 *
 * ===========================================================================
 * 【截止（ddl）不占节次】—— 与 utils/planner.js 的 busyRangesOfDay 保持同一口径
 * ===========================================================================
 *   ddl 的语义是"某个时刻之前必须完成"，它**不是一段被占住的时间**：
 *   12:00 交材料，不代表 11:45-12:25 这一节你上不了别的课。
 *   编辑页的占用提示（planner.busyRangesOfDay）早就是这个口径：
 *   "ddl 只有截止时刻 → 不产生占用区间"。
 *
 *   同一个问题（"一条截止算不算占了这段时间"）如果在两个页面给出相反答案，
 *   评审一眼就能看出是洞 —— 所以这里排除 ddl，让它与编辑页一致。
 *
 *   【注意】只是**不计入空闲统计**：ddl 的卡片照旧画在它到期时刻对应的那一行
 *   （可见性不能退，用户就是要看到"12:00 前要交材料"）。所以这里不能去改
 *   buildGrid 的 buckets —— 那会让卡片直接消失。这又是一次"排版与统计不能
 *   共用同一个数据结构"：排版要它在，统计要不数它。
 *
 * 【占用口径 = resolveSpan 的 occupiedRows】
 *   一条任务占哪几行，**只认 resolveSpan 一个来源**（上一版这里自己拼
 *   `rangeOf(span[0], span[1])`，而 span 是节次号；一旦落点改用"最大重叠"，
 *   节次号区间和真实跨行就不是一回事了）。三种情形：
 *     * 写了 periods（"7-9"）→ 第 7~9 节对应的行，与旧口径完全一致；
 *     * 只有 end_time（截止）→ occupiedRows 是空数组 → 一行都不占；
 *     * 有时间段（"14:00-18:00"）→ 真正与它相交的每一行，**中间夹着的午休行也算**
 *       （卡片要占掉那一格的高度，空闲统计也就不能把那格算成空的）。
 *
 * @param {Array<Array<{dayIndex: number, task: object}>>} buckets 每个任务只出现在它的起始行
 * @param {Array<object>} rows 行数组（用来索引）
 * @param {object} rowIndexOfPeriod 节次号 → 行下标
 * @param {number} dayIndex 0 = 周一
 * @param {object|null} override 校准过的作息表（resolveSpan 要用，必须与排版同源）
 * @returns {Array<boolean>} 长度与 rows 相同；true = 这一行在这一天被占了
 */
function occupiedRowsOfDay(buckets, rows, rowIndexOfPeriod, dayIndex, override) {
  const occupied = [];
  for (let i = 0; i < rows.length; i += 1) occupied.push(false);

  // 【口径缓存：task._id → occupiedRows】buckets 里同一条任务可能出现多次
  // （连堂的每一节各自算一次落点会得到同一个结果），缓存一下省掉重复的时间换算，
  // 也保证同一条任务在"画"和"统计"两条路径上拿到的是**同一个数组**。
  const spanCache = {};

  buckets.forEach((items) => {
    items.forEach((item) => {
      if (!item || item.dayIndex !== dayIndex) return;
      // 截止只标出到期时刻，不占时间（与 planner.busyRangesOfDay 同口径）
      if (str(item.task && item.task.type) === 'ddl') return;

      const task = item.task || {};
      const cacheKey = str(task._id);
      let rows0 = cacheKey ? spanCache[cacheKey] : null;
      if (!rows0) {
        // 【与 locateRow / viewTask 共用同一个口径】否则会出现
        // "卡片画在第 3 节行、第 3 节却算空闲"这类排版与统计打架的问题。
        rows0 = resolveSpan(task, rows, rowIndexOfPeriod, override).occupiedRows || [];
        if (cacheKey) spanCache[cacheKey] = rows0;
      }
      rows0.forEach((index) => {
        // 越界（例如写了"第14节"但表里只有 13 行）安全忽略
        if (occupied[index] !== undefined) occupied[index] = true;
      });
    });
  });

  return occupied;
}

/**
 * 一条任务"落在哪一行、占哪几行"的统一口径 —— **排版（locateRow / viewTask）
 * 与统计（occupiedRowsOfDay）都必须走它**。
 *
 * 【为什么必须唯一】这个仓库已经因为"排版与统计各算一套"踩过四次坑：
 * 最近的一次是卡片画在第 3 节行、而第 3 节却仍算空闲。所以：
 * **同一条任务，"画多高"和"占几行"必须来自同一个口径。**
 *
 * 【落点怎么定（locateRow 的旧注释，现已合并到这里）】
 *   1. 有 periods（"7-9"）→ 用它的起始节次定位（最准，是用户/导入时明确写下的）
 *   2. 没有 periods 但有**起止时间** → 取"与 [start,end] 重叠分钟数最多"的那一节
 *   3. 只有 end_time（截止）→ 照旧用 periods.periodSpanFromTimes 的"结束时刻包含判定"
 *   4. 都没有 → -1，交给「其他时段」
 *
 * 【第 2 条为什么要按"最大重叠"挑，而不是照抄 periodSpanFromTimes】
 *   periodSpanFromTimes 是**就位吸附**：它先看"起点属于哪一节"，起点不在任何一节里
 *   才退回按结束时刻定位。于是会挑出一节**跟这条任务几乎没关系**的行：
 *     * 「09:55-10:55」默认作息 → 起点 09:55 不属于任何一节 → 退回按结束时刻 10:55
 *       → 10:55 恰好是第 4 节的开始（包含判定含端点）→ 落第 4 节行，
 *       而它与第 4 节的重叠是 **0 分钟**（它真正占的是第 3 节 10:00-10:45 那 45 分钟）。
 *   用户看到"时间写着 09:55-10:55、卡片却在第 4 节那一行"，就是我们一直在修的那类
 *   "时间与显示对不上"。所以**只在这一条路径上**改用最大重叠：
 *   与当天所有节次逐一算重叠分钟数，取最大的那一节；**最大重叠 ≤ 0 才返回 -1**
 *   （跟哪一节都没交集 → 交给「其他时段」，它现在就在表头下方第一行，一眼能看到，
 *   卡片上还写着自己的时间）。并列时取节次号小的（与 periodNumberAt 的既有排序一致）。
 *
 * 【这一条不比就落空】「09:40-10:40」起点 09:40 被第 2 节包含（含端点）但重叠 0 分钟，
 *   而第 3 节有 40 分钟 —— 按"起点所在节必须有重叠"判会把它误伤进兜底行，
 *   按最大重叠判才会正确地落到第 3 节。
 *   （空档行/午休行照样参与这个比较，理由见 bestOverlapPeriod 的注释。）
 *
 * 【绝不改动 periodSpanFromTimes 本身】它是全项目共用口径（编辑页的冲突提示等也在用），
 *   这里只是页面自己的"落在哪一行"选择器。
 *
 * 返回的三个东西：
 *   * `landingRow`：落点行下标（卡片画在这一格）；定位不到是 -1
 *   * `occupiedRows`：这条任务真正占住的行下标（**连续**，含中间夹着的午休行）；
 *     它决定「空闲 N 节」要不要减 —— 截止是空数组（只标时刻，不占时间）
 *   * `degenerate`：是不是"零长"（只有 end_time 的截止、或 end 缺失/倒挂）——
 *     零长只占落点那一行、且不占时间
 *
 * @returns {{landingRow: number, occupiedRows: number[], degenerate: boolean}}
 */
function resolveSpan(task, rows, rowIndexOfPeriod, override) {
  const list = Array.isArray(rows) ? rows : [];

  // ① 有 periods（"7-9"）：连堂的既有口径，一行都不动
  const byPeriods = periodSpanOf(task);
  if (byPeriods) {
    const periodRows = [];
    for (let n = byPeriods[0]; n <= byPeriods[1]; n += 1) {
      const index = rowIndexOfPeriod ? rowIndexOfPeriod[n] : undefined;
      if (index !== undefined) periodRows.push(index);
    }
    return { landingRow: periodRows.length ? periodRows[0] : -1,
      occupiedRows: periodRows, degenerate: false };
  }

  const startTime = str(task.start_time);
  const endTime = str(task.end_time);
  // 一个时间都没写 → 交给「其他时段」（它就在表头下方第一行，一眼能看到）
  if (!startTime && !endTime) return { landingRow: -1, occupiedRows: [], degenerate: false };

  // ② 只有 end_time（典型是 ddl）走"结束时刻包含判定"。
  // 一条 12:00 的截止是零长区间，与第 5 节的重叠是 0 分钟 —— 若把它也套上最大重叠，
  // 它会掉进「其他时段」，"截止与子任务不出现在时间表里"那个问题立刻复活。
  // 截止的语义就是"标出到期时刻"，本来就该吸附到那个时刻所在的那一节，且**不占时间**。
  if (!startTime) {
    const byEnd = periods.periodSpanFromTimes('', endTime, override);
    if (!byEnd) return { landingRow: -1, occupiedRows: [], degenerate: false };
    const index = rowIndexOfPeriod ? rowIndexOfPeriod[byEnd[0]] : undefined;
    return { landingRow: index === undefined ? -1 : index, occupiedRows: [], degenerate: true };
  }

  // ③ 有 start_time 的时间任务：落点 = **真实课节跨度**的第一行；占用 = 含空档的整段行。
  //
  // 【这一步就是真机那条「参加双选会 14:00-18:00」的修复，改过两轮】
  //   第一轮：以前这里只返回落点那一节 → 卡片一格高、只扣 1 节空闲（用户问"篇幅
  //     是不是起码要覆盖到第八节课"）。改成按时间跨度算。
  //   第二轮（本次）：用户的校准作息里**午休行是 12:25-14:15**，双选会 14:00 开始 ——
  //     14:00 落在午休行**里面**（重叠 15 分钟），于是"跨度第一行"把锚点定到了午休行，
  //     卡片从 12:25 那一行开始画，而卡上时间文字写着 14:00-18:00。
  //     用户原话："视觉上等于暗示这个活动 12:25 就开始了"。
  //   ⇒ **锚点与高度只在 isClass（真实课节）行之间取**；占用跨度保持含空档。
  //
  // 【为什么落点不是"重叠最多的那一节"】卡片是**画在落点那一格里、靠 height 往下盖**的
  //   （见 viewTask 的 blockStyle）。校准作息下「10:00-14:30」重叠最多的那一行是午休行
  //   （12:25-14:15，重叠 110 分钟）—— 按最大重叠落点，卡片会从午休行开始往下盖，
  //   顶端就落在 12:25 上，又一次"暗示它 12:25 开始"。所以按重叠挑落点这条路，
  //   在这里是**故意的反面教材**：它只在"连一行真实课节都没碰到"时作为兜底使用。
  const degenerate = lacksTrustedEnd(task);   // 结束时间不可信（缺 / 倒挂）—— 仅用于标注

  let occupied = [];
  let blockRows = [];      // 卡片真正要盖住的行（只含真实课节行）
  if (!isZeroLengthInterval(task)) {
    const rowSpan = rowSpanFromTimes(task, list, override);
    if (rowSpan) {
      for (let i = rowSpan.from; i <= rowSpan.to; i += 1) occupied.push(i);
      for (let i = rowSpan.heightFrom; i <= rowSpan.heightTo; i += 1) blockRows.push(i);
    }
  }

  // 【兜底】算不出跨度（时间落在所有行的空隙里，例如默认作息下的午休时段）→
  //   退回"重叠最多"的吸附口径。它对任何行都没有真实重叠时返回 -1 → 交给「其他时段」。
  if (!occupied.length) {
    const best = bestOverlapPeriod(startTime, endTime, override);
    if (best === null) {
      return { landingRow: -1, occupiedRows: [], blockRows: [], degenerate: degenerate };
    }
    const anchor = rowIndexOfPeriod ? rowIndexOfPeriod[best] : undefined;
    if (anchor === undefined) {
      return { landingRow: -1, occupiedRows: [], blockRows: [], degenerate: false };
    }
    // 零长区间只占落点那一行（它是"一个时刻"，不是一段）；此时两个集合是同一个
    return {
      landingRow: anchor,
      occupiedRows: [anchor],
      blockRows: [anchor],
      degenerate: degenerate,
    };
  }

  return {
    landingRow: blockRows.length ? blockRows[0] : occupied[0],
    occupiedRows: occupied,
    // 卡片要盖住的行（真实课节行）。occupiedRows 与它可以不同：
    // 双选会那种"从午休行里开始"的任务，占用含午休行、但卡片从第一节真课画起。
    blockRows: blockRows,
    degenerate: degenerate,
  };
}

/** 兼容旧调用：只要落点行下标（转发给 resolveSpan，口径只有一份） */
function locateRow(task, rows, rowIndexOfPeriod, override) {
  return resolveSpan(task, rows, rowIndexOfPeriod, override).landingRow;
}

/**
 * 【仅测试用】用**具名参数**调 resolveSpan。
 *
 * 为什么不直接让测试按位置传四个参数：`locateRow(task, {3: 2}, null)` 这种旧写法
 * 一眼看不出第二个实参是"节次号→行下标"还是"行数组"，而这两个东西传错位置**都是
 * 合法 JS**，只会静默算出另一个答案。所以给测试一个没有歧义的入口：
 *   `T.spanFor({ task, rows, rowIndexOfPeriod, override })`
 *
 * @param {object} options {task, rows, rowIndexOfPeriod, override}
 * @returns {{landingRow: number, occupiedRows: number[], degenerate: boolean}}
 */
function spanFor(options) {
  const opts = options || {};
  return resolveSpan(opts.task, opts.rows, opts.rowIndexOfPeriod, opts.override);
}

/**
 * 一条任务的**结束分钟数** —— 时间类口径的唯一来源。
 *
 * ===========================================================================
 * 【为什么必须抽出来】"结束时间缺失/倒挂时怎么办"这个问题在页面里有**两条**
 * 独立的代码路径（rowSpanFromTimes 算跨度、bestOverlapPeriod 算吸附落点）。
 * 两处各写一份，就会出现同一张卡片"落点在一行、跨的是另两行"的鬼影 ——
 * 本文件在 2026-10 的那次修复里正好踩到：倒挂区间在跨度那条路上被当成
 * "start + estimate 的一段"（2 行），在吸附那条路上被当成"一个点"（1 行），
 * 于是倒挂的脏数据会画成一张 2 行高、却从"点所在那一行"往下盖的卡片。
 * 现在两条路径都调这个函数，**连边界口径都不可能再分叉**。
 *
 * 规则（按优先级）：
 *   1. 写了 end_time 且 end > start → 就用它（用户明确写下的结束时间最可信，
 *      **绝不**被 estimate_min 顶掉）；
 *   2. 没写 end_time、或 end ≤ start（倒挂/相等）→ 用 start + estimate_min；
 *   3. estimate_min 缺失或非法 → start + DEFAULT_BUSY_MINUTES（30 分钟），
 *      与 utils/planner.js 的"没写预计耗时按 30 分钟兜底"同一个数。
 *
 * 【注意】它只在**有 start_time** 时被调用；只有 end_time 的截止走的是另一条
 * "零长区间 + 结束时刻吸附"的路（见 resolveSpan 第 ② 步），因为截止不是一个时间段。
 *
 * @param {object} task 任务
 * @param {number} startMin 已经算好的开始分钟数（调用方一定先确认它非 null）
 * @returns {number} 结束分钟数
 */
function endMinuteOf(task, startMin) {
  const endMin = periods.toMinutes(str(task && task.end_time));
  if (endMin !== null && endMin > startMin) return endMin;
  return startMin + busyLengthOf(task);
}

/**
 * 一条任务"没写清楚时长"时该占多久（分钟）—— **唯一来源**。
 *   * 有 estimate_min 且为正 → 用它（用户/AI 给的预计耗时）；
 *   * 否则 30 分钟 —— 与 utils/planner.js 的 DEFAULT_BUSY_MINUTES 同一个数。
 *
 * 【为什么连"缺省值"也要抽出来】缺省值分散写的时候，两条路径会用**不同的兜底**：
 * 一条用 estimate_min、另一条用 30 分钟，于是倒挂的脏数据"算跨度时是 2 小时、
 * 算落点时是半小时"，落点与跨度又对不上。同一个数只留一处，才不会分叉。
 */
function busyLengthOf(task) {
  const estimate = Number(task && task.estimate_min);
  return Number.isFinite(estimate) && estimate > 0 ? estimate : DEFAULT_BUSY_MINUTES;
}

/**
 * 这条任务**有没有一个真实的结束时刻**（而不是靠 estimate 推出来的）。
 *   用途：只在两个地方给出提示性判断 ——
 *     * resolveSpan 的 `degenerate`（"结束时间不可信"）；
 *     * bestOverlapPeriod 的"零长：改用包含判定定位"。
 *   ⚠️ 它**不**决定"占多长时间"：缺 end / 倒挂时会用 estimate 推出一段，
 *     所以"degenerate"≠"零长"（那个概念见 isZeroLengthInterval）。
 *
 * 【为什么抽出来】resolveSpan 与 bestOverlapPeriod 都要问同一个问题。写在两处时，
 * 倒挂区间在一处算成"一段"、在另一处算成"一个点"，卡片就会"落点一行、跨另几行"。
 *
 * @param {object} task 任务
 * @returns {boolean} true = 没有可信的结束时间（缺 / 倒挂 / 等于开始）
 */
function lacksTrustedEnd(task) {
  const startMin = periods.toMinutes(str(task && task.start_time));
  if (startMin === null) return true;
  const endMin = periods.toMinutes(str(task && task.end_time));
  return endMin === null || endMin <= startMin;
}

/**
 * 这条任务的时间区间是不是**零长**（只有一个时刻，没有任何长度）。
 *   只有一种情形：开始时间压根解析不出来（典型是只有 end_time 的截止）。
 *   缺 end / 倒挂**不算**零长 —— 那会按 start + estimate 推出一段。
 *
 * 【为什么抽出来】"零长"这个判断同时决定了"占几行"和"卡片多高"，
 * 两条路径必须给出同一个答案。
 */
function isZeroLengthInterval(task) {
  return periods.toMinutes(str(task && task.start_time)) === null;
}

/**
 * 找出**没有 periods 的任务**真正跨了哪几行。
 *
 * ===========================================================================
 * 【为什么需要它】真机反馈：周四「参加双选会 14:00-18:00」被画成**一格高**，
 * 用户问"这个双选会的篇幅是不是起码要覆盖到第八节课呢" —— 他说得对。
 * ===========================================================================
 *   原因：卡片的 spanCount 过去**只来自 task.periods**，而没有 periods 的任务
 *   （手工加的日程、AI 解析出来的日程、子任务）一律按 1 行高渲染，
 *   哪怕它按时间是实打实地跨了 4 节。
 *   同一件事也让统计偏乐观：resolveSpan 把它算成"只占落点那一节"，
 *   于是「空闲 N 节」也就多算了。
 *
 * 【口径】半开区间 [start, end) 求交 —— 与全项目一致（首尾相接不算重叠）。
 *   返回的是**行下标**（不是节次号）。
 *
 * ===========================================================================
 * 【两个端点集：占用的跨度 from..to，与卡片真正要盖住的 heightFrom..heightTo】
 * ===========================================================================
 *   这一条是**第二次**修同一个真机用例，两次的原因不同，都要留着：
 *
 *   第 1 次修：卡片高度过去只来自 task.periods，没有 periods 就恒为 1 行高 ——
 *     14:00-18:00 的双选会被画成一格高。所以高度改成"按时间真正跨几行算"。
 *
 *   第 2 次修（本次）：用户的校准作息里**午休行是 12:25-14:15**，而双选会 14:00 开始 ——
 *     14:00 落在午休行**里面**！于是"跨度第一行"把锚点定到了午休行：
 *       卡片从 12:25 那一行开始画，而卡上的时间文字写着 14:00-18:00。
 *     用户的话是"视觉上等于暗示这个活动 12:25 就开始了"。
 *     **锚点与高度都必须只在"真实课节行"之间取**：
 *       * `heightFrom/heightTo` = 与它有交集的 **isClass 行**的最小/最大下标；
 *       * 锚点（landingRow）= heightFrom；卡片高度 = heightTo − heightFrom + 1；
 *       * `from/to`（占用跨度）**保持原样、含两端之间的空档行** —— 占用口径不能跟着变，
 *         否则「空闲 N 节」会莫名其妙地变一个数。
 *     * 与**任何真实课节都没有交集**时（整段时间都在空档里，例如 12:30-13:10）：
 *       heightFrom/heightTo 退回 from/to —— 空档行仍然是可落的行，
 *       这是我们上一轮特意保留的行为（见 bestOverlapPeriod 的注释），不许弄丢。
 *
 *   【为什么"高度"和"占用"可以不是同一个数】占用的语义是"这段时间被这件事占住了"
 *   （所以午休那 15 分钟也算占），高度的语义是"卡片要盖住几节课"
 *   （所以从第 7 节画到第 10 节）。把两者强行绑成同一个数，就必然要在
 *   "卡片从午休行开始"和"少扣一节空闲"之间二选一 —— 而这两个都是错的。
 *
 * @param {object} task 任务
 * @param {Array<object>} rows 行列表（buildGrid 里那一份）
 * @param {object|null} override 校准过的作息表
 * @returns {{from: number, to: number, heightFrom: number, heightTo: number}|null}
 *          一个行都交不到 → null
 */
function rowSpanFromTimes(task, rows, override) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return null;

  const startTime = str(task && task.start_time);
  const endTime = str(task && task.end_time);
  const startMin = periods.toMinutes(startTime);
  if (startMin === null) {
    // 没有开始时间（典型是截止：只有 end_time）→ 按**一个时刻**处理，不撑成一段。
    // 截止的语义就是"标出到期时刻"，它不该占时间（与 occupiedRowsOfDay 里那条早退同口径）。
    return null;
  }

  const endMin = endMinuteOf(task, startMin);

  let from = -1;
  let to = -1;
  let classFrom = -1;   // 只统计 isClass 行：锚点与卡片高度用它
  let classTo = -1;
  list.forEach((row, index) => {
    if (!row || row.isFallback) return;          // 「其他时段」兜底行不参与时间换算
    const range = periods.effectivePeriodRange(row.number, override) || ['', ''];
    const begin = periods.toMinutes(range[0]);
    const finish = periods.toMinutes(range[1]);
    if (begin === null || finish === null) return;
    // 半开区间求交：[start, end) ∩ [begin, finish) 非空 ⇔ max(start, begin) < min(end, finish)
    if (Math.max(startMin, begin) < Math.min(endMin, finish)) {
      if (from === -1) from = index;
      to = index;
      if (row.isClass !== false) {
        if (classFrom === -1) classFrom = index;
        classTo = index;
      }
    }
  });

  if (from === -1) return null;
  // 只碰到空档行（整段时间都在空档里）→ 高度也退回这一行，别让它变成 0 行
  if (classFrom === -1) {
    return { from: from, to: to, heightFrom: from, heightTo: to };
  }
  return { from: from, to: to, heightFrom: classFrom, heightTo: classTo };
}

/**
 * 找出与 [start, end] 重叠分钟数最多的**行**，作为这条任务的落点。
 *
 * ===========================================================================
 * 【空档行（午休 / 休息）可以接任务 —— 这是 Python 版的有意设计】
 * ===========================================================================
 *   `config.py:225-234` 的 gap_period_range 注释原话是"让这段时间真的能接住任务"。
 *   理由是「午休」行**不是一条假的横线**：
 *     * 它是 periodRows 生成的一行，有**真实的时间区间**（校准作息下第 6 节 = 12:25-14:15）；
 *     * 它**真的画在网格里**。一条 12:30 的任务落在它里面，用户就是在那一行找它；
 *     * 它**本来就不计入空闲节数**（见 freeCounts 的统计口径），所以往里面放卡片
 *       不会污染「空闲 N 节」这个数字 —— 两个口径并不冲突。
 *   这与"12:00 在默认作息里没有任何一行接得住、所以进「其他时段」"**不是一回事**：
 *   前者有行可落，后者连行都没有。
 *
 * 【为什么一度排除了它，又为什么回退】（写清判据，免得以后被当成反复无常）
 *   一开始收到的用例要求「12:25-13:25（校准作息）→ 其他时段」。那条用例是在
 *   **只考虑真实课节**的前提下推出来的，忘了空档行本身也是一个区间（它与第 6 节
 *   重叠 60 分钟）。于是临时加了一行 `breakLabel` 早退去凑那个期望值。
 *   复核后确认**用例写错了、以本实现为准**，判据就是上面那三条（有真实区间 /
 *   画在网格里 / 不计入空闲）。所以那行早退已删除 —— 空档行与其他行一视同仁地
 *   参与"最大重叠"比较。
 *
 * 【零长区间按"包含判定"定位】
 *   start 缺失（这条路径归 resolveSpan 的第 ② 步管，这里直接返回 null）、
 *   或 end 与 start 相等（零长）时，"重叠"恒为 0，若仍要求"重叠 > 0"就永远定位不到。
 *   所以这种退化情形改用"这个时刻落在哪一节里"来定，与 ddl 那条路径的口径一致。
 *    （正常区间仍要求**严格大于 0** 的重叠 —— 12:25-13:25 与第 5 节的重叠是 0，
 *      正是靠这一条它才不会被吸附到第 5 节。）
 *
 * 【end 缺失 / 倒挂怎么办 → 交给 endMinuteOf，不在这里另写一份】
 *   以前这里把两者都当成"零长的一个点"，而 rowSpanFromTimes 把倒挂当成
 *   "start + estimate 的一段" —— 同一张卡片于是"落点在一行、跨的是另三行"。
 *   现在两边共用 endMinuteOf：缺 end 或 end ≤ start 都按 start + estimate
 *   （缺省 30 分钟）算出**一段**时间，于是"落点"与"跨度"必然同源。
 *
 * @param {string} start "HH:MM"
 * @param {string} end "HH:MM"（可空 / 倒挂 → 按 start + estimate 推）
 * @param {object|null} [override] 校准过的作息表；也可以传一个**选项对象**
 *   `{task, override}` 或 `{override, estimateMin}` —— 测试里更愿意这么写，
 *   因为"现在到底用哪几个字段"在调用点一眼可见，也不会把 override 传错位置。
 * @returns {number|null} 节次号；与任何一行都没有交集时返回 null
 */
function bestOverlapPeriod(start, end, override) {
  const asOptions = override && typeof override === 'object' && !Array.isArray(override)
    && (Object.prototype.hasOwnProperty.call(override, 'override')
      || Object.prototype.hasOwnProperty.call(override, 'task'));
  const task = asOptions
    ? (override.task || { start_time: start, end_time: end, estimate_min: override.estimateMin })
    : { start_time: start, end_time: end };
  const table = asOptions ? (override.override || null) : override;

  const startMin = periods.toMinutes(str(task && task.start_time));
  if (startMin === null) return null;

  const endMin = endMinuteOf(task, startMin);
  const lacksEnd = lacksTrustedEnd(task);

  // 每一行都是候选 —— **包括空档行（午休/休息）**：
  // 它有真实时间区间、也真的画在网格里，而且不计入空闲节数（见函数头注释）。
  const numbers = periods.periodNumbers(table);
  let best = null;
  let bestOverlap = 0;    // 初始 0：只有"严格大于 0"的重叠才算命中
  let contained = null;   // 没有可信结束时间时兜底用：第一个包含"开始那一刻"的行

  numbers.forEach((number) => {
    const range = periods.effectivePeriodRange(number, table) || ['', ''];
    const begin = periods.toMinutes(range[0]);
    const finish = periods.toMinutes(range[1]);
    if (begin === null || finish === null) return;

    if (contained === null && startMin >= begin && startMin <= finish) contained = number;

    const overlap = Math.max(0, Math.min(endMin, finish) - Math.max(startMin, begin));
    if (overlap <= 0) return;
    // 并列时取节次号小的：numbers 已升序，用"严格大于"比较即可天然做到
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = number;
    }
  });

  // 只有**真的有一段重叠**时才用"点"兜底；没有任何重叠且结束时间不可信时，
  // 才退回"这个时刻落在哪一节里"（ddl 与脏数据都靠这条才能吸附到某一行）。
  // 【顺序不能反】先看重叠、再看包含 —— 反过来的话，"倒挂 + 有 estimate"的区间
  // 会被它自己推出来的重叠判成落空，卡片又跳回"点"所在的那一行。
  if (best !== null) return best;
  return lacksEnd ? contained : null;
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
 *
 * @param {object} task 任务
 * @param {object} [rowSpans] buildGrid 算好的 `task._id → 卡片占几行`。
 *   只有**没有 periods** 的任务会用到它（有时间段的手工日程/AI 日程要按真实跨度
 *   撑高，见 buildGrid 第 4 步）。缺省时退回 1 行，保持"最坏情况只是矮一点"。
 */
function viewTask(task, rowSpans) {
  const span = periodSpanOf(task);
  let periodText = '';
  if (span) periodText = span[0] === span[1] ? `第${span[0]}节` : `第${span[0]}-${span[1]}节`;

  // 卡片高度按"跨了几节"算（连堂的卡要占满它跨过的行，否则看起来只上了一节）。
  // 三种情形：
  //   * 写了 periods → 节次区间长度（既有口径，一行不改）；
  //   * 没写 periods 但算得出时间跨度 → 真实跨的行数（本次修复的双选会就是这一类）；
  //   * 落进「其他时段」的 → 1 行（那一格里没有第二行的容身之处）。
  let spanCount = 1;
  if (span) {
    spanCount = span[1] - span[0] + 1;
  } else {
    const id = str(task && task._id);
    const mapped = id && rowSpans ? Number(rowSpans[id]) : NaN;
    if (Number.isFinite(mapped) && mapped >= 1) spanCount = mapped;
  }
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
