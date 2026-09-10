import { beforeEach, describe, expect, it, vi } from "vitest";

const { query, admin } = vi.hoisted(() => ({ query: vi.fn(), admin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: admin }));
import { GET } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
  admin.mockReturnValue({ from: () => ({ select: () => ({ limit: () => ({ abortSignal: query }) }) }) });
});

describe("deployment readiness", () => {
  it("returns a non-cacheable success after the database responds", async () => {
    query.mockResolvedValue({ error: null });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok", database: "ok" });
  });

  it("reports missing schema as unavailable without leaking database details", async () => {
    query.mockResolvedValue({ error: { message: "private database details" } });
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable", database: "unavailable" });
  });

  it("reports missing configuration or connection failures as unavailable", async () => {
    admin.mockImplementation(() => { throw new Error("secret configuration"); });
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable", database: "unavailable" });
  });
});
