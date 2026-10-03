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
    { type: "turn.done", turn: { id: "A", role: "user", transcript: "question A" } },
  ]);
  await new Promise((r) => setTimeout(r, 5));
  // the user interrupts with question B before A is answered; GPT-Live drops dA.
  app.relay([
    { type: "error", error: { message: "Unknown delegation item id: dA" } },
    { type: "turn.created", turn: { id: "B", role: "user" } },
    { type: "delegation.created", item: { type: "delegation", id: "dB", user_bidi_turn_id: "B" } },
    { type: "turn.done", turn: { id: "B", role: "user", transcript: "question B" } },
  ]);
  gates["question A"]();
  await new Promise((r) => setTimeout(r, 5));
  // A's answer must NOT go to B's delegation.
  assert.equal(app.outbox.length, 1, "A's answer still goes to A's own delegation id");
  assert.equal(app.outbox[0].delegation_item_id, "dA");
  app.outbox.length = 0;
  gates["question B"]();
  await app.chain;
  assert.equal(app.outbox.length, 1);
  assert.equal(app.outbox[0].delegation_item_id, "dB");
  assert.equal(app.outbox[0].content[0].text, "answer to question B");
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
  c2.relay([{ type: "delegation.created", item: { type: "delegation", id: "d2", user_bidi_turn_id: "T" } }, { type: "turn.done", turn: { id: "T", role: "user", transcript: "hi" } }]);
  await c2.chain;
  assert.equal(c1.outbox.length, 0);
  assert.equal(c2.outbox[0].delegation_item_id, "d2");
  assert.equal(c2.outbox[0].content[0].text, "two:hi");
});
