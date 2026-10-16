import React from 'react';
import { styled } from './storybook.js';
import { mutedColor } from './theme.js';
import type { Delta, DiffResult } from '@juxtapose/core';

const Evidence = styled.section(({ theme }) => ({
  marginBottom: 12,
  padding: '8px 10px',
  border: `1px solid ${theme.appBorderColor}`,
  borderRadius: 6,
  overflowWrap: 'anywhere',
  fontSize: 12,
  lineHeight: 1.5,
  '& h3': { fontSize: 12, margin: '0 0 3px', fontWeight: 700 },
  '& p': { margin: '4px 0' },
  '& details + details': { marginTop: 5 },
  '& summary': { cursor: 'pointer', color: mutedColor(theme) },
  '& ul': { margin: '8px 0', paddingLeft: 20 },
  '& li + li': { marginTop: 4 },
}));

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
    <Evidence aria-label="What changed">
      {verdict ? (
        <details>
          <summary>
            {verdict.classification === 'reflow'
              ? 'Layout reflow'
              : verdict.classification.replace(/-/g, ' ')}{' '}
            · {verdict.deltaCount} {verdict.deltaCount === 1 ? 'change' : 'changes'} ·
            View evidence
          </summary>
          <p>{verdict.summary}</p>
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
              Showing {verdict.deltas.length} of {verdict.deltaCount} changes; the report
              limits stored detail.
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
        <details>
          <summary>Renderer retry: {retry.outcome}</summary>
          <p>
            {retry.resolvedBy ? `Used ${retry.resolvedBy}. ` : ''}
            {retry.outcome === 'resolved'
              ? 'The retry matched the exact approved hash. Recovery does not prove the original cause.'
              : (retry.reason ?? 'The retry did not establish an exact baseline match.')}
          </p>
        </details>
      )}
    </Evidence>
  );
};
