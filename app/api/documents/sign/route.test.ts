import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { AuthError } from "@/lib/errors";

const requireUser = vi.fn();
const requireRole = vi.fn((profile: { role: string }, roles: string[]) => {
  if (!roles.includes(profile.role)) throw new AuthError("Forbidden", 403);
});
const requireInstitutionMember = vi.fn();
vi.mock("@/lib/auth", () => ({
  requireUser,
  requireRole,
  requireInstitutionMember,
}));

const fromMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => ({ from: fromMock }),
}));

const signDocumentCore = vi.fn();
vi.mock("@/lib/documents/sign-document", () => ({
  signDocumentCore,
}));

function makeSignRequest() {
  const form = new FormData();
  form.set("institution_id", "c13b37f0-1000-4000-8000-000000000099");
  form.set("document_type", "certificate");
  form.set("file", new Blob([new Uint8Array([1, 2, 3])]), "test.pdf");
  return new NextRequest("http://localhost/api/documents/sign", { method: "POST", body: form });
}

describe("POST /api/documents/sign — authorization", () => {
  beforeEach(() => {
    requireUser.mockReset();
    requireRole.mockClear();
    requireInstitutionMember.mockReset();
    fromMock.mockReset();
    signDocumentCore.mockReset();
  });

  it("returns 401 when unauthenticated — never reaches signDocumentCore", async () => {
    requireUser.mockRejectedValue(new AuthError("Missing Authorization bearer token.", 401));
    const { POST } = await import("@/app/api/documents/sign/route");
    const res = await POST(makeSignRequest());
    expect(res.status).toBe(401);
    expect(signDocumentCore).not.toHaveBeenCalled();
  });

  it("returns 403 for a citizen role — never reaches signDocumentCore", async () => {
    requireUser.mockResolvedValue({ id: "user-1", role: "citizen" });
    const { POST } = await import("@/app/api/documents/sign/route");
    const res = await POST(makeSignRequest());
    expect(res.status).toBe(403);
    expect(signDocumentCore).not.toHaveBeenCalled();
  });

  it("returns 403 when the officer is not a member of the target institution", async () => {
    requireUser.mockResolvedValue({ id: "user-1", role: "institution_officer" });
    requireInstitutionMember.mockRejectedValue(
      new AuthError("You are not a member of this institution.", 403)
    );
    const { POST } = await import("@/app/api/documents/sign/route");
    const res = await POST(makeSignRequest());
    expect(res.status).toBe(403);
    expect(signDocumentCore).not.toHaveBeenCalled();
  });

  it("never includes private key material in the response body", async () => {
    requireUser.mockResolvedValue({ id: "officer-1", role: "institution_officer" });
    requireInstitutionMember.mockResolvedValue(undefined);
    fromMock.mockReturnValue({
      select: vi.fn(function (this: unknown) {
        return this;
      }),
      eq: vi.fn(function (this: unknown) {
        return this;
      }),
      single: vi.fn(async () => ({ data: { status: "active" }, error: null })),
    });
    signDocumentCore.mockResolvedValue({
      id: "doc-1",
      verification_id: "CHK-TEST-0001",
      pin_code: "123456",
      qr_payload: "https://example.cm/verify/CHK-TEST-0001",
      qr_image: "data:image/png;base64,xxx",
      status: "active",
      has_original_download: false,
    });
    const { POST } = await import("@/app/api/documents/sign/route");
    const res = await POST(makeSignRequest());
    const bodyText = await res.text();
    expect(bodyText).not.toMatch(/BEGIN (EC )?PRIVATE KEY/);
    expect(res.status).toBe(201);
  });
});
