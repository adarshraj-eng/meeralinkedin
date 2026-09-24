# Meera's LinkedIn bot

A private Telegram bot that turns a rough thought into three drafts in Meera Pillai's voice, and nudges her with post ideas every morning.

Nothing is ever posted without her saying so. Twice, if publishing is switched on.

## How it works for her

She types whatever's in her head:

> something about why we reformulated the serum after the humidity returns

The bot reads the whole thread, not just the last line, and comes back with three drafts taking genuinely different angles on the same material. Each arrives in a tap-to-copy block.

Underneath each draft: **Shorter**, **Longer**, **Go deeper**, **More concrete**, **Stronger guardrail**, **Less Skinstinct**, **For founders**, **New angles**. Tapping one rewrites all three, keeping every fact. **Use this one** saves it to her approved list.

If the brief is missing a fact the bot must not invent — which product, which incident, what the number actually was — it asks one question instead of guessing. It never asks about tone or length.

## Why this doesn't look like a normal LinkedIn bot

Most LinkedIn advice is wrong for Meera, so the prompt deliberately contradicts it:

| Generic LinkedIn advice | What this bot does |
|---|---|
| 80–200 words | **450–650 words.** These are essays. |
| Short punchy lines, one per paragraph | Flowing paragraphs of 3–7 sentences, long-then-short rhythm |
| 3–5 hashtags | **None.** The schema has no hashtag field at all. |
| Hook that earns the "see more" click | A specific number with a timeframe, or a dated scene |
| End with a question to drive comments | A dry, flat kicker. Never "Thoughts?" |
| Emoji for scannability | None, ever |

### Placeholders instead of invented numbers

This is the most important behaviour and it's deliberate, so it's worth explaining.

Meera's credibility rests on never overclaiming. So the bot is instructed that if a post needs a figure it doesn't have, it must write `[DATA NEEDED: repeat rate for Q3]` rather than a plausible guess.

That means **a draft can arrive unfinished, on purpose.** When it does, the bot lists every gap under the draft and won't call it ready. If she approves it anyway, the confirmation says "Saved, but not ready yet" rather than "Ready to post". Send the real figures and it redrafts.

The alternative — a fluent post with an invented return rate in it — is the one failure this brand can't absorb.

### Where the voice lives

`voice/` holds four documents: `voice-skill.md` (the detailed writing-instructions brief, read first), `voice-profile.md` (persona, beliefs, vocabulary, sentence mechanics, format templates), `facts-and-positions.md` (everything she has published, so new posts don't contradict it), and `examples.md` (annotated signature moves).

They're loaded into every prompt at startup. **Edit the markdown, restart the bot, and the voice changes** — no code involved. `facts-and-positions.md` is the one to keep current: when a new number becomes public, add it there and the bot can use it instead of a placeholder.

Its claims were fact-checked on 24 September 2026 and each carries its source; the "Verified references" section at the end records what was corrected and why. The standing rule is at the bottom of that file: anything not in the document is unverified, so the bot writes a `[VERIFY: ...]` placeholder instead of guessing.

To confirm the corrected facts are reaching the drafts (needs a key, costs one call):

```powershell
node test/check-facts.mjs
```

The same material is installed as a Claude Code skill in `.claude/skills/meera-pillai-voice/`, so a Claude Code session in this folder writes in her voice too.

## The automation

Two commands:

```
/auto on 09:00
```

Every weekday at 09:00 in her timezone, the bot messages her three things worth posting about *today*. Each one is a tappable button — tap it and the drafts arrive. The ideas are built from her profile, her usual topics, and her last six approved posts, so it won't keep pitching the same angle back at her.

```
/ideas
```

The same thing on demand, without waiting for the morning.

Scheduling details that matter in practice:

- **Timezone aware** — `/auto tz Asia/Kolkata`, or any IANA zone. Default is Asia/Kolkata.
- **Fires once a day, no matter what.** The last-sent date is stored per user, so a restart, a closed laptop, or a missed minute won't double-send or skip.
- **Won't ambush her at 11pm.** If the bot was offline all morning, the nudge is dropped rather than fired late — there's a two-hour window after the target time.
- **Weekdays only** by default. `/auto everyday` if she wants weekends too.
- `/auto off` stops it. `/auto` on its own shows the current state.

## Control over what gets posted

This was the point of the design, so it's worth being explicit.

**By default the bot cannot post to LinkedIn at all.** It has no LinkedIn credentials and no code path that runs without them. Every draft ends as text in Telegram that she copies herself. That's the safest arrangement and it needs no LinkedIn app approval.

If she later wants to post without leaving Telegram, fill in `LINKEDIN_ACCESS_TOKEN` and `LINKEDIN_AUTHOR_URN` in `.env`. Even then there are two gates: a draft has to be **approved** (the ✅ button), and then she has to run **`/publish`** and confirm on a preview showing the exact text. The bot never publishes on its own, on a schedule, or as a side effect of anything else.

Getting those credentials means creating a LinkedIn Developer app, requesting the **Share on LinkedIn** product, and running an OAuth flow for a `w_member_social` token. LinkedIn reviews that request, which takes time and isn't guaranteed — which is why the bot is built to be useful without it.

## Setup

From the project folder:

```powershell
npm install
```

> **Windows PowerShell 5.1 note:** `&&` is not a valid separator in 5.1 — `cd foo && npm install` fails with a parser error. Run the two commands on separate lines, or use `;` to chain them unconditionally.

Copy `.env.example` to `.env` and fill in:

| Variable | Where it comes from |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Message [@BotFather](https://t.me/BotFather) on Telegram, `/newbot`, copy the token |
| `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → Create API key |
| `ALLOWED_USER_IDS` | Start the bot, send it `/whoami`, paste the number back in, restart |

`ALLOWED_USER_IDS` is the lock on the door. Until it's set, anyone who finds the bot can spend your API credit — the bot warns loudly at startup if it's empty.

```bash
npm start
```

Then in Telegram: `/start` → `/profile` (so drafts sound like her and not like LinkedIn) → `/voice` (paste two or three posts she's written and liked) → `/auto on 09:00`.

The profile and voice samples are what separate this from a generic "write me a LinkedIn post" prompt. Five minutes on them changes the output more than anything else.

### Keeping it running

`npm start` runs in the foreground and stops when the terminal closes — fine for trying it out, not for a 9am nudge. On Windows, `start-background.ps1` launches it detached and logs to `bot.log`:

```powershell
powershell -ExecutionPolicy Bypass -File start-background.ps1
```

For something that survives a reboot, run that script from Task Scheduler at logon, or put the bot on a small always-on box (a $5 VPS, a Raspberry Pi) under `pm2` or a systemd unit.

## Deploying to Vercel

`npm start` is long polling: the bot asks Telegram for updates in a loop, which needs a process that's always running. Vercel serverless functions are the opposite - they exist only for the duration of one request - so the deployed bot works differently in three ways:

- **Webhook, not polling.** Telegram POSTs updates to `/api/telegram` directly. `src/index.js` (long polling) isn't used in production.
- **Storage moves to Redis.** `data/*.json` doesn't survive between separate function invocations, so `src/store.js`, `src/sessions.js`, and the pending-ideas cache in `src/scheduler.js` all switch to a Redis store the moment `KV_REST_API_URL`/`KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`) are present - see `src/backend.js`. Locally, with those unset, everything still uses local JSON files exactly as before.
- **The daily nudge moves to Vercel Cron.** There's no in-process timer on Vercel, so `vercel.json` schedules a hit to `/api/cron` every 15 minutes, which runs one sweep (`runSweepOnce`) and relies on the same `lastSentDate` bookkeeping to avoid double-sending.

### Steps

1. **Push this repo to GitHub**, then in Vercel: **Add New → Project → Import** it.
2. **Attach a Redis store**: Storage tab → Marketplace → a Redis integration (Upstash) → connect it to this project. This sets the KV/Redis env vars automatically - don't add them by hand.
3. **Add the rest of the environment variables** (Project Settings → Environment Variables): `TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`, `ALLOWED_USER_IDS`, and optionally `GEMINI_MODEL`, `GEMINI_FALLBACK_MODELS`, `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_AUTHOR_URN`. Also set `TELEGRAM_WEBHOOK_SECRET` and `CRON_SECRET` to two random strings (e.g. `openssl rand -hex 32`) - without them, anyone who finds your `.vercel.app` URL can hit the webhook or the cron endpoint directly.
4. **Deploy**, then copy the live URL (`https://your-project.vercel.app`).
5. **Point Telegram at it** - run this once, locally, with the same `TELEGRAM_BOT_TOKEN`/`TELEGRAM_WEBHOOK_SECRET` you just set in Vercel:
   ```bash
   npm run set-webhook -- https://your-project.vercel.app/api/telegram
   ```
6. Message the bot on Telegram - it should respond immediately. Check **Vercel → your project → Logs** if it doesn't.

### Notes and trade-offs

- **Cron granularity.** `/auto on 07:30` is checked every 15 minutes here, versus every minute locally - a nudge can arrive up to ~15 minutes after the chosen time. Tighten `vercel.json`'s cron schedule if your Vercel plan allows more frequent crons (check your plan's current limits in the Vercel dashboard - they've changed over time and vary by plan).
- **Slow drafts and webhook timeouts.** Telegram expects a webhook response reasonably quickly and will retry if it doesn't get one; a slow Gemini call (retries + fallback models) can occasionally take long enough to trigger a retry, which could show up as a duplicate "typing..." or duplicate draft. `vercel.json` sets `maxDuration: 60` for both functions; raise it if your plan supports longer durations and this becomes a real problem.
- **Switching back to local polling.** Telegram only delivers updates one way at a time. Run `npm run delete-webhook` before using `npm run dev`/`npm start` again, and `npm run set-webhook -- <url>` to switch back.
- **`data/` still exists** for local development and the test suite; it's simply unused whenever the Redis env vars are present.

## Commands

| | |
|---|---|
| `/ideas` | Three things to post about, right now |
| `/auto` | Set up or check the daily nudge |
| `/new` | Fresh start, forget the current thread |
| `/profile` | Edit role, audience, topics, tone, things to avoid |
| `/voice` | Paste a post she wrote, so drafts match her voice (up to 8) |
| `/drafts` | Everything she's approved, with publish status |
| `/publish` | Post an approved draft to LinkedIn (only if configured) |
| `/cancel` | Back out of a profile or voice prompt |
| `/whoami` | Telegram user ID |

## Layout

```
src/
  index.js      local/always-on entry point: long polling, command menu, graceful shutdown
  bot.js        all Telegram handlers (shared by index.js and api/telegram.js)
  llm.js        the two Gemini calls: draft posts, suggest ideas
  prompts.js    the system prompts and the tweak instructions
  scheduler.js  the daily sweep and the idea nudge (runSweepOnce is shared by the local
                interval and api/cron.js; pendingIdeas is KV-backed when deployed)
  store.js      per-user data - local JSON files, or Vercel KV when deployed
  sessions.js   per-chat drafting state - in-memory locally, KV when deployed
  backend.js    picks the filesystem/in-memory or KV backend, once, from env vars
  ui.js         keyboards, HTML escaping, the copy block
  publish.js    LinkedIn, off unless configured
  config.js     env loading and validation
api/
  telegram.js   Vercel serverless function: the Telegram webhook
  cron.js       Vercel serverless function: hit by Vercel Cron for the daily nudge
scripts/
  set-webhook.mjs     point Telegram at a deployed /api/telegram URL
  delete-webhook.mjs  switch back to local long polling
test/smoke.js   offline checks - no API key or network needed
data/           per-user JSON when running locally (gitignored)
```

Both Gemini calls use `responseJsonSchema` with a Zod schema, so the bot gets typed objects rather than parsing prose — and the response is validated against that schema before it reaches the UI, so a malformed reply becomes a clean error instead of a broken message. The stable half of each system prompt comes first, so Gemini's implicit caching can match the prefix across requests.

Gemini returns 503 when a model is busy and 429 when the key is over quota, both common on the free tier. `llm.js` retries with backoff and then falls through to the models in `GEMINI_FALLBACK_MODELS`, so a busy model doesn't silently kill the 9am nudge.

`prompts.js` is the file to edit to change how the posts read — the house rules (no em dashes, no "thrilled to announce", no invented numbers, 80–200 words) all live there in plain English.

## Tests

```bash
npm test
```

11 offline checks covering the schedule arithmetic (fires once, not twice; not before the time; not hours late; weekend handling; a corrupt timezone doesn't kill the sweep), the per-user write lock under concurrent updates, and HTML escaping in the copy block. No API key or network needed.

The live Gemini calls were verified separately against the real API — drafting, idea generation, and the clarifying-question path all confirmed working on `gemini-3.5-flash`. Those aren't in the suite because they need a key and cost money.

## Model choice

Default is `gemini-3.5-flash`: fast (about 2s), cheap, and it handles this task well. Verified working at the time of writing.

`gemini-3.8-flash` and `gemini-flash-latest` returned 503 (busy) and the pro models returned 429 (quota) on a free-tier key — hence the fallback chain. If you move to a paid tier, `GEMINI_MODEL=gemini-3.1-pro-preview` is worth comparing on her real briefs; set `GEMINI_FALLBACK_MODELS` to whatever you want it to fall back to.

Run this to see what your key can actually reach:

```powershell
node -e "const {GoogleGenAI}=require('@google/genai');(async()=>{const ai=new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY});for await(const m of await ai.models.list())console.log(m.name)})()"
```
