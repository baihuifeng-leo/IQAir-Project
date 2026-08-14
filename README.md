# 电商工作台 · E-commerce Workbench

面向小家电电商团队的内部工作台，集中处理竞品资料、评论、经营报告，以及素材关键词合规检测。项目采用原生 Node.js 与浏览器端 JavaScript 实现；运行时数据与代码目录分离，适合部署在内网 Ubuntu 虚拟机。

## 功能概览

| 模块 | 用途 |
| --- | --- |
| 价格带沙盘 | 按品牌与价格带维护产品矩阵，支持分类、批量编辑、协同修改与 PNG 导出。 |
| 竞品对位 | 维护品牌、产品素材与参数对位，支持中英文内容、原图预览和协同编辑。 |
| 评论风向标 | 导入 `.xlsx` 评论，按品牌、产品、维度和极性聚合，支持关键词与原评论溯源。 |
| 竞品 3D 预览 | 将价格、颗粒物 CADR、甲醛 CADR 等数据呈现在可交互的 3D 场景中。 |
| 报告管理 | 个人经营数据与微盟周数据的导入、汇总和放映。 |
| 素材质检 | 基于 PaddleOCR 的商品素材文字识别、产品归属判断、关键词检测与历史追溯。 |

## 素材质检

素材质检支持天猫、京东两套独立词库，并可在同一平台下维护多套词库。

- 自动识别上传素材是 `1:1` 或 `3:4`；其它比例会停止检测并说明原因。
- 产品归属以 OCR 文字证据为主，文件名只作为候选，避免滤芯素材被机器型号误判。
- 按产品、素材比例校验关键词，输出通过、提醒、报错三种状态。
- 区分缺词、串词、未入库词、价格不对与错词。
  - **错词**：期望词与识别内容仅相差一个字符（如“过滤筒”与“过滤桶”），会展示正确词、识别词，并高亮错误字。
  - **未入库词**：仅提示核对，不拦截通过状态。
- 检测台和历史记录均按上传批次折叠；检测台显示最近 24 小时的服务端记录，因此测试与生产环境可看到同步后的同一批记录。
- 关键词库支持产品封面、产品类型、分类、素材比例与价格配置。

## 架构与目录

```text
server.js                         HTTP 服务、登录、SSE 协同与 API 路由
merge.js                          价格带沙盘 / 竞品对位的三方合并
audit.js                          变更日志摘要
reviews-*.js                      评论导入、清洗、分析与存储
preview3d-store.js                3D 竞品数据存储
report-store.js                   个人报告数据存储
materialcheck-match.js            素材关键词匹配、错词/串词判定
materialcheck-store.js            词库、检测记录、上传素材与 OCR 调度
materialcheck-ocr.js              PaddleOCR 常驻进程管理
materialcheck-paddleocr-worker.py PaddleOCR Python Worker
materialcheck.test.js             素材质检回归测试
public/                           原生前端、样式和本地第三方资源
install.sh                        Ubuntu 首次安装与生产部署脚本
workbench.service                 systemd 服务模板
deploy-to-prod.sh                 发布前分支/工作区安全检查
```

项目不依赖 npm 包管理或前端构建步骤。评论 Excel 读取器、ECharts、Three.js、html2canvas 等资源均已随项目提供。

## 数据目录

代码与运行时数据必须分离。默认开发数据在项目的 `data/` 目录；生产环境使用 `DATA_DIR` 指定的数据目录。

```text
data/
├── db.json                 价格带沙盘、竞品对位等协同文档
├── users.json              用户、权限及个人偏好（PIN 为 scrypt 哈希）
├── .session-secret         会话签名密钥
├── audit.log               变更日志
├── uploads/                上传的图片与素材质检原图
├── materialcheck/
│   ├── products.json       平台 / 词库 / 产品 / 关键词配置
│   └── records.jsonl       素材质检历史记录
├── reviews/                评论库
├── products3d/             3D 竞品数据
├── reports/                个人报告数据
└── backups/                自动备份（默认保留最近 30 份）
```

生产代码位于 `/opt/workbench`，生产数据位于 `/var/lib/workbench`。部署代码不会删除或重置生产数据。

## 本地运行

前提：Node.js 20.9 或更高版本。素材质检还需要 Python 3、`paddlepaddle` 与 `paddleocr`；首次执行安装脚本会自动创建专用虚拟环境。

```bash
git clone <repository-url>
cd EC-Workbench
PORT=9090 DATA_DIR="$PWD/data" node server.js
```

打开 `http://<host>:9090`。首次启动会创建默认管理员 `admin / 123456`；请登录后立即修改 PIN。

常用检查：

```bash
curl http://127.0.0.1:9090/api/health
node merge.test.js
node materialcheck.test.js
```

## Ubuntu / systemd 部署

推荐通过 `install.sh` 部署。脚本会：

1. 检查 Node.js 与 Python 环境；
2. 创建或复用 `/opt/workbench/venv` 中的 PaddleOCR 环境；
3. 部署代码到 `/opt/workbench`；
4. 预热 PaddleOCR 模型；
5. 创建或复用 `/var/lib/workbench`；
6. 注册并重启 `workbench.service`。

```bash
cd /root/IQAir-Project/EC-Workbench
sudo bash install.sh
```

默认生产端口为 `8090`。服务单元通过 `DATA_DIR=/var/lib/workbench` 与 `HOME=/var/lib/workbench` 保证 OCR 模型缓存和业务数据都写入可持久化目录。

```bash
sudo systemctl status workbench
sudo systemctl restart workbench
journalctl -u workbench -f
curl http://127.0.0.1:8090/api/health
```

`install.sh` 每次运行都会执行依赖可用性检查、PaddleOCR 安装命令和模型预热；相同版本通常会复用已安装的 Python 包与已下载模型。这样部署耗时会略长，但可以及早发现 OCR 依赖或模型缓存损坏。

## 开发、测试与发布流程

当前约定如下：

1. 从 `main` 新建功能分支。
2. 在项目目录使用 `9090` 与项目 `data/` 进行开发、测试和验收。
3. 验收通过后，提交功能分支并合并回 `main`。
4. 推送 `main` 到 GitHub。
5. 在 `main` 且工作区干净时运行 `sudo bash install.sh`，将代码发布到生产 `8090`。
6. 测试数据与生产数据默认隔离；只有明确需要同步词库、检测历史或上传素材时，才逐文件核对后复制到 `/var/lib/workbench`。

`deploy-to-prod.sh` 可在部署前检查当前是否为 `main` 且工作区是否干净；实际生产发布仍以 `install.sh` 为准，因为它会同步处理 OCR 运行环境与 systemd 服务。

## 权限与安全

- 所有非登录、健康检查页面与 API 都需要登录。
- 会话使用 HttpOnly 签名 Cookie，默认有效期为 30 天。
- 管理员可管理用户、备份恢复、查看变更日志，并拥有素材质检词库编辑权限。
- 非管理员可按权限查看或编辑关键词库；未授权用户不会看到编辑入口。
- 图片原始字节直接保存，不经浏览器重编码；单图上限为 40 MB。
- systemd 服务使用非登录用户 `workbench` 运行，并限制写入范围到 `/var/lib/workbench`。

## 反向代理

生产环境建议由反向代理提供 HTTPS，并转发到 `http://<server-ip>:8090`。

- 请保留 `X-Forwarded-Proto`，服务据此决定 Cookie 是否使用 `Secure` 标记。
- 不要对 SSE 事件流启用响应缓冲，否则多人协同的实时更新会延迟。
- 如使用 UFW，仅开放反向代理所需来源到 `8090/tcp`。

## Docker 状态

仓库保留了 `Dockerfile` 与 `docker-compose.yml`，但它们尚未纳入当前素材质检所需的 Python/PaddleOCR 依赖，也未复制相关 OCR 模块。因此 Docker 配置目前不适合作为完整生产部署方案；请优先使用 systemd + `install.sh`。

## 维护提示

- 不要删除 `.session-secret`，除非需要强制所有用户重新登录。
- 不要直接修改生产 `records.jsonl` 或 `products.json`；优先从界面维护词库和检测记录。
- 生产服务无法识别图片时，先检查 `journalctl -u workbench -n 100 --no-pager`，再确认 `/opt/workbench/venv`、`HOME=/var/lib/workbench` 与模型缓存权限。
