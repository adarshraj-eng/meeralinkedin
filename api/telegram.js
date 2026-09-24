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
 */
export default webhookCallback(bot, "http", {
  secretToken: config.telegramWebhookSecret || undefined,
});
