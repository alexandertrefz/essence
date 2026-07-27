# @essence/cli

`essence` — the command line for the
[Essence](https://github.com/alexandertrefz/essence) programming language. One
binary carries the whole toolchain: the compiler, the formatter, the Language
Server and the Debug Adapter.

## Install

```sh
npm install -g @essence/cli
```

This puts `essence` on PATH, along with `esc`, the same binary under its
historic name. Node 22 or later runs it; under [Bun](https://bun.sh) it works
the same.

## Usage

```
essence <command> [file...] [options]
essence <file.es>              same as: essence build <file.es>
```

| Command  |                                                          |
| -------- | -------------------------------------------------------- |
| `build`  | Compile Essence sources to JavaScript (the default)      |
| `run`    | Compile a source file and execute it immediately         |
| `check`  | Type-check sources without writing any output            |
| `watch`  | Recompile automatically whenever a source changes        |
| `format` | Format Essence sources in place                          |
| `lsp`    | Start the Essence Language Server, speaking over stdio   |
| `dap`    | Start the Essence Debug Adapter, speaking over stdio     |
| `help`   | Show help for `essence` or for a single command          |

`essence HelloWorld.es` compiles one file to `HelloWorld.js` beside it. The
emitted bundle is a self-contained ES module — the runtime is inlined and
tree-shaken into it — and runs under Node or Bun with no dependencies.
`--sourcemap` emits a source map whose positions are the `.es` lines the
author wrote, which is what the debugger and mapped stack traces read.

`essence --help` documents every option; `essence help <command>` goes deeper
on one. `--json` turns any build into a machine-readable report.
