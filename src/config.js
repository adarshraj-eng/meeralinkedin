import "dotenv/config";
import path from "node:path";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
}

export const config = {
  telegramToken: requireEnv("TELEGRAM_BOT_TOKEN"),
  geminiApiKey: requireEnv("GEMINI_API_KEY"),
  model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
  // Tried in order when the primary is busy (503), over quota (429), or the
  // network drops. Free-tier capacity moves minute to minute, so keep several
  // genuinely different models here - and never just repeat the primary.
  fallbackModels: (process.env.GEMINI_FALLBACK_MODELS || "gemini-3.5-flash,gemini-3-flash-preview,gemini-flash-lite-latest")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  dataDir: path.resolve(process.env.DATA_DIR || "./data"),
  allowedUserIds: (process.env.ALLOWED_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),
  linkedin: {
    accessToken: process.env.LINKEDIN_ACCESS_TOKEN || "",
    authorUrn: process.env.LINKEDIN_AUTHOR_URN || "",
    get enabled() {
      return Boolean(this.accessToken && this.authorUrn);
    },
  },
  // Only used by the Vercel deployment (api/telegram.js, api/cron.js). Both
  // are optional but recommended: without them, anyone who finds the deployed
  // URL can hit those endpoints directly.
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || "",
  cronSecret: process.env.CRON_SECRET || "",
};
