"""
main.py —— 智能日程管家的 Streamlit 入口。

启动方式（在本目录下执行）：
    pip install -r requirements.txt
    streamlit run main.py

页面结构：
    ┌ 顶部：标题 + 统计指标（st.metric：总数 / 已完成 / 待办 / DDL）
    ├ 侧边栏：render_sidebar()  → 自然语言输入 / 手动添加（tabs）+ 一键清空已完成
    └ 主区域：① render_week_view()  周视图（周一~周日 × 上午/下午/晚上）
              ② render_ddl_list()   未来 7 天截止提醒
              ③ 任务管理           完成 / 删除
              ④ 导出与导入         导出 CSV / 导入课程表
              ⑤ 底部说明           数据存储位置

错误处理边界：
    每个区域都用 ui_components.safe_render() 包一层，
    任何未捕获异常只会让该区域显示友好错误卡片，其余功能照常可用；
    main() 外层还有一层兜底 try-except。
"""

import csv
import io
import json
from datetime import date

# streamlit 是入口必需依赖；缺失时给出可执行的提示，而不是丢一堆 traceback
try:
    import streamlit as st

    STREAMLIT_AVAILABLE = True
except ImportError:  # pragma: no cover - 仅在缺少依赖时触发
    st = None
    STREAMLIT_AVAILABLE = False

import ai_parser
import config
import exporter
import importer
import storage
import task_manager
from ui_components import (
    is_control_flow_exception,
    render_ddl_list,
    render_error_page,
    render_flash,
    render_sidebar,
    render_task_manager,
    render_space_panel,
    render_week_view,
    render_workload_panel,
    safe_render,
    set_flash,
)

# 页面标题（同时用于浏览器标签页与页面顶部）
PAGE_TITLE = "智能日程管家"
FOOTER_TEXT = "数据存储在本地 data/schedules.json"

# 导出 CSV 的列（顺序即表头顺序）
EXPORT_COLUMNS = (
    "id", "title", "type", "date", "start_time", "end_time", "priority",
    "repeat", "week_start", "week_end", "week_parity", "periods", "location",
    "done", "parent_id", "estimate_min", "created_at",
)

# 导入流程在 session_state 里暂存解析结果
SS_IMPORT_RESULT = "ss_import_result"


# ---------------------------------------------------------------------------
# 页面配置
# ---------------------------------------------------------------------------
def _configure_page() -> None:
    """配置页面元信息。

    注意：st.set_page_config 必须是本次脚本运行中第一个执行的 Streamlit 命令，
    所以它被放在 main() 的最前面单独调用。
    """
    st.set_page_config(
        page_title=PAGE_TITLE,
        page_icon="📅",
        layout="wide",
    )


# ---------------------------------------------------------------------------
# 顶部统计
# ---------------------------------------------------------------------------
def _render_overview() -> None:
    """用 st.metric 展示任务概览：总数 / 已完成 / 待办 / DDL 数量。"""
    stats = task_manager.get_task_stats()  # 取数一律走 task_manager

    col_total, col_done, col_pending, col_ddl, col_finished = st.columns(5)
    with col_total:
        st.metric("📋 总任务", stats["total"])
    with col_done:
        st.metric("✅ 已完成", stats["done"])
    with col_pending:
        st.metric("🕒 待办", stats["pending"])
    with col_ddl:
        st.metric("⏰ DDL", stats["ddl"])
    with col_finished:
        st.metric("🎓 已结课", stats["finished"])


# ---------------------------------------------------------------------------
# 导出 / 导入
# ---------------------------------------------------------------------------
def tasks_to_csv(tasks: list) -> str:
    """把任务列表转成 CSV 文本（供「导出日程」按钮下载）。

    Args:
        tasks: task_manager.load_tasks() 得到的任务列表。

    Returns:
        str: CSV 文本（含表头；字段顺序见 EXPORT_COLUMNS）。
    """
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=list(EXPORT_COLUMNS), extrasaction="ignore")
    writer.writeheader()
    for task in tasks or []:
        if isinstance(task, dict):
            writer.writerow({key: task.get(key, "") for key in EXPORT_COLUMNS})
    return buffer.getvalue()


def tasks_to_json(tasks: list) -> str:
    """把任务列表转成 JSON 文本（导出用，能被 importer 再导入回来）。

    Args:
        tasks: 任务列表。

    Returns:
        str: 缩进过的 JSON 文本。
    """
    return json.dumps(tasks or [], ensure_ascii=False, indent=2)


def _decode_upload(raw: bytes) -> str:
    """把上传文件的字节解码成文本。

    中文 Windows 上 Excel 导出的 CSV 常常是 GBK，所以这里逐个编码试。

    Args:
        raw: 文件字节。

    Returns:
        str: 解码后的文本。
    """
    for encoding in ("utf-8-sig", "utf-8", "gbk", "utf-16"):
        try:
            return raw.decode(encoding)
        except (UnicodeDecodeError, UnicodeError):
            continue
    return raw.decode("utf-8", "replace")


def _read_import_source(uploaded, pasted: str) -> tuple:
    """从「上传的文件」或「粘贴的文本」里取到要解析的内容。

    Args:
        uploaded: st.file_uploader 的返回值（可能为 None）。
        pasted: 粘贴框里的文本。

    Returns:
        tuple: (文本, 文件名)；都没有内容时返回 ("", "")。
    """
    if uploaded is not None:
        try:
            raw = uploaded.getvalue()
        except Exception:  # noqa: BLE001 - 上传对象异常不该让页面崩
            raw = b""
        if isinstance(raw, str):
            return raw, str(getattr(uploaded, "name", ""))
        return _decode_upload(raw), str(getattr(uploaded, "name", ""))
    text = str(pasted or "")
    return (text, "") if text.strip() else ("", "")


def _render_import_preview(result: dict) -> None:
    """展示解析结果，并提供「确认导入」以及学期/作息的同步选项。

    Args:
        result: importer.parse_any() 的返回值。

    Returns:
        None
    """
    tasks = result.get("tasks") or []
    errors = result.get("errors") or []
    notes = result.get("notes") or []
    format_label = {"ics": "iCalendar (.ics)", "csv": "CSV", "json": "JSON"}.get(
        result.get("format"), result.get("format", "未知")
    )

    st.success(f"识别为 {format_label}，解析出 {len(tasks)} 条日程 / 课程。")

    if notes:
        with st.expander(f"合并与处理说明（{len(notes)} 条）", expanded=False):
            for note in notes:
                st.markdown(f"- {note}")

    if result.get("semester_start"):
        st.caption(f"从数据推断的学期第一周周一：**{result['semester_start']}**")
        st.checkbox(
            f"把学期开始设为 {result['semester_start']}（第几周、单双周都按它算）",
            value=True, key="ss_import_set_semester",
        )

    ranges = result.get("period_times") or {}
    if ranges:
        rendered = " · ".join(
            f"{config.row_label(row, ranges)} {config.row_time_range(row, ranges)[0] or '?'}"
            f"-{config.row_time_range(row, ranges)[1] or '?'}"
            for row in config.period_rows(ranges)
            if config.row_key(row) in ranges or config.is_break_period(row[0], ranges)
        )
        st.caption(f"从课表校准出的每节课时间：{rendered}")
        st.checkbox("保存这份作息表（周视图左侧会显示你学校的上下课时间）",
                    value=True, key="ss_import_apply_periods")

    if errors:
        with st.expander(f"⚠️ 有 {len(errors)} 条没能解析", expanded=False):
            for message in errors:
                st.markdown(f"- {message}")

    if tasks:
        preview = [{
            "标题": t.get("title", ""),
            "日期": t.get("date", ""),
            "开始": t.get("start_time", ""),
            "结束": t.get("end_time", ""),
            "节次": t.get("periods", ""),
            "重复": config.REPEAT_LABELS.get(t.get("repeat") or "none", ""),
            "周次": (f"第{t.get('week_start')}-{t.get('week_end')}周 "
                     f"{config.PARITY_LABELS.get(t.get('week_parity'), '')}"
                     if t.get("repeat") == config.REPEAT_WEEKLY else ""),
            "地点": t.get("location", ""),
        } for t in tasks]
        st.dataframe(preview, use_container_width=True, hide_index=True)

    col_ok, col_cancel = st.columns(2)
    with col_ok:
        if st.button("✅ 确认导入", key="ss_import_confirm",
                     use_container_width=True, type="primary", disabled=not tasks):
            added = 0
            for task in tasks:
                if task_manager.add_task(task):
                    added += 1

            settings_update = {}
            if st.session_state.get("ss_import_set_semester") and result.get("semester_start"):
                settings_update["semester_start"] = result["semester_start"]
            if st.session_state.get("ss_import_apply_periods") and ranges:
                settings_update["period_times"] = ranges
            if settings_update and not task_manager.save_settings(settings_update):
                st.warning("日程已导入，但设置保存失败（可稍后重试）")

            if added:
                st.session_state[SS_IMPORT_RESULT] = None
                set_flash("success", f"已导入 {added} 条")
                st.rerun()  # 导入成功后刷新页面
            else:
                st.error("没有导入任何内容，请检查上面的解析提示")
    with col_cancel:
        if st.button("取消", key="ss_import_cancel", use_container_width=True):
            st.session_state[SS_IMPORT_RESULT] = None
            st.rerun()


def _render_data_io(tasks: list) -> None:
    """渲染「导出日程 / 导入课表」面板（支持 ics / csv / json）。

    Args:
        tasks: 当前全部任务。

    Returns:
        None
    """
    with st.expander("📤 导出 / 📥 导入课程表", expanded=False):
        # ---- 导出 ----
        st.markdown("**导出日程**")
        col_csv, col_json, col_ics = st.columns(3)
        with col_csv:
            st.download_button(
                "⬇️ 导出 CSV",
                # 加 BOM，Excel 打开中文不乱码
                data=("\ufeff" + tasks_to_csv(tasks)).encode("utf-8"),
                file_name=f"schedules_{date.today().isoformat()}.csv",
                mime="text/csv",
                use_container_width=True,
            )
        with col_json:
            st.download_button(
                "⬇️ 导出 JSON",
                data=tasks_to_json(tasks).encode("utf-8"),
                file_name=f"schedules_{date.today().isoformat()}.json",
                mime="application/json",
                use_container_width=True,
            )
        with col_ics:
            st.download_button(
                "⬇️ 导出 .ics",
                data=exporter.ics_bytes(tasks),
                file_name=f"schedules_{date.today().isoformat()}.ics",
                mime="text/calendar",
                use_container_width=True,
                help="系统日历 / 手机日历可直接导入；本应用也能再读回来",
            )
        st.caption(f"共 {len(tasks)} 条 · 字段：{', '.join(EXPORT_COLUMNS)}")

        st.divider()

        # ---- 导入 ----
        st.markdown("**导入课程表 / 日程**")
        st.caption(
            "支持 **.ics**（WakeUp 课程表、超级课程表、手机日历导出的都是这个）、"
            "**.csv**（本应用模板，也能读 Excel 存的 GBK 编码）、**.json**（本应用导出）。"
            "格式会自动识别；双周课会被合并回一门课，学期起点和作息表也能一并校准。"
        )
        uploaded = st.file_uploader(
            "上传文件", type=["ics", "ical", "csv", "json", "txt"], key="ss_import_file"
        )
        pasted = st.text_area(
            "或者直接把内容粘贴到这里", height=110, key="ss_import_text",
            placeholder="BEGIN:VCALENDAR ... 或 高等数学,周三,第1-2节,,高,1-16",
        )

        if st.button("🔍 解析", key="ss_import_parse", use_container_width=True):
            text, name = _read_import_source(uploaded, pasted)
            if not text:
                st.error("请先上传文件，或把内容粘贴到上面的输入框")
            else:
                st.session_state[SS_IMPORT_RESULT] = importer.parse_any(text, name)

        result = st.session_state.get(SS_IMPORT_RESULT)
        if result:
            st.divider()
            _render_import_preview(result)

        st.caption(
            "CSV 模板：`课程名,日期或星期,节次/开始时间,结束时间,优先级,周次,地点`；"
            "周次写 1-16 / 1-8单 / 1-16双周，留空表示单次日程。"
        )


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def main() -> None:
    """页面主流程：配置 → 取数 → 侧边栏 → 主区域 → 底部。

    整个流程包在错误边界里：任何未捕获异常都会渲染成友好错误卡片，而不是白屏崩溃。
    """
    if not STREAMLIT_AVAILABLE:
        raise SystemExit(
            "未安装 streamlit，无法启动界面。\n"
            "请先执行：pip install -r requirements.txt\n"
            "启动方式：streamlit run main.py"
        )

    try:
        # 1) 页面配置（必须是第一个 Streamlit 命令）
        _configure_page()

        # 2) 页面顶部标题
        st.title("📅 智能日程管家")
        st.caption(
            f"今天是 {date.today().strftime('%Y-%m-%d')}"
            " · 按节次排课表 · 自然语言添加 · 截止提醒 · 日程可随时修改删除"
        )

        # 3) 身份与存储：解析「我的空间」→ 必要时发新的空间码 → 旧数据一次性迁移
        url_code = None
        try:
            url_code = st.query_params.get(storage.SPACE_PARAM)
        except Exception:  # noqa: BLE001 - 老版本 Streamlit 没有 query_params
            url_code = None
        space_code, space_is_new = storage.resolve_space_code(url_code)
        storage.set_current_space(space_code)
        if space_is_new:                      # 把新空间码写回 URL，方便收藏/加到主屏
            try:
                st.query_params[storage.SPACE_PARAM] = space_code
            except Exception:  # noqa: BLE001
                pass
        migrated = storage.migrate_legacy_json(space_code)

        # 从 task_manager 加载所有任务（只走 task_manager，不直接碰存储）
        tasks = task_manager.load_tasks()

        # 4) 渲染侧边栏（自然语言输入 / 手动添加 / 清理已完成）
        safe_render(render_sidebar, where="侧边栏")

        # 展示上一次操作的结果提示
        safe_render(render_flash, where="提示信息")

        # 5) 我的空间（多用户：空间码 / 换设备 / 删除）
        safe_render(render_space_panel, where="我的空间")

        # 5-①) 顶部统计
        safe_render(_render_overview, where="统计信息")

        # 5-②) 本周时间缺口：课表空档 vs 这周要做的事（判断逻辑在 planner.py）
        safe_render(render_workload_panel, tasks, where="时间缺口")

        # 6-①) 主区域上方：周视图
        safe_render(render_week_view, tasks, where="周视图")

        st.divider()

        # 6-②) 主区域下方：即将到来的 DDL
        safe_render(render_ddl_list, where="截止提醒")

        st.divider()

        # 6-③) 日程管理：修改 / 完成切换 / 删除已录入的日程
        safe_render(render_task_manager, tasks, where="日程管理")

        st.divider()

        # 6-④) 导出 / 导入课程表
        safe_render(_render_data_io, tasks, where="导入导出")

        # 7) 页面底部
        st.divider()
        st.caption(FOOTER_TEXT)

    except BaseException as exc:  # noqa: BLE001 - 页面级兜底
        if is_control_flow_exception(exc):
            raise  # st.rerun()/st.stop() 必须原样抛出，否则刷新会失效
        render_error_page(exc, "页面")


if __name__ == "__main__":
    # `streamlit run main.py` 会以 __main__ 身份执行本文件
    main()
