import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { consumeUpload, createUploadTarget } from "./upload";

function fakeAdmin(storageBucket: Record<string, unknown>) {
  return {
    storage: { from: vi.fn(() => storageBucket) },
  } as unknown as SupabaseClient;
}

describe("createUploadTarget", () => {
  it("returns the signed upload path/token/url", async () => {
    const bucket = {
      createSignedUploadUrl: vi.fn(async () => ({
        data: { path: "ignored", token: "tok_123", signedUrl: "https://storage.example/upload" },
        error: null,
      })),
    };
    const target = await createUploadTarget(fakeAdmin(bucket), "clip.mp4");
    expect(target.token).toBe("tok_123");
    expect(target.signed_url).toBe("https://storage.example/upload");
    expect(target.path).toMatch(/^\d{4}-\d{2}-\d{2}\/[0-9a-f-]+\.mp4$/);
  });

  it("falls back to .mp4 for an unrecognized/missing extension", async () => {
    const bucket = {
      createSignedUploadUrl: vi.fn(async () => ({
        data: { path: "ignored", token: "tok_123", signedUrl: "https://storage.example/upload" },
        error: null,
      })),
    };
    const target = await createUploadTarget(fakeAdmin(bucket), "shared-media");
    expect(target.path).toMatch(/\.mp4$/);
  });

  it("throws when Supabase Storage returns an error", async () => {
    const bucket = {
      createSignedUploadUrl: vi.fn(async () => ({ data: null, error: { message: "bucket missing" } })),
    };
    await expect(createUploadTarget(fakeAdmin(bucket), "clip.mp4")).rejects.toThrow(/bucket missing/);
  });
});

describe("consumeUpload", () => {
  it("returns the file and deletes the object on success", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "video/mp4" });
    const remove = vi.fn(async () => ({ data: null, error: null }));
    const bucket = {
      list: vi.fn(async () => ({ data: [{ metadata: { size: 3 } }], error: null })),
      download: vi.fn(async () => ({ data: blob, error: null })),
      remove,
    };
    const result = await consumeUpload(fakeAdmin(bucket), "2026-01-01/abc");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.name).toBe("abc");
    expect(remove).toHaveBeenCalledWith(["2026-01-01/abc"]);
  });

  it("rejects a file over the transcription size cap without downloading it", async () => {
    const download = vi.fn();
    const bucket = {
      list: vi.fn(async () => ({ data: [{ metadata: { size: 30 * 1024 * 1024 } }], error: null })),
      download,
      remove: vi.fn(async () => ({ data: null, error: null })),
    };
    const result = await consumeUpload(fakeAdmin(bucket), "2026-01-01/big");
    expect(result).toEqual({ ok: false, reason: "too_large" });
    expect(download).not.toHaveBeenCalled();
  });

  it("reports not_found and still attempts cleanup when the download fails", async () => {
    const remove = vi.fn(async () => ({ data: null, error: null }));
    const bucket = {
      list: vi.fn(async () => ({ data: [], error: null })),
      download: vi.fn(async () => ({ data: null, error: { message: "not found" } })),
      remove,
    };
    const result = await consumeUpload(fakeAdmin(bucket), "2026-01-01/missing");
    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(remove).toHaveBeenCalledWith(["2026-01-01/missing"]);
  });
});
