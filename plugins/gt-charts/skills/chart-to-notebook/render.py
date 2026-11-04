"""Install the gt-charts version the notebook targets: it pins the gt-embed
bundle the charts load, the same one they load in Databricks."""

import argparse
import asyncio
import functools
import http.server
import os
import re
import subprocess
import sys
import tarfile
import tempfile
import threading
from pathlib import Path

import gt_charts as gt
from gt_charts.config import bundle_url
from gt_charts.html import build_notebook_document


class _CORSHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, *args):
        pass


def serve_npm_bundle() -> str:
    match = re.search(r"gt-embed@([^/]+)", bundle_url())
    if not match:
        sys.exit(f"cannot read a gt-embed version from bundle URL {bundle_url()}")
    tmp = Path(tempfile.mkdtemp())
    packed = subprocess.run(
        ["npm", "pack", f"gt-embed@{match[1]}", "--silent"],
        cwd=tmp,
        check=True,
        capture_output=True,
        text=True,
    )
    with tarfile.open(tmp / packed.stdout.split()[-1]) as tar:
        tar.extractall(tmp, filter="data")
    handler = functools.partial(_CORSHandler, directory=tmp / "package")
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{server.server_port}"


def capture_documents(notebook: Path) -> list[str]:
    docs = []
    gt.Chart.show = lambda chart: docs.append(build_notebook_document(chart))
    exec(compile(notebook.read_text(), str(notebook), "exec"), {"__name__": "__main__"})
    return docs


async def screenshot(docs, out_dir: Path, stem: str, chromium: str | None) -> list[str]:
    from playwright.async_api import async_playwright

    problems = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chromium)
        for n, doc in enumerate(docs, 1):
            page = await browser.new_page(viewport={"width": 1200, "height": 900})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            await page.set_content(doc, wait_until="networkidle")
            await page.wait_for_timeout(1500)
            path = out_dir / f"{stem}-{n}.png"
            await page.screenshot(path=path, full_page=True)
            if not await page.locator("section canvas, section svg").count():
                errors.append("the embed rendered nothing (bundle not loaded?)")
            if errors:
                problems.append(f"chart {n} failed, screenshot {path}: {errors[0]}")
            else:
                print(path)
        await browser.close()
    return problems


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("notebook", type=Path)
    parser.add_argument("--out-dir", type=Path, default=Path("."))
    parser.add_argument("--local-bundle", action="store_true")
    parser.add_argument("--chromium")
    args = parser.parse_args()

    if args.local_bundle:
        os.environ["GT_CHARTS_BUNDLE_URL"] = serve_npm_bundle()
    docs = capture_documents(args.notebook)
    if not docs:
        sys.exit("the notebook shows no chart; end each chart with .show()")
    args.out_dir.mkdir(parents=True, exist_ok=True)
    problems = asyncio.run(
        screenshot(docs, args.out_dir, args.notebook.stem, args.chromium)
    )
    if problems:
        sys.exit("\n".join(problems))


if __name__ == "__main__":
    main()
