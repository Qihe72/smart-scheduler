/**
 * pages/ai/ai.js —— AI 自然语言添加 + 大任务拆解。
 *
 * 这一页把两个 AI 云函数接到界面上（契约见 utils/api.js 文件头，实现在
 * cloudfunctions/aiParse 与 cloudfunctions/aiDecompose）：
 *
 *   ① 自然语言录入：输入一句话 → api.aiParse(text) → 模型返回 events / deadlines
 *      → 这里把它们摊成可勾选、可编辑的条目 → 确认后 api.bulkAdd(tasks) 落库。
 *   ① b 课表截图识别（模式一里的第二张卡）：拍照 / 相册选图 → 压缩 → api.aiParseImage()
 *      → 用**用户自己的 Key** 让多模态模型把截图认成课程（repeat:'weekly' + 节次 + 周次）
 *      → 同一套勾选列表 → 「替换课表」(api.importReplace) 或 「追加导入」(api.importParsedTasks)。
 *      模型不支持识图时**一个请求都不发**，直接把"换成 glm-5.3-flash / glm-ocr"说清楚
 *      （判据见 utils/api.js 的 classifyVisionModel，与云函数那份名单由测试钉住）。
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

/**
 * 识图 base64 的字符数上限（与 utils/api.js / 云函数 aiParse 那份一致）。
 * 取 api 导出的那个常量，取不到（老版本 api.js）就用同一个数字兜底。
 */
var MAX_IMAGE_BASE64_CHARS = Number(api.MAX_IMAGE_BASE64_CHARS) || 900000;

/**
 * 已停用（官方公告停止服务）的模型名 → 建议改用的模型名。
 *
 * 【事实依据】DeepSeek 官方 changelog（https://api-docs.deepseek.com/updates/）：
 * 2026-07-24 起 `deepseek-chat` / `deepseek-reasoner` **停止服务**（它们当年指向
 * V4-Flash 的非思考/思考模式）；2026-09-10 发布的 V4.1-Flash 是原生多模态，
 * API 模型名 `deepseek-flash`。
 *
 * 【为什么要和"不支持识图"分开说】两件事给用户的下一步不一样：一个是"换个模型"，
 * 另一个是"你存的名字已经不被服务了，改成 X"。而且**都不需要换服务商** ——
 * 早先版本以为 DeepSeek 没有多模态、劝人换服务商，那是错的（见文件末尾的更正说明）。
 */
var RETIRED_MODELS = {
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash'
};

Page({
  data: {
    mode: 'parse',            // 'parse' = 自然语言录入 | 'decompose' = 任务拆解

    // ---- 模式一：自然语言录入 ----
    inputText: '',
    parsing: false,
    parsed: null,             // { items: [...], clarification: '', hasAny: bool }
    parsedSource: '',         // '' | 'text' | 'image' —— 当前 parsed 是哪条路来的（防串数据）
    parseError: '',
    needClarification: false,
    clarification: '',

    // ---- 模式一之二：课表截图识别（用用户自己的 Key + 多模态模型）----
    visionReady: false,       // api.aiParseImage 是否就绪
    aiProvider: '',           // 云端读到的服务商（'zhipu' / 'deepseek' / ''）
    aiModel: '',              // **实际会被使用的模型名**（没填就用该服务商的默认模型兜出来）
    visionState: 'unknown',   // true（已知支持识图）| false（已知纯文本模型）| 'unknown'
    visionHint: '',           // 选图之前就显示的那句提示
    visionHintLevel: '',      // 'danger'（红）| 'muted'（灰）| 'ok'（绿）| ''
    imagePath: '',            // 压缩后的临时文件路径（只用来显示缩略图）
    imageMime: '',            // 送给云函数的 mime（从图片魔数/后缀判出来）
    imageSizeText: '',        // 「已压缩到约 N KB」
    imageSource: '',          // '拍照' | '相册'（显示用）
    imageError: '',           // 选图/压缩/读文件阶段的错误
    visionBusy: false,        // 正在识别（按钮 loading + 秒数计时）
    visionElapsed: 0,         // 已经等了多久（秒）
    visionError: '',          // 识别失败的人话（原样显示后端文案）
    visionWarnings: [],       // 模型自己说"哪里没看清" / 云端跳过的脏条目
    visionNotes: '',          // 模型的一句话总结
    periodsSaveText: '',      // 「并按截图校准了 N 节作息」/「作息校准未保存：…」

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

    // 识图能力提示要在**选图之前**就位，所以这里顺手把当前 AI 配置读一次。
    // 【两条自我约束】① 只在"录入"模式读（从任务页点"拆解"进来的用户根本不碰识图，
    // 不该为他多发一次请求）；② 用 `{silent:true}` —— 用户还没做任何操作，
    // 读不到就退化成灰字"没能读到 AI 配置"，**绝不弹 toast 打扰**（他可能只想用文字录入）。
    this.setData({ visionReady: typeof api.aiParseImage === 'function' });
    if (this.data.mode === 'parse') this.loadAiConfig();
  },

  /**
   * 页面卸载：**必须清掉识别计时器**。
   *
   * setInterval 不会因为页面销毁而自动停 —— 在真机上它会一直跑、每秒 setData 一次
   * （控制台刷警告、白耗电）。所以 onUnload 里先停表，再用 _visionGone 让迟到的
   * 回调不再 setData（请求已经在路上了，拦不住，但不能让它往已销毁的页面上写）。
   */
  onUnload: function () {
    this._visionGone = true;
    this.stopVisionTimer();
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

  /**
   * 切到自然语言录入。
   * 【清结果】两条路（文字 / 截图）共用同一套结果区，切模式时把上一条路的结果清干净，
   * 免得出现"文字解析的列表 + 识图的警告"混在一起这种说不清来源的界面。
   */
  switchToParse: function () {
    this.clearResults();
    this.setData({ mode: 'parse', tip: '', tipType: '' });
    if (!this.data.aiModel) this.loadAiConfig(); // 刚才可能没读到（例如进页面时断网），回来再试一次
  },

  /** 切到任务拆解 */
  switchToDecompose: function () {
    this.clearResults();
    this.setData({ mode: 'decompose', tip: '', tipType: '' });
    if (!this.data.courses.length) this.loadCourses();
  },

  /** 清掉两条路共用的结果区（结果 / 错误 / 警告 / 作息提示） */
  clearResults: function () {
    this._visionPeriodTimes = null;
    this.setData({
      parsed: null,
      parsedSource: '',
      parseError: '',
      needClarification: false,
      clarification: '',
      visionError: '',
      visionWarnings: [],
      visionNotes: '',
      periodsSaveText: ''
    });
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
      parsedSource: '',
      parseError: '',
      needClarification: false,
      clarification: '',
      tip: '',
      tipType: ''
    });
  },

  /**
   * 点「解析」（文本路径）。
   *
   * 【只清自己那条路的状态】上一次可能是"识图"跑出来的结果与警告，这里必须一并清掉，
   * 否则会出现"解析出 2 条文字日程"却顶着"识图提示：第 3 行看不清"的荒唐界面。
   * 注意**不清**已选好的图片（用户可能只是想先试一句话，再回去识别）。
   */
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

    this.setData({
      parsing: true,
      parseError: '',
      parsed: null,
      parsedSource: '',
      tip: '',
      tipType: '',
      // 走的是文本这条路：把识图留下的错误/警告/作息提示清掉（结果区只有一套）
      visionError: '',
      visionWarnings: [],
      visionNotes: '',
      periodsSaveText: ''
    });
    this._visionPeriodTimes = null;

    api.aiParse(text).then(function (res) {
      if (!res.ok) {
        // 【后端那句 error 原样显示；平台级失败（超时/没部署）翻译成人话】见 explainAiFailure
        self.setData({ parsing: false, parseError: explainAiFailure(res.error, 'aiParse') });
        return;
      }

      var data = res.data || {};
      var items = buildParseItems(data);
      self.setData({
        parsing: false,
        parseError: '',
        parsed: { items: items, hasAny: items.length > 0 },
        parsedSource: 'text',
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

  /** 确认入库（文本解析那条路）：把勾选的条目交给 tasks 的 bulk_add */
  onConfirmImport: function () {
    this.importPicked({ source: 'text' });
  },

  /** 确认入库（识图那条路）：**追加**导入，沿用同一个 bulk_add */
  onVisionAppend: function () {
    this.importPicked({ source: 'image' });
  },

  /**
   * 两条路共用的"把勾选的条目落库"。
   *
   * @param {Object} options { source: 'text' | 'image' }
   *        text  → 顺手清空输入框（那条路的结果已经用完了）
   *        image → 落库成功后要刷新任务列表 + 保存截图里读出的作息（见 saveVisionPeriods）
   */
  importPicked: function (options) {
    var self = this;
    var opts = options || {};
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

    // 只把云函数认识的字段发过去（title/type/date/start_time/end_time/priority…）。
    // 【为什么 filter(Boolean)】万一后端只给了 events 没给 tasks，item.task 会是 null；
    // 与其塞一个空对象进数组，不如把这种情况如实报出来（下面那句 tip）。
    var list = picked.map(function (item) { return item.task; }).filter(Boolean);
    if (!list.length) {
      this.setData({ tip: '勾选的条目缺少可入库的数据，请重新识别', tipType: 'warn' });
      return;
    }

    this.setData({ submitting: true, tip: '', tipType: '' });
    api.importParsedTasks(list).then(function (res) {
      if (!res.ok) {
        self.setData({ submitting: false, tip: explainAiFailure(res.error, 'tasks'), tipType: 'warn' });
        return;
      }
      var data = res.data || {};
      var inserted = Number(data.inserted) || 0;
      var skipped = Number(data.skipped) || 0;
      var errors = Array.isArray(data.errors) ? data.errors : [];
      // 文案与「我的」页导入保持一致（同一件事不该有两种说法）
      var message = '已入库 ' + inserted + ' 条';
      if (skipped) message += '，跳过 ' + skipped + ' 条（云端校验没过）';

      var patch = {
        submitting: false,
        parsed: null,
        parsedSource: '',
        needClarification: false,
        clarification: '',
        tip: message,
        tipType: skipped ? 'warn' : 'ok'
      };
      if (opts.source === 'text') patch.inputText = '';
      // 云函数逐条给的跳过原因要显示出来（否则用户不知道漏了什么）
      if (opts.source === 'image' && errors.length) patch.visionWarnings = errors.slice(0, 5);
      self.setData(patch);

      if (opts.source === 'image') {
        // 课表变了：重新拉一次任务列表（本页"会删几门课"那个数字也要跟着变）
        self.loadCourses();
        self.saveVisionPeriods();
      }
    });
  },

  // -------------------------------------------------------------------------
  // 模式一之二：课表截图识别
  // -------------------------------------------------------------------------

  /**
   * 读当前 AI 配置，算出"选图之前"要显示的那句模型提示。
   *
   * 取值口是 `api.readAiConfig(res.data)`（平铺形状，见 utils/api.js 的说明）——
   * 不要写 res.data.data，那一层不存在。
   *
   * 【用 silent 读】这是一次"后台顺手读"，不是用户主动发起的操作：读不到就退化成
   * "不确定"（灰字、允许尝试、云端还有一道拦截），**绝不为它弹 toast** ——
   * 用户进这一页可能只是想用文字录入，被一句"网络异常"打扰是纯噪音。
   */
  loadAiConfig: function () {
    var self = this;
    var unknownHint = function () {
      return {
        visionState: 'unknown',
        visionHint: '没能读到 AI 配置，识别前请确认「我的 → AI 设置」里的模型支持识图（拿不准就先识别试试，失败会说清原因）',
        visionHintLevel: 'muted'
      };
    };
    if (typeof api.aiConfigGet !== 'function' || typeof api.classifyVisionModel !== 'function') {
      // 老版本 api.js（没有配置读取口 / 没有判定函数）：按"不确定"处理，允许尝试
      this.setData(unknownHint());
      return;
    }
    api.aiConfigGet({ silent: true }).then(function (res) {
      if (!res.ok) {
        self.setData(unknownHint());
        return;
      }
      var cfg = api.readAiConfig(res.data);
      // 用户没填模型时，云函数用的是该服务商的**默认模型**（恰好是纯文本的），
      // 所以这里要把默认值兜出来再判定，否则最常见的那种情况反而漏了提示。
      var model = api.effectiveModelName(cfg.provider, cfg.model);
      // 【必须把 provider 一起传进去】提示要按"服务商 + 模型 + 是否停用"分流：
      // 同样是 DeepSeek，`deepseek-chat`（已停用）要劝他改名字，`deepseek-flash`（V4.1-Flash）
      // 却是能识图的 —— 光看模型名/光看服务商都不够（见 visionHintOf）。
      var hint = visionHintOf(model, cfg.provider);
      self.setData({
        aiProvider: cfg.provider,
        aiModel: model,
        visionState: hint.state,
        visionHint: hint.text,
        visionHintLevel: hint.level
      });
    });
  },

  /** 拍照 / 从相册选一张课表截图（data-source="camera" | "album"） */
  onPickImage: function (event) {
    var self = this;
    if (this.data.visionBusy) return;

    var dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    var source = String(dataset.source || 'album') === 'camera' ? 'camera' : 'album';

    // 这里**不拦**模型不支持的情况：先让用户把图选出来、看见缩略图，
    // 点「开始识别」时才给那句明确的红字提示（拦在选图前会让人以为按钮坏了）。
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: [source],
      success: function (res) {
        var file = res && res.tempFiles && res.tempFiles[0];
        if (!file) return;
        self.prepareImage(file, source);
      },
      fail: function (err) {
        var message = String((err && err.errMsg) || '');
        if (message.indexOf('cancel') !== -1) return; // 用户主动取消不算错误
        self.setData({ imageError: '选择图片失败：' + (message || '未知原因') });
      }
    });
  },

  /**
   * 选到图之后：先压缩，再读成 base64。
   *
   * 【为什么要压】手机原图动辄 3~5 MB，base64 之后必然超过云函数的 900000 字符上限；
   * quality 55 + 宽 1200 足够看清课表，又能把体积压到限额内。
   */
  prepareImage: function (file, source) {
    var self = this;
    var path = String((file && file.tempFilePath) || '');
    if (!path) {
      this.setData({ imageError: '没拿到图片文件，请重试' });
      return;
    }
    // 换了新图：上一次的识别结果与错误都不该留着
    // （结果区是两条路共用的，所以文字解析的结果也一起清掉 —— 免得"新图 + 旧列表"对不上）
    this._imageBase64 = '';
    this._imageMime = '';
    this.setData({
      imageError: '',
      visionError: '',
      visionWarnings: [],
      visionNotes: '',
      periodsSaveText: '',
      parsed: null,
      parsedSource: '',
      parseError: '',
      imagePath: '',
      imageMime: '',
      imageSizeText: '',
      imageSource: source === 'camera' ? '拍照' : '相册'
    });
    this._visionPeriodTimes = null;
    this.compressThenRead(path, false);
  },

  /**
   * 压缩 → 读 base64。
   * 【压不动就退回原图】compressImage 在个别机型/超大图上会失败；失败也照样往下走，
   * 由尺寸守卫去拦（宁可提示"图片太大"，也不能发一张超限的图上去）。
   */
  compressThenRead: function (path, alreadyCompressed) {
    var self = this;
    var read = function (target, compressed) { self.readImageBase64(target, compressed); };

    if (alreadyCompressed || typeof wx.compressImage !== 'function') {
      read(path, false);
      return;
    }
    wx.compressImage({
      src: path,
      quality: 55,
      compressedWidth: 1200,
      success: function (res) {
        var next = res && res.tempFilePath;
        read(next || path, !!next);
      },
      fail: function (err) {
        console.warn('[ai] 压缩图片失败，改用原图（尺寸守卫照走）：', err && err.errMsg);
        read(path, false);
      }
    });
  },

  /**
   * 读成 base64 并存进**实例**（不是 data）。
   *
   * 【为什么不放 data】一张 900 KB 的 base64 进 setData 会序列化过桥，页面会卡住；
   * 它只在内存里活到这一次请求结束，data 里只留能渲染的缩略图路径与体积文案。
   */
  readImageBase64: function (path, compressed) {
    var self = this;
    var fs = null;
    try {
      fs = wx.getFileSystemManager();
    } catch (err) {
      fs = null;
    }
    if (!fs || typeof fs.readFile !== 'function') {
      this.setData({ imageError: '当前环境不支持读取图片文件，请改用文字录入' });
      return;
    }

    fs.readFile({
      filePath: path,
      encoding: 'base64',
      success: function (res) {
        var base64 = String((res && res.data) || '').replace(/\s+/g, '');
        if (!base64) {
          self.setData({ imageError: '这张图读出来是空的，请换一张试试' });
          return;
        }
        var kb = Math.max(1, Math.round((base64.length * 3) / 4 / 1024));
        if (base64.length > MAX_IMAGE_BASE64_CHARS) {
          // 【尺寸守卫】超限的图连传都不传：云端一定拒，白等好几秒
          self._imageBase64 = '';
          self.setData({
            imagePath: path,
            imageSizeText: (compressed ? '已压缩到约 ' : '原图约 ') + kb + ' KB',
            imageError: '图片太大（约 ' + kb + ' KB），请重新截图或先裁剪，只保留课表部分'
          });
          return;
        }
        var mime = mimeFromBase64(base64) || mimeFromPath(path) || 'image/jpeg';
        self._imageBase64 = base64;
        self._imageMime = mime;
        self.setData({
          imagePath: path,
          imageMime: mime,
          imageSizeText: (compressed ? '已压缩到约 ' : '原图约 ') + kb + ' KB',
          imageError: ''
        });
      },
      fail: function (err) {
        self.setData({ imageError: '读取图片失败：' + String((err && err.errMsg) || '未知原因') });
      }
    });
  },

  /** 点「开始识别」 */
  onRecognize: function () {
    var self = this;
    if (this.data.visionBusy) return;

    if (typeof api.aiParseImage !== 'function') {
      this.setData({ visionError: '当前版本的截图识别不可用，请改用文字录入' });
      return;
    }
    if (!this._imageBase64) {
      this.setData({ visionError: this.data.imageError || '请先拍照或从相册选一张课表截图' });
      return;
    }
    // 【本需求的核心】模型明确不支持识图 → 直接给那句话，**一个请求都不发**
    // （省用户的钱和时间；也不让他在"看不懂的服务端报错"里打转）
    if (this.data.visionState === false) {
      this.setData({ visionError: this.data.visionHint, tip: '', tipType: '' });
      return;
    }

    this.setData({
      visionBusy: true,
      visionElapsed: 0,
      visionError: '',
      visionWarnings: [],
      visionNotes: '',
      periodsSaveText: '',
      parsed: null,
      parsedSource: '',
      parseError: '',
      needClarification: false,
      clarification: '',
      tip: '',
      tipType: ''
    });
    this._visionPeriodTimes = null;
    this.startVisionTimer();

    var app = getApp();
    var global = (app && app.globalData) || {};
    var monday = periods.formatDate(periods.mondayOf(new Date()));

    api.aiParseImage({
      image_base64: this._imageBase64,
      mime_type: this._imageMime || 'image/jpeg',
      week_monday: monday,                       // 本周周一：把「周一第 3 节」换算成具体日期
      semester_start: global.semesterStart || '',
      week_start: 1,
      week_end: periods.WEEKS_PER_TERM,          // 20：契约里的默认重复周次范围
      period_times: global.periodTimes || null   // 用户已校准的作息（可空）
    }).then(function (res) {
      if (!res.ok) {
        self.finishVision({ error: explainAiFailure(res.error, 'aiParse') });
        return;
      }
      var data = res.data || {};
      self.finishVision({ data: data, items: buildParseItems(data) });
    }).catch(function (err) {
      // api.js 约定"永不 reject"，这条纯属兜底：任何意外都不能让页面卡在 loading 里
      console.error('[ai] 识图调用出现未预期异常：', err);
      self.finishVision({ error: '识别失败：' + explainAiFailure(errorTextOf(err), 'aiParse') });
    });
  },

  /**
   * 识图的收尾（成功 / 失败都走这里）。
   * 【一定要走这里的原因】计时器与 loading 必须被复位 —— 失败路径漏一个，
   * 用户就会看到一个永远转圈、秒数一直涨的页面。
   */
  finishVision: function (result) {
    this.stopVisionTimer();
    if (this._visionGone) return; // 页面已卸载：不再 setData

    var patch = { visionBusy: false, visionElapsed: 0 };
    var payload = result || {};

    if (payload.error) {
      patch.visionError = payload.error;
      this.setData(patch);
      return;
    }

    var data = payload.data || {};
    var items = payload.items || [];
    // 截图里读出来的作息先留着：等**导入成功**之后再存（与「我的」页导入课表一致 ——
    // "识别成功但用户没导入"不该在设置里留下脏数据）
    this._visionPeriodTimes = data.period_times || null;

    patch.parsed = { items: items, hasAny: items.length > 0 };
    patch.parsedSource = 'image';
    patch.visionError = '';
    patch.visionWarnings = Array.isArray(data.warnings) ? data.warnings : [];
    patch.visionNotes = String(data.notes || '');
    if (!items.length) {
      patch.tip = '没有从这张截图里认出课程，换一张更清晰、只含课表的截图试试';
      patch.tipType = 'warn';
    } else {
      patch.tip = '';
      patch.tipType = '';
    }
    this.setData(patch);
  },

  /** 秒表：把"已经等了多久"显示出来（长任务没有反馈，用户会以为卡死） */
  startVisionTimer: function () {
    var self = this;
    this.stopVisionTimer();
    this._visionTimer = setInterval(function () {
      if (self._visionGone) {
        self.stopVisionTimer();
        return;
      }
      self.setData({ visionElapsed: self.data.visionElapsed + 1 });
    }, 1000);
  },

  /** 停表（重复调用安全；任何结束路径都要经过它） */
  stopVisionTimer: function () {
    if (this._visionTimer) {
      clearInterval(this._visionTimer);
      this._visionTimer = null;
    }
  },

  /**
   * 确认框里那个 N：本页已拉到的任务里，按「课表类」判据现算有几门。
   *
   * 判据与云函数 tasks 侧**完全一致**（repeat === 'weekly' 且 periods 非空，见
   * cloudfunctions/tasks/lib/normalize.js 的 isCourseTask）：这个数字要说给用户听，
   * 说错了就是骗人。任务列表还没拉到（或拉失败）时返回 null —— 那就**不编数字**，
   * 文案退回"仅删除课表类任务"。
   *
   * @returns {number|null}
   */
  courseCountForConfirm: function () {
    var all = this._allTasks;
    if (!Array.isArray(all)) return null;
    var count = 0;
    all.forEach(function (task) {
      if (isCourseTask(task)) count += 1;
    });
    return count;
  },

  /**
   * 「替换课表」：先弹确认框（会删数据的事一定要二次确认，且把数字摆出来），
   * 再由云函数的 import_replace 一次完成"删旧 + 插新"（scope 固定 'courses'）。
   */
  onVisionReplace: function () {
    var self = this;
    var parsed = this.data.parsed;
    if (!parsed || !parsed.items.length) return;

    var picked = parsed.items.filter(function (item) { return item.selected; });
    if (!picked.length) {
      this.setData({ tip: '请至少勾选一门要导入的课', tipType: 'warn' });
      return;
    }
    if (picked.length > MAX_BULK_INPUT) {
      this.setData({ tip: '一次最多导入 ' + MAX_BULK_INPUT + ' 条', tipType: 'warn' });
      return;
    }
    if (typeof api.importReplace !== 'function') {
      this.setData({ tip: '替换功能尚未就绪，请改用「追加导入」', tipType: 'warn' });
      return;
    }
    var list = picked.map(function (item) { return item.task; }).filter(Boolean);
    if (!list.length) {
      this.setData({ tip: '勾选的条目缺少可入库的数据，请重新识别', tipType: 'warn' });
      return;
    }

    var count = this.courseCountForConfirm();
    // 【红线】"会删数据"必须在按下去之前就说清楚：删几门、什么不受影响。
    var content = count === null
      ? '将仅删除课表类任务；你手动添加的日程、截止、子任务不受影响。'
      : '将删除现有 ' + count + ' 门课程；你手动添加的日程、截止、子任务不受影响。';

    wx.showModal({
      title: '替换已有课表？',
      content: content,
      confirmText: '替换',
      confirmColor: '#e0553f',
      success: function (res) {
        if (res && res.confirm) self.doVisionReplace(list);
      }
    });
  },

  /** 真正发替换请求（删与插都由云函数一次完成，前端不做"先删再插"） */
  doVisionReplace: function (list) {
    var self = this;
    this.setData({ submitting: true, tip: '', tipType: '' });

    api.importReplace(list).then(function (res) {
      if (!res.ok) {
        self.setData({ submitting: false, tip: '替换失败：' + explainAiFailure(res.error, 'tasks'), tipType: 'warn' });
        return;
      }
      // 平铺形状：{ ok, removed, inserted, skipped, duplicates, errors, partial }
      var data = res.data || {};
      var removed = Number(data.removed) || 0;
      var inserted = Number(data.inserted) || 0;
      var skipped = Number(data.skipped) || 0;
      var errors = Array.isArray(data.errors) ? data.errors : [];

      // 文案与「我的」页导入课表一致
      var parts = ['已替换：删除 ' + removed + ' 门、导入 ' + inserted + ' 门'];
      if (skipped) parts.push('跳过 ' + skipped + ' 条');
      // 【如实】partial = 旧的可能删了、新的没插全 —— 这时候绝不能说"失败了就当没发生"
      if (data.partial) parts.push('旧课表可能已被删除，请到课表页确认');

      var patch = {
        submitting: false,
        parsed: null,
        parsedSource: '',
        tip: parts.join('、'),
        tipType: data.partial ? 'warn' : 'ok'
      };
      if (errors.length) patch.visionWarnings = errors.slice(0, 5);
      self.setData(patch);
      wx.showToast({ title: parts[0], icon: inserted ? 'success' : 'none' });

      // 课表变了：重新拉一次任务列表刷新本页状态（含"会删几门课"那个数字）
      self.loadCourses();
      self.saveVisionPeriods();
    });
  },

  /**
   * 把截图里读出来的作息**增量**存回 settings（与「我的」页导入课表同一套语义）。
   *
   * 【合并基准必须是"当前生效的作息"】新读到的节次覆盖同名节次、未涉及的保留原值。
   * 基准不能拿空对象 —— 那会把用户之前校准过的其它节次一起抹掉。所以这里先问一次
   * 服务端拿权威值，拿不到就**不保存**（宁可不校准，也不能拿一张空表覆盖）。
   *
   * 【解耦】导入成功与作息保存成功是两件事：保存失败只说"作息校准未保存"，
   * 绝不能说成"识别/导入失败"（课都已经进库了）。
   */
  saveVisionPeriods: function () {
    var self = this;
    var incoming = this._visionPeriodTimes;
    if (!incoming || !Object.keys(incoming).length) {
      this.setData({ periodsSaveText: '' });
      return;
    }
    var count = Object.keys(incoming).length;

    // 这两次调用都是"导入已完成之后的收尾"，所以走 silent：失败了页面自己会写一句
    // 「作息校准未保存（课程已导入）」，不该再弹一次 toast 把导入成功的喜悦盖掉。
    api.getSettings({ silent: true }).then(function (res) {
      if (!res.ok) throw new Error(res.error || '读取设置失败');
      var current = (res.data && res.data.period_times) || {};
      var merged = mergePeriodTimes(current, incoming);
      if (!merged) return null;
      return api.saveSettings({ period_times: merged }).then(function (saved) {
        if (!saved.ok) throw new Error(saved.error || '保存失败');
        // 服务端会把归一化后的作息回传，以它为准（与「我的」页同一口径）
        var finalTimes = (saved.data && saved.data.period_times) || merged;
        var app = getApp();
        if (app && app.globalData) app.globalData.periodTimes = finalTimes;
        if (self._visionGone) return;
        self.setData({ periodsSaveText: '并按截图校准了 ' + count + ' 节作息' });
      });
    }).catch(function (err) {
      // 只在自己的那一行如实说明没存上，不改结果文案、不弹 toast 打断
      if (self._visionGone) return;
      self.setData({ periodsSaveText: '作息校准未保存（课程已导入）：' + errorTextOf(err) });
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
        self.setData({ picking: false, decomposeError: explainAiFailure(res.error, 'tasks') });
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
          repeatLabel: task.repeat === 'weekly' ? '每周' : (task.repeat === 'daily' ? '每天' : ''),
          state: state,
          blockedReason: blocked
        };
        byId[id] = item;
        if (!blocked) candidates.push(item);
      });

      self._taskById = byId;
      // 【为什么要留原样的一份】"替换课表"的确认框要说清"会删几门课"，
      // 那个数字必须按**课表类判据**在原始任务上现算（courses 是拆解候选，
      // 已经按"能不能拆"筛过一遍，拿它算会算错）。
      self._allTasks = all;
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
        // 后端自己写的人话原样显示；平台级的超时/未部署由 explainAiFailure 翻译
        self.setData({ decomposing: false, decomposeError: explainAiFailure(res.error, 'aiDecompose') });
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
    priorityTagClass: priorityTagClass,
    // 识图那几条路的纯函数（测的就是页面真正在用的那份实现）
    visionHintOf: visionHintOf,
    RETIRED_MODELS: RETIRED_MODELS,
    isCourseTask: isCourseTask,
    mergePeriodTimes: mergePeriodTimes,
    mimeFromBase64: mimeFromBase64,
    mimeFromPath: mimeFromPath,
    // 平台级调用失败（超时 / 函数没部署）的人话翻译
    explainAiFailure: explainAiFailure
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
      // 课程（每周重复 + 节次）多给一行更贴切的说明：'每周 第3-5节 · 1-16周'
      courseText: courseLine(item),
      // 重复方式：让用户一眼看出"这条会天天出现"，与落库的 repeat 同一来源
      repeatLabel: (item && item.repeat === 'daily') ? '每天' : ((item && item.repeat === 'weekly') ? '每周' : ''),
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

/**
 * 课程的补充说明行：'每周 第3-5节 · 1-16周'。
 * 只有"每周重复 **且** 有节次"的条目才配得上这行（那正是云函数侧课表类任务的判据）；
 * 普通日程 / 截止返回空串，界面上就还是原来那一行。
 *
 * @param {Object} item events / deadlines 里的一条（识图回来时会带 repeat / periods / week_*）
 * @returns {string} '' 表示不是课程
 */
function courseLine(item) {
  if (!item || typeof item !== 'object') return '';
  if (String(item.repeat || '') !== 'weekly') return '';
  var span = String(item.periods || '').trim();
  if (!span) return '';
  var parts = ['每周 第' + span + '节'];
  var from = Number(item.week_start);
  var to = Number(item.week_end);
  var parity = String(item.week_parity || 'all');
  if (from > 0 && to > 0) {
    var weeks = from === to ? String(from) : from + '-' + to;
    if (parity === 'odd') weeks += ' 单周';
    else if (parity === 'even') weeks += ' 双周';
    parts.push(weeks + '周');
  }
  return parts.join(' · ');
}

/**
 * 这句提示的分流（**按"服务商 + 模型 + 是否停用"**，不再按"服务商有没有识图模型"）。
 *
 *   ① 模型名已停用（deepseek-chat / deepseek-reasoner）→ 红字：**改成 deepseek-flash**，
 *      **不是**换服务商（DeepSeek 的 V4.1-Flash 自带识图）；
 *   ② 已知纯文本模型（如智谱 glm-4.7-flash）→ 红字：换成**同一家**的 glm-5.3-flash / glm-ocr；
 *   ③ 模型没收录（unknown）→ 灰字：允许尝试，失败了再换；
 *   ④ 已知支持 → 绿字：让他安心。
 *
 * 【state 的口径】它回答"这次识图能不能成"：①② 都是 false（「开始识别」据此**直接拦下、
 * 一个请求都不发**），③ 是 'unknown'（照常尝试），④ 是 true。
 *
 * @param {string} model 实际会被使用的模型名
 * @param {string} [provider] 当前服务商（'zhipu' / 'deepseek' / ''）
 *        目前**不参与判定**（判定看模型名：停用名单 + 支持/纯文本名单），
 *        参数保留是为了不改调用处、也给以后"按服务商换措辞"留位置。
 * @returns {{state:(boolean|string), text:string, level:string}}
 */
function visionHintOf(model, provider) {
  var name = String(model === null || model === undefined ? '' : model).trim() || '(未设置)';
  var key = api.normalizeModelKey ? api.normalizeModelKey(name) : name.toLowerCase();
  var replacement = RETIRED_MODELS[key];

  // ① 名字已经停服了：说清"换成哪个名字"，而不是笼统说"不支持识图"
  if (replacement) {
    return {
      state: false,
      level: 'danger',
      text: '当前模型 ' + name + ' 自 2026-07-24 起已停止服务，'
        + '请到「我的 → AI 设置」把模型改成 ' + replacement + '（DeepSeek V4.1-Flash，自带识图能力）'
    };
  }

  var state = api.classifyVisionModel(name);
  // ② 同一家换个模型就行（建议的模型都是这家自己的，不需要换服务商/换 Key）
  if (state === false) {
    return {
      state: state,
      level: 'danger',
      text: '当前模型 ' + name + ' 不具备识图能力，请到「我的 → AI 设置」换成 glm-5.3-flash 或 glm-ocr'
    };
  }
  // ④ 已知支持
  if (state === true) {
    return { state: state, level: 'ok', text: '当前模型 ' + name + ' 支持识图' };
  }
  // ③ 没收录
  return {
    state: state,
    level: 'muted',
    text: '当前模型 ' + name + ' 未在已知支持识图的列表里，如果识别失败请更换模型'
  };
}

/**
 * 什么是"课表类任务"（与 cloudfunctions/tasks/lib/normalize.js 的 isCourseTask 判据一致）。
 *
 * 【为什么页面里要再写一遍】替换课表的确认框里要说"将删除现有 N 门课程"，
 * 这个 N 必须与云函数**实际会删的东西**一致：`repeat === 'weekly'` **且** `periods` 非空。
 * 判据放宽一个字，确认框里的数字就是骗人的（宁可少说，也不能多说）。
 */
function isCourseTask(task) {
  if (!task || typeof task !== 'object') return false;
  if (String(task.repeat || '') !== 'weekly') return false;
  return !!String(task.periods || '').trim();
}

/**
 * 合并作息表：**新读到的节次覆盖同名节次，未涉及的节次保留原值**。
 *
 * 合并基准必须是"当前生效的作息"（从 settings 读回来的那份），**不是空对象** ——
 * 否则一次只校准了几节课的识别会把用户其它节次的作息抹掉。这条语义与「我的」页
 * 导入 .ics（pages/me/me.js 的 mergePeriodTimes）完全一致，两边刻意用同一套口径。
 *
 * @param {Object|null} base 当前作息 {'1': ['08:00','08:45'], ...}
 * @param {Object|null} incoming 本次从截图里读出来的作息
 * @returns {Object|null} 合并结果；incoming 为空时返回 null（调用方据此跳过保存）
 */
function mergePeriodTimes(base, incoming) {
  var baseObj = (base && typeof base === 'object') ? base : {};
  var nextObj = (incoming && typeof incoming === 'object') ? incoming : {};
  var keys = Object.keys(nextObj);
  if (!keys.length) return null;

  var merged = {};
  Object.keys(baseObj).forEach(function (key) { merged[key] = baseObj[key]; });
  keys.forEach(function (key) { merged[key] = nextObj[key]; });
  return merged;
}

/**
 * 从 base64 头部魔数判断图片类型。
 *
 * 【为什么不用后缀】compressImage 出来的临时路径不一定带扩展名，而 mime 传错
 * 会让服务商按错误的解码器解析（有些会直接报"图片格式不支持"，把用户引到错方向）。
 * base64 的前几个字符就是文件魔数，判它最准。
 *
 *   '/9j/'  → JPEG 的 FF D8 FF   'iVBOR' → PNG 的 89 50 4E 47   'UklGR' → WEBP 的 RIFF
 *
 * @param {string} base64 纯 base64
 * @returns {string} mime；认不出返回 ''
 */
function mimeFromBase64(base64) {
  var head = String(base64 || '').slice(0, 8);
  if (head.indexOf('/9j/') === 0) return 'image/jpeg';
  if (head.indexOf('iVBOR') === 0) return 'image/png';
  if (head.indexOf('UklGR') === 0) return 'image/webp';
  return '';
}

/** 从文件路径后缀猜 mime（魔数判不出时的退路；再猜不出由调用方兜 image/jpeg） */
function mimeFromPath(path) {
  var text = String(path || '').toLowerCase();
  if (/\.png$/.test(text)) return 'image/png';
  if (/\.webp$/.test(text)) return 'image/webp';
  if (/\.jpe?g$/.test(text)) return 'image/jpeg';
  return '';
}

/** 把任意异常/返回值变成一句人能看的话（页面里所有 catch 都用它） */
function errorTextOf(err) {
  if (!err) return '未知原因';
  return String(err.message || err.errMsg || err);
}

/**
 * **平台级调用失败** → 人话（注意：这不是后端自己写的那句 error，别搞混）。
 *
 * ===========================================================================
 * 【为什么需要它】真机截图：用户输入「我要每天中午13:10-13:20都进行学习打卡」，
 * 界面上直接甩出一大段英文 —— `cloud.callFunction:fail Error: errCode: -504003 |
 * errMsg: Invoking task timed out after 3 seconds 更多错误信息请访问：
 * https://docs.cloudbase.net/error-code/basic/FUNCTIONS_TIME_LIMIT_EXCEEDED (trace: …)`
 * ===========================================================================
 * 这句话对用户等于零信息：他不知道 -504003 是什么，更不知道唯一能做的动作是
 * **把云函数的超时时间调大**。根因是平台默认的超时只有 3 秒，而模型回复通常要 3~15 秒
 * （云函数内部本来就准备了 15 秒 / 识图 45 秒，根本没机会用上就被掐了）。
 *
 * 【为什么不像 me.js 那样翻译"未知 action"】那一类是我们自己的服务端文案，原样显示即可；
 * 这里要处理的是**调用层**的失败（超时、函数没部署），它压根不是给人看的。
 * 所以只认这两种平台签名，其余**一律原样返回** —— 后端写的「AI 服务暂不可用」这类
 * 人话必须一个字都不动（这是本页原有的约定，改它属于越权）。
 *
 * 【原话必须保留在句尾】翻译最容易犯的错是把线索丢掉：以后真出别的问题时，
 * 没有原始报错就没法排查。
 *
 * @param {string} errorText 调用失败时拿到的错误文案
 * @param {string} fnName 这次调用的是哪个云函数（文案里要指名道姓，用户才知道去改哪一个）
 * @returns {string} 给用户看的一句话
 */
function explainAiFailure(errorText, fnName) {
  var raw = String(errorText === undefined || errorText === null ? '' : errorText).trim();
  if (!raw) return '操作失败，请稍后重试';
  var fn = String(fnName || '').trim() || 'aiParse';

  // ① 被平台的超时时间掐断（云函数默认只有 3 秒）
  if (/FUNCTIONS_TIME_LIMIT_EXCEEDED|Invoking task timed out|-504003|timed out after \d+ seconds/i.test(raw)) {
    return 'AI 云函数还没跑完就被平台掐断了：微信云函数的超时时间默认只有 3 秒，'
      + '而模型回复通常要 3~15 秒。请在云开发控制台 → 云函数 → `' + fn + '` → 配置 → '
      + '把「超时时间」改成 20 秒（另一个 AI 云函数 `aiDecompose` 也一并改），然后再试一次。'
      + '（平台原话：' + raw + '）';
  }
  // ② 云函数根本没部署到这个云环境
  if (/FUNCTION_NOT_FOUND|function not found|FunctionName parameter could not be found/i.test(raw)) {
    return '云函数 `' + fn + '` 还没部署到你的云环境：在微信开发者工具里右键 `cloudfunctions/' + fn
      + '` → 「上传并部署：云端安装依赖」，然后重试。（平台原话：' + raw + '）';
  }
  // ③ 其余原样返回（后端自己写的 error 本来就是给人看的人话）
  return raw;
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
