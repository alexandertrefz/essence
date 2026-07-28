# Developing the extension

The extension is one package of the [Essence
monorepo](https://github.com/alexandertrefz/essence), but what it bundles is a
DEPENDENCY: `@essence-lang/language-server`, pinned by exact version in
`devDependencies` — the published, compiled package. Inside the monorepo the
workspace satisfies that pin, so `buildServer.js` resolves to the sibling
package's TypeScript sources; anywhere else, `bun install` fetches the
published package and the same build bundles its compiled `dist/`. The
standard library's `.es` sources are copied beside the bundle the same way,
resolved off `@essence-lang/stdlib` rather than a relative path.

```sh
bun install        # links the workspace, or fetches the published packages
bun run build      # bundles @essence-lang/language-server into server/server.js
```

Press `F5` ("Extension") to open an Extension Development Host.

`server/server.js` is generated and not committed — rebuild it after changing
the Language Server. To skip the bundling step entirely while working on the
server, point `essence.server.path` at `packages/language-server/bin/esls`: a
built `.js` bundle is run with Node, and anything else is treated as source and
run with Bun. The setting spawns what it names with `--stdio` and nothing else,
so it wants that entry point rather than the `essence lsp` command a terminal
would use. That is the better loop of the two — `esls` runs the server's
TypeScript directly, so a change needs no rebuild at all, just
`Essence: Restart Language Server`, which picks it up without reloading the
window.

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

## Packaging

```sh
bun run package
```

This rebuilds the bundle and produces a `.vsix`. The bundle is included in the
package even though it is git-ignored, so the published extension is
self-contained. Publishing to the Marketplace is
`bunx vsce publish --no-dependencies`, authenticated as the `essence`
publisher (`bunx vsce login essence`, or the `VSCE_PAT` environment variable).
