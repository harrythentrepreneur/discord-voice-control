// Is a spoken turn meant for the app? The mic is open the whole call, so it hears filler ("Mhm",
// "Oh, yeah") and people in the room. Those must not reach the brain: it answers everything, and
// posts go out at once. Rules, cheapest first:
//  - filler / very short turns are ignored, unless they are a known short command ("undo", "stop");
//  - anything addressed to the app or mentioning Discord things is accepted;
//  - other turns are accepted only if they look like a request (question or imperative).
const FILLER = /^(?:u+m+|u+h+|h?m+|mhm+|ah+|oh+|eh+|er+m*|hmm+|okay|ok|yeah|yep|yes|no|nope|right|sure|cool|nice|wow|oh yeah|oh okay|hello|hi|hey|bye|goodbye|thanks|thank you|sorry|what|huh)$/i;
const SHORT_COMMANDS = /^(?:undo(?: that)?|stop|cancel|repeat(?: that)?|again|say (?:that|it) again|shorter|more|tell me more|go on|continue|post it|send it|scratch that)$/i;
const DISCORD = /\b(?:discord|channel|channels|thread|threads|forum|room|rooms|post|posts|message|messages|reply|react|reaction|pin|pinned|rename|server|catch me up|catch up|what did i miss|updates?|summari[sz]e|summary|read|tell (?:them|him|her)|hq|case|cases|pipeline|support|approvals?|dev|ads?|omo|baker|phonics|rapid|undo)\b/i;
// Wh-questions and imperatives read as requests. Yes/no openers ("did I break another one?") are
// how people talk to each other, so they count only with a Discord or status word.
const REQUEST = /^(?:what|what's|whats|who|where|when|which|how|why|any|anything|give|show|tell|read|check|find|look|open|post|send|reply|write|start|create|make|rename|pin|react|summari[sz]e|catch|list)\b/i;
// After "can you…": an app action verb. "Can you pass the salt" stays out.
const REQUEST_VERB = /^(?:check|read|look|go|open|find|get|give|show|tell|update|summari[sz]e|catch|list|send|post|reply|write|start|create|make|rename|pin|react|share|let|see|compare|explain|search|scroll|repeat|say|change|add|move|ask|ping|follow)\b/;
const STATUS = /\b(?:waiting|new|latest|happening|happened|anyone|anybody|someone|today|yesterday|this morning|tonight|blocked|stuck|done|finished|shipped|merged|signups?|sales|customers?)\b/i;

export function normalise(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
}

// Spoken lead-ins ("Okay, um, hey, so can you…") are stripped before judging the request.
const LEAD = /^(?:(?:okay|ok|kay|'kay|so|and|um+|uh+|mm+|hmm+|hey|hi|hello|right|alright|yeah|yes|also|then|now|well|wait|actually|nice|cool|great|please|and then|and also|omo|discord voice)\s+)+/;
const POLITE = /^(?:can|could|would|will) you (?:please |just |also )?|^(?:i (?:need|want) you to|i'd like you to|please|let's|i wanna|i want to) /;

// opts.followUp: the app answered moments ago, so a short question is probably to it.
// opts.pending: a draft waits for yes/no, so every turn goes to the brain.
export function classifyTurn(text, { followUp = false, pending = false } = {}) {
  if (pending && String(text || "").trim()) return { accept: true, reason: "answering a draft" };
  const t = normalise(text).replace(LEAD, "").replace(LEAD, "");
  if (!t) return { accept: false, reason: "empty" };
  const words = t.split(" ");
  if (SHORT_COMMANDS.test(t)) return { accept: true, reason: "command" };
  if (followUp && words.length >= 2 && /^(?:what|why|how|who|where|which|when|do|does|did|are|is|was|can|could|and|no what|so what|more|any|anything|wh)\b/.test(t)) return { accept: true, reason: "follow-up" };
  if (FILLER.test(t) || FILLER.test(words.slice(0, 2).join(" ")) && words.length <= 2) return { accept: false, reason: "filler" };
  if (words.length <= 2 && !DISCORD.test(t)) return { accept: false, reason: "too short" };
  if (DISCORD.test(t)) return { accept: true, reason: "discord" };
  const core = t.replace(POLITE, "");
  if (core !== t && REQUEST_VERB.test(core)) return { accept: true, reason: "polite request" };
  if (REQUEST.test(t) && words.length >= 3) return { accept: true, reason: "request" };
  if (/^(?:is|are|was|were|did|do|does|can|could|would|will|should|has|have)\b/.test(t) && STATUS.test(t) && words.length >= 3) return { accept: true, reason: "status question" };
  return { accept: false, reason: "not a request" };
}

// A post/thread/etc. goes out at once ONLY if the turn itself asked for a write. Otherwise the
// brain's draft is held for a spoken or tapped yes. Protects against a stray sentence posting.
const WRITE_ASK = /\b(?:post|send|reply|respond|tell (?:them|him|her|everyone)|write|say (?:to|in)|message|announce|react|pin|start (?:a )?(?:thread|post)|create|new (?:thread|channel|post)|rename|ping|let (?:them|him|her) know|share)\b/i;
export function askedToWrite(text) {
  return WRITE_ASK.test(normalise(text));
}
