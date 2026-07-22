# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

电商工作台 (E-commerce Workbench) — an internal tool for a home-appliance category team to track competitor pricing, positioning, reviews, 3D comparisons, personal sales reports, and material/keyword compliance checks (OCR-based). Zero external dependencies: a single Node.js `http` server, vanilla JS/CSS on the frontend, no `package.json`, no build step, no bundler. Designed to run on an internal Ubuntu VM with no outbound internet access (no CDN scripts/fonts).

## Repo layout

This directory (`EC-Workbench/`) **is** the git repo root — `git checkout` here gives you the real, directly-runnable structure:

```
EC-Workbench/
  server.js, merge.js, audit.js, xlsx-lite.js,
  reviews-nlp.js, reviews-ingest.js, reviews-store.js,
  preview3d-store.js, report-store.js, merge.test.js,
  materialcheck-ocr.js, materialcheck-match.js, materialcheck-store.js,
  materialcheck-paddleocr-worker.py, materialcheck.test.js,
  install.sh, deploy-to-prod.sh, Dockerfile, docker-compose.yml,
  workbench.service, README.md, ANALYSIS.md
  public/
    index.html, login.html, core.js, matrix.js, compare.js,
    reviews.js, preview3d.js, preview3d-scene.js, report.js,
    materialcheck.js, admin.js, users.js, settings.js, styles.css, seed.json,
    echarts.min.js, html2canvas.min.js,
    three.module.min.js + 12 three-*.js addon files (orbitcontrols,
    effectcomposer/renderpass/unrealbloompass/outputpass + shader deps,
    css2drenderer — the 3D preview's rendering stack)
```

There is **no** flattened/loose convention and **no** tarball to keep in sync — that historical setup (where the tracked source was a flat copy separate from a `competitive-workbench.tar.gz` deployable artifact) was retired in 2026-07-22. `git checkout` here always gives you something that runs as-is with `node server.js`.

This directory used to be split into `Test/` and `Product/` subfolders (a staging-copy model). That split was also retired the same day — this single directory is now both where development happens and where a deploy is sourced from, gated by branch/cleanliness checks (see below) instead of physical separation.

`/root/IQAir-Project` (the parent of this directory) is just the user's general project folder, holding other unrelated projects/config alongside this repo. It is **not** itself a git repo — this repo's root is `EC-Workbench/`.

Not tracked in git (gitignored, real runtime/tooling state):
- `data/` — runtime data dir (`db.json`, `users.json`, uploads, reviews/reports/materialcheck data, `.session-secret`, `audit.log`)
- `venv/` — Python virtualenv for the PaddleOCR worker used by material check (`materialcheck-paddleocr-worker.py`); set it up via `install.sh`
- `*.log`

## Commands

No install step, no build step, no linter config, no `package.json`. Run these from inside `EC-Workbench/`.

```bash
node server.js                 # run the server directly, no extraction/build step needed
node merge.test.js             # run the 3-way merge unit tests (custom, zero-framework: prints ✓/✗ per case)
node materialcheck.test.js     # material-check store unit tests
```

Environment variables read by `server.js`: `PORT` (default 8080), `DATA_DIR` (default `./data`), `ADMIN_USER` / `ADMIN_PIN` (only used once, when `users.json` doesn't exist yet).

Manual smoke test: start the server, open `/login.html`, log in as `admin` / `123456` (or whatever `ADMIN_PIN` was set to), then exercise the relevant tab in the browser. There is no automated frontend test suite — UI changes must be verified by hand.

## Workflow: dev → main → production

1. 日常开发直接在这个目录里做（当前签出的通常是某个 feature 分支，比如 `feature/materialcheck-paddleocr-ocr`），改完 commit。
2. 本地跑 `node server.js`（默认 8080）手动验证。
3. 验证通过后，合并进 `main`（`main` 是"已验证、可上生产"的唯一权威分支——不要直接在 `main` 上开发）。
4. 部署到生产：`./deploy-to-prod.sh`。这个脚本会先检查**当前分支必须是 `main` 且工作区干净**，不满足直接报错退出；检查通过后自动 `git pull origin main`，然后 `rsync`（排除 `.git`/`data`/`venv`/`*.log`）同步到 `/opt/workbench`（真正对外提供服务的目录，8090 端口，由 `/etc/systemd/system/workbench.service` 管理；因为 systemd 加了 `ProtectHome=true`，这个目录不能直接指向 `/root` 下，所以 rsync 这一跳始终需要）。rsync 前会先跑一遍 dry-run 给你看会同步什么，再要求手动确认。

## Architecture

**Server (`server.js`)** — a single-file Node `http` server, no framework, hand-rolled router (`if (p === '/api/...')` chain). Key pieces:
- `db.json` under `DATA_DIR` is the source of truth for the two collaboratively-edited documents, `matrix` (价格带沙盘/price-band board) and `compare` (竞品对位/competitor comparison), each with its own revision counter (`db.revs[name]`).
- `PUT /api/doc/:name` is the collaborative-save endpoint: client sends `{ rev, base, doc, tab }`; if the client's `base` revision is stale, the server three-way-merges (`merge3` from `merge.js`) the client's edit against the current server doc instead of rejecting or overwriting, then broadcasts the merged result over SSE to every connected client (`/api/events`, tab-aware so the editing client's own in-progress typing isn't clobbered).
- `audit.js`'s `diffSummary()` turns doc diffs into human-readable change-log lines (field-level, not "someone edited the doc") written to `audit.log` (JSONL, rotates at 8MB).
- Auth is username + 6-digit PIN, scrypt-hashed, HttpOnly signed session cookie (`.session-secret` file, 30-day sessions).
- Uploads (`/api/upload`) stream raw binary straight to disk — no canvas re-encoding, no base64, to avoid lossy recompression of product photos.
- Feature areas each get their own append-only/store module instead of living in `db.json`, because their write patterns differ from the collaborative docs (see README "存储选型" reasoning): `reviews-store.js` (review corpus, JSONL, append-only, no merge conflicts by design), `preview3d-store.js` (full-overwrite import per upload, not incremental), `report-store.js` (per-user isolated, date-keyed incremental merge for daily data / Monday-keyed for 微盟 weekly data), `materialcheck-store.js` (keyword library + detection history).
- `xlsx-lite.js` is a from-scratch `.xlsx` reader (no library) — parses the zip/XML directly via `zlib.inflateRawSync`, used by all Excel-import flows (reviews, 3D preview, reports).
- `reviews-nlp.js` extracts **aspect × polarity** (维度×极性) from Chinese review text via keyword rules with negation-scope/context guards — deliberately not a positive/negative-review classifier (see README/ANALYSIS.md for why: this dataset is 97%+ nominally positive and a good/bad split would be near-content-free).
- `materialcheck-ocr.js` / `materialcheck-paddleocr-worker.py` — material/listing keyword compliance check: uploaded images go through a long-running PaddleOCR worker process (Python, spawned via the venv), extracted text is matched against a per-product keyword library (`materialcheck-match.js`) to flag missing/garbled required keywords.

**Frontend** — no framework, no virtual DOM. `core.js` holds shared app state, the SSE client, debounced autosave (0.7s idle → `PUT /api/doc/:name`), the undo stack, and image compression before upload. Each top-level tab is its own file operating on shared state: `matrix.js` (price-band board), `compare.js` (competitor comparison), `reviews.js` (review sentiment board, uses ECharts), `preview3d.js` + `preview3d-scene.js` (3D scatter via Three.js — `preview3d.js` is the classic-script UI/data layer, `preview3d-scene.js` is the site's only ES module, bridged through `window.P3DScene` + the `p3dscene-ready` event), `report.js` (personal reports), `materialcheck.js` (material/keyword compliance check tab), plus `admin.js` (audit log / backup-restore panel), `users.js` (user management), `settings.js` (per-user tab visibility). `styles.css` holds all design tokens and styling — no CSS-in-JS, no preprocessor.

Collaborative editing model (matrix/compare only — the other tabs are import/form-driven and have no shared "document" or undo stack): client holds `{ rev, doc }`; on conflict the server's `merge3` reconciles field-level and array-level (by id) changes and the client is notified the merge happened rather than silently overwritten. See README's merge-outcome table for the exact same-cell-vs-different-cell conflict rules.

`ANALYSIS.md` is a historical design proposal doc (pre-implementation technical plan) — treat it as background, not a source of truth. Current behavior is described in `README.md`.
