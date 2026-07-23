# The Standard Library

Essence's standard library, written in Essence.

Each file opens with `declarations { … }` — the Program form that lets a
Namespace body hold body-less native Method signatures (`method(a: Integer) ->
Integer` with no block) and value-less static Properties (`static PI:
Transcendental`). A signature alone declares that the runtime implements the
Method; a signature with a body implements it here, in Essence.

`src/enricher/stdlib.ts` reads every `.es` file in this directory, in sorted
order, hoists them into ONE shared Scope — so a Protocol declared in one file
and a Namespace conforming to it in another resolve across the file boundary —
and then enriches and validates them. A single Diagnostic anywhere in here is a
compiler-developer error and throws, fully rendered.

The conversion from the TypeScript tables in `src/enricher/types/*.ts` is
complete — the core Protocols, `Boolean`, `Nothing`, `Optional`, `Ordering`,
`Record`, `String`, the whole numeric tower (`Integer`, `Rational`,
`Algebraic`, `Transcendental` and the covering `Number`, which brings the
`Number` and `Irrational` Union Types with it) and finally `List` all live
here. Whatever a file here declares is subtracted from those tables, so the
Namespaces moved over one at a time; what is left of the legacy half is the
bare primitive Type tags and `__print`.

A Namespace may be half native and half Essence — `Boolean.isNot` and
`Number.isBetween` are written here, the rest of both is still bound to
`src/rewriter/__internal/` — and emitted user code can not tell the two apart. `src/rewriter/stdlibPrelude.ts`
is what makes that true: it simplifies the enriched sources once per process, and
the Rewriter imports every merged Namespace's runtime module as `$native_<Name>`
and emits

```js
const Boolean = { ...$native_Boolean, isNot: function (_self, other) { … } };
```

so `Boolean.isNot(…)`, a conformance witness's `isNot: Boolean.isNot`, and a
Union dispatch target all resolve against one object. The Essence half wins where
the two collide, and `src/tests/builtins.spec.ts` fails on a Method that is
implemented in BOTH — delete the TypeScript in the same commit that writes the
Essence.

The spread keeps every export of the runtime module alive, so a const is emitted
only into Programs that actually name the Namespace, transitively. Two things
follow for whoever converts the next one: a **bodied static Property is refused**
— `static PI: Transcendental = …` would be initialised inside the const before
the const exists, so declare it without a value until the Rewriter emits
Properties as assignments — and adding a Method that calls into a second merged
Namespace is fine, the reachability search follows it.

`Number` is where both of those stopped being hypothetical. Its `PI` and `TAU`
are value-less native static Properties, so they arrive through the spread like
any other native and never reach the refusal; and `isBetween`'s body ends in
`::and(…)`, so a Program that reaches `Number` pulls `Boolean` in behind it and
gets both consts. A Program that names `Number` at all — `Number.PI` is
enough — gets the const, because the const is what carries the natives too.

A Type and the Namespace that targets it move TOGETHER: the subtraction is per
category, so converting `choice Ordering` alone would leave the legacy
`Ordering` Namespace pointing at the old Type object and say nothing about it.

`src/tests/stdlibEquivalence.spec.ts` is the net the move rides on: for every
name already converted it deep-compares what was read from here against the
table it replaced, which stays on disk until the last one is gone. Every
Namespace converted adds one line to its registry; the whole file is deleted
with the last table.

## Transcription hazards

- **Two Methods of one name in a Namespace body are not reported.** The second
  silently replaces the first, and the equivalence gate only notices when the
  two differ — a Method pasted twice unchanged disappears without a word. This
  is a gap in the Enricher, not in this directory, but hand transcription is
  what makes it likely.
- **Overload ORDER is load-bearing.** An Overload's position picks the
  `__overload$N` name the Simplifier emits and therefore the runtime export it
  binds to, natives included. Transcribe an `overload` block in the order the
  table wrote it.
- **Wrap Documentation lines only where the text should wrap.** The lines of a
  `§§` block are joined with a newline, so re-flowing a description to fit the
  margin changes the string an Editor renders.
- **A `@param` is matched against the Parameter's external and then internal
  name.** One naming neither attaches to nothing and is rendered into every
  Hover regardless. The gate reports these per Overload.
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
- **A new Namespace is a new runtime module.** The Simplifier emits
  `<Namespace>.<method>(…)`, so each name needs an entry in
  `runtimeNamespaceNames` (`src/rewriter/index.ts`), a
  `src/rewriter/__internal/<Name>.ts` — a re-export of the implementation is
  enough — a place in `builtinMemberOrder` (`src/enricher/builtins.ts`), and a
  row in `builtins.spec.ts`'s `runtimeModules`.

## The one intentional API change

The conversion is a transcription, and the equivalence gate holds it to that —
with a single exception, on the record here and in `stdlibEquivalence.spec.ts`.
`List::joinWith` was fixed to a List of Strings, because a hand written table
entry had no way to ask for less. Joining asks nothing of the items but that
each can say what it is, so it is now
`joinWith<infer ItemType is Printable>(_ separator: String) -> String` and
`[1, 2, 3]::joinWith(", ")` is `"1, 2, 3"`. Behaviour on a List of Strings is
unchanged. The gate does not normalize the difference away: `joinWith` is
excused from `List`'s wholesale comparison and pinned by a test that spells the
new declaration out in full.
