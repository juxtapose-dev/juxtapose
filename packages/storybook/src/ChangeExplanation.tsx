import React from 'react';
import type { Delta, DiffResult } from '@juxtapose/core';

function deltaText(delta: Delta): string {
  switch (delta.kind) {
    case 'text':
      return `${delta.el}: text ${JSON.stringify(delta.from)} → ${JSON.stringify(delta.to)}`;
    case 'style':
      return `${delta.el}: ${delta.prop} ${delta.from} → ${delta.to}`;
    case 'attr':
      return `${delta.el}: ${delta.attr} ${JSON.stringify(delta.from)} → ${JSON.stringify(delta.to)}`;
    case 'added':
    case 'removed':
      return `${delta.el}: ${delta.kind}`;
    case 'moved':
      return `${delta.el}: moved ${delta.dx}px horizontally, ${delta.dy}px vertically`;
    case 'resized':
      return `${delta.el}: width changed by ${delta.dw}px, height by ${delta.dh}px`;
    case 'shift':
      return `${delta.count} elements after ${delta.after}: shifted ${delta.dx}px horizontally, ${delta.dy}px vertically`;
  }
}

/** Report evidence only: opening the panel must never trigger more analysis. */
export const ChangeExplanation: React.FC<{ result: DiffResult }> = ({ result }) => {
  const verdict = result.structural;
  const flake = result.flake;
  const retry = result.rendererRetry;
  if (result.error || (!verdict && !flake && !retry && result.status !== 'fail'))
    return null;
  return (
    <section
      aria-label="What changed"
      style={{ marginBottom: 12, overflowWrap: 'anywhere' }}
    >
      <h3 style={{ fontSize: 13, margin: '8px 0' }}>What changed</h3>
      {verdict ? (
        <>
          <p>{verdict.summary}</p>
          <details>
            <summary>
              Change evidence · {verdict.classification} · {verdict.deltaCount} changes
            </summary>
            <p>
              Structural evidence explains{' '}
              {verdict.explained === 'full'
                ? 'all or nearly all'
                : verdict.explained === 'partial'
                  ? 'some'
                  : 'little or none'}{' '}
              of the changed region area.
            </p>
            <ul>
              {verdict.deltas.map((delta, index) => (
                <li key={index}>{deltaText(delta)}</li>
              ))}
            </ul>
            {verdict.deltaCount > verdict.deltas.length && (
              <p>
                Showing {verdict.deltas.length} of {verdict.deltaCount} changes; the
                report limits stored detail.
              </p>
            )}
            {verdict.unexplainedRegions.length > 0 && (
              <p>
                {verdict.unexplainedRegions.length} unexplained regions recorded. Inspect
                the screenshots for changes the DOM evidence does not explain.
              </p>
            )}
            {verdict.flags.length > 0 && (
              <p>Evidence limits and flags: {verdict.flags.join(', ')}</p>
            )}
          </details>
        </>
      ) : (
        result.status === 'fail' && (
          <p>
            No structural explanation is available. This does not mean there was no
            change; inspect the capture and agent prompt.
          </p>
        )
      )}
      {flake && (
        <details>
          <summary>
            Possible flake: {flake.cause} · {flake.confidence} confidence
          </summary>
          <pre style={{ whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(flake.evidence, null, 2)}
          </pre>
          {flake.fix && (
            <>
              <p>
                Suggested configuration for review. Select and copy; this is not applied
                automatically.
              </p>
              <textarea
                aria-label="Suggested flake configuration"
                readOnly
                rows={6}
                style={{ width: '100%' }}
                value={JSON.stringify(flake.fix, null, 2)}
                onFocus={(event) => event.currentTarget.select()}
              />
            </>
          )}
        </details>
      )}
      {retry && (
        <p>
          Renderer retry: {retry.outcome}
          {retry.resolvedBy ? ` using ${retry.resolvedBy}` : ''}.{' '}
          {retry.outcome === 'resolved'
            ? 'The retry matched the exact approved hash. Recovery does not prove the original cause.'
            : (retry.reason ?? 'The retry did not establish an exact baseline match.')}
        </p>
      )}
    </section>
  );
};
