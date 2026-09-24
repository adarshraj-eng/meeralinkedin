import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { config } from "./config.js";
import { BASE_SYSTEM, VOICE_CONTEXT, profileSystem, IDEAS_SYSTEM, ideasContext } from "./prompts.js";

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

const VariantSchema = z.object({
  label: z.string().describe("2-4 words naming the angle"),
  text: z.string().describe("The complete post, ready to paste"),
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
export function isRetryable(err) {
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
async function callWithFallback(request) {
  const models = [config.model, ...config.fallbackModels.filter((m) => m !== config.model)];
  let lastErr;

  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await ai.models.generateContent({ model, ...request });
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err)) throw err;
        if (attempt < 2) await sleep(1000 * 2 ** attempt);
      }
    }
    console.warn(`llm: ${model} unavailable (${statusOf(lastErr)}), trying next model`);
  }
  throw lastErr;
}

async function generateJson({ system, contents, schema, validator }) {
  let response;
  try {
    response = await callWithFallback({
      contents,
      config: {
        systemInstruction: system,
        responseMimeType: "application/json",
        responseJsonSchema: schema,
        temperature: 1,
        maxOutputTokens: 16000,
      },
    });
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
 */
export async function draftPosts({ profile, voiceSamples, history, brief, instruction }) {
  const contents = [
    // Gemini calls the assistant role "model".
    ...history.map((t) => ({
      role: t.role === "assistant" ? "model" : "user",
      parts: [{ text: t.content }],
    })),
    {
      role: "user",
      parts: [{ text: instruction ? `${brief}\n\n[Revision instruction: ${instruction}]` : brief }],
    },
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
