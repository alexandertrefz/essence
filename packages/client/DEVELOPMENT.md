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

A String crosses as a string too, and one Choice's `#Up` is spelled like another's. Where a Union puts two such arms in
one position, the position has no unambiguous JavaScript spelling, and the boundary refuses it. Deciding would turn a
String `"Up"` handed in into a `Direction#Up` coming out, and the boundary must not lose data. Other Union arms are
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

The arms compared are the ones a JavaScript value is decided between. A nested Union is flattened, since its arms stand
in the outer position unchanged. An `Optional` is flattened too, because it is spelled by absence and `undefined`
collides with nothing. It reaches a Descriptor in two shapes. `describeUnion` collapses a Union of exactly its two
Cases into an `optional` node. In a larger Union the two Cases stay apart, the `#Value` carrying a String collides with
`#Up`, and `#Empty` adds nothing.

## Rounding a Rational to a double

`toNumber` in `rational.ts` answers the nearest double, rounded once. When both parts are at most `2 ** 53`, a double
holds each exactly, and one hardware division rounds correctly, as IEEE 754 requires. Larger parts would each be
rounded on conversion, and dividing two roundings can misround the quotient by an ulp.

Past that fast path, `dividedMagnitude` still rounds exactly once:

- The quotient is taken to 64 bits, and a nonzero remainder sets its low bit. Any later rounding to 53 bits or fewer
  then reads this quotient as halfway exactly when the true quotient is halfway.
- Converting that quotient to a double is the one rounding. Scaling it back by a power of two is exact.
- A subnormal answer has fewer significant bits than the conversion keeps, so converting would round twice. When the
  exponent is under -1022, `roundedShift` rounds the quotient to a multiple of `2 ** -1074` in bigint arithmetic, half to
  even. The result converts exactly. A tie it sees is a true tie, since an inexact quotient has its low bit set.

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
interpreter, and the Descriptor that says how one reads the other. Everything the compiler knew about the boundary is in that
JSON, so a browser marshals without a compiler. It runs the boundary `loadModule` runs, with the compiler's half
spent at build time.

The wrapper imports the runtime by the package specifier the served Modules use, and the host resolves both to one
module. So the Type key the interpreter stamps on values is the key the Module's own Functions read. The interpreter is
imported by its package name too, `@essence-lang/client/marshal-runtime`, and the host resolves it. A copy the plugin
resolved itself would bring a second `EssenceRational`, whose values the first copy's `instanceof` refuses.

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
