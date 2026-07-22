'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_PSMS = ['3', '6', '11'];

/**
 * 放大2倍+灰度+锐化+对比度增强，写到系统临时目录的一个新文件，返回路径。
 * 调用方负责用完后删除返回的临时文件。
 */
function preprocessImage(imagePath, { exec = execFile } = {}) {
  const outPath = path.join(os.tmpdir(), 'mc-pre-' + crypto.randomBytes(6).toString('hex') + '.png');
  return new Promise((resolve, reject) => {
    exec('convert', [
      imagePath, '-resize', '200%', '-colorspace', 'Gray', '-sharpen', '0x1', '-contrast-stretch', '1%x1%', outPath
    ], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error('图片预处理失败：' + (stderr || err.message || '未知错误')));
      resolve(outPath);
    });
  });
}

function runOnce(imagePath, lang, psm, exec) {
  return new Promise((resolve, reject) => {
    exec('tesseract', [imagePath, 'stdout', '-l', lang, '--psm', psm], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error('OCR 识别失败：' + (stderr || err.message || '未知错误')));
      resolve(String(stdout || '').trim());
    });
  });
}

/**
 * 调用系统级 tesseract 二进制识别图片文字。
 * 先做一次放大/灰度/锐化/对比度增强的预处理（失败则退回用原图，不阻断识别），
 * 再用多个 PSM（版面分割模式）分别跑一遍取并集——电商海报是拼贴式版面，不同 PSM
 * 各有识别盲区（比如默认的 PSM 3 常把大标题连同旁边产品图一起判成图片区域跳过，
 * 换 PSM 反而漏别的区域），取并集互补。关键词匹配是无序子串比对，并集只会让命中
 * 变多不会引入误判，多个 PSM 之间只要有一个成功即可，不要求全部成功。
 * exec 可注入桩函数用于测试，默认用真实的 child_process.execFile。
 */
async function runOcr(imagePath, { exec = execFile, lang = 'chi_sim+eng', psms = DEFAULT_PSMS } = {}) {
  let target = imagePath;
  let tempFile = null;
  try {
    tempFile = await preprocessImage(imagePath, { exec });
    target = tempFile;
  } catch { /* 预处理失败不阻断识别，退回用原图 */ }

  try {
    const results = await Promise.allSettled(psms.map((psm) => runOnce(target, lang, psm, exec)));
    const texts = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (texts.length === 0) throw results[0].reason;
    return texts.join('\n');
  } finally {
    if (tempFile) fs.promises.unlink(tempFile).catch(() => {});
  }
}

/**
 * 服务启动时探测 tesseract / ImageMagick 是否可用。tesseract 缺失只打日志警告，
 * 不阻断服务启动（跟原来行为一致）；ImageMagick 缺失同样只警告——预处理本来就有
 * 优雅降级，缺了顶多是识别效果打折，不是硬依赖。
 */
async function checkAvailable({ exec = execFile } = {}) {
  const probe = (cmd, args) => new Promise((resolve) => {
    exec(cmd, args, { maxBuffer: 1024 * 1024 }, (err) => resolve(!err));
  });

  const hasTesseract = await probe('tesseract', ['--version']);
  if (!hasTesseract) {
    console.warn('[materialcheck] 没有检测到 tesseract 二进制，素材检测功能会失败。跑一遍 install.sh，或手动 apt-get install tesseract-ocr tesseract-ocr-chi-sim');
  }

  const hasConvert = await probe('convert', ['-version']);
  if (!hasConvert) {
    console.warn('[materialcheck] 没有检测到 ImageMagick（convert 命令），识别前的放大/增强预处理会跳过，识别率会打折。跑一遍 install.sh，或手动 apt-get install imagemagick');
  }

  return hasTesseract;
}

module.exports = { runOcr, checkAvailable, preprocessImage };
