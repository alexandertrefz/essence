# Developing the extension

The extension is one package of the [Essence
monorepo](https://github.com/alexandertrefz/essence), but what it bundles is a
DEPENDENCY: `@essence-lang/language-server`, pinned by exact version in
`devDependencies` — the published, compiled package. Inside the monorepo the
workspace satisfies that pin, so `buildServer.js` resolves to the sibling
package's TypeScript sources; anywhere else, `bun install` fetches the
published package and the same build bundles its compiled `dist/`. The
standard library's `.es` sources are copied beside the bundle the same way,
resolved off `@essence-lang/standard-library` rather than a relative path — and
so are the runtime's, which the Bundler writes absolute paths to and reads back
off disk, so no bundler can see through them.

The live test session's Worker is bundled BESIDE the server as
`server/testWorker.js`: a Worker is started from a file, and the server ships
as one file with nothing to resolve out of.

```sh
bun install        # links the workspace, or fetches the published packages
bun run build      # server/server.js, server/testWorker.js, and the sources
                   # each of them reads at run time
```

Press `F5` ("Extension") to open an Extension Development Host.

`server/` is generated and not committed — rebuild it after changing the
Language Server. To skip the bundling step entirely while working on the
server, point `essence.server.path` at `packages/language-server/bin/esls` —
as `${workspaceFolder}/packages/language-server/bin/esls` in a workspace
`.vscode/settings.json`, which then works from any checkout. A built `.js` bundle
is forked on the Node VS Code ships, and anything else is treated as source
and run with Bun. The setting spawns what it names with `--stdio` and nothing
else, so it wants that entry point rather than the `essence lsp` command a
terminal would use. That is the better loop of the two — `esls` runs the
server's TypeScript directly, so a change needs no rebuild at all, just
`Essence: Restart Language Server`, which picks it up without reloading the
window.

Bun is found on PATH, then in its usual install locations, then by asking the
login shell (`$SHELL -ilc 'command -v bun'`, bounded to five seconds) —
`essence.bun.path` names it outright. When VS Code launched without the
shell's PATH, the Essence output channel says so and says to relaunch. If Bun
cannot be found at all the bundled server runs instead, with a warning: keep
an eye on that warning, because a bundle built last week silently serving a
checkout's diagnostics is the confusing failure this is meant to avoid.

All of that resolution is `launch.js`, pure functions of their arguments with
the file system, environment and shell handed in; `tests/launch.spec.ts`
covers every branch without an extension host.

## The debugging walkthrough

The debugger has no extension-host test harness, so a release is checked by
hand, in the Extension Development Host:

- `F5` on an open `.es` file with no launch.json compiles and runs it; its
  output lands in the Debug Console; the same entry appears in the
  Run and Debug view's picker.
- A breakpoint set before launching binds (solid red) and is hit; the paused
  line is the source line, and stepping over a `match` treats it as one
  statement while stepping in enters the matching Case's body.
- The call stack names the author's functions and hides glue;
  `glueFrames: "subtle"` shows it greyed out instead.
- Variables, watch and hover render Essence values (`3/4`, quoted Strings,
  Case tags), and expanding a Record or List keeps rendering its members.
- `stopOnEntry` pauses on the program's own first statement. "Uncaught
  Exceptions" pauses a failing Program on the mapped line, and `Ctrl+F5`
  runs without debugging or pausing.
- A Program with a Diagnostic fails the launch with the Diagnostics in the
  Debug Console; the Problems view carries the same details.
- `essence.cli.path` pointed at a checkout's `packages/cli/bin/essence` is
  used and named in the Essence output channel.

## The test walkthrough

The Test Explorer has no extension-host harness either. Everything it DECIDES
is `testModel.ts` — folding a batch, merging a narrowed one, building the tree,
what a failure says, what to mark — and `tests/testModel.spec.ts` covers that
without VS Code. `testView.js` is the half that calls the API, and
`tests/testView.spec.ts` drives it against `tests/vscodeStub.ts`, a stand-in
for the API that records every call: which item was created, which run was
ended, what was drawn on which editor. What a stand-in cannot say is whether VS
Code agrees with it, so a release is still checked by hand, in the Extension
Development Host, over a workspace holding at least two files that write
`tests { … }`, one of which imports the other, plus a `suite`, a `tagged`, a
`skipped "reason"` and a `focused`:

- The Testing view fills in on its own, without anything being run: files, then
  suites, then tests, each on its own line, in the order they were written. A
  test whose name interpolates shows its template until it has run once.
- Typing a failure into a test turns its item red within about half a second,
  the failure shows up in Problems under `test-failed`, the gutter marks the
  test's lines and the failed `expect`'s line, and hovering that line says what
  the terminal says. Undoing it turns everything green again.
- Editing the imported file re-runs both files; editing the importer re-runs
  only it. Deleting a test file removes it from the tree.
- ▶ beside one test runs that one and leaves every other result standing —
  neither the tree nor the gutter loses what it knew. ▶ beside a suite runs its
  tests. Run All runs everything, including a file whose first test was written
  a moment ago and which nothing had reported on yet.
- The profile picker offers one entry per tag; picking "Run slow" runs exactly
  the tests carrying it.
- **Essence: Re-run Failed Tests** runs only what is red. With nothing red it
  says so.
- A test that prints shows what it printed under itself in the Test Results
  terminal, on its own lines rather than staircased.
- The Debug profile and the Debug lens both refuse, name the `essence test
  --filter` command for the selection, and copy it when asked.
- Half-typing a line so the file stops compiling leaves the tree and the marks
  as they were rather than emptying them; the compile error is in Problems.
- Setting `essence.tests.enabled` to false stops the automatic runs — the marks
  stop changing as you type — while ▶ and the Run lens still work. Setting
  `essence.tests.skipTags` to a tag the workspace uses re-runs everything and
  leaves those tests unmarked.
- **Essence: Show Test Session Output** writes one line per cycle.
- Running with coverage (the profile picker's "Run with Coverage") sets
  `essence.tests.coverage` to true in the workspace settings, and from then on
  every cycle counts: the coverage view fills in per file, the lines nothing
  ran carry a grey bar in the gutter, and the file's declarations list every
  `match` arm and every Case of a `choice` with a tick or a cross. Turning the
  setting off again stops the counting and the marks. The output channel writes
  a second line per cycle with the two percentages.
- A test written `across` a List of rows is listed once per row, under a node
  named by the template, and each row's item shows the name that row renders.
  ▶ beside the template runs every row; ▶ beside one row runs only it.
- A test whose snapshot has never been recorded gets an **Accept snapshot**
  lens after its first run. Pressing it writes the recorded value into the
  source as an ordinary edit — the file becomes dirty rather than changing
  under the buffer, and one undo takes it back. A `matches snapshot from "…"`
  writes a `__snapshots__` file beside the source instead, and the lens goes
  once there is nothing left to accept.
- `Essence: Restart Language Server` empties the tree and fills it in again.

## Packaging

```sh
bun run package
```

This rebuilds the bundle and produces a `.vsix`. The bundle is included in the
package even though it is git-ignored, so the published extension is
self-contained. Publishing to the Marketplace is
`bunx vsce publish --no-dependencies`, authenticated as the `essence`
publisher (`bunx vsce login essence`, or the `VSCE_PAT` environment variable).
