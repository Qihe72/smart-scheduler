/**
 * pages/me/me.js —— 「我的」页：学期设置 / 节次作息 / 导入课表 / 导出备份 / 关于。
 *
 * ===========================================================================
 * 【这一页的设计原则：每一项要么真能用，要么明说"暂不支持"】
 * ===========================================================================
 *   评审最反感的不是功能少，而是"点了没反应"。所以：
 *     1. 学期设置      → 真能改（picker 选日期 → settings_save）
 *     2. 节次作息      → 显示 + **可补录**：未校准的节次（当前显示内置默认时间）
 *                          可以「设定时间」自己补上，已校准的可以「修改 / 清除」。
 *                          真机上用户问"第6节应该是 13:30-14:10，为什么显示 14:55-15:40"——
 *                          因为他课表里第 6 节没有课，自动校准推不出时间，退回了默认作息。
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
// 三点六（静默补额度 / 一次补齐 / 写进手机系统日历）的实现都在这个模块里：
// 它只封装 wx 能力、不碰网络，所以能独立单测（utils/tests/subscribe.test.js）。
const subscribe = require('../../utils/subscribe.js');

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

// ---------------------------------------------------------------------------
// utils/timetable.js 是「从教务系统导入」用的解析器（同样按可选依赖处理）
// ---------------------------------------------------------------------------
let timetable = null;
let timetableLoadError = '';
try {
  // eslint-disable-next-line global-require
  timetable = require('../../utils/timetable.js');
} catch (err) {
  timetable = null;
  timetableLoadError = (err && err.message) || String(err);
}

/** 课表解析器可用吗（模块在 + 两个函数都导出了） */
function timetableReady() {
  return !!(timetable
    && typeof timetable.parseTimetable === 'function'
    && typeof timetable.toTasks === 'function');
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
  zhipu: {
    label: '智谱 GLM',
    hint: '免费档 glm-4.7-flash',
    keyUrl: 'https://open.bigmodel.cn',
    keyUrlLabel: '智谱开放平台',
    keyShape: '智谱的 Key 形如「32 位十六进制.16 位」',
  },
  deepseek: {
    label: 'DeepSeek',
    // 【模型名以各家官方文档为准】DeepSeek 的 `deepseek-chat` / `deepseek-reasoner`
    // 自 **2026-07-24 起停止服务**，现在的模型是 `deepseek-flash`（V4.1-Flash）。
    // 顺带把"这家也能识图"写进 hint —— 用户问过"识图必须换智谱吗"，
    // 让他一眼就能在这一格看出 DeepSeek 也是原生多模态。
    hint: '备选，deepseek-flash（V4.1-Flash，原生多模态、自带识图）',
    keyUrl: 'https://platform.deepseek.com',
    keyUrlLabel: 'DeepSeek 开放平台',
    keyShape: 'DeepSeek 的 Key 以 sk- 开头',
  },
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
    keyUrlLabel: meta.keyUrlLabel || value,
    keyShape: meta.keyShape || '',
  };
});

/**
 * 各服务商的默认模型。
 * 【为什么本地还有一份】api.js 的 AI_DEFAULT_MODELS **没有导出**，而页面需要
 * "用户没填时我该提示他会用哪个模型"。这里只用于**展示**；
 * 真正决定用哪个模型的是云函数（用户填了就用用户的，否则用该服务商默认）。
 * 与 api.js 的 AI_DEFAULT_MODELS 必须保持一致（测试里有断言对账）。
 *
 * ⚠️ **模型名会变，以各家官方文档为准**：DeepSeek 的 `deepseek-chat` /
 * `deepseek-reasoner` 自 2026-07-24 起**停止服务**，现在是 `deepseek-flash`。
 * 这一格正是用户抱怨"模型不对"的那一格 —— 显示一个已停服的名字会让他更迷惑。
 */
const AI_DEFAULT_MODEL = { zhipu: 'glm-4.7-flash', deepseek: 'deepseek-flash' };

/** 模型名长度上限：与 utils/api.js 的 MAX_MODEL_CHARS 一致（那边没导出，这里对账） */
const MAX_MODEL_CHARS = 60;

/**
 * 从 Key 的**形状**猜它是哪家的（纯本地判断，绝不发请求、绝不联网校验）。
 *
 *   * `sk-` 开头 → 像 DeepSeek；
 *   * `32位十六进制.16位十六进制` → 像智谱（形如 <32 位十六进制>.<16 位字母数字>）。
 *
 * 【为什么这里不写一个"像真的"示例】早先这行写了一个满足该形状的示例串，结果被仓库的
 * 密钥扫描判成"硬编码 API Key"，静态验收直接红。**示例要写成占位符形状**，
 * 否则既误导读者、又让扫描器报警（一条总在响的警报等于没有警报）。
 * 认不出来返回空串 —— **认不出就不提示**，绝不瞎猜（瞎猜会让用户改错服务商）。
 *
 * @param {string} key 用户刚粘贴的 Key
 * @returns {string} 'zhipu' | 'deepseek' | ''
 */
function detectKeyProvider(key) {
  const text = str(key);
  if (!text) return '';
  if (/^sk-/i.test(text)) return 'deepseek';
  if (/^[0-9a-f]{32}\.[0-9a-f]{16}$/i.test(text)) return 'zhipu';
  return '';
}

/**
 * Key 形状与**当前选中的服务商**是否对不上。
 *
 * 【为什么这条提示很要紧】服务商与 Key 必须来自同一家，否则请求一定失败
 * （服务端会报身份验证失败）。真机上用户就是这么踩的：他粘了 DeepSeek 的 Key，
 * 但下拉框默认停在智谱，于是服务端按 zhipu 解析、界面显示"智谱 + glm-4.7-flash"，
 * 而用户手里明明是 DeepSeek 的 Key —— 他只会觉得"这软件坏了"。
 *
 * 【只提示，不静默切换】服务商是用户的配置，静默改掉比让他自己点一下更糟。
 * 所以这里只返回"该切到哪家"，由用户点按钮确认。
 *
 * @param {string} key 输入框里的 Key
 * @param {string} provider 当前选中的服务商
 * @returns {{detected: string, mismatch: boolean, fixIndex: number, message: string}}
 */
function keyProviderHint(key, provider) {
  const detected = detectKeyProvider(key);
  const current = str(provider);
  const result = { detected, mismatch: false, fixIndex: -1, message: '' };
  // 认不出形状、或本来就没有 Key → 不提示
  if (!detected) return result;
  // 形状与所选服务商一致 → 不提示
  if (detected === current) return result;

  const detectedMeta = AI_PROVIDER_LABELS[detected] || {};
  const currentMeta = AI_PROVIDER_LABELS[current] || {};
  result.mismatch = true;
  result.fixIndex = indexOfProvider(detected);
  result.message = `你填的 Key 看起来是 ${detectedMeta.label || detected} 的`
    + `（${detectedMeta.keyShape || '形状'}），但上面选的服务商是 `
    + `${currentMeta.label || current || '(未选)'} —— 两者必须一致，否则会报身份验证失败。`;
  return result;
}

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

// ---------------------------------------------------------------------------
// 联系与反馈
// ---------------------------------------------------------------------------
/**
 * 联系方式。**只有这一份**：页面的 data 与"复制"都从这里取，改一处就够。
 *
 * 【改这里之后记得同步 README 的「联系与反馈」一节】那份是给 GitHub 访客看的，
 * 与小程序里显示的应当是同一组号。
 */
const CONTACTS = {
  wechat: '19333181312',
  email: '839933831@qq.com',
};

/** 取联系方式；认不出的 kind 一律给微信号（页面上只有这两种） */
function contactOf(kind) {
  return str(kind) === 'email' ? CONTACTS.email : CONTACTS.wechat;
}

/**
 * 反馈模板：把"定位问题真正需要的"信息列成空位。
 *
 * 【为什么值得单独做一个按钮】用户报一句"它坏了"几乎没法定位；而这个项目里最费时的
 * 恰恰是复现（真机、机型、微信版本、点了几步才出问题）。把这几项列成空位，用户填两行
 * 就够我查了 —— 空着也比只写一句描述强。
 */
const FEEDBACK_TEMPLATE = [
  '【问题 / 建议】',
  '（一句话说清：哪里不对，或者你想要什么）',
  '',
  '【复现步骤】',
  '1. ',
  '2. ',
  '',
  '【期望结果】',
  '',
  '【实际结果】',
  '',
  '【我的环境】',
  '手机型号：',
  '微信版本：',
  '操作路径（在小程序里点了哪几个页面 / 按钮）：',
].join('\n');

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
 * 这一节的作息是不是**恰好等于程序内置的默认作息**（别的学校那份样板）。
 *
 * @param {number|string} number 节次号
 * @param {*} value 作息值 ["08:00","08:45"]（或脏数据）
 * @returns {boolean} true = 与内置默认完全相同（没有信息量）
 */
function isBuiltinDefault(number, value) {
  if (!Array.isArray(value) || value.length !== 2) return false;
  if (!periods || !periods.PERIOD_TIMES) return false;
  const builtin = periods.PERIOD_TIMES[Number(number)];
  if (!Array.isArray(builtin) || builtin.length !== 2) return false;
  return String(value[0]) === String(builtin[0]) && String(value[1]) === String(builtin[1]);
}

/**
 * 合并作息表：**新导入的节次覆盖同名节次，未涉及的节次保留原值**。
 *
 * 合并基准必须是"当前生效的作息"（页面里的 this.periodTimes，来自 settings），
 * **不是空对象** —— 否则一次只校准了几节课的导入会把其它节次的作息抹掉。
 * 这条语义与 Web 版一致（那边也是往 settings 里增量 upsert）。
 *
 * ===========================================================================
 * 【防御：基准里"与内置默认完全相同"的项**不搬进结果**】
 * ===========================================================================
 *   真机上挖出来的一个会**污染每一个新用户**的链条（逐处核过）：
 *     1. 云函数 settings_get 在 period_times 为空时**回填内置默认表**（13 节，
 *        含"第6节 14:55-15:40"）；
 *     2. 本页 onLoad 把它当成"当前作息"读进 this.periodTimes；
 *     3. 用户导入 .ics → 走到这里，基准 = 那 13 节**默认值**；
 *     4. 合并时把它们原样搬进结果 → 云上真的存了 13 节，
 *        于是**第6节 = 默认的 14:55-15:40 被标成「已校准」**；
 *        更糟的是"第6节存在" → 判据不再为它生成空档行 → **午休行永远不出现**。
 *   ⇒ 判据：某项的值等于内置默认值，就视为"没有信息量"，丢掉。两条理由：
 *     * 它要么是**服务端回填出来的假校准**（上面这条 bug）；
 *     * 要么是**用户真实作息恰好等于默认**（例如他学校第 3 节真的就是 10:00-10:45）——
 *       丢掉**行为上无差别**：显示的时间一模一样，校不校准都长那样。
 *   副作用是好的：这条防御能**自动修复已经被污染的数据** ——
 *     用户下次导入时，那个假的第6节会被丢掉，午休行随之回来。
 *
 *   【为什么必须用 periods 的常量来比】默认作息是 utils/periods.js 从 config.py
 *     抄过来的（PERIOD_TIMES）。本文件再抄一份，两边迟早不同步 ——
 *     那时这条防御会静默失效（既不报错、也不红），比没有更糟。
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
  const incomingKeys = {};
  keys.forEach((key) => { incomingKeys[key] = true; });

  // 先铺原有的：**与内置默认完全相同的项不搬**（除非这次导入恰好要覆盖它 ——
  // 那种情况下下面的 keys.forEach 会把它带进来，覆盖优先于这条防御）
  Object.keys(baseObj).forEach((key) => {
    if (incomingKeys[key]) return;                       // 交给下一段覆盖
    if (isBuiltinDefault(key, baseObj[key])) return;     // 服务端回填的假校准 / 等于默认的真实值
    merged[key] = baseObj[key];
  });
  // 再用新的覆盖同名项（文件里真的出现了的节次，永远以它为准）
  keys.forEach((key) => { merged[key] = nextObj[key]; });
  return merged;
}

/**
 * 这一节是不是**未校准**（当前显示的是内置默认时间，不是用户课表里的时间）。
 *
 * ===========================================================================
 * 【为什么这件事必须有一个口径】真机上用户看到「第6节 14:55-15:40」并问
 *   "第6节应该是 13:30-14:10，不知道为什么显示的是 14:55-15:40" ——
 *   因为他的课表里**第 6 节没有课**（文件里就没有排在 13:30 的那一节），
 *   自动校准推不出它的时间，于是退回了程序内置的默认作息。
 *   这一行必须被**明确标成"不是你课表里的时间"**，否则用户会以为程序算错了。
 * ===========================================================================
 *
 * 【入参是标准行，不是本页的视图模型】
 *   periods.isUncalibratedRow(row, override) 内部用 `Array.isArray(row)` 挡了一道，
 *   传视图模型（对象）进去它一律返回 false —— 那样每一行都会被当成"已校准"，
 *   补录入口就全没了。所以这里收**标准行**（periodRows 返回的那个数组）。
 *
 * 【判据已冻结】utils/periods.js 里那个函数的注释写明：界面的补录入口按它判断，
 *   **函数名与语义已冻结**。它对合成空档行（['break','12:25','13:30']）返回 false
 *   —— 它不是节次，没什么可补录的；对缺号的节次行（第 6 节那种「午休」）返回 true。
 *
 * 【typeof 守卫 + 兜底】接口不在（旧版 utils）时退回本地口径：
 *   **有节次号、且 override 里没有它 = 未校准**。这与上面那个函数的核心判据一致，
 *   只是少了"合成行"这一条 —— 而合成行由 rowIsBreak / editable 另外挡住。
 *
 * @param {Array} row 标准行（periods.periodRows() 的一项）
 * @param {object|null} override 校准过的作息 {"6": ["13:30","14:10"], ...}
 * @returns {boolean}
 */
function isUncalibrated(row, override) {
  if (periods && typeof periods.isUncalibratedRow === 'function') {
    try {
      return !!periods.isUncalibratedRow(row, override);
    } catch (err) {
      console.warn('[me] periods.isUncalibratedRow 异常，退回本地判据：', err);
    }
  }
  const number = rowNumberOf(row);
  if (number === null) return false;   // 合成空档行 / 脏行：不是节次，谈不上未校准
  return !(override && typeof override === 'object'
    && Object.prototype.hasOwnProperty.call(override, String(number)));
}

/**
 * 一行（**标准行**）的节次号：节次行 `[7]` → 7；合成空档行 `['break',…]` → null。
 *
 * 【为什么必须用它而不是读 row[0]】行有两种（见 periods.js 的注释）：
 * 合成行的 row[0] 是字符串 `'break'` —— 直接 `String(row[0])` 会得到键名 "break"、
 * `toInt` 会得到 null，于是所有"按节次号"的判断全都不成立。
 * 统计"到底有几节"、以及判断"这一行能不能补录"，都必须先过这一道。
 */
function rowNumberOf(row) {
  // 【先挡住 null / 非数组】utils/periods.js 的 rowPeriodNumber 内部只用
  // `Array.isArray(row) ? ...` 判了"不是数组就 false"这一半，**null 会一路走到 row[0]**
  // 并抛 TypeError（`Cannot read properties of null`）。本页的行来自计算，
  // 理论上不会脏，但"理论上不会"在这个仓库里已经出过太多次事了 —— 所以自己先挡一道。
  if (!Array.isArray(row) || !row.length) return null;
  if (periods && typeof periods.rowPeriodNumber === 'function') {
    return periods.rowPeriodNumber(row);
  }
  // 兜底：拿不到那个函数时自己判（只认正整数节次号）
  const number = Number(row[0]);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * 这一行是不是**空档行**（两种都算：缺号夹出来的「午休」节次行、合成空档行）。
 *
 * 【为什么不能自己用 breakLabel(row[0]) 判】合成空档行的 row[0] 是 `'break'`，
 * `breakLabel('break')` 返回空串 → **这一行不会被标成空档**，底色与样式全失效。
 * 所以统一用 periods.isBreakRow(row, override)（同事点名提醒过这条）。
 */
function rowIsBreak(row, override) {
  if (periods && typeof periods.isBreakRow === 'function') {
    try {
      return !!periods.isBreakRow(row, override);
    } catch (err) {
      console.warn('[me] periods.isBreakRow 异常，退回 breakLabel 判据：', err);
    }
  }
  const number = rowNumberOf(row);
  return number === null ? true : !!periods.breakLabel(number, override);
}

/**
 * 补录一节作息要提交的**增量**：`{ '6': ['13:30','14:10'] }`。
 *
 * 为什么返回"只含这一节"的对象、再交给 mergePeriodTimes 去合并：
 * 保存路径上**只能有一个合并实现**（就是导入那条路用的那个），
 * 否则"补录"和"导入"迟早会在"其它节次保不保留"上给出不同答案。
 *
 * @returns {{ok: boolean, patch: object|null, error: string}}
 */
function periodRowPatch(number, start, end) {
  const key = String(number);
  const from = str(start);
  const to = str(end);
  // 【必须两个都给】一节有起无止（或反过来）算不出它占哪段时间，
  // 课表页会退化成"用结束时刻吸附"，用户看到的仍是一个他自己都没确认过的时间。
  if (!from || !to) {
    return { ok: false, patch: null, error: '开始和结束时间都要填（一节必须有起止）' };
  }
  if (periods && typeof periods.toMinutes === 'function'
    && periods.toMinutes(from) !== null && periods.toMinutes(to) !== null
    && periods.toMinutes(to) <= periods.toMinutes(from)) {
    return { ok: false, patch: null, error: `结束时间要晚于开始时间（现在是 ${from}-${to}）` };
  }
  const patch = {};
  patch[key] = [from, to];
  return { ok: true, patch: patch, error: '' };
}

/**
 * 从作息表里**删掉**一个节次（其余原样保留）—— 给「清除」用。
 *
 * 返回的是完整的新作息（不是增量）：清除的语义是"这一节回到未校准"，
 * 只有把 key 真的去掉才算数。
 *
 * @param {object|null} base 当前作息
 * @param {number|string} number 要清掉的节次号
 * @returns {{times: object, removed: boolean}} times 可能为空对象（全清光）
 */
function dropPeriodKey(base, number) {
  const key = String(number);
  const source = (base && typeof base === 'object') ? base : {};
  const next = {};
  Object.keys(source).forEach((item) => {
    if (item !== key) next[item] = source[item];
  });
  // 【removed 的判据是"原来真的有这个键"】不是"删完少了一个" ——
  // 要清的那一节本来就没校准过时，删了等于没删，界面不该说"已清除"。
  return { times: next, removed: Object.prototype.hasOwnProperty.call(source, key) };
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

    // --- 二、节次作息（可补录） ---
    //     每一行：{ key, number, label, timeText, isBreak, calibrated, uncalibrated, actionText }
    //     * calibrated   = 已校准（来自导入识别或用户补录）
    //     * uncalibrated = 显示的是内置默认时间 → 界面要给「设定时间」入口
    periodRows: [],
    periodSourceText: '',       // 「当前使用默认作息（第 1~13 节）」等
    periodOverrideText: '',     // 「其中 3 节是导入课表时校准过的」
    periodGapHint: '课表里两节之间空得比较久时（例如中午 12:25 到 13:30），'
      + '会自动显示成一行「午休」；短于 45 分钟的只是课间，不占行。',
    // --- 补录弹层（选开始/结束时间） ---
    periodEditVisible: false,
    periodEditIndex: -1,        // 正在编辑的 periodRows 下标；-1 = 没有
    periodEditLabel: '',
    periodEditStart: '08:00',
    periodEditEnd: '08:45',
    periodEditError: '',        // 本地校验或保存失败的人话
    periodSaving: false,
    // 保存成功/失败的一句话结果（显示在作息卡片里，与导入那条路分开）
    periodSaveText: '',
    periodSaveFailed: false,

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
    aiModel: '',                // **当前生效**的模型名（服务端返回值，只读展示）
    // --- 模型输入（用户真机抱怨"模型改不了"：以前只有一个只读的"模型：X"，
    //     后端其实一直支持自选模型，缺的就是这一格） ---
    aiModelInput: '',           // 用户填的模型名；留空 = 不改（保存时不带 model 字段）
    aiModelPlaceholder: '留空 = 用该服务商的默认模型',
    aiModelHint: '',            // 该服务商的默认模型是什么（帮用户决定要不要填）
    aiModelAliasHint: '',       // 「你填的是宣传名，API 里的名字是 X」——纯提示，不改用户输入
    // --- Key 形状识别（纯本地，不发请求） ---
    aiKeyShapeHint: '',         // 形状与服务商不一致时的黄字提醒；一致/认不出时为空
    aiKeyShapeFixIndex: -1,     // 「切到 X」按钮要切到哪个下标；-1 = 不显示按钮
    aiKeyShapeFixLabel: '',
    aiHasKey: false,            // 用户是否填过自己的 Key
    aiMasked: '',               // 服务端返回的掩码，例如 ****abcd
    aiStatusText: '',           // 「正在使用你自己填的 Key（****abcd）」等
    aiStatusType: '',           // '' | 'own' | 'preset' | 'none'
    aiStatusDetail: '',         // 「服务商：智谱 · 模型：glm-4.7-flash」这一行
    aiResultText: '',           // 保存/清除的结果提示
    aiKeyUrl: AI_PROVIDERS[0].keyUrl,
    aiProviderHint: AI_PROVIDERS[0].hint,
    aiKeyUrlLabel: AI_PROVIDERS[0].keyUrlLabel || '智谱开放平台',
    aiDefaultModelText: '',     // 「该服务商的默认模型：glm-4.7-flash」

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

    // --- 三点六、"别让我一个个点"（utils/subscribe.js） ---
    remindSilentAllowed: false, // 用户勾过「总是保持以上选择，不再询问」→ 再调用不弹窗，可静默补额度
    remindSilentText: '',       // 上面这件事的说明（已开启自动补充 / 怎么勾才能免打扰）
    remindTopUpLabel: '',       // 按钮文案：「一次补齐 3 次」/「补充 1 次（不会弹窗）」
    remindTopUpBusy: false,     // 正在连弹授权窗（防连点）
    remindCalBusy: false,       // 正在写手机系统日历
    remindCalText: '',          // 写日历的结果：成功几条 + 其余几条为什么没写

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
    // 【作息保存这一路的结果只有一份】补录（上面的卡片）与导入后的自动校准（下面这一步）
    // 都写这两个字段 —— 它们是"作息有没有存上"的同一件事，分成两份只会让界面自相矛盾。
    // periodSaveText / periodSaveFailed 在「二、节次作息」的 data 里已经声明过了。
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

    // --- 联系与反馈（值取自 CONTACTS，不在这里再抄一遍） ---
    contactWechat: CONTACTS.wechat,
    contactEmail: CONTACTS.email,
    contactResultText: '',      // 「已复制…」/「复制失败…」如实写在这里
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
   * 作息表。
   * 用 periods.periodRows + rowLabel + rowTimeRange，与课表页**同一套口径**，
   * 所以这里看到的「午休」和课表左侧那一行一定是同一个东西。
   *
   * 【列表里有两种行 —— 这是本页最容易搞错的地方】
   *   * **节次行** `[7]`：有节次号，可以补录；
   *   * **合成空档行** `['break','12:25','13:30']`：periods.js 在"相邻两行之间空隙
   *     ≥ 45 分钟"时插进来的，**没有节次号**（rowPeriodNumber → null）。
   *     它出现在这份作息表里是**有意的** —— 用户看得到"这里插了一行"是好事
   *     （这正是同事在课表里做的那件事）。但它不给补录按钮：它不是节次，
   *     period_times 里也没有它的键（键必须是节次号），保存无处可存。
   *   ⚠️ 所以**任何"按 row[0] 当节次号"的写法都是错的**（合成行的 row[0] 是字符串
   *     `'break'`：breakLabel 返回空串 → 空档样式失效；String(row[0]) 会得到键名
   *     "break" → 统计与判据全歪）。统一走 rowNumberOf / rowIsBreak 两个包装。
   *
   * 【每一行的视图模型】
   *   * `uncalibrated`：显示的是**内置默认时间**，不是用户课表里的时间
   *     （真机那条「第6节 14:55-15:40」就是这个情形：他课表里第 6 节没有课，
   *      自动校准推不出来，于是回落默认作息）。界面据此给「设定时间」入口。
   *   * `isBreak`：走 periods.isBreakRow，**两种空档行都认**。
   *   * `editable`：有节次号才可编辑。
   *   * `actionText`：按钮文案（未校准 = 设定时间，已校准 = 修改，空档行 = 空）。
   */
  renderPeriods() {
    const override = this.periodTimes;
    const rows = periods.periodRows(override);
    const list = rows.map((row) => {
      const number = rowNumberOf(row);            // ⚠️ 不是 row[0]（见上）
      const rowRange = periods.rowTimeRange(row, override) || ['', ''];
      const isGapRow = number === null;           // 合成空档行 / 脏行
      const uncalibrated = isUncalibrated(row, override);
      const calibrated = !isGapRow && !!override
        && Object.prototype.hasOwnProperty.call(override, String(number));
      // 【未校准的行要显示**这一节自己的默认时间**，而不是行上那个推出来的时间】
      // 真机上用户看到的是「午休 12:25-14:15」—— 那是左右两节夹出来的推断值，
      // 看着挺合理，于是他根本不会想到"第 6 节其实是 14:55-15:40 的默认值"。
      // 而他真正要报的是「第 6 节应该是 13:30-14:10，为什么显示 14:55-15:40」。
      // 所以这里改成显示 periodTimeRange(number) = 内置默认时间，
      // 「未校准」+「设定时间」就是给这一格的解释与出口。
      // （合成空档行不走这一支：它的区间是 periodRows 直接给的 12:25-13:30。）
      const range = uncalibrated
        ? (periods.periodTimeRange(number, override) || rowRange)
        : rowRange;
      return {
        key: periods.rowKey ? periods.rowKey(row) : String(number),
        number: number,
        label: periods.rowLabel(row, override) || (isGapRow ? '空档' : `第${number}节`),
        timeText: range[0] && range[1] ? `${range[0]}-${range[1]}` : (range[0] || range[1] || '—'),
        // 【不能用 breakLabel(number)】合成空档行的 number 是 null → 那一行不会被
        // 标成空档、底色与样式全失效。rowIsBreak 把两种空档行都认下来。
        isBreak: rowIsBreak(row, override),
        isGapRow: isGapRow,
        editable: !isGapRow,
        calibrated: calibrated,
        uncalibrated: uncalibrated,
        actionText: isGapRow ? '' : (uncalibrated ? '设定时间' : '修改'),
      };
    });

    // -------------------------------------------------------------------------
    // 统计口径：**只数节次行**（合成空档行不是一节，不能算进"共 N 节"里）
    //
    // 以前这里写的是 `calibratedCount === list.length` —— 那个等式在合成空档行
    // 出现之后永远不成立（列表里多了不属于任何节次的行），
    // 而且 `list.length` 也不再等于节数（缺号时 13、补录满 15）。
    // 所以分母改成 periodCount（走 rowNumberOf 过滤），文案里的 N 自然就对了。
    // -------------------------------------------------------------------------
    const periodRows = list.filter((item) => !item.isGapRow);
    const periodCount = periodRows.length;
    const calibratedCount = periodRows.filter((item) => item.calibrated).length;
    const uncalibratedCount = periodRows.filter((item) => item.uncalibrated).length;
    let sourceText = '';
    if (!override || !Object.keys(override).length) {
      sourceText = `当前使用内置默认作息（第 1~${periodCount} 节）`;
    } else if (calibratedCount === periodCount) {
      sourceText = `当前作息全部来自导入课表时的自动校准（共 ${periodCount} 节）`;
    } else {
      sourceText = `当前作息 = 默认作息 + 已校准的 ${calibratedCount} 节`
        + `（共 ${periodCount} 节）`;
    }

    const parts = [];
    if (calibratedCount) {
      parts.push(`带「已校准」标记的 ${calibratedCount} 节来自导入识别或你手动设定的时间。`);
    }
    if (uncalibratedCount) {
      // 【这句话必须说清"错在哪"】用户的原话是"第6节应该是 13:30-14:10，
      // 不知道为什么显示的是 14:55-15:40"。答案就是：这一节他课表里没有课，
      // 程序推不出时间，显示的是内置默认值 —— 不是算错，是**没有依据**。
      parts.push(`带「未校准」标记的 ${uncalibratedCount} 节显示的是内置默认时间，`
        + '不是你课表里的时间 —— 点「设定时间」可以补上。');
    }
    if (periodCount < list.length) {
      // 合成空档行是**有意的**：两节之间空得久（≥45 分钟）就在这里插一行，
      // 与课表页左侧那一行是同一个东西。说一句，免得用户以为列表出错了。
      parts.push('列表里的「休息 / 午休」空档行是按两节之间的时间空隙自动插的，'
        + '不是课程，也不用填。');
    }

    this.setData({
      periodRows: list,
      periodSourceText: sourceText,
      periodOverrideText: parts.join(''),
    });
  },

  // -------------------------------------------------------------------------
  // 补录作息（未校准的节次可以自己设定时间）
  // -------------------------------------------------------------------------

  /** 把某一行的下标翻译成可编辑的上下文；下标不合法返回 null（脏事件不许崩） */
  readPeriodRow(index) {
    const list = this.data.periodRows || [];
    const idx = Number(index);
    if (!Number.isFinite(idx) || idx < 0 || idx >= list.length) return null;
    const row = list[idx];
    if (!row) return null;
    if (row.editable === false) return null;   // 空档行没有节次号，不能编辑
    const override = this.periodTimes || {};
    const saved = override[String(row.number)];
    // 弹层初值一律用**当前显示的时间**（未校准行 = 内置默认时间，已校准行 = 校准值）：
    // 用户看到 14:55-15:40 却要在弹层里看到一个不一样的值，那是最容易填错的组合。
    return {
      index: idx,
      row: row,
      number: row.number,
      label: row.label,
      start: Array.isArray(saved) && saved[0] ? String(saved[0]) : firstTime(row.timeText),
      end: Array.isArray(saved) && saved[1] ? String(saved[1]) : secondTime(row.timeText),
    };
  },

  /** 点「设定时间 / 修改」→ 打开弹层（纯本地，不发请求） */
  onTapPeriodSet(event) {
    const index = event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.index
      : -1;
    const ctx = this.readPeriodRow(index);
    if (!ctx) {
      wx.showToast({ title: '这一行读不出来，请下拉刷新', icon: 'none' });
      return;
    }
    this.setData({
      periodEditVisible: true,
      periodEditIndex: ctx.index,
      periodEditLabel: ctx.label,
      periodEditStart: ctx.start,
      periodEditEnd: ctx.end,
      periodEditError: '',
    });
  },

  /** 已校准的行也走同一个入口（文案叫「修改」，行为一致） */
  onTapPeriodEdit(event) {
    this.onTapPeriodSet(event);
  },

  onPeriodStartChange(event) {
    this.setData({ periodEditStart: str(event && event.detail && event.detail.value) });
  },

  onPeriodEndChange(event) {
    this.setData({ periodEditEnd: str(event && event.detail && event.detail.value) });
  },

  onTapPeriodCancel() {
    if (this.data.periodSaving) return;   // 保存中不给关（避免"关了却存进去了"的错觉）
    this.setData({ periodEditVisible: false, periodEditError: '' });
  },

  /** 空处理器：弹层面板上的 catchtap 用它挡住冒泡（点面板内部不关窗） */
  onNoop() {},

  /**
   * 保存这一节的时间（**未校准的补录**与**已校准的修改**是同一条路）。
   *
   * 合并语义与导入**完全一致**：只把这一节塞进 mergePeriodTimes 的增量里，
   * 其余节次原值保留（单个节次的补录就是"只改一个 key"）。
   */
  onTapPeriodSave() {
    if (this.data.periodSaving) return;
    const ctx = this.readPeriodRow(this.data.periodEditIndex);
    if (!ctx) {
      this.setData({ periodEditError: '这一行已经不在列表里了，请关掉重试' });
      return;
    }
    const checked = periodRowPatch(ctx.number, this.data.periodEditStart, this.data.periodEditEnd);
    if (!checked.ok) {
      // 【本地就能判的错就地拦下】不为了一个"没填完整"去发一次请求
      this.setData({ periodEditError: checked.error });
      return;
    }
    this.savePeriodPatch(checked.patch, `已保存：${ctx.label} ${this.data.periodEditStart}`
      + `-${this.data.periodEditEnd}`);
  },

  /**
   * 「清除」：把这一节从 period_times 里去删掉，回到未校准。
   *
   * 【为什么要有】用户填错了得能退回去 —— 没有这个入口，一次手滑就把课表口径改歪了。
   * 【为什么要确认】这是改**配置**，不是改一条任务：影响面是整张课表（所有落到这一节的
   *   课程/日程都会跟着变）。所以按"破坏性操作"处理，先问一句。
   */
  onTapPeriodClear(event) {
    const index = event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.index
      : -1;
    const ctx = this.readPeriodRow(index);
    if (!ctx) {
      wx.showToast({ title: '这一行读不出来，请下拉刷新', icon: 'none' });
      return;
    }
    if (!settingsReady()) {
      wx.showToast({ title: '设置接口不可用，请更新版本', icon: 'none' });
      return;
    }
    const next = dropPeriodKey(this.periodTimes, ctx.number);

    wx.showModal({
      title: `清除「${ctx.label}」的时间？`,
      content: `清除后这一节回到未校准状态，课表里会按内置默认时间显示（当前是 `
        + `${ctx.row.timeText}）。`,
      confirmText: '清除',
      cancelText: '取消',
      success: (res) => {
        if (!res || !res.confirm) return;   // 点了取消 → 什么都不做
        this.savePeriodPatch(null, `已清除：${ctx.label} 的时间（回到未校准）`, next.times);
      },
      fail: () => {
        // 弹窗弹不出来时按"用户没确认"处理：不删任何东西
        this.setData({ periodSaveFailed: true, periodSaveText: '没能弹出确认框，本次没有清除' });
      },
    });
  },

  /**
   * 保存作息（补录 / 修改 / 清除的**唯一出口**）。
   *
   * @param {object|null} patch 增量（只含被改的那一节）；清除时传 null
   * @param {string} okText 成功后的那一句话
   * @param {object} [fullTimes] 已经算好的完整作息（清除用：key 要去掉，不能靠合并）
   */
  savePeriodPatch(patch, okText, fullTimes) {
    if (!settingsReady()) {
      this.failPeriodSave('设置接口不可用，请更新版本', true);
      return;
    }
    const next = fullTimes || mergePeriodTimes(this.periodTimes, patch);
    // 兜底：patch 为空（理论上不会，调用方都先校验过）→ 不发请求
    if (!next) {
      this.failPeriodSave('没有要保存的内容', true);
      return;
    }

    this.setData({ periodSaving: true, periodEditError: '' });
    api.saveSettings({ period_times: next }).then((result) => {
      if (result && result.ok === false) throw new Error(describeError(result));
      // 服务端会把 period_times 归一化后回传，以**服务端返回的**为准（与导入那条路同口径）
      const saved = extractSettings(result);
      const finalTimes = saved.period_times || next;
      // 【先备份再覆盖】服务端可能回一个空对象/缺字段（归一化没做完），
      // 这时宁可继续用我们算好的 next，也不要把用户已有的作息清成空。
      const applied = (finalTimes && Object.keys(finalTimes).length) ? finalTimes : next;
      this.periodTimes = applied;
      // 同步给 app.globalData（课表页读的就是它），并立刻重画本页作息表
      // —— renderPeriods 会按新作息重新打「已校准 / 未校准」标记
      syncGlobalSettings({ ok: true, data: { period_times: applied } });
      this.setData({
        periodSaving: false,
        periodEditVisible: false,
        periodEditError: '',
        periodSaveText: okText,
        periodSaveFailed: false,
      });
      this.renderPeriods();
    }).catch((err) => {
      this.failPeriodSave(`没能保存：${describeError(err)}`, false);
    });
  },

  /**
   * 保存失败：**只说人话、绝不动已有的作息**。
   * @param {string} message 给人看的一句话
   * @param {boolean} [inModal] true = 显示在弹层里（本地前置校验失败），false = 弹层下方那行
   */
  failPeriodSave(message, inModal) {
    // this.periodTimes 一个字节都不改；periodRows 也只有成功路径才重画
    this.setData({
      periodSaving: false,
      periodSaveText: message,
      periodSaveFailed: true,
      periodEditError: inModal ? message : '',
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
      // 这是用户的一次真实点击 → 顺手看看能不能静默补一次提醒额度（没勾"保持选择"的人不会被调用）
      this.maybeSilentTopUp();
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
    // 【silent: true】这是"进页面顺手读一次"的辅助请求，用户还没做任何操作 ——
    // 读不到时只在卡片里留一行灰字（下面的 aiResultText），不该弹"网络异常"打扰他。
    // 走 api.js 导出的核心 call() 并显式传 options：
    //   * 它是公开接口，明确支持第三个参数 {silent}；
    //   * `api.aiConfigGet(options)` 现在**也已经会把 options 转发下去**了
    //     （utils/api.js:663，之前漏传过、我这里是绕过它的直连写法）。
    //     两种写法行为一致；保留直连是因为它不依赖那个包装的转发细节。
    // 用户主动点的保存/清除照弹（那是他自己触发的动作，必须给反馈）。
    const readConfig = typeof api.call === 'function'
      ? api.call('ai_config_get', null, { silent: true })
      : api.aiConfigGet();
    return readConfig.then((result) => {
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
      // 【不许断言"AI 用不了"】预置 Key 配在 aiParse / aiDecompose 的环境变量里，
      // tasks 无从得知——这里只陈述"你还没填"，有没有兜底由 AI 云函数报错时去说。
      statusText = '还没填 Key，AI 用的是程序预置的 Key（如果部署时配了）';
    }

    // 状态行第二行：把**服务商 + 实际生效的模型**一起写出来。
    // 真机上用户报"我用的明明是 deepseek，它硬说我用的是智谱大模型"——
    // 就是因为原来只有「模型：X」，看不出服务商是哪家；而服务商与 Key 必须同源，
    // 所以这两件事必须能同时看见。
    const effectiveModel = str(config.model) || AI_DEFAULT_MODEL[option.value] || '';
    const statusDetail = `服务商：${option.label} · 模型：${effectiveModel || '（未知）'}`;

    this.setData({
      aiProviderIndex: index,
      aiProviderValue: option.value,
      aiProviderHint: option.hint,
      aiKeyUrl: option.keyUrl,
      aiKeyUrlLabel: option.keyUrlLabel,
      aiDefaultModelText: AI_DEFAULT_MODEL[option.value]
        ? `该服务商的默认模型：${AI_DEFAULT_MODEL[option.value]}`
        : '',
      aiModel: effectiveModel,
      aiStatusDetail: statusDetail,
      aiHasKey: hasKey,
      aiMasked: masked,
      aiStatusText: statusText,
      aiStatusType: statusType,
      // 输入框永远留空：要改就重新填一个，绝不回显旧的
      aiKeyInput: '',
      aiKeyPlaceholder: hasKey
        ? `已保存 ${masked || '****'}，留空则不改动`
        : '粘贴你的 API Key（不会显示出来）',
      // 模型输入框也留空：留空 = 保持服务端当前生效的模型（保存时不带 model 字段）
      aiModelInput: '',
      aiModelAliasHint: '',
    });
    // 状态回填后两个输入框都清空了 → 两条提示自然要重算（都会算成"无提示"）
    this.refreshKeyShapeHint('');
    this.refreshModelAliasHint('');
  },

  /**
   * 重算 Key 形状提示（纯本地，不发任何请求）。
   * 输入框变化、保存回填、切换服务商都要调它 —— 任何一处漏调，提示就会与界面不同步。
   * @param {string} key 当前输入框里的 Key（空 = 没有提示）
   */
  refreshKeyShapeHint(key) {
    const hint = keyProviderHint(key, this.data.aiProviderValue);
    this.setData({
      aiKeyShapeHint: hint.message,
      aiKeyShapeFixIndex: hint.fixIndex,
      aiKeyShapeFixLabel: hint.fixIndex >= 0
        ? `切到 ${(AI_PROVIDERS[hint.fixIndex] || {}).label || ''}`
        : '',
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
      aiKeyUrlLabel: option.keyUrlLabel,
      aiDefaultModelText: AI_DEFAULT_MODEL[option.value]
        ? `该服务商的默认模型：${AI_DEFAULT_MODEL[option.value]}`
        : '',
      aiResultText: '',
    });
    // 【必须重算】服务商一改，"Key 形状对不对得上"的结论就变了 ——
    // 例如从 zhipu 切到 deepseek 后，本来那行黄字就该消失。
    this.refreshKeyShapeHint(this.data.aiKeyInput);
  },

  /**
   * 点「切到 DeepSeek / 切到智谱 GLM」按钮。
   *
   * 【只改下拉选中项，**不保存、不提交**】服务商是用户的配置，
   * 静默改掉比让他自己点一下更糟；按钮的作用只是省掉他去点下拉框。
   * 生效仍然要他按「保存」。
   */
  onAiFixProvider() {
    const index = this.data.aiKeyShapeFixIndex;
    if (!(index >= 0) || !AI_PROVIDERS[index]) return;
    this.onAiProviderChange({ detail: { value: index } });
  },

  /** Key 输入框：只存进 data 供提交用；提交成功后立刻清空 */
  onAiKeyInput(event) {
    const value = str(event.detail && event.detail.value);
    this.setData({ aiKeyInput: value });
    // 边打字边判断形状（纯本地、零请求）
    this.refreshKeyShapeHint(value);
  },

  /** 模型输入框：只存进 data；留空 = 保存时不带 model 字段 */
  onAiModelInput(event) {
    const value = str(event.detail && event.detail.value);
    this.setData({ aiModelInput: value });
    // 边打字边给"名字写错了"的提示（纯本地、零请求）
    this.refreshModelAliasHint(value);
  },

  /**
   * 模型名写错时的提醒（纯本地，不发请求）。
   *
   * 真机反馈：用户填的是 **`deepseek-V4.1-Flash`**（那是 DeepSeek 的**宣传名**），
   * 而 API 里的模型名是 `deepseek-flash` —— 于是请求失败，
   * 而报错信息把他误导去查 Key。所以这里把"宣传名 → API 名"的对应关系提示出来。
   *
   * 【只提示，绝不自动改用户填的值】静默改写用户的配置比让他自己改一遍更糟：
   * 他下次看到输入框里的值和自己填的不一样，会怀疑程序在乱动他的东西。
   *
   * 【拿不到那个函数就静默跳过】utils/api.js 的 modelAliasAdvice 由另一位同学在加，
   * 加载顺序上可能还不存在 —— 用 typeof 守卫，缺了就当没有这条提示，绝不报错。
   *
   * @param {string} model 当前输入框里的模型名
   */
  refreshModelAliasHint(model) {
    let advice = '';
    if (typeof api.modelAliasAdvice === 'function') {
      try {
        advice = str(api.modelAliasAdvice(str(model)));
      } catch (err) {
        // 建议函数自己出错不能连累页面（它只是锦上添花的一条提示）
        console.warn('[me] modelAliasAdvice 异常，已跳过提示：', err);
        advice = '';
      }
    }
    this.setData({ aiModelAliasHint: advice });
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

    // 模型：留空 → **payload 里不带 model 字段**（不是空串），由云函数用该服务商默认模型；
    // 填了 → 带 trim 后的值。
    const modelInput = str(this.data.aiModelInput);
    if (modelInput.length > MAX_MODEL_CHARS) {
      // 本地拦下：多半是误粘贴。不发请求，直接给人话（超长服务端也会拒，但白跑一趟网络）
      this.setData({
        aiResultText: `模型名过长（${modelInput.length} 字，最多 ${MAX_MODEL_CHARS} 字），`
          + `请检查是否粘贴错了。`,
      });
      toastText('模型名过长，请检查是否粘贴错了');
      return;
    }

    const payload = { provider, api_key: apiKey };
    // 只有确实填了模型才带这个字段 —— 空串会让云函数把模型清成空值
    if (modelInput) payload.model = modelInput;

    this.setData({ aiSaving: true, aiResultText: '' });
    api.aiConfigSave(payload).then((result) => {
      if (result && result.ok === false) throw new Error(describeError(result));
      // 用服务端返回的掩码回填；**不回显 Key 原文**（data 里也立刻清掉输入）
      this.applyAiConfig(extractAiConfig(result));
      this.setData({
        aiSaving: false,
        aiResultText: `已保存：${this.data.aiStatusDetail}`
          + `（Key ${this.data.aiMasked || '****'}）。`,
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
      // 顺手读一次"用户勾过『总是保持以上选择』没有" —— 它决定能不能静默补额度。
      // 【为什么跟着状态一起读】模板 ID 刚拿到手（canSilentTopUp 要用它去查设置页），
      // 而这件事只有本地一次 getSetting，不放这儿就得再找个时机。失败无所谓：
      // refreshSubscribeSetting 内部一律按"没勾过"处理，也就是安全的那一侧。
      this.refreshSubscribeSetting();
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
        remindResultText: (patch.capped
          ? `已上报授权，但服务端额度已到上限（${patch.max_quota} 条），这次没有增加。`
          : '已增加 1 次提醒机会（一次性订阅：授权一次只能收到一条提醒）。')
          + remindSilentGuide(this.data.remindSilentAllowed),
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

  // =========================================================================
  // 三点六、"别让我一个个点"：静默补额度 + 一次补齐 + 写进手机系统日历
  // =========================================================================
  // 【这一节解决什么】微信的规则一条都改不了（授权一次只能发一条、授权窗必须由用户的
  // 点击行为触发、长期订阅只对特定类目开放 —— 见 utils/subscribe.js 文件头与
  // docs/到期提醒.md）。但用户那句"我就是不想再一次一次点去了"是合理的诉求，所以：
  //   1. `refreshSubscribeSetting` —— 判出用户勾没勾弹窗里的「总是保持以上选择，不再询问」。
  //      勾过之后，再次调用**不会再弹窗**（官方文档：勾选后模板会出现在小程序设置页，
  //      可用 getSetting 读状态），于是本页每一次点击都能顺手静默补 1 条。
  //   2. `onRemindTopUpRound` —— 没勾过的人：点一下连弹到 3 条，不必来回找同一颗按钮
  //      （每个授权窗仍然要各自点一次"允许"：那是微信的交互，我们替代不了）。
  //   3. `onAddToCalendar` —— 两条都不想要的人：把截止事项写进**手机系统日历**，
  //      不消耗微信额度、不限条数、离线也响。这才是真正意义的"全部放开"。

  /**
   * 读一次"用户勾过『总是保持以上选择，不再询问』没有"，并据此重画两张说明。
   *
   * 【失败一律按"没勾过"处理】那是安全的一侧：判不出来就不许静默调用，
   * 于是绝不会因为一次读失败而给用户弹出意料之外的授权窗。
   */
  refreshSubscribeSetting() {
    return subscribe.readSubscribeSetting().then((setting) => {
      const allowed = subscribe.canSilentTopUp(setting, this.remindTemplateId);
      const maxTimes = subscribe.maxTimesForRound(allowed);
      this.setData({
        remindSilentAllowed: allowed,
        remindSilentText: allowed
          ? '已开启自动补充：你在这页每点一次（保存作息、改提前量、写日历…），我都会顺手补 1 次额度，10 分钟最多一次，不用再惦记。'
          : '想彻底不用点：下次授权弹窗里勾上「总是保持以上选择，不再询问」，之后我就能自动帮你补额度。'
            + '（这个开关由微信弹窗提供，小程序改不了它，只能请你勾一次。）',
        remindTopUpLabel: maxTimes === 1
          ? '补充 1 次（不会弹窗）'
          : `一次补齐 ${subscribe.TOPUP_ROUND_MAX} 次（少点两次）`,
      });
      return allowed;
    });
  },

  /**
   * 顺手静默补 1 条额度。
   *
   * 【三道闸，缺一不可】① 模板 ID 有了（没有就什么都没得谈）；② 用户勾过"保持以上选择"
   * （否则这次调用会**弹窗**，那是打扰不是省心）；③ 距上次静默补充够 10 分钟
   * （不然每点一次都调一次，等于刷）。任何一步不满足就直接返回，用户什么都感觉不到。
   *
   * 【为什么全程静默】这个动作不是用户点出来的（他点的是"保存作息"），
   * 所以失败绝不能弹 toast —— 与 status 那次顺手读同一个道理（见本文件文件头第四条）。
   */
  maybeSilentTopUp() {
    if (!this.remindTemplateId) return;
    if (!this.data.remindSilentAllowed) return;
    subscribe.silentTopUpOnce({
      tmplId: this.remindTemplateId,
      // 上报失败要**当成失败**：服务端没有额度，留一条"假的已授权"只会让下次下发 43101。
      onAccept: () => remindAck(1).then((result) => {
        if (!result || result.ok !== true) throw new Error(describeError(result));
        return result;
      }),
    }).then((result) => {
      if (!result || result.done !== true) return;
      // 额度真的变了，安静地把卡片上的数字对齐服务端（silent：这一步失败也不再打扰）
      this.loadRemindStatus({ silent: true });
    }).catch((err) => {
      console.warn('[me] 静默补额度失败（不影响使用）：', describeError(err));
    });
  },

  /**
   * 点「一次补齐」：连弹授权窗到 N 次，每次"允许"各上报 +1。
   *
   * 【N 是几：由"会不会弹窗"决定】没勾"保持以上选择"时 N=3（每个窗都有用户逐次同意的
   * 记录，3 条就是 3 条真额度）；勾过之后 N=1 —— 静默调用只回一个 accept，
   * 里面并没有"几次"这回事（勾选框能不能累积额度，官方文档没写、我们也没真机证据）。
   * **宁可少攒，不可虚报**：虚报出来的额度在下发时必然 43101 失败，那是把用户的提醒玩坏。
   *
   * 【中途停下也要如实说】用户第 2 个窗点了拒绝、或第 2 次调用直接失败，
   * 都要说清"补到了几次、为什么没继续"，不能只报一个成功数。
   */
  onRemindTopUpRound() {
    if (this.data.remindTopUpBusy || this.data.remindBusy || this.data.remindLoading) return;
    if (!this.remindTemplateId) {
      this.promptRemindConfig();
      return;
    }

    const maxTimes = subscribe.maxTimesForRound(this.data.remindSilentAllowed);
    this.setData({ remindTopUpBusy: true, remindResultText: '', remindResultType: '' });

    let added = 0;
    let stopped = '';
    let detail = '';

    const step = (index) => {
      if (index >= maxTimes) return Promise.resolve();
      return subscribe.requestSubscribeOnce(this.remindTemplateId).then((answer) => {
        if (answer.result !== 'accept') {
          stopped = answer.result;
          detail = answer.detail || '';
          return null;
        }
        // 每一次"允许"各上报一次：count 恒为 1（一次授权只能发一条，报多了就是骗服务端）
        return remindAck(1).then((result) => {
          if (!result || result.ok !== true) throw new Error(describeError(result));
          added += 1;
          return step(index + 1);
        });
      });
    };

    step(0).then(() => {
      const text = roundResultText(added, stopped, detail, this.data.remindSilentAllowed);
      this.setData({
        remindTopUpBusy: false,
        remindResultText: text,
        remindResultType: added > 0 ? 'ok' : 'warn',
      });
      toastText(added > 0 ? `已增加 ${added} 次提醒机会` : '这次没有增加额度');
      // 额度/开关都变了，把卡片对齐服务端的真值（silent：失败不再打扰）
      return this.loadRemindStatus({ silent: true });
    }).catch((err) => {
      // 报到一半失败：**已经补上的那几次是真的**，如实说，别让用户以为全丢了
      const detailText = describeError(err);
      this.setData({
        remindTopUpBusy: false,
        remindResultText: added > 0
          ? `已增加 ${added} 次，但后面上报失败：${detailText}。剩下的请再点一次「补充」。`
          : `上报失败：${detailText}。这次机会可能没记上，请再点一次。`,
        remindResultType: 'warn',
      });
      toastText(`上报失败：${detailText}`);
    });
  },

  /**
   * 把**还没到期的截止事项**写进手机系统日历（不消耗微信提醒额度、不限条数）。
   *
   * 【为什么这条通道重要】微信那条路每发一条都要用户授权一次；日历这条路一次授权
   * （scope.addPhoneCalendar）之后就一直能用，系统闹钟到点会响，断网也响。
   * 对"我的截止事项必须有人提醒我"这个需求来说，它比订阅消息更可靠。
   *
   * 【口径与微信那条通道完全一致】只写 `type==='ddl'`、未完成、且**填了截止时刻**的
   * 事项 —— 云函数的 dueInstantOf 就是这么判的（缺 end_time 一律跳过，"不瞎猜 23:59"）。
   * 两条通道对同一条数据给出不同答案，比两条都不做还糟。
   *
   * 【重复点击不会写两份】写成功的键记在本地，下次默认跳过（见 utils/subscribe.js）。
   */
  onAddToCalendar() {
    if (this.data.remindCalBusy) return;

    if (!subscribe.calendarSupported()) {
      const text = `当前微信版本不支持写系统日历（需要基础库 ${subscribe.CAL_MIN_SDK} 及以上，请先升级微信）。`;
      this.setData({ remindCalText: text });
      toastText('微信版本过低，写不了日历');
      return;
    }

    this.setData({ remindCalBusy: true, remindCalText: '正在读取截止事项…' });

    api.listTasks().then((result) => {
      if (result && result.ok === false) throw new Error(describeError(result));
      const tasks = extractTasks(result);
      const built = subscribe.calendarEventsOf(tasks, {
        leadMin: this.data.remindLeadMin,
        skipKeys: subscribe.readWrittenKeys(),
        max: subscribe.CAL_MAX_EVENTS,
        // 【可注入的"现在"】与 pages/tasks 的 remindNowMs 同一约定：生产环境里它是 undefined
        // （subscribe 内部回落到 Date.now()），单测钉死一个时刻，"哪些算过期"就与跑测试的机器日期无关。
        nowMs: this.remindNowMs,
      });

      if (!built.events.length) {
        // 【一条都写不了时必须说清"为什么"】否则用户只会认为这个按钮坏了
        this.setData({ remindCalBusy: false, remindCalText: noCalendarText(built, tasks.length) });
        toastText('没有可写入的截止事项');
        return null;
      }

      return subscribe.addCalendarEvents(built.events, {
        onEach: (progress) => {
          this.setData({ remindCalText: `正在写入手机日历 ${progress.index} / ${progress.total}…` });
        },
      }).then((summary) => {
        // 只把**真的写成功**的那些记下来（失败的下次还会再试）
        subscribe.rememberWrittenKeys(summary.okIndexes.map((i) => built.events[i] && built.events[i].key));
        this.setData({
          remindCalBusy: false,
          remindCalText: calendarSummaryText(summary, built, this.data.remindLeadText),
        });
        toastText(summary.added ? `已写入 ${summary.added} 条到手机日历` : '写入失败');
        // 写日历是用户的一次点击 → 顺手看看能不能补一次额度（没勾"保持选择"的人不会被调用）
        this.maybeSilentTopUp();
      });
    }).catch((err) => {
      this.setData({ remindCalBusy: false, remindCalText: `写日历失败：${describeError(err)}` });
      toastText(`写日历失败：${describeError(err)}`);
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
        // 用户点过 picker 了 → 顺手静默补一次额度（判定与节流都在 maybeSilentTopUp 里）
        this.maybeSilentTopUp();
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
      // 用户点过按钮了 → 顺手静默补一次额度（这是"以后不用管"的关键一步）
      this.maybeSilentTopUp();
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

  /**
   * 「从教务系统导入」：读剪贴板 → 解析课表 → 预览（同样**不写库**）。
   *
   * ===========================================================================
   * 【为什么是"复制粘贴"，而不是"填个网址"】
   * ===========================================================================
   * 2026-10-15 实测：深大 ehall 的课表页（`jwapp/sys/wdkb/...`）**一跳就跳去
   * authserver.szu.edu.cn**（学校统一身份认证）—— 没有用户浏览器里的登录态，谁都取不到它。
   * 而小程序这一侧三条路都封死：`wx.request` 只认自己拥有并能上传校验文件的合法域名；
   * 个人主体不能用 `web-view`；云函数能出网但没有用户的 Cookie。
   * 所以让用户**在自己浏览器里登录**，把**内容**粘进来 —— 全程不碰学号密码。
   *
   * 能认两种输入（自动识别，见 utils/timetable.js）：
   *   ① 课表页 Ctrl+S 另存的网页（最稳：格子上带着 data-week 与节次）；
   *   ② 直接 Ctrl+A / Ctrl+C 复制的文本（明细行本身就把周次/星期/节次/地点说全了）。
   *
   * 【为什么必须有学期开始日期】课程要落到具体日期（weekly 靠 date 定"周几"）。
   * 与其猜一个，不如让用户先设好上面那个字段 —— 全项目只认这一个来源。
   */
  onImportFromTimetable() {
    if (this.data.importing || this.data.submitting) return;

    if (!timetableReady()) {
      const text = `课表解析模块不可用（utils/timetable.js 缺失${timetableLoadError ? `：${timetableLoadError}` : ''}）`;
      this.setData({ importResultText: text });
      toastText('课表解析模块不可用');
      return;
    }

    const semesterStart = str(this.data.semesterStart)
      || str(((getApp() || {}).globalData || {}).semesterStart);
    if (!semesterStart) {
      // 不猜日期：设好学期开始日期再来（课程要靠它算"第 1 周的那一天"）
      const text = '请先设置上面的「学期开始日期」，再点这个按钮 —— 课程要靠它算出具体日期。';
      this.setData({ importResultText: text });
      wx.showToast({ title: '请先设置学期开始日期', icon: 'none' });
      return;
    }

    this.setData({ importing: true, importResultText: '', warnings: [], previewItems: [], pendingTasks: [] });

    const fail = (text, toast) => {
      this.setData({ importing: false, importResultText: text });
      if (toast) toastText(toast);
    };

    wx.getClipboardData({
      success: (res) => {
        const text = str(res && res.data);
        if (!text.trim()) {
          fail('剪贴板是空的：先在课表页按 Ctrl+A、Ctrl+C 复制，再回来点这个按钮。', '剪贴板是空的');
          return;
        }

        const parsed = timetable.parseTimetable(text);
        const warnings = parsed.warnings.slice();
        if (!parsed.courses.length) {
          fail('没从剪贴板里认出课表：' + (warnings[0] || '这段内容不像是课表页')
            + '。也可以在课表页截图，用上面的「拍照识别课表」。', '没认出课表，可改用截图识别');
          return;
        }

        const built = timetable.toTasks(parsed, { semesterStart: semesterStart, warnings: warnings });
        const tasks = built.tasks;
        if (!tasks.length) {
          fail('这些内容还变不成课程：' + (warnings[0] || '没有可导入的条目'), '没有可导入的课程');
          return;
        }

        const preview = tasks.slice(0, 8).map((task) => ({
          title: str(task.title) || '(无标题)',
          dateText: formatDateCn(task.date),
          whenText: whenTextOf(task),
          typeLabel: TYPE_LABELS[str(task.type)] || '日程',
        }));

        this.pendingTasks = tasks;
        // 这条路的课程时间由**用户自己的节次作息**决定，网页里没有上下课时刻可校准
        this.pendingPeriodTimes = null;

        this.setData({
          // 【必须显式收掉 importing】成功这条路也要收：漏了它界面会永远停在"正在解析…"
          // （真被测试抓到过一次：三条断言因此变红）
          importing: false,
          pickedFileName: `剪贴板（${parsed.format === 'ehall-html' ? '保存的网页' : '复制的文本'}）`,
          parsedCount: parsed.courses.length,
          taskCount: tasks.length,
          warnings: warnings,
          previewItems: preview,
          previewMore: Math.max(tasks.length - preview.length, 0),
          pendingTasks: [],
          calibratedPeriodCount: 0,
          calibratedText: '',
          importResultText: `从剪贴板认出 ${parsed.courses.length} 门课，可导入 ${tasks.length} 条`
            + '（课程的上课时刻按你自己的节次作息显示）',
        });
      },
      fail: (err) => fail(`读剪贴板失败：${describeError(err)}`, '读剪贴板失败'),
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
      // 【为什么不用 describeError】"未知 action"意味着**云环境里部署的那份云函数版本过旧**，
      // 是部署状态问题、不是数据问题；用户唯一能做的动作是重新部署。
      // 所以这里把它翻译成"你该做什么"，并保留服务端原话在句尾（不吞线索）。
      const friendly = explainCloudError('import_replace', describeError(err));
      this.setData({ importResultText: `替换失败：${friendly}` });
      toastText(`替换失败：${friendly}`);
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
      // 与替换路径同款：把"未知 action"翻译成"云函数版本过旧，请重新部署"。
      // 追加导入用的 bulk_add 虽然老版本也有，但同样可能因为部署错环境而报未知 action。
      const friendly = explainCloudError('bulk_add', describeError(err));
      this.setData({ importResultText: `入库失败：${friendly}` });
      toastText(`入库失败：${friendly}`);
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

  // -------------------------------------------------------------------------
  // 联系与反馈（用户提问题 / 给修改建议的入口）
  // -------------------------------------------------------------------------

  /**
   * 复制联系方式。`dataset.kind` 区分「微信号 / 邮箱」。
   *
   * 【为什么只做"复制"】小程序里既没有 `mailto:`，也不能直接跳去加微信好友 ——
   * 剪贴板是唯一既可靠又不需要任何权限的动作（与「导出备份」同一个理由）。
   * 所以这里的目标不是"一键联系"，而是"一键拿到联系方式，剩下的交给微信/邮箱"。
   */
  onCopyContact(event) {
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const kind = str(dataset.kind) === 'email' ? 'email' : 'wechat';
    this.copyToClipboard(contactOf(kind), kind === 'email' ? '邮箱' : '微信号');
  },

  /** 复制一段"反馈模板"：把最需要的信息列成空位，用户填完发过来就行 */
  onCopyFeedbackTemplate() {
    this.copyToClipboard(FEEDBACK_TEMPLATE, '反馈模板');
  },

  /**
   * 复制文本 + 如实反馈结果（三个入口共用）。
   *
   * 【失败绝不能静默】用户点了"复制"，就得知道到底复制上没有 —— 复制成功却没有提示，
   * 他会以为按钮坏了；复制失败却提示成功，他会粘出一片空白然后以为我给的号是错的。
   */
  copyToClipboard(text, label) {
    const value = str(text);
    if (!value) {
      this.setData({ contactResultText: `没有可复制的${label}` });
      toastText(`没有可复制的${label}`);
      return;
    }
    wx.setClipboardData({
      data: text,
      success: () => {
        this.setData({ contactResultText: `已复制${label}：${value.split('\n')[0]}` });
        toastText(`已复制${label}`);
      },
      fail: (err) => {
        const detail = describeError(err);
        this.setData({ contactResultText: `复制${label}失败：${detail}。可以长按上面的文字手动复制。` });
        toastText(`复制失败：${detail}`);
      },
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
    // 三点六 · "别让我一个个点"：静默补额度的引导 + 两个结果行（utils/tests/remind_page.test.js 用）
    remindSilentGuide: remindSilentGuide,
    roundResultText: roundResultText,
    noCalendarText: noCalendarText,
    calendarSummaryText: calendarSummaryText,
    REMIND_FUNCTION: REMIND_FUNCTION,
    REMIND_DOC: REMIND_DOC,
    REMIND_NO_TEMPLATE_TIP: REMIND_NO_TEMPLATE_TIP,
    FALLBACK_LEAD_OPTIONS: FALLBACK_LEAD_OPTIONS,
    // 导入课表 · 云函数报错翻译
    explainCloudError: explainCloudError,
    isCourseTask: isCourseTask,
    splitCoursesAndManual: splitCoursesAndManual,
    mergePeriodTimes: mergePeriodTimes,
    isBuiltinDefault: isBuiltinDefault,
    // 节次作息 · 未校准标记与补录
    isUncalibrated: isUncalibrated,
    rowNumberOf: rowNumberOf,
    rowIsBreak: rowIsBreak,
    periodRowPatch: periodRowPatch,
    dropPeriodKey: dropPeriodKey,
    firstTime: firstTime,
    secondTime: secondTime,
    // AI 设置 · Key 形状与服务商匹配
    detectKeyProvider: detectKeyProvider,
    keyProviderHint: keyProviderHint,
    MAX_MODEL_CHARS: MAX_MODEL_CHARS,
    AI_DEFAULT_MODEL: AI_DEFAULT_MODEL,
    // 联系与反馈（utils/tests/me_contact.test.js 从**页面对象**上取这三个）
    CONTACTS: CONTACTS,
    contactOf: contactOf,
    FEEDBACK_TEMPLATE: FEEDBACK_TEMPLATE,
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

/** "13:30-14:10" → "13:30"（解析不出来给空串，调用方自己兜底） */
function firstTime(timeText) {
  const matched = /^(\d{1,2}:\d{2})\s*[-–~]\s*(\d{1,2}:\d{2})$/.exec(str(timeText));
  return matched ? matched[1] : '';
}

/** "13:30-14:10" → "14:10" */
function secondTime(timeText) {
  const matched = /^(\d{1,2}:\d{2})\s*[-–~]\s*(\d{1,2}:\d{2})$/.exec(str(timeText));
  return matched ? matched[2] : '';
}

/**
 * 设置接口是否可用（getSettings / saveSettings 都在）。
 * 【为什么要有它】api.js 由同事维护，形状可能变（这个仓库已经因此踩过一次：
 * aiConfigGet 的 options 被漏掉）。缺函数时直接调用会抛 TypeError ——
 * 那是**最糟的失败方式**（用户只该看到一句人话）。所以动手前先问一句。
 */
function settingsReady() {
  return typeof api.getSettings === 'function' && typeof api.saveSettings === 'function';
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
 * 云函数名（提示里要指名道姓说"该重新部署哪一个"）。
 * 优先用 utils/api.js 导出的事实来源，取不到才退回字面量 —— 免得哪天改了名字这里对不上。
 */
const CLOUD_FUNCTION_NAME = (api && api.CLOUD_FUNCTION_NAME) || 'tasks';

/**
 * 把云函数的报错翻译成"用户该做什么"。
 *
 * ===========================================================================
 * 【为什么需要它】真机事故：用户点「替换导入」失败，界面上弹的是云函数原话
 * ===========================================================================
 *   「替换失败：未知 action：import_replace；支持 list / add / bulk_add / ...」
 *   代码没问题 —— 是他云环境里部署的 tasks **还是旧版本**（不认识 import_replace）。
 *   但这句原话对用户毫无帮助：他既不知道"未知 action"是什么意思，
 *   更不知道唯一能做的动作是**重新部署云函数**。
 *
 *   「未知 action」是**部署状态**问题，不是数据问题：代码里已经写好了这个 action，
 *   只是云端跑的那份还没有。所以提示必须直接告诉他"云函数版本过旧、请重新部署"，
 *   而不是把服务端的术语原样丢给他。
 *
 * 【不吞信息】原始报错**保留在句尾**（「服务端原话：…」）。藏起来的话，
 *   以后真出别的问题时就没法排查了 —— 这类"翻译"最容易犯的错就是把线索丢掉。
 *
 * @param {string} action 这次调用的 action（如 'import_replace'）；空/非字符串也能处理
 * @param {string} errorText 服务端/网络层给的原始错误文案
 * @returns {string} 给用户看的一句话
 */
function explainCloudError(action, errorText) {
  const raw = str(errorText);
  const name = str(action) || '（未知）';

  // 服务端说"不认识这个 action" → 云端那份代码比小程序旧
  if (raw.indexOf('未知 action') !== -1) {
    const who = name === '（未知）'
      ? `云函数 \`${CLOUD_FUNCTION_NAME}\``
      : `云函数 \`${CLOUD_FUNCTION_NAME}\` 不认识 \`${name}\``;
    return `${who}：你云环境里部署的版本过旧。`
      + `请在微信开发者工具里右键 \`cloudfunctions/${CLOUD_FUNCTION_NAME}\` → `
      + `「上传并部署：云端安装依赖」，然后再点一次。`
      + `（服务端原话：${raw}）`;
  }

  // 其它情况一律原样返回，不做任何猜测 —— 网络抖动不能被误判成部署问题
  return raw || '操作失败，请稍后重试';
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
 * 授权成功后那句"以后怎么才能不用点"的引导。
 *
 * 【为什么放在结果行里，而不是在授权窗前弹一个提示】在授权窗前再弹一个"请记得勾选…"的
 * 确认框，等于让用户为省事**先多点一次** —— 那正好违背这一节的目的。弹窗里那个勾选框由
 * 微信提供，我们改不了它，只能在他点完一次之后把这句话说清楚（下一轮他就能顺手勾上）。
 *
 * @param {boolean} silentAllowed 用户是否已经勾过「总是保持以上选择，不再询问」
 * @returns {string} 空串表示不需要再念一遍
 */
function remindSilentGuide(silentAllowed) {
  if (silentAllowed) return '';
  return '　想以后不用点：在这个弹窗里勾上「总是保持以上选择，不再询问」，之后我会自动帮你补额度。';
}

/**
 * 「一次补齐」的结果行。四种情况必须说得出区别（用户看不到别的东西）：
 * 全部补上 / 补了一部分就停 / 一个都没补上（拒绝、被封、调用失败）/ 没拿到结果。
 *
 * @param {number} added 真的上报成功的次数
 * @param {string} stopped '' 表示没停下（全部成功）；否则是 reject/ban/fail/unknown
 * @param {string} detail 失败时的原始原因（原样带上，不翻译成猜的语义）
 * @param {boolean} silentAllowed 是否走的静默那条路（决定"弹了几次窗"这句怎么写）
 * @returns {string}
 */
function roundResultText(added, stopped, detail, silentAllowed) {
  const n = Math.max(0, Math.floor(Number(added) || 0));
  if (n > 0 && !stopped) {
    return silentAllowed
      ? `一轮补齐完成：增加 ${n} 次提醒机会（已勾「保持以上选择」，全程没有弹窗）。`
      : `一轮补齐完成：增加 ${n} 次提醒机会（微信一次授权只能发一条，所以弹了 ${n} 次窗）。`;
  }
  if (n > 0) {
    const why = stopped === 'reject' ? `你在第 ${n + 1} 个窗点了拒绝`
      : stopped === 'ban' ? '这个模板在微信那边被你拒过'
        : stopped === 'fail' ? `授权窗没能弹出来${detail ? `（${detail}）` : ''}`
          : `第 ${n + 1} 次没有拿到结果（${stopped || '空'}）`;
    return `已增加 ${n} 次；${why}，剩下的没继续。`;
  }
  if (stopped === 'reject') return '你拒绝了授权，可以不授权，但这样到期时就收不到微信提醒了。';
  if (stopped === 'ban') return '你之前拒绝了订阅消息，需要到微信「设置 → 订阅消息」里把本小程序打开，再回来点一次。';
  if (stopped === 'fail') return `授权窗没能弹出来：${detail || '未知原因'}。`;
  return `没有拿到授权结果（${stopped || '空'}），请再点一次试试。`;
}

/** 一条都写不进日历时，把"为什么"按原因列出来（否则用户只会觉得按钮坏了） */
function noCalendarText(built, total) {
  const skipped = (built && built.skipped) || {};
  const reasons = [];
  // 顺序 = 用户最可能遇到的原因排在前面
  if (skipped.noTime) {
    reasons.push(`${skipped.noTime} 条只填了日期、没填截止时刻（微信提醒那条路也一样跳过它，先去编辑页补个时间）`);
  }
  if (skipped.noDate) reasons.push(`${skipped.noDate} 条连日期都没有`);
  if (skipped.invalid) reasons.push(`${skipped.invalid} 条的日期或时刻格式不对`);
  if (skipped.past) reasons.push(`${skipped.past} 条已经过期了`);
  if (skipped.already) reasons.push(`${skipped.already} 条之前已经写过（不重复写第二份）`);
  if (skipped.done) reasons.push(`${skipped.done} 条已经做完了`);
  if (skipped.notDdl) reasons.push(`${skipped.notDdl} 条不是「截止」类型（日程和子任务没有"到期"这个概念）`);
  const head = total
    ? `当前 ${total} 条任务里没有可以写进日历的截止事项`
    : '当前还没有任务';
  return reasons.length ? `${head}：${reasons.join('；')}。` : `${head}。`;
}

/** 写入完成后的结果行：成功几条 + 失败几条 + 其余几条为什么没写 */
function calendarSummaryText(summary, built, leadText) {
  const added = Math.max(0, Math.floor(Number(summary && summary.added) || 0));
  const skipped = (built && built.skipped) || {};
  const notes = [`已写入 ${added} 条到手机日历${leadText ? `，按「${leadText}」提前提醒` : ''}`];
  if (summary && summary.failed) {
    const auth = summary.authDenied
      ? '：多半是你没允许「添加到日历」，去微信的「设置 → 授权管理」里打开再来一次'
      : '';
    notes.push(`有 ${summary.failed} 条没写成（${(summary && summary.firstError) || '未知原因'}）${auth}`);
  }
  if (skipped.noTime) notes.push(`另有 ${skipped.noTime} 条没填截止时刻，没写`);
  if (skipped.already) notes.push(`${skipped.already} 条之前写过，已跳过`);
  if (skipped.past) notes.push(`${skipped.past} 条已过期`);
  if (built && built.truncated) notes.push(`一次最多写 ${subscribe.CAL_MAX_EVENTS} 条，其余的过一会儿再点一次`);
  return `${notes.join('；')}。`;
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
    // 三点六 · "别让我一个个点"：静默补额度的引导 + 两个结果行（utils/tests/remind_page.test.js 用）
    remindSilentGuide: remindSilentGuide,
    roundResultText: roundResultText,
    noCalendarText: noCalendarText,
    calendarSummaryText: calendarSummaryText,
    REMIND_FUNCTION: REMIND_FUNCTION,
    REMIND_DOC: REMIND_DOC,
    REMIND_NO_TEMPLATE_TIP: REMIND_NO_TEMPLATE_TIP,
    FALLBACK_LEAD_OPTIONS: FALLBACK_LEAD_OPTIONS,
    // 导入课表 · 云函数报错翻译（utils/tests/me_import.test.js 用）
    explainCloudError: explainCloudError,
    isCourseTask: isCourseTask,
    splitCoursesAndManual: splitCoursesAndManual,
    mergePeriodTimes: mergePeriodTimes,
    isBuiltinDefault: isBuiltinDefault,
    // 节次作息 · 未校准标记与补录（utils/tests/me_periods.test.js 用）
    isUncalibrated: isUncalibrated,
    rowNumberOf: rowNumberOf,
    rowIsBreak: rowIsBreak,
    periodRowPatch: periodRowPatch,
    dropPeriodKey: dropPeriodKey,
    firstTime: firstTime,
    secondTime: secondTime,
    // AI 设置 · Key 形状与服务商匹配（utils/tests/me_ai.test.js 用）
    detectKeyProvider: detectKeyProvider,
    keyProviderHint: keyProviderHint,
    MAX_MODEL_CHARS: MAX_MODEL_CHARS,
    AI_DEFAULT_MODEL: AI_DEFAULT_MODEL,
    // 联系与反馈（utils/tests/me_contact.test.js 用）
    CONTACTS: CONTACTS,
    contactOf: contactOf,
    FEEDBACK_TEMPLATE: FEEDBACK_TEMPLATE,
  },
};
