const $ = (s) => document.querySelector(s);
const api = async (path, body) => {
  const r = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status });
  return j;
};

/* ---------- UI state ---------- */

let call = null; // the live GPT-Live call, if any

const ui = {
  mode: "idle", // idle | connecting | listening | thinking | speaking
  heard: "",
  waiting: 0, // requests in flight (typed or spoken)
  lastLog: [],
};
// V2 default: Direct (fastest, shows sources). A saved explicit choice from v2 on is kept.
if (!localStorage.dvcBrainV2) { localStorage.dvcBrain = "B"; localStorage.dvcBrainV2 = "1"; }
let brainMode = localStorage.dvcBrain || "B";
const DEVICE = localStorage.dvcDevice || (localStorage.dvcDevice = Math.random().toString(36).slice(2, 10));
const callsSeen = new Set(JSON.parse(sessionStorage.dvcCalls || "[]")); // calls started on this device
let canUndo = false;
const seenUpdates = new Set();
// Badge = live updates you haven't looked at yet (cleared when you open Your requests).
let unseenUpdates = 0;
const paintBadge = () => { const b = $("#req-count"); b.hidden = !unseenUpdates; b.textContent = unseenUpdates; };
let firstRender = true;
function chime() {
  try {
    const ctx = (window.__chime ||= new (window.AudioContext || window.webkitAudioContext)());
    for (const [f, t] of [[880, 0], [1320, 0.12]]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.35);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.4);
    }
  } catch {}
}
function notifyUpdate(u) {
  unseenUpdates++;
  paintBadge();
  if (!call) chime(); // during a call the voice says it instead
  buzz([20, 60, 20]);
  toast(`${u.needsYou ? "Needs you" : u.done ? "✓ Finished" : "New reply"} · ${u.author}: ${plain(u.text).slice(0, 80)}`, 5000);
  refreshRequests(false);
  if (document.visibilityState !== "visible" && "Notification" in window && Notification.permission === "granted")
    try { new Notification(`${u.author} ${u.done ? "finished" : "replied"}`, { body: u.text.slice(0, 140), tag: u.id }); } catch {}
}

const STATE_TEXT = {
  idle: "",
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Checking Discord…",
  speaking: "Speaking",
};

function setMode(m) {
  ui.mode = m;
  const mic = $("#talk");
  mic.classList.toggle("connecting", m === "connecting");
  mic.classList.toggle("on", ["listening", "thinking", "speaking"].includes(m));
  mic.classList.toggle("thinking", m === "thinking");
  mic.classList.toggle("speaking", m === "speaking");
  mic.setAttribute("aria-label", call ? "End the call" : "Start talking");
  $("#mic-label").textContent = m === "idle" ? "Talk" : m === "connecting" ? "Cancel" : "End";
  const muted = call?.micMuted;
  $("#state").textContent = (STATE_TEXT[m] || "") + (muted && call && m !== "connecting" ? " · mic off" : "");
  const conn = $("#conn");
  conn.className = "conn " + (m === "idle" ? "" : m === "connecting" ? "busy" : "live");
  conn.querySelector("span").textContent = m === "idle" ? "Ready" : m === "connecting" ? "Connecting…" : "Live";
  document.body.classList.toggle("in-call", m !== "idle");
  $("#mute").disabled = !call || m === "connecting";
}

function setHeard(t) {
  ui.heard = t || "";
  $("#heard").textContent = ui.heard;
}

let toastTimer;
function toast(text, ms = 2600) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function buzz(ms = 12) {
  if (Array.isArray(ms)) { try { navigator.vibrate?.(ms); } catch {} return; }
  try { navigator.vibrate?.(ms); } catch {}
}

/* ---------- Conversation feed ---------- */

const fmtTime = (iso) => {
  try { return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); } catch { return ""; }
};

// Incremental render: the server sends a sliding window of the log on every relay (0.6 s) and
// refresh (8 s). Rebuilding the list each time replayed every bubble's entrance animation, so the
// whole chat flashed. Now each entry is keyed, existing bubbles are reused untouched, only new
// ones are created (and only they animate), and nothing changes when nothing changed.
// Key = type + text + occurrence number. Not the timestamp: the typed bubble shown instantly and
// the server's copy of it have different timestamps but must be the same node.
function keysFor(items) {
  const seen = new Map();
  return items.map((e) => {
    const base = `${e.type}|${e.text}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return `${base}|${n}`;
  });
}
const nodes = new Map(); // key -> <li>
let lastSig = "";
let thinkingEl = null;

// Minimal, safe markdown for Discord text: **bold**, `code`, list dashes and quotes. Builds DOM
// nodes (never innerHTML), so message text can't inject markup.
function md(text) {
  const frag = document.createDocumentFragment();
  const lines = String(text || "").replace(/<@!?\d+>/g, "").replace(/^\s*>\s?replying to \S+\s*/m, "").split("\n");
  lines.forEach((line, i) => {
    line = line.replace(/^\s*[-*•]\s+/, "• ").replace(/^\s*>\s?/, "").replace(/^#+\s*/, "");
    for (const part of line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
      if (!part) continue;
      if (/^\*\*[^*]+\*\*$/.test(part)) { const b = document.createElement("b"); b.textContent = part.slice(2, -2); frag.append(b); }
      else if (/^`[^`]+`$/.test(part)) { const c = document.createElement("code"); c.textContent = part.slice(1, -1); frag.append(c); }
      else frag.append(part.replace(/\*\*|__/g, ""));
    }
    if (i < lines.length - 1) frag.append(document.createElement("br"));
  });
  return frag;
}
const plain = (t) => String(t || "").replace(/<@!?\d+>/g, "").replace(/^\s*>\s?replying to \S+\s*/m, "").replace(/\*\*|`|^\s*[-*•]\s+/gm, "").trim();

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const ago = (iso) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
function statusPill(st) {
  const map = { "needs you": ["needs", "Needs you"], done: ["replied", "Done"], replied: ["replied", "Replied"], working: ["working", "Working"], deleted: ["gone", "Deleted"], unknown: ["gone", "Unknown"] };
  const [cls, label] = map[st] || ["waiting", "Waiting"];
  return el("span", "pill " + cls, label);
}
// "thread "X" in #chan" -> "X · #chan" so the distinguishing part (the thread) comes first.
const shortRoom = (r) => String(r || "").replace(/^(?:thread|forum post|private thread) "([^"]+)" in (#\S+)$/, "$1 · $2");

function sourceCard(c) {
  const a = el("a", "src" + (c.request ? " req" : ""));
  if (c.url) { a.href = c.url; a.target = "_blank"; a.rel = "noopener"; }
  a.append(el("div", "src-room", shortRoom(c.room) || "Discord"));
  const img = (c.media || []).find((m) => m.kind === "image");
  const vid = (c.media || []).find((m) => m.kind === "video");
  if (img || vid) {
    const box = el("div", "src-media");
    if (vid) { const v = el("video"); v.src = vid.url + (vid.url.includes("#") ? "" : "#t=0.5"); v.controls = true; v.playsInline = true; v.preload = "metadata"; box.append(v); }
    else { const i = el("img"); i.src = img.url; i.loading = "lazy"; i.alt = img.name || ""; box.append(i); }
    a.append(box);
  }
  if (c.text) { const t = el("div", "src-text"); t.append(md(c.text)); a.append(t); }
  const foot = el("div", "src-foot");
  foot.append(el("span", "", [c.author, c.at ? ago(c.at) : ""].filter(Boolean).join(" · ")));
  if (c.url) foot.append(el("span", "src-open", "Open ↗"));
  if (c.status) foot.append(statusPill(c.status));
  a.append(foot);
  return a;
}

function bubble(e) {
  if (e.type === "update") {
    const li = el("li", "msg bot update" + (e.done ? " finished" : ""));
    const b = el("div", "bubble");
    b.append(el("div", "upd-head", (e.needsYou ? "Needs your decision · " : e.done ? "✓ Finished · " : "New reply · ") + shortRoom(e.room)));
    const body = el("div", "");
    body.append(el("b", "", e.author + ": "));
    body.append(md(e.text));
    b.append(body);
    if (e.request) b.append(el("div", "upd-req", `You asked: ${plain(e.request).slice(0, 110)}`));
    if (e.url) { const open = el("a", "upd-open", "Open in Discord ↗"); open.href = e.url; open.target = "_blank"; open.rel = "noopener"; b.append(open); }
    li.append(b);
    return li;
  }
  const li = document.createElement("li");
  const you = e.type === "heard";
  li.className = "msg " + (you ? "you" : "bot") + (e.action === "done" ? " done" : "") + (e.type === "error" ? " err" : "");
  const b = document.createElement("div");
  b.className = "bubble";
  if (e.type === "reply") b.append(md(e.text)); else b.textContent = e.text;
  li.append(b);
  const meta = document.createElement("div");
  meta.className = "meta";
  const bits = [fmtTime(e.at)];
  if (you && e.typed) bits.push("typed");
  meta.append(bits.filter(Boolean).join(" · "));
  if (!you && e.brain) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = (e.brain === "B" ? "Direct" : e.brain === "A" ? "Hermes" : e.brain) + (e.ms ? ` · ${(e.ms / 1000).toFixed(1)}s` : "");
    meta.append(tag);
  }
  if (!you && e.type === "reply") {
    const cp = document.createElement("button");
    cp.className = "copy";
    cp.type = "button";
    cp.textContent = "Copy";
    cp.onclick = async () => {
      try { await navigator.clipboard.writeText(e.text); toast("Copied"); } catch { toast("Couldn't copy"); }
    };
    meta.append(cp);
  }
  li.append(meta);
  if (!you && e.sources?.length) {
    const box = el("div", "sources");
    for (const c of e.sources) box.append(sourceCard(c));
    li.insertBefore(box, meta);
  }
  return li;
}

function render(state) {
  if (!state?.log) return;
  ui.lastLog = state.log;
  // Only this device's conversation: its calls and its typed requests. Other phones' calls and
  // answers that were replaced by a newer question (never spoken) are left out.
  const mine = (e) => (e.call ? callsSeen.has(e.call) : e.device ? e.device === DEVICE : !!e.local);
  const items = state.log.filter((e) => (["heard", "reply", "error"].includes(e.type) && !e.skipped && mine(e)) || e.type === "update");
  // New live updates: chime + toast + badge, once each.
  for (const u of items.filter((e) => e.type === "update" && !seenUpdates.has(e.id))) {
    seenUpdates.add(u.id);
    if (!firstRender) notifyUpdate(u);
  }
  firstRender = false;
  if (typeof state.canUndo === "boolean") canUndo = state.canUndo;
  const keys = keysFor(items);
  const sig = keys.join("\n") + `|w${ui.waiting > 0}|p${!!state.pending}|u${canUndo}`;
  if (sig === lastSig) return; // nothing changed: touch nothing
  lastSig = sig;

  const feed = $("#feed");
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  const ol = $("#log");
  const keep = new Set();
  let added = false;
  let prev = null;
  for (const [i, e] of items.entries()) {
    const k = keys[i];
    keep.add(k);
    let li = nodes.get(k);
    if (!li) {
      li = bubble(e);
      nodes.set(k, li);
      added = true;
    }
    // place in order without re-inserting nodes that are already in the right spot
    const want = prev ? prev.nextSibling : ol.firstChild;
    if (want !== li) ol.insertBefore(li, want);
    prev = li;
  }
  for (const [k, li] of nodes) if (!keep.has(k)) { li.remove(); nodes.delete(k); }

  if (ui.waiting > 0) {
    if (!thinkingEl) {
      thinkingEl = document.createElement("li");
      thinkingEl.className = "msg bot thinking";
      thinkingEl.innerHTML = '<div class="bubble"><i></i><i></i><i></i></div>';
    }
    if (ol.lastChild !== thinkingEl) ol.append(thinkingEl);
  } else if (thinkingEl) {
    thinkingEl.remove();
    thinkingEl = null;
  }

  $("#empty").hidden = items.length > 0 || ui.waiting > 0;
  $("#quick").hidden = !(items.length > 0 || ui.waiting > 0);
  if (!$("#quick").hidden) requestAnimationFrame(() => window.fadeQuick?.());
  // Undo reflects the server's real last undoable action, not history.
  $("#undo").disabled = !canUndo;
  $("#confirm").hidden = !state.pending;
  const last = [...state.log].reverse().find((e) => e.pending);
  if (state.pending && last) $("#confirm-text").textContent = last.pending;
  // Follow new messages only if the user was already at the bottom; never yank them while reading.
  if (added && nearBottom) requestAnimationFrame(() => {
    const lastBot = [...ol.querySelectorAll("li.msg.bot:not(.thinking)")].pop();
    const lastYou = [...ol.querySelectorAll("li.msg.you")].pop();
    // A long answer opens at its start (with the question just above), not at its last line.
    if (lastBot && lastBot.offsetHeight > feed.clientHeight * 0.6) {
      const anchor = lastYou && lastYou.offsetTop < lastBot.offsetTop ? lastYou : lastBot;
      feed.scrollTop = anchor.offsetTop - 8;
    } else feed.scrollTop = feed.scrollHeight;
  });
}

/* ---------- Diagnostics to the server log ---------- */

function report(kind, text = "") {
  try {
    const body = JSON.stringify({ kind, text: String(text).slice(0, 300) });
    if (!navigator.sendBeacon?.("/api/client-event", new Blob([body], { type: "application/json" })))
      fetch("/api/client-event", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true });
  } catch {}
}
window.addEventListener("error", (e) => report("page-error", e.message));
window.addEventListener("unhandledrejection", (e) => report("page-error", e.reason?.message || String(e.reason)));

/* ---------- The call ---------- */

let wakeLock = null;

function hush(c, on) {
  (window.__hush ||= []).push([Date.now(), on]);
  c.hushed = on;
  if (c.audio) c.audio.muted = on;
  clearTimeout(c.hushTimer);
  if (on) c.hushTimer = setTimeout(() => hush(c, false), 30000); // never stay mute forever
}

async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    else if (on) report("no-wake-lock");
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) {
    report("wake-lock-failed", e.message);
  }
}
document.addEventListener("visibilitychange", () => {
  if (call) report(document.visibilityState === "visible" ? "screen-on" : "screen-off", call.pc.connectionState);
  if (document.visibilityState === "visible" && call) keepAwake(true);
});

// Voice level of the assistant drives the mic glow while it speaks.
function meter(c, stream) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 256;
    src.connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    c.ctx = ctx;
    const tick = () => {
      if (call !== c) return ctx.close().catch(() => {});
      an.getByteFrequencyData(buf);
      const lvl = Math.min(1, buf.reduce((a, b) => a + b, 0) / buf.length / 70);
      $("#talk").style.setProperty("--lvl", lvl.toFixed(2));
      const speaking = lvl > 0.08 && !c.hushed;
      if (speaking && ui.mode === "listening") setMode("speaking");
      if (!speaking && ui.mode === "speaking") setMode("listening");
      requestAnimationFrame(tick);
    };
    tick();
  } catch {}
}

let starting = false;

async function start() {
  if (starting || call) return;
  starting = true;
  buzz();
  // iOS only grants a screen wake lock inside the tap itself, so request it before any await.
  keepAwake(true);
  setMode("connecting");
  setHeard("Allow the microphone if asked");
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    starting = false;
    const n = e.name;
    report("mic-error", n + ": " + e.message);
    setMode("idle");
    setHeard(
      n === "NotAllowedError" ? "Microphone blocked. Allow it in your browser settings." :
      n === "NotFoundError" ? "No microphone found." :
      n === "NotReadableError" ? "Another app is using the microphone." : "Microphone failed: " + n);
    return;
  }
  setHeard("");
  const pc = new RTCPeerConnection();
  const c = { pc, stream, queue: [], timer: null, audio: null, brain: brainMode, micMuted: false };
  call = c;
  for (const t of stream.getAudioTracks()) {
    pc.addTrack(t, stream);
    t.addEventListener("ended", () => { report("mic-ended", document.visibilityState); stop("Microphone stopped."); });
    t.addEventListener("mute", () => report("mic-muted", document.visibilityState));
    t.addEventListener("unmute", () => report("mic-unmuted", document.visibilityState));
  }
  pc.ontrack = (e) => {
    const a = new Audio();
    a.autoplay = true;
    a.srcObject = e.streams[0];
    c.audio = a;
    a.muted = !!c.hushed;
    a.play().catch((err) => { report("audio-blocked", err.message); toast("Tap anywhere to hear the voice", 5000); });
    meter(c, e.streams[0]);
  };
  const dc = pc.createDataChannel("oai-events");
  dc.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === "input_transcript.added" && d.item?.text) {
        c.partial = (c.partial || "") + d.item.text;
        if (c.partial.trim().split(/\s+/).length >= 3) setHeard("“" + c.partial.trim() + "…”");
      }
      if (d.type === "turn.done" && d.turn?.role === "user") { c.partial = ""; if (d.turn.transcript) setHeard("“" + d.turn.transcript.trim() + "”"); }
      // GPT-Live fills the wait with stock phrases ("One moment.", "Checking.") even when the
      // prompt forbids it. Anything it says between a delegation and our answer is filler,
      // so mute the voice for exactly that window.
      if (d.type === "delegation.created") { hush(c, true); setMode("thinking"); }
      if (/^(input_transcript|output_transcript|turn\.)/.test(d.type)) c.lastSpeech = Date.now();
      if (d.type === "turn.done" && d.turn?.role === "assistant") (window.__said ||= []).push([Date.now(), d.turn.transcript, !!c.hushed]);
      c.queue.push(d);
    } catch {}
  };
  let relaying = false;
  c.timer = setInterval(async () => {
    if (relaying || call !== c || !c.id) return; // hold events until the server names this call
    relaying = true;
    const batch = c.queue.splice(0, 300);
    try {
      const r = await api("/api/relay", { events: batch, callId: c.id });
      if (r.appends?.length) { hush(c, false); if (ui.mode === "thinking") setMode("listening"); }
      for (const a of r.appends || []) {
        // A live update waits until nobody is talking, so it never cuts into an answer.
        if (a.type === "session.context.append") { c.announces = [...(c.announces || []), a]; continue; }
        if (dc.readyState === "open") dc.send(JSON.stringify(a));
      }
      if (c.announces?.length && ui.mode === "listening" && !c.hushed && Date.now() - (c.lastSpeech || 0) > 2500 && dc.readyState === "open")
        dc.send(JSON.stringify(c.announces.shift()));
      render(r);
    } catch (err) {
      if (err.status === 409) return stop("Call ended. Tap to talk again.");
      c.queue.unshift(...batch);
    } finally {
      relaying = false;
    }
  }, 600);
  pc.onconnectionstatechange = () => {
    report("connection", pc.connectionState + " / " + document.visibilityState);
    if (pc.connectionState === "connected") { setMode("listening"); buzz(20); }
    if (["failed", "disconnected"].includes(pc.connectionState)) stop("Connection lost. Tap to reconnect.");
  };
  try {
    await pc.setLocalDescription(await pc.createOffer());
    const ans = await api("/api/offer", { sdp: pc.localDescription.sdp, brain: brainMode });
    if (call !== c) return;
    c.id = ans.callId;
    callsSeen.add(c.id);
    sessionStorage.dvcCalls = JSON.stringify([...callsSeen].slice(-20));
    await pc.setRemoteDescription({ type: "answer", sdp: ans.sdp });
  } catch (e) {
    stop("Couldn't start: " + e.message);
  } finally {
    starting = false;
  }
}

let stop = function (msg) {
  if (call) report("call-stopped", msg || "user");
  const c = call;
  call = null;
  if (c) {
    clearInterval(c.timer);
    c.stream.getTracks().forEach((t) => t.stop());
    try { c.pc.close(); } catch {}
    if (c.audio) c.audio.srcObject = null;
  }
  keepAwake(false);
  $("#mute").setAttribute("aria-pressed", "false");
  $("#mute").setAttribute("aria-label", "Mute microphone");
  $("#mute span").textContent = "Mute";
  $("#talk").classList.remove("muted");
  setMode("idle");
  setHeard(msg || "");
  if (msg) buzz(30);
};

function toggleMute() {
  if (!call) return;
  call.micMuted = !call.micMuted;
  for (const t of call.stream.getAudioTracks()) t.enabled = !call.micMuted;
  $("#mute").setAttribute("aria-pressed", String(call.micMuted));
  $("#mute").setAttribute("aria-label", call.micMuted ? "Unmute microphone" : "Mute microphone");
  $("#mute span").textContent = call.micMuted ? "Unmute" : "Mute";
  $("#talk").classList.toggle("muted", call.micMuted);
  report(call.micMuted ? "user-mute" : "user-unmute");
  buzz();
  setMode(ui.mode);
}

/* ---------- Typed requests, chips, undo ---------- */

let lastAsk = { text: "", at: 0 };
async function ask(text, path = "/api/ask") {
  text = String(text || "").trim();
  if (!text && path === "/api/ask") return;
  // A double tap (or a quick re-send of the same words) runs once.
  if (text === lastAsk.text && Date.now() - lastAsk.at < 2500) return;
  lastAsk = { text, at: Date.now() };
  buzz();
  ui.waiting++;
  // Show the request immediately, before the server answers.
  render({ log: [...ui.lastLog, { type: "heard", text: path === "/api/undo" ? "undo" : text, typed: true, device: DEVICE, call: call?.id, at: new Date().toISOString() }] });
  try {
    const r = await api(path, { text, callId: call?.id, brain: brainMode, device: DEVICE });
    ui.waiting--;
    render(r);
    if (path === "/api/undo") toast(r.say);
  } catch (err) {
    ui.waiting--;
    render({ log: [...ui.lastLog, { type: "error", text: err.message, local: true, at: new Date().toISOString() }] });
  }
}

$("#talk").onclick = () => { $("#resume").hidden = true; return call ? stop() : start(); };
$("#mute").onclick = toggleMute;
$("#undo").onclick = () => ask("undo", "/api/undo");
$("#yes").onclick = async () => render(await api("/api/confirm", { yes: true, callId: call?.id }));
$("#no").onclick = async () => render(await api("/api/confirm", { yes: false, callId: call?.id }));
const sendBtn = document.querySelector("#typed .send");
const paintSend = () => (sendBtn.disabled = !$("#say").value.trim());
$("#say").addEventListener("input", paintSend);
paintSend();
$("#typed").onsubmit = (e) => {
  e.preventDefault();
  const t = $("#say").value;
  $("#say").value = "";
  paintSend();
  $("#say").blur();
  ask(t);
};
for (const chip of document.querySelectorAll(".chip")) chip.onclick = () => ask(chip.dataset.say);
// Quick row: hint that it scrolls (fade only while more chips are hidden to the right).
const quick = document.getElementById("quick");
const fadeQuick = (window.fadeQuick = () => quick.classList.toggle("more", quick.scrollLeft + quick.clientWidth < quick.scrollWidth - 4));
quick.addEventListener("scroll", fadeQuick, { passive: true });
new ResizeObserver(fadeQuick).observe(quick);

// Brain switch (split test). A live call keeps its brain; the choice applies to the next call.
function paintBrain() {
  for (const b of document.querySelectorAll(".seg button")) b.setAttribute("aria-checked", String(b.dataset.brain === brainMode));
  setMode(ui.mode);
}
for (const b of document.querySelectorAll(".seg button")) {
  b.onclick = () => {
    if (brainMode === b.dataset.brain) return;
    brainMode = localStorage.dvcBrain = b.dataset.brain;
    buzz();
    paintBrain();
    toast(call ? `Brain ${brainMode} from your next call` : `Brain ${brainMode}: ${brainMode === "A" ? "Hermes profile" : "direct, no Hermes"}`);
  };
}

/* ---------- Sign in ---------- */

$("#login-form").onsubmit = async (e) => {
  e.preventDefault();
  const code = $("#code").value.trim();
  if (!code) { $("#login-error").textContent = "Enter your access code."; $("#code").focus(); return; }
  try {
    await api("/api/login", { code });
    boot();
  } catch {
    $("#code").value = "";
    $("#login-error").textContent = "That code didn't work.";
  }
};

async function boot() {
  try {
    const sess = await api("/api/session");
    if (!sess.authed) throw new Error("login");
    const s = await api("/api/state");
    $("#login").hidden = true;
    $("#app").hidden = false;
    paintBrain();
    render(s);
  } catch {
    $("#login").hidden = false;
    $("#app").hidden = true;
  }
}
boot();

// Refresh the feed while idle so a typed reply or another device's call shows up.
setInterval(async () => {
  if (call || document.visibilityState !== "visible" || $("#app").hidden || ui.waiting) return;
  try { render(await api("/api/state")); } catch {}
}, 10000);


/* ---------- V2: Your requests ---------- */

async function refreshRequests(render = true) {
  try {
    const r = await api("/api/requests");
    if (!render) return;
    const ol = $("#req-list");
    ol.innerHTML = "";
    if (!r.items.length) ol.append(el("li", "muted", "Nothing sent from the voice app in the last 48 hours."));
    for (const x of r.items) {
      const li = el("li");
      const a = el("a", "req");
      a.href = x.url; a.target = "_blank"; a.rel = "noopener";
      const top = el("div", "req-top");
      top.append(el("span", "req-room", shortRoom(x.room) || "Discord"));
      top.append(statusPill(x.status));
      a.append(top);
      a.append(el("div", "req-text", (x.title ? `${x.title}: ` : "") + plain(x.text)));
      const last = x.replies?.at?.(-1);
      if (last) { const r = el("div", "req-reply"); r.append(el("b", "", last.author + ": ")); r.append(md(last.text)); a.append(r); }
      a.append(el("div", "req-top", `Asked ${ago(x.at)}` + (x.lastActivity ? ` · updated ${ago(x.lastActivity)}` : "")));
      li.append(a);
      ol.append(li);
    }
  } catch {
    if (render) $("#req-list").innerHTML = '<li class="muted">Could not load requests.</li>';
  }
}
$("#open-requests").onclick = () => {
  buzz();
  $("#requests").hidden = false;
  unseenUpdates = 0;
  paintBadge();
  refreshRequests(true);
  // Ask once for notifications so finished work can alert with the screen off (where supported).
  if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
};
$("#close-requests").onclick = () => ($("#requests").hidden = true);
$("#requests").onclick = (e) => { if (e.target.id === "requests") $("#requests").hidden = true; };
setInterval(() => { if (!$("#app").hidden && document.visibilityState === "visible") refreshRequests(!$("#requests").hidden); }, 30000);
setTimeout(() => refreshRequests(false), 1500);

/* ---------- V2: resume a dropped call ---------- */
let lastStopWasDrop = false;
const _stop = stop;
stop = function (msg) {
  const drop = !!call && !!msg && /lost|ended|stopped/i.test(msg);
  _stop(msg);
  lastStopWasDrop = drop;
  $("#resume").hidden = !drop;
  if (drop) $("#resume-text").textContent = "Call dropped. Your conversation is kept.";
};
$("#resume-btn").onclick = () => { $("#resume").hidden = true; start(); };
