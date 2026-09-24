import { hasKv, kv } from "./backend.js";

/**
 * Per-chat drafting state: the current brief, the three variants, which one
 * is selected, and what free-text reply is being waited on. This used to be
 * a plain in-memory Map, which is fine for a single long-running process
 * (local polling) but doesn't survive across separate serverless
 * invocations, so the webhook function needs it in KV instead.
 */
const DEFAULT_SESSION = { brief: "", understanding: "", variants: [], index: 0, awaiting: null, field: null };

// A session lives about as long as a conversation does; a week of inactivity
// is long enough to resume a thread and short enough not to accumulate forever.
const TTL_SECONDS = 60 * 60 * 24 * 7;

const memory = new Map();

function keyFor(chatId) {
  return `session:${chatId}`;
}

export async function getSession(chatId) {
  if (!hasKv) {
    if (!memory.has(chatId)) memory.set(chatId, { ...DEFAULT_SESSION });
    return memory.get(chatId);
  }
  const raw = await kv.get(keyFor(chatId));
  return raw ? { ...DEFAULT_SESSION, ...raw } : { ...DEFAULT_SESSION };
}

/** Call this after mutating a session object, even under the in-memory
 * backend - it's a no-op there, but the two backends must be interchangeable. */
export async function setSession(chatId, session) {
  if (!hasKv) {
    memory.set(chatId, session);
    return;
  }
  await kv.set(keyFor(chatId), session, { ex: TTL_SECONDS });
}

export async function clearSession(chatId) {
  if (!hasKv) {
    memory.delete(chatId);
    return;
  }
  await kv.del(keyFor(chatId));
}
