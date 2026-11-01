import { expect, it, vi, beforeEach } from 'vitest';
import { open } from 'node:fs/promises';
vi.mock('node:fs/promises', () => ({ open: vi.fn() }));
beforeEach(() => {
  vi.resetModules();
  vi.mocked(open).mockReset();
});
function file(bytes: Uint8Array) {
  let position = 0;
  return {
    read: vi.fn(async (buffer: Uint8Array, offset: number, length: number) => {
      const size = Math.min(length, bytes.length - position);
      buffer.set(bytes.subarray(position, position + size), offset);
      position += size;
      return { bytesRead: size, buffer };
    }),
    close: vi.fn(async () => {}),
  };
}
it('loads a bounded immutable source once and closes its owned file', async () => {
  const f = file(
    new TextEncoder().encode(
      '/* juxtapose.react-browser/v1\n*/ var __juxReactComponents={};',
    ),
  );
  vi.mocked(open).mockResolvedValue(f as Awaited<ReturnType<typeof open>>);
  const { loadReactBrowserSource } = await import('./react-browser-source.js');
  const warn = vi.fn();
  expect(await loadReactBrowserSource(warn)).toMatchObject({
    status: 'available',
    source: expect.stringContaining('__juxReactComponents'),
  });
  expect(await loadReactBrowserSource(warn)).toMatchObject({ status: 'available' });
  expect(open).toHaveBeenCalledOnce();
  expect(f.close).toHaveBeenCalledOnce();
  expect(warn).not.toHaveBeenCalled();
});
it('returns explicit missing status and warns once without leaking the raw path', async () => {
  vi.mocked(open).mockRejectedValue(
    Object.assign(new Error('private/path'), { code: 'ENOENT' }),
  );
  const { loadReactBrowserSource } = await import('./react-browser-source.js');
  const warn = vi.fn();
  expect(await loadReactBrowserSource(warn)).toEqual({
    status: 'unavailable',
    reason: 'asset_missing',
  });
  await loadReactBrowserSource(warn);
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0]?.[0]).not.toContain('private/path');
});
it.each(['oversize', 'invalid_utf8', 'wrong_header'] as const)(
  'refuses %s assets and closes the file',
  async (kind) => {
    const bytes =
      kind === 'oversize'
        ? new Uint8Array(128 * 1024 + 1)
        : kind === 'invalid_utf8'
          ? new Uint8Array([255])
          : new TextEncoder().encode('not the component asset');
    const f = file(bytes);
    vi.mocked(open).mockResolvedValue(f as Awaited<ReturnType<typeof open>>);
    const { loadReactBrowserSource } = await import('./react-browser-source.js');
    expect(await loadReactBrowserSource(vi.fn())).toEqual({
      status: 'unavailable',
      reason: 'asset_invalid',
    });
    expect(f.close).toHaveBeenCalledOnce();
  },
);
it('retains the soft unavailable outcome if a warning callback throws', async () => {
  vi.mocked(open).mockRejectedValue(
    Object.assign(new Error('missing'), { code: 'ENOENT' }),
  );
  const { loadReactBrowserSource } = await import('./react-browser-source.js');
  expect(
    await loadReactBrowserSource(() => {
      throw new Error('logger');
    }),
  ).toEqual({ status: 'unavailable', reason: 'asset_missing' });
});
