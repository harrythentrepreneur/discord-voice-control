#!/usr/bin/env node
// Minimal MCP stdio server: the user's Discord tools for the discord-voice Hermes profile.
// Reads run immediately. Writes are NEVER executed here: they are written to the voice app's
// pending file and the app runs them only after the user's own spoken (or tapped) yes.
import "./env.mjs";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDiscord } from "./discord.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const PENDING_FILE = process.env.DVC_PENDING_FILE || path.join(ROOT, ".local", "pending.json");

const S = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
export const TOOLS = [
  { name: "find_rooms", description: "Only if read_room could not match a spoken name: list rooms by loose name.", inputSchema: obj({ query: S }) },
  { name: "recent_activity", description: "ONE call for 'what's new / what did I miss / any updates': the most recently active rooms WITH their latest messages. Answer straight from it.", inputSchema: obj({ limit: { type: "integer", minimum: 1, maximum: 5 } }) },
  { name: "catch_up", description: "Same as recent_activity. ONE call for 'what's new / what did I miss / any updates': the most recently active rooms with their latest messages. Prefer this over recent_activity + read_room.", inputSchema: obj({ rooms: { type: "integer", minimum: 1, maximum: 6 }, per_room: { type: "integer", minimum: 3, maximum: 15 } }) },
  { name: "read_room", description: "Read messages in a room (oldest to newest) with ids. 'room' may be an id OR a spoken name like 'support queue' or 'team general chat' (best match is used). before_message_id pages back.", inputSchema: obj({ room: S, limit: { type: "integer", minimum: 1, maximum: 60 }, before_message_id: S }, ["room"]) },
  { name: "read_pins", description: "Pinned messages in a room.", inputSchema: obj({ room: S }, ["room"]) },
  { name: "my_requests", description: "ONE call for 'did everything go through / what did we send / status of the things we made / any replies to my requests': every post and thread this voice app created, newest first, each with live status (replied / no reply yet) and the latest replies.", inputSchema: obj({ hours: { type: "integer", minimum: 1, maximum: 168 } }) },
  { name: "propose_post", description: "Propose posting as the user (optionally replying to a message id). Sent as the user as soon as this turn ends.", inputSchema: obj({ room: S, text: S, reply_to_message_id: S }, ["room", "text"]) },
  { name: "propose_thread", description: "Propose starting a thread / forum post with an opening message. Created as soon as this turn ends.", inputSchema: obj({ room: S, title: S, text: S }, ["room", "title", "text"]) },
  { name: "propose_react", description: "Propose an emoji reaction on a message. Done as soon as this turn ends.", inputSchema: obj({ room: S, message_id: S, emoji: S }, ["room", "message_id", "emoji"]) },
  { name: "propose_pin", description: "Propose pinning a message. Done as soon as this turn ends.", inputSchema: obj({ room: S, message_id: S }, ["room", "message_id"]) },
  { name: "propose_rename", description: "Propose renaming a channel or thread. Done as soon as this turn ends.", inputSchema: obj({ room: S, name: S }, ["room", "name"]) },
  { name: "propose_channel", description: "Propose creating a text channel, optionally in a category by name. Done as soon as this turn ends.", inputSchema: obj({ name: S, category: S, topic: S }, ["name"]) },
];

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const STOP = new Set(["the", "channel", "thread", "room", "in", "post", "forum", "a", "of"]);
const ts = (id) => new Date(Number((BigInt(id) >> 22n) + 1420070400000n)).toISOString();

export function createHandlers(discord = createDiscord(), pendingFile = PENDING_FILE) {
  const label = (c) => (c ? (c.kind === "text" ? `#${c.name}` : `${c.kind} "${c.name}"${c.parent ? ` in #${c.parent}` : ""}`) : "unknown room");
  async function room(ref) {
    const r = String(ref || "").trim();
    const byId = /^\d{15,}$/.test(r) ? await discord.get(r) : null;
    if (byId) return byId;
    const list = await discord.channels();
    const q = norm(r.replace(/^#/, ""));
    const words = r.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
    const score = (c) => {
      const n = norm(c.name);
      if (n === q) return 100;
      if (n.includes(q) && q.length > 2) return 60 - (n.length - q.length) / 10;
      const hay = n + "|" + norm(c.parent);
      if (!words.length) return 0;
      if (words.every((w) => hay.includes(w))) return 40 - n.length / 20;
      // Spoken names carry extra words ("discord voice controller thing" -> discord-controller).
      const hit = words.filter((w) => hay.includes(w)).length;
      return hit >= 2 && hit / words.length >= 0.5 ? 20 * (hit / words.length) - n.length / 40 : 0;
    };
    const best = list.map((c) => [score(c), c]).filter(([v]) => v > 0).sort((a, b) => b[0] - a[0] || (BigInt(b[1].last || 0) > BigInt(a[1].last || 0) ? 1 : -1))[0];
    if (!best) throw new Error(`No room matches "${r}". Try find_rooms.`);
    return best[1];
  }
  function propose(action, summary) {
    const p = { ...action, summary, createdAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
    fs.writeFileSync(pendingFile + ".tmp", JSON.stringify(p));
    fs.renameSync(pendingFile + ".tmp", pendingFile);
    return { status: "queued; the app sends it as soon as you finish this turn", instruction: "Reply with one short line only, e.g. 'Posting that now.' The app reports the real result." };
  }
  const this_room = room;
  const handlers = {
    async find_rooms({ query = "" }) {
      const list = await discord.channels();
      const words = String(query).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
      const rows = list.filter((c) => {
        const hay = norm(c.name) + "|" + norm(c.parent) + "|" + norm(c.category);
        return !words.length || hay.includes(norm(query)) || words.every((w) => hay.includes(w));
      });
      return rows.slice(0, 60).map(({ id, name, kind, parent, category, last }) => ({ id, name, kind, parent, category, lastActivity: last ? ts(last) : null }));
    },
    // NOTE: never use `this` in handlers: the MCP dispatcher calls them unbound. It did, and
    // recent_activity failed on every call all day ("reading 'catch_up'").
    async recent_activity({ limit = 4 }) {
      return handlers.catch_up({ rooms: Math.min(5, limit), per_room: 8 });
    },
    async _recent_rooms({ limit = 12 }) {
      const list = await discord.channels();
      return list.filter((c) => c.last).sort((a, b) => (BigInt(b.last) > BigInt(a.last) ? 1 : -1)).slice(0, Math.min(25, limit))
        .map((c) => ({ id: c.id, name: c.name, kind: c.kind, parent: c.parent, lastActivity: ts(c.last) }));
    },
    async catch_up({ rooms = 4, per_room = 10 }) {
      const list = await discord.channels();
      const top = list.filter((c) => c.last).sort((a, b) => (BigInt(b.last) > BigInt(a.last) ? 1 : -1)).slice(0, Math.min(6, rooms));
      const out = await Promise.all(top.map(async (c) => {
        try {
          const msgs = await discord.readMessages(c.id, Math.min(15, per_room));
          return { room: label(c), id: c.id, lastActivity: ts(c.last), messages: msgs.map(({ author, at, text, url, media }) => ({ author, at, text: text.slice(0, 700), url, media: media?.length ? media : undefined })) };
        } catch (e) { return { room: label(c), error: `Discord ${e.status || "error"}` }; }
      }));
      return out;
    },
    async read_room({ room, room_id, limit = 30, before_message_id }) {
      const c = await this_room(room || room_id);
      if (c.kind === "forum") {
        const posts = (await discord.channels()).filter((t) => t.parentId === c.id && t.last)
          .sort((a, b) => (BigInt(b.last) > BigInt(a.last) ? 1 : -1)).slice(0, 6);
        return { room: label(c), note: "Forum: newest active posts with their latest messages.", posts: await Promise.all(posts.map(async (t) => ({
          post: t.name, id: t.id, lastActivity: ts(t.last),
          messages: (await discord.readMessages(t.id, 6)).map(({ author, at, text, url, media }) => ({ author, at, text: text.slice(0, 600), url, media: media?.length ? media : undefined })),
        }))) };
      }
      return { room: label(c), messages: await discord.readMessages(c.id, limit, before_message_id) };
    },
    async read_pins({ room, room_id }) {
      const c = await this_room(room || room_id);
      return { room: label(c), pins: await discord.pins(c.id) };
    },
    async propose_post({ room: room_ref, room_id, text, reply_to_message_id }) {
      const c = await this_room(room_ref || room_id);
      const t = String(text).slice(0, 1900);
      return propose({ tool: "post_message", args: { channel_id: c.id, content: t, reply_to_message_id } }, `${reply_to_message_id ? "Reply" : "Post"} in ${label(c)}: "${t}". Send it?`);
    },
    async propose_thread({ room: room_ref, room_id, title, text }) {
      const c = await this_room(room_ref || room_id);
      return propose({ tool: "create_thread", args: { channel_id: c.id, name: String(title).slice(0, 90), content: String(text).slice(0, 1900) } }, `Start "${title}" in ${label(c)}, opening with: "${text}". Go ahead?`);
    },
    async propose_react({ room: room_ref, room_id, message_id, emoji }) {
      const c = await this_room(room_ref || room_id);
      return propose({ tool: "react", args: { channel_id: c.id, message_id, emoji } }, `React ${emoji} to that message in ${label(c)}?`);
    },
    async propose_pin({ room: room_ref, room_id, message_id }) {
      const c = await this_room(room_ref || room_id);
      return propose({ tool: "pin_message", args: { channel_id: c.id, message_id } }, `Pin that message in ${label(c)}?`);
    },
    async propose_rename({ room: room_ref, room_id, name }) {
      const c = await this_room(room_ref || room_id);
      return propose({ tool: "rename_channel", args: { channel_id: c.id, name } }, `Rename ${label(c)} to "${name}"?`);
    },
    async propose_channel({ name, category, topic }) {
      return propose({ tool: "create_channel", args: { name, category, topic } }, `Create a channel called ${name}${category ? ` in ${category}` : ""}?`);
    },
    // "Did everything go through? What's the status of the things we sent?" One call: every post and
    // thread this app made (newest first), each checked live for replies since.
    async my_requests({ hours = 24, limit = 12 }) {
      const items = readLedger().filter((x) => Date.now() - Date.parse(x.at) < Math.min(168, hours) * 3600e3).slice(-Math.min(25, limit)).reverse();
      return Promise.all(items.map(async (x) => {
        try {
          const after = await discord.call("GET", `/channels/${x.channelId}/messages?limit=10&after=${x.messageId}`);
          const all = after.filter((m) => !m.webhook_id).reverse();
          // Agent heartbeats ("⏳ Working… iteration 21/800", "📚 Reading skill …") mean "in progress",
          // not "replied". Only real messages count as replies.
          const isPing = (m) => isProgress(m.content);
          const replies = all.filter((m) => !isPing(m));
          const lastAny = all.at(-1);
          // Honest status from the LATEST message: a ping or "next I'll…" = still working.
          const status = !all.length ? "no reply yet"
            : NEEDS_YOU.test(lastAny.content || "") ? "needs you"
            : isPing(lastAny) || STILL_WORKING.test(lastAny.content || "") ? "working"
            : DONE_WORDS.test(lastAny.content || "") ? "done" : "replied";
          return { ...x, replies: undefined, url: `https://discord.com/channels/${GUILD_ID}/${x.channelId}/${x.messageId}`, status, lastActivity: all.at(-1)?.timestamp, replies: replies.slice(-3).map((m) => ({ author: m.member?.nick || m.author?.global_name || m.author?.username, at: m.timestamp, text: cleanForPhone(m.content).slice(0, 400) })).filter((r) => r.text) };
        } catch (e) {
          return { ...x, status: e.status === 404 ? "deleted" : "unknown" };
        }
      }));
    },
  };
  return handlers;
}

// The work ledger: every post/thread this app created. Small JSON file, newest last.
const GUILD_ID = process.env.DVC_GUILD || "";
// Agent progress noise vs real replies.
export function isProgress(text) {
  const t = String(text || "");
  return (
    // "✍️ Writing", "🔀 Delegating list", "📖 Reading STATUS.md", "⏳ Working — 6 min"
    /^\s*(?:>\s*)?\p{Extended_Pictographic}\uFE0F?\s*(?:\*\*)?[A-Z][a-z]+ing\b/u.test(t) ||
    /^\s*(?:>\s*)?(⏩|⏳|🔄|⚙️|💭)/u.test(t) ||
    /\biteration \d+\s*(\/|of)\s*\d+/i.test(t) ||
    /^\s*(reading skill|running|working —)\b/i.test(t) ||
    /^\s*```/.test(t)
  );
}
const STILL_WORKING = /\b(next,? i'?ll|now i'?ll|i'?ll (now |next )?(check|continue|look|start|run|create|build|write|post)|working on|in progress|continuing|still (checking|working|running))\b/i;
// A decision block ("**If yes I will:**", "Decide:") means it is waiting on the owner.
const NEEDS_YOU = /\*\*(decide|if yes i will)[:*]|^\s*decide:/im;
const DONE_WORDS = /\b(done|finished|complete[d]?|ready for (you|review)|merged|shipped|fixed|is live|published|here'?s the (result|report|summary))\b/i;
// Strip code blocks, paths and tool noise so a phone card shows words, not terminal output.
export function cleanForPhone(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/(^|\s)\/(home|tmp|usr|var)\/\S+/g, "$1")
    .split("\n").filter((l) => !isProgress(l) && !/^\s*\(×\d+\)/.test(l)).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim();
}
export const LEDGER_FILE = process.env.DVC_LEDGER_FILE || path.join(ROOT, ".local", "ledger.json");
export function readLedger(file = LEDGER_FILE) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; }
}
export function appendLedger(entry, file = LEDGER_FILE) {
  const all = readLedger(file);
  all.push({ at: new Date().toISOString(), ...entry });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(all.slice(-300), null, 1));
  fs.renameSync(file + ".tmp", file);
}
export function removeFromLedger(messageId, file = LEDGER_FILE) {
  const all = readLedger(file).filter((x) => x.messageId !== messageId);
  fs.writeFileSync(file, JSON.stringify(all, null, 1));
}

// --- JSON-RPC over stdio (MCP) ---
export function runStdio() {
  const handlers = createHandlers();
  const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params } = msg;
    if (id === undefined) return; // notifications
    try {
      if (method === "initialize")
        return out({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "discord-voice", version: "0.2.0" } } });
      if (method === "tools/list") return out({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      if (method === "ping") return out({ jsonrpc: "2.0", id, result: {} });
      if (method === "tools/call") {
        const fn = handlers[params?.name];
        if (!fn) throw new Error("unknown tool");
        try {
          const r = await fn(params.arguments || {});
          return out({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(r).slice(0, 60000) }] } });
        } catch (e) {
          return out({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: e.message + (e.status ? ` (Discord ${e.status})` : "") }] } });
        }
      }
      out({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
    } catch (e) {
      out({ jsonrpc: "2.0", id, error: { code: -32000, message: e.message } });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runStdio();
