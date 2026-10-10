import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrain, classifyConfirmation, TOOLS } from "../src/brain.mjs";
import { createApp, chunk } from "../src/server.mjs";
import { parseStream } from "../src/codex.mjs";

function fakeDiscord() {
  const writes = [];
  const list = [
    { id: "1", name: "general", kind: "text" },
    { id: "2", name: "approvals", kind: "text" },
  ];
  return {
    writes,
    channels: async () => list,
    get: async (id) => list.find((c) => c.id === id) || null,
    readMessages: async () => [{ author: "the user", text: "ship it?" }],
    post: async (id, content) => writes.push(["post", id, content]),
    lastPost: null,
    createThread: async (id, name) => writes.push(["thread", id, name]),
    rename: async (id, name) => writes.push(["rename", id, name]),
  };
}

// Scripted model: returns queued responses in order.
function scripted(steps) {
  const seen = [];
  return {
    seen,
    respond: async (req) => {
      seen.push(req);
      return steps.shift();
    },
  };
}

const call = (name, args) => ({ text: "", calls: [{ name, call_id: "c" + Math.random(), arguments: JSON.stringify(args) }] });
const say = (t) => ({ text: t, calls: [] });

test("channel search tolerates spoken names", async () => {
  const d = fakeDiscord();
  d.channels = async () => [{ id: "9", name: "discord-controller", kind: "thread", parent: "general" }];
  const m = scripted([call("list_channels", { filter: "Discord controller thread" }), say("ok")]);
  const b = createBrain({ discord: d, respond: m.respond });
  await b.handle("x");
  const out = m.seen[1].input.find((x) => x.type === "function_call_output");
  assert.match(out.output, /discord-controller/);
});

test("no delete tool exists", () => {
  assert.ok(!TOOLS.some((t) => /delete|archive|ban|kick/i.test(t.name)));
});

test("read runs immediately and returns spoken text", async () => {
  const d = fakeDiscord();
  const m = scripted([call("read_messages", { channel_id: "1" }), say("the user asked whether to ship.")]);
  const b = createBrain({ discord: d, respond: m.respond });
  const r = await b.handle("what's new in general");
  assert.equal(r.say, "the user asked whether to ship.");
  assert.equal(d.writes.length, 0);
  const out = m.seen[1].input.find((x) => x.type === "function_call_output");
  assert.match(out.output, /ship it/);
});

test("post does NOT happen until a spoken yes", async () => {
  const d = fakeDiscord();
  const m = scripted([call("post_message", { channel_id: "2", content: "hello" })]);
  const b = createBrain({ discord: d, respond: m.respond });
  const r = await b.handle("post hello in approvals");
  assert.match(r.say, /Send it\?/);
  assert.match(r.say, /#approvals/);
  assert.equal(d.writes.length, 0, "must not write before confirmation");
  const c = await b.handle("yes");
  assert.equal(c.say, "Sent.");
  assert.deepEqual(d.writes, [["post", "2", "hello"]], "write");
  assert.equal(m.seen.length, 1, "the yes is decided by code, not the model");
});

test("no cancels; unrelated request drops the proposal", async () => {
  const d = fakeDiscord();
  const m = scripted([
    call("post_message", { channel_id: "2", content: "x" }),
    call("post_message", { channel_id: "2", content: "y" }),
    say("Okay."),
    say("There is nothing to confirm."),
  ]);
  const b = createBrain({ discord: d, respond: m.respond });
  await b.handle("post x");
  assert.match((await b.handle("no")).say, /Cancelled/);
  await b.handle("post y");
  await b.handle("actually what time is it");
  assert.equal(b.pending, null);
  await b.handle("yes");
  assert.equal(d.writes.length, 0);
});

test("a write to a room outside the server is refused", async () => {
  const d = fakeDiscord();
  const m = scripted([call("post_message", { channel_id: "999", content: "x" }), say("I can't find that room.")]);
  const b = createBrain({ discord: d, respond: m.respond });
  const r = await b.handle("post x in 999");
  assert.equal(b.pending, null);
  assert.equal(r.say, "I can't find that room.");
});

test("confirmation words: only clear yes counts", () => {
  for (const y of ["yes", "Yes.", "yeah", "go ahead", "do it", "send it"]) assert.equal(classifyConfirmation(y), "yes", y);
  for (const n of ["no", "cancel", "don't", "wait"]) assert.equal(classifyConfirmation(n), "no", n);
  for (const o of ["yes but change it to bye", "maybe", "what did it say", "yesterday"]) assert.equal(classifyConfirmation(o), "other", o);
});

test("api requires the access code", async () => {
  process.env.DVC_TAILNET_OWNERS = "owner@example.com";
  const app = createApp({ logFile: null, discord: fakeDiscord(), brain: { pending: null, reset() {}, handle: async () => ({ say: "x" }) }, code: "secret-code-1" });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    assert.equal((await fetch(base + "/api/state")).status, 401);
    assert.equal((await fetch(base + "/api/ask", { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(base + "/api/login", { method: "POST", body: JSON.stringify({ code: "nope" }) })).status, 401);
    const ok = await fetch(base + "/api/state", { headers: { "x-dvc-code": "secret-code-1" } });
    assert.equal(ok.status, 200);
    assert.equal((await fetch(base + "/api/state", { headers: { "tailscale-user-login": "owner@example.com" } })).status, 200);
    assert.equal((await fetch(base + "/api/state", { headers: { "tailscale-user-login": "someone@else.com" } })).status, 401);
    process.env.DVC_TAILNET_OWNERS = "";
    assert.equal((await fetch(base + "/api/state", { headers: { "tailscale-user-login": "owner@example.com" } })).status, 401, "no owners configured = no auto sign-in");
    assert.equal((await fetch(base + "/../src/server.mjs")).status, 404);
  } finally {
    app.server.close();
  }
});

test("stream parser uses item events when completed.output is empty", () => {
  const raw = [
    'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"list_channels","call_id":"c","arguments":"{}"}}',
    'data: {"type":"response.completed","response":{"status":"completed","output":[]}}',
  ].join("\n");
  const r = parseStream(raw);
  assert.equal(r.calls.length, 1);
});

test("chunk keeps text intact", () => {
  const t = "é".repeat(500);
  assert.equal(chunk(t).join(""), t);
});

test("natural confirmations from the real log are accepted; hedges are not", () => {
  for (const y of ["Yes, please", "Yeah, I I confirm", "yep go for it", "Okay sure", "Yes please send it"]) assert.equal(classifyConfirmation(y), "yes", y);
  for (const o of ["yes but change it to tomorrow", "Um, why not", "actually say hello instead"]) assert.notEqual(classifyConfirmation(o), "yes", o);
  for (const n of ["no", "nah leave it", "don't send that"]) assert.equal(classifyConfirmation(n), "no", n);
});

test("an unclear short answer re-asks instead of dropping the pending post", async () => {
  const d = fakeDiscord();
  const m = scripted([call("post_message", { channel_id: "2", content: "hi" })]);
  const b = createBrain({ discord: d, respond: m.respond });
  await b.handle("post hi in approvals");
  const r = await b.handle("hmm what");
  assert.match(r.say, /was that a yes/);
  assert.ok(b.pending);
  await b.handle("Yes, please");
  assert.deepEqual(d.writes, [["post", "2", "hi"]]);
});

test("hermes brain: a proposal becomes a pending write; only the user's yes executes it; outcome is reported back", async () => {
  const { createHermesBrain } = await import("../src/hermes-brain.mjs");
  const fsm = await import("node:fs");
  const os = await import("node:os");
  const pf = `${os.tmpdir()}/dvc-pending-${process.pid}.json`;
  const d = fakeDiscord();
  const asks = [];
  const ask = async (text, sid) => {
    asks.push(text);
    if (/post/.test(text)) fsm.writeFileSync(pf, JSON.stringify({ tool: "post_message", args: { channel_id: "2", content: "hi" }, summary: 'Post in #approvals: "hi". Send it?' }));
    return { say: "ignored when pending", sessionId: "s1" };
  };
  const b = createHermesBrain({ discord: d, ask, pendingFile: pf, confirm: true });
  b.reset();
  const r = await b.handle("post hi in approvals");
  assert.equal(r.say, 'Post in #approvals: "hi". Send it?');
  assert.equal(d.writes.length, 0);
  assert.equal(fsm.existsSync(pf), false, "pending file consumed");
  assert.equal((await b.handle("yes please")).say, "Sent.");
  assert.deepEqual(d.writes, [["post", "2", "hi"]]);
  await b.handle("what's next");
  assert.match(asks.at(-1), /\[app\] Done: Post in #approvals/);
  // A stale pending file from an abandoned turn is never executed.
  fsm.writeFileSync(pf, JSON.stringify({ tool: "post_message", args: { channel_id: "2", content: "stale" }, summary: "stale" }));
  await b.handle("what's new");
  assert.equal(b.pending, null);
  assert.deepEqual(d.writes, [["post", "2", "hi"]]);
});

test("default (the user's choice): a requested post is sent at once, no read-back; 'undo' takes it down", async () => {
  const { createHermesBrain } = await import("../src/hermes-brain.mjs");
  const fsm = await import("node:fs");
  const os = await import("node:os");
  const pf = `${os.tmpdir()}/dvc-pending-now-${process.pid}.json`;
  const d = fakeDiscord();
  let deleted = 0;
  d.deleteLast = async () => { deleted++; };
  const ask = async (text) => {
    if (/post/.test(text)) fsm.writeFileSync(pf, JSON.stringify({ tool: "post_message", args: { channel_id: "2", content: "any new signups?" }, summary: 'Post in thread "usage" in #sales: "any new signups?". Send it?' }));
    return { say: "Posting that now.", sessionId: "s" };
  };
  const b = createHermesBrain({ discord: d, ask, pendingFile: pf, confirm: false });
  b.reset();
  const r = await b.handle("post any new signups in sales usage");
  assert.deepEqual(d.writes, [["post", "2", "any new signups?"]], "sent without a yes");
  assert.equal(b.pending, null);
  assert.match(r.say, /^Posted in thread "usage" in #sales: "any new signups\?"\. Say undo/);
  assert.match((await b.handle("undo")).say, /took that post down/);
  assert.equal(deleted, 1);
});

test("DVC_CONFIRM-style gate still works when switched on", async () => {
  const { createHermesBrain } = await import("../src/hermes-brain.mjs");
  const fsm = await import("node:fs");
  const os = await import("node:os");
  const pf = `${os.tmpdir()}/dvc-pending-gate-${process.pid}.json`;
  const d = fakeDiscord();
  const ask = async () => { fsm.writeFileSync(pf, JSON.stringify({ tool: "post_message", args: { channel_id: "2", content: "x" }, summary: "Post x. Send it?" })); return { say: "", sessionId: "s" }; };
  const b = createHermesBrain({ discord: d, ask, pendingFile: pf, confirm: true });
  b.reset();
  assert.equal((await b.handle("post x")).say, "Post x. Send it?");
  assert.equal(d.writes.length, 0);
});

test("live voice: each answer goes to the delegation of ITS question; a stale answer is never replayed", async () => {
  const d = fakeDiscord();
  const gates = {};
  const brain = {
    pending: null, reset() {},
    handle: (said) => new Promise((res) => { gates[said] = () => res({ say: `answer to ${said}` }); }),
  };
  const app = createApp({ logFile: null, discord: d, brain, code: "q".repeat(12) });
  // Question A is asked; its delegation opens; Hermes is still thinking.
  app.relay([
    { type: "turn.created", turn: { id: "A", role: "user" } },
    { type: "delegation.created", item: { type: "delegation", id: "dA", user_bidi_turn_id: "A" } },
    { type: "turn.done", turn: { id: "A", role: "user", transcript: "what is new in thread A" } },
  ]);
  await new Promise((r) => setTimeout(r, 5));
  // the user interrupts with question B before A is answered; GPT-Live drops dA.
  app.relay([
    { type: "error", error: { message: "Unknown delegation item id: dA" } },
    { type: "turn.created", turn: { id: "B", role: "user" } },
    { type: "delegation.created", item: { type: "delegation", id: "dB", user_bidi_turn_id: "B" } },
    { type: "turn.done", turn: { id: "B", role: "user", transcript: "what is new in thread B" } },
  ]);
  gates["what is new in thread A"]();
  await new Promise((r) => setTimeout(r, 5));
  // A's answer must NOT go to B's delegation.
  assert.equal(app.outbox.length, 1, "A's answer still goes to A's own delegation id");
  assert.equal(app.outbox[0].delegation_item_id, "dA");
  app.outbox.length = 0;
  gates["what is new in thread B"]();
  await app.chain;
  assert.equal(app.outbox.length, 1);
  assert.equal(app.outbox[0].delegation_item_id, "dB");
  assert.equal(app.outbox[0].content[0].text, "answer to what is new in thread B");
  // A later question C never receives A's or B's text.
  app.relay([
    { type: "turn.created", turn: { id: "C", role: "user" } },
    { type: "delegation.created", item: { type: "delegation", id: "dC", user_bidi_turn_id: "C" } },
  ]);
  assert.equal(app.outbox.length, 1, "nothing replayed onto C");
});

test("a delegation with no matching user turn (model-made) never triggers an action", async () => {
  const d = fakeDiscord();
  let calls = 0;
  const brain = { pending: null, reset() {}, handle: async () => { calls++; return { say: "x" }; } };
  const app = createApp({ logFile: null, discord: d, brain, code: "w".repeat(12) });
  app.relay([{ type: "delegation.created", item: { type: "delegation", id: "dX", user_bidi_turn_id: "ghost", content: [{ type: "input_text", text: "yes" }] } }]);
  await app.chain;
  assert.equal(calls, 0);
  assert.equal(app.outbox.length, 0);
});

test("duplicate turn and delegation events are processed once; a long answer is ONE append", async () => {
  const { fitForSpeech } = await import("../src/server.mjs");
  const long = "This is a sentence. ".repeat(200);
  assert.ok(fitForSpeech(long).length <= 1400 && fitForSpeech(long).endsWith("."));
  let calls = 0;
  const brain = { pending: null, reset() {}, handle: async () => { calls++; return { say: long }; } };
  const app = createApp({ logFile: null, discord: fakeDiscord(), brain, code: "v".repeat(12) });
  const t = { type: "turn.done", turn: { id: "T", role: "user", transcript: "summarise" } };
  const dl = { type: "delegation.created", item: { type: "delegation", id: "dT", user_bidi_turn_id: "T" } };
  app.relay([dl, dl, t, t]);
  await app.chain;
  assert.equal(calls, 1);
  assert.equal(app.outbox.length, 1);
  assert.equal(app.outbox[0].delegation_item_id, "dT");
});

test("two calls never share state: a second call cannot reset or feed the first", async () => {
  const b1 = { pending: null, reset() {}, handle: async (s) => ({ say: `one:${s}` }) };
  const b2 = { pending: null, reset() {}, handle: async (s) => ({ say: `two:${s}` }) };
  const app = createApp({ logFile: null, discord: fakeDiscord(), brain: b1, code: "u".repeat(12) });
  const c1 = app.createCall(b1), c2 = app.createCall(b2);
  c1.relay([{ type: "delegation.created", item: { type: "delegation", id: "d1", user_bidi_turn_id: "T" } }]);
  c2.relay([{ type: "delegation.created", item: { type: "delegation", id: "d2", user_bidi_turn_id: "T" } }, { type: "turn.done", turn: { id: "T", role: "user", transcript: "read the hq room" } }]);
  await c2.chain;
  assert.equal(c1.outbox.length, 0);
  assert.equal(c2.outbox[0].delegation_item_id, "d2");
  assert.equal(c2.outbox[0].content[0].text, "two:read the hq room");
});

test("brain B (direct): same tools in-process, writes run at once, undo works, no Hermes", async () => {
  const { createDirectBrain, DIRECT_TOOLS } = await import("../src/direct-brain.mjs");
  const { TOOLS } = await import("../src/mcp.mjs");
  assert.deepEqual(DIRECT_TOOLS.map((t) => t.name), TOOLS.map((t) => t.name), "B has exactly A's tools");
  const d = fakeDiscord();
  d.deleteLast = async () => ({ undone: "post" });
  let n = 0;
  const respond = async ({ tools }) => {
    assert.ok(tools.find((t) => t.name === "propose_post"));
    n++;
    if (n === 1) return { text: "", calls: [{ call_id: "c1", name: "propose_post", arguments: JSON.stringify({ room: "general", text: "hello team" }) }] };
    return { text: "Posting that now.", calls: [] };
  };
  const b = createDirectBrain({ discord: d, respond, confirm: false });
  b.reset();
  const r = await b.handle("post hello team in general");
  assert.equal(d.writes.length, 1, "posted once, at once");
  assert.equal(d.writes[0][2], "hello team");
  assert.match(r.say, /^Posted/);
  assert.match((await b.handle("undo")).say, /took that post down/);
});

test("background talk and filler never reach the brain; real requests do", async () => {
  const { classifyTurn } = await import("../src/intent.mjs");
  // Real phrases from the call log that must be ignored
  for (const t of ["Hello", "Mhm", "Mm", "Oh, yeah", "Goodbye", "Uh, video", "Um", "Did I break another one", "And she passed away, not in a traditional sense", "No, I think so"])
    assert.equal(classifyTurn(t).accept, false, t);
  for (const t of ["What did I miss?", "undo", "what's happening in the discord controller thread", "post in general: shipping tonight", "Summarise the support forum", "tell me more", "any updates", "read the hq room", "What is waiting on me today?"])
    assert.equal(classifyTurn(t).accept, true, t);
});

test("an ignored turn gets a silent answer and never calls the brain", async () => {
  let calls = 0;
  const brain = { pending: null, reset() {}, handle: async () => { calls++; return { say: "x" }; } };
  const app = createApp({ logFile: null, discord: fakeDiscord(), brain, code: "t".repeat(12) });
  app.relay([
    { type: "delegation.created", item: { type: "delegation", id: "dM", user_bidi_turn_id: "M" } },
    { type: "turn.done", turn: { id: "M", role: "user", transcript: "Mhm" } },
  ]);
  await app.chain;
  assert.equal(calls, 0);
  assert.equal(app.outbox.length, 1);
  assert.equal(app.outbox[0].content[0].text, "");
  assert.ok(app.log.some((e) => e.type === "ignored" && e.text === "Mhm"));
});

test("a write the turn never asked for is held for a yes, even with instant posting", async () => {
  const { createHermesBrain } = await import("../src/hermes-brain.mjs");
  const fsm = await import("node:fs");
  const os = await import("node:os");
  const pf = `${os.tmpdir()}/dvc-pending-hold-${process.pid}.json`;
  const d = fakeDiscord();
  const ask = async () => { fsm.writeFileSync(pf, JSON.stringify({ tool: "post_message", args: { channel_id: "2", content: "x" }, summary: "Post x. Send it?" })); return { say: "", sessionId: "s" }; };
  const b = createHermesBrain({ discord: d, ask, pendingFile: pf, confirm: false });
  b.reset();
  const r = await b.handle("what do you think about the launch", { allowWrite: false });
  assert.equal(d.writes.length, 0, "nothing posted");
  assert.equal(r.say, "Post x. Send it?");
  assert.ok(b.pending);
  const { askedToWrite } = await import("../src/intent.mjs");
  assert.equal(askedToWrite("post in general: hello"), true);
  assert.equal(askedToWrite("what do you think about the launch"), false);
});

test("long answers are spoken in part with 'Want more?'; short ones whole", async () => {
  const { spokenPart } = await import("../src/server.mjs");
  const short = "One. Two. Three.";
  assert.deepEqual(spokenPart(short), { say: short, rest: "" });
  const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} has six words.`).join(" ");
  const p = spokenPart(long);
  assert.match(p.say, /Want more\?$/);
  assert.ok(p.say.split(" ").length <= 75);
  assert.ok(p.rest.length > 0);
  assert.equal((p.say.replace(" Want more?", "") + " " + p.rest).replace(/\s+/g, " "), long);
});

test("yes/no questions count only with a status word", async () => {
  const { classifyTurn } = await import("../src/intent.mjs");
  assert.equal(classifyTurn("Is anything waiting on me").accept, true);
  assert.equal(classifyTurn("Did anyone reply to the customer").accept, true);
  assert.equal(classifyTurn("Did you put the kettle on").accept, false);
  assert.equal(classifyTurn("Can you pass the salt").accept, false);
});

test("follow-ups right after an answer, and yes/no to a draft, always get through", async () => {
  const { classifyTurn } = await import("../src/intent.mjs");
  assert.equal(classifyTurn("Do you have anything").accept, false);
  assert.equal(classifyTurn("Do you have anything", { followUp: true }).accept, true);
  assert.equal(classifyTurn("No, what do you mean", { followUp: true }).accept, true);
  assert.equal(classifyTurn("yes", { pending: true }).accept, true);
  assert.equal(classifyTurn("I broke a glass", { followUp: true }).accept, false);
  assert.equal(classifyTurn("why do the voice app and the website chat give different answers?").accept, true);
});

test("V2: recent_activity works when called unbound (the bug that broke catch-up all day)", async () => {
  const { createHandlers } = await import("../src/mcp.mjs");
  const d = fakeDiscord();
  d.readMessages = async () => [{ author: "omo", at: "2026-10-04T00:00:00Z", text: "hi", url: "u" }];
  const h = createHandlers(d, "/tmp/dvc-x.json");
  const fn = h.recent_activity; // unbound, exactly as the MCP dispatcher calls it
  const r = await fn({ limit: 2 });
  assert.ok(Array.isArray(r));
});

test("V2: posts land in the ledger, a repeat within 60s is not posted twice, undo removes it", async () => {
  const { createHermesBrain } = await import("../src/hermes-brain.mjs");
  const { readLedger } = await import("../src/mcp.mjs");
  const fsm = await import("node:fs");
  const os = await import("node:os");
  const pf = `${os.tmpdir()}/dvc-v2-pend-${process.pid}.json`;
  const lf = `${os.tmpdir()}/dvc-v2-ledger-${process.pid}.json`;
  try { fsm.unlinkSync(lf); } catch {}
  const d = fakeDiscord();
  let n = 0;
  d.post = async (id, text) => { d.writes.push(["post", id, text]); return { messageId: `m${++n}` }; };
  d.lastAction = null;
  d.deleteLast = async () => ({ undone: "post" });
  const ask = async () => { fsm.writeFileSync(pf, JSON.stringify({ tool: "post_message", args: { channel_id: "2", content: "Any new signups?" }, summary: 'Post in thread "usage" in #sales: "Any new signups?". Send it?' })); return { say: "", sessionId: "s" }; };
  const b = createHermesBrain({ discord: d, ask, pendingFile: pf, confirm: false, ledgerFile: lf });
  b.reset();
  await b.handle("post any new signups in usage");
  assert.equal(readLedger(lf).length, 1);
  assert.equal(readLedger(lf)[0].room, 'thread "usage" in #sales');
  const r2 = await b.handle("post any new signups in usage");
  assert.equal(d.writes.length, 1, "duplicate blocked");
  assert.match(r2.say, /already sent that/);
  d.lastAction = { kind: "post", messageId: "m1" };
  await b.handle("undo");
  assert.equal(readLedger(lf).length, 0, "undo removes it from the ledger");
});

test("V2: watcher raises one update per new reply, skips our own webhook posts, never repeats", async () => {
  const { createWatcher, spokenUpdate } = await import("../src/watcher.mjs");
  const { appendLedger } = await import("../src/mcp.mjs");
  const fsm = await import("node:fs");
  const os = await import("node:os");
  const lf = `${os.tmpdir()}/dvc-v2-wl-${process.pid}.json`;
  const sf = `${os.tmpdir()}/dvc-v2-ws-${process.pid}.json`;
  for (const f of [lf, sf]) try { fsm.unlinkSync(f); } catch {}
  appendLedger({ kind: "post", channelId: "9", messageId: "100", room: 'thread "usage" in #baker', text: "Any new signups?" }, lf);
  let replies = [{ id: "101", webhook_id: "w", content: "my own post", timestamp: "t", author: { username: "Harry" } }, { id: "102", content: "Done: two new signups, Juan and Danielle.", timestamp: "t", author: { username: "omo" } }];
  const d = { call: async () => replies };
  const got = [];
  const w = createWatcher({ discord: d, ledgerFile: lf, stateFile: sf, onUpdate: (u) => got.push(u) });
  await w.tick();
  assert.equal(got.length, 1);
  assert.equal(got[0].author, "omo");
  assert.equal(got[0].done, true);
  replies = [];
  await w.tick();
  assert.equal(got.length, 1, "no repeat");
  assert.match(spokenUpdate(got[0]), /^Update in usage: omo says it's done\. Done: two new signups/);
});

test("V2: answers carry their Discord sources (room, link, media) for the phone cards", async () => {
  const { sourcesFrom } = await import("../src/direct-brain.mjs");
  const cards = sourcesFrom("read_room", { room: "#general", messages: [{ author: "omo", at: "t", text: "video ready", url: "https://discord.com/channels/g/c/m", media: [{ kind: "video", url: "https://cdn/x.mp4" }] }] });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].url, "https://discord.com/channels/g/c/m");
  assert.equal(cards[0].media[0].kind, "video");
});

test("V2: a message with a video is shown as a card even if it is not among the newest three", async () => {
  const { sourcesFrom } = await import("../src/direct-brain.mjs");
  const msgs = [{ author: "omo", at: "t", text: "v5 cut", url: "u0", media: [{ kind: "video", url: "x.mp4" }] }, ...[1, 2, 3, 4].map((i) => ({ author: "omo", at: "t", text: `log ${i}`, url: `u${i}` }))];
  const cards = sourcesFrom("read_room", { room: "#vid", messages: msgs });
  assert.ok(cards.some((c) => c.media?.[0]?.kind === "video"));
});

test("V2: watcher never replays history for requests made before it started", async () => {
  const { createWatcher } = await import("../src/watcher.mjs");
  const { appendLedger } = await import("../src/mcp.mjs");
  const fsm = await import("node:fs");
  const os = await import("node:os");
  const lf = `${os.tmpdir()}/dvc-v2-old-${process.pid}.json`;
  const sf = `${os.tmpdir()}/dvc-v2-olds-${process.pid}.json`;
  for (const f of [lf, sf]) try { fsm.unlinkSync(f); } catch {}
  appendLedger({ kind: "post", channelId: "9", messageId: "100", room: "#x", text: "old ask", at: new Date(Date.now() - 3600e3).toISOString() }, lf);
  let page = [{ id: "105", content: "old reply", timestamp: "t", author: { username: "omo" } }];
  const d = { call: async (m, url) => (/limit=1(?!\d)/.test(url) ? page.slice(-1) : page.filter((x) => BigInt(x.id) > BigInt(/after=(\d+)/.exec(url)?.[1] || 0))) };
  const got = [];
  const w = createWatcher({ discord: d, ledgerFile: lf, stateFile: sf, onUpdate: (u) => got.push(u) });
  await w.tick(); await w.tick();
  assert.equal(got.length, 0, "old replies are not news");
  page.push({ id: "106", content: "Finished the audit.", timestamp: "t", author: { username: "omo" } });
  await w.tick();
  assert.equal(got.length, 1);
  assert.equal(got[0].text, "Finished the audit.");
});

test("V2: agent heartbeat lines are not live updates", async () => {
  const { createWatcher } = await import("../src/watcher.mjs");
  const { appendLedger } = await import("../src/mcp.mjs");
  const fsm = await import("node:fs");
  const os = await import("node:os");
  const lf = `${os.tmpdir()}/dvc-v2-hb-${process.pid}.json`, sf = `${os.tmpdir()}/dvc-v2-hbs-${process.pid}.json`;
  for (const f of [lf, sf]) try { fsm.unlinkSync(f); } catch {}
  appendLedger({ kind: "post", channelId: "9", messageId: "100", room: "#x", text: "ask" }, lf);
  const msgs = [{ id: "101", content: "⏩ Picked up in the current run, iteration 38/800", timestamp: "t", author: { username: "omo" } }, { id: "102", content: "Finished the audit.", timestamp: "t", author: { username: "omo" } }];
  const got = [];
  await createWatcher({ discord: { call: async () => msgs }, ledgerFile: lf, stateFile: sf, onUpdate: (u) => got.push(u) }).tick();
  assert.deepEqual(got.map((u) => u.text), ["Finished the audit."]);
});

test("V2: request status is honest (working vs replied vs done) and phone text has no terminal noise", async () => {
  const { isProgress, cleanForPhone } = await import("../src/mcp.mjs");
  assert.ok(isProgress("⏳ Working — 6 min — iteration 21/800, terminal"));
  assert.ok(isProgress("📚 Reading skill whatsapp-ad-conversion-optimisation"));
  assert.ok(!isProgress("RapidWorksheet was paused on 30 Sep."));
  const t = cleanForPhone("Here is the plan.\n```\ncd /home/user/x\n```\n(×2)\n📚 Reading skill baker\nsaved to /home/user/.agent/a.json ok");
  assert.ok(!/```|\/home\/|Reading skill|×2/.test(t), t);
  assert.match(t, /Here is the plan\./);
});

test("V2: every agent progress style is noise, real sentences are not", async () => {
  const { isProgress } = await import("../src/mcp.mjs");
  for (const t of ["✍️ Writing", "🔀 Delegating list  📖 Reading STATUS.md", "> 💭 **Reasoning:** > The busy leases", "📖 Reading STATUS.md"]) assert.ok(isProgress(t), t);
  for (const t of ["No new users, chats or signups since my 11:16 update.", "I agree, \"Hey Baker!\" is probably the wrong message.", "✅ Merged and verified."]) assert.ok(!isProgress(t), t);
});

test("lock-screen ping: only Done/Needs-you, never twice per room in 2 min, not during a call, not if already mentioned", async () => {
  const { createNotifier } = await import("../src/watcher.mjs");
  const posts = [];
  const discord = { call: async (m, url, body) => { posts.push({ url, body }); return { id: `n${posts.length}` }; } };
  let live = false, t = 1e9;
  const notify = createNotifier({ discord, ownerId: "42", isLive: () => live, now: () => t });
  const u = (o) => ({ id: "m1", channelId: "c1", author: "omo", text: "Finished the audit. Details below.", done: true, ...o });
  assert.equal((await notify(u({ done: false }))).sent, false, "plain reply: no ping");
  assert.equal((await notify(u({ mentionsOwner: true }))).sent, false, "already mentioned");
  live = true; assert.equal((await notify(u())).sent, false, "live call: voice says it"); live = false;
  const r = await notify(u());
  assert.equal(r.sent, true);
  assert.match(posts[0].body.content, /^🔔 <@42> omo finished: Finished the audit\.$/);
  assert.deepEqual(posts[0].body.allowed_mentions, { users: ["42"] });
  assert.equal(posts[0].body.message_reference.message_id, "m1");
  assert.equal((await notify(u({ id: "m2" }))).sent, false, "same room within 2 min");
  t += 121e3; assert.equal((await notify(u({ id: "m3", done: false, needsYou: true }))).sent, true);
  assert.match(posts[1].body.content, /needs a decision from you/);
});

test("watcher ignores its own pings and the owner's own messages (no loop)", async () => {
  const { createWatcher } = await import("../src/watcher.mjs");
  const { appendLedger } = await import("../src/mcp.mjs");
  const fsm = await import("node:fs");
  const os = await import("node:os");
  const lf = `${os.tmpdir()}/dvc-n-l-${process.pid}.json`, sf = `${os.tmpdir()}/dvc-n-s-${process.pid}.json`;
  for (const f of [lf, sf]) try { fsm.unlinkSync(f); } catch {}
  appendLedger({ kind: "post", channelId: "9", messageId: "100", room: "#x", text: "ask" }, lf);
  const msgs = [
    { id: "101", content: "🔔 <@42> omo finished: x", timestamp: "t", author: { id: "7", username: "omo" } },
    { id: "102", content: "thanks, looks good", timestamp: "t", author: { id: "42", username: "harry" } },
    { id: "103", content: "Done.", timestamp: "t", author: { id: "7", username: "omo" } },
  ];
  const got = [];
  await createWatcher({ discord: { call: async () => msgs }, ledgerFile: lf, stateFile: sf, ownerId: "42", onUpdate: (u) => got.push(u) }).tick();
  assert.deepEqual(got.map((u) => u.id), ["103"]);
});
