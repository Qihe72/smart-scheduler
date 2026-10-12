"""
planner.py —— 排期决策：把「这周还剩多少空档」和「这周还有多少事」算在一起。

为什么单独一个模块：
    * 这里全是**纯函数**（输入任务、作息表、行占用情况，输出数字与建议），
      不碰界面、不读文件、不联网 —— 所以能像 config.py 一样被单元测试直接覆盖；
    * 依赖只有 config，保持「UI → 领域 → 常量」的单向依赖。

三个概念（下面的结论就是用它们拼出来的）：
    空档 free   —— 课表里既没课、也没被排任务的**节次**能提供的分钟数；
    需求 demand —— 本周内待办任务自己写的「预计耗时」（estimate_min，分钟）之和；
    缺口 gap    —— 需求 - 空档；大于 0 表示这周排不下，得挪时间或砍事情。

刻意「不猜」：没写预计耗时的任务**不计入需求**，只单独数出来提醒你。
宁可说「有 3 件没估，这个判断还不准」，也不替用户编一个耗时 —— 
这和项目里「算不准就不猜」（午休认定、默认作息）是同一条原则。
"""

from datetime import date  # noqa: F401 - 仅用于文档里的类型说明

try:  # pragma: no cover - 取决于调用方式
    from . import config
except ImportError:  # pragma: no cover
    import config

# 一天最多按 24 小时算，防止手填出离谱的数字把结论带偏
MAX_DAY_MINUTES = 24 * 60


def _minutes_of(hhmm) -> int:
    """把 "HH:MM" 转成「当天第几分钟」；格式不对返回 0。"""
    try:
        hour, minute = str(hhmm).strip().split(":")[:2]
        return int(hour) * 60 + int(minute)
    except (AttributeError, TypeError, ValueError):
        return 0


def task_estimate(task: dict) -> int:
    """取一条任务的预计耗时（分钟）。

    没写、非法、负数一律当 0（= 还没估）。

    Args:
        task: 任务 dict。

    Returns:
        int: 大于等于 0 的分钟数。
    """
    if not isinstance(task, dict):
        return 0
    try:
        value = int(task.get("estimate_min") or 0)
    except (TypeError, ValueError):
        return 0
    return value if value > 0 else 0


def format_minutes(minutes) -> str:
    """把分钟数写成人话：40 分钟 / 1.5 小时 / 2 小时。

    Args:
        minutes: 分钟数。

    Returns:
        str: 人话；0 或非法值返回 "—"。
    """
    try:
        minutes = int(minutes)
    except (TypeError, ValueError):
        return "—"
    if minutes <= 0:
        return "—"
    if minutes < 60:
        return f"{minutes} 分钟"
    hours = minutes / 60
    if abs(hours - round(hours)) < 0.05:
        return f"{int(round(hours))} 小时"
    return f"{hours:.1f} 小时"


def row_minutes(row, period_times: dict = None) -> int:
    """一节课有多少分钟（用校准过的作息算）。

    Args:
        row: 课表的一行，例如 (7,)。
        period_times: 校准过的作息表。

    Returns:
        int: 分钟数；作息缺失或起止不合法时返回 0（这种行不计入空档）。
    """
    try:
        start, end = config.row_time_range(row, period_times)
    except (AttributeError, TypeError, ValueError):
        return 0
    begin, finish = _minutes_of(start), _minutes_of(end)
    if begin <= 0 or finish <= begin:
        return 0
    return min(finish - begin, MAX_DAY_MINUTES)


def free_minutes_by_day(days: list, class_row_minutes: dict,
                        occupied_rows_by_day: dict) -> dict:
    """算出每天还剩多少分钟空档。

    只数**真正的课**：被任务占掉的行算忙，其余的行按各自的时长累加。
    午休那种「空档行」由调用方排除在 class_row_minutes 之外，所以不算空闲时间。

    Args:
        days: 这一周 7 天的 date 列表。
        class_row_minutes: {行下标: 该节多少分钟}，只包含算作「课」的行。
        occupied_rows_by_day: {"2026-09-25": {2, 3, 4}, ...}，被任务占掉的行下标。

    Returns:
        dict: {日期字符串: 空档分钟数}。
    """
    result = {}
    for day in days:
        taken = set(occupied_rows_by_day.get(day.isoformat()) or set())
        free = sum(
            minutes for index, minutes in (class_row_minutes or {}).items()
            if index not in taken
        )
        result[day.isoformat()] = free
    return result


def split_demand(pending_tasks: list) -> tuple:
    """把待办分成「估过工时的」和「没估的」。

    Args:
        pending_tasks: 本周发生、且还没完成的任务。

    Returns:
        tuple: (需求总分钟, [(任务, 分钟), ...], [没估的任务, ...])
    """
    estimated, unestimated, total = [], [], 0
    for task in pending_tasks or []:
        if not isinstance(task, dict):
            continue
        minutes = task_estimate(task)
        if minutes:
            estimated.append((task, minutes))
            total += minutes
        else:
            unestimated.append(task)
    return total, estimated, unestimated


def _advice(free_total: int, demand: int, gap: int, unestimated: list,
            busiest: tuple) -> list:
    """把数字翻译成能照做的几句话（第一条是结论，其余是补充）。"""
    lines = []
    if demand:
        if gap > 0:
            lines.append(
                f"⚠️ 这周排不下：要做 {format_minutes(demand)}，"
                f"课表只剩 {format_minutes(free_total)}，还差 {format_minutes(gap)}。"
            )
            lines.append("要么把不急的挪到下周，要么先做最靠近截止的那一件。")
        else:
            lines.append(
                f"✅ 这周还排得下：要做 {format_minutes(demand)}，"
                f"课表剩 {format_minutes(free_total)}"
                f"（余 {format_minutes(free_total - demand)}）。"
            )
    else:
        lines.append("本周还没有带「预计耗时」的待办 —— 给任务填上耗时，这里才会给判断。")
    if unestimated:
        lines.append(
            f"另有 {len(unestimated)} 件没写预计耗时，**没有**计入上面的需求，"
            "所以结论可能偏乐观。"
        )
    if busiest and busiest[1] > 0:
        lines.append(f"空档最多的是 {busiest[0]}（{format_minutes(busiest[1])}），适合放需要整块时间的事。")
    return lines


def plan_week(days: list, pending_tasks: list, class_row_minutes: dict,
              occupied_rows_by_day: dict) -> dict:
    """把「空档」和「需求」算成一份可以照做的结论。

    Args:
        days: 这一周 7 天的 date 列表。
        pending_tasks: 本周发生、还没完成的任务（由调用方筛好，保持本函数纯粹）。
        class_row_minutes: {行下标: 该节多少分钟}，只包含算作「课」的行。
        occupied_rows_by_day: 每天被任务占掉的行下标集合。

    Returns:
        dict: {
            "free_minutes_by_day": {日期: 分钟},
            "free_total":          本周空档合计（分钟）,
            "demand_minutes":      本周需求合计（分钟，只算估过的）,
            "gap_minutes":         需求 - 空档（> 0 表示排不下）,
            "busiest_day":         空档最多的那天（日期字符串，可能为 ""）,
            "busiest_free_minutes": 那天的空档分钟数,
            "estimated":           [(任务, 分钟), ...],
            "unestimated":         [没写耗时的任务, ...],
            "advice":              [结论, 补充, ...],
        }
    """
    free_each = free_minutes_by_day(days, class_row_minutes, occupied_rows_by_day)
    free_total = sum(free_each.values())
    demand, estimated, unestimated = split_demand(pending_tasks)
    gap = demand - free_total
    busiest = max(free_each.items(), key=lambda item: item[1]) if free_each else ("", 0)
    return {
        "free_minutes_by_day": free_each,
        "free_total": free_total,
        "demand_minutes": demand,
        "gap_minutes": gap,
        "busiest_day": busiest[0],
        "busiest_free_minutes": busiest[1],
        "estimated": estimated,
        "unestimated": unestimated,
        "advice": _advice(free_total, demand, gap, unestimated, busiest),
    }
