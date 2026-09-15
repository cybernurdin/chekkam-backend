import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limit";
import { toErrorResponse } from "@/lib/errors";
import { createUploadTarget } from "@/lib/media/upload";
import { parseBody } from "@/lib/validation/parse";

const RATE_LIMIT = 8;
const RATE_WINDOW_SECONDS = 10 * 60;
const bodySchema = z.object({ filename: z.string().trim().min(1).max(255) });

/**
 * POST /api/media/claim-check/upload-url
 *
 * Step one of the large-media claim-check flow: issue a short-lived signed
 * Supabase Storage upload URL so the client can send a video/audio file
 * (up to 24MB) straight to storage, bypassing the ~4.5MB Vercel Function
 * body limit that blocks most real shared video clips. The client then
 * PUTs the file to `signed_url` and calls POST /api/media/claim-check with
 * `{ storage_path }` instead of a multipart file.
 */
export async function POST(req: NextRequest) {
  try {
    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
    const rate = await checkRateLimit(`media-claim-check-upload-url:${clientIp}`, RATE_LIMIT, RATE_WINDOW_SECONDS);
    if (!rate.allowed) {
      return NextResponse.json({ error: { code: "RATE_LIMITED", message: "Too many upload requests from this network. Please wait and try again." } }, { status: 429 });
    }

    const body = parseBody(bodySchema, await req.json());
    const admin = getSupabaseAdmin();
    const target = await createUploadTarget(admin, body.filename);
    return NextResponse.json({
      storage_path: target.path,
      upload_token: target.token,
      signed_url: target.signed_url,
      max_bytes: 24 * 1024 * 1024,
      expires_in_seconds: 120,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
