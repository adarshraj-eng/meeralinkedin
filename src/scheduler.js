import { InlineKeyboard } from "grammy";
import { listUserIds, loadUser, updateUser } from "./store.js";
import { suggestIdeas } from "./llm.js";
import { escapeHtml } from "./ui.js";
import { hasKv, kv } from "./backend.js";

/**
 * The daily nudge.
 *
 * Locally (long polling), startScheduler ticks every minute in-process, same
 * as before. On Vercel there is no long-running process to tick, so a Vercel
 * Cron job hits api/cron.js on a schedule and it calls runSweepOnce directly.
 * Either way the sweep logic - and the isDue arithmetic - is identical: we
 * check stored users and fire for anyone whose local clock has reached their
 * chosen time and who hasn't been sent anything yet today. Storing
 * lastSentDate (rather than a timer) means a restart, a laptop sleep, a cold
 * start, or a missed tick doesn't skip or double-send.
 */

const TICK_MS = 60_000;

// Pending idea batches, keyed by chat, so the "which idea did you tap" buttons
// stay tiny. Same dual-backend story as store.js: in-memory when there's one
// long-running process, KV when the reply might land on a different
// serverless invocation than the one that sent the ideas.
const IDEAS_TTL_SECONDS = 60 * 60 * 48;
const memoryIdeas = new Map();

function ideasKey(chatId) {
  return `ideas:${chatId}`;
}

export async function getPendingIdeas(chatId) {
  if (!hasKv) return memoryIdeas.get(chatId) || null;
  return (await kv.get(ideasKey(chatId))) || null;
}

export async function setPendingIdeas(chatId, ideas) {
  if (!hasKv) {
    memoryIdeas.set(chatId, ideas);
    return;
  }
  await kv.set(ideasKey(chatId), ideas, { ex: IDEAS_TTL_SECONDS });
}

export async function clearPendingIdeas(chatId) {
  if (!hasKv) {
    memoryIdeas.delete(chatId);
    return;
  }
  await kv.del(ideasKey(chatId));
}

function localParts(tz, now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: parts.weekday, // Mon, Tue, ...
  };
}

function isDue(auto, now = new Date()) {
  if (!auto?.enabled || !auto.chatId) return false;

  let here;
  try {
    here = localParts(auto.tz, now);
  } catch {
    here = localParts("UTC", now); // bad tz string saved - don't crash the sweep
  }

  if (auto.weekdaysOnly && ["Sat", "Sun"].includes(here.weekday)) return false;
  if (here.date === auto.lastSentDate) return false;

  const [h, m] = auto.time.split(":").map(Number);
  const target = h * 60 + m;

  // Fire at or after the target, but only within a 2h window, so a bot that was
  // offline all morning doesn't send yesterday's nudge at 11pm.
  return here.minutes >= target && here.minutes < target + 120;
}

export function ideasKeyboard(ideas) {
  const kb = new InlineKeyboard();
  ideas.forEach((idea, i) => {
    kb.text(`${i + 1}. ${idea.label}`, `idea:${i}`).row();
  });
  kb.text("Not today", "idea:skip");
  return kb;
}

export function renderIdeas(ideas) {
  const lines = ["<b>Three things you could post about today</b>", ""];
  ideas.forEach((idea, i) => {
    lines.push(`<b>${i + 1}. ${escapeHtml(idea.label)}</b>`);
    lines.push(escapeHtml(idea.pitch));
    lines.push("");
  });
  lines.push("<i>Tap one and I'll draft it. Or just tell me something else.</i>");
  return lines.join("\n");
}

/** Generate and send the nudge for one user. Exported so /ideas can reuse it. */
export async function sendIdeas(bot, userId, chatId) {
  const user = await loadUser(userId);
  const recentPosts = user.drafts.slice(-6).map((d) => d.text);

  const ideas = await suggestIdeas({ profile: user.profile, recentPosts });
  if (!ideas?.length) return false;

  await setPendingIdeas(chatId, ideas);
  await bot.api.sendMessage(chatId, renderIdeas(ideas), {
    parse_mode: "HTML",
    reply_markup: ideasKeyboard(ideas),
  });
  return true;
}

/** One pass over every stored user, firing the nudge for whoever is due.
 * Called every minute by startScheduler locally, and once per invocation by
 * api/cron.js on Vercel. */
export async function runSweepOnce(bot) {
  let ids;
  try {
    ids = await listUserIds();
  } catch (err) {
    console.error("scheduler: could not list users", err);
    return;
  }

  for (const userId of ids) {
    try {
      const user = await loadUser(userId);
      if (!isDue(user.auto)) continue;

      // Claim the slot before the API call, so a slow draft can't double-fire.
      const today = localParts(user.auto.tz).date;
      await updateUser(userId, (u) => {
        u.auto.lastSentDate = today;
      });

      await sendIdeas(bot, userId, user.auto.chatId);
      console.log(`scheduler: sent daily ideas to ${userId}`);
    } catch (err) {
      console.error(`scheduler: failed for user ${userId}`, err);
    }
  }
}

/** Local/always-on entry point: ticks runSweepOnce every minute in-process.
 * Not used on Vercel - there, api/cron.js calls runSweepOnce directly. */
export function startScheduler(bot) {
  runSweepOnce(bot);
  const timer = setInterval(() => runSweepOnce(bot), TICK_MS);
  timer.unref?.();
  return timer;
}

export const _internal = { isDue, localParts };
