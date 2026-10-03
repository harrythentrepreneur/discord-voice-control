// Local server: static page + GPT-Live offer + event relay + confirm.
// Binds loopback by default. Every /api call needs the local access code.
import "./env.mjs"; // must be first: loads .env before other modules read process.env
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createLiveCall } from "./codex.mjs";
import { createDiscord } from "./discord.mjs";
import { createBrain } from "./brain.mjs";
import { createHermesBrain } from "./hermes-brain.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const LOCAL = path.join(ROOT, ".local");
const tailnetOwners = () => (process.env.DVC_TAILNET_OWNERS || "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);

export function chunk(text, max = 450) {
  const out = [];
  let cur = "";
  for (const ch of text) {
    if (Buffer.byteLength(cur + ch) > max) {
      out.push(cur);
      cur = "";
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// One append per answer. Splitting into several appends let GPT-Live start speaking after the
// first chunk and close the delegation, so later chunks were rejected ("Unknown delegation item
// id") and long answers were cut off mid-sentence. The vendor limit is 500 tokens per append.
export function fitForSpeech(text, max = 1400) {
  const t = String(text).replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return end > max / 2 ? cut.slice(0, end + 1) : cut + "…";
}

function speakable(delegationId, text) {
  return [fitForSpeech(text)].map((t) => ({
    type: "delegation.context.append",
    delegation_item_id: delegationId,
    channel: "speakable",
    content: [{ type: "input_text", text: t }],
  }));
}

export function accessCode() {
  fs.mkdirSync(LOCAL, { recursive: true });
  const f = path.join(LOCAL, "access-code");
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(9).toString("base64url"), { mode: 0o600 });
  return fs.readFileSync(f, "utf8").trim();
}

export function createApp({ discord = createDiscord(), brain, typedBrain, liveCall = createLiveCall, code = accessCode(), logFile = path.join(LOCAL, "calls.jsonl") } = {}) {
  const log = [];
  const push = (e) => {
    const entry = { at: new Date().toISOString(), ...e };
    log.push(entry);
    // Durable call log, one JSON line per event (rotated at ~5 MB). Read with
    // scripts/log-report.mjs. Holds the user's own words and replies, never credentials.
    if (logFile) try {
      const f = logFile;
      if (fs.existsSync(f) && fs.statSync(f).size > 5e6) fs.renameSync(f, f + ".1");
      fs.appendFileSync(f, JSON.stringify(entry) + "\n");
    } catch {}
    if (log.length > 200) log.shift();
  };
  // Default brain: the dedicated discord-voice Hermes profile. DVC_BRAIN=local keeps the old
  // in-process ChatGPT brain as a fallback.
  // Typed requests (/api/ask, tests) use a SEPARATE brain and Hermes session, so they can never
  // mix into a live voice call's context.
  const injected = !!brain;
  brain ||= process.env.DVC_BRAIN === "local"
    ? createBrain({ discord, log: (e) => push(e) })
    : createHermesBrain({ discord, log: (e) => push(e) });
  typedBrain ||= injected ? brain : process.env.DVC_BRAIN === "local"
    ? createBrain({ discord, log: (e) => push(e) })
    : createHermesBrain({ discord, log: (e) => push(e) });
  typedBrain.reset?.();

  // Answers are paired with the QUESTION they answer, never by arrival order.
  // GPT-Live tags each delegation with the user turn it belongs to (item.user_bidi_turn_id;
  // fallback: the latest user turn.created). the user's completed turn (turn.done, role user) is
  // processed once; its answer goes ONLY to a delegation of that same turn. An answer whose turn
  // has been overtaken by a newer question is dropped, never replayed later (that replay was the
  // "old answer to a new question" bug).
  // Every GPT-Live call owns its own brain session and event state. A second call (another
  // device, a test) can never reset or feed events into a call already in progress.
  const calls = new Map(); // callId -> call
  const newBrain = () => process.env.DVC_BRAIN === "local"
    ? createBrain({ discord, log: (e) => push(e) })
    : createHermesBrain({ discord, log: (e) => push(e) });
  let lastCall = null;

  function createCall(callBrain) {
  const brain = callBrain;
  const seen = new Set();
  const outbox = [];
  let chain = Promise.resolve();
  const delegsByTurn = new Map(); // turnId -> [delegation ids], newest last
  const answers = new Map();      // turnId -> answer text waiting for its delegation
  let latestTurn = null;          // newest user turn GPT-Live has opened

  function sendFor(turnId) {
    const say = answers.get(turnId);
    const ids = delegsByTurn.get(turnId);
    if (say == null || !ids?.length) return;
    outbox.push(...speakable(ids.at(-1), say));
    answers.delete(turnId);
    delegsByTurn.delete(turnId);
  }

  async function onUserTurn(turnId, said) {
    push({ type: "heard", text: said, turn: turnId });
    let r;
    try {
      r = await brain.handle(said);
    } catch (e) {
      r = { say: e.safe || "Something went wrong reaching the Discord brain. Please try again." };
    }
    push({ type: "reply", text: r.say, turn: turnId, pending: r.pending?.summary || null, action: r.action?.status || null });
    if (latestTurn && turnId !== latestTurn && !delegsByTurn.has(turnId)) {
      push({ type: "status", text: "Answer skipped: you had already asked something newer.", turn: turnId });
      return;
    }
    answers.set(turnId, r.say);
    sendFor(turnId);
  }

  function relay(events) {
    for (const e of events) {
      if (!e || typeof e !== "object") continue;
      if (process.env.DVC_TRACE) fs.appendFileSync(path.join(LOCAL, "trace.jsonl"), JSON.stringify({ t: e.type, role: e.turn?.role, id: e.turn?.id || e.item?.id || e.delegation_item_id || e.item_id, txt: (e.turn?.transcript || e.item?.text || "").slice(0, 80), raw: e.type === "error" || e.type.startsWith("delegation") ? JSON.stringify(e).slice(0, 1500) : undefined }) + "\n");
      if (e.type === "turn.created" && e.turn?.role === "user" && e.turn.id) latestTurn = e.turn.id;
      if (e.type === "turn.done" && e.turn?.role === "user" && typeof e.turn.transcript === "string") {
        const turnId = e.turn.id || `t${Date.now()}`;
        if (seen.has("t" + turnId)) continue;
        seen.add("t" + turnId);
        latestTurn = latestTurn || turnId;
        const said = e.turn.transcript.trim();
        if (said) chain = chain.then(() => onUserTurn(turnId, said));
      }
      if (e.type === "delegation.created" && e.item?.type === "delegation" && typeof e.item.id === "string") {
        if (seen.has("d" + e.item.id)) continue;
        seen.add("d" + e.item.id);
        const turnId = e.item.user_bidi_turn_id || latestTurn;
        if (!turnId) continue;
        if (!delegsByTurn.has(turnId)) delegsByTurn.set(turnId, []);
        delegsByTurn.get(turnId).push(e.item.id);
        sendFor(turnId);
      }
      if (e.type === "error" && /Unknown delegation item id/.test(e.error?.message || "")) {
        push({ type: "status", text: "Voice closed that request before the answer arrived; dropped, not replayed." });
        continue;
      }
      if (e.type === "error") push({ type: "error", text: "GPT-Live reported an error.", detail: JSON.stringify(e.error || e).slice(0, 400) });
    }
  }

  return { brain, relay, outbox, get chain() { return chain; } };
  }

  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

  async function body(req) {
    let raw = "";
    for await (const c of req) {
      raw += c;
      if (raw.length > 1e6) throw new Error("too large");
    }
    return raw ? JSON.parse(raw) : {};
  }

  function authed(req) {
    // Requests through `tailscale serve` carry the tailnet identity. Serve proxies from
    // loopback, and only the user's own login is accepted.
    const tsLogin = req.headers["tailscale-user-login"];
    const loop = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
    if (loop && tsLogin && tailnetOwners().includes(String(tsLogin).toLowerCase())) return true;
    const cookie = /(?:^|;\s*)dvc=([^;]+)/.exec(req.headers.cookie || "")?.[1];
    const given = cookie || req.headers["x-dvc-code"] || "";
    const a = Buffer.from(String(given)), b = Buffer.from(code);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, obj, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
      res.end(JSON.stringify(obj));
    };
    try {
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/api/login" && req.method === "POST") {
        const b = await body(req);
        const a = Buffer.from(String(b.code || "")), c = Buffer.from(code);
        if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) return send(401, { error: "Wrong code." });
        return send(200, { ok: true }, { "Set-Cookie": `dvc=${code}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
      }
      if (url.pathname.startsWith("/api/")) {
        if (!authed(req)) return send(401, { error: "login required" });
        if (req.method === "POST" && url.pathname === "/api/offer") {
          const b = await body(req);
          const r = await liveCall(b.sdp);
          const callId = crypto.randomUUID();
          const callBrain = injected ? brain : newBrain();
          callBrain.reset?.();
          const call = createCall(callBrain);
          calls.set(callId, call);
          lastCall = call;
          while (calls.size > 6) calls.delete(calls.keys().next().value);
          push({ type: "status", text: "Call started", call: callId.slice(0, 8) });
          return send(200, { sdp: r.sdp, callId });
        }
        if (req.method === "POST" && url.pathname === "/api/relay") {
          const b = await body(req);
          const call = calls.get(String(b.callId || ""));
          if (!call) return send(409, { error: "This call has ended. Tap Start talking again." });
          call.relay(Array.isArray(b.events) ? b.events.slice(0, 300) : []);
          if (b.wait) await call.chain;
          return send(200, { appends: call.outbox.splice(0), log: log.slice(-40), pending: call.brain.pending ? true : false });
        }
        if (req.method === "POST" && url.pathname === "/api/ask") {
          // Typed fallback: same brain, same confirmation rules.
          const b = await body(req);
          let r;
          try {
            r = await typedBrain.handle(String(b.text || ""));
          } catch (e) {
            r = { say: e.safe || "Something went wrong." };
          }
          push({ type: "heard", text: String(b.text || "") });
          push({ type: "reply", text: r.say, pending: r.pending?.summary || null, action: r.action?.status || null });
          return send(200, { say: r.say, log: log.slice(-40), pending: !!typedBrain.pending });
        }
        if (req.method === "POST" && url.pathname === "/api/confirm") {
          const b = await body(req);
          const cb = calls.get(String(b.callId || ""))?.brain || typedBrain;
          const r = await cb.confirm(b.yes === true);
          push({ type: "reply", text: r.say, action: r.action?.status || null });
          return send(200, { say: r.say, log: log.slice(-40), pending: !!cb.pending });
        }
        if (req.method === "POST" && url.pathname === "/api/client-event") {
          const b = await body(req);
          const kind = String(b.kind || "").slice(0, 40);
          if (kind) push({ type: "client", kind, text: String(b.text || "").slice(0, 300), ua: String(req.headers["user-agent"] || "").slice(0, 120) });
          return send(200, { ok: true });
        }
        if (req.method === "GET" && url.pathname === "/api/state")
          return send(200, { log: log.slice(-40), pending: false });
        return send(404, { error: "not found" });
      }
      const file = url.pathname === "/" ? "/index.html" : url.pathname;
      const p = path.join(ROOT, "public", path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
      if (!p.startsWith(path.join(ROOT, "public")) || !fs.existsSync(p)) return send(404, { error: "not found" });
      res.writeHead(200, { "Content-Type": types[path.extname(p)] || "application/octet-stream", "Cache-Control": "no-store" });
      fs.createReadStream(p).pipe(res);
    } catch (e) {
      send(e.status && e.status < 500 ? e.status : 502, { error: e.safe || "Server error." });
    }
  });
  // Tests drive one call directly.
  const testCall = createCall(brain);
  return { server, relay: testCall.relay, log, outbox: testCall.outbox, get chain() { return testCall.chain; }, createCall };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3077);
  const host = process.env.HOST || "127.0.0.1";
  const { server } = createApp();
  server.listen(port, host, () => console.log(`discord-voice-control on http://${host}:${port}`));
}
