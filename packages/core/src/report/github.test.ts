import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveGitHubContext } from './github.js';

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
