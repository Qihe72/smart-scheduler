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
 *
 * ===========================================================================
 * 【占用提示（"这段时间已经有事了"）】
 * ===========================================================================
 *   日期 + 时间（或节次）一填好，就在时间那一栏下面出一行红字，例：
 *     该时间段已被占用：08:30-09:55 光学实训（与 1 条日程重叠）
 *   旁边给一个「换到最近的空闲**课节**」按钮。五条底线：
 *     1. **只提醒，不拦人**：保存逻辑一个字都不改（用户可能就是故意重叠），
 *        也**不加**二次确认弹窗 —— 那会让"保存"这件事变啰嗦；
 *     2. **算不动就不算**：任务列表拉不到时静默降级成"没有提示"，
 *        绝不因为拉不到列表就让新建任务不可用；
 *     3. **编辑时排除自己**：否则编辑自己的时间会一直撞自己，红字永远消不掉；
 *     4. **作息自己拉一次**（loadPeriodSettings）：绝不把内置默认作息当成
 *        用户的校准作息用 —— 那是"课表时间对不上"这一类 bug 的老根；
 *     5. **避让只给"整段的空闲课节"**（候选起点只有各节次开始时刻）：换出来的
 *        起点必然被某一节包含，周视图才画得对行；找不到就明说没有，不给
 *        "09:57 这种课间时刻" —— 那会让卡片落在跟时间对不上的一行。
 *   检测逻辑全在 utils/planner.js 的纯函数里（busyRangesOfDay / findConflicts /
 *   suggestFreeSlot，节次换算走 slotPeriods），这里只负责"什么时候算"和"算完怎么显示"。
 */

const api = require('../../utils/api.js');
const planner = require('../../utils/planner.js');

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
  { value: 'daily', label: '每天重复（打卡 / 习惯）' },
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
    isDaily: false,
    isRepeating: false,
    repeatHintText: '',
    customDuration: false,   // 是否用数字输入框填耗时（预设里没有的值）
    customDurationText: '',

    // --- 占用提示（见 refreshBusy） ---
    busyHint: '',            // 时间栏下方的红字；空串 = 不显示
    busyNote: '',            // 附注：有任务没写预计耗时，时长是估的
    canAvoid: false,         // 「换到最近的空闲课节」能不能点（找不到整段空闲课时为 false）
    avoidTip: '',            // 找不到空闲课节时的说明文字

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
    // 自己拉到的设置（见 loadPeriodSettings）；null / '' 表示"还没拿到，先看 globalData"
    this.periodTimes = null;
    this.semesterStart = '';

    // 新增：不预设时间，只把控件显示值放到一个中性位置
    this.setData({
      taskId,
      isEdit: !!taskId,
      submitText: taskId ? '保存修改' : '添加任务',
      datePicker: todayStr(),   // 仅用于 date picker 的显示，不进 form
      durationOptions: buildDurationOptions(0),
    });

    if (taskId) this.loadTask(taskId);
    else this.loadAllTasks();
  },

  // -------------------------------------------------------------------------
  // 读取（编辑模式）
  // -------------------------------------------------------------------------

  /**
   * 新增任务时也要把已有任务拉下来 —— 占用提示要拿它们做对比。
   *
   * 【为什么失败只 warn 不报错】新建任务本身不依赖这份列表（保存走 addTask）。
   * 拉不到就只是"这次没有占用提示"；如果照着 loadTask 那样写 errorText，
   * 整个表单会变成一页错误提示，新建任务直接不可用 —— 那是本末倒置。
   */
  loadAllTasks() {
    this.loadPeriodSettings();   // 与列表并行拉，谁先回来都会重算一次占用
    api.listTasks().then((result) => {
      if (result && result.ok === false) {
        console.warn('[edit] 拉取任务列表失败，本次不显示占用提示：', describeError(result));
        return;
      }
      this.allTasks = extractTasks(result);
      // 列表是异步回来的：这期间用户可能已经填好时间了，补算一次
      this.refreshBusy();
    }).catch((err) => {
      // api.listTasks 按约定不会 reject，这里只是兜底，行为与上面一致：静默降级
      console.warn('[edit] 拉取任务列表失败，本次不显示占用提示：', describeError(err));
    });
  },

  /**
   * 拉一次设置（校准作息 + 学期开始日期），拿到就重算占用。
   *
   * 【为什么编辑页必须自己拉，不能只信 app.globalData】app.js 启动时确实同步过一次
   * settings，但冷启动直接深链进编辑页（或 app 那次同步失败 / 还没回来）时，
   * globalData 里的 periodTimes 还是空对象 —— 而**空对象 = 用内置默认作息**。
   * 拿默认作息当校准作息用，正是"课表显示的时间跟实际对不上"那一类 bug 的根源
   * （默认作息里第 5 节是 14:00，校准后可能是 11:45），所以这里必须自己确认一次：
   * 只要 settings 里给了 period_times，占用检测就必须用**它**。
   *
   * 【失败不阻塞】按 api.js 的约定，getSettings 失败时它自己会弹一次 toast（那是
   * "请求失败"提示，页面这边关不掉）；本页保证的是：不写 errorText、不进错误页、
   * 照旧允许填表与保存 —— 代价只是这次的占用提示可能按默认作息算，不准而已。
   * 这比"因为读不到设置就不让人建任务"要好得多。
   */
  loadPeriodSettings() {
    return api.getSettings().then((result) => {
      if (result && result.ok === false) {
        console.warn('[edit] 读取设置失败，本次按已有作息（可能是默认表）算占用：', describeError(result));
        return;
      }
      const settings = extractSettings(result);
      // 只有真的拿到了才覆盖：云端没存过 period_times 时给的是 null，
      // 这时保持"空 = 默认作息"的语义，而不是把 {} 当成一份校准表
      if (settings.period_times) this.periodTimes = settings.period_times;
      if (settings.semester_start) this.semesterStart = settings.semester_start;
      this.refreshBusy();
    }).catch((err) => {
      // api.getSettings 按约定不会 reject，这里只是兜底：同样静默降级
      console.warn('[edit] 读取设置失败，本次按已有作息算占用：', describeError(err));
    });
  },

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
    this.loadPeriodSettings();   // 编辑模式同样要自己确认一次作息（见 loadPeriodSettings）
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
    // 节次也是"时间信息"的一种（没填时间时占用区间就是靠它算出来的），得跟着重算
    this.refreshBusy();
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

  /**
   * 重算 isDdl / isWeekly / 各种提示文字。
   *
   * 末尾顺带重算一次占用提示：所有会影响"时间占用"的交互（日期 / 起止时间 / 时长 /
   * 类型）都已经汇到这里了，在这一处收口比在每个 handler 里各写一行更难漏。
   */
  refreshDerived() {
    const form = this.data.form;
    const isDdl = form.type === 'ddl';
    const isWeekly = form.repeat === 'weekly';
    // 【每天重复】"每天"是含周末的七天都算（见 utils/periods.js 的 REPEAT_DAILY）。
    // 周次对它同样有意义（"第 1 ~ 20 周每天"），所以"起始周 / 结束周"照常显示；
    // 单双周只对每周重复有意义，对每天不显示（"每天，但只在单周"自相矛盾）。
    const isDaily = form.repeat === 'daily';
    const isRepeating = isWeekly || isDaily;
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
      isDaily,
      isRepeating,
      parentText,
      weekRangeText: `第 ${form.week_start} ~ ${form.week_end} 周`,
      // 【两种重复各一句人话】每天那句要说清楚三件事：含周末、从哪天开始、周视图会在七列都显示
      repeatHintText: isDaily
        ? `每天（含周六周日）从 ${str(form.date) || '选定的日期'} 开始，在第 ${form.week_start} ~ ${form.week_end} 周里每天出现；周视图里它会在周一到周日七列上都显示。`
        : `这门课会上 ${`第 ${form.week_start} ~ ${form.week_end} 周`}；周视图按这个范围显示。`,
      estimateText: estimate > 0 ? estimateLabel(estimate) : '未填写',
    });
    this.refreshBusy();
  },

  // -------------------------------------------------------------------------
  // 占用提示 / 一键避让
  // -------------------------------------------------------------------------

  /** 正在填的这条任务（占用检测里的"候选"）：字段与 planner.findConflicts 的 candidate 对齐 */
  candidateOf(form) {
    const source = form || this.data.form || {};
    const type = str(source.type) || 'event';
    const isDdl = type === 'ddl';
    const startTime = str(source.start_time);
    const endTime = str(source.end_time);
    return {
      id: str(this.data.taskId),          // 编辑模式下就是这条自己的 _id（用来排除自己）
      type,
      date: str(source.date),
      // 【与 buildPayload 同一口径】ddl 的 start_time 会连同保存一起被清掉（截止只有一个时刻），
      // 所以检测时也不能拿它当"开始时间"：否则从"日程"改成"截止"后，
      // 页面会提示一段根本不会被存下来的忙碌，红字与保存结果对不上。
      start_time: isDdl ? '' : startTime,
      end_time: isDdl ? (endTime || startTime) : endTime,
      estimate_min: Number(source.estimate_min) || 0,
      periods: str(source.periods),
    };
  },

  /**
   * 重算「该时间段已被占用」以及"能不能一键避让"。
   *
   * 【为什么同步算】planner 那三个函数都是纯内存计算（不发请求），所以每次改时间
   * 就地重算最稳；反过来，如果做成"每次按键发一次请求"，不但在输入时浪费调用，
   * 还会出现"后发的先回"把提示冲成旧结论的问题。
   *
   * 【什么时候不提示】没日期、或者既没时间也没节次时不提示 —— 那时用户还没表达
   * 任何时间意图，弹一句红字只是噪音。ddl 只填了截止时刻的情况**不用特判**：
   * planner 的口径是"截止时刻不是一段忙碌"，结论自然是没有占用。
   */
  refreshBusy() {
    const form = this.data.form || {};
    const date = str(form.date);
    const hasTime = !!(str(form.start_time) || str(form.end_time));
    const hasPeriods = !!str(form.periods);

    if (!date || (!hasTime && !hasPeriods)) {
      this.setBusy({});
      return;
    }

    const periodTimes = this.currentPeriodTimes();
    const semesterStart = this.currentSemesterStart();
    const found = planner.findConflicts(this.candidateOf(form), this.allTasks || [], periodTimes, {
      semesterStart,
    });
    const conflicts = found.conflicts || [];
    if (!conflicts.length) {
      this.setBusy({});
      return;
    }

    // 期望时刻与时长都取自 findConflicts 算好的"候选自己的区间"：
    // 这样"建议的空闲课节"和"红字里说的那段时间"永远是同一个口径（兜底规则也不会写两遍）。
    const slot = planner.suggestFreeSlot(date, found.end - found.start, this.allTasks || [], periodTimes, {
      after: found.start,
      semesterStart,
    });

    this.setBusy({
      busyHint: buildBusyHint(conflicts),
      busyNote: buildBusyNote(conflicts),
      canAvoid: !!slot,
      // 找不到就是找不到：明说"没有整段的空闲课节"，不让用户以为按钮坏了
      avoidTip: slot ? '' : '今天没有整段的空闲课节，可以自己挑一个别的时间。',
    });
  },

  /** 占用提示统一从这里写回（一次 setData，字段齐了才不会留下上一轮的残影） */
  setBusy(patch) {
    this.setData({
      busyHint: str(patch.busyHint),
      busyNote: str(patch.busyNote),
      canAvoid: patch.canAvoid === true,
      avoidTip: str(patch.avoidTip),
    });
  },

  /**
   * 当前生效的校准作息：**本页自己拉到的那份优先**（见 loadPeriodSettings），
   * 其次才看 app.globalData（app.js 启动时同步过一次），最后退回 {}＝内置默认作息。
   */
  currentPeriodTimes() {
    if (this.periodTimes && typeof this.periodTimes === 'object' && Object.keys(this.periodTimes).length) {
      return this.periodTimes;
    }
    return globalPeriodTimes();
  },

  /** 当前生效的学期开始日期（算"每周重复的课这周上不上"要用），口径同上 */
  currentSemesterStart() {
    return str(this.semesterStart) || globalSemesterStart();
  },

  /**
   * 一键避让：把起止时间换成"离期望时刻最近的空闲**课节**"。
   *
   * 【为什么是"课节"而不是"任意空闲分钟段"】suggestFreeSlot 的候选起点只有各节次的
   * 开始时刻（见 utils/planner.js 的 freeSlotCandidates），所以换出来的起点**必然**
   * 被某一节包含 → 节次写得出来 → 周视图把卡片画在正确的那一行。反过来，如果允许
   * "09:57 这种课间时刻"当起点，周视图只能靠就近吸附排版，卡片就会落在跟时间对不上
   * 的行上 —— 那正是用户最早报的那类观感问题。
   *
   * 【节次怎么填】一律走 planner.slotPeriods()。它推不出来时返回空串，这里就写空串
   * （绝不把老节次留在表单里造成"时间与显示不符"）；这条分支正常路径走不到，只是防御。
   *
   * 【找不到就不硬给】按钮此时是灰的，点一下也要有一句明确的话，
   * 而不是默默什么都不发生、也不是随便塞一个会把卡片画错行的时间。
   */
  onAvoidBusy() {
    const form = this.data.form || {};
    const date = str(form.date);
    const periodTimes = this.currentPeriodTimes();
    const semesterStart = this.currentSemesterStart();
    const found = planner.findConflicts(this.candidateOf(form), this.allTasks || [], periodTimes, {
      semesterStart,
    });

    // 理论上进不来（按钮只在有冲突时出现）；真进来了就按"没有可避让的"处理，别抛错
    const duration = found.start === null ? 0 : (found.end - found.start);
    const slot = planner.suggestFreeSlot(date, duration, this.allTasks || [], periodTimes, {
      after: found.start === null ? undefined : found.start,
      semesterStart,
    });

    if (!slot) {
      this.setBusy({
        busyHint: this.data.busyHint,
        busyNote: this.data.busyNote,
        canAvoid: false,
        avoidTip: '今天没有整段的空闲课节，可以自己挑一个别的时间。',
      });
      wx.showToast({ title: '今天没有整段的空闲课节', icon: 'none' });
      return;
    }

    const periodsText = planner.slotPeriods(slot.start_time, slot.end_time, periodTimes);
    const patch = {
      'form.start_time': slot.start_time,
      'form.end_time': slot.end_time,
      // 推不出节次就留空：绝不留一个跟新时间对不上的老节次（那会把卡片画到别处）
      'form.periods': periodsText,
      // picker 的显示值也要跟着走，否则"改"按钮点开还停在旧时刻上
      startPicker: slot.start_time,
      endPicker: slot.end_time,
    };

    this.setData(patch);
    this.refreshDerived();   // 里面会重算占用（换完通常就没有红字了）
    // 只报时间，不报节次：时段可能只盖住某节课的一头，说"第 3-4 节"反而容易让人以为占满了整节
    wx.showToast({
      title: periodsText
        ? `已换到 ${slot.start_time}-${slot.end_time}`
        : `已换到 ${slot.start_time}-${slot.end_time}，节次请自己填`,
      icon: 'none',
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

  /**
   * 【仅测试用】把页面内部用到的纯函数挂出来（utils/tests/edit_busy.test.js）。
   *
   * 为什么必须有 `buildPayload`：它是"表单 → 交给云函数的那份数据"的唯一出口，
   * 也就是**真正决定存下去什么**的那一层。早先它只在别的测试的注释里被提到过，
   * 没有一条断言直接盯着它 —— 加"每天重复"时正是这一层最容易漏掉一个分支
   * （漏了就会静默存成"不重复"）。小程序框架只会调用它认识的生命周期与事件方法，
   * 这个下划线开头的键永远不会被触发。
   */
  __test: {
    buildPayload: buildPayload,
    REPEATS: REPEATS,
    emptyForm: emptyForm,
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
  // 三种重复：none / weekly（课程）/ daily（打卡 · 习惯）
  const repeat = form.repeat === 'weekly' ? 'weekly' : (form.repeat === 'daily' ? 'daily' : 'none');
  // 【周次对每周与每天都有意义】"第几周到第几周"两种重复都要提交；
  // 单双周只给每周（每天重复时一律 all，与 utils/tasks.js 的补丁清理同一口径）。
  const repeating = repeat !== 'none';
  const isWeekly = repeat === 'weekly';

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
    repeat: repeat,
    week_start: repeating ? toWeek(form.week_start, 1) : null,
    week_end: repeating ? toWeek(form.week_end, 20) : null,
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
// 占用提示的文案（纯函数：输入是 planner 算出来的占用区间，输出是给人看的一句话）
// ---------------------------------------------------------------------------

/**
 * 红字提示。多条时只列前 2 条 + 「等 N 条」—— 全列出来会把表单挤得没法看，
 * 而"到底撞了哪几条"用户其实在列表页一眼就能看到。
 *
 *   1 条：该时间段已被占用：08:30-09:55 光学实训（与 1 条日程重叠）
 *   2 条：该时间段已被占用：08:30-09:55 光学实训、10:00-11:40 高等数学（与 2 条日程重叠）
 *   3 条：该时间段已被占用：08:30-09:55 光学实训、10:00-11:40 高等数学 等 3 条
 */
function buildBusyHint(conflicts) {
  const list = conflicts || [];
  if (!list.length) return '';
  const shown = list.slice(0, 2).map(busyRangeLabel).join('、');
  if (list.length > 2) return `该时间段已被占用：${shown} 等 ${list.length} 条`;
  return `该时间段已被占用：${shown}（与 ${list.length} 条${busyTypeWord(list)}重叠）`;
}

/** 一条占用区间写成 "08:30-09:55 光学实训" */
function busyRangeLabel(range) {
  const item = range || {};
  const start = str(item.start_time);
  const end = str(item.end_time);
  const time = start && end ? `${start}-${end}` : (start || end);
  const title = str(item.title) || '(无标题)';
  return time ? `${time} ${title}` : title;
}

/** "与 N 条 XX 重叠"里的 XX：撞上的是同一种类型就说类型名，混着就说"任务" */
function busyTypeWord(list) {
  const first = str(list[0].type) || 'event';
  const same = list.every((item) => (str(item.type) || 'event') === first);
  return same ? (TYPE_LABELS[first] || '任务') : '任务';
}

/**
 * 附注：撞上的任务里有"没写预计耗时"的，那段时间长度是按 30 分钟估的。
 * 必须说出来 —— 与项目里"算不准就不猜（算不准也要说清哪里不准）"是同一条原则。
 */
function buildBusyNote(conflicts) {
  const estimated = (conflicts || []).filter((item) => item.estimated === true);
  if (!estimated.length) return '';
  return `其中 ${estimated.length} 条没写预计耗时，占用时长按 30 分钟估算。`;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * app.globalData 里的校准作息（settings.period_times）—— **兜底来源**。
 *
 * 页面自己拉到的那份优先（见 loadPeriodSettings 与 currentPeriodTimes 方法）：
 * 这里只负责"页面还没拉到 / 拉失败"时给出一个可用的值。拿不到返回 {}，
 * 语义上等于"完全用 periods.js 的内置默认作息"。
 */
function globalPeriodTimes() {
  try {
    const app = typeof getApp === 'function' ? getApp() : null;
    if (app && typeof app.getPeriodTimes === 'function') return app.getPeriodTimes() || {};
    if (app && app.globalData && app.globalData.periodTimes) return app.globalData.periodTimes;
  } catch (err) {
    // 极端情况下（页面卸载中）getApp 可能抛错：不能让它把整张表单带崩
    console.warn('[edit] 读取作息失败，按默认作息算：', err);
  }
  return {};
}

/** app.globalData 里的学期开始日期（算"每周重复的课这周上不上"要用）；拿不到返回空串 */
function globalSemesterStart() {
  try {
    const app = typeof getApp === 'function' ? getApp() : null;
    if (app && typeof app.getSemesterStart === 'function') return str(app.getSemesterStart());
    if (app && app.globalData) return str(app.globalData.semesterStart);
  } catch (err) {
    console.warn('[edit] 读取学期开始日期失败：', err);
  }
  return '';
}

/**
 * 从 api.getSettings() 的返回值里取 {semester_start, period_times}。
 * 与 pages/week 的 extractSettings 同一套口径（都兼容 res.data 包装、都校验日期格式）。
 */
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
