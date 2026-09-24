import { Redis } from "@upstash/redis";

/**
 * Storage backend switch. Vercel's KV/Redis marketplace integration sets
 * these env vars automatically once a store is attached to the project, so
 * production (the webhook + cron functions) picks up Redis with zero config.
 * Locally - and in tests - those vars are absent, so store.js/sessions.js/
 * scheduler.js fall back to the filesystem/in-memory implementations that
 * ran everything before this file existed. One process, one backend: never
 * mix the two at once.
 *
 * Two naming conventions exist depending on which Vercel integration was
 * used (the older "KV" one vs. the current Upstash Redis one on the
 * Marketplace), so both are accepted.
 */
const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const hasKv = Boolean(url && token);

export const kv = hasKv ? new Redis({ url, token }) : null;
