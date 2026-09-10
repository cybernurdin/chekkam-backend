import QRCode from "qrcode";

/** Builds the public verification URL encoded into a document's (or, with
 * pathSegment="verify-product", a product's — Phase 10) QR code. SRS 10.1 step 5. */
export function buildVerificationUrl(verificationId: string, pathSegment: string = "verify"): string {
  const base = process.env.APP_BASE_URL ?? "https://chekkam-backend-seven.vercel.app";
  return `${base.replace(/\/$/, "")}/${pathSegment}/${verificationId}`;
}

/** Renders a QR code as a base64 PNG data URL, generated server-side. SRS 10.1 step 6. */
export async function generateQrDataUrl(payload: string): Promise<string> {
  return QRCode.toDataURL(payload, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 320,
  });
}
