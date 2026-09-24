import { config } from "./config.js";

/**
 * Direct publishing to LinkedIn. OFF unless both LINKEDIN_ACCESS_TOKEN and
 * LINKEDIN_AUTHOR_URN are set - see README for how to get them.
 *
 * Nothing in this file is ever called automatically. The bot only reaches it
 * when she has approved a draft AND then explicitly runs /publish on it.
 */
export async function publishToLinkedIn(text) {
  if (!config.linkedin.enabled) {
    throw new Error("LinkedIn publishing is not configured.");
  }

  const res = await fetch("https://api.linkedin.com/v2/ugcPosts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.linkedin.accessToken}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify({
      author: config.linkedin.authorUrn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text },
          shareMediaCategory: "NONE",
        },
      },
      visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LinkedIn API ${res.status}: ${body.slice(0, 300)}`);
  }

  const id = res.headers.get("x-restli-id") || "";
  return id ? `https://www.linkedin.com/feed/update/${id}/` : "";
}
