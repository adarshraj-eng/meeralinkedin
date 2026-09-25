// B1 acceptance check: scoring gate (B1.1) + news angle (B1.2).
// Needs a real key and costs several calls, so it is not part of npm test.
// Run:  node test/check-pipeline.mjs
const { scoreNote, extractKeywords, draftPosts } = await import("../src/llm.js");
const { fetchTopNews, verifyBlock } = await import("../src/news.js");

const THRESHOLD = 6;

const STRONG = [
  "in the 12 months to june 23% of returns mentioned texture, 71% of those from humid cities. we rebuilt the base, actives unchanged, returns dropped to 8% the next quarter",
  "the vitamin C thing has taken 14 months because above 10% L-AA you need an airless pump, pH under 3.5 AND an antioxidant system or it drops measurably in 4-6 months",
];

const WEAK = [
  "call the lab tomorrow",
  "reorder the boxes, and check with Priya about the shipment",
  "packaging is so annoying",
  "thinking about actives",
];

console.log("=== B1.1 SCORING GATE ===\n");
let pass = true;

for (const note of STRONG) {
  const v = await scoreNote(note);
  const ok = v.score >= THRESHOLD;
  if (!ok) pass = false;
  console.log(`${ok ? "PASS" : "FAIL"}  ${v.score}/10  (want >=${THRESHOLD})  "${note.slice(0, 55)}..."`);
  console.log(`      ${v.reason}\n`);
}

for (const note of WEAK) {
  const v = await scoreNote(note);
  const ok = v.score < THRESHOLD;
  if (!ok) pass = false;
  console.log(`${ok ? "PASS" : "FAIL"}  ${v.score}/10  (want <${THRESHOLD})   "${note}"`);
  console.log(`      ${v.reason}\n`);
}

console.log(`SCORING GATE: ${pass ? "all correct" : "MISCLASSIFIED - the prompt needs tightening"}\n`);

console.log("=== B1.2 NEWS ANGLE ===\n");

// Whether a draft uses the news item depends on whether the article is
// actually relevant, which we don't control. Try a couple of notes on topics
// that news outlets cover, so the verify-flag path gets exercised at least once.
const NEWS_NOTES = [
  "sunscreen SPF is rated at 2mg/cm2 but almost nobody applies that much, and the drop-off is not linear",
  STRONG[0],
];

let demonstrated = false;

for (const note of NEWS_NOTES) {
  const { search_phrase } = await extractKeywords(note);
  const news = await fetchTopNews(search_phrase);
  console.log(`note:   "${note.slice(0, 60)}..."`);
  console.log(`phrase: ${search_phrase}`);

  if (!news) {
    console.log("result: no news found - draft proceeds without an angle\n");
    continue;
  }
  console.log(`result: ${news.headline}\n        ${news.source} · ${news.date}`);

  const r = await draftPosts({ profile: {}, voiceSamples: [], history: [], brief: note, news });
  const used = r.variants.filter((v) => v.used_news);
  console.log(`drafts: ${r.variants.map((v) => `${v.label}[news=${v.used_news}]`).join(", ")}`);
  console.log(`        ${used.length} of ${r.variants.length} used the news item\n`);

  if (used.length && !demonstrated) {
    demonstrated = true;
    console.log("--- a draft with the news angle, as it arrives in Telegram ---\n");
    console.log(`${used[0].text.trim()}\n\n${verifyBlock(news)}\n`);
  }
}

console.log(
  demonstrated
    ? "NEWS ANGLE: verify flag demonstrated end to end."
    : "NEWS ANGLE: pipeline works, but no article was relevant enough to use.\n" +
        "Drafts were written without an angle, which is the intended behaviour -\n" +
        "a forced news hook is worse than none. Re-run for a different article.",
);
