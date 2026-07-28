# @essence-lang/compiler

The [Essence](https://github.com/alexandertrefz/essence) compiler: source text
in, JavaScript out.

The compiler is a pipeline, and the package's exports are its stages rather
than one barrel — a front end composes the stages it needs:

| Subpath | Stage |
| --- | --- |
| `@essence-lang/compiler/lexer` | source text → tokens |
| `@essence-lang/compiler/parser` | tokens → AST |
| `@essence-lang/compiler/enricher` | AST → typed AST, against the standard library |
| `@essence-lang/compiler/validator` | semantic checks over the typed AST |
| `@essence-lang/compiler/simplifier` | typed AST → typed simple AST |
| `@essence-lang/compiler/optimiser` | simplifications on the typed simple AST |
| `@essence-lang/compiler/rewriter` | typed simple AST → JavaScript module text |
| `@essence-lang/compiler/bundler` | module texts → one self-contained ES module, via esbuild |
| `@essence-lang/compiler/modules` | module graph resolution |
| `@essence-lang/compiler/diagnostics` | the Diagnostic type, codes and rendering |
| `@essence-lang/compiler/documents` | position and text-document helpers |
| `@essence-lang/compiler/helpers` | shared utilities |
| `@essence-lang/compiler/printType` | rendering a Type back to Essence notation |

Passing `--sourcemap` through the pipeline emits real source maps: positions
survive from the parser to the rewriter, each module's map rides inline, and
the bundler composes them so the final map names only the `.es` files the
author wrote — the inlined runtime and the standard-library prelude stay
unmapped, which is what lets a debugger step over them.

Most consumers want a front end instead of the stages:
[`@essence-lang/cli`](https://www.npmjs.com/package/@essence-lang/cli) assembles the
whole pipeline behind `essence build`, and
[`@essence-lang/language-server`](https://www.npmjs.com/package/@essence-lang/language-server)
runs the analysis half of it over an editor's documents.
