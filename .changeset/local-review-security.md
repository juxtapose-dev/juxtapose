---
'@juxtapose/cli': patch
'@juxtapose/server': patch
'@juxtapose/storybook': patch
---

Restrict the local review API to loopback callers with trusted loopback hosts and same-origin browser requests. Require an explicit review header and JSON content type for mutations, and update the Storybook client to send them. This blocks cross-site baseline approvals and capture cancellation; directly exposed network review APIs are no longer accepted.

Keep static workbench reads within the real build directory, including symlinks. Malformed request URLs now return an error instead of terminating the capture process.
