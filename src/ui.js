import { InlineKeyboard } from "grammy";

export function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The post exactly as it should appear on LinkedIn. No hashtags - Meera
 * doesn't use them, so the model isn't asked for any.
 */
export function fullText(variant) {
  return variant.text.trim();
}

/**
 * The model is told to write [DATA NEEDED: ...] rather than invent a number.
 * Finding them is the whole point, so surface them loudly - a post that ships
 * with a placeholder still in it is worse than no post.
 */
export function findPlaceholders(text) {
  return [...text.matchAll(/\[(?:DATA NEEDED|VERIFY|TODO)[^\]]*\]/gi)].map((m) => m[0]);
}

export function draftKeyboard(variants, index) {
  const kb = new InlineKeyboard();

  variants.forEach((v, i) => {
    const mark = i === index ? "• " : "";
    kb.text(`${mark}${i + 1}. ${v.label}`, `v:${i}`);
    if ((i + 1) % 2 === 0) kb.row();
  });
  kb.row();

  kb.text("Shorter", "t:shorter").text("Longer", "t:longer").row();
  kb.text("Go deeper", "t:deeper").text("More concrete", "t:concrete").row();
  kb.text("Stronger guardrail", "t:guardrail").row();
  kb.text("Less Skinstinct", "t:lessbrand").text("For founders", "t:founders").row();
  kb.text("New angles", "t:fresh").row();
  kb.text("✅ Use this one", "ok").text("♻️ Start over", "new");

  return kb;
}

export function renderDraft(understanding, variants, index) {
  const v = variants[index];
  const body = fullText(v);
  const words = body.trim().split(/\s+/).length;
  const gaps = findPlaceholders(body);

  const lines = [
    `<i>${escapeHtml(understanding)}</i>`,
    "",
    `<b>Draft ${index + 1} of ${variants.length} — ${escapeHtml(v.label)}</b>  <i>(${words} words)</i>`,
    "",
    `<pre>${escapeHtml(body)}</pre>`,
  ];

  if (gaps.length) {
    lines.push(
      "",
      `⚠️ <b>${gaps.length} gap${gaps.length === 1 ? "" : "s"} to fill before posting.</b> ` +
        "I left these rather than invent a number:",
      ...gaps.map((g) => `• <code>${escapeHtml(g)}</code>`),
      "",
      "<i>Send me the real figures and I'll put them in.</i>",
    );
  } else {
    lines.push("", "<i>Tap the text to copy it. Or pick another angle / adjust it below.</i>");
  }

  return lines.join("\n");
}
