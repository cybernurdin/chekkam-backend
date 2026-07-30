import { z } from "zod";
import { RISK_ANALYSIS_SYSTEM_PROMPT, buildUserPrompt } from "@/lib/ai/prompts";
import { getAiConfig } from "@/lib/ai/config";
import { logAiPrediction } from "@/lib/ai/predictions";
import { predictLocalRiskLevel } from "@/lib/ai/local-model";
import { Lang, trRisk } from "@/lib/i18n";

export const riskAnalysisSchema = z.object({
  risk_level: z.enum(["low", "medium", "high", "critical"]),
  risk_score: z.number().int().min(0).max(100),
  category: z.enum([
    "fake_recruitment",
    "scholarship_scam",
    "mobile_money_fraud",
    "phishing",
    "impersonation",
    "fake_government_notice",
    "leaked_document",
    "ai_manipulation",
    "other",
    "none",
  ]),
  language: z.enum(["en", "fr", "pidgin", "mixed", "unknown"]),
  reasons: z.array(z.string()).min(1).max(4),
  indicators: z.object({
    has_urgency_pressure: z.boolean(),
    requests_payment: z.boolean(),
    requests_personal_info: z.boolean(),
    impersonates_institution: z.string().nullable(),
    contains_suspicious_link: z.boolean(),
    /** Set by the rule-based/local-model tiers only (a shared-SMS claimed
     * mobile-money transaction time compared against now — see
     * detectTransactionTimeMismatch). The AI tier doesn't populate this. */
    claimed_transaction_time_mismatch: z.enum(["none", "future", "stale"]).optional(),
  }),
  recommended_action: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
  /** Verbatim quotes from the submitted content that drove the assessment, for UI highlighting. */
  suspicious_phrases: z.array(z.string()).max(6).default([]),
});

export type RiskAnalysisResult = z.infer<typeof riskAnalysisSchema> & {
  needs_human_review: true;
  source: "ai" | "local_model" | "rule_based_fallback";
};

export type AnalyzeContentOptions = {
  /** Report row this analysis belongs to, if one exists yet at call time. */
  reportId?: string | null;
  inputType?: "text" | "link";
  /** Response language for reasons/recommended_action (EN/FR). Defaults to "en". */
  preferredLanguage?: Lang;
};

/**
 * Runs AI risk analysis (SRS Section 8). Always returns a result — falls back
 * to a rule-based check on missing API key, timeout, HTTP error, or invalid
 * JSON (FR-025), so a submitter never sees a bare error instead of a result.
 * needs_human_review is always true regardless of AI confidence (FR-024).
 * Every call is logged to ai_predictions for latency/model/outcome auditing.
 */
export async function analyzeContent(
  content: string,
  options: AnalyzeContentOptions = {}
): Promise<RiskAnalysisResult> {
  const { reportId = null, inputType = "text", preferredLanguage = "en" } = options;
  const { apiKey, model, timeoutMs } = getAiConfig();
  const startedAt = Date.now();

  const logAndReturn = (
    result: RiskAnalysisResult,
    extra: { model?: string | null; error?: string | null } = {}
  ) => {
    void logAiPrediction({
      reportId,
      inputType,
      source: result.source,
      model: extra.model ?? null,
      latencyMs: Date.now() - startedAt,
      riskLevel: result.risk_level,
      riskScore: result.risk_score,
      category: result.category,
      confidence: result.confidence,
      error: extra.error ?? null,
    });
    return result;
  };

  if (!apiKey) {
    return logAndReturn(fallback(content, preferredLanguage));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        temperature: 0.2,
        messages: [
          { role: "system", content: RISK_ANALYSIS_SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(content, preferredLanguage) },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return logAndReturn(fallback(content, preferredLanguage), {
        model,
        error: `OpenAI HTTP ${response.status}`,
      });
    }

    const payload = await response.json();
    const raw = payload?.choices?.[0]?.message?.content;
    if (typeof raw !== "string") {
      return logAndReturn(fallback(content, preferredLanguage), {
        model,
        error: "OpenAI response missing message content",
      });
    }

    const parsed = riskAnalysisSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return logAndReturn(fallback(content, preferredLanguage), {
        model,
        error: "OpenAI response failed schema validation",
      });
    }

    return logAndReturn(
      { ...parsed.data, needs_human_review: true, source: "ai" },
      { model }
    );
  } catch (err) {
    return logAndReturn(fallback(content, preferredLanguage), {
      model,
      error: err instanceof Error ? err.message : "Unknown error",
    });
  } finally {
    clearTimeout(timeout);
  }
}

const URGENCY_WORDS = [
  "urgent",
  "immediately",
  "act now",
  "expires today",
  "last chance",
  "24 hours",
  "urgence",
  "immédiatement",
];
const PAYMENT_WORDS = [
  "send money",
  "processing fee",
  "mobile money",
  "momo",
  "orange money",
  "western union",
  "pay now",
  "frais",
  "paiement",
];
const PERSONAL_INFO_WORDS = [
  "password",
  "pin code",
  "otp",
  "national id",
  "cni",
  "bank details",
  "account number",
];
const LINK_PATTERN = /https?:\/\/\S+|www\.\S+/i;
const INSTITUTION_PATTERN =
  /(minpostel|ministry|ministère|government|gouvernement|police|gendarmerie|customs|douanes|waec|gce board)/i;

// Matches a bare clock time as it appears in a shared mobile-money SMS
// ("...received at 14:32", "sent 2:32pm", "14h32") — no date, since these
// messages/screenshots never include one.
const TRANSACTION_TIME_PATTERN = /\b([01]?\d|2[0-3])[:h]([0-5]\d)\s*(am|pm)?\b/i;
const TRANSACTION_TIME_FUTURE_TOLERANCE_MS = 5 * 60 * 1000; // clock-skew grace window
const TRANSACTION_TIME_STALE_THRESHOLD_MS = 3 * 60 * 60 * 1000; // 3 hours

/**
 * A classic Cameroon mobile-money scam: the scammer shows the victim a fake
 * or reused "payment sent" SMS/screenshot claiming money already arrived, so
 * the victim hands over goods/change before checking their own balance. The
 * message always carries a clock time but never a date, so this compares
 * that claimed time against now — a transaction claimed to have happened in
 * the future is impossible outright; one claimed hours ago being presented
 * as urgent/just-happened suggests an old message is being replayed.
 *
 * A bare time has no date, so "23:50" seen at "00:10" almost certainly means
 * yesterday, not 23h50 from now — if the naive same-day reading would be
 * more than 12h in the future, the more plausible reading is "yesterday."
 */
function detectTransactionTimeMismatch(
  content: string,
  now: Date
): { status: "future" | "stale" | "none"; claimedTime: Date | null } {
  const match = content.match(TRANSACTION_TIME_PATTERN);
  if (!match) return { status: "none", claimedTime: null };

  let hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23) return { status: "none", claimedTime: null };

  const claimed = new Date(now);
  claimed.setHours(hour, minute, 0, 0);
  if (claimed.getTime() - now.getTime() > 12 * 60 * 60 * 1000) {
    claimed.setDate(claimed.getDate() - 1);
  }

  const diffMs = claimed.getTime() - now.getTime();
  if (diffMs > TRANSACTION_TIME_FUTURE_TOLERANCE_MS) return { status: "future", claimedTime: claimed };
  if (-diffMs > TRANSACTION_TIME_STALE_THRESHOLD_MS) return { status: "stale", claimedTime: claimed };
  return { status: "none", claimedTime: claimed };
}

/** Returns the first matching word's original-case substring as it appears in `content`, if any. */
function findOriginalCaseMatch(content: string, words: string[]): string | null {
  const lower = content.toLowerCase();
  for (const word of words) {
    const index = lower.indexOf(word);
    if (index !== -1) return content.slice(index, index + word.length);
  }
  return null;
}

/**
 * The two non-AI tiers, in order: the local model when it can load and
 * predict, the pure-keyword rule-based check otherwise. Never throws.
 */
function fallback(content: string, preferredLanguage: Lang, now: Date = new Date()): RiskAnalysisResult {
  return (
    localModelFallback(content, preferredLanguage, now) ?? ruleBasedFallback(content, preferredLanguage, now)
  );
}

/**
 * Keyword/pattern indicator detection shared by both fallback tiers
 * (rule-based and local-model) — one implementation of "what counts as a
 * suspicious signal," never two.
 */
function detectIndicators(content: string, preferredLanguage: Lang, now: Date = new Date()) {
  const lower = content.toLowerCase();
  const hasUrgency = URGENCY_WORDS.some((w) => lower.includes(w));
  const requestsPayment = PAYMENT_WORDS.some((w) => lower.includes(w));
  const requestsPersonalInfo = PERSONAL_INFO_WORDS.some((w) => lower.includes(w));
  const hasLink = LINK_PATTERN.test(content);
  const institutionMatch = content.match(INSTITUTION_PATTERN)?.[0] ?? null;
  const timeMismatch = requestsPayment ? detectTransactionTimeMismatch(content, now) : { status: "none" as const, claimedTime: null };
  const signalCount = [
    hasUrgency,
    requestsPayment,
    requestsPersonalInfo,
    hasLink,
    timeMismatch.status !== "none",
  ].filter(Boolean).length;

  const reasons: string[] = [];
  const suspiciousPhrases: string[] = [];
  if (hasUrgency) {
    reasons.push(trRisk("urgent", preferredLanguage));
    const match = findOriginalCaseMatch(content, URGENCY_WORDS);
    if (match) suspiciousPhrases.push(match);
  }
  if (requestsPayment) {
    reasons.push(trRisk("payment", preferredLanguage));
    const match = findOriginalCaseMatch(content, PAYMENT_WORDS);
    if (match) suspiciousPhrases.push(match);
  }
  if (requestsPersonalInfo) {
    reasons.push(trRisk("personalInfo", preferredLanguage));
    const match = findOriginalCaseMatch(content, PERSONAL_INFO_WORDS);
    if (match) suspiciousPhrases.push(match);
  }
  if (hasLink) {
    reasons.push(trRisk("link", preferredLanguage));
    const match = content.match(LINK_PATTERN)?.[0];
    if (match) suspiciousPhrases.push(match);
  }
  if (timeMismatch.status === "future") {
    reasons.push(trRisk("claimedTimeInFuture", preferredLanguage));
  } else if (timeMismatch.status === "stale") {
    reasons.push(trRisk("claimedTimeStale", preferredLanguage));
  }
  if (institutionMatch) suspiciousPhrases.push(institutionMatch);
  if (reasons.length === 0) {
    reasons.push(trRisk("noHighRisk", preferredLanguage));
  }

  return {
    signalCount,
    reasons,
    suspiciousPhrases,
    category: requestsPayment ? "mobile_money_fraud" : hasLink ? "phishing" : "other",
    indicators: {
      has_urgency_pressure: hasUrgency,
      requests_payment: requestsPayment,
      requests_personal_info: requestsPersonalInfo,
      impersonates_institution: institutionMatch,
      contains_suspicious_link: hasLink,
      claimed_transaction_time_mismatch: timeMismatch.status,
    },
  } as const;
}

/**
 * Deterministic keyword/pattern fallback used when neither the AI provider
 * nor the local model (lib/ai/local-model.ts) are available. Always yields
 * low confidence per SRS 8.3, so it reads as "we couldn't fully analyze
 * this — a human will look at it" rather than a false "all clear."
 */
export function ruleBasedFallback(
  content: string,
  preferredLanguage: Lang = "en",
  now: Date = new Date()
): RiskAnalysisResult {
  const { signalCount, reasons, suspiciousPhrases, category, indicators } = detectIndicators(
    content,
    preferredLanguage,
    now
  );

  return {
    risk_level: signalCount >= 2 ? "high" : signalCount === 1 ? "medium" : "low",
    risk_score: Math.min(40 + signalCount * 20, 90),
    category,
    language: preferredLanguage,
    reasons,
    indicators,
    recommended_action: trRisk("recommendedAction", preferredLanguage),
    confidence: "low",
    suspicious_phrases: suspiciousPhrases,
    needs_human_review: true,
    source: "rule_based_fallback",
  };
}

/**
 * Local TF-IDF + logistic-regression classifier fallback (FR-026/027) — a
 * fallback tier between the AI call and the pure-keyword rule-based
 * fallback, active with no third-party key and no network call. Predicts
 * risk_level itself (see ml/METRICS.md); category/indicators/reasons still
 * come from the same keyword detection the rule-based tier uses, since the
 * training set is too small to honestly support a learned category
 * classifier. Returns null (never throws) only on an unexpected runtime
 * scoring failure, so callers can fall through to the rule-based tier —
 * ml/model.json itself is a committed static import, always present in a
 * successful build, not something that can be "absent" the way an env var can.
 */
export function localModelFallback(
  content: string,
  preferredLanguage: Lang = "en",
  now: Date = new Date()
): RiskAnalysisResult | null {
  const prediction = predictLocalRiskLevel(content);
  if (!prediction) return null;

  const { reasons, suspiciousPhrases, category, indicators } = detectIndicators(
    content,
    preferredLanguage,
    now
  );
  const scoreByLevel = { low: 20, medium: 55, high: 80 } as const;

  return {
    risk_level: prediction.risk_level,
    risk_score: scoreByLevel[prediction.risk_level],
    category,
    language: preferredLanguage,
    reasons,
    indicators,
    recommended_action: trRisk("recommendedAction", preferredLanguage),
    confidence: prediction.confidence,
    suspicious_phrases: suspiciousPhrases,
    needs_human_review: true,
    source: "local_model",
  };
}
