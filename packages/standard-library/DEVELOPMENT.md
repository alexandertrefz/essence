# Developing the standard library

What the library is and how its names are chosen is the
[README](./README.md); this is the half for editing the library itself.

**`packages/compiler/src/tests/stdlibGolden.spec.ts` is the net.** `packages/fixtures/files/StdlibExhaustive.es`
calls every declared Method across its edge cases and its output is diffed
against a checked-in capture. Never regenerate that capture to make a test
pass — a changed value means a body is wrong.

## `declarations { … }`

Each file opens with `declarations { … }` rather than `implementation { … }`.
It is the Program form that lets a Namespace body hold **body-less native
Method signatures** (`method(a: Integer) -> Integer` with no block) and
**value-less static Properties** (`static Pi: Transcendental`). A signature
alone declares that the runtime implements the Method; a signature with a body
implements it here, in Essence. Nothing else about the form differs — the same
Parser, Enricher and Validator run over it.

The form is refused outside this directory, and the loader refuses an
`implementation { … }` file inside it: an `implementation` Program can not
declare a native at all, so accepting one would silently produce a Namespace
missing exactly the Methods the file was written to add.

## Every file here is a Module

Each file writes an `import { … }` block naming what it uses from its siblings
and an `export { … }` block naming what it offers them. They are linked through
the same machinery a user Program's Modules go through, one Scope per file.

Two rules the loader enforces, both by throwing:

- **Every import must be USED.** An unused entry is a warning, and a warning
  anywhere in here takes the whole load down.
- **Every entry must be UNALIASED.** An imported Namespace is bound as a shallow
  copy carrying the LOCAL name, and the Rewriter builds `$es_<Namespace>_<member>`
  from that name — under an alias a call site emits a const nothing declares.

Writing an import is not optional for a Namespace you only DISPATCH through:
`length::subtract(…)` needs `Integer` imported even though the call never spells
it. Naming `Integer` as a *Type* needs no import — the nine bare Type tags live
one Scope out, and are the only names that do.

### The prelude

`Prelude.es` re-exports what the LANGUAGE offers. The builtin tables are built
from its surface alone, so there are three levels of visibility:

| | |
|---|---|
| private to its file | not in that file's `export { … }` |
| internal to the library | exported, not re-exported by `Prelude.es` |
| a builtin | re-exported by `Prelude.es` |

Adding a name to `Prelude.es` adds it to the language. A helper the library needs
and the language should not grow simply stays off the list.

### The shape of the graph is frozen

One cycle is allowed — `Algebraic`, `Integer`, `List`, `Rational`, `String`,
`Transcendental` — and the loader refuses any other. That group is intrinsic:
cross-kind arithmetic means each numeric kind names the others, a String's
characters ARE a `List<String>`, and both `parse`s consume a String. A new cycle
anywhere, or a seventh file joining that one, means an import closed a circle
nobody decided on. `EXPECTED_CYCLE` in `packages/compiler/src/enricher/stdlib.ts`
is where it is stated.

### The rest

A single Diagnostic anywhere in here is a compiler-developer error and throws,
fully rendered by the same renderer the CLI prints with, against the file it was
found in.

The load happens once per process and is cached; `loadStdlib()` hands every
consumer — the Enricher's top level Scope, the Language Server's builtin
listings, the test suite — the same object. It costs on the order of 60 ms,
most of it enrichment, since each group hoists to its own fixed point.

The ORDER the builtins are listed in is the one thing a source file can not say
about itself, because each declares only its own name. It is stated in
`builtinMemberOrder`, `builtinTypeOrder` and `builtinProtocolOrder`
(`packages/compiler/src/enricher/builtins.ts`), and it is observable: Completion
dedupes members first-Namespace-wins, the Enricher searches `matchingNamespaces`
in that order, and `closestMatch` breaks a "did you mean …?" tie on the first
candidate.

Documentation Positions read out of these files are stripped before the tables
are handed out — a builtin is sourceless to Hover, Signature Help and `go to
definition` in a USER's Program. The Language Server opens these files as
ordinary documents when you edit them, which is a different path, so navigation
inside `packages/standard-library/sources` works normally.

## Native and Essence in one Namespace

Every Namespace here is half native and half Essence — about half of all
declared Method entries are written in Essence — and emitted user code can not
tell the two apart. `packages/compiler/src/rewriter/stdlibPrelude.ts` simplifies the enriched
sources once per process, and the Rewriter emits each Essence-implemented
Method as its OWN top-level const:

```js
import * as Boolean from "…/runtime/src/Boolean.ts";

const $es_Boolean_isNot = function (_self, other) { … };
```

A native stays a member read off the plain import (`Boolean.negate(…)`), which
esbuild rewrites to a direct symbol reference and can tree-shake; an
Essence-implemented Method is not a member of anything, so nothing has to
materialise the module namespace object. `namespaceMember` in
`packages/compiler/src/rewriter/index.ts` picks the spelling, and all four emission sites — a
plain call, a conformance witness, a Union dispatch target, a static Lookup —
go through it, so every one works for both kinds.

`packages/compiler/src/tests/builtins.spec.ts` and the generated contract both fail on a Method
implemented in BOTH — delete the TypeScript in the same commit that writes the
Essence.

A const is emitted only into Programs that reach it. The reachability search
reads each Method's TYPED body, so it follows a Method reached only through
another Essence Method's body, including through a conformance witness.

A **bodied static Property** is emitted the same way, as its own const — but in a
band BELOW every Method and free Function, because its value is computed where
its const stands rather than when something calls it. Within that band the
Properties are emitted in the order they read each other, and a Property that
reads itself, or a pair that read each other, is refused instead of emitted in an
order that happens to run. That order follows a Property THROUGH the Methods and
free Functions it calls: a Method called from inside a Property's value runs in
the band, so the Properties it reads are read there too, and a Property that a
Method it calls reads back is refused like any other cycle. A Method the value
only hands on — `static F = Boolean.isNot`, or a conformance witness — is not
followed, since its body runs whenever it is eventually called. A Property's value
can only name a Namespace declared above its own, so backwards is the only
direction an edge points. A value-LESS
`static Pi: Transcendental` stays a native and reaches a call site as the plain
`Number.Pi` member read — no standard library Property has a value yet.

`Number.Pi`, `Number.Tau` and `Number.E` look like the ones that should have
gone first, and none of them can. No Essence expression produces a
Transcendental out of nothing — every native that answers with one takes one —
so `Pi` and `E` ARE the primitives the rest are written from, and there is no
Transcendental literal to write instead. Every arithmetic route to `Tau` is
Typed `Transcendental | Rational` (`Number.Pi::multiply(with 2)`,
`Number.Pi::add(Number.Pi)`), because a zero factor and a cancelled π term
collapse the value to a Rational, and the declared `Transcendental` refuses the
Union. `Number.GoldenRatio` alone has an Essence spelling — a half plus half of
`5::squareRoot()` — but `squareRoot` answers an `Optional` the `Algebraic`
annotation refuses, so it stays value-less with the others. So the band is
exercised through `useStdlib`
(`packages/compiler/src/enricher/stdlib.ts`), the seam that swaps the
process-wide library for one a test wrote, until a Property that can carry a
value is written here.

### What to weigh before writing the next one

Composition is not free, and three costs are easy to miss because no test fails:

- **A body pulls in everything it transitively reaches.** `Integer.compare`
  once delegated to the covering `Number.compare`; that made comparing two
  Integers drag the Algebraic, Transcendental and Rational machinery into any
  Program that compared two Integers, nearly doubling `HelloWorld.es`.
  Same-kind ordering is native again for that reason. `Algebraic::absolute`,
  `Transcendental::absolute` and `Transcendental::is` read the covering
  Namespace the same way — three lines that were the only mentions of `Number`
  in either file — and cost a Program that takes two absolute values 3.9 kB of
  a tower it never named. Algebraic's is written on its own `compare` now (a
  value is below its own negation exactly when it is negative, and an Algebraic
  is never zero); Transcendental declares no ordering to write either of its
  two on, so both went native. `Number.es` is out of the cycle entirely.
- **Two Namespaces can end up written on each other.** `String` is written on
  `List` throughout — `lines`, `repeat` and `replaceFirst` all route through it
  — and `List::toString` was written on `String::append`, the one call back.
  It is native now, so the edge points one way. Interpolating would not have
  helped: a hole renders through its value's `Printable` conformance, and for a
  String that is `String::toString`, the same edge under another name.
- **A body can change complexity class.** `String.length` written as
  `@::characters()::length()` is correct, but builds a List of every character
  to count them, and pulls `List`'s whole import graph in behind it. It is
  native too. `List.anyItem`/`everyItem` ARE written in Essence, but on the
  native short-circuiting `firstItem(where:)` rather than the eager `keepEvery`,
  so they stop at the item that decides the answer — the earlier `keepEvery`
  form lost that and measured ~0 ms → ~180 ms over 2000 calls when the first
  item decides it. `count(where:)` is still on `keepEvery`, which is right:
  counting has to see every item.

Prefer a body that reaches only its own Namespace's primitives. `packages/compiler/src/tests/bundleSize.spec.ts`
guards two files, but it is a floor, not a substitute for measuring.

## Editing hazards

- **Two Methods of one name in a Namespace body are not reported.** The second
  silently replaces the first, without a word. This is a gap in the Enricher,
  not in this directory, but writing a Namespace by copying a neighbouring
  Method is what makes it likely.
- **Overload ORDER is load-bearing.** An Overload's position picks the
  `__overload$N` name the Simplifier emits and therefore the runtime export it
  binds to, natives included. Reordering an `overload` block silently rebinds
  every Overload in it.
- **Wrap Documentation lines only where the text should wrap.** The lines of a
  `§§` block are joined with a newline, so re-flowing a description to fit the
  margin changes the string an Editor renders.
- **A tag carrying its text on its own line separates the two with an
  em-dash.** `@param other — the String to add`, `@returns — the joined
  String`. A tag head alone takes its text from the lines below it and needs no
  separator; one that runs its text on without either is reported as
  `missing-documentation-separator`, and still lifted.
- **A `@param` is matched against the Parameter's external and then internal
  name.** One naming neither attaches to nothing, and is rendered into every
  Hover regardless — a description of a Parameter the reader cannot find. It is
  now reported as `unknown-documentation-parameter`, which is what caught
  `split(intoGroupsOf size:)` being documented as `@param groupsOf`. A
  `§§` block above an `overload` keyword may name a Parameter of any Overload
  in the set.
- **Every Method of a Namespace answers for the Namespace's target Type.**
  There is no per-Method receiver, and a Method that only some values of the
  target Type can answer does not belong there. Reach for a **bounded Method
  Generic** first — `sort<infer ItemType is Comparable>()` and
  `join<infer ItemType is Printable>(with:)` stay Methods of `List`, which
  targets every List, and the bound is what a use site has to satisfy. The
  Method Generic shadows the Namespace's `ItemType` outright, and the bound's
  conformance arrives as a hidden trailing Argument, so the runtime
  implementation gains a `conformance` Parameter.
- **A narrower receiver needs a Namespace of its own — and only when no bound
  can express it.** `flatten` is the one such Method: its items have to be
  Lists AND it names the inner item Type, which no Protocol bound can do. It is
  declared as `NestedList<infer ItemType> for List<List<ItemType>>` in
  `List.es`, beside the Namespace it left. A receiver matches every Namespace
  whose target Type it unifies with, so `[[1]]::` reaches both `List` and
  `NestedList`, and `[1]::flatten()` finds no Namespace to search. When two such
  Namespaces declare the SAME Method name, the narrower target wins —
  `List<List<ItemType>>` covers only nested Lists, `List<ItemType>` covers those
  too, so a nested receiver resolves to `NestedList` — and it is a Namespace
  whose target is no narrower than another's that leaves the call
  `ambiguous-namespace`. Naming a Method twice is still worth avoiding: which
  one a call reaches then depends on the receiver's Type rather than on what it
  says.
- **A receiver narrowed by EVIDENCE is the same rule with a refinement as the
  target.** `NonEmptyList<ItemType>` is a checked refinement of `List<ItemType>`,
  and `namespace NonEmptyList<infer ItemType> for NonEmptyList<ItemType>` holds the two
  Methods the proof makes total — `firstItem` and `lastItem`, answering an item
  where `List`'s own answer an Optional. A refined receiver reaches every
  Namespace its base reaches and this one besides, so the refined target beats
  the base target for a Method both declare; a List nothing proved anything
  about does not reach it at all. Neither Method can be written in Essence,
  which is the point rather than a gap: a refinement erases before anything
  runs, so a native is what spending the evidence looks like.
- **A Type and the Namespace that targets it belong in one file.** `Optional`
  and `Ordering` each declare their Choice and the Namespace over it together;
  splitting them across files works, but leaves the two halves of one idea
  where nobody looking at either finds the other. A Namespace narrower than the
  general one goes in the same file too — `NestedOptional` sits under
  `Optional`, as `NestedList` does under `List`.

## Adding a Namespace

A new Namespace is a new runtime module. The Simplifier emits
`<Namespace>.<method>(…)`, so each name needs

1. an entry in `runtimeNamespaceNames` (`packages/compiler/src/rewriter/index.ts`),
2. a a `@essence-lang/runtime` module — a re-export of the implementation is
   enough,
3. a place in `builtinMemberOrder` (`packages/compiler/src/enricher/builtins.ts`), and
4. a row in `builtins.spec.ts`'s `runtimeModules`.

A Namespace that also declares a **Type** — a `choice`, as `Ordering` and `Side`
do — needs a fifth: a place in `builtinTypeOrder`, beside `builtinMemberOrder`.

`builtins.spec.ts` cross-checks the first, third and fourth against each other
and against the Namespaces declared here, so a missing registration is a failing
test rather than a call to `undefined`.

One more site is easy to miss because it is not a registration list: the native
contract generator (`packages/compiler/src/tools/generateNatives.ts`) maps each Essence Type to
the runtime type that stands for it. A new `choice` whose Cases appear in ANY
native signature needs its Union alias in `UNION_NAME_ALIASES`, its Case types
in `CASE_TYPES`, and each of those names in `RUNTIME_TYPE_MODULES` — otherwise
`generate:natives` throws `no runtime type known for Case '<Choice>#<Case>'`
rather than rendering the contract. `Side` needed all three, because
`String::trim(at:)` takes one.

## The native contract

`@essence-lang/runtime`'s `natives.generated.ts` is generated from these
declarations by `bun run generate:natives` and checked in. It spells the calling
convention every native binding must keep as TypeScript, so `tsc` rejects a
native whose signature has drifted:

- non-static Method → `fn(receiver, …declaredParameters, …conformanceWitnesses)`
- static Method → `fn(…declaredParameters, …conformanceWitnesses)`
- a bounded Method Generic adds a trailing `<Name>__conformance` object of the
  bound Protocol's Methods
- an Overload binds to `name__overload$N`, N its position in the Method Type's
  overloads — **never** its position among the bodied ones

A missing native, a wrong receiver, a wrong arity, a wrong parameter or return
Type, a misplaced witness, and a runtime export left behind for a Method that
moved to Essence are all compile errors. `packages/compiler/src/tests/natives.spec.ts` fails, without
ever writing, when the checked-in file drifts from the renderer — regenerate and
commit it in the same change as the signature. It is in both `.oxlintrc.json` and
`.oxfmtrc.json` `ignorePatterns`, like the generated parser grammar.

A native that accepts FEWER parameters than declared is assignable to the
declared arrow type, so the `$<Namespace>` assertion alone would let it through.
The paired `$<Namespace>Arity` assertion pins the count instead, one `member: N`
entry per native. `Parameters<T>['length']` is a literal only for a plain
signature, so a default or rest parameter fails it too — which is the intent, as
a native is called positionally with every argument the convention passes. The
runtime `.length` of each export is checked against the same count in
`packages/compiler/src/tests/builtins.spec.ts`, the one place a default parameter
can still be seen.
