'use strict';

const { execFile } = require('child_process');

/**
 * 调用系统级 tesseract 二进制识别图片文字。
 * exec 可注入桩函数用于测试，默认用真实的 child_process.execFile。
 */
function runOcr(imagePath, { exec = execFile, lang = 'chi_sim+eng', psm = '11' } = {}) {
  return new Promise((resolve, reject) => {
    // PSM 11（稀疏文本，不假设有序版面）：电商海报是拼贴式版面，不是规整文档，
    // 默认的 PSM 3 整页版式分析会把标题文字连同旁边的产品图一起判成"图片区域"整段跳过。
    // 关键词匹配是无序子串比对，PSM 11 打乱阅读顺序换来更全的文字覆盖，没有副作用。
    exec('tesseract', [imagePath, 'stdout', '-l', lang, '--psm', psm], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error('OCR 识别失败：' + (stderr || err.message || '未知错误')));
      resolve(String(stdout || '').trim());
    });
  });
}

/**
 * 服务启动时探测 tesseract 是否可用，不可用只打日志警告，不阻断服务启动。
 */
function checkAvailable({ exec = execFile } = {}) {
  return new Promise((resolve) => {
    exec('tesseract', ['--version'], { maxBuffer: 1024 * 1024 }, (err) => {
      if (err) {
        console.warn('[materialcheck] 没有检测到 tesseract 二进制，素材检测功能会失败。跑一遍 install.sh，或手动 apt-get install tesseract-ocr tesseract-ocr-chi-sim');
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

module.exports = { runOcr, checkAvailable };
