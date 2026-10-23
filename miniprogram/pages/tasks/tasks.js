/**
 * pages/tasks/tasks.js —— DDL / 子任务列表页。
 *
 * 【这一页做什么】
 *   * 默认只看「进行中」，可切「全部 / 已完成」。
 *   * 每条显示：标题、类型、日期、时间或节次、优先级、预计耗时（estimate_min 非 0 才显示，
 *     写法是「≈1.5 小时」这种）。
 *   * 勾选完成 → api.updateTask(id, { done })。
 *   * 删除 → wx.showModal 二次确认，确认文案写明「会一并删除其子任务」→ api.removeTask(id)。
 *   * 点条目 → pages/edit/edit?id=xxx。
 *   * parent_id 不为空的条目显示「↳ 属于：<父标题>」（点那行小字直接跳父任务）。
 *   * 两个 AI 入口：顶部「AI 录入」→ pages/ai/ai；
 *     每条任务上的「拆解」→ pages/ai/ai?mode=decompose&id=xxx
 *     （只对"待办且不是子任务、并且能排出时间"的条目出现，见 decomposeInfo()）。
 *
 * 【为什么不用三态改筛选口径】
 *   列表默认只看「进行中」，这里用的是 `done === true` 算完成 —— 与云函数 list 的
 *   "取全部"口径一致，勾了就消失，行为可预期。
 *   utils/tasks.js 的三态（pending/done/finished）里多一个「已结课」（每周重复的课
 *   上完最后一次），它**只用于**决定要不要给"拆解"入口：已结课的课不需要再拆。
 *   如果哪天要让「进行中」也排除已结课，改 applyFilter 一处即可 —— 但现在不动，
 *   免得列表里的课突然"自己不见了"。
 *
 * 【为什么在前端过滤而不是分页查库】
 *   云函数 list 一次把当前用户的全部任务取回来（内部已自动翻页），
 *   切筛选标签就不必再打一次请求；只有渲染量大时才用「加载更多」分批铺开。
 */

const api = require('../../utils/api.js');

// ---------------------------------------------------------------------------
// utils/tasks.js 是另一位同学交付的三态判定模块（taskState）。这里**只**用它来判断
// "这条还值不值得拆解"，不拿它改列表的筛选口径（见文件头「为什么不用三态改筛选」）。
// 用 try/catch 包一层：万一它在运行期不可用，页面照样能用，只是拆解入口退化为
// "按 done + 不是子任务"这套更宽松的判断，不会把整个任务页带崩。
// ---------------------------------------------------------------------------
let tasksUtil = null;
try {
  // eslint-disable-next-line global-require
  tasksUtil = require('../../utils/tasks.js');
} catch (err) {
  tasksUtil = null;
  console.warn('[tasks] utils/tasks.js 不可用，拆解入口改用简化判断：', err);
}

/** 筛选标签：值与 taskFilter 对应 */
const FILTERS = [
  { key: 'pending', label: '进行中' },
  { key: 'soon', label: '即将到期' },
  { key: 'all', label: '全部' },
  { key: 'done', label: '已完成' },
];

/** 一屏先渲染多少条，「加载更多」每次再加这么多 */
const PAGE_STEP = 40;

// ---------------------------------------------------------------------------
// 「24 小时内到期」—— 顶部警示条 + 「即将到期」筛选（**纯前端**，不依赖任何云函数）
// ---------------------------------------------------------------------------
/**
 * ===========================================================================
 * 【这是没有微信通知时的降级路径，必须永远可用】
 * ===========================================================================
 * 订阅消息那条路（cloudfunctions/remind + pages/me 的「到期提醒」卡片）依赖三件事：
 * 用户在微信后台配好模板、用户在真机上授权过、并且还有剩余额度。任何一件没满足，
 * 用户就**什么都收不到**。所以"打开小程序时能看见哪些事快到期了"这件事必须由
 * **页面自己算**：拿已经拉到的任务列表现算，不新增云函数、不依赖 remind 是否可用。
 *
 * 【时间口径：北京时间（UTC+8），与 remind 云函数逐字对齐】
 * 云函数容器时区是 UTC，它用 `Date.UTC(y, m-1, d) + (h*60+min)*60000 - 8h` 合成
 * 截止时刻（remind/index.js 的 dueInstantOf）。前端**必须用同一套算法**，否则
 * 设备时区不是东八区时（比如模拟器、或者人在国外），同一件事在两端会得出不同结论：
 * 云函数认为"还差 30 分钟"，页面却认为"还早"。
 * 所以下面 dueInstantOf 的合成方式与云函数**一模一样**，不要图省事写成
 * `new Date(date + ' ' + time)`（那种写法按设备本地时区解释）。
 *
 * 【"24 小时内"的判定口径】
 *   `dueAt - now ∈ [-GRACE, +WINDOW]`，即
 *     * 还没到期、且距到期不到 24 小时 → 算；
 *     * 刚过期一点点（≤ GRACE = 10 分钟）→ **也算**（用户刚打开小程序，这条正是最急的）；
 *     * 已经过期很久（超过宽限）→ **不算**（"早该做完了"不算"即将到期"，天天挂在那
 *       只会让人忽略这条警示条）。
 *   口径与云函数的提醒窗口对齐：那边同样是"窗口内 + 10 分钟宽限兜底"。
 *   这些任务必须是 **ddl + 未完成 + 有明确截止时刻（date + end_time）**，
 *   缺时刻的一律不算 —— 与云函数的 dueInstantOf 一样"不瞎猜 23:59"。
 */
const TASK_REMIND_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 刚过期多久之内仍然算"即将到期"（与云函数 GRACE_MS 同值，理由见上） */
const TASK_REMIND_GRACE_MS = 10 * 60 * 1000;

/** 北京时间相对 UTC 的偏移（与云函数 BEIJING_OFFSET_MS 同值） */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 各筛选下的空态文案（空列表时总得告诉用户"是没数据，还是筛掉了"） */
const EMPTY_TEXT = {
  pending: '当前没有进行中的任务',
  soon: '24 小时内没有要到期的截止事项',
  all: '还没有任何任务，点下面按钮添加',
  done: '还没有已完成的任务',
};

const TYPE_LABELS = { event: '日程', ddl: '截止', subtask: '子任务' };
const PRIORITY_LABELS = { high: '高', mid: '中', low: '低' };
const PRIORITY_ORDER = { high: 0, mid: 1, low: 2 };
const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

Page({
  data: {
    // --- 筛选 ---
    filters: FILTERS,
    taskFilter: 'pending',   // 默认只看进行中

    // --- 列表 ---
    allItems: [],            // 当前筛选下的全部条目（视图模型）
    visibleItems: [],        // 实际渲染的切片
    hasMore: false,          // 还有没渲染完的

    // --- 统计 ---
    totalCount: 0,           // 全部任务数
    pendingCount: 0,         // 进行中
    doneCount: 0,            // 已完成
    todayCount: 0,           // 今天到期的（含每天的课）
    filterText: '',          // 「进行中 · 3 条」
    emptyText: '当前没有进行中的任务',  // 空态文案，随筛选变化

    // --- 状态 ---
    loading: true,
    errorText: '',
    busyId: '',              // 正在被勾选/删除的条目 id（防连点）
    todayDate: '',
    semesterStart: '',       // 学期开始日期，判断"已结课"要用；从 app.globalData 取
    aiEnabled: true,         // utils/tasks.js 是否可用（不可用时拆解入口按简化判断）
    decomposeHint: '',       // 一键拆解不可用时的说明文案，空串 = 可以正常用

    // --- 24 小时内到期（降级提示，纯前端算，不依赖 remind 云函数） ---
    dueSoonCount: 0,         // 24 小时内到期的截止事项有几条（只数**未完成**的）
    dueSoonText: '',         // 「今天有 2 个截止事项即将到期」；没有时为空串（警示条不出现）
  },

  onLoad() {
    // 学期开始日期只影响"每周重复的课结课了没"，取不到也没关系（退化为按 done 判断）
    this.setData({
      semesterStart: readSemesterStart(),
      aiEnabled: !!tasksUtil,
      decomposeHint: tasksUtil
        ? ''
        : 'AI 拆解需要 utils/tasks.js（三态判定），当前不可用；'
          + '你仍然可以进 AI 页手动挑一条任务来拆解。',
    });
    this.loadTasks();
  },

  /** 从编辑页返回时自动刷新（改了标题/日期，列表要跟着变） */
  onShow() {
    // 首次 onLoad 已经拉过一次；这里用 loadedOnce 避免刚进页面连发两次请求
    if (this.loadedOnce) this.loadTasks();
  },

  /** 下拉刷新 */
  onPullDownRefresh() {
    this.loadTasks().then(() => {
      wx.stopPullDownRefresh();
    }).catch(() => {
      wx.stopPullDownRefresh();
    });
  },

  // -------------------------------------------------------------------------
  // 数据加载
  // -------------------------------------------------------------------------

  /**
   * 拉全部任务 → 算统计 → 按当前筛选拼列表。
   *
   * 【为什么要判 ok】utils/api.js 约定「失败不 reject，而是 resolve {ok:false, error}」，
   * 失败时它自己已经弹过 toast。这里必须显式判 ok，否则请求失败会被显示成
   * "当前没有进行中的任务" —— 把"没读到"说成"没有数据"，是最容易误人的那种 bug。
   *
   * @returns {Promise<void>}
   */
  loadTasks() {
    this.setData({ loading: true, errorText: '' });
    return api.listTasks().then((result) => {
      if (result && result.ok === false) throw new Error(describeError(result));
      const tasks = extractTasks(result);
      const today = todayStr();

      // 父标题映射：子任务要显示「↳ 属于：<父标题>」
      const titleById = {};
      tasks.forEach((task) => {
        const id = str(task._id);
        if (id) titleById[id] = str(task.title) || '(无标题)';
      });

      // 每条条目的视图模型；再补一次"我有几个子任务"（删除确认文案要用）
      const semesterStart = this.data.semesterStart || readSemesterStart();
      const items = buildChildCounts(
        tasks.map((task) => viewTask(task, titleById, today, semesterStart))
      );

      // 【降级提示】24 小时内到期的截止事项 —— 拿刚拉到的列表现算，**不发任何请求**
      // （理由与时间口径见文件上方 TASK_REMIND_WINDOW_MS 那一段注释）。
      // 它同时把 dueSoonCount / dueSoonText 写进 data，所以必须排在下面的 setData 之前。
      this.applyDueSoon(items, tasks);

      // 统计（全部口径）
      let pendingCount = 0;
      let doneCount = 0;
      let todayCount = 0;
      items.forEach((item) => {
        if (item.done) doneCount += 1;
        else pendingCount += 1;
        if (item.isToday) todayCount += 1;
      });

      this.allItems = items;
      this.loadedOnce = true;
      this.setData({
        loading: false,
        errorText: '',
        totalCount: items.length,
        pendingCount,
        doneCount,
        todayCount,
        todayDate: today,
      });
      this.applyFilter(this.data.taskFilter, true);
    }).catch((err) => {
      this.loadedOnce = true;
      this.setData({
        loading: false,
        errorText: `加载失败：${describeError(err)}`,
      });
    });
  },

  // -------------------------------------------------------------------------
  // 筛选 / 分页
  // -------------------------------------------------------------------------

  /** 点筛选标签 */
  onTapFilter(event) {
    const key = str(event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.key
      : '');
    if (!key || key === this.data.taskFilter) return;
    this.applyFilter(key, true);
  },

  /**
   * 套用筛选并重置分页。
   * @param {string} key pending / soon / all / done
   * @param {boolean} reset 是否从头渲染
   */
  applyFilter(key, reset) {
    const filter = FILTERS.some((item) => item.key === key) ? key : 'pending';
    const items = (this.allItems || []).filter((item) => {
      if (filter === 'done') return item.done;
      // 「即将到期」= 24 小时内到期**且未完成**的截止事项（isSoon 在 loadTasks 里算好）
      if (filter === 'soon') return item.isSoon === true;
      if (filter === 'all') return true;
      return !item.done;
    });
    this.filtered = items;
    this.setData({
      taskFilter: filter,
      filterText: `${labelOfFilter(filter)} · ${items.length} 条`,
      emptyText: EMPTY_TEXT[filter] || EMPTY_TEXT.pending,
      allItems: this.allItems,
      visibleItems: reset ? items.slice(0, PAGE_STEP) : (this.data.visibleItems || []),
      hasMore: items.length > PAGE_STEP,
    });
  },

  /**
   * 点顶部那条「今天有 N 个截止事项即将到期」的警示条 → 切到「即将到期」筛选，
   * 把那几条摆到眼前。用筛选而不是滚动：列表里可能还夹着别的任务，滚动能滚到的
   * 位置并不确定，而筛选是"确定看得见"的。
   */
  onTapSoonBanner() {
    if (!this.data.dueSoonCount) return;
    this.applyFilter('soon', true);
  },

  /**
   * 重算「24 小时内到期」并把结果写进 data（**唯一的写入口**）。
   *
   * 【为什么要一个统一入口，而不是各处自己 setData】勾选完成 / 取消完成 / 删除之后
   * 都要重算，而"截止时刻"没变、只有 `done` 变了 —— 如果有哪条路径忘了重算，
   * 顶部警示条就会继续用旧数字说"还有 1 个即将到期"，点进去却是空的。
   * 这类"文案与事实不一致"的 bug 在页面上非常显眼，所以收口到一个方法里。
   *
   * @param {Array<object>} items 条目视图模型（会被就地打上 isSoon）
   * @param {Array<object>} [tasks] 原始任务数组；不传时按 id 用 allItems 反查 done 状态
   * @returns {number} 符合项条数
   */
  applyDueSoon(items, tasks) {
    const list = Array.isArray(items) ? items : [];
    // 「现在」存成实例字段而不是 data：WXML 用不到它，而时间戳进 data 只会让每次
    // setData 都多传一份用不上的数据。
    // 写成 `this.remindNowMs || Date.now()` 是**故意留一个可注入的口子**：单测
    // （utils/tests/remind_page.test.js）先往里塞一个固定时刻，才能对"23 小时后算、
    // 24 小时整算不算、刚过期 10 分钟算"这些边界下确定性断言。生产路径没人预设它。
    this.remindNowMs = this.remindNowMs || Date.now();

    // 入参两种形态：刚拉到的**原始任务**，或本地的**条目视图模型**（勾选后走这条）。
    // 视图模型带着 isSoon 之外的所有判据（type/date/end_time/done），所以能直接复用。
    const source = Array.isArray(tasks) ? tasks : list;
    const soonIds = computeDueSoonIds(source, this.remindNowMs);
    list.forEach((item) => {
      item.isSoon = item.done !== true && soonIds.indexOf(item.id) !== -1;
    });
    const count = this.countDueSoon(list);
    this.setData({
      dueSoonCount: count,
      // 没有符合项时文案是空串 → WXML 里警示条整条不渲染（不留一条空条占位置）
      dueSoonText: dueSoonText(count),
    });
    return count;
  },

  /** 数一数当前有几个"即将到期"（只算未完成的） */
  countDueSoon(items) {
    return (Array.isArray(items) ? items : []).filter((item) => item.isSoon === true).length;
  },

  /** 加载更多 */
  onLoadMore() {
    const shown = (this.data.visibleItems || []).length + PAGE_STEP;
    const items = this.filtered || [];
    this.setData({
      visibleItems: items.slice(0, shown),
      hasMore: items.length > shown,
    });
  },

  // -------------------------------------------------------------------------
  // 勾选完成
  // -------------------------------------------------------------------------

  /**
   * 勾选 / 取消勾选 → updateTask(id, { done })。
   * 用 busyId 挡住连点：勾选是异步的，连点两下会发出两个方向相反的请求。
   */
  onToggleDone(event) {
    const id = str(event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.id
      : '');
    if (!id) {
      wx.showToast({ title: '这条数据缺少 id', icon: 'none' });
      return;
    }
    if (this.data.busyId === id) return;

    const current = (this.allItems || []).filter((item) => item.id === id)[0];
    const nextDone = !(current && current.done);

    this.setData({ busyId: id });
    api.updateTask(id, { done: nextDone }).then((result) => {
      if (result && result.ok === false) {
        throw new Error(describeError(result));
      }
      // 本地直接改，省一次 list 请求；下次下拉刷新会跟服务端对齐
      (this.allItems || []).forEach((item) => {
        if (item.id === id) item.done = nextDone;
      });
      const total = this.allItems.length;
      const doneCount = this.allItems.filter((item) => item.done).length;
      // 【必须重算】「即将到期」的口径里有"未完成"这一条：勾上之后它立刻不再算，
      // 取消勾选（若仍符合时间窗口）要立刻变回来。不重算的话顶部警示条会继续说
      // "还有 1 个即将到期"，点进去却是空的 —— 文案与事实不一致最容易让人不信这个功能。
      this.applyDueSoon(this.allItems);
      this.setData({
        busyId: '',
        allItems: this.allItems,
        doneCount,
        pendingCount: total - doneCount,
      });
      this.applyFilter(this.data.taskFilter, true);
      wx.showToast({ title: nextDone ? '已完成' : '已恢复', icon: 'none' });
    }).catch((err) => {
      this.setData({ busyId: '' });
      // 失败提示由 api.js 统一弹；这里再弹一次会变成连续两个 toast
      console.warn('[tasks] 勾选失败：', describeError(err));
    });
  },

  // -------------------------------------------------------------------------
  // 删除（二次确认）
  // -------------------------------------------------------------------------

  /** 删除：先弹窗说清楚会连带删掉子任务，确认后才真删 */
  onDelete(event) {
    const id = str(event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.id
      : '');
    if (!id) {
      wx.showToast({ title: '这条数据缺少 id', icon: 'none' });
      return;
    }
    const item = (this.allItems || []).filter((row) => row.id === id)[0];
    if (!item) return;

    const extra = item.childCount
      ? `\n它下面还有 ${item.childCount} 个子任务，会一并删除。`
      : '';
    wx.showModal({
      title: '确认删除',
      content: `确定删除「${item.title}」吗？删除后会一并删除其子任务，且无法恢复。${extra}`,
      confirmText: '删除',
      confirmColor: '#e0553f',
      success: (res) => {
        if (res && res.confirm) this.doRemove(id, item.title);
      },
    });
  },

  /** 真正执行删除 */
  doRemove(id, title) {
    this.setData({ busyId: id });
    api.removeTask(id).then((result) => {
      if (result && result.ok === false) {
        throw new Error(describeError(result));
      }
      wx.showToast({ title: '已删除', icon: 'none' });
      // 删除会级联带走子任务，所以必须重新拉一次，不能只从本地数组里剔一条
      this.setData({ busyId: '' });
      return this.loadTasks();
    }).catch((err) => {
      this.setData({ busyId: '' });
      console.warn('[tasks] 删除失败：', describeError(err));
    });
  },

  // -------------------------------------------------------------------------
  // 跳转
  // -------------------------------------------------------------------------

  /** 点条目 → 编辑页 */
  onTapItem(event) {
    const id = str(event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.id
      : '');
    if (!id) {
      wx.showToast({ title: '这条数据缺少 id', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: `/pages/edit/edit?id=${id}` });
  },

  /** 点「↳ 属于：xxx」→ 直接去父任务（catchtap 已挡住冒泡，不会同时触发编辑自己） */
  onTapParent(event) {
    const id = str(event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.parentId
      : '');
    if (!id) {
      wx.showToast({ title: '找不到父任务', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: `/pages/edit/edit?id=${id}` });
  },

  /** 空态里的按钮 */
  onTapAdd() {
    wx.navigateTo({ url: '/pages/edit/edit' });
  },

  /**
   * 只给纯 node 单测用的探针（utils/tests/remind_page.test.js）。
   * 测的是页面真正在用的那份实现（与 pages/ai/ai.js、pages/week/week.js 同一套做法）。
   */
  __test: {
    dueInstantOf: dueInstantOf,
    computeDueSoonIds: computeDueSoonIds,
    dueSoonText: dueSoonText,
    TASK_REMIND_WINDOW_MS: TASK_REMIND_WINDOW_MS,
    TASK_REMIND_GRACE_MS: TASK_REMIND_GRACE_MS,
    BEIJING_OFFSET_MS: BEIJING_OFFSET_MS,
    // 三点八 · 「缺时刻·不会提醒」标记（utils/tests/ddl_time.test.js 用）
    viewTask: viewTask,
  },
});

// ---------------------------------------------------------------------------
// 视图模型
// ---------------------------------------------------------------------------

/**
 * 把一条云数据库任务变成渲染用的条目。
 *
 * @param {object} task 原始任务
 * @param {object} titleById {_id: 标题}，用来显示父任务标题
 * @param {string} today 今天（YYYY-MM-DD）
 * @param {string} semesterStart 学期开始日期（判断"已结课"用，可为空）
 * @returns {object} 条目视图模型
 */
function viewTask(task, titleById, today, semesterStart) {
  const title = str(task.title) || '(无标题)';
  const type = str(task.type) || 'event';
  const priority = str(task.priority) || 'mid';
  const date = str(task.date);
  const start = str(task.start_time);
  const end = str(task.end_time);
  const periodText = periodsText(task.periods);

  // 时间/节次：节次优先（课表里节次比钟点更好认），没有节次才显示钟点
  let whenText = '';
  if (periodText) whenText = periodText;
  else if (start && end) whenText = `${start}-${end}`;
  else if (start) whenText = start;
  else if (end) whenText = `${end} 前`;

  const parentId = str(task.parent_id);
  const parentTitle = parentId ? (titleById[parentId] || '(父任务已删除)') : '';

  // 只有子任务身份才显示父任务那一行：parent_id 有值但类型没跟上时也算，宁可多显示不可漏
  const showParent = !!parentId;

  const decompose = decomposeInfo(task, type, start, end, semesterStart);

  return {
    id: str(task._id),
    title,
    type,
    typeLabel: TYPE_LABELS[type] || '日程',
    done: task.done === true,
    priority,
    priorityLabel: PRIORITY_LABELS[priority] || '中',
    highPriority: priority === 'high',
    dateText: date ? `${shortDate(date)}（${weekdayOf(date)}）` : '未定日期',
    isToday: !!date && date === today,
    whenText,
    location: str(task.location),
    estimateText: estimateText(task.estimate_min),
    repeatText: repeatText(task),
    parentId,
    parentTitle,
    showParent,
    childCount: 0,       // 由 buildChildCounts 统一填
    subtaskOfOther: type === 'subtask' && !parentId,
    // --- 24 小时内到期（由 loadTasks 用 computeDueSoonIds 统一填） ---
    // 默认 false：没有截止时刻 / 已经完成 / 还早 / 过期太久，都是 false（判据见文件上方注释）
    isSoon: false,
    // --- 缺时刻的截止：微信那条提醒通道会直接跳过它 ---
    // 判据与云函数 dueInstantOf 同一口径：截止要看 end_time（ddl 只有这一个时刻）。
    // 只标"未完成 + 截止 + 有日期 + 一个时刻都没填"，因为只有这一批是真的永远收不到提醒；
    // 连日期都没有的另有「未定日期」显示（那是另一个问题，不该混成一个标签）。
    needsTime: type === 'ddl' && !!date && !start && !end && task.done !== true,
    // --- AI 拆解入口 ---
    canDecompose: decompose.ok,
    decomposeBlockedText: decompose.reason,
  };
}

/**
 * 这条任务该不该出现「拆解」入口。
 *
 * 规则（与 pages/ai/ai.js 里挑候选的那套保持一致，免得点进去发现它不在列表里）：
 *   * 已完成 / 已结课（三态里的 done、finished）→ 不给拆：事情都过去了，拆出来也没人做；
 *   * 本身就是子任务 → 不给拆：子任务再拆子任务没有意义（服务端也只支持一层父子）；
 *   * 其余（pending）→ 给拆。
 *
 * 另外，ai.js 拆解时要把子任务排在"今天 ~ 截止日"之间，所以它要求任务有合法日期。
 * 这里也照着要求日期，但**放宽一点**：只要任务自己写了日期就放行，日期合法性交给
 * ai.js 去判（它有自己的 isValidDate），避免两边口径不一致时用户点了没反应。
 *
 * @returns {{ok: boolean, reason: string}} ok=false 时 reason 是给用户看的原因
 */
function decomposeInfo(task, type, startTime, endTime, semesterStart) {
  if (type === 'subtask') {
    // 直接不显示按钮，不占用界面（reason 留空 = WXML 不渲染）
    return { ok: false, reason: '' };
  }

  const state = taskStateOf(task, semesterStart);
  if (state === 'done') {
    return { ok: false, reason: '已完成，无需拆解' };
  }
  if (state === 'finished') {
    return { ok: false, reason: '已结课，无需拆解' };
  }

  const hasTime = !!(str(startTime) || str(endTime));
  if (!str(task.date) && !hasTime) {
    return { ok: false, reason: '先补上日期，AI 才能把子任务排开' };
  }

  return { ok: true, reason: '' };
}

/**
 * 三态判定的统一入口：能用 utils/tasks.js 就用它（口径与服务端一致），
 * 用不了就退化成"done 为真算完成，其余算待办"。
 * @returns {string} 'done' | 'finished' | 'pending'
 */
function taskStateOf(task, semesterStart) {
  if (tasksUtil && typeof tasksUtil.taskState === 'function') {
    try {
      const state = tasksUtil.taskState(task, semesterStart || '', new Date());
      if (state) return str(state);
    } catch (err) {
      // 落到下面的兜底
    }
  }
  return task && task.done === true ? 'done' : 'pending';
}

/** 统计每条任务有几个直接子任务（删除确认文案要用） */
function buildChildCounts(items) {
  const counts = {};
  items.forEach((item) => {
    if (item.parentId) counts[item.parentId] = (counts[item.parentId] || 0) + 1;
  });
  items.forEach((item) => {
    item.childCount = counts[item.id] || 0;
  });
  return items;
}

/**
 * 预计耗时的中文写法：0 或非法 → ''（**不显示**）；
 * 60 → 「≈1 小时」，90 → 「≈1.5 小时」，45 → 「≈45 分钟」，150 → 「≈2.5 小时」。
 */
function estimateText(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return '';
  const abs = Math.round(value);
  if (abs < 60) return `≈${abs} 分钟`;
  const hours = abs / 60;
  // 半小时以内用一位小数，整点小时不拖 ".0"
  const text = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  return `≈${text} 小时`;
}

/** 重复方式的短描述：每周的课显示「每周 · 1-16周 · 单周」，每天重复显示「每天 · 1-20周」 */
function repeatText(task) {
  const repeat = str(task.repeat);
  const start = Number(task.week_start);
  const end = Number(task.week_end);
  const hasWeeks = Number.isFinite(start) && Number.isFinite(end);
  // 每天重复（打卡 / 习惯）：不含单双周 —— 它对每天没有意义（见 periods.taskOccursOn）
  if (repeat === 'daily') return hasWeeks ? `每天 · ${start}-${end}周` : '每天';
  if (repeat !== 'weekly') return '';
  const parts = ['每周'];
  if (hasWeeks) parts.push(`${start}-${end}周`);
  const parity = str(task.week_parity);
  if (parity === 'odd') parts.push('单周');
  else if (parity === 'even') parts.push('双周');
  return parts.join(' · ');
}

/** "7-9" → "第7-9节"，"7" → "第7节"，空 → "" */
function periodsText(raw) {
  const text = str(raw);
  if (!text) return '';
  const matched = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(text);
  if (matched) return `第${matched[1]}-${matched[2]}节`;
  const single = /^\d{1,2}$/.test(text);
  return single ? `第${text}节` : text;
}

// ---------------------------------------------------------------------------
// 24 小时内到期（降级提示的纯逻辑，全部可单测）
// ---------------------------------------------------------------------------

/**
 * 一条 DDL 的截止**绝对时刻**（毫秒，北京时间的日历日 + 当天时刻合成）。
 *
 * ===========================================================================
 * 【口径必须与 remind 云函数逐字一致】两头算的不是同一个东西 = 用户看到的
 * 和实际会提醒的对不上。云函数的 dueInstantOf（cloudfunctions/remind/index.js）：
 *   `Date.UTC(y, m-1, d) + (h*60+min)*60000 - 8h`
 * 这里就是同一行公式（见文件上方 BEIJING_OFFSET_MS 那一段的说明）。
 * 特意**不**复用 utils/periods.js 的 parseDate/toDate：那两个按设备本地时区构造
 * Date，取 getTime() 出来会随设备时区漂移，和云函数对不上。
 * ===========================================================================
 *
 * 返回 null 的情况（都不算"即将到期" —— 宁可不提示，也不要提示一条错的）：
 *   * 不是 ddl（日程/子任务没有"到期"概念）；
 *   * `done === true`（做完了还催就是骚扰）；
 *   * 缺 `date` 或缺 `end_time`（没有明确时刻 —— **不瞎猜 23:59**，与云函数同款取舍）；
 *   * 日期/时间格式非法，或 `end_time` 越界（`24:00` 那种跨天写法）。
 *
 * 【与云函数唯一的差异，如实写在这里】云函数的时间正则容忍 `9:5` 这种写法
 * （normalize 系的口径），这里只认 `H:MM` / `HH:MM`。差异的后果是"极端脏数据下
 * 少提示一条"，不会多提示；而且云端入库前已经把时间归一化成 `HH:MM` 了。
 *
 * @param {object} task 任务文档
 * @returns {number|null} 毫秒时间戳；算不出来为 null
 */
function dueInstantOf(task) {
  if (!task || typeof task !== 'object') return null;
  if (str(task.type) !== 'ddl') return null;
  if (task.done === true) return null;

  const dateText = str(task.date);
  const timeText = str(task.end_time);
  if (!dateText || !timeText) return null;

  const dateMatched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  if (!dateMatched) return null;
  const timeMatched = /^(\d{1,2}):(\d{2})$/.exec(timeText);
  if (!timeMatched) return null;

  const year = Number(dateMatched[1]);
  const month = Number(dateMatched[2]);
  const day = Number(dateMatched[3]);
  const hour = Number(timeMatched[1]);
  const minute = Number(timeMatched[2]);
  if (hour > 23 || minute > 59) return null;

  const dayUtc = Date.UTC(year, month - 1, day);
  // 回环校验：Date.UTC 会把 2026-02-30 静默进位成 2026-03-02，必须自己发现
  const roundTrip = new Date(dayUtc);
  if (roundTrip.getUTCFullYear() !== year
    || roundTrip.getUTCMonth() + 1 !== month
    || roundTrip.getUTCDate() !== day) {
    return null;
  }
  return dayUtc + (hour * 60 + minute) * 60 * 1000 - BEIJING_OFFSET_MS;
}

/**
 * 从一批原始任务里挑出"24 小时内到期**且未完成**"的 id。
 *
 * 判定区间：`dueAt - now ∈ [-TASK_REMIND_GRACE_MS, +TASK_REMIND_WINDOW_MS]`
 * （含"刚过期 10 分钟内"这次兜底，超过就算"过期太久"，不再提示 —— 口径见文件上方注释）。
 *
 * @param {Array<object>} tasks 云函数 list 返回的原始任务数组
 * @param {number} nowMs "现在"（毫秒）。**由调用方传进来**：测试要能钉死一个时刻，
 *        页面在 loadTasks 里传 Date.now()。不传就按当前时刻。
 * @returns {Array<string>} 命中的任务 id（去重不会发生，但顺序与入参一致）
 */
function computeDueSoonIds(tasks, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const list = Array.isArray(tasks) ? tasks : [];
  const ids = [];
  list.forEach((task) => {
    const dueAt = dueInstantOf(task);
    if (dueAt === null) return;
    const delta = dueAt - now;
    if (delta > TASK_REMIND_WINDOW_MS) return;   // 还早（超过 24 小时）
    if (delta < -TASK_REMIND_GRACE_MS) return;   // 过期太久（不算"即将到期"）
    const id = str(task._id);
    if (id) ids.push(id);
  });
  return ids;
}

/** 警示条文案；没有符合项时返回**空串**（WXML 据此整条不渲染） */
function dueSoonText(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return n ? `今天有 ${n} 个截止事项即将到期` : '';
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function str(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** "2026-09-07" → "09-07" */
function shortDate(dateStr) {
  const text = str(dateStr);
  return text.length >= 10 ? text.slice(5) : text;
}

/** 日期 → 周几（"2026-09-07" → "周一"）；解析不了返回空串 */
function weekdayOf(dateStr) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(dateStr));
  if (!matched) return '';
  const date = new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]));
  if (Number.isNaN(date.getTime())) return '';
  return WEEKDAY_NAMES[(date.getDay() + 6) % 7];
}

function pad2(number) {
  return number < 10 ? `0${number}` : String(number);
}

/** 今天（本地时区的日历日，与 utils/periods.js 口径一致） */
function todayStr() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/**
 * 从 app.globalData 读学期开始日期（判断"每周重复的课结课了没"要用）。
 * 读不到就返回空串 —— taskState 在算不出周次时不会把任务判成已结课，
 * 结果是"多显示一个拆解按钮"，比"该有的按钮不见了"安全。
 */
function readSemesterStart() {
  try {
    const app = getApp();
    const value = app && app.globalData ? app.globalData.semesterStart : '';
    return str(value);
  } catch (err) {
    return '';
  }
}

function labelOfFilter(key) {
  const hit = FILTERS.filter((item) => item.key === key)[0];
  return hit ? hit.label : '进行中';
}

/** 从 api.listTasks() 的返回值里取任务数组（兼容多种包装层级） */
function extractTasks(result) {
  if (!result) return [];
  const data = result.data === undefined ? result : result.data;
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.tasks)) return data.tasks;
  if (Array.isArray(result.tasks)) return result.tasks;
  return [];
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
