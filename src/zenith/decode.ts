import quotedPrintable from 'quoted-printable';

export function base64UrlToBase64(s: string): string {
  let b = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b.length % 4;
  if (pad) b += '='.repeat(4 - pad);
  return b;
}

/**
 * D-09: strict B64 -> QP -> HTML pipeline with no fallback.
 * Throws on bad base64 or QP failure.
 */
export function decodeStrict(rawBodyB64: string): string {
  if (!rawBodyB64 || typeof rawBodyB64 !== 'string') {
    throw new Error('strict-decode: base64 fail: empty input');
  }

  // Validate base64url/base64 shape — reject obviously invalid chars
  const normalizedInput = rawBodyB64.replace(/[\r\n\s]/g, '');
  if (!/^[A-Za-z0-9+/=_-]+$/.test(normalizedInput)) {
    throw new Error('strict-decode: base64 fail: invalid base64 characters');
  }

  let qp: string;
  try {
    const b64 = base64UrlToBase64(normalizedInput);
    // Buffer.from never throws on invalid base64; it silently ignores bad chars — so we already validated regex above
    // Re-encode check: ensure round-trip length is plausible
    const buf = Buffer.from(b64, 'base64');
    if (buf.length === 0 && normalizedInput.length > 0) {
      throw new Error('strict-decode: base64 fail: decoded empty');
    }
    qp = buf.toString('utf-8');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('strict-decode')) throw e;
    throw new Error(`strict-decode: base64 fail: ${msg}`);
  }

  try {
    const decoded = quotedPrintable.decode(qp);
    // quoted-printable returns binary string; convert to utf-8
    return Buffer.from(decoded, 'binary').toString('utf-8');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`strict-decode: quopri fail: ${msg}`);
  }
}
