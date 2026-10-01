# Developing the debug adapter

The adapter speaks the Debug Adapter Protocol to a client. It speaks the Chrome DevTools Protocol to a Node process
running the compiled bundle. This file explains how its parts fit together; [README.md](README.md) covers using it.

## The call stack

`presentFrames` in `src/frames.ts` turns a CDP stack into the one the user reads. Each frame from the debuggee is
one of three kinds:

- A `user` frame maps to a line of a `.es` file.
- A standard library frame has no mapping but is named `$es_<Namespace>_<member>`. It stays on the stack, shown
  subtly under its Essence name, because a user wants to see the `sorted` that called their comparator.
- Everything else is glue: dispatch trampolines, the inlined runtime, module bootstrap. Glue is hidden unless the
  launch sets `glueFrames: "subtle"`, which shows it greyed out.

A `match` lowers to a function that is called at once, so a pause inside an arm shows an anonymous frame over the
enclosing function. The two frames are one construct, so they are merged. The anonymous frame takes its caller's
name and keeps its own position and scope chain, and the caller's frame goes.

The merge applies only to an anonymous user frame over a user frame of the same source. A Function value passed to
the standard library sits over glue instead. V8 names a Function bound to a declaration after it. So neither is
merged.

A frame still anonymous after the merge is one of two things. The last user frame is the module's top level, named
after its file. Any other is a `match` over glue, named `match`.

## Rendering values

The Variables view, watch and hover show values as `Terminal.inspect` spells them. The rendering runs inside the
debuggee. `Runtime.callFunctionOn` evaluates the source of `describeEssenceValues` in `src/render.ts` over the live
values, bigints and all, and one JSON string comes back. `essenceListItems` and `essenceDictionaryEntries` are sent
the same way when a List or a Dictionary is expanded.

Nothing else of the adapter exists in the debuggee's realm, so each of these functions is self-contained. Each
inlines what it needs and repeats the view arithmetic of the others rather than sharing it. The copies of runtime
code are these, and `src/tests/render.spec.ts` checks each rendering against `getStringRepresentation`:

- `quoted` is `quotedText` in `packages/runtime/src/String.ts`.
- `shownTag` is `caseText` in `packages/runtime/src/registry.ts`.
- A Rational is reduced to lowest terms, as `formatAsRational` in `packages/runtime/src/Rational.ts` prints it.
  `createRational` reduces nothing, and a Dictionary keeps the first key box that arrived, which may be unreduced.

The tag symbol is found by its description, because every bundle mints its own `Symbol("$type")`. For the same
reason a Dictionary entry takes its tag from the Dictionary rather than minting one. The renderer would not
recognise a Record with a second symbol.

Looking at a paused Program must not write to it. The functions build new Arrays and Records and never call
runtime code that changes a box in place, such as `materialise`.

### Lists

A List box views two runs: the back run forward in `value`, and the front run reversed in `front`. Each is as long
as its count says. `ListType` in `packages/runtime/src/List.ts` defines them. Both Arrays are shared with the other
boxes of the chain and can hold items this box never had. The renderer therefore shows the view, never the whole
Array.

A positional write changes a run in place and counts a version up. `writes` logs what each write overwrote beside
the version this box views, as `packages/runtime/src/listWrites.ts` defines. A box the chain has written past says
what it holds by undoing the writes made since its version, into a copy.

### Dictionaries

A Dictionary box is a shared store and a generation into it, as `DictionaryType` in
`packages/runtime/src/Dictionary.ts` defines. The store holds one slot per key in insertion order. Each slot holds
the versions its value has had, each stamped with the generation of the write that made it. For each slot, a box
holds the newest version stamped at or before its own generation. A slot with no such version is not the box's.

A version whose value is a Symbol is the tombstone a removal pushes. The key stands in the store, but the box does
not hold it. `typeof` decides this, because no value of the language is a Symbol. The runtime's `TOMBSTONE` belongs
to a realm the renderer cannot reach.

An entry is the Record `{ key, value }` that `entries()` answers and every Dictionary callback receives. The adapter
builds it in the debuggee rather than calling the bundle's own `entries`. A bundle may have renamed or dropped that
binding, and calling it would run Program code inside a paused Program. The key and value are the live boxes, so
expanding an entry opens what the Dictionary holds.

### Releasing handles

Every handle the Variables view mints in the debuggee belongs to the object group `VARIABLE_OBJECT_GROUP`. A List or
Dictionary row expands through one `Runtime.callFunctionOn` that builds an Array in the debuggee.
`Runtime.getProperties` puts what it answers into the group of the object it was asked about. Naming the group on
that one call therefore puts the entries read off the Array into it too.

`releaseVariableObjects` releases the group on each new pause and on each resume, the two moments a
`variablesReference` stops meaning anything. The Array itself is released as soon as it has been read.

This matters for Dictionaries. A List's items are the Program's own values, reachable from the box whether the
debugger holds a handle or not. A Dictionary's entries are built by `essenceDictionaryEntries`, and only the handle
holds them. Without the release, every opened row would leave its entries in the debuggee until the session ends.

## Stepping

A step is carried over the runtime and the prelude in two layers.

When the bundle's script is parsed, the session blackboxes every line the bundle's map does not cover.
`blackboxPositions` in `src/stepping.ts` collects the mapped lines into runs. `Debugger.setBlackboxedRanges` takes
toggle positions: the interval before the first position is plain, the next one blackboxed, and so on. The first
toggle at 0:0 starts blackboxing, and each run of mapped lines switches it off and on again around itself. A run
that starts at line 0 would leave an empty leading interval, so that pair is dropped. V8 then steps over the
unmapped code by itself.

The manual step in `onPaused` covers what blackboxing cannot. `beginStep` records the kind of step, the source line
it starts on and a budget of 50 pauses. While budget remains, a pause in unmapped code steps on: a step-in steps
into, a next or step-out steps out. A next that lands on the line it started from steps over again, since one
source line can be several generated statements. When the budget is spent, the session stops where it is rather
than run on without the user seeing it.

### The entry pause

`--inspect-brk` holds the program before its first statement. The launch sends `Runtime.runIfWaitingForDebugger`
and awaits the pause that follows without reporting it, and the client sets its breakpoints while the program
waits there. `configurationDone` then decides what becomes of the pause. Without `stopOnEntry` the program resumes.
With it, the session steps in, because the entry pause sits in runtime glue and the user means the first statement
they wrote. Blackboxing carries the step over the glue, and the stop is reported as `entry`.

## Debugging a test

A launch that names `tests` compiles the program with its `tests { … }` block. The result is a `.mjs` bundle that
publishes its registry on `$tests` and runs nothing on its own. `testRunnerSource` in `src/testRunner.ts` writes a
runner script beside the bundle, which imports it, runs the requested tests and prints a report. The session
launches the runner and addresses breakpoints to the bundle, so it carries both paths.

The runner is a separate file rather than an epilogue appended to the bundle. The bundle stays the exact file its
source map describes, so every breakpoint lands where the map says. The runner is generated as text because it
names the bundle and the test ids. A file shipped with the adapter would also have to be found at run time, in a
package that may be bundled into one file.

The runner prints its own report rather than using the test reporter, since inside the debuggee it may depend only
on the bundle it loads. It sets the exit code to 1 when a test fails, as `essence test` does.
