# node-pty 1.1.0 `src/unix/pty.cc`, unmodified

The file exactly as npm installs it for `node-pty@1.1.0`. The sha256 is
`5e1005d6bdcfbe97b486ee415419fe7adae99035047f07340fbad36419e0bae6`, which is
`PRISTINE_SHA256` in `scripts/patch-node-pty.mjs`.

It is kept here because the installed copy in `node_modules` is the PATCHED
one after `postinstall` runs. `testing/unit/patchNodePty.test.ts` needs the
input the patch actually receives on a fresh install. MIT licensed; see
`LICENSE` beside it (copied from the package).

Delete this directory together with the patch script, once node-pty ships
microsoft/node-pty#882 in a stable release (#1437).
