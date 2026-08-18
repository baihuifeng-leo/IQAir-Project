# Task 4 Report — 天猫与淘宝详情适配器

## Status

DONE

## Implemented

- Added `extractDetail(page, { timeoutMs, emit })` in `taobao-detail-adapter.js`.
- Uses separate explicit root selector sets for `detail.tmall.com` and `item.taobao.com`; missing and ambiguous roots fail with distinct codes.
- Scrolls only the supplied controlled Page by viewport increments and requires root height, included image count, and mutation count to remain unchanged for three consecutive observations at the root bottom.
- Fails with `DETAIL_INCOMPLETE` at timeout and never extracts partial blocks after timeout.
- Preserves DOM order for image, text, table, and video-poster blocks while excluding recommendation, review, shop, navigation, and overlay ancestry.
- Builds image candidates in the required order: `currentSrc`, numerically descending `srcset`, `src`, then supported lazy attributes.
- Normalizes protocol-relative Alibaba CDN URLs to HTTPS, deduplicates normalized candidates, filters inline/known transparent placeholders and disallowed hosts through `assertAllowedImageUrl`, and preserves path/query spelling.

## TDD Evidence

- Initial RED: `node --test taobao-detail-adapter.test.js` failed with `MODULE_NOT_FOUND` before production code existed.
- Mutation-check RED: semantic recommendation/review ancestry fixtures failed until exclusion behavior lived in the adapter instead of the FakePage.
- GREEN: `node --test taobao-detail-adapter.test.js detail-url.test.js` passed 15/15.

## Verification

- `node --check taobao-detail-adapter.js`
- `node --check taobao-detail-adapter.test.js`
- `node --test taobao-detail-adapter.test.js detail-url.test.js` — 15 passed, 0 failed.
- `npm test` — 85 passed, 0 failed; nested legacy suites also reported materialcheck 127/127 and merge 14/14.

## Concerns

- Per task instruction, verification used only deterministic FakePage fixtures and did not access any real Taobao/Tmall page. Production selector drift and live lazy-loader timing remain integration risks for the later controlled-session end-to-end acceptance step.

---

## Review Fix Round 1 — 2026-08-14

### Fixed findings

- Replaced the operation-name stub in `FakePage.evaluate` with a jsdom-backed
  browser environment. It installs `window`, `document`, `MutationObserver`,
  and `Node`, then invokes the exact browser function passed to `evaluate`.
  Geometry and scroll state are deterministic but the browser-side root query,
  traversal, ancestry filtering, mutation observation, and scroll decisions now
  run for real.
- The browser extraction now recursively walks `childNodes`, emits text/image/
  table/video blocks in encounter order, and stops descending when it emits a
  table or media node. Nested content therefore has no aggregate parent text or
  parent/child duplicate blocks.
- Stable completion distinguishes a scrollable trusted root from ordinary page
  scrolling. Overflow roots advance `root.scrollTop`; page scrolling stops when
  the trusted root's bottom reaches the viewport edge, and only then are the
  three stable observations counted. A root that has scrolled above the
  viewport is not a terminal page state.
- Centralized lazy-attribute and exclusion policy is now supplied as every
  `page.evaluate` argument. The browser and Node serialization use that same
  policy data. Marker collection includes id, class, role, every `data-*` and
  `aria-*` name/value, with camel-case normalization; main-image/gallery,
  recommendation, and review subtrees are excluded.
- Node serialization now drops image/video blocks with no allowed candidate.

### TDD evidence

- RED: `node --test taobao-detail-adapter.test.js` produced 3 expected
  failures against the previous adapter: aggregate/reordered nested content and
  decoys, an empty media block, and page overscroll to 5000 rather than the
  trusted root end at 3000.
- GREEN: `node --test taobao-detail-adapter.test.js detail-url.test.js` — 16
  passed, 0 failed.

### Verification

- `node --check taobao-detail-adapter.js`
- `git diff --check`
- `npm test` — 86 passed, 0 failed (the pre-existing expected PaddleOCR
  availability warning is emitted because its local worker binary is absent).

### Remaining concern

- jsdom is a test-only `devDependency` (`jsdom@26.1.0`); no production code
  imports it. The fixtures exercise the browser function but cannot detect live
  Taobao/Tmall selector or lazy-loader changes, which remain end-to-end risks.

---

## Re-review Round 1 Fix — 2026-08-14

- Added `recommended` and `recommendations` to the shared exclusion policy;
  that policy continues to be supplied to every browser evaluation and to the
  Node serialization boundary.
- Added a real jsdom browser-function regression fixture covering class, id,
  `data-*`, and `aria-*` ancestry, including plain and camel-case variants. It
  also proves an adjacent legitimate detail text/image pair remains present.
- RED: the new fixture failed with all four recommendation subtrees serialized.
- GREEN: `node --test taobao-detail-adapter.test.js detail-url.test.js` — 17
  passed, 0 failed.
