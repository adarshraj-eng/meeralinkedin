/**
 * B1.2 - the news angle.
 *
 * Google News publishes an RSS feed per search query with no key and no
 * account, which is why the brief points here rather than at a paid news API.
 * We parse the top item out of that XML ourselves: one dependency-free fetch,
 * and nothing to expire or get rate limited on a free tier.
 *
 * Everything here is best-effort. A news lookup that fails must never stop a
 * draft being written - the post is the product, the news angle is a bonus.
 */

const FEED = "https://news.google.com/rss/search";
const TIMEOUT_MS = 8000;

/** Strip CDATA, tags and entities out of an RSS field. */
function clean(raw) {
  if (!raw) return "";
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? clean(m[1]) : "";
}

/**
 * Google News puts the publication name at the end of the title after a
 * spaced hyphen, and also in a <source> element. Prefer the element.
 */
function splitTitle(title, source) {
  if (source) return { headline: title.replace(new RegExp(`\\s+-\\s+${source}$`), "").trim(), source };
  const m = title.match(/^(.*)\s+-\s+([^-]+)$/);
  return m ? { headline: m[1].trim(), source: m[2].trim() } : { headline: title, source: "" };
}

/**
 * @param {string} phrase  search phrase from extractKeywords
 * @returns {Promise<{headline, source, date, url, summary}|null>}
 */
export async function fetchTopNews(phrase) {
  if (!phrase?.trim()) return null;

  // Recent news only - a two-year-old article makes a post less timely, not more.
  const query = `${phrase.trim()} when:30d`;
  const url = `${FEED}?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; meera-linkedin-bot/1.0)" },
    });
    if (!res.ok) {
      console.warn(`news: feed returned ${res.status}`);
      return null;
    }

    const xml = await res.text();
    const first = xml.match(/<item>([\s\S]*?)<\/item>/i);
    if (!first) return null;

    const item = first[1];
    const rawTitle = tag(item, "title");
    if (!rawTitle) return null;

    const { headline, source } = splitTitle(rawTitle, tag(item, "source"));
    const pubDate = tag(item, "pubDate");

    return {
      headline,
      source: source || "Google News",
      date: pubDate ? new Date(pubDate).toISOString().slice(0, 10) : "",
      url: tag(item, "link"),
      // Google News descriptions are a list of related links; the headline
      // carries the actual information, so keep this short and optional.
      summary: clean(tag(item, "description")).slice(0, 200),
    };
  } catch (err) {
    console.warn("news: lookup failed -", err?.name === "AbortError" ? "timed out" : err?.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The verify flag the brief requires on any draft built with a news item.
 * Not optional: a fact published in her name that she has not checked is the
 * exact failure this pipeline exists to prevent.
 */
export function verifyBlock(news) {
  return [
    "─────────────────────────────────",
    `NEWS SOURCE: ${news.headline}`,
    `FROM: ${news.source}${news.date ? ` · ${news.date}` : ""}`,
    `LINK: ${news.url}`,
    "⚠ Check this before publishing — you are the author of this claim",
    "─────────────────────────────────",
  ].join("\n");
}
