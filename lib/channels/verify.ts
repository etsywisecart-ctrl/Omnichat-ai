import crypto from "crypto";

/**
 * Verify Meta's X-Hub-Signature-256 header against the raw request body.
 *
 * Fails CLOSED: with no app secret configured there is no way to tell a real
 * delivery from a forged one, so the request is rejected. The previous
 * behaviour — returning true when the secret was missing — meant a typo in an
 * environment variable silently turned webhook authentication off.
 *
 * The comparison is constant-time so response timing can't be used to guess a
 * valid signature byte by byte.
 */
export function verifyMetaSignature(
  body: string,
  signature: string,
  appSecret: string
): boolean {
  if (!appSecret) {
    console.error("Meta signature check failed: app secret is not configured");
    return false;
  }
  if (!signature.startsWith("sha256=")) return false;

  const expected = `sha256=${crypto.createHmac("sha256", appSecret).update(body).digest("hex")}`;

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

/**
 * Compare a webhook verify token in constant time.
 * An unset expected token rejects, rather than matching anything.
 */
export function verifyHubToken(provided: string | null, expected: string | undefined): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
