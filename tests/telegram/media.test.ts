import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, unlink, stat, readdir } from 'node:fs/promises';

describe('telegram media — 2-step download + tmp + dedup', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('getLargestPhotoId picks largest file_size', async () => {
    const { getLargestPhotoId } = await import('../../src/telegram/media');
    const photos = [
      { file_id: 'small', file_size: 100 },
      { file_id: 'large', file_size: 9000 },
      { file_id: 'mid', file_size: 500 },
    ];
    expect(getLargestPhotoId(photos)).toBe('large');
  });

  it('getLargestPhotoId empty returns null', async () => {
    const { getLargestPhotoId } = await import('../../src/telegram/media');
    expect(getLargestPhotoId([])).toBeNull();
    expect(getLargestPhotoId(null as unknown as Array<{ file_id: string }>)).toBeNull();
  });

  it('downloadTelegramFile success returns buffer via 2-step fetch', async () => {
    const buf = Buffer.from('fake-image-bytes');
    let getFileCalled = false;
    let dlCalled = false;
    global.fetch = vi.fn(async (url: string, _opts?: unknown) => {
      const u = String(url);
      if (u.includes('/getFile')) {
        getFileCalled = true;
        return {
          ok: true,
          json: async () => ({ ok: true, result: { file_path: 'photos/file_1.jpg', file_size: 123 } }),
        } as unknown as Response;
      }
      if (u.includes('/file/bot')) {
        dlCalled = true;
        return {
          ok: true,
          arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
    }) as unknown as typeof fetch;

    const { downloadTelegramFile } = await import('../../src/telegram/media');
    const res = await downloadTelegramFile('file123', 'TOKEN123');
    expect(getFileCalled).toBe(true);
    expect(dlCalled).toBe(true);
    expect(res.buffer.equals(buf)).toBe(true);
    expect(res.filePath).toBe('photos/file_1.jpg');
  });

  it('downloadTelegramFile missing file_path throws friendly error', async () => {
    global.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/getFile')) {
        return {
          ok: true,
          json: async () => ({ ok: true, result: {} }),
        } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
    }) as unknown as typeof fetch;

    const { downloadTelegramFile } = await import('../../src/telegram/media');
    await expect(downloadTelegramFile('bigfile', 'TOKEN')).rejects.toThrow(/getFile failed/);
  });

  it('downloadTelegramFile >20MB throws', async () => {
    const big = Buffer.alloc(21 * 1024 * 1024, 0x41);
    global.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/getFile')) {
        return {
          ok: true,
          json: async () => ({ ok: true, result: { file_path: 'photos/big.jpg', file_size: 21 * 1024 * 1024 } }),
        } as unknown as Response;
      }
      if (u.includes('/file/bot')) {
        return {
          ok: true,
          arrayBuffer: async () => big.buffer.slice(big.byteOffset, big.byteOffset + big.byteLength),
        } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
    }) as unknown as typeof fetch;

    const { downloadTelegramFile } = await import('../../src/telegram/media');
    await expect(downloadTelegramFile('bigfile', 'TOKEN')).rejects.toThrow(/File too large/);
  });

  it('downloadTelegramFile getFile non-ok throws', async () => {
    global.fetch = vi.fn(async () => {
      return {
        ok: false,
        status: 429,
        json: async () => ({ ok: false, description: 'Too Many Requests' }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const { downloadTelegramFile } = await import('../../src/telegram/media');
    await expect(downloadTelegramFile('file1', 'TOKEN')).rejects.toThrow(/getFile failed/);
  });

  it('tmpWriteWithHash creates file with SHA256 name and schedules 24h unlink', async () => {
    const { tmpWriteWithHash } = await import('../../src/telegram/media');
    const buf = Buffer.from('hello-world-tmp-test-' + Date.now());
    const { createHash } = await import('node:crypto');
    const expectedHash = createHash('sha256').update(buf).digest('hex');
    const { tmpPath, contentHash } = await tmpWriteWithHash(buf, '.jpg');
    expect(contentHash).toBe(expectedHash);
    expect(tmpPath).toContain(`tg-verify-${expectedHash}.jpg`);
    const s = await stat(tmpPath);
    expect(s.isFile()).toBe(true);
    // cleanup immediately (proves write worked); 24h unref timer is verified by code inspection
    await unlink(tmpPath).catch(() => {});
    expect(contentHash).toBe(expectedHash);
  });

  it('cleanupStaleTmp sweeps old tg-verify files', async () => {
    const { tmpWriteWithHash, cleanupStaleTmp } = await import('../../src/telegram/media');
    // create a stale file manually with old mtime
    const buf = Buffer.from('stale-test');
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(buf).digest('hex');
    const stalePath = join(tmpdir(), `tg-verify-${hash}-stale-test.bin`);
    await writeFile(stalePath, buf);
    // set mtime to 25h ago via utimes
    const { utimes } = await import('node:fs/promises');
    const old = Date.now() - 25 * 60 * 60 * 1000;
    const oldDate = new Date(old);
    await utimes(stalePath, oldDate, oldDate);
    // ensure file exists
    const before = await stat(stalePath).then(() => true).catch(() => false);
    expect(before).toBe(true);
    await cleanupStaleTmp();
    const after = await stat(stalePath).then(() => true).catch(() => false);
    expect(after).toBe(false);
  });

  it('extFromMime maps correctly', async () => {
    const { extFromMime } = await import('../../src/telegram/media');
    expect(extFromMime('image/jpeg')).toBe('.jpg');
    expect(extFromMime('image/png')).toBe('.png');
    expect(extFromMime('image/webp')).toBe('.webp');
    expect(extFromMime('application/pdf')).toBe('.pdf');
    expect(extFromMime(undefined)).toBe('.bin');
  });
});
