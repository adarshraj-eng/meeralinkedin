// Which Gemini models can this key actually reach right now?
// Useful when drafts start failing - tells you what to put in GEMINI_FALLBACK_MODELS.
// Run:  node test/probe-models.mjs
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const candidates = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite",
  "gemini-flash-latest",
  "gemini-flash-lite-latest",
  "gemini-2.5-flash-lite",
  "gemini-3.1-pro-preview",
  "gemini-pro-latest",
];

for (const model of candidates) {
  const started = Date.now();
  try {
    const r = await ai.models.generateContent({
      model,
      contents: "Reply with the single word: ok",
      config: { maxOutputTokens: 2000 },
    });
    console.log(model.padEnd(26), "OK  ", `${Date.now() - started}ms`.padEnd(8), JSON.stringify((r.text || "").trim().slice(0, 16)));
  } catch (err) {
    const code = (err?.message || "").match(/"code"\s*:\s*(\d+)/)?.[1] || err?.status || "?";
    console.log(model.padEnd(26), "FAIL", String(code).padEnd(8), (err?.message || "").slice(0, 60).replace(/\s+/g, " "));
  }
}
