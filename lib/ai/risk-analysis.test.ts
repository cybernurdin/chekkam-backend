import { describe, expect, it, vi, beforeEach } from "vitest";
import { ruleBasedFallback } from "@/lib/ai/risk-analysis";

const { logAiPrediction } = vi.hoisted(() => ({
  logAiPrediction: vi.fn<(entry: Record<string, unknown>) => Promise<void>>(async () => {}),
}));
vi.mock("@/lib/ai/predictions", () => ({
  logAiPrediction,
}));

describe("ruleBasedFallback", () => {
  it("flags urgency + payment language as high risk, low confidence", () => {
    const result = ruleBasedFallback(
      "URGENT: send money now via mobile money or lose your scholarship, act now!"
    );
    expect(result.risk_level).toBe("high");
    expect(result.category).toBe("mobile_money_fraud");
    expect(result.confidence).toBe("low");
    expect(result.needs_human_review).toBe(true);
    expect(result.source).toBe("rule_based_fallback");
    expect(result.indicators.has_urgency_pressure).toBe(true);
    expect(result.indicators.requests_payment).toBe(true);
    expect(result.suspicious_phrases.length).toBeGreaterThan(0);
    expect(result.suspicious_phrases).toContain("URGENT");
  });

  it("flags a bare link with no other signals as low/medium risk phishing", () => {
    const result = ruleBasedFallback("Check this out: https://example.com/win");
    expect(result.indicators.contains_suspicious_link).toBe(true);
    expect(result.category).toBe("phishing");
    expect(result.risk_level).toBe("medium");
  });

  it("returns low risk with a pending-review reason for benign text", () => {
    const result = ruleBasedFallback("Hello, how are you today?");
    expect(result.risk_level).toBe("low");
    expect(result.reasons[0]).toMatch(/not been reviewed/i);
    expect(result.suspicious_phrases).toEqual([]);
  });
});

describe("ruleBasedFallback — claimed mobile-money transaction time", () => {
  // A classic Cameroon momo scam: the scammer shows a fake/reused "payment
  // sent" SMS so the victim hands over goods before checking their real
  // balance. The message always carries a bare clock time, never a date.
  const now = new Date("2026-03-10T14:00:00.000Z");

  it("flags a claimed transaction time that hasn't happened yet", () => {
    const result = ruleBasedFallback(
      "You have received 25,000 XAF mobile money transfer at 23:45. Thank you.",
      "en",
      now
    );
    expect(result.indicators.claimed_transaction_time_mismatch).toBe("future");
    expect(result.reasons.some((r) => /hasn't occurred yet/i.test(r))).toBe(true);
  });

  it("flags a claimed transaction time hours in the past as a possibly-reused message", () => {
    const result = ruleBasedFallback(
      "You have received 25,000 XAF mobile money transfer at 08:00. Thank you.",
      "en",
      now
    );
    expect(result.indicators.claimed_transaction_time_mismatch).toBe("stale");
    expect(result.reasons.some((r) => /much earlier than now/i.test(r))).toBe(true);
  });

  it("does not flag a claimed time within a normal recent window", () => {
    const result = ruleBasedFallback(
      "You have received 25,000 XAF mobile money transfer at 13:55. Thank you.",
      "en",
      now
    );
    expect(result.indicators.claimed_transaction_time_mismatch).toBe("none");
  });

  it("treats a late-night time seen shortly after midnight as yesterday, not ~24h in the future", () => {
    const justAfterMidnight = new Date("2026-03-10T00:10:00.000Z");
    const result = ruleBasedFallback(
      "You have received 25,000 XAF mobile money transfer at 23:55. Thank you.",
      "en",
      justAfterMidnight
    );
    // 23:55 "today" would be ~23h45 in the future; the plausible reading is
    // 23:55 yesterday — 15 minutes ago, not a future or a stale claim.
    expect(result.indicators.claimed_transaction_time_mismatch).toBe("none");
  });

  it("does not run the time check at all when the message doesn't mention payment", () => {
    const result = ruleBasedFallback("Meeting moved to 23:45 tomorrow, see you then.", "en", now);
    expect(result.indicators.claimed_transaction_time_mismatch).toBe("none");
  });
});

describe("analyzeContent (no OPENAI_API_KEY)", () => {
  beforeEach(() => {
    logAiPrediction.mockClear();
    vi.stubEnv("OPENAI_API_KEY", "");
  });

  it("falls back to the local model (ahead of pure rule-based) and logs the prediction", async () => {
    const { analyzeContent } = await import("@/lib/ai/risk-analysis");
    const result = await analyzeContent("send money now, urgent!", {
      reportId: "report-123",
      inputType: "text",
    });

    // The local model (lib/ai/local-model.ts) loads successfully in this
    // environment, so it is the fallback used here — pure keyword-only
    // rule-based fallback is now the third tier, exercised directly by the
    // ruleBasedFallback() unit tests above, not by this no-API-key path.
    expect(result.source).toBe("local_model");
    expect(logAiPrediction).toHaveBeenCalledTimes(1);
    const call = logAiPrediction.mock.calls[0][0] as Record<string, unknown>;
    expect(call.reportId).toBe("report-123");
    expect(call.inputType).toBe("text");
    expect(call.source).toBe("local_model");
    expect(typeof call.latencyMs).toBe("number");
  });
});

describe("localModelFallback", () => {
  it("produces a complete RiskAnalysisResult shape with source local_model", async () => {
    const { localModelFallback } = await import("@/lib/ai/risk-analysis");
    const result = localModelFallback("URGENT: send money now via mobile money or lose your scholarship!");
    expect(result).not.toBeNull();
    expect(result!.source).toBe("local_model");
    expect(result!.needs_human_review).toBe(true);
    expect(["low", "medium", "high", "critical"]).toContain(result!.risk_level);
    expect(["low", "medium", "high"]).toContain(result!.confidence);
    expect(result!.indicators.has_urgency_pressure).toBe(true);
    expect(result!.indicators.requests_payment).toBe(true);
  });
});
