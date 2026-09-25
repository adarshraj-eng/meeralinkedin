/**
 * Offline checks - no API key, no network, no Telegram.
 * Covers the parts that are easy to break silently: the schedule arithmetic,
 * the per-user write lock, and HTML escaping in the copy block.
 *
 *   node --test test/smoke.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

process.env.TELEGRAM_BOT_TOKEN ||= "1:test";
process.env.GEMINI_API_KEY ||= "test-key";
process.env.DATA_DIR = "./.tmp-test";

const { _internal } = await import("../src/scheduler.js");
const store = await import("../src/store.js");
const ui = await import("../src/ui.js");
const { z } = await import("zod");

const { isDue } = _internal;
const WED_0905_IST = new Date("2026-09-23T03:35:00Z");
const SAT_0905_IST = new Date("2026-09-26T03:35:00Z");
const base = { enabled: true, chatId: 1, tz: "Asia/Kolkata", time: "09:00", weekdaysOnly: true, lastSentDate: "" };

test("fires once the local time has arrived", () => {
  assert.equal(isDue(base, WED_0905_IST), true);
});

test("does not fire twice in one day", () => {
  assert.equal(isDue({ ...base, lastSentDate: "2026-09-23" }, WED_0905_IST), false);
});

test("does not fire before the chosen time", () => {
  assert.equal(isDue({ ...base, time: "11:00" }, WED_0905_IST), false);
});

test("does not fire hours late after downtime", () => {
  assert.equal(isDue({ ...base, time: "06:00" }, WED_0905_IST), false);
});

test("respects enabled and chatId", () => {
  assert.equal(isDue({ ...base, enabled: false }, WED_0905_IST), false);
  assert.equal(isDue({ ...base, chatId: null }, WED_0905_IST), false);
});

test("honours the weekday setting", () => {
  assert.equal(isDue(base, SAT_0905_IST), false);
  assert.equal(isDue({ ...base, weekdaysOnly: false }, SAT_0905_IST), true);
});

test("a corrupt timezone falls back to UTC instead of crashing the sweep", () => {
  assert.equal(isDue({ ...base, tz: "Not/AZone", time: "03:00", weekdaysOnly: false }, WED_0905_IST), true);
});

test("concurrent writes to one user do not clobber each other", async (t) => {
  t.after(() => fs.rm("./.tmp-test", { recursive: true, force: true }));
  await store.initStore();
  await store.updateUser(999, (u) => {
    u.profile.name = "Meera";
  });
  await Promise.all([
    store.updateUser(999, (u) => u.voiceSamples.push("a")),
    store.updateUser(999, (u) => u.voiceSamples.push("b")),
    store.updateUser(999, (u) => u.voiceSamples.push("c")),
  ]);
  const u = await store.loadUser(999);
  assert.equal(u.profile.name, "Meera");
  assert.equal(u.voiceSamples.length, 3);
  assert.deepEqual(await store.listUserIds(), [999]);
});

test("the copy block escapes HTML so posts can contain < & >", () => {
  const html = ui.renderDraft("read it right", [{ label: "A & B", text: "x < y & <b>" }], 0);
  assert.ok(html.includes("&amp;"));
  assert.ok(html.includes("&lt;b&gt;"));
});

test("the copyable text is the post and nothing else", () => {
  assert.equal(ui.fullText({ text: "  post body  " }), "post body");
});

test("data placeholders are found so a draft can't ship with an invented gap", () => {
  const text = "Returns were [DATA NEEDED: Q3 figure] last year. [VERIFY: study, year] says otherwise.";
  const gaps = ui.findPlaceholders(text);
  assert.equal(gaps.length, 2);
  assert.equal(gaps[0], "[DATA NEEDED: Q3 figure]");
  assert.deepEqual(ui.findPlaceholders("a clean post with no gaps"), []);
});

test("a draft with placeholders renders the warning instead of the copy hint", () => {
  const withGap = ui.renderDraft("ok", [{ label: "A", text: "We saw [DATA NEEDED: returns]." }], 0);
  assert.ok(withGap.includes("gap"), "should warn about the gap");
  assert.ok(!withGap.includes("Tap the text to copy"), "should not invite copying an unfinished post");

  const clean = ui.renderDraft("ok", [{ label: "A", text: "A finished post." }], 0);
  assert.ok(clean.includes("Tap the text to copy"));
});

test("the voice documents are loaded into the prompt", async () => {
  const prompts = await import("../src/prompts.js");
  assert.ok(prompts.VOICE_PROFILE.length > 1000, "voice-profile.md should be loaded");
  assert.ok(prompts.FACTS.length > 1000, "facts-and-positions.md should be loaded");
  assert.ok(prompts.VOICE_CONTEXT.includes("Skinstinct"));
  // The rules that most often get lost when someone edits the prompt.
  assert.ok(prompts.BASE_SYSTEM.includes("No hashtags"));
  assert.ok(prompts.BASE_SYSTEM.includes("450-650"));
  assert.ok(prompts.BASE_SYSTEM.includes("DATA NEEDED"));
});

test("the draft schema converts to JSON Schema Gemini will accept", async () => {
  const { toGeminiSchema } = await import("../src/llm.js");
  const S = z.object({
    understanding: z.string(),
    variants: z.array(z.object({ label: z.string(), text: z.string() })),
  });
  const schema = toGeminiSchema(S);
  const json = JSON.stringify(schema);

  assert.equal(schema.type, "object");
  assert.equal(schema.properties.variants.type, "array");
  // Gemini rejects these keywords outright, so they must never reach it.
  assert.ok(!json.includes("additionalProperties"), "additionalProperties must be stripped");
  assert.ok(!json.includes("$ref"), "$ref must be inlined, Gemini ignores it");
  assert.ok(!json.includes("$schema"), "$schema must be stripped");
  // Nested objects inside arrays are the case that actually breaks in practice.
  assert.ok(!JSON.stringify(schema.properties.variants).includes("additionalProperties"));
});

test("the pipeline's time budgets fit inside Vercel's maxDuration", async () => {
  const { config } = await import("../src/config.js");
  const vercel = JSON.parse(await fs.readFile("./vercel.json", "utf8"));
  const maxDuration = vercel.functions["api/telegram.js"].maxDuration * 1000;

  // One Telegram update runs: score -> keywords -> news fetch -> draft.
  // If the sum exceeds maxDuration, Vercel kills the function mid-flight and
  // Telegram gets a 500, then retries the same update - which is how the
  // deployed bot started failing. Keep real margin here.
  const NEWS_FETCH_MS = 8000; // news.js TIMEOUT_MS
  const OVERHEAD_MS = 3000; // redis, telegram round trips, cold start slack
  const worst =
    config.scoreBudgetMs + config.keywordBudgetMs + NEWS_FETCH_MS + config.llmBudgetMs + OVERHEAD_MS;

  assert.ok(
    worst < maxDuration,
    `worst-case pipeline ${worst}ms must stay under maxDuration ${maxDuration}ms`,
  );
  assert.ok(worst < maxDuration - 5000, `leave >=5s margin; currently ${maxDuration - worst}ms`);
});
