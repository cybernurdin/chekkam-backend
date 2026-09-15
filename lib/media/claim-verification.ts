/**
 * Claim verification deliberately keeps three different kinds of evidence
 * separate: what text we could obtain, whether a published fact check matched
 * it, and the publisher/provenance check performed elsewhere. A missing fact
 * check is never reported as a false claim.
 */
export type ClaimSource = {
  title: string;
  url: string;
  publisher: string | null;
  rating: string | null;
  reviewed_at: string | null;
};

export type ClaimResult = {
  claim: string;
  status: "matched_fact_check" | "no_match" | "provider_not_configured";
  sources: ClaimSource[];
};

export type TranscriptResult = {
  text: string;
  status: "provided" | "caption_extracted" | "unavailable";
  detail: string;
};

const MAX_TRANSCRIPT_CHARS = 12_000;
const MAX_CLAIMS = 5;
const FACT_CHECK_ENDPOINT = "https://factchecktools.googleapis.com/v1alpha1/claims:search";

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function isTikTokUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    return host === "tiktok.com" || host.endsWith(".tiktok.com");
  } catch {
    return false;
  }
}

/**
 * TikTok does not provide a public audio-transcript API. Its oEmbed response
 * can provide a post title/caption, which is useful lead text but is labelled
 * accordingly so it cannot be mistaken for a spoken-word transcript.
 */
export async function extractPublicPostText(url: string): Promise<TranscriptResult> {
  if (!isTikTokUrl(url)) {
    return {
      text: "",
      status: "unavailable",
      detail: "This public link does not provide a transcript to Chekkam. Paste a transcript or share the original audio/video file.",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const endpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
    const response = await fetch(endpoint, {
      headers: { "User-Agent": "Chekkam verification service/1.0" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`TikTok oEmbed HTTP ${response.status}`);
    const payload = await response.json();
    const caption = cleanText(payload?.title).slice(0, MAX_TRANSCRIPT_CHARS);
    if (!caption) throw new Error("TikTok oEmbed had no title");
    return {
      text: caption,
      status: "caption_extracted",
      detail: "Chekkam extracted the public post caption/title. It is not a transcript of the spoken audio.",
    };
  } catch {
    return {
      text: "",
      status: "unavailable",
      detail: "Chekkam could not obtain a public caption from this TikTok link. Paste a transcript or share the original audio/video file.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function suppliedTranscript(value: string | undefined): TranscriptResult | null {
  const text = cleanText(value).slice(0, MAX_TRANSCRIPT_CHARS);
  if (!text) return null;
  return {
    text,
    status: "provided",
    detail: "Transcript supplied by the person submitting this check. Review it against the original media.",
  };
}

export function extractCheckableClaims(text: string): string[] {
  const candidates = cleanText(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 25 && sentence.length <= 500);
  return [...new Set(candidates)].slice(0, MAX_CLAIMS);
}

type GoogleClaimReview = {
  publisher?: { name?: string; site?: string };
  url?: string;
  title?: string;
  textualRating?: string;
  reviewDate?: string;
};

type GoogleClaim = { text?: string; claimReview?: GoogleClaimReview[] };

function sourceFromReview(review: GoogleClaimReview): ClaimSource | null {
  if (!review.url) return null;
  return {
    title: cleanText(review.title) || "Fact-check review",
    url: review.url,
    publisher: cleanText(review.publisher?.name) || cleanText(review.publisher?.site) || null,
    rating: cleanText(review.textualRating) || null,
    reviewed_at: cleanText(review.reviewDate) || null,
  };
}

export async function searchFactChecks(claim: string, languageCode: string): Promise<ClaimResult> {
  const key = process.env.GOOGLE_FACT_CHECK_API_KEY;
  if (!key) return { claim, status: "provider_not_configured", sources: [] };

  const params = new URLSearchParams({
    query: claim,
    languageCode: languageCode === "fr" ? "fr" : "en",
    pageSize: "5",
    key,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${FACT_CHECK_ENDPOINT}?${params}`, { signal: controller.signal });
    if (!response.ok) return { claim, status: "no_match", sources: [] };
    const payload = (await response.json()) as { claims?: GoogleClaim[] };
    const sources = (payload.claims ?? [])
      .flatMap((item) => item.claimReview ?? [])
      .map(sourceFromReview)
      .filter((source): source is ClaimSource => source !== null)
      .slice(0, 5);
    return { claim, status: sources.length ? "matched_fact_check" : "no_match", sources };
  } catch {
    return { claim, status: "no_match", sources: [] };
  } finally {
    clearTimeout(timeout);
  }
}

export async function transcribeMedia(file: File): Promise<TranscriptResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { text: "", status: "unavailable", detail: "Speech transcription is not configured yet." };
  }
  const form = new FormData();
  form.append("file", file, file.name || "shared-media.mp4");
  form.append("model", process.env.OPENAI_TRANSCRIPTION_MODEL ?? "gpt-4o-mini-transcribe");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55_000);
  try {
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`transcription HTTP ${response.status}`);
    const payload = await response.json();
    const text = cleanText(payload?.text).slice(0, MAX_TRANSCRIPT_CHARS);
    if (!text) throw new Error("empty transcription");
    return { text, status: "provided", detail: "Speech was transcribed from the submitted media. Review it against the original media." };
  } catch {
    return { text: "", status: "unavailable", detail: "Chekkam could not transcribe this media. Paste a transcript and try again." };
  } finally {
    clearTimeout(timeout);
  }
}
