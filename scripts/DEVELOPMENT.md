# Developing the repository scripts

These scripts serve the whole repository: the comment and citation checks, generated files, the test budget and
publishing. This file explains the parts whose reasons do not fit in a comment. `PUBLISHING.md` at the repository
root is the release checklist.

## The test budget

`testBudget.ts` gives every spec in the repository one timeout, preloaded by `bunfig.toml` into each test process,
the parallel runner's workers included. Most of this suite compiles a Program and often runs it, and how long that
takes depends on the host more than on the code. Bun's default of five seconds is ample on an idle machine, but with
several suites sharing a loaded machine, fast tests time out at random.

A timeout that fires while the thing it guards still holds is a flake. So the budget is a minute, and a test that
truly hangs still fails, a minute later. A spec that claims a speed says so with a growth ratio or a count of the
work done, never with this number.

The budget is a preload rather than `[test] timeout` in `bunfig.toml`, which Bun reads but does not apply. It is not
`--timeout` on the `test` script either, which would leave `bun test <one spec>` on the default.
`setDefaultTimeout` covers `beforeAll` hooks as well as tests.

## Publishing packages

`publishing/packages.ts` is the one description of what gets published. Staging, packing, the smoke test and
publishing all walk its list, so a package joins or leaves the published set in one place.

The workspace never builds: Bun develops against the source-first manifests. So `publishing/stage.ts` assembles each
package's publishable form outside the tree, under `build/publish/packages/`, with compiled JavaScript, declarations,
and a manifest whose entries point at them. `npm publish` runs in the staged directory, never in `packages/`.

The sources use bundler-style import specifiers without extensions, such as `./common/index`, which Node's ESM loader
refuses. Staging resolves every relative specifier against the compiled tree and gives it `.js` for a file or
`/index.js` for a directory. A specifier that resolves to neither is an error. The same rewrite serves the
declarations, since TypeScript resolves a `.js` specifier to the `.d.ts` beside it.

`publishing/smoke.ts` runs the staged artifact, since a green suite only proves the sources. It copies the staged
packages into a scratch npm workspace in the system's temporary directory. It works outside the repository, so Node
cannot cover a file a package lacks by walking up into the repository's own `node_modules`. The smoke test installs the
packages with npm and drives them with Node: every export imported, and a program compiled, run, source-mapped and
formatted.

`publishing/publish.ts` stages again rather than trusting an earlier run, so the registry gets what the tree says now.
It does not run the smoke test, which needs the network and a few minutes; `bun run publish:smoke` is the step before.
