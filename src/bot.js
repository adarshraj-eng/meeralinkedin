import { Bot, InlineKeyboard } from "grammy";
import { config } from "./config.js";
import { loadUser, updateUser, MAX_HISTORY_TURNS, MAX_VOICE_SAMPLES, MAX_NOTES } from "./store.js";
import { draftPosts, scoreNote, extractKeywords, RefusalError, QuotaError } from "./llm.js";
import { fetchTopNews, verifyBlock } from "./news.js";
import { TWEAKS } from "./prompts.js";
import { publishToLinkedIn } from "./publish.js";
import { draftKeyboard, renderDraft, fullText, escapeHtml, findPlaceholders } from "./ui.js";
import { sendIdeas, getPendingIdeas, setPendingIdeas, clearPendingIdeas } from "./scheduler.js";
import { getSession, setSession, clearSession } from "./sessions.js";

export const bot = new Bot(config.telegramToken);

/** Below this, a note is turned away instead of drafted (B1.1). */
const SCORE_THRESHOLD = 6;

const PROFILE_FIELDS = {
  name: "your name",
  role: "your role / job title",
  company: "your company",
  audience: "who you're writing for",
  topics: "the topics you usually post about",
  tone: "the tone you want (e.g. direct and warm, no hype)",
  goals: "what you want out of LinkedIn",
  avoid: "anything you never want in your posts",
};

// --- access control -------------------------------------------------------

bot.use(async (ctx, next) => {
  const id = ctx.from?.id;
  if (!id) return;
  if (config.allowedUserIds.length && !config.allowedUserIds.includes(id)) {
    if (ctx.message?.text === "/whoami") {
      await ctx.reply(`Your Telegram user ID is ${id}`);
      return;
    }
    await ctx.reply("This bot is private. Ask the owner to add your Telegram user ID.");
    return;
  }
  await next();
});

// --- commands -------------------------------------------------------------

const HELP = `<b>What I do</b>
Tell me what you want to write about, in your own words, and I'll draft three versions in your voice. Pick one, adjust it with the buttons, and copy it into LinkedIn.

You can be as rough as you like:
<i>"something about why we reformulated the serum"</i>
<i>"the vitamin C product, why it's taken so long"</i>
<i>"what a CoA actually shows and how to read one"</i>

I work from your voice profile and your published facts, so I won't contradict anything you've already said. If a post needs a number I don't have, I'll leave a <code>[DATA NEEDED: ...]</code> marker rather than invent one, and tell you what's missing.

<b>Commands</b>
/new - start a fresh post, forget the current thread
/profile - notes that override the voice profile
/voice - add a recent post so drafts stay current
/notes - every note I scored, and why
/drafts - the posts you've approved
/publish - post an approved draft to LinkedIn (only if set up)
/whoami - your Telegram user ID
/help - this message

<b>On autopilot</b>
/ideas - three things you could post about, right now
/auto on 09:00 - and I'll send those to you every weekday morning
/auto - see or change the schedule

<b>Control</b>
I never post anything anywhere on my own. Every draft stops with you.`;

bot.command("start", async (ctx) => {
  const user = await loadUser(ctx.from.id);
  const greeting = user.profile.name ? `Hi ${escapeHtml(user.profile.name)}.` : "Hi.";
  await ctx.reply(`${greeting}\n\n${HELP}`, { parse_mode: "HTML" });
});

bot.command("help", (ctx) => ctx.reply(HELP, { parse_mode: "HTML" }));

bot.command("whoami", (ctx) => ctx.reply(`Your Telegram user ID is ${ctx.from.id}`));

bot.command("new", async (ctx) => {
  await clearSession(ctx.chat.id);
  await updateUser(ctx.from.id, (u) => {
    u.history = [];
  });
  await ctx.reply("Clean slate. What do you want to post about?");
});

bot.command("profile", async (ctx) => {
  const user = await loadUser(ctx.from.id);
  const lines = Object.entries(PROFILE_FIELDS).map(([k, label]) => {
    const v = user.profile[k];
    return `<b>${k}</b> - ${v ? escapeHtml(v) : `<i>not set (${label})</i>`}`;
  });

  const kb = new InlineKeyboard();
  Object.keys(PROFILE_FIELDS).forEach((k, i) => {
    kb.text(k, `pf:${k}`);
    if ((i + 1) % 3 === 0) kb.row();
  });

  await ctx.reply(
    "<b>Your notes</b>\nYour voice profile is already loaded from <code>voice/</code>, so you don't need to fill these in. " +
      "Use them only to override something, or to add context the profile doesn't cover.\n\n" +
      `${lines.join("\n")}\n\nTap a field to change it.`,
    { parse_mode: "HTML", reply_markup: kb },
  );
});

bot.command("voice", async (ctx) => {
  const user = await loadUser(ctx.from.id);
  const arg = (ctx.match || "").trim();

  if (arg === "clear") {
    await updateUser(ctx.from.id, (u) => {
      u.voiceSamples = [];
    });
    await ctx.reply("Voice samples cleared.");
    return;
  }

  if (arg) {
    await addVoiceSample(ctx, arg);
    return;
  }

  const s = await getSession(ctx.chat.id);
  s.awaiting = "voice";
  await setSession(ctx.chat.id, s);
  const n = user.voiceSamples.length;
  await ctx.reply(
    `You have ${n} sample post${n === 1 ? "" : "s"} on file (max ${MAX_VOICE_SAMPLES}).\n\n` +
      "Paste a LinkedIn post you wrote and liked, and I'll match how you sound. " +
      "Send /cancel to stop, or /voice clear to wipe them.",
  );
});

bot.command("cancel", async (ctx) => {
  const s = await getSession(ctx.chat.id);
  s.awaiting = null;
  s.field = null;
  await setSession(ctx.chat.id, s);
  await ctx.reply("Cancelled.");
});

bot.command("drafts", async (ctx) => {
  const user = await loadUser(ctx.from.id);
  if (!user.drafts.length) {
    await ctx.reply("No approved drafts yet.");
    return;
  }
  const recent = user.drafts.slice(-10).reverse();
  await ctx.reply(
    `<b>Your approved posts</b> (${user.drafts.length} total, showing the latest ${recent.length})`,
    { parse_mode: "HTML" },
  );
  for (const d of recent) {
    const when = new Date(d.approvedAt).toLocaleString();
    const status = d.publishedAt ? `published ${new Date(d.publishedAt).toLocaleString()}` : "not published";
    await ctx.reply(
      `<i>${escapeHtml(when)} - ${escapeHtml(d.label)} - ${escapeHtml(status)}</i>\n\n<pre>${escapeHtml(d.text)}</pre>`,
      { parse_mode: "HTML" },
    );
  }
});

bot.command("notes", async (ctx) => {
  const user = await loadUser(ctx.from.id);
  if (!user.notes.length) {
    await ctx.reply("No notes scored yet. Send me one.");
    return;
  }

  const recent = user.notes.slice(-15).reverse();
  const drafted = user.notes.filter((n) => n.drafted).length;
  const turned = user.notes.length - drafted;

  const lines = recent.map((n) => {
    const mark = n.drafted ? "✓" : "✗";
    const snippet = n.text.length > 70 ? `${n.text.slice(0, 70)}...` : n.text;
    return `${mark} <b>${n.score}/10</b> ${escapeHtml(snippet)}\n   <i>${escapeHtml(n.reason)}</i>`;
  });

  await ctx.reply(
    `<b>Notes scored</b> - ${drafted} drafted, ${turned} turned away (of ${user.notes.length})\n\n${lines.join("\n\n")}`,
    { parse_mode: "HTML" },
  );
});

bot.command("publish", async (ctx) => {
  if (!config.linkedin.enabled) {
    await ctx.reply(
      "Direct publishing isn't set up, so I can't post to LinkedIn. Copy the draft from /drafts and paste it in yourself. See the README if you want to connect a LinkedIn app.",
    );
    return;
  }

  const user = await loadUser(ctx.from.id);
  const last = [...user.drafts].reverse().find((d) => !d.publishedAt);
  if (!last) {
    await ctx.reply("Nothing approved and unpublished. Approve a draft first.");
    return;
  }

  const kb = new InlineKeyboard().text("Yes, post it", "pub:yes").text("No", "pub:no");
  await ctx.reply(
    `About to post this to your LinkedIn, publicly and immediately:\n\n<pre>${escapeHtml(last.text)}</pre>\n\nConfirm?`,
    { parse_mode: "HTML", reply_markup: kb },
  );
});

// --- the daily nudge ------------------------------------------------------

bot.command("ideas", async (ctx) => {
  await ctx.replyWithChatAction("typing").catch(() => {});
  try {
    const ok = await sendIdeas(bot, ctx.from.id, ctx.chat.id);
    if (!ok) await ctx.reply("Couldn't come up with anything useful. Tell me what's been going on instead?");
  } catch (err) {
    console.error("ideas failed", err);
    await ctx.reply("Something went wrong generating ideas. Try again in a moment.");
  }
});

bot.command("auto", async (ctx) => {
  const arg = (ctx.match || "").trim().toLowerCase();
  const user = await loadUser(ctx.from.id);

  if (!arg || arg === "status") {
    const a = user.auto;
    const state = a.enabled
      ? `on, ${a.time} ${a.tz}, ${a.weekdaysOnly ? "weekdays only" : "every day"}`
      : "off";
    await ctx.reply(
      `<b>Daily post ideas:</b> ${escapeHtml(state)}\n\n` +
        "<code>/auto on</code> - nudge me every weekday at 09:00\n" +
        "<code>/auto on 07:30</code> - pick the time (24h, your timezone)\n" +
        "<code>/auto tz Asia/Kolkata</code> - set your timezone\n" +
        "<code>/auto everyday</code> or <code>/auto weekdays</code>\n" +
        "<code>/auto off</code> - stop\n" +
        "<code>/ideas</code> - ideas right now, without waiting",
      { parse_mode: "HTML" },
    );
    return;
  }

  if (arg === "off") {
    await updateUser(ctx.from.id, (u) => {
      u.auto.enabled = false;
    });
    await ctx.reply("Daily ideas off. /auto on to turn them back on.");
    return;
  }

  if (arg === "everyday" || arg === "weekdays") {
    await updateUser(ctx.from.id, (u) => {
      u.auto.weekdaysOnly = arg === "weekdays";
    });
    await ctx.reply(arg === "weekdays" ? "Weekdays only." : "Every day, weekends included.");
    return;
  }

  const tzMatch = arg.match(/^tz\s+(\S+)$/);
  if (tzMatch) {
    const tz = (ctx.match || "").trim().split(/\s+/)[1];
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    } catch {
      await ctx.reply(`"${escapeHtml(tz)}" isn't a timezone I recognise. Try something like Asia/Kolkata or Europe/London.`);
      return;
    }
    await updateUser(ctx.from.id, (u) => {
      u.auto.tz = tz;
    });
    await ctx.reply(`Timezone set to ${escapeHtml(tz)}.`);
    return;
  }

  const onMatch = arg.match(/^on(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (onMatch) {
    const h = onMatch[1] === undefined ? 9 : Number(onMatch[1]);
    const m = onMatch[2] === undefined ? 0 : Number(onMatch[2]);
    if (h > 23 || m > 59) {
      await ctx.reply("That's not a valid time. Use 24-hour format, like /auto on 07:30.");
      return;
    }
    const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    const updated = await updateUser(ctx.from.id, (u) => {
      u.auto.enabled = true;
      u.auto.time = time;
      u.auto.chatId = ctx.chat.id;
      u.auto.lastSentDate = ""; // let it fire today if the time has already passed
    });
    await ctx.reply(
      `Done. I'll send you three post ideas at ${time} ${updated.auto.tz}, ` +
        `${updated.auto.weekdaysOnly ? "weekdays only" : "every day"}.\n\n` +
        "Wrong timezone? /auto tz Europe/London. Want some right now? /ideas",
    );
    return;
  }

  await ctx.reply("Didn't catch that. Send /auto on its own to see the options.");
});

// --- callbacks ------------------------------------------------------------

bot.callbackQuery(/^idea:(\d+|skip)$/, async (ctx) => {
  const which = ctx.match[1];
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: undefined });

  if (which === "skip") {
    await clearPendingIdeas(ctx.chat.id);
    await ctx.reply("No problem. I'll check in tomorrow.");
    return;
  }

  const ideas = await getPendingIdeas(ctx.chat.id);
  const idea = ideas?.[Number(which)];
  if (!idea) {
    await ctx.reply("That batch of ideas has expired. Send /ideas for a fresh set.");
    return;
  }

  await ctx.reply(`Drafting: <i>${escapeHtml(idea.label)}</i>`, { parse_mode: "HTML" });
  await runDraft(ctx, idea.brief);
});

bot.callbackQuery(/^pf:(.+)$/, async (ctx) => {
  const field = ctx.match[1];
  if (!(field in PROFILE_FIELDS)) {
    await ctx.answerCallbackQuery({ text: "Unknown field." });
    return;
  }
  const s = await getSession(ctx.chat.id);
  s.awaiting = "profile";
  s.field = field;
  await setSession(ctx.chat.id, s);
  await ctx.answerCallbackQuery();
  await ctx.reply(`Send me ${PROFILE_FIELDS[field]}. Send "-" to clear it, /cancel to stop.`);
});

bot.callbackQuery(/^v:(\d+)$/, async (ctx) => {
  const s = await getSession(ctx.chat.id);
  const i = Number(ctx.match[1]);
  if (!s.variants[i]) {
    await ctx.answerCallbackQuery({ text: "That draft is gone. Send a new brief." });
    return;
  }
  s.index = i;
  await setSession(ctx.chat.id, s);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(renderDraft(s.understanding, s.variants, i, { score: s.score, news: s.news }), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: draftKeyboard(s.variants, i),
  });
});

bot.callbackQuery(/^t:(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  const s = await getSession(ctx.chat.id);
  if (!s.variants.length || !TWEAKS[key]) {
    await ctx.answerCallbackQuery({ text: "Nothing to adjust. Send a new brief." });
    return;
  }
  await ctx.answerCallbackQuery({ text: "Rewriting..." });
  await runDraft(ctx, s.brief, TWEAKS[key]);
});

bot.callbackQuery("new", async (ctx) => {
  await clearSession(ctx.chat.id);
  await updateUser(ctx.from.id, (u) => {
    u.history = [];
  });
  await ctx.answerCallbackQuery();
  await ctx.reply("Cleared. What do you want to post about?");
});

bot.callbackQuery("ok", async (ctx) => {
  const s = await getSession(ctx.chat.id);
  const v = s.variants[s.index];
  if (!v) {
    await ctx.answerCallbackQuery({ text: "Nothing to approve." });
    return;
  }
  const text = fullText(v);

  await updateUser(ctx.from.id, (u) => {
    u.drafts.push({ label: v.label, text, approvedAt: Date.now(), publishedAt: null });
  });

  await ctx.answerCallbackQuery({ text: "Saved" });
  await ctx.editMessageReplyMarkup({ reply_markup: undefined });

  // A draft with an unfilled placeholder is not ready, however much she likes it.
  const gaps = findPlaceholders(text);
  const heading = gaps.length ? "Saved, but not ready yet" : "Ready to post";
  const tail = gaps.length
    ? `Still ${gaps.length} placeholder${gaps.length === 1 ? "" : "s"} to fill. Send me the real figures and I'll redraft it.`
    : config.linkedin.enabled
      ? "Tap to copy, or run /publish to post it from here."
      : "Tap the text to copy it, then paste it into LinkedIn.";
  await ctx.reply(`<b>${heading}</b>\n\n<pre>${escapeHtml(text)}</pre>\n\n<i>${tail}</i>`, {
    parse_mode: "HTML",
  });
});

bot.callbackQuery(/^pub:(yes|no)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: undefined });

  if (ctx.match[1] === "no") {
    await ctx.reply("Not posted.");
    return;
  }

  const user = await loadUser(ctx.from.id);
  let idx = -1;
  for (let i = user.drafts.length - 1; i >= 0; i--) {
    if (!user.drafts[i].publishedAt) {
      idx = i;
      break;
    }
  }
  if (idx === -1) {
    await ctx.reply("Nothing left to publish.");
    return;
  }

  try {
    const url = await publishToLinkedIn(user.drafts[idx].text);
    await updateUser(ctx.from.id, (u) => {
      if (u.drafts[idx]) {
        u.drafts[idx].publishedAt = Date.now();
        u.drafts[idx].url = url;
      }
    });
    await ctx.reply(url ? `Posted: ${url}` : "Posted to LinkedIn.");
  } catch (err) {
    console.error("publish failed", err);
    await ctx.reply(`Couldn't post it: ${err.message}\n\nThe draft is still in /drafts, so nothing is lost.`);
  }
});

// --- plain messages -------------------------------------------------------

bot.on("message:text", async (ctx) => {
  const s = await getSession(ctx.chat.id);
  const text = ctx.message.text.trim();
  if (!text) return;

  if (s.awaiting === "profile") {
    const field = s.field;
    s.awaiting = null;
    s.field = null;
    await setSession(ctx.chat.id, s);
    await updateUser(ctx.from.id, (u) => {
      u.profile[field] = text === "-" ? "" : text;
    });
    await ctx.reply(text === "-" ? `Cleared ${field}.` : `Got it. ${field} is now: ${text}`);
    return;
  }

  if (s.awaiting === "voice") {
    s.awaiting = null;
    await setSession(ctx.chat.id, s);
    await addVoiceSample(ctx, text);
    return;
  }

  // Answering a clarifying question: fold the answer into the original brief.
  const brief = s.awaiting === "clarify" ? `${s.brief}\n\n${text}` : text;
  s.awaiting = null;
  await setSession(ctx.chat.id, s);
  await runDraft(ctx, brief);
});

// --- core -----------------------------------------------------------------

async function addVoiceSample(ctx, text) {
  if (text.length < 80) {
    await ctx.reply("That's a bit short to learn from. Paste a full post (at least a few sentences).");
    return;
  }
  const user = await updateUser(ctx.from.id, (u) => {
    u.voiceSamples.push(text);
    if (u.voiceSamples.length > MAX_VOICE_SAMPLES) u.voiceSamples.shift();
  });
  await ctx.reply(`Saved. I have ${user.voiceSamples.length} of your posts to learn from. Send /voice to add another.`);
}

/**
 * B1.2 - keywords out of the note, then the top Google News item for them.
 * Best-effort on purpose: if either step fails the draft still goes ahead
 * without a news angle, because the post is the product.
 */
async function addNewsAngle(brief) {
  try {
    const { search_phrase } = await extractKeywords(brief);
    const news = await fetchTopNews(search_phrase);
    if (news) console.log(`news: "${search_phrase}" -> ${news.source}: ${news.headline}`);
    return news;
  } catch (err) {
    console.warn("news: angle skipped -", err?.message);
    return null;
  }
}

/**
 * The verify flag goes only on drafts that actually used the news item.
 * Stamping a source block onto a post that ignored the article would be
 * noise at best and a false citation at worst.
 */
function attachVerifyBlocks(variants, news) {
  if (!news) return variants;
  return variants.map((v) => (v.used_news ? { ...v, text: `${v.text.trim()}\n\n${verifyBlock(news)}` } : v));
}

async function runDraft(ctx, brief, instruction) {
  const chatId = ctx.chat.id;
  const s = await getSession(chatId);
  s.brief = brief;
  await setSession(chatId, s);

  await ctx.replyWithChatAction("typing").catch(() => {});
  const typing = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 5000);

  try {
    const user = await loadUser(ctx.from.id);
    let news = null;

    // B1.1 + B1.2 run on a fresh note only. A button revision is re-working a
    // note that already passed the gate, so re-scoring it would be wrong (and
    // would burn two extra calls on every tap).
    if (!instruction) {
      const verdict = await scoreNote(brief);
      await updateUser(ctx.from.id, (u) => {
        u.notes.push({
          text: brief,
          score: verdict.score,
          reason: verdict.reason,
          drafted: verdict.score >= SCORE_THRESHOLD,
          at: Date.now(),
        });
        while (u.notes.length > MAX_NOTES) u.notes.shift();
      });

      if (verdict.score < SCORE_THRESHOLD) {
        clearInterval(typing);
        await ctx.reply(
          `<b>No draft for this one.</b> <i>(${verdict.score}/10)</i>\n\n${escapeHtml(verdict.reason)}\n\n` +
            "<i>Send it again with the missing detail and I'll write it.</i>",
          { parse_mode: "HTML" },
        );
        return;
      }

      s.score = verdict.score;
      news = await addNewsAngle(brief);
      s.news = news;
      await setSession(chatId, s);
    } else {
      news = s.news || null;
    }

    const result = await draftPosts({
      profile: user.profile,
      voiceSamples: user.voiceSamples,
      history: user.history,
      brief,
      instruction,
      news,
    });

    if (result.needs_clarification && result.clarifying_question) {
      s.awaiting = "clarify";
      await setSession(chatId, s);
      await ctx.reply(result.clarifying_question);
      return;
    }

    if (!result.variants?.length) {
      await ctx.reply("I couldn't turn that into a post. Give me a bit more to work with?");
      return;
    }

    const variants = attachVerifyBlocks(result.variants, news);

    s.understanding = result.understanding;
    s.variants = variants;
    s.index = 0;
    await setSession(chatId, s);

    await ctx.reply(renderDraft(result.understanding, variants, 0, { score: s.score, news }), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: draftKeyboard(variants, 0),
    });

    // Keep the drafts in history so follow-ups and tweaks have real context.
    await updateUser(ctx.from.id, (u) => {
      u.history.push({
        role: "user",
        content: instruction ? `${brief}\n\n[Revision: ${instruction}]` : brief,
      });
      u.history.push({
        role: "assistant",
        content: variants.map((v, i) => `Draft ${i + 1} (${v.label}):\n${v.text}`).join("\n\n"),
      });
      while (u.history.length > MAX_HISTORY_TURNS) u.history.shift();
    });
  } catch (err) {
    if (err instanceof RefusalError) {
      await ctx.reply("I can't write that one. Try rephrasing, or ask for a different angle.");
    } else if (err instanceof QuotaError) {
      await ctx.reply(
        "The Gemini API key is out of quota, so I can't draft anything right now. " +
          "It usually resets within the day. Your note is saved - send it again once quota is back.",
      );
    } else {
      console.error("draft failed", err);
      await ctx.reply("Something went wrong talking to the model. Try again in a moment.");
    }
  } finally {
    clearInterval(typing);
  }
}

bot.catch((err) => {
  console.error("Bot error:", err.error ?? err);
});
