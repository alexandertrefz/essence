# @essence-lang/language-server

The Language Server for the
[Essence](https://github.com/alexandertrefz/essence) programming language,
speaking the Language Server Protocol over stdio.

Start it as `essence lsp` from
[`@essence-lang/cli`](https://www.npmjs.com/package/@essence-lang/cli), or through this
package's own `esls` launcher. Any LSP client can drive it; the
[Essence VS Code extension](https://github.com/alexandertrefz/essence/tree/master/packages/vscode-extension)
bundles it.

It serves diagnostics (with stable codes and Quick Fixes), completion,
signature help, hovers, go-to-definition, references, document highlight,
renaming, linked editing, call hierarchy, semantic tokens, inlay hints, code
lenses, folding and selection ranges, an outline, and formatting via
[`@essence-lang/formatter`](https://www.npmjs.com/package/@essence-lang/formatter) — all
running on the same compiler stages `essence build` compiles with, so the
editor and the build can never disagree about a program.

## The live test session

It also runs the workspace's tests as they are typed. An edit re-runs the test
files it reached, on the unsaved buffer; a failed `expect` is published as a
`test-failed` diagnostic; the values a run recorded are served as inlay hints;
and two workspace-wide tag diagnostics — `similar-tags` and `lonely-tag` —
report what no single module could see. `essence.tests.enabled` (default true)
switches the whole of it off.

Two things beyond the protocol, which a client has to know about. Both shapes
are written out in `src/testProtocol.ts`.

- **`essence/testRun`** — a notification, sent twice per run: once as
  `kind: "start"` naming the files about to run, and once as `kind: "end"`
  carrying the whole event batch, the counts and the duration. It has a
  `version` of its own (`3`), separate from the `schema` each event carries; a
  client that meets a version it does not know ignores the notification, and one
  that meets an event kind it does not know ignores that event.
  - `sites` carries every test of every file the batch covers — id, name
    template, suite path, effective tags, and the ranges of the whole item and
    of its keyword — whether it ran or not, so a client can draw a tree and put
    each item on its line without parsing anything. It is empty for a file that
    would not compile, which is the signal to keep drawing the tree it last had.
  - `ids` carries what the batch was narrowed to, empty where it was not. A
    narrowed batch reports a deselection for every other test of that file, so a
    client merges by id rather than replacing the file.
  - `coverage` carries what the run's counters counted, one entry per SOURCE
    file — which is not the same set as `files`: a `Foo.tests.es` runs the
    tests, and what its counters counted is mostly `Foo.es`. Each entry holds
    the line, branch and Case ratios, every point with its count and range, and
    the branches and arms nothing reached. It is empty unless
    `essence.tests.coverage` is on, and a cycle only covers the entries a change
    reached — so a client showing the whole project lays each batch over what it
    had, keyed by `module`.
- **`essence/runTests`** — a request taking `{ ids?, files? }` and answering
  `{ run }`, the number the notifications for it will carry. Naming neither runs
  every test file of the workspace, which is what a Test Explorer's Run and
  Refresh buttons mean — and the only way to reach a file whose first test was
  written since the last cycle. `null` comes back where nothing matched.
  A request is answered even while `essence.tests.enabled` is false: what the
  setting declines is running on every keystroke, not running when asked.

The server reads one configuration section, `essence.tests`, through
`workspace/configuration` whenever the client says something under `essence`
changed: `enabled` (default true) stops the session running by itself,
`skipTags` names tags no run selects, `debounce` is how long a burst of edits
may be before it costs a run (default 450 ms), and `coverage` (default false)
makes every run count what it reached. A client that answers nothing keeps the
defaults. Coverage is off by default deliberately: instrumenting compiles a
different bundle from the one a build produces and makes the Program do more
work on every keystroke, so it is the reader who decides it is worth that.
Changing it throws away what was counted under the old setting and runs
everything again. What `enabled: false` declines is the automatic
half — a request still runs, the lenses are still offered, and what a requested
run found is still published. Only the workspace-wide tag Diagnostics go with
it, because those walk every parse in the project on the Server's own
account.

The Run and Debug code lenses above every `test` and `suite` carry the commands
**`essence.test.run`** and **`essence.test.debug`**, each with one argument:
`{ ids, filePath, title }`. A client binds those two commands itself — running is
an editor gesture, and the server has no idea whether it is looking at a Test
Explorer, a terminal or a debug session. Forwarding `ids` and `filePath` to
`essence/runTests` is the whole of what `essence.test.run` has to do.

A third lens, **`essence.test.acceptSnapshot`**, is offered above a test whose
last run left a snapshot to accept — one nothing had recorded, or one that
differs from what was stored. It carries the same argument, and what it has to
do is forward it to `essence/runTests` with `update: true`. The server records
whatever that run produces: a `__snapshots__` companion is written where it
stands, and a source it would rewrite comes back as a `workspace/applyEdit` —
so an unsaved buffer is edited rather than written round, and the change is
undoable like anything else the reader did.

Every id a lens carries is a test's own. A table test has one per ROW, because
a row is a test in its own right and carries its row number as the last step of
its identity.
