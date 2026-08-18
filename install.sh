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
node_meets_requirement() {
  local version="${1#v}" major minor
  IFS=. read -r major minor _ <<< "$version"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
  (( major > 20 || (major == 20 && minor >= 9) ))
}

if command -v node >/dev/null 2>&1 && node_meets_requirement "$(node -v)"; then
  info "Node 已就绪：$(node -v)"
else
  if command -v node >/dev/null 2>&1; then
    warn "当前 Node 版本为 $(node -v)，详情长图需要 Node.js >=20.9.0，准备安装/检查兼容版本…"
  else
    info "安装 Node.js…"
  fi
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
  NODE_VERSION="$(node -v 2>/dev/null || echo 无)"
  node_meets_requirement "$NODE_VERSION" || die "Node.js 版本过旧（$NODE_VERSION），详情长图需要 Node.js >=20.9.0。请安装 NodeSource 22.x 后重试。"
  info "Node 安装完成：$(node -v)"
fi

# ── 2. OCR 引擎（PaddleOCR，跑在独立的 Python venv 里）──────
# 素材质检需要 Python3 + PaddlePaddle + PaddleOCR。装进 $APP_DIR/venv 这个专用
# 虚拟环境，不碰系统 Python（Ubuntu 24.04 默认不让直接 pip install 到系统环境）。
info "准备 Python 环境…"
apt-get update -qq
apt-get install -y -qq python3 python3-venv python3-pip >/dev/null
mkdir -p "$APP_DIR"
if [[ ! -x "$APP_DIR/venv/bin/python3" ]]; then
  python3 -m venv "$APP_DIR/venv"
fi
info "安装 PaddlePaddle + PaddleOCR（体积较大，第一次装可能要几分钟）…"
"$APP_DIR/venv/bin/pip" install --quiet --upgrade pip
"$APP_DIR/venv/bin/pip" install --quiet paddlepaddle paddleocr
command -v "$APP_DIR/venv/bin/python3" >/dev/null 2>&1 || die "PaddleOCR 环境安装失败，素材质检功能需要它才能跑"
info "Python 环境安装完成"

# ── 3. 专用用户，不给登录 shell ────────────────────────────
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
  info "创建系统用户 $SVC_USER"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
fi

# ── 4. 代码 ────────────────────────────────────────────────
info "部署代码到 $APP_DIR"
mkdir -p "$APP_DIR"
rm -rf "$APP_DIR/public"
for f in server.js merge.js audit.js xlsx-lite.js reviews-nlp.js reviews-ingest.js reviews-store.js preview3d-store.js report-store.js report-news-store.js report-news-ai.js materialcheck-ocr.js materialcheck-match.js materialcheck-store.js materialcheck-paddleocr-worker.py \
  detail-task-store.js detail-worker.js detail-worker-client.js detail-url.js detail-image-resolver.js detail-png-composer.js detail-job-runner.js detail-api.js png-stream-writer.js sharp-operation-runner.js sharp-operation-child.js platform-session-store.js taobao-session.js taobao-detail-adapter.js; do
  [[ -f "$SRC_DIR/$f" ]] || die "源码目录里缺少 $f"
  install -m 0644 "$SRC_DIR/$f" "$APP_DIR/"
done
[[ -f "$SRC_DIR/README.md" ]] && install -m 0644 "$SRC_DIR/README.md" "$APP_DIR/"
install -m 0644 "$SRC_DIR/package.json" "$APP_DIR/"
install -m 0644 "$SRC_DIR/package-lock.json" "$APP_DIR/"
cp -r "$SRC_DIR/public" "$APP_DIR/public"

# 详情长图：Sharp 图片合成 + Playwright 受控浏览器。npm 依赖锁定在刚拷贝的
# package.json/package-lock.json 里；--omit=dev 跳过只有测试用得到的 jsdom。
info "安装 Node 依赖（sharp / playwright / fflate）…"
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund)

# Chromium 的二进制默认会下到 $HOME/.cache；这里显式钉到数据目录下（跟
# workbench.service 里同名的环境变量必须一致），装完后服务用户只需要读权限，
# 不需要在生产环境里自己再下一次。中文字体是给素材质检/详情长图两处的
# 图片文字渲染用的（这台安装机上如果没有 fontconfig+CJK 字体，Sharp 合成出的
# 长图里的中文会整段渲染不出来，不是崩溃，是静默空白，容易被忽略）。
info "安装 Chromium 与操作系统依赖（含中文字体，第一次装体积较大）…"
apt-get install -y -qq fonts-noto-cjk >/dev/null
export PLAYWRIGHT_BROWSERS_PATH="$DATA_DIR/browser-cache"
mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"
(cd "$APP_DIR" && PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" npx --yes playwright install --with-deps chromium)
info "Chromium 安装完成"

chown -R root:root "$APP_DIR"
chmod -R a+rX "$APP_DIR"
# venv 是装机时生成的运行环境，不是代码，跳过上面这次 chown/chmod 遗留的所有权问题：
# 一起 chown/chmod 没关系，重新走一遍权限（world-readable+execute）venv 和刚装的
# node_modules 也都能正常跑（npm ci/playwright install 在这一步之前跑完，所以
# 这次 chmod 会正确覆盖到它们，不会漏掉）。

info "预热 PaddleOCR 模型（第一次跑要下载模型文件，需要联网，可能要一两分钟）…"
if "$APP_DIR/venv/bin/python3" "$APP_DIR/materialcheck-paddleocr-worker.py" --warmup >/dev/null 2>&1; then
  info "PaddleOCR 模型预热完成"
else
  warn "PaddleOCR 模型预热失败（可能是没联网），素材质检功能启动时会自动重试，不影响其它功能"
fi

# ── 5. 数据目录（服务唯一可写的地方）─────────────────────
# platform-sessions：淘宝/天猫受控浏览器的持久登录态（每个账号一个子目录）。
# detail-jobs：详情长图任务记录 + 拼好的 PNG 结果，按任务 id 分子目录。
# browser-cache：上一步装好的 Chromium 二进制，重复执行本脚本不会重新下载
# （目录已存在时 playwright install 会跳过）。这三个目录都不会被本脚本删除，
# 重复安装不丢登录态、不丢历史任务结果。
info "准备数据目录 $DATA_DIR"
mkdir -p "$DATA_DIR" "$DATA_DIR/reviews" "$DATA_DIR/products3d" "$DATA_DIR/reports" "$DATA_DIR/report-news" "$DATA_DIR/materialcheck" "$DATA_DIR/uploads/materialcheck" "$DATA_DIR/platform-sessions" "$DATA_DIR/detail-jobs" "$DATA_DIR/browser-cache"
chown -R "$SVC_USER:$SVC_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

# ── 6. systemd ─────────────────────────────────────────────
if [[ -f /etc/systemd/system/workbench.service ]]; then
  warn "已存在 workbench.service，保留你改过的配置（端口、PIN 等没动）"
else
  info "注册 systemd 服务"
  install -m 0644 "$SRC_DIR/workbench.service" /etc/systemd/system/workbench.service
fi
if [[ ! -f /etc/workbench/ai.env ]]; then
  install -d -m 0750 /etc/workbench
  install -m 0600 "$SRC_DIR/workbench-ai.env.example" /etc/workbench/ai.env
  warn "已创建 /etc/workbench/ai.env 模板；填写 AI_API_KEY 与 AI_MODEL 后重启服务即可启用 AI 新闻生成"
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
