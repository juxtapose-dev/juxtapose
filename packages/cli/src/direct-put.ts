import { UserError } from './user-error.js';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_URL_BYTES = 4096;
const MAX_LIFETIME_SECONDS = 900;
const SIGNED_HEADERS = 'content-length;content-type;host;if-none-match';
const QUERY = [
  'X-Amz-Algorithm',
  'X-Amz-Credential',
  'X-Amz-Date',
  'X-Amz-Expires',
  'X-Amz-SignedHeaders',
  'X-Amz-Signature',
];
type ContentType = 'application/gzip' | 'image/webp';
interface Capability {
  url: string;
  expiresAtMs: number;
  headers: {
    'content-type': ContentType;
    'content-length': string;
    'if-none-match': '*';
  };
}

export class DirectPutError extends UserError {
  constructor(readonly reason: 'invalid' | 'expired' | 'failed') {
    super(
      reason === 'invalid'
        ? 'The service returned an invalid direct upload capability.'
        : reason === 'expired'
          ? 'The direct upload capability expired. Retry the same submission to refresh it.'
          : 'Direct upload could not be confirmed. Local artifacts are retained; retry the same submission.',
      1,
    );
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function capability(
  value: unknown,
  bytes: Uint8Array,
  contentType: ContentType,
): Capability {
  try {
    if (
      !record(value) ||
      !keys(value, [
        'schema',
        'method',
        'url',
        'bytes',
        'issuedAtMs',
        'expiresAtMs',
        'headers',
      ]) ||
      value.schema !== 'juxtapose.direct-put/v1' ||
      value.method !== 'PUT' ||
      typeof value.url !== 'string' ||
      Buffer.byteLength(value.url) > MAX_URL_BYTES ||
      !/^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com\//.test(value.url) ||
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength < 1 ||
      bytes.byteLength > MAX_BYTES ||
      value.bytes !== bytes.byteLength ||
      !Number.isSafeInteger(value.issuedAtMs) ||
      !Number.isSafeInteger(value.expiresAtMs) ||
      typeof value.issuedAtMs !== 'number' ||
      value.issuedAtMs < 0 ||
      value.issuedAtMs % 1000 !== 0 ||
      typeof value.expiresAtMs !== 'number' ||
      value.expiresAtMs < 0 ||
      !record(value.headers) ||
      !keys(value.headers, ['content-type', 'content-length', 'if-none-match']) ||
      !['application/gzip', 'image/webp'].includes(contentType) ||
      value.headers['content-type'] !== contentType ||
      value.headers['content-length'] !== String(bytes.byteLength) ||
      value.headers['if-none-match'] !== '*'
    )
      throw new Error();
    const url = new URL(value.url);
    const query = url.searchParams;
    const queryKeys = [...query.keys()];
    const lifetime = (value.expiresAtMs - value.issuedAtMs) / 1000;
    const date = new Date(value.issuedAtMs).toISOString().replace(/[:-]|\.\d{3}/g, '');
    if (
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(url.hostname) ||
      queryKeys.length !== QUERY.length ||
      new Set(queryKeys).size !== QUERY.length ||
      !QUERY.every((key) => query.has(key)) ||
      query.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256' ||
      query.get('X-Amz-SignedHeaders') !== SIGNED_HEADERS ||
      query.get('X-Amz-Date') !== date ||
      !Number.isInteger(lifetime) ||
      lifetime < 1 ||
      lifetime > MAX_LIFETIME_SECONDS ||
      query.get('X-Amz-Expires') !== String(lifetime) ||
      !/^[a-f0-9]{64}$/.test(query.get('X-Amz-Signature') ?? '') ||
      !new RegExp(`^[A-Za-z0-9]{16,128}/${date.slice(0, 8)}/auto/s3/aws4_request$`).test(
        query.get('X-Amz-Credential') ?? '',
      )
    )
      throw new Error();
    return {
      url: value.url,
      expiresAtMs: value.expiresAtMs,
      headers: {
        'content-type': contentType,
        'content-length': String(bytes.byteLength),
        'if-none-match': '*',
      },
    };
  } catch {
    // Descriptors and provider errors contain credentials; never attach their cause.
    throw new DirectPutError('invalid');
  }
}

function discard(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    /* Do not expose provider data. */
  }
}

async function send(
  value: Capability,
  bytes: Uint8Array<ArrayBuffer>,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error());
    }, timeoutMs);
  });
  try {
    const pending = fetch(value.url, {
      method: 'PUT',
      body: bytes,
      headers: value.headers,
      redirect: 'error',
      credentials: 'omit',
      signal: controller.signal,
    });
    // A late response must not retain an unread provider body after the deadline.
    void pending.then(
      (response) => {
        if (controller.signal.aborted) discard(response);
      },
      () => {},
    );
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** PUT completion, including an ambiguous existing object, always needs API finalization. */
export async function putDirect(
  descriptor: unknown,
  bytes: Uint8Array,
  contentType: ContentType,
): Promise<{ requiresFinalization: true; putStatus: number }> {
  const value = capability(descriptor, bytes, contentType);
  const body = new Uint8Array(bytes);
  for (let attempt = 0; attempt < 3; attempt++) {
    const remaining = value.expiresAtMs - Date.now();
    if (remaining <= 0) throw new DirectPutError('expired');
    let response: Response | undefined;
    try {
      response = await send(value, body, Math.min(60_000, remaining));
    } catch {
      /* Retain only a redacted failure below. */
    }
    if (response) {
      discard(response);
      if (response.ok || response.status === 412)
        return { requiresFinalization: true, putStatus: response.status };
      if (response.status < 500 || response.status > 599)
        throw new DirectPutError('failed');
    }
    if (Date.now() >= value.expiresAtMs) throw new DirectPutError('expired');
    if (attempt < 2)
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(250 * (attempt + 1), value.expiresAtMs - Date.now()),
        ),
      );
  }
  throw new DirectPutError('failed');
}
