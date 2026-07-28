# @essence-lang/runtime

The [Essence](https://github.com/alexandertrefz/essence) language runtime —
the native halves of the standard library, inlined into every compiled
Program.

This package is consumed in an unusual direction. Programs never import it:
the compiler's rewriter writes absolute paths to these modules into the
JavaScript it emits, and the bundler inlines and tree-shakes exactly what the
Program touched. What the compiler imports from this package is therefore its
*location* — `RUNTIME_DIRECTORY` and `RUNTIME_TSCONFIG` — not its values.

That is also why the published package deliberately ships its TypeScript
sources in `src/` alongside the compiled `dist/`: the bundler inlines the
sources, so a published compiler emits the same bundle bytes a workspace
checkout does.

Values are plain objects tagged with a `$type` symbol; `Integer` holds a
`bigint`, `Rational` a pair of them, and the numeric tower continues through
`Algebraic` and `Transcendental` so that `1::divide(by 3)` stays exact. The
pretty-printer behind `__print` lives here too, in `functions.ts`.

You would depend on this package directly only to build tooling that
manipulates compiled Essence values —
[`@essence-lang/compiler`](https://www.npmjs.com/package/@essence-lang/compiler) brings
it along for everything else.
