// Live updates: watch every post/thread this app sent (the work ledger) for new replies from
// people or agents, and raise one update per new reply. Polls Discord lightly (one request per
// tracked item, oldest items dropped after 48 h), keeps a cursor per item so nothing repeats
// across restarts.
import fs from "node:fs";
import path from "node:path";
import { readLedger, LEDGER_FILE, isProgress, cleanForPhone } from "./mcp.mjs";

const DONE = /\b(done|finished|complete[d]?|ready|merged|shipped|posted|fixed|live|deployed|sent|published|pushed|approved|resolved)\b/i;

export function createWatcher({ discord, ledgerFile = LEDGER_FILE, stateFile, onUpdate = () => {}, everyMs = 30000, maxAgeH = 48, now = () => Date.now() } = {}) {
  const sf = stateFile || path.join(path.dirname(ledgerFile), "watch.json");
  let cursors = {};
  try { cursors = JSON.parse(fs.readFileSync(sf, "utf8")); } catch {}
  const save = () => { try { fs.writeFileSync(sf, JSON.stringify(cursors)); } catch {} };
  const updates = []; // newest last, capped
  const startedAt = now();
  let timer = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const items = readLedger(ledgerFile).filter((x) => now() - Date.parse(x.at) < maxAgeH * 3600e3);
      for (const x of items) {
        if (cursors[x.messageId] === "gone") continue;
        // An item that existed before this watcher started is primed silently: only replies from
        // now on are news. (Without this, the first run replayed every old reply as "new".)
        if (!cursors[x.messageId] && Date.parse(x.at) < startedAt - 60e3) {
          try {
            const last = await discord.call("GET", `/channels/${x.channelId}/messages?limit=1`);
            cursors[x.messageId] = last?.[0]?.id && BigInt(last[0].id) > BigInt(x.messageId) ? last[0].id : x.messageId;
          } catch (e) { if (e.status === 404) cursors[x.messageId] = "gone"; }
          continue;
        }
        const after = cursors[x.messageId] || x.messageId;
        let msgs;
        try { msgs = await discord.call("GET", `/channels/${x.channelId}/messages?limit=10&after=${after}`); }
        catch (e) { if (e.status === 404) cursors[x.messageId] = "gone"; continue; }
        if (!Array.isArray(msgs) || !msgs.length) continue;
        msgs.sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? 1 : -1));
        cursors[x.messageId] = msgs.at(-1).id;
        for (const m of msgs) {
          if (m.webhook_id) continue; // our own posts
          const text = String(m.content || (m.embeds?.[0]?.title ?? "") || (m.attachments?.length ? "[attachment]" : "")).trim();
          if (!text) continue;
          // Agent heartbeats ("⏩ picked up in the current run… iteration 38/800") are progress noise,
          // not news. Only real replies become live updates.
          if (isProgress(text) || !cleanForPhone(text)) continue;
          const u = {
            id: m.id, at: m.timestamp, room: x.room || "", request: (x.title || x.text || "").slice(0, 120),
            author: m.member?.nick || m.author?.global_name || m.author?.username || "someone",
            text: cleanForPhone(text).slice(0, 400), done: DONE.test(text),
            needsYou: /\*\*(decide|if yes i will)[:*]|^\s*decide:/im.test(text),
            url: `https://discord.com/channels/${process.env.DVC_GUILD || ""}/${x.channelId}/${m.id}`,
          };
          updates.push(u);
          if (updates.length > 100) updates.shift();
          onUpdate(u);
        }
      }
      save();
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() { if (!timer) { timer = setInterval(() => tick().catch(() => {}), everyMs); timer.unref?.(); } return this; },
    stop() { clearInterval(timer); timer = null; },
    since(id) { return id ? updates.filter((u) => BigInt(u.id) > BigInt(id)) : updates.slice(-10); },
    get updates() { return updates; },
  };
}

// One short spoken line for an update (the voice reads it during a call).
export function spokenUpdate(u) {
  const room = u.room ? ` in ${u.room.replace(/^thread "([^"]+)".*$/, "$1").replace(/^#/, "")}` : "";
  const gist = u.text.replace(/https?:\/\/\S+/g, "a link").replace(/[*_`>#]/g, "").split(/(?<=[.!?])\s/)[0].slice(0, 160);
  return `Update${room}: ${u.author} ${u.needsYou ? "needs a decision from you" : u.done ? "says it's done" : "replied"}. ${gist}`;
}
