# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

电商工作台 (E-commerce Workbench) — an internal tool for a home-appliance category team to track competitor pricing, positioning, reviews, 3D comparisons, and personal sales reports. Zero external dependencies: a single Node.js `http` server, vanilla JS/CSS on the frontend, no `package.json`, no build step, no bundler. Designed to run on an internal Ubuntu VM with no outbound internet access (no CDN scripts/fonts).

## Repo layout is unusual — read this before editing

This working tree is a **flattened source view**, not the deployable layout. The real app ships as `competitive-workbench.tar.gz`, which unpacks to:

```
competitive-workbench/
  server.js, merge.js, audit.js, xlsx-lite.js,
  reviews-nlp.js, reviews-ingest.js, reviews-store.js,
  preview3d-store.js, report-store.js, merge.test.js,
  install.sh, Dockerfile, docker-compose.yml, workbench.service, README.md
  public/
    index.html, login.html, core.js, matrix.js, compare.js,
    reviews.js, preview3d.js, report.js, admin.js, users.js, settings.js,
    styles.css, seed.json, echarts.min.js, echarts-gl.min.js, html2canvas.min.js
```

In this repo, every file that is actively edited lives as a **loose file at the repo root** (frontend files that belong under `public/` are *not* in a `public/` subdirectory here — they sit flat next to `server.js`). A handful of files that essentially never change are **not tracked loose at all** and only exist inside `competitive-workbench.tar.gz`: `merge.js`, `audit.js`, `merge.test.js`, `Dockerfile`, `docker-compose.yml`, `workbench.service`, `public/seed.json`.

Consequences:
- `server.js` cannot run directly from the repo root as-is — it does `require('./merge.js')`, `require('./audit.js')`, and serves from `path.join(__dirname, 'public')`, none of which exist loose here. To actually run/test the server, extract `competitive-workbench.tar.gz` and work from `competitive-workbench/`, or copy the missing files in alongside the loose ones and mkdir `public/` + move the frontend files into it.
- Loose files at repo root are kept **byte-identical** to their counterparts inside the tarball. **Every commit that changes a loose source file also rebuilds `competitive-workbench.tar.gz`** so the archive never goes stale (see commit `05ef96f` for the incident where it wasn't done for a while and the shipped archive silently lagged behind). When making changes, rebuild and re-commit the tarball in the same commit:
  ```bash
  rm -rf /tmp/pack && mkdir -p /tmp/pack/competitive-workbench/public
  # copy root-only files (server-side) to competitive-workbench/
  cp server.js merge.js audit.js xlsx-lite.js reviews-nlp.js reviews-ingest.js \
     reviews-store.js preview3d-store.js report-store.js merge.test.js install.sh \
     Dockerfile docker-compose.yml workbench.service README.md /tmp/pack/competitive-workbench/
  # copy frontend files into public/
  cp index.html login.html core.js matrix.js compare.js reviews.js preview3d.js \
     report.js admin.js users.js settings.js styles.css seed.json \
     echarts.min.js echarts-gl.min.js html2canvas.min.js /tmp/pack/competitive-workbench/public/
  tar czf competitive-workbench.tar.gz -C /tmp/pack competitive-workbench
  ```
  (`merge.js`, `audit.js`, `merge.test.js`, `Dockerfile`, `docker-compose.yml`, `workbench.service`, `seed.json` only exist inside the current tarball — extract it first if you need to touch one of those and then re-pack.)
- `README.md` at the root documents the tarball's `public/`-based layout, not this flattened checkout — don't be confused when file paths in README don't match what `ls` shows here.
- `ANALYSIS.md` is a historical design proposal doc (pre-implementation technical plan), not current architecture — treat it as background, not a source of truth. Current behavior is described in README.md.

## Commands

No install step, no build step, no linter config, no `package.json`.

```bash
node server.js                 # run the server (needs merge.js/audit.js/public/ present — see above)
node merge.test.js             # run the 3-way merge unit tests (custom, zero-framework: prints ✓/✗ per case)
```

Environment variables read by `server.js`: `PORT` (default 8080), `DATA_DIR` (default `./data`), `ADMIN_USER` / `ADMIN_PIN` (only used once, when `users.json` doesn't exist yet).

Manual smoke test: start the server, open `/login.html`, log in as `admin` / `123456` (or whatever `ADMIN_PIN` was set to), then exercise the relevant tab in the browser. There is no automated frontend test suite — UI changes must be verified by hand.

## Architecture

**Server (`server.js`)** — a single-file Node `http` server, no framework, hand-rolled router (`if (p === '/api/...')` chain). Key pieces:
- `db.json` under `DATA_DIR` is the source of truth for the two collaboratively-edited documents, `matrix` (价格带沙盘/price-band board) and `compare` (竞品对位/competitor comparison), each with its own revision counter (`db.revs[name]`).
- `PUT /api/doc/:name` is the collaborative-save endpoint: client sends `{ rev, base, doc, tab }`; if the client's `base` revision is stale, the server three-way-merges (`merge3` from `merge.js`) the client's edit against the current server doc instead of rejecting or overwriting, then broadcasts the merged result over SSE to every connected client (`/api/events`, tab-aware so the editing client's own in-progress typing isn't clobbered).
- `audit.js`'s `diffSummary()` turns doc diffs into human-readable change-log lines (field-level, not "someone edited the doc") written to `audit.log` (JSONL, rotates at 8MB).
- Auth is username + 6-digit PIN, scrypt-hashed, HttpOnly signed session cookie (`.session-secret` file, 30-day sessions).
- Uploads (`/api/upload`) stream raw binary straight to disk — no canvas re-encoding, no base64, to avoid lossy recompression of product photos.
- Three feature areas each get their own append-only/store module instead of living in `db.json`, because their write patterns differ from the collaborative docs (see README "存储选型" reasoning): `reviews-store.js` (review corpus, JSONL, append-only, no merge conflicts by design), `preview3d-store.js` (full-overwrite import per upload, not incremental), `report-store.js` (per-user isolated, date-keyed incremental merge for daily data / Monday-keyed for 微盟 weekly data).
- `xlsx-lite.js` is a from-scratch `.xlsx` reader (no library) — parses the zip/XML directly via `zlib.inflateRawSync`, used by all three Excel-import flows (reviews, 3D preview, reports).
- `reviews-nlp.js` extracts **aspect × polarity** (维度×极性) from Chinese review text via keyword rules with negation-scope/context guards — deliberately not a positive/negative-review classifier (see README/ANALYSIS.md for why: this dataset is 97%+ nominally positive and a good/bad split would be near-content-free).

**Frontend** — no framework, no virtual DOM. `core.js` holds shared app state, the SSE client, debounced autosave (0.7s idle → `PUT /api/doc/:name`), the undo stack, and image compression before upload. Each top-level tab is its own file operating on shared state: `matrix.js` (price-band board), `compare.js` (competitor comparison), `reviews.js` (review sentiment board, uses ECharts), `preview3d.js` (3D scatter via ECharts-GL), `report.js` (personal reports), plus `admin.js` (audit log / backup-restore panel), `users.js` (user management), `settings.js` (per-user tab visibility). `styles.css` holds all design tokens and styling — no CSS-in-JS, no preprocessor.

Collaborative editing model (matrix/compare only — the other three tabs are import/form-driven and have no shared "document" or undo stack): client holds `{ rev, doc }`; on conflict the server's `merge3` reconciles field-level and array-level (by id) changes and the client is notified the merge happened rather than silently overwritten. See README's merge-outcome table for the exact same-cell-vs-different-cell conflict rules.
