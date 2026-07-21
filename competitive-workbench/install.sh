#!/usr/bin/env bash
#
# 竞品作战台 · Ubuntu 一键安装
#   sudo bash install.sh
#
# 干了这几件事：装 Node、建专用系统用户、把代码拷到 /opt/workbench、
# 数据目录放 /var/lib/workbench、注册成 systemd 服务并开机自启。
# 重复执行是安全的：它只更新代码，不碰你的数据和用户表。

set -euo pipefail

APP_DIR=/opt/workbench
DATA_DIR=/var/lib/workbench
SVC_USER=workbench
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

info() { printf '\033[36m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 sudo 跑：sudo bash install.sh"
[[ -f "$SRC_DIR/server.js" && -f "$SRC_DIR/audit.js" && -d "$SRC_DIR/public" ]] || die "在解压后的目录里跑这个脚本（要能看到 server.js 和 public/）"

# 源目录不能就是运行目录：下面要先删 $APP_DIR/public 再拷贝，同一个地方会把前端删光
if [[ "$SRC_DIR" == "$APP_DIR" ]]; then
  die "不要在 $APP_DIR 里就地运行本脚本。把源码解压到别处（比如 ~/competitive-workbench）再跑。"
fi
case "$SRC_DIR" in
  "$APP_DIR"/*) warn "源码放在了 $APP_DIR 里面。能装，但建议挪到 ~ 下面，免得和运行目录混在一起。" ;;
esac

# ── 1. Node ────────────────────────────────────────────────
if command -v node >/dev/null 2>&1 && [[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]]; then
  info "Node 已就绪：$(node -v)"
else
  info "安装 Node.js…"
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
  MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [[ "$MAJOR" -ge 18 ]] || die "仓库里的 Node 太旧（$(node -v 2>/dev/null || echo 无)）。装 NodeSource 的 22.x 再来：
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs"
  info "Node 安装完成：$(node -v)"
fi

# ── 2. 专用用户，不给登录 shell ────────────────────────────
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
  info "创建系统用户 $SVC_USER"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
fi

# ── 3. 代码 ────────────────────────────────────────────────
info "部署代码到 $APP_DIR"
mkdir -p "$APP_DIR"
rm -rf "$APP_DIR/public"
for f in server.js merge.js audit.js xlsx-lite.js reviews-nlp.js reviews-ingest.js reviews-store.js preview3d-store.js report-store.js; do
  [[ -f "$SRC_DIR/$f" ]] || die "源码目录里缺少 $f"
  install -m 0644 "$SRC_DIR/$f" "$APP_DIR/"
done
[[ -f "$SRC_DIR/README.md" ]] && install -m 0644 "$SRC_DIR/README.md" "$APP_DIR/"
cp -r "$SRC_DIR/public" "$APP_DIR/public"
chown -R root:root "$APP_DIR"
chmod -R a+rX "$APP_DIR"

# ── 4. 数据目录（服务唯一可写的地方）─────────────────────
info "准备数据目录 $DATA_DIR"
mkdir -p "$DATA_DIR" "$DATA_DIR/reviews" "$DATA_DIR/products3d" "$DATA_DIR/reports"
chown -R "$SVC_USER:$SVC_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

# ── 5. systemd ─────────────────────────────────────────────
if [[ -f /etc/systemd/system/workbench.service ]]; then
  warn "已存在 workbench.service，保留你改过的配置（端口、PIN 等没动）"
else
  info "注册 systemd 服务"
  install -m 0644 "$SRC_DIR/workbench.service" /etc/systemd/system/workbench.service
fi

systemctl daemon-reload
systemctl enable workbench >/dev/null 2>&1
systemctl restart workbench

sleep 1.5
if ! systemctl is-active --quiet workbench; then
  die "服务没起来，看日志：journalctl -u workbench -n 40 --no-pager"
fi

PORT="$(systemctl show workbench -p Environment --value | tr ' ' '\n' | sed -n 's/^PORT=//p')"
PORT="${PORT:-8090}"
IP="$(hostname -I | awk '{print $1}')"

echo
info "跑起来了 → http://${IP}:${PORT}"
if [[ ! -s "$DATA_DIR/users.json" ]] || grep -q '"defaultPin": *true' "$DATA_DIR/users.json" 2>/dev/null; then
  warn "默认账号 admin / 123456 —— 登录后第一件事去「⋯ → 用户管理」改掉"
fi
echo
echo "  看日志      journalctl -u workbench -f"
echo "  重启        sudo systemctl restart workbench"
echo "  改端口/PIN  sudo systemctl edit --full workbench"
echo "  数据在      $DATA_DIR"
echo
