# =============================================================================
# 智能日程管家 Smart Scheduler —— 生产用 Dockerfile
#
#   构建：docker build -t smart-scheduler:1.0 .
#   运行：docker run -d --name smart-scheduler -p 8501:8501 \
#              -e ZHIPU_API_KEY=xxxx \
#              -v smart-scheduler-data:/app/data \
#              smart-scheduler:1.0
#   打开：http://localhost:8501        （手机访问把 localhost 换成电脑的局域网 IP）
#
#   【重要】数据目录 data/ 必须挂载出来（上面那条 -v）。
#   schedules.json / settings.json 是运行期写进容器文件系统的，
#   不挂载的话，容器一删（docker rm）或镜像一重建，你的课表和日程就一起没了。
#   挂载方式二选一：
#     -v smart-scheduler-data:/app/data     具名卷，Windows/macOS 上最省事
#     -v D:\smart-scheduler-data:/app/data  绑定宿主机目录，备份就是拷贝这个文件夹
#
#   本文件用 python:3.12-slim；项目 requirements.txt 只要求 Python >= 3.10，
#   3.12 在 Debian 源里既有 tzdata 又是长期受支持的版本，体积也小。
# =============================================================================

FROM python:3.12-slim

# ---------------------------------------------------------------------------
# 一、时区
# ---------------------------------------------------------------------------
# 容器里默认是 UTC，比北京时间晚 8 小时；本项目大量按「今天 / 本周 / 当前节次」
# 判断状态（task_manager 的三种状态、周视图高亮今天），时区错了会整天错位。
#   TZ        —— 让 glibc 与 Python 的 datetime.now() 都按上海时间走
#   tzdata    —— 时区数据库，slim 镜像不带，不装的话 TZ 不生效
# 也可以用 -e TZ=Asia/Tokyo 在运行时改（tzdata 已装好，改完重启容器即可）。
ENV TZ=Asia/Shanghai
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata \
 && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
 && echo $TZ > /etc/timezone \
 && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# 二、Python 依赖
# ---------------------------------------------------------------------------
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app

# 先只拷 requirements.txt：只要它没变，改代码时这一层直接命中缓存，不用重装依赖
COPY requirements.txt ./
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r requirements.txt

# ---------------------------------------------------------------------------
# 三、应用代码
# ---------------------------------------------------------------------------
# 逐个列文件名而不是 COPY . . ：这样镜像里有什么，看这几行就知道。
# planner.py 是「本周空档 vs 这周要做的事」的纯函数模块，被 ui_components.py import，
# 漏了它镜像能启动、但「本周空档」那块会整体失效（import 失败被容错吞掉）。
COPY main.py config.py task_manager.py importer.py exporter.py storage.py ai_parser.py ui_components.py planner.py healthcheck.py ./
COPY launcher.py ./
COPY .streamlit/ ./.streamlit/
COPY .env.example ./.env.example

# data/ 是数据目录，只保证它存在（真正的数据靠运行时挂载进来）。
# 这里**故意不写 COPY data/ ./data/**：.dockerignore 已经排除了 data/，
# 即使写了也只会拷到一个空目录；不写，是为了保证镜像里永远是「空数据」，
# 不会把你本机的 schedules.json（真实课表、作业、DDL）打包进去。
RUN mkdir -p /app/data

# ---------------------------------------------------------------------------
# 四、端口与健康检查
# ---------------------------------------------------------------------------
EXPOSE 8501

# 打 Streamlit 自带的健康端点 http://localhost:8501/_stcore/health
# 返回 ok 才算健康。这里用 Python 标准库 urllib，不额外依赖 curl/wget。
# 检查 start-period 给 40 秒冷启动时间；启动中不会立刻判成 unhealthy。
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["python", "healthcheck.py"]

# ---------------------------------------------------------------------------
# 五、启动命令
# ---------------------------------------------------------------------------
# PORT 只是给「不想用 8501」的人留的口子：
#   docker run ... -e PORT=8080 -p 8080:8080 smart-scheduler:1.0
# 改动端口要连 -p 一起改；EXPOSE 与 HEALTHCHECK 仍按 8501 写的，
# 换了端口请把 HEALTHCHECK 里的端口一起换掉。
ENV PORT=8501

# server.address 必须是 0.0.0.0：容器里的 localhost 不是宿主机，
# 只监听 127.0.0.1 的话 -p 8501:8501 也转发不进来。
# headless=true 禁止 Streamlit 尝试打开浏览器（容器里没有浏览器）。
CMD streamlit run main.py --server.address=0.0.0.0 --server.port=${PORT} --server.headless=true
