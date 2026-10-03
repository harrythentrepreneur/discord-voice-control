// REAL end-to-end voice check: synthetic spoken question -> GPT-Live (ChatGPT login)
// -> delegation -> ChatGPT brain -> live Discord read -> spoken answer. Read-only.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const base = process.env.URL || "http://127.0.0.1:3077";
const wav = path.resolve(process.argv[2] || ".local/q.wav");
const code = fs.readFileSync(".local/access-code", "utf8").trim();
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  headless: true,
  args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-audio-capture=${wav}%noloop`, "--autoplay-policy=no-user-gesture-required"],
});
const out = { at: new Date().toISOString(), synthetic: true };
try {
  const ctx = await browser.newContext({ permissions: ["microphone"] });
  const page = await ctx.newPage();
  const events = [];
  page.on("response", (r) => { if (r.url().includes("/api/")) events.push(`${r.url().split("/api/")[1]} ${r.status()}`); });
  await page.goto(base);
  await page.fill("#code", code);
  await page.click("#login button");
  await page.waitForSelector("#talk");
  await page.click("#talk");
  await page.waitForFunction(() => /Listening|Heard/.test(document.querySelector("#status").textContent), null, { timeout: 30000 });
  out.connected = true;
  await page.waitForFunction((n) => document.querySelectorAll("#log li.reply").length >= n, Number(process.env.REPLIES || 1), { timeout: 90000 });
  out.log = await page.$$eval("#log li", (l) => l.map((x) => `${x.className}: ${x.textContent}`).reverse());
  await page.waitForTimeout(Number(process.env.TAIL || 25000));
  out.assistantSpeech = await page.evaluate(() => (window.__said || []).map(([t, txt, muted]) => `${muted ? "MUTED " : "heard "}${txt}`));
  out.routes = [...new Set(events)];
  await page.click("#talk");
} catch (e) {
  out.error = e.message.split("\n")[0];
} finally {
  await browser.close();
}
console.log(JSON.stringify(out, null, 1));
