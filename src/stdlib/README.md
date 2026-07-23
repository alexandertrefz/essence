# The Standard Library

Essence's standard library, written in Essence.

Everything a Program can reach before its first line is declared here: the core
Protocols (`Equatable`, `Printable`, `Comparable`), `Boolean`, `Nothing`,
`Optional`, `Ordering`, `Record`, `String`, the whole numeric tower (`Integer`,
`Rational`, `Algebraic`, `Transcendental` and the covering `Number`, which
brings the `Number` and `Irrational` Union Types with it), and `List` together
with `NestedList`.

The only things NOT declared here are the ones no declaration could produce:
the bare Type tags — `Boolean`, `String`, `Integer`, `Rational`, `Algebraic`,
`Transcendental`, `Nothing`, the open Record and the unapplied `List` — which
live in `src/enricher/primitives.ts`, and `__print`, the one native Function
with no Namespace to live in, in `src/enricher/types/NativeFunctions.ts`.

About half of the declared Method entries are also IMPLEMENTED here, in
Essence; the rest bind to `src/rewriter/__internal/`. What stays native is a
deliberate line, not a backlog: the primitives everything else is composed from
(`Boolean.negate`/`is`/`and`/`or`, integer and rational arithmetic, same-kind
`compareTo`), the JavaScript intrinsics Essence has no expression for
(`String.uppercased`, the trim Methods, `Record`'s reflective Methods,
`String.compareTo` — there is no way to name a character's code point), and the
iteration primitives the rest rest on (`List.reduce`, `item(at:)`, `slice`,
`keepEvery`, `append(contentsOf:)`, `static of`, `String.split(on:)`).

Two Methods are native for reasons worth reading before assuming otherwise:
`String.replaceEvery`, because on the EMPTY part `replaceAll` inserts at UTF-16
code-unit boundaries — between the two surrogate halves of an emoji — a
position Essence cannot name; and `List.is`, because the pairwise form trips an
infinite recursion in generic inference (the repro is at the declaration).

**`src/tests/stdlibGolden.spec.ts` is the net.** `testFiles/StdlibExhaustive.es`
calls every declared Method across its edge cases and its output is diffed
against a checked-in capture. Never regenerate that capture to make a test
pass — a changed value means a body is wrong.

## The voice

The library is meant to be guessable: after a handful of Methods, a reader
should be able to predict what the next one is CALLED and which of its Arguments
carry a label. Four rules decide that, and every Method here follows them.

**1. A transforming Method is an imperative command.** `add`, `sort`, `reverse`,
`trim`, `round`, `negate`, `flatten`, `map`, `split`, `insert`, `clamp` — never
the past-tense participle (`sorted`, `reversed`, `trimmed`). In a mutating
language `list.sort()` is dangerous and `sorted()` is how an immutable API warns
you; Essence has no such hazard to warn against, because EVERY Method is a Query
and nothing is ever changed in place. `list::sort()` can only mean "give me the
sorted List" — there is no mutating `sort` to confuse it with. Immutability is a
global invariant, stated once here, not something each name re-encodes. `::`
already lends the receiver-first feel; the imperative completes it and reads
better (`1::add(2)`, not `1::added(2)`).

**2. A preposition is a label, never fused into the verb.** When an Argument is
reached through a preposition — *of* a thing, *on* a separator, *with* a prefix,
*by* a comparison, *at* an index — the preposition is that Argument's label and
the verb stem stays bare: `text::firstIndex(of ",")`, `text::split(on ",")`,
`text::starts(with "x")`, `list::sort(by compare)`, `list::item(at 0)`,
`2::raise(to 10)`, `1::divide(by 2)`.

**3. Direct object positional, everything prepositional labelled.** A verb's
direct object — what it acts on, with no preposition between — stays positional
and bare: `contains(_ other)`, `prepend(_ item)`, `add(_ other)`,
`insert(_ item, …)`. Everything reached THROUGH a preposition is labelled,
whether it is the only Argument (`firstIndex(of:)`) or a later one
(`replaceEvery(_ part, with:)`, `insert(_ item, at index)`,
`pad(to length, with pad)`). So `insert(_ item, at index)` reads "insert `item`,
at `index`" — the item is the direct object, the index is reached through *at*.

**4. A variant of one idea is an Overload, not a new name.** One `trim` with an
`at:` Overload, not `trimmed`/`trimmedAtStart`/`trimmedAtEnd`; one `sort`, not
`sorted`/`sortedBy`. And a fixed set of modes is a `choice`, never a `String` —
`trim(at Side#Start)`, not `trim("start")`.

Three name SHAPES, so rule 1 is not misapplied:

| Shape | Form | Examples |
|---|---|---|
| **Transformation** — does something, returns the result | imperative command | `sort`, `reverse`, `trim`, `negate`, `pad`, `clamp`, `raise(to:)`, `join(with:)` |
| **Predicate** — returns a `Boolean` | `is…`/`has…`/`doesNot…` prefix, or a direct verb | `isEmpty`, `isEven`, `hasItems`, `contains`, `starts(with:)` |
| **Accessor** — returns an intrinsic part | noun or adjective; no verb to force | `length`, `numerator`, `reciprocal`, `absolute`, `keys`, `firstItem`, `item(at:)`, `firstIndex(of:)`, `indexed` |

Rules 2 and 3 do NOT apply to the `is…`/`has…`/`doesNot…` prefixes — those are
predicate naming, not prepositional Arguments, so `isGreaterThan`, `isBetween`
and `doesNotContain` keep their fused word. Quantifiers and adjectives are not
prepositions either: `removeEvery`, `keepEvery`, `removeFirst`,
`removeDuplicates`, `firstItem`/`lastItem` keep theirs.

Two more conventions worth stating because they are already consistent and easy
to break:

- **A predicate Parameter is always labelled `where`** — `keepEvery(where:)`,
  `count(where:)`, `anyItem(where:)`.
- **Count-like nonsense is lenient; value-like failure returns an `Optional`** —
  `List.repeat(_, times 0)` is the empty List, while `clamp` with inverted
  bounds is `Nothing`.
- **Keep return Types tight.** Add Overloads rather than widening one signature:
  `Integer::add(Integer) -> Integer` beside `add(Rational) -> Rational`, never a
  single `add(Number) -> Number`.

## `declarations { … }`

Each file opens with `declarations { … }` rather than `implementation { … }`.
It is the Program form that lets a Namespace body hold **body-less native
Method signatures** (`method(a: Integer) -> Integer` with no block) and
**value-less static Properties** (`static PI: Transcendental`). A signature
alone declares that the runtime implements the Method; a signature with a body
implements it here, in Essence. Nothing else about the form differs — the same
Parser, Enricher and Validator run over it.

The form is refused outside this directory, and the loader refuses an
`implementation { … }` file inside it: an `implementation` Program can not
declare a native at all, so accepting one would silently produce a Namespace
missing exactly the Methods the file was written to add.

## How it is loaded

`src/enricher/stdlib.ts` reads every `.es` file in this directory, in sorted
order, hoists them into ONE shared Scope — so a Protocol declared in one file
and a Namespace conforming to it in another resolve across the file boundary —
and then enriches and validates them. A single Diagnostic anywhere in here is a
compiler-developer error and throws, fully rendered by the same renderer the
CLI prints with.

The load happens once per process and is cached; `loadStdlib()` hands every
consumer — the Enricher's top level Scope, the Language Server's builtin
listings, the test suite — the same object. It costs on the order of 15 ms.

The ORDER the builtins are listed in is the one thing a source file can not say
about itself, because each declares only its own name. It is stated in
`builtinMemberOrder` and `builtinTypeOrder` (`src/enricher/builtins.ts`), and it
is observable: Completion dedupes members first-Namespace-wins, the Enricher
searches `matchingNamespaces` in that order, and `closestMatch` breaks a "did
you mean …?" tie on the first candidate.

Documentation Positions read out of these files are stripped before the tables
are handed out — a builtin is sourceless to Hover, Signature Help and `go to
definition` in a USER's Program. The Language Server opens these files as
ordinary documents when you edit them, which is a different path, so navigation
inside `src/stdlib` works normally.

## Native and Essence in one Namespace

Every Namespace here is half native and half Essence — about half of all
declared Method entries are written in Essence — and emitted user code can not
tell the two apart. `src/rewriter/stdlibPrelude.ts` simplifies the enriched
sources once per process, and the Rewriter emits each Essence-implemented
Method as its OWN top-level const:

```js
import * as Boolean from "…/__internal/Boolean.ts";

const $es_Boolean_isNot = function (_self, other) { … };
```

A native stays a member read off the plain import (`Boolean.negate(…)`), which
esbuild rewrites to a direct symbol reference and can tree-shake; an
Essence-implemented Method is not a member of anything, so nothing has to
materialise the module namespace object. `namespaceMember` in
`src/rewriter/index.ts` picks the spelling, and all four emission sites — a
plain call, a conformance witness, a Union dispatch target, a static Lookup —
go through it, so every one works for both kinds.

`src/tests/builtins.spec.ts` and the generated contract both fail on a Method
implemented in BOTH — delete the TypeScript in the same commit that writes the
Essence.

A const is emitted only into Programs that reach it. The reachability search
reads each Method's TYPED body, so it follows a Method reached only through
another Essence Method's body, including through a conformance witness. A
**bodied static Property is still refused** — its initialiser would run in
declaration order, and ordering two Properties that name each other is not
answered yet; declare it without a value, as `Number.PI` and `TAU` are.

### What to weigh before writing the next one

Composition is not free, and two costs are easy to miss because no test fails:

- **A body pulls in everything it transitively reaches.** `Integer.compareTo`
  once delegated to the covering `Number.compareTo`; that made comparing two
  Integers drag the Algebraic, Transcendental and Rational machinery — and
  `bigint-fraction` — into any Program that compared two Integers, nearly
  doubling `HelloWorld.es`. Same-kind ordering is native again for that reason.
- **A body can change complexity class.** `String.length` written as
  `@::characters()::length()` is correct, but builds a List of every character
  to count them, and pulls `List`'s whole import graph in behind it. It is
  native again too. `List.anyItem`/`everyItem`/`firstItem(where:)` ARE written
  on `keepEvery`, which has no early exit, so they lost short-circuiting —
  measured at ~0 ms to ~180 ms over 2000 calls when the first item decides it.

Prefer a body that reaches only its own Namespace's primitives. `src/tests/bundleSize.spec.ts`
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
- **A `@param` is matched against the Parameter's external and then internal
  name.** One naming neither attaches to nothing and is rendered into every
  Hover regardless.
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
  `NestedList`, and `[1]::flatten()` finds no Namespace to search. Two such
  Namespaces must not declare the SAME Method name: receiver specificity does
  not break that tie, and the call is reported as `ambiguous-namespace`.
- **A Type and the Namespace that targets it belong in one file.** `Optional`
  and `Ordering` each declare their Type and the Namespace over it together;
  splitting them across files works, but leaves the two halves of one idea
  where nobody looking at either finds the other.

## Adding a Namespace

A new Namespace is a new runtime module. The Simplifier emits
`<Namespace>.<method>(…)`, so each name needs

1. an entry in `runtimeNamespaceNames` (`src/rewriter/index.ts`),
2. a `src/rewriter/__internal/<Name>.ts` — a re-export of the implementation is
   enough,
3. a place in `builtinMemberOrder` (`src/enricher/builtins.ts`), and
4. a row in `builtins.spec.ts`'s `runtimeModules`.

`builtins.spec.ts` cross-checks the first, third and fourth against each other
and against the Namespaces declared here, so a missing registration is a failing
test rather than a call to `undefined`.

## The native contract

`src/rewriter/__internal/natives.generated.ts` is generated from these
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
moved to Essence are all compile errors. `src/tests/natives.spec.ts` fails, without
ever writing, when the checked-in file drifts from the renderer — regenerate and
commit it in the same change as the signature. It is in both `.oxlintrc.json` and
`.oxfmtrc.json` `ignorePatterns`, like the generated parser grammar.

One gap remains: a native that accepts FEWER parameters than declared is not
caught, because TypeScript treats a shorter function as assignable.

## `List`'s bounded Methods

Three of `List`'s Method Generics carry a Protocol bound, and each bound is a
statement about what the Method needs rather than a restriction to work around.

`join<infer ItemType is Printable>(with separator: String) -> String` is
deliberately wider than a reader might expect: joining asks nothing of the items
but that each can say what it is, so `[1, 2, 3]::join(with ", ")` is `"1, 2, 3"`,
not a type error. `sort<infer ItemType is Comparable>()` is the same shape for
ordering.

`is`, `isNot`, `contains`, `doesNotContain`, `firstIndex(of:)`, `lastIndex(of:)`,
`count(of:)`, `removeEvery(_ item:)` and `removeDuplicates` are bounded
`is Equatable`, so equality between items means the item Type's OWN `is` rather
than a structural comparison the language cannot express. That is a narrowing:
a Method holding an UNBOUNDED `List<ItemType>` can no longer call them, and the
Diagnostic says which bound to add. `List` conforms
`is Equatable where ItemType is Equatable`, so nested Lists still have a witness.
