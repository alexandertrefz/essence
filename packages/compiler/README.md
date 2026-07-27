# @essence/compiler

The [Essence](https://github.com/alexandertrefz/essence) compiler: source text
in, JavaScript out.

The compiler is a pipeline, and the package's exports are its stages rather
than one barrel — a front end composes the stages it needs:

| Subpath | Stage |
| --- | --- |
| `@essence/compiler/lexer` | source text → tokens |
| `@essence/compiler/parser` | tokens → AST |
| `@essence/compiler/enricher` | AST → typed AST, against the standard library |
| `@essence/compiler/validator` | semantic checks over the typed AST |
| `@essence/compiler/simplifier` | typed AST → typed simple AST |
| `@essence/compiler/optimiser` | simplifications on the typed simple AST |
| `@essence/compiler/rewriter` | typed simple AST → JavaScript module text |
| `@essence/compiler/bundler` | module texts → one self-contained ES module, via esbuild |
| `@essence/compiler/modules` | module graph resolution |
| `@essence/compiler/diagnostics` | the Diagnostic type, codes and rendering |
| `@essence/compiler/documents` | position and text-document helpers |
| `@essence/compiler/helpers` | shared utilities |
| `@essence/compiler/printType` | rendering a Type back to Essence notation |

Passing `--sourcemap` through the pipeline emits real source maps: positions
survive from the parser to the rewriter, each module's map rides inline, and
the bundler composes them so the final map names only the `.es` files the
author wrote — the inlined runtime and the standard-library prelude stay
unmapped, which is what lets a debugger step over them.

Most consumers want a front end instead of the stages:
[`@essence/cli`](https://www.npmjs.com/package/@essence/cli) assembles the
whole pipeline behind `essence build`, and
[`@essence/language-server`](https://www.npmjs.com/package/@essence/language-server)
runs the analysis half of it over an editor's documents.
