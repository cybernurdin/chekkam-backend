import { afterEach, describe, expect, it, vi } from "vitest";
import { verifySignature } from "@/lib/crypto/verify";
import { generateSigningKeyPair, hashDocument, normalizePublicKeyPem } from "@/lib/crypto/sign";
import { signDocumentCore } from "@/lib/documents/sign-document";
import { verifyByUpload, verifyByIdOrPin } from "@/lib/documents/verify";

function verifierAdmin(doc: Record<string, unknown>) {
  const documentBuilder: Record<string, unknown> = {
    select: vi.fn(() => documentBuilder),
    or: vi.fn(() => documentBuilder),
    eq: vi.fn(() => documentBuilder),
    maybeSingle: vi.fn(async () => ({ data: doc, error: null })),
  };
  return {
    from: vi.fn((table: string) =>
      table === "document_verification_logs"
        ? { insert: vi.fn(async () => ({ data: null, error: null })) }
        : documentBuilder
    ),
  };
}

describe("signed document verification lifecycle", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("signs an original, detects a changed original, and returns revoked after withdrawal", async () => {
    const institutionId = "c13b37f0-1000-4000-8000-000000000001";
    const envKey = `DOCUMENT_SIGNING_KEY_${institutionId.replace(/-/g, "_").toUpperCase()}`;
    const { privateKey, publicKey } = generateSigningKeyPair();
    vi.stubEnv(envKey, privateKey.replace(/\n/g, "\\n"));

    let inserted: Record<string, unknown> | null = null;
    const documentsBuilder: Record<string, unknown> = {
      insert: vi.fn((payload: Record<string, unknown>) => {
        inserted = payload;
        return documentsBuilder;
      }),
      select: vi.fn(() => documentsBuilder),
      single: vi.fn(async () => ({
        data: {
          id: "doc-1",
          verification_id: inserted?.verification_id,
          pin_code: inserted?.pin_code,
          qr_payload: inserted?.qr_payload,
          status: "active",
        },
        error: null,
      })),
    };
    const institutionBuilder: Record<string, unknown> = {
      select: vi.fn(() => institutionBuilder),
      eq: vi.fn(() => institutionBuilder),
      maybeSingle: vi.fn(async () => ({ data: { signing_public_key: publicKey }, error: null })),
    };
    const keyHistoryBuilder = {
      upsert: vi.fn(async () => ({ data: null, error: null })),
    };
    const signingAdmin = {
      from: vi.fn((table: string) =>
        table === "documents"
          ? documentsBuilder
          : table === "institutions"
            ? institutionBuilder
            : table === "institution_signing_keys"
              ? keyHistoryBuilder
          : { insert: vi.fn(async () => ({ data: null, error: null })) }
      ),
    };

    const original = Buffer.from("original signed scholarship certificate");
    const signed = await signDocumentCore(signingAdmin as never, {
      institutionId,
      documentType: "scholarship",
      recipientName: "Ada Example",
      fileBuffer: original,
      actorId: "officer-1",
    });

    expect(signed.qr_payload).toContain(`/verify/${signed.verification_id}`);
    expect(signed.qr_image).toMatch(/^data:image\/png/);
    expect(inserted).not.toBeNull();
    // The mock callback mutates this value asynchronously; make that fact
    // explicit for TypeScript's control-flow analysis.
    const insertedPayload = inserted as Record<string, unknown> | null;
    expect(
      verifySignature(
        hashDocument(original),
        insertedPayload?.signature as string,
        publicKey
      )
    ).toBe(true);
    expect(insertedPayload?.signing_public_key_snapshot).toBe(normalizePublicKeyPem(publicKey));

    const baseDocument = {
      id: "doc-1",
      verification_id: signed.verification_id,
      file_hash: insertedPayload?.file_hash,
      signature: insertedPayload?.signature,
      document_type: "scholarship",
      recipient_name: "Ada Example",
      expiry_date: null,
      signing_public_key_snapshot: publicKey,
      institutions: { name: "Example University", verified: true, signing_public_key: publicKey },
    };

    const genuine = await verifyByUpload(
      verifierAdmin({ ...baseDocument, status: "active" }) as never,
      original,
      signed.verification_id,
      "mobile"
    );
    expect(genuine.status).toBe("genuine");
    expect(genuine.institution_verified).toBe(true);

    const tampered = await verifyByUpload(
      verifierAdmin({ ...baseDocument, status: "active" }) as never,
      Buffer.concat([original, Buffer.from(" altered")]),
      signed.verification_id,
      "mobile"
    );
    expect(tampered.status).toBe("tampered");

    const revoked = await verifyByUpload(
      verifierAdmin({
        ...baseDocument,
        status: "revoked",
        revoked_at: "2026-07-28T00:00:00.000Z",
        revocation_reason: "Superseded by a corrected document",
      }) as never,
      original,
      signed.verification_id,
      "mobile"
    );
    expect(revoked.status).toBe("revoked");
    expect(revoked.reason).toBe("Superseded by a corrected document");
  });

  it("returns not_found (never a 'fake' verdict) for a file that was never signed", async () => {
    const notFoundAdmin = verifierAdmin(null as never);
    const result = await verifyByUpload(
      notFoundAdmin as never,
      Buffer.from("some random file nobody ever signed"),
      null,
      "mobile"
    );
    expect(result.status).toBe("not_found");
    expect(JSON.stringify(result).toLowerCase()).not.toContain("fake");
  });

  it("gives consistent results between an ID/PIN-only lookup and a full-file upload of the same document", async () => {
    const institutionId = "c13b37f0-1000-4000-8000-000000000002";
    const envKey = `DOCUMENT_SIGNING_KEY_${institutionId.replace(/-/g, "_").toUpperCase()}`;
    const { privateKey, publicKey } = generateSigningKeyPair();
    vi.stubEnv(envKey, privateKey.replace(/\n/g, "\\n"));

    let inserted: Record<string, unknown> | null = null;
    const documentsBuilder: Record<string, unknown> = {
      insert: vi.fn((payload: Record<string, unknown>) => {
        inserted = payload;
        return documentsBuilder;
      }),
      select: vi.fn(() => documentsBuilder),
      single: vi.fn(async () => ({
        data: {
          id: "doc-2",
          verification_id: inserted?.verification_id,
          pin_code: inserted?.pin_code,
          qr_payload: inserted?.qr_payload,
          status: "active",
        },
        error: null,
      })),
    };
    const institutionBuilder: Record<string, unknown> = {
      select: vi.fn(() => institutionBuilder),
      eq: vi.fn(() => institutionBuilder),
      maybeSingle: vi.fn(async () => ({ data: { signing_public_key: publicKey }, error: null })),
    };
    const keyHistoryBuilder = { upsert: vi.fn(async () => ({ data: null, error: null })) };
    const signingAdmin = {
      from: vi.fn((table: string) =>
        table === "documents"
          ? documentsBuilder
          : table === "institutions"
            ? institutionBuilder
            : table === "institution_signing_keys"
              ? keyHistoryBuilder
              : { insert: vi.fn(async () => ({ data: null, error: null })) }
      ),
    };

    const original = Buffer.from("a genuine mobile-money merchant licence");
    const signed = await signDocumentCore(signingAdmin as never, {
      institutionId,
      documentType: "merchant_licence",
      fileBuffer: original,
      actorId: "officer-1",
    });
    const insertedPayload = inserted as Record<string, unknown> | null;

    const baseDocument = {
      id: "doc-2",
      verification_id: signed.verification_id,
      file_hash: insertedPayload?.file_hash,
      signature: insertedPayload?.signature,
      document_type: "merchant_licence",
      recipient_name: null,
      expiry_date: null,
      signing_public_key_snapshot: publicKey,
      institutions: { name: "Example University", verified: true, signing_public_key: publicKey },
    };

    // Same underlying record, checked two different ways — QR scan lands on
    // an ID/PIN-only lookup (no file to hash), the public /verify page's
    // upload form hashes the actual file. Both must agree it's genuine.
    const byIdOnly = await verifyByIdOrPin(
      verifierAdmin({ ...baseDocument, status: "active" }) as never,
      signed.verification_id,
      "web"
    );
    const byUpload = await verifyByUpload(
      verifierAdmin({ ...baseDocument, status: "active" }) as never,
      original,
      signed.verification_id,
      "web"
    );
    expect(byIdOnly.status).toBe("genuine");
    expect(byUpload.status).toBe("genuine");
    expect(byIdOnly.verification_id).toBe(byUpload.verification_id);
    expect(byIdOnly.institution).toBe(byUpload.institution);
  });
});
