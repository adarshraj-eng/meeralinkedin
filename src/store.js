import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { hasKv, kv } from "./backend.js";

/**
 * One user record per Telegram user: profile, voice samples, recent history,
 * approved drafts, and the daily-nudge schedule.
 *
 * Two backends, chosen once via hasKv (see backend.js):
 *  - filesystem: one JSON file per user, read-modify-write. Used locally and
 *    in tests, and fine for any always-on host that isn't serverless.
 *  - Vercel KV: same shape, stored under `user:{id}`, with a `users` set so
 *    the scheduler can sweep everyone. Needed once storage has to survive
 *    across separate function invocations.
 * Writes are serialised per user (within a single process) so concurrent
 * updates don't clobber each other.
 */

const DEFAULT_USER = {
  profile: {
    name: "",
    role: "",
    company: "",
    audience: "",
    topics: "",
    tone: "",
    goals: "",
    avoid: "",
  },
  voiceSamples: [],
  history: [], // recent {role, content} turns, for context across messages
  drafts: [], // approved posts
  auto: null, // filled from DEFAULT_AUTO on load
};

export const DEFAULT_AUTO = {
  enabled: false,
  time: "09:00", // local HH:MM in the user's timezone
  tz: "Asia/Kolkata",
  weekdaysOnly: true,
  lastSentDate: "", // YYYY-MM-DD in the user's timezone, so we fire once a day
  chatId: null,
};

export const MAX_HISTORY_TURNS = 16;
export const MAX_VOICE_SAMPLES = 8;

const writeQueues = new Map();

function withDefaults(parsed) {
  return {
    ...structuredClone(DEFAULT_USER),
    ...parsed,
    profile: { ...DEFAULT_USER.profile, ...(parsed.profile || {}) },
    auto: { ...DEFAULT_AUTO, ...(parsed.auto || {}) },
  };
}

// --- filesystem backend -----------------------------------------------------

function fileFor(userId) {
  return path.join(config.dataDir, `${userId}.json`);
}

async function fsInit() {
  await fs.mkdir(config.dataDir, { recursive: true });
}

async function fsLoad(userId) {
  try {
    const raw = await fs.readFile(fileFor(userId), "utf8");
    return withDefaults(JSON.parse(raw));
  } catch (err) {
    if (err.code === "ENOENT") return withDefaults({});
    throw err;
  }
}

async function fsSave(userId, user) {
  const tmp = `${fileFor(userId)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(user, null, 2), "utf8");
  await fs.rename(tmp, fileFor(userId));
}

async function fsListIds() {
  try {
    const files = await fs.readdir(config.dataDir);
    return files.filter((f) => f.endsWith(".json")).map((f) => Number(f.replace(/\.json$/, "")));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

// --- Vercel KV backend -------------------------------------------------------

function userKey(userId) {
  return `user:${userId}`;
}

async function kvLoad(userId) {
  const parsed = (await kv.get(userKey(userId))) || {};
  return withDefaults(parsed);
}

async function kvSave(userId, user) {
  await kv.set(userKey(userId), user);
  await kv.sadd("users", String(userId));
}

async function kvListIds() {
  const ids = await kv.smembers("users");
  return (ids || []).map(Number);
}

// --- public API ---------------------------------------------------------

export async function initStore() {
  if (!hasKv) await fsInit();
}

export async function loadUser(userId) {
  return hasKv ? kvLoad(userId) : fsLoad(userId);
}

/** Read-modify-write under a per-user lock. `mutate` receives the user record. */
export function updateUser(userId, mutate) {
  const prev = writeQueues.get(userId) || Promise.resolve();
  const next = prev.then(async () => {
    const user = await loadUser(userId);
    await mutate(user);
    await (hasKv ? kvSave(userId, user) : fsSave(userId, user));
    return user;
  });
  writeQueues.set(
    userId,
    next.catch(() => {}),
  );
  return next;
}

/** Every user we've ever stored, for the scheduler to sweep. */
export async function listUserIds() {
  return hasKv ? kvListIds() : fsListIds();
}
