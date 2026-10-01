# Developing the compiler's tools

## The natives contract

A Method signature without a body in `packages/standard-library/sources/*.es` declares a native, bound by name to
an export of `@essence-lang/runtime`. Nothing between the enricher's tables and the runtime module checks that
the export has the right shape. `generateNatives.ts` renders the loaded standard library into
`packages/runtime/src/natives.generated.ts`, a TypeScript contract that `tsc` checks. Nothing imports the file, so
it has no run-time footprint. `bun run generate:natives` writes it, and `tests/natives.spec.ts` fails when the
checked-in file differs from what `renderNativesModule` renders.

Each Namespace gets a `*Natives` type, with one entry per native: Properties first, then Methods, each Overload
under its mangled `__overload$N` key. Each entry is an arrow type, never method shorthand, so that
`strictFunctionTypes` checks its Parameters contravariantly. A non-static entry's receiver comes first, named
`self`. Each bounded Generic appends a conformance witness Parameter, in declaration order, as the runtime
calling convention passes them. `nativeArity` counts those slots, and `tests/builtins.spec.ts` checks it against
each runtime function's `.length`. A comment before each entry spells the Essence signature, so that a reordered
Overload shows in the diff. The free Functions, which are the `loop` entries, get a `FunctionsNatives` type and
the module `./functions`.

`mapType` maps each Essence Type to its runtime type. It throws on any Type it can not render, since a silent
`any` would defeat the check. A refinement maps to its base, which is all a native receives. The builtin unit
Choices and the generic Choices `Step`, `Optional` and `Result` map to runtime aliases through the tables at the
head of the file. Any other Union is rendered as the union of its members. A Parameter label that is a reserved
word in TypeScript is replaced by `argument<index>`, since the calling convention is positional.

### The assertions

Each module gets up to three assertions.

1. `$<Namespace>` assigns the module to its `*Natives` type. That catches a missing native or one of the wrong Type.
   Extra exports pass, since a reference is not excess-checked as an object literal is. An empty `*Natives`, for a
   Namespace written wholly in Essence, always holds.
2. `$<Namespace>Absent` forbids a runtime export for a Method implemented in Essence, so leftover TypeScript can
   not drift away from the Essence that replaced it. `AssertNoEssenceExports` is built on `keyof` rather than on
   an intersection with `{ member?: never }`. An empty `{}` intersected with that weak type is itself weak, and
   TypeScript would wrongly reject a module that lacks the member.
3. `$<Namespace>Arity` pins each native Method's arity with `AssertArities`. Assignability can not, since a
   function taking fewer Parameters is assignable to a wider type. `Parameters<T>["length"]` is a literal only for
   a plain signature: a default Parameter widens it to a union and a rest Parameter to `number`. Neither matches,
   which is right, since a native has to spell out every argument the convention passes. A member the module
   lacks is left to the first assertion.

The absence and arity assertions are left out where they would have nothing to say, and so are their helper
types. A bounded Protocol gets a `<Protocol>Conformance` witness type, its whole surface with `Self` bound to the
Type Parameter. A provided Method appears in it at the requirement's own arity, as the compiler emits it.

The output is deterministic. The Namespaces arrive in `builtinMemberOrder`, and every table is read in source
order.
