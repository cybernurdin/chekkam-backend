import { randomUUID } from "crypto";
import path from "node:path";
import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Direct-to-storage upload for media too large to send through a single
 * Vercel Function body (4.5MB). The client asks for a signed upload URL,
 * PUTs the file straight to Supabase Storage, then calls claim-check with
 * the storage path instead of raw bytes. Chekkam never keeps this media
 * beyond the single check: `consumeUpload` deletes the object whether the
 * transcription succeeds or fails (data minimization, CLAUDE.md §5.5).
 */
const BUCKET = "media-check-uploads";
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

export type UploadTarget = {
  path: string;
  token: string;
  signed_url: string;
};

const ALLOWED_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".3gp", ".mp3", ".m4a", ".wav", ".ogg"]);

export async function createUploadTarget(admin: SupabaseClient, filename: string): Promise<UploadTarget> {
  const extension = path.extname(filename).toLowerCase();
  // Preserve an allowed extension: OpenAI uses the file's container/type when
  // deciding how to transcribe it, and Supabase enforces allowed MIME types.
  const suffix = ALLOWED_EXTENSIONS.has(extension) ? extension : ".mp4";
  const objectPath = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}${suffix}`;
  const { data, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(objectPath);
  if (error || !data) throw new Error(`could not create upload target: ${error?.message ?? "unknown error"}`);
  return { path: objectPath, token: data.token, signed_url: data.signedUrl };
}

export type ConsumedUpload =
  | { ok: true; file: File }
  | { ok: false; reason: "not_found" | "too_large" | "download_failed" };

/**
 * Reads an uploaded object back as a File (so it can go straight into the
 * existing transcribeMedia(file) without changing that function), then
 * always deletes the object. A failed or oversized read still deletes
 * whatever was written, so nothing lingers in storage past one request.
 */
export async function consumeUpload(admin: SupabaseClient, path: string): Promise<ConsumedUpload> {
  try {
    const { data: info } = await admin.storage.from(BUCKET).list(path.split("/")[0], {
      search: path.split("/")[1],
    });
    const size = info?.[0]?.metadata?.size as number | undefined;
    if (typeof size === "number" && size > MAX_UPLOAD_BYTES) {
      return { ok: false, reason: "too_large" };
    }

    const { data, error } = await admin.storage.from(BUCKET).download(path);
    if (error || !data) return { ok: false, reason: "not_found" };
    const filename = path.split("/").pop() || "shared-media";
    return { ok: true, file: new File([data], filename, { type: data.type || "application/octet-stream" }) };
  } catch {
    return { ok: false, reason: "download_failed" };
  } finally {
    await admin.storage.from(BUCKET).remove([path]).catch(() => undefined);
  }
}
