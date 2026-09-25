import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { config } from "./config.js";
import { BASE_SYSTEM, VOICE_CONTEXT, profileSystem, IDEAS_SYSTEM, ideasContext } from "./prompts.js";

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

const VariantSchema = z.object({
  label: z.string().describe("2-4 words naming the angle"),
  text: z.string().describe("The complete post, ready to paste"),
  used_news: z.boolean().describe("True only if the news item actually shaped this draft"),
});

const DraftSchema = z.object({
  understanding: z.string().describe("One short line on how you read the brief"),
  needs_clarification: z.boolean(),
  clarifying_question: z.string().describe("The question, or empty string"),
  variants: z.array(VariantSchema).describe("3 drafts, or empty if asking a question"),
});

const IdeaSchema = z.object({
  label: z.string().describe("2-5 words, shown on a button"),
  pitch: z.string().describe("One sentence on why this is worth posting now"),
  brief: z.string().describe("The brief to draft from, first person as them"),
});

const IdeasSchema = z.object({
  ideas: z.array(IdeaSchema).describe("Exactly 3 ideas"),
});

export class RefusalError extends Error {}

/** Every model returned 429 - the key is out of quota, not merely busy. */
export class QuotaError extends Error {}

/**
 * Gemini rejects a few JSON Schema keywords that Zod emits by default, and
 * ignores $ref, so inline everything and drop what it won't take.
 */
export function toGeminiSchema(zodSchema) {
  const schema = z.toJSONSchema(zodSchema, { target: "draft-7", io: "output" });
  const strip = (node) => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== "object") return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "additionalProperties" || k === "$schema" || k === "exclusiveMinimum") continue;
      out[k] = strip(v);
    }
    return out;
  };
  return strip(schema);
}

const DRAFT_SCHEMA = toGeminiSchema(DraftSchema);
const IDEAS_SCHEMA = toGeminiSchema(IdeasSchema);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function statusOf(err) {
  const m = (err?.message || "").match(/"code"\s*:\s*(\d+)/);
  return m ? Number(m[1]) : err?.status;
}

/**
 * Worth retrying: the model is busy or over quota, or the network dropped.
 * "fetch failed" covers DNS, TLS and connection resets, which a bot that fires
 * unattended at 9am will hit eventually.
 */
/** AbortSignal.timeout fired, or the request was otherwise aborted. */
function isAbort(err) {
  return err?.name === "TimeoutError" || err?.name === "AbortError" || /aborted/i.test(err?.message || "");
}

export function isRetryable(err) {
  // Out of budget, so retrying is pointless.
  if (isAbort(err)) return false;
  const status = statusOf(err);
  if (status === 429 || status === 500 || status === 503 || status === 504) return true;
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(
    `${err?.message || ""} ${err?.cause?.message || ""}`,
  );
}

/**
 * Gemini returns 503 when a model is busy and 429 when the key is over quota,
 * and both are common enough on the free tier to break the 9am nudge. Retry
 * with backoff, then fall through to the next model rather than give up.
 */
async function callWithFallback(request, budgetMs = config.llmBudgetMs) {
  const models = [config.model, ...config.fallbackModels.filter((m) => m !== config.model)];
  const deadline = Date.now() + budgetMs;
  let lastErr;
  let quotaHits = 0;

  models: for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = deadline - Date.now();
      // Vercel kills the function at maxDuration and Telegram sees a 500, so
      // stop while there is still time to answer. Giving up cleanly beats
      // being killed mid-flight.
      if (remaining <= 0) {
        console.warn("llm: time budget exhausted, giving up early");
        throw lastErr || new Error("Ran out of time waiting for the model.");
      }

      try {
        // The budget is worthless without this. Checking the clock only
        // between attempts lets a single hung request run for minutes - one
        // call was measured at 313s against a 26s budget - because nothing
        // interrupts an await. The signal caps the request itself.
        return await ai.models.generateContent({
          model,
          ...request,
          config: { ...request.config, abortSignal: AbortSignal.timeout(remaining) },
        });
      } catch (err) {
        lastErr = err;

        // An abort means the budget ran out. Stop everything and fall through
        // to the summary below - throwing here would skip it and surface a
        // bare DOMException instead of the quota diagnosis we already have.
        if (isAbort(err)) break models;

        if (!isRetryable(err)) throw err;

        // 429 means the key is out of quota, not that the model is busy.
        // Retrying the same model cannot help and burns the budget, so move
        // to the next one immediately.
        if (statusOf(err) === 429) {
          quotaHits++;
          break;
        }

        const backoff = 1000 * 2 ** attempt;
        if (attempt < 2 && Date.now() + backoff < deadline) await sleep(backoff);
      }
    }
    console.warn(`llm: ${model} unavailable (${statusOf(lastErr) ?? "network"}), trying next model`);
  }

  // A 429 anywhere in the chain is the actionable diagnosis, even if the other
  // models failed differently (busy, aborted on the budget). Report quota
  // rather than whichever error happened to land last.
  if (quotaHits > 0) {
    throw new QuotaError(
      `${quotaHits} of ${models.length} models returned 429 - the Gemini API key is out of quota.`,
    );
  }
  // An abort is the budget expiring, which reads as nothing at all unless named.
  if (isAbort(lastErr)) {
    throw new Error(`No model responded within ${Math.round(budgetMs / 1000)}s.`);
  }
  throw lastErr;
}

async function generateJson({ system, contents, schema, validator, maxOutputTokens = 16000, temperature = 1, budgetMs }) {
  let response;
  try {
    response = await callWithFallback({
      contents,
      config: {
        systemInstruction: system,
        responseMimeType: "application/json",
        responseJsonSchema: schema,
        temperature,
        maxOutputTokens,
      },
    }, budgetMs);
  } catch (err) {
    // A blocked prompt surfaces as an API error rather than a response.
    if (/safety|blocked|PROHIBITED/i.test(err?.message || "")) {
      throw new RefusalError(err.message);
    }
    throw err;
  }

  const finish = response.candidates?.[0]?.finishReason;
  if (finish === "SAFETY" || finish === "PROHIBITED_CONTENT" || response.promptFeedback?.blockReason) {
    throw new RefusalError(`Blocked by Gemini safety filters (${finish || response.promptFeedback?.blockReason}).`);
  }
  if (finish === "MAX_TOKENS") {
    throw new Error("The model ran out of room before finishing. Try a shorter brief.");
  }

  const text = response.text;
  if (!text) throw new Error("Model returned an empty response.");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Model returned text that wasn't valid JSON.");
  }

  const result = validator.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Model returned JSON in an unexpected shape: ${result.error.issues[0]?.message}`);
  }
  return result.data;
}

/**
 * @param {object} args
 * @param {object} args.profile
 * @param {string[]} args.voiceSamples
 * @param {{role: string, content: string}[]} args.history  prior turns for context
 * @param {string} args.brief                                what she just asked for
 * @param {string} [args.instruction]                        tweak applied to a re-draft
 * @param {object} [args.news]                               optional news item to hang a timely angle on
 */
export async function draftPosts({ profile, voiceSamples, history, brief, instruction, news }) {
  let prompt = instruction ? `${brief}\n\n[Revision instruction: ${instruction}]` : brief;

  if (news) {
    prompt += `\n\n---\nA recent news item came back for this topic. **You have not read this article. You know only the three lines below.**\n\nHeadline: ${news.headline}\nPublication: ${news.source}${news.date ? `\nDate: ${news.date}` : ""}\n\nIf it is genuinely relevant, use it to make the post timely. If it does not fit naturally, ignore it completely and write the post as if you had never seen it - a forced news hook is worse than no news hook.\n\nIf you do use it, these rules are absolute:\n\n1. **Never state what the article says, found, noted, reported or concluded.** You do not know. You have a headline, not the contents. Writing "the FDA noted that..." or "the report found that..." invents a claim and attributes it to a real organisation, which is the single worst thing this post could do. You may say only that the subject is being covered, and that the coverage exists - for example "this came up again in the press this month" or "there was coverage of this on ${news.date || "that date"}".\n2. **Never treat it as evidence for anything.** It cannot support a number, a mechanism, or a position. Her own facts do that work; the news item only establishes timeliness.\n3. **Never name the publication or another company inside the post.** Her voice does not name brands. The source is recorded separately, underneath the post, where she can check it.\n\nIf the headline is too thin to use under those rules - and most are - ignore it and set used_news to false. That is the expected outcome, not a failure.`;
  }

  const contents = [
    // Gemini calls the assistant role "model".
    ...history.map((t) => ({
      role: t.role === "assistant" ? "model" : "user",
      parts: [{ text: t.content }],
    })),
    { role: "user", parts: [{ text: prompt }] },
  ];

  return generateJson({
    // Stable half first (instructions, then the voice docs) so Gemini's
    // implicit cache can match the prefix; her own notes vary, so they go last.
    system: [BASE_SYSTEM, VOICE_CONTEXT, profileSystem(profile, voiceSamples)]
      .filter(Boolean)
      .join("\n\n---\n\n"),
    contents,
    schema: DRAFT_SCHEMA,
    validator: DraftSchema,
  });
}

/** Unprompted post ideas for the daily nudge. */
export async function suggestIdeas({ profile, recentPosts }) {
  const { ideas } = await generateJson({
    system: `${IDEAS_SYSTEM}\n\n${ideasContext(profile, recentPosts)}`,
    contents: [{ role: "user", parts: [{ text: "What should I post about today?" }] }],
    schema: IDEAS_SCHEMA,
    validator: IdeasSchema,
  });
  return ideas;
}

// --- B1.1: scoring gate ---------------------------------------------------

const ScoreSchema = z.object({
  score: z.number().describe("0-10, how much of a LinkedIn post is in this note"),
  reason: z.string().describe("One line, addressed to her, explaining the score"),
});

const SCORE_SCHEMA = toGeminiSchema(ScoreSchema);

/**
 * Not every note deserves a post. Logistics reminders, half-sentences and
 * to-dos should be turned away before a drafting call is spent on them.
 * Deliberately strict - a gate that passes everything is not a gate.
 */
const SCORING_SYSTEM = `You score raw notes from Meera Pillai, founder of Skinstinct, on whether there is a LinkedIn post in them. She writes evidence-led, mechanism-first posts about skincare formulation for an audience of consumers, founders and formulators.

Score 0-10 on how much of a post is actually present.

- **0-2** - a task, a reminder, a logistics note, a link with no comment, or a fragment with no idea in it. "call the lab", "reorder boxes", "follow up with Priya".
- **3-5** - a thought that is real but too thin to build on: an unfinished sentence, a vague opinion with no mechanism or example, a mood. "packaging is so annoying", "thinking about actives".
- **6-7** - a usable seed: one clear idea, observation or question with enough substance that the mechanism can be found. A customer question worth answering in public.
- **8-10** - a strong note: a specific incident, a number, a concrete decision with a trade-off, or a position she can argue with evidence.

Judge the raw material, not the writing. A blunt, badly typed note with a real formulation insight scores high. A tidy sentence with nothing in it scores low.

Be strict. If you are hesitating between two bands, take the lower one. Most notes in a founder's capture channel are not posts, and turning one away costs her nothing while a weak post costs her credibility.

The reason is one line, written to her, plain and non-judgemental. If the score is below 6 it should say what is missing and what would lift it - the detail, the number, the incident.`;

/** Returns {score, reason}. Below 6, the caller should not draft. */
export async function scoreNote(note) {
  return generateJson({
    system: SCORING_SYSTEM,
    contents: [{ role: "user", parts: [{ text: note }] }],
    schema: SCORE_SCHEMA,
    validator: ScoreSchema,
    // Mechanical work: low temperature so the same note scores the same way,
    // and enough headroom that thinking tokens cannot truncate the JSON.
    maxOutputTokens: 2000,
    temperature: 0.2,
    budgetMs: config.scoreBudgetMs,
  });
}

// --- B1.2: news angle -----------------------------------------------------

const KeywordsSchema = z.object({
  search_phrase: z.string().describe("A short news search phrase, 3-6 words"),
  terms: z.array(z.string()).describe("3-5 individual search terms"),
});

const KEYWORDS_SCHEMA = toGeminiSchema(KeywordsSchema);

const KEYWORDS_SYSTEM = `You extract news search terms from a note by a skincare formulation founder.

Return 3-5 search terms and one short search phrase (3-6 words) that would find a genuinely related recent news story.

Aim at the subject matter - the ingredient, the regulation, the industry practice, the market - not at her personal situation. "our serum returns were high in Mumbai" should produce something like "India skincare humidity formulation", not "Skinstinct returns".

Prefer terms that real news outlets would use. Avoid brand names she hasn't mentioned, and never invent a product or company.`;

export async function extractKeywords(note) {
  return generateJson({
    system: KEYWORDS_SYSTEM,
    contents: [{ role: "user", parts: [{ text: note }] }],
    schema: KEYWORDS_SCHEMA,
    validator: KeywordsSchema,
    maxOutputTokens: 2000,
    temperature: 0.2,
    budgetMs: config.keywordBudgetMs,
  });
}
