#!/usr/bin/env python3
"""
素材质检 OCR 常驻子进程：PaddleOCR 加载模型要 1-30 秒，不能像 tesseract 那样
每张图现起一个进程，所以这个脚本常驻后台，Node 那边（materialcheck-ocr.js）
通过 stdin/stdout 按行传 JSON 跟它通信，一个连接只加载一次模型。

协议：
  stdin  每行一个 JSON：{"id": <请求编号>, "path": "<图片绝对路径>"}
  stdout 每行一个 JSON：
    成功 {"id": <编号>, "ok": true, "lines": [{"text": "...", "score": 0.95}, ...]}
    失败 {"id": <编号>, "ok": false, "error": "..."}
  启动完成（模型加载好，可以开始收请求）打一行 {"ready": true}

MKLDNN（oneDNN 加速）在这台机器装的 PaddlePaddle 版本上跟某些算子的组合会直接报错
（ConvertPirAttribute2RuntimeAttribute not support），关掉换纯 CPU 路径，实测没有
明显变慢。文档方向分类/展平/文本行方向这三个子流程是给扫描件矫正用的，电商海报
用不上，关掉能省一点耗时。
"""
import sys
import os
import json

os.environ.setdefault('FLAGS_use_mkldnn', 'false')

from paddleocr import PaddleOCR  # noqa: E402

def main():
    ocr = PaddleOCR(
        lang='ch', ocr_version='PP-OCRv4', enable_mkldnn=False,
        use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False
    )
    print(json.dumps({'ready': True}), flush=True)

    # install.sh 用 --warmup 跑一次，只为了触发模型下载+加载，加载完就退出，
    # 不用等 stdin，这样装机的时候就能把模型下好，不用等第一次真实检测时才下载。
    if '--warmup' in sys.argv:
        return

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue

        req_id = req.get('id')
        path = req.get('path')
        try:
            results = ocr.predict(path)
            out_lines = []
            for res in results:
                texts = res.get('rec_texts', [])
                scores = res.get('rec_scores', [])
                for text, score in zip(texts, scores):
                    out_lines.append({'text': text, 'score': round(float(score), 4)})
            print(json.dumps({'id': req_id, 'ok': True, 'lines': out_lines}), flush=True)
        except Exception as e:
            print(json.dumps({'id': req_id, 'ok': False, 'error': str(e)}), flush=True)

if __name__ == '__main__':
    main()
