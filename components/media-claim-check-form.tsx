"use client";

import { useState } from "react";
import { useI18n } from "@/components/i18n-provider";

type ClaimSource = {
  title: string;
  url: string;
  publisher: string | null;
  rating: string | null;
  reviewed_at: string | null;
};

type Claim = {
  claim: string;
  status: "matched_fact_check" | "no_match" | "provider_not_configured";
  sources: ClaimSource[];
};

type ClaimCheckResult = {
  transcript: { text: string; status: string; detail: string };
  claims: Claim[];
  sources: ClaimSource[];
  provider_status: "ready" | "not_configured";
  needs_human_review: boolean;
  recommended_action: string;
};

const MAX_INLINE_BYTES = 4 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

function contentTypeForFilename(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".3gp")) return "video/3gpp";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  return "application/octet-stream";
}

async function readApiError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    return body?.error?.message || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Web counterpart of the Flutter share-review upload path: a clip under
 * 4MB goes straight through /api/media/claim-check; a larger one is
 * written directly to short-lived Supabase Storage (bypassing Vercel's
 * ~4.5MB body limit) and consumed/deleted by the backend in one request.
 * Same engine, same two-step honesty rules, as every other surface.
 */
export function MediaClaimCheckForm() {
  const { lang, t } = useI18n();
  const [mode, setMode] = useState<"link" | "file">("link");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<"idle" | "uploading" | "checking">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ClaimCheckResult | null>(null);

  const loading = phase !== "idle";

  async function checkByUrl(value: string): Promise<ClaimCheckResult> {
    const res = await fetch("/api/media/claim-check", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept-Language": lang },
      body: JSON.stringify({ url: value, language: lang }),
    });
    if (!res.ok) throw new Error(await readApiError(res, t("somethingWrong")));
    return res.json();
  }

  async function checkByFile(selected: File): Promise<ClaimCheckResult> {
    if (selected.size > MAX_UPLOAD_BYTES) throw new Error(t("videoFileTooLarge"));

    if (selected.size <= MAX_INLINE_BYTES) {
      setPhase("checking");
      const form = new FormData();
      form.append("file", selected, selected.name);
      form.append("language", lang);
      const res = await fetch("/api/media/claim-check", {
        method: "POST",
        headers: { "Accept-Language": lang },
        body: form,
      });
      if (!res.ok) throw new Error(await readApiError(res, t("somethingWrong")));
      return res.json();
    }

    setPhase("uploading");
    const targetRes = await fetch("/api/media/claim-check/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept-Language": lang },
      body: JSON.stringify({ filename: selected.name }),
    });
    if (!targetRes.ok) throw new Error(await readApiError(targetRes, t("somethingWrong")));
    const target = await targetRes.json();
    const signedUrl: string | undefined = target?.signed_url;
    const storagePath: string | undefined = target?.storage_path;
    if (!signedUrl || !storagePath) throw new Error(t("somethingWrong"));

    const uploadRes = await fetch(signedUrl, {
      method: "PUT",
      headers: { "Content-Type": contentTypeForFilename(selected.name), "x-upsert": "false" },
      body: selected,
    });
    if (!uploadRes.ok) throw new Error(t("somethingWrong"));

    setPhase("checking");
    const res = await fetch("/api/media/claim-check", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept-Language": lang },
      body: JSON.stringify({ storage_path: storagePath, language: lang }),
    });
    if (!res.ok) throw new Error(await readApiError(res, t("somethingWrong")));
    return res.json();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === "link" && !url.trim()) return;
    if (mode === "file" && !file) return;
    setError(null);
    setResult(null);
    setPhase(mode === "link" ? "checking" : "uploading");
    try {
      const data = mode === "link" ? await checkByUrl(url.trim()) : await checkByFile(file!);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("somethingWrong"));
    } finally {
      setPhase("idle");
    }
  }

  return (
    <div>
      <p className="text-sm text-chekkam-muted">{t("videoCheckIntro")}</p>

      <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4">
        <div className="flex gap-2">
          {(["link", "file"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setMode(option)}
              className={`rounded-[var(--radius-chekkam-sm)] px-4 py-1.5 text-sm font-medium transition ${
                mode === option
                  ? "bg-chekkam-primary text-white"
                  : "bg-chekkam-tint text-chekkam-muted hover:bg-chekkam-border"
              }`}
            >
              {option === "link" ? t("videoModeLink") : t("videoModeFile")}
            </button>
          ))}
        </div>

        {mode === "link" ? (
          <input
            required
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t("videoLinkPlaceholder")}
            className="w-full rounded-[var(--radius-chekkam)] border border-chekkam-border bg-chekkam-tint px-4 py-3 text-sm text-chekkam-ink outline-none transition focus:border-chekkam-primary focus:bg-chekkam-surface-raised focus:ring-2 focus:ring-chekkam-primary/20"
          />
        ) : (
          <div className="flex flex-col gap-2">
            <label className="w-full cursor-pointer rounded-[var(--radius-chekkam)] border border-dashed border-chekkam-border bg-chekkam-tint px-4 py-3 text-sm text-chekkam-muted transition hover:border-chekkam-primary">
              {file ? file.name : t("videoChooseFile")}
              <input
                type="file"
                accept="video/*,audio/*"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
            {!file && <span className="text-xs text-chekkam-faint">{t("videoNoFileChosen")}</span>}
          </div>
        )}

        {error && <p className="text-sm text-status-danger">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="rounded-[var(--radius-chekkam-sm)] bg-gradient-hero px-4 py-2.5 text-sm font-semibold text-white shadow-chekkam-sm transition hover:brightness-110 disabled:opacity-60"
        >
          {phase === "uploading" ? t("videoUploading") : phase === "checking" ? t("videoChecking") : t("videoCheckThis")}
        </button>
      </form>

      {result && (
        <div className="mt-8 rounded-[var(--radius-chekkam)] border border-chekkam-border bg-chekkam-surface-raised p-6 shadow-chekkam-md">
          <p className="text-sm text-chekkam-muted">{result.transcript.detail}</p>

          {result.transcript.text && (
            <div className="mt-4">
              <p className="text-sm font-semibold text-chekkam-ink">{t("videoTranscriptTitle")}</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-chekkam-muted">{result.transcript.text}</p>
            </div>
          )}

          {result.transcript.text && (
            <div className="mt-5">
              <p className="text-sm font-semibold text-chekkam-ink">
                {t("videoClaimsSourcesTitle")}
                {result.sources.length > 0 ? ` (${result.sources.length})` : ""}
              </p>
              {result.provider_status === "not_configured" ? (
                <p className="mt-2 text-sm text-status-warning">{t("videoProviderNotConfigured")}</p>
              ) : result.sources.length === 0 ? (
                <p className="mt-2 text-sm text-chekkam-muted">{t("videoNoSourcesFound")}</p>
              ) : (
                <ul className="mt-2 flex flex-col gap-3">
                  {result.sources.map((source) => (
                    <li key={source.url} className="rounded-[var(--radius-chekkam-sm)] bg-chekkam-tint p-4">
                      <p className="text-sm font-medium text-chekkam-ink">{source.title}</p>
                      {(source.publisher || source.rating) && (
                        <p className="mt-1 text-xs text-chekkam-muted">
                          {[source.publisher, source.rating ? `Rating: ${source.rating}` : null].filter(Boolean).join(" · ")}
                        </p>
                      )}
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="mt-1 block break-all text-xs font-medium text-chekkam-primary hover:underline"
                      >
                        {source.url}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <p className="mt-5 text-sm font-semibold text-chekkam-ink">{result.recommended_action}</p>

          <div className="mt-5 flex items-start gap-3 rounded-[var(--radius-chekkam-sm)] bg-chekkam-tint p-4">
            <span className="text-chekkam-primary">i</span>
            <p className="text-sm text-chekkam-muted">{t("videoReviewNotice")}</p>
          </div>
        </div>
      )}
    </div>
  );
}
