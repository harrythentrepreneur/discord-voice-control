// Probe which session shapes the ChatGPT-subscription GPT-Live route accepts, using a REAL
// browser SDP offer (fake mic). Prints the HTTP status + error for each candidate.
import { chromium } from "playwright";
import { resolveOAuth, LIVE_URL } from "../src/codex.mjs";

const tool = { type: "function", name: "read_room", description: "Read a Discord room", parameters: { type: "object", properties: { room: { type: "string" } }, required: ["room"] } };
const candidates = JSON.parse(process.argv[2] || "{}");
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true, args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const page = await (await browser.newContext({ permissions: ["microphone"] })).newPage();
await page.goto("http://127.0.0.1:3077/");
const auth = await resolveOAuth();
for (const [name, extra] of Object.entries(candidates)) {
  const sdp = await page.evaluate(async () => {
    const pc = new RTCPeerConnection();
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => pc.addTrack(t, s));
    pc.createDataChannel("oai-events");
    await pc.setLocalDescription(await pc.createOffer());
    window.__pc = pc;
    return pc.localDescription.sdp;
  });
  const session = { model: "gpt-live-1-codex", instructions: "Test.", audio: { output: { voice: "cove" } }, ...JSON.parse(JSON.stringify(extra).replace('"__TOOL__"', JSON.stringify(tool))) };
  const r = await fetch(LIVE_URL, { method: "POST", redirect: "manual", headers: { Authorization: `Bearer ${auth.token}`, "ChatGPT-Account-Id": auth.accountId, "OpenAI-Alpha": "quicksilver=v2", "Content-Type": "application/json" }, body: JSON.stringify({ sdp, session }) });
  const body = await r.text();
  console.log(name, r.status, r.ok ? "ACCEPTED" : body.replace(/\s+/g, " ").slice(0, 400));
  await page.evaluate(() => window.__pc?.close());
}
await browser.close();
