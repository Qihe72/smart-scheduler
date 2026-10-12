"""
ai_parser.py —— 自然语言 → 结构化日程（调用 DeepSeek Chat Completions API）。

=====================================================================
依赖说明（重要）
=====================================================================
本模块依赖 config.py 中的 API_KEY：
    * API_KEY 来自环境变量（默认 ZHIPU_API_KEY，见 config.LLM_PROVIDERS；
      也支持 DEEPSEEK_API_KEY），或项目根目录的 .env 文件；
    * 可通过 `cp .env.example .env` 后填入真实 Key 来配置；
    * 如果未配置（API_KEY 为空），本模块的所有函数都不会发起网络请求，
      而是直接返回错误提示：
        - 返回 dict 的函数 → {"error": True, "message": "未配置 <当前服务商的 Key 变量名>..."}
        - chat_with_ai()   → 直接返回该提示字符串
    也就是说：没配 Key 时程序依然能正常 import、正常运行，只是走「手动输入」路线。

接口调用方式（按要求）：
    POST {BASE_URL}/chat/completions
    Header: Content-Type: application/json
            Authorization: Bearer {API_KEY}
    超时：15 秒（TIMEOUT）
"""

import json
import logging
import re
from datetime import date, timedelta

# requests 是必需的第三方依赖（见 requirements.txt）。
# 这里做「容错 import」：万一环境里没装 requests，本模块依然可以被 import，
# 只是所有 AI 函数会直接返回「缺少依赖」的错误提示，而不是让整个应用启动失败。
try:
    import requests
    from requests.exceptions import RequestException, Timeout as RequestsTimeout

    REQUESTS_AVAILABLE = True
    REQUESTS_IMPORT_ERROR = ""
except ImportError as _exc:  # pragma: no cover - 仅在缺少依赖时触发
    requests = None
    # 占位异常类：此时网络调用根本不会发生（见 _chat_completion 的提前返回），
    # 仅用于让下面的 except 子句在语法上始终成立。
    RequestException = Exception
    RequestsTimeout = Exception
    REQUESTS_AVAILABLE = False
    REQUESTS_IMPORT_ERROR = str(_exc)

# 兼容两种导入方式：
#   1) 作为包的一部分：`from smart_scheduler import ai_parser`
#   2) 直接把 smart-scheduler/ 当作源码目录：`import ai_parser`
try:  # pragma: no cover - 取决于调用方式
    from . import config
    from .config import API_KEY, BASE_URL, MODEL
except ImportError:  # pragma: no cover
    import config
    from config import API_KEY, BASE_URL, MODEL

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
# 所选服务商的 OpenAI 兼容端点（智谱与 DeepSeek 的接口形状一致，可直接共用）
API_URL = f"{BASE_URL.rstrip('/')}/chat/completions"

# 按要求设置 15 秒超时（连接 + 读取共享该时间上限）
TIMEOUT = 15

# 统一的失败提示：UI 层拿到这个字符串就可以引导用户手动输入
ERROR_MESSAGE = "AI服务暂不可用，请使用手动输入"

# 未配置 API Key 时的提示（与上一条区分开，方便用户排查）
NO_KEY_MESSAGE = f"未配置 {config.LLM_KEY_ENV}，请使用手动输入（可在 .env 文件中设置）"

# 缺少 requests 依赖时的提示
NO_REQUESTS_MESSAGE = "缺少 requests 依赖，请先执行 pip install -r requirements.txt"

# 模型没有按要求返回合法 JSON 时的提示（与「服务不可用」区分开，便于排查）
PARSE_ERROR_MESSAGE = "AI返回的内容无法解析，请重试或使用手动输入"

# 中文星期，datetime.weekday() 中 0 = 周一
WEEKDAY_CN = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]

# 附加：AI 返回的中文标签 → task_manager / config 使用的内部常量
TYPE_CN_TO_CONST = {
    "日程": config.TYPE_EVENT,
    "event": config.TYPE_EVENT,
    "ddl": config.TYPE_DDL,
    "截止": config.TYPE_DDL,
    "子任务": config.TYPE_SUBTASK,
    "subtask": config.TYPE_SUBTASK,
}

PRIORITY_CN_TO_CONST = {
    "高": config.PRIORITY_HIGH,
    "中": config.PRIORITY_MID,
    "低": config.PRIORITY_LOW,
    "high": config.PRIORITY_HIGH,
    "mid": config.PRIORITY_MID,
    "low": config.PRIORITY_LOW,
}


def _lookup_label(mapping: dict, value, default: str) -> str:
    """在「中文标签 → 内部常量」的映射里做容错查找。

    模型返回的大小写并不稳定（"DDL" / "ddl" / "Ddl"，"High" / "high"），
    所以先精确匹配，再统一转小写匹配。

    Args:
        mapping: 标签映射表。
        value: 模型返回的原始标签。
        default: 都匹配不上时返回的默认常量。

    Returns:
        str: 对应的内部常量。
    """
    key = str(value or "").strip()
    if not key:
        return default
    if key in mapping:
        return mapping[key]
    lowered = key.lower()
    if lowered in mapping:
        return mapping[lowered]
    return default


def type_to_const(value, default: str = None) -> str:
    """把 AI 返回的类型标签转换成 config 中的类型常量。

    Args:
        value: "日程" / "DDL" / "ddl" / "子任务" 等。
        default: 匹配不上时的默认值，默认按「日程」处理。

    Returns:
        str: config.TYPE_EVENT / TYPE_DDL / TYPE_SUBTASK 之一。
    """
    return _lookup_label(TYPE_CN_TO_CONST, value, default or config.TYPE_EVENT)


def priority_to_const(value, default: str = None) -> str:
    """把 AI 返回的优先级标签转换成 config 中的优先级常量。

    Args:
        value: "高" / "中" / "低" / "high" 等。
        default: 匹配不上时的默认值，默认按「中」处理。

    Returns:
        str: config.PRIORITY_HIGH / PRIORITY_MID / PRIORITY_LOW 之一。
    """
    return _lookup_label(PRIORITY_CN_TO_CONST, value, default or config.PRIORITY_MID)


# ---------------------------------------------------------------------------
# 内部工具函数
# ---------------------------------------------------------------------------
def _has_api_key() -> bool:
    """判断当前是否已配置 API Key。

    Returns:
        bool: API_KEY 非空（去掉首尾空白后）返回 True。
    """
    return bool((API_KEY or "").strip())


def _error_result(message: str = ERROR_MESSAGE) -> dict:
    """构造统一的错误返回结构。

    Args:
        message: 给用户看的提示文案。

    Returns:
        dict: {"error": True, "message": message}
    """
    return {"error": True, "message": message}


def _build_date_reference(today: date = None) -> str:
    """生成「相对日期 → 绝对日期」的参考表，注入到 system prompt 中。

    相对日期由 AI 换算容易出错，这里直接在 Python 里算好，让模型照抄，
    这样「明天 / 后天 / 本周三 / 下周三」等表达就有了确定的唯一答案。

    Args:
        today: 基准日期，默认取今天（运行时动态计算）。

    Returns:
        str: 多行文本，例如：
             - 今天：2026-09-22（周二）
             - 明天：2026-09-23（周三）
             ...
    """
    today = today or date.today()
    monday_this_week = today - timedelta(days=today.weekday())
    monday_next_week = monday_this_week + timedelta(days=7)

    lines = [
        f"- 今天：{today.isoformat()}（{WEEKDAY_CN[today.weekday()]}）",
        f"- 明天：{(today + timedelta(days=1)).isoformat()}",
        f"- 后天：{(today + timedelta(days=2)).isoformat()}",
        f"- 大后天：{(today + timedelta(days=3)).isoformat()}",
    ]
    # 本周一 ~ 本周日（若已过去，由 prompt 里的规则说明如何处理）
    for i, name in enumerate(WEEKDAY_CN):
        lines.append(f"- 本{name}：{(monday_this_week + timedelta(days=i)).isoformat()}")
    # 下周一 ~ 下周日
    for i, name in enumerate(WEEKDAY_CN):
        lines.append(f"- 下{name}：{(monday_next_week + timedelta(days=i)).isoformat()}")
    return "\n".join(lines)


def _json_loads_tolerant(text: str):
    """带常见修复的 json.loads 包装。

    模型偶尔会输出「尾逗号」「中文引号」这类小瑕疵，这里逐个尝试修复；
    每次尝试都用 try-except 包住 json.loads，全部失败时返回 None 而不是抛异常。

    Args:
        text: 可能不是合法 JSON 的文本。

    Returns:
        dict | list | None: 解析结果；无法解析时返回 None。
    """
    if not isinstance(text, str) or not text.strip():
        return None

    candidates = [text]
    # 修复 1：去掉对象/数组里多余的尾逗号，例如 {"a": 1,} 或 [1, 2,]
    candidates.append(re.sub(r",\s*([}\]])", r"\1", text))
    # 修复 2：中文全角引号 → 英文引号（模型用中文输入法时常见）
    zh_fixed = (
        text.replace("“", '"').replace("”", '"')
        .replace("‘", "'").replace("’", "'")
    )
    candidates.append(zh_fixed)
    candidates.append(re.sub(r",\s*([}\]])", r"\1", zh_fixed))

    for candidate in candidates:
        try:
            return json.loads(candidate)
        except (json.JSONDecodeError, TypeError, ValueError):
            continue
    return None


def _extract_json(content: str):
    """从模型返回的文本中提取 JSON 对象。

    模型有时会带上 ```json 代码块或前后解释文字，这里做容错处理：
        1) 直接解析整段文本；
        2) 剥掉 Markdown 代码块围栏后再解析；
        3) 截取第一个 { 到最后一个 } 之间的内容再解析；
        4) 以上都失败 → 返回 None（调用方据此返回友好错误）。

    Args:
        content: 模型返回的原始文本。

    Returns:
        dict | None: 解析成功返回 dict，失败返回 None。
    """
    if not isinstance(content, str) or not content.strip():
        logger.error("模型返回内容为空，无法解析 JSON")
        return None

    text = content.strip()

    # 1) 去掉 Markdown 代码块围栏：```json ... ``` 或 ``` ... ```
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, flags=re.DOTALL | re.IGNORECASE)
    stripped = fence.group(1).strip() if fence else ""

    candidates = [text, stripped]
    # 2) 截取最外层的大括号内容（应对「好的，结果如下：{...}」这类回复）
    for base in (stripped, text):
        start, end = base.find("{"), base.rfind("}")
        if start != -1 and end > start:
            candidates.append(base[start:end + 1])

    for candidate in candidates:
        if not candidate:
            continue
        data = _json_loads_tolerant(candidate)
        if isinstance(data, dict):
            return data
        # 模型偶尔会返回数组（例如 [{...}]），取第一个对象
        if isinstance(data, list) and data and isinstance(data[0], dict):
            logger.warning("模型返回了数组，已取第一个对象")
            return data[0]

    logger.error("无法从模型返回内容中解析出 JSON：%s", text[:200])
    return None


def _build_examples(today: date = None) -> str:
    """生成几条「输入 → 输出」示例，日期全部按今天动态算好。

    few-shot 示例对日期换算的稳定性帮助很大：这里把「明天」「这周五」
    「10月15号」三种典型说法都算成真实日期再喂给模型，模型照抄即可。

    Args:
        today: 基准日期，默认今天。

    Returns:
        str: 示例文本块。
    """
    today = today or date.today()
    tomorrow = today + timedelta(days=1)

    # 本周五；如果已经过去，则理解为下周五（与 prompt 中的规则一致）
    this_monday = today - timedelta(days=today.weekday())
    friday = this_monday + timedelta(days=4)
    if friday < today:
        friday += timedelta(days=7)

    # 10 月 15 号：取今天之后最近的那一个
    oct15 = date(today.year, 10, 15)
    if oct15 < today:
        oct15 = date(today.year + 1, 10, 15)

    # 下周一（用于「下周一中午十二点前」这个例子）
    next_monday = today - timedelta(days=today.weekday()) + timedelta(days=7)

    return f"""示例 1：
输入：明天下午三点开组会
输出：{{"events":[{{"title":"开组会","date":"{tomorrow.isoformat()}","start_time":"15:00","end_time":"","type":"日程","priority":"中"}}],"deadlines":[],"needs_clarification":false,"clarification_question":""}}

示例 2：
输入：这周五前交实验报告
输出：{{"events":[],"deadlines":[{{"title":"交实验报告","date":"{friday.isoformat()}","type":"DDL","priority":"高"}}],"needs_clarification":false,"clarification_question":""}}

示例 3：
输入：10月15号上午九点半体检
输出：{{"events":[{{"title":"体检","date":"{oct15.isoformat()}","start_time":"09:30","end_time":"","type":"日程","priority":"中"}}],"deadlines":[],"needs_clarification":false,"clarification_question":""}}

示例 4（注意：截止只有一个时刻，没有开始时间）：
输入：下周一中午十二点前交项目申报书
输出：{{"events":[],"deadlines":[{{"title":"交项目申报书","date":"{next_monday.isoformat()}","end_time":"12:00","type":"DDL","priority":"高"}}],"needs_clarification":false,"clarification_question":""}}"""


def _chat_completion(messages: list, json_mode: bool = False, temperature: float = 0.2):
    """调用 DeepSeek Chat Completions 接口（本模块唯一的网络出口）。

    Args:
        messages: OpenAI 格式的消息列表，如
                  [{"role": "system", "content": "..."}, {"role": "user", "content": "..."}]
        json_mode: 为 True 时请求 response_format=json_object，强制模型输出 JSON。
        temperature: 采样温度，解析类任务用低温更稳定。

    Returns:
        tuple[str | None, str | None]: (模型回复文本, 错误提示)。
            成功时第二个元素为 None；失败时第一个元素为 None。
    """
    # 未配置 Key：不发起任何网络请求，直接返回提示
    if not _has_api_key():
        logger.warning("未配置 %s，跳过 AI 调用", config.LLM_KEY_ENV)
        return None, NO_KEY_MESSAGE

    # 缺少 requests 依赖：同样不发请求，给出可执行的修复提示
    if not REQUESTS_AVAILABLE:
        logger.error("缺少 requests 依赖：%s", REQUESTS_IMPORT_ERROR)
        return None, NO_REQUESTS_MESSAGE

    payload = {
        "model": MODEL,
        "messages": messages,
        "temperature": temperature,
        "stream": False,
    }

    # 服务商专属参数，默认空。不确定对方是否支持时就不要填，保持最大兼容。
    payload.update(getattr(config, "LLM_EXTRA_BODY", None) or {})
    if json_mode:
        # 两家都支持 JSON 输出模式，可显著降低返回非法 JSON 的概率
        payload["response_format"] = {"type": "json_object"}

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}",
    }

    try:
        response = requests.post(API_URL, headers=headers, json=payload, timeout=TIMEOUT)
    except requests.exceptions.Timeout:
        logger.error("调用 %s 超时（>%s 秒）", config.LLM_LABEL, TIMEOUT)
        return None, ERROR_MESSAGE
    except requests.exceptions.RequestException as exc:
        # 网络不可达、DNS 失败、连接被重置等
        logger.error("调用 %s 网络异常：%s", config.LLM_LABEL, exc)
        return None, ERROR_MESSAGE

    # 个别兼容端点不支持 response_format，遇到 400 时去掉该字段重试一次
    if response.status_code == 400 and json_mode:
        logger.warning("服务端拒绝了 response_format，去掉该字段重试一次")
        payload.pop("response_format", None)
        try:
            response = requests.post(API_URL, headers=headers, json=payload, timeout=TIMEOUT)
        except requests.exceptions.RequestException as exc:
            logger.error("重试调用 %s 失败：%s", config.LLM_LABEL, exc)
            return None, ERROR_MESSAGE

    # 认证失败单独记录，方便排查（不打印 Key 本身）
    if response.status_code == 401:
        logger.error("%s 返回 401：API Key 无效或已过期", config.LLM_LABEL)
        return None, ERROR_MESSAGE
    if response.status_code == 429:
        logger.error("%s 返回 429：请求过于频繁或额度不足", config.LLM_LABEL)
        return None, ERROR_MESSAGE
    if response.status_code != 200:
        logger.error("%s 返回异常状态码 %s：%s", config.LLM_LABEL, response.status_code, response.text[:200])
        return None, ERROR_MESSAGE

    try:
        data = response.json()
    except ValueError:
        logger.error("%s 返回的内容不是合法 JSON", config.LLM_LABEL)
        return None, ERROR_MESSAGE

    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        logger.error("%s 返回结构异常：%s", config.LLM_LABEL, str(data)[:200])
        return None, ERROR_MESSAGE

    if not isinstance(content, str) or not content.strip():
        logger.error("DeepSeek 返回了空内容")
        return None, ERROR_MESSAGE
    return content, None


def _normalize_parse_result(data: dict) -> dict:
    """把模型返回的解析结果补齐成约定结构，保证字段类型安全。

    Args:
        data: 已解析出的 dict（可能缺少字段或类型不对）。

    Returns:
        dict: 固定包含 events / deadlines / needs_clarification / clarification_question。
    """
    result = {
        "events": [],
        "deadlines": [],
        "needs_clarification": False,
        "clarification_question": "",
    }
    if not isinstance(data, dict):
        return result

    # events：只保留 dict，并补全字段
    raw_events = data.get("events")
    if isinstance(raw_events, list):
        for item in raw_events:
            if not isinstance(item, dict):
                continue
            result["events"].append({
                "title": str(item.get("title", "")).strip(),
                "date": str(item.get("date", "")).strip(),
                "start_time": str(item.get("start_time", "") or "").strip(),
                "end_time": str(item.get("end_time", "") or "").strip(),
                "type": str(item.get("type") or "日程").strip(),
                "priority": str(item.get("priority") or config.PRIORITY_LABELS[config.PRIORITY_MID]).strip(),
            })

    # deadlines：只保留 dict，并补全字段（DDL 没有起止时间）
    raw_deadlines = data.get("deadlines")
    if isinstance(raw_deadlines, list):
        for item in raw_deadlines:
            if not isinstance(item, dict):
                continue
            result["deadlines"].append({
                "title": str(item.get("title", "")).strip(),
                "date": str(item.get("date", "")).strip(),
                # 截止时刻（可空：空表示「当天结束前截止」）
                "end_time": str(item.get("end_time") or "").strip(),
                "type": str(item.get("type") or "DDL").strip(),
                "priority": str(item.get("priority") or config.PRIORITY_LABELS[config.PRIORITY_HIGH]).strip(),
            })

    result["needs_clarification"] = bool(data.get("needs_clarification", False))
    result["clarification_question"] = str(data.get("clarification_question") or "").strip()
    return result


# ---------------------------------------------------------------------------
# 对外接口
# ---------------------------------------------------------------------------
def parse_natural_input(text: str) -> dict:
    """把一句自然语言解析成结构化的日程 / 截止列表。

    相对日期（明天、后天、下周三……）由模型结合 prompt 中注入的
    「日期参考表」换算成真实的 YYYY-MM-DD，基准日期为运行当天。

    Args:
        text: 用户输入的自然语言，例如「明天下午三点开会，下周三前交报告」。

    Returns:
        dict: 成功时返回
              {
                "events": [{"title", "date", "start_time", "end_time", "type", "priority"}],
                "deadlines": [{"title", "date", "type", "priority"}],
                "needs_clarification": bool,
                "clarification_question": str
              }
              失败时返回 {"error": True, "message": "AI服务暂不可用，请使用手动输入"}；
              未配置 API_KEY 时 message 为未配置提示。
    """
    # 空输入直接本地拦掉，不必浪费一次请求
    if not isinstance(text, str) or not text.strip():
        return {
            "events": [],
            "deadlines": [],
            "needs_clarification": True,
            "clarification_question": "请描述一下你的安排，例如：明天 15:00 开会。",
        }
    text = text.strip()

    today = date.today()
    system_prompt = f"""你是一个中文日程解析助手。你的任务是把用户的自然语言输入解析成严格的 JSON。

今天是 {today.isoformat()}（{WEEKDAY_CN[today.weekday()]}）。请严格依据下面的日期参考表换算所有相对日期：
{_build_date_reference(today)}

【日期换算规则】逐条遵守，这是本任务最容易出错的地方：
1. 「明天 / 后天 / 大后天 / 下周X / 本周X」直接查上面的参考表，不要自己推算。
2. 「这周五 / 本周五 / 周五」：如果本周的那一天还没过（≥今天），就用本周的；如果已经过去，就用下周的那一天。
3. 「三天后 / 一周后 / 两天以后」：今天 + 3 天 / 今天 + 7 天 / 今天 + 2 天。
4. 「10月15号 / 10-15 / 10/15 / 十月十五」：年份取今天之后最近的那一年（今年该日期已过则取下一年）。
5. 「月底 / 月初」：本月最后一天 / 本月第一天。「下个月X号」：下个月的 X 号。
6. 只说了月份日期、没说年份时，一律按「今天之后最近的这一天」处理，不要输出过去的日期。

【时间换算规则】：
1. 24 小时制、HH:MM 补零输出：上午九点 → 09:00；下午三点 → 15:00；晚上八点半 → 20:30；中午十二点 → 12:00。
2. 十二小时制换算：上午/早上/清晨 保持小时不变；下午/傍晚/晚上/夜里 小时 +12；凌晨 0-5 点保持原样。
3. 「半」= 30 分，「一刻」= 15 分，「三刻」= 45 分，「整」= 00 分。
4. 只给了日期没给时间 → start_time 与 end_time 都填空字符串 ""，不要瞎猜一个时间。

{_build_examples(today)}

只输出一个 JSON 对象，不要输出解释、不要用 Markdown 代码块、不要添加额外字段。结构必须完全如下：
{{
  "events": [
    {{"title": "字符串", "date": "YYYY-MM-DD", "start_time": "HH:MM", "end_time": "HH:MM", "type": "日程", "priority": "中"}}
  ],
  "deadlines": [
    {{"title": "字符串", "date": "YYYY-MM-DD", "end_time": "HH:MM", "type": "DDL", "priority": "高"}}
  ],
  "needs_clarification": false,
  "clarification_question": ""
}}

其他规则：
1. 有明确开始时间的具体安排放进 events；「某时间点之前必须完成」类（截止、DDL、交作业、提交报告）放进 deadlines。
2. events 的 type 固定为 "日程"；deadlines 的 type 固定为 "DDL"。
3. 【重要】deadlines 表示的是一个**截止时刻**，不是一段时间：没有 start_time 字段，不要编造开始时间。
   用户说了具体时刻（「中午十二点」「下午五点前」「23:59 前」）就填进 end_time；
   只说了日期（「10月15号交」）就把 end_time 留空字符串，表示「当天结束前截止」。
3. priority 只能取 "高"、"中"、"低"：用户明确说了紧急/重要就用 "高"，DDL 默认 "高"，其余默认 "中"。
4. 所有 date 必须是绝对的 YYYY-MM-DD（月份日期补零，如 2026-10-05），禁止输出"明天""这周五""10月15号"这类写法。
5. 一句话里可能包含多件事（例如"明天三点开会，周五前交报告"），请全部解析出来，不要漏。
6. 只有标题、缺少必要时间信息（例如只说"开会"而没说什么时候）时，把 needs_clarification 设为 true，并在 clarification_question 里用一句简短中文追问；这时 events 和 deadlines 可以为空数组。
7. 如果输入与日程完全无关，返回空的 events、deadlines，needs_clarification 设为 false。"""

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": text},
    ]

    try:
        content, error = _chat_completion(messages, json_mode=True, temperature=0.2)
        if error:
            return _error_result(error)

        data = _extract_json(content)
        if data is None:
            # 模型没按要求返回 JSON：解析容错已全部失败，返回友好错误（不抛异常）
            return _error_result(PARSE_ERROR_MESSAGE)

        return _normalize_parse_result(data)
    except Exception as exc:  # 兜底：任何未预料的异常都不应让 UI 崩溃
        logger.exception("parse_natural_input 发生未预期异常：%s", exc)
        return _error_result()


def decompose_task(task_title: str, deadline: str) -> dict:
    """把一个大任务拆解成若干带建议执行日期的子任务。

    Args:
        task_title: 任务名称，例如「写毕业论文」。
        deadline: 截止日期，格式 "YYYY-MM-DD"。

    Returns:
        dict: 成功时返回
              {
                "task": str,
                "deadline": "YYYY-MM-DD",
                "subtasks": [{"title": str, "suggested_date": "YYYY-MM-DD",
                              "estimate_min": int}]
              }
              失败时在同样的结构上追加
              {"error": True, "message": "AI服务暂不可用，请使用手动输入"}。
    """
    # 参数校验失败时也返回同一套结构，方便调用方统一处理
    fallback = {"task": str(task_title or ""), "deadline": str(deadline or ""), "subtasks": []}

    if not isinstance(task_title, str) or not task_title.strip():
        result = dict(fallback)
        result.update(_error_result("任务名称不能为空，请使用手动输入"))
        return result
    if not isinstance(deadline, str) or not deadline.strip():
        result = dict(fallback)
        result.update(_error_result("截止日期不能为空，请使用手动输入"))
        return result
    task_title = task_title.strip()
    deadline = deadline.strip()

    today = date.today()
    system_prompt = f"""你是一个中文任务拆解助手。请把用户给出的大任务拆解成 3~8 个具体、可执行、互不重叠的子任务。

今天是 {today.isoformat()}（{WEEKDAY_CN[today.weekday()]}），任务截止日期是 {deadline}。
请把子任务均匀地安排在「今天到截止日期之间」，越靠前的子任务日期越早，最后一个子任务的日期不晚于截止日期。

只输出一个 JSON 对象，不要输出解释、不要用 Markdown 代码块、不要添加额外字段。结构必须完全如下：
{{
  "task": "任务名称",
  "deadline": "{deadline}",
  "subtasks": [
    {{"title": "子任务名称", "suggested_date": "YYYY-MM-DD", "estimate_min": 60}}
  ]
}}

规则：
1. "task" 原样返回用户给出的任务名称；"deadline" 原样返回 {deadline}。
2. 每个子任务都要是动词开头的具体动作，粒度控制在 30 分钟到半天能完成。
3. "suggested_date" 必须是绝对的 YYYY-MM-DD，且在 {today.isoformat()} 到 {deadline} 之间。
4. 子任务按建议日期的先后顺序排列。
5. "estimate_min" 是这一步预计要花多少**分钟**（整数，15 的倍数，例如 30 / 60 / 120）——
   它会被用来算「这周还排得下吗」，所以要贴近真实耗时，不要都写一样的数。"""

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"任务：{task_title}\n截止日期：{deadline}"},
    ]

    try:
        content, error = _chat_completion(messages, json_mode=True, temperature=0.3)
        if error:
            result = dict(fallback)
            result.update(_error_result(error))
            return result

        data = _extract_json(content)
        if data is None:
            result = dict(fallback)
            result.update(_error_result(PARSE_ERROR_MESSAGE))
            return result

        # 归一化：以调用方传入的 task / deadline 为准，避免模型改写
        subtasks = []
        raw_subtasks = data.get("subtasks")
        if isinstance(raw_subtasks, list):
            for item in raw_subtasks:
                if not isinstance(item, dict):
                    continue
                title = str(item.get("title", "")).strip()
                if not title:
                    continue
                try:
                    estimate = int(item.get("estimate_min") or 0)
                except (TypeError, ValueError):
                    estimate = 0
                subtasks.append({
                    "title": title,
                    "suggested_date": str(item.get("suggested_date", "") or "").strip(),
                    "estimate_min": estimate if estimate > 0 else 0,
                })

        return {"task": task_title, "deadline": deadline, "subtasks": subtasks}
    except Exception as exc:  # 兜底异常保护
        logger.exception("decompose_task 发生未预期异常：%s", exc)
        result = dict(fallback)
        result.update(_error_result())
        return result


def chat_with_ai(text: str) -> str:
    """单轮闲聊 / 兜底对话，直接返回模型的文本回复。

    Args:
        text: 用户说的话。

    Returns:
        str: 模型的回复文本；调用失败或未配置 API_KEY 时返回错误提示字符串
             （如 "AI服务暂不可用，请使用手动输入"）。
    """
    if not isinstance(text, str) or not text.strip():
        return "你想聊点什么？也可以直接告诉我你的日程安排。"

    system_prompt = (
        "你是「智能日程助手」里的对话助手，用简洁友好的中文回答用户。"
        "如果用户是在描述日程，可以提醒他使用自然语言解析功能；回答控制在 3 句话以内。"
    )
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": text.strip()},
    ]

    try:
        content, error = _chat_completion(messages, json_mode=False, temperature=0.7)
        if error:
            return error
        return content.strip()
    except Exception as exc:  # 兜底异常保护
        logger.exception("chat_with_ai 发生未预期异常：%s", exc)
        return ERROR_MESSAGE


# ---------------------------------------------------------------------------
# 附加工具：把 AI 返回的中文标签转换成 task_manager 使用的内部结构
# ---------------------------------------------------------------------------
def _estimate_min_of(item: dict) -> int:
    """取条目里的「预计耗时（分钟）」，非法/缺失一律 0（= 没估）。"""
    if not isinstance(item, dict):
        return 0
    try:
        value = int(item.get("estimate_min") or 0)
    except (TypeError, ValueError):
        return 0
    return value if value > 0 else 0


def to_local_tasks(parse_result: dict, parent_id: int = None) -> list:
    """把 parse_natural_input() 的结果转换成 task_manager.add_task() 可用的 dict 列表。

    这一步只做标签映射（"日程" → config.TYPE_EVENT，"高" → config.PRIORITY_HIGH），
    不写文件、不分配 id，id / created_at 由 task_manager.add_task() 负责。

    Args:
        parse_result: parse_natural_input() 的返回值。
        parent_id: 可选的父任务 id，会写入每条任务的 parent_id 字段。

    Returns:
        list: 任务 dict 列表；解析失败（含 error 字段）时返回 []。
    """
    if not isinstance(parse_result, dict) or parse_result.get("error"):
        return []

    tasks = []
    for item in parse_result.get("events", []) or []:
        if not isinstance(item, dict):
            continue
        row = {
            "title": str(item.get("title", "")).strip(),
            "type": type_to_const(item.get("type"), config.TYPE_EVENT),
            "date": str(item.get("date", "")).strip(),
            "start_time": str(item.get("start_time", "") or "").strip(),
            "end_time": str(item.get("end_time", "") or "").strip(),
            "priority": priority_to_const(item.get("priority"), config.PRIORITY_MID),
            "done": False,
            "parent_id": parent_id,
            "estimate_min": _estimate_min_of(item),
        }
        row.update(_repeat_fields(item))
        tasks.append(row)
    for item in parse_result.get("deadlines", []) or []:
        if not isinstance(item, dict):
            continue
        row = {
            "title": str(item.get("title", "")).strip(),
            "type": type_to_const(item.get("type"), config.TYPE_DDL),
            "date": str(item.get("date", "")).strip(),
            # 截止类没有起始时间，只有截止时刻
            "start_time": "",
            "end_time": str(item.get("end_time", "") or "").strip(),
            "priority": priority_to_const(item.get("priority"), config.PRIORITY_HIGH),
            "done": False,
            "parent_id": parent_id,
            "estimate_min": _estimate_min_of(item),
        }
        row.update(_repeat_fields(item))
        tasks.append(row)
    # 过滤掉没有标题或日期的脏数据
    return [t for t in tasks if t["title"] and t["date"]]


def _repeat_fields(item: dict) -> dict:
    """取出条目里的「重复设置」字段（课程可能是每周重复的）。

    Args:
        item: 解析结果里的一条（可能带 repeat / week_start / week_end / week_parity）。

    Returns:
        dict: 只含出现过的重复字段；没有就返回空 dict，
              交给 task_manager 的默认值处理。
    """
    if not isinstance(item, dict):
        return {}
    repeat = str(item.get("repeat") or "").strip().lower()
    if repeat not in config.ALL_REPEATS or repeat == config.REPEAT_NONE:
        return {}
    fields = {"repeat": repeat}
    if item.get("week_start") is not None:
        fields["week_start"] = item.get("week_start")
    if item.get("week_end") is not None:
        fields["week_end"] = item.get("week_end")
    parity = str(item.get("week_parity") or "").strip().lower()
    if parity in config.ALL_PARITIES:
        fields["week_parity"] = parity
    return fields


# ---------------------------------------------------------------------------
# 自测入口：`python ai_parser.py` 会真实调用 API（需要先配置 API_KEY）
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    print("接口地址：", API_URL)
    print("模型：", MODEL)
    print("API Key 是否已配置：", _has_api_key())
    print("requests 是否可用：", REQUESTS_AVAILABLE)

    if not _has_api_key():
        print(f"\n未检测到 {config.LLM_KEY_ENV}，下面演示的是「未配置」时的返回值：")
        print("parse_natural_input:", parse_natural_input("明天下午三点开会"))
        print("decompose_task:", decompose_task("写毕业论文", "2026-12-31"))
        print("chat_with_ai:", chat_with_ai("你好"))
    else:
        print("\n日期参考表：")
        print(_build_date_reference())
        demo = parse_natural_input("明天下午三点开组会，下周三前交课程报告")
        print("\nparse_natural_input:", json.dumps(demo, ensure_ascii=False, indent=2))
        print("to_local_tasks:", json.dumps(to_local_tasks(demo), ensure_ascii=False, indent=2))
        print("\ndecompose_task:", json.dumps(
            decompose_task("写毕业论文", "2026-12-31"), ensure_ascii=False, indent=2))
        print("\nchat_with_ai:", chat_with_ai("你好，你能做什么？"))
