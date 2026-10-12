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
// 到期提醒（微信订阅消息 / 服务通知）
// ---------------------------------------------------------------------------
/**
 * 云函数名：**独立云函数** `remind`，不是 tasks 的一个 action。
 * 契约见 docs/到期提醒.md 第 8 节，云端已冻结，前端照着调即可。
 */
const REMIND_FUNCTION = 'remind';

/** 提示用户去看配置文档时用的路径（写在文案里，不改文档位置就不会错） */
const REMIND_DOC = 'docs/到期提醒.md';

/** 服务端放模板 ID 的那个环境变量名（只在"判断服务端那句话是不是在讲模板"时用） */
const REMIND_TEMPLATE_ENV = 'REMIND_TEMPLATE_ID';

/** 云函数没给 lead_options 时的兜底档位（与 remind 云函数的 LEAD_MIN_OPTIONS 同一份值） */
const FALLBACK_LEAD_OPTIONS = [15, 30, 60, 120, 1440];

/** 提前量档位的中文说法（WXML 不能调方法，所以做成一份常量表按 picker 下标取） */
const LEAD_TEXTS = FALLBACK_LEAD_OPTIONS.map((minutes) => `提前 ${describeLeadMinutes(minutes)}`);

/** toast 标题太长会被截断，所以页面自己先截（与 api.js 的口径一致） */
const MAX_TOAST_CHARS = 30;

/** 「我的」页不硬编码模板 ID，一律从 status 取（见本文件 loadRemindStatus 的注释） */
const EMPTY_REMIND_STATUS = {
  template_id: '',
  page: '',
  enabled: false,
  lead_min: 0,
  lead_options: [],
  quota: 0,
  max_quota: 0,
  ready: false,
  ready_reason: '',
  has_authorized: false,
};

/** 用户点按钮时，模板确实没配 → 这句话必须指向"下一步做什么" */
const REMIND_NO_TEMPLATE_TIP = `服务端还没配置订阅消息模板 ID，请先按 ${REMIND_DOC} 配置`;

/**
 * ===========================================================================
 * 【这个功能为什么这么"别扭"：三条平台约束，不是我们的实现选择】
 * ===========================================================================
 * 1. **必须用户主动授权**（`wx.requestSubscribeMessage`）。小程序不能自己给自己发通知，
 *    所以"开关"其实不是一个本地开关，而是"再弹一次授权窗"的入口。
 * 2. **订阅消息是一次性的：授权一次 = 服务端只能下发一条**。所以每点一次按钮只
 *    +1 次机会（`ack({count:1})`）—— 一次攒 3 次是**做不到**的（微信一次授权最多
 *    也只能接受模板位，而用户点一下就是一条）。页面上必须把这句解释写出来，
 *    否则用户会以为"我明明授权过了，怎么又不够了"是 bug。
 * 3. **模板 ID 只有服务端有**（云开发控制台的环境变量 `REMIND_TEMPLATE_ID`）。
 *    前端**绝不能硬编码**它：换模板只该改那一个环境变量，不该重新提审小程序。
 *    所以流程永远是 `status` 拿 `template_id` → 用它去弹授权窗。
 *
 * 【第四条：为什么 status 失败必须静默】
 * 进页面顺手读一次"提醒设置"属于**用户还没做任何事**的后台读取。此时弹一句
 * "网络异常"只会让人莫名其妙（他可能只是来看学期设置的）。所以这一路用
 * `{silent:true}`，失败只在卡片里写一行灰字。反过来，**用户主动点**的动作
 * （补充授权 / 改提前量 / 发测试提醒）一律不用 silent —— 点了就必须有反馈。
 */

/**
 * 归一化提前量候选：只保留正整数分钟，且必须按升序（picker 的下标要和它对得上）。
 * 服务端返回脏数据时退回内置档位 —— 卡片不能因为一个字段坏掉就整个不可用。
 *
 * @param {*} value 云函数返回的 lead_options
 * @returns {Array<number>} 非空、升序的分钟数组
 */
function normalizeLeadOptions(value) {
  const list = Array.isArray(value) ? value : [];
  const clean = list
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map((item) => Math.round(item));
  // 去重 + 升序：否则同一个档位会出现两次，picker 选中项也说不清是哪一个
  const unique = clean.filter((item, index) => clean.indexOf(item) === index);
  unique.sort((a, b) => a - b);
  return unique.length ? unique : FALLBACK_LEAD_OPTIONS.slice();
}

/**
 * 分钟数 → 人话。1440 说"提前 1 天"比"提前 1440 分钟"好读得多。
 * @param {number} minutes
 * @returns {string}
 */
function describeLeadMinutes(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value % 1440 === 0) {
    const days = value / 1440;
    return days === 1 ? '1 天' : `${days} 天`;
  }
  if (value % 60 === 0) {
    const hours = value / 60;
    return hours === 1 ? '1 小时' : `${hours} 小时`;
  }
  return `${value} 分钟`;
}

/** 提前量 → 「提前 30 分钟」（WXML 与 toast 共用同一句，不会两处写法不一致） */
function leadTextOf(minutes) {
  const human = describeLeadMinutes(minutes);
  return human ? `提前 ${human}` : '';
}

/**
 * 把 status 的返回整理成"能直接上屏"的一组字段。
 *
 * 【两层 ok 是必须的】utils/api.js 的 `callCloudFunction` 会把云函数返回值**包一层**：
 *   外层 `{ ok:true, data:<云函数返回值>, error:null }`；云函数自己那份也是平铺的
 *   `{ ok:true, enabled, quota, ... }`。所以字段要从 `data` 上取，而**两层 ok 都要判**：
 *   只看外层会把 `{ok:false,error:'…'}` 当成成功，于是界面上出现一堆 0/空值，
 *   看起来像"功能坏了"，其实是读取失败。
 *
 * @param {object} result api.callCloudFunction 的返回值
 * @returns {object} 可直接进 data 的提醒状态（取不到的字段给安全默认值）
 */
function readRemindStatus(result) {
  const empty = Object.assign({}, EMPTY_REMIND_STATUS);
  if (!result || result.ok !== true) return empty;
  // 形状以 api.js 为准（外层 ok + data）；缺 data 时退回 result 本身，纯属防脏数据
  const data = (result.data && typeof result.data === 'object') ? result.data : result;
  if (data.ok !== true) return empty;

  const options = normalizeLeadOptions(data.lead_options);
  const leadMin = Number(data.lead_min);
  return {
    template_id: str(data.template_id),
    page: str(data.page),
    enabled: data.enabled === true,
    // lead_min 只认候选档位里的值：不在候选里时界面显示"提前 60 分钟"会与 picker 选中项对不上
    lead_min: options.indexOf(leadMin) === -1 ? options[0] : leadMin,
    lead_options: options,
    quota: Math.max(0, Math.floor(Number(data.quota) || 0)),
    max_quota: Math.max(0, Math.floor(Number(data.max_quota) || 0)),
    ready: data.ready === true,
    ready_reason: str(data.ready_reason),
    has_authorized: data.has_authorized === true,
  };
}

/** 同上，用于 ack / config 的返回（它们只回一部分字段） */
function readRemindPatch(result) {
  const empty = {
    template_id: '',
    enabled: false,
    lead_min: 0,
    quota: 0,
    added: 0,
    capped: false,
    max_quota: 0,
  };
  if (!result || result.ok !== true) return empty;
  const data = (result.data && typeof result.data === 'object') ? result.data : result;
  if (data.ok !== true) return empty;
  return {
    template_id: str(data.template_id),
    enabled: data.enabled === true,
    lead_min: Number(data.lead_min) || 0,
    quota: Number(data.quota) || 0,
    added: Number(data.added) || 0,
    capped: data.capped === true,
    max_quota: Number(data.max_quota) || 0,
  };
}

/**
 * ===========================================================================
 * 【建议后续补在 utils/api.js 里的薄封装】—— 本页暂时只能自己包一层
 * ===========================================================================
 * 本次改动**不许动 utils/api.js**（有人正在改它），所以这三个封装先留在页面里：
 *
 *     function remindStatus(options) { return api.callCloudFunction('remind', { action:'status' },
 *       '云函数 remind 没有返回结果，请确认已部署', options); }
 *     function remindAck(count)      { return api.callCloudFunction('remind', { action:'ack', count: count }); }
 *     function remindConfig(patch)   { return api.callCloudFunction('remind', { action:'config', ...patch }); }
 *     function remindTest()          { return api.callCloudFunction('remind', { action:'test' }); }
 *
 * 搬过去之后，`pages/tasks` 里那份一模一样的实现可以一起删掉（那边只用到 status）。
 * 现在不搬是因为 api.js 的所有权不在本次改动范围内。
 */
function remindCall(payload, options) {
  return api.callCloudFunction(REMIND_FUNCTION, payload,
    '云函数 remind 没有返回结果，请确认已部署', options);
}

/** 读提醒状态（silent 由调用方决定：进页面读用 silent，用户点过按钮的收尾刷新也用） */
function remindStatus(options) {
  return remindCall({ action: 'status' }, options);
}

/** 上报"用户刚授权了 count 次"。count **只能是 1..3 的数字**（服务端断言 typeof number） */
function remindAck(count) {
  return remindCall({ action: 'ack', count: count });
}

/** 改提前量 / 开关 */
function remindConfig(patch) {
  const data = Object.assign({ action: 'config' }, patch || {});
  return remindCall(data);
}

/** 立刻发一条测试提醒（默认不消耗额度，返回值里有 quota_consumed） */
function remindTest() {
  return remindCall({ action: 'test' });
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

/**
 * 合并作息表：**新导入的节次覆盖同名节次，未涉及的节次保留原值**。
 *
 * 合并基准必须是"当前生效的作息"（页面里的 this.periodTimes，来自 settings），
 * **不是空对象** —— 否则一次只校准了几节课的导入会把其它节次的作息抹掉。
 * 这条语义与 Web 版一致（那边也是往 settings 里增量 upsert）。
 *
 * @param {object|null} base 当前作息 {"1": ["08:00","08:45"], ...}
 * @param {object|null} incoming 本次从文件校准出来的作息
 * @returns {object|null} 合并结果；两边都空时返回 null（调用方据此跳过保存）
 */
function mergePeriodTimes(base, incoming) {
  const baseObj = (base && typeof base === 'object') ? base : {};
  const nextObj = (incoming && typeof incoming === 'object') ? incoming : {};
  const keys = Object.keys(nextObj);
  if (!keys.length) return null; // 没有任何新校准 → 不保存（调用方也不提示）

  const merged = {};
  // 先铺原有的，再用新的覆盖同名项
  Object.keys(baseObj).forEach((key) => { merged[key] = baseObj[key]; });
  keys.forEach((key) => { merged[key] = nextObj[key]; });
  return merged;
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

    // --- 三点五、到期提醒（微信订阅消息 / 服务通知，云函数 remind） ---
    remindLoading: true,        // 正在读提醒设置
    remindReadFailed: false,    // 读失败 → 卡片里只写一行灰字（见 loadRemindStatus 注释）
    remindReady: false,         // 「现在点一下就能收到一条提醒」（服务端配好模板 + 开关开着 + 还有额度）
    remindEnabled: false,
    remindQuota: 0,             // 剩余可提醒次数
    remindMaxQuota: 0,          // 额度上限（服务端封顶，用于"N / 上限"的展示）
    remindQuotaText: '',        // 「剩余可提醒次数 2 / 10」
    remindLeadMin: 0,
    remindLeadIndex: 0,         // picker 选中下标（与 remindLeadOptions 一一对应）
    remindLeadOptions: FALLBACK_LEAD_OPTIONS.slice(),
    remindLeadTexts: LEAD_TEXTS.slice(),
    remindLeadText: '',         // 「提前 30 分钟」
    remindReadyReason: '',      // 服务端给的人话，ready=false 时原样显示
    remindStatusType: '',       // '' | 'on' | 'off' | 'warn'
    remindStatusText: '',       // 卡片里那行主状态
    remindConfigError: false,   // 上面那行是不是"配置问题"（决定按钮文案）
    remindHint: '',             // 灰字提示行（读失败 / 读取中）
    remindBusy: false,          // 正在弹授权窗或正在上报（防连点）
    remindResultText: '',       // ack / config / test 的结果，如实显示
    remindResultType: '',       // '' | 'ok' | 'warn'
    remindTestAvailable: false, // 能不能发测试提醒（模板配好 + 至少授权过）

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
    calibratedPeriodCount: 0,   // 本次从文件里校准出多少节上下课时间
    calibratedText: '',         // 「并从文件里校准出 N 节上下课时间，导入成功后会一并保存」
    periodSaveText: '',         // 作息保存这一路的独立结果（成功/失败都写这里）
    periodSaveFailed: false,    // 上面那句是不是失败（WXML 里不能调方法，只能带个标记）
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
    // 到期提醒的状态也是独立一条链：它读不到不该把"学期设置 / 作息表"变成错误态。
    // 【silent】进页面顺手读一次，失败不弹 toast（见文件头第四条）。
    this.loadRemindStatus({ silent: true });
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
  // 三点五、到期提醒（微信订阅消息 / 服务通知，云函数 remind）
  // =========================================================================
  // 云函数名是 **remind**（独立云函数，不是 tasks 的 action），契约见
  // docs/到期提醒.md 第 8 节。前端不硬编码模板 ID，一律从 status 取。
  // =========================================================================

  /**
   * 读一次提醒状态并重画卡片。
   *
   * 【silent 的两种用法，别用混】
   *   * 进页面 / onShow 顺手读：`{silent:true}` —— 用户还没做任何操作，失败只写一行灰字；
   *   * 用户**点过按钮**之后的收尾刷新：也用 silent —— 这一步失败不该再弹一次 toast
   *     （用户已经看到"已增加 1 次提醒机会"，再来一句"网络异常"只会让人以为刚才那次没成）。
   *   用户主动发起的动作本身（enable / lead / test）**绝不** silent ——
   *   它们连 `loadRemindStatus` 都不走：**请求本身就是那条反馈**，失败会由
   *   api.js 弹 toast 并写进结果行。
   *
   * @param {{silent?: boolean}} [options] 只有显式传 `{silent:false}` 才会不静默
   *        （默认静默：进页面 / onShow 顺手读一次都走这条路）
   * @returns {Promise<void>}
   */
  loadRemindStatus(options) {
    const silent = !(options && options.silent === false);
    this.setData({ remindLoading: true, remindHint: silent ? '' : this.data.remindHint });
    return remindStatus({ silent: silent }).then((result) => {
      if (!result || result.ok !== true || !result.data || result.data.ok !== true) {
        // 【必须显式判两层 ok】api.js 失败时 resolve {ok:false,error}（不 reject）。
        // 不判的话这次失败会被渲染成"剩余 0 次、开关关着"，看起来像功能坏了。
        throw new Error(describeError(result));
      }
      this.applyRemindStatus(readRemindStatus(result));
    }).catch((err) => {
      // 【为什么只是灰字】见 loadRemindStatus 上面的说明与文件头的第四条。
      this.setData({
        remindLoading: false,
        remindReadFailed: true,
        // 只陈述"读不到"这个事实，不猜原因（可能压根没部署 remind，也可能是断网）
        remindHint: `暂时读不到提醒设置${describeError(err) ? `（${describeError(err)}）` : ''}`,
        remindStatusType: '',
        remindStatusText: '',
      });
    });
  },

  /**
   * 把归一化后的提醒状态写进 data（只写渲染需要的字段）。
   * @param {{template_id,enabled,lead_min,lead_options,quota,max_quota,ready,ready_reason}} s
   */
  applyRemindStatus(s) {
    const status = s || {};
    const options = normalizeLeadOptions(status.lead_options);
    const leadMin = options.indexOf(Number(status.lead_min)) === -1 ? options[0] : Number(status.lead_min);
    const quota = Math.max(0, Math.floor(Number(status.quota) || 0));
    const maxQuota = Math.max(0, Math.floor(Number(status.max_quota) || 0));
    const templateId = str(status.template_id);
    const reason = str(status.ready_reason);
    // 没配模板是**服务端配置问题**，不是用户能在这儿解决的；按钮得指向该做的事
    const configError = !templateId;

    // 【只放实例上，不放 data】模板 ID 是拿来做参数的，界面上一个字都不显示
    // （它是服务端配置，用户既看不懂也不需要看；只显示"配没配好"这个结论）。
    this.remindTemplateId = templateId;

    let statusType = '';
    let statusText = '';
    if (configError) {
      statusType = 'warn';
      statusText = '服务端还没配置订阅消息模板，功能暂时不可用';
    } else if (status.enabled === true) {
      statusType = 'on';
      statusText = quota > 0 ? '已开启' : '已开启，但授权次数用完了';
    } else {
      statusType = 'off';
      statusText = '未开启';
    }

    this.setData({
      remindLoading: false,
      remindReadFailed: false,
      remindHint: '',
      remindReady: status.ready === true,
      remindEnabled: status.enabled === true,
      remindQuota: quota,
      remindMaxQuota: maxQuota,
      remindQuotaText: maxQuota ? `剩余可提醒次数 ${quota} / ${maxQuota}` : `剩余可提醒次数 ${quota}`,
      remindLeadMin: leadMin,
      remindLeadIndex: Math.max(options.indexOf(leadMin), 0),
      remindLeadOptions: options,
      remindLeadTexts: options.map(leadTextOf),
      remindLeadText: leadTextOf(leadMin),
      remindReadyReason: reason,
      remindStatusType: statusType,
      remindStatusText: statusText,
      remindConfigError: configError,
      // 【测试提醒的两个前置】模板已配 + 至少授权过（quota>0 或开关开着）。
      // 少了前者云函数会直接返回"还没配置模板"；少了后者用户什么都收不到，
      // 与其让他点了才看到报错，不如按钮直接置灰并说明。
      remindTestAvailable: !configError && (quota > 0 || status.enabled === true),
    });
  },

  /**
   * 点「开启 / 补充授权」。
   *
   * ===========================================================================
   * 【为什么一次只 +1：这是平台硬限制，不是我们的实现选择】
   * ===========================================================================
   * 一次性订阅的语义是"用户授权一次，服务端只能下发一条"。所以：
   *   点一次按钮 → 弹一次授权窗 → 用户点允许 → `ack({count:1})` → 额度 +1。
   * 想"一次攒 3 条"是做不到的（`ack` 的 count 允许 1..3 是给一次性勾多个模板位留的，
   * 而我们只勾一个模板）。这句解释必须写在按钮下面，否则用户会以为功能坏了。
   *
   * 【顺序不能换】① 没有 template_id 就不弹窗（弹了也没用）；② 弹窗；③ 按
   * `res[template_id]` 分流：`accept` 才 ack，`reject` / `ban` 一律**不 ack**
   * （没授权却加额度 = 骗服务端，下次真实下发必然 43101 失败）。
   */
  onRemindEnable() {
    if (this.data.remindLoading || this.data.remindBusy) return;

    // ---- ① 模板 ID 只能从 status 拿（前端不硬编码）----
    // 走到这里还没有 template_id，只有两种可能：status 没读到（读失败/还在路上），
    // 或服务端没配环境变量。两种都**不发请求、不弹授权窗**，并且给出下一步该做什么。
    if (!this.remindTemplateId) {
      this.promptRemindConfig();
      return;
    }

    // ---- ② 弹授权窗 ----
    // 【注意 tmplIds 里的键就是它自己】回调里要用**同一个** template_id 去取结果，
    // 所以下面判 res[this.remindTemplateId] —— 写死 'accept' 判断整个 res 是错的。
    this.setData({ remindBusy: true, remindResultText: '', remindResultType: '' });
    wx.requestSubscribeMessage({
      tmplIds: [this.remindTemplateId],
      success: (res) => this.handleSubscribeResult(res),
      fail: (err) => this.handleSubscribeFail(err),
    });
  },

  /** 没有可用模板 ID 时的统一出口：把"下一步做什么"说清楚（用户主动点的，必须有反馈） */
  promptRemindConfig() {
    // 服务端给的 ready_reason 本身就是人话且指向下一步，能用就用它。
    // 【但要挑一下】只有在它确实在讲"模板没配"这件事时才用 —— 这一句会同时写进
    // 结果行，万一它是"已就绪：还能下发 2 条"（状态是旧的那种情况），
    // 弹出来就自相矛盾了。挑不出来就用本地那句（它一定指向 docs/到期提醒.md）。
    const serverReason = str(this.data.remindReadyReason);
    const usable = serverReason
      && (serverReason.indexOf('模板') > -1 || serverReason.indexOf(REMIND_TEMPLATE_ENV) > -1);
    const content = usable ? serverReason : REMIND_NO_TEMPLATE_TIP;
    this.setData({
      remindResultText: content,
      remindResultType: 'warn',
    });
    wx.showModal({
      title: '暂时不能开启到期提醒',
      content: content,
      showCancel: false,
      confirmText: '知道了',
    });
  },

  /**
   * 授权窗的返回。三种结果分开处理，**文案必须不一样**（用户下一步要做的事不同）。
   * @param {object} res wx.requestSubscribeMessage 的 success 参数
   */
  handleSubscribeResult(res) {
    const templateId = this.remindTemplateId;
    const answer = str(res && res[templateId]);

    if (answer === 'accept') {
      // ---- ③ 授权成功：上报 +1（count 恒为 1，见 onRemindEnable 的说明）----
      this.ackRemindAuthorized();
      return;
    }

    this.setData({ remindBusy: false });
    if (answer === 'reject') {
      // 用户当场拒绝：如实说清"不授权就收不到提醒"，但不责备、也不假装成功
      const text = '你拒绝了授权，可以不授权，但这样到期时就收不到微信提醒了。';
      this.setData({ remindResultText: text, remindResultType: 'warn' });
      wx.showToast({ title: '已拒绝授权，收不到提醒', icon: 'none' });
      return;
    }
    if (answer === 'ban') {
      // 之前拒过（或被后台关过）：只能去微信的订阅消息设置里自己打开
      const text = '你之前拒绝了订阅消息，需要到微信「设置 → 订阅消息」里把本小程序打开，再回来点一次。';
      this.setData({ remindResultText: text, remindResultType: 'warn' });
      wx.showToast({ title: '请在微信设置里打开订阅消息', icon: 'none' });
      return;
    }
    // 其它值（含空串）：如实说"没拿到结果"，不猜
    const unknown = `没有拿到授权结果（${answer || '空'}），请再点一次试试。`;
    this.setData({ remindResultText: unknown, remindResultType: 'warn' });
    wx.showToast({ title: '没有拿到授权结果，请再试一次', icon: 'none' });
  },

  /** 授权弹窗本身失败（不是用户拒绝，是调用失败）：errCode / errMsg 原样给出人话 */
  handleSubscribeFail(err) {
    const detail = subscribeErrorText(err);
    this.setData({
      remindBusy: false,
      remindResultText: `订阅授权没能弹出来：${detail}`,
      remindResultType: 'warn',
    });
    toastText(`订阅授权没能弹出来：${detail}`);
  },

  /**
   * 上报"用户刚授权了 1 次"。**count 恒为 1**：
   * 一次授权窗只勾一个模板位，报多了等于骗服务端（下发时必然 43101）。
   */
  ackRemindAuthorized() {
    remindAck(1).then((result) => {
      if (!result || result.ok !== true || !result.data || result.data.ok !== true) {
        throw new Error(describeError(result));
      }
      const patch = readRemindPatch(result);
      this.setData({
        remindBusy: false,
        remindResultText: patch.capped
          ? `已上报授权，但服务端额度已到上限（${patch.max_quota} 条），这次没有增加。`
          : '已增加 1 次提醒机会（一次性订阅：授权一次只能收到一条提醒）。',
        remindResultType: 'ok',
      });
      toastText(patch.capped ? '额度已达上限' : '已增加 1 次提醒机会');
      // 额度/开关都变了，重新读一次把卡片刷新成服务端的真值（silent：失败不再打扰）
      return this.loadRemindStatus({ silent: true });
    }).catch((err) => {
      // 【不能吞】授权成功了但上报失败 → 用户以为攒上了、其实服务端没有额度。
      // 必须如实告诉他"这次可能没记上，再点一次按钮"。
      const detail = describeError(err);
      this.setData({
        remindBusy: false,
        remindResultText: `授权成功，但上报失败：${detail}。这次机会可能没记上，请再点一次按钮重试。`,
        remindResultType: 'warn',
      });
      toastText(`上报失败：${detail}`);
    });
  },

  /**
   * 改提前量（picker）。只接受候选档位里的**下标**，非法输入**一个请求都不发** ——
   * 服务端的 config 是白名单校验，发了也是白跑一次网络。
   *
   * ===========================================================================
   * 【坑：不能直接对 picker 的值取 Number()】`Number(null)` 与 `Number('')` 都是 **0**，
   * 而 0 是一个**合法下标**（第一档）。于是"事件里没有 value"这种异常输入会被
   * 悄悄当成"用户选了 15 分钟"，把人家设好的提前量改掉 —— 用户没动过设置、
   * 值却自己变了，是最难查的一类 bug（这条是写单测时用探针抓出来的）。
   * 所以先把原始值**严格**校验成"确实是一个下标"（非空数字），再做范围检查。
   * ===========================================================================
   */
  onRemindLeadChange(event) {
    const options = this.data.remindLeadOptions || [];
    const index = toPickerIndex(event && event.detail ? event.detail.value : null);
    if (index === null || index >= options.length) {
      // 下标越界 / 类型不对（脏数据、事件异常）：什么都不做，更不许改当前值
      return;
    }
    this.applyRemindLead(options[index]);
  },

  /** 真正提交提前量 */
  applyRemindLead(leadMin) {
    const options = this.data.remindLeadOptions || [];
    const value = Number(leadMin);
    if (!Number.isFinite(value) || options.indexOf(value) === -1) return; // 非法值不发请求
    if (value === this.data.remindLeadMin) return; // 没变就不发（省一次请求，也不会闪一下）

    this.setData({ remindBusy: true, remindResultText: '', remindResultType: '' });
    remindConfig({ lead_min: value }).then((result) => {
      if (!result || result.ok !== true || !result.data || result.data.ok !== true) {
        throw new Error(describeError(result));
      }
      const patch = readRemindPatch(result);
      this.setData({ remindBusy: false });
      // 就地更新（服务端返回的 lead_min 才是准的）+ 用同一份数据重画提前量文案
      this.applyRemindLeadLocal(patch.lead_min || value);
      // 顺带把额度/ready 也对齐一次（config 的返回里带 quota）
      return this.loadRemindStatus({ silent: true }).then(() => {
        this.setData({
          remindResultText: `已改为${leadTextOf(patch.lead_min || value)}提醒。`,
          remindResultType: 'ok',
        });
        toastText('已保存提前量');
      });
    }).catch((err) => {
      this.setData({
        remindBusy: false,
        remindResultText: `修改提前量失败：${describeError(err)}`,
        remindResultType: 'warn',
      });
      toastText(`修改失败：${describeError(err)}`);
    });
  },

  /** 只改本地这几个字段（不重新读状态），用于"就地更新" */
  applyRemindLeadLocal(leadMin) {
    const options = this.data.remindLeadOptions || [];
    const value = Number(leadMin);
    const safe = options.indexOf(value) === -1 ? options[0] : value;
    this.setData({
      remindLeadMin: safe,
      remindLeadIndex: Math.max(options.indexOf(safe), 0),
      remindLeadText: leadTextOf(safe),
    });
  },

  /**
   * 发一条测试提醒。
   * 前置：模板已配 + 至少授权过 —— 缺任何一条，点了也是白发（云函数会拒或用户收不到）。
   * 结果如实显示，包括"这次没有消耗额度"（云函数默认 `quota_consumed:false`）。
   */
  onRemindTest() {
    if (this.data.remindBusy || this.data.remindLoading) return;
    if (this.data.remindConfigError) {
      this.promptRemindConfig();
      return;
    }
    if (!this.data.remindTestAvailable) {
      const text = `还没有授权过：请先点上方的「开启并授权 +1 次」，授权后微信才能给你发提醒。`;
      this.setData({ remindResultText: text, remindResultType: 'warn' });
      toastText('请先授权订阅消息');
      return;
    }

    const quotaBefore = this.data.remindQuota;
    this.setData({ remindBusy: true, remindResultText: '', remindResultType: '' });
    remindTest().then((result) => {
      if (!result || result.ok !== true || !result.data || result.data.ok !== true) {
        throw new Error(describeError(result));
      }
      const data = result.data;
      const consumed = data.quota_consumed === true;
      // 【如实说】服务端不一定回 quota_consumed 造成的差异：这里用"发之前的额度"对比
      // 服务端回的 quota，两边都对得上才敢说"没消耗额度"。
      const quotaAfter = Number(data.quota);
      let quotaText = '这次没有消耗可提醒次数。';
      if (consumed) {
        quotaText = Number.isFinite(quotaAfter)
          ? `这次消耗了 1 次额度（剩余 ${quotaAfter} 次）。`
          : '这次消耗了 1 次额度。';
      } else if (Number.isFinite(quotaAfter) && quotaAfter !== quotaBefore) {
        // 服务端说没消耗、额度却变了 → 不敢替它下结论，如实并列两个数字
        quotaText = `这次按"不消耗额度"下发，但额度从 ${quotaBefore} 变成了 ${quotaAfter}，以服务端为准。`;
      }
      this.setData({
        remindBusy: false,
        remindResultText: `测试提醒已发出（${quotaText}）请到微信「服务通知」里查看；没收到就看模板字段是否与微信后台一致。`,
        remindResultType: 'ok',
      });
      toastText('测试提醒已发出');
      return this.loadRemindStatus({ silent: true });
    }).catch((err) => {
      this.setData({
        remindBusy: false,
        remindResultText: `测试提醒发送失败：${describeError(err)}`,
        remindResultType: 'warn',
      });
      toastText(`测试失败：${describeError(err)}`);
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
      const { events, warnings, tasks, periodTimes } = payload;
      const preview = tasks.slice(0, 8).map((task) => ({
        title: str(task.title) || '(无标题)',
        dateText: formatDateCn(task.date),
        whenText: whenTextOf(task),
        typeLabel: TYPE_LABELS[str(task.type)] || '日程',
      }));

      // 【为什么要把 periodTimes 留住】导入时从课表里校准出来的上下课时间，
      // 是"这条时间落在第几节"的唯一依据。页面上只是预览，真正落库在导入成功之后
      // （见 doReplace / doAppend）—— 这样"解析成功但用户取消导入"不会留下脏作息。
      this.pendingTasks = tasks;
      this.pendingPeriodTimes = periodTimes || null;
      const calibratedCount = periodTimes ? Object.keys(periodTimes).length : 0;

      this.setData({
        pickedFileName: fileName,
        parsedCount: events.length,
        taskCount: tasks.length,
        warnings: warnings || [],
        previewItems: preview,
        previewMore: Math.max(tasks.length - preview.length, 0),
        pendingTasks: [],
        calibratedPeriodCount: calibratedCount,
        calibratedText: calibratedCount
          ? `并从文件里校准出 ${calibratedCount} 节上下课时间，导入成功后会一并保存`
          : '',
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
            // periodTimes 也一起带出来 —— 少了它，"课程时间与文件不符"这个 bug 就会回来：
            // 课表按默认作息把 12:00 当成午休空档，于是截止/子任务全落进「其他时段」。
            const periodTimes = (parsed && parsed.periodTimes) || null;
            finish(true, { events, warnings, tasks: tasks.slice(0, MAX_IMPORT), periodTimes });
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
   * 导入成功后，把本次校准出来的作息**增量**存回 settings。
   *
   * ===========================================================================
   * 【为什么必须存】这是"课程时间与导入文件不符"和"子任务/截止不出现在时间表里"
   * 两个真机问题的共同根因：导入时从 .ics 校准出的上下课时间（例如第 1 节
   * 08:30-09:10）只用在预览里，**没有落库**。于是课表页仍按内置默认作息
   * （第 1 节 08:00-08:45、11:40–14:00 是午休空档）去算"这个时间属于第几节"：
   *   * 12:00 的截止 → 默认作息里落在午休空档 → 定位不到 → 只能进「其他时段」；
   *   * 16:00-17:00 的子任务 → 默认算第 7 节，实际应为第 9 节。
   * ===========================================================================
   *
   * 【解耦】导入成功与作息保存成功是**两件事**：
   * 保存失败绝不能把"导入"说成失败（课程确实已经进库了），
   * 所以这里单独给一句文案，不抛给调用方、也不影响 importResultText。
   *
   * @param {boolean} importerOk 导入是否真的成功了（失败时本方法直接不做事）
   */
  saveCalibratedPeriods(importerOk) {
    if (!importerOk) return;

    const merged = mergePeriodTimes(this.periodTimes, this.pendingPeriodTimes);
    // 文件里没有可校准信息 → 不写库、不提示（用户没做这件事，别打扰他）
    if (!merged) {
      this.pendingPeriodTimes = null;
      this.setData({ periodSaveText: '', periodSaveFailed: false });
      return;
    }
    const count = Object.keys(this.pendingPeriodTimes || {}).length;

    api.saveSettings({ period_times: merged }).then((result) => {
      if (result && result.ok === false) throw new Error(describeError(result));
      // 服务端会把 period_times 归一化后回传，以**服务端返回的**为准（与学期日期同一口径）
      const saved = extractSettings(result);
      const finalTimes = saved.period_times || merged;
      this.periodTimes = finalTimes;
      this.pendingPeriodTimes = null;
      // 同步给 app.globalData（课表页读的就是它），并立刻重画本页作息表
      // —— renderPeriods 会用 calibrated 口径给这些节次打上「已校准」标记
      syncGlobalSettings({ ok: true, data: { period_times: finalTimes } });
      this.setData({
        periodSaveText: `并按导入课表校准了 ${count} 节作息`,
        periodSaveFailed: false,
      });
      this.renderPeriods();
    }).catch((err) => {
      // 【关键】导入已经成功了，这里只是附加信息 —— 不弹 toast 打断用户，
      // 也不改 importResultText，只在自己的那一行如实说明没存上。
      this.pendingPeriodTimes = null;
      this.setData({
        periodSaveText: `作息校准未保存（课程已导入）：${describeError(err)}`,
        periodSaveFailed: true,
      });
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
      // 【第二步】把本次校准的作息增量存回 settings —— 少了这一步，课表页会按
      // 默认作息去算"这些时间属于第几节"，用户的截止/子任务就会落错行或落进「其他时段」。
      this.saveCalibratedPeriods(true);
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
      // 【第二步】与替换路径同款：把校准作息增量存回 settings。
      // 追加路径同样需要它 —— 用户第二次导入时往往是追加，不存作息一样会落错行。
      this.saveCalibratedPeriods(true);
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

  /**
   * 只给纯 node 单测用的探针（utils/tests/remind_page.test.js）。
   *
   * 【为什么放在 Page 对象上】这样测试断言的就是**页面真正在用的那份实现**，
   * 不会出现"测的是一份、跑的是另一份"。小程序框架只会调用它认识的生命周期与事件
   * 方法（onLoad/onShow/onXxx），这个下划线开头的键永远不会被触发。
   */
  __test: {
    // 到期提醒
    normalizeLeadOptions: normalizeLeadOptions,
    describeLeadMinutes: describeLeadMinutes,
    leadTextOf: leadTextOf,
    toPickerIndex: toPickerIndex,
    readRemindStatus: readRemindStatus,
    readRemindPatch: readRemindPatch,
    subscribeErrorText: subscribeErrorText,
    REMIND_FUNCTION: REMIND_FUNCTION,
    REMIND_DOC: REMIND_DOC,
    REMIND_NO_TEMPLATE_TIP: REMIND_NO_TEMPLATE_TIP,
    FALLBACK_LEAD_OPTIONS: FALLBACK_LEAD_OPTIONS,
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

/**
 * 把 picker 事件里的值严格解析成**下标**：合法的非负整数返回它，其余一律返回 null。
 *
 * 【为什么不用 Number()】`Number(null)` / `Number('')` / `Number([])` 全都是 **0**，
 * 而 0 是合法下标 —— 用 Number 就会把"事件里根本没有 value"变成"用户选了第一档"。
 * 所以这里只认"非空数字"这一种输入（picker 给的就是字符串或数字）。
 *
 * @param {*} value `event.detail.value`
 * @returns {number|null}
 */
function toPickerIndex(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
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

/**
 * 弹一句短提示。toast 太长会被截断成省略号（还占不满一行就很难看），
 * 所以**完整句子一律写在卡片的结果行上**，toast 只给一句短的。
 */
function toastText(message) {
  let text = str(message) || '操作失败，请稍后重试';
  if (text.length > MAX_TOAST_CHARS) text = `${text.slice(0, MAX_TOAST_CHARS)}…`;
  wx.showToast({ title: text, icon: 'none', duration: 2200 });
}

/**
 * `wx.requestSubscribeMessage` 的 fail 回调 → 人话。
 *
 * 【为什么不自己翻译 errCode】微信这一路的错误码没有稳定公开的语义表，
 * 猜错一个码就会给用户指错方向。所以**原样带上 errMsg（和 errCode）**，
 * 顶多加一句"请再试一次"这种我们真的知道的事。
 * 最常见的两种真实原因是：没在真机上跑（开发者工具不支持）、基础库版本过低。
 */
function subscribeErrorText(err) {
  const code = str(err && err.errCode);
  const message = str(err && err.errMsg) || str(err && err.message) || '未知原因';
  return code ? `${message}（errCode ${code}）` : message;
}

/**
 * 到期提醒那几个纯函数也导出一份给单测（utils/tests/remind_page.test.js）。
 *
 * 【为什么页面文件也写 module.exports】小程序运行时会 `require` 页面文件、调用它里面的
 * `Page()`；多一个 `module.exports` 赋值对运行时**没有任何影响**（框架不读它）。
 * 而 `const REMIND_FUNCTION = ...` 这些是模块作用域的东西，只有导出才能被 node 单测拿到 ——
 * 测的仍然是页面**真正在用的那份实现**，不是测试里另抄一遍。
 */
module.exports = {
  __test: {
    normalizeLeadOptions: normalizeLeadOptions,
    describeLeadMinutes: describeLeadMinutes,
    leadTextOf: leadTextOf,
    readRemindStatus: readRemindStatus,
    readRemindPatch: readRemindPatch,
    subscribeErrorText: subscribeErrorText,
    REMIND_FUNCTION: REMIND_FUNCTION,
    REMIND_DOC: REMIND_DOC,
    REMIND_NO_TEMPLATE_TIP: REMIND_NO_TEMPLATE_TIP,
    FALLBACK_LEAD_OPTIONS: FALLBACK_LEAD_OPTIONS,
  },
};
