# Developing the client

What the package does for a host is the [README](./README.md), and what the boundary costs is
[BENCH.md](./BENCH.md). This page is the map for changing the package itself. Paths are relative to
`packages/client/src` unless they name another package.

## Input types

`Input<T>` in `input.ts` is what a caller may pass where a Module declared `T`. What comes back is `T` itself.
The two differ only at an Integer. It always comes out as a `bigint`, so a call's Type does not depend on the size of
its answer. Going in, the interpreter takes a safe `number` as readily as a `bigint`. A declaration that said `bigint`
for a Parameter would make every caller write `BigInt(i)` for nothing.

`Input<T>` is a mapped Type rather than a second declaration of every alias, so a Parameter reads `Input<Rectangle>`
and hovers to the shape. It walks down a List, through both slots of a Dictionary and into a Record's members. A
naked `T` distributes over the arms of a Union. It stops where marshalling stops:

- A Rational is a class and crosses as itself.
- A Function is not widened. Its declaration already prints each Parameter and its answer in the direction that
  value crosses.
- A `Map` is matched before the object case. The mapped Type would otherwise walk its Methods and widen no key.
- A `Promise` is matched for the same reason, since the mapped Type would walk `then`, `catch` and `finally`. The
  declaration that printed it already spells what it holds.

## Bare Cases

A unit Choice is one whose Cases have no payload, and its Cases cross as their bare names: a `Direction#Up` is the
string `"Up"`. This package calls such a Case a bare Case. It avoids "unit Case", which the compiler uses for any Case
without a payload. `Shape#Blank` is a unit Case without being bare, because `Shape` has Cases with payloads and
crosses as an object.

A String crosses as a string too, and one Choice's `#Up` is spelled like another's. Where a Union puts two such arms
in one position, the position has no unambiguous JavaScript spelling, and the boundary refuses it. Deciding would turn
a String `"Up"` handed in into a `Direction#Up` coming out, and the boundary must not lose data. Other Union arms are
tried in declaration order, and the first that admits a value takes it. That rule does not reach bare Cases.

The rule is per Case name, not per pair of Choices. `Direction | Vertical` is spellable while the two share no Case
name. A Choice with payloads crosses as a `$case` object, which no string is, so `Direction | Shape` is spellable too.
Two bare Cases of one name collide only when their tags differ. Two Modules may each declare a `choice Direction`, so
the display name is no identity, while one Case reached twice through a Union is no collision.

`bareCaseCollision` in `bare-cases.ts` is the one statement of the rule. The marshaller asks it whether a position can
cross at all, and `dts.ts` asks it whether a position can be printed. A second copy could start refusing what the
other still declares.

Only a Union is asked. A lone bare Case, or one inside an `Optional`, has its position to itself. A Record member or a
List item that holds two shapes is a Union of its own, asked where it is reached.

The arms compared are the ones a JavaScript value is decided between. A nested Union is flattened, since its arms
stand in the outer position unchanged. An `Optional` is flattened too, because it is spelled by absence and
`undefined` collides with nothing. It reaches a Descriptor in two shapes. `describeUnion` collapses a Union of exactly
its two Cases into an `optional` node. In a larger Union the two Cases stay apart, the `#Value` carrying a String
collides with `#Up`, and `#Empty` adds nothing.

## Rounding a Rational to a double

`toNumber` in `rational.ts` answers the nearest double, rounded once. When both parts are at most `2 ** 53`, a double
holds each exactly, and one hardware division rounds correctly, as IEEE 754 requires. Larger parts would each be
rounded on conversion, and dividing two roundings can misround the quotient by an ulp.

Past that fast path, `dividedMagnitude` still rounds exactly once:

- The quotient is taken to 64 bits, and a nonzero remainder sets its low bit. Any later rounding to 53 bits or fewer
  then reads this quotient as halfway exactly when the true quotient is halfway.
- Converting that quotient to a double is the one rounding. Scaling it back by a power of two is exact.
- A subnormal answer has fewer significant bits than the conversion keeps, so converting would round twice. When the
  exponent is under -1022, `roundedShift` rounds the quotient to a multiple of `2 ** -1074` in bigint arithmetic, half
  to even. The result converts exactly. A tie it sees is a true tie, since an inexact quotient has its low bit set.

`scaledByPowerOfTwo` multiplies in steps of at most `2 ** 1023`, the largest power of two a double holds. One
multiplication can underflow. For `1/2 ** 1020` the quotient `2 ** 64` scales back by `2 ** -1084`, which is `0` as a
double, while the answer is the normal `8.9e-308`. Stepping keeps every intermediate in range. The loop stops early at
`0` and at `Infinity`, which no further step changes.

## Bundler plugins

`essence` in `vite-plugin.ts`, `essenceEsbuild` in `esbuild-plugin.ts` and `essenceBun` in `bun-plugin.ts` answer one
question for three hosts: what a `.es` file compiles to. `plugin-core.ts` answers it once.

A plugin compiles a `.es` file when the bundler asks for its text. What comes back is not a bundle but the graph as
modules. There is one JavaScript module per `.es` file and the standard library's prelude, and the runtime is imported
by its package name. The host resolves, shakes and splits all of it as it does its own code.

A host bundles the runtime as source, so each plugin hands the host `BUNDLE_DEFINES`, as the Compiler's own bundler uses
them: Vite through the `config()` hook, esbuild through `initialOptions.define` and `Bun.build` through
`build.config.define`. A host that dropped them would keep the List work count a spec reads, at the cost of its bytes
and one global read per copy. See "Counting a List's work" in packages/runtime/DEVELOPMENT.md.

### One module per file

A build may have two `.es` entries, and a value has to pass between them. Two bundles would hold two copies of the
runtime and two Type keys. A Choice built by one would go unrecognised in the other's `match`. Served per file,
the whole app has one module per path, one prelude and one runtime.

This rests on the Rewriter's host target, `EmitTarget`. Under it a file's emitted text depends on the file and the
project root, never on which entry was compiled. One served Module imports another by a specifier relative to that
root, so every entry resolves it to the same module. `createCompiler` therefore takes the root from the bundler's
configuration and canonicalises it, and never derives it from a path being compiled. A second entry that shares a
graph compiles it again and emits the same text for every shared file.

Under the host target the prelude holds the whole standard library, so its text depends on the compiler alone. One id,
`PRELUDE_ID`, serves it to the whole build.

### The raw door

A served Module's emitted JavaScript is reached by an id made of `RAW_SCHEME` and its path. The wrapper imports the
entry's Module by it, and a sibling import resolves to it. The id names no file: the emitted JavaScript exists nowhere
on disk, and a bundler that read the path would find Essence source. The scheme keeps it apart from every other
specifier, as the bundler's `essence:` Modules are. A `?raw` import of a `.es` file gets Essence's own values
under the names the Rewriter emitted. The `bundle` view of the declarations describes them.

### The wrapper

`wrapperFor` writes the module a build imports. It holds the entry's emitted Module behind the raw door, the
interpreter, and the Descriptor that says how one reads the other. Everything the compiler knew about the boundary is
in that JSON, so a browser marshals without a compiler. It runs the boundary `loadModule` runs, with the compiler's
half spent at build time.

The wrapper imports the runtime by the package specifier the served Modules use, and the host resolves both to one
module. So the Type key the interpreter stamps on values is the key the Module's own Functions read. The interpreter
is imported by its package name too, `@essence-lang/client/marshal-runtime`, and the host resolves it. A copy the
plugin resolved itself would bring a second `EssenceRational`, whose values the first copy's `instanceof` refuses.

The bridge imports only the runtime files the boundary needs, as `runtimeBridgeModules` lists them. It asks the
questions the bridge injected into a `loadModule` bundle asks. A Module whose boundary names no Dictionary brings no
Dictionary store into the build. One that names no asynchronous work brings none of `Future.ts`. The question
covers the declared Types as well as the exports. A Dictionary that appears only in an exported `type` still needs its
door, for a host that marshals against that Type.

The wrapper reads each export when it is evaluated, not on first use. A module's exports are bindings, and JavaScript
has no lazy `export const`. So a constant with no mapping refuses the whole Module rather than one export. In a build
that is the better failure: the alternative is a page that renders and then throws somewhere else. It also makes a
marshalled constant one object for the whole build. `loadModule` builds a fresh value on each read (`defineConstant`),
so a List a host pushes onto there changes nothing for another reader. The README states the difference under "In a
bundler".

Every export is bound to a local named `$export_` and its mangled name, and exported under an alias. The wrapper has
names of its own, such as `bind`, `$raw`, `$module` and one `$runtime_` alias per runtime file. An `export const` of a
Module's own name could collide with one of them and break the host's build at a line no source has. The alias form
also spells a name such as `ok?`, so every export takes it. The `$runtime_` and `$export_` prefixes keep the two sets
apart, and `mangled` maps no two names to one.

`diagnostics: "minimal"` blanks every `shown` in the embedded Descriptor. `shown` is the Type as the compiler printed
it, which a refusal names. It is most of a Descriptor's bytes and decides nothing, so values cross the same either
way. `withoutShown` walks the Descriptor by kind rather than blanking every key called `shown`. A Record member, a
payload member, a Namespace member or an export may itself be called `shown`. Blanking it by name would leave an empty
string where a Descriptor belongs, and the interpreter would build that member as nothing.

### Stale compiles

`createCompiler` makes one compiler per build. It remembers emitted text: a module per `.es` file and the prelude they
share. A dev server outlives edits, so the host's watcher tells it which file changed through `invalidate`. Given a
file, it forgets only what was compiled from a graph that read the file. An app with several entries then recompiles
only what an edit can change. Given nothing, it forgets everything, as a rebuild in watch mode must, since it names no
file.

Time is a count of invalidations, not a clock. Each compile records the count it started at, and it is stale once any
source it read is invalidated after that. A compile that started before an edit read the old sources, however long it
ran. It can not be stopped, so it finishes, but nothing it emitted is remembered. `compile` awaits it, finds it stale
and compiles again.

A compile is held as a promise, so a wrapper and its raw door asked for together wait on one compile. A compile that
failed is dropped at once, since the next request may find the sources fixed.

### Watch files under Vite

Every source a served module was compiled from is a watch file of it. Vite turns a watch file into an edge of its
module graph. An edit then travels from the changed file through the modules that import it, along the Essence
imports, up to the nearest module that accepts. The plugin only names the files and forgets what an edit made stale
through `invalidate`. A dev server names the changed file, and a rebuild names none.

The plugin names the files in `load` and again in `transform`. Vite records the files `load` names against the
module's node, and a module nobody has imported yet has no node until its load returns. A module requested straight
away, as a test or a second tab does, can lose them. An edit to its sources then never reaches it, and the stale text
is served again. Whether that happens depends on a race with the analysis of the importer that would have created the
node. By `transform` the node exists, so the edge is drawn either way. The `load` call stays, because it is also what
puts the file under the real watcher.

### Under Bun

`essenceBun` serves two hosts. Under `Bun.build` it is a bundler plugin like the esbuild one. Under the runtime,
`Bun.plugin` registers it once for the process. Every later `.es` import is then compiled when it is asked for, in a
script, under `bun test` and under `bun --hot`. A `preload` in `bunfig.toml` registers it before the entry runs.

The two hosts offer specifiers differently. The bundler follows esbuild: a resolver sees the specifier as written and
the namespace of the module that wrote it. The runtime offers a specifier spelled `scheme:rest` to the resolvers
registered for that scheme as their namespace, with the scheme taken off. It offers a specifier with no `.` and no
`:`, such as a package name, to no plugin at all. So each resolver is registered once with no namespace, for the
bundler and for files under the runtime. It is registered once more under its scheme, for served modules under the
runtime. `withScheme` reads a specifier with the scheme on or off.

The packages every served module imports by name, the runtime and the interpreter, go through no hook. The plugin
resolves them from the root and writes the resolved files into the served text. A served module has no `resolveDir`
under Bun, so a bare import would resolve from the `.es` file's own directory. That fails for a source reached
through `../`.

A served Module's path is its raw specifier rather than the file's path in a namespace of its own. `Bun.build` tells
modules apart by path alone. A Module served under the file's path would be taken for the wrapper already loaded
there, and the wrapper would import itself. For the same reason the wrapper's load hook names the `file` namespace,
since a `Bun.build` load hook without one answers for every namespace.

`bun --hot` reloads a module when a file Bun read changes. Bun never reads a `.es` file, since the plugin does, so
nothing served would reload. Under the runtime every served module therefore also imports the source of every file of
its graph as text. The `?source` query keeps those imports away from the plugin's own hooks, and Bun watches the files
it read. An edit to one reloads every module of the graph that reaches it, the wrapper included, and every importer of
the wrapper. The process keeps one runtime and one Type key, so a value from before the reload is a value after it.
`bun --watch` restarts the process on the same edits. A `Bun.build` bundle gets no such imports, since a build is one
pass with no watcher.

The runtime has no `onStart` and no hook that reports a changed file, so the plugin checks for itself. It remembers
every source it served by size and time. Each load first asks the filesystem which of them moved, and invalidates
those. Under `Bun.build` the same check finds nothing moved, at the cost of a `stat` per source.

## Declaration files

`generateDeclarations` in `dts.ts` prints a Module as TypeScript from the Descriptor the interpreter marshals by.
Every rule a value crosses by is written once, on the compiler's side, and a declaration file reads it in the other
language.

There are two views, because a bundler serves two doors into one Module. The wrapper hands over JavaScript, which the
`javascript` view declares. Behind it, `?raw` serves the emitted Module itself, which the `bundle` view declares. A
generated file has to describe the module it stands beside, so the view follows from the door.

The `bundle` view declares only what the emitted Module binds. Types, Choices and Protocols are erased before anything
is emitted, and an Overload set binds each Overload under a name of its own. Every value there is an opaque
`EssenceValue`, declared in the file itself rather than imported, so the file needs nothing from this package. A
Namespace member is declared under its emitted name, since a member called `prototype` or `constructor` is bound under
a mangled one.

### Directions

A position's Type depends on which way a value crosses it: in, as an Argument, or out, as a constant or an answer.
Coming out, a value says what it is. Going in, it has to be built against what the Module declared. So what the
interpreter can not build, such as a Type Parameter, is `never` on the way in and ordinary on the way out.
`inputRefusal` prints that `never` with the interpreter's own sentence beside it. A call the interpreter would refuse
then fails to typecheck instead.

The direction travels down through everything a position holds, and a Function turns it around. A Function coming out
is called by the host, so its Parameters go in and its answer comes out. A callback going in is called by the Module,
so its Parameters come out and its answer goes in. Either way it is wrapped to marshal around its calls, so the
printed signature is the one its holder really calls.

The in-form is wider where an Integer is reachable without a Function in the way. An Integer is the one leaf the
interpreter takes more of than it gives back. `widensOnInput` finds such a Type, and a named one is printed as
`Input<Name>` at a Parameter. A Record member the callee fills in with a default may be left out going in. It is
always there coming out, so it carries `?` only in the in-form.

### Naming

A Type the Module exports under a name of its own is looked up by `shown`, the Type as the compiler printed it. That
is the one identity that survives a Descriptor being written down. Two Types that print alike are one Type to
TypeScript anyway, since it compares by shape. Printing the name makes a generated file read like its source.

A Type Alias is declared once, in its out-form. `crossesDifferently` decides whether a Parameter may still go by the
name. Where the two directions print differently, the shape is spelled out at the Parameter instead. A callback
member, a nested `Optional` and a member with a default all differ. The difference then lands on the member it belongs
to. Refusals are asked before the names, so an alias for a callback is refused where it is passed in.

### Unions and Cases

An `Optional` is spelled by absence: `#Value` is its item and `#Empty` is `undefined`. A Union's arms print in
declaration order without duplicates, so `Optional<Integer> | Integer` is one `bigint`. An `Optional` inside a Union
adds its item and one `undefined`, however deep it sits.

A Union that puts two bare Cases, or a bare Case and a String, in one position prints as `never` with the reason.
TypeScript would read `"Up" | string` as `string`, a position the interpreter refuses entirely. The refusal stands
inline where the mistake is, since such a Union may be a Record member or a callback's answer.
`OVERLOADED_NOTICE` precedes its declaration instead, because an Overload set is refused as a whole export.

Every other Case carries `$case`: the Choice as declared, and the Case's name. A Case of a unit Choice prints as the
string literal of its bare name in both directions. The boundary also takes the qualified `"Direction#Up"` going in,
but a declaration states the one spelling a caller should write.

A Choice is declared twice under one name: the Type a value has, and the object its Cases are spelled through. A host
writes `Shape.Circle({ radius: 3n })` and annotates it `Shape`. A Case constructor is a spelling: `caseConstructors`
copies the payload with the tag added and marshals nothing. So its declaration is generic, taking any payload the
boundary accepts and answering that payload with the tag. `Shape.Circle({ radius: 3 })` is then an `Input<Shape>`,
since it holds a number until it crosses. The Type Parameter is named `Payload_`, and no Essence name holds an
underscore, so it shadows nothing. Only a bare Case is `readonly`. The table is frozen either way, but a bare string
is the one member a reader might take for a slot rather than a name.

A Namespace leaves out a Case whose name it also declares, because `bindNamespace` lets the Namespace's own member
replace the constructor.

### Work

Work crosses only as a call's answer. `printAnswer` prints a `Future<T>` there as `Promise<T>`, and `printBody` prints
work anywhere else as `never` with the reason. A `Started<T>` comes out as a promise too, but has no way in: a host
callback has nothing to start the Module's work with. A callback that answers a Future is declared to answer
`Promise<T>`, not `Promise<T> | T`, although the boundary takes either.

### Parameters

TypeScript allows `?` only on a trailing run of Parameters. Essence lets a Parameter with a default stand before a
required one when labels tell them apart. There the positional declaration keeps the Parameter required, as
`T | undefined`, which a positional JavaScript call has to pass. The labelled form marks it optional. It is declared
exactly where `labelsOf` lets the interpreter answer a labelled call.

A Parameter is named by its label. A `_` Parameter has none, and a label TypeScript would misread, such as `first?`,
is no better. Both fall back to `p` and the position, prefixed with `_` until no other Parameter has that name.

## The interpreter

`marshal-runtime.ts` is the run-time half of the boundary: every conversion, refusal and call, over Descriptors rather
than Types. A bundler ships it to a browser, so it must not reach the compiler. Its imports that lead to compiler
files are `import type`, which is erased, and `descriptor.spec.ts` checks every specifier the bundled file reaches.
Beside `errors.ts` and `rational.ts`, its one value import is `bare-cases.ts`. That file holds a rule, imports
`./descriptor` for types alone, and is shared with `dts.ts` so the two never disagree.

### Two directions

The two directions are not mirror images. Coming out, a value says what it is. Every Essence value but a Function
carries its Type on the bundle's Type key, and `toJS` reads that tag. A Function carries nothing, so the Descriptor
its position declared travels beside it, through Record members and List items. Where that Descriptor names exactly
one signature, the Function crosses as a callable that marshals around its calls.

Going in, a JavaScript value says nothing. `7` could be an Integer, a Rational, an `Optional<Integer>` or one arm of a
Union. What the Module declared decides, so the way in is built from the Descriptor. A Function goes both ways, and
its directions turn around inside it. A callback the Module calls is handed values crossing out, and answers with one
crossing in. So each direction reaches the other, and every rule is written once for both.

### Compiled rules

Every Descriptor is fixed when the Module is built. Each question the interpreter asks of a shape has one answer for
the life of a binding. `compileIn` and `compileOut` ask them once per Descriptor node and keep the closure that
answers, in a `WeakMap` keyed by the node. A call runs closures and touches no Descriptor. A Descriptor nobody holds
any more takes its closures with it. A Descriptor is a tree, since `describe` answers a Type that reaches itself with
a `refused` node. Compiling a node's children while compiling the node therefore terminates.

An answer has a table of its own. A Future is work everywhere else and a `Promise` as an answer, and one Descriptor
node can stand in both positions through a Type Alias. One table would hand both positions whichever rule was compiled
first.

### Values from the bundle

The Type key every tag is read through, and every constructor a value is built by, come from the bundle through the
bridge. A value built any other way carries a Symbol the Module has never seen, and every Method it reaches would find
it untyped. `createInterpreter` reads them off the bridge once. They are the runtime's own Functions rather than
Methods, so they call the same when held apart from the bridge.

A value the way in builds fits its Descriptor by construction. Each member is built against the member's own
Descriptor, and each Union arm is the arm that took the value. So the runtime's `isValueOfType` is not asked
afterwards. It would need a Type whose Case identities are the compiling machine's canonical paths, while the values
carry entry-relative tags. Translating one into the other would be a second copy of the rule `emittedIdentity` states.

A Record or a payload Case the interpreter builds is tagged in place. The bridge's constructor would copy it into a
second object. The result has the runtime's own shape, with the members and the Type key on one object, as the
Rewriter writes a static construction. Only objects the interpreter made itself are tagged this way, and a host is
still handed the copying constructors.

A Case payload default is the one value built from nothing a host handed over. A Case is built where it is written,
and no callee stands between the host's object and the Case to fill a default in. `buildFill` builds it once, when the
reader is compiled, and every value that leaves the member out shares it, since Essence values are immutable.

The Dictionary and Future doors of the bridge exist only where the boundary names a Dictionary or work, as
`runtimeBridgeModules` decides. Where one is missing, a Descriptor that names it comes from another compile. The shape
then compiles to a refusal that says so, such as `noDictionaryDoor`. A Record coming out can also carry a Dictionary
in a member its position never declared, which meets the same refusal.

### Bare Case names

Whether a Case crosses as a bare string is a fact about its Choice, and a value carries nothing that says so. A
declared position knows it, but `toJS` with nothing declared does not. `bareCaseNames` reads every unit Choice Case
the Module names, once, so `toJS` answers the same string either way and a host can hand it back. The table is
complete for what a host can reach, since a value leaves only through an export, and an export names its Type. That is
why an interpreter requires the Module.

### List boxes

`ListBox` is the only place this package knows the runtime's List layout, and `packages/runtime/src/List.ts` is the
authority. A List is two runs with a view into each: the back run stored forward in `value`, and the front run stored
reversed in `front`. The runs are shared between the boxes of one chain, and each box says how much of each run is its
own. An absent `length` means the back view is the whole Array, and an absent `front` means the box never prepended.
Reading `value` alone answers neither the right items nor the right number of them.

The interpreter reads a box and never writes it. The runtime's `materialise` leaves the combined Array on the box for
the natives to read again. The interpreter reads it once and hands JavaScript an Array of its own. Handing over the
box's Array would let a host edit a value the Module still holds.

A positional write changes the back run in place and counts a version up, which leaves the run's other boxes behind.
`packages/runtime/src/listWrites.ts` is the authority. A box's `writes` holds the log of what each write overwrote,
and the version this box views. `backRunSeenBy` undoes the writes made since, into a copy of the box's own view. It
repeats the runtime's `caughtUp` rather than importing it, because `caughtUp` writes the replayed run back onto the
box. The runtime repairs such a box wherever it reads one. `tests/undoReplay.spec.ts` holds this copy and the one in
`tools/bench.ts` against the runtime's own.

### List loops

`runIn` picks the loop a List's items are read by from the item's kind, once, where the List is compiled. A loop that
calls a converter it is handed can not see what it calls. Every List would reach the same loop, whose one call site
sees Integers, Strings and whole Lists in turn. The engine then makes an out-of-line call per item, and decides
differently from run to run. So an Integer, a String and a Boolean each have a loop of their own. Their admission is
written there as well as in the branch of `buildIn` that compiles the leaf alone. The two spellings are one rule: a
value inside a List is the same value met alone, so a difference between them is a bug. A Rational goes through the
general loop, because its admission outweighs the call. `BENCH.md` has the measurement.

A hole in an Array is read as the `undefined` it holds, and admitted only where the item's shape admits absence.
`[1, , 3]` is refused where the items are Integers. It crosses with `#Empty` in the middle where they are
`Optional<Integer>`.

### Reading a Union

A Union reads a JavaScript value by trying its arms in declaration order, and the first arm that admits the value
takes it. Overlapping arms are therefore decided rather than ambiguous. `Optional<String> | Integer` reads `"7"` as a
String, because its `Optional<String>` arm comes first.

Two shapes are refused before any arm is compiled, since an arm that took the value would already have decided. An
`Optional` inside an `Optional` would spell `#Value(#Empty)` and `#Empty` both as `undefined`. Inside a Union, a later
arm could take the `undefined` an earlier one refused. A Union whose arms collide as bare Cases has nothing to decide
with, as "Bare Cases" describes.

Three shortcuts change no answer. `familiesOf` lists the JavaScript kinds each arm could take, and an arm that rules
out the value's kind is skipped. An arm refuses by throwing, and a thrown Error captures a stack, so failing arms
would otherwise dominate a large call. A skipped arm never recognised the value, so it could neither have taken it nor
given the refusal worth reporting. A Union of bare Cases alone reads a string from a table built when the reader is
compiled, under both spellings of each Case. An object whose `$case` names an arm goes to that arm alone, whose
refusal is the one the search would report. A miss in either table falls through to the arms.

When every arm refuses, the refusal reported is the one from the arm that got inside the value, if exactly one did.
`reachedInside` says so when the failure's path is deeper than the value's, or when the failure is marked `inside`. A
Case whose `$case` matched but whose payload is wrong refuses at the value itself, and marks itself. So a misspelled
payload member is named, as a Record's would be, rather than reported as the whole Choice. Otherwise the Union's own
refusal names the whole Type.

An `Optional` is that Union with its arms run through. Absence, `undefined` or `null`, is `#Empty`, and anything else
is `#Value`. `null` is admitted because JSON has only that one, and `undefined` is what comes back out. `#Empty` never
reaches inside a value, so a refusal from inside the `#Value` arm is the one reported.

### Callbacks

`buildCallbackIn` turns a JavaScript Function into an Essence one. It mirrors `wrapFunction`, and it is the one place
the boundary is crossed by a call the Module makes. The Module hands the callback its own values, which cross out. The
callback's answer is built against the declared return, and crosses in.

The Module calls a callback by position, never by label. Labels are how Essence writes its calls. A JavaScript
Function takes its Arguments in order, and the package invents no calling convention for code it did not write. For
the same reason, a callback that answers work is not handed the run's context. A host that wants to be stopped closes
over an `AbortController` of its own.

A refusal inside a callback is spelled from where the callback arrived, as in `argument 2 → return value`, since that
names the Function the host passed. The path is spelled once, when the callback arrives. A callback that answers work
meets the Future door's check on arrival too, while a host can still be told.

A callback declared `-> Future<T>` is how work crosses into a Module. The host writes an ordinary Function answering a
`Promise`, and the Module gets a Future. A Future is a description, so the host is called at every start and no
sooner. A host's `(url) => fetch(url)` handed to such a Parameter makes no request until started, and `::attempt(times
3)` over it makes three. The Arguments cross when the Module calls the callback, rather than when the work starts.
They belong to the moment the Module built the Future. A `Started` answer has no door, since a host can not start a
run of the Module's own work. It meets the refusal in `buildIn`.

### The way out

The way out is not the mirror of the way in. A value coming out says what it is, so a compiled reader only checks the
tag against the shape its position declared. Where the two agree, nothing inside the value needs deciding. Otherwise,
as for a value from an arm the Descriptor did not name, the reader hands the value to the general walk, `toJS`. The
compiled reader is an optimisation of that walk, not a second reading.

An Integer always comes out as a bigint. The runtime holds an Integer as a number while it fits one and as a bigint
beyond. Passing that split on would make the Type a host receives depend on the size of the answer.

An `Optional` is transparent: its Case does not appear in the answer, and the path gains no segment for it. A lone
`Optional` Case, as an unannotated constant infers it, goes to the walk that owns absence. `collectCases` leaves a
Union's `Optional` arms to that walk in the same way.

For a Union, the reader compiles the choosing: one reader per Case the Union offers, under the tag its values carry.
Every other arm goes through the general walk. A Union the way in refuses for colliding bare Cases is refused going
out too. A host is never handed a value it could not hand back.

A Function is the one untagged value, so only the Descriptor of its position says what a call to it means.

### Work crossing out

`buildAnswerOut` is the only place the boundary starts anything. A call's answer that is a Future is started there,
once per call, since a Future describes work and two calls are two runs. Each run belongs to a root context of its
own, which the host's signal aborts where the binding has one. The Rewriter likewise emits a fresh root per
site at a Program's top level.

A Started is already in flight and is not started again: what crosses is the promise it holds. The host's signal is
not linked to it, and an aborted host signal does not decline it. A run belongs to whoever started it and may be
awaited from anywhere, so one holder's stop must not stop the work others wait for. `Started::within` states the same
rule inside the language.

A Future answered after the host's signal was aborted is not started at all. The host receives a promise that never
settles, as a stopped run answers nothing.

The value inside is marshalled when it arrives, so its refusal is a rejected promise rather than a throw at the call.
The promise adds no path segment, as an `Optional` adds none.

`rootContext` takes its listener off the host's signal when the run is over. The signal lives as long as the host, and
a listener per call would outlive each call. The runtime's `childOf` keeps the same bookkeeping. A signal that is
already aborted aborts the context before anything runs under it.

A mid-run abort is cooperative. Work suspended in a native that reads the signal stops there and answers nothing. Such
natives are `Async.sleep` and `Http.send`, and `::within` and `::race` over either. Work already running continues to
its end and answers, since nothing between two Statements reads a signal.
