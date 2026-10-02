# Developing the repository scripts

These scripts serve the whole repository: the comment and citation checks, generated files, the test budget and
publishing. This file explains the parts whose reasons do not fit in a comment. `PUBLISHING.md` at the repository
root is the release checklist.

## The test budget

`testBudget.ts` gives every spec in the repository one timeout, preloaded by `bunfig.toml` into each test process,
the parallel runner's workers included. Bun reads `bunfig.toml` only from the directory a run starts in, so every
workspace holding a spec has one that preloads the same file, and so does the root. A run started deeper inside a
package keeps Bun's default. Most of this suite compiles a Program and often runs it, and how long
that takes depends on the host more than on the code. Bun's default of five seconds is ample on an idle machine, but
with several suites sharing a loaded machine, fast tests time out at random.

A timeout that fires while the thing it guards still holds is a flake. So the budget is a minute, and a test that
truly hangs still fails, a minute later. A spec that claims a speed says so with a growth ratio or a count of the
work done, never with this number.

The budget is a preload rather than `[test] timeout` in `bunfig.toml`, which Bun ignores. It is not `--timeout` on
the `test` script either, which would leave `bun test <one spec>` on the default.

A test takes its timeout from its file's default when it registers, and `setDefaultTimeout` sets only the default of
the file it runs in. A plain `bun test` runs the preload once, inside its first file, so a call there leaves every
later file on five seconds. `--isolate`, which `--parallel` implies, runs the preload again for each file. In a plain
run nothing in the preload runs again before a later file registers its tests. So the preload registers a plugin
that puts the call at the start of every `*.spec.ts` file Bun loads. The call shares the first line, or replaces a
`#!` line there. Line numbers in a failure stay true, and only columns on the first line shift. The call reaches
`bun:test` through `import.meta.require`, so it declares no name that a spec's own names could shadow. It covers
`beforeAll` hooks as well as tests.

`ESSENCE_TEST_BUDGET` sets the budget in milliseconds. Anything but a positive number keeps the minute, since a
timeout of zero turns timeouts off. `tests/testBudget.spec.ts` sets a short budget this way. It runs files that
outlast it after another file: plainly, under `--isolate` and under `--parallel`. A later file left on Bun's default
passes there, which fails the spec. It also starts a run inside every workspace holding a spec, and refuses a test
file whose name the plugin's filter misses.

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
