/**
 * 云函数 remind —— DDL（截止事项）到期提醒：定时扫描 + 微信订阅消息下发。
 *
 * ===========================================================================
 * 【这个函数解决什么问题】
 * ===========================================================================
 * 「任务快到期了，用微信服务通知提醒一下」。小程序**不能**自己定时唤起，
 * 所以唯一的做法是：
 *     定时触发器（每 5 分钟）→ 扫所有开了提醒的用户 → 找出"即将到期且没提醒过"的
 *     DDL → 用云调用 openapi.subscribeMessage.send 下发订阅消息（= 微信的"服务通知"）。
 *
 * ===========================================================================
 * 【红线一：订阅消息是"用户授权一次、只能发一条"】
 * ===========================================================================
 *   1. 一次性订阅（工具类小程序基本只能用这个）：用户点一次「允许」= 攒下 1 条额度。
 *      额度存在 settings 行的 `remind_quota` 里，**发一条扣一条**。
 *   2. 额度为 0 时**绝对不能调用下发接口** —— 调了不但发不出去（43101），
 *      还可能把用户刚攒的授权白白打穿。所以扫描里 quota <= 0 的直接记
 *      `skipped: 'no_quota'` 并汇总返回，前端在用户下次进小程序时引导补授权。
 *   3. 长期订阅只对特定行业类目开放，工具类小程序一般拿不到（见 docs/到期提醒.md）。
 *
 * ===========================================================================
 * 【红线二：幂等 —— 同一个截止时刻只提醒一次】
 * ===========================================================================
 * 定时器每 5 分钟跑一轮，一轮里"还差 20 分钟到期"的任务在接下来 4 轮里都符合
 * "即将到期"的条件。防重复靠两件事：
 *   * `dueKeyOf(task)` = `"<taskId>@<date> <end_time>"` —— 幂等键；
 *   * 发之前查 `reminders` 集合里有没有这个键，发之后写一条记录。
 * 用户改了截止时间 → 键变了 → 允许再提醒一次（这是想要的语义：改期后要重新提醒）。
 *
 * ===========================================================================
 * 【红线三：时间口径统一按北京时间】
 * ===========================================================================
 * 云函数容器时区是 UTC（与 aiParse/index.js 同一口径）。ddl 的 `date` + `end_time`
 * 都是用户按北京时间填的，所以这里用 `Date.UTC(...) - BEIJING_OFFSET_MS` 合成绝对
 * 时刻，**不用 `new Date('2026-10-16 12:00')`** —— 那种写法按容器时区解释，会在
 * 00:00–08:00 整体差一天。
 *
 * ===========================================================================
 * 【结构：纯函数优先，IO 只有薄薄一层】
 * ===========================================================================
 * 判断逻辑（dueInstantOf / planReminders / buildMessageData / classifySendError …）
 * 全是纯函数并挂在 exports 上；下发走 `exports.sendSubscribeMessage` 这个**唯一出口**。
 * 好处：cloudfunctions/_selftest.js 用内存假数据库 + 打桩出口就能覆盖全部分支，
 * 不需要云环境、不需要 npm install。
 *
 * ===========================================================================
 * 【安全铁律（与 tasks / aiParse 一致）】
 * ===========================================================================
 * 用户身份只从 `cloud.getWXContext().OPENID` 取，**不接受** event 里的任何身份参数。
 * 扫描动作（scan）是定时器触发的，没有调用者身份 —— 它遍历的是"自己开了提醒"的用户，
 * 每个用户的 openid 取自 settings 行本身，前端无法借此指定要提醒谁。
 *
 * 入参：{ action, ...payload }；返回：{ ok:true, ... } 或 { ok:false, error }
 */

'use strict';

// wx-server-sdk 由云函数运行环境提供。用 try 包一层，好处是：
// 在没有云环境的机器上（例如 cloudfunctions/_selftest.js）也能 require 本文件，
// 只测里面的纯逻辑，而不会因为缺依赖直接崩掉。发送出口见 sendSubscribeMessage。
let cloud = null;
let sdkError = null;
try {
  // eslint-disable-next-line global-require
  cloud = require('wx-server-sdk');
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
} catch (error) {
  cloud = null;
  sdkError = error;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const COLLECTION_TASKS = 'tasks';
const COLLECTION_SETTINGS = 'settings';
const COLLECTION_REMINDERS = 'reminders';

/** 云数据库单次 get/remove 的硬上限（与 tasks/lib/normalize.js 的 PAGE_SIZE 同值） */
const PAGE_SIZE = 100;

/** 单次查询的翻页轮数上限：100 轮 × 100 条 = 10000 条，防止 where 写错时死循环 */
const MAX_PAGES = 100;

/** 云函数容器时区是 UTC，这里统一按北京时间（UTC+8）算 —— 与 aiParse/index.js 同口径 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 「提前多久提醒」的允许值（分钟）。24 小时是上限：再长就不是"快到期"了 */
const LEAD_MIN_OPTIONS = [15, 30, 60, 120, 1440];

/**
 * 默认提前量：一小时。
 *
 * 【为什么默认给 60 而不是 15】提醒这件事，**漏掉比早到严重得多**：
 *   * 定时器 5 分钟一轮 + 每轮都可能因为超时/抖动被跳过，窗口越窄越容易彻底漏发；
 *   * 宽限（GRACE_MS）只能救"刚好错过"的情况，救不了"整轮没跑"；
 *   * 用户嫌早就自己在页面上改成 15 / 30 —— 默认值取"宁早勿漏"这一侧。
 * 改这个值只会影响**没显式设置过 lead_min 的用户**。
 */
const DEFAULT_LEAD_MIN = 60;

/**
 * 宽限窗口（毫秒）。
 *
 * 【为什么必须留】定时器每 5 分钟跑一轮，但触发有抖动；而且如果某一轮执行超时/失败，
 * 一个"还差 2 分钟到期"的任务可能在下一轮就已经过期了。没有宽限的话它就**永远不会被提醒**。
 * 留 10 分钟：宁可晚一两分钟发，也不要彻底漏掉。
 */
const GRACE_MS = 10 * 60 * 1000;

/** 一个用户一轮扫描最多提醒几条（避免一次授权 3 条就一口气全轰出去） */
const MAX_PER_SCAN = 3;

/** 单次 scan 处理的用户数上限（防止用户量大了把云函数跑超时；剩下的下一轮继续） */
const DEFAULT_MAX_USERS = 200;

/** 查已发记录时最多取多少条（超过这个量的老记录不再参与去重，只影响很久以前的历史） */
const MAX_SENT_ROWS = 5000;

/** ack 一次只接受 1..3 次授权（微信一次最多允许勾 3 个模板位 / 客户端不能虚报更多） */
const MIN_ACK_COUNT = 1;
const MAX_ACK_COUNT = 3;

/**
 * 额度上限（条）。
 *
 * 【为什么要封顶】ack 是客户端说"用户刚授权了 N 次"，虽然服务端会校验 N ≤ 3，
 * 但反复点「允许」能无限累加，用户攒 50 条额度毫无意义（更容易变成骚扰）。
 * 封在 10 条：够用，且万一前端有 bug 也不会失控。
 */
const MAX_QUOTA = 10;

/** 错误码分类（详见 classifySendError 的注释） */
const ERROR_USER_REJECTED = 43101;
const ERROR_FIELD_INVALID = 47003;
const ERROR_TOKEN = [40001, 42001];

/**
 * 模板字段的**长度/格式约束**。
 *
 * ===========================================================================
 * 【已由真机证实：长度不是"字符数"，而是"权重"】
 * ===========================================================================
 * 2026-10-12 真机点「发一条测试提醒」，微信原样返回：
 *
 *     openapi.subscribeMessage.send fail: argument invalid data format,
 *     invalid value of property: data.thing2, should be 5-20 characters
 *     示例：{"data":{"thing2":"..."}}
 *
 * 当时发出去的值是 `提交实验报告（还剩30分钟）`：
 *   * 按**码点**数：14 个字符 —— 看着完全没超 20；
 *   * 按**权重**算（汉字/全角算 2）：提交实验报告(12) + （(2) + 还剩(4) + 30(2) + 分钟(4) + ）(2) = **26**。
 * 26 > 20，与微信那句 "should be 5-20 characters" 完全吻合。
 *
 * ⇒ **结论（本文件的长度口径）**：`thing` 类那个 "20" 是**权重**，汉字/全角标点按 2 计，
 *   数字/字母/半角符号按 1 计。所以 `thing` 的真实预算只有 **≈10 个汉字**，不是 20 个。
 *   下面所有 `max` 都按这个口径解释；判定与截断统一走 `fieldUnits()`。
 *
 * ===========================================================================
 * 【仍未最终证实的部分（照实写，别过度声明）】
 * ===========================================================================
 *   * 这次真机**只报了 `thing2`**，`date4` / `short_thing19` 没被挑错；但整条消息是被
 *     **整体拒掉**的（一个字段不合法，整条不发），所以它们只能算"没被证伪"，
 *     不算"已证实"。
 *   * `date` 的"年月日 + 时刻"（`2026年9月28日12:00`）仍未最终证实。
 *   * 其它类型的数值沿用官方示例与通行规则，没被真机验证过。
 *
 * 参考（官方只给了示例，没有可引用的类型表正文）：
 * https://developers.weixin.qq.com/miniprogram/dev/server/API/mp-message-management/subscribe-message/api_sendmessage.html
 */
const THING_MAX = 20;
const SHORT_THING_MAX = 5;
const PHRASE_MAX = 5;
const NUMBER_MAX = 32;
const CHARACTER_STRING_MAX = 32;
const AMOUNT_MAX = 12;
const NAME_MAX = 10;
const PHONE_MAX = 20;
const CAR_NUMBER_MAX = 8;
const LETTER_MAX = 6;
const SYMBOL_MAX = 5;

/**
 * 未知字段类型的兜底上限（不敢瞎猜就按最保守的 5 权重截断，并记 warning）。
 * 5 权重 ≈ 2 个汉字 + 1 个半角字符。
 */
const UNKNOWN_FIELD_MAX = SHORT_THING_MAX;

/** `date` 类型的输出形状：年月日，**不补零**，与官方示例 `2019年10月1日15:01` 一致 */
const DATE_TEXT_RE = /^\d{4}年\d{1,2}月\d{1,2}日(\d{1,2}:\d{1,2})?$/;

/**
 * 每种字段类型的约束。
 *
 *   * `max`          —— 截断上限（`Infinity` = 不截断，格式由 formatter 保证）
 *   * `allowSpace`   —— 值里能不能出现空格；不能时把空格换成 `·`
 *     （`phrase` / `short_thing` 这类短文本字段带空格容易被判参数不合法）
 *   * `awkward`      —— 这个类型**不适合**放"标题/备注"这类自由文本（只加警告，不阻止）
 *   * `formatter`    —— 该类型对输入的**形状要求**；给了就把值重塑成这个形状
 */
const FIELD_TYPE_RULES = {
  thing: { max: THING_MAX, allowSpace: true },
  short_thing: { max: SHORT_THING_MAX, allowSpace: false },
  phrase: { max: PHRASE_MAX, allowSpace: false, awkward: true },
  date: { max: Number.POSITIVE_INFINITY, allowSpace: true, formatter: (values) => values.dueDateText },
  time: { max: Number.POSITIVE_INFINITY, allowSpace: true, formatter: (values) => values.dueDateText },
  character_string: { max: CHARACTER_STRING_MAX, allowSpace: false, awkward: true },
  character: { max: THING_MAX, allowSpace: false, awkward: true }, // 字母数字关键字（与 character_string 同类）
  number: { max: NUMBER_MAX, allowSpace: true },
  letter: { max: LETTER_MAX, allowSpace: false },
  symbol: { max: SYMBOL_MAX, allowSpace: false },
  amount: { max: AMOUNT_MAX, allowSpace: false },
  name: { max: NAME_MAX, allowSpace: false },
  phone_number: { max: PHONE_MAX, allowSpace: false },
  car_number: { max: CAR_NUMBER_MAX, allowSpace: false },
};

/** 兼容旧的常量名（自测与外部引用） */
const AWKWARD_FIELD_TYPES = Object.keys(FIELD_TYPE_RULES).filter((type) => FIELD_TYPE_RULES[type].awkward);

/**
 * 默认字段映射：`模板字段名 → 语义槽位`。
 *
 * 【已对齐用户实际申请到的模板】字段名与展示顺序：
 *   `{{thing2.DATA}}` 提醒内容 → 任务标题（带"还剩 N 分钟"的尾巴）
 *   `{{date4.DATA}}`  日程时间 → 截止时刻（date 类型：`2026年9月28日12:00`）
 *   `{{short_thing19.DATA}}` 日程类别 → `截止` / `日程` / `子任务`
 *
 * 【换模板只改 `REMIND_FIELD_MAP` 环境变量】字段名是**平台侧**决定的，硬编码字段名 =
 * 换个模板就 47003；走环境变量就不用重新发版小程序、也不用改云函数代码。
 * 这个默认值只是"没配环境变量时用哪套"的兜底。
 */
const DEFAULT_FIELD_MAP = { thing2: 'title', date4: 'due', short_thing19: 'category' };

/** 语义槽位白名单（REMIND_FIELD_MAP 的值只能是这几个，其它一律忽略并给出警告） */
const SLOT_TITLE = 'title';
const SLOT_DUE = 'due';
const SLOT_LEFT = 'left';
const SLOT_CATEGORY = 'category';
const SLOTS = [SLOT_TITLE, SLOT_DUE, SLOT_LEFT, SLOT_CATEGORY];

/**
 * 任务类型 → 中文类别标签。
 *
 * 【为什么在这里硬写一份】`utils/tasks.js` 用的 `TYPE_LABELS`
 * （`{event:'日程', ddl:'截止', subtask:'子任务'}`，定义在 `utils/periods.js:38`）
 * 是**前端**的模块：云函数不能 require 前端目录（部署时只上传 `cloudfunctions/` 下的
 * 各函数目录），所以这里镜像一份，并保证与前端一致。改前端那份时记得同步这里。
 */
const TYPE_LABELS = { event: '日程', ddl: '截止', subtask: '子任务' };
const TYPE_LABEL_FALLBACK = '日程';

/**
 * 模板字段名形状与类型白名单。
 *
 * 【为什么要拆成"整体形状 + 类型白名单"两步】只用一个正则
 * `^(thing|time|...)\d+$` 是**不够的**：`thing-1` 这种写错的名字会整条匹配失败，
 * 但如果正则写成 `^(\w+?)\d+$` 又会把 `thing-1` 里的 `thing-` 当成合法类型放过。
 * 两步走：先确认"类型名 + 数字"，再确认类型名在白名单里 —— 两种错法都挡得住。
 *
 * 【注意类型名里有下划线】`short_thing19` / `character_string1` 是合法的微信字段名，
 * 所以类型名那一段必须允许 `[a-z_]+`，不能用 `[a-z]+`。
 */
const FIELD_NAME_RE = /^([a-z_]+?)(\d+)$/;
const FIELD_TYPES = Object.keys(FIELD_TYPE_RULES);

/**
 * 每个**语义槽位**渲染成什么文本（与字段类型无关 —— 类型只决定长度/格式约束）。
 *
 * 【为什么渲染文本只认槽位】"这个字段放什么数据"由映射的**值**（槽位）决定，
 * "这个字段能放多长/什么格式"由映射的**键**（字段类型）决定 —— 两件事解耦之后，
 * 用户不管选的是 `thing2` 还是 `short_thing19`，`title` 槽位给出的都是标题内容，
 * 只是被各自的规则约束（thing 20 权重、short_thing 5 权重）。
 *
 * 【`left` 槽位为什么要按类型换写法】`phrase` / `short_thing` 只有 5 权重 =
 * 2 个汉字 + 1 个半角字符，整句"还有 30 分钟到期"根本放不下，只能给 `30分钟`。
 * 判据统一是"这个类型的 `max` 放不放得下整句"，而不是逐个类型硬编码。
 *
 * 【注意】截断不在这里做 —— 统一在 buildMessageData 里按权重裁，
 * 保证"渲染"和"裁剪"两条路径不会各算一套。这里只做**长短写法的选择**。
 */
const SLOT_RENDERERS = {
  [SLOT_TITLE]: (values) => values.title,
  [SLOT_DUE]: (values) => values.due,
  [SLOT_LEFT]: (values, rule) => (rule.max <= PHRASE_MAX ? values.leftTiny : values.left),
  [SLOT_CATEGORY]: (values, rule) => (rule.max <= SHORT_THING_MAX ? values.categoryTiny : values.category),
};

/** 环境变量名 */
const ENV_TEMPLATE_ID = 'REMIND_TEMPLATE_ID';
const ENV_FIELD_MAP = 'REMIND_FIELD_MAP';
const ENV_PAGE = 'REMIND_PAGE';

/** 默认跳转页面（订阅消息被点击后打开的小程序页面） */
const DEFAULT_PAGE = '/pages/tasks/tasks';

/** 订阅消息里不出现、但写进 reminders 记录里的备注 */
const REMIND_RECORD_TYPE = 'subscribe_message';

// ---------------------------------------------------------------------------
// 基础工具（纯函数）
// ---------------------------------------------------------------------------
function toStr(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  return '';
}

function pad2(number) {
  return String(number).padStart(2, '0');
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 统一的成功返回（与 tasks 云函数同约定：payload 平铺在 {ok:true} 上，不套 data） */
function ok(payload) {
  return Object.assign({ ok: true }, payload || {});
}

/** 统一的失败返回 */
function fail(error) {
  return { ok: false, error: String(error || '未知错误') };
}

/** 时间戳 → 北京时间字符串（只用于日志，别拿去做业务判断） */
function beijingIso(ms) {
  const shifted = new Date((isFiniteNumber(ms) ? ms : Date.now()) + BEIJING_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`
    + `T${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}+08:00`;
}

/** 时间戳 → `YYYY-MM-DD HH:MM`（北京时间；我们自己日志/内部用的形状） */
function formatDueText(ms) {
  const shifted = new Date(ms + BEIJING_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`
    + ` ${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`;
}

/**
 * 时间戳 → **`date` / `time` 类模板字段要的形状**：`2026年9月28日12:00`（北京时间）。
 *
 * 【为什么不用 formatDueText 那种 `2026-09-28 12:00`】那是我们内部的形状，不是模板要求的：
 * 微信 `date` 类型的官方示例是 `2019年10月1日15:01` —— **年月日用中文、且不补零**。
 * 把内部格式直接塞进 date 字段是 47003 的常见来源。
 */
function formatDateFieldText(ms) {
  const shifted = new Date(ms + BEIJING_OFFSET_MS);
  return `${shifted.getUTCFullYear()}年${shifted.getUTCMonth() + 1}月${shifted.getUTCDate()}日`
    + `${shifted.getUTCHours()}:${pad2(shifted.getUTCMinutes())}`;
}

/** 任务类型 → 中文类别标签（与 utils/periods.js 的 TYPE_LABELS 一致） */
function typeLabelOf(type) {
  const key = toStr(type);
  return TYPE_LABELS[key] || TYPE_LABEL_FALLBACK;
}

/**
 * `date` + `HH:MM`（都按北京时间）→ 绝对毫秒。
 * 只给 `status` 造样例任务用（不参与任何业务判断，业务判断一律走 dueInstantOf）。
 */
function bjMsOfDateText(dateText, clockText) {
  const day = toStr(dateText).split('-').map(Number);
  const clock = toStr(clockText).split(':').map(Number);
  if (day.length !== 3 || clock.length !== 2) return Date.now();
  return Date.UTC(day[0], day[1] - 1, day[2], clock[0], clock[1], 0, 0) - BEIJING_OFFSET_MS;
}

/** 剩余分钟数 → 人话（`.ts` 那种，剩余分钟数本身就是整数，不做四舍五入） */
function humanizeLeft(minutesLeft) {
  const minutes = Math.max(0, Math.round(isFiniteNumber(minutesLeft) ? minutesLeft : 0));
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`;
}

/**
 * 剩余分钟数 → **短语**（给 `phrase` 类模板字段用）。
 *
 * 【为什么不能直接用 humanizeLeft】`phrase` 类字段只允许 5 个汉字、且**不允许空格**
 * （"还有 30 分钟到期"这种带空格的整句会被微信按参数不合法拒掉）。
 * 所以短语版只给"30分钟 / 1小时 / 2天"这种紧凑写法。
 */
function humanizeLeftPhrase(minutesLeft) {
  const minutes = Math.max(0, Math.round(isFiniteNumber(minutesLeft) ? minutesLeft : 0));
  if (minutes < 1) return '即将到期';
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours}小时${rest}分` : `${hours}小时`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}天${restHours}小时` : `${days}天`;
}

/**
 * 按**码点**截断（不是按 UTF-16 长度）。
 *
 * 【为什么不能直接用 slice(0, 20)】`String.prototype.slice` 按 UTF-16 码元切，
 * 一个 emoji（代理对）会被拦腰切断，留下半个代理 → 微信侧校验/显示都会出问题。
 * 任务标题里放 emoji 完全正常，所以这里按码点切。
 *
 * 【注意】这是"按字符个数"的旧口径，只用于**不涉及微信长度限制**的地方
 * （日志摘要、短文本收口）。模板字段一律用 `truncateToUnits`（权重口径）。
 */
function truncateByCodePoint(text, max) {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  // 留一个字符给省略号：被截断时总长度仍然是 max，不会因为补省略号又超限
  return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/** 省略号：截断处用它收口。**硬性按 2 权重算**（见 charUnits 里的特例说明） */
const ELLIPSIS = '…';
const ELLIPSIS_UNITS = 2;

/**
 * 一个字符占几个"权重"：**汉字与全角标点算 2，其余算 1**。
 *
 * 【依据】真机实测（见文件上方 THING_MAX 处的原始报错）：`thing` 的 "20" 是权重而不是
 * 字符数 —— 14 个字符的字符串因为含 6 个汉字 + 2 个全角括号而被算成 26 > 20 被拒。
 * 全角区段的判定沿用 Unicode East Asian Wide/Fullwidth 的常用区间写法。
 *
 * 【两个特例】
 *   1. `…`（U+2026）在 Unicode 里属于"宽度模糊"（East Asian Ambiguous），标准区间
 *      覆盖不到它。但我们**只在截断处自己产出**这个字符，且按最保守的 2 权重计预算 ——
 *      宁可少放一个字符，也不要因为一个省略号把整条消息顶超限。
 *   2. 入参先过 `toStr()`（会 trim），所以孤立的空格会算成 0；字段值本身也都是 trim 过的，
 *      不存在"值里有前导/尾随空格"的情况。
 */
function charUnits(ch) {
  const text = toStr(ch);
  if (!text) return 0;
  if (text === ELLIPSIS) return ELLIPSIS_UNITS;
  const c = text.codePointAt(0);
  if (c === undefined) return 0;
  const wide = (c >= 0x1100 && c <= 0x115f) // 韩文字母
    || c === 0x2329 || c === 0x232a
    || (c >= 0x2e80 && c <= 0xa4cf) // CJK 部首、假名、注音、CJK 统一表意文字（含全角标点）
    || (c >= 0xac00 && c <= 0xd7a3) // 韩文音节
    || (c >= 0xf900 && c <= 0xfaff) // CJK 兼容表意文字
    || (c >= 0xfe10 && c <= 0xfe19) // 竖排标点
    || (c >= 0xfe30 && c <= 0xfe6f) // CJK 兼容形式（含 ！，：；？ 等全角）
    || (c >= 0xff00 && c <= 0xff60) // 全角字母数字与标点
    || (c >= 0xffe0 && c <= 0xffe6) // 全角符号
    || (c >= 0x20000 && c <= 0x3fffd); // CJK 扩展 B 及以后
  return wide ? 2 : 1;
}

/**
 * 一段文本的**权重长度**（微信模板字段真正在数的那个数）。
 *
 * ```
 * fieldUnits('提交实验报告（还剩30分钟）') === 26   // 真机被拒的那条，钉成回归用例
 * fieldUnits('截止') === 4                        // short_thing 上限 5 → 合规
 * ```
 *
 * 按码点遍历（`Array.from`），所以 emoji（代理对）算 1 个字符、不会切坏。
 */
function fieldUnits(text) {
  let total = 0;
  Array.from(toStr(text)).forEach((ch) => { total += charUnits(ch); });
  return total;
}

/**
 * 按**权重**截断，超限处补 `…`（省略号也占 2 权重，算进预算）。
 *
 * 【为什么要"逐个吃 + 回填"而不是一次算够】一个字符的权重是 1 或 2，光靠除法估不准：
 *   * 先按 `预算 - 省略号` 把字符一个个吃进去；
 *   * 过半角字符（1 权重）时还能再塞一个，所以从**放不下的那个字符开始回填** ——
 *     否则 `子任务`(6) 在 5 预算下会退成 `子…`(3)，白白浪费 2 个权重。
 * 结果一定满足 `fieldUnits(result) <= max` —— 这是**硬保证**（有 `checkFieldCompliance` 兜底）。
 * 预算是 0 或放不下省略号时返回空串：宁可不发这一栏，也不要发一个超限的值
 * （一个字段超限，整条消息都会被微信拒掉）。实际上各类 `max` 最小也是 5，走不到这一步；
 * 留着是为了让"截断函数自己不会造出违规值"这件事没有例外。
 *
 * @returns {{text:string, units:number, truncated:boolean}}
 */
function truncateToUnits(text, max) {
  const src = toStr(text);
  const budget = Math.max(0, Math.floor(isFiniteNumber(max) ? max : 0));
  const total = fieldUnits(src);
  if (total <= budget) return { text: src, units: total, truncated: false };
  // 连省略号都放不下 → 只能给空串（硬保证优先）
  if (budget <= ELLIPSIS_UNITS) return { text: '', units: 0, truncated: true };

  // 要截断 → 末尾要放省略号，先把它从预算里扣掉
  const bodyBudget = budget - ELLIPSIS_UNITS;
  const chars = Array.from(src);
  let used = 0;
  const kept = [];
  for (let i = 0; i < chars.length; i += 1) {
    const unit = charUnits(chars[i]);
    if (used + unit > bodyBudget) break;
    kept.push(chars[i]);
    used += unit;
  }
  // 回填：剩下的预算还能塞下后续的半角字符（例如 5 预算下"子任"用掉 4，还能再放 1 个）
  for (let i = kept.length; i < chars.length; i += 1) {
    if (used + charUnits(chars[i]) + ELLIPSIS_UNITS > budget) break;
    kept.push(chars[i]);
    used += charUnits(chars[i]);
  }
  return { text: `${kept.join('')}${ELLIPSIS}`, units: used + ELLIPSIS_UNITS, truncated: true };
}

/**
 * 字段的**本地合规自检**：权重不超上限，且 date/time 类形状正确。
 * 放在这里是为了让"我以为合规"和"真的合规"用同一段代码判断。
 *
 * @returns {{ok:boolean, reason:string}}
 */
function checkFieldCompliance(key, value, max, type) {
  const units = fieldUnits(value);
  // date / time 的 max 是 Infinity（格式由 formatter 保证），只查形状
  if (Number.isFinite(max) && units > max) {
    return { ok: false, reason: `${key} 权重 ${units} 超过上限 ${max}` };
  }
  if ((type === 'date' || type === 'time') && !DATE_TEXT_RE.test(toStr(value))) {
    return { ok: false, reason: `${key}（${type} 类）值 "${toStr(value)}" 不符合年月日形状` };
  }
  return { ok: true, reason: '' };
}

/** 把配置解析成可用的计划（纯函数，IO 在 planScan 里） */
function desiredQuota(current, add) {
  const base = Math.max(0, Math.floor(isFiniteNumber(current) ? current : 0));
  const delta = Math.max(0, Math.floor(isFiniteNumber(add) ? add : 0));
  return Math.min(MAX_QUOTA, base + delta);
}

// ---------------------------------------------------------------------------
// 截止时刻 / 幂等键
// ---------------------------------------------------------------------------

/**
 * 一条 DDL 的截止**绝对时刻**（毫秒，北京时间的日历日 + 当天时刻合成）。
 *
 * 返回 null 的四种情况（都不提醒 —— 宁可不发，也不要发一条错的）：
 *   * `type !== 'ddl'`：只提醒截止事项，日程/子任务没有"到期"概念；
 *   * `done === true`：已经做完了还提醒就是骚扰；
 *   * 缺 `date` 或缺 `end_time`：没有明确时刻，无从不提醒（**不瞎猜 23:59**）；
 *   * `date` / `end_time` 非法，或 `end_time` 越过了当天（`24:00` 这种"跨天"写法）。
 *
 * @param {object} task 任务文档
 * @param {{warnings?: Array<string>}} [opts] 传入 warnings 数组时，非法数据会往里记一条
 * @returns {number|null} 毫秒时间戳
 */
function dueInstantOf(task, opts) {
  const options = opts || {};
  const warnings = Array.isArray(options.warnings) ? options.warnings : null;

  /** 记一条 warning（形如 `[remind] 任务 xxx：end_time 非法（"25:00"），跳过`） */
  const warn = (reason) => {
    if (warnings) warnings.push(`${taskIdOf(task) || '(无 id)'}：${reason}`);
  };

  if (!task || typeof task !== 'object' || Array.isArray(task)) return null;
  if (toStr(task.type) !== 'ddl') return null; // 静默跳过：这不是脏数据，是设计如此
  if (task.done === true) return null;

  const dateText = toStr(task.date);
  const timeText = toStr(task.end_time);
  if (!dateText) { warn('缺 date，跳过（不猜日期）'); return null; }
  if (!timeText) { warn('缺 end_time（ddl 的截止时刻必须在 end_time），跳过'); return null; }

  // --- 日期：必须是 YYYY-MM-DD 且真实存在（2026-02-30 要挡住，不能靠 Date 自动进位） ---
  const dateMatched = dateText.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatched) { warn(`date 格式非法（"${dateText}"，要求 YYYY-MM-DD），跳过`); return null; }
  const year = Number(dateMatched[1]);
  const month = Number(dateMatched[2]);
  const day = Number(dateMatched[3]);
  const dayUtc = Date.UTC(year, month - 1, day);

  // --- 时间：HH:MM（也接受 H:MM，与 normalize.js 的 normalizeTime 口径一致） ---
  const timeMatched = timeText.match(/^(\d{1,2}):(\d{2})$/);
  if (!timeMatched) { warn(`end_time 格式非法（"${timeText}"，要求 HH:MM），跳过`); return null; }
  const hour = Number(timeMatched[1]);
  const minute = Number(timeMatched[2]);
  if (hour > 23 || minute > 59) {
    warn(`end_time 越界（"${timeText}"，跨天请建成第二天，不在这里替用户 +1 天），跳过`);
    return null;
  }

  // 回环校验：Date.UTC 会把 2026-02-30 静默进位成 2026-03-02，必须自己发现
  const roundTrip = new Date(dayUtc);
  if (roundTrip.getUTCFullYear() !== year
    || roundTrip.getUTCMonth() + 1 !== month
    || roundTrip.getUTCDate() !== day) {
    warn(`date 不是真实日期（"${dateText}"），跳过`);
    return null;
  }

  // 【关键】按北京时间合成为绝对时刻：UTC 时间 = 本地时间 - 8 小时。
  // 写成 Date.UTC(...) - BEIJING_OFFSET_MS 而不是 new Date(date + ' ' + time)：
  // 后者按容器时区（UTC）解释，结果会整体差 8 小时。
  return dayUtc + (hour * 60 + minute) * 60 * 1000 - BEIJING_OFFSET_MS;
}

/** 截止时刻的**幂等键**：同一个任务的同一个截止时刻只会提醒一次。 */
function dueKeyOf(task) {
  if (!task || typeof task !== 'object') return '';
  const id = taskIdOf(task);
  const dateText = toStr(task.date);
  const timeText = normalizeClockText(toStr(task.end_time));
  if (!id || !dateText || !timeText) return '';
  return `${id}@${dateText} ${timeText}`;
}

/** 任务的 id（云数据库是 _id；兼容一下 id，方便前端把还没入库的对象丢进来测） */
function taskIdOf(task) {
  if (!task || typeof task !== 'object') return '';
  return toStr(task._id) || toStr(task.id);
}

/** `9:5` → `09:05`，其余原样返回（只用于拼幂等键，保证同一时刻只有一个键） */
function normalizeClockText(text) {
  const matched = text.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!matched) return text;
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  if (hour > 23 || minute > 59) return text;
  return `${pad2(hour)}:${pad2(minute)}`;
}

// ---------------------------------------------------------------------------
// 计划（纯函数）—— 决定"这一轮该给谁发哪几条"
// ---------------------------------------------------------------------------

/**
 * 从一批任务里挑出这一轮要提醒的。
 *
 * 入选条件（三条同时成立）：
 *   1. 拿得到截止时刻（见 dueInstantOf）；
 *   2. `0 <= dueAt - now <= leadMin * 60000` —— 已经过期的靠 `GRACE_MS` 兜底；
 *   3. 幂等键不在 `sentKeys` 里。
 *
 * 排除掉的会进 `skipped` 并带 `reason`，方便日志和自测断言：
 *   * `'no_due_instant'`   —— 非 ddl / 已完成 / 缺时刻 / 数据非法
 *   * `'already_sent'`     —— 幂等键命中（**这条最关键**：没有它每 5 分钟会重复轰）
 *   * `'too_early'`        —— 还早，下一轮再说
 *   * `'too_late'`         —— 过期超过宽限窗口，放弃（不再补发一条"你早就过期了"）
 *
 * @param {{now:number, tasks:Array, sentKeys:any, leadMin?:number, max?:number}} input
 * @returns {{items: Array<{task:object, dueAt:number, minutesLeft:number, dueKey:string}>,
 *            skipped: Array<{task:object, reason:string}>}}
 */
function planReminders(input) {
  const opts = input || {};
  const now = isFiniteNumber(opts.now) ? opts.now : Date.now();
  const leadMin = isFiniteNumber(opts.leadMin) && opts.leadMin > 0 ? opts.leadMin : DEFAULT_LEAD_MIN;
  const max = Number.isInteger(opts.max) && opts.max > 0 ? opts.max : MAX_PER_SCAN;
  const windowMs = leadMin * 60 * 1000;

  // sentKeys 允许传 Set / 数组 / 逗号串 —— 调用方手边是什么就给什么
  let sentKeys = opts.sentKeys;
  if (!(sentKeys instanceof Set)) {
    if (Array.isArray(sentKeys)) sentKeys = new Set(sentKeys);
    else if (typeof sentKeys === 'string' && sentKeys) sentKeys = new Set(sentKeys.split(','));
    else sentKeys = new Set();
  }

  const tasks = Array.isArray(opts.tasks) ? opts.tasks : [];
  const candidates = [];
  const skipped = [];

  tasks.forEach((task) => {
    // 每条任务单独算警告，避免一条脏数据把整轮的 warnings 淹掉；这里只收集不打印
    const warnings = [];
    const dueAt = dueInstantOf(task, { warnings });
    if (dueAt === null) {
      skipped.push({ task, reason: 'no_due_instant', detail: warnings.join('；') });
      return;
    }
    const dueKey = dueKeyOf(task);
    if (dueKey && sentKeys.has(dueKey)) {
      skipped.push({ task, reason: 'already_sent', dueKey });
      return;
    }
    const minutesLeft = Math.round((dueAt - now) / 60000);
    if (dueAt - now > windowMs) {
      skipped.push({ task, reason: 'too_early', dueAt, dueKey });
      return;
    }
    if (dueAt - now < -GRACE_MS) {
      skipped.push({ task, reason: 'too_late', dueAt, dueKey });
      return;
    }
    candidates.push({ task, dueAt, minutesLeft, dueKey });
  });

  // 按截止时刻升序：最急的先发。同一时刻时用 _id 兜底，保证顺序稳定可断言。
  candidates.sort((a, b) => {
    if (a.dueAt !== b.dueAt) return a.dueAt - b.dueAt;
    const idA = taskIdOf(a.task);
    const idB = taskIdOf(b.task);
    if (idA === idB) return 0;
    return idA < idB ? -1 : 1;
  });

  const items = candidates.slice(0, max);
  candidates.slice(max).forEach((item) => {
    skipped.push({ task: item.task, reason: 'over_scan_limit', dueAt: item.dueAt, dueKey: item.dueKey });
  });

  return { items, skipped };
}

// ---------------------------------------------------------------------------
// 模板字段（纯函数）
// ---------------------------------------------------------------------------

/**
 * 解析 `REMIND_FIELD_MAP`（JSON 字符串或对象）→ `{ ok, fieldMap, warnings }`。
 *
 * 解析失败时**回退到默认映射**而不是让整轮扫描失败：字段名对不上的后果只是 47003，
 * 而"整个提醒功能全挂"严重得多。警告会一路带到 scan 的返回里。
 */
function resolveFieldMap(raw) {
  const warnings = [];
  let parsed = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return { fieldMap: Object.assign({}, DEFAULT_FIELD_MAP), warnings };
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      warnings.push(`${ENV_FIELD_MAP} 不是合法 JSON，已回退到默认字段映射（${(error && error.message) || error}）`);
      return { fieldMap: Object.assign({}, DEFAULT_FIELD_MAP), warnings };
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    if (raw !== undefined && raw !== null && raw !== '') {
      warnings.push(`${ENV_FIELD_MAP} 不是对象，已回退到默认字段映射`);
    }
    return { fieldMap: Object.assign({}, DEFAULT_FIELD_MAP), warnings };
  }

  const fieldMap = {};
  Object.keys(parsed).forEach((field) => {
    const slot = toStr(parsed[field]);
    // 两步校验：先看形状（类型名 + 数字），再看类型名在白名单里
    const matched = field.match(FIELD_NAME_RE);
    if (!matched || FIELD_TYPES.indexOf(matched[1]) === -1) {
      warnings.push(`模板字段名 "${field}" 形状不对（应为 thing1 / time2 / date3 这种），已忽略`);
      return;
    }
    if (SLOTS.indexOf(slot) === -1) {
      warnings.push(`字段 "${field}" 的语义槽位 "${slot}" 不认识（只能是 ${SLOTS.join(' / ')}），已忽略`);
      return;
    }
    const type = matched[1];
    const rule = FIELD_TYPE_RULES[type];
    if (rule && rule.awkward) {
      warnings.push(`字段 "${field}" 是 ${type} 类型，用来放任务标题/备注这类自由文本可能被微信拒绝，`
        + '建议改用 thing / short_thing 类字段');
    }
    fieldMap[field] = slot;
  });

  if (!Object.keys(fieldMap).length) {
    warnings.push('字段映射里没有任何有效条目，已回退到默认字段映射');
    return { fieldMap: Object.assign({}, DEFAULT_FIELD_MAP), warnings };
  }
  return { fieldMap, warnings };
}

/** 模板字段名 → 字段类型（`short_thing19` → `short_thing`，`thing2` → `thing`） */
function fieldTypeOf(field) {
  const matched = toStr(field).match(FIELD_NAME_RE);
  if (matched) return matched[1];
  // 名字不合法时退回"按字母前缀猜"，至少让调用方拿到点线索（resolveFieldMap 已经拦过一道）
  return toStr(field).replace(/\d+$/, '');
}

/** 字段是否属于"不能塞自由文本"的类型（用于 47003 的排查提示） */
function isAwkwardField(field) {
  return AWKWARD_FIELD_TYPES.indexOf(fieldTypeOf(field)) !== -1;
}

/** 取某字段类型的约束（未知类型给保守兜底，不抛错） */
function ruleForType(type) {
  return FIELD_TYPE_RULES[type] || { max: UNKNOWN_FIELD_MAX, allowSpace: false, unknown: true };
}

/**
 * 把一条任务渲染成"某一个语义槽位"的完整文本（**未截断、未做类型整形**）。
 *
 * @param {string} slot 语义槽位
 * @param {object} values buildMessageData 准备好的取值表
 * @param {object} [rule] 目标字段类型的约束；决定 title/left/category 用长写法还是短写法
 * @returns {string}
 */
function slotValueOf(slot, values, rule) {
  const renderer = SLOT_RENDERERS[slot];
  if (!renderer) return '';
  return toStr(renderer(values, rule || ruleForType('thing')));
}

/**
 * 标题栏的最终取值（**不带"（还剩 N 分钟）"尾巴**）。
 *
 * ===========================================================================
 * 【为什么把尾巴去掉了 —— 不是没想到，是平台字段放不下】
 * ===========================================================================
 * 原来标题栏发的是 `提交实验报告（还剩30分钟）`。真机实测（见文件上方 THING_MAX 处的
 * 原始报错）证明 `thing` 的 20 是**权重**：这条字符串权重 = 26 > 20，被微信拒掉。
 * 也就是说 `thing` 的真实预算只有 ≈10 个汉字 ——
 *   * 尾巴 `（还剩30分钟）` 自己就占 12 权重，正好吃掉一半以上；
 *   * 加上尾巴之后，稍微长一点的标题就必然超限，**整条消息发不出去**（不是难看，是发不出）。
 * 而"还剩多久"其实**已经由 `date4`（日程时间）表达了**：用户看到"2026年9月28日12:00"
 * 就知道什么时候到期。所以这里做取舍：**保标题完整，把尾巴让出去**。
 * 真正需要"还剩 N 分钟"这种相对时间的话，应该换一个模板（有 `thing` 之外的富余字段），
 * 而不是硬塞进标题栏。
 *
 * @returns {{text:string, units:number, truncated:boolean}}
 */
function composeTitle(title, max) {
  return truncateToUnits(toStr(title) || '未命名任务', max);
}

/**
 * 紧凑剩余时间：`30分钟` / `1小时30分` / `2天3小时`（**不带空格**）。
 * 给"标题尾巴"与 `short_thing` / `phrase` 这类紧凑字段用。
 */
function humanizeLeftCompact(minutesLeft) {
  const minutes = Math.max(0, Math.round(isFiniteNumber(minutesLeft) ? minutesLeft : 0));
  if (minutes < 1) return '不到1分钟';
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours}小时${rest}分` : `${hours}小时`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}天${restHours}小时` : `${days}天`;
}

/**
 * 构造订阅消息的 `data` 对象。
 *
 * 形状：`{ thing1: { value: '交实验报告' }, time2: { value: '2026-10-16 12:00' }, ... }`
 * —— 与 `cloud.openapi.subscribeMessage.send({ data })` 的入参一致。
 *
 * 每个字段都会按**微信的字段类型规则**处理：
 *   * 渲染什么文本 → 由映射的值（语义槽位 title/due/left）决定；
 *   * 能放多长、能不能带空格 → 由映射的键（字段类型 thing/time/phrase…）决定。
 * 超长主动截断、不允许空格的类型把空格换成 `·`、date/time 类把值重塑成模板要求的形状
 * —— 全都是为了让微信**收下**这条消息，不然就是 47003：用户什么都收不到，
 * 而报错只有一行看不懂的英文。
 *
 * @param {object} task
 * @param {number} dueAt 截止时刻（毫秒）
 * @param {object|string} [fieldMap] 字段映射；不传用默认
 * @param {{now?:number}} [options] `now` 用于算"还剩多久"；不传用当前时刻
 * @returns {{data: object, fields: Array, truncated: string[], warnings: string[]}}
 *          `fields` 是**可测的留痕**：每个字段的「槽位 → key → 类型 → 最终值」。
 *          47003 排查全靠它（见 describeMessageFields）。
 */
function buildMessageData(task, dueAt, fieldMap, options) {
  const opts = options || {};
  const now = isFiniteNumber(opts.now) ? opts.now : Date.now();
  const resolved = fieldMap === undefined || fieldMap === null
    ? { fieldMap: Object.assign({}, DEFAULT_FIELD_MAP), warnings: [] }
    : resolveFieldMap(fieldMap);
  const map = resolved.fieldMap;
  const warnings = resolved.warnings.slice();

  const minutesLeft = Math.max(0, Math.round((dueAt - now) / 60000));
  const leftText = humanizeLeft(minutesLeft);
  // 标题不预截断：预算由**目标字段的类型**决定（thing 是 20 权重，short_thing 只有 5），
  // 所以截断放在下面的字段循环里，跟其它槽位走同一条路径。
  const titleText = toStr(task && task.title) || '未命名任务';
  const categoryText = typeLabelOf(task && task.type);
  const values = {
    title: titleText,
    // short_thing 只有 5 权重 = 2 个汉字，`子任务`（6 权重）会被截成 `子任…` —— 这是对的：
    // 不发出去比发一条超限被整条拒掉好。
    categoryTiny: truncateToUnits(categoryText, SHORT_THING_MAX).text,
    due: formatDueText(dueAt), // 内部形状（日志/自测用）
    dueDateText: formatDateFieldText(dueAt), // date / time 类模板字段要的形状
    left: `还有 ${leftText}到期`,
    leftTiny: truncateToUnits(`还有${humanizeLeftPhrase(minutesLeft)}`, SHORT_THING_MAX).text,
    minutesLeftText: String(minutesLeft),
    category: categoryText,
  };

  const data = {};
  const fields = [];
  const truncated = [];
  Object.keys(map).forEach((field) => {
    const slot = map[field];
    const type = fieldTypeOf(field);
    const rule = ruleForType(type);
    if (rule.unknown) {
      warnings.push(`字段 "${field}" 的类型 "${type}" 不在已知清单里，已按"原样 + 只限长度(${rule.max} 权重)"处理；`
        + '如果微信回 47003，请照 docs/到期提醒.md 的类型表核对这个字段');
    }
    const renderer = SLOT_RENDERERS[slot];
    if (!renderer) {
      // 理论上到不了这里（resolveFieldMap 已经过滤过槽位），留着当最后一道保险
      warnings.push(`字段 "${field}" 的槽位 "${slot}" 没有渲染规则，已跳过`);
      return;
    }
    // ① 先按**类型的形状要求**重塑（date/time 类在这里被改成 `2026年9月28日12:00`）
    let rendered = rule.formatter
      ? toStr(rule.formatter(values))
      : slotValueOf(slot, values, rule);
    // ② 不允许空格的类型：换成间隔号保住可读性（不换的话大概率被判参数不合法）
    if (!rule.allowSpace) rendered = rendered.replace(/\s+/g, '·');
    // ③ 按**权重**截断（汉字/全角算 2；emoji 按码点算，不会被切一半）
    const fitted = Number.isFinite(rule.max)
      ? truncateToUnits(rendered, rule.max)
      : { text: rendered, units: fieldUnits(rendered), truncated: false };
    const value = fitted.text;
    if (fitted.truncated) {
      truncated.push(`${field}（${type}）超长，已按权重口径裁到 ${rule.max} 以内`
        + `（原 ${fieldUnits(rendered)} → 现 ${fitted.units}）`);
    }
    data[field] = { value };
    // 留痕：槽位 → key → 类型 → 最终值 + 权重（自测断言 & 47003 排查都靠它）
    fields.push({ slot, key: field, type, value, max: rule.max, units: fitted.units });
    // ④ **本地合规自检**：跟"我以为合规"用同一段代码判断，别等微信回 47003 才发现
    const check = checkFieldCompliance(field, value, rule.max, type);
    if (!check.ok) {
      // 走到这里说明我们自己的截断/整形有 bug（理论上不该发生）—— 必须大声报出来
      warnings.push(`字段 "${field}" 本地自检未通过（${check.reason}），微信很可能回 47003`);
    } else if (type === 'date' || type === 'time') {
      // 形状对了也要留一句：date 的"年月日+时刻"是**仍未最终证实**的写法
      warnings.push(`字段 "${field}"（${type} 类）形状已通过本地校验，但"年月日+时刻"这种写法`
        + '尚未被真机证实（见 docs/到期提醒.md §9）；若被拒，第一顺位改法是只给日期');
    }
  });

  if (!Object.keys(data).length) warnings.push('字段映射为空，data 里没有任何字段（微信会拒绝发送）');
  return { data, fields, truncated, warnings };
}

/** 失败记录里单个字段值最多留多少字符（够定位问题，又不会把日志撑爆） */
const FIELD_VALUE_LOG_MAX = 60;

/**
 * 把 `buildMessageData` 的字段留痕压成一行可读文本（日志与失败记录都用它）。
 *
 * 【为什么需要它 —— 这是 47003 唯一的自证手段】
 * 模板字段的长度/格式约束是**平台侧**的规则，我们本地只能照着文档示例去猜，
 * 无法完全预演。所以一旦微信回 47003，必须能一眼看到"**哪个字段、发出去的是什么值**"，
 * 否则用户只能拿着"argument invalid"干瞪眼。这条信息同时写进 reminders 的失败记录，
 * 于是"事后追查"不需要再复现一次发送。
 *
 * 安全性：这些值全部来自任务自身（标题/时间/类别），**不含 openid、不含任何密钥**；
 * 仍然做一次 scrubSecrets 兜底（防将来有人把别的东西塞进来），并把单值截到 60 字符。
 *
 * @param {Array} fields buildMessageData 的 fields
 * @returns {string} 形如 `thing2=提交实验报告（还剩30分钟） | date4=2026年9月28日12:00 | short_thing19=截止`
 */
function describeMessageFields(fields) {
  const list = Array.isArray(fields) ? fields : [];
  return list.map((item) => {
    const text = scrubSecrets(toStr(item && item.value)).slice(0, FIELD_VALUE_LOG_MAX);
    return `${(item && item.key) || '?'}=${text}`;
  }).join(' | ');
}

// ---------------------------------------------------------------------------
// 错误分类（纯函数）
// ---------------------------------------------------------------------------

/** 从任意形状的错误里挖出微信错误码 */
function extractErrCode(error) {
  if (!error || typeof error !== 'object') return null;
  const candidates = [error.errCode, error.errcode, error.code];
  // 云调用的返回体有两种包法：`{errcode}` 直接给，或 `{data:{errcode}}` 套一层
  // （sendSubscribeMessage 的 response.data 就是后者）。两处都翻一遍。
  if (error.data && typeof error.data === 'object') {
    candidates.push(error.data.errCode, error.data.errcode, error.data.code);
  }
  if (error.error && typeof error.error === 'object') {
    candidates.push(error.error.errCode, error.error.errcode);
  }
  for (let i = 0; i < candidates.length; i += 1) {
    const value = candidates[i];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  }
  // 微信云调用的错误经常是 `errCode: -1` 而真正的码在 errMsg 里，例如
  // "errCode: 43101, errMsg: openapi.subscribeMessage.send:fail user refuse to accept the msg"
  const text = toStr(error.errMsg) || toStr(error.message)
    || toStr(error.data && (error.data.errMsg || error.data.errmsg));
  const matched = text.match(/(?:errCode|errcode|code)["'\s:=]+(-?\d{3,6})/);
  if (matched) return Number(matched[1]);
  return null;
}

/** 从任意形状的错误里挖出可读原文（**注意：这里不做脱敏，返回给前端的路径要过 scrubSecrets**） */
function extractErrMsg(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  const text = toStr(error.errMsg) || toStr(error.message);
  return text;
}

/**
 * 脱敏：万一微信把请求体回显在错误里，日志/返回里也不该出现完整模板内容。
 *
 * 【为什么这条不能省】错误信息最终会进 `errors` 数组返回给前端，而前端会把它显示给用户。
 * 一旦微信回显了完整的 data（里面有任务标题），就等于把用户自己的数据绕了一圈。
 * 这里**不引入任何依赖**，只做固定形状的替换（与 aiParse 的 scrubSecret 同一思路）。
 *
 * 【为什么不用 `\{[\s\S]*?\}` 去整体匹配 data】那样会把后面所有 `}` 都吞掉
 * （错误对象里往往还有别的花括号），日志会被切得看不懂。改成数组元素的形状
 * `data.thing1.value` 这种扁平引用 —— 既保住了"是哪个字段出问题"的线索，
 * 又不会把内容带出去。
 */
function scrubSecrets(text) {
  return toStr(text)
    // access_token=xxx / access_token: "xxx"
    .replace(/(access_token["'\s:=]+)([A-Za-z0-9_\-]{8,})/gi, '$1***')
    // touser / openid（用户标识不必要地出现在错误里）
    .replace(/("?(?:touser|openid|openId)"?\s*[:=]\s*"?)([A-Za-z0-9_\-]{6,})/gi, '$1***')
    // data.thing1.value=... / data[time2][value]: "..." —— 只留字段名，抹掉内容
    .replace(/(data(?:\.|\[)[A-Za-z]+\d*(?:\.value|\]\[value\])["'\]]*\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1***');
}

/**
 * 按微信错误码分类，决定"下一步怎么办"。
 *
 * | 错误码 | 含义 | 处理 |
 * | --- | --- | --- |
 * | 43101 | 用户拒收 / 没有有效授权（额度用完了或用户在设置里关了订阅） | `disableUser`：**关掉该用户的提醒**并停止重试，否则每 5 分钟白跑一次 |
 * | 47003 | 模板参数不合规（字段名对不上、超长、格式不对） | `checkFieldMap`：提示去核对 REMIND_FIELD_MAP 与字段类型 |
 * | 40001 / 42001 | access_token 无效/过期 | `retry`：重试一次（云调用会自动取 token，多为瞬时抖动） |
 * | 其它 | — | `unknown`：原样记录（脱敏后），不重试（避免放大故障） |
 *
 * @returns {{code:number|null, kind:string, retry:boolean, disableUser:boolean, checkFieldMap:boolean, hint:string}}
 */
function classifySendError(error) {
  const code = extractErrCode(error);
  const detail = scrubSecrets(extractErrMsg(error)) || '（无错误详情）';

  if (code === ERROR_USER_REJECTED) {
    return {
      code,
      kind: 'user_rejected',
      retry: false,
      disableUser: true, // 关键：不关的话这个用户每一轮都会被重试
      checkFieldMap: false,
      hint: `用户拒收或已无有效订阅授权（43101），已关闭该用户的到期提醒；用户下次进小程序可重新授权。原文：${detail}`,
    };
  }
  if (code === ERROR_FIELD_INVALID) {
    return {
      code,
      kind: 'invalid_field',
      retry: false,
      disableUser: false,
      checkFieldMap: true,
      hint: `模板参数不合规（47003）：请核对 REMIND_FIELD_MAP 里的字段名与字段类型`
        + `（thing 类 ≤${THING_MAX} 字、short_thing 类 ≤${SHORT_THING_MAX} 字、`
        + `date/time 类要年月日形状"2026年9月28日12:00"）。原文：${detail}`,
    };
  }
  if (ERROR_TOKEN.indexOf(code) !== -1) {
    return {
      code,
      kind: 'token',
      retry: true,
      disableUser: false,
      checkFieldMap: false,
      hint: `access_token 异常（${code}），将重试一次。原文：${detail}`,
    };
  }
  if (code === null) {
    // 连错误码都没有：多半是本地问题（云调用不可用 / 网络断了），原文才是唯一线索
    return {
      code: null,
      kind: 'unknown',
      retry: false,
      disableUser: false,
      checkFieldMap: false,
      hint: `下发失败且未拿到微信错误码（多为云调用不可用或网络问题，请查云函数日志）。原文：${detail}`,
    };
  }
  return {
    code,
    kind: 'unknown',
    retry: false,
    disableUser: false,
    checkFieldMap: false,
    hint: `未知错误（错误码 ${code}）。原文：${detail}`,
  };
}

/**
 * 这个失败该不该**把刚扣掉的额度还回去**？
 *
 * 【为什么必须区分】`deliverOne` 是"先扣额度再发送"，本意是"宁可少算不可多发"。
 * 但**配置/参数类**错误（47003 字段不合规、模板不存在…）在微信侧**根本没消耗额度** ——
 * 消息压根没发出去，用户的订阅授权是一次都没用掉的。这种情况下扣掉就是白扣：
 * 模板配错一次，接下来每一轮扫描（每 5 分钟）都会扣一次，
 * **几轮下来就把用户的授权次数烧光了**，等配置改对反而发不出去。
 *
 * 所以：
 *   * 配置/参数类（`checkFieldMap`：47003）→ **还**。
 *   * 未知类（含"模板不存在"这类也是 47003/47004 家族，统一按 checkFieldMap 或 unknown 看）→
 *     也**还**。理由：未知错误里绝大多数同样是"没发出去"，而多给用户一条额度只是
 *     多一次机会（前端会引导授权），远好过把授权烧光。**宁多还，不白扣。**
 *   * `user_rejected`（43101）→ **不还**：用户侧确实拒收，额度本来就是无效的。
 *   * `token`（40001/42001）→ **不还**：云调用已重试一次，属于"可能已消耗"的模糊地带，
 *     按"宁可少算"处理（这也是原设计里那条红线的方向）。
 *
 * @param {object} classified classifySendError 的产物
 * @returns {boolean}
 */
function shouldRefundQuota(classified) {
  if (!classified) return false;
  if (classified.disableUser) return false; // 43101：用户拒收
  if (classified.kind === 'token') return false; // 40001/42001：可能已消耗
  // 配置/参数类 + 未知类：都没真正发出去 → 还回去
  return true;
}

/**
 * 把 1 次额度还回去（并把"已还"写进返回，便于排查"为什么额度没少"）。
 * 任何异常都不往外抛：还款失败不该盖过"发送失败"这个主要事实。
 *
 * @returns {Promise<boolean>} 是否真的还成功
 */
async function refundQuotaOnce(db, openid, now) {
  try {
    const row = await loadSettingsRow(db, openid);
    const current = Math.max(0, Math.floor(Number(row && row.remind_quota) || 0));
    // 封顶同上限：还也不能越过总额上限
    await writeSettingsFields(db, openid, { remind_quota: Math.min(MAX_QUOTA, current + 1) }, now);
    return true;
  } catch (error) {
    console.error('[remind] 额度回退失败（不影响主流程）：', scrubSecrets((error && error.message) || error));
    return false;
  }
}

// ---------------------------------------------------------------------------
// 下发出口（**唯一的 IO 出口，自测会把它整个替换掉**）
// ---------------------------------------------------------------------------

/**
 * 真正调用微信下发订阅消息。
 *
 * 【为什么单独抽成 exports 上的函数】`cloud.openapi` 在 node 自测里根本不存在。
 * 把它固定在**一个**出口上，自测只要替换 `remind.sendSubscribeMessage` 就能跑完
 * 成功/43101/47003/40001 全部分支，而不需要真云环境。
 *
 * @param {string} openid 接收者
 * @param {string} templateId 模板 ID（从环境变量来，前端不硬编码）
 * @param {string} page 点开后跳转的页面
 * @param {object} data 模板数据（buildMessageData 的产物）
 * @returns {Promise<{ok:boolean, errCode:number|null, errMsg:string, raw:object|null}>}
 */
async function sendSubscribeMessage(openid, templateId, page, data) {
  if (!cloud || !cloud.openapi || !cloud.openapi.subscribeMessage) {
    return {
      ok: false,
      errCode: null,
      errMsg: '云调用不可用：cloud.openapi.subscribeMessage 不存在'
        + `（${sdkError ? sdkError.message : 'wx-server-sdk 未加载'}）`,
      raw: null,
    };
  }
  try {
    const response = await cloud.openapi.subscribeMessage.send({
      touser: openid,
      templateId,
      page,
      data,
      // 注意：订阅消息**没有** miniprogramState 这个参数（那是公众号模板消息的字段），
      // 多传字段会被微信按"参数不合法"拒绝（47003）。这里严格只传官方四个字段。
      lang: 'zh_CN',
    });
    // 【易错点】云调用的错误也可能以**正常返回**的形式出现（不抛异常，而是 body 里带
    // errcode）。只认 catch 会把这些失败当成功记进 reminders —— 于是"明明没收到却记成已发"，
    // 而且因为有幂等键，这条提醒再也不会重发。所以两种形状都要归一化成同一套三元组。
    const body = (response && response.data) || response || {};
    const errCode = extractErrCode(response) === null ? extractErrCode(body) : extractErrCode(response);
    if (errCode) {
      return {
        ok: false,
        errCode,
        errMsg: scrubSecrets(extractErrMsg(body) || extractErrMsg(response)),
        raw: response || null,
      };
    }
    return { ok: true, errCode: null, errMsg: '', raw: response || null };
  } catch (error) {
    return {
      ok: false,
      errCode: extractErrCode(error),
      errMsg: scrubSecrets(extractErrMsg(error)) || '云调用抛出异常',
      raw: null,
    };
  }
}

// ---------------------------------------------------------------------------
// 读库的小工具（薄 IO）
// ---------------------------------------------------------------------------

/** 分页取全（云数据库单次最多 100 条） */
async function fetchAll(query, maxRows) {
  const cap = Number.isInteger(maxRows) && maxRows > 0 ? maxRows : Infinity;
  const all = [];
  let skip = 0;
  for (let round = 0; round < MAX_PAGES; round += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await query.skip(skip).limit(PAGE_SIZE).get();
    const batch = (result && result.data) || [];
    all.push.apply(all, batch);
    if (all.length >= cap) break;
    if (batch.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
  }
  return all.length > cap ? all.slice(0, cap) : all;
}

/** 读当前用户的 settings 原始行（不套默认值，配额字段要看原样） */
async function loadSettingsRow(db, openid) {
  const result = await db.collection(COLLECTION_SETTINGS).where({ _openid: openid }).limit(1).get();
  return ((result && result.data) || [])[0] || null;
}

/**
 * 写 settings 的若干字段（update-and-set 语义：没有记录就建一条属于自己的）。
 *
 * 【为什么所有 settings 写入都走这里】对 settings 的每次写都必须带 `_openid` 条件，
 * 集中一处就不会漏；"先 update，updated===0 才显式 add"这套口径也只需要一份实现
 * （与 tasks/index.js 的 writeSettingsFields 同款约定）。
 */
async function writeSettingsFields(db, openid, fields, now) {
  const stamp = now || beijingIso(Date.now());
  const data = Object.assign({}, fields, { updated_at: stamp });
  const result = await db.collection(COLLECTION_SETTINGS).where({ _openid: openid }).update({ data });
  const updated = (result && (result.stats ? result.stats.updated : result.updated)) || 0;
  let created = 0;
  if (!updated) {
    await db.collection(COLLECTION_SETTINGS).add({
      data: Object.assign({}, data, { _openid: openid, created_at: stamp }),
    });
    created = 1;
  }
  return { updated, created };
}

/**
 * 扫描用：取"开了提醒"的 settings 行。
 *
 * 【判定口径】`remind_enabled` 必须是**真值 true**。没这个字段（老用户从没配过）
 * 一律不扫 —— 绝不默认给没授权过的人发消息（也是微信的硬要求：没授权发不出去）。
 *
 * 【边界，如实写在这里】只取一批（上界 maxUsers，默认 200 条），
 * **没有做翻页**。用户量超过这个数时，排在后面的用户要等前面的用户
 * 关掉提醒（行数降下来）才会被扫到。为什么先这样：真到了那个量级，
 * 单靠一个每 5 分钟的定时器本来就该换成"分批 + 游标"的做法，
 * 那时再改这里比现在猜一个翻页方案更靠谱。返回值里用 `scanned` 如实报出本轮处理了几个。
 */
async function fetchEnabledSettings(db, limit) {
  const cap = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_MAX_USERS;
  const result = await db.collection(COLLECTION_SETTINGS)
    .where({ remind_enabled: true })
    .limit(cap)
    .get();
  return ((result && result.data) || []).slice(0, cap);
}

/** 取某个用户最近的已发记录（用于幂等去重） */
async function fetchSentReminders(db, openid) {
  return fetchAll(db.collection(COLLECTION_REMINDERS).where({ _openid: openid }), MAX_SENT_ROWS);
}

/** 取某个用户的全部任务（ddl 的过滤放在纯函数里，这里不做条件判断） */
async function fetchMyTasks(db, openid) {
  return fetchAll(db.collection(COLLECTION_TASKS).where({ _openid: openid }));
}

/** 写一条"已发/尝试过"的记录 —— 幂等的另一半（查 + 写） */
async function recordReminder(db, fields) {
  await db.collection(COLLECTION_REMINDERS).add({ data: fields });
}

// ---------------------------------------------------------------------------
// 扫描编排
// ---------------------------------------------------------------------------

/** 把一条 task 的字段映射成调试用的一行摘要（日志里不打印完整对象，太长） */
function describeTask(task) {
  return `${taskIdOf(task) || '(无 id)'} "${toStr(task && task.title).slice(0, 12)}"`
    + ` due=${toStr(task && task.date)} ${toStr(task && task.end_time)}`;
}

/**
 * 一轮扫描的主编排。
 *
 * 【错误隔离】按用户循环，**单个用户失败只记进 errors，绝不中断整轮**。
 * 一个用户的脏数据 / 一次网络抖动，不应该让排在后面的所有用户都收不到提醒。
 *
 * @param {object} input
 * @param {object} input.db 云数据库实例
 * @param {number} input.now 当前时刻（毫秒）—— 注入进来是为了自测能固定时间
 * @param {number} input.leadMin 提前量（分钟）
 * @param {string} input.templateId 模板 ID（空串 = 没配置）
 * @param {string} input.page 点击后跳转的页面
 * @param {object|string} input.fieldMap 字段映射
 * @param {number} [input.maxPerScan] 单用户单轮上限
 * @param {number} [input.maxUsers] 单轮最多处理多少用户
 * @returns {Promise<{ok, scanned, sent, skipped, failed, errors, warnings, details}>}
 */
async function planScan(input) {
  const opts = input || {};
  const db = opts.db;
  const now = isFiniteNumber(opts.now) ? opts.now : Date.now();
  const leadMin = isFiniteNumber(opts.leadMin) && opts.leadMin > 0 ? opts.leadMin : DEFAULT_LEAD_MIN;
  const templateId = toStr(opts.templateId);
  const page = toStr(opts.page) || DEFAULT_PAGE;
  const maxPerScan = Number.isInteger(opts.maxPerScan) && opts.maxPerScan > 0
    ? opts.maxPerScan : MAX_PER_SCAN;
  const maxUsers = Number.isInteger(opts.maxUsers) && opts.maxUsers > 0
    ? opts.maxUsers : DEFAULT_MAX_USERS;

  const fieldMapResolved = resolveFieldMap(opts.fieldMap);
  const warnings = fieldMapResolved.warnings.slice();
  const errors = [];
  const details = [];
  const skippedReasons = {};
  let scanned = 0;
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let quotaRefunded = 0;

  const countSkip = (reason) => {
    skipped += 1;
    skippedReasons[reason] = (skippedReasons[reason] || 0) + 1;
  };

  // --- 没配模板就别扫了：扫了也发不出去，只会白跑一遍数据库 ---
  if (!templateId) {
    return {
      ok: false,
      error: `服务端还没配置订阅消息模板 ID（环境变量 ${ENV_TEMPLATE_ID}），本轮未扫描、未下发`,
      scanned: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      warnings,
      skipped_reasons: skippedReasons,
      details,
    };
  }

  let rows = [];
  try {
    rows = await fetchEnabledSettings(db, maxUsers);
  } catch (error) {
    // 连用户列表都读不到：这是**全局性**故障（集合不存在 / 权限问题），如实报错
    return {
      ok: false,
      error: `读取 settings 失败（请确认 ${COLLECTION_SETTINGS} 集合已创建）：`
        + `${scrubSecrets((error && error.message) || error)}`,
      scanned: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      warnings,
      skipped_reasons: skippedReasons,
      details,
    };
  }

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] || {};
    const openid = toStr(row._openid);
    scanned += 1;
    if (!openid) {
      // settings 行没有 _openid：正常不该发生（客户端写入时云数据库会自动带），跳过并记账
      failed += 1;
      errors.push(`第 ${i + 1} 条 settings 缺少 _openid，已跳过（无法确定提醒谁）`);
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const planned = await planForUser({ db, openid, row, now, leadMin, maxPerScan });
      planned.skipped.forEach((item) => countSkip(item.reason));

      if (!planned.items.length) {
        // eslint-disable-next-line no-continue
        continue;
      }

      let quota = planned.quota;
      for (let j = 0; j < planned.items.length; j += 1) {
        const item = planned.items[j];
        if (quota <= 0) {
          // 【红线】额度为 0 时绝不调用下发接口，只记账，让前端下次引导补授权
          countSkip('no_quota');
          details.push({ openid, task_id: taskIdOf(item.task), action: 'skipped', reason: 'no_quota' });
          // eslint-disable-next-line no-continue
          continue;
        }

        const built = buildMessageData(item.task, item.dueAt, fieldMapResolved.fieldMap, { now });
        // 字段留痕带进下发：失败时它会被写进 reminders 记录与日志（47003 唯一的自证手段）
        const sendInput = {
          openid,
          templateId,
          page,
          data: built.data,
          fields: built.fields,
          task: item.task,
          dueKey: item.dueKey,
          dueAt: item.dueAt,
        };
        // eslint-disable-next-line no-await-in-loop
        const outcome = await deliverOne(db, sendInput, now);

        if (outcome.status === 'sent') {
          sent += 1;
          quota -= 1;
        } else if (outcome.status === 'skipped') {
          countSkip(outcome.reason);
        } else {
          failed += 1;
          if (outcome.error) errors.push(outcome.error);
          // 配置/参数类失败会把额度退回去 —— 汇总出来，便于确认"模板配错不烧额度"
          if (outcome.quota_refunded) quotaRefunded += 1;
        }
        // 成功/失败都留明细：这张表就是"为什么这条没收到提醒"的答案
        if (outcome.detail) details.push(outcome.detail);
      }
    } catch (error) {
      // 单个用户失败 → 记账后继续下一个用户（整轮扫描不中断）
      failed += 1;
      errors.push(`用户 ${maskOpenid(openid)} 处理失败：${scrubSecrets((error && error.message) || error)}`);
    }
  }

  return {
    ok: true,
    scanned, // 扫了多少个"开了提醒"的用户
    sent, // 成功下发几条
    skipped, // 跳过几条（含 no_quota / already_sent / too_early …）
    failed, // 失败几条（含业务失败与异常）
    quota_refunded: quotaRefunded, // 其中有几次把占用的额度退回去了（配置类失败）
    errors, // 失败原因（已脱敏）
    warnings, // 配置类提醒（字段映射、截断等）
    skipped_reasons: skippedReasons,
    details, // 逐条明细，便于用日志排查"为什么没收到"
    lead_min: leadMin,
    now: beijingIso(now),
  };
}

/** 为一个用户算"这一轮要发哪几条"（读库 + 纯函数计划） */
async function planForUser(input) {
  const { db, openid, row, now, leadMin, maxPerScan } = input;

  // ① 该用户的 ddl 任务（type 过滤交给纯函数，读库不做条件判断）
  const tasks = await fetchMyTasks(db, openid);

  // ② 已经**成功**发过的幂等键
  // 【为什么必须是 sentKeysFromRows 而不是直接收 due_key】失败记录（47003/43101）
  // 也落在同一张表里。如果把它们也算作"已提醒"，那用户把模板字段改对之后，
  // 这条提醒就永远发不出去了 —— 那是最难查的一类 bug。
  const sentRows = await fetchSentReminders(db, openid);
  const sentKeys = sentKeysFromRows(sentRows);

  // ③ 额度：settings 行里的 remind_quota（用户授权一次 = 1 条，发送成功后 -1）
  const quota = Math.max(0, Math.floor(Number(row && row.remind_quota) || 0));

  // ④ 计划（纯函数）
  const planned = planReminders({ now, tasks, sentKeys, leadMin, max: maxPerScan });
  return { items: planned.items, skipped: planned.skipped, quota, sentKeys };
}

/**
 * 下发一条并落记录。
 *
 * 【顺序很重要】先扣额度、再发送。理由：如果"发送成功但扣额度失败"，用户会白得一条额度
 * （无所谓）；反过来"发送失败但没扣额度"会导致下一轮又发一遍（骚扰）。宁可少算，不可多发。
 * 因为额度用绝对写（读到的值 -1），所以这里只需要一次 update，不需要 `inc` 指令。
 *
 * @returns {Promise<{status:'sent'|'failed'|'skipped', reason?:string, error?:string, detail?:object}>}
 */
async function deliverOne(db, info, now) {
  // `fields` 是 buildMessageData 的字段留痕：只在**失败**路径用到（写进记录 + 打日志）
  const { openid, templateId, page, data, fields, task, dueKey } = info;
  const taskId = taskIdOf(task);

  // --- 先扣额度，再发送 ---
  // 【为什么读一次、写绝对值，而不是 `db.command.inc(-1)`】
  //  1. 必须先知道"还剩几条"才能决定要不要发（quota 0 时**绝不能**调用下发接口）；
  //  2. 绝对写让这一段的语义完全可测（内存假数据库不需要支持 inc 指令），
  //     而 inc 的原子性优势在这里并不关键：定时器每 5 分钟才跑一轮，
  //     同一用户的并发扫描窗口重叠可以忽略。
  try {
    const row = await loadSettingsRow(db, openid);
    const current = Math.max(0, Math.floor(Number(row && row.remind_quota) || 0));
    if (current <= 0) return { status: 'skipped', reason: 'no_quota' };
    await writeSettingsFields(db, openid, { remind_quota: current - 1 }, now);
  } catch (error) {
    // 扣额度都失败 → 不发送（宁可漏一条，也不要出现"额度失控"）
    return {
      status: 'failed',
      error: `扣减额度失败，已跳过下发：${scrubSecrets((error && error.message) || error)}`,
      detail: { openid, task_id: taskId, action: 'failed', phase: 'quota', due_key: dueKey },
    };
  }

  const result = await exports.sendSubscribeMessage(openid, templateId, page, data);
  const classified = classifySendError(result.ok ? null : {
    errCode: result.errCode,
    errMsg: result.errMsg,
  });

  if (result.ok) {
    await safeRecord(db, {
      _openid: openid,
      task_id: taskId,
      due_key: dueKey,
      sent_at: beijingIso(now),
      template_id: templateId,
      type: REMIND_RECORD_TYPE,
      ok: true,
      error: '',
    });
    return {
      status: 'sent',
      detail: { openid, task_id: taskId, action: 'sent', due_key: dueKey },
    };
  }

  // --- 失败：落一条 ok:false 的记录 ---
  // 【为什么要记失败】47003 这类"配置错"必须留痕，否则用户只会看到"没收到提醒"，
  // 完全没有线索。记下来之后再有人问"为什么没发出去"，查 reminders 集合就有答案。
  //
  // 【为什么要连字段和值一起记 —— 这是唯一的自证手段】模板字段的长度/格式约束是
  // **平台侧**的规则：我们本地照着文档示例去猜，无法完全预演（`date4` 到底收不收
  // "2026年9月28日12:00" 这种带时刻的形状，只有真机发一次才知道）。所以出错时
  // 必须把"**哪个字段、发出去的是什么值**"留下来 —— 否则用户拿着 "argument invalid"
  // 完全无法判断该改映射还是该改格式。值来自任务自身，不含 openid / 密钥（见
  // describeMessageFields 的注释）。
  const fieldTrace = describeMessageFields(fields);
  const failureText = fieldTrace ? `${classified.hint} 本次发出的字段与值：${fieldTrace}` : classified.hint;

  // --- 配置/参数类失败：把刚才扣掉的额度还回去 ---
  // 【为什么】这类错误在微信侧**根本没消耗额度**（消息没发出去），扣掉就是白扣；
  // 模板配错一次会让接下来每轮扫描都白扣一次，几轮就把用户的授权烧光。
  const refunded = shouldRefundQuota(classified) ? await refundQuotaOnce(db, openid, now) : false;

  await safeRecord(db, {
    _openid: openid,
    task_id: taskId,
    due_key: dueKey,
    sent_at: beijingIso(now),
    template_id: templateId,
    type: REMIND_RECORD_TYPE,
    ok: false,
    error: failureText,
    err_code: classified.code,
    // 额度有没有还回去，记在案上（否则"为什么额度没少"会变成一个查不出来的谜）
    quota_refunded: refunded,
    // 单独存一份结构化的，便于在控制台里逐字段核对（比在长字符串里找更省事）
    sent_fields: (Array.isArray(fields) ? fields : []).map((item) => ({
      key: item.key, type: item.type, slot: item.slot, value: toStr(item.value).slice(0, FIELD_VALUE_LOG_MAX),
    })),
  });
  // 日志里也打一份：47003 排查时通常先看云函数日志，而不是先去翻数据库
  if (fieldTrace) {
    console.warn(`[remind] 下发失败（err_code=${classified.code}，额度已回退=${refunded}），`
      + `本次字段与值：${fieldTrace}`);
  }

  if (classified.disableUser) {
    // 43101：用户那边已经拒收/没授权了，继续每 5 分钟重试纯属白跑，直接关掉开关。
    // 【注意】**不写 due_key 到"已发"语义里** —— 用户重新授权后应该还能收到这条提醒，
    // 所以这条失败记录在下一轮会因为 ok:false 被 planForUser 忽略（见 fetchSentReminders 的用法）。
    try {
      await writeSettingsFields(db, openid, {
        remind_enabled: false,
        remind_disabled_reason: classified.hint,
      }, now);
    } catch (error) {
      // 关开关都失败：如实记进 errors，但不抛（本轮其它用户还要继续）
      return {
        status: 'failed',
        error: `${classified.hint}（另外：关闭提醒开关失败 ${scrubSecrets((error && error.message) || error)}）`,
        detail: { openid, task_id: taskId, action: 'disabled_failed', due_key: dueKey },
      };
    }
  }

  // 返回值里**也要**带字段与值：控制台点一次"云端测试"就能直接看到该改哪个字段，
  // 不必再去翻数据库或日志（这是 47003 排查最短的那条路径）。
  return {
    status: 'failed',
    error: `${describeTask(task)}：${classified.hint}`
      + (fieldTrace ? `；本次发出的字段与值：${fieldTrace}` : '')
      + (refunded ? '；已把这次占用的额度退回' : ''),
    // quota_refunded 让调用方（scan）能汇总"这轮退了几次"，便于确认"模板配错不会烧额度"
    quota_refunded: refunded,
    detail: {
      openid,
      task_id: taskId,
      action: classified.disableUser ? 'user_disabled' : 'failed',
      err_code: classified.code,
      due_key: dueKey,
      quota_refunded: refunded,
    },
  };
}

/** 落记录：失败不影响主流程（记录只是"账本"，不该让提醒本身失败） */
async function safeRecord(db, fields) {
  try {
    await recordReminder(db, fields);
  } catch (error) {
    console.error('[remind] 写 reminders 记录失败：', scrubSecrets((error && error.message) || error));
  }
}

/** 日志里不要出现完整 openid（前 6 后 4 保留，够定位人） */
function maskOpenid(openid) {
  const text = toStr(openid);
  if (text.length <= 10) return text ? '***' : '';
  return `${text.slice(0, 6)}***${text.slice(-4)}`;
}

/**
 * 幂等去重的正确口径：**只有成功的记录才算"已提醒"**。
 *
 * 【为什么要单独一个函数】`fetchSentReminders` 会把失败记录也取回来（排查用）。
 * 如果拿全量记录当 sentKeys，一条 47003 失败之后用户改好了模板，这条提醒就再也发不出来了。
 * 所以过滤逻辑单独抽出来，自测里直接断言它。
 */
function sentKeysFromRows(rows) {
  const keys = new Set();
  (Array.isArray(rows) ? rows : []).forEach((record) => {
    if (!record || record.ok !== true) return;
    const key = toStr(record.due_key);
    if (key) keys.add(key);
  });
  return keys;
}

// ---------------------------------------------------------------------------
// 环境 / 上下文
// ---------------------------------------------------------------------------

/** 取当前调用者的 openid（唯一可信来源；定时器触发时为空） */
function currentOpenId() {
  if (!cloud) return '';
  try {
    const context = cloud.getWXContext() || {};
    return toStr(context.OPENID);
  } catch (error) {
    return '';
  }
}

/** 读环境变量（允许从 deps.env 注入，方便自测时换配置） */
function readEnv(deps, name) {
  const injected = deps && deps.env;
  if (injected && Object.prototype.hasOwnProperty.call(injected, name)) return injected[name];
  return process.env[name];
}

/** 模板 ID：只从云函数环境变量来 —— 前端不硬编码模板 ID，也就换不了模板 */
function templateIdFrom(deps) {
  return toStr(readEnv(deps, ENV_TEMPLATE_ID));
}

function pageFrom(deps) {
  return toStr(readEnv(deps, ENV_PAGE)) || DEFAULT_PAGE;
}

/**
 * 环境是否"能发"：[ready, ready_reason]。reason 必须是**人话**，前端直接展示。
 *
 * 【只判模板 ID，不判云调用可用性】`cloud` / `cloud.openapi` 在 node 自测里天然是
 * 不存在的（那是云环境注入的）。如果把它也当成"没配置"，自测里所有测试动作都会
 * 在第一道门就被挡掉 —— 于是**真正要测的下发分支一条都跑不到**。
 * 云调用不可用时会由 sendSubscribeMessage 返回一条明确的错误，走正常失败路径，
 * 同样能说清原因（见 classifySendError 的 code===null 分支）。
 */
function envReadiness(deps) {
  if (!templateIdFrom(deps)) {
    return [false, `服务端还没配置订阅消息模板 ID（请在云开发控制台给 remind 云函数加环境变量 ${ENV_TEMPLATE_ID}）`];
  }
  return [true, ''];
}

// ---------------------------------------------------------------------------
// 各 action 的实现
// ---------------------------------------------------------------------------

/**
 * status：给前端看的"这个用户现在能不能收到提醒"。
 *
 * 【前端要靠它拿 template_id 去弹授权窗】所以模板 ID 必须在这里透出来 ——
 * 小程序端不硬编码模板 ID，换模板只改云函数环境变量。
 *
 * @returns {Promise<{ok, enabled, lead_min, quota, template_id, ready, ready_reason,
 *                    has_authorized, page, field_map, lead_options, max_per_scan}>}
 */
async function actionStatus(db, openid, deps) {
  const row = await loadSettingsRow(db, openid);
  const templateId = templateIdFrom(deps);
  const quota = Math.max(0, Math.floor(Number(row && row.remind_quota) || 0));
  const enabled = !!(row && row.remind_enabled === true);
  const leadMin = LEAD_MIN_OPTIONS.indexOf(Number(row && row.lead_min)) !== -1
    ? Number(row.lead_min) : DEFAULT_LEAD_MIN;
  const [envReady, envReason] = envReadiness(deps);

  // 【ready 的语义】= "现在点一下就能收到一条提醒"。三个条件缺一不可：
  // 服务端配好了模板 + 用户开了开关 + 手上还有额度。
  // ready_reason 每一句都能直接甩给用户看，且都指向"下一步该做什么"。
  let ready = false;
  let readyReason = '';
  if (!envReady) {
    readyReason = envReason;
  } else if (!enabled) {
    readyReason = '你还没开启到期提醒（打开开关后，微信会弹一次订阅授权）';
  } else if (quota <= 0) {
    readyReason = '授权次数已用完：一次性订阅是"授权一次只能发一条"，请重新点一次开启以补充授权';
  } else {
    ready = true;
    readyReason = `已就绪：还能下发 ${quota} 条`;
  }

  const fieldMapResolved = resolveFieldMap(readEnv(deps, ENV_FIELD_MAP));
  // 【为什么 status 里也要跑一遍 buildMessageData】字段名对不对、类型约束满足不满足，
  // 是**上线前唯一能自查的东西**：这里用一条样例任务算出"真发出去会是什么样"，
  // 前端/后台一眼就能对着微信后台的模板核对，不用等真机收到 47003 才发现。
  // 用样例任务（不是真实任务）是为了不泄露任何用户数据，且不受"有没有 ddl"影响。
  const sampleTask = { title: '提交实验报告', type: 'ddl', date: '2026-09-28', end_time: '12:00' };
  const sampleBuilt = buildMessageData(sampleTask, bjMsOfDateText('2026-09-28', '12:00'),
    fieldMapResolved.fieldMap, { now: Date.now() });
  return ok({
    enabled,
    lead_min: leadMin,
    lead_options: LEAD_MIN_OPTIONS.slice(),
    quota,
    max_quota: MAX_QUOTA,
    template_id: templateId,
    page: pageFrom(deps),
    ready,
    ready_reason: readyReason,
    has_authorized: quota > 0 || enabled,
    field_map: fieldMapResolved.fieldMap,
    // 这个模板/映射组合下"实际会发出去什么"（调试用；值来自样例任务，不含用户数据）
    field_preview: sampleBuilt.fields,
    field_preview_text: describeMessageFields(sampleBuilt.fields),
    field_types: fieldMapResolved.fieldMap
      ? Object.keys(fieldMapResolved.fieldMap).reduce((acc, key) => {
        acc[key] = fieldTypeOf(key);
        return acc;
      }, {})
      : {},
    disabled_reason: toStr(row && row.remind_disabled_reason),
    max_per_scan: MAX_PER_SCAN,
    grace_min: Math.round(GRACE_MS / 60000),
    config_warnings: fieldMapResolved.warnings.concat(sampleBuilt.warnings),
  });
}

/**
 * ack：客户端 `wx.requestSubscribeMessage` 成功后调用，把可下发次数 +N。
 *
 * 【为什么要服务端校验 N】ack 完全由客户端发起，如果不校验，一个改过的客户端
 * 就能把自己刷成"无限额度"，等于把用户额度打穿的门打开了。这里只接受 1..3
 * （微信一次授权最多也就 3 条），并且总额封顶 MAX_QUOTA。
 *
 * @param payload {{count?:number, lead_min?:number}} count 默认 1
 */
async function actionAck(db, openid, payload, deps) {
  const count = payload && payload.count === undefined ? 1 : payload.count;
  // 【为什么用"原始值的 typeof"判定而不是 Number(count)】`Number('3')` 是 3，
  // 于是 `count: "3"` 这种字符串会被静默接受 —— 而 ack 是**唯一**能给额度加数的入口，
  // 这里必须"只认数字"，序列化给它的字符串一律当成写错了（宁可让调用方当场发现）。
  if (typeof count !== 'number' || !Number.isInteger(count)
    || count < MIN_ACK_COUNT || count > MAX_ACK_COUNT) {
    return fail(`count 只能是 ${MIN_ACK_COUNT}..${MAX_ACK_COUNT} 之间的**数字**（一次授权最多 ${MAX_ACK_COUNT} 条），`
      + `收到：${JSON.stringify(payload && payload.count === undefined ? null : payload.count)}`);
  }

  const now = beijingIso(Date.now());
  const row = await loadSettingsRow(db, openid);
  const current = Math.max(0, Math.floor(Number(row && row.remind_quota) || 0));
  const next = desiredQuota(current, count);

  const fields = {
    remind_enabled: true,
    remind_quota: next,
    remind_authorized_at: now,
    remind_disabled_reason: '', // 重新授权即清除"上次被关掉"的原因
  };
  // 顺手允许在这里改提前量：前端"开启提醒"弹窗里通常会带一个选项
  const leadMin = Number(payload && payload.lead_min);
  if (payload && payload.lead_min !== undefined) {
    if (LEAD_MIN_OPTIONS.indexOf(leadMin) === -1) {
      return fail(`lead_min 只能是 ${LEAD_MIN_OPTIONS.join(' / ')} 之一（分钟），收到：${JSON.stringify(payload.lead_min)}`);
    }
    fields.lead_min = leadMin;
  }

  await writeSettingsFields(db, openid, fields, now);
  console.log(`[remind] ack：+${count} 条授权（额度 ${current} → ${next}），已开启提醒`);
  return ok({
    enabled: true,
    quota: next,
    added: next - current, // 因为总额封顶，实际加上的可能比 count 少，如实返回
    capped: next - current < count,
    max_quota: MAX_QUOTA,
    lead_min: fields.lead_min === undefined
      ? (LEAD_MIN_OPTIONS.indexOf(Number(row && row.lead_min)) !== -1 ? Number(row.lead_min) : DEFAULT_LEAD_MIN)
      : fields.lead_min,
  });
}

/**
 * config：改「提前多久提醒」与开关。
 *
 * 【为什么 lead_min 走白名单而不是"随便填个数"】提前量直接决定扫描窗口：
 * 填 100000 就把整学期的 ddl 全变成"即将到期"，一轮全发出去。白名单只给
 * 15/30/60/120/1440 五档，非法值**拒绝并列全允许值**（不静默改成默认值 ——
 * 那样用户会以为设置生效了）。
 */
async function actionConfig(db, openid, payload, deps) {
  const fields = {};
  const now = beijingIso(Date.now());

  if (payload && payload.lead_min !== undefined) {
    const leadMin = Number(payload.lead_min);
    if (LEAD_MIN_OPTIONS.indexOf(leadMin) === -1) {
      return fail(`lead_min 只能是 ${LEAD_MIN_OPTIONS.join(' / ')} 之一（分钟），收到：${JSON.stringify(payload.lead_min)}`);
    }
    fields.lead_min = leadMin;
  }

  if (payload && payload.enabled !== undefined) {
    if (typeof payload.enabled !== 'boolean') {
      return fail(`enabled 只能是 true / false，收到：${JSON.stringify(payload.enabled)}`);
    }
    fields.remind_enabled = payload.enabled;
    // 用户主动关掉时不写 disabled_reason（那是"系统关的"才写）
    if (payload.enabled) fields.remind_disabled_reason = '';
  }

  if (!Object.keys(fields).length) {
    return fail('没有要改的字段：请给 lead_min 或 enabled');
  }

  await writeSettingsFields(db, openid, fields, now);
  const row = await loadSettingsRow(db, openid);
  const quota = Math.max(0, Math.floor(Number(row && row.remind_quota) || 0));
  return ok({
    enabled: !!(row && row.remind_enabled === true),
    lead_min: LEAD_MIN_OPTIONS.indexOf(Number(row && row.lead_min)) !== -1
      ? Number(row.lead_min) : DEFAULT_LEAD_MIN,
    quota,
    template_id: templateIdFrom(deps),
  });
}

/**
 * test：给当前用户**立刻**发一条测试提醒（用来验证模板字段对不对）。
 *
 * 【额度语义：默认不消耗】它是"验证配置"的动作，而不是一次真实的到期提醒。
 * 消耗额度会让用户在"配置阶段"就把额度试光，然后真正到期时反而发不出去。
 * 但为了排除"额度为 0 却发出去了"的错觉，返回值里显式写清 `quota_consumed:false`，
 * 同时给出"真实下发时会不会因为额度为 0 被跳过"的提示。客户端可以传
 * `{ consume_quota: true }` 强制按真实路径走（消耗额度、走同一套幂等/记录）。
 */
async function actionTest(db, openid, payload, deps) {
  const [envReady, envReason] = envReadiness(deps);
  if (!envReady) return fail(envReason);

  const now = isFiniteNumber(deps && deps.now) ? deps.now : Date.now();
  const templateId = templateIdFrom(deps);
  const page = pageFrom(deps);
  const consumeQuota = !!(payload && payload.consume_quota === true);
  const fieldMapResolved = resolveFieldMap(readEnv(deps, ENV_FIELD_MAP));

  // 用一条**不会入库**的假任务：title 里带上时间戳，便于在微信里区分是"刚才那条测试"
  const leadMin = 30;
  const task = {
    _id: `test_${now}`,
    title: '【测试】到期提醒',
    type: 'ddl',
    date: formatDueText(now).slice(0, 10),
    end_time: formatDueText(now).slice(11, 16),
    done: false,
  };
  const dueAt = now + leadMin * 60 * 1000;
  // 用 now 算"还剩多久"（测试消息的剩余时间是固定的 30 分钟，便于对照）
  const built = buildMessageData(task, dueAt, fieldMapResolved.fieldMap, { now });
  const fieldTrace = describeMessageFields(built.fields);

  let quota = 0;
  try {
    const row = await loadSettingsRow(db, openid);
    quota = Math.max(0, Math.floor(Number(row && row.remind_quota) || 0));
  } catch (error) {
    return fail(`读取提醒配置失败：${scrubSecrets((error && error.message) || error)}`);
  }
  if (consumeQuota && quota <= 0) {
    // 与扫描同一口径：绝不出现"额度 0 还去下发"
    return fail('当前可下发次数为 0，测试消息会消耗 1 条额度，已在调用微信之前中止（请先授权）');
  }

  const data = built.data;
  // 真机排查时先看日志：字段与值在这一行里
  console.log(`[remind] test：即将下发，字段与值：${fieldTrace}`);
  const result = await exports.sendSubscribeMessage(openid, templateId, page, data);
  const classified = classifySendError(result.ok ? null : {
    errCode: result.errCode,
    errMsg: result.errMsg,
  });

  if (!result.ok) {
    // 测试失败**照样落记录**：这正是排查模板字段问题最需要的线索。
    // 记录里必须带上"哪个字段、发了什么值"——这是 47003 唯一的自证手段。
    //
    // 注意这里**没有**先扣额度（测试路径是"发送成功后才扣"），所以不需要回退；
    // 真机第一次 47003 那次的经验已经写进 shouldRefundQuota 的注释里。
    await safeRecord(db, {
      _openid: openid,
      task_id: task._id,
      due_key: `${task._id}@test`,
      sent_at: beijingIso(now),
      template_id: templateId,
      type: 'test',
      ok: false,
      error: `${classified.hint} 本次发出的字段与值：${fieldTrace}`,
      err_code: classified.code,
      sent_fields: built.fields.map((item) => ({
        key: item.key, type: item.type, slot: item.slot, value: toStr(item.value).slice(0, FIELD_VALUE_LOG_MAX),
      })),
    });
    console.warn(`[remind] test 下发失败（err_code=${classified.code}），本次字段与值：${fieldTrace}`);
    return fail(`测试下发失败：${classified.hint}；本次发出的字段与值：${fieldTrace}`);
  }

  if (consumeQuota) {
    await writeSettingsFields(db, openid, { remind_quota: Math.max(0, quota - 1) }, now);
  }

  return ok({
    sent: true,
    quota_consumed: consumeQuota,
    quota: consumeQuota ? Math.max(0, quota - 1) : quota,
    template_id: templateId,
    page,
    field_map: fieldMapResolved.fieldMap,
    // 把**真正发出去的 data** 回给前端：模板字段对不上时，前端可以拿它和
    // 微信后台模板的字段名逐一对照 —— 这是排查 47003 最直接的办法
    preview: data,
    // 留痕明细：槽位 → key → 类型 → 最终值（比 preview 更适合逐条核对）
    fields: built.fields,
    fields_text: fieldTrace,
    truncated: built.truncated,
    warnings: built.warnings.concat(fieldMapResolved.warnings),
  });
}

/**
 * scan：定时触发器入口（无 action 时也当 scan，方便在控制台手点测试）。
 *
 * 【为什么无 action 也当 scan】云开发的定时触发器会往云函数塞一个
 * `{Type:'Timer', TriggerName:...}` 形状的 event，没有 action 字段。
 * 手动在控制台点"测试"时也常常是空 event。两种都当 scan，省得配两套。
 */
async function actionScan(db, openid, payload, deps) {
  const now = isFiniteNumber(deps && deps.now) ? deps.now : Date.now();
  const leadMinOverride = Number(payload && payload.lead_min);
  const summary = await planScan({
    db,
    now,
    leadMin: LEAD_MIN_OPTIONS.indexOf(leadMinOverride) !== -1 ? leadMinOverride : DEFAULT_LEAD_MIN,
    templateId: templateIdFrom(deps),
    page: pageFrom(deps),
    fieldMap: readEnv(deps, ENV_FIELD_MAP),
    maxUsers: DEFAULT_MAX_USERS,
  });

  // 日志里汇总一行，方便在云函数日志里一眼看出本轮干了什么
  console.log(`[remind] scan：扫描用户 ${summary.scanned}，下发 ${summary.sent}，跳过 ${summary.skipped}，`
    + `失败 ${summary.failed}${summary.errors.length ? `，首个错误：${summary.errors[0]}` : ''}`);
  return summary;
}

const HANDLERS = {
  scan: actionScan,
  status: actionStatus,
  ack: actionAck,
  config: actionConfig,
  test: actionTest,
};

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** 解析入参：身份类字段**显式丢弃**（与 tasks 云函数同一套做法） */
const IDENTITY_KEYS = ['openid', '_openid', 'OPENID', 'user', 'user_id', 'unionid', 'uid'];
function stripIdentity(payload) {
  const clean = {};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return clean;
  Object.keys(payload).forEach((key) => {
    if (IDENTITY_KEYS.indexOf(key) !== -1) return;
    clean[key] = payload[key];
  });
  return clean;
}

/**
 * 处理一次调用（db / openid / env 都由外部注入，便于自测）。
 *
 * 【权限说明】scan 是全局动作（定时器触发），它遍历的是"自己开了提醒"的用户；
 * status / ack / config / test 是**个人动作**，只操作 `_openid === openid` 那一行。
 * 换句话说：scan 不是"前端可以指定提醒谁"的口子 —— 它的输入里根本没有收件人参数。
 */
async function handleAction(db, openid, event, deps) {
  if (!db) return fail('数据库不可用：请确认已开通云开发并正确 init');

  const action = toStr(event && event.action) || 'scan'; // 无 action（定时器）→ scan
  const handler = HANDLERS[action];
  if (!handler) {
    return fail(`未知 action：${action}；支持 ${Object.keys(HANDLERS).join(' / ')}`);
  }
  if (action !== 'scan' && !openid) {
    return fail('无法识别用户身份，请在小程序内调用');
  }

  const payload = stripIdentity(event);
  return handler(db, openid, payload, deps || {});
}

/** 云函数入口 */
exports.main = async (event) => {
  try {
    const deps = { env: process.env, now: Date.now() };
    if (!cloud) {
      // 没有云环境时**不直接拒绝 scan** —— 让 planScan 去报"数据库不可用"这类
      // 更准确的原因；个人动作则明确说清缺依赖。
      const action = toStr(event && event.action);
      if (action && action !== 'scan') {
        return fail(`云函数依赖未就绪，请在云环境内运行（${sdkError ? sdkError.message : 'wx-server-sdk 缺失'}）`);
      }
      return fail(`云函数依赖未就绪，请在云环境内运行（${sdkError ? sdkError.message : 'wx-server-sdk 缺失'}）`);
    }
    return await handleAction(cloud.database(), currentOpenId(), event || {}, deps);
  } catch (error) {
    // 统一兜底：不把堆栈抛给前端；日志里留全量信息（已脱敏）
    console.error('[remind] 执行失败：', scrubSecrets((error && error.stack) || error));
    return fail(`服务异常：${scrubSecrets((error && error.message) || error)}`);
  }
};

// ---------------------------------------------------------------------------
// 暴露给 cloudfunctions/_selftest.js（不依赖 wx-server-sdk 即可测试）
// ---------------------------------------------------------------------------
//
// 【为什么用 Object.assign(exports, ...) 而不是 module.exports = {...}】
// deliverOne / actionTest 里是通过 `exports.sendSubscribeMessage(...)` 调用的
// （好让自测能替换这个出口）。如果整体替换 module.exports，闭包里的 exports
// 就指向旧对象，替换会静默失效 —— 自测会去调真的云调用。
Object.assign(exports, {
  main: exports.main,
  handleAction,
  // 纯函数
  dueInstantOf,
  dueKeyOf,
  planReminders,
  buildMessageData,
  resolveFieldMap,
  classifySendError,
  sentKeysFromRows,
  extractErrCode,
  scrubSecrets,
  humanizeLeft,
  humanizeLeftPhrase,
  humanizeLeftCompact,
  truncateByCodePoint,
  // 长度口径（真机证实：汉字/全角算 2 权重）
  charUnits,
  fieldUnits,
  truncateToUnits,
  checkFieldCompliance,
  formatDueText,
  formatDateFieldText,
  typeLabelOf,
  fieldTypeOf,
  isAwkwardField,
  ruleForType,
  slotValueOf,
  composeTitle,
  describeMessageFields,
  shouldRefundQuota,
  refundQuotaOnce,
  beijingIso,
  desiredQuota,
  normalizeClockText,
  // 薄 IO / 编排
  planScan,
  planForUser,
  deliverOne,
  fetchAll,
  fetchEnabledSettings,
  fetchSentReminders,
  loadSettingsRow,
  writeSettingsFields,
  // actions
  actionStatus,
  actionAck,
  actionConfig,
  actionTest,
  actionScan,
  // 出口（自测会替换它）
  sendSubscribeMessage,
  currentOpenId,
  envReadiness,
  // 常量
  HANDLERS,
  COLLECTION_TASKS,
  COLLECTION_SETTINGS,
  COLLECTION_REMINDERS,
  LEAD_MIN_OPTIONS,
  DEFAULT_LEAD_MIN,
  GRACE_MS,
  MAX_PER_SCAN,
  MAX_ACK_COUNT,
  MAX_QUOTA,
  MAX_SENT_ROWS,
  PAGE_SIZE,
  BEIJING_OFFSET_MS,
  DEFAULT_PAGE,
  DEFAULT_FIELD_MAP,
  SLOTS,
  FIELD_TYPES,
  FIELD_TYPE_RULES,
  TYPE_LABELS,
  THING_MAX,
  SHORT_THING_MAX,
  PHRASE_MAX,
  CHARACTER_STRING_MAX,
  UNKNOWN_FIELD_MAX,
  FIELD_VALUE_LOG_MAX,
  ELLIPSIS_UNITS,
  ENV_TEMPLATE_ID,
  ENV_FIELD_MAP,
  ENV_PAGE,
  ERROR_USER_REJECTED,
  ERROR_FIELD_INVALID,
});
