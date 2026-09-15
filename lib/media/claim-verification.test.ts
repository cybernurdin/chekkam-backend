import { afterEach, describe, expect, it, vi } from "vitest";
import { extractCheckableClaims, searchFactChecks, suppliedTranscript } from "./claim-verification";

const originalKey = process.env.GOOGLE_FACT_CHECK_API_KEY;

afterEach(() => {
  if (originalKey === undefined) delete process.env.GOOGLE_FACT_CHECK_API_KEY;
  else process.env.GOOGLE_FACT_CHECK_API_KEY = originalKey;
  vi.unstubAllGlobals();
});

describe("media claim verification", () => {
  it("keeps only a small, de-duplicated set of checkable statements", () => {
    expect(extractCheckableClaims("A short sentence. Cameroon announced a new nationwide vaccination campaign on Monday. Cameroon announced a new nationwide vaccination campaign on Monday.")).toEqual([
      "Cameroon announced a new nationwide vaccination campaign on Monday.",
    ]);
  });

  it("does not pretend a supplied transcript came from the media", () => {
    expect(suppliedTranscript("  Spoken words from the original video. ")).toMatchObject({
      status: "provided",
      text: "Spoken words from the original video.",
    });
  });

  it("reports source search as unconfigured instead of making up sources", async () => {
    delete process.env.GOOGLE_FACT_CHECK_API_KEY;
    await expect(searchFactChecks("A checkable claim", "en")).resolves.toEqual({
      claim: "A checkable claim",
      status: "provider_not_configured",
      sources: [],
    });
  });

  it("maps published fact-check reviews to source links", async () => {
    process.env.GOOGLE_FACT_CHECK_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      claims: [{ claimReview: [{
        publisher: { name: "Africa Check" },
        url: "https://example.org/review",
        title: "Claim review",
        textualRating: "False",
        reviewDate: "2026-09-15",
      }] }],
    }), { status: 200 })));
    await expect(searchFactChecks("A checkable claim", "en")).resolves.toEqual({
      claim: "A checkable claim",
      status: "matched_fact_check",
      sources: [{
        title: "Claim review",
        url: "https://example.org/review",
        publisher: "Africa Check",
        rating: "False",
        reviewed_at: "2026-09-15",
      }],
    });
  });
});
