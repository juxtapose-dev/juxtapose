import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveArtifactUrl, resolveGitHubContext } from './github.js';

let dir: string;
let eventPath: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'jux-gh-'));
  eventPath = path.join(dir, 'event.json');
  await writeFile(eventPath, JSON.stringify({ pull_request: { number: 42 } }));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const base = {
  GITHUB_TOKEN: 't',
  GITHUB_REPOSITORY: 'owner/repo',
} as NodeJS.ProcessEnv;

describe('resolveGitHubContext', () => {
  it('reads the PR number from the event payload', async () => {
    const ctx = await resolveGitHubContext({ ...base, GITHUB_EVENT_PATH: eventPath });
    expect(ctx).toMatchObject({ prNumber: 42, repository: 'owner/repo' });
  });

  it('accepts GH_TOKEN as well as GITHUB_TOKEN', async () => {
    const ctx = await resolveGitHubContext({
      GITHUB_REPOSITORY: 'owner/repo',
      GH_TOKEN: 't',
      GITHUB_EVENT_PATH: eventPath,
    });
    expect(ctx?.prNumber).toBe(42);
  });

  it('falls back to the ref for workflows that synthesize one', async () => {
    const ctx = await resolveGitHubContext({
      ...base,
      GITHUB_REF: 'refs/pull/7/merge',
    });
    expect(ctx?.prNumber).toBe(7);
  });

  it('returns null with no token', async () => {
    // Running locally. Reporting is a side effect; its absence is ordinary.
    const ctx = await resolveGitHubContext({
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_EVENT_PATH: eventPath,
    });
    expect(ctx).toBeNull();
  });

  it('returns null on a push rather than a pull request', async () => {
    // There is no PR to comment on, which is not an error.
    const ctx = await resolveGitHubContext({ ...base, GITHUB_REF: 'refs/heads/main' });
    expect(ctx).toBeNull();
  });

  it('returns null rather than throwing on a malformed payload', async () => {
    const bad = path.join(dir, 'bad.json');
    await writeFile(bad, 'not json');
    expect(await resolveGitHubContext({ ...base, GITHUB_EVENT_PATH: bad })).toBeNull();
  });

  it('returns null when the payload file is missing', async () => {
    const ctx = await resolveGitHubContext({
      ...base,
      GITHUB_EVENT_PATH: path.join(dir, 'nope.json'),
    });
    expect(ctx).toBeNull();
  });

  it('honours a custom API url for GitHub Enterprise', async () => {
    const ctx = await resolveGitHubContext({
      ...base,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_API_URL: 'https://ghe.example.com/api/v3',
    });
    expect(ctx?.apiUrl).toBe('https://ghe.example.com/api/v3');
  });

  it('defaults to github.com when no API url is set', async () => {
    const ctx = await resolveGitHubContext({ ...base, GITHUB_EVENT_PATH: eventPath });
    expect(ctx?.apiUrl).toBe('https://api.github.com');
  });
});

describe('resolveArtifactUrl', () => {
  const actions = {
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'acme/web',
    GITHUB_RUN_ID: '12345',
  };

  it('points at the run page where artifacts are listed', () => {
    expect(resolveArtifactUrl(true, actions)).toBe(
      'https://github.com/acme/web/actions/runs/12345',
    );
  });

  it('refuses to link when no report was written', () => {
    // The env vars are set on every Actions run, including ones that upload
    // nothing. Linking on env alone sends the reader to an empty artifacts
    // list, which costs them a click and some trust.
    expect(resolveArtifactUrl(false, actions)).toBeUndefined();
  });

  it('returns nothing outside Actions', () => {
    expect(resolveArtifactUrl(true, {})).toBeUndefined();
  });

  it('lets any CI point at its own artifact storage', () => {
    // Most providers host artifacts themselves at a stable URL. We cannot
    // construct those — they carry a build number and an artifact path only the
    // provider knows — so the escape hatch is the whole non-Actions story.
    expect(
      resolveArtifactUrl(true, {
        JUXTAPOSE_REPORT_URL: 'https://output.circle-artifacts.com/.../report.html',
      }),
    ).toBe('https://output.circle-artifacts.com/.../report.html');
  });

  it('prefers an explicit url over the Actions run page', () => {
    expect(
      resolveArtifactUrl(true, {
        ...actions,
        JUXTAPOSE_REPORT_URL: 'https://mine/r.html',
      }),
    ).toBe('https://mine/r.html');
  });

  it('ignores an empty explicit url rather than linking nowhere', () => {
    // A CI that exports the variable unset would otherwise produce `[...]()`.
    expect(resolveArtifactUrl(true, { ...actions, JUXTAPOSE_REPORT_URL: '  ' })).toBe(
      'https://github.com/acme/web/actions/runs/12345',
    );
  });

  it('still writes no link when there is no report', () => {
    expect(
      resolveArtifactUrl(false, { JUXTAPOSE_REPORT_URL: 'https://mine/r.html' }),
    ).toBeUndefined();
  });
});
