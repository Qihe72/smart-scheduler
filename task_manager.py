"""
task_manager.py —— 本地日程数据管理（纯本地读写，不含任何 AI / 网络逻辑）。

数据存储：
    所有任务都保存在 config.DATA_FILE（即 data/schedules.json）中，
    文件内容是「列表」，每个元素是一个任务 dict：

        {
            "id": 1,                       # 自增整数，全局唯一
            "title": "写周报",              # 标题
            "type": "ddl",                 # event / ddl / subtask
            "date": "2025-01-31",          # 日期 YYYY-MM-DD
            "start_time": "09:00",         # 开始时间 HH:MM，可空字符串
            "end_time": "10:00",           # 结束时间 HH:MM，可空字符串
            "priority": "high",            # high / mid / low
            "done": False,                 # 是否已完成
            "parent_id": None,             # 所属父任务的 id，无则为 None
            "estimate_min": 0,             # 预计耗时（分钟），0 表示没写
            "created_at": "2025-01-30 21:05"  # 创建时间 YYYY-MM-DD HH:MM
        }

设计约定：
    * 所有函数「不抛异常给调用方」：出错时按语义返回 [] 或 False，
      并把错误原因写入 logging（不会污染 UI）。
    * 单文件的读-改-写不是并发安全的，本应用为单机单用户，够用。
"""

import json
import logging
import os
import time
from datetime import date, datetime, timedelta

# 兼容两种导入方式：
#   1) 作为包的一部分：`from smart_scheduler import task_manager`
#   2) 直接把 smart-scheduler/ 当作源码目录：`import task_manager`
try:  # pragma: no cover - 取决于调用方式
    from . import config, storage
except ImportError:  # pragma: no cover
    import config
    import storage

logger = logging.getLogger(__name__)

# 支持的日期 / 时间格式
DATE_FMT = "%Y-%m-%d"
TIME_FMT = "%H:%M"
DATETIME_FMT = "%Y-%m-%d %H:%M"

# 写盘时的重试策略：Windows 上文件可能被其他进程短暂占用
REPLACE_ATTEMPTS = 5
REPLACE_RETRY_DELAY = 0.08  # 秒，逐次线性退避


# ---------------------------------------------------------------------------
# 内部工具函数
# ---------------------------------------------------------------------------
def _now_str() -> str:
    """返回当前时间的字符串（YYYY-MM-DD HH:MM）。"""
    return datetime.now().strftime(DATETIME_FMT)


def _today_str() -> str:
    """返回今天的日期字符串（YYYY-MM-DD）。"""
    return datetime.now().strftime(DATE_FMT)


def _ensure_data_dir() -> None:
    """确保数据目录存在；不存在则创建（包括多级目录）。

    Raises:
        OSError: 目录无法创建时向上抛出，由调用方捕获。
    """
    os.makedirs(config.DATA_DIR, exist_ok=True)


def _read_all_json() -> list:
    """从磁盘读取原始 JSON 数据（**只给旧数据迁移/备份用**，见 storage.migrate_legacy_json）。

    Returns:
        list: 文件中的任务列表；文件不存在、内容为空或格式非法时返回 []。
    """
    path = config.DATA_FILE
    if not os.path.exists(path):
        return []
    try:
        # utf-8-sig：兼容带 BOM 的文件（例如用记事本另存为 UTF-8 时产生的 BOM）
        with open(path, "r", encoding="utf-8-sig") as f:
            content = f.read().strip()
        if not content:  # 空文件按空列表处理
            return []
        data = json.loads(content)
        if not isinstance(data, list):
            logger.error("数据文件 %s 的顶层结构不是列表，已忽略", path)
            return []
        return data
    except (OSError, json.JSONDecodeError) as exc:
        logger.error("读取数据文件 %s 失败：%s", path, exc)
        return []


def _write_all_json(tasks: list) -> bool:
    """把任务列表写成 JSON 文件（**只给旧数据迁移/导出用**）。

    Windows 上杀毒软件、文件索引、编辑器可能短暂占用文件，导致
    os.replace 偶发失败，所以这里做几次带退避的重试。

    Args:
        tasks: 待写入的任务列表。

    Returns:
        bool: 写入成功返回 True，失败返回 False。
    """
    if not isinstance(tasks, list):
        logger.error("save_tasks 需要 list，收到 %s", type(tasks).__name__)
        return False

    path = config.DATA_FILE
    tmp_path = f"{path}.tmp"
    try:
        _ensure_data_dir()
        with open(tmp_path, "w", encoding="utf-8") as f:
            # ensure_ascii=False：中文直接按 UTF-8 保存，文件可读性更好
            json.dump(tasks, f, ensure_ascii=False, indent=2)
    except OSError as exc:
        logger.error("写入临时文件 %s 失败：%s", tmp_path, exc)
        return False

    # 原子替换（带重试，避免被其他进程的短暂占用打断）
    for attempt in range(REPLACE_ATTEMPTS):
        try:
            os.replace(tmp_path, path)
            return True
        except OSError as exc:
            if attempt == REPLACE_ATTEMPTS - 1:
                logger.error("替换数据文件 %s 失败（已重试 %s 次）：%s",
                             path, REPLACE_ATTEMPTS, exc)
                break
            time.sleep(REPLACE_RETRY_DELAY * (attempt + 1))

    # 清理可能残留的临时文件
    try:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
    except OSError:
        pass
    return False


def _safe_int(value, default=None):
    """把 value 转成 int，失败时返回 default（内部工具函数）。

    Args:
        value: 任意待转换的值。
        default: 转换失败时的返回值。

    Returns:
        int | Any: 转换结果或 default。
    """
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _parse_date(value):
    """把 "YYYY-MM-DD" 字符串解析成 date；失败返回 None。"""
    try:
        return datetime.strptime(str(value).strip(), DATE_FMT).date()
    except (ValueError, TypeError):
        return None


def _next_id(tasks: list) -> int:
    """计算下一个可用的自增 id。

    Args:
        tasks: 现有任务列表。

    Returns:
        int: 现有最大 id + 1；列表为空或 id 非法时返回 1。
    """
    max_id = 0
    for task in tasks:
        if isinstance(task, dict):
            try:
                max_id = max(max_id, int(task.get("id", 0)))
            except (TypeError, ValueError):
                continue
    return max_id + 1


def _normalize_task(task: dict) -> dict:
    """把用户传入的任务 dict 补全为规范结构并做基础校验。

    Args:
        task: 用户传入的任务 dict，至少需要包含非空的 "title"。

    Returns:
        dict: 补全默认值后的任务 dict；缺少 title 时返回空 dict {} 表示非法。
    """
    if not isinstance(task, dict):
        return {}

    title = str(task.get("title", "")).strip()
    if not title:
        return {}

    # 类型不合法时退回「日程」
    task_type = task.get("type", config.TYPE_EVENT)
    if task_type not in config.ALL_TYPES:
        task_type = config.TYPE_EVENT

    # 优先级不合法时退回「中」
    priority = task.get("priority", config.PRIORITY_MID)
    if priority not in config.ALL_PRIORITIES:
        priority = config.PRIORITY_MID

    # parent_id：允许 None / 数字 / 数字字符串
    parent_id = task.get("parent_id", None)
    if parent_id in ("", None):
        parent_id = None
    else:
        try:
            parent_id = int(parent_id)
        except (TypeError, ValueError):
            parent_id = None

    # 预计耗时（分钟）：供「本周还排得下吗」的缺口分析用；0 表示没写，绝不瞎猜
    estimate_min = _safe_int(task.get("estimate_min"), 0) or 0
    if estimate_min < 0:
        estimate_min = 0

    # 重复方式 / 周次范围 / 单双周（课程表相关）
    repeat = str(task.get("repeat") or config.REPEAT_NONE).strip().lower()
    if repeat not in config.ALL_REPEATS:
        repeat = config.REPEAT_NONE
    if repeat == config.REPEAT_WEEKLY:
        week_start = _safe_int(task.get("week_start"), 1) or 1
        week_end = _safe_int(task.get("week_end"), config.WEEKS_PER_TERM) or config.WEEKS_PER_TERM
        week_start = max(1, week_start)
        if week_end < week_start:
            week_end = week_start
        week_parity = str(task.get("week_parity") or config.PARITY_ALL).strip().lower()
        if week_parity not in config.ALL_PARITIES:
            week_parity = config.PARITY_ALL
    else:
        # 不重复的任务不需要周次信息，存 None 保持数据干净
        week_start = week_end = None
        week_parity = config.PARITY_ALL

    # 截止类（DDL）语义修正：它只有「截止时刻」，没有起始时间。
    # 老数据如果把时刻填在 start_time 里，这里顺手迁移成截止时刻。
    start_time = str(task.get("start_time") or "").strip()
    end_time = str(task.get("end_time") or "").strip()
    if task_type == config.TYPE_DDL:
        if not end_time and start_time:
            end_time = start_time
        start_time = ""

    return {
        "id": task.get("id"),
        "title": title,
        "type": task_type,
        "date": str(task.get("date") or _today_str()),
        "start_time": start_time,
        "end_time": end_time,
        "priority": priority,
        "done": bool(task.get("done", False)),
        "parent_id": parent_id,
        "estimate_min": estimate_min,
        "created_at": str(task.get("created_at") or _now_str()),
        "repeat": repeat,
        "week_start": week_start,
        "week_end": week_end,
        "week_parity": week_parity,
        # 以下两项来自课表导入（可空）：节次范围 "7-9"、上课地点
        "periods": str(task.get("periods") or "").strip(),
        "location": str(task.get("location") or "").strip(),
    }


# ---------------------------------------------------------------------------
# 对外接口
# ---------------------------------------------------------------------------
def _read_all() -> list:
    """读取当前空间的全部任务。

    存储后端在 storage.py：多用户版按「空间码」存进 SQLite。
    刻意保持函数名与返回值不变，所以上层（界面、统计、导出）一行都不用改。

    Returns:
        list: 任务 dict 列表；出错返回 []。
    """
    return storage.load_tasks()


def _write_all(tasks: list) -> bool:
    """把任务列表整体写回当前空间。

    Args:
        tasks: 待写入的任务列表。

    Returns:
        bool: 成功 True，失败 False。
    """
    if not isinstance(tasks, list):
        logger.error("save_tasks 需要 list，收到 %s", type(tasks).__name__)
        return False
    return storage.save_tasks(tasks)


def load_tasks() -> list:
    """读取所有任务。

    Returns:
        list: 任务 dict 列表，按 id 升序排列；文件不存在或损坏时返回 []。
    """
    tasks = _read_all()

    # 过滤掉明显不是 dict 的脏数据，并按 id 排序，保证顺序稳定
    clean = [t for t in tasks if isinstance(t, dict)]
    try:
        clean.sort(key=lambda t: int(t.get("id", 0)))
    except (TypeError, ValueError):
        logger.warning("部分任务的 id 不是整数，已跳过排序")
    return clean


def save_tasks(tasks: list) -> bool:
    """把整个任务列表写回数据文件（覆盖写）。

    Args:
        tasks: 完整的任务列表。

    Returns:
        bool: 成功返回 True，失败返回 False。
    """
    return _write_all(tasks)


def add_task(task: dict) -> bool:
    """新增一个任务，并自动分配自增 id。

    Args:
        task: 任务 dict，必须包含非空 "title"；其余字段缺失时自动补默认值。
              函数会「就地」写入生成的 id / created_at（即传入的 dict 会被更新），
              调用方可直接从 task["id"] 读取新 id。

    Returns:
        bool: 添加成功返回 True；参数非法或写文件失败返回 False。
    """
    if not isinstance(task, dict):
        logger.error("add_task 需要 dict，收到 %s", type(task).__name__)
        return False

    tasks = _read_all()
    normalized = _normalize_task(task)
    if not normalized:
        logger.error("add_task 失败：缺少 title")
        return False

    # 分配自增 id 与创建时间（忽略调用方传入的 id，避免冲突）
    normalized["id"] = _next_id(tasks)
    if not task.get("created_at"):
        normalized["created_at"] = _now_str()

    tasks.append(normalized)
    if not _write_all(tasks):
        return False

    # 回填给调用方
    task.update(normalized)
    return True


def delete_task(task_id: int) -> bool:
    """按 id 删除任务；同时删除挂在它下面的子任务。

    Args:
        task_id: 要删除的任务 id。

    Returns:
        bool: 删除成功返回 True；任务不存在、id 非法或写文件失败返回 False。
    """
    try:
        target_id = int(task_id)
    except (TypeError, ValueError):
        logger.error("delete_task 收到非法 id：%r", task_id)
        return False

    tasks = _read_all()
    # 先找出要删的 id 集合：目标本身 + 它的直接子任务（parent_id 指向它）
    remove_ids = {target_id}
    for t in tasks:
        if isinstance(t, dict):
            try:
                if t.get("parent_id") is not None and int(t.get("parent_id")) == target_id:
                    remove_ids.add(int(t.get("id")))
            except (TypeError, ValueError):
                continue

    remaining = [
        t for t in tasks
        if not (isinstance(t, dict) and _safe_int(t.get("id")) in remove_ids)
    ]
    if len(remaining) == len(tasks):
        logger.warning("delete_task：未找到 id=%s 的任务", target_id)
        return False

    return _write_all(remaining)


def update_task(task_id: int, updates: dict) -> bool:
    """按 id 更新任务的部分字段。

    Args:
        task_id: 要更新的任务 id。
        updates: 需要修改的字段字典，例如 {"title": "新标题", "done": True}。
                 不允许通过这里修改 id 和 created_at。

    Returns:
        bool: 更新成功返回 True；任务不存在、参数非法或写文件失败返回 False。
    """
    if not isinstance(updates, dict) or not updates:
        logger.error("update_task 需要非空的 updates dict")
        return False

    target_id = _safe_int(task_id)
    if target_id is None:
        logger.error("update_task 收到非法 id：%r", task_id)
        return False

    tasks = _read_all()
    found = False
    for task in tasks:
        if not isinstance(task, dict):
            continue
        if _safe_int(task.get("id")) != target_id:
            continue
        # 逐字段更新；id / created_at 属于系统字段，不允许被覆盖
        for key, value in updates.items():
            if key in ("id", "created_at"):
                continue
            task[key] = value
        # 用规范化函数兜底，保证更新后结构依旧合法
        normalized = _normalize_task(task)
        if normalized:
            normalized["id"] = target_id
            normalized["created_at"] = task.get("created_at") or _now_str()
            task.clear()
            task.update(normalized)
            found = True
        break

    if not found:
        logger.warning("update_task：未找到 id=%s 的任务或更新后数据非法", target_id)
        return False

    return _write_all(tasks)


def get_tasks_by_date(date: str) -> list:
    """按日期筛选任务。

    Args:
        date: 日期字符串，格式 "YYYY-MM-DD"。

    Returns:
        list: 该日期下的任务列表；日期格式非法或没有任务时返回 []。
    """
    if not isinstance(date, str):
        logger.error("get_tasks_by_date 需要字符串日期，收到 %s", type(date).__name__)
        return []

    try:
        datetime.strptime(date.strip(), DATE_FMT)  # 仅做格式校验
    except ValueError:
        logger.error("get_tasks_by_date 收到非法日期：%r（应为 YYYY-MM-DD）", date)
        return []

    target = date.strip()
    result = [t for t in load_tasks() if str(t.get("date", "")) == target]

    # 排序规则：未完成在前，然后按开始时间、优先级
    def sort_key(task):
        """列表排序用的 key：未完成 > 早时间 > 高优先级。"""
        return (
            bool(task.get("done", False)),
            str(task.get("start_time") or "99:99"),
            config.PRIORITY_ORDER.get(task.get("priority"), 1),
        )

    try:
        result.sort(key=sort_key)
    except (TypeError, ValueError):
        logger.warning("任务排序时遇到异常数据，已返回未排序结果")
    return result


def get_upcoming_ddls(days: int = 7) -> list:
    """获取从今天起未来 N 天内、尚未完成的截止任务（type == "ddl"）。

    Args:
        days: 向后看的天数，默认 7；传入非法值时按 7 处理。

    Returns:
        list: 范围内的 DDL 任务列表，按日期、时间升序；出错或无结果时返回 []。
    """
    try:
        days = int(days)
    except (TypeError, ValueError):
        logger.warning("get_upcoming_ddls 收到非法 days=%r，已按 7 天处理", days)
        days = 7
    if days < 0:
        days = 0

    today = datetime.now().date()
    end_date = today + timedelta(days=days)

    result = []
    for task in load_tasks():
        # 只关心「截止」类型且未完成的
        if task.get("type") != config.TYPE_DDL or task.get("done"):
            continue
        try:
            task_date = datetime.strptime(str(task.get("date", "")), DATE_FMT).date()
        except ValueError:
            # 日期字段非法的任务直接跳过，不影响其他数据
            continue
        if today <= task_date <= end_date:
            result.append(task)

    try:
        # 截止类没有 start_time，用截止时刻排序
        result.sort(key=lambda t: (
            str(t.get("date", "")),
            str(t.get("end_time") or t.get("start_time") or "99:99"),
        ))
    except (TypeError, ValueError):
        logger.warning("DDL 排序时遇到异常数据，已返回未排序结果")
    return result


def mark_done(task_id: int) -> bool:
    """把指定任务标记为已完成（done=True）。

    Args:
        task_id: 任务 id。

    Returns:
        bool: 标记成功返回 True；任务不存在、id 非法或写文件失败返回 False。
    """
    return update_task(task_id, {"done": True})


def get_task_stats() -> dict:
    """统计任务概览，供页面顶部的指标卡片（st.metric）使用。

    「已结束」指每周重复的课上完了（当前周次超过 week_end），这类不再计入待办。

    Returns:
        dict: {
            "total":    总任务数,
            "done":     手动标记完成的数量,
            "pending":  待办数（total - done - finished）,
            "ddl":      截止类（type == "ddl"）任务数,
            "finished": 已结课的课程数,
        }
        读取失败时各项均为 0（不会抛异常）。
    """
    tasks = load_tasks()
    total = len(tasks)
    done = sum(1 for t in tasks if t.get("done"))
    ddl = sum(1 for t in tasks if t.get("type") == config.TYPE_DDL)
    # 只读一次设置，避免每个任务都去读文件
    semester_start = (load_settings() or {}).get("semester_start")
    finished = sum(1 for t in tasks if is_task_finished(t, semester_start=semester_start))
    return {
        "total": total,
        "done": done,
        "pending": max(total - done - finished, 0),
        "ddl": ddl,
        "finished": finished,
    }


def last_occurrence_date(task: dict, semester_start=None):
    """推算「每周重复」的这门课**最后一次上课**是哪一天。

    按 week_end 和单双周倒推：双周课如果 week_end 落在单周，实际最后一周要往前挪一周。

    Args:
        task: 任务 dict。
        semester_start: 开学第一周的周一；不传则读本地设置。

    Returns:
        date | None: 最后一次上课的日期；不是每周重复的课、或数据不全时返回 None。
    """
    if not isinstance(task, dict):
        return None
    if str(task.get("repeat") or config.REPEAT_NONE) != config.REPEAT_WEEKLY:
        return None
    anchor = _parse_date(task.get("date"))
    if anchor is None:
        return None  # 没有原始日期就不知道是星期几

    week_end = _safe_int(task.get("week_end"))
    if week_end is None or week_end < 1:
        return None
    week_start = _safe_int(task.get("week_start"), 1) or 1
    parity = str(task.get("week_parity") or config.PARITY_ALL)

    week = week_end
    if parity != config.PARITY_ALL:
        while week >= week_start and config.week_parity(week) != parity:
            week -= 1
        if week < week_start:
            return None  # 按这个单双周要求，它一次也上不了

    if semester_start is None:
        semester_start = (load_settings() or {}).get("semester_start")
    try:
        monday = config.monday_of_week(week, semester_start)
    except (ValueError, TypeError):
        return None
    return monday + timedelta(days=anchor.weekday())


def is_task_finished(task: dict, today: date = None, semester_start=None,
                     now: datetime = None) -> bool:
    """判断一条日程是不是「已经结束」了。

    只有**每周重复**的课（课表导入的课程）才会自动结束，判定依据是
    **最后一次课有没有上完**，而不是简单地看周次：

        * 最后一次课在昨天或更早        → 已结束
        * 最后一次课就在今天、且已下课  → 已结束（没有填下课时间则算还没结束）
        * 最后一次课还没到              → 进行中

    这样「本周就结课」的课，上完最后一次就立刻结束，不会拖到下周一。

    自己手动添加的一次性日程（以及没有周次信息的任务）**不会**自动结束：
    那种情况手动点「完成」或删除更稳妥，免得误判把还没做的事吞掉。

    Args:
        task: 任务 dict。
        today: 基准日期，默认今天。
        semester_start: 开学第一周的周一；不传则读本地设置。
        now: 当前时间（判断「今天下课了没」用），默认此刻。

    Returns:
        bool: 已结束返回 True。
    """
    if not isinstance(task, dict):
        return False
    if str(task.get("repeat") or config.REPEAT_NONE) != config.REPEAT_WEEKLY:
        return False  # 一次性日程：手动结束
    if task.get("done"):
        return False  # 手动标记过完成的算「已完成」，不重复统计

    last_date = last_occurrence_date(task, semester_start)
    if last_date is None:
        return False

    today = today or date.today()
    if last_date < today:
        return True
    if last_date > today:
        return False

    # 最后一次课就在今天：下课时间过了才算结束
    end_time = str(task.get("end_time") or "").strip()
    if not end_time:
        return False
    try:
        hour, minute = (int(part) for part in end_time.split(":")[:2])
    except (ValueError, TypeError):
        return False
    current = now or datetime.now()
    return (current.hour, current.minute) >= (hour, minute)


def occurrence_passed(task: dict, day: date, now: datetime = None) -> bool:
    """判断一条日程在 day 这一天的**那一次**是不是已经过去了。

    和 is_task_finished() 的区别：那个判断的是「整门课结课了没」，
    这个判断的是「这一次课/这件事过点了没」——
    比如下午三点时，今天早上 08:30-09:55 的课就已经算过去了。

    规则：
        * day 在今天之前        → 已过去
        * day 在今天之后        → 还没到
        * day 就是今天          → 有下课时间就比下课时间；只有开始时间就比开始时间；
                                  没有时间（比如 DDL）不下结论
        * 没有 start_time 的任务（DDL 等）→ 不下结论，仍按普通样式显示

    Args:
        task: 任务 dict。
        day: 这一格对应的日期。
        now: 当前时间，默认此刻。

    Returns:
        bool: 这一次已经过去返回 True。
    """
    if not isinstance(task, dict) or not isinstance(day, date):
        return False
    if not str(task.get("start_time") or "").strip():
        return False  # 没有具体时间的（DDL）不按「过点」处理

    today = date.today()
    if day < today:
        return True
    if day > today:
        return False

    # 就在今天：比下课时间（没有下课时间就比开始时间）
    mark = str(task.get("end_time") or "").strip() or str(task.get("start_time") or "").strip()
    if not mark:
        return False
    try:
        hour, minute = (int(part) for part in mark.split(":")[:2])
    except (ValueError, TypeError):
        return False
    current = now or datetime.now()
    return (current.hour, current.minute) >= (hour, minute)


def ends_this_week(task: dict, today: date = None, semester_start=None) -> bool:
    """判断这门课是不是「本周结课」（最后一次课在今天到本周日之间）。

    用来在界面上给快结束的课一个提示。

    Args:
        task: 任务 dict。
        today: 基准日期，默认今天。
        semester_start: 开学第一周的周一。

    Returns:
        bool: 本周还会上最后一次课返回 True。
    """
    last_date = last_occurrence_date(task, semester_start)
    if last_date is None:
        return False
    if task.get("done") or is_task_finished(task, today, semester_start):
        return False
    today = today or date.today()
    sunday = today + timedelta(days=6 - today.weekday())
    return today <= last_date <= sunday


def clear_done_tasks() -> int:
    """删除所有已完成（done=True）的任务。

    用于页面上的「一键清空已完成任务」按钮。

    Returns:
        int: 实际删除的条数；
             0 表示没有已完成的任务（无需改动）；
             -1 表示写文件失败（数据保持原样）。
    """
    tasks = _read_all()
    remaining = [t for t in tasks if not (isinstance(t, dict) and t.get("done"))]
    removed = len(tasks) - len(remaining)
    if removed == 0:
        return 0
    if not _write_all(remaining):
        return -1
    logger.info("已清空 %s 条已完成任务", removed)
    return removed


def task_occurs_on(task: dict, day: date, semester_start=None) -> bool:
    """判断某条任务在指定日期是否发生（课程「每周重复」的核心逻辑）。

    规则：
        * 不重复的任务：只有 date 等于 day 时才发生
        * 每周重复的任务：星期几相同，且 day 所在的周次落在 [week_start, week_end]，
          且满足单双周要求（all / odd / even）
        * 没有学期开始日期（或 day 在开学前）时，每周重复退化为「只在 date 当天」

    Args:
        task: 任务 dict。
        day: 待判断的日期。
        semester_start: 开学第一周的周一（date 或 "YYYY-MM-DD"）。

    Returns:
        bool: 该任务当天是否发生。
    """
    if not isinstance(task, dict) or not isinstance(day, date):
        return False

    task_date = _parse_date(task.get("date"))
    if task_date is None:
        return False

    if str(task.get("repeat") or config.REPEAT_NONE) != config.REPEAT_WEEKLY:
        return task_date == day

    # ---- 每周重复 ----
    if task_date.weekday() != day.weekday():
        return False
    if semester_start is None:
        return task_date == day

    week_no = config.week_number_of(day, semester_start)
    if week_no is None:
        return False

    week_start = _safe_int(task.get("week_start"), 1) or 1
    week_end = _safe_int(task.get("week_end"), config.WEEKS_PER_TERM) or config.WEEKS_PER_TERM
    if not (week_start <= week_no <= week_end):
        return False

    parity = str(task.get("week_parity") or config.PARITY_ALL)
    if parity != config.PARITY_ALL and config.week_parity(week_no) != parity:
        return False
    return True


# ---------------------------------------------------------------------------
# 本地设置（学期开始日期）
# ---------------------------------------------------------------------------
def load_settings() -> dict:
    """读取本地设置（目前只有学期开始日期）。

    Returns:
        dict: 至少包含 {"semester_start": "YYYY-MM-DD"}；
              文件缺失/损坏时返回默认值，不会抛异常。
    """
    defaults = {"semester_start": config.SEMESTER_START_DEFAULT, "period_times": {}}
    # 设置也是**每人一份**的：不同学校的作息表、学期起点都不一样（见 storage.py）
    data = storage.load_settings_raw()
    if not isinstance(data, dict):
        logger.error("设置结构异常，已忽略")
        return defaults

    # 逐项校验，坏值退回默认
    semester_start = str(data.get("semester_start") or "").strip()
    if _parse_date(semester_start) is None:
        semester_start = defaults["semester_start"]

    period_times = {}
    raw_times = data.get("period_times")
    if isinstance(raw_times, dict):
        for key, value in raw_times.items():
            if isinstance(value, (list, tuple)) and len(value) == 2:
                period_times[str(key)] = [str(value[0] or ""), str(value[1] or "")]
    return {"semester_start": semester_start, "period_times": period_times}


def save_settings(settings: dict) -> bool:
    """保存本地设置（**按空间**存进 SQLite，见 storage.py）。

    Args:
        settings: 设置 dict，目前支持 {"semester_start": "YYYY-MM-DD"} 与 {"period_times": {...}}。

    Returns:
        bool: 保存成功返回 True，失败返回 False。
    """
    if not isinstance(settings, dict):
        logger.error("save_settings 需要 dict，收到 %s", type(settings).__name__)
        return False

    merged = load_settings()
    if "semester_start" in settings:
        raw = str(settings.get("semester_start") or "").strip()
        if _parse_date(raw) is None:
            logger.error("save_settings 收到非法日期：%r", raw)
            return False
        merged["semester_start"] = raw

    if "period_times" in settings:
        raw_times = settings.get("period_times")
        if not isinstance(raw_times, dict):
            logger.error("save_settings 收到非法 period_times")
            return False
        cleaned = {}
        for key, value in raw_times.items():
            if isinstance(value, (list, tuple)) and len(value) == 2:
                cleaned[str(key)] = [str(value[0] or ""), str(value[1] or "")]
        merged["period_times"] = cleaned

    # 写进「当前空间」的设置记录 —— 不同学校的作息与学期起点互不影响
    return storage.save_settings_raw(merged)


# ---------------------------------------------------------------------------
# 简单的自测入口：`python task_manager.py` 可直接跑一遍基本流程
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    print("数据文件：", config.DATA_FILE)
    print("初始任务数：", len(load_tasks()))

    demo = {
        "title": "示例：提交课程报告",
        "type": config.TYPE_DDL,
        "date": _today_str(),
        "start_time": "18:00",
        "priority": config.PRIORITY_HIGH,
        "parent_id": None,
    }
    if add_task(demo):
        print("已添加任务，id =", demo["id"], "created_at =", demo["created_at"])
        print("未来 7 天 DDL：", get_upcoming_ddls(7))
        print("今日任务：", get_tasks_by_date(_today_str()))
        print("标记完成：", mark_done(demo["id"]))
        print("删除测试数据：", delete_task(demo["id"]))
