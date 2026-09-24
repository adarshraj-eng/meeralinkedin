import { webhookCallback } from "grammy";
import { bot } from "../src/bot.js";
import { config } from "../src/config.js";

/**
 * Vercel serverless entry point for the Telegram webhook. Long-polling
 * (bot.start() in src/index.js) has no place here - a serverless function
 * only lives for the duration of one request - so Telegram is instead told
 * to POST every update straight to this URL. See scripts/set-webhook.mjs.
 *
 * secretToken checks Telegram's X-Telegram-Bot-Api-Secret-Token header, so a
 * stranger who finds this URL can't feed the bot fake updates on your API key.
 *
 * grammY's own default timeout here is 10 seconds, well under vercel.json's
 * 60s maxDuration for this function. draftPosts' retry-with-backoff across
 * fallback models can legitimately take longer than that on a busy/rate
 * limited Gemini key, so the short default was cutting requests off early -
 * which made Telegram retry the same update, which made things worse. Match
 * it to maxDuration instead (with a few seconds of margin).
 */
export default webhookCallback(bot, "http", {
  secretToken: config.telegramWebhookSecret || undefined,
  timeoutMilliseconds: 55_000,
});
