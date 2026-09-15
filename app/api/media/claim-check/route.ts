import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit } from "@/lib/rate-limit";
import { ValidationError, toErrorResponse } from "@/lib/errors";
import { parseBody } from "@/lib/validation/parse";
import { extractCheckableClaims, extractPublicPostText, searchFactChecks, suppliedTranscript, transcribeMedia, type TranscriptResult } from "@/lib/media/claim-verification";
import { consumeUpload } from "@/lib/media/upload";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

// Vercel Functions reject request/response payloads over 4.5 MB. Leave
// headroom for multipart encoding; a file over this size must go through
// POST /api/media/claim-check/upload-url and be submitted here by
// storage_path instead of inline multipart.
const MAX_INLINE_MEDIA_BYTES = 4 * 1024 * 1024;
const RATE_LIMIT = 8;
const RATE_WINDOW_SECONDS = 10 * 60;

const jsonSchema = z.object({
  url: z.string().url().max(4096).optional(),
  transcript: z.string().max(12_000).optional(),
  storage_path: z.string().regex(/^\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.(mp4|mov|webm|3gp|mp3|m4a|wav|ogg)$/).optional(),
  language: z.enum(["en", "fr"]).default("en"),
}).refine((value) => value.url || value.transcript || value.storage_path, {
  message: "A public URL, transcript, or uploaded storage_path is required.",
});

function emptyResult(transcript: TranscriptResult, language: string) {
  return {
    mode: "media_claim_check",
    transcript,
    claims: [],
    sources: [],
    provider_status: process.env.GOOGLE_FACT_CHECK_API_KEY ? "ready" : "not_configured",
    needs_human_review: true,
    recommended_action: transcript.status === "unavailable"
      ? "Paste a transcript or share a short original audio/video clip to check factual claims."
      : "Read the original media in context before deciding whether to share it.",
    language,
  };
}

/** POST /api/media/claim-check
 *
 * Checks statements, not the truthfulness of a whole video. A TikTok URL can
 * yield its public caption only; it cannot lawfully or reliably yield an
 * audio transcript without the original media. The mobile share flow makes
 * that distinction visible to the person checking it.
 */
export async function POST(req: NextRequest) {
  try {
    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
    const rate = await checkRateLimit(`media-claim-check:${clientIp}`, RATE_LIMIT, RATE_WINDOW_SECONDS);
    if (!rate.allowed) return NextResponse.json({ error: { code: "RATE_LIMITED", message: "Too many claim checks from this network. Please wait and try again." } }, { status: 429 });

    const contentType = req.headers.get("content-type") ?? "";
    let transcript: TranscriptResult;
    let language = "en";
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      language = form.get("language") === "fr" ? "fr" : "en";
      if (!(file instanceof File)) throw new ValidationError("file is required.", "file");
      if (file.size > MAX_INLINE_MEDIA_BYTES) {
        return NextResponse.json({
          ...emptyResult({ text: "", status: "unavailable", detail: "This video is too large to send this way. Request an upload_url from POST /api/media/claim-check/upload-url, upload the file there, then resubmit this request with { storage_path } instead of the file." }, language),
          upload: { status: "direct_upload_required", max_inline_bytes: MAX_INLINE_MEDIA_BYTES, upload_url_endpoint: "/api/media/claim-check/upload-url" },
        }, { status: 413 });
      }
      transcript = await transcribeMedia(file);
    } else {
      const body = parseBody(jsonSchema, await req.json());
      language = body.language;
      if (body.storage_path) {
        const consumed = await consumeUpload(getSupabaseAdmin(), body.storage_path);
        if (!consumed.ok) {
          const detail = consumed.reason === "too_large"
            ? "The uploaded file is larger than the 24 MB transcription limit. Share a shorter clip or paste a transcript."
            : "Chekkam could not read the uploaded file. It may have expired — upload it again and retry.";
          return NextResponse.json(emptyResult({ text: "", status: "unavailable", detail }, language));
        }
        transcript = await transcribeMedia(consumed.file);
      } else {
        transcript = suppliedTranscript(body.transcript) ?? await extractPublicPostText(body.url!);
      }
    }
    if (!transcript.text) return NextResponse.json(emptyResult(transcript, language));

    const claimTexts = extractCheckableClaims(transcript.text);
    const claims = await Promise.all(claimTexts.map((claim) => searchFactChecks(claim, language)));
    const sources = claims.flatMap((claim) => claim.sources).filter((source, index, items) => items.findIndex((candidate) => candidate.url === source.url) === index);
    return NextResponse.json({
      mode: "media_claim_check",
      transcript,
      claims,
      sources,
      provider_status: process.env.GOOGLE_FACT_CHECK_API_KEY ? "ready" : "not_configured",
      needs_human_review: true,
      recommended_action: claims.some((claim) => claim.status === "matched_fact_check")
        ? "Open the linked fact-check sources, compare the wording and date, and review the original media before sharing."
        : "No matching published fact check was found. This is not evidence that the claim is true or false; check primary and official sources.",
      language,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
