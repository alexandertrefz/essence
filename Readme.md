# Goals
The main goal for Essence is to allow the authoring of bug-free maintainable code, in a fast and pleasant manner.
Essence features a strong type system combined with a mixture of functional and object oriented concepts, enabling code that is easy to understand & maintain.

Its syntax and features are designed with modern IDE's in mind, allowing for great code completion & inline documentation features.

Essence compiles to modern ECMAScript, allowing execution in Bun, Node.js as well as browsers.

# The Essence
* Explicit is better than implicit.
* Extensibility is better than completeness.
* Creating correct code must be enjoyable.
* Prototyping must be fast – thus refactoring must be painless.
* Readability counts.
* There should be one – and preferably only one – obvious way to do it.
* Practicality beats purity.
* Simple is better than complex.
* Complex is better than complicated.
* Beautiful is better than ugly.
* Clever is seldom good.

# Features
* All Data is Immutable
* Static Structural Typing
* Type Inference
* Compact & Readable Syntax
* Algebraic Data Types
* Modules
* Protocols
* Generics
* Named Parameters
* Arbitrary Precision Numbers
* First-Class Functions


# Example Code
You can find the most recent and working example of syntax in [HelloWorld.es](packages/fixtures/files/HelloWorld.es)
as well as the other files in [packages/fixtures/files](packages/fixtures/files). It also should be noted that the
syntax is meant to be viewed with a font with code ligatures, like FiraCode.

The standard library is written in Essence and lives in [packages/stdlib/sources](packages/stdlib/sources); its
[README](packages/stdlib/README.md) is the most substantial writing about the language there is.

# The Compiler
Essence is compiled with `esc`, in [packages/cli/bin](packages/cli/bin). Compiling a file produces a self-contained
ES module next to it — the parts of the runtime the program actually uses are bundled in, so the output runs
under Bun or Node, or in a browser, with nothing else installed.

```sh
packages/cli/bin/esc HelloWorld.es          # compile to HelloWorld.js
packages/cli/bin/esc run HelloWorld.es      # compile and execute, emitting nothing
packages/cli/bin/esc check *.es             # type-check only, no output
packages/cli/bin/esc watch List.es          # recompile on every save
packages/cli/bin/esc build *.es -o dist/    # compile a batch, in parallel
```

`bun install` also links `esc` and `esls` into `node_modules/.bin`, so `bun run esc …` works from anywhere in
the repository.

Run `esc help` for the command overview, and `esc help <command>` for everything a single command can do.
`--json` turns any of them into a machine-readable report for editors and CI.

# Repository layout

One workspace, eleven packages. Nothing is built: every package points `main` straight at its TypeScript, and
Bun runs the sources.

| Package | What it is |
|---|---|
| [`compiler`](packages/compiler) | the pipeline — lexer, parser, enricher, validator, simplifier, optimiser, rewriter, bundler |
| [`interfaces`](packages/interfaces) | the types every stage agrees on. Depends on nothing |
| [`stdlib`](packages/stdlib) | the standard library, written in Essence |
| [`runtime`](packages/runtime) | the native halves of the standard library, inlined into every compiled program |
| [`ariadne`](packages/ariadne) | a TypeScript port of the `ariadne` diagnostic renderer |
| [`escodegen`](packages/escodegen) | vendored fork of the ECMAScript code generator, see its [PATCHES.md](packages/escodegen/PATCHES.md) |
| [`cli`](packages/cli) | `esc` |
| [`language-server`](packages/language-server) | `esls`, spoken over stdio |
| [`vscode-extension`](packages/vscode-extension) | the VS Code extension, which bundles the language server |
| [`website`](packages/website) | the documentation |
| [`fixtures`](packages/fixtures) | Essence sources the test suite compiles |

# Development

```sh
bun install
bun test          # run the test suite
bun run check     # lint and format
bun run typecheck # type-check every package, as one program
```

The Language Server is started by the `esls` executable in
[packages/language-server/bin](packages/language-server/bin). To develop the VS Code extension against a live
server, point its `essence.server.path` setting at that file — it runs the server's TypeScript directly, so
there is no bundle to rebuild.

# Disclaimer
This language is still a work in progress. It is not ready for use yet and there is no documentation as most things are in flux. Generally: Here be dragons!
