#!/usr/bin/env bash
# ===========================================================================
# backup.sh —— 在线备份「所有人的日程数据」（SQLite 单文件 app.db）
#
# 为什么不能直接 cp data/app.db：
#   数据库开了 WAL（storage.py 里 PRAGMA journal_mode=WAL），还在跑的时候
#   文件里可能有未落盘的事务。直接拷贝的副本有可能打不开、或者缺最近几条改动。
#   正确做法是用 SQLite 自己的在线备份 API（Connection.backup），它会在
#   一致性快照的前提下把库复制出来，**不需要停服务**，多人在线时也能跑。
#
# 用法：
#   bash deploy/backup.sh [目标目录] [保留份数]
#     bash deploy/backup.sh                       # 默认 ./backups，保留 14 份
#     bash deploy/backup.sh /mnt/backup 30        # 存到 /mnt/backup，保留 30 份
#
#   目标目录可以是挂载进来的网盘/U盘目录（异地备份更保险）。
#   保留份数是按文件名排序后保留最新的 N 个 app-*.db。
#
# 恢复（把某一份备份塞回去）：
#   cd deploy
#   docker compose stop app                                  # 先停应用，避免边写边换
#   docker compose cp /path/to/app-20260925-033000.db app:/app/data/app.db
#   docker compose start app
#   # 也可以直接验证一下备份内容：
#   #   docker compose exec app python -c "import sqlite3;c=sqlite3.connect('/app/data/app.db');print(c.execute('select count(*) from tasks').fetchone())"
#   #   表名以 storage.py 里的建表语句为准；报 no such table 的话先 .tables 看一眼。
#
# 定时任务（每天凌晨 3:30 备份到 /mnt/backup，保留 30 份）：
#   crontab -e
#   # 下面这一行整行粘进去（注意：cron 的 PATH 很干净，/usr/bin 是 docker 的常见位置）
#   30 3 * * * cd /opt/smart-scheduler && /usr/bin/bash deploy/backup.sh /mnt/backup 30 >> /var/log/ss-backup.log 2>&1
#   # 放一份到别的地方更保险（3-2-1 原则：至少两份介质）：
#   0 4 * * 0 cd /opt/smart-scheduler && /usr/bin/bash deploy/backup.sh /mnt/backup 30
#
# 退出码：0 成功；1 出错（路径不对、容器没起、备份为空等）。
# ===========================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# 0. 参数与常量
# ---------------------------------------------------------------------------
BACKUP_DIR="${1:-./backups}"
KEEP="${2:-14}"

# 容器内路径（与 docker-compose.yml 里的 scheduler-data:/app/data 对应）
CONTAINER_DB="/app/data/app.db"
# 容器内的临时目录要放在 /app/data 里面 —— 具名卷里一定有写权限。
SNAP_DIR="/app/data/_backup_tmp"
SNAP_FILE="${SNAP_DIR}/app.db"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# docker compose 的调用方式：本脚本在 deploy/ 里，compose 文件也在 deploy/ 里，
# 所以先 cd 过去，后面的命令就不用带 -f 了。允许用 COMPOSE_FILE 覆盖。
cd "${SCRIPT_DIR}"
COMPOSE=(docker compose)
if [[ -n "${COMPOSE_FILE:-}" ]]; then
  COMPOSE=(docker compose -f "${COMPOSE_FILE}")
fi

# ---------------------------------------------------------------------------
# 1. 检查环境
# ---------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || {
  echo "[错误] 找不到 docker 命令。确认 Docker 装好了，且当前用户能执行 docker（在 docker 组里）。" >&2
  exit 1
}

if ! "${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -qx "app"; then
  echo "[错误] 容器 app 没在运行。先执行： docker compose up -d" >&2
  "${COMPOSE[@]}" ps >&2 || true
  exit 1
fi

mkdir -p "${BACKUP_DIR}"
# 转成绝对路径：下面要 cd 进备份目录写文件，相对路径会错位
BACKUP_DIR="$(cd "${BACKUP_DIR}" && pwd)"

STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="${BACKUP_DIR}/app-${STAMP}.db"

echo "[1/4] 时区确认（备份文件名的时间戳按容器外的本地时间）"
echo "      date = $(date '+%Y-%m-%d %H:%M:%S %Z')"

# ---------------------------------------------------------------------------
# 2. 在容器内做一致性快照
# ---------------------------------------------------------------------------
echo "[2/4] 在容器内做 SQLite 在线备份 ..."
"${COMPOSE[@]}" exec -T app python -c "
import os, sqlite3, sys
src_path = '${CONTAINER_DB}'
snap_path = '${SNAP_FILE}'
if not os.path.exists(src_path):
    sys.exit('源数据库不存在：' + src_path)
os.makedirs(os.path.dirname(snap_path), exist_ok=True)
if os.path.exists(snap_path):
    os.remove(snap_path)
src = sqlite3.connect(src_path)
dst = sqlite3.connect(snap_path)
with dst:
    src.backup(dst)          # 在线备份：不需要停服务，读到的是一致的快照
dst.close()
src.close()
os.chmod(snap_path, 0o666)   # 让容器外的普通用户也能读/删这份临时文件
size = os.path.getsize(snap_path)
print('快照完成：%s (%d 字节)' % (snap_path, size))
if size < 1024:
    sys.exit('快照只有 %d 字节，看起来不对，已中止' % size)
"

# ---------------------------------------------------------------------------
# 3. 把快照拷到宿主机
# ---------------------------------------------------------------------------
echo "[3/4] 拷出到 ${TARGET} ..."
# docker compose cp 的源要写成 "服务名:容器内路径"，目标是宿主机目录。
# 同一目录内改名有风险（跨文件系统时 mv 会退化成拷贝+删除），
# 所以直接拷成带时间戳的最终文件名；拷坏了下面还会校验大小。
"${COMPOSE[@]}" cp "app:${SNAP_FILE}" "${TARGET}"

if [[ ! -s "${TARGET}" ]]; then
  echo "[错误] 拷贝出来的文件是空的：${TARGET}" >&2
  exit 1
fi
BYTES="$(wc -c < "${TARGET}" | tr -d ' ')"
echo "      已生成 $(basename "${TARGET}")，${BYTES} 字节"

# 清掉容器里的临时快照（数据卷里不留垃圾）
"${COMPOSE[@]}" exec -T app python -c "
import os
p = '${SNAP_FILE}'
os.path.exists(p) and os.remove(p)
" >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 4. 轮转旧备份
# ---------------------------------------------------------------------------
echo "[4/4] 轮转：只保留最新的 ${KEEP} 份"
if ! [[ "${KEEP}" =~ ^[0-9]+$ ]]; then
  echo "[警告] 保留份数 '${KEEP}' 不是数字，跳过轮转。" >&2
elif (( KEEP > 0 )); then
  # 按文件名倒序（app-YYYYmmdd-HHMMSS.db 的字典序 = 时间序），第 KEEP 个之后的删掉
  mapfile -t OLD < <(ls -1 "${BACKUP_DIR}"/app-*.db 2>/dev/null | sort -r | tail -n "+$((KEEP + 1))")
  if (( ${#OLD[@]} > 0 )); then
    for f in "${OLD[@]}"; do
      rm -f -- "$f"
      echo "      删除旧备份 $(basename "$f")"
    done
  else
    echo "      没有需要删除的旧备份"
  fi
fi

echo
echo "✅ 备份完成：${TARGET}"
echo "   当前备份列表（新→旧）："
ls -1t "${BACKUP_DIR}"/app-*.db 2>/dev/null | head -n "${KEEP}" | sed 's/^/     /'
echo
echo "   建议把其中最近的一份也放到别的地方（U盘/网盘/另一台机器）——"
echo "   备份和数据在同一块盘上，盘坏了就一起没了。"
