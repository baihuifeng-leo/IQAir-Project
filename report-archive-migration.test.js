'use strict';
const assert = require('assert');
const { mergeArchives, freezeLegacyMasters } = require('./scripts/migrate-shared-report-archives.js');

const source = {
  archives: [{
    weekStart: '2026-07-27', officialVersionId: 'v1',
    versions: [{ id: 'v1', number: 1, snapshot: { report: { slides: [{ id: 'legacy-slide' }] } } }]
  }]
};
const target = {
  archives: [{
    weekStart: '2026-08-03', officialVersionId: 'v2',
    versions: [{ id: 'v2', number: 1, snapshot: { report: { slides: [{ id: 'current-slide' }] } } }]
  }],
  daily: [{ date: '2026-08-10' }], weimeng: [{ weekStart: '2026-08-10' }], slides: []
};

const merged = mergeArchives(target, source);
assert.deepEqual(merged.archives.map((item) => item.weekStart), ['2026-07-27', '2026-08-03']);
assert.equal(merged.daily.length, 1, '迁移不能覆盖共享工作区日数据');
assert.equal(merged.weimeng.length, 1, '迁移不能覆盖共享工作区微盟数据');
assert.equal(merged.archives[0].versions[0].snapshot.report.slides[0].id, 'legacy-slide');

const repeated = mergeArchives(merged, source);
assert.equal(repeated.archives[0].versions.length, 1, '重复迁移不得产生重复版本');

const overlapping = mergeArchives(
  { archives: [{ weekStart: '2026-07-27', officialVersionId: 'v-current', versions: [{ id: 'v-current', number: 2 }] }] },
  { archives: [{ weekStart: '2026-07-27', officialVersionId: 'v-legacy', versions: [{ id: 'v-legacy', number: 1 }] }] }
);
assert.equal(overlapping.archives[0].officialVersionId, 'v-current', '合并旧版本不能改变现有正式版');
assert.deepEqual(overlapping.archives[0].versions.map((item) => item.id), ['v-current', 'v-legacy']);

const frozen = freezeLegacyMasters({ archives: [{ versions: [{ snapshot: { report: { slides: [{ id: 'page' }] } } }] }] });
assert.equal(frozen.archives[0].versions[0].snapshot.report.slideMasterVersion, 0, '旧档案必须显式冻结为无母版');
assert.deepEqual(frozen.archives[0].versions[0].snapshot.report.slides, [{ id: 'page' }], '冻结母版不能改变归档页面元素');
assert.equal(freezeLegacyMasters({ archives: [{ versions: [{ snapshot: { report: { slideMasterVersion: 1 } } }] }] }).archives[0].versions[0].snapshot.report.slideMasterVersion, 1, '已有母版版本不能被迁移覆盖');

console.log('✓ shared report archive migration is idempotent and preserves the live workspace');
