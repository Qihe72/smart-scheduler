/**
 * pages/me/me.js —— 「我的」页：学期设置 / 节次作息 / 导入课表 / 导出备份 / 关于。
 *
 * ===========================================================================
 * 【这一页的设计原则：每一项要么真能用，要么明说"暂不支持"】
 * ===========================================================================
 *   评审最反感的不是功能少，而是"点了没反应"。所以：
 *     1. 学期设置      → 真能改（picker 选日期 → settings_save）
 *     2. 节次作息      → **只读展示**，并在页面上写明「本版只读」。
 *        Python 版 config.py 里作息是**源码常量** CLASS_PERIODS（注释写着"按自己学校的
 *        上下课时间改这里即可"），data/settings.json 里的 period_times 是**导入课表时
 *        自动校准**的结果、不是给用户在界面上编辑的。所以小程序这一版**不做**可编辑的
 *        作息表 —— 与其假装能改，不如老实说明。
 *     3. 导入课表(.ics) → 真能用：选文件 → 解析 → 预览 → 确认 → bulk_add 入库
 *     4. 导出备份      → 真能用：把所有任务拼成 JSON 复制到剪贴板
 *     5. 关于 / 第三方 → 静态说明（第三方资源归属是招新评审的评分项，必须写全）
 *     6. 数据说明      → 静态说明（数据存在用户自己的云环境里，按 openid 隔离）
 *
 * 【契约】所有云端调用都走 utils/api.js，它返回 Promise<{ok,data,error}> 且**永不 reject**：
 *   失败时它自己弹过 toast，页面这里负责把 error 文案显示在界面上（不静默失败、
 *   也不自己编造更具体的原因）。
 */

const api = require('../../utils/api.js');
const periods = require('../../utils/periods.js');

// ---------------------------------------------------------------------------
// utils/ics.js 是**并行开发中**的模块（不归本页维护，所以不主动创建它）。
// 用 try/catch 包住 require：万一它还没落地，本页依然能正常渲染，
// 只是"导入课表"这一段会明确告诉用户"当前版本不可用"，而不是整页白屏。
// ---------------------------------------------------------------------------
let ics = null;
let icsLoadError = '';
try {
  // eslint-disable-next-line global-require
  ics = require('../../utils/ics.js');
} catch (err) {
  ics = null;
  icsLoadError = (err && err.message) || String(err);
}

/** 解析器是不是真的可用（模块存在 + 导出了那两个函数） */
function icsReady() {
  return !!(ics && typeof ics.parseIcs === 'function' && typeof ics.toTasks === 'function');
}

/** 一次最多导入多少条（与云函数 MAX_BULK_INPUT = 200 对齐，超了云函数会直接报错） */
const MAX_IMPORT = 200;

/** 类型中文名（放顶部：下面的方法会用到，const 不提升） */
const TYPE_LABELS = { event: '日程', ddl: '截止', subtask: '子任务' };

/** 学期周次上限（与 normalize.js 的 MAX_WEEK 一致） */
const MAX_WEEK = 30;

// ---------------------------------------------------------------------------
// AI 设置
// ---------------------------------------------------------------------------
/**
 * 服务商列表：**提交的值直接取自 utils/api.js 的白名单**（api.AI_PROVIDERS）。
 *
 * 【为什么不是本地写死一份】provider 是要发给云函数的**字面量**，api.js 里白名单是
 * `['zhipu', 'deepseek']`（云端 PROVIDERS 表、Python 版 config.py 也都是 zhipu）。
 * 我第一版在本文件里写成了 'glm'，结果 normalizeProvider('glm') 返回 ''、
 * aiConfigSave 直接拒绝 —— 用户点保存 100% 失败，提示还是"请选择服务商"（他明明选了）。
 * 这类"显示名与提交值混用"的错靠 review 很难发现，所以这里**共用同一个来源**：
 * api.js 改了，下拉框跟着改，两者不可能再对不上。
 *
 * label 是给人看的显示名（「智谱 GLM」），value 是给机器看的值（'zhipu'）——
 * 两者本来就该不同，但不能凭记忆写。
 */
const FALLBACK_PROVIDERS = ['zhipu', 'deepseek'];

/** 显示名映射：key 必须与 api.js 白名单里的值一致（不一致就退化成显示原始值） */
const AI_PROVIDER_LABELS = {
  zhipu: { label: '智谱 GLM', hint: '免费档 glm-4.7-flash', keyUrl: 'https://open.bigmodel.cn' },
  deepseek: { label: 'DeepSeek', hint: '备选', keyUrl: 'https://platform.deepseek.com' },
};

/** 从 api.js 取白名单；取不到时退回 FALLBACK_PROVIDERS，页面不会因此空掉 */
function providerWhitelist() {
  const list = api && Array.isArray(api.AI_PROVIDERS) ? api.AI_PROVIDERS : [];
  const clean = list
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => !!item);
  return clean.length ? clean : FALLBACK_PROVIDERS.slice();
}

/** 下拉框选项：value 来自白名单，label 只是显示名 */
const AI_PROVIDERS = providerWhitelist().map((value) => {
  const meta = AI_PROVIDER_LABELS[value] || {};
  return {
    value,
    label: meta.label || value,
    hint: meta.hint || '',
    keyUrl: meta.keyUrl || '',
  };
});

/** 各服务商的默认模型（提交时用户没改就用这个；纯展示用，不让用户乱填） */
const AI_DEFAULT_MODEL = { zhipu: 'glm-4.7-flash', deepseek: 'deepseek-chat' };

/** api.js 里的三个封装是不是已经就绪（没就绪时本区块明确禁用） */
function aiConfigReady() {
  return !!(api && typeof api.aiConfigGet === 'function'
    && typeof api.aiConfigSave === 'function'
    && typeof api.aiConfigClear === 'function');
}

// ---------------------------------------------------------------------------
// 导入课表：替换 / 追加
// ---------------------------------------------------------------------------
/**
 * 什么是"课表类任务"（替换模式下**只**清这一类）。
 *
 * 判据：`repeat === 'weekly'` **且** 有 `periods` —— 这正是 .ics 导入出来的课程形态
 * （每周重复 + 明确节次）。用户手工加的日程 / 截止 / 子任务即便设了每周重复，
 * 也不会写 periods，所以不会被误删。
 *
 * 【这是硬红线】用户要的是"新导入课表替换之前课表"，但替换绝不能把
 * 他手写的日程一起清掉 —— 所以判据必须**窄**：宁可留下几门没被认出来的旧课，
 * 也不能删掉一条手工任务。
 */
function isCourseTask(task) {
  if (!task || typeof task !== 'object') return false;
  if (String(task.repeat || '') !== 'weekly') return false;
  return !!String(task.periods || '').trim();
}

/** 统计"会被替换掉的课表类任务" / "不受影响的手工任务" */
function splitCoursesAndManual(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  let courseCount = 0;
  let manualCount = 0;
  list.forEach((task) => {
    if (isCourseTask(task)) courseCount += 1;
    else manualCount += 1;
  });
  return { courseCount, manualCount };
}

/** 云函数侧是否已提供 import_replace（没就绪时"替换"选项禁用，不假装能用） */
function importReplaceReady() {
  return !!(api && typeof api.importReplace === 'function');
}

Page({
  data: {
    // --- 加载 / 错误 ---
    loading: true,
    errorText: '',

    // --- 一、学期设置 ---
    semesterStart: '',          // 当前生效的（'YYYY-MM-DD'，周一）
    datePicker: '',             // date picker 的显示值（仅控件用，见 onDateChange 注释）
    savingSemester: false,
    currentWeekNo: 0,           // 今天是第几周；0 = 算不出来（没设置 / 开学前）
    currentWeekText: '',        // 「今天在第 3 周（单周）」/「还没设置开学日期」

    // --- 二、节次作息（只读） ---
    periodRows: [],             // [{ key, label, timeText, isBreak, calibrated }]
    periodSourceText: '',       // 「当前使用默认作息（第 1~13 节）」等
    periodOverrideText: '',     // 「其中 3 节是导入课表时校准过的」

    // --- 三、AI 设置 ---
    aiAvailable: true,          // api.js 的 aiConfig* 是否就绪
    aiUnavailableText: '',
    aiLoading: false,           // 正在读配置
    aiSaving: false,
    aiClearing: false,
    aiProviderIndex: 0,         // 下拉框选中项（只能选，不能填地址）
    providers: AI_PROVIDERS,
    aiProviderValue: AI_PROVIDERS[0].value,  // 当前选中的 provider **值**（保存时对它就校验白名单）
    aiKeyInput: '',             // password 输入框的内容；提交后立刻清空
    aiKeyPlaceholder: '',
    aiModel: '',                // 当前生效的模型名（只读展示）
    aiHasKey: false,            // 用户是否填过自己的 Key
    aiMasked: '',               // 服务端返回的掩码，例如 ****abcd
    aiStatusText: '',           // 「正在使用你自己填的 Key（****abcd）」等
    aiStatusType: '',           // '' | 'own' | 'preset' | 'none'
    aiResultText: '',           // 保存/清除的结果提示
    aiKeyUrl: AI_PROVIDERS[0].keyUrl,
    aiProviderHint: AI_PROVIDERS[0].hint,

    // --- 四、导入课表 ---
    icsAvailable: true,         // 解析器是否可用
    icsUnavailableText: '',
    importMode: 'replace',      // 'replace' = 替换已有课表（默认）| 'append' = 追加
    importModes: [
      { value: 'replace', label: '替换已有课表' },
      { value: 'append', label: '追加到现有任务' },
    ],
    importReplaceReady: true,   // 云函数 import_replace 是否就绪
    importReplaceHint: '',      // 未就绪时的说明
    courseCount: 0,             // 当前课表类任务数（替换会删这么多）
    manualCount: 0,             // 手工任务数（替换不会碰）
    replaceSummary: '',         // 「替换会删除 N 门课程；你手工添加的 M 条不受影响」
    importing: false,           // 正在读文件 / 解析
    submitting: false,          // 正在入库
    pickedFileName: '',
    parsedCount: 0,             // 解析出多少个日程
    taskCount: 0,               // 转成多少条任务
    warnings: [],               // 解析警告（必须显示给用户，不吞）
    previewItems: [],           // 前几条预览
    previewMore: 0,             // 还有多少条没展示
    pendingTasks: [],           // 待入库的任务（点确认才用）
    importResultText: '',       // 「已入库 N 条，跳过 M 条」

    // --- 五、导出备份 ---
    exporting: false,
    exportTaskCount: 0,
    exportPreview: '',          // 导出内容的前几个字，给用户看一眼
    exportHint: '',

    // --- 静态文案 ---
    version: '1.0.0',
    cloudFunctionName: 'tasks',
    appName: '青年时间管理助手',
  },

  onLoad() {
    // 解析器（utils/ics.js）不可用时就如实说明，并把导入按钮换成"暂不可用"，
    // 而不是留一个点了没反应的按钮。
    const ready = icsReady();
    // AI 设置依赖 utils/api.js 上的三个封装（另一位同学正在加）。没就绪就把这一块
    // 明确置为"暂不可用"，绝不让 aiConfigGet is not a function 把整页带崩。
    const aiReady = aiConfigReady();
    // 「替换」依赖云函数的 import_replace（另一位同学在做）。没就绪就把这个选项
    // 明确标出来并禁用，绝不让用户点了确认才发现删不掉。
    const replaceReady = importReplaceReady();
    this.setData({
      icsAvailable: ready,
      icsUnavailableText: ready
        ? ''
        : `课表解析模块暂不可用，导入功能已停用（${icsLoadError || 'utils/ics.js 尚未就绪'}）。`
          + '其余功能不受影响；解析模块就绪后本页会自动恢复导入。',
      importReplaceReady: replaceReady,
      importReplaceHint: replaceReady
        ? ''
        : '「替换已有课表」需要云函数的 import_replace（尚未就绪），当前只能追加。',
      aiAvailable: aiReady,
      aiUnavailableText: aiReady
        ? ''
        : 'AI 设置功能暂不可用（utils/api.js 里的 aiConfig 接口尚未就绪）。'
          + '其余功能不受影响；接口就绪后本页会自动恢复。',
    });
    this.loadAll();
  },

  /** 从别的页面切回来时刷新一下（学期设置可能在别处改过） */
  onShow() {
    if (this.loadedOnce) this.loadAll();
  },

  /** 下拉刷新 */
  onPullDownRefresh() {
    this.loadAll().then(() => {
      wx.stopPullDownRefresh();
    }).catch(() => {
      wx.stopPullDownRefresh();
    });
  },

  // =========================================================================
  // 一、读设置 + 渲染作息表
  // =========================================================================

  /**
   * 读 settings_get，然后重算学期信息与作息表。
   * @returns {Promise<void>}
   */
  loadAll() {
    this.setData({ loading: true, errorText: '' });
    // AI 配置独立读：它失败不该让"学期设置 / 作息表"跟着变成错误态，
    // 反过来也一样。所以两条链路各自处理自己的错误（见 loadAiConfig）。
    this.loadAiConfig();
    // 任务列表也顺手拉一次：用来算"替换会删掉几门课、不碰几条手工任务"，
    // 好让用户在点确认**之前**就看到数字。失败不影响本页（下面各自兜底）。
    this.refreshImportCounts();
    return api.getSettings().then((result) => {
      // api.js 失败时 resolve {ok:false,error}（不 reject），必须显式判 ok，
      // 否则会把"没读到设置"显示成"还没设置过"，把人误导到错误方向。
      if (result && result.ok === false) throw new Error(describeError(result));

      const settings = extractSettings(result);
      this.periodTimes = settings.period_times || null;
      this.loadedOnce = true;

      // 顺手把结果同步给 app.js 的 globalData（失败也不影响本页）
      syncGlobalSettings(result);

      this.setData({ loading: false, errorText: '' });
      this.renderSemester(settings.semester_start);
      this.renderPeriods();
    }).catch((err) => {
      this.loadedOnce = true;
      this.setData({
        loading: false,
        errorText: `读取设置失败：${describeError(err)}`,
      });
    });
  },

  /** 学期信息：当前第几周 / 单双周 */
  renderSemester(semesterStart) {
    const today = todayStr();
    let weekNo = 0;
    let text = '';
    if (semesterStart) {
      weekNo = periods.weekNumberOf(today, semesterStart) || 0;
      if (weekNo) {
        const parity = periods.weekParity(weekNo) === periods.PARITY_ODD ? '单周' : '双周';
        text = `今天在第 ${weekNo} 周（${parity}）`;
      } else {
        text = '今天在开学之前，周次从第 1 周开始算';
      }
    } else {
      text = '还没设置开学日期，课表的"第几周 / 单双周"都算不出来';
    }
    this.setData({
      semesterStart,
      datePicker: semesterStart || today,
      currentWeekNo: weekNo,
      currentWeekText: text,
    });
  },

  /**
   * 作息表（只读展示）。
   * 用 periods.periodRows + rowLabel + rowTimeRange，与课表页**同一套口径**，
   * 所以这里看到的「午休」和课表左侧那一行一定是同一个东西。
   */
  renderPeriods() {
    const override = this.periodTimes;
    const rows = periods.periodRows(override);
    const list = rows.map((row) => {
      const number = row[0];
      const range = periods.rowTimeRange(row, override) || ['', ''];
      const breakName = periods.breakLabel(number, override);
      return {
        key: periods.rowKey ? periods.rowKey(row) : String(number),
        label: periods.rowLabel(row, override) || `第${number}节`,
        timeText: range[0] && range[1] ? `${range[0]}-${range[1]}` : (range[0] || range[1] || '—'),
        isBreak: !!breakName,
        calibrated: !!override && Object.prototype.hasOwnProperty.call(override, String(number)),
      };
    });

    const calibratedCount = list.filter((item) => item.calibrated).length;
    let sourceText = '';
    if (!override || !Object.keys(override).length) {
      sourceText = `当前使用内置默认作息（第 1~${list.length} 节）`;
    } else if (calibratedCount === list.length) {
      sourceText = `当前作息全部来自导入课表时的自动校准（共 ${list.length} 节）`;
    } else {
      sourceText = `当前作息 = 默认作息 + 导入课表时校准的 ${calibratedCount} 节`;
    }

    this.setData({
      periodRows: list,
      periodSourceText: sourceText,
      periodOverrideText: calibratedCount
        ? `带「已校准」标记的 ${calibratedCount} 节来自导入课表时的识别结果。`
        : '',
    });
  },

  // =========================================================================
  // 二、学期设置：保存
  // =========================================================================

  /** 选了开学日期（只是填进 pending，还没保存） */
  onDateChange(event) {
    const value = str(event.detail && event.detail.value);
    if (!value) return;
    // 只改控件的显示值，真正的落库在「保存」按钮里 —— 免得用户一划日期就写库
    this.setData({ semesterStart: value, datePicker: value });
  },

  /** 保存开学日期 */
  onSaveSemester() {
    if (this.data.savingSemester) return;
    const value = str(this.data.semesterStart);
    if (!value) {
      wx.showToast({ title: '请先选择开学日期', icon: 'none' });
      return;
    }
    this.setData({ savingSemester: true });
    api.saveSettings({ semester_start: value }).then((result) => {
      if (result && result.ok === false) throw new Error(describeError(result));
      this.setData({ savingSemester: false });
      // 云函数会把日期归一化成"那一周的周一"，所以要把**服务端返回值**当准，
      // 不能沿用本地选的那天（否则界面上显示的周一和别人算出来的不一样）
      const saved = extractSettings(result);
      syncGlobalSettings(result);
      wx.showToast({ title: '已保存', icon: 'success' });
      this.renderSemester(saved.semester_start || value);
    }).catch((err) => {
      this.setData({ savingSemester: false });
      wx.showToast({ title: `保存失败：${describeError(err)}`, icon: 'none' });
    });
  },

  // =========================================================================
  // 三、AI 设置（服务商 + 自己的 Key）
  // =========================================================================

  /**
   * 读当前 AI 配置。
   *
   * 【安全要点】服务端只回 `{provider, model, hasKey, masked}` —— 掩码形如 `****abcd`，
   * **永远不会有明文**。所以页面 data 里从头到尾不会出现 Key 原文，
   * 渲染层自然也不可能把它显示出来。
   */
  loadAiConfig() {
    if (!aiConfigReady()) {
      this.setData({ aiLoading: false });
      return Promise.resolve();
    }
    this.setData({ aiLoading: true });
    return api.aiConfigGet().then((result) => {
      // 与其他路径一致：失败不 reject 而是 {ok:false,error}，必须显式判 ok
      if (result && result.ok === false) throw new Error(describeError(result));
      this.applyAiConfig(extractAiConfig(result));
      this.setData({ aiLoading: false });
    }).catch((err) => {
      // 原样显示服务端给的 error，不自己编造"是不是没配 Key / 是不是超时"这类原因
      this.setData({
        aiLoading: false,
        aiResultText: `读取 AI 设置失败：${describeError(err)}`,
      });
    });
  },

  /**
   * 把服务端返回的 AI 配置写进 data（**只写掩码，不写明文**）。
   * @param {{provider: string, model: string, hasKey: boolean, masked: string}} config
   */
  applyAiConfig(config) {
    const provider = str(config.provider);
    const index = Math.max(indexOfProvider(provider), 0);
    const option = AI_PROVIDERS[index] || AI_PROVIDERS[0];
    const hasKey = config.hasKey === true;
    const masked = str(config.masked);

    // 三态文案。**重要**：这里只陈述规则，不陈述页面无法知道的事实 ——
    // 预置 Key 配在 aiParse / aiDecompose 的环境变量里（微信云开发里每个云函数的环境变量
    // 各自独立），而本页读的是 tasks 云函数，它根本不知道那边有没有配。
    // 所以 hasKey=false 时**绝不能说"AI 用不了"** —— 那可能把正在生效的预置 Key 说成不可用。
    // 真正要区分"到底有没有 Key"的那句话，交给知道答案的一方（aiParse/aiDecompose 的报错）去说。
    let statusText = '';
    let statusType = '';
    if (hasKey) {
      statusType = 'own';
      statusText = `正在使用你自己填的 Key（${masked || '****'}）`;
    } else if (str(config.preset_provider) || config.preset === true) {
      statusType = 'preset';
      statusText = '正在使用程序预置的 Key（所有人共用，额度可能有限）';
    } else {
      statusType = 'none';
      statusText = '你还没填自己的 Key';
    }

    this.setData({
      aiProviderIndex: index,
      aiProviderValue: option.value,
      aiProviderHint: option.hint,
      aiKeyUrl: option.keyUrl,
      aiModel: str(config.model) || AI_DEFAULT_MODEL[option.value] || '',
      aiHasKey: hasKey,
      aiMasked: masked,
      aiStatusText: statusText,
      aiStatusType: statusType,
      // 输入框永远留空：要改就重新填一个，绝不回显旧的
      aiKeyInput: '',
      aiKeyPlaceholder: hasKey
        ? `已保存 ${masked || '****'}，留空则不改动`
        : '粘贴你的 API Key（不会显示出来）',
    });
  },

  /** 换服务商（下拉框，白名单里选） */
  onAiProviderChange(event) {
    const index = Number(event.detail && event.detail.value);
    const safe = Number.isFinite(index) && AI_PROVIDERS[index] ? index : 0;
    const option = AI_PROVIDERS[safe];
    this.setData({
      aiProviderIndex: safe,
      aiProviderValue: option.value,   // 只写入白名单里的值
      aiProviderHint: option.hint,
      aiKeyUrl: option.keyUrl,
      aiResultText: '',
    });
  },

  /** Key 输入框：只存进 data 供提交用；提交成功后立刻清空 */
  onAiKeyInput(event) {
    this.setData({ aiKeyInput: str(event.detail && event.detail.value) });
  },

  /** 保存：provider 必须是白名单里的值，key 必须非空 */
  onAiConfigSave() {
    if (!aiConfigReady() || this.data.aiSaving) return;

    // 提交的是"当前选中项的值"，并对**这个值**再做一次白名单校验。
    // 不能只信下拉框：数据的来源（data.providers / aiProviderValue）在运行时是可以被改的，
    // 而这里挡的是"云函数会不会拿一个任意地址去发请求"—— 校验必须落在真正要提交的值上。
    const provider = str(this.data.aiProviderValue) || (AI_PROVIDERS[this.data.aiProviderIndex] || AI_PROVIDERS[0]).value;
    if (!isAllowedProvider(provider)) {
      this.setData({ aiResultText: `服务商不在可选范围内：${provider || '(空)'}` });
      wx.showToast({ title: '服务商不合法，已阻止提交', icon: 'none' });
      return;
    }
    const apiKey = str(this.data.aiKeyInput);
    if (!apiKey) {
      wx.showToast({ title: '请先填写 API Key', icon: 'none' });
      return;
    }

    this.setData({ aiSaving: true, aiResultText: '' });
    api.aiConfigSave({
      provider,
      api_key: apiKey,
      model: this.data.aiModel || AI_DEFAULT_MODEL[provider] || '',
    }).then((result) => {
      if (result && result.ok === false) throw new Error(describeError(result));
      // 用服务端返回的掩码回填；**不回显 Key 原文**（data 里也立刻清掉输入）
      this.applyAiConfig(extractAiConfig(result));
      this.setData({
        aiSaving: false,
        aiResultText: `已保存，之后 AI 会使用你自己的 Key（${this.data.aiMasked || '****'}）。`,
      });
      wx.showToast({ title: '已保存', icon: 'success' });
    }).catch((err) => {
      this.setData({
        aiSaving: false,
        aiResultText: `保存失败：${describeError(err)}`,
      });
      wx.showToast({ title: `保存失败：${describeError(err)}`, icon: 'none' });
    });
  },

  /** 清除：二次确认后才清（与删除任务同样的做法） */
  onAiConfigClear() {
    if (!aiConfigReady() || this.data.aiClearing) return;
    if (!this.data.aiHasKey) {
      wx.showToast({ title: '当前没有你自己填的 Key', icon: 'none' });
      return;
    }

    wx.showModal({
      title: '确认清除',
      content: '确定清除你自己填的 API Key 吗？清除后会改回使用程序预置的 Key'
        + '（如果也没有预置，AI 功能将不可用）。此操作不影响你的日程数据。',
      confirmText: '清除',
      confirmColor: '#e0553f',
      success: (res) => {
        if (!res || !res.confirm) return;
        this.doClearAiConfig();
      },
    });
  },

  /** 真正执行清除 */
  doClearAiConfig() {
    this.setData({ aiClearing: true, aiResultText: '' });
    api.aiConfigClear().then((result) => {
      if (result && result.ok === false) throw new Error(describeError(result));
      this.applyAiConfig(extractAiConfig(result));
      this.setData({
        aiClearing: false,
        aiResultText: '已清除。之后 AI 会使用程序预置的 Key（如果有）。',
      });
      wx.showToast({ title: '已清除', icon: 'none' });
    }).catch((err) => {
      this.setData({
        aiClearing: false,
        aiResultText: `清除失败：${describeError(err)}`,
      });
      wx.showToast({ title: `清除失败：${describeError(err)}`, icon: 'none' });
    });
  },

  // =========================================================================
  // 四、导入课表（.ics）
  // =========================================================================

  /**
   * 拉一次任务列表，算出"替换会删几门课 / 不碰几条手工任务"。
   *
   * 失败**不报错**：这只是给确认框用的一组参考数字。读不到就不显示数字，
   * 但绝不能因此拦住导入（那才是本末倒置）。
   * @returns {Promise<void>}
   */
  refreshImportCounts() {
    return api.listTasks().then((result) => {
      if (result && result.ok === false) throw new Error(describeError(result));
      this.applyImportCounts(extractTasks(result));
    }).catch((err) => {
      this.tasksForCounts = null;
      console.warn('[me] 读取任务用于统计替换条数失败（不影响导入）：', describeError(err));
    });
  },

  /** 把统计结果写进 data（也用于"拉不到"时的兜底文案） */
  applyImportCounts(tasks) {
    if (!tasks) {
      this.setData({
        courseCount: 0,
        manualCount: 0,
        replaceSummary: '替换会先清空已有课表（只清课程，不动你手工添加的任务）。',
      });
      return;
    }
    this.tasksForCounts = tasks;
    const split = splitCoursesAndManual(tasks);
    this.setData({
      courseCount: split.courseCount,
      manualCount: split.manualCount,
      replaceSummary: split.courseCount
        ? `替换会先删除现有 ${split.courseCount} 门课程；你手工添加的 ${split.manualCount} 条任务不受影响。`
        : `当前没有可替换的课程；你手工添加的 ${split.manualCount} 条任务不受影响。`,
    });
  },

  /** 切换导入方式（替换 / 追加），默认是替换 */
  onImportModeChange(event) {
    const mode = str(event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.mode
      : '');
    if (mode !== 'replace' && mode !== 'append') return;
    if (mode === 'replace' && !this.data.importReplaceReady) {
      wx.showToast({ title: '替换功能尚未就绪，请先用追加', icon: 'none' });
      return;
    }
    this.setData({ importMode: mode, importResultText: '' });
  },

  /** 从聊天记录里挑一个 .ics 文件 */
  onPickIcs() {
    if (!icsReady()) {
      wx.showToast({ title: '当前版本的课表导入不可用', icon: 'none' });
      return;
    }
    if (this.data.importing || this.data.submitting) return;

    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['ics'],
      success: (res) => {
        const file = res && res.tempFiles && res.tempFiles[0];
        if (!file) return;
        const name = str(file.name) || '课表.ics';
        if (!/\.ics$/i.test(name)) {
          wx.showToast({ title: '请选择 .ics 文件', icon: 'none' });
          return;
        }
        // 10MB 以上的日历文件基本不可能是课表，先挡掉免得 readFile 卡住
        if (Number(file.size) > 10 * 1024 * 1024) {
          wx.showToast({ title: '文件太大（超过 10MB）', icon: 'none' });
          return;
        }
        this.readIcsFile(file.path, name);
      },
      fail: (err) => {
        // 用户主动取消不算错误，不弹提示
        const msg = str(err && err.errMsg);
        if (msg && msg.indexOf('cancel') !== -1) return;
        wx.showToast({ title: `选择文件失败：${msg || '未知原因'}`, icon: 'none' });
      },
    });
  },

  /** 读文件 → 解析 → 预览（此阶段**不写库**） */
  readIcsFile(filePath, fileName) {
    this.setData({ importing: true, importResultText: '', warnings: [], previewItems: [], pendingTasks: [] });

    const finish = (ok, payload) => {
      this.setData({ importing: false });
      if (!ok) {
        this.setData({ pickedFileName: fileName, importResultText: `解析失败：${payload}` });
        wx.showToast({ title: '解析失败，详见页面提示', icon: 'none' });
        return;
      }
      const { events, warnings, tasks } = payload;
      const preview = tasks.slice(0, 8).map((task) => ({
        title: str(task.title) || '(无标题)',
        dateText: formatDateCn(task.date),
        whenText: whenTextOf(task),
        typeLabel: TYPE_LABELS[str(task.type)] || '日程',
      }));

      this.pendingTasks = tasks;
      this.setData({
        pickedFileName: fileName,
        parsedCount: events.length,
        taskCount: tasks.length,
        warnings: warnings || [],
        previewItems: preview,
        previewMore: Math.max(tasks.length - preview.length, 0),
        pendingTasks: [],
        importResultText: tasks.length
          ? `解析出 ${events.length} 个日程，可导入 ${tasks.length} 条`
          : `解析出 ${events.length} 个日程，但没有可导入的条目`,
      });
    };

    try {
      wx.getFileSystemManager().readFile({
        filePath,
        encoding: 'utf8',
        success: (res) => {
          const text = res && res.data ? String(res.data) : '';
          if (!text.trim()) {
            finish(false, '文件是空的');
            return;
          }
          try {
            const parsed = ics.parseIcs(text);
            const events = (parsed && parsed.events) || [];
            const warnings = (parsed && parsed.warnings) || [];
            const tasks = ics.toTasks(events) || [];
            finish(true, { events, warnings, tasks: tasks.slice(0, MAX_IMPORT) });
          } catch (err) {
            // 解析器的异常原样转达（不自己编原因），但不把堆栈甩给用户
            finish(false, describeError(err));
          }
        },
        fail: (err) => {
          finish(false, `读文件失败：${str(err && err.errMsg) || '未知原因'}`);
        },
      });
    } catch (err) {
      finish(false, describeError(err));
    }
  },

  /**
   * 确认导入。
   *
   * 两种模式：
   *   * 替换（默认）：先弹二次确认，**文案里必须写清会删几门课、不会碰什么**，
   *     确认后调 import_replace（scope='courses'），由云函数保证"删+插"是一次事务；
   *   * 追加：沿用原来的 bulk_add，直接入库。
   */
  onConfirmImport() {
    const tasks = this.pendingTasks || [];
    if (!tasks.length || this.data.submitting) return;

    if (this.data.importMode !== 'replace') {
      this.doAppend(tasks);
      return;
    }
    if (!this.data.importReplaceReady) {
      wx.showToast({ title: '替换功能尚未就绪，请改用「追加」', icon: 'none' });
      return;
    }

    // 确认前把数字摆出来：会删多少、导入多少、不碰多少。
    // 这些数字来自导入前的快照（loadAll / 选文件时拉的），用户点确认前就能看到。
    const willRemove = this.data.courseCount;
    const willInsert = tasks.length;
    const keepManual = this.data.manualCount;
    const content = `将删除现有 ${willRemove} 门课程，再导入 ${willInsert} 门；`
      + `你手动添加的 ${keepManual} 条日程与截止不受影响。`;

    wx.showModal({
      title: '替换已有课表？',
      content,
      confirmText: '替换',
      confirmColor: '#e0553f',
      success: (res) => {
        if (!res || !res.confirm) return;
        this.doReplace(tasks);
      },
    });
  },

  /**
   * 替换导入：调云函数的 import_replace（scope 固定 'courses' = 只清课表类任务）。
   *
   * 【为什么不能前端先删再插】那样"删完、插失败"会把用户课表清空 ——
   * 所以整件事必须由云函数一次完成（删与插同生共死），前端只发一次请求。
   */
  doReplace(tasks) {
    // 再挡一道：调用方（onConfirmImport）已经检查过，但这里是真正发请求的地方。
    // 没有这道守卫，api.importReplace 不存在时会抛 TypeError（红屏式报错），
    // 那是最糟的失败方式 —— 用户只该看到一句人话。
    if (!importReplaceReady()) {
      wx.showToast({ title: '替换功能尚未就绪，请改用「追加」', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    api.importReplace(tasks).then((result) => {
      if (result && result.ok === false) throw new Error(describeError(result));
      // 平铺形状：{ ok, removed, inserted, skipped, errors }（与本文件 ai_config 的取值口一致）
      const data = (result && result.data) || result || {};
      const removed = Number(data.removed) || 0;
      const inserted = Number(data.inserted) || 0;
      const skipped = Number(data.skipped) || 0;
      const errors = Array.isArray(data.errors) ? data.errors : [];

      const parts = [`已替换：删除 ${removed} 门、导入 ${inserted} 门`];
      if (skipped) parts.push(`跳过 ${skipped} 条`);
      const text = parts.join('、');

      this.pendingTasks = [];
      this.setData({
        submitting: false,
        importResultText: text,
        warnings: errors.length ? errors.slice(0, 5) : this.data.warnings,
        previewItems: [],
        previewMore: 0,
        taskCount: 0,
        parsedCount: 0,
      });
      wx.showToast({ title: text, icon: inserted ? 'success' : 'none' });
      // 课表变了，重新统计一次"替换会删几门课"
      this.refreshImportCounts();
    }).catch((err) => {
      this.setData({ submitting: false });
      wx.showToast({ title: `替换失败：${describeError(err)}`, icon: 'none' });
    });
  },

  /** 追加导入（原来的行为，bulk_add） */
  doAppend(tasks) {
    this.setData({ submitting: true });
    api.bulkAdd(tasks).then((result) => {
      if (result && result.ok === false) throw new Error(describeError(result));
      // 云函数返回 { ids, inserted, skipped, errors[] }
      const data = (result && result.data) || {};
      const inserted = Number(data.inserted) || 0;
      const skipped = Number(data.skipped) || 0;
      const errors = Array.isArray(data.errors) ? data.errors : [];

      const parts = [`已入库 ${inserted} 条`];
      if (skipped) parts.push(`跳过 ${skipped} 条`);
      const text = parts.join('、');

      this.pendingTasks = [];
      this.setData({
        submitting: false,
        importResultText: text,
        // 云函数逐条给的跳过原因要显示出来（不然用户不知道漏了什么）
        warnings: errors.length ? errors.slice(0, 5) : this.data.warnings,
        previewItems: [],
        previewMore: 0,
        taskCount: 0,
        parsedCount: 0,
      });
      wx.showToast({ title: text, icon: inserted ? 'success' : 'none' });
      this.refreshImportCounts();
    }).catch((err) => {
      this.setData({ submitting: false });
      wx.showToast({ title: `入库失败：${describeError(err)}`, icon: 'none' });
    });
  },

  /** 放弃这次导入 */
  onCancelImport() {
    this.pendingTasks = [];
    this.setData({
      pickedFileName: '',
      parsedCount: 0,
      taskCount: 0,
      warnings: [],
      previewItems: [],
      previewMore: 0,
      importResultText: '',
    });
  },

  // =========================================================================
  // 四、导出备份
  // =========================================================================

  /**
   * 导出：读全部任务 → 拼成 JSON → 复制到剪贴板。
   * 小程序里没有"下载到本地文件"的通用做法，剪贴板是最省事也最不容易出错的方式。
   */
  onExport() {
    if (this.data.exporting) return;
    this.setData({ exporting: true, exportHint: '' });

    api.listTasks().then((result) => {
      if (result && result.ok === false) throw new Error(describeError(result));
      const tasks = extractTasks(result);
      const payload = {
        app: this.data.appName,
        version: this.data.version,
        exported_at: new Date().toISOString(),
        semester_start: this.data.semesterStart || null,
        count: tasks.length,
        tasks,
      };
      const text = JSON.stringify(payload, null, 2);

      return new Promise((resolve, reject) => {
        wx.setClipboardData({
          data: text,
          success: () => resolve({ tasks, text }),
          fail: (err) => reject(new Error(`复制到剪贴板失败：${str(err && err.errMsg) || '未知原因'}`)),
        });
      });
    }).then(({ tasks, text }) => {
      this.setData({
        exporting: false,
        exportTaskCount: tasks.length,
        exportPreview: text.slice(0, 120),
        exportHint: tasks.length
          ? `已复制 ${tasks.length} 条任务（约 ${Math.max(Math.round(text.length / 1024), 1)} KB）到剪贴板，粘贴到备忘录或发给自己即可备份。`
          : '当前还没有任务，已经复制了一份空备份结构。',
      });
      wx.showToast({ title: '已复制到剪贴板', icon: 'success' });
    }).catch((err) => {
      this.setData({ exporting: false, exportHint: `导出失败：${describeError(err)}` });
      wx.showToast({ title: `导出失败：${describeError(err)}`, icon: 'none' });
    });
  },

  // =========================================================================
  // 五、杂项
  // =========================================================================

  /** 复制云环境 ID（提交作业 / 排障时经常要用） */
  onCopyEnvId() {
    const app = getApp();
    const envId = str(app && app.globalData && app.globalData.envId);
    if (!envId) {
      wx.showToast({ title: '还没读到云环境 ID', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: envId,
      success: () => wx.showToast({ title: '已复制云环境 ID', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败', icon: 'none' }),
    });
  },
});

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function str(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function pad2(number) {
  return number < 10 ? `0${number}` : String(number);
}

/** 今天（本地时区的日历日，与 utils/periods.js 口径一致） */
function todayStr() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** "2026-09-07" → "9月7日"；解析不了返回原文 */
function formatDateCn(dateStr) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(dateStr));
  if (!matched) return str(dateStr) || '未定日期';
  return `${Number(matched[2])}月${Number(matched[3])}日`;
}

/** 预览里那一条的"什么时候"：节次优先，其次钟点 */
function whenTextOf(task) {
  const raw = str(task.periods);
  if (raw) {
    const matched = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(raw);
    if (matched) return `第${matched[1]}-${matched[2]}节`;
    if (/^\d{1,2}$/.test(raw)) return `第${raw}节`;
    return raw;
  }
  const start = str(task.start_time);
  const end = str(task.end_time);
  if (start && end) return `${start}-${end}`;
  if (start) return start;
  if (end) return `${end} 前`;
  return '';
}

/** 从 api 返回值里取 {semester_start, period_times} */
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

/**
 * 把云函数的 AI 配置返回整理成"能安全上屏"的对象。
 *
 * ===========================================================================
 * 【分工：形状归 api.js，加固归本页 —— 两段都别删】
 * ===========================================================================
 *   1. **形状（平铺还是嵌套）由 utils/api.js 的 readAiConfig() 统一负责**。
 *      本页不再写 `result.data === undefined ? result : result.data` 这种"两种都认"的容忍
 *      —— 那正是"上游形状翻来覆去改却没人发现"的温床：页面自己猜形状，
 *      猜对了也没人知道契约到底是哪一种。现在只有一个地方知道返回长什么样。
 *
 *   2. **下面这两道加固与形状无关，是显示层的安全兜底，必须留在这里**：
 *      * 只认 provider / model / hasKey / masked 这几个渲染必需的字段，
 *        **绝不读取 api_key / key / secret 之类的字段** —— 万一哪天服务端误回明文，
 *        它也不会被带进页面 data，界面上就不可能显示出来；
 *      * masked 必须长得像掩码（`****abcd`），否则降级成 `****` ——
 *        防的是"明文被当成掩码直接渲染上屏"。
 *      换句话说：api.js 保证"字段取得出来"，本页保证"取出来的东西能安全显示"。
 *      看到这两段觉得重复而删掉一段，就等于拆掉其中一道防线。
 *
 * @param {object} result api.aiConfigGet / Save / Clear 的返回值（{ok, data, error}）
 * @returns {{provider, model, hasKey, masked, preset_provider}} 可直接进 data 的对象
 */
function extractAiConfig(result) {
  var empty = { provider: '', model: '', hasKey: false, masked: '', preset_provider: '' };
  if (!result || typeof result !== 'object') return empty;

  // 形状全部交给 api.js —— 连"平铺还是嵌套"都不用本页操心。
  // 注意传的是 result.data（云函数原始返回体）；result.data 缺失或不是对象时
  // 退回 result 本身，交给 readAiConfig 自己的判断，避免传个 undefined 进去。
  var payload = result.data && typeof result.data === 'object' ? result.data : result;
  if (typeof api.readAiConfig !== 'function') return empty; // 接口未就绪时不硬编形状

  var config = api.readAiConfig(payload) || {};

  // ---- 加固一：只认这几个字段（不会把任何 api_key / key / secret 带出去）----
  var provider = str(config.provider);
  var model = str(config.model);

  // ---- 加固二：masked 只接受"看起来就是掩码"的值 ----
  var rawMasked = str(config.masked);
  var masked = /^\*+[A-Za-z0-9]{0,8}$/.test(rawMasked) ? rawMasked : (rawMasked ? '****' : '');

  return {
    provider: provider,
    model: model,
    hasKey: config.hasKey === true,
    masked: masked,
    // 服务端**目前不回**这个字段（预置 Key 配在 aiParse/aiDecompose 的环境变量里，
    // tasks 无从得知，所以刻意不提供）。这里保留读取是为了万一将来真给了，
    // 界面能直接显示"正在使用预置 Key"；读不到就走上面的"你还没填自己的 Key"。
    preset_provider: str(config.preset_provider) || (config.preset === true ? 'preset' : ''),
  };
}

/**
 * provider 在白名单里的下标；找不到返回 -1。
 *
 * **只做 trim、不做小写化**，比对是严格相等的：'GLM' / 'Deepseek' 这类大小写变体
 * 一律不认。白名单校验宁可严一点 —— 反正 UI 是下拉框，用户永远只会拿到规范值，
 * 而任何"看着像"的值都可能是有人想塞别的东西（云函数那边也是按规范值存的）。
 * 只 trim 是因为首尾空格纯属手滑，不是另一种服务商。
 */
function indexOfProvider(value) {
  const target = str(value);
  for (let i = 0; i < AI_PROVIDERS.length; i += 1) {
    if (AI_PROVIDERS[i].value === target) return i;
  }
  return -1;
}

/** 只允许白名单里的服务商（挡住任何"自定义地址"的可能） */
function isAllowedProvider(value) {
  return indexOfProvider(value) !== -1;
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

/**
 * 把 settings 结果同步给 app.js 的 globalData。
 *
 * 【为什么必须做】课表页算周次/单双周读的是 app.globalData.semesterStart；
 * 如果这里改完设置不通知它，用户切回课表看到的还是**旧的学期**，会以为没保存成功。
 * app.applySettings() 就是为这件事准备的（见 app.js 注释）。
 */
function syncGlobalSettings(result) {
  try {
    const app = getApp();
    if (app && typeof app.applySettings === 'function') {
      app.applySettings(result && result.data !== undefined ? result.data : result);
      return;
    }
    // 兜底：老版 app.js 没有 applySettings 时直接写字段
    const data = (result && result.data) || result || {};
    if (app && app.globalData) {
      if (str(data.semester_start)) app.globalData.semesterStart = str(data.semester_start);
      if (data.period_times && typeof data.period_times === 'object') {
        app.globalData.periodTimes = data.period_times;
      }
      app.globalData.settingsLoaded = true;
    }
  } catch (err) {
    // 同步失败不影响本页（课表页自己也会读一次设置），只留日志
    console.warn('[me] 同步 globalData 失败（不影响使用）：', err);
  }
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
