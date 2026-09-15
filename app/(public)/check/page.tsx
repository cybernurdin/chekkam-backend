"use client";

import { useState } from "react";
import Link from "next/link";
import { LanguageToggle } from "@/components/language-toggle";
import { useI18n } from "@/components/i18n-provider";
import { MediaClaimCheckForm } from "@/components/media-claim-check-form";

type ReportResult = {
  id: string;
  status: string;
  risk_level?: "low" | "medium" | "high" | "critical";
  risk_score?: number;
  category?: string;
  ai_reasons?: string[];
  recommended_action?: string;
  confidence?: string;
};

const RISK_CLASS: Record<string, string> = {
  low: "bg-status-success/12 text-status-success",
  medium: "bg-status-warning/12 text-status-warning",
  high: "bg-status-danger/12 text-status-danger",
  critical: "bg-status-danger/12 text-status-danger",
};

export default function CheckPage() {
  const { lang, t } = useI18n();
  const [checkMode, setCheckMode] = useState<"message" | "media">("message");
  const [contentType, setContentType] = useState<"text" | "link">("text");
  const [content, setContent] = useState("");
  const [result, setResult] = useState<ReportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const submitRes = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept-Language": lang },
        body: JSON.stringify({
          content_type: contentType,
          raw_content: content,
          channel: "web",
          language: lang,
        }),
      });
      const submitted = await submitRes.json();
      if (!submitRes.ok) throw new Error(submitted?.error?.message ?? t("failedSubmit"));

      const detailRes = await fetch(`/api/reports/${submitted.id}?lang=${lang}`, {
        headers: { "Accept-Language": lang },
      });
      const detail = await detailRes.json();
      if (!detailRes.ok) throw new Error(detail?.error?.message ?? t("failedLoadResult"));
      setResult(detail as ReportResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("somethingWrong"));
    } finally {
      setLoading(false);
    }
  }

  const riskLabel = result?.risk_level
    ? {
        low: t("lowRisk"),
        medium: t("mediumRisk"),
        high: t("highRisk"),
        critical: t("criticalRisk"),
      }[result.risk_level]
    : null;

  return (
    <div className="mx-auto flex min-h-full w-full max-w-2xl flex-1 flex-col justify-center px-6 py-16">
      <div className="mb-6 flex items-center justify-between gap-4">
        <Link href="/" className="text-sm font-medium text-chekkam-muted hover:text-chekkam-primary">
          ← {t("backChekkam")}
        </Link>
        <LanguageToggle />
      </div>
      <div className="text-xs font-semibold uppercase tracking-wider text-chekkam-primary">
        {t("checkMessage")}
      </div>
      <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-semibold text-chekkam-ink">
        {t("gotSuspicious")}
      </h1>
      <p className="mt-2 text-sm text-chekkam-muted">{t("checkIntro")}</p>

      <div className="mt-6 flex gap-2">
        {(["message", "media"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => setCheckMode(mode)}
            className={`rounded-[var(--radius-chekkam-sm)] px-4 py-1.5 text-sm font-medium transition ${
              checkMode === mode
                ? "bg-chekkam-ink text-white"
                : "bg-chekkam-tint text-chekkam-muted hover:bg-chekkam-border"
            }`}
          >
            {mode === "message" ? t("checkModeMessage") : t("checkModeMedia")}
          </button>
        ))}
      </div>

      {checkMode === "media" ? (
        <div className="mt-6">
          <MediaClaimCheckForm />
        </div>
      ) : (
        <>
      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
        <div className="flex gap-2">
          {(["text", "link"] as const).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setContentType(type)}
              className={`rounded-[var(--radius-chekkam-sm)] px-4 py-1.5 text-sm font-medium transition ${
                contentType === type
                  ? "bg-chekkam-primary text-white"
                  : "bg-chekkam-tint text-chekkam-muted hover:bg-chekkam-border"
              }`}
            >
              {type === "text" ? t("text") : t("link")}
            </button>
          ))}
        </div>
        <textarea
          required
          rows={6}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={contentType === "link" ? "https://example.com/suspicious-link" : t("pasteMessageHere")}
          className="w-full rounded-[var(--radius-chekkam)] border border-chekkam-border bg-chekkam-tint px-4 py-3 text-sm text-chekkam-ink outline-none transition focus:border-chekkam-primary focus:bg-chekkam-surface-raised focus:ring-2 focus:ring-chekkam-primary/20"
        />
        {error && <p className="text-sm text-status-danger">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="rounded-[var(--radius-chekkam-sm)] bg-gradient-hero px-4 py-2.5 text-sm font-semibold text-white shadow-chekkam-sm transition hover:brightness-110 disabled:opacity-60"
        >
          {loading ? t("analyzing") : t("checkThis")}
        </button>
      </form>

      {result && (
        <div className="mt-8 rounded-[var(--radius-chekkam)] border border-chekkam-border bg-chekkam-surface-raised p-6 shadow-chekkam-md">
          {result.risk_level && riskLabel ? (
            <span
              className={`inline-block rounded-full px-3 py-1 text-sm font-semibold ${
                RISK_CLASS[result.risk_level] ?? "bg-status-neutral/12 text-status-neutral"
              }`}
            >
              {riskLabel}
            </span>
          ) : (
            <span className="inline-block rounded-full bg-status-neutral/12 px-3 py-1 text-sm font-semibold text-status-neutral">
              {t("pendingReview")}
            </span>
          )}
          <p className="mt-4 font-[family-name:var(--font-heading)] text-xl font-semibold text-chekkam-ink">
            {result.recommended_action ?? t("reportQueued")}
          </p>
          {result.ai_reasons && result.ai_reasons.length > 0 && (
            <ul className="mt-4 list-inside list-disc text-sm text-chekkam-muted">
              {result.ai_reasons.map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ul>
          )}
          <div className="mt-5 flex items-start gap-3 rounded-[var(--radius-chekkam-sm)] bg-chekkam-tint p-4">
            <span className="text-chekkam-primary">i</span>
            <p className="text-sm text-chekkam-muted">{t("automatedFirstLook")}</p>
          </div>
        </div>
      )}
        </>
      )}

      <div className="mt-10 flex gap-4 text-sm">
        <Link href="/verify" className="font-medium text-chekkam-primary hover:underline">
          {t("verifyDocument")} →
        </Link>
        <Link href="/alerts" className="font-medium text-chekkam-primary hover:underline">
          {t("seePublicAlerts")} →
        </Link>
      </div>
    </div>
  );
}
