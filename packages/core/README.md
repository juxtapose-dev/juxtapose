# @juxtapose/core

Platform-agnostic capture, diff, baseline and analysis core for juxtapose.

Part of [juxtapose](https://github.com/juxtapose-dev/juxtapose), visual
regression testing for component workbenches.

**You probably don't need to install this directly.** Use
[`@juxtapose/cli`](https://www.npmjs.com/package/@juxtapose/cli) for the
command line, or
[`@juxtapose/storybook`](https://www.npmjs.com/package/@juxtapose/storybook)
to review diffs inside Storybook. This package is a building block those
depend on.

Full documentation: https://github.com/juxtapose-dev/juxtapose

## Design reference comparison

`designReferences` names project-contained PNG targets independently of approved
regression baselines. Each entry maps to an exact capture key, including any
variant suffix:

```json
{
  "designReferences": {
    "card-mobile": {
      "storyId": "card--default__mobile",
      "image": "design/card-mobile.png",
      "viewport": { "width": 375, "height": 812 },
      "deviceScaleFactor": 1,
      "captureKind": "viewport"
    }
  }
}
```

`compareDesignReference` compares a saved current image with the named PNG
without launching a browser. It verifies the capture key, CSS viewport, DPR,
capture kind, and actual image dimensions before comparing pixels. A design PNG
has no DOM snapshot, so its ledger explicitly marks structural evidence as
unavailable. `pass` means Pixelmatch counted zero changed pixels at the chosen
threshold; exact byte hashes remain in the ledger for provenance. Comparison
and region IDs depend on both hashes, geometry, and policy, so saved region IDs
must be refreshed after either image or the comparison policy changes.

MIT © Magic Factory LLC
