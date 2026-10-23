# dsh-jj-graph Host-half tests

`ops.test.mjs` mounts `index.js` on a fake `webServer`, drives `/jj-graph/api` with
synthetic `req`/`res`, and checks every op's envelope + shape (`repos`, `findrepos`,
`listdir`, `addrepo`, `graph` incl. root filtering, the `@` wc ref and `limit`/`skip`
pagination, `branches` incl. the current-position readout — bookmark on `@`, git HEAD in
a colocated worktree, upstream bookmark otherwise, and never a trunk substitute —
`workstatus`, `workfile`, `show`, `diff`, `filediff`, `filelog`,
`remoteinfo`, the 400 paths) plus the read-only rule that pure reads append nothing to
`jj op log`. `reveal` is never called; it opens Finder.

Run with node >= 22 and `jj` on PATH (`JJ_BIN` overrides the binary): `node test/ops.test.mjs`

The script creates and deletes `test/.tmp/` itself (already covered by the repo
`.gitignore`), including after a failure, and exits non-zero if any check fails.
