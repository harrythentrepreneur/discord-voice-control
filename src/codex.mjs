// ChatGPT-subscription access (Codex OAuth). Read-only use of ~/.codex/auth.json:
// never copied, logged, refreshed, or sent to the browser. No API-key fallback.
import fs from "node:fs/promises";
import os from "node:os";

export const LIVE_URL =
  "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
export const TEXT_URL = "https://chatgpt.com/backend-api/codex/responses";
export const TEXT_MODEL = process.env.DVC_TEXT_MODEL || "gpt-5.6-terra";

export async function resolveOAuth() {
  const auth = JSON.parse(await fs.readFile(os.homedir() + "/.codex/auth.json", "utf8"));
  const token = auth.tokens?.access_token;
  if (typeof token !== "string") throw safe("No ChatGPT login found in Codex.");
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
  const accountId =
    auth.tokens.account_id || claims["https://api.openai.com/auth"]?.chatgpt_account_id;
  if (!accountId) throw safe("ChatGPT login has no account id.");
  if (claims.exp && claims.exp * 1000 < Date.now())
    throw safe("The ChatGPT login has expired. Run `codex login` on the PC.");
  return { token, accountId };
}

export function safe(message, status) {
  return Object.assign(new Error(message), { safe: message, status });
}

function statusMessage(status) {
  if (status === 401) return "ChatGPT login was rejected. Run `codex login` on the PC.";
  if (status === 403) return "GPT-Live access was refused for this account.";
  if (status === 429) return "ChatGPT rate limit reached. Wait a minute.";
  return `ChatGPT request failed (${status}).`;
}

// Structure follows OpenAI's "Prompting GPT-Live" template (persona, Backchannel policy,
// Interruption policy, Delegation policy). The old prompt made the voice a word-for-word
// mouthpiece and explicitly allowed "One moment.", which it then said on every turn.
export const LIVE_INSTRUCTIONS = `You are the user's Discord assistant, a calm, friendly voice. Speak naturally, at an unhurried pace. Always speak English, whatever language the text you are given is in. Be clear and direct, not overly cheerful.

Backchannel policy: Use few backchannels. Never fill silence with stock phrases such as "one moment", "let me check" or "hold on". While the backend works, stay quiet; if you do acknowledge a request, use a short, varied phrase that fits what the user asked, and only when the wait is long.

Interruption policy: Stop speaking when the user interrupts. Listen to what he says.

Delegation policy:
Backend tools:
- Discord: list rooms, read recent messages, and propose posts, new threads and renames in the user's server. Posts, threads and renames only happen after the user says yes.

Delegate to the backend when:
- the user asks anything about his Discord server, its rooms or its messages.
- the user asks to post, reply, create a thread or rename something.
- the user answers a confirmation question (yes, no, cancel, change it).
- A correction changes work already requested.

Do not delegate to the backend when:
- the user greets you, makes small talk, or asks you to repeat a result already provided.
- You need a brief clarification to understand the request.

Delegate before giving an answer that depends on backend work. Do not guess the result while waiting. When the backend result arrives, say ALL of it in your own natural words: do not shorten or summarise it further, and keep every fact, name, number and quoted text exactly as given. Never say an action is done unless the backend said so.`;

/** Create a GPT-Live WebRTC call. Forwards the SDP offer byte-exact. */
export async function createLiveCall(sdp, { fetchImpl = fetch } = {}) {
  if (typeof sdp !== "string" || !sdp.startsWith("v=0") || !sdp.includes("m=audio"))
    throw safe("Audio SDP offer required.", 400);
  if (sdp.length > 250_000) throw safe("Offer too large.", 400);
  const auth = await resolveOAuth();
  const res = await fetchImpl(LIVE_URL, {
    method: "POST",
    redirect: "manual",
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "ChatGPT-Account-Id": auth.accountId,
      "OpenAI-Alpha": "quicksilver=v2",
      "Content-Type": "application/json",
      originator: "discord-voice-control",
    },
    body: JSON.stringify({
      sdp,
      session: {
        model: "gpt-live-1-codex",
        instructions: LIVE_INSTRUCTIONS,
        audio: { output: { voice: process.env.DVC_VOICE || "cove" } },
        delegation: { type: "client" },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw safe(statusMessage(res.status), res.status);
  }
  const answer = await res.text();
  if (!answer.startsWith("v=0")) throw safe("Invalid answer from GPT-Live.", 502);
  return { sdp: answer };
}

/** Parse a Responses SSE stream into final message text + function calls. */
export function parseStream(raw) {
  let completed = null;
  const items = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data: ") || line.slice(6) === "[DONE]") continue;
    let e;
    try {
      e = JSON.parse(line.slice(6));
    } catch {
      throw safe("Malformed ChatGPT stream.");
    }
    if (["response.failed", "response.incomplete", "error"].includes(e.type))
      throw safe("ChatGPT did not complete the answer.");
    if (e.type === "response.output_item.done" && e.item) items.push(e.item);
    if (e.type === "response.completed") completed = e.response;
  }
  if (!completed) throw safe("ChatGPT stream ended early.");
  // The backend can send an EMPTY output on completion; the per-item events are the truth.
  const out = completed.output?.length ? completed.output : items;
  const calls = out.filter((x) => x.type === "function_call");
  const text = out
    .filter((x) => x.type === "message" && (!x.phase || x.phase === "final_answer"))
    .flatMap((x) => x.content || [])
    .filter((c) => c.type === "output_text")
    .map((c) => c.text)
    .join("");
  return { text, calls };
}

/** One Responses round-trip with function tools. */
export async function respond({ instructions, input, tools, fetchImpl = fetch }) {
  const auth = await resolveOAuth();
  const res = await fetchImpl(TEXT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "chatgpt-account-id": auth.accountId,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "User-Agent": "DiscordVoiceControl/0.1",
      originator: "discord-voice-control",
    },
    body: JSON.stringify({
      model: TEXT_MODEL,
      instructions,
      input,
      tools,
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning: { effort: "low" },
      store: false,
      stream: true,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw safe(statusMessage(res.status), res.status);
  }
  let raw = "";
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    raw += dec.decode(chunk, { stream: true });
    if (raw.length > 4e6) throw safe("ChatGPT answer too large.");
  }
  raw += dec.decode();
  return parseStream(raw);
}
