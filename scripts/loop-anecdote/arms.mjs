// The task is the same in both arms; only the verification method differs.
// One anecdote, not a benchmark (that is row 4): one page, one edit, one
// session per arm, run by hand.
export const TASK =
  'In scripts/loop-anecdote/page.html, change the Save button\'s background to rgb(29, 78, 216) and its text to "Save changes". The page is served at http://127.0.0.1:4173/. Verify the change rendered as intended and report what you verified.';

// `npx jux` would fetch an unrelated npm package named `jux` (this repo does
// not link a `jux` bin); both arms run the built CLI directly.
export const JUX = 'node packages/cli/dist/index.js';

export const ARMS = {
  skill: {
    launch: 'claude --plugin-dir plugins/claude-code',
    prompt: `${TASK} Use /juxtapose:visual-check to verify; in this repository \`jux\` is \`${JUX}\` (run from the repo root).`,
  },
  screenshot: {
    launch: 'claude',
    prompt: `${TASK} Verify by taking a screenshot of the page before and after with \`${JUX} snap <url> --as <name>\` (run from the repo root) and reading the two .webp files; do not use jux diff.`,
  },
};
