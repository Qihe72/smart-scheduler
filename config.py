"""
config.py —— 智能日程助手（smart-scheduler）的全局配置。

本模块只做三件事：
1. 从环境变量 / .env 文件读取 DeepSeek 的 API Key 等配置；
2. 定义数据文件（schedules.json）所在目录，并保证目录存在；
3. 定义日程类型、优先级等业务常量，供其他模块统一引用。

注意：本文件不做任何网络请求，也不需要安装 streamlit 即可 import。
"""

import os
import re
from datetime import date, timedelta

# python-dotenv 用于读取项目根目录下的 .env 文件。
# 若未安装，则退化为「只用系统环境变量」，保证模块仍可 import 不报错。
try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - 仅在没有装 python-dotenv 时触发
    def load_dotenv(*args, **kwargs):
        """python-dotenv 缺失时的空实现（占位函数）。"""
        return False

# ---------------------------------------------------------------------------
# 一、加载 .env 文件
# ---------------------------------------------------------------------------
# BASE_DIR 指向 config.py 所在目录（即 smart-scheduler/），
# 使用绝对路径可以保证无论从哪个工作目录启动程序，读到的都是同一个 .env。
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_FILE = os.path.join(BASE_DIR, ".env")

# load_dotenv 默认不会覆盖已存在的系统环境变量，这里保持默认行为：
# 即「系统环境变量优先于 .env 文件」。
load_dotenv(dotenv_path=ENV_FILE)

# ---------------------------------------------------------------------------
# 二、大模型 API 配置（自然语言解析 / 任务拆解用）
# ---------------------------------------------------------------------------
# 为什么不直接写死一家：模型型号和价格几个月就变一次
# （写这份配置时 glm-4-flash 已下线、GLM-5.3-Flash 已改为按量计费），
# 所以这里做成一张表 + 一个环境变量，换服务商只要改 .env，不用动代码。
LLM_PROVIDERS = {
    "zhipu": {
        "label": "智谱 GLM",
        "model": "glm-4.7-flash",  # 免费档（输入/输出均 0 元）
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "key_env": "ZHIPU_API_KEY",
    },
    "deepseek": {
        "label": "DeepSeek",
        # 【2026-10-13 更正】DeepSeek 的旧模型名 deepseek-chat / deepseek-reasoner
  # 已于 2026-07-24 停止服务；现用 deepseek-flash（DeepSeek-V4.1-Flash，原生多模态）。
  # 依据：https://api-docs.deepseek.com/updates/ 。仍可用 LLM_MODEL 覆盖。
  "model": "deepseek-flash",
        "base_url": "https://api.deepseek.com/v1",
        "key_env": "DEEPSEEK_API_KEY",
    },
}

# 没有任何一家配 Key 时，用这家（好让提示里出现正确的环境变量名）
LLM_DEFAULT_PROVIDER = "zhipu"


def _env_key(name: str) -> str:
    """读取环境变量里的 Key，去掉首尾空白。"""
    return (os.getenv(name) or "").strip()


def _pick_llm_provider() -> str:
    """决定这次运行用哪家服务商。

    优先级：
      1. LLM_PROVIDER 明确指定且认得 → 就用它，**即使这家还没配 Key**。
         理由：显式指定却没配 Key 时报错要点名缺哪个环境变量，
         而不是"偷偷换一家"让人以为配置已经生效。
      2. 没指定 → 用「配置了 Key 的那一家」。
         学生手上往往只有其中一家的 Key，这样不会出现「明明填了 Key 却提示未配置」；
      3. 谁都没配 Key → 用默认那家，让报错信息指向正确的变量名。

    注意：云函数版 aiParse / aiDecompose 用的是**同一条规则**，
    改这里的时候请同步改那边，别让两个前端的行为分叉。

    Returns:
        str: LLM_PROVIDERS 中的键。
    """
    wanted = (os.getenv("LLM_PROVIDER") or "").strip().lower()
    if wanted and wanted not in LLM_PROVIDERS:
        print(f"[config] 未知的 LLM_PROVIDER={wanted!r}，已忽略（可选：{', '.join(LLM_PROVIDERS)}）")
        wanted = ""
    if wanted:
        # 显式指定就用它 —— 即使这家还没配 Key（报错才准确，不偷偷换一家）
        return wanted
    for name, cfg in LLM_PROVIDERS.items():
        if _env_key(cfg["key_env"]):
            return name
    return LLM_DEFAULT_PROVIDER


LLM_PROVIDER = _pick_llm_provider()
_LLM = LLM_PROVIDERS[LLM_PROVIDER]
LLM_LABEL = _LLM["label"]
LLM_KEY_ENV = _LLM["key_env"]

# 本次实际使用的 Key；读不到时为空字符串，调用方需自行判断是否已配置。
LLM_API_KEY = _env_key(LLM_KEY_ENV)

# 别名：ai_parser.py 等模块统一按 `from config import API_KEY` 使用，
# 两个名字指向同一个值，配置一处即可。
API_KEY = LLM_API_KEY

# 当前服务商的 OpenAI 兼容接口地址与模型。
# 模型名可以用 LLM_MODEL 覆盖：不同账号能用的型号不一样，改 .env 即可。
BASE_URL = _LLM["base_url"]
MODEL = (os.getenv("LLM_MODEL") or "").strip() or _LLM["model"]

# 服务商专属的额外请求参数，默认空（保持最大兼容）。
# 例：智谱想关掉思考模式降低延迟，可以填 {"thinking": {"type": "disabled"}}。
LLM_EXTRA_BODY = {}

# 兼容旧变量名：早期文档和脚本里只认 DEEPSEEK_API_KEY，保留它避免外部引用突然读不到。
DEEPSEEK_API_KEY = _env_key("DEEPSEEK_API_KEY")


def llm_summary() -> str:
    """返回一行「当前用哪家、哪个模型、Key 配没配」的说明，供日志与侧边栏提示复用。"""
    state = "Key 已配置" if LLM_API_KEY else f"未配置 {LLM_KEY_ENV}"
    return f"{LLM_LABEL} / {MODEL} / {state}"

# ---------------------------------------------------------------------------
# 三、数据文件路径
# ---------------------------------------------------------------------------
# 规范中的相对路径 "./data"，这里按 config.py 所在目录解析为绝对路径，
# 避免因为启动目录不同而读写到不同的文件。
DATA_DIR = "./data"
# normpath 只为去掉路径里多余的 "./" 分隔符，让日志输出更整洁
DATA_DIR = os.path.normpath(os.path.join(BASE_DIR, DATA_DIR))

# 所有日程 / 截止 / 子任务都保存在这一个 JSON 文件里（内容是一个列表）
DATA_FILE = os.path.join(DATA_DIR, "schedules.json")

# 本地设置（学期开始日期等）
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")

# 多用户版：任务与设置按「空间码」隔离地存在这个 SQLite 文件里（见 storage.py）。
# 单机自用时它就在 data/ 下，什么都不用配；放到服务器上时把 data/ 挂成持久卷即可。
DB_FILE = os.path.join(DATA_DIR, "app.db")

# 模块被 import 时确保 data/ 目录存在（exist_ok=True 表示已存在也不报错）
os.makedirs(DATA_DIR, exist_ok=True)

# ---------------------------------------------------------------------------
# 四、业务常量：日程类型
# ---------------------------------------------------------------------------
TYPE_EVENT = "event"      # 日程：有明确起止时间的一件事，例如「周三 14:00 开会」
TYPE_DDL = "ddl"          # 截止：某个时间点之前必须完成，例如「周五前交报告」
TYPE_SUBTASK = "subtask"  # 子任务：挂在某个日程/截止下的拆解步骤

# 便于做参数校验与 UI 下拉框
ALL_TYPES = (TYPE_EVENT, TYPE_DDL, TYPE_SUBTASK)

# 类型的中文显示名，UI 层可直接使用
TYPE_LABELS = {
    TYPE_EVENT: "日程",
    TYPE_DDL: "截止",
    TYPE_SUBTASK: "子任务",
}

# ---------------------------------------------------------------------------
# 五、业务常量：优先级
# ---------------------------------------------------------------------------
PRIORITY_HIGH = "high"  # 高
PRIORITY_MID = "mid"    # 中
PRIORITY_LOW = "low"    # 低

ALL_PRIORITIES = (PRIORITY_HIGH, PRIORITY_MID, PRIORITY_LOW)

# 优先级中文显示名
PRIORITY_LABELS = {
    PRIORITY_HIGH: "高",
    PRIORITY_MID: "中",
    PRIORITY_LOW: "低",
}

# 排序权重：数字越小越靠前（用于列表排序，high 排最前面）
PRIORITY_ORDER = {
    PRIORITY_HIGH: 0,
    PRIORITY_MID: 1,
    PRIORITY_LOW: 2,
}


def is_api_key_configured() -> bool:
    """判断当前所选服务商的大模型 API Key 是否已配置。

    Returns:
        bool: 环境变量（或 .env）中存在非空的 Key 时返回 True。
    """
    return bool(LLM_API_KEY)


# ---------------------------------------------------------------------------
# 六、作息表：把一天切成「一节课一节课」
# ---------------------------------------------------------------------------
# 大学生看的是节次，不是笼统的「上午/下午」。
# 下面是本科生常见的作息，**按自己学校的上下课时间改这里即可**，
# 周视图的行、课表导入的「第1-2节」写法都跟着一起变。
# 格式：(节次, 开始时间, 结束时间)
CLASS_PERIODS = (
    (1, "08:00", "08:45"),
    (2, "08:55", "09:40"),
    (3, "10:00", "10:45"),
    (4, "10:55", "11:40"),
    (5, "14:00", "14:45"),
    (6, "14:55", "15:40"),
    (7, "16:00", "16:45"),
    (8, "16:55", "17:40"),
    (9, "19:00", "19:45"),
    (10, "19:55", "20:40"),
    (11, "20:50", "21:35"),
    (12, "21:40", "22:25"),
    (13, "22:30", "23:15"),
)

# 周视图的行：**每节课一行**（第1节、第2节……）。
# 这样三节连课（例如第7-9节）会竖着占三行，一眼就能看出连堂。
# 注意：这只是**默认**行；真实课表要用 period_rows() 算 ——
# 它还会把「校准到的节次」和「任务里写过的节次」并进来。
# 学校一天 13 节还是 14 节并不统一，别人课表里有第14节，课表就该多一行。
PERIOD_ROWS = tuple((number,) for number, _, _ in CLASS_PERIODS)

# 节次号 → (开始, 结束)
PERIOD_TIMES = {number: (start, end) for number, start, end in CLASS_PERIODS}


def _to_minutes(hhmm: str):
    """把 "HH:MM" 转成当天第几分钟；格式非法返回 None。"""
    try:
        hour, minute = str(hhmm).strip().split(":")[:2]
        return int(hour) * 60 + int(minute)
    except (ValueError, AttributeError):
        return None


def period_time_range(number: int, override: dict = None) -> tuple:
    """返回第 N 节课的起止时间。

    Args:
        number: 节次号，例如 7。
        override: 可选的作息覆盖表 {"1": ["08:30", "09:10"], ...}，
                  来自导入课表时自动校准的结果（存在 data/settings.json）。

    Returns:
        tuple: (开始时间, 结束时间)。
    """
    try:
        number = int(number)
    except (TypeError, ValueError):
        return "", ""
    default_start, default_end = PERIOD_TIMES.get(number, ("", ""))

    if isinstance(override, dict):
        saved = override.get(str(number))
        if isinstance(saved, (list, tuple)) and len(saved) == 2:
            start = str(saved[0] or default_start)
            end = str(saved[1] or default_end)
            start_min, end_min = _to_minutes(start), _to_minutes(end)
            if start_min is not None and end_min is not None and start_min < end_min:
                return start, end
            # 校准值和默认值拼不出合法区间时，只显示确实推断出来的那一侧
            return str(saved[0] or ""), str(saved[1] or "")
    return default_start, default_end


def _to_hhmm(minutes) -> str:
    """把「当天第几分钟」转回 "HH:MM"。"""
    return f"{int(minutes) // 60:02d}:{int(minutes) % 60:02d}"


def calibrated_periods(override: dict = None) -> dict:
    """把校准表里「起止都合法」的节次挑出来。

    Args:
        override: 覆盖表 {"5": ["11:45", "12:25"], ...}。

    Returns:
        dict: {节次号: (开始分钟, 结束分钟)}；格式不合法或 start >= end 的整条丢掉。
    """
    result = {}
    for key, value in (override or {}).items():
        try:
            number = int(key)
        except (TypeError, ValueError):
            continue
        if not isinstance(value, (list, tuple)) or len(value) != 2:
            continue
        start, end = _to_minutes(value[0]), _to_minutes(value[1])
        if start is None or end is None or start >= end:
            continue
        result[number] = (start, end)
    return result


def gap_period_range(number, override: dict = None) -> tuple:
    """没校准到的节次：用左右**紧邻**两节的校准值，夹出它中间那段空档。

    真实的例子：课表里只有第 5 节（11:45-12:25）和第 7 节（14:15-15:00），
    中间缺的第 6 节其实就是 12:25-14:15 这段午休。
    与其显示程序里写死的默认作息（14:55-15:40，还会和真实的第 7 节撞在一起），
    不如直接认定它是午休，而且让这段时间真的能接住任务。

    只有「左右紧邻、中间恰好缺这一节」才算得出来；两边缺一边、或者连着缺好几节
    （没法判断这段怎么分）都返回 ("", "")，交给默认作息兜底，不瞎猜。

    Args:
        number: 节次号。
        override: 校准过的作息表。

    Returns:
        tuple: (开始, 结束)；算不出来返回 ("", "")。
    """
    try:
        number = int(number)
    except (TypeError, ValueError):
        return "", ""
    calibrated = calibrated_periods(override)
    if number in calibrated:
        return "", ""
    previous, following = number - 1, number + 1
    if previous not in calibrated or following not in calibrated:
        return "", ""
    gap_start = calibrated[previous][1]
    gap_end = calibrated[following][0]
    if gap_start >= gap_end:
        return "", ""
    return _to_hhmm(gap_start), _to_hhmm(gap_end)


def is_break_period(number, override: dict = None) -> bool:
    """这个节次是不是「没课的空档」（例如午休）。"""
    return bool(gap_period_range(number, override)[0])


def break_label(number, override: dict = None) -> str:
    """空档行的显示名：中午那段叫「午休」，其他时段叫「休息」。"""
    gap = gap_period_range(number, override)
    start = _to_minutes(gap[0]) if gap[0] else None
    if start is None:
        return ""
    return "午休" if 11 * 60 <= start < 15 * 60 else "休息"


def effective_period_range(number, override: dict = None) -> tuple:
    """一节「实际占哪段时间」：校准值 → 中间空档（午休）→ 默认作息。

    匹配时刻和画课表都走这一个口径，保证「左侧写着午休」和
    「12:30 的任务排进午休行」说的是同一件事。

    Args:
        number: 节次号。
        override: 校准过的作息表。

    Returns:
        tuple: (开始时间, 结束时间)。
    """
    gap_start, gap_end = gap_period_range(number, override)
    if gap_start:
        return gap_start, gap_end
    return period_time_range(number, override)


def row_time_range(row, override: dict = None) -> tuple:
    """返回课表一行的起止时间（行 = 一节课）。

    Args:
        row: PERIOD_ROWS 中的一项，例如 (7,)。
        override: 可选的作息覆盖表（见 period_time_range）。

    Returns:
        tuple: (开始时间, 结束时间)。
    """
    try:
        return effective_period_range(row[0], override)
    except (IndexError, TypeError):
        return "", ""


def row_label(row, override: dict = None) -> str:
    """返回一行的显示名，例如 (7,) -> "第7节"；没校准到的空档行 -> "午休"。

    Args:
        row: PERIOD_ROWS 中的一项，例如 (7,)。
        override: 校准过的作息表（给了它才知道这一行是不是午休空档）。
    """
    try:
        if len(row) == 1:
            return break_label(row[0], override) or f"第{row[0]}节"
        return f"第{row[0]}-{row[-1]}节"
    except (IndexError, TypeError):
        return ""


def row_key(row) -> str:
    """返回一行的短标识，例如 (7,) -> "7"，(1, 2) -> "1-2"。用作设置里的键。"""
    try:
        if len(row) == 1:
            return str(row[0])
        return f"{row[0]}-{row[-1]}"
    except (IndexError, TypeError):
        return ""


def period_numbers(override: dict = None, extra=None) -> tuple:
    """课表到底有哪几节：默认作息 ∪ 校准到的节次 ∪ 额外指定的节次。

    节次数**不能写死**：学校一天 13 节、14 节都有，同一个人不同学期也可能不一样。
    导入课表时校准到第几节、或者任务里写了第几节，课表就应该有那一行。

    Args:
        override: 校准过的作息表。
        extra: 额外的节次号（可迭代）。

    Returns:
        tuple: 升序节次号，例如 (1, 2, ..., 13, 14)。
    """
    numbers = {number for number, _, _ in CLASS_PERIODS}
    for source in (override or {}, extra or ()):
        keys = source.keys() if isinstance(source, dict) else source
        for key in keys:
            try:
                number = int(key)
            except (TypeError, ValueError):
                continue
            if number > 0:
                numbers.add(number)
    return tuple(sorted(numbers))


def period_rows(override: dict = None, extra=None) -> tuple:
    """课表的行：一天有哪几节，就有几行。

    Args:
        override: 校准过的作息表。
        extra: 额外的节次号（可迭代）。

    Returns:
        tuple: 行列表，例如 ((1,), (2,), ..., (13,), (14,))。
    """
    return tuple((number,) for number in period_numbers(override, extra))


def row_for_period(number: int, rows=None):
    """返回包含某个节次的行。

    Args:
        number: 节次号，例如 7。
        rows: 行列表（见 period_rows）；不给就用默认的 PERIOD_ROWS。

    Returns:
        tuple | None: 例如 (7,)；没有行包含该节次时返回 None。
    """
    try:
        number = int(number)
    except (TypeError, ValueError):
        return None
    for row in (rows if rows is not None else PERIOD_ROWS):
        if number in row:
            return row
    return None


def row_index_of_period(number: int, rows=None):
    """返回某个节次对应的行下标。

    Args:
        number: 节次号。
        rows: 行列表（见 period_rows）；不给就用默认的 PERIOD_ROWS。

    Returns:
        int | None: 行下标；不在表里返回 None。
    """
    table = list(rows if rows is not None else PERIOD_ROWS)
    row = row_for_period(number, table)
    if row is None:
        return None
    try:
        return table.index(row)
    except ValueError:
        return None


def period_number_at(hhmm: str, override: dict = None, prefer: str = "start"):
    """判断某个时刻属于第几节课。

    校准过的作息和默认作息可能重叠（例如默认第 5 节是 14:00-14:45，
    而学校实际第 7 节是 14:15 开始），所以这里不是取第一个命中的，
    而是按「最贴近」来选：
        prefer="start" —— 取开始时间最接近该时刻的那节课（判断是第几节开始）
        prefer="end"   —— 取结束时间最接近该时刻的那节课（判断上到第几节）

    Args:
        hhmm: "HH:MM"。
        override: 可选的作息覆盖表。
        prefer: "start" 或 "end"。

    Returns:
        int | None: 节次号；不在任何一节课内返回 None。
    """
    minutes = _to_minutes(hhmm)
    if minutes is None:
        return None

    hits = []
    for number in period_numbers(override):
        begin_str, finish_str = effective_period_range(number, override)
        begin, finish = _to_minutes(begin_str), _to_minutes(finish_str)
        if begin is None or finish is None:
            continue
        if begin <= minutes <= finish:
            distance = abs(finish - minutes) if prefer == "end" else abs(begin - minutes)
            hits.append((distance, number))

    if not hits:
        return None
    hits.sort()
    return hits[0][1]


def parse_period_span(text: str) -> tuple:
    """解析「节次范围」字段，例如 "7-9" / "第7-9节" / "7"。

    与 parse_period_label 的区别：这个要求整串就是节次，不会在长文本里乱抓数字。

    Args:
        text: 节次字段。

    Returns:
        tuple: (起始节次, 结束节次)；解析失败返回 (None, None)。
    """
    raw = str(text or "").strip()
    if not raw:
        return None, None
    match = re.match(r"^第?\s*(\d{1,2})\s*(?:[-~—–到至]\s*(\d{1,2}))?\s*节?$", raw)
    if not match:
        return None, None
    first = int(match.group(1))
    last = int(match.group(2) or first)
    if last < first:
        first, last = last, first
    return first, last


def period_span_from_times(start_time: str, end_time: str, override: dict = None) -> tuple:
    """按起止时间反推这条日程占哪几节课。

    Args:
        start_time: 开始时间 "HH:MM"。
        end_time: 结束时间 "HH:MM"（可空）。
        override: 可选的作息覆盖表。

    Returns:
        tuple: (起始节次, 结束节次)；判断不出来时返回 (None, None)。
    """
    first = period_number_at(start_time, override, prefer="start")
    if first is None:
        # 只填了结束时间（例如「11:30 前完成」）：就按结束时刻所在的那节课定位，
        # 不要因为缺开始时间就把整条任务当成"没有时间"
        only_end = period_number_at(end_time, override, prefer="end")
        if only_end is None:
            return None, None
        return only_end, only_end
    last = period_number_at(end_time, override, prefer="end") if end_time else None
    if last is None or last < first:
        last = first
    return first, last


def parse_period_label(text: str) -> tuple:
    """从课表描述里解析节次范围，例如 "第7 - 9节" -> (7, 9)、"第3节" -> (3, 3)。

    Args:
        text: 含节次写法的文本（ICS 的 DESCRIPTION、CSV 的节次列等）。

    Returns:
        tuple: (起始节次, 结束节次)；解析不出来时返回 (None, None)。
    """
    raw = str(text or "")
    match = re.search(r"第?\s*(\d{1,2})\s*(?:[-~—–到至]\s*(\d{1,2}))?\s*节", raw)
    if not match:
        return None, None
    first = int(match.group(1))
    last = int(match.group(2) or first)
    if last < first:
        first, last = last, first
    return first, last


def period_row_index(start_time: str, override: dict = None):
    """判断某个开始时间落在课表的哪一行。

    行 = 一节课，所以只有「开始时间落在该节课的 [开始, 结束] 区间内」才算命中。
    若同时落在多行（校准过的作息可能有重叠），取**起点最接近**的那一行。

    Args:
        start_time: "HH:MM" 字符串。
        override: 可选的作息覆盖表（见 period_time_range）。

    Returns:
        int | None: PERIOD_ROWS 的下标；没有时间或不在任何节次内时返回 None
                    （由界面放进「其他时段」）。
    """
    minutes = _to_minutes(start_time)
    if minutes is None:
        return None

    hits = []
    for index, row in enumerate(period_rows(override)):
        begin_str, finish_str = effective_period_range(row[0], override)
        begin, finish = _to_minutes(begin_str), _to_minutes(finish_str)
        if begin is None or finish is None:
            continue
        if begin <= minutes <= finish:
            hits.append((abs(begin - minutes), index))

    if not hits:
        return None
    hits.sort()
    return hits[0][1]


def period_row_index_by_period(number, override: dict = None):
    """按节次号定位课表行（导入的课表自带节次时用这个，比按时间猜更准）。

    Args:
        number: 节次号。
        override: 未使用，保留参数以便与 period_row_index 统一调用方式。

    Returns:
        int | None: PERIOD_ROWS 的下标。
    """
    return row_index_of_period(number)


def parse_period_spec(text: str) -> tuple:
    """把「第1-2节 / 1-2 / 第3节 / 3」解析成 (开始时间, 结束时间)。

    用于课程表 CSV：时间列既可以写 "08:00" 也可以写 "第1-2节"。

    Args:
        text: 节次写法。

    Returns:
        tuple: (开始时间, 结束时间)；无法识别时返回 (None, None)。
    """
    raw = str(text or "").strip()
    if not raw:
        return None, None
    match = re.match(r"^第?\s*(\d{1,2})\s*(?:[-~—到至]\s*(\d{1,2}))?\s*节?$", raw)
    if not match:
        return None, None
    first = int(match.group(1))
    last = int(match.group(2) or first)
    if first not in PERIOD_TIMES or last not in PERIOD_TIMES or last < first:
        return None, None
    return PERIOD_TIMES[first][0], PERIOD_TIMES[last][1]


# ---------------------------------------------------------------------------
# 七、学期与周次：让课程「每周重复」并按第几周显示
# ---------------------------------------------------------------------------
# 开学第一周的周一（默认值，可在侧边栏「学期设置」里改，改完存到 data/settings.json）
SEMESTER_START_DEFAULT = "2026-09-07"

# 一学期按多少周算（课表周次范围的上限）
WEEKS_PER_TERM = 20

# 重复方式
REPEAT_NONE = "none"        # 只在那一天
REPEAT_WEEKLY = "weekly"    # 每周重复（课程）
ALL_REPEATS = (REPEAT_NONE, REPEAT_WEEKLY)
REPEAT_LABELS = {
    REPEAT_NONE: "不重复",
    REPEAT_WEEKLY: "每周重复（课程）",
}

# 单双周
PARITY_ALL = "all"    # 每周都上
PARITY_ODD = "odd"    # 单周
PARITY_EVEN = "even"  # 双周
ALL_PARITIES = (PARITY_ALL, PARITY_ODD, PARITY_EVEN)
PARITY_LABELS = {
    PARITY_ALL: "每周",
    PARITY_ODD: "单周",
    PARITY_EVEN: "双周",
}


def monday_of(day: date) -> date:
    """返回某一天所在周的周一。"""
    return day - timedelta(days=day.weekday())


def week_number_of(day: date, semester_start) -> int:
    """计算某一天是开学第几周（第 1 周 = 开学第一周的周一那一周）。

    Args:
        day: 要计算的日期。
        semester_start: 开学第一周的周一（date 或 "YYYY-MM-DD"）。

    Returns:
        int | None: 第几周；日期在开学之前（或参数非法）时返回 None。
    """
    try:
        start = monday_of(semester_start if isinstance(semester_start, date)
                          else date.fromisoformat(str(semester_start)))
    except (ValueError, TypeError):
        return None
    delta_days = (monday_of(day) - start).days
    if delta_days < 0:
        return None  # 开学之前，不算周次
    return delta_days // 7 + 1


def monday_of_week(week_no: int, semester_start) -> date:
    """返回第 week_no 周的周一。

    Args:
        week_no: 第几周（从 1 开始）。
        semester_start: 开学第一周的周一。

    Returns:
        date: 该周的周一。
    """
    start = monday_of(semester_start if isinstance(semester_start, date)
                      else date.fromisoformat(str(semester_start)))
    return start + timedelta(weeks=max(int(week_no), 1) - 1)


def week_parity(week_no: int) -> str:
    """返回某一周是单周还是双周。"""
    return PARITY_ODD if int(week_no) % 2 == 1 else PARITY_EVEN


def parse_week_spec(text: str) -> tuple:
    """解析课程表里的「周次」写法。

    支持：``1-16`` / ``1-16周`` / ``第1-16周`` / ``1-8单`` / ``1-16双周`` / ``3`` / ``单周``

    Args:
        text: 周次写法。

    Returns:
        tuple: (起始周, 结束周, 单双周)；表示「不重复」时返回 None。
    """
    raw = str(text or "").strip()
    if not raw or raw in ("全部", "每周", "全周", "每周重复"):
        return None

    # 只写了「单周 / 双周」：默认整学期
    if raw in ("单", "单周", PARITY_LABELS[PARITY_ODD]):
        return 1, WEEKS_PER_TERM, PARITY_ODD
    if raw in ("双", "双周", PARITY_LABELS[PARITY_EVEN]):
        return 1, WEEKS_PER_TERM, PARITY_EVEN

    match = re.match(
        r"^第?\s*(\d{1,2})\s*(?:[-~—到至]\s*(\d{1,2}))?\s*周?\s*(单|双)?\s*周?$", raw
    )
    if not match:
        return None
    first = int(match.group(1))
    last = int(match.group(2) or first)
    if last < first:
        first, last = last, first
    parity = PARITY_ALL
    if match.group(3) == "单":
        parity = PARITY_ODD
    elif match.group(3) == "双":
        parity = PARITY_EVEN
    return first, last, parity
