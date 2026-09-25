# @essence-lang/runtime

The [Essence](https://github.com/alexandertrefz/essence) language runtime —
the native halves of the standard library, inlined into every compiled
Program.

This package is consumed in an unusual direction. A bundled Program does not
import it: the compiler's rewriter writes absolute paths to these modules into
the JavaScript it emits, and the bundler inlines and tree-shakes exactly what
the Program touched. A host's build, which is what the plugins of
`@essence-lang/client` make, imports `@essence-lang/runtime/<Module>` by
package specifier instead. What the compiler imports from this package is
mostly its *location*, `RUNTIME_DIRECTORY` and `RUNTIME_TSCONFIG`; the few
values it imports are the rational arithmetic its constant folding shares with
Programs and the test runner's `DEFAULT_CASES`.

That inlining is also why the published package ships its TypeScript
sources in `src/` alongside the compiled `dist/`: the bundler inlines the
sources, so a published compiler emits the same bundle bytes a workspace
checkout does.

Values are plain objects tagged with a `$type` symbol. An `Integer` holds a
JavaScript number while its value is a safe integer and a `bigint` beyond, and
a `Rational` holds a pair of bigints, so that `1::divide(by 3)` stays exact;
the numeric tower continues through `Algebraic` and `Transcendental`. The
pretty-printer behind `Terminal.inspect` lives here too, in `Terminal.ts`.

You would depend on this package directly only to build tooling that
manipulates compiled Essence values —
[`@essence-lang/compiler`](https://www.npmjs.com/package/@essence-lang/compiler) brings
it along for everything else.
