![Codecov](https://img.shields.io/codecov/c/github/alexandertrefz/essence/master.svg?style=for-the-badge)

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
You can find the most recent and working example of syntax in the [HelloWorld.es](testFiles/HelloWorld.es)
as well as the other files in [testFiles](testFiles). It also should be noted that the syntax is meant to
be viewed with a font with code ligatures, like FiraCode.

The current runtime implementation is rudimentary however. There are many features missing from the standard library. Various langauge features are only partially implemented.

# The Compiler
Essence is compiled with `esc`, in [bin](bin). Compiling a file produces a self-contained ES module
next to it — the parts of the runtime the program actually uses are bundled in, so the output runs
under Bun or Node, or in a browser, with nothing else installed.

```sh
bin/esc testFiles/HelloWorld.es        # compile to testFiles/HelloWorld.js
bin/esc run testFiles/HelloWorld.es    # compile and execute, emitting nothing
bin/esc check testFiles/*.es           # type-check only, no output
bin/esc watch testFiles/List.es        # recompile on every save
bin/esc build testFiles/*.es -o dist/  # compile a batch, in parallel
```

Run `bin/esc help` for the command overview, and `bin/esc help <command>` for everything a single
command can do. `--json` turns any of them into a machine-readable report for editors and CI.

# Development

```sh
bun install
bun test          # run the test suite
bun run check     # lint and format
bun run typecheck # type-check the compiler itself
```

The Language Server is started by the `esls` executable in [bin](bin).

# Disclaimer
This language is still a work in progress. It is not ready for use yet and there is no documentation as most things are in flux. Generally: Here be dragons!
