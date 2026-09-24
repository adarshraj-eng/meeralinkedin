import "dotenv/config";
import { Bot } from "grammy";

/** Run before switching back to local long polling (npm run dev / npm start),
 * since Telegram refuses to long-poll while a webhook is set. */
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set. Copy it from .env or export it first.");
  process.exit(1);
}

const bot = new Bot(token);
await bot.api.deleteWebhook();
console.log("Webhook removed. Long polling (npm run dev / npm start) will work again.");
