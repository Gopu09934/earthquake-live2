/**
 * Launches Chromium as a real (non-headless) window on the Xvfb virtual
 * display so ffmpeg's x11grab can capture exactly what a viewer would
 * see in a normal browser tab. Kiosk mode removes all browser chrome
 * (address bar, tabs) so the captured frame is just the dashboard.
 *
 * This process is expected to run forever — start.sh runs ffmpeg
 * alongside it and kills both together when the stream stops.
 */

const puppeteer = require("puppeteer");

const WIDTH = parseInt(process.argv[2] || "1280", 10);
const HEIGHT = parseInt(process.argv[3] || "720", 10);
const URL = process.env.DASHBOARD_URL || "http://localhost:8080/index.html";

async function gotoWithRetry(page, attempts = 15) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 15000 });
      console.log(`[render] Dashboard loaded on attempt ${i}.`);
      return;
    } catch (err) {
      console.log(`[render] Load attempt ${i}/${attempts} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error("Could not load the dashboard after repeated retries.");
}

async function main() {
  console.log(`[render] Launching Chromium at ${WIDTH}x${HEIGHT} -> ${URL}`);

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: [
      "--kiosk",
      `--window-size=${WIDTH},${HEIGHT}`,
      "--window-position=0,0",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-infobars",
      "--disable-session-crashed-bubble",
      "--noerrdialogs",
      "--autoplay-policy=no-user-gesture-required",
      "--force-device-scale-factor=1",
    ],
  });

  browser.on("disconnected", () => {
    console.error("[render] Chromium disconnected/crashed — exiting so the stream can restart.");
    process.exit(1);
  });

  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());
  await page.setViewport({ width: WIDTH, height: HEIGHT });

  page.on("console", (msg) => console.log("[page]", msg.text()));
  page.on("pageerror", (err) => console.error("[page error]", err.message));

  await gotoWithRetry(page);

  // Keep the process alive indefinitely — ffmpeg captures this window
  // from the outside via x11grab; there's nothing more for Node to do.
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("[render] Fatal:", err);
  process.exit(1);
});
