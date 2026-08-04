#!/usr/bin/env python3
"""浏览器级回归：PDF 导出必须脱离工作台主题，并保留清晰的 canvas 图表。"""

import os
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parent


def unused_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_for_server(url):
    for _ in range(100):
        try:
            with urllib.request.urlopen(url, timeout=0.5) as response:
                if response.status == 200:
                    return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError("测试服务器未能启动")


def main():
    port = unused_port()
    with tempfile.TemporaryDirectory(prefix="workbench-pdf-qa-") as data_dir:
        env = {**os.environ, "PORT": str(port), "DATA_DIR": data_dir}
        server = subprocess.Popen(["node", "server.js"], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            wait_for_server(f"http://127.0.0.1:{port}/api/health")
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                context = browser.new_context(viewport={"width": 1440, "height": 1000})
                context.add_init_script("window.print = () => { document.body.dataset.printReady = 'true'; };")
                page = context.new_page()
                page.goto(f"http://127.0.0.1:{port}/login")
                page.get_by_label("用户名").fill("admin")
                page.get_by_label("PIN").fill("123456")
                page.get_by_role("button", name="登录").click()
                page.get_by_role("tab", name="报告管理").click()

                # 注入高分辨率 canvas，确保导出时走 PNG 替换链路而不是截屏或 CSS 缩放。
                page.evaluate("""() => {
                  const host = document.querySelector('#rpt-trend-chart');
                  host.hidden = false;
                  const canvas = document.createElement('canvas');
                  canvas.width = 1600; canvas.height = 500;
                  const ctx = canvas.getContext('2d');
                  ctx.fillStyle = '#10243a'; ctx.fillRect(0, 0, canvas.width, canvas.height);
                  ctx.strokeStyle = '#45e0b1'; ctx.lineWidth = 16; ctx.beginPath();
                  ctx.moveTo(40, 420); ctx.lineTo(480, 230); ctx.lineTo(920, 300); ctx.lineTo(1560, 75); ctx.stroke();
                  host.replaceChildren(canvas);
                }""")

                for theme in ("dark", "light"):
                    page.evaluate("theme => document.documentElement.dataset.theme = theme", theme)
                    with page.expect_popup() as popup_info:
                        page.locator("#rpt-export-pdf-btn").click()
                    popup = popup_info.value
                    popup.wait_for_load_state("load")
                    popup.locator("body[data-print-ready='true']").wait_for()
                    assert popup.locator(".pdf-page").count() == 3, f"{theme} 模式下导出页数不正确"
                    assert popup.locator("#workspace").count() == 0, f"{theme} 模式下错误复用了工作台"
                    assert popup.locator(".rpt-pdf-chart-image").count() >= 1, f"{theme} 模式下 canvas 未转成原始 PNG"
                    assert popup.locator(".rpt-pdf-chart-image").evaluate_all("images => images.every(image => image.naturalWidth >= 1600 && image.naturalHeight >= 500)"), f"{theme} 模式下导出图表为空或分辨率不足"
                    expected_background = "rgb(8, 12, 20)" if theme == "dark" else "rgb(238, 241, 247)"
                    assert popup.locator("html").get_attribute("data-theme") == theme, f"{theme} 模式未传入独立导出文档"
                    assert popup.locator("body").evaluate("body => getComputedStyle(body).backgroundColor") == expected_background, f"{theme} 模式下导出主题不正确"
                    assert popup.locator(".pdf-page").evaluate_all("pages => pages.every(page => { const box = page.getBoundingClientRect(); return Math.abs(box.width - 1280) < 1 && Math.abs(box.height - 720) < 1; })"), f"{theme} 模式下页面画布尺寸不一致"
                    assert popup.locator(".pdf-page").evaluate_all("pages => pages.every(page => [...page.children].every(child => child.getBoundingClientRect().bottom <= page.getBoundingClientRect().bottom + 1))"), f"{theme} 模式下固定报告页仍有内容被裁切"
                    popup.close()
                browser.close()
            print("✓ PDF export browser regression passed in dark and light themes")
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()


if __name__ == "__main__":
    main()
