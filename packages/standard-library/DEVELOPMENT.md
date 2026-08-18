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

A Namespace private to its own file — `Exact` in `Number.es`, which holds the
one mixed-kind dispatch `Number.sum` and `Number.product` fold over — needs no
loader change and no registration at all: the builtin tables are built from
`Prelude.es`'s surface, so a name that is not on it reaches none of them. It is
still a Namespace of the library like any other, its bodies are emitted and
reached the same way, and it is a call-graph Node, so it is listed in
`packages/compiler/src/tests/stdlibCallGraph.spec.ts` with the rest.

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

Every Namespace here is part native and part Essence — seven of every ten
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
`5::squareRoot()` — but `squareRoot`'s no-Argument entry answers an
`Optional` the `Algebraic` annotation refuses, so it stays value-less with the others. So the band is
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
  native too. `List.hasItems(where:)` and `hasItems(onlyWhere:)` ARE written in
  Essence, but on `reduce`'s early-stopping entry rather than on the eager
  `everyItem(where:)`, so they stop at the item that decides the answer — the
  earlier filtering form lost that and measured ~0 ms → ~180 ms over 2000 calls
  when the first item decides it. `count(where:)` is still on
  `everyItem(where:)`, which is right: counting has to see every item.

Prefer a body that reaches only its own Namespace's primitives. `packages/compiler/src/tests/bundleSize.spec.ts`
guards two files, but it is a floor, not a substitute for measuring.

## Why bodies look the way they do

Seven mechanics account for most of what looks odd in these files. Each is
explained once, here. A body that leans on one carries a one line pointer to
this section, and the bodies beside it carry nothing.

**`@` is the scrutinee inside a `match`, not the receiver.** A Case body reads
`@` as the value the `match` is over. Bind the receiver to a Constant above the
`match` where a Case body needs it — `constant text = @` — as `String::pad`,
`String::compare(to:comparing:)` and `Rational::round` do.

**A Method Generic has to be written `infer`.** A Generic without it never
enters `bindableNames`, and inference then leaves it unbound. Every Method
level Generic here is written `<infer Result>` or
`<infer ItemType is Equatable>`.

**A written literal is its own refinement proof.** The Compiler reads the value
of a literal, so `2` is a NonZeroInteger. `@::remainder(dividingBy 2)` answers a
bare Integer, and there is no Optional to take apart. A value the Program is
handed carries no such proof and goes through the predicate instead.

**`Equatable` is derived for a Choice.** The conformance is declared and the
Methods are left out: a Choice compares by tag, and by payload where a Case
carries one. A Namespace over a Choice of unit Cases writes `toString` and
nothing else. `Ordering`, `Side` and `CaseSensitivity` are all that shape.
`Optional` is the exception, and says why at its own declaration: its `is`
takes a bare item as well as another Optional, which no derived conformance
offers.

**An Overload is selected by the first entry the Arguments match.** Two orders
are in play. The order the entries are WRITTEN numbers them, and that number is
in the emitted name (`divide__overload$3`) and in the native binding, so
inserting an entry rebinds every entry after it. The order they are READ hoists
the entries that ask for a refinement, so a call that can prove what a refined
entry asks for reaches it wherever it stands. Two consequences are worth
knowing: `Optional::is` declares the whole Optional entry FIRST, so
`#Empty::is(#Empty)` asks whether the receiver is empty; `Rational.of` appends
its refined entry LAST, where it is numbered after the others and still read
before them.

**A body pulls its whole transitive reach into every bundle.** A Method is
emitted into a Program that reaches it, and so is everything its body calls.
`Integer::isLessThan` is written on Integer's own `compare` for that reason:
routing it through the covering `Number::compare` reaches the whole numeric
tower, and nearly doubled a Program that only compares two Integers.
`packages/compiler/src/tests/bundleSize.spec.ts` is the guard.

**`reduce` binds `Result` from `startingWith`.** The seed decides the Type the
fold carries, and it is read before the callback is checked. So a seed that is
an empty List or an empty Optional is bound to an annotated Constant first,
and the Constant is what `startingWith` is given:
`constant kept: List<ItemType> = []` in `removeDuplicates`,
`constant start: Optional<ItemType> = #Empty` in `firstItem(where:)`. A bare
`[]` has no items to read the item Type from, and a bare `#Empty` fixes the fold
to the empty Case alone.

## Writing the docs and notes

A `§§` block is what a reader of the LANGUAGE sees, in a Hover and in a
Completion list. A `§` note is what the next person editing this file sees.
They answer different questions and are held to different rules.

### `§§` blocks

The writing rules are ASD-STE100's — the writing rules, not the dictionary,
since the language's own terms are technical names:

- The first sentence says what the Method answers, in 25 words or fewer.
- Edge cases are their own sentences, in a SECOND paragraph, separated by a
  blank `§§` line. The first paragraph is the answer; everything after it is a
  case.
- One topic per sentence. No sentence over 25 words.
- No em-dash aside inside a sentence. A colon that introduces an example is
  fine.
- Active voice, present tense. `can`, never `may`. No `should`.
- No metaphor, no idiom, no aside. Those belong to the README.
- One term for one thing: item, character, position, answers.
- `@returns` is a noun phrase, and a second sentence after it where one is
  needed.

**A `@param` line documents the Parameter at its own position.** The first line
documents the first Parameter, the second the second, and each names its
Parameter the way the signature names it: the label, or `_` where the Parameter
carries none. `insert(_ item, at index)` is documented `@param _` and
`@param at`. A line naming something else is `misnamed-documentation-parameter`;
a line past the last Parameter is `unknown-documentation-parameter`. A block
above an `overload` keyword documents the set as a whole, where a position means
nothing, so a line there can name a Parameter of any entry.

**A documented Parameter list is documented in full.** A block that writes any
`@param` writes one per Parameter, and each names the label or `_` — the
internal name a body reads a labelled Parameter under is not a second spelling
for it, and a Parameter no line reached is `undocumented-parameter`. That is
`documentationStrictness = "strict"`
(`packages/compiler/src/enricher/resolvers.ts`), which is what every Program is
held to. The `"lenient"` half of the rule — the internal name, and a run that
stops before the last Parameter — survives only as the alternative
`documentationParameterProblems` can be asked for, and only
`documentation.spec.ts` asks.
`packages/compiler/src/tests/stdlibProse.spec.ts` enforces the four writing
rules over these sources, and every one of them is live: a sentence over 25
words, an em-dash aside inside a `§§` sentence, a ` may ` or a ` should `, and
an ALL-CAPS word that is not an acronym each fail it.
`ESSENCE_PROSE_REPORT=1 bun test stdlibProse` prints what they find, per rule
and per file.

### `§` notes

A note says why the code is what it is. It holds three things: the decision,
the alternative it was taken over, and the number that decided it — a measured
bundle size, a measured time. Nothing else earns the lines.

History does not: what a body used to be, and what was tried before it, are in
git. Neither do metaphor, ALL-CAPS emphasis and asides. A note that a reader has
to read twice is a note to shorten.

A mechanic that several bodies share is explained once, in
[Why bodies look the way they do](#why-bodies-look-the-way-they-do). The site
that leans on it carries the pointer; the sites beside it carry nothing.

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
- **A `@param` is matched to a Parameter by POSITION**, and names it the way
  the signature does — see [Writing the docs and
  notes](#writing-the-docs-and-notes). A line that names something else, or
  that stands past the last Parameter, attaches to nothing and is rendered into
  every Hover regardless — a description of a Parameter the reader cannot find.
  Both are reported, which is what caught `split(intoGroupsOf size:)` being
  documented as `@param groupsOf`.
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
  can express it.** `flatten` is the clearest case: its items have to be
  Lists AND it names the inner item Type, which no Protocol bound can do. It is
  declared as `NestedList<infer ItemType> for List<List<ItemType>>` in
  `List.es`, beside the Namespace it left. The numeric aggregates are the same
  shape for a plainer reason — `sum` is about numbers rather than about any item
  — so `IntegerList`, `RationalList` and `NumberList` (`NumberList.es`) each
  target the List of one numeric kind, and a List of Strings reaches none of
  them. A receiver matches every Namespace
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
  and `namespace NonEmptyList<infer ItemType> for NonEmptyList<ItemType>` holds the three
  Methods the proof changes the answer of — `firstItem` and `lastItem` answer an
  item where `List`'s own answer an Optional, and `length` answers a
  `NonZeroInteger` where `List`'s answers an Integer. The rest of that Namespace
  carries the proof forward instead: a `map` or a `reverse` of a List with
  something in it still has something in it. A refined receiver reaches every
  Namespace its base reaches and this one besides, so the refined target beats
  the base target for a Method both declare; a List nothing proved anything
  about does not reach it at all. None of the three can be written in Essence,
  which is the point rather than a gap: a refinement erases before anything
  runs, so a native is what spending the evidence looks like. `length` is the
  plainest case — an Essence body could only write `@::length()`, which is that
  same Method on a receiver that still carries the proof, and the Validator
  refuses it as `infinite-recursion`.
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
3. a place in `builtinMemberOrder` (`packages/compiler/src/enricher/builtins.ts`),
4. a row in `builtins.spec.ts`'s `runtimeModules`, and
5. a place in the Namespace order `packages/compiler/src/tests/stdlibLoader.spec.ts`
   asserts, which reads the same list back.

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

### A native that declares a default

A native signature may carry `= expression` on a Parameter — `trim(at side: Side
= #BothEnds)`, `slice(from start: Integer = 0, to end: Integer = @::length())` —
and **the native contract does not change at all**. The runtime never learns
that defaults exist: it keeps taking exactly the Parameters the declaration
lists, positionally, with no default and no rest parameter, and `nativeArity`
counts them the way it always did.

What the Compiler does instead is synthesize the frame the default needs, as a
top-level const beside the prelude's Essence-implemented members:

```js
const $es_String_trim = (_self, side = $type.createCase("Side#BothEnds")) =>
	String.trim(_self, side)
```

**Only a call site that actually leaves an Argument out names it.** A call that
writes every Argument emits byte-identically to what it always did — a direct
read off the imported runtime module, tree-shakeable exactly as before — and the
shim, which nothing references, is dropped by the bundler.

The invariant this rests on is worth writing down: **a native's declaration in
`sources/` stays the single source of truth for its defaults.** Asking the
runtime to implement one would spell the same default twice, once in `.es` as
documentation and once in `.ts` as behaviour, with nothing checking that the two
agree. The `.es` file says what the default is; the `.ts` file never mentions
it.

A default is refused where it could never fire: on a Protocol requirement
(`default-on-protocol-requirement`), and on a Function literal in expression
position (`default-on-function-literal`). And in this version a Method fulfilling
a Protocol requirement must match it exactly, defaulted Parameters included —
which is why `String.is` and `String.isNot` keep their `overload` block rather
than collapsing into a defaulted `comparing:` Parameter.
