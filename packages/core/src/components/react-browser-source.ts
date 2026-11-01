import { open } from 'node:fs/promises';
export type ReactBrowserAsset =
  | { status: 'available'; source: string }
  | { status: 'unavailable'; reason: 'asset_missing' | 'asset_invalid' };
let loaded: Promise<ReactBrowserAsset> | undefined;
let warned = false;
/** Immutable package asset; missing source is explicit and warns once, never a silent empty hook. */
export async function loadReactBrowserSource(
  onWarning: (message: string) => void = (message) => {
    process.stderr.write(`jux: ${message}\n`);
  },
): Promise<ReactBrowserAsset> {
  loaded ??= (async () => {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(
        new URL('../../dist/components/react-browser.bundle.js', import.meta.url),
        'r',
      );
      const bytes = new Uint8Array(128 * 1024 + 1);
      let count = 0;
      for (;;) {
        const part = await file.read(bytes, count, bytes.length - count, null);
        count += part.bytesRead;
        if (part.bytesRead === 0 || count === bytes.length) break;
      }
      if (count > 128 * 1024)
        return { status: 'unavailable', reason: 'asset_invalid' } as const;
      const source = new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(0, count),
      );
      if (
        !source.startsWith('/* juxtapose.react-browser/v1\n') ||
        !source.includes('__juxReactComponents')
      )
        return { status: 'unavailable', reason: 'asset_invalid' } as const;
      return { status: 'available', source } as const;
    } catch (error) {
      return {
        status: 'unavailable',
        reason:
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
            ? 'asset_missing'
            : 'asset_invalid',
      } as const;
    } finally {
      await file?.close().catch(() => {});
    }
  })();
  const result = await loaded;
  if (result.status === 'unavailable' && !warned) {
    warned = true;
    try {
      onWarning(
        'React component evidence unavailable: browser asset missing or invalid. Rebuild @juxtapose/core and retry.',
      );
    } catch {
      /* A diagnostic callback cannot turn the unavailable result into a failure. */
    }
  }
  return result;
}
