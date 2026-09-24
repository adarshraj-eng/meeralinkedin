import "dotenv/config";
import { Bot } from "grammy";

/**
 * Run once after every deploy to a new Vercel URL:
 *   node scripts/set-webhook.mjs https://your-project.vercel.app/api/telegram
 *
 * Telegram will only deliver updates by webhook OR by long polling, never
 * both. Setting a webhook here means src/index.js's bot.start() (long
 * polling, for local dev) will error if you try to run it at the same time -
 * run scripts/delete-webhook.mjs first to switch back.
 */
const url = process.argv[2];
if (!url) {
  console.error("Usage: node scripts/set-webhook.mjs https://your-project.vercel.app/api/telegram");
  process.exit(1);
}

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set. Copy it from .env or export it first.");
  process.exit(1);
}

const bot = new Bot(token);
const secret = process.env.TELEGRAM_WEBHOOK_SECRET || undefined;

await bot.api.setWebhook(url, secret ? { secret_token: secret } : {});
console.log(`Webhook set to ${url}${secret ? " (with secret token)" : " (no secret token - set TELEGRAM_WEBHOOK_SECRET to add one)"}.`);

const info = await bot.api.getWebhookInfo();
console.log(info);
