import { bot } from "./bot.js";
import { config } from "./config.js";
import { initStore } from "./store.js";
import { startScheduler } from "./scheduler.js";

await initStore();

if (!config.allowedUserIds.length) {
  console.warn(
    "WARNING: ALLOWED_USER_IDS is empty, so anyone who finds this bot can use it (on your API key).\n" +
      "         Send /whoami to the bot, put the number in .env, and restart.",
  );
}

await bot.api.setMyCommands([
  { command: "ideas", description: "Three things you could post about now" },
  { command: "auto", description: "Daily post ideas on a schedule" },
  { command: "new", description: "Start a fresh post" },
  { command: "profile", description: "Edit who you are" },
  { command: "voice", description: "Teach me your writing voice" },
  { command: "drafts", description: "Posts you've approved" },
  { command: "publish", description: "Post an approved draft to LinkedIn" },
  { command: "help", description: "How this works" },
]);

startScheduler(bot);

const stop = async () => {
  console.log("\nShutting down.");
  await bot.stop();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

console.log(`Model: ${config.model}`);
console.log(`Data:  ${config.dataDir}`);
console.log(`LinkedIn publishing: ${config.linkedin.enabled ? "ENABLED (still needs /publish each time)" : "off"}`);

bot.start({
  onStart: (info) => console.log(`Running as @${info.username}. Press Ctrl+C to stop.`),
});
