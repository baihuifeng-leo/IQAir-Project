'use strict';

const fs = require('fs');
const path = require('path');

const clone = (value) => JSON.parse(JSON.stringify(value));

function mergeArchives(target, source) {
  const merged = clone(target || {});
  merged.archives = Array.isArray(merged.archives) ? merged.archives : [];
  const incoming = Array.isArray(source?.archives) ? source.archives : [];
  for (const archive of incoming) {
    if (!archive?.weekStart || !Array.isArray(archive.versions)) continue;
    const existing = merged.archives.find((item) => item.weekStart === archive.weekStart);
    if (!existing) { merged.archives.push(clone(archive)); continue; }
    existing.versions = Array.isArray(existing.versions) ? existing.versions : [];
    const known = new Set(existing.versions.map((version) => version?.id).filter(Boolean));
    for (const version of archive.versions) {
      if (version?.id && !known.has(version.id)) { existing.versions.push(clone(version)); known.add(version.id); }
    }
  }
  merged.archives.sort((a, b) => String(a.weekStart).localeCompare(String(b.weekStart)));
  return merged;
}

function backupName(targetFile, kind = 'shared-archive', now = new Date()) {
  const date = now.toISOString().slice(0, 10);
  return `${targetFile}.${date}.${kind}-backup.json`;
}

function freezeLegacyMasters(report) {
  const frozen = clone(report || {});
  for (const archive of frozen.archives || []) {
    for (const version of archive?.versions || []) {
      const snapshotReport = version?.snapshot?.report;
      if (snapshotReport && snapshotReport.slideMasterVersion === undefined) snapshotReport.slideMasterVersion = 0;
    }
  }
  return frozen;
}

function migrate(targetFile, sourceFile) {
  const target = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
  const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  const backup = backupName(targetFile);
  if (!fs.existsSync(backup)) fs.copyFileSync(targetFile, backup, fs.constants.COPYFILE_EXCL);
  const merged = mergeArchives(target, source);
  fs.writeFileSync(targetFile, JSON.stringify(merged, null, 1));
  return { backup, archives: merged.archives.map((archive) => archive.weekStart) };
}

function freeze(targetFile) {
  const target = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
  const backup = backupName(targetFile, 'legacy-master-freeze');
  if (!fs.existsSync(backup)) fs.copyFileSync(targetFile, backup, fs.constants.COPYFILE_EXCL);
  const frozen = freezeLegacyMasters(target);
  fs.writeFileSync(targetFile, JSON.stringify(frozen, null, 1));
  return { backup, archives: (frozen.archives || []).map((archive) => archive.weekStart) };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--freeze-legacy-masters') {
    const targetFile = path.resolve(args[1] || '');
    if (!args[1]) { console.error('用法：node scripts/migrate-shared-report-archives.js --freeze-legacy-masters <共享档案文件>'); process.exitCode = 1; }
    else { try { console.log(JSON.stringify(freeze(targetFile))); } catch (error) { console.error(error.message); process.exitCode = 1; } }
  } else {
    const [targetFile, sourceFile] = args.map((file) => path.resolve(file || ''));
    if (!targetFile || !sourceFile) {
      console.error('用法：node scripts/migrate-shared-report-archives.js <共享档案文件> <旧账户档案文件>');
      process.exitCode = 1;
    } else {
      try { console.log(JSON.stringify(migrate(targetFile, sourceFile))); }
      catch (error) { console.error(error.message); process.exitCode = 1; }
    }
  }
}

module.exports = { mergeArchives, backupName, freezeLegacyMasters, migrate, freeze };
