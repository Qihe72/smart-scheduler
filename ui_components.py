"""
ui_components.py —— Streamlit 界面组件层。

职责边界（重要）：
    本模块【只负责 UI】—— 负责把数据画出来、把用户的交互收上来，
    绝不直接读写 data/schedules.json。所有数据操作一律通过 task_manager
    （load_tasks / add_task / mark_done ...）完成，
    AI 解析一律通过 ai_parser 完成。

提供的组件：
    render_week_view(tasks)  —— 本周课表：行 = 节次（一节课一节课），列 = 周一到周日
    render_ddl_list()        —— 未来 7 天截止提醒（≤2 天红色告警）
    render_add_form()        —— 手动添加任务表单
    render_natural_input()   —— 自然语言输入 + 追问 + 逐条确认（可编辑）后入库
    render_task_manager()    —— 日程管理：修改 / 完成切换 / 删除已录入的日程
    render_sidebar()         —— 侧边栏（tabs：自然语言 / 手动添加，另有清理已完成）
    render_flash()           —— 展示上一次操作的结果提示（供 main.py 主区域调用）

颜色约定（见 _CSS）：
    日程 = 蓝色系卡片，DDL = 红色系卡片，子任务 = 绿色系卡片，
    已完成 = 灰色 + 删除线，今天所在列 = 蓝色高亮描边。
"""

import html
import json
import logging
import socket
from datetime import date, datetime, time, timedelta

# streamlit 是 UI 层必需的依赖（见 requirements.txt）。
# 这里做容错 import：缺少 streamlit 时本模块依然可以被 import，
# 真正调用渲染函数时会抛出带安装提示的 RuntimeError，而不是在 import 阶段崩掉。
try:
    import streamlit as st

    STREAMLIT_AVAILABLE = True
except ImportError:  # pragma: no cover - 仅在缺少依赖时触发
    st = None
    STREAMLIT_AVAILABLE = False

# 数据操作全部走 task_manager（按要求导入其中的函数）
try:  # pragma: no cover - 取决于调用方式
    from . import ai_parser, config, planner, storage
    from .task_manager import (
        add_task,
        clear_done_tasks,
        delete_task,
        get_upcoming_ddls,
        ends_this_week,
        is_task_finished,
        load_settings,
        occurrence_passed,
        load_tasks,
        mark_done,
        save_settings,
        task_occurs_on,
        update_task,
    )
except ImportError:  # pragma: no cover
    import ai_parser
    import config
    import planner
    import storage
    from task_manager import (
        add_task,
        clear_done_tasks,
        delete_task,
        get_upcoming_ddls,
        ends_this_week,
        is_task_finished,
        load_settings,
        occurrence_passed,
        load_tasks,
        mark_done,
        save_settings,
        task_occurs_on,
        update_task,
    )

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
WEEKDAY_CN = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]

# 任务类型 → 卡片配色 class
TYPE_CSS_CLASS = {
    config.TYPE_EVENT: "ss-card-event",
    config.TYPE_DDL: "ss-card-ddl",
    config.TYPE_SUBTASK: "ss-card-subtask",
}

# 优先级 → 小标签配色 class
PRIORITY_CSS_CLASS = {
    config.PRIORITY_HIGH: "ss-pri-high",
    config.PRIORITY_MID: "ss-pri-mid",
    config.PRIORITY_LOW: "ss-pri-low",
}

# session_state 中使用的 key（统一加 ss_ 前缀，避免与页面代码冲突）
SS_NL_RESULT = "ss_nl_result"           # 自然语言解析结果（原始 AI 返回）
SS_NL_ITEMS = "ss_nl_items"             # 拍平后的「待确认条目」列表（可在界面上编辑）
SS_NL_EDIT = "ss_nl_edit_index"         # 当前正在编辑的条目下标，None 表示没有
SS_NL_SOURCE = "ss_nl_source_text"      # 自然语言原始输入（追问时要用）
SS_FLASH = "ss_flash"                   # 操作结果提示 ("success"/"error"/"info", 文案)
SS_MANAGE_EDIT = "ss_manage_edit_id"    # 正在编辑的日程 id，None 表示没有
SS_MANAGE_DELETE = "ss_manage_delete_id"  # 正在等待确认删除的日程 id
SS_DECOMPOSE = "ss_decompose_id"          # 正在拆解的日程 id，None 表示没有
SS_DECOMPOSE_ITEMS = "ss_decompose_items"  # AI 拆出来的子任务（待确认），None 表示还没拆
SS_WEEK_OFFSET = "ss_week_offset"       # 周视图的偏移：0 = 本周，1 = 下一周，-1 = 上一周

# 控制流异常：这类异常是 Streamlit 用来中断脚本的正常机制，绝不能被错误边界吞掉。
# 不同 Streamlit 版本里这两个类的位置不一样，能 import 到就用精确类型，
# 同时保留「按类名判断」的兜底。
CONTROL_FLOW_EXCEPTION_NAMES = {"RerunException", "StopException"}
CONTROL_FLOW_EXCEPTION_TYPES = []
for _module_path in (
    "streamlit.runtime.scriptrunner_utils.exceptions",
    "streamlit.runtime.scriptrunner.control",
    "streamlit.runtime.scriptrunner",
):
    try:
        _mod = __import__(_module_path, fromlist=["RerunException", "StopException"])
        for _name in ("RerunException", "StopException"):
            _cls = getattr(_mod, _name, None)
            if isinstance(_cls, type) and _cls not in CONTROL_FLOW_EXCEPTION_TYPES:
                CONTROL_FLOW_EXCEPTION_TYPES.append(_cls)
    except ImportError:
        continue
CONTROL_FLOW_EXCEPTION_TYPES = tuple(CONTROL_FLOW_EXCEPTION_TYPES)


# ---------------------------------------------------------------------------
# 样式：圆角 + 柔和阴影 + 低饱和配色
# ---------------------------------------------------------------------------
_CSS = """
<style>
/* ---------- 整体 ---------- */
.ss-section-title {
    font-size: 15px; font-weight: 700; color: #1d2939;
    margin: 4px 0 10px 0; letter-spacing: .2px;
}
.ss-app-title {
    font-size: 18px; font-weight: 800; color: #1d2939; margin-bottom: 6px;
}
.ss-hint { font-size: 12px; color: #667085; }

/* ---------- 周视图：一张表格，行 = 每节课，列 = 星期 ---------- */
.ss-table {
    width: 100%; border-collapse: separate; border-spacing: 5px 3px;
    table-layout: fixed; margin-top: 2px;
}
.ss-th {
    text-align: center; font-size: 12px; font-weight: 700; color: #344054;
    background: #ffffff; border: 1px solid #eaecf0; border-radius: 10px;
    padding: 5px 2px; font-weight: 700;
}
.ss-th-today {
    color: #1d4ed8; border-color: #2f6fed; background: #eef4ff;
    box-shadow: 0 0 0 2px rgba(47, 111, 237, .12);
}
.ss-th-corner, .ss-td-gutter {
    width: 78px; text-align: center; border: none; background: transparent;
    font-size: 10px; font-weight: 700; color: #98a2b3; padding: 0 2px;
}
.ss-day-date { font-size: 11px; font-weight: 500; color: #667085; }
.ss-today-badge {
    display: inline-block; background: #2f6fed; color: #fff;
    border-radius: 999px; font-size: 9px; padding: 1px 6px;
    margin-left: 3px; vertical-align: middle;
}

/* 左侧节次栏 */
.ss-gutter {
    background: #f8fafc; border: 1px solid #eef1f6; border-radius: 10px;
    padding: 5px 3px; text-align: center;
}
.ss-gutter-name { font-size: 11px; font-weight: 700; color: #475467; }
.ss-gutter-time { font-size: 9px; color: #98a2b3; line-height: 1.35; margin-top: 2px; }

/* 格子 */
.ss-td {
    vertical-align: top; padding: 3px; height: 46px;
    border: 1px solid #eef1f6; border-radius: 10px; background: #fdfefe;
}
.ss-td-today { background: #f7faff; border-color: #dbe6ff; }
.ss-td-empty { border-style: dashed; }
/* 连堂课：一个跨多行的格子，卡片撑满整格 —— 中间没有任何缝隙 */
.ss-td-block { padding: 3px; }
.ss-card-fill { height: 100%; box-sizing: border-box; display: flex;
                flex-direction: column; justify-content: center; }

/* 同一格里有两条以上日程（撞课）：并排成几列，每列里的卡片按自己的节次行对齐。
   以前是「每张卡都 height:100% 往下堆」，两张卡就是 200% 高，必然溢出到
   下面那一行的「空闲」格子上面 —— 看起来就是卡片错位 + 空闲没去掉。 */
.ss-td-multi { padding: 0; }              /* 内边距交给内层，高度才没有额外误差 */
.ss-block-cols {
    display: flex; gap: 3px; box-sizing: border-box;
    height: calc(100% + 2px);             /* 100% 是内容框，+2px 把上下边框补回来 */
    padding: 3px; position: relative;
}
.ss-block-col { display: flex; flex-direction: column; flex: 1 1 0; min-width: 0; }
/* 一条日程占的「带」：flex-basis:0 + flex-grow:行数 → 高度严格按节次行数分配 */
.ss-band { flex-basis: 0; min-height: 0; display: flex; flex-direction: column;
           overflow: hidden; }
/* 占位用的空带（这条日程开始之前 / 结束之后的那几行） */
.ss-band-gap { flex-basis: 0; min-height: 0; }
/* 带里的卡片撑满这一带；卡自带的 5px 下间距必须去掉，否则会把下面的带顶歪 */
.ss-band > .ss-card { flex: 1 1 auto; min-height: 0; margin-bottom: 0; padding: 4px 6px; }
/* 撞课角标：同一节课被两条日程占住 */
.ss-badge-conflict {
    display: inline-block; background: #fff4e5; color: #b54708;
    border: 1px solid #f7d9a8; border-radius: 999px;
    font-size: 9px; padding: 0 5px; margin-left: 4px;
    font-weight: 600; vertical-align: middle;
}
.ss-empty {
    font-size: 9px; color: #cfd6e0; letter-spacing: 2px;
}

/* ---------- 「今日」列表（手机上最实用的视图） ---------- */
.ss-tl-item {
    display: flex; gap: 8px; align-items: stretch;
    background: #ffffff; border: 1px solid #eaecf0; border-radius: 12px;
    padding: 8px 10px; margin-bottom: 6px;
    box-shadow: 0 1px 3px rgba(16, 24, 40, .06);
}
.ss-tl-passed { opacity: .55; }
.ss-tl-bar { width: 4px; border-radius: 999px; background: #98a2b3; flex: 0 0 4px; }
.ss-tl-bar-event   { background: #2f6fed; }
.ss-tl-bar-ddl     { background: #e5484d; }
.ss-tl-bar-subtask { background: #2fa96b; }
.ss-tl-time {
    font-size: 12px; font-weight: 700; color: #344054;
    flex: 0 0 84px; padding-top: 1px;
}
.ss-tl-title { font-size: 13px; font-weight: 700; color: #1d2939; }
.ss-tl-meta { font-size: 11px; color: #667085; margin-top: 2px; }
.ss-tl-empty {
    text-align: center; color: #98a2b3; font-size: 13px;
    padding: 24px 0; background: #fbfcfe; border: 1px dashed #e4e7ec; border-radius: 12px;
}

/* ---------- 手机上使用 ---------- */
.ss-mobile-url {
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 13px; font-weight: 700; color: #1d4ed8;
    background: #f6f9ff; border: 1px solid #dbe6ff; border-radius: 10px;
    padding: 8px 10px; word-break: break-all; text-align: center; margin: 6px 0;
}

/* ---------- 窄屏（手机）自适应 ---------- */
.ss-table-wrap { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
@media (max-width: 760px) {
    /* 8 列课表在手机上压扁就没法看了：让它横向滑动，列保持可读宽度 */
    .ss-table { min-width: 620px; border-spacing: 3px 2px; }
    .ss-th { font-size: 10px; padding: 3px 1px; border-radius: 8px; }
    .ss-th-corner, .ss-td-gutter { width: 44px; font-size: 9px; }
    .ss-gutter { padding: 3px 1px; border-radius: 8px; }
    .ss-gutter-name { font-size: 9px; }
    .ss-gutter-time { font-size: 8px; }
    .ss-td { height: 38px; padding: 2px; border-radius: 8px; }
    .ss-card { font-size: 9px; padding: 4px 5px; border-radius: 8px; }
    .ss-card-title { font-size: 9px; }
    .ss-card-meta, .ss-card-loc { font-size: 8px; }
    .ss-tl-item { padding: 7px 8px; }
    .ss-tl-time { flex: 0 0 70px; font-size: 11px; }
    .ss-tl-title { font-size: 12px; }
}

/* ---------- 任务卡片 ---------- */
.ss-card {
    border-radius: 10px; padding: 6px 8px; margin-bottom: 5px;
    font-size: 11px; line-height: 1.35; color: #1d2939;
    box-shadow: 0 1px 3px rgba(16, 24, 40, .08);
    border-left: 3px solid #98a2b3;
    word-break: break-word;
}
.ss-card-title { font-weight: 700; margin-bottom: 2px; }
.ss-card-meta { font-size: 10px; opacity: .85; }
.ss-card-loc  { font-size: 10px; opacity: .8; margin-top: 1px; }

/* 日程：蓝色系 */
.ss-card-event  { background: linear-gradient(135deg, #eaf2ff 0%, #dbe8ff 100%);
                  border-left-color: #2f6fed; color: #123a75; }
/* DDL：红色系 */
.ss-card-ddl    { background: linear-gradient(135deg, #ffeef0 0%, #ffdfe3 100%);
                  border-left-color: #e5484d; color: #8f1d1d; }
/* 子任务：绿色系 */
.ss-card-subtask{ background: linear-gradient(135deg, #eafaf1 0%, #d8f3e3 100%);
                  border-left-color: #2fa96b; color: #125c37; }
/* 已结课：淡显（每周重复的课上完最后一次课就自动进入这个状态） */
.ss-card-finished { opacity: .55; }
/* 表头里的空闲节数 */
.ss-free { font-size: 9px; font-weight: 500; color: #98a2b3; margin-top: 1px; }
/* 「待排时间」行：浅黄底，和已排好的课区分开 */
.ss-td-unscheduled { background: #fffdf6; border-color: #f0e6cf; }
/* 午休这类「空档行」：不是课，占位字也不写「空闲」 */
.ss-td-break { background: #fcfcfd; border-style: dashed; border-color: #f1f3f7; }
.ss-empty-break { color: #d9dee7; letter-spacing: 3px; }

/* 已经上过 / 已经过去：灰色角标 */
.ss-badge-passed {
    display: inline-block; background: #f2f4f7; color: #667085;
    border: 1px solid #e4e7ec; border-radius: 999px;
    font-size: 9px; padding: 0 5px; margin-left: 4px;
    font-weight: 600; vertical-align: middle;
}
/* 本周结课：提前提示一下 */
.ss-badge-ending {
    display: inline-block; background: #e8f1ff; color: #1d4ed8;
    border: 1px solid #cddffd; border-radius: 999px;
    font-size: 9px; padding: 0 5px; margin-left: 4px;
    font-weight: 600; vertical-align: middle;
}
.ss-badge-finished {
    display: inline-block; background: #eef1f6; color: #667085;
    border-radius: 999px; font-size: 9px; padding: 0 5px; margin-left: 4px;
    font-weight: 600; vertical-align: middle;
}

/* 已完成：灰色 + 删除线 */
.ss-card-done {
    background: #f2f4f7 !important; border-left-color: #98a2b3 !important;
    color: #667085 !important; text-decoration: line-through;
    box-shadow: none; opacity: .9;
}
/* 优先级小标签 */
.ss-pri { font-weight: 700; }
.ss-pri-high { color: #b42318; }
.ss-pri-mid  { color: #b54708; }
.ss-pri-low  { color: #475467; }

/* ---------- 未来 7 天 DDL 列表 ---------- */
.ss-ddl {
    border-radius: 10px; padding: 9px 12px; margin-bottom: 7px;
    box-shadow: 0 1px 3px rgba(16, 24, 40, .07);
    border-left: 4px solid #2f6fed; background: #f6f9ff;
}
/* 距离截止 ≤2 天：红色告警 */
.ss-ddl-urgent {
    border-left-color: #e5484d;
    background: linear-gradient(135deg, #fff1f2 0%, #ffe4e6 100%);
}
.ss-ddl-title { font-size: 13px; font-weight: 700; color: #1d2939; }
.ss-ddl-meta  { font-size: 11px; color: #667085; margin-top: 2px; }
.ss-ddl-days  { font-size: 12px; font-weight: 800; color: #2f6fed; }
.ss-ddl-days-urgent { font-size: 12px; font-weight: 800; color: #b42318; }
.ss-badge-urgent {
    display: inline-block; background: #e5484d; color: #fff;
    border-radius: 999px; font-size: 10px; padding: 1px 7px; margin-left: 6px;
}

/* ---------- 解析结果预览 ---------- */
.ss-preview {
    background: #ffffff; border: 1px solid #eaecf0; border-radius: 12px;
    padding: 8px 10px; box-shadow: 0 1px 2px rgba(16, 24, 40, .04);
}
.ss-preview-head {
    font-size: 12px; font-weight: 700; color: #344054; margin: 2px 0 6px 0;
}

/* ---------- 错误边界：友好错误卡片 ---------- */
.ss-error-card {
    background: #fff5f5; border: 1px solid #ffd7d7; border-left: 5px solid #e5484d;
    border-radius: 12px; padding: 14px 16px; margin: 8px 0;
    box-shadow: 0 1px 3px rgba(16, 24, 40, .06);
}
.ss-error-title { font-size: 15px; font-weight: 800; color: #8f1d1d; margin-bottom: 4px; }
.ss-error-hint { font-size: 12px; color: #a15c5c; line-height: 1.5; }

/* ---------- 统计指标卡片 ---------- */
.ss-stat-hint { font-size: 11px; color: #667085; }
</style>
"""


# ---------------------------------------------------------------------------
# 内部工具：Streamlit 依赖检查 / 通用小工具
# ---------------------------------------------------------------------------
def _require_streamlit() -> None:
    """确认 streamlit 可用，否则抛出带安装提示的异常。

    Raises:
        RuntimeError: 当前环境没有安装 streamlit 时抛出。
    """
    if not STREAMLIT_AVAILABLE:
        raise RuntimeError(
            "未安装 streamlit，无法渲染界面。请先执行：pip install -r requirements.txt"
        )


def _inject_css() -> None:
    """把自定义 CSS 注入当前页面（幂等，可重复调用）。"""
    st.markdown(_CSS, unsafe_allow_html=True)


def _safe_rerun() -> None:
    """触发一次脚本重跑（兼容不同版本的 Streamlit）。

    注意：真实 Streamlit 中该调用会通过抛异常中断当前脚本，属于正常行为。
    """
    rerun = getattr(st, "rerun", None) or getattr(st, "experimental_rerun", None)
    if callable(rerun):
        rerun()


def _set_flash(kind: str, message: str) -> None:
    """记录一条「操作结果提示」，供下一次重跑后展示。

    Args:
        kind: "success" / "error" / "info" / "warning"。
        message: 提示文案。
    """
    st.session_state[SS_FLASH] = (kind, message)


def set_flash(kind: str, message: str) -> None:
    """_set_flash 的公开别名，供页面代码（main.py）在改动数据后调用。

    Args:
        kind: "success" / "error" / "info" / "warning"。
        message: 提示文案。
    """
    _set_flash(kind, message)


def render_flash() -> None:
    """展示并清除上一次操作留下的提示（没有则什么都不做）。

    需要在数据变更后调用 _safe_rerun() 的场景，用它来跨重跑传递成功/失败提示。
    """
    _require_streamlit()
    flash = st.session_state.get(SS_FLASH)
    if not flash:
        return
    kind, message = flash
    st.session_state[SS_FLASH] = None
    {
        "success": st.success,
        "error": st.error,
        "warning": st.warning,
        "info": st.info,
    }.get(kind, st.info)(message)


# ---------------------------------------------------------------------------
# 错误边界：任何未捕获异常都渲染成友好提示，而不是让整页崩掉
# ---------------------------------------------------------------------------
def is_control_flow_exception(exc: BaseException) -> bool:
    """判断异常是否为 Streamlit 的控制流信号（必须原样向上抛）。

    Streamlit 的 st.rerun() / st.stop() 是通过抛异常实现的，
    错误边界如果把它当成普通错误吞掉，页面刷新就会失效。

    Args:
        exc: 待判断的异常。

    Returns:
        bool: 属于控制流信号（或非 Exception 的 BaseException）时返回 True。
    """
    if not isinstance(exc, Exception):
        # KeyboardInterrupt / SystemExit / GeneratorExit 等，一律不拦截
        return True
    # 1) 精确类型判断（能 import 到 Streamlit 的异常类时）
    if CONTROL_FLOW_EXCEPTION_TYPES and isinstance(exc, CONTROL_FLOW_EXCEPTION_TYPES):
        return True
    # 2) 按类名判断（兜底：类所在模块路径随版本变化）
    return any(cls.__name__ in CONTROL_FLOW_EXCEPTION_NAMES for cls in type(exc).__mro__)


def render_error_page(exc: BaseException, where: str = "页面") -> None:
    """把一个未捕获异常渲染成友好的错误卡片（技术细节收进折叠面板）。

    Args:
        exc: 捕获到的异常。
        where: 出错的位置描述，例如「周视图」「侧边栏」。

    Returns:
        None
    """
    if st is None:  # 连 streamlit 都没有，只能打印
        print(f"[{where}] 渲染失败：{type(exc).__name__}: {exc}")
        return

    try:
        _inject_css()  # 保证错误卡片也有样式
    except Exception:
        pass

    message = str(exc).strip() or "没有更多信息"
    st.markdown(
        f'<div class="ss-error-card">'
        f'<div class="ss-error-title">😥 「{html.escape(str(where))}」加载失败</div>'
        f'<div class="ss-error-hint">其他区域不受影响，可以继续使用。<br>'
        f'错误类型：{html.escape(type(exc).__name__)} · {html.escape(message[:200])}</div>'
        f"</div>",
        unsafe_allow_html=True,
    )
    try:
        with st.expander("查看技术细节（排查用）"):
            st.exception(exc)
    except Exception:
        st.caption(f"错误信息：{message}")


def safe_render(func, *args, where: str = None, **kwargs) -> bool:
    """错误边界：执行一个渲染函数，把未捕获异常转成友好错误卡片。

    Args:
        func: 要执行的渲染函数（如 render_week_view）。
        *args: 传给 func 的位置参数。
        where: 出错位置描述，默认取函数名。
        **kwargs: 传给 func 的关键字参数。

    Returns:
        bool: 正常渲染完成返回 True，发生异常并展示错误卡片后返回 False。
    """
    _require_streamlit()
    label = where or getattr(func, "__name__", "组件")
    try:
        func(*args, **kwargs)
        return True
    except BaseException as exc:  # noqa: BLE001 - 这里就是要兜住一切
        if is_control_flow_exception(exc):
            raise  # st.rerun()/st.stop() 必须原样抛出
        logger.exception("「%s」渲染时发生未捕获异常", label)
        render_error_page(exc, label)
        return False


def _today() -> date:
    """返回今天（单点封装，方便测试时替换）。"""
    return date.today()


def _week_days(today: date = None) -> list:
    """返回本周周一到周日共 7 个 date。

    Args:
        today: 基准日期，默认今天。

    Returns:
        list: [周一, 周二, ..., 周日]。
    """
    today = today or _today()
    monday = today - timedelta(days=today.weekday())
    return [monday + timedelta(days=i) for i in range(7)]


def _semester_start() -> date:
    """读取「开学第一周的周一」设置（读不到就用 config 里的默认值）。

    Returns:
        date: 开学第一周的周一。
    """
    try:
        raw = (load_settings() or {}).get("semester_start")
        parsed = date.fromisoformat(str(raw))
        return parsed
    except (ValueError, TypeError, AttributeError):
        try:
            return date.fromisoformat(config.SEMESTER_START_DEFAULT)
        except (ValueError, TypeError):
            return _today()


def _period_times() -> dict:
    """读取从导入课表校准出来的作息表（每节课的起止时间）。

    Returns:
        dict: {"1": ["08:30", "09:10"], ...}；读不到时返回 {}（用 config 默认值）。
    """
    try:
        times = (load_settings() or {}).get("period_times")
        return times if isinstance(times, dict) else {}
    except Exception:  # noqa: BLE001 - 设置读不出来不该影响页面
        return {}


def _period_rows(period_times: dict = None, tasks: list = None) -> tuple:
    """这次渲染要用哪几行。

    行不能写死：学校一天的节次数不一样（13 节 / 14 节都有），
    所以「默认作息里的节次 ∪ 校准到的节次 ∪ 任务里写过的节次」都算数 ——
    别人导入了有第 14 节课的课表，或者手填一条第 14 节的任务，课表就该多出这一行。

    Args:
        period_times: 校准过的作息表。
        tasks: 全部任务。

    Returns:
        tuple: 行列表，例如 ((1,), (2,), ..., (14,))。
    """
    extra = []
    for task in tasks or []:
        if not isinstance(task, dict):
            continue
        first, last = config.parse_period_span(task.get("periods"))
        if first:
            extra.extend(range(first, last + 1))
    return config.period_rows(period_times, extra)


def _task_rows(task: dict, period_times: dict = None, rows=None):
    """决定一条任务占课表的哪几行（连堂课会占多行）。

    优先用课表自带的节次（导入的 ICS/CSV 里 DESCRIPTION 带着「第7 - 9节」，
    比按时间反推更准——各校作息不同，时间可能落在相邻两节课里），
    没有节次信息时才按起止时间去匹配作息表。

    Args:
        task: 任务 dict。
        period_times: 校准过的作息表（每节课的起止时间）。
        rows: 课表的行列表（见 _period_rows）；不给就用默认的 13 节。

    Returns:
        tuple | None: (首行下标, 末行下标, 首节次, 末节次)；无法判断返回 None。
    """
    first_period, last_period = config.parse_period_span(task.get("periods"))
    if first_period is None:
        first_period, last_period = config.period_span_from_times(
            str(task.get("start_time") or ""), str(task.get("end_time") or ""), period_times
        )
    if first_period is None:
        return None

    first_row = config.row_index_of_period(first_period, rows)
    last_row = config.row_index_of_period(last_period, rows)
    if first_row is None:
        return None
    if last_row is None or last_row < first_row:
        last_row = first_row
    return first_row, last_row, first_period, last_period


def _slot_index(start_time: str):
    """判断任务应该落在哪个时段。

    规则（保证任何时间都能落进唯一时段，不会丢任务）：
        hour < 12            → 上午（含 8 点前）
        12 <= hour < 18      → 下午（含 12:00~13:59 午休）
        hour >= 18           → 晚上（含 18:00 之后）

    Args:
        start_time: "HH:MM" 字符串。

    Returns:
        int | None: 0/1/2 表示上午/下午/晚上；没有时间或格式非法时返回 None（进「全天」）。
    """
    if not isinstance(start_time, str) or not start_time.strip():
        return None
    try:
        hour = int(start_time.strip().split(":")[0])
    except (ValueError, IndexError):
        return None
    if hour < 12:
        return 0
    if hour < 18:
        return 1
    return 2


def _task_card_html(task: dict, fill: bool = False, finished: bool = False,
                    ending: bool = False, passed: bool = False,
                    conflict: bool = False) -> str:
    """把一条任务渲染成彩色卡片的 HTML。

    Args:
        task: 任务 dict（task_manager 的结构）。
        fill: True 时让卡片撑满整个格子（连堂课跨多行时用）。
        finished: 整门课已经结课了（淡显 + 「已结课」角标）。
        ending: 本周还会上最后一次课（给个提示角标）。
        passed: 这一次课/这件事已经过去了（淡显 + 「已结束」角标）。
        conflict: 这节课被两条日程同时占住（挂 ⚠ 撞课 角标）。

    Returns:
        str: 卡片 HTML 片段。
    """
    title = html.escape(str(task.get("title") or "(无标题)"))
    ttype = task.get("type", config.TYPE_EVENT)
    done = bool(task.get("done"))

    css = TYPE_CSS_CLASS.get(ttype, "ss-card-event")
    if done:
        css += " ss-card-done"  # 灰色 + 删除线
    if finished or passed:
        css += " ss-card-finished"  # 已结课 / 已经上过：淡显

    # 元信息：时间段（或类型）+ 优先级
    start = str(task.get("start_time") or "").strip()
    end = str(task.get("end_time") or "").strip()
    if ttype == config.TYPE_DDL:
        # 截止类只有一个「截止时刻」，没有开始时间
        when = f"{end} 截止" if end else "当天截止"
    elif start and end:
        when = f"{start}-{end}"
    elif start:
        when = start
    elif end:
        # 只有结束时间（例如子任务「11:30 前做完」）——不能把时间藏起来
        when = f"截至 {end}"
    else:
        when = config.TYPE_LABELS.get(ttype, "")

    priority = task.get("priority", config.PRIORITY_MID)
    pri_label = config.PRIORITY_LABELS.get(priority, "")
    pri_css = PRIORITY_CSS_CLASS.get(priority, "ss-pri-mid")
    pri_html = f'<span class="ss-pri {pri_css}">{html.escape(pri_label)}</span>' if pri_label else ""
    if finished:
        done_html = '<span class="ss-badge-finished">已结课</span>'
    elif done:
        done_html = " ✅"
    elif passed:
        done_html = '<span class="ss-badge-passed">已结束</span>'
    elif ending:
        done_html = '<span class="ss-badge-ending">本周结课</span>'
    else:
        done_html = ""
    if conflict:
        done_html += '<span class="ss-badge-conflict">⚠ 撞课</span>'

    # 节次（连堂课一眼看出占几节，例如「第7-9节」）
    periods = str(task.get("periods") or "").strip()
    if periods:
        when = f"{when} · 第{periods}节"

    # 写了预计耗时就在卡片上显示出来（缺口分析用的就是它）
    estimate = planner.task_estimate(task)
    if estimate:
        when = f"{when} · ≈{planner.format_minutes(estimate)}"

    # 上课地点（课表导入会带上）：单独一行，太长就截断
    location = str(task.get("location") or "").strip()
    location_html = ""
    if location:
        shown = location if len(location) <= 16 else location[:15] + "…"
        location_html = f'<div class="ss-card-loc">📍 {html.escape(shown)}</div>'

    if fill:
        css += " ss-card-fill"

    return (
        f'<div class="ss-card {css}">'
        f'<div class="ss-card-title">{title}{done_html}</div>'
        f'<div class="ss-card-meta">{html.escape(when)} · {pri_html}</div>'
        f"{location_html}"
        f"</div>"
    )


def _gutter_html(name: str, time_range: tuple = None) -> str:
    """渲染课表左侧的节次栏（节次名 + 时间）。"""
    if time_range and time_range[0]:
        time_html = (
            f'<div class="ss-gutter-time">{time_range[0]}<br>{time_range[1]}</div>'
        )
    else:
        time_html = ""
    return f'<div class="ss-gutter"><div class="ss-gutter-name">{html.escape(name)}</div>{time_html}</div>'


def _sort_tasks(tasks: list) -> list:
    """格子内排序：未完成在前，其次按开始时间。"""
    return sorted(tasks, key=lambda t: (
        bool(t.get("done", False)),
        str(t.get("start_time") or "99:99"),
    ))


def _merge_blocks(spans: list) -> list:
    """把「(首行, 末行, 任务)」整理成互不重叠的格子。

    正常情况下每门课各自一块；如果同一时段撞课（时间重叠），
    就把它们并进同一个格子里，避免 rowspan 打架把表格画歪。

    Args:
        spans: [(首行下标, 末行下标, 任务), ...]

    Returns:
        list: [{"first": 首行, "last": 末行, "tasks": [任务, ...],
                "spans": [(首行, 末行, 任务), ...]}, ...]，按行排序。
            spans 保留**每条任务自己**占的行：同一个格子里撞课时，
            渲染要按各自的行去占位，不能都撑满整格。
    """
    blocks = []
    for first, last, task in sorted(spans, key=lambda item: (item[0], item[1])):
        for block in blocks:
            if last < block["first"] or first > block["last"]:
                continue
            block["first"] = min(block["first"], first)
            block["last"] = max(block["last"], last)
            block["tasks"].append(task)
            block["spans"].append((first, last, task))
            break
        else:
            blocks.append({"first": first, "last": last, "tasks": [task],
                           "spans": [(first, last, task)]})

    # 合并之后可能又和别的块重叠了，反复合并到稳定
    changed = True
    while changed:
        changed = False
        for i in range(len(blocks)):
            for j in range(i + 1, len(blocks)):
                a, b = blocks[i], blocks[j]
                if b["first"] <= a["last"] and a["first"] <= b["last"]:
                    a["first"] = min(a["first"], b["first"])
                    a["last"] = max(a["last"], b["last"])
                    a["tasks"].extend(b["tasks"])
                    a["spans"].extend(b.get("spans") or [])
                    blocks.pop(j)
                    changed = True
                    break
            if changed:
                break

    blocks.sort(key=lambda item: item["first"])
    for block in blocks:
        block["tasks"] = _sort_tasks(block["tasks"])
    return blocks


def _build_week_cells(tasks: list, days: list, semester_start: date = None,
                      period_times: dict = None, rows=None) -> tuple:
    """把任务分配到课表格子里，并算出每门课跨哪几行。

    这里用的是**发生（occurrence）**而不是「日期相等」：
    每周重复的课程会在它应该出现的每一周都显示出来。

    归位规则（按优先级）：
        1. 截止类（DDL）→ 「⏰ 当天截止」行（截止是个时间点，不占课时）
        2. 有节次（如 "7-9"）→ 直接排进对应节次行（**没有开始时间也照样排进去**，
           这是「子任务要确切放到课表里」的关键）
        3. 有开始时间 → 按时间匹配节次行；匹配不上（如 12:30）进「其他时段」
        4. 时间、节次都没有 → 「📝 待排时间」行（还没安排时间的日程/子任务）

    Args:
        tasks: 全部任务。
        days: 这一周 7 天的 date 列表。
        semester_start: 开学第一周的周一（用于计算周次与单双周）。
        period_times: 校准过的作息表（用于按时间兜底定位）。
        rows: 课表的行列表（见 _period_rows）；不给就用默认的 13 节。

    Returns:
        tuple: (day_cells, row_has_content)
            day_cells[日期字符串] = {
                "blocks": [{"first": 首行, "last": 末行, "tasks": [...]}, ...],
                "deadlines": [...],    # 截止类
                "unscheduled": [...],  # 日程/子任务，但还没排时间
                "other": [...],        # 有开始时间但不在任何一节课里
            }
            row_has_content: {"deadlines": bool, "unscheduled": bool, "other": bool}
    """
    day_cells = {}
    row_has_content = {"deadlines": False, "unscheduled": False, "other": False}

    for day in days:
        entry = {"blocks": [], "deadlines": [], "unscheduled": [], "other": []}
        spans = []
        for task in tasks or []:
            if not isinstance(task, dict):
                continue
            if not task_occurs_on(task, day, semester_start):
                continue

            # 1) 截止类不占课时，单独一行
            if str(task.get("type") or "") == config.TYPE_DDL:
                entry["deadlines"].append(task)
                row_has_content["deadlines"] = True
                continue

            start = str(task.get("start_time") or "").strip()
            end = str(task.get("end_time") or "").strip()
            has_period = bool(config.parse_period_span(task.get("periods"))[0])

            # 4) 起止时间、节次全都没有 → 待排时间（只填了结束时间也算有时间）
            if not start and not end and not has_period:
                entry["unscheduled"].append(task)
                row_has_content["unscheduled"] = True
                continue

            # 2)(3) 有节次按节次排，否则按开始时间排
            task_rows = _task_rows(task, period_times, rows)
            if task_rows is None:  # 有开始时间但不在任何节次内（如 12:30）
                entry["other"].append(task)
                row_has_content["other"] = True
                continue
            spans.append((task_rows[0], task_rows[1], task))

        entry["deadlines"] = _sort_tasks(entry["deadlines"])
        entry["unscheduled"] = _sort_tasks(entry["unscheduled"])
        entry["other"] = _sort_tasks(entry["other"])
        entry["blocks"] = _merge_blocks(spans)
        day_cells[day.isoformat()] = entry

    return day_cells, row_has_content

def _td_simple(tasks: list, is_today: bool, day: date = None, now: datetime = None,
               extra_css: str = "", empty_text: str = "空闲",
               empty_css: str = "") -> str:
    """渲染一个普通格子（不跨行）：有内容就放卡片，没内容就显示占位字。

    占位字默认是「空闲」；午休这种空档行由调用方传成「午休」，
    免得把午休也算成"没课的空闲"。
    """
    css = "ss-td ss-td-today" if is_today else "ss-td"
    css += extra_css
    if not tasks:
        return (f'<td class="{css} ss-td-empty">'
                f'<span class="ss-empty{empty_css}">{empty_text}</span></td>')
    cards = "".join(
        _task_card_html(
            task,
            passed=bool(day is not None and occurrence_passed(task, day, now)),
        )
        for task in tasks
    )
    return f'<td class="{css}">{cards}</td>'


def _block_task_spans(block: dict, task: dict):
    """取「某条任务在这个格子里自己占的第几行到第几行」。

    一个格子可能被两条日程共用（撞课），而它们各占的行不一样：
    例如「应用光学 第3-5节」和「子任务 第5节」同格，
    前者占 3 行、后者只占最后 1 行。渲染时要按各自的行去占位。

    Args:
        block: _merge_blocks() 产出的块。
        task: 块里的某条任务。

    Returns:
        tuple: (首行下标, 末行下标)；找不到时退回整块的范围。
    """
    for first, last, item in block.get("spans") or []:
        if item is task:
            return first, last
    return block["first"], block["last"]


def _block_conflicts(block: dict) -> set:
    """算出块里哪些任务和别的任务**真的**占到了同一节课。

    Returns:
        set: 撞课任务的 id() 集合（dict 不能做 set 元素，用 id 代替）。
    """
    spans = block.get("spans") or []
    hit = set()
    for i in range(len(spans)):
        a_first, a_last, a_task = spans[i]
        for j in range(i + 1, len(spans)):
            b_first, b_last, b_task = spans[j]
            if b_first <= a_last and a_first <= b_last:
                hit.add(id(a_task))
                hit.add(id(b_task))
    return hit


def _td_block(block: dict, is_today: bool, day: date = None, now: datetime = None) -> str:
    """渲染连堂课的格子：一个 rowspan 跨多行的单元格。

    两种画法：
        1. 格子里只有一条日程 —— 卡片撑满整格（连堂课看起来是一整块，中间没缝）；
        2. 格子里挤了两条以上（撞课，或子任务压在某节课上）—— 并排成几列，
           每张卡按**自己的节次行**占位，既不会叠在一起，也不会溢到下面那一格。
    """
    css = "ss-td ss-td-block ss-td-today" if is_today else "ss-td ss-td-block"
    span = block["last"] - block["first"] + 1
    tasks = list(block["tasks"])
    conflicts = _block_conflicts(block)

    if len(tasks) == 1:
        card = _task_card_html(
            tasks[0],
            fill=True,
            passed=bool(day is not None and occurrence_passed(tasks[0], day, now)),
        )
        return f'<td class="{css}" rowspan="{span}">{card}</td>'

    columns = []
    for task in tasks:
        first, last = _block_task_spans(block, task)
        lead = max(first - block["first"], 0)   # 前面空几条（用空带占位）
        body = max(last - first + 1, 1)         # 自己占几条
        tail = max(block["last"] - last, 0)     # 后面空几条
        card = _task_card_html(
            task,
            fill=True,
            passed=bool(day is not None and occurrence_passed(task, day, now)),
            conflict=id(task) in conflicts,
        )
        parts = []
        if lead:
            parts.append(f'<div class="ss-band-gap" style="flex-grow:{lead}"></div>')
        parts.append(f'<div class="ss-band" style="flex-grow:{body}">{card}</div>')
        if tail:
            parts.append(f'<div class="ss-band-gap" style="flex-grow:{tail}"></div>')
        columns.append('<div class="ss-block-col">' + "".join(parts) + "</div>")

    inner = '<div class="ss-block-cols">' + "".join(columns) + "</div>"
    return f'<td class="{css} ss-td-multi" rowspan="{span}">{inner}</td>'


def _week_table_html(days: list, day_cells: dict, row_has_content: dict,
                     today: date, period_times: dict, rows=None) -> str:
    """把整周渲染成一张 HTML 表格。

    用真表格（而不是一堆并列的列）是为了能用 ``rowspan`` 做**真正的合并单元格**：
    两节课的日程就是一个跨两行的格子，三节课的跨三行，中间没有任何缝隙。

    课表上方最多两行，都不占课时、也不参与合并：
        ⏰ 当天截止  —— 截止类（DDL）
        📝 待排时间  —— 还没安排时间的日程 / 子任务（给它填个节次就会排进下面）
    每列表头还会显示当天「空闲 N 节」，方便一眼看出哪天还有空。

    中间那种「没校准到、但左右两节能夹出空档」的节次会显示成**午休**：
    它不是课，占位字写「午休」而不是「空闲」，也不计进「空闲 N 节」；
    但落在 12:25-14:15 的任务会真的排进这一行（见 config.gap_period_range）。

    Args:
        days: 这一周 7 天。
        day_cells: _build_week_cells() 的结果。
        row_has_content: 这三行各自是否需要渲染。
        today: 今天（用于高亮）。
        period_times: 校准过的作息表。
        rows: 课表的行列表（见 _period_rows）；不给就用默认作息的行。

    Returns:
        str: 整张表的 HTML。
    """
    # 注意：这里的局部变量不能叫 rows —— 那是本函数的参数（传进来的行列表），
    # 同名会把参数遮蔽掉，导致 table_rows 永远退回默认的 13 行。
    display_rows = []
    if row_has_content["deadlines"]:
        display_rows.append(("deadlines", "⏰ 当天截止", None))
    if row_has_content["unscheduled"]:
        display_rows.append(("unscheduled", "📝 待排时间", None))

    # 空档行（例如午休）：没校准到、但左右紧邻两节能夹出空档的节次。
    # 它不是课，所以占位字写「午休」，也不算进「空闲 N 节」。
    table_rows = rows if rows else config.PERIOD_ROWS
    break_rows = {}
    for index, period_row in enumerate(table_rows):
        label = config.break_label(period_row[0], period_times)
        if label:
            break_rows[index] = label
        display_rows.append((index, config.row_label(period_row, period_times),
                             config.row_time_range(period_row, period_times)))
    if row_has_content["other"]:
        display_rows.append(("other", "其他时段", None))

    # 每天还有几节是空的：只数真正的课（午休那种空档行不算空闲节数）
    class_row_set = {index for index in range(len(table_rows))
                     if index not in break_rows}
    free_by_day = {}
    for day in days:
        covered = set()
        for block in day_cells[day.isoformat()]["blocks"]:
            covered.update(range(block["first"], block["last"] + 1))
        occupied = len([index for index in covered if index in class_row_set])
        free_by_day[day.isoformat()] = max(len(class_row_set) - occupied, 0)

    parts = ['<div class="ss-table-wrap"><table class="ss-table"><thead><tr>',
             '<th class="ss-th-corner">节次 \\ 星期</th>']
    for day in days:
        css = "ss-th ss-th-today" if day == today else "ss-th"
        badge = '<span class="ss-today-badge">今天</span>' if day == today else ""
        parts.append(
            f'<th class="{css}">{WEEKDAY_CN[day.weekday()]}'
            f'<span class="ss-day-date"> {day.strftime("%m-%d")}</span>{badge}'
            f'<div class="ss-free">空闲 {free_by_day[day.isoformat()]} 节</div></th>'
        )
    parts.append("</tr></thead><tbody>")

    now = datetime.now()  # 判定「今天的课过点了没」
    for key, label, time_range in display_rows:
        parts.append("<tr>")
        parts.append(f'<td class="ss-td-gutter">{_gutter_html(label, time_range)}</td>')
        for day in days:
            entry = day_cells[day.isoformat()]
            is_today = day == today
            if key in ("deadlines", "unscheduled", "other"):
                extra = " ss-td-unscheduled" if key == "unscheduled" else ""
                parts.append(_td_simple(entry[key], is_today, day, now, extra_css=extra))
                continue
            block = next((b for b in entry["blocks"] if b["first"] == key), None)
            if block is not None:
                parts.append(_td_block(block, is_today, day, now))
            elif any(b["first"] < key <= b["last"] for b in entry["blocks"]):
                continue  # 这一格被上面跨行的单元格盖住了，不输出 <td>
            elif key in break_rows:
                # 午休行：有任务时上面那个分支已经画了卡片，这里只处理空着的格子
                parts.append(_td_simple([], is_today, day, now,
                                        extra_css=" ss-td-break",
                                        empty_text=break_rows[key],
                                        empty_css=" ss-empty-break"))
            else:
                parts.append(_td_simple([], is_today, day, now))
        parts.append("</tr>")

    parts.append("</tbody></table></div>")
    return "".join(parts)

def _local_ip() -> str:
    """取本机在局域网里的 IP（手机要用它访问）。

    用 UDP connect 让系统按路由挑一个出口地址，不会真的发包，离线也能用。

    Returns:
        str: 例如 "192.168.1.7"；取不到返回空字符串。
    """
    for probe in (("8.8.8.8", 80), ("114.114.114.114", 53)):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.settimeout(0.3)
                sock.connect(probe)
                ip = sock.getsockname()[0]
            if ip and not ip.startswith("127."):
                return ip
        except OSError:
            continue
    try:
        ip = socket.gethostbyname(socket.gethostname())
        return "" if ip.startswith("127.") else ip
    except OSError:
        return ""


def _server_port() -> int:
    """取当前 Streamlit 的端口（拿不到就当 8501）。"""
    try:
        return int(st.get_option("server.port") or 8501)
    except Exception:  # noqa: BLE001 - 取不到就用默认值
        return 8501


def _qr_html(url: str) -> str:
    """把网址生成二维码（装了 segno 才有；没装就返回空字符串）。

    segno 是纯 Python 库、没有额外依赖：pip install segno

    Args:
        url: 要编码的网址。

    Returns:
        str: <img> 标签；没有 segno 或生成失败时返回空字符串。
    """
    try:
        import segno
    except ImportError:
        return ""
    try:
        data_uri = segno.make(url, error="m").svg_data_uri(scale=4, border=2)
        return (
            '<img alt="扫码在手机上打开" src="' + data_uri + '" '
            'style="width:170px;height:170px;background:#fff;border:1px solid #eaecf0;'
            'border-radius:10px;padding:6px;display:block;margin:4px auto;">'
        )
    except Exception:  # noqa: BLE001 - 二维码只是锦上添花，失败不影响主流程
        return ""


def render_mobile_entry() -> None:
    """侧边栏「📱 手机上使用」：给出局域网地址，装了 segno 还会显示二维码。

    Returns:
        None
    """
    _require_streamlit()

    with st.expander("📱 手机上使用", expanded=False):
        ip = _local_ip()
        if not ip:
            st.caption("没检测到局域网地址，确认电脑已经连上 WiFi 或网线。")
            return

        url = f"http://{ip}:{_server_port()}"
        st.caption("手机连**同一个 WiFi**，用浏览器打开下面这个地址：")
        st.markdown(f'<div class="ss-mobile-url">{html.escape(url)}</div>', unsafe_allow_html=True)

        qr = _qr_html(url)
        if qr:
            st.markdown(qr, unsafe_allow_html=True)
        else:
            st.caption("装上 segno 就能直接扫码打开（纯 Python、无依赖）：`pip install segno`")

        st.caption(
            "打开后可以在浏览器菜单里选「添加到主屏幕」，用起来就跟 App 一样。"
            "打不开时检查：① 手机和电脑是不是同一个 WiFi；"
            "② Windows 防火墙允许 Python 通过「专用网络」。"
        )


def _today_item_html(task: dict, day: date, passed: bool, period_times: dict) -> str:
    """渲染「今日」列表里的一项。"""
    ttype = task.get("type", config.TYPE_EVENT)
    ttype_for_time = task.get("type", config.TYPE_EVENT)
    start = str(task.get("start_time") or "").strip()
    end = str(task.get("end_time") or "").strip()
    if ttype_for_time == config.TYPE_DDL:
        when = f"{end} 截止" if end else "当天截止"
    else:
        when = f"{start}-{end}" if start and end else (start or "全天")

    title = html.escape(str(task.get("title") or "(无标题)"))
    if task.get("done"):
        title += " ✅"
    elif passed:
        title += '<span class="ss-badge-passed">已结束</span>'

    meta_bits = []
    periods = str(task.get("periods") or "").strip()
    if periods:
        meta_bits.append(f"第{periods}节")
    location = str(task.get("location") or "").strip()
    if location:
        meta_bits.append(f"📍{location}")
    if not start:
        meta_bits.append(config.TYPE_LABELS.get(ttype, ""))

    css = "ss-tl-item ss-tl-passed" if passed else "ss-tl-item"
    return (
        f'<div class="{css}">'
        f'<div class="ss-tl-bar ss-tl-bar-{html.escape(str(ttype))}"></div>'
        f'<div class="ss-tl-time">{html.escape(when)}</div>'
        f'<div><div class="ss-tl-title">{title}</div>'
        f'<div class="ss-tl-meta">{" · ".join(meta_bits)}</div></div>'
        f"</div>"
    )


def render_today_list(tasks: list = None) -> None:
    """渲染「今天」的日程列表——手机上比 13×8 的课表好用得多。

    已经过点的课会淡显并标「已结束」。

    Args:
        tasks: 任务列表；传 None 时自动通过 task_manager.load_tasks() 读取。

    Returns:
        None
    """
    _require_streamlit()
    _inject_css()

    if tasks is None:
        tasks = load_tasks()

    today = _today()
    semester_start = _semester_start()
    now = datetime.now()

    entries = [
        task for task in (tasks or [])
        if isinstance(task, dict) and task_occurs_on(task, today, semester_start)
    ]
    entries.sort(key=lambda item: (str(item.get("start_time") or "99:99"),))

    weekday = WEEKDAY_CN[today.weekday()]
    st.markdown(
        f'<div class="ss-section-title">📱 今天 · {today.strftime("%m-%d")} {weekday}'
        f'（共 {len(entries)} 项）</div>',
        unsafe_allow_html=True,
    )

    if not entries:
        st.markdown('<div class="ss-tl-empty">今天没有安排 🎉</div>', unsafe_allow_html=True)
        return

    blocks = [
        _today_item_html(task, today, occurrence_passed(task, today, now), _period_times())
        for task in entries
    ]
    st.markdown("".join(blocks), unsafe_allow_html=True)


def render_workload_panel(tasks: list = None) -> None:
    """渲染「本周时间缺口」：课表空档 vs 这周要做的事。

    做法与周视图共用同一套规则（复用 _build_week_cells），所以「课表上看起来有空」
    和「这里算出来有空」永远是同一个口径；午休那种空档行不算课，也不计入空档。
    真正的判断逻辑在 planner.py（纯函数，可单测），这里只负责取数与展示。

    Args:
        tasks: 任务列表；不传则自己读一次。
    """
    if tasks is None:
        tasks = load_tasks()

    today = _today()
    semester_start = _semester_start()
    period_times = _period_times()
    this_monday = today - timedelta(days=today.weekday())
    days = [this_monday + timedelta(days=i) for i in range(7)]

    period_rows = _period_rows(period_times, tasks)
    if not period_rows:
        return
    # 每节「课」有多少分钟：午休那种空档行不算课，也就不提供空闲时间
    class_row_minutes = {
        index: planner.row_minutes(row, period_times)
        for index, row in enumerate(period_rows)
        if not config.break_label(row[0], period_times)
    }
    week_cells, _row_has_content = _build_week_cells(tasks, days, semester_start,
                                                     period_times, period_rows)

    occupied_by_day = {}
    for day in days:
        entry = week_cells.get(day.isoformat()) or {}
        taken = set()
        for block in entry.get("blocks") or []:
            taken.update(range(block["first"], block["last"] + 1))
        occupied_by_day[day.isoformat()] = taken

    # 需求侧：这周会发生、还没做完、也不是「已结课」的课
    pending = []
    for task in tasks or []:
        if not isinstance(task, dict) or task.get("done"):
            continue
        if is_task_finished(task, semester_start=semester_start):
            continue
        if any(task_occurs_on(task, day, semester_start) for day in days):
            pending.append(task)

    plan = planner.plan_week(days, pending, class_row_minutes, occupied_by_day)

    st.markdown('<div class="ss-section-title">⏳ 本周时间缺口</div>', unsafe_allow_html=True)
    gap = plan["gap_minutes"]
    col_free, col_need, col_gap = st.columns(3)
    with col_free:
        st.metric("🕳️ 本周空档", planner.format_minutes(plan["free_total"]))
    with col_need:
        st.metric("🧾 本周要做", planner.format_minutes(plan["demand_minutes"]))
    with col_gap:
        st.metric(
            "📉 缺口",
            planner.format_minutes(gap) if gap > 0 else "0 分钟",
            delta="排不下" if gap > 0 else "排得下",
            delta_color="inverse" if gap > 0 else "normal",
        )

    for index, line in enumerate(plan["advice"]):
        if index == 0:
            if gap > 0:
                st.warning(line)
            else:
                st.success(line)
        else:
            st.caption(line)

    with st.expander("按天看：空档 / 当天要做", expanded=False):
        lines = ["| 日期 | 空档 | 当天要做 |", "|---|---|---|"]
        for day in days:
            iso = day.isoformat()
            need_today = sum(
                planner.task_estimate(task) for task in pending
                if task_occurs_on(task, day, semester_start)
            )
            lines.append(
                f"| {WEEKDAY_CN[day.weekday()]} {day.strftime('%m-%d')} "
                f"| {planner.format_minutes(plan['free_minutes_by_day'].get(iso, 0))} "
                f"| {planner.format_minutes(need_today)} |"
            )
        st.markdown("\n".join(lines))
        st.caption("「预计耗时」在侧边栏「手动添加」或「日程管理 → 编辑」里填；"
                   "没填的任务不计入「当天要做」，但会出现在下面的提示里。")


def render_week_view(tasks: list = None) -> None:
    """渲染「课表」：行 = 节次（大节），列 = 周一到周日，可前后翻周。

    时间刻度用的是 config.CLASS_PERIODS 里定义的**一节课一节课**，
    而不是笼统的「上午/下午/晚上」——这才对得上大学生的日常课表。
    每周重复的课程（repeat="weekly"）会按周次范围与单双周在对应周自动出现。

    归位规则：
        * 开始时间落在第 N 节内 → 显示在对应的大节行（如 08:00 和 08:55 都进「第1-2节」）
        * 完全没有时间的任务（通常是 DDL）→ 顶部「全天/待办」行
        * 有开始时间但不在任何节次内（如 12:30、22:00）→ 底部「其他时段」行

    Args:
        tasks: 任务列表；传 None 时自动通过 task_manager.load_tasks() 读取。

    Returns:
        None
    """
    _require_streamlit()
    _inject_css()  # 自定义 CSS 放在函数顶部

    if tasks is None:
        tasks = load_tasks()  # 只读，仍然走 task_manager，不直接碰 JSON

    if SS_WEEK_OFFSET not in st.session_state:
        st.session_state[SS_WEEK_OFFSET] = 0
    offset = int(st.session_state.get(SS_WEEK_OFFSET) or 0)

    today = _today()
    semester_start = _semester_start()
    period_times = _period_times()
    this_monday = today - timedelta(days=today.weekday())
    days = [this_monday + timedelta(weeks=offset, days=i) for i in range(7)]
    monday = days[0]

    week_no = config.week_number_of(monday, semester_start)
    if week_no is None:
        week_text = "学期外"
    else:
        parity_label = config.PARITY_LABELS.get(config.week_parity(week_no), "")
        week_text = f"第 {week_no} 周 · {parity_label}"
    title_suffix = "（本周）" if offset == 0 else ""

    # 0) 这次要画哪几行：节次数不写死（别人课表里有第 14 节，就该多一行）
    table_rows = _period_rows(period_times, tasks)

    # 1) 把任务分配到「星期 × 节次」的格子里（逻辑抽在 _build_week_cells 里，便于单测）
    week_cells, row_has_content = _build_week_cells(tasks, days, semester_start,
                                                    period_times, table_rows)
    item_count = (
        sum(len(block["tasks"]) for entry in week_cells.values() for block in entry["blocks"])
        + sum(len(entry["deadlines"]) + len(entry["unscheduled"]) + len(entry["other"])
              for entry in week_cells.values())
    )

    st.markdown(
        f'<div class="ss-section-title">🗓️ 课表 · {week_text}{title_suffix}'
        f'（{days[0].strftime("%m-%d")} ~ {days[6].strftime("%m-%d")}）</div>',
        unsafe_allow_html=True,
    )

    # 2) 视图切换：手机上用「今日」列表最舒服
    view = st.radio(
        "视图", ["📅 周课表", "📱 今日"],
        horizontal=True, key="ss_view_mode", label_visibility="collapsed",
    )
    if view == "📱 今日":
        render_today_list(tasks)
        return

    # 3) 翻周导航
    col_prev, col_this, col_next, col_info = st.columns([1, 1, 1, 4])
    with col_prev:
        if st.button("◀ 上一周", key="ss_week_prev", use_container_width=True):
            st.session_state[SS_WEEK_OFFSET] = offset - 1
            _safe_rerun()
    with col_this:
        if st.button("回到本周", key="ss_week_this", use_container_width=True):
            st.session_state[SS_WEEK_OFFSET] = 0
            _safe_rerun()
    with col_next:
        if st.button("下一周 ▶", key="ss_week_next", use_container_width=True):
            st.session_state[SS_WEEK_OFFSET] = offset + 1
            _safe_rerun()
    with col_info:
        calibrated = "· 作息已按导入的课表校准 " if period_times else ""
        st.caption(
            f"这一周共 {item_count} 条 {calibrated}· "
            "蓝色 = 日程 · 红色 = 截止(DDL) · 绿色 = 子任务 · 灰色删除线 = 已完成"
        )

    if not item_count:
        st.info("这一周没有任何安排。")

    # 3) 整周一次渲染成一张表格（连堂课用 rowspan 真正合并单元格）
    st.markdown(
        _week_table_html(days, week_cells, row_has_content, today, period_times,
                         table_rows),
        unsafe_allow_html=True,
    )


# ---------------------------------------------------------------------------
# 组件 2：未来 7 天 DDL 提醒
# ---------------------------------------------------------------------------
def _public_base_url() -> str:
    """尽力拼出「当前访问地址」，用来生成带空间码的链接和二维码。

    反向代理（Caddy/nginx）会把原始协议与域名放在 X-Forwarded-* 里；
    本地直连时退回到「本机局域网 IP + 端口」，这样手机扫码也能用。

    Returns:
        str: 形如 https://example.com 或 http://192.168.1.7:8501
    """
    scheme, host = "", ""
    try:
        headers = {str(k).lower(): str(v) for k, v in dict(st.context.headers or {}).items()}
        host = headers.get("host", "")
        scheme = headers.get("x-forwarded-proto", "")
    except Exception:  # noqa: BLE001 - 取不到就退回本地地址
        pass
    if not host:
        return ""
    return f"{scheme or 'http'}://{host}"


def render_space_panel() -> None:
    """渲染「我的空间」：显示空间码、换设备进入、二维码、改名、删除。

    多用户版的"账号"就是一个**空间码**：知道它的人 = 拥有那份日程，没有密码。
    所以这里同时给出两条出口：导出自己的数据、删除自己的空间，
    并在界面上直说「别放敏感信息」。
    """
    _require_streamlit()
    _inject_css()

    info = storage.space_info()
    code = info["code"]
    label = f"（{info['name']}）" if info.get("name") else ""

    with st.expander(f"🔑 我的空间{label} · {info['task_count']} 条日程", expanded=False):
        col_left, col_right = st.columns([3, 2])
        with col_left:
            st.markdown(f"**你的空间码**：`{code}`")
            st.caption(
                "换手机、换浏览器时，用同一台设备打开**带这个码的链接**，就能接着用同一份日程。"
                "同学各自有自己的码，互相看不到对方的日程。"
            )
            base = _public_base_url()
            if base:
                link = f"{base}?{storage.SPACE_PARAM}={code}"
                st.code(link, language=None)
                st.caption("📱 手机：先用手机打开上面的链接，再点浏览器菜单 →「添加到主屏幕」，"
                           "以后点图标直接进，不用再输码。")
            else:
                st.caption("（拿不到访问地址，先在浏览器地址栏里确认当前 URL）")
        with col_right:
            base = _public_base_url()
            qr = _qr_html(f"{base}?{storage.SPACE_PARAM}={code}") if base else ""
            if qr:
                st.markdown(qr, unsafe_allow_html=True)
                st.caption("手机扫码就能带着这个码打开")
            else:
                st.caption("装了 `segno` 才会显示二维码（可选依赖）")

        st.divider()

        tasks = load_tasks()
        st.download_button(
            "⬇️ 导出我的数据（JSON）",
            data=json.dumps(tasks, ensure_ascii=False, indent=2).encode("utf-8"),
            file_name=f"my-schedule-{date.today().isoformat()}.json",
            mime="application/json",
            key="ss_space_export",
            help="把自己这个空间的日程存成一个文件；换设备时可以再导入回来",
        )

        with st.form(key="ss_space_switch", clear_on_submit=True):
            entered = st.text_input(
                "已有空间码？粘贴进来即可进入那个空间",
                placeholder="例如 kQ3fZ_a91Bx", key="ss_space_input",
            )
            switched = st.form_submit_button("进入这个空间", use_container_width=True,
                                             key="ss_space_switch_btn")

        col_name, col_rename = st.columns([3, 1])
        with col_name:
            new_name = st.text_input("给这个空间起个名字（可选，只是方便你自己认）",
                                     value=info.get("name", ""), key="ss_space_name")
        with col_rename:
            st.write("")
            if st.button("保存昵称", key="ss_space_rename", use_container_width=True):
                if storage.rename_space(code, new_name):
                    set_flash("success", "昵称已保存")
                    _safe_rerun()
                st.error("保存失败，请重试")

        st.divider()
        st.caption("⚠️ 空间码就是唯一的凭证，**没有密码**：谁拿到链接谁就能看到这份日程。"
                   "别把身份证号、住址之类敏感信息写进日程。")

        if not st.session_state.get("ss_space_delete_confirm"):
            if st.button("🗑️ 删除我的空间（连同里面的日程）", key="ss_space_delete_ask"):
                st.session_state["ss_space_delete_confirm"] = True
                _safe_rerun()
        else:
            st.warning(f"确定要删除空间 `{code}` 及其 {info['task_count']} 条日程吗？此操作不可恢复。")
            col_yes, col_no = st.columns(2)
            with col_yes:
                if st.button("确认删除", key="ss_space_delete_yes", type="primary",
                             use_container_width=True):
                    if storage.delete_space(code):
                        fresh = storage.new_space_code()
                        storage.set_current_space(fresh)
                        try:
                            st.query_params[storage.SPACE_PARAM] = fresh
                        except Exception:  # noqa: BLE001
                            pass
                        st.session_state["ss_space_delete_confirm"] = False
                        set_flash("success", "空间已删除，已为你开了一个新的空空间")
                        _safe_rerun()
                    st.error("删除失败，请重试")
            with col_no:
                if st.button("取消", key="ss_space_delete_no", use_container_width=True):
                    st.session_state["ss_space_delete_confirm"] = False
                    _safe_rerun()

        if switched:
            target = storage.normalize_space(entered)
            if not target:
                st.error("空间码只能包含字母、数字、下划线和连字符")
            else:
                storage.ensure_space(target)
                storage.set_current_space(target)
                try:
                    st.query_params[storage.SPACE_PARAM] = target
                except Exception:  # noqa: BLE001
                    pass
                set_flash("success", f"已进入空间 {target}")
                _safe_rerun()


def render_ddl_list() -> None:
    """渲染「未来 7 天截止提醒」列表。

    数据来自 task_manager.get_upcoming_ddls(7)，按距离截止日的远近排序；
    距离 ≤2 天的用红色告警样式，其余用蓝色常规样式。
    每条显示：任务名 / 截止日期 / 剩余天数，并提供「标记完成」按钮。

    Returns:
        None
    """
    _require_streamlit()
    _inject_css()  # 自定义 CSS 放在函数顶部

    st.markdown('<div class="ss-section-title">⏰ 未来 7 天截止提醒</div>', unsafe_allow_html=True)
    render_flash()

    ddls = get_upcoming_ddls(7)
    if not ddls:
        st.info("未来 7 天没有截止任务，轻松一下 ☕")
        return

    # 按截止时刻排序（越近越靠前）
    ddls = sorted(ddls, key=lambda t: (str(t.get("date", "")), str(t.get("end_time") or "")))
    now = datetime.now()

    for task in ddls:
        task_date = str(task.get("date", ""))
        moment = str(task.get("end_time") or "").strip()
        deadline_dt = None
        try:
            day = date.fromisoformat(task_date)
            if moment:  # 有截止时刻就精确到分钟
                hour, minute = (int(part) for part in moment.split(":")[:2])
                deadline_dt = datetime(day.year, day.month, day.day, hour, minute)
            else:       # 没写时刻 = 当天结束前截止
                deadline_dt = datetime(day.year, day.month, day.day, 23, 59)
        except (ValueError, TypeError):
            deadline_dt = None

        if deadline_dt is None:
            days_text, urgent = "日期未知", False
        else:
            seconds_left = (deadline_dt - now).total_seconds()
            urgent = seconds_left <= 48 * 3600      # 48 小时内算紧急
            if seconds_left < 0:
                days_text = "已逾期"
            elif seconds_left < 3600:
                days_text = f"还剩 {int(seconds_left // 60)} 分钟"
            elif seconds_left < 24 * 3600:
                days_text = f"还剩 {int(seconds_left // 3600)} 小时"
            else:
                hours = int(seconds_left // 3600)
                days_text = f"还剩 {hours // 24} 天 {hours % 24} 小时"

        deadline_text = f"{task_date} {moment}".strip() + (" 截止" if moment else " 当天截止")

        card_css = "ss-ddl ss-ddl-urgent" if urgent else "ss-ddl"
        days_css = "ss-ddl-days-urgent" if urgent else "ss-ddl-days"
        badge = '<span class="ss-badge-urgent">紧急</span>' if urgent else ""

        left, right = st.columns([5, 1])
        with left:
            st.markdown(
                f'<div class="{card_css}">'
                f'<div class="ss-ddl-title">{html.escape(str(task.get("title") or "(无标题)"))}{badge}</div>'
                f'<div class="ss-ddl-meta">截止：{html.escape(deadline_text)}'
                f' &nbsp;|&nbsp; <span class="{days_css}">{days_text}</span></div>'
                f"</div>",
                unsafe_allow_html=True,
            )
        with right:
            # 只调用 task_manager，不直接改数据文件
            if st.button("✔ 完成", key=f"ss_ddl_done_{task.get('id')}", use_container_width=True):
                if mark_done(task.get("id")):
                    _set_flash("success", f"已完成：{task.get('title', '')}")
                else:
                    _set_flash("error", "标记失败，请重试")
                _safe_rerun()


# ---------------------------------------------------------------------------
# 组件 3：手动添加表单
# ---------------------------------------------------------------------------
def render_add_form() -> None:
    """渲染「手动添加日程 / 课程」表单。

    字段：标题、类型、日期、开始时间、结束时间、优先级、重复方式（每周重复 + 周次范围 + 单双周）。
    字段控件与编辑表单共用 `_render_task_fields`，行为完全一致。
    提交后校验标题，再通过 task_manager.add_task() 写入数据。

    Returns:
        None
    """
    _require_streamlit()
    _inject_css()  # 自定义 CSS 放在函数顶部

    st.markdown('<div class="ss-section-title">✍️ 手动添加</div>', unsafe_allow_html=True)

    # 用表单包起来：里面的控件不会各自触发重跑，只在点提交时统一提交
    # 类型放在表单外：切成「截止」后，下面会变成单个「截止时刻」输入
    add_type = _render_type_selector("ss_add", {})
    with st.form(key="ss_add_form", clear_on_submit=True):
        # 新建任务：默认「不指定具体时间 / 当天截止」不勾选，用户填的时间才会生效
        values = _render_task_fields("ss_add", {}, task_type=add_type,
                                     with_done=False, no_time_default=False,
                                     trust_widget_times=True)
        submitted = st.form_submit_button("添加任务", use_container_width=True, type="primary")

    if not submitted:
        return

    # ---- 提交后的处理：校验 → 组装 dict → 交给 task_manager ----
    if not values.get("title"):
        st.error("请填写标题")
        return

    task = {
        "title": values["title"],
        "type": values["type"],
        "date": values["date"],
        "start_time": values["start_time"],
        "end_time": values["end_time"],
        "priority": values["priority"],
        "repeat": values["repeat"],
        "week_start": values["week_start"],
        "week_end": values["week_end"],
        "week_parity": values["week_parity"],
        "periods": values.get("periods", ""),
        "location": values.get("location", ""),
        "estimate_min": values.get("estimate_min", 0),
        "done": False,
        "parent_id": None,
    }

    if add_task(task):  # 通过 task_manager 写入，不直接操作 JSON
        _set_flash("success", f"已添加：{task['title']}")
        _safe_rerun()
    else:
        st.error("添加失败，请重试（可查看终端日志）")


# ---------------------------------------------------------------------------
# 组件 4：自然语言输入
# ---------------------------------------------------------------------------
def _parse_date_value(text: str, default: date = None) -> date:
    """把 "YYYY-MM-DD" 解析成 date；非法或为空时返回默认值（今天）。"""
    try:
        return date.fromisoformat(str(text).strip())
    except (ValueError, TypeError):
        return default or _today()


def _parse_time_value(text: str, default: time) -> time:
    """把 "HH:MM" 解析成 time；非法或为空时返回默认值。"""
    raw = str(text or "").strip()
    for fmt in ("%H:%M", "%H:%M:%S"):
        try:
            return datetime.strptime(raw, fmt).time()
        except ValueError:
            continue
    return default


def _result_to_items(result: dict) -> list:
    """把 AI 解析结果拍平成「一行一条」的待确认条目。

    Args:
        result: ai_parser.parse_natural_input() 的返回值。

    Returns:
        list: 条目 dict 列表，每条包含
              title / type / date / start_time / end_time / priority。
    """
    items = []
    for kind in ("events", "deadlines"):
        for raw in result.get(kind) or []:
            if not isinstance(raw, dict):
                continue
            items.append({
                "title": str(raw.get("title", "")).strip(),
                "type": str(raw.get("type") or ("日程" if kind == "events" else "DDL")).strip(),
                "date": str(raw.get("date", "")).strip(),
                "start_time": str(raw.get("start_time") or "").strip(),
                "end_time": str(raw.get("end_time") or "").strip(),
                "priority": str(raw.get("priority") or ("中" if kind == "events" else "高")).strip(),
                # 默认不重复；用户可以在确认卡片里改成「每周重复」
                "repeat": str(raw.get("repeat") or config.REPEAT_NONE),
                "week_start": raw.get("week_start") or 1,
                "week_end": raw.get("week_end") or config.WEEKS_PER_TERM,
                "week_parity": str(raw.get("week_parity") or config.PARITY_ALL),
            })
    # 丢掉没有标题的空条目
    return [item for item in items if item["title"]]


def _items_to_result(items: list) -> dict:
    """把（可能被用户编辑过的）条目列表还原成 ai_parser 认识的结果结构。

    Args:
        items: _result_to_items() 结构、但字段值已被用户改过的列表。

    Returns:
        dict: 与 parse_natural_input() 返回结构一致、可直接喂给 to_local_tasks() 的 dict。
    """
    result = {
        "events": [],
        "deadlines": [],
        "needs_clarification": False,
        "clarification_question": "",
    }
    for item in items:
        ttype = ai_parser.type_to_const(item.get("type"), config.TYPE_EVENT)
        # 重复设置原样带上（可能被用户在确认卡片里改过）
        repeat_fields = {
            "repeat": item.get("repeat") or config.REPEAT_NONE,
            "week_start": item.get("week_start"),
            "week_end": item.get("week_end"),
            "week_parity": item.get("week_parity") or config.PARITY_ALL,
        }
        if ttype == config.TYPE_DDL:
            result["deadlines"].append({
                "title": item.get("title", ""),
                "date": item.get("date", ""),
                "type": "DDL",
                "priority": item.get("priority", ""),
                "periods": item.get("periods", ""),
                "location": item.get("location", ""),
                **repeat_fields,
            })
        else:
            result["events"].append({
                "title": item.get("title", ""),
                "date": item.get("date", ""),
                "start_time": item.get("start_time", ""),
                "end_time": item.get("end_time", ""),
                "type": "日程",
                "priority": item.get("priority", ""),
                "periods": item.get("periods", ""),
                "location": item.get("location", ""),
                **repeat_fields,
            })
    return result


def _item_card_html(item: dict) -> str:
    """把一条待确认条目渲染成彩色卡片（复用周视图的卡片样式）。"""
    return _task_card_html({
        "title": item.get("title", ""),
        "type": ai_parser.type_to_const(item.get("type"), config.TYPE_EVENT),
        "start_time": item.get("start_time", ""),
        "end_time": item.get("end_time", ""),
        "priority": ai_parser.priority_to_const(item.get("priority"), config.PRIORITY_MID),
        "done": False,
    })


def _render_type_selector(prefix: str, task: dict) -> str:
    """渲染「类型」下拉框。

    **故意放在表单外面**：切到「截止」后，下面的时间输入要立刻变成「截止时刻」——
    表单里的控件要提交后才生效，做不到这种联动。

    Args:
        prefix: 控件 key 前缀。
        task: 任务/条目当前内容（用于定位当前类型）。

    Returns:
        str: 内部类型常量（config.TYPE_EVENT / TYPE_DDL / TYPE_SUBTASK）。
    """
    options = list(config.ALL_TYPES)
    labels = [config.TYPE_LABELS.get(t, t) for t in options]
    current = ai_parser.type_to_const(task.get("type"), config.TYPE_EVENT)
    chosen = st.selectbox("类型", labels, index=options.index(current), key=f"{prefix}_type")
    return options[labels.index(chosen)]


def _render_task_fields(prefix: str, task: dict, task_type: str = None,
                        with_done: bool = False, no_time_default: bool = None,
                        trust_widget_times: bool = False) -> dict:
    """渲染一组任务字段控件（标题/类型/日期/起止时间/优先级/重复/可选已完成）。

    **必须在 `with st.form(...)` 上下文里调用**；提交按钮由调用方渲染。
    自然语言确认卡片的编辑表单、「日程管理」的编辑表单、手动添加表单
    共用这一份实现，保证三处的空时间处理、标签映射行为完全一致。

    Args:
        prefix: 控件 key 前缀（不同任务要用不同前缀，避免 key 冲突）。
        task: 任务/条目的当前内容。
        task_type: 类型（由 _render_type_selector 在表单外选好传进来）。
        with_done: 是否额外渲染「已完成」勾选框。
        no_time_default: 「不指定具体时间」勾选框的默认值。
                         None 表示根据 task 是否有时间来推断（编辑已有任务用）；
                         新建任务时应显式传 False，否则空任务会被默认勾上、
                         导致用户选好的时间被丢掉。

    Returns:
        dict: 归一化后的字段值，键为 title / type / date / start_time / end_time /
              priority / repeat / week_start / week_end / week_parity (/ done)。
              type 与 priority 已转成 config 里的内部常量。
    """
    task_type = task_type or ai_parser.type_to_const(task.get("type"), config.TYPE_EVENT)
    priority_options = [config.PRIORITY_HIGH, config.PRIORITY_MID, config.PRIORITY_LOW]
    priority_labels = [config.PRIORITY_LABELS.get(p, p) for p in priority_options]
    current_priority = ai_parser.priority_to_const(task.get("priority"), config.PRIORITY_MID)

    title = st.text_input("标题", value=str(task.get("title") or ""), key=f"{prefix}_title")
    edit_date = st.date_input(
        "日期", value=_parse_date_value(task.get("date")), key=f"{prefix}_date"
    )

    start_value = ""
    end_value = ""
    if task_type == config.TYPE_DDL:
        # ---- 截止类：只有一个「截止时刻」，没有起始时间 ----
        if no_time_default is None:
            no_time_default = not str(task.get("end_time") or "").strip()
        only_today = st.checkbox(
            "当天截止（不设具体时刻）", value=no_time_default, key=f"{prefix}_notime"
        )
        moment_default = _parse_time_value(task.get("end_time"), time(12, 0))
        moment = st.time_input(
            "截止时刻", value=moment_default,
            step=timedelta(minutes=5), key=f"{prefix}_moment",
            help="例如中午 12:00 截止；勾上上面那个框就表示「当天结束前」",
        )
        end_value = "" if only_today else moment.strftime("%H:%M")
    else:
        # ---- 日程 / 子任务：有起止时间 ----
        # 时间控件的兜底默认值：保存时若「原本为空 + 控件仍等于这个默认值」，
        # 就继续保持为空——绝不凭空捏造时间（例如给没有结束时间的日程硬塞 10:00）。
        start_default = _parse_time_value(task.get("start_time"), time(9, 0))
        end_default = _parse_time_value(task.get("end_time"), time(10, 0))
        col_start, col_end = st.columns(2)
        with col_start:
            start_t = st.time_input(
                "开始时间", value=start_default,
                step=timedelta(minutes=5), key=f"{prefix}_start",
            )
        with col_end:
            end_t = st.time_input(
                "结束时间", value=end_default,
                step=timedelta(minutes=5), key=f"{prefix}_end",
            )
        if no_time_default is None:
            no_time_default = not task.get("start_time") and not task.get("end_time")
        no_time = st.checkbox(
            "不指定具体时间", value=no_time_default, key=f"{prefix}_notime",
        )
        start_value = start_t.strftime("%H:%M")
        end_value = end_t.strftime("%H:%M")
        if not trust_widget_times:
            # 编辑已有任务时，原本为空、用户又没动过的字段保持为空（不凭空造时间）
            if not str(task.get("start_time") or "").strip() and start_t == start_default:
                start_value = ""
            if not str(task.get("end_time") or "").strip() and end_t == end_default:
                end_value = ""
        if no_time:  # 勾了「不指定具体时间」→ 两个都清空
            start_value = end_value = ""
    priority_label = st.selectbox(
        "优先级", priority_labels,
        index=priority_options.index(current_priority), key=f"{prefix}_priority",
    )

    # ---- 重复设置（课程用） ----
    repeat_options = list(config.ALL_REPEATS)
    repeat_labels = [config.REPEAT_LABELS.get(r, r) for r in repeat_options]
    current_repeat = str(task.get("repeat") or config.REPEAT_NONE)
    if current_repeat not in config.ALL_REPEATS:
        current_repeat = config.REPEAT_NONE
    repeat_label = st.selectbox(
        "重复方式", repeat_labels,
        index=repeat_options.index(current_repeat), key=f"{prefix}_repeat",
    )
    parity_options = list(config.ALL_PARITIES)
    parity_labels = [config.PARITY_LABELS.get(p, p) for p in parity_options]
    current_parity = str(task.get("week_parity") or config.PARITY_ALL)
    if current_parity not in config.ALL_PARITIES:
        current_parity = config.PARITY_ALL

    col_ws, col_we, col_parity = st.columns(3)
    with col_ws:
        week_start = st.number_input(
            "从第几周", min_value=1, max_value=60, step=1,
            value=int(task.get("week_start") or 1), key=f"{prefix}_week_start",
        )
    with col_we:
        week_end = st.number_input(
            "到第几周", min_value=1, max_value=60, step=1,
            value=int(task.get("week_end") or config.WEEKS_PER_TERM), key=f"{prefix}_week_end",
        )
    with col_parity:
        parity_label = st.selectbox(
            "单双周", parity_labels,
            index=parity_options.index(current_parity), key=f"{prefix}_parity",
        )
    st.caption("「每周重复」时，按上面的周次范围与单双周出现在课表里；「不重复」只用日期那一天。")

    # 预计耗时：缺口分析要用它；0 表示没写（不填也不影响别的功能）
    estimate_min = st.number_input(
        "预计耗时（分钟，0 = 还没估）", min_value=0, max_value=24 * 60, step=15,
        value=int(task.get("estimate_min") or 0), key=f"{prefix}_estimate",
        help="写「本周还排得下吗」要用它：预计耗时 vs 课表空档。没写的任务不计入需求。",
    )

    done = bool(task.get("done"))
    if with_done:
        done = st.checkbox("已完成", value=done, key=f"{prefix}_done")

    # 节次与地点：课表导入会带上，手动填也可以（节次用来把课放到正确的行）
    col_period, col_loc = st.columns(2)
    with col_period:
        periods = st.text_input(
            "节次（如 7-9，可空）", value=str(task.get("periods") or ""),
            key=f"{prefix}_periods", placeholder="7-9",
            help="填了节次（或起止时间）就会排进课表对应位置；"
                 "两者都不填会出现在课表上方的「待排时间」行",
        )
    with col_loc:
        location = st.text_input(
            "地点（可空）", value=str(task.get("location") or ""),
            key=f"{prefix}_location", placeholder="致理楼L3-515",
        )

    return {
        "title": str(title).strip(),
        "type": task_type,
        "date": edit_date.isoformat() if hasattr(edit_date, "isoformat") else str(edit_date),
        "start_time": start_value,
        "end_time": end_value,
        "priority": priority_options[priority_labels.index(priority_label)],
        "repeat": repeat_options[repeat_labels.index(repeat_label)],
        "week_start": int(week_start),
        "week_end": int(week_end),
        "week_parity": parity_options[parity_labels.index(parity_label)],
        "periods": str(periods).strip(),
        "location": str(location).strip(),
        "done": done,
        "estimate_min": int(estimate_min),
    }


def _render_item_editor(index: int, item: dict) -> None:
    """渲染第 index 条待确认条目的编辑表单。

    保存只改 session_state 里的待确认条目，不落盘——落盘统一在「确认添加」时进行。

    Args:
        index: 条目下标。
        item: 该条目的当前内容。
    """
    prefix = f"ss_nl_edit_{index}"
    task_type = _render_type_selector(prefix, item)   # 表单外，切换类型立刻生效
    with st.form(key=f"ss_nl_edit_form_{index}"):
        values = _render_task_fields(prefix, item, task_type=task_type)
        saved = st.form_submit_button("💾 保存", use_container_width=True, type="primary")
        canceled = st.form_submit_button("取消", use_container_width=True)

    if saved:
        items = list(st.session_state.get(SS_NL_ITEMS) or [])
        if 0 <= index < len(items):
            values["title"] = values["title"] or items[index].get("title", "")
            values.pop("done", None)  # 待确认条目还没有「已完成」的概念
            items[index] = values
            st.session_state[SS_NL_ITEMS] = items
        st.session_state[SS_NL_EDIT] = None
        _safe_rerun()
    elif canceled:
        st.session_state[SS_NL_EDIT] = None
        _safe_rerun()


def _render_nl_items(items: list) -> None:
    """逐条渲染确认卡片：每条一行，带「编辑」和「移除」按钮。

    Args:
        items: 待确认条目列表。
    """
    for index, item in enumerate(items):
        # 正在编辑这一条 → 显示编辑表单
        if st.session_state.get(SS_NL_EDIT) == index:
            st.markdown(
                f'<div class="ss-hint">正在编辑第 {index + 1} 条</div>', unsafe_allow_html=True
            )
            _render_item_editor(index, item)
            continue

        col_card, col_edit, col_remove = st.columns([6, 1, 1])
        with col_card:
            st.markdown(_item_card_html(item), unsafe_allow_html=True)
            when = html.escape(str(item.get("date", "")))
            if item.get("start_time"):
                when += f' {html.escape(str(item["start_time"]))}'
                if item.get("end_time"):
                    when += f'-{html.escape(str(item["end_time"]))}'
            st.markdown(f'<div class="ss-hint">📅 {when}</div>', unsafe_allow_html=True)
        with col_edit:
            if st.button("✏️", key=f"ss_nl_edit_btn_{index}", help="编辑这一条"):
                st.session_state[SS_NL_EDIT] = index
                _safe_rerun()
        with col_remove:
            if st.button("🗑️", key=f"ss_nl_remove_btn_{index}", help="移除这一条"):
                st.session_state[SS_NL_ITEMS] = [
                    x for i, x in enumerate(items) if i != index
                ]
                st.session_state[SS_NL_EDIT] = None
                _safe_rerun()


def _nl_clear() -> None:
    """清空自然语言解析相关的 session_state。"""
    st.session_state[SS_NL_RESULT] = None
    st.session_state[SS_NL_ITEMS] = []
    st.session_state[SS_NL_EDIT] = None
    st.session_state[SS_NL_SOURCE] = ""


def _nl_parse(text: str) -> None:
    """调用 AI 解析文本，并把结果写进 session_state。

    Args:
        text: 用户输入（追问场景下是「原始输入 + 补充说明」）。
    """
    if not text or not text.strip():
        st.warning("请先输入内容")
        return
    with st.spinner("AI 正在解析…"):
        result = ai_parser.parse_natural_input(text)
    st.session_state[SS_NL_SOURCE] = text.strip()
    st.session_state[SS_NL_RESULT] = result

    # 解析成功 → 拍平成可编辑的待确认条目；失败或需要追问 → 清空
    if isinstance(result, dict) and not result.get("error") and not result.get("needs_clarification"):
        st.session_state[SS_NL_ITEMS] = _result_to_items(result)
    else:
        st.session_state[SS_NL_ITEMS] = []
    st.session_state[SS_NL_EDIT] = None


def _nl_confirm(items: list) -> None:
    """用户点「确认添加」后，把（可能编辑过的）条目逐条写入数据。

    Args:
        items: 待确认条目列表（用户可能已经编辑或删除过其中几条）。
    """
    # 中文标签（"日程"/"DDL"）→ 内部常量（event/ddl），再交给 task_manager
    local_tasks = ai_parser.to_local_tasks(_items_to_result(items))
    if not local_tasks:
        st.warning("没有可添加的内容，请补充更完整的信息")
        return

    added = 0
    for task in local_tasks:
        if add_task(task):
            added += 1

    if added:
        _nl_clear()
        _set_flash("success", f"已添加 {added} 条任务")
        _safe_rerun()
    else:
        st.error("添加失败，请重试或使用手动输入")


def render_natural_input() -> None:
    """渲染「自然语言输入」组件，支持追问与结果确认。

    流程：
        输入 → ai_parser.parse_natural_input()
          ├─ 返回 error            → 提示「AI服务不可用，请使用手动输入」
          ├─ needs_clarification   → 显示追问，等待用户补充后再次解析
          └─ 解析成功              → 逐条显示确认卡片（可编辑/移除），
                                     用户点「确认添加」后才写入数据

    Returns:
        None
    """
    _require_streamlit()
    _inject_css()  # 自定义 CSS 放在函数顶部

    st.markdown('<div class="ss-section-title">💬 一句话添加日程</div>', unsafe_allow_html=True)

    # 初始化状态
    if SS_NL_RESULT not in st.session_state:
        st.session_state[SS_NL_RESULT] = None
    if SS_NL_ITEMS not in st.session_state:
        st.session_state[SS_NL_ITEMS] = []
    if SS_NL_EDIT not in st.session_state:
        st.session_state[SS_NL_EDIT] = None
    if SS_NL_SOURCE not in st.session_state:
        st.session_state[SS_NL_SOURCE] = ""

    # ---- 输入区 ----
    with st.form(key="ss_nl_form"):
        text = st.text_area(
            "用自然语言描述（支持「明天」「下周三」这类说法）",
            value="",
            height=90,
            key="ss_nl_text",
            placeholder="例如：明天下午三点开组会，下周三前交课程报告",
        )
        parse_clicked = st.form_submit_button("🪄 智能解析", use_container_width=True, type="primary")

    if parse_clicked:
        _nl_parse(text)

    result = st.session_state.get(SS_NL_RESULT)
    if not result:
        return

    # ---- 分支 1：AI 不可用 ----
    if result.get("error"):
        st.warning("AI服务不可用，请使用手动输入")
        detail = str(result.get("message") or "").strip()
        if detail:
            st.caption(f"详细信息：{detail}")
        if st.button("知道了", key="ss_nl_dismiss", use_container_width=True):
            _nl_clear()
            _safe_rerun()
        return

    # ---- 分支 2：信息不足，需要追问 ----
    if result.get("needs_clarification"):
        question = str(result.get("clarification_question") or "请补充更具体的时间信息").strip()
        st.info(f"还想确认一下：{question}")
        with st.form(key="ss_nl_clarify_form"):
            extra = st.text_input("补充说明", key="ss_nl_extra", placeholder="例如：周三下午两点")
            clarify_clicked = st.form_submit_button("继续解析", use_container_width=True)

        if clarify_clicked:
            # 把原始输入和补充说明拼在一起重新解析，避免丢失上下文
            original = str(st.session_state.get(SS_NL_SOURCE) or "").strip()
            combined = f"{original}\n补充说明：{extra}".strip() if original else str(extra)
            _nl_parse(combined)
        return

    # ---- 分支 3：解析成功，逐条确认（可编辑）后再写入 ----
    items = list(st.session_state.get(SS_NL_ITEMS) or [])
    if not items:
        st.warning("没有识别到任何日程或截止，请换个说法再试，或使用手动输入")
        if st.button("重新输入", key="ss_nl_retry", use_container_width=True):
            _nl_clear()
            _safe_rerun()
        return

    st.markdown(
        f'<div class="ss-preview-head">解析结果（共 {len(items)} 条，确认后才会写入）</div>',
        unsafe_allow_html=True,
    )
    _render_nl_items(items)

    col_ok, col_cancel = st.columns(2)
    with col_ok:
        if st.button(
            f"✅ 确认添加（{len(items)}）", key="ss_nl_confirm",
            use_container_width=True, type="primary",
        ):
            _nl_confirm(items)
    with col_cancel:
        if st.button("取消", key="ss_nl_cancel", use_container_width=True):
            _nl_clear()
            _safe_rerun()


# ---------------------------------------------------------------------------
# 组件 5：日程管理（编辑 / 完成切换 / 删除已录入的日程）
# ---------------------------------------------------------------------------
def _manage_edit_html(task: dict) -> str:
    """渲染「正在编辑某条日程」的提示卡片。"""
    return (
        f'<div class="ss-preview-head">✏️ 正在编辑：{html.escape(str(task.get("title") or ""))}'
        f'（{html.escape(str(task.get("date") or ""))}）</div>'
    )


def _render_task_editor(task: dict) -> None:
    """渲染一条已录入日程的编辑表单，保存时通过 task_manager.update_task 落盘。"""
    task_id = task.get("id")
    prefix = f"ss_manage_edit_{task_id}"
    task_type = _render_type_selector(prefix, task)   # 表单外，切换类型立刻生效
    with st.form(key=f"ss_manage_edit_form_{task_id}"):
        values = _render_task_fields(prefix, task, task_type=task_type, with_done=True)
        saved = st.form_submit_button("💾 保存修改", use_container_width=True, type="primary")
        canceled = st.form_submit_button("取消", use_container_width=True)

    if saved:
        if not values.get("title"):
            st.error("标题不能为空")
            return
        if update_task(task_id, values):  # 只改数据，不直接碰 JSON
            set_flash("success", f"已更新：{values['title']}")
            st.session_state[SS_MANAGE_EDIT] = None
            _safe_rerun()
        else:
            st.error("保存失败，请重试")
    elif canceled:
        st.session_state[SS_MANAGE_EDIT] = None
        _safe_rerun()


def _relation_caption(task: dict, tasks: list) -> str:
    """给「子任务 / 父任务」加一句归属说明（让 parent_id 在界面上看得见）。

    Args:
        task: 当前任务。
        tasks: 全部任务（用来找父任务或子任务）。

    Returns:
        str: 一句说明；没有归属关系时返回空字符串。
    """
    by_id = {t.get("id"): t for t in (tasks or []) if isinstance(t, dict)}
    parent_id = task.get("parent_id")
    if parent_id is not None and parent_id in by_id:
        return f"↳ 属于：{by_id[parent_id].get('title', '')}"
    children = [t for t in (tasks or [])
                if isinstance(t, dict) and t.get("parent_id") == task.get("id")]
    if children:
        titles = "、".join(str(c.get("title") or "") for c in children[:3])
        more = f" 等 {len(children)} 个" if len(children) > 3 else ""
        return f"↳ 含 {len(children)} 个子任务：{titles}{more}"
    return ""


def _render_decompose_panel(task: dict) -> None:
    """把一个任务交给 AI 拆成子任务，确认后才带 parent_id 落盘。

    流程：点 🤖 → 调 ai_parser.decompose_task()（只联网、不写数据）
          → 结果进 session_state，逐条让你确认/改日期/改耗时 → 点「全部加入」才落盘。
    这样即使 AI 拆得不好，也不会有半成品进你的日程；取消就是纯取消。

    Args:
        task: 要拆解的日程 dict。
    """
    task_id = task.get("id")
    title = str(task.get("title") or "")
    st.markdown(
        f'<div class="ss-section-title">🤖 拆解「{html.escape(title)}」</div>',
        unsafe_allow_html=True,
    )

    items = st.session_state.get(SS_DECOMPOSE_ITEMS)
    if items is None:
        # 第一次进面板：调一次 AI，然后把结果存进 session_state（避免每次重跑都调）
        with st.spinner("AI 正在拆解…"):
            result = ai_parser.decompose_task(title, str(task.get("date") or ""))
        if result.get("error"):
            st.error(result.get("message") or "AI 拆解失败")
            st.caption("没有配置 AI 也能自己手动建子任务；或改成稍后再试。")
            if st.button("关闭", key=f"ss_decomp_close_{task_id}", use_container_width=True):
                st.session_state[SS_DECOMPOSE] = None
                _safe_rerun()
            return
        raw = result.get("subtasks") or []
        st.session_state[SS_DECOMPOSE_ITEMS] = [
            {
                "title": str(s.get("title") or ""),
                "date": str(s.get("suggested_date") or task.get("date") or ""),
                "estimate_min": int(s.get("estimate_min") or 0),
            }
            for s in raw
        ]
        st.session_state[SS_DECOMPOSE] = task_id
        _safe_rerun()

    st.caption(f"AI 拆出 {len(items)} 步。确认（可改日期/耗时/去掉不要的）后再加入，"
               f"它们会作为子任务挂在「{title}」下面。")

    with st.form(key=f"ss_decomp_form_{task_id}"):
        keep_flags, edited = [], []
        for index, item in enumerate(items):
            col_keep, col_title, col_date, col_est = st.columns([1, 4, 2, 2])
            with col_keep:
                keep_flags.append(st.checkbox("加入", value=True,
                                              key=f"ss_decomp_keep_{task_id}_{index}"))
            with col_title:
                edited.append(str(st.text_input("子任务", value=item["title"],
                                                key=f"ss_decomp_title_{task_id}_{index}")))
            with col_date:
                edited_date = st.date_input("日期", value=_parse_date_value(item["date"]),
                                            key=f"ss_decomp_date_{task_id}_{index}")
                edited.append(edited_date.isoformat() if hasattr(edited_date, "isoformat")
                              else str(edited_date))
            with col_est:
                edited.append(int(st.number_input(
                    "预计耗时(分)", min_value=0, max_value=24 * 60, step=15,
                    value=int(item["estimate_min"] or 0),
                    key=f"ss_decomp_est_{task_id}_{index}",
                )))
        col_ok, col_cancel = st.columns(2)
        with col_ok:
            submitted = st.form_submit_button("➕ 全部加入", use_container_width=True,
                                              type="primary",
                                              key=f"ss_decomp_form_{task_id}")
        with col_cancel:
            canceled = st.form_submit_button("取消", use_container_width=True,
                                             key=f"ss_decomp_cancel_{task_id}")

    if canceled:
        st.session_state[SS_DECOMPOSE] = None
        st.session_state[SS_DECOMPOSE_ITEMS] = None
        _safe_rerun()

    if not submitted:
        return

    entries = []
    for index in range(len(items)):
        if not keep_flags[index]:
            continue
        subtask_title = edited[index * 3]
        subtask_date = edited[index * 3 + 1]
        subtask_est = edited[index * 3 + 2]
        if not subtask_title.strip():
            continue
        entries.append({
            "title": subtask_title.strip(),
            "date": subtask_date,
            "type": config.TYPE_LABELS[config.TYPE_SUBTASK],
            "start_time": "",
            "end_time": "",
            "priority": config.PRIORITY_LABELS[config.PRIORITY_MID],
            "estimate_min": subtask_est,
        })

    if not entries:
        st.warning("一条都没勾选，或标题都是空的")
        return

    rows = ai_parser.to_local_tasks({"events": entries}, parent_id=task_id)
    added = sum(1 for row in rows if add_task(row))
    st.session_state[SS_DECOMPOSE] = None
    st.session_state[SS_DECOMPOSE_ITEMS] = None
    if added:
        set_flash("success", f"已拆出 {added} 个子任务，挂在「{title}」下面")
        _safe_rerun()
    st.error("添加失败，请重试")


def render_task_manager(tasks: list = None) -> None:
    """渲染「日程管理」：逐条修改 / 删除已经录入的日程。

    每条日程一行，右侧三个操作：
        ✏️ 编辑      → 展开编辑表单（标题/类型/日期/起止时间/优先级/已完成），保存走 update_task
        ✅ / ↩️      → 完成状态切换，走 update_task
        🗑️ 删除      → 二次确认后删除，走 delete_task（会级联删除其子任务）

    Args:
        tasks: 任务列表；传 None 时自动通过 task_manager.load_tasks() 读取。

    Returns:
        None
    """
    _require_streamlit()
    _inject_css()  # 自定义 CSS 放在函数顶部

    if tasks is None:
        tasks = load_tasks()

    st.markdown('<div class="ss-section-title">🗂️ 日程管理</div>', unsafe_allow_html=True)

    if SS_MANAGE_EDIT not in st.session_state:
        st.session_state[SS_MANAGE_EDIT] = None
    if SS_MANAGE_DELETE not in st.session_state:
        st.session_state[SS_MANAGE_DELETE] = None

    if not tasks:
        st.info("还没有任何日程。用左侧「自然语言」或「手动添加」建一条吧。")
        return

    # ---- 筛选 ----
    semester_start = (load_settings() or {}).get("semester_start")
    type_filter_labels = ["全部类型"] + [config.TYPE_LABELS[t] for t in config.ALL_TYPES]
    # 「进行中」是默认视图：已完成的和已结课的都不占地方
    status_filter_labels = ["进行中", "已完成", "已结束", "全部状态"]
    col_type, col_status, col_count = st.columns([1, 1, 2])
    with col_type:
        type_filter = st.selectbox("类型筛选", type_filter_labels, key="ss_manage_filter_type")
    with col_status:
        status_filter = st.selectbox("状态筛选", status_filter_labels, key="ss_manage_filter_status")
    with col_count:
        finished_total = sum(1 for t in tasks if is_task_finished(t, semester_start=semester_start))
        extra = f"，其中 {finished_total} 条已结课（自动收起、不计入待办）" if finished_total else ""
        st.caption(f"共 {len(tasks)} 条日程{extra}；改动会立即保存到本地数据文件。")

    visible = []
    for task in tasks:
        if type_filter != "全部类型":
            if config.TYPE_LABELS.get(task.get("type"), "") != type_filter:
                continue
        done = bool(task.get("done"))
        finished = is_task_finished(task, semester_start=semester_start)
        # 「本周结课」只在它还进行中时提示
        ending = (not finished) and ends_this_week(task, semester_start=semester_start)
        if status_filter == "进行中" and (done or finished):
            continue
        if status_filter == "已完成" and not done:
            continue
        if status_filter == "已结束" and not finished:
            continue
        visible.append((task, finished, ending))

    if not visible:
        if status_filter == "进行中" and finished_total:
            st.info("进行中的日程都清空了 🎉 —— 已结课的课程在「状态筛选 → 已结束」里。")
        else:
            st.caption("当前筛选条件下没有日程。")
        return

    st.caption(f"显示 {len(visible)} 条（按日期、时间排序）")

    for task, finished, ending in visible:
        task_id = task.get("id")

        # 状态 1：正在编辑这一条
        if st.session_state[SS_MANAGE_EDIT] == task_id:
            st.markdown(_manage_edit_html(task), unsafe_allow_html=True)
            _render_task_editor(task)
            continue

        # 状态 2：等待确认删除
        if st.session_state[SS_MANAGE_DELETE] == task_id:
            st.markdown(
                f'<div class="ss-error-card"><div class="ss-error-title">'
                f'确定删除「{html.escape(str(task.get("title") or ""))}」？</div>'
                f'<div class="ss-error-hint">删除后无法恢复，其子任务也会一并删除。</div></div>',
                unsafe_allow_html=True,
            )
            col_yes, col_no = st.columns(2)
            with col_yes:
                if st.button("确认删除", key=f"ss_manage_del_yes_{task_id}",
                             use_container_width=True, type="primary"):
                    if delete_task(task_id):  # 走 task_manager
                        set_flash("success", f"已删除：{task.get('title', '')}")
                        st.session_state[SS_MANAGE_DELETE] = None
                        _safe_rerun()
                    else:
                        st.error("删除失败，请重试")
            with col_no:
                if st.button("取消", key=f"ss_manage_del_no_{task_id}", use_container_width=True):
                    st.session_state[SS_MANAGE_DELETE] = None
                    _safe_rerun()
            continue

        # 状态 2.5：正在拆解这一条（AI 给步骤 → 确认后才落成子任务）
        if st.session_state.get(SS_DECOMPOSE) == task_id:
            _render_decompose_panel(task)
            continue

        # 状态 3：正常展示
        col_card, col_split, col_edit, col_done, col_delete = st.columns([6, 1, 1, 1, 1])
        with col_card:
            st.markdown(
                _task_card_html(task, finished=finished, ending=ending),
                unsafe_allow_html=True,
            )
            relation = _relation_caption(task, tasks)
            if relation:
                st.caption(relation)
        with col_split:
            # 子任务不再往下拆；日程/截止都可以拆成步骤
            if task.get("type") != config.TYPE_SUBTASK:
                if st.button("🤖", key=f"ss_manage_decomp_btn_{task_id}",
                             help="把这个任务拆成可执行的小步骤（AI 给草案，你确认后才加入）"):
                    st.session_state[SS_DECOMPOSE] = task_id
                    st.session_state[SS_DECOMPOSE_ITEMS] = None
                    st.session_state[SS_MANAGE_EDIT] = None
                    st.session_state[SS_MANAGE_DELETE] = None
                    _safe_rerun()
        with col_edit:
            if st.button("✏️", key=f"ss_manage_edit_btn_{task_id}", help="修改这条日程"):
                st.session_state[SS_MANAGE_EDIT] = task_id
                st.session_state[SS_MANAGE_DELETE] = None
                _safe_rerun()
        with col_done:
            done = bool(task.get("done"))
            if st.button("↩️" if done else "✅",
                         key=f"ss_manage_done_btn_{task_id}",
                         help="取消完成" if done else "标记完成"):
                if update_task(task_id, {"done": not done}):  # 走 task_manager
                    set_flash("success",
                              f"已取消完成：{task.get('title', '')}" if done
                              else f"已完成：{task.get('title', '')}")
                    _safe_rerun()
                else:
                    st.error("操作失败，请重试")
        with col_delete:
            if st.button("🗑️", key=f"ss_manage_del_btn_{task_id}", help="删除这条日程"):
                st.session_state[SS_MANAGE_DELETE] = task_id
                st.session_state[SS_MANAGE_EDIT] = None
                _safe_rerun()


# ---------------------------------------------------------------------------
# 组件 6：侧边栏
# ---------------------------------------------------------------------------
def render_semester_settings() -> None:
    """渲染「学期设置」：设置开学第一周的周一，用于计算「第几周」与单双周。

    设置保存在 data/settings.json，周视图的周次、单双周判断都读它。

    Returns:
        None
    """
    _require_streamlit()

    with st.expander("📅 学期设置", expanded=False):
        current = _semester_start()
        today_week = config.week_number_of(_today(), current)
        if today_week:
            parity = config.PARITY_LABELS.get(config.week_parity(today_week), "")
            st.caption(f"开学第一周周一：{current.isoformat()} · 今天是第 {today_week} 周（{parity}）")
        else:
            st.caption(f"开学第一周周一：{current.isoformat()} · 今天在学期之前")

        picked = st.date_input("开学第一周的周一", value=current, key="ss_semester_start")
        if st.button("保存学期设置", key="ss_semester_save", use_container_width=True):
            if save_settings({"semester_start": picked.isoformat()}):
                set_flash("success", f"学期开始已设为 {picked.isoformat()}")
                _safe_rerun()
            else:
                st.error("保存失败，请重试")
        st.caption("课程/日程的「每周重复」按这个起点换算周次与单双周。")

        times = _period_times()
        if times:
            lines = []
            for row in config.period_rows(times):
                key = config.row_key(row)
                if key in times or config.is_break_period(row[0], times):
                    start, end = config.row_time_range(row, times)
                    lines.append(
                        f"{config.row_label(row, times)} {start or '?'}-{end or '?'}"
                    )
            if lines:
                st.caption("已按导入的课表校准作息：" + " · ".join(lines))
            if st.button("清除校准，恢复默认作息", key="ss_period_reset", use_container_width=True):
                if save_settings({"period_times": {}}):
                    set_flash("success", "已恢复默认作息表")
                    _safe_rerun()
                else:
                    st.error("保存失败，请重试")


def render_sidebar() -> None:
    """渲染侧边栏：用 tabs 装「自然语言输入」和「手动添加表单」。

    两个组件内部只调用 st.*（Streamlit 的容器上下文是全局的），
    因此放在 `with st.sidebar:` 里就会渲染到侧边栏中。

    Returns:
        None
    """
    _require_streamlit()
    _inject_css()  # 自定义 CSS 放在函数顶部

    with st.sidebar:
        st.markdown('<div class="ss-app-title">🗓️ 智能日程助手</div>', unsafe_allow_html=True)
        render_flash()  # 展示上一次操作的结果

        # AI 是否可用只影响提示文案，不影响手动录入
        if not config.is_api_key_configured():
            st.warning("未配置AI服务，当前仅支持手动输入模式")
            st.caption(f"如需启用：把 .env.example 复制为 .env，并填入 {config.LLM_KEY_ENV}。")

        tab_natural, tab_manual = st.tabs(["💬 自然语言", "✍️ 手动添加"])
        with tab_natural:
            render_natural_input()
        with tab_manual:
            render_add_form()

        # ---- 学期设置：周次 / 单双周依赖它 ----
        render_semester_settings()

        # ---- 手机上使用（局域网地址 / 可选二维码） ----
        render_mobile_entry()

        # ---- 数据清理：一键清空已完成任务 ----
        st.divider()
        with st.expander("🧹 清理已完成任务", expanded=False):
            st.caption("删除所有已完成的任务，操作不可撤销。")
            clear_confirmed = st.checkbox("我确认清空已完成任务", key="ss_clear_done_confirm")
            if st.button("一键清空已完成任务", key="ss_clear_done", use_container_width=True):
                if not clear_confirmed:
                    st.error("请先勾选上面的确认框")
                else:
                    removed = clear_done_tasks()  # 通过 task_manager 操作
                    if removed > 0:
                        set_flash("success", f"已清空 {removed} 条已完成任务")
                        _safe_rerun()
                    elif removed == 0:
                        st.info("没有已完成的任务")
                    else:
                        st.error("清空失败，请重试")


if __name__ == "__main__":  # pragma: no cover
    # 本模块是 UI 组件库，不能单独运行；请用 streamlit 启动页面入口：
    #   streamlit run main.py
    print("ui_components.py 是 Streamlit 组件库，请通过 `streamlit run main.py` 启动界面。")
    print("streamlit 是否可用：", STREAMLIT_AVAILABLE)
