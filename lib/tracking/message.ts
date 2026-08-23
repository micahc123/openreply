export interface MessageTrackedLink {
  slug: string;
  destinationUrl: string;
}

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/i;

function trimTrailingPunctuation(url: string) {
  return url.replace(/[.,!?;:]+$/, "");
}

export function extractFirstUrl(message: string): string | null {
  const match = message.match(URL_PATTERN);
  if (!match) return null;

  try {
    const url = trimTrailingPunctuation(match[0]);
    return new URL(url).toString();
  } catch {
    return null;
  }
}

export function replaceUrlWithTrackedPlaceholder(
  message: string,
  destinationUrl: string | null | undefined
) {
  if (!destinationUrl) return message;
  if (message.includes(destinationUrl)) {
    return message.replace(destinationUrl, "{link}");
  }

  const withoutTrailingSlash = destinationUrl.replace(/\/$/, "");
  return message.replace(withoutTrailingSlash, "{link}");
}

/**
 * Personalize {username} and strip the {link} token — used when the link is
 * delivered as a separate button rather than inline in the message text.
 */
export function renderMessageWithoutLink({
  message,
  commenterName,
}: {
  message: string;
  commenterName?: string | null;
}) {
  return message
    .replace(/\{username\}/gi, commenterName ?? "there")
    .replace(/\s*\{link\}\s*/gi, " ")
    .trim();
}

export function buildTrackedUrl(slug: string, baseUrl?: string) {
  const resolvedBaseUrl =
    baseUrl ??
    (typeof window !== "undefined"
      ? window.location.origin
      : process.env.NEXTAUTH_URL ?? "http://localhost:3000");

  return `${resolvedBaseUrl.replace(/\/$/, "")}/r/${slug}`;
}

export function renderMessageWithTracking({
  message,
  commenterName,
  trackedLinks,
  baseUrl,
}: {
  message: string;
  commenterName?: string | null;
  trackedLinks?: MessageTrackedLink[];
  baseUrl?: string;
}) {
  let rendered = message.replace(/\{username\}/gi, commenterName ?? "there");
  const primaryLink = trackedLinks?.[0];

  if (!primaryLink) return rendered;

  const trackedUrl = resolveLinkUrl(primaryLink, baseUrl);

  if (/\{link\}/i.test(rendered)) {
    return rendered.replace(/\{link\}/gi, trackedUrl);
  }

  if (rendered.includes(primaryLink.destinationUrl)) {
    rendered = rendered.replaceAll(primaryLink.destinationUrl, trackedUrl);
  } else {
    const withoutTrailingSlash = primaryLink.destinationUrl.replace(/\/$/, "");
    rendered = rendered.replaceAll(withoutTrailingSlash, trackedUrl);
  }

  return rendered;
}

/**
 * Whether link tracking is switched off for this deployment.
 *
 * Tracked links route through this app's own host (`/r/<slug>`), which is what
 * records a click. That is normally what you want — but if that hostname is
 * unreachable for some audience (an ISP that fails to resolve it, say), every
 * link in every DM is dead for those people. Setting DISABLE_LINK_TRACKING=1
 * sends the destination URL directly instead: no click stats, but the link
 * always opens.
 *
 * Note this must NOT be implemented by dropping tracked links from a campaign.
 * Instagram rejects a plain-text DM containing a raw URL (Meta error 508);
 * business-sent links are only accepted inside a web_url button template. So
 * the link still travels as a button — only the URL inside it changes.
 */
export function isLinkTrackingDisabled(): boolean {
  return process.env.DISABLE_LINK_TRACKING === "1";
}

/** The URL to actually put in front of a user for a given tracked link. */
export function resolveLinkUrl(
  link: { slug: string; destinationUrl: string },
  baseUrl?: string
): string {
  return isLinkTrackingDisabled()
    ? link.destinationUrl
    : buildTrackedUrl(link.slug, baseUrl);
}
