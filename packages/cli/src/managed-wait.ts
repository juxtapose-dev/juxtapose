import type { BuildReceipt } from './managed-submit.js';
import type { UploadConfig } from './hosted-upload.js';
import { UserError } from './user-error.js';
import { EXIT } from './exit-codes.js';
export interface ManagedStatus {
  schema: 'juxtapose.managed-status/v1';
  buildId: string;
  sourceSha: string;
  phase:
    | 'upload'
    | 'validation'
    | 'capture'
    | 'baseline'
    | 'comparison'
    | 'publication'
    | 'review'
    | 'reference';
  terminal: boolean;
  reason: string | null;
  recovery:
    'automatic' | 'capture_baseline' | 'submit_current_head' | 'operator' | 'none';
  retryAfterMs: number;
  validation: { status: string };
  execution: { status: string };
  comparison: { status: string };
  publication: { status: string };
  review: {
    state: string;
    runId: string | null;
    url: string | null;
    verdict: 'incomplete' | 'needs_review' | 'approved' | 'unchanged' | 'rejected';
  };
}
export interface WaitOptions {
  timeoutMs: number;
  pollMs: number;
  signal?: AbortSignal;
  onProgress?: (status: ManagedStatus) => void;
}

export class ManagedWaitError extends UserError {
  constructor(
    readonly code: string,
    message: string,
    readonly lastStatus: ManagedStatus | null = null,
    readonly retryable = false,
    readonly httpStatus?: number,
  ) {
    super(message, EXIT.failure);
  }
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
interface StatusIdentity {
  id: string;
  sourceSha: string | null;
}
function readStatus(value: unknown, identity: StatusIdentity): ManagedStatus {
  const invalid = () =>
    new ManagedWaitError(
      'status_protocol',
      'The service returned an invalid managed status; no visual result was accepted.',
    );
  if (
    !record(value) ||
    value['schema'] !== 'juxtapose.managed-status/v1' ||
    value['buildId'] !== identity.id ||
    typeof value['sourceSha'] !== 'string' ||
    !/^[a-f0-9]{40}$/.test(value['sourceSha']) ||
    (identity.sourceSha !== null && value['sourceSha'] !== identity.sourceSha) ||
    ![
      'upload',
      'validation',
      'capture',
      'baseline',
      'comparison',
      'publication',
      'review',
      'reference',
    ].includes(String(value['phase'])) ||
    typeof value['terminal'] !== 'boolean' ||
    !(
      value['reason'] === null ||
      (typeof value['reason'] === 'string' && /^[a-z_]{1,64}$/.test(value['reason']))
    ) ||
    ![
      'automatic',
      'capture_baseline',
      'submit_current_head',
      'operator',
      'none',
    ].includes(String(value['recovery'])) ||
    !Number.isInteger(value['retryAfterMs']) ||
    Number(value['retryAfterMs']) < 250 ||
    Number(value['retryAfterMs']) > 30000
  )
    throw invalid();
  for (const [key, allowed] of Object.entries({
    validation: ['not_started', 'pending', 'running', 'ready', 'failed'],
    execution: ['not_started', 'queued', 'running', 'completed', 'failed', 'canceled'],
    comparison: ['not_started', 'queued', 'running', 'completed', 'failed', 'canceled'],
    publication: ['not_started', 'queued', 'running', 'completed', 'blocked'],
  })) {
    const phase = value[key];
    if (!record(phase) || !allowed.includes(String(phase['status']))) throw invalid();
  }
  const review = value['review'];
  if (
    !record(review) ||
    ![
      'not_started',
      'waiting_capture',
      'pending',
      'blocked',
      'superseded',
      'published',
      'reference',
      'ready',
    ].includes(String(review['state'])) ||
    !['incomplete', 'needs_review', 'approved', 'unchanged', 'rejected'].includes(
      String(review['verdict']),
    ) ||
    !(
      review['runId'] === null ||
      (typeof review['runId'] === 'string' && uuid.test(review['runId']))
    )
  )
    throw invalid();
  if (review['state'] === 'ready') {
    if (
      !value['terminal'] ||
      value['phase'] !== 'review' ||
      review['verdict'] === 'incomplete' ||
      typeof review['runId'] !== 'string' ||
      typeof review['url'] !== 'string' ||
      (value['validation'] as Record<string, unknown>)['status'] !== 'ready' ||
      ['execution', 'comparison', 'publication'].some(
        (key) => (value[key] as Record<string, unknown>)['status'] !== 'completed',
      )
    )
      throw invalid();
    let url: URL;
    try {
      url = new URL(review['url']);
    } catch {
      throw invalid();
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith(`/runs/${review['runId']}`)
    )
      throw invalid();
  } else if (
    review['url'] !== null ||
    review['runId'] !== null ||
    review['verdict'] !== 'incomplete'
  )
    throw invalid();
  if (
    value['phase'] === 'reference' &&
    (!value['terminal'] ||
      review['state'] !== 'reference' ||
      (value['execution'] as Record<string, unknown>)['status'] !== 'completed')
  )
    throw invalid();
  return value as unknown as ManagedStatus;
}
/** Only fixed same-origin API paths are fetched; the returned review URL is never used for bearer requests. */
async function waitForBuildStatus(
  identity: StatusIdentity,
  config: UploadConfig,
  options: WaitOptions,
  trigger: boolean,
): Promise<ManagedStatus> {
  if (
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    !Number.isFinite(options.pollMs) ||
    options.pollMs < 1
  )
    throw new UserError('Invalid managed wait timeout or poll interval.');
  const deadline = Date.now() + options.timeoutMs,
    local = new AbortController();
  const timer = setTimeout(() => local.abort(), options.timeoutMs),
    signal = AbortSignal.any([local.signal, ...(options.signal ? [options.signal] : [])]);
  let lastStatus: ManagedStatus | null = null;
  const interruption = () =>
    new ManagedWaitError(
      options.signal?.aborted ? 'interrupted' : 'wait_timeout',
      `${options.signal?.aborted ? 'Waiting interrupted' : 'Managed wait timed out'}. Build ${identity.id} continues on the service; retry the same command.`,
      lastStatus,
    );
  const check = () => {
    if (signal.aborted || Date.now() >= deadline) throw interruption();
  };
  const race = async <T>(pending: Promise<T>, stop: AbortSignal): Promise<T> => {
    void pending.catch(() => {});
    check();
    if (stop.aborted)
      throw new ManagedWaitError(
        'service_unavailable',
        'Managed status request timed out.',
        lastStatus,
        true,
      );
    let abort = () => {};
    const canceled = new Promise<never>((_r, reject) => {
      abort = () =>
        reject(
          signal.aborted
            ? interruption()
            : new ManagedWaitError(
                'service_unavailable',
                'Managed status request timed out.',
                lastStatus,
                true,
              ),
        );
      stop.addEventListener('abort', abort, { once: true });
    });
    try {
      const value = await Promise.race([pending, canceled]);
      check();
      if (stop.aborted)
        throw new ManagedWaitError(
          'service_unavailable',
          'Managed status request timed out.',
          lastStatus,
          true,
        );
      return value;
    } finally {
      stop.removeEventListener('abort', abort);
    }
  };
  const delay = async (ms: number) => {
    check();
    let onAbort = () => {};
    let t: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        t = setTimeout(resolve, Math.min(ms, Math.max(1, deadline - Date.now())));
        onAbort = () => reject(interruption());
        signal.addEventListener('abort', onAbort, { once: true });
      });
      check();
    } finally {
      clearTimeout(t);
      signal.removeEventListener('abort', onAbort);
    }
  };
  const request = async (method: 'POST' | 'GET', path: string): Promise<unknown> => {
    check();
    const stop = AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.max(1, Math.min(10000, deadline - Date.now()))),
    ]);
    let arrived: Response | undefined,
      disposed = false;
    const dispose = () => {
      if (arrived && !disposed) {
        disposed = true;
        void arrived.body?.cancel().catch(() => {});
      }
    };
    try {
      const pending = fetch(new URL(path, config.origin), {
        method,
        redirect: 'manual',
        signal: stop,
        headers: { authorization: `Bearer ${config.token}` },
      });
      void pending.then(
        (response) => {
          arrived = response;
          if (stop.aborted) dispose();
        },
        () => {},
      );
      const response = await race(pending, stop);
      if (!response.ok) {
        dispose();
        throw new ManagedWaitError(
          'service_unavailable',
          `Managed ${method === 'POST' ? 'capture request' : 'status'} failed (HTTP ${response.status}); no visual result was accepted.`,
          lastStatus,
          [429, 502, 503, 504].includes(response.status),
          response.status,
        );
      }
      if (
        response.headers.get('content-type')?.split(';')[0]?.trim() !==
          'application/json' ||
        !response.body
      )
        throw new ManagedWaitError(
          'status_protocol',
          'Invalid managed status response.',
          lastStatus,
        );
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await race(reader.read(), stop);
          if (part.done) break;
          size += part.value.length;
          if (size > 65536)
            throw new ManagedWaitError(
              'status_protocol',
              'Managed status exceeds response limit.',
              lastStatus,
            );
          chunks.push(part.value);
        }
      } finally {
        disposed = true;
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      check();
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      ) as unknown;
    } catch (error) {
      dispose();
      if (signal.aborted || Date.now() >= deadline) throw interruption();
      if (error instanceof ManagedWaitError) throw error;
      throw new ManagedWaitError(
        'service_unavailable',
        'Managed status is unavailable; retry the same submission.',
        lastStatus,
        true,
      );
    }
  };
  const retry = async (method: 'POST' | 'GET', path: string) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await request(method, path);
      } catch (error) {
        if (!(error instanceof ManagedWaitError) || !error.retryable || attempt >= 2)
          throw error;
        await delay(250 * 2 ** attempt);
      }
    }
  };
  try {
    if (trigger) {
      try {
        const started = await retry('POST', `/v1/builds/${identity.id}/capture`);
        if (
          !record(started) ||
          !record(started['capture']) ||
          started['capture']['buildId'] !== identity.id ||
          !['pending', 'running', 'ready', 'failed'].includes(
            String(started['capture']['status']),
          )
        )
          throw new ManagedWaitError(
            'status_protocol',
            'Invalid capture trigger receipt.',
            lastStatus,
          );
      } catch (error) {
        if (!(error instanceof ManagedWaitError) || error.httpStatus !== 404) throw error;
        // Intake may pause after upload; only a matching scoped status can recover this 404.
      }
    }
    for (;;) {
      check();
      lastStatus = readStatus(
        await retry('GET', `/v1/builds/${identity.id}/status`),
        identity,
      );
      identity.sourceSha ??= lastStatus.sourceSha;
      options.onProgress?.(lastStatus);
      if (lastStatus.terminal) return lastStatus;
      if (
        !trigger &&
        ['capture_not_requested', 'upload_required'].includes(lastStatus.reason ?? '')
      )
        throw new ManagedWaitError(
          'capture_not_started',
          `Build ${identity.id} has no active capture to resume. Retry the original compiled submission with --wait when intake is enabled.`,
          lastStatus,
        );
      await delay(Math.max(options.pollMs, lastStatus.retryAfterMs));
    }
  } finally {
    clearTimeout(timer);
    local.abort();
  }
}

export async function waitForManagedBuild(
  build: BuildReceipt,
  config: UploadConfig,
  options: WaitOptions,
): Promise<ManagedStatus> {
  if (
    !uuid.test(build.build.id) ||
    !/^[a-f0-9]{40}$/.test(build.build.sourceSha) ||
    build.build.status !== 'uploaded'
  )
    throw new ManagedWaitError(
      'status_protocol',
      'Waiting requires an exact uploaded build receipt.',
    );
  return waitForBuildStatus(
    { id: build.build.id, sourceSha: build.build.sourceSha },
    config,
    options,
    true,
  );
}
/** Resume reads only the existing server workflow; it does not bind it to the current checkout. */
export async function resumeManagedBuild(
  buildId: string,
  config: UploadConfig,
  options: WaitOptions,
): Promise<ManagedStatus> {
  if (!uuid.test(buildId)) throw new UserError('--resume must be a build UUID.');
  return waitForBuildStatus({ id: buildId, sourceSha: null }, config, options, false);
}
