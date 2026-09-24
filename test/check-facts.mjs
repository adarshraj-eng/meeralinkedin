// Throwaway check: do the corrected facts actually reach the drafts?
// Needs a real key and costs a call, so it is not part of npm test.
// Run:  node test/check-facts.mjs
const { draftPosts } = await import("../src/llm.js");

const r = await draftPosts({
  profile: {},
  voiceSamples: [],
  history: [],
  brief: "a post about fragrance allergens and the EU disclosure list, and how much sunscreen people actually apply",
});

const all = r.variants.map((v) => v.text).join(" ");

console.log("--- corrected facts reaching the drafts? ---");
console.log("82 / ~80 allergens:      ", /\b82\b|around 80|about 80/.test(all));
console.log("1.9% prevalence:         ", /1\.9\s*%/.test(all));
console.log("Liverpool year:          ", { has2019: /2019/.test(all), has2022: /2022/.test(all) });
console.log("exponential/square root: ", /square root|exponential|fourth root/i.test(all));

const twentySix = all.match(/[^.]*\b26\b[^.]*\./g);
console.log("mentions 26:             ", twentySix ? twentySix.join(" | ").slice(0, 300) : "no");

console.log("\n--- excerpt ---\n" + r.variants[0].text.slice(0, 800));
