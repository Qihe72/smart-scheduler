/**
 * pages/ai/ai.js —— AI 自然语言添加 + 大任务拆解。
 *
 * 这一页把两个 AI 云函数接到界面上（契约见 utils/api.js 文件头，实现在
 * cloudfunctions/aiParse 与 cloudfunctions/aiDecompose）：
 *
 *   ① 自然语言录入：输入一句话 → api.aiParse(text) → 模型返回 events / deadlines
 *      → 这里把它们摊成可勾选、可编辑的条目 → 确认后 api.bulkAdd(tasks) 落库。
 *   ② 任务拆解：选中一条已有任务 → api.aiDecompose({title, date}) → 得到 3~8 个
 *      带建议日期的子任务 → 确认后逐条 addTask({...type:'subtask', parent_id}) 落库。
 *
 * 【错误处理的一条铁律】AI 云函数失败时返回的 error 是后端写好的统一文案
 * （例如 'AI 服务暂不可用'，未配 Key / 超时 / 非 200 都是这一句）。
 * 本页**原样显示**，绝不自己编造"是不是 Key 没配""是不是超时了"这类更具体的原因 ——
 * 前端猜错了只会让人往错的方向排查。
 */

'use strict';

var api = require('../../utils/api.js');
var periods = require('../../utils/periods.js');
var tasksUtil = require('../../utils/tasks.js');
var planner = require('../../utils/planner.js');

/** aiParse 的输入上限（与云函数 aiParse 的 MAX_TEXT_LENGTH 保持一致） */
var MAX_TEXT_LENGTH = 500;

/** 一次 bulk_add 的上限（与云函数 tasks 的 MAX_BULK_INPUT 一致） */
var MAX_BULK_INPUT = 200;

Page({
  data: {
    mode: 'parse',            // 'parse' = 自然语言录入 | 'decompose' = 任务拆解

    // ---- 模式一：自然语言录入 ----
    inputText: '',
    parsing: false,
    parsed: null,             // { items: [...], clarification: '', hasAny: bool }
    parseError: '',
    needClarification: false,
    clarification: '',

    // ---- 模式二：任务拆解 ----
    courses: [],              // 可拆解的任务（带 parent 信息，够云函数用）
    picking: false,           // 是否正在加载任务列表
    pickedId: '',
    pickedTitle: '',
    pickedDate: '',            // 展示用：任务自己的日期（可能是空串）
    pickedDeadline: '',        // 发给云函数的截止日（没日期时按今天兜底）
    decomposing: false,
    subtasks: [],             // [{ title, suggested_date, estimate_min, selected }]
    decomposeError: '',

    // ---- 公共 ----
    submitting: false,
    tip: '',
    tipType: ''               // '' | 'ok' | 'warn'
  },

  /**
   * 页面加载。
   *
   * 支持两种入口（URL 契约由「任务」页那边定死）：
   *   /pages/ai/ai                            → 默认进「录入」模式
   *   /pages/ai/ai?mode=decompose&id=<taskId>  → 切到「拆解」模式，并自动选中该任务
   *
   * 【竞态】任务列表是异步从云函数拉的，onLoad 跑完时列表通常还没到。
   * 所以这里**不直接选中**，只把意图记进 this._pendingPickId，由 loadCourses() 在
   * 数据落地后调 resolvePendingPick() 完成选中 —— 这样"跳过来却没选中"就不会发生。
   *
   * @param {Object} options 页面参数（小程序会把 query 解析成对象）
   */
  onLoad: function (options) {
    var opts = options || {};

    // 云开发没就绪时先给一句明确提示（api.js 里也会兜底）
    var app = getApp();
    if (app && typeof app.ensureInit === 'function') {
      app.ensureInit();
    }

    // ① 入口模式：只有明确写了 mode=decompose 才进拆解；缺失/非法都当普通入口
    if (String(opts.mode || '') === 'decompose') {
      this.setData({ mode: 'decompose' });
    } else if (opts.mode) {
      // 给了 mode 但值不认识：当普通入口，静默忽略（不报错、不打断用户）
      console.warn('[ai] 不认识的 mode 参数，已按默认入口处理：', opts.mode);
    }

    // ② 目标任务 id：只有"拆解模式 + id 看着有效"才记下来等待选中
    var wantId = String(opts.id === undefined || opts.id === null ? '' : opts.id).trim();
    if (this.data.mode === 'decompose' && wantId && isValidTaskId(wantId)) {
      this._pendingPickId = wantId;
      this._pendingFromLink = true;
    } else if (wantId) {
      console.warn('[ai] id 参数无效或当前不是拆解模式，已忽略：', wantId);
    }

    this.loadCourses();
  },

  /**
   * 每次显示时兜一下：万一 onLoad 时列表还没回来、resolvePendingPick 又没被触发
   * （例如中途失败后重进本页），这里再尝试一次，避免"跳过来了但没选中"。
   *
   * 本页不是 tabBar 页面，每次 navigateTo 进来都会新建页面实例（会重新走 onLoad），
   * 所以这条路径主要是保险；留着它没有副作用 —— pendingPickId 一旦处理完就清空。
   */
  onShow: function () {
    if (this._pendingPickId && this.data.courses.length) {
      this.resolvePendingPick();
    }
  },

  // -------------------------------------------------------------------------
  // 模式切换
  // -------------------------------------------------------------------------

  /** 切到自然语言录入 */
  switchToParse: function () {
    this.setData({ mode: 'parse', tip: '', tipType: '' });
  },

  /** 切到任务拆解 */
  switchToDecompose: function () {
    this.setData({ mode: 'decompose', tip: '', tipType: '' });
    if (!this.data.courses.length) this.loadCourses();
  },

  // -------------------------------------------------------------------------
  // 模式一：自然语言录入
  // -------------------------------------------------------------------------

  /** 输入框变化 */
  onInput: function (event) {
    this.setData({ inputText: (event.detail && event.detail.value) || '' });
  },

  /** 清空输入与结果 */
  onClearInput: function () {
    this.setData({
      inputText: '',
      parsed: null,
      parseError: '',
      needClarification: false,
      clarification: '',
      tip: '',
      tipType: ''
    });
  },

  /** 点「解析」 */
  onParse: function () {
    var self = this;
    var text = String(this.data.inputText || '').trim();

    if (!text) {
      this.setData({ parseError: '请先输入你的安排，例如：明天下午三点开组会', tip: '', tipType: '' });
      return;
    }
    if (text.length > MAX_TEXT_LENGTH) {
      // 本地先拦一道：免得白跑一次云函数（云函数也会返回"输入过长"）
      this.setData({
        parseError: '输入过长（最多 ' + MAX_TEXT_LENGTH + ' 字），请分几次输入',
        tip: '',
        tipType: ''
      });
      return;
    }

    this.setData({ parsing: true, parseError: '', parsed: null, tip: '', tipType: '' });

    api.aiParse(text).then(function (res) {
      if (!res.ok) {
        // 【原样显示后端的 error】，不加工
        self.setData({ parsing: false, parseError: res.error });
        return;
      }

      var data = res.data || {};
      var items = buildParseItems(data);
      self.setData({
        parsing: false,
        parseError: '',
        parsed: { items: items, hasAny: items.length > 0 },
        needClarification: data.needs_clarification === true,
        clarification: String(data.clarification_question || '')
      });
    });
  },

  /** 勾选 / 取消勾选某一条解析结果 */
  onToggleItem: function (event) {
    var index = Number(event.currentTarget.dataset.index);
    var parsed = this.data.parsed;
    if (!parsed || !parsed.items[index]) return;
    var items = parsed.items.slice();
    items[index] = Object.assign({}, items[index], { selected: !items[index].selected });
    this.setData({ parsed: { items: items, hasAny: parsed.hasAny } });
  },

  /** 全选 / 全不选 */
  onToggleAll: function () {
    var parsed = this.data.parsed;
    if (!parsed || !parsed.items.length) return;
    var allOn = parsed.items.every(function (item) { return item.selected; });
    var items = parsed.items.map(function (item) {
      return Object.assign({}, item, { selected: !allOn });
    });
    this.setData({ parsed: { items: items, hasAny: parsed.hasAny } });
  },

  /** 确认入库：把勾选的条目交给 tasks 的 bulk_add */
  onConfirmImport: function () {
    var self = this;
    var parsed = this.data.parsed;
    if (!parsed || !parsed.items.length) return;

    var picked = parsed.items.filter(function (item) { return item.selected; });
    if (!picked.length) {
      this.setData({ tip: '请至少勾选一条要添加的日程', tipType: 'warn' });
      return;
    }
    if (picked.length > MAX_BULK_INPUT) {
      this.setData({ tip: '一次最多导入 ' + MAX_BULK_INPUT + ' 条', tipType: 'warn' });
      return;
    }

    // 只把云函数认识的字段发过去（title/type/date/start_time/end_time/priority…）
    var list = picked.map(function (item) { return item.task; });

    this.setData({ submitting: true, tip: '', tipType: '' });
    api.importParsedTasks(list).then(function (res) {
      if (!res.ok) {
        self.setData({ submitting: false, tip: res.error, tipType: 'warn' });
        return;
      }
      var inserted = (res.data && res.data.inserted) || 0;
      var skipped = (res.data && res.data.skipped) || 0;
      var message = '已添加 ' + inserted + ' 条';
      if (skipped) message += '，跳过 ' + skipped + ' 条（云端校验没过）';

      self.setData({
        submitting: false,
        parsed: null,
        inputText: '',
        needClarification: false,
        clarification: '',
        tip: message,
        tipType: skipped ? 'warn' : 'ok'
      });
    });
  },

  // -------------------------------------------------------------------------
  // 模式二：任务拆解
  // -------------------------------------------------------------------------

  /**
   * 拉任务列表，算出"哪些能拆解"。
   *
   * 列表来自云函数（异步），所以**选中动作必须发生在这里**，不能放在 onLoad：
   * 数据一落地就调 resolvePendingPick() 去兑现 onLoad 记下的意图。
   */
  loadCourses: function () {
    var self = this;
    this.setData({ picking: true, decomposeError: '' });

    api.listTasks().then(function (res) {
      if (!res.ok) {
        self.setData({ picking: false, decomposeError: res.error });
        return;
      }

      var all = (res.data && res.data.tasks) || [];
      var now = new Date();
      var semesterStart = self.semesterStart();
      var byId = {};      // 全部任务（含不能拆的）——用来如实说明"为什么不能拆"
      var candidates = [];

      all.forEach(function (task) {
        if (!task || typeof task !== 'object') return;
        var id = String(task._id || '');
        if (!id) return;
        var state = tasksUtil.taskState(task, semesterStart, now);
        var blocked = decomposeBlockedReason(task, state);
        var item = {
          _id: id,
          title: tasksUtil.displayTitle(task),
          date: String(task.date || ''),
          // 真正传给云函数的截止日：没日期就按今天算（见 deadlineFor）
          deadline: deadlineFor(task),
          hasDate: tasksUtil.isValidDate(task.date),
          timeText: tasksUtil.timeText(task),
          priority: String(task.priority || 'mid'),
          priorityLabel: tasksUtil.PRIORITY_LABELS[task.priority] || '中',
          repeatLabel: task.repeat === 'weekly' ? '每周' : '',
          state: state,
          blockedReason: blocked
        };
        byId[id] = item;
        if (!blocked) candidates.push(item);
      });

      self._taskById = byId;
      self.setData({ picking: false, courses: candidates });

      // 数据到位了，兑现 onLoad 里的选中意图（这就是防竞态的那一步）
      self.resolvePendingPick();
    });
  },

  /**
   * 兑现 onLoad / onShow 记下的"自动选中某条任务"的意图。
   *
   * 三种结局，都**如实**反映，不静默忽略、也不假装选中：
   *   'selected'    → 选中成功（来自深链时提示一句"已选中"）
   *   'cant'        → 找到了这条任务，但它不能拆（已完成 / 是子任务 / 没日期…）
   *                   → toast 说明真实原因，退回普通列表
   *   'missing'     → 列表里根本没有这个 id（已删除 / id 不对 / 不是自己的）
   *                   → toast 说明"没找到"，退回普通列表
   *
   * @returns {string} 'none' | 'selected' | 'cant' | 'missing'
   */
  resolvePendingPick: function () {
    var id = this._pendingPickId;
    if (!id) return 'none';

    var fromLink = this._pendingFromLink === true;
    this._pendingPickId = '';       // 无论成败都清空，避免反复弹同一句提示
    this._pendingFromLink = false;

    var byId = this._taskById || {};
    var hit = byId[id];

    if (!hit) {
      wx.showToast({ title: '没找到这条任务，可能已被删除', icon: 'none', duration: 2200 });
      return 'missing';
    }
    if (hit.blockedReason) {
      wx.showToast({ title: hit.blockedReason, icon: 'none', duration: 2600 });
      return 'cant';
    }

    this.pickCourse(hit);
    if (fromLink) {
      wx.showToast({ title: '已选中：' + hit.title, icon: 'none', duration: 1600 });
    }
    return 'selected';
  },

  /** 全局的学期开始日期（用于状态判断） */
  semesterStart: function () {
    var app = getApp();
    return (app && app.globalData && app.globalData.semesterStart) || '';
  },

  /** 真正落地"选中某条任务"这件事（列表点击与自动选中都走它） */
  pickCourse: function (item) {
    if (!item) return;
    this.setData({
      pickedId: item._id,
      pickedTitle: item.title,
      // 展示用：任务自己的日期（可能是空串，表示"只有时间没日期"）
      pickedDate: item.date,
      // 发给云函数的截止日：没日期时已按今天兜底（见 deadlineFor）
      pickedDeadline: item.deadline || item.date || '',
      subtasks: [],
      decomposeError: '',
      tip: '',
      tipType: ''
    });
  },

  /** 选中一条任务（用户点击列表） */
  onPickCourse: function (event) {
    var id = String(event.currentTarget.dataset.id || '');
    var hit = this.data.courses.filter(function (item) { return item._id === id; })[0];
    if (!hit) return;
    this.pickCourse(hit);
  },

  /** 点「拆解」 */
  onDecompose: function () {
    var self = this;
    if (!this.data.pickedId) {
      this.setData({ decomposeError: '请先选一条要拆解的任务' });
      return;
    }

    this.setData({ decomposing: true, decomposeError: '', subtasks: [], tip: '', tipType: '' });

    var deadline = this.data.pickedDeadline || this.data.pickedDate;
    api.aiDecompose({ title: this.data.pickedTitle, date: deadline }).then(function (res) {
      if (!res.ok) {
        // 同样原样显示后端的错误文案
        self.setData({ decomposing: false, decomposeError: res.error });
        return;
      }
      var data = res.data || {};
      var subtasks = (data.subtasks || []).map(function (item) {
        return {
          title: String(item.title || ''),
          suggested_date: String(item.suggested_date || ''),
          estimate_min: Number(item.estimate_min) || 0,
          estimateText: subtasksEstimateText(item.estimate_min),
          selected: true
        };
      });
      self.setData({ decomposing: false, subtasks: subtasks });
      if (!subtasks.length) {
        self.setData({ decomposeError: '这次没有拆出可用的步骤，可以再试一次' });
      }
    });
  },

  /** 勾选 / 取消勾选某个子任务 */
  onToggleSubtask: function (event) {
    var index = Number(event.currentTarget.dataset.index);
    var list = this.data.subtasks.slice();
    if (!list[index]) return;
    list[index] = Object.assign({}, list[index], { selected: !list[index].selected });
    this.setData({ subtasks: list });
  },

  /** 确认入库：勾选的子任务逐条写成 subtask，挂在被拆解的任务下面 */
  onConfirmSubtasks: function () {
    var self = this;
    var picked = this.data.subtasks.filter(function (item) { return item.selected; });
    if (!picked.length) {
      this.setData({ tip: '请至少勾选一个步骤', tipType: 'warn' });
      return;
    }

    this.setData({ submitting: true, tip: '', tipType: '' });

    // 逐条 add：子任务各自有 date / estimate_min，比 bulk_add 更好确认每条的成败。
    // 用 Promise.all 并发提交，条数最多 8 条，不会触发云函数并发限制。
    var jobs = picked.map(function (item) {
      return api.addTask({
        title: item.title,
        type: 'subtask',
        date: item.suggested_date,
        start_time: '',
        end_time: '',
        priority: 'mid',
        done: false,
        parent_id: self.data.pickedId,
        repeat: 'none',
        estimate_min: item.estimate_min
      });
    });

    Promise.all(jobs).then(function (results) {
      var okCount = results.filter(function (r) { return r && r.ok; }).length;
      var failCount = results.length - okCount;
      var message = '已添加 ' + okCount + ' 个子任务';
      if (failCount) message += '，' + failCount + ' 条失败';
      self.setData({
        submitting: false,
        subtasks: [],
        tip: message,
        tipType: failCount ? 'warn' : 'ok'
      });
      if (okCount) self.loadCourses(); // 刷新列表（子任务不算候选，但计数会变）
    });
  },

  /** 去新建任务页（拆解列表为空时的出口） */
  goCreate: function () {
    wx.navigateTo({ url: '/pages/edit/edit' });
  },

  /** 去任务列表看结果 */
  goTasks: function () {
    wx.switchTab({ url: '/pages/tasks/tasks' });
  },

  /**
   * 【仅测试用】把页面内部用到的纯函数挂出来，供 utils/tests/ai_page.test.js 直接调用。
   *
   * 为什么挂在这里而不是另开一个模块：这样测试跑的就是**页面真正在用的那一份实现**，
   * 不会出现"测的是一份、跑的是另一份"。小程序框架只会调用它认识的生命周期与事件
   * 方法（onLoad/onShow/onXxx），这个下划线开头的键永远不会被触发。
   */
  __test: {
    isValidTaskId: isValidTaskId,
    decomposeBlockedReason: decomposeBlockedReason,
    buildParseItems: buildParseItems,
    timeRangeText: timeRangeText,
    priorityTagClass: priorityTagClass
  }
});

// ---------------------------------------------------------------------------
// 纯函数（不依赖 Page / wx，便于单独阅读与以后抽出去测）
// ---------------------------------------------------------------------------

/**
 * 把 aiParse 的返回摊成"一条一行、可勾选"的条目。
 *
 * 云函数已经额外返回了一个 tasks[]（能直接落库的形态），但那是 events+deadlines
 * 拼起来的，和这里要显示的条目**一一对应**；为了显示要的中文类型名、时间文案，
 * 这里按 events / deadlines 分别构造，同时把落库要用的 task 挂在条目上。
 *
 * @param {Object} data aiParse 的 data
 * @returns {Array<Object>} [{ kind, title, date, timeText, typeLabel, priorityLabel, tagClass, task, selected }]
 */
function buildParseItems(data) {
  var items = [];
  var events = (data && data.events) || [];
  var deadlines = (data && data.deadlines) || [];
  var taskList = (data && data.tasks) || [];

  // tasks[] 的顺序是 events 在前、deadlines 在后（见 aiParse 的 toTaskList），
  // 这里按同样的顺序取用，保证"显示的那条"和"落库的那条"是同一个对象。
  var cursor = 0;

  events.forEach(function (item) {
    var task = taskList[cursor] || null;
    cursor += 1;
    items.push({
      kind: 'event',
      title: String((item && item.title) || ''),
      date: String((item && item.date) || ''),
      timeText: timeRangeText(item && item.start_time, item && item.end_time),
      typeLabel: '日程',
      priority: String((item && item.priority) || '中'),
      priorityLabel: String((item && item.priority) || '中'),
      tagClass: priorityTagClass(item && item.priority),
      task: task,
      selected: true
    });
  });

  deadlines.forEach(function (item) {
    var task = taskList[cursor] || null;
    cursor += 1;
    items.push({
      kind: 'ddl',
      title: String((item && item.title) || ''),
      date: String((item && item.date) || ''),
      timeText: timeRangeText('', item && item.end_time),
      typeLabel: '截止',
      priority: String((item && item.priority) || '高'),
      priorityLabel: String((item && item.priority) || '高'),
      tagClass: priorityTagClass(item && item.priority),
      task: task,
      selected: true
    });
  });

  // 兜底：万一后端只给了 tasks[]（字段对不上时），也不至于让用户看到空白页
  if (!items.length && taskList.length) {
    taskList.forEach(function (task) {
      items.push({
        kind: String(task.type || 'event') === 'ddl' ? 'ddl' : 'event',
        title: String(task.title || ''),
        date: String(task.date || ''),
        timeText: timeRangeText(task.start_time, task.end_time),
        typeLabel: String(task.type || '') === 'ddl' ? '截止' : '日程',
        priority: String(task.priority || 'mid'),
        priorityLabel: tasksUtil.PRIORITY_LABELS[task.priority] || '中',
        tagClass: priorityTagClass(task.priority),
        task: task,
        selected: true
      });
    });
  }

  // 没标题或没日期的条目直接丢掉（云端也会丢，这里先丢是为了不显示无效行）
  return items.filter(function (item) { return item.title && item.date; });
}

/** 时间文案：'15:00-16:00' / '15:00 起' / '12:00 前' / '--' */
function timeRangeText(start, end) {
  var from = periods.formatMinutes(periods.toMinutes(start));
  var to = periods.formatMinutes(periods.toMinutes(end));
  if (from && to) return from + '-' + to;
  if (from) return from + ' 起';
  if (to) return to + ' 前';
  return '--';
}

/** 中文优先级 → 标签样式类（复用 app.wxss 里的 .tag-high/.tag-mid/.tag-low） */
function priorityTagClass(priority) {
  var text = String(priority || '').trim();
  if (text === '高' || text === 'high') return 'tag-high';
  if (text === '低' || text === 'low') return 'tag-low';
  return 'tag-mid';
}

/** 子任务的预计耗时文案（复用 planner 的"人话"：60 → "1 小时"，0 → "—"） */
function subtasksEstimateText(minutes) {
  return planner.formatMinutes(minutes);
}

/**
 * 判断一个 url 参数里的 id 是否"看着有效"（用来挡掉 `?id=`、`?id=  `、`?id=null` 这类脏输入）。
 * 云数据库的 _id 是字符串；这里不硬性要求长度，只要非空、控制字符与空白即可，
 * 真伪交给列表查表（resolvePendingPick 里会给出"没找到"）。
 */
function isValidTaskId(value) {
  var text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) return false;
  if (text === 'undefined' || text === 'null') return false; // 前端拼串常出现的两种情况
  return /^[A-Za-z0-9_-]{3,128}$/.test(text);
}

/**
 * 这条任务能不能被 AI 拆解？不能的话返回一句**能直接给用户看**的中文原因，能则返回 ''。
 *
 * 【两边的口径必须一样】「任务」页的拆解按钮用的是同一套判据（见 pages/tasks/tasks.js
 * 的 decomposeInfo）：已完成 / 已结课不给拆、子任务不给拆、**既没日期也没时间**不给拆。
 * 这里刻意放宽成"有 date **或** 有 start_time/end_time 之一即可" —— 否则会出现
 * "任务页有按钮、点进来却说没找到"的割裂体验（两边判据差一条就是 bug）。
 *
 * 这个原因会同时用于两处：① 列表里过滤；② 深链自动选中失败时 toast 说明真实原因
 * （不能静默忽略，也不能假装选中）。
 *
 * @param {Object} task 云数据库里的任务
 * @param {string} state utils/tasks.js 的 taskState() 结果（'done'|'finished'|'pending'）
 * @returns {string} '' 表示可以拆解
 */
function decomposeBlockedReason(task, state) {
  if (!task || typeof task !== 'object') return '这条任务不可用';
  if (!tasksUtil.toStr(task.title)) return '这条任务没有标题，无法拆解';
  if (state === 'done') return '这条任务已完成，不用再拆解了';
  if (state === 'finished') return '这门课已经结课，不用再拆解了';
  if (String(task.type || '') === 'subtask') return '这本身就是一个子任务，不能再拆';
  // 与任务页一致：有日期，或者有起止时间之一，就算"有时间信息"
  if (!hasAnyTimeInfo(task)) return '先补上日期，AI 才能把子任务排开';
  return '';
}

/** 这条任务有没有"时间信息"：合法日期，或者 start_time / end_time 之一 */
function hasAnyTimeInfo(task) {
  if (!task || typeof task !== 'object') return false;
  if (tasksUtil.isValidDate(task.date)) return true;
  return !!tasksUtil.toStr(task.start_time) || !!tasksUtil.toStr(task.end_time);
}

/**
 * 拆解时要传给云函数的截止日期（云函数要求 YYYY-MM-DD，并把子任务排在"今天~截止日"之间）。
 *
 * 任务自己有日期就用它；只有时间没日期（任务页也允许这种任务进来）时，
 * 按"就是今天"处理 —— 这是唯一不会把子任务排到过去的解释，
 * 同时也和任务页那句提示（"先补上日期，AI 才能把子任务排开"）不冲突：
 * 它只是不拦你进来，不代表它能凭空知道你指哪一天。
 */
function deadlineFor(task) {
  if (task && tasksUtil.isValidDate(task.date)) return String(task.date);
  return tasksUtil.todayStr();
}
