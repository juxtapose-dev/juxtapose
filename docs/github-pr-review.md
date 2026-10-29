# GitHub PR review

Use the Storybook addon for local feedback and the GitHub App check for merge approval.
The two jobs have different meanings:

- **Visual capture** passes when a complete, stable run reaches the service.
- **juxtapose**, the GitHub App check, passes when the captured changes are approved.

Require **both** checks in the repository ruleset. Select the Juxtapose GitHub App
as the expected source for `juxtapose`; do not accept another workflow with the
same check name. A green capture job alone does not approve visual changes.

## Setup

1. Install the Juxtapose GitHub App, link the repository to the SaaS project, and
   create a project-scoped upload token. Store it as `JUXTAPOSE_TOKEN` in Actions.
2. Give human reviewers an owner, admin, or reviewer role on the Juxtapose team.
   They must sign in with the GitHub account they use to review. Repository write
   access alone does not grant Juxtapose approval permission.
3. Pin a CLI release containing `--review-in-github` in the repository's
   devDependencies and lockfile. This flag is new in this changeset and is not
   available in the previously published 0.25.1 release.
4. Adapt [the workflow example](examples/visual-review.yml) to your build command
   and project layout. It assumes a root pnpm project with a `build-storybook`
   script, default cache storage, and a committed Juxtapose configuration.
5. Run a pilot PR with a deliberate change. Verify an unauthorized actor cannot
   approve, an authorized reviewer can, and a new changed head blocks again.
   Then require `Visual capture` and `juxtapose` in your ruleset.

The App needs Checks write, Pull requests write (comments and head reads), and
subscriptions to `pull_request` and `check_run` events. Enable these in the App
registration before testing the new requested-action handler.

## What reviewers see

The comment shows the captured commit, run identity, approval progress, and up to
three before/current/diff previews when publication is enabled for the project.
Reviewers use **Approve visual diff** in the PR's Juxtapose check to approve the
remaining changes in that exact run. The action is offered for 1–100 outstanding
changes. Use the dashboard for individual decisions, denials, undo, or larger
runs. GitHub comments cannot contain arbitrary interactive buttons or sliders.

The action verifies the live PR head, installation, repository, reviewer identity,
and latest run before writing approvals. It rejects incomplete, superseded, stale,
or denied evidence. Duplicate actions do not create duplicate approvals. An old
button cannot approve a newer run even if it has the same commit SHA.

## Canonical rendering

Do not compare a macOS-generated baseline with a Linux CI screenshot. Chrome
pinning alone does not make OS font rasterization identical. The example renders
the merge-base and head on the **same runner**, using the **same CLI and Chrome**.
It seeds a temporary baseline from the merge-base, captures head, and uploads only
the head review. It never writes approvals back to the source branch.

This avoids requiring Docker on every developer machine. A pinned Linux container
is useful when preserving baselines between jobs or reproducing CI locally; pin
its digest, CPU architecture, fonts, browser, viewport, locale, timezone, and
capture configuration. Docker does not freeze network data, time, randomness,
or application animations. Use deterministic fixtures, bundled fonts, and stable
story readiness in either setup. The addon remains local feedback, not CI evidence.

The example deliberately compares against the merge-base, not an arbitrary local
manifest. Approval in the SaaS currently does not promote a baseline for the next
PR. Capturing the base each time avoids that dependency, at the cost of an extra
build and capture. Changes already on the target branch after the merge-base and
integration behavior are a separate concern; require normal integration tests too.

## Failure behavior and current limits

`jux run --upload --review-in-github` forces full selection and `--recheck changed`.
It rejects `--story`, `--since`, dry-run, disabled rechecks, skipped stories, stale
baselines, unstable captures, missing PR metadata, and synthetic merge checkouts.
Capture errors and upload failures remain failures. Plain `jux run --upload`
retains its existing nonzero exit for visual changes.

The example is for trusted same-repository PRs. Forks do not receive upload secrets
and intentionally remain blocked by the required App check; do not switch to
`pull_request_target` to run untrusted PR code with secrets. A separate isolated
capture and privileged ingestion design is needed for forks. Merge queues are not
yet supported by this mode.

The current gate accounts for uploaded captures. It does **not** yet prove that
removed stories, changed exclusions, renamed variants, or changed capture policy
were reviewed. Existing service approvals carry forward by branch/story/current
image hash, rather than the complete base/head/policy identity. These are release
limitations for teams that require a strict “every UI change accounted for” gate;
they are tracked in the service PR-review plan. Local addon approvals are not
required by this workflow.

Inline screenshots require explicit per-project publication opt-in in the service.
They use bearer media URLs that GitHub may cache, even for private repositories.
The service defaults to links only. See its `docs/pr-comment-previews.md` runbook.
