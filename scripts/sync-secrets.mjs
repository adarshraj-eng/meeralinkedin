/**
 * Push secrets from the local .env up to Vercel, for every environment.
 *
 *   node scripts/sync-secrets.mjs                       # the usual two
 *   node scripts/sync-secrets.mjs GEMINI_API_KEY        # just one
 *
 * Run this after rotating a key. It reads the values straight out of .env and
 * pipes them to the Vercel CLI, so a rotated secret never has to be pasted
 * into a chat window, a shell history, or anything else that keeps a log.
 *
 * Nothing here prints a secret - only its name and length.
 */
import { readFileSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";

const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

const DEFAULT_KEYS = ["TELEGRAM_BOT_TOKEN", "GEMINI_API_KEY"];
const ENVIRONMENTS = ["production", "preview", "development"];

const keys = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_KEYS;

// Parse .env ourselves rather than via dotenv, so a value is never injected
// into this process's environment where a child could inherit it.
const env = {};
for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

let failed = false;

for (const key of keys) {
  const value = env[key];
  if (!value) {
    console.error(`SKIP  ${key} - not set in .env`);
    failed = true;
    continue;
  }

  console.log(`\n${key} (${value.length} chars)`);

  for (const environment of ENVIRONMENTS) {
    // Remove first: `vercel env add` on an existing name in the same
    // environment is rejected rather than overwritten.
    try {
      execSync(`${NPX} --yes vercel env rm ${key} ${environment} --yes`, { stdio: "pipe" });
    } catch {
      // Not there yet on a first run - that is fine.
    }

    try {
      // On Windows npx is npx.cmd. Getting this wrong is worse than it looks:
      // the remove above has already run, so a failure here leaves the
      // variable missing from Vercel entirely rather than merely stale.
      execFileSync(NPX, ["--yes", "vercel", "env", "add", key, environment], {
        input: value,
        stdio: ["pipe", "pipe", "pipe"],
        // Node refuses to spawn a .cmd without a shell (EINVAL). Safe here:
        // key and environment are fixed tokens, and the secret goes over
        // stdin, never onto the command line where a shell could log it.
        shell: process.platform === "win32",
      });
      console.log(`  ${environment.padEnd(12)} updated`);
    } catch (err) {
      console.error(`  ${environment.padEnd(12)} FAILED - ${err.message.split("\n")[0]}`);
      failed = true;
    }
  }
}

console.log(
  failed
    ? "\nSomething did not update. Fix it before redeploying, or production keeps the old value."
    : "\nAll set. Redeploy for the new values to take effect, then re-run scripts/set-webhook.mjs " +
        "if the bot token changed - a new token means a new webhook registration.",
);

process.exit(failed ? 1 : 0);
