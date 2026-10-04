// Summarise the durable call log: calls, what the user said, replies, writes, errors and phone events.
// Usage: node scripts/log-report.mjs [hours=24]
import fs from "node:fs";

const hours = Number(process.argv[2] || 24);
const since = Date.now() - hours * 3600e3;
const files = [".local/calls.jsonl.1", ".local/calls.jsonl"].filter((f) => fs.existsSync(f));
const rows = files
  .flatMap((f) => fs.readFileSync(f, "utf8").split("\n"))
  .filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((e) => e && Date.parse(e.at) >= since);

const count = (t, k) => rows.filter((e) => e.type === t && (!k || e.kind === k)).length;
const writes = rows.filter((e) => e.type === "write");
const errors = rows.filter((e) => e.type === "error" || (e.type === "client" && /error|failed|blocked|ended/.test(e.kind)));
const failedWrites = rows.filter((e) => e.type === "reply" && e.action === "failed");
const unclear = rows.filter((e) => e.type === "reply" && /was that a yes/i.test(e.text || ""));

console.log(`Last ${hours}h: ${count("status")} calls, ${count("heard")} requests, ${writes.length} Discord changes, ${failedWrites.length} failed changes, ${unclear.length} unclear yes/no, ${errors.length} problems`);
console.log(`Phone: screen-off ${count("client", "screen-off")}, mic muted ${count("client", "mic-muted")}, mic ended ${count("client", "mic-ended")}, connection events ${count("client", "connection")}`);
if (errors.length) {
  console.log("\nProblems:");
  for (const e of errors.slice(-15)) console.log(` ${e.at.slice(5, 19)} ${e.kind || e.type}: ${(e.detail || e.text || "").slice(0, 160)}`);
}
console.log("\nTimeline (last 40):");
for (const e of rows.slice(-40)) {
  const what = e.type === "client" ? `[phone] ${e.kind} ${e.text || ""}` : e.type === "write" ? `[WRITE] ${e.tool} -> ${e.channel}` : `${e.type}: ${e.text || ""}`;
  console.log(` ${e.at.slice(11, 19)} ${what.replace(/\s+/g, " ").slice(0, 170)}`);
}

// Split test: speed and length per brain (replies tagged with brain + ms).
{
  const fs2 = await import("node:fs");
  const rows = fs2.readFileSync(new URL("../.local/calls.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.type === "reply" && e.brain && e.ms != null);
  const by = {};
  for (const e of rows) (by[e.brain] ||= []).push(e);
  for (const [b, list] of Object.entries(by)) {
    const ms = list.map((e) => e.ms).sort((x, y) => x - y);
    const med = ms[Math.floor(ms.length / 2)];
    const words = Math.round(list.reduce((n, e) => n + (e.words || 0), 0) / list.length);
    console.log(`brain ${b}: ${list.length} answers, median ${(med / 1000).toFixed(1)}s, slowest ${(ms.at(-1) / 1000).toFixed(1)}s, avg ${words} words`);
  }
}
