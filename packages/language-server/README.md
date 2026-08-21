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
  `version` of its own (`1`), separate from the `schema` each event carries; a
  client that meets a version it does not know ignores the notification, and one
  that meets an event kind it does not know ignores that event.
- **`essence/runTests`** — a request taking `{ ids?, files? }` and answering
  `{ run }`, the number the notifications for it will carry.

The Run and Debug code lenses above every `test` and `suite` carry the commands
**`essence.test.run`** and **`essence.test.debug`**, each with one argument:
`{ ids, filePath, title }`. A client binds those two commands itself — running is
an editor gesture, and the server has no idea whether it is looking at a Test
Explorer, a terminal or a debug session. Forwarding `ids` and `filePath` to
`essence/runTests` is the whole of what `essence.test.run` has to do.
