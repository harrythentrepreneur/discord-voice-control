# V2 — audit and design

Source: `.local/calls.jsonl`, 3 Oct 19:15 → 4 Oct 03:13 UTC (712 events, 42 calls, 170 spoken or
typed turns, 31 writes), plus the discord-voice profile's `logs/errors.log`.

## What Harry actually uses it for (the vision)

Hands-free **operator console for an agent-run company**, used while doing other things ("we can do
it while doing the dishes", "I just woke up, can you update me", "I'm just in the shower").
The pattern is a loop:

1. **Catch up** — "any updates", "what's new in X", "how's the split test", "the Minecraft video".
2. **Delegate** — "send a message to the controller thread: …", "start a thread in hq for …",
   "hand it to the launch video director", "make threads for each, then Omo will work on that".
3. **Track** — "did we actually send everything and make the threads?", "I don't see some of the
   ones you made", "am I following along?", "update me on the eight things we made".
4. **See** — "show me the relevant things as you talk about it" (the visualizer request, 02:55).

Voice is a control layer over the existing Discord structure ("now it has a really good structure,
so this time it won't get lost").

## What went wrong

| # | Finding | Evidence |
|---|---|---|
| 1 | **The catch-up tool was broken all day.** `recent_activity` called `this.catch_up`, but the MCP dispatcher calls the handler unbound, so it always threw. Brain A fell back to reading rooms one by one. | 8+ `Cannot read properties of undefined (reading 'catch_up')` in profile errors.log; A replies "the catch-up tool errored" 5 times; A p90 30.7 s |
| 2 | **No memory of what was delegated.** "Did we send everything?" took 30–41 s and three re-asks, because the brain had to rediscover its own posts. | 01:38–01:39 |
| 3 | **Context is lost between calls** ("I don't have the earlier part of the conversation"). Each call is a fresh session, and calls drop often. | 20:15:02, 42 calls in 8 h |
| 4 | **Household talk was treated as requests** (broken glass, mum, church) → answers, and once "Done." to "I wanna do some dishes". | 01:37–02:08 (fixed in v1.1 by the intent filter) |
| 5 | **Answers mention things he can't see.** He asked for the visualizer: show the actual messages and media while talking. | 02:55–02:57 |
| 6 | **Created threads are invisible to him.** "I don't see some of the ones you made"; "am I following along?" The voice app cannot add him to threads it creates. | 01:38, 03:02 |
| 7 | **Duplicate/garbled posts.** "Huh? I need it" + "Uh, video" produced two posts 5 s apart. | 01:29:19 / 01:29:24 |
| 8 | **A is slow and long, B is fast but shallower.** A p50 8.4 s (26 answers), B p50 4.7 s (70 answers). Harry used B ~3× more. | log-report |
| 9 | **Calls drop** (screen off / wake lock refused 33 times) and the page lost its conversation state. | client events |
| 10 | A page error in the old UI (`textContent` of null) ended a call. | 02:42:27 |

## V2 design

**One brain path, fast and grounded:** brain B (direct, in-process tools) becomes the default, with
the fixed catch-up. A (Hermes) stays selectable for the split test.

**Work ledger (new).** Every post or thread the app makes is recorded in `.local/ledger.json` with
room, link, text, time and whether anyone replied since. New tools:
- `my_requests` — "what did we send / did everything go through / what's the status of the things we
  made": one call reads the ledger and checks each item's replies live.
- Catch-up includes "replies to your requests" first.

**Conversation memory across calls.** The brain keeps one rolling conversation per device (last 30
turns, 6 h), so "that thread", "him", "the split test" survive a dropped call.

**Visual cards (the visualizer).** Every answer carries the Discord sources it used: room, author,
time, a snippet, a link that opens the message in Discord, and any image or video attachments shown
inline. The phone shows them under the answer as tappable cards, so what is spoken is also visible.

**Follow what you start.** Threads created by voice open with a mention of Harry, which adds him to
the thread so it appears in his sidebar and notifies him.

**Duplicate guard.** The same room plus near-identical text within 60 s is not posted twice.

**Phone UX.**
- A "Your requests" sheet: every item the app sent, with live status (waiting, replied) and a link.
- Answer cards with sources, and media.
- The call survives screen-off where iOS allows. When it drops, one tap resumes it, and the
  conversation is kept.
