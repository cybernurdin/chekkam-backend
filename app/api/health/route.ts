import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Readiness probe: checks database access without exposing credentials or records. */
export async function GET() {
  try {
    const { error } = await getSupabaseAdmin()
      .from("institution_signing_keys")
      .select("institution_id", { head: true })
      .limit(1)
      .abortSignal(AbortSignal.timeout(5_000));
    if (error) throw error;
    return NextResponse.json(
      { status: "ok", database: "ok" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { status: "unavailable", database: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
