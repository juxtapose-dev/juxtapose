// Post the run summary as a PR comment, updating rather than accumulating.
//
// Hand-rolled against the REST API instead of pulling in Octokit: this needs
// three endpoints, and the CLI's install size is a real cost for a tool people
// add to every project.

import { readFile } from 'node:fs/promises';
import { isRecord } from '../browser/guards.js';
import { COMMENT_MARKER } from './comment.js';

/**
 * Everything needed to post, read from the environment GitHub Actions
 * provides. Absent outside Actions, which is the normal local case.
 */
export interface GitHubContext {
  token: string;
  /** `owner/repo` */
  repository: string;
  prNumber: number;
  apiUrl: string;
}

/**
 * Assemble the context from the workflow environment.
 *
 * Returns null when anything is missing — running locally, on a push rather
 * than a pull request, or without a token. That is an ordinary state, not an
 * error: reporting is a side effect, and a missing token should never fail a
 * build that otherwise passed.
 */
export async function resolveGitHubContext(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GitHubContext | null> {
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  const repository = env.GITHUB_REPOSITORY;
  if (!token || !repository) return null;

  const prNumber = await readPrNumber(env);
  if (prNumber === null) return null;

  return {
    token,
    repository,
    prNumber,
    apiUrl: env.GITHUB_API_URL ?? 'https://api.github.com',
  };
}

/**
 * The Actions run page, where uploaded artifacts are listed.
 *
 * Deliberately not derived from env vars alone. `GITHUB_RUN_ID` is set on every
 * Actions run including ones that upload nothing, so keying off it would
 * produce a link to an empty artifacts list — a promise to a dead end, which
 * costs the reader a click and some trust. The caller passes `hasArtifact` only
 * when it actually wrote a report, so no report means no link.
 *
 * We cannot link the artifact file itself: that URL is auth-gated and expires.
 */
export function resolveArtifactUrl(
  hasArtifact: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!hasArtifact) return undefined;
  const server = env.GITHUB_SERVER_URL;
  const repository = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  if (!server || !repository || !runId) return undefined;
  return `${server}/${repository}/actions/runs/${runId}`;
}

/**
 * Find the PR number.
 *
 * `GITHUB_EVENT_PATH` points at the full webhook payload, which carries it for
 * `pull_request` events. On a `push` there is no PR and we correctly find
 * nothing. `GITHUB_REF` is checked as a fallback for workflows that re-dispatch
 * with a synthesized ref.
 */
async function readPrNumber(env: NodeJS.ProcessEnv): Promise<number | null> {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (eventPath) {
    try {
      const event: unknown = JSON.parse(await readFile(eventPath, 'utf8'));
      if (isRecord(event)) {
        const pr = event['pull_request'];
        const n = (isRecord(pr) ? pr['number'] : undefined) ?? event['number'];
        if (typeof n === 'number') return n;
      }
    } catch {
      // Malformed or unreadable payload; fall through to the ref.
    }
  }

  // refs/pull/123/merge
  const match = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? '');
  return match ? Number(match[1]) : null;
}

interface Comment {
  id: number;
  body?: string;
}

const isComment = (v: unknown): v is Comment =>
  isRecord(v) &&
  typeof v['id'] === 'number' &&
  (v['body'] === undefined || typeof v['body'] === 'string');

/**
 * Create or update the juxtapose comment.
 *
 * Returns the comment's URL, or null if nothing was posted. Never throws: a
 * reporting failure must not fail a build. The caller decides the exit code
 * from the run itself, which is the thing that actually matters.
 */
export async function postComment(
  ctx: GitHubContext,
  body: string,
): Promise<string | null> {
  try {
    const existing = await findOwnComment(ctx);

    const res = existing
      ? await api(ctx, `/repos/${ctx.repository}/issues/comments/${existing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ body }),
        })
      : await api(ctx, `/repos/${ctx.repository}/issues/${ctx.prNumber}/comments`, {
          method: 'POST',
          body: JSON.stringify({ body }),
        });

    if (!res.ok) return null;
    const created: unknown = await res.json();
    return isRecord(created) && typeof created['html_url'] === 'string'
      ? created['html_url']
      : null;
  } catch {
    return null;
  }
}

/**
 * Locate our previous comment by its marker.
 *
 * Paginated because a busy PR can exceed one page, and our comment is
 * typically the oldest — posted on the first CI run — so stopping at page one
 * would make us post a duplicate on every subsequent push.
 */
async function findOwnComment(ctx: GitHubContext): Promise<Comment | null> {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await api(
      ctx,
      `/repos/${ctx.repository}/issues/${ctx.prNumber}/comments?per_page=100&page=${page}`,
    );
    if (!res.ok) return null;

    const comments: unknown = await res.json();
    // Thrown, not null: null means "no comment of ours", which would post a
    // duplicate. postComment turns this into "nothing posted", as the
    // TypeError on `.find` it replaces did.
    if (!Array.isArray(comments))
      throw new Error('jux: GitHub returned a non-array comment list');
    const found = comments.find(
      (c): c is Comment => isComment(c) && c.body?.includes(COMMENT_MARKER) === true,
    );
    if (found) return found;
    if (comments.length < 100) return null;
  }
  return null;
}

const MAX_PAGES = 10;

function api(
  ctx: GitHubContext,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${ctx.apiUrl}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${ctx.token}`,
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      ...init.headers,
    },
  });
}
