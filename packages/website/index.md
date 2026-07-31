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
You can find the most recent and working example of syntax in the [HelloWorld.es](https://github.com/alexandertrefz/essence/blob/master/packages/fixtures/files/HelloWorld.es)
as well as the other files in [packages/fixtures/files](https://github.com/alexandertrefz/essence/tree/master/packages/fixtures/files). It also should be noted that the syntax is meant to
be viewed with a font with code ligatures, like FiraCode.

You can compile any of them with the `essence` executable in `packages/cli/bin`. This produces a self-contained ES
module of the same name beside the source — the parts of the runtime the program actually uses are bundled in,
so it runs under Bun or Node, or in a browser, with nothing else installed.

```sh
essence HelloWorld.es       # compile to HelloWorld.js
essence run HelloWorld.es   # compile and execute in one step
essence check *.es          # type-check only, no output
essence format *.es         # format in place
```

That one executable carries the whole toolchain — `build`, `run`, `check`, `watch`, `format` and `lsp` — and
`essence help` describes every command. The older names still work as aliases: `esc` is `essence`, `esfmt` is
`essence format`, and `esls` is `essence lsp`.

The current runtime implementation is rudimentary however. There are many features missing from the standard library. Various langauge features are only partially implemented.

# Disclaimer
This language is still a work in progress. It is not ready for use yet and there is no documentation as most things are in flux. Generally: Here be dragons!
