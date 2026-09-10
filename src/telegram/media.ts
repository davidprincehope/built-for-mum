import { createHash } from 'node:crypto';
import { writeFile, unlink, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function getLargestPhotoId(photo: Array<{ file_id: string; file_size?: number }>): string | null {
  if (!photo || photo.length === 0) return null;
  const sorted = [...photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0));
  const first = sorted[0];
  if (!first?.file_id) return null;
  return first.file_id;
}

export function extFromMime(mime?: string): string {
  if (!mime) return '.bin';
  const m = mime.toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
  if (m.includes('png')) return '.png';
  if (m.includes('webp')) return '.webp';
  if (m.includes('pdf')) return '.pdf';
  return '.bin';
}

export async function downloadTelegramFile(
  fileId: string,
  token: string,
): Promise<{ buffer: Buffer; filePath: string; fileSize?: number }> {
  if (!fileId) throw new Error('getFile failed: missing file_id');
  if (!token) throw new Error('getFile failed: missing TELEGRAM_BOT_TOKEN');

  const gfRes = await fetch(`https://api.telegram.org/bot${token}/getFile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });

  let gfJson: { ok: boolean; result?: { file_path?: string; file_size?: number }; description?: string } = { ok: false };
  try {
    gfJson = (await gfRes.json()) as typeof gfJson;
  } catch {
    throw new Error('getFile failed: invalid response from Telegram');
  }

  if (!gfRes.ok || !gfJson.ok || !gfJson.result?.file_path) {
    const desc = gfJson.description ?? 'no file_path (file too large or expired?)';
    throw new Error(`getFile failed: ${desc}`);
  }

  const filePath = gfJson.result.file_path;
  const dlUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const dlRes = await fetch(dlUrl);
  if (!dlRes.ok) {
    throw new Error(`getFile failed: download failed ${dlRes.status}`);
  }

  const buffer = Buffer.from(await dlRes.arrayBuffer());
  if (buffer.length > 20 * 1024 * 1024) {
    throw new Error('File too large — 20MB max via Telegram cloud. Send compressed image or use local Bot API server');
  }
  // Also enforce file_size from getFile if present >20MB before download would have been skipped, but we already downloaded; keep guard
  return { buffer, filePath, fileSize: gfJson.result.file_size };
}

export async function tmpWriteWithHash(
  buffer: Buffer,
  ext: string = '.jpg',
): Promise<{ tmpPath: string; contentHash: string }> {
  const contentHash = createHash('sha256').update(buffer).digest('hex');
  const safeExt = ext.startsWith('.') ? ext : `.${ext}`;
  const tmpPath = join(tmpdir(), `tg-verify-${contentHash}${safeExt}`);
  await writeFile(tmpPath, buffer);
  // 24h auto-unlink unref
  setTimeout(() => {
    unlink(tmpPath).catch(() => {});
  }, 24 * 60 * 60 * 1000).unref();
  return { tmpPath, contentHash };
}

export async function cleanupStaleTmp(): Promise<void> {
  let files: string[] = [];
  try {
    files = await readdir(tmpdir());
  } catch {
    return;
  }
  const now = Date.now();
  const threshold = 24 * 60 * 60 * 1000;
  const targets = files.filter((f) => f.startsWith('tg-verify-'));
  await Promise.all(
    targets.map(async (f) => {
      const full = join(tmpdir(), f);
      try {
        const s = await stat(full);
        const age = now - s.mtimeMs;
        if (age > threshold) {
          await unlink(full).catch(() => {});
        }
      } catch {
        // ignore missing/stat errors
      }
    }),
  );
}
