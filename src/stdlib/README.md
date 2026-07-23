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

The conversion from the TypeScript tables in `src/enricher/types/*.ts` is in
flight — the core Protocols, `Boolean`, `Nothing`, `Optional`, `Ordering` and
`Record` have moved, the rest have not. Whatever a file here declares is
subtracted from those tables, so a Namespace moves over one at a time.

A Namespace may be half native and half Essence — `Boolean.isNot` is written
here, the rest of `Boolean` is still bound to `src/rewriter/__internal/Boolean.ts`
— and emitted user code can not tell the two apart. `src/rewriter/stdlibPrelude.ts`
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
