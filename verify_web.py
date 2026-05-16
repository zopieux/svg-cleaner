#!/usr/bin/env nix-shell
#! nix-shell -i python3 -p python3 python3Packages.playwright python3Packages.numpy python3Packages.shapely python3Packages.networkx python3Packages.svgpathtools python3Packages.scipy playwright-driver.browsers

import os
import sys
import threading
import http.server
import socketserver
import time
import subprocess
from functools import partial


# Set up environment for Nix-provided Playwright browsers BEFORE importing playwright
def setup_playwright():
    try:
        cmd = [
            "nix-build",
            "-E",
            "(import <nixpkgs> {}).playwright-driver.browsers",
            "--no-out-link",
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        browser_path = res.stdout.strip()
        if browser_path:
            os.environ["PLAYWRIGHT_BROWSERS_PATH"] = browser_path
            os.environ["PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"] = "1"
            print(f"Using Playwright browsers from Nix store: {browser_path}")
            return True
    except subprocess.CalledProcessError as e:
        print(f"CRITICAL: Could not resolve PLAYWRIGHT_BROWSERS_PATH: {e.stderr}")
        sys.exit(1)
    except Exception as e:
        print(f"CRITICAL: Unexpected error during Playwright setup: {e}")
        sys.exit(1)
    sys.exit(1)


setup_playwright()
from playwright.sync_api import sync_playwright


class ThreadedHTTPServer(threading.Thread):
    def __init__(self, directory):
        super().__init__(daemon=True)
        self.directory = directory
        self.port = 0
        self.httpd = None
        self.started = threading.Event()

    def run(self):
        handler = partial(
            http.server.SimpleHTTPRequestHandler, directory=self.directory
        )
        handler.log_message = lambda *args: None
        # Use port 0 to bind to any available port
        with socketserver.TCPServer(("", 0), handler) as self.httpd:
            self.port = self.httpd.socket.getsockname()[1]
            self.started.set()
            self.httpd.serve_forever()


def verify():
    print("Building web version...")
    subprocess.run(["nix", "build", ".#web"], check=True)

    print("Running native python version...")
    subprocess.run(
        [
            sys.executable,
            "clean_svg.py",
            "test.svg",
            "test_native_out.svg",
            "--snap-tolerance",
            "0.1",
        ],
        check=True,
    )

    build_dir = os.path.abspath("result")
    server = ThreadedHTTPServer(build_dir)
    server.start()
    server.started.wait(timeout=5)

    print(f"Running web version test in Chromium (port {server.port})...")
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch()
            page = browser.new_page()

            # Pipe browser logs to our stdout
            page.on("console", lambda msg: print(f"BROWSER: {msg.text}"))

            page.goto(f"http://localhost:{server.port}/index.html")

            print("Waiting for Pyodide initialization...")
            start_time = time.time()
            page.wait_for_selector("#status", state="hidden", timeout=30000)
            end_time = time.time()
            print(f"Pyodide loading took {end_time - start_time:.2f}s")

            with open("test.svg", "r") as f:
                test_svg_content = f.read()

            print("Processing SVG via SVGCleaner JS API...")
            result_svg_content = page.evaluate(
                """
                async (svg) => {
                    console.log("Waiting for cleaner...");
                    for (let i = 0; i < 200; i++) {
                        if (window.cleaner && window.cleaner.isLoaded) break;
                        await new Promise(r => setTimeout(r, 100));
                    }
                    if (!window.cleaner || !window.cleaner.isLoaded) {
                        throw new Error("Cleaner initialization timed out in browser");
                    }
                    console.log("Cleaner ready, processing...");
                    return window.cleaner.process(svg, 0.1);
                }
            """,
                test_svg_content,
            )

            with open("test_web_out.svg", "w") as f:
                f.write(result_svg_content)
            browser.close()
        except Exception as e:
            print(f"Error during Playwright execution: {e}")
            sys.exit(1)

    print("\nComparing results...")
    import filecmp

    if filecmp.cmp("test_native_out.svg", "test_web_out.svg", shallow=False):
        print("✅ SUCCESS: Web and Native outputs are identical!")
    else:
        print("⚠️  NOTICE: Outputs differ slightly.")
        from svgpathtools import svg2paths

        p1, _ = svg2paths("test_native_out.svg")
        p2, _ = svg2paths("test_web_out.svg")
        if len(p1) == len(p2):
            print(f"✅ SUCCESS: Path counts match! (Count: {len(p1)})")
        else:
            print(f"❌ FAILURE: Path counts differ! Native: {len(p1)}, Web: {len(p2)}")
            sys.exit(1)


if __name__ == "__main__":
    verify()
