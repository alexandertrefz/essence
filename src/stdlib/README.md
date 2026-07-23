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

A Namespace may be half native and half Essence — `Boolean.isNot` and
`Number.isBetween` are written here, the rest of both is bound to
`src/rewriter/__internal/` — and emitted user code can not tell the two apart.
`src/rewriter/stdlibPrelude.ts` is what makes that true: it simplifies the
enriched sources once per process, and the Rewriter imports every merged
Namespace's runtime module as `$native_<Name>` and emits

```js
const Boolean = { ...$native_Boolean, isNot: function (_self, other) { … } };
```

so `Boolean.isNot(…)`, a conformance witness's `isNot: Boolean.isNot`, and a
Union dispatch target all resolve against one object. The Essence half wins
where the two collide, and `src/tests/builtins.spec.ts` fails on a Method that
is implemented in BOTH — delete the TypeScript in the same commit that writes
the Essence.

The spread keeps every export of the runtime module alive, so a const is
emitted only into Programs that actually name the Namespace, transitively. Two
things follow for whoever writes the next Essence-bodied Method: a **bodied
static Property is refused** — `static PI: Transcendental = …` would be
initialised inside the const before the const exists, so declare it without a
value until the Rewriter emits Properties as assignments — and calling into a
second merged Namespace is fine, the reachability search follows it.

`Number` is where both of those stopped being hypothetical. Its `PI` and `TAU`
are value-less native static Properties, so they arrive through the spread like
any other native and never reach the refusal; and `isBetween`'s body ends in
`::and(…)`, so a Program that reaches `Number` pulls `Boolean` in behind it and
gets both consts. A Program that names `Number` at all — `Number.PI` is
enough — gets the const, because the const is what carries the natives too.

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
  Generic** first — `sorted<infer ItemType is Comparable>()` and
  `joinWith<infer ItemType is Printable>(…)` stay Methods of `List`, which
  targets every List, and the bound is what a use site has to satisfy. The
  Method Generic shadows the Namespace's `ItemType` outright, and the bound's
  conformance arrives as a hidden trailing Argument, so the runtime
  implementation gains a `conformance` Parameter.
- **A narrower receiver needs a Namespace of its own — and only when no bound
  can express it.** `flattened` is the one such Method: its items have to be
  Lists AND it names the inner item Type, which no Protocol bound can do. It is
  declared as `NestedList<infer ItemType> for List<List<ItemType>>` in
  `List.es`, beside the Namespace it left. A receiver matches every Namespace
  whose target Type it unifies with, so `[[1]]::` reaches both `List` and
  `NestedList`, and `[1]::flattened()` finds no Namespace to search. Two such
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

A Namespace declared here but missing any of those either fails
`builtins.spec.ts` or emits a call to `undefined`.

## `List::joinWith`

Worth knowing because the signature is deliberately wider than a reader might
expect: joining asks nothing of the items but that each can say what it is, so
it is `joinWith<infer ItemType is Printable>(_ separator: String) -> String`
and `[1, 2, 3]::joinWith(", ")` is `"1, 2, 3"`, not a type error.
