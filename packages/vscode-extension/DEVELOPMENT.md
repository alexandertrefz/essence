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
as one file with nothing to resolve out of. The Worker's one import from
outside its bundle is esbuild, copied beside it as `server/esbuild-wasm/` (see
"The test session's esbuild").

The bundle runs on the Node VS Code ships, not on Bun. A dependency whose
`main` is a UMD build, as `jsonc-parser`'s is, requires its own files from
inside a factory the bundler can not see through, so the bundle would look for
them beside itself. `buildServer.js` bundles such a package's `module` entry
instead (`umdPackages`). `tests/serverBundle.spec.ts` builds the server, starts
it under Node and runs a workspace's tests through it, since no other spec runs
the bundle there.

Every bundle reads its own location at run time. Bundled as they are, a
CommonJS module's `__dirname` and `__filename` would be spelled out as the
paths it was built from, which name the building machine and exist on no other.
`ownLocation` in `buildServer.js` defines both to the bundle's `import.meta`
instead, for the server, its Worker and the extension alike. The language
client is one such module: it stops a server that outlives `stop` with the
`terminateProcess.sh` beside its own file, so `buildExtension.js` copies that
script beside `dist/extension.js`. The spec checks that no built file names the
checkout.

```sh
bun install        # links the workspace, or fetches the published packages
bun run build      # server/server.js, server/testWorker.js, dist/extension.js,
                   # and what each of them reads at run time
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

## Finding the runtimes

`launch.js` decides where everything the extension spawns comes from. Its
functions are pure: the file system, the environment and the shell are handed
in, so `tests/launch.spec.ts` covers every branch.

`PATH` cannot be trusted. VS Code reads the shell environment once, at launch,
by running the user's login shell. When that probe times out, for example on a
slow `.zshrc`, every extension host of the session runs on the bare launchd
`PATH`. Neither Bun nor a user-installed Node is on it.

So a bundle runs on the Node that VS Code ships, which needs no lookup. That
covers the bundled server, a configured `.js` server and a `.js` CLI. Anything
that needs a runtime is resolved by `resolveRuntime`, in this order:

1. The explicit setting, such as `essence.bun.path`. A path that does not
   exist is an error rather than a reason to look elsewhere, since the user
   asked for that one.
2. `PATH`, which is what the user configured and what every other tool runs.
3. The usual install locations of Bun's installer, Homebrew and the Node
   version managers. They come after `PATH`, so a stray install never shadows
   a chosen version.
4. An interactive login shell asked `command -v`, which repeats the probe VS
   Code failed, bounded here to five seconds. Its output is read from the
   bottom up, past any greeting, and only an existing absolute path counts.

The answer's `source` names the step, so the output channel can tell a user
with a broken `PATH` how the runtime was found. `describeEnvironment`
recognises the bare launchd `PATH` and says to quit and reopen VS Code, since
Reload Window keeps the old environment.

When a configured server cannot run, `resolveServer` offers the bundled one as
`fallback`. The extension runs it with a warning, so diagnostics keep coming
while the setting is fixed.

`resolveCli` picks the CLI the debug adapter runs through. The setting comes
first, then a checkout open in the workspace, whose `bin/essence` runs on Bun,
then an installed `essence`. `resolveRuntime` finds that one without a setting
of its own, since `essence.cli.path` is the setting that names a CLI.

## Restarting the server

Every start and stop of the Language Server runs on one promise chain,
`lifecycle`, through `queue`. The restart command is bound to the status bar
item, where a second click is one gesture away. Two overlapping restarts would
leak a server. The second would see the `client = undefined` the first wrote,
skip the stop, and start a client. The first would then overwrite that client
when its own stop resolved. That client would never be stopped, and its server
would live until the window closed. On the chain, a restart begins only once
the one before it has finished starting, so it always has that client to stop.

`queue` catches a failure so that the chain stays usable, since a rejected
link would skip every step queued behind it. The start and the stop each
report their own failures as well.

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
- The Debug profile and the Debug lens both start a debug session: put a
  breakpoint inside a test body, press Debug on that test, and it stops there
  with the test's own bindings in the Variables view. Stepping, Continue and
  the Debug Console read as they do for a program; the console ends with
  `✓ <name>` and a count.
- Half-typing a line so the file stops compiling leaves the tree and the marks
  as they were rather than emptying them; the compile error is in Problems.
- Setting `essence.tests.enabled` to false stops the automatic runs — the marks
  stop changing as you type — while ▶ and the Run lens still work. Writing a
  tag the workspace uses into `test.skipTags` of the project's `essence.json`
  and saving re-runs everything and leaves those tests unmarked; a stale
  `essence.tests.skipTags` in the editor settings does nothing.
- `essence.json` itself opens as JSON with comments — a `//` line is not red —
  and typing a `"` inside the top-level object offers `exclude`, `test` and
  `build`, each with its description on hover. Writing `"skipTag"` instead of
  `"skipTags"` puts an `unknown-setting` Warning in Problems on that key, out
  of the unsaved buffer, and it goes when the key is fixed. Excluding the
  directory that holds one of the two test files and saving removes that file
  from the Testing view and from Problems.
- **Essence: Show Test Session Output** writes one line per cycle.
- Running with coverage (the profile picker's "Run with Coverage") sets
  `essence.tests.coverage` to true in the workspace settings, and from then on
  every cycle counts: the coverage view fills in per file, every counted line
  carries a square in the gutter — green where the tests ran it, grey where
  nothing did, amber where it ran but not whole, such as an `if` with no
  `else` whose condition was never false — and the file's declarations list
  every `match` arm and every
  Case of a `choice` with a tick or a cross. Turning the setting off again
  stops the counting and takes every square down on the next cycle. The output
  channel writes a second line per cycle with the two percentages.
- With coverage on, editing WITHIN a line of a source file (change a literal,
  keep the line count the same) re-runs only the tests that reached that line —
  the output channel's cycle line names fewer tests, and a test file whose tests
  do not reach the change is not re-run. Adding or removing a line, editing a
  top-level Constant, or having coverage off re-runs the whole reached set. A
  narrowed cycle leaves the gutter squares where they were.
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

## Applying a batch

`applyBatch` in `testModel.ts` applies one `essence/testRun` batch to what the
client holds, by three rules:

1. A file the batch covered is replaced by what the batch says about it.
2. A narrowed batch replaces only the ids it names. A Run lens over one test
   reports every other test of its file as deselected, and adopting those
   would forget results nobody asked to forget.
3. A file the batch has nothing for, in a batch that did not compile, is kept
   and marked stale. A half-typed line does not empty the Test Explorer.

A record belongs to the file its test is written in, which the events carry as
`module`. In a batch over exactly one file, a record without a module belongs
to that file.

Coverage is held apart from the test results, because the two sets of files
differ: a cycle runs `Foo.tests.es` and counts `Foo.es`. The coverage files a
batch carries are laid over what is held, by module, since a cycle covers only
what a change reached. A whole run replaces them instead: the first run of a
session, or the run after a setting changed. Switching coverage makes the
Server discard what it counted and run everything as a `settings` cycle. Such
a cycle with no files therefore means coverage was turned off, and every mark
goes. The Choices always replace what is held, since the Server works that
answer out across the whole session.

## Gutter marks

`testView.js` marks each line of a test with a square in the gutter, coloured
by what the test last did. VS Code's own Testing gutter already draws its icon
on a test's first line, so the marks cover the test's lines rather than one
icon there. A square is used rather than a bar, because a source-control gutter
draws a bar beside a changed line. A green bar meaning "passed" would be read
as "added".

A failed `expect` is marked with a dot on its own line, so it reads apart from
the squares. It also reaches the overview ruler, where a failure scrolled off
the screen can be found. Both glyphs are drawn in the same 18-unit box, and
`contain` scales the box to the gutter's cell. The glyphs therefore keep their
relative sizes at any line height.

The colours are baked into the icons, since a gutter icon is an image and
cannot follow the theme. They are fixed colours that read on light and dark
backgrounds alike. Coverage reuses three of them. Green marks a line the tests
ran, amber one they ran but not whole, and grey one nothing ran. The coverage
marks are drawn whether or not VS Code's coverage view is open, so the file
itself shows what the tests reached.

## Runs and cycles

The Server owns the run and re-runs on every edit. A run VS Code asks for is a
request through `essence/runTests`, and its results arrive on the ordinary
`essence/testRun` notifications, numbered by cycle. `testView.js` keeps each
open TestRun in `runs`, by the cycle it answers.

The Server sends a cycle's `start` notification from inside the request
handler, so it often arrives before the response that names the cycle. The run
waits in `requested` meanwhile, and a `start` with the reason `request` adopts
it.

A request made while a cycle is in flight is deferred. Its response names the
cycle that will run it before any notification carries that number, and
another cycle may start and end in between. The number is held in `promised`
until a notification names it. The response does not say whether the request
was deferred, so every number is held. Two gestures deferred into one cycle get
the same number, and the run pressed last is kept.

A cycle that never ends would leave its run spinning, for example when the
session is switched off or a Worker dies. So a newer cycle's `start` ends every
older open run that is not promised. An `end` sweeps nothing. A promised cycle
that found nothing to run ends under its own number without starting. Sweeping
then would end an older cycle that is still compiling.

Cancelling a run only stops VS Code waiting. A cycle is a Worker compiling and
cannot be stopped; its results still arrive, and the next batch draws them.

What a request asks for follows from how the Server selects tests:

- A whole file is asked for as a file, since a test written since the last
  cycle has no id yet.
- An empty request asks for the whole workspace. A list of the files this
  client knows would miss a file whose first test was just written.
- Naming ids narrows the whole cycle, so a selection of both ids and files is
  spelled out in ids.
- A lens sends both its ids and its file. The Server can match ids only
  against a run it has already done. Before the first run, or while
  `essence.tests.enabled` is off, it has none, and ids alone would run nothing.

## The test session's esbuild

The test session's Worker bundles each test file with esbuild before it runs
it, as `essence test` does. esbuild's API is JavaScript, but it starts a native
binary, which npm installs for one platform as an optional dependency. A
packaged extension has no `node_modules`, so an API bundled into the Worker
would look for that binary and not find it.

The extension ships esbuild's WebAssembly build, `esbuild-wasm`, instead. One
binary serves every platform, so one package still serves them all, where
native binaries would need a package per platform. `buildServer.js` copies it
to `server/esbuild-wasm/` and leaves `esbuild` unbundled, pointing it at the
copy. The build stops when the copy's version differs from the `esbuild` the
compiler pins, since the two must speak the same API.

The WebAssembly API starts its binary as `node bin/esbuild`. `PATH` may hold no
`node` (see "Finding the runtimes"), and the Node VS Code runs the server on is
not called `node`. So the copy starts it with `process.execPath`, the
executable the server itself runs on. Under VS Code that is the extension
host's own executable, which the inherited `ELECTRON_RUN_AS_NODE` runs as Node.
The build stops if the line of `lib/main.js` that names `node` changes shape.

The WebAssembly build writes the same bundle as the native one, but more
slowly. The compiler, the CLI and a server run from source keep the native
binary. `tests/serverBundle.spec.ts` builds the server into a directory with no
`node_modules` above it, runs it on Node with a `PATH` that holds nothing, and
checks that a workspace's tests pass.

## Packaging

```sh
bun run package
```

This rebuilds the bundle and produces a `.vsix`. The bundle is included in the
package even though it is git-ignored, so the published extension is
self-contained. Publishing to the Marketplace is

```sh
bun run publish
```

authenticated as the `essence` publisher (`bunx vsce login essence`, or the
`VSCE_PAT` environment variable). Both scripts pass `--no-dependencies`, and
a bare `vsce publish` must never be run here: without the flag, vsce asks
`npm list` for the dependency tree, finds this workspace's link to the
extension in the repository's `node_modules`, and packs the whole repository
through it — `.git`, `build/`, every package's sources, some three thousand
files — or fails on the workspace links before it gets that far.
