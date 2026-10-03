// Real GPT-Live call with a given session shape; plays a WAV as the mic and dumps every
// data-channel event type (and function-call / delegation payloads). Read-only probe.
import { chromium } from "playwright";
import path from "node:path";
import { resolveOAuth, LIVE_URL } from "../src/codex.mjs";

const [, , shapeJson, wavArg, secsArg, sendJson, urlArg] = process.argv;
const SEND = JSON.parse((sendJson || "[]").replace('"__TOOL__"', JSON.stringify({ type: "function", name: "read_room", description: "Read the latest messages of a Discord room by its spoken name.", parameters: { type: "object", properties: { room: { type: "string" } }, required: ["room"] } })));
const URL_ = urlArg || null;
const tool = { type: "function", name: "read_room", description: "Read the latest messages of a Discord room by its spoken name.", parameters: { type: "object", properties: { room: { type: "string" } }, required: ["room"] } };
const extra = JSON.parse((shapeJson || "{}").replace('"__TOOL__"', JSON.stringify(tool)));
const wav = path.resolve(wavArg || ".local/q.wav");
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true,
  args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${wav}%noloop`] });
const page = await (await browser.newContext({ permissions: ["microphone"] })).newPage();
await page.goto("http://127.0.0.1:3077/");
const auth = await resolveOAuth();
await page.exposeFunction("answer", async (sdp) => {
  const session = { model: "gpt-live-1-codex", instructions: "You help the user with his Discord. Use your tools to answer.", audio: { output: { voice: "cove" } }, ...extra };
  const r = await fetch(URL_ || LIVE_URL, { method: "POST", redirect: "manual", headers: { Authorization: `Bearer ${auth.token}`, "ChatGPT-Account-Id": auth.accountId, "OpenAI-Alpha": "quicksilver=v2", "Content-Type": "application/json" }, body: JSON.stringify({ sdp, session }) });
  return { status: r.status, sdp: await r.text() };
});
const events = await page.evaluate(async ([secs, SEND]) => {
  const out = [];
  const pc = new RTCPeerConnection();
  const s = await navigator.mediaDevices.getUserMedia({ audio: true });
  s.getTracks().forEach((t) => pc.addTrack(t, s));
  const dc = pc.createDataChannel("oai-events");
  dc.onmessage = (e) => { try { out.push(JSON.parse(e.data)); } catch {} };
  await pc.setLocalDescription(await pc.createOffer());
  const a = await window.answer(pc.localDescription.sdp);
  if (a.status !== 201) return [{ type: "http", status: a.status, body: a.sdp.slice(0, 300) }];
  await pc.setRemoteDescription({ type: "answer", sdp: a.sdp });
  await new Promise((r) => { const t = setInterval(() => { if (dc.readyState === "open") { clearInterval(t); r(); } }, 50); });
  for (const m of SEND) dc.send(JSON.stringify(m));
  await new Promise((r) => setTimeout(r, secs * 1000));
  pc.close();
  return out;
}, [Number(secsArg || 25), SEND]);
await browser.close();
const counts = {};
for (const e of events) counts[e.type] = (counts[e.type] || 0) + 1;
console.log(JSON.stringify(counts));
for (const e of events) {
  if (/delegation|function|tool|error|session\.|response\./.test(e.type))
    console.log(e.type, JSON.stringify(e).slice(0, 600));
  if (e.type === "turn.done") console.log("turn.done", e.turn?.role, (e.turn?.transcript || "").slice(0, 160));
}
