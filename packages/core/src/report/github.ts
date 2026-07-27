// Post the run summary as a PR comment, updating rather than accumulating.
//
// Hand-rolled against the REST API instead of pulling in Octokit: this needs
// three endpoints, and the CLI's install size is a real cost for a tool people
// add to every project.

import { readFile } from 'node:fs/promises';
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
      const event = JSON.parse(await readFile(eventPath, 'utf8')) as {
        pull_request?: { number?: number };
        number?: number;
      };
      const n = event.pull_request?.number ?? event.number;
      if (typeof n === 'number') return n;
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
    const created = (await res.json()) as { html_url?: string };
    return created.html_url ?? null;
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

    const comments = (await res.json()) as Comment[];
    const found = comments.find((c) => c.body?.includes(COMMENT_MARKER));
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
