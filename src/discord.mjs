// Narrow Discord REST client. Only the calls listed here exist; the only delete is "undo" of this app's own last action.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://discord.com/api/v10";
export const GUILD = process.env.DVC_GUILD || "";
export const OWNER = process.env.DVC_OWNER || ""; // your Discord user id (name + avatar for posts)
const HOOK_NAME = process.env.DVC_WEBHOOK_NAME || "Voice controller";

function readToken() {
  if (process.env.DISCORD_BOT_TOKEN) return process.env.DISCORD_BOT_TOKEN;
  const file = process.env.DVC_ENV_FILE || os.homedir() + "/.hermes/.env";
  const env = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const m = env.match(/^DISCORD_BOT_TOKEN=(.*)$/m);
  if (!m) throw new Error("DISCORD_BOT_TOKEN not found");
  return m[1].trim().replace(/^['"]|['"]$/g, "");
}

const TYPES = { 0: "text", 5: "announcement", 15: "forum", 11: "thread", 12: "private thread", 10: "thread" };

export function createDiscord({ fetchImpl = fetch, token = null } = {}) {
  const tok = () => token || (token = readToken());
  async function call(method, path, body, retry = true) {
    const res = await fetchImpl(API + path, {
      method,
      headers: {
        Authorization: `Bot ${tok()}`,
        "User-Agent": "DiscordBot (discord-voice-control, 0.1)",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429 && retry) {
      const j = await res.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, Math.min(5, j.retry_after || 1) * 1000));
      return call(method, path, body, false);
    }
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`Discord ${res.status}`), { status: res.status, detail: text.slice(0, 200) });
    return text ? JSON.parse(text) : null;
  }

  let cache = null;
  let lastPost = null;
  let lastAction = null; // the last thing this app did, for "undo"
  const HOOKS = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), ".local", "webhooks.json");
  let me = null;
  async function persona() {
    if (me) return me;
    const u = await call("GET", `/users/${OWNER}`);
    const m = await call("GET", `/guilds/${GUILD}/members/${OWNER}`).catch(() => null);
    me = {
      name: m?.nick || u.global_name || u.username,
      avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=256` : undefined,
    };
    return me;
  }
  async function webhookFor(channelId) {
    let store = {};
    try { store = JSON.parse(fs.readFileSync(HOOKS, "utf8")); } catch {}
    if (store[channelId]) return store[channelId];
    const existing = (await call("GET", `/channels/${channelId}/webhooks`)).find((w) => w.name === HOOK_NAME && w.token);
    const w = existing || (await call("POST", `/channels/${channelId}/webhooks`, { name: HOOK_NAME }));
    store[channelId] = { id: w.id, token: w.token };
    fs.mkdirSync(path.dirname(HOOKS), { recursive: true });
    fs.writeFileSync(HOOKS, JSON.stringify(store), { mode: 0o600 });
    return store[channelId];
  }
  async function channels(force = false) {
    if (cache && !force && Date.now() - cache.at < 60_000) return cache.list;
    const [chans, active] = await Promise.all([
      call("GET", `/guilds/${GUILD}/channels`),
      call("GET", `/guilds/${GUILD}/threads/active`),
    ]);
    const cats = Object.fromEntries(chans.filter((c) => c.type === 4).map((c) => [c.id, c.name]));
    const byId = Object.fromEntries(chans.map((c) => [c.id, c]));
    const list = [
      ...chans
        .filter((c) => TYPES[c.type])
        .map((c) => ({ id: c.id, name: c.name, kind: TYPES[c.type], category: cats[c.parent_id] || null, last: c.last_message_id || null, topic: c.topic ? c.topic.slice(0, 120) : undefined })),
      ...(active.threads || []).map((t) => ({
        id: t.id,
        name: t.name,
        kind: byId[t.parent_id]?.type === 15 ? "forum post" : "thread",
        parent: byId[t.parent_id]?.name || null,
        parentId: t.parent_id,
        last: t.last_message_id || null,
      })),
    ];
    cache = { at: Date.now(), list };
    return list;
  }

  return {
    call,
    channels,
    async get(id) {
      return (await channels()).find((c) => c.id === id) || null;
    },
    async readMessages(id, limit = 15, before = null) {
      const n = Math.max(1, Math.min(50, Number(limit) || 15));
      const msgs = await call("GET", `/channels/${id}/messages?limit=${n}${before ? `&before=${before}` : ""}`);
      return msgs.reverse().map((m) => ({
        id: m.id,
        author: m.member?.nick || m.author?.global_name || m.author?.username,
        bot: !!m.author?.bot && !m.webhook_id,
        at: m.timestamp,
        replyTo: m.referenced_message ? (m.referenced_message.author?.global_name || m.referenced_message.author?.username) : undefined,
        text: (m.content || (m.embeds?.length ? `[embed] ${m.embeds[0].title || m.embeds[0].description || ""}` : m.attachments?.length ? "[attachment]" : "")).slice(0, 900),
        url: `https://discord.com/channels/${GUILD}/${id}/${m.id}`,
        media: [
          ...(m.attachments || []).map((a) => ({ kind: /^video/.test(a.content_type || "") ? "video" : /^image/.test(a.content_type || "") ? "image" : "file", url: a.url, name: a.filename })),
          ...(m.embeds || []).filter((e) => e.image?.url || e.thumbnail?.url || e.video?.url).map((e) => ({ kind: e.video?.url ? "video" : "image", url: e.video?.url || e.image?.url || e.thumbnail?.url, name: e.title || "" })),
        ].slice(0, 4),
      }));
    },
    async pins(id) {
      const msgs = await call("GET", `/channels/${id}/pins`);
      return msgs.slice(0, 15).map((m) => ({ id: m.id, author: m.author?.global_name || m.author?.username, text: (m.content || "").slice(0, 400) }));
    },
    // Reactions, pins, renames and new channels have NO webhook API in Discord, so they can only
    // be done by the bot account. Each records how to reverse it, so "undo" covers them too.
    async react(channelId, messageId, emoji) {
      await call("PUT", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
      lastAction = { kind: "react", channelId, messageId, emoji };
      return { reacted: true };
    },
    async pin(channelId, messageId) {
      await call("PUT", `/channels/${channelId}/pins/${messageId}`);
      lastAction = { kind: "pin", channelId, messageId };
      return { pinned: true };
    },
    async createChannel(name, categoryName, topic) {
      const chans = await call("GET", `/guilds/${GUILD}/channels`);
      const cat = categoryName ? chans.find((c) => c.type === 4 && c.name.toLowerCase() === categoryName.toLowerCase()) : null;
      const c = await call("POST", `/guilds/${GUILD}/channels`, { name, type: 0, parent_id: cat?.id, topic });
      cache = null;
      lastAction = { kind: "channel", channelId: c.id };
      return { channelId: c.id, category: cat?.name || null };
    },
    async editLast(content) {
      if (!lastPost) throw Object.assign(new Error("nothing to edit"), { status: 404 });
      const p = lastPost;
      const res = await fetchImpl(`${API}/webhooks/${p.hookId}/${p.token}/messages/${p.messageId}${p.threadId ? `?thread_id=${p.threadId}` : ""}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "User-Agent": "DiscordBot (discord-voice-control, 0.1)" },
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw Object.assign(new Error(`Discord ${res.status}`), { status: res.status });
      return { edited: true };
    },
    // Reverse ONLY the last thing this app itself did in this run.
    async deleteLast() {
      const a = lastAction;
      if (!a) throw Object.assign(new Error("nothing to undo"), { status: 404 });
      const hookDelete = async (p) => {
        const res = await fetchImpl(`${API}/webhooks/${p.hookId}/${p.token}/messages/${p.messageId}${p.threadId ? `?thread_id=${p.threadId}` : ""}`, {
          method: "DELETE", headers: { "User-Agent": "DiscordBot (discord-voice-control, 0.1)" }, signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok && res.status !== 404) throw Object.assign(new Error(`Discord ${res.status}`), { status: res.status });
      };
      if (a.kind === "post") await hookDelete(a);
      else if (a.kind === "thread") { await call("DELETE", `/channels/${a.threadId}`); await hookDelete(a.starter).catch(() => {}); cache = null; }
      else if (a.kind === "react") await call("DELETE", `/channels/${a.channelId}/messages/${a.messageId}/reactions/${encodeURIComponent(a.emoji)}/@me`);
      else if (a.kind === "pin") await call("DELETE", `/channels/${a.channelId}/pins/${a.messageId}`);
      else if (a.kind === "rename" && a.before) { await call("PATCH", `/channels/${a.channelId}`, { name: a.before }); cache = null; }
      else if (a.kind === "channel") { await call("DELETE", `/channels/${a.channelId}`); cache = null; }
      lastAction = null;
      if (a.kind === "post") lastPost = null;
      return { undone: a.kind };
    },
    get lastAction() {
      return lastAction;
    },
    get lastPost() {
      return lastPost;
    },
    async post(id, content, replyTo = null) {
      // Post under the user's name and avatar through a channel webhook. Discord still marks
      // webhook posts as an APP; nothing here uses a user token (that breaks Discord's terms).
      const ch = await this.get(id);
      if (!ch) throw Object.assign(new Error("unknown room"), { status: 404 });
      const parentId = ch.kind === "thread" || ch.kind === "forum post" ? ch.parentId : id;
      const hook = await webhookFor(parentId);
      const q = parentId !== id ? `?wait=true&thread_id=${id}` : "?wait=true";
      const me = await persona();
      const res = await fetchImpl(`${API}/webhooks/${hook.id}/${hook.token}${q}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "DiscordBot (discord-voice-control, 0.1)" },
        // Webhooks cannot make a native reply, so a reply quotes and links the original.
        body: JSON.stringify({
          content: replyTo ? `> replying to https://discord.com/channels/${GUILD}/${id}/${replyTo}\n${content}` : content,
          username: me.name, avatar_url: me.avatar, allowed_mentions: { parse: [] },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      if (!res.ok) throw Object.assign(new Error(`Discord ${res.status}`), { status: res.status, detail: text.slice(0, 200) });
      const messageId = JSON.parse(text).id;
      lastPost = { channelId: id, hookId: hook.id, token: hook.token, messageId, threadId: parentId !== id ? id : null };
      lastAction = { kind: "post", ...lastPost };
      return { messageId };
    },
    async createThread(id, name, content) {
      // Same "the user voice" path as posts. Forum: the webhook creates the post itself
      // (thread_name). Text channel: the opening message is posted by the webhook, then the thread
      // is started FROM that message, so the thread opens with the user's app-badged post.
      const parent = await this.get(id);
      if (!parent) throw Object.assign(new Error("unknown room"), { status: 404 });
      const hook = await webhookFor(id);
      const me = await persona();
      const res = await fetchImpl(`${API}/webhooks/${hook.id}/${hook.token}?wait=true`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "DiscordBot (discord-voice-control, 0.1)" },
        body: JSON.stringify({
          // Mentioning the owner adds them to the thread, so it shows in their sidebar and notifies.
          content: OWNER ? `${content || name}\n\n<@${OWNER}>` : content || name,
          username: me.name, avatar_url: me.avatar, allowed_mentions: { users: OWNER ? [OWNER] : [] },
          ...(parent.kind === "forum" ? { thread_name: name.slice(0, 100) } : {}),
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      if (!res.ok) throw Object.assign(new Error(`Discord ${res.status}`), { status: res.status, detail: text.slice(0, 200) });
      const m = JSON.parse(text);
      let threadId = m.channel_id;
      if (parent.kind !== "forum") {
        const t = await call("POST", `/channels/${id}/messages/${m.id}/threads`, { name: name.slice(0, 100), auto_archive_duration: 10080 });
        threadId = t.id;
      }
      cache = null;
      if (OWNER && parent.kind !== "forum") await call("PUT", `/channels/${threadId}/thread-members/${OWNER}`).catch(() => {});
      lastAction = { kind: "thread", threadId, starter: { hookId: hook.id, token: hook.token, messageId: m.id, threadId: parent.kind === "forum" ? threadId : null } };
      return { threadId, messageId: m.id };
    },
    async rename(id, name) {
      const before = (await this.get(id))?.name;
      await call("PATCH", `/channels/${id}`, { name });
      lastAction = { kind: "rename", channelId: id, before };
      cache = null;
      return { renamed: true };
    },
  };
}
