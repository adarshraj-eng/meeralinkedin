import { bot } from "../src/bot.js";
import { runSweepOnce } from "../src/scheduler.js";
import { config } from "../src/config.js";

/**
 * Vercel Cron entry point for the daily nudge. There's no long-running
 * process on Vercel to run the once-a-minute setInterval that src/scheduler.js
 * uses locally, so a Cron Job (see vercel.json) hits this endpoint instead,
 * and each hit just runs one sweep. isDue's own bookkeeping (lastSentDate,
 * the 2h window) is what keeps this idempotent no matter how often it's
 * actually invoked.
 *
 * Vercel signs Cron requests with `Authorization: Bearer $CRON_SECRET` once
 * CRON_SECRET is set - see https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs.
 * Without it set, this endpoint is reachable by anyone who finds the URL.
 */
export default async function handler(req, res) {
  if (config.cronSecret) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${config.cronSecret}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
  }

  try {
    await runSweepOnce(bot);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("cron sweep failed", err);
    res.status(500).json({ error: err.message });
  }
}
