import type { BuildReceipt } from './managed-submit.js';
import type { UploadConfig } from './hosted-upload.js';
import { UserError } from './user-error.js';
import { EXIT } from './exit-codes.js';

export interface PreviewStatus {
  schema: 'juxtapose.preview-status/v1';
  buildId: string;
  sourceSha: string;
  branch: string;
  state:
    | 'queued'
    | 'validating'
    | 'publishing'
    | 'ready'
    | 'failed'
    | 'expired'
    | 'not_requested'
    | 'disabled';
  terminal: boolean;
  reason:
    | null
    | 'upload_required'
    | 'preview_disabled'
    | 'preview_not_requested'
    | 'preview_failed'
    | 'preview_expired'
    | 'viewer_disabled'
    | 'repository_unavailable'
    | 'source_changed';
  retryAfterMs: 2000;
  url: string | null;
}
export interface PreviewWaitOptions {
  timeoutMs: number;
  pollMs: number;
  signal?: AbortSignal;
  onProgress?: (status: PreviewStatus) => void;
}
export class PreviewWaitError extends UserError {
  constructor(
    readonly code: string,
    message: string,
    readonly lastStatus: PreviewStatus | null = null,
    readonly retryable = false,
  ) {
    super(message, EXIT.failure);
  }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const reasons = [
  null,
  'upload_required',
  'preview_disabled',
  'preview_not_requested',
  'preview_failed',
  'preview_expired',
  'viewer_disabled',
  'repository_unavailable',
  'source_changed',
];
const pendingStates = ['queued', 'validating', 'publishing'];
const stateReasons: Record<PreviewStatus['state'], readonly PreviewStatus['reason'][]> = {
  queued: [null],
  validating: [null],
  publishing: [null],
  ready: [null, 'viewer_disabled', 'repository_unavailable'],
  failed: ['preview_failed', 'source_changed'],
  expired: ['preview_expired'],
  disabled: ['preview_disabled'],
  not_requested: ['upload_required', 'preview_not_requested'],
};
function readStatus(
  value: unknown,
  id: string,
  sha: string | null,
  branch: string | null,
  origin: string,
): PreviewStatus {
  const invalid = () =>
    new PreviewWaitError(
      'preview_protocol',
      'The service returned an invalid preview status; no preview URL was accepted.',
    );
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(',') !==
      'branch,buildId,reason,retryAfterMs,schema,sourceSha,state,terminal,url' ||
    v['schema'] !== 'juxtapose.preview-status/v1' ||
    v['buildId'] !== id ||
    typeof v['sourceSha'] !== 'string' ||
    !/^[a-f0-9]{40}$/.test(v['sourceSha']) ||
    (sha !== null && v['sourceSha'] !== sha) ||
    typeof v['branch'] !== 'string' ||
    !/^[\x20-\x7e]{1,200}$/.test(v['branch']) ||
    (branch !== null && v['branch'] !== branch) ||
    typeof v['state'] !== 'string' ||
    ![
      ...pendingStates,
      'ready',
      'failed',
      'expired',
      'not_requested',
      'disabled',
    ].includes(v['state']) ||
    v['terminal'] !== !pendingStates.includes(v['state']) ||
    !reasons.includes(v['reason'] as PreviewStatus['reason']) ||
    v['retryAfterMs'] !== 2000 ||
    !(v['url'] === null || typeof v['url'] === 'string')
  )
    throw invalid();
  if (
    !stateReasons[v['state'] as PreviewStatus['state']].includes(
      v['reason'] as PreviewStatus['reason'],
    )
  )
    throw invalid();
  if (v['state'] === 'ready' && v['url'] === null && v['reason'] === null)
    throw invalid();
  if (v['url'] !== null) {
    if (v['state'] !== 'ready' || v['reason'] !== null || v['url'].length > 1024)
      throw invalid();
    const appOrigin = new Map([
      ['https://api.juxtapose.dev', 'https://app.juxtapose.dev'],
      ['https://api-staging.juxtapose.dev', 'https://app-staging.juxtapose.dev'],
    ]).get(origin);
    let url: URL;
    try {
      url = new URL(v['url']);
    } catch {
      throw invalid();
    }
    if (
      !appOrigin ||
      url.origin !== appOrigin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.href !== v['url'] ||
      !new RegExp(`^/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+/preview/build/${id}$`).test(
        url.pathname,
      )
    )
      throw invalid();
  }
  return {
    schema: 'juxtapose.preview-status/v1',
    buildId: id,
    sourceSha: v['sourceSha'],
    branch: v['branch'],
    state: v['state'] as PreviewStatus['state'],
    terminal: !pendingStates.includes(v['state']),
    reason: v['reason'] as PreviewStatus['reason'],
    retryAfterMs: 2000,
    url: v['url'],
  };
}

/** Fixed GET only: publication polling never starts capture or follows a launch URL. */
export async function waitForPreview(
  build: BuildReceipt | string,
  config: UploadConfig,
  options: PreviewWaitOptions,
): Promise<PreviewStatus> {
  const id = typeof build === 'string' ? build : build.build.id;
  let sha = typeof build === 'string' ? null : build.build.sourceSha;
  let branch = typeof build === 'string' ? null : build.build.branch;
  if (
    !uuid.test(id) ||
    (sha !== null && !/^[a-f0-9]{40}$/.test(sha)) ||
    (typeof build !== 'string' && build.build.status !== 'uploaded')
  )
    throw new UserError(
      'Preview waiting requires an uploaded build receipt or --resume build UUID.',
    );
  if (
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    !Number.isFinite(options.pollMs) ||
    options.pollMs < 1
  )
    throw new UserError('Invalid preview wait timeout or poll interval.');
  const deadline = performance.now() + options.timeoutMs;
  const local = new AbortController();
  const timer = setTimeout(() => local.abort(), options.timeoutMs);
  const signal = AbortSignal.any([
    local.signal,
    ...(options.signal ? [options.signal] : []),
  ]);
  let lastStatus: PreviewStatus | null = null;
  const interrupted = () =>
    new PreviewWaitError(
      options.signal?.aborted ? 'interrupted' : 'wait_timeout',
      `Preview waiting ${options.signal?.aborted ? 'was interrupted' : 'timed out'}. Resume with jux submit --experimental --resume ${id} --wait-preview. No capture was requested.`,
      lastStatus,
    );
  const check = () => {
    if (signal.aborted || performance.now() >= deadline) throw interrupted();
  };
  const race = async <T>(pending: Promise<T>, stop: AbortSignal): Promise<T> => {
    void pending.catch(() => {});
    let abort = () => {};
    const unavailable = () =>
      signal.aborted
        ? interrupted()
        : new PreviewWaitError(
            'preview_unavailable',
            'Preview status request timed out.',
            lastStatus,
            true,
          );
    try {
      check();
      if (stop.aborted) throw unavailable();
      const canceled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(unavailable());
        stop.addEventListener('abort', abort, { once: true });
      });
      const result = await Promise.race([pending, canceled]);
      check();
      if (stop.aborted) throw unavailable();
      return result;
    } finally {
      stop.removeEventListener('abort', abort);
    }
  };
  const delay = async (ms: number) => {
    check();
    let onAbort = () => {};
    let wait: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        wait = setTimeout(
          resolve,
          Math.min(ms, Math.max(1, deadline - performance.now())),
        );
        onAbort = () => reject(interrupted());
        signal.addEventListener('abort', onAbort, { once: true });
      });
      check();
    } finally {
      clearTimeout(wait);
      signal.removeEventListener('abort', onAbort);
    }
  };
  const request = async (): Promise<unknown> => {
    check();
    const stop = AbortSignal.any([
      signal,
      AbortSignal.timeout(
        Math.max(1, Math.ceil(Math.min(10_000, deadline - performance.now()))),
      ),
    ]);
    let response: Response | undefined;
    let disposed = false;
    const dispose = () => {
      if (response && !disposed) {
        disposed = true;
        void response.body?.cancel().catch(() => {});
      }
    };
    try {
      const pending = fetch(new URL(`/v1/builds/${id}/preview`, config.origin), {
        method: 'GET',
        redirect: 'manual',
        signal: stop,
        headers: { authorization: `Bearer ${config.token}` },
      });
      void pending.then(
        (arrived) => {
          response = arrived;
          if (stop.aborted) dispose();
        },
        () => {},
      );
      response = await race(pending, stop);
      if (!response.ok) {
        dispose();
        if (response.status === 404)
          throw new PreviewWaitError(
            'preview_unsupported',
            'Preview status is unavailable for this build or service. Check its preview support and project scope; no capture was requested.',
            lastStatus,
          );
        throw new PreviewWaitError(
          'preview_unavailable',
          `Preview status failed (HTTP ${response.status}); no capture was requested.`,
          lastStatus,
          [429, 502, 503, 504].includes(response.status),
        );
      }
      if (
        response.headers.get('content-type')?.split(';')[0]?.trim() !==
          'application/json' ||
        !response.body
      )
        throw new PreviewWaitError(
          'preview_protocol',
          'Invalid preview status response.',
          lastStatus,
        );
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await race(reader.read(), stop);
          if (part.done) break;
          size += part.value.length;
          if (size > 65536)
            throw new PreviewWaitError(
              'preview_protocol',
              'Preview status exceeds response limit.',
              lastStatus,
            );
          chunks.push(part.value);
        }
      } finally {
        disposed = true;
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      try {
        return JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
        ) as unknown;
      } catch {
        throw new PreviewWaitError(
          'preview_protocol',
          'Invalid preview status JSON.',
          lastStatus,
        );
      }
    } catch (error) {
      dispose();
      check();
      if (error instanceof PreviewWaitError) throw error;
      throw new PreviewWaitError(
        'preview_unavailable',
        'Preview status is unavailable; resume the same build to retry.',
        lastStatus,
        true,
      );
    }
  };
  try {
    for (;;) {
      let value: unknown;
      for (let attempt = 0; ; attempt++) {
        try {
          value = await request();
          break;
        } catch (error) {
          if (!(error instanceof PreviewWaitError) || !error.retryable || attempt >= 2)
            throw error;
          await delay(250 * 2 ** attempt);
        }
      }
      lastStatus = readStatus(value, id, sha, branch, config.origin);
      sha ??= lastStatus.sourceSha;
      branch ??= lastStatus.branch;
      options.onProgress?.(lastStatus);
      if (lastStatus.terminal) return lastStatus;
      await delay(Math.max(options.pollMs, lastStatus.retryAfterMs));
    }
  } finally {
    clearTimeout(timer);
    local.abort();
  }
}
