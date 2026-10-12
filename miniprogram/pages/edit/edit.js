/**
 * pages/edit/edit.js —— 添加 / 编辑任务表单。
 *
 * 【有 id = 编辑，没 id = 新增】
 *   onLoad(options) 里取 options.id；有 id 就从 api.listTasks() 里把那条任务找出来填进表单
 *   （契约里没有 task_get，所以只能这样取；顺带也拿到了"子任务归属"要用的父任务列表）。
 *
 * ===========================================================================
 * 【最重要的一条规矩：控件默认值 ≠ 用户输入】
 * ===========================================================================
 *   编辑一条**原本没填时间**的任务时，绝不能让 picker 的默认值（比如 08:00）被当成
 *   用户填的值写回数据库 —— 那就等于凭空给用户加了个"08:00 开始"。
 *   所以这里把两者严格分开：
 *     form.date / form.start_time / form.end_time  ← 只有用户真的选了才会变
 *     datePicker / startPicker / endPicker         ← 仅仅是给控件看的显示值
 *   未选择过时，picker 显示的是一个中性占位（'08:00' / 今天），但它**不进入表单数据**；
 *   时间旁边的「未填」「清除」状态也如实反映 form 里的空值。
 *   新增时同理：不预设任何时间，用户不填就是"没填"（date 交给云函数补今天）。
 *   保存编辑时还会先跟原记录做一次逐字段 diff，只提交真正改动的字段，
 *   进一步保证"没碰过的字段不会被顺手覆盖"。
 *
 * 【子任务的类型/时间关系】
 *   子任务也是"一件事"，允许有日期时间；但 DDL 的语义是"只有一个截止时刻"，
 *   所以选「截止」时隐藏开始时间，只留截止时间（与云函数的归一化一致：
 *   DDL 会把 start_time 迁移到 end_time 并清空 start_time）。
 */

const api = require('../../utils/api.js');

/** 类型中文名（放顶部：下面的函数是提升的，调用它们时这个常量必须已初始化） */
const TYPE_LABELS = { event: '日程', ddl: '截止', subtask: '子任务' };

/** 类型下拉 */
const TYPES = [
  { value: 'event', label: '日程' },
  { value: 'ddl', label: '截止' },
  { value: 'subtask', label: '子任务' },
];

/** 优先级下拉 */
const PRIORITIES = [
  { value: 'high', label: '高' },
  { value: 'mid', label: '中' },
  { value: 'low', label: '低' },
];

/** 重复方式 */
const REPEATS = [
  { value: 'none', label: '不重复' },
  { value: 'weekly', label: '每周重复（课程）' },
];

/** 单双周 */
const PARITIES = [
  { value: 'all', label: '每周' },
  { value: 'odd', label: '单周' },
  { value: 'even', label: '双周' },
];

/** 预计耗时预设（分钟）；0 = 不填 */
const DURATIONS = [0, 15, 30, 45, 60, 90, 120, 180, 240];

/** 周次范围 1 ~ 30（与云函数 normalize.js 的 MIN_WEEK / MAX_WEEK 一致） */
const WEEKS = (() => {
  const list = [];
  for (let i = 1; i <= 30; i += 1) list.push(i);
  return list;
})();

/** 表单空值模板（对象字面量会被复用，所以用函数返回新对象） */
function emptyForm() {
  return {
    type: 'event',
    title: '',
    date: '',
    start_time: '',
    end_time: '',
    periods: '',
    location: '',
    priority: 'mid',
    estimate_min: 0,
    repeat: 'none',
    week_start: 1,
    week_end: 20,
    week_parity: 'all',
    parent_id: '',
  };
}

Page({
  data: {
    // --- 表单数据（真正要提交的东西） ---
    form: emptyForm(),

    // --- 下拉数据 ---
    types: TYPES,
    priorities: PRIORITIES,
    repeats: REPEATS,
    parities: PARITIES,
    weekOptions: WEEKS,
    durationOptions: [],     // [{value, label}]，由 buildDurationOptions 生成
    parentOptions: [],       // [{value:'', label:'（不选）'}, {value:id, label:标题}]

    // --- 控件显示值（**不是**表单数据，见文件头注释） ---
    datePicker: '',
    startPicker: '08:00',
    endPicker: '09:00',

    // --- 各种下标 ---
    typeIndex: 0,
    priorityIndex: 1,
    repeatIndex: 0,
    parityIndex: 0,
    weekStartIndex: 0,
    weekEndIndex: 19,
    durationIndex: 0,
    parentIndex: 0,

    // --- 派生状态 ---
    isDdl: false,
    isSubtask: false,
    isWeekly: false,
    customDuration: false,   // 是否用数字输入框填耗时（预设里没有的值）
    customDurationText: '',

    // --- 页面状态 ---
    taskId: '',
    isEdit: false,
    loading: false,          // 编辑模式下首次读取的那一下
    saving: false,
    errorText: '',
    parentText: '（不选）',
    weekRangeText: '第 1 ~ 20 周',
    estimateText: '',
    submitText: '保存',
  },

  onLoad(options) {
    const taskId = str(options && options.id);
    this.original = null;
    this.allTasks = [];

    // 新增：不预设时间，只把控件显示值放到一个中性位置
    this.setData({
      taskId,
      isEdit: !!taskId,
      submitText: taskId ? '保存修改' : '添加任务',
      datePicker: todayStr(),   // 仅用于 date picker 的显示，不进 form
      durationOptions: buildDurationOptions(0),
    });

    if (taskId) this.loadTask(taskId);
    else this.refreshDerived();
  },

  // -------------------------------------------------------------------------
  // 读取（编辑模式）
  // -------------------------------------------------------------------------

  /**
   * 取全部任务 → 找到目标那条填进表单；同时把父任务候选也准备好。
   *
   * 【为什么要判 ok】utils/api.js 约定「失败不 reject，而是 resolve {ok:false, error}」。
   * 不判的话，"读取失败"会伪装成"这条任务已被删除"，把人引到完全错误的方向。
   *
   * @param {string} taskId 要编辑的任务 _id
   */
  loadTask(taskId) {
    this.setData({ loading: true, errorText: '' });
    api.listTasks().then((result) => {
      if (result && result.ok === false) throw new Error(describeError(result));
      const tasks = extractTasks(result);
      this.allTasks = tasks;
      const task = tasks.filter((item) => str(item._id) === taskId)[0];
      if (!task) {
        throw new Error('这条任务可能已被删除，请返回列表刷新');
      }
      this.original = task;
      this.fillForm(task, tasks);
      this.setData({ loading: false, errorText: '' });
    }).catch((err) => {
      this.setData({
        loading: false,
        errorText: `读取失败：${describeError(err)}`,
      });
    });
  },

  /**
   * 把一条已存在的任务填进表单。
   *
   * 【关键】这里只把**记录里真正有值**的字段填进 form。
   * 空的时间字段保持空字符串；而控件的显示值给一个中性默认，
   * 用户不动它，这个默认值就永远不会被保存。
   */
  fillForm(task, allTasks) {
    const type = str(task.type) || 'event';
    const priority = str(task.priority) || 'mid';
    const repeat = str(task.repeat) || 'none';
    const parity = str(task.week_parity) || 'all';
    const date = str(task.date);
    const startTime = str(task.start_time);
    const endTime = str(task.end_time);
    const estimateRaw = Number(task.estimate_min);
    const estimate = Number.isFinite(estimateRaw) && estimateRaw > 0 ? Math.round(estimateRaw) : 0;
    const parentId = str(task.parent_id);

    const durationOptions = buildDurationOptions(estimate);
    const durationIndex = indexOfValue(durationOptions, estimate);
    // 预设里没有这个分钟数 → 走数字输入框，原样保留用户以前填的值
    const customDuration = estimate > 0 && durationIndex === -1;

    const form = emptyForm();
    form.type = type;
    form.title = str(task.title);
    form.date = date;
    form.start_time = startTime;
    form.end_time = endTime;
    form.periods = str(task.periods);
    form.location = str(task.location);
    form.priority = priority;
    form.estimate_min = estimate;
    form.repeat = repeat;
    form.week_start = toWeek(task.week_start, 1);
    form.week_end = toWeek(task.week_end, 20);
    form.week_parity = parity;
    form.parent_id = parentId;

    const parentOptions = buildParentOptions(allTasks, task._id, parentId);

    this.setData({
      form,
      // 控件显示值：没值时给中性默认，但**不写回 form**
      datePicker: date || todayStr(),
      startPicker: startTime || '08:00',
      endPicker: endTime || '09:00',
      typeIndex: Math.max(indexOfValue(TYPES, type), 0),
      priorityIndex: Math.max(indexOfValue(PRIORITIES, priority), 0),
      repeatIndex: Math.max(indexOfValue(REPEATS, repeat), 0),
      parityIndex: Math.max(indexOfValue(PARITIES, parity), 0),
      weekStartIndex: form.week_start - 1,
      weekEndIndex: form.week_end - 1,
      durationIndex: customDuration ? 0 : Math.max(durationIndex, 0),
      durationOptions,
      customDuration,
      customDurationText: customDuration ? String(estimate) : '',
      parentOptions,
      parentIndex: Math.max(indexOfValue(parentOptions, parentId), 0),
    });
    this.refreshDerived();
  },

  // -------------------------------------------------------------------------
  // 表单交互
  // -------------------------------------------------------------------------

  /** 类型：日程 / 截止 / 子任务 */
  onTypeChange(event) {
    const index = Number(event.detail.value) || 0;
    const type = TYPES[index] ? TYPES[index].value : 'event';
    const patch = { typeIndex: index, 'form.type': type };
    // 不再是子任务就把归属清掉，免得留下一个说不清关系的字段
    if (type !== 'subtask') {
      patch['form.parent_id'] = '';
      patch.parentIndex = 0;
    }
    this.setData(patch);
    this.refreshDerived();
  },

  /** 标题（type="text" 的 input 没有 value 长度上限，很好用） */
  onTitleInput(event) {
    this.setData({ 'form.title': str(event.detail.value) });
  },

  /** 地点 */
  onLocationInput(event) {
    this.setData({ 'form.location': str(event.detail.value) });
  },

  /** 日期；控制「清除」按钮的显隐靠 form.date 是否为空 */
  onDateChange(event) {
    const value = str(event.detail.value);
    this.setData({ 'form.date': value, datePicker: value || todayStr() });
    this.refreshDerived();
  },

  /** 清除日期（回到"没填日期"，交给云函数补今天） */
  onClearDate() {
    this.setData({ 'form.date': '' });
    this.refreshDerived();
  },

  /** 开始时间；选了才写进 form（picker 的显示默认值不算用户输入） */
  onStartTimeChange(event) {
    const value = str(event.detail.value);
    this.setData({ 'form.start_time': value, startPicker: value || '08:00' });
    this.refreshDerived();
  },

  /** 清除开始时间 */
  onClearStart() {
    this.setData({ 'form.start_time': '' });
    this.refreshDerived();
  },

  /** 结束时间 */
  onEndTimeChange(event) {
    const value = str(event.detail.value);
    this.setData({ 'form.end_time': value, endPicker: value || '09:00' });
    this.refreshDerived();
  },

  /** 清除结束时间 */
  onClearEnd() {
    this.setData({ 'form.end_time': '' });
    this.refreshDerived();
  },

  /** 节次（"7-9" / "7"；留空表示按起止时间自动归类） */
  onPeriodsInput(event) {
    this.setData({ 'form.periods': str(event.detail.value) });
  },

  /** 优先级 */
  onPriorityChange(event) {
    const index = Number(event.detail.value) || 0;
    this.setData({
      priorityIndex: index,
      'form.priority': PRIORITIES[index] ? PRIORITIES[index].value : 'mid',
    });
  },

  /** 预计耗时（预设下拉） */
  onDurationChange(event) {
    const index = Number(event.detail.value) || 0;
    const option = this.data.durationOptions[index];
    const value = option ? Number(option.value) : 0;
    this.setData({
      durationIndex: index,
      'form.estimate_min': Number.isFinite(value) && value > 0 ? value : 0,
    });
    this.refreshDerived();
  },

  /** 预计耗时（自定义分钟数输入） */
  onDurationInput(event) {
    const raw = str(event.detail.value);
    const value = Number(raw);
    const minutes = raw && Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), 1440) : 0;
    this.setData({
      customDurationText: raw,
      'form.estimate_min': minutes,
    });
    this.refreshDerived();
  },

  /** 在「预设下拉」和「自己填分钟」之间切换 */
  onToggleCustomDuration() {
    const next = !this.data.customDuration;
    const minutes = Number(this.data.form.estimate_min) || 0;
    this.setData({
      customDuration: next,
      customDurationText: next ? (minutes > 0 ? String(minutes) : '') : '',
      durationIndex: next ? 0 : Math.max(indexOfValue(this.data.durationOptions, minutes), 0),
    });
  },

  /** 重复方式：不重复 / 每周重复 */
  onRepeatChange(event) {
    const index = Number(event.detail.value) || 0;
    const repeat = REPEATS[index] ? REPEATS[index].value : 'none';
    this.setData({ repeatIndex: index, 'form.repeat': repeat });
    this.refreshDerived();
  },

  /** 起始周 */
  onWeekStartChange(event) {
    const index = Number(event.detail.value) || 0;
    const week = WEEKS[index] || 1;
    // 起始周超过结束周时顺手对齐，避免提交一个倒挂的区间
    const end = Math.max(Number(this.data.form.week_end) || 20, week);
    this.setData({
      weekStartIndex: index,
      'form.week_start': week,
      'form.week_end': end,
      weekEndIndex: end - 1,
    });
    this.refreshDerived();
  },

  /** 结束周 */
  onWeekEndChange(event) {
    const index = Number(event.detail.value) || 0;
    let week = WEEKS[index] || 20;
    const start = Number(this.data.form.week_start) || 1;
    if (week < start) week = start; // 结束周不能早于起始周
    this.setData({
      weekEndIndex: week - 1,
      'form.week_end': week,
    });
    this.refreshDerived();
  },

  /** 单双周 */
  onParityChange(event) {
    const index = Number(event.detail.value) || 0;
    this.setData({
      parityIndex: index,
      'form.week_parity': PARITIES[index] ? PARITIES[index].value : 'all',
    });
    this.refreshDerived();
  },

  /** 选父任务（只对子任务有意义） */
  onParentChange(event) {
    const index = Number(event.detail.value) || 0;
    const option = this.data.parentOptions[index];
    this.setData({
      parentIndex: index,
      'form.parent_id': option ? str(option.value) : '',
    });
    this.refreshDerived();
  },

  // -------------------------------------------------------------------------
  // 派生文案（WXML 里不写复杂表达式，都在这里算好）
  // -------------------------------------------------------------------------

  /** 重算 isDdl / isWeekly / 各种提示文字 */
  refreshDerived() {
    const form = this.data.form;
    const isDdl = form.type === 'ddl';
    const isWeekly = form.repeat === 'weekly';
    const estimate = Number(form.estimate_min) || 0;

    let parentText = '（不选）';
    const options = this.data.parentOptions || [];
    for (let i = 0; i < options.length; i += 1) {
      if (str(options[i].value) === str(form.parent_id)) {
        // 表单里只显示标题本身；带 [类型] 与日期的长标签是下拉列表里用来区分同名任务的
        parentText = str(options[i].shortLabel) || options[i].label;
        break;
      }
    }

    this.setData({
      isDdl,
      isSubtask: form.type === 'subtask',
      isWeekly,
      parentText,
      weekRangeText: `第 ${form.week_start} ~ ${form.week_end} 周`,
      estimateText: estimate > 0 ? estimateLabel(estimate) : '未填写',
    });
  },

  // -------------------------------------------------------------------------
  // 保存
  // -------------------------------------------------------------------------

  /**
   * 保存：新增走 addTask，编辑走 updateTask。
   *
   * 编辑时**只提交真正改动过的字段**（diff），这样：
   *   1. 没碰过的字段绝不会被"顺手"覆盖（尤其是原本为空的时间）；
   *   2. 提交体积小，也不会因为某个字段的细微差异触发无意义的写。
   */
  onSave() {
    if (this.data.saving) return;

    const form = this.data.form;
    const title = str(form.title);
    if (!title) {
      wx.showToast({ title: '请先填写标题', icon: 'none' });
      return;
    }

    const built = buildPayload(form);
    const next = built.task;
    this.setData({ saving: true });

    if (!this.data.isEdit) {
      api.addTask(next).then((result) => {
        if (result && result.ok === false) throw new Error(describeError(result));
        this.setData({ saving: false });
        wx.showToast({ title: '已添加', icon: 'success' });
        this.backToList();
      }).catch((err) => {
        // 失败提示由 api.js 统一弹（它已经弹过一次了，这里不再重复弹）
        this.setData({ saving: false });
        console.warn('[edit] 新增失败：', describeError(err));
      });
      return;
    }

    const patch = diffPatch(this.original, next, built.alwaysSend);
    if (!Object.keys(patch).length) {
      this.setData({ saving: false });
      wx.showToast({ title: '没有改动', icon: 'none' });
      return;
    }

    api.updateTask(this.data.taskId, patch).then((result) => {
      if (result && result.ok === false) throw new Error(describeError(result));
      this.setData({ saving: false });
      wx.showToast({ title: '已保存', icon: 'success' });
      this.backToList();
    }).catch((err) => {
      this.setData({ saving: false });
      console.warn('[edit] 保存失败：', describeError(err));
    });
  },

  /** 保存成功后统一返回上一页（列表页 onShow 会自己刷新） */
  backToList() {
    setTimeout(() => {
      const pages = getCurrentPages();
      if (pages.length > 1) wx.navigateBack();
      else wx.redirectTo({ url: '/pages/tasks/tasks' });
    }, 600);
  },

  // -------------------------------------------------------------------------
  // 删除
  // -------------------------------------------------------------------------

  /** 删除：二次确认（会连带删掉子任务，文案必须写明白） */
  onRemove() {
    if (this.data.saving || !this.data.isEdit) return;
    const title = str(this.data.form.title) || '这条任务';
    const childCount = this.countChildren();

    const extra = childCount ? `\n它下面还有 ${childCount} 个子任务，会一并删除。` : '';
    wx.showModal({
      title: '确认删除',
      content: `确定删除「${title}」吗？删除后会一并删除其子任务，且无法恢复。${extra}`,
      confirmText: '删除',
      confirmColor: '#e0553f',
      success: (res) => {
        if (!res || !res.confirm) return;
        this.setData({ saving: true });
        api.removeTask(this.data.taskId).then((result) => {
          if (result && result.ok === false) throw new Error(describeError(result));
          this.setData({ saving: false });
          wx.showToast({ title: '已删除', icon: 'none' });
          this.backToList();
        }).catch((err) => {
          this.setData({ saving: false });
          console.warn('[edit] 删除失败：', describeError(err));
        });
      },
    });
  },

  /** 当前任务有几个直接子任务 */
  countChildren() {
    const id = str(this.data.taskId);
    if (!id) return 0;
    return (this.allTasks || []).filter((task) => str(task.parent_id) === id).length;
  },
});

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/**
 * 表单 → 提交给云函数的任务对象。
 *
 * 与云函数 normalize.js 的 TASK_FIELDS 白名单一一对应，不多传字段。
 *
 * 【DDL 的时间怎么放】截止的语义是"只有一个时刻"，所以统一放在 end_time，
 * 并把 start_time 显式写成空串（＝清空）。注意：`alwaysSend` 里会要求
 * end_time / start_time 必须出现在 patch 里 —— 因为把"日程"改成"截止"时，
 * 这两个字段的**含义**变了（区间起点→无，区间终点→唯一时刻），
 * 哪怕字符串没变也必须显式提交，不能让服务端的"只改我给的字段"去猜。
 *
 * @returns {{task: object, alwaysSend: string[]}}
 */
function buildPayload(form) {
  const isDdl = form.type === 'ddl';
  const startTime = str(form.start_time);
  const endTime = str(form.end_time);
  const isWeekly = form.repeat === 'weekly';

  const task = {
    type: form.type,
    title: str(form.title),
    date: str(form.date),                       // 允许为空：云函数会补今天
    start_time: isDdl ? '' : startTime,
    end_time: isDdl ? (endTime || startTime) : endTime,
    periods: str(form.periods),
    location: str(form.location),
    priority: form.priority,
    estimate_min: Number(form.estimate_min) > 0 ? Math.round(Number(form.estimate_min)) : 0,
    repeat: isWeekly ? 'weekly' : 'none',
    week_start: isWeekly ? toWeek(form.week_start, 1) : null,
    week_end: isWeekly ? toWeek(form.week_end, 20) : null,
    week_parity: isWeekly ? (str(form.week_parity) || 'all') : 'all',
  };

  // 只有子任务才带 parent_id（父任务本身留空，避免脏关系）
  task.parent_id = form.type === 'subtask' ? (str(form.parent_id) || null) : null;

  return { task, alwaysSend: isDdl ? ['start_time', 'end_time'] : [] };
}

/**
 * 编辑时只提交改动过的字段。
 *
 * 这样"用户没碰过的字段"根本不会出现在 patch 里 —— 包括那些本来就为空的时间字段。
 * （题外话：云函数里 title '' / date '2026-02-30' 这类"把字段清空成非法值"会被挡下来并报错，
 *  这是刻意的校验，不是这里能绕过的；这里只保证不主动多传。）
 *
 * @param {object} original 原始记录
 * @param {object} next 表单算出来的目标状态（buildPayload().task）
 * @param {string[]} [alwaysSend] 值虽然没变、但含义变了、必须显式提交的字段
 * @returns {object} 待提交的 patch（可能为空对象 = 没有任何改动）
 */
function diffPatch(original, next, alwaysSend) {
  const source = original || {};
  const mustSend = alwaysSend || [];
  const patch = {};
  Object.keys(next).forEach((key) => {
    const before = source[key] === undefined || source[key] === null ? '' : source[key];
    const after = next[key] === undefined || next[key] === null ? '' : next[key];
    if (String(before) !== String(after) || mustSend.indexOf(key) !== -1) {
      patch[key] = next[key];
    }
  });
  return patch;
}

/** 预计耗时下拉：预设 + （可选）把记录里那个"预设里没有"的值插进去 */
function buildDurationOptions(current) {
  const options = DURATIONS.map((minutes) => ({
    value: minutes,
    label: minutes > 0 ? estimateLabel(minutes) : '不填',
  }));
  const value = Number(current);
  if (Number.isFinite(value) && value > 0 && DURATIONS.indexOf(Math.round(value)) === -1) {
    options.splice(1, 0, { value: Math.round(value), label: estimateLabel(Math.round(value)) });
  }
  return options;
}

/** 耗时中文写法：45 → 「≈45 分钟」；90 → 「≈1.5 小时」；120 → 「≈2 小时」 */
function estimateLabel(minutes) {
  const value = Math.round(Number(minutes) || 0);
  if (value <= 0) return '不填';
  if (value < 60) return `≈${value} 分钟`;
  const hours = value / 60;
  const text = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  return `≈${text} 小时`;
}

/**
 * 父任务候选：所有「不是子任务」的任务（子任务不能挂在子任务下）。
 * 若正在编辑的这条原本就挂着一个已删掉的父任务，把它补进候选，
 * 免得用户一保存就把归属关系弄丢了。
 */
function buildParentOptions(allTasks, selfId, currentParentId) {
  const options = [{ value: '', label: '（不选）', shortLabel: '（不选）' }];
  const seen = {};
  let missingCurrent = !!currentParentId;

  (allTasks || []).forEach((task) => {
    const id = str(task._id);
    if (!id || id === str(selfId)) return;
    if (str(task.type) === 'subtask') return;
    if (seen[id]) return;
    seen[id] = true;
    if (id === str(currentParentId)) missingCurrent = false;
    const title = str(task.title) || '(无标题)';
    const typeLabel = TYPE_LABELS[str(task.type)] || '任务';
    const dateText = str(task.date) ? ` ${shortDate(task.date)}` : '';
    // label 给下拉列表（带类型与日期，方便区分同名任务）；shortLabel 给表单显示
    options.push({ value: id, label: `[${typeLabel}] ${title}${dateText}`, shortLabel: title });
  });

  if (missingCurrent) {
    options.push({ value: str(currentParentId), label: '(已删除的父任务)', shortLabel: '(已删除的父任务)' });
  }
  return options;
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

/** 从 [{value}] 里找 value 的下标；找不到返回 -1 */
function indexOfValue(list, value) {
  const target = str(value);
  const items = list || [];
  for (let i = 0; i < items.length; i += 1) {
    if (str(items[i].value) === target) return i;
  }
  // 数字型 value 也要能匹配（优先级/耗时是字符串与数字混着比）
  for (let i = 0; i < items.length; i += 1) {
    if (Number(items[i].value) === Number(value) && Number.isFinite(Number(value))) return i;
  }
  return -1;
}

/** 周次夹到 1~30 */
function toWeek(value, fallback) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.min(number, 30);
}

/** "2026-09-07" → "09-07" */
function shortDate(dateStr) {
  const text = str(dateStr);
  return text.length >= 10 ? text.slice(5) : text;
}

function pad2(number) {
  return number < 10 ? `0${number}` : String(number);
}

/** 今天（本地时区的日历日，与 utils/periods.js 口径一致） */
function todayStr() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
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
