import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { AuthError } from "@/lib/errors";

const requireUser = vi.fn();
const requireRole = vi.fn((profile: { role: string }, roles: string[]) => {
  if (!roles.includes(profile.role)) throw new AuthError("Forbidden", 403);
});
vi.mock("@/lib/auth", () => ({
  requireUser,
  requireRole,
}));

const fromMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => ({ from: fromMock }),
}));

function makeRequest(id: string, reason = "Reported as fraudulent") {
  return new NextRequest(`http://localhost/api/documents/${id}/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
}

describe("POST /api/documents/:id/revoke — authorization", () => {
  beforeEach(() => {
    requireUser.mockReset();
    requireRole.mockClear();
    fromMock.mockReset();
  });

  it("returns 401 when unauthenticated", async () => {
    requireUser.mockRejectedValue(new AuthError("Missing Authorization bearer token.", 401));
    const { POST } = await import("@/app/api/documents/[id]/revoke/route");
    const res = await POST(makeRequest("doc-1"), { params: Promise.resolve({ id: "doc-1" }) });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a citizen role", async () => {
    requireUser.mockResolvedValue({ id: "user-1", role: "citizen" });
    const { POST } = await import("@/app/api/documents/[id]/revoke/route");
    const res = await POST(makeRequest("doc-1"), { params: Promise.resolve({ id: "doc-1" }) });
    expect(res.status).toBe(403);
  });

  it("returns 403 when the officer is not a member of the document's institution", async () => {
    requireUser.mockResolvedValue({ id: "user-1", role: "institution_officer" });
    const docBuilder: Record<string, unknown> = {
      select: vi.fn(() => docBuilder),
      eq: vi.fn(() => docBuilder),
      maybeSingle: vi.fn(async () => ({
        data: { id: "doc-1", institution_id: "inst-1", status: "active" },
        error: null,
      })),
    };
    const membershipBuilder: Record<string, unknown> = {
      select: vi.fn(() => membershipBuilder),
      eq: vi.fn(() => membershipBuilder),
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    };
    fromMock.mockImplementation((table: string) =>
      table === "institution_members" ? membershipBuilder : docBuilder
    );
    const { POST } = await import("@/app/api/documents/[id]/revoke/route");
    const res = await POST(makeRequest("doc-1"), { params: Promise.resolve({ id: "doc-1" }) });
    expect(res.status).toBe(403);
  });
});
