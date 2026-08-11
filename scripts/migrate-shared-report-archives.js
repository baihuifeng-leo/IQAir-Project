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

function clearMismatchedArchiveNews(report, weekStart) {
  const repaired = clone(report || {});
  for (const archive of repaired.archives || []) {
    if (archive?.weekStart !== weekStart) continue;
    for (const version of archive.versions || []) {
      const news = version?.snapshot?.news;
      if (news && typeof news === 'object' && news.weekStart !== weekStart) version.snapshot.news = null;
    }
  }
  return repaired;
}

function replaceArchiveNews(report, weekStart, news) {
  const repaired = clone(report || {});
  const archive = (repaired.archives || []).find((item) => item?.weekStart === weekStart);
  if (!archive) throw new Error(`找不到 ${weekStart} 周报档案`);
  if (!news || typeof news !== 'object' || !Array.isArray(news?.pages?.global) || news.pages.global.length !== 2) throw new Error('来源新闻必须包含两条全屏稿');
  const snapshotNews = { ...clone(news), weekStart };
  for (const version of archive.versions || []) {
    if (!version?.snapshot) continue;
    version.snapshot.news = clone(snapshotNews);
  }
  return repaired;
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

function clearMismatchedNews(targetFile, weekStart) {
  const target = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
  const repaired = clearMismatchedArchiveNews(target, weekStart);
  const changed = JSON.stringify(target) !== JSON.stringify(repaired);
  if (!changed) return { backup: null, weekStart, changed: false };
  const backup = backupName(targetFile, 'archive-news-repair');
  if (!fs.existsSync(backup)) fs.copyFileSync(targetFile, backup, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(targetFile, JSON.stringify(repaired, null, 1));
  return { backup, weekStart, changed: true };
}

function restoreArchiveNews(targetFile, weekStart, sourceFile, sourceWeek) {
  const target = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
  const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  const news = source?.weeks?.[sourceWeek];
  const repaired = replaceArchiveNews(target, weekStart, news);
  const backup = backupName(targetFile, 'archive-news-restore');
  if (!fs.existsSync(backup)) fs.copyFileSync(targetFile, backup, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(targetFile, JSON.stringify(repaired, null, 1));
  return { backup, weekStart, sourceWeek, titles: news.pages.global.map((item) => item.title) };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--freeze-legacy-masters') {
    const targetFile = path.resolve(args[1] || '');
    if (!args[1]) { console.error('用法：node scripts/migrate-shared-report-archives.js --freeze-legacy-masters <共享档案文件>'); process.exitCode = 1; }
    else { try { console.log(JSON.stringify(freeze(targetFile))); } catch (error) { console.error(error.message); process.exitCode = 1; } }
  } else if (args[0] === '--clear-mismatched-news') {
    const weekStart = args[1]; const targetFile = path.resolve(args[2] || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart || '') || !args[2]) { console.error('用法：node scripts/migrate-shared-report-archives.js --clear-mismatched-news <周一日期> <共享档案文件>'); process.exitCode = 1; }
    else { try { console.log(JSON.stringify(clearMismatchedNews(targetFile, weekStart))); } catch (error) { console.error(error.message); process.exitCode = 1; } }
  } else if (args[0] === '--restore-archive-news') {
    const [weekStart, sourceFileInput, sourceWeek, targetFileInput] = args.slice(1);
    const sourceFile = path.resolve(sourceFileInput || ''); const targetFile = path.resolve(targetFileInput || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart || '') || !/^\d{4}-\d{2}-\d{2}$/.test(sourceWeek || '') || !sourceFileInput || !targetFileInput) { console.error('用法：node scripts/migrate-shared-report-archives.js --restore-archive-news <归档周一日期> <新闻备份文件> <新闻来源周一日期> <共享档案文件>'); process.exitCode = 1; }
    else { try { console.log(JSON.stringify(restoreArchiveNews(targetFile, weekStart, sourceFile, sourceWeek))); } catch (error) { console.error(error.message); process.exitCode = 1; } }
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

module.exports = { mergeArchives, backupName, freezeLegacyMasters, clearMismatchedArchiveNews, replaceArchiveNews, migrate, freeze, clearMismatchedNews, restoreArchiveNews };
