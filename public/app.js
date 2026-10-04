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

function render(state) {
  if (!state) return;
  const ul = $("#log");
  ul.innerHTML = "";
  for (const e of [...state.log].reverse()) {
    if (!["heard", "reply", "error"].includes(e.type)) continue;
    const li = document.createElement("li");
    li.className = e.type + (e.action === "done" ? " write" : "");
    li.textContent = e.text;
    ul.append(li);
  }
  $("#confirm").hidden = !state.pending;
  const last = [...state.log].reverse().find((e) => e.pending);
  if (state.pending && last) $("#confirm-text").textContent = last.pending;
}

// Phone-side events go to the server log so a failed call can be diagnosed afterwards.
function report(kind, text = "") {
  try {
    const body = JSON.stringify({ kind, text: String(text).slice(0, 300) });
    if (!navigator.sendBeacon?.("/api/client-event", new Blob([body], { type: "application/json" })))
      fetch("/api/client-event", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true });
  } catch {}
}
window.addEventListener("error", (e) => report("page-error", e.message));
window.addEventListener("unhandledrejection", (e) => report("page-error", e.reason?.message || String(e.reason)));

let call = null;
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
let starting = false;

async function start() {
  if (starting || call) return;
  starting = true;
  // iOS only grants a screen wake lock inside the tap itself, so request it before any await.
  keepAwake(true);
  $("#talk").disabled = true;
  $("#status").textContent = "Starting microphone…";
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    starting = false;
    $("#talk").disabled = false;
    const n = e.name;
    report("mic-error", n + ": " + e.message);
    $("#status").textContent =
      n === "NotAllowedError" ? "Microphone blocked. Allow it in the browser address bar." :
      n === "NotFoundError" ? "No microphone found." :
      n === "NotReadableError" ? "Another app is using the microphone." : "Microphone failed: " + n;
    return;
  }
  const pc = new RTCPeerConnection();
  const c = { pc, stream, queue: [], timer: null, audio: null };
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
    a.play().catch((e) => { report("audio-blocked", e.message); $("#status").textContent = "Tap the page once to hear the voice."; });
  };
  const dc = pc.createDataChannel("oai-events");
  dc.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === "input_transcript.added" && d.item?.text) $("#status").textContent = "Heard: " + d.item.text;
      // GPT-Live fills the wait with stock phrases ("One moment.", "Checking.") even when the
      // prompt forbids it. Anything it says between a delegation and our answer is filler,
      // so mute the voice for exactly that window.
      if (d.type === "delegation.created") hush(c, true);
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
      if (r.appends?.length) hush(c, false);
      for (const a of r.appends || []) if (dc.readyState === "open") dc.send(JSON.stringify(a));
      render(r);
    } catch (err) {
      if (err.status === 409) return stop("Call ended on the server. Tap Start talking again.");
      c.queue.unshift(...batch);
    } finally {
      relaying = false;
    }
  }, 600);
  pc.onconnectionstatechange = () => {
    report("connection", pc.connectionState + " / " + document.visibilityState);
    if (pc.connectionState === "connected") $("#status").textContent = "Listening. Ask about any channel.";
    if (["failed", "disconnected"].includes(pc.connectionState)) stop("Connection lost.");
  };
  try {
    await pc.setLocalDescription(await pc.createOffer());
    const ans = await api("/api/offer", { sdp: pc.localDescription.sdp, brain: localStorage.dvcBrain || "A" });
    if (call !== c) return;
    c.id = ans.callId;
    await pc.setRemoteDescription({ type: "answer", sdp: ans.sdp });
    $("#talk").textContent = "Stop";
    $("#talk").classList.add("on");
    $("#status").textContent = "Connecting…";
  } catch (e) {
    stop("Could not start: " + e.message);
  } finally {
    starting = false;
    $("#talk").disabled = false;
  }
}

function stop(msg) {
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
  $("#talk").textContent = "Start talking";
  $("#talk").classList.remove("on");
  $("#status").textContent = msg || "Stopped.";
}

$("#talk").onclick = () => (call ? stop() : start());
$("#yes").onclick = async () => render(await api("/api/confirm", { yes: true, callId: call?.id }));
$("#no").onclick = async () => render(await api("/api/confirm", { yes: false, callId: call?.id }));
$("#typed").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("#say").value.trim();
  if (!text) return;
  $("#say").value = "";
  $("#status").textContent = "Working…";
  try {
    const r = await api("/api/ask", { text });
    $("#status").textContent = r.say;
    render(r);
  } catch (err) {
    $("#status").textContent = err.message;
  }
};
$("#login").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("/api/login", { code: $("#code").value.trim() });
    boot();
  } catch {
    $("#code").value = "";
    $("#code").placeholder = "Wrong code";
  }
};

async function boot() {
  try {
    const s = await api("/api/state");
    $("#login").hidden = true;
    $("#app").hidden = false;
    render(s);
  } catch {
    $("#login").hidden = false;
    $("#app").hidden = true;
  }
}
boot();

// Split test switch: A = Hermes profile, B = direct model. Applies to the next call.
(() => {
  const sel = document.getElementById("brain");
  if (!sel) return;
  sel.value = localStorage.dvcBrain || "A";
  sel.onchange = () => {
    localStorage.dvcBrain = sel.value;
    $("#status").textContent = `Brain ${sel.value} selected. Applies from the next call.`;
  };
})();
