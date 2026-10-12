# tests —— 可复跑的验证

不引入任何新依赖：`unittest` 是标准库，装了 `pytest` 也跑同一套。

## 怎么跑

```bash
# 方式一：标准库（推荐，零依赖）
python -m unittest discover -s tests -t .

# 方式二：装了 pytest 的话
pytest tests/ -v
```

指定隔离目录（环境只允许写某个目录时用得上）：

```powershell
$env:SS_TEST_DATA_DIR='D:\tmp\ss-tests'; python -m unittest discover -s tests -t .
```

## 数据安全

`tests/_support.py` 会把真实的 `data/*.json` **只读复制**到隔离目录，并把
`config.DATA_FILE` / `config.SETTINGS_FILE` 指过去，所以：

* 测试永远不会写你的真实日程；
* `_support.real_data_untouched()` 可以随时核对真实文件的 SHA256。

## 覆盖了什么

| 文件 | 覆盖 |
|---|---|
| `test_planner.py` | 预计耗时字段全链路、空档 / 需求 / 缺口 / 建议的纯函数断言 |
| `test_decompose.py` | AI 拆解（monkeypatch，不联网）、确认后带 `parent_id` 落盘、父子说明、级联删除 |
| `test_timetable.py` | 午休空档认定与保守性、节次数不写死（含第 14 节）、渲染结构不变量（同格不出现卡片+空闲、并排列的 flex-grow 之和等于 rowspan） |

## 和 `preview/` 里那批脚本的关系

`preview/` 保留了开发过程中用过的临时验证脚本（逐字节回归、基准 HTML 等），
它们是当时的取证工具；`tests/` 是整理后可以长期跑的版本。
