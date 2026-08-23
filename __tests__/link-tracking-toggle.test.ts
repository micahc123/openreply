import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolveLinkUrl,
  isLinkTrackingDisabled,
  renderMessageWithTracking,
} from "../lib/tracking/message";

const link = { slug: "abc123", destinationUrl: "https://www.vividsites.app/" };

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXTAUTH_URL", "https://openreply.example.com");
});

describe("link tracking toggle", () => {
  it("tracks through our own host by default", () => {
    expect(isLinkTrackingDisabled()).toBe(false);
    expect(resolveLinkUrl(link)).toBe("https://openreply.example.com/r/abc123");
  });

  it("sends the destination directly when tracking is disabled", () => {
    vi.stubEnv("DISABLE_LINK_TRACKING", "1");
    expect(isLinkTrackingDisabled()).toBe(true);
    expect(resolveLinkUrl(link)).toBe("https://www.vividsites.app/");
  });

  it("only disables on exactly '1', so a stray value cannot silently drop tracking", () => {
    vi.stubEnv("DISABLE_LINK_TRACKING", "true");
    expect(isLinkTrackingDisabled()).toBe(false);
    expect(resolveLinkUrl(link)).toBe("https://openreply.example.com/r/abc123");
  });

  // The whole point: {link} must still be substituted. Leaving the literal
  // token in the message is what a naive "just remove the tracked link"
  // approach produces.
  it("substitutes {link} with the destination when disabled", () => {
    vi.stubEnv("DISABLE_LINK_TRACKING", "1");
    expect(
      renderMessageWithTracking({
        message: "Here you go 🔥 {link}",
        trackedLinks: [link],
      })
    ).toBe("Here you go 🔥 https://www.vividsites.app/");
  });

  it("substitutes {link} with the tracked URL when enabled", () => {
    expect(
      renderMessageWithTracking({
        message: "Here you go 🔥 {link}",
        trackedLinks: [link],
      })
    ).toBe("Here you go 🔥 https://openreply.example.com/r/abc123");
  });
});
