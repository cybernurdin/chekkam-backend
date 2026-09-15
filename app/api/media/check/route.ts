import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { fileTypeFromBuffer } from "file-type";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limit";
import { hashDocument } from "@/lib/crypto/sign";
import { ValidationError, toErrorResponse } from "@/lib/errors";
import { parseBody } from "@/lib/validation/parse";
import { analyzeImageAuthenticity, analyzeAudioAuthenticity, analyzeVideoAuthenticity } from "@/lib/ai/content-authenticity";
import { verifyMediaSource } from "@/lib/media/source-verification";
import { inspectContentCredentials } from "@/lib/media/content-credentials";

// Vercel Functions reject bodies larger than 4.5MB. Keep multipart headroom;
// a future direct-to-storage flow handles larger original media safely.
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const RATE_LIMIT = 15;
const RATE_WINDOW_SECONDS = 10 * 60;

const urlSchema = z.object({
  url: z.string().url().max(4096),
  channel: z.enum(["mobile", "extension", "web", "share_intent"]).default("mobile"),
});

type MediaKind = "image" | "video" | "audio" | "document" | "file" | "link";

function mediaKindForMime(mime: string | undefined): MediaKind {
  if (!mime) return "file";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "document";
  return "file";
}

function sourceSignal(source: Awaited<ReturnType<typeof verifyMediaSource>>) {
  if (source.status === "verified_official_source") {
    return {
      kind: "publisher_source",
      nature: "deterministic",
      result: "verified_official_source",
      detail: source.detail,
    };
  }
  return {
    kind: "publisher_source",
    nature: "registry",
    result: source.status,
    detail: source.detail,
  };
}

function provenanceSignal(provenance: Awaited<ReturnType<typeof inspectContentCredentials>>) {
  return {
    kind: "content_credentials",
    nature: provenance.status === "verified" ? "cryptographic" : "deterministic",
    result: provenance.status,
    detail: provenance.detail,
  };
}

/**
 * POST /api/media/check
 *
 * A deliberately narrow media Trust Report. It can deterministically confirm
 * that a shared public URL came from an approved publisher/domain, and can
 * attach a clearly advisory image assessment when a vision provider is
 * configured. It does not pretend to prove that a video is real, or that a
 * publisher's report is universally true.
 */
export async function POST(req: NextRequest) {
  try {
    const clientIp =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";
    const rate = await checkRateLimit(`media-check:${clientIp}`, RATE_LIMIT, RATE_WINDOW_SECONDS);
    if (!rate.allowed) {
      return NextResponse.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: "Too many media checks from this network. Please wait a few minutes and try again.",
          },
        },
        { status: 429 }
      );
    }

    const admin = getSupabaseAdmin();
    const contentType = req.headers.get("content-type") ?? "";

    if (!contentType.includes("multipart/form-data")) {
      const body = parseBody(urlSchema, await req.json());
      const source = await verifyMediaSource(admin, body.url);
      return NextResponse.json({
        mode: "media_trust_report",
        media_kind: "link",
        is_proof: false,
        verdict: source.status === "verified_official_source" ? "source_verified" : "source_unverified",
        source,
        ai_generation: {
          status: "not_assessed",
          confidence: null,
          detail: "A shared link does not contain enough media data for an AI-generation assessment.",
        },
        signals: [sourceSignal(source)],
        needs_human_review: true,
        recommended_action:
          source.status === "verified_official_source"
            ? "Check the publication date and full context before sharing the claim."
            : "Find the original post or an official publisher before relying on this media.",
      });
    }

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ValidationError("file is required (multipart/form-data).", "file");
    }
    if (file.size > MAX_FILE_BYTES) {
      throw new ValidationError("File exceeds the 4MB inline media-check limit. Send a shorter clip or use direct upload when available.", "file");
    }

    const sourceUrl = form.get("source_url");
    const buffer = Buffer.from(await file.arrayBuffer());
    const sniffed = await fileTypeFromBuffer(buffer);
    const mime = sniffed?.mime ?? (file.type || undefined);
    const mediaKind = mediaKindForMime(mime);
    const source =
      typeof sourceUrl === "string" && sourceUrl.trim()
        ? await verifyMediaSource(admin, sourceUrl)
        : null;
    const provenance = await inspectContentCredentials(
      buffer,
      mime ?? "application/octet-stream"
    );

    let aiGeneration: {
      status: string;
      likelihood: string;
      confidence: string | null;
      detail: string[];
      indicators: Record<string, unknown>;
    };
    if (mediaKind === "image") {
      const assessment = await analyzeImageAuthenticity(buffer, mime ?? "image/*");
      aiGeneration = {
        status: assessment.status,
        likelihood: assessment.ai_likelihood,
        confidence: assessment.confidence,
        detail: assessment.explanation,
        indicators: assessment.indicators,
      };
    } else if (mediaKind === "video") {
      const assessment = analyzeVideoAuthenticity(buffer);
      aiGeneration = {
        status: assessment.status,
        likelihood: assessment.ai_likelihood,
        confidence: assessment.confidence,
        detail: assessment.explanation,
        indicators: assessment.indicators,
      };
    } else if (mediaKind === "audio") {
      const assessment = analyzeAudioAuthenticity(buffer);
      aiGeneration = {
        status: assessment.status,
        likelihood: assessment.ai_likelihood,
        confidence: assessment.confidence,
        detail: assessment.explanation,
        indicators: assessment.indicators,
      };
    } else {
      aiGeneration = {
        status: "not_assessed",
        likelihood: "unknown",
        confidence: null,
        detail:
          mediaKind === "document"
            ? ["Use document verification to check a signed document or PDF signature."]
            : ["This file type cannot be assessed for AI-generation indicators."],
        indicators: {},
      };
    }

    const signals = [
      {
        kind: "file_fingerprint",
        nature: "deterministic",
        result: "sha256_computed",
        detail: "A SHA-256 fingerprint was computed for this submitted file.",
      },
      provenanceSignal(provenance),
      ...(source ? [sourceSignal(source)] : []),
      {
        kind: "ai_generation",
        nature: "advisory",
        result: aiGeneration.status,
        detail: aiGeneration.detail.join(" "),
      },
    ];

    return NextResponse.json({
      mode: "media_trust_report",
      media_kind: mediaKind,
      file_name: file.name,
      file_hash: hashDocument(buffer),
      is_proof: false,
      verdict: source?.status === "verified_official_source" ? "source_verified" : "source_unverified",
      source,
      provenance,
      ai_generation: aiGeneration,
      signals,
      needs_human_review: true,
      recommended_action:
        mediaKind === "document"
          ? "Run document verification to check the issuer registry and any embedded signature."
          : source?.status === "verified_official_source"
            ? "Review the original publication date and context before sharing."
            : "Share the original public link or confirm the claim with a recognised official source.",
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
