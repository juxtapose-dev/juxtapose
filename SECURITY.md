# Security

## Reporting a vulnerability

Report privately through
[GitHub's advisory form](https://github.com/juxtapose-dev/juxtapose/security/advisories/new),
not as a public issue. Expect an acknowledgement within a few working days.

Include what you need to reproduce it: affected package and version, and the
smallest set of steps that shows the problem.

## Supported versions

Pre-1.0, fixes land on the latest minor. There are no backports to earlier
minors.

## What is in scope

juxtapose runs a browser against your own workbench and writes to your repo, so
the interesting cases are where input crosses one of those boundaries:

- A story that can escape the capture browser or read files outside the project.
- A story id or file path that writes outside `.juxtapose/`, since ids become
  filenames.
- Anything that puts a token in a report, a PR comment, or a generated HTML
  report. These are frequently uploaded as CI artifacts.

## What is not

- **A story executing arbitrary code in the capture browser.** Capturing a story
  means running it. If the workbench is hostile, so is the capture, and the
  browser is the boundary rather than juxtapose.
- **Anything requiring write access to the repository.** Someone who can change
  `juxtapose.config.json` or a baseline can already change your source.
- **Baselines being wrong.** A mismatched or approved-in-error baseline is a
  correctness bug. File it as an issue.
