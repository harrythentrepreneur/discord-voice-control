// Brain backed by the dedicated `discord-voice` Hermes profile (GPT-Live -> this app -> Hermes).
// Hermes does all reasoning with its discord-voice MCP tools. Writes come back as a pending action
// file; this module keeps the deterministic yes/no gate and executes only on the user's own yes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { classifyConfirmation } from "./brain.mjs";
import { PENDING_FILE } from "./mcp.mjs";

const PROFILE = process.env.DVC_PROFILE || "discord-voice";
const BASE = process.env.DVC_HERMES_URL || "http://127.0.0.1:8642";

function profileKey() {
  if (process.env.DVC_HERMES_KEY) return process.env.DVC_HERMES_KEY;
  const env = fs.readFileSync(path.join(os.homedir(), ".hermes", "profiles", PROFILE, ".env"), "utf8");
  const m = env.match(/^API_SERVER_KEY=(.*)$/m);
  if (!m) throw new Error(`API_SERVER_KEY missing for profile ${PROFILE}`);
  return m[1].trim();
}

export async function askHermes(text, sessionId, { fetchImpl = fetch, key = profileKey() } = {}) {
  const res = await fetchImpl(`${BASE}/p/${PROFILE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(sessionId ? { "X-Hermes-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify({ model: PROFILE, messages: [{ role: "user", content: text }] }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw Object.assign(new Error(`Hermes ${res.status}`), { safe: `The Discord brain is unavailable (${res.status}).` });
  const j = await res.json();
  return { say: String(j.choices?.[0]?.message?.content || "").trim(), sessionId: res.headers.get("x-hermes-session-id") || sessionId };
}

const DONE = { post_message: "Sent.", react: "Done.", pin_message: "Pinned.", create_thread: "Started.", create_channel: "Channel created.", rename_channel: "Renamed." };

// the user's standing choice (4 Oct 2026): an action he asks for runs at once, no read-back.
// DVC_CONFIRM=1 restores the spoken yes/no gate. "Undo" removes the last post this app sent.
const CONFIRM = process.env.DVC_CONFIRM === "1";
const UNDO = /^\s*(undo( that)?|delete (that|it|the last (post|message))|take (that|it) (back|down)|scratch that|remove (that|it))\b[\s.!]*$/i;
const doneText = (a) => {
  const x = a.args || {};
  const where = /^(Post|Reply) in (.+?): "/.exec(a.summary || "")?.[2];
  if (a.tool === "post_message") return `Posted${where ? ` in ${where}` : ""}: "${x.content}". Say undo to take it down.`;
  return `${DONE[a.tool] || "Done."} Say undo to reverse it.`;
};

// The MCP server writes ONE shared pending file. Serialise every Hermes request across all brains
// (voice call, typed requests) so a draft is always read by the brain whose request created it.
let hermesLock = Promise.resolve();
function withHermesLock(fn) {
  const run = hermesLock.then(fn, fn);
  hermesLock = run.catch(() => {});
  return run;
}

export function createHermesBrain({ discord, ask = askHermes, pendingFile = PENDING_FILE, log = () => {}, confirm = CONFIRM }) {
  let sessionId = null;
  let pending = null;

  const readPending = () => {
    try {
      const p = JSON.parse(fs.readFileSync(pendingFile, "utf8"));
      fs.unlinkSync(pendingFile);
      return p;
    } catch {
      return null;
    }
  };

  async function execute(a) {
    const x = a.args;
    switch (a.tool) {
      case "post_message": return discord.post(x.channel_id, x.content, x.reply_to_message_id);
      case "react": return discord.react(x.channel_id, x.message_id, x.emoji);
      case "pin_message": return discord.pin(x.channel_id, x.message_id);
      case "create_thread": return discord.createThread(x.channel_id, x.name, x.content);
      case "create_channel": return discord.createChannel(x.name, x.category, x.topic);
      case "rename_channel": return discord.rename(x.channel_id, x.name);
      default: throw new Error("not allowed");
    }
  }

  async function confirmPending(yes) {
    const a = pending;
    pending = null;
    if (!a) return { say: "There is nothing waiting for confirmation." };
    if (!yes) {
      note(`[app] the user cancelled: ${a.summary}`);
      return { say: "Cancelled. Nothing was changed.", action: { ...a, status: "cancelled" } };
    }
    try {
      await execute(a);
      log({ type: "write", tool: a.tool, channel: a.args.channel_id });
      note(`[app] Done: ${a.summary}`);
      return { say: confirm ? DONE[a.tool] || "Done." : doneText(a), action: { ...a, status: "done" } };
    } catch (e) {
      return { say: `That failed. Discord said ${e.status || "an error"}. Nothing else was changed.`, action: { ...a, status: "failed" } };
    }
  }

  // Outcome notes ride along with the user's next request so Hermes knows what really happened.
  let notes = [];
  const note = (n) => notes.push(n);

  // allowWrite=false (the turn never asked to post) holds a draft for a yes even when posts are
  // instant, so a misheard or background sentence can never post as the user.
  async function handle(utterance, { allowWrite = true } = {}) {
    const text = String(utterance || "").trim().slice(0, 2000);
    if (!text) return { say: "I didn't catch that." };
    if (UNDO.test(text) && !pending) {
      try {
        const u = await discord.deleteLast();
        const what = { post: "took that post down", thread: "deleted that thread", react: "removed that reaction", pin: "unpinned it", rename: "changed the name back", channel: "deleted that channel" }[u?.undone] || "took that post down";
        log({ type: "write", tool: "undo", undone: u?.undone });
        note(`[app] the user said undo; ${what}.`);
        return { say: `Done, I ${what}.`, action: { tool: "undo", status: "done" } };
      } catch {
        return { say: "There's nothing recent from me to undo." };
      }
    }
    if (pending) {
      const d = classifyConfirmation(text);
      if (d !== "other") return confirmPending(d === "yes");
      if (text.split(/\s+/).length <= 4) return { say: `Sorry, was that a yes? ${pending.summary}` };
      note(`[app] the user moved on; this was NOT sent: ${pending.summary}`);
      pending = null;
    }
    const msg = notes.length ? `${notes.join("\n")}\n\nthe user: ${text}` : text;
    notes = [];
    const { r, p } = await withHermesLock(async () => {
      try { fs.unlinkSync(pendingFile); } catch {}
      const r = await ask(msg, sessionId);
      return { r, p: readPending() };
    });
    sessionId = r.sessionId || sessionId;
    if (p) {
      pending = p;
      if (!confirm && allowWrite) return confirmPending(true);
      if (!allowWrite) log({ type: "held", tool: p.tool, reason: "turn did not ask to write" });
      return { say: p.summary, pending: p };
    }
    return { say: r.say || "Done." };
  }

  return {
    handle,
    confirm: (yes) => confirmPending(!!yes),
    get pending() { return pending; },
    reset() {
      pending = null;
      notes = [];
      sessionId = `dvc_${randomUUID()}`;
    },
  };
}
