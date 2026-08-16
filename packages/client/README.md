# @essence-lang/client

Load [Essence](https://github.com/alexandertrefz/essence) Modules from
JavaScript. One call takes a path to a `.es` file and answers with its
exports, compiled, bundled and imported on the way in.

```js
import { loadModule } from "@essence-lang/client"

let math = await loadModule("./math/Math.es")
```

In somebody else's build it is an ordinary import: the Vite and esbuild plugins
serve a `.es` file as the same marshalled JavaScript — see
[In a bundler](#in-a-bundler). Where the compiling happened at build time
instead, `loadPrebuilt` reads a bundle and the Descriptor beside it with no
compiler in reach at all — see [Prebuilt](#prebuilt).

There is no build step and no artifact to manage. The whole Module graph is
compiled in memory, the bundle is written under the hash of everything it was
compiled from **and by** — every source, the compiler, the standard library,
the runtime — and a second load of unchanged sources reads that file back
without compiling anything, so the Program inside it is evaluated once. An
upgraded toolchain hashes differently and recompiles, which is what keeps a
cache that is never invalidated from serving yesterday's code.

The cache lives in the platform's own cache directory: `$XDG_CACHE_HOME/essence/client`
where that is set, `~/Library/Caches/essence/client` on macOS,
`%LOCALAPPDATA%\essence\client\Cache` on Windows, and `~/.cache/essence/client`
otherwise. `ESSENCE_CLIENT_CACHE` moves it, and `loadModule`'s `cacheDirectory`
option overrides both — for a host that wants its compiled bundles to travel
with its own build output.

Source that does not compile throws an `EssenceCompileError` whose message is
the report `esc` prints: the excerpt, the underline, the Notes and the Helps,
one block per file.

## Values

`exports` holds the Module as ordinary JavaScript: constants as values,
Functions as Functions, Namespaces as objects of the same.

```js
let math = await loadModule("./math/Math.es")

math.exports.PI.toString() // "157/50"
math.exports.square(12n) // 144n
```

| Essence           | JavaScript                            |
| ----------------- | ------------------------------------- |
| `Integer`         | `bigint` out; `bigint` or a safe `number` in |
| `Rational`        | `EssenceRational`                     |
| `String`          | `string`, normalised to NFC on the way in |
| `Boolean`         | `boolean`                             |
| `List<T>`         | `Array`                               |
| `{ a: T }`        | a plain object, closed — an undeclared key is refused |
| `Optional<T>`     | `T` or `undefined`                    |
| a Case of a Choice | `{ $case: "Choice#Case", ...payload }` |
| a Case of a Choice with no payloads at all | the bare Case name, `"Up"` |

The mapping loses nothing in either direction. There is no JavaScript number
for `1/3`, so a `Rational` crosses as its two `bigint` parts; a `number` handed
back to one is read for the value it actually holds, so `0.1` becomes
`3602879701896397/36028797018963968` rather than `1/10`. An `Integer` goes out
as a `bigint` at every size — one kind out, so a call's Type does not depend on
how big its answer happened to be — and comes in as either a `bigint` or a
`number` that is exactly an integer a double holds, `2 ** 53` being refused
rather than accepted already wrong. Where there is no
lossless spelling at all the value is refused rather than approximated: an
`Optional` inside an `Optional` would be `undefined` at both levels, and
`#Value(#Empty)` is not `#Empty`.

`Optional` is the one Choice spelled by ABSENCE rather than by a `$case`, and
that holds however its Type was written down. An unannotated
`constant present = #Value(3)` has one of `Optional`'s Cases alone for a Type
rather than the Union an annotation would have named, and still crosses as
`3n` — the last two rows of the table are every other Choice.

A constant is marshalled when it is read, not when the Module is loaded, so an
export the boundary has no mapping for — the numeric tower above `Rational`,
today — throws where it is read instead of taking the whole Module with it.
Each read builds a fresh value, exactly as `marshaller.toJS(raw.…)` does. Both
of those are `loadModule`'s; a bundler's wrapper reads once instead, and
[`In a bundler`](#in-a-bundler) says what that changes.

Which direction a value is going decides how it is read. Coming out, a value
says what it is — every Essence value but a Function carries its Type — so
nothing has to be told. The Function is the exception: it carries nothing, so
the Type its position declared is what it crosses as — the answer of a call
and a Record member alike come back as JavaScript Functions that marshal
around their calls. Going in, `7` could be an `Integer`, a `Rational` or an
`Optional<Integer>`, so the Type the Module declared is what decides, read off
`surface`. A value that does not fit throws an `EssenceMarshalError` naming the
Type, the value, and where inside it the two parted ways.

```
argument 1 → [1].height: expected Integer, got the string "four".
```

## Calls

A call is marshalled on both sides: the Arguments against the Parameter Types
the Module declared, the answer against whatever comes back.

Essence writes a label at every call site, so a Function whose Parameters all
carry one may be called either way — with the Arguments in order, or with a
single object whose keys are exactly the labels.

```js
let geometry = await loadModule("./Geometry.es")

geometry.exports.Rectangle.of(3n, 4n) // { width: 3n, height: 4n }
geometry.exports.Rectangle.of({ width: 3n, height: 4n }) // the same call
```

A Function of one Parameter a Record can inhabit — the Record itself, or a
Union or `Optional` with one among its arms — is positional whatever its label
says. Both readings take an object, and the Record is the one that can hold
any shape, so `describe({ width: 3n, height: 4n })` passes the Rectangle.

A Namespace comes back as an object of its Methods. There is no `::` on this
side, so an instance Method takes its receiver where a call passes it, first.

```js
geometry.exports.RectangleMeasurable.area({ width: 3n, height: 4n }) // 12n
```

A call the signature does not admit — the wrong number of Arguments, an object
whose keys are not the labels — throws an `EssenceCallError` naming the
signature and both ways of writing it. An overloaded Method throws one too:
which Overload a call means is decided by the Argument Types, and a JavaScript
value carries none, so each Overload is reached by its own name on `raw`.

## Choices

A Case crosses as `{ $case: "Choice#Case", ...payload }`, unless its Choice
carries no payloads at all — which is
[a spelling of its own](#choices-with-no-payloads). Either way the Module hands
back a way to write one: every exported Choice is a value as well as a Type,
holding one constructor per Case.

```js
let shapes = await loadModule("./Shapes.es")
let { Shape, areaOf } = shapes.exports

areaOf(Shape.Circle({ radius: 3n })) // 9n
areaOf(Shape.Blank) // 0n
```

A Case with a payload is a Function of it; a Case without one is the value
itself, since there is nothing to pass. What comes back is the plain object the
boundary already accepts — nothing is marshalled or checked there, so a
constructor is a *spelling* and every refusal still happens once, at the
crossing, with the path and the Type to say it in.

Where the Module also writes `namespace Shape for Shape` — which is how a
Choice is given its Methods — the constructors are members of that Namespace
instead: one name binds one thing, and `Shape.Circle(…)` beside `Shape.area(…)`
is the object a reader expects either way. A Method or a static constant of a
Case's name wins, because the Module really does bind that one.

### Choices with no payloads

A Choice all of whose Cases are payload-less — `choice Direction { Up, Down }`,
the standard library's `Ordering` — crosses as the **bare Case name** instead,
in both directions. There is nothing for a `$case` object to carry that the
name does not, and `turn("Up")` is what a JavaScript caller wanted to write.

```js
let compass = await loadModule("./Compass.es")
let { Direction, turn } = compass.exports

turn("Up") // the string itself
turn(Direction.Up) // the same call — the constructor IS the string "Up"
turn("Direction#Up") // accepted too, for a host that already had the tag
```

The name is verbatim: `"Up"`, never `"up"`, and never a casing of this
package's choosing. It is all or nothing per Choice — one payload anywhere and
every Case of that Choice keeps the object form, its payload-less ones
included — and `Optional` is untouched, being spelled by absence already.

Two shapes the object form keeps apart can collide here, because a bare string
is what a `String` is too. Within one Union — read through nested Unions, and
through an `Optional`, which puts its item in the same position — a payload-less
Case beside a `String`, or beside a Case of the **same name** from another
Choice, is a position with no unambiguous JavaScript spelling. The boundary
refuses it rather than deciding it: deciding it would mean a String `"Up"`
handed in coming back out as a `Direction`, and losing a value is the one thing
this boundary may not do.

```
argument 1: 'Direction | String' has no unambiguous JavaScript spelling — a
Direction#Up crosses as the string "Up", which a String is too. Wrap one side
in a Record or give the Case a payload.
```

The Module still loads and every other export still works — only that position
throws, and only when a value crosses it. The refusal is per Case **name**, so
`Direction | Sign` sharing none is spelled out as usual, and per payload-less
Case, so `Direction | Shape` is fine as well: a `Shape` crosses as an object,
which no string is.

## Callbacks

A Function goes in as well as out. Where a Parameter — or a member, or a list
item — declares one, a JavaScript Function is accepted there and the Module
calls it.

```js
let calls = await loadModule("./Calls.es")

calls.exports.applied(3n, (value) => value * 2n) // 6n
```

Its own two directions are the reverse of the way it crossed: the Module hands
a callback *its* values, which come **out**, and whatever the callback answers
with is built against the declared return, so it goes **in**. Everything the
mapping table says applies at both ends of that call, and a refusal inside one
is spelled from where the callback arrived — the Function to go and fix is the
one that was passed there.

```
argument 2 → return value: expected Integer, got the string "twice".
```

A callback is called positionally, whatever labels its declared signature
carries: a JavaScript Function takes its Arguments in order, and this package
does not invent a calling convention for code it did not write. It is called
as many times as the Module calls it — a callback is not a value marshalled
once and remembered.

## Types

`generateDeclarations` turns a Module's Descriptor into a TypeScript
declaration file — the same mapping as the table above, read as Types, printed
off the very object the boundary marshals by.

```ts
import {
	describeModule,
	describeTypes,
	generateDeclarations,
	loadModule,
} from "@essence-lang/client"

let math = await loadModule("./math/Math.es")

generateDeclarations(describeModule(math.surface, math.entryPath), {
	moduleName: "Math.es",
	// NOTE: The Types the Module names. A Descriptor does not carry them —
	// nothing at run time reads a Type Alias — so a declaration file that wants
	// them by name asks for them.
	types: describeTypes(math.surface, math.entryPath),
})
```

```ts
export declare const PI: EssenceRational
export declare function square(p0: bigint | number): bigint
```

A Type Alias is declared under the name it was written with and referred to by
it everywhere else, a Choice becomes the union of its Cases — of their bare
names, where the Choice carries no payloads — and `Optional<T>` is
`T | undefined`. A Parameter is named by its label; a `_` Parameter by its
position.

The declarations say what the boundary takes as well as what it gives. An
Integer comes *out* as a `bigint` and goes *in* as a `bigint` or a safe
`number`, so a Parameter reads `bigint | number` and an answer reads `bigint`.
A named Type holding an Integer keeps its name at a Parameter, wrapped in the
package's `Input<T>` — a mapped Type that widens exactly the leaves the
interpreter does, so `describe(shape: Input<Rectangle>)` hovers to
`{ width: bigint | number; height: bigint | number }` while `Rectangle` itself
stays what comes back. And a Function whose Parameters are all labelled is
declared twice, because it may be called twice: positionally, and with one
object whose keys are the labels.

```ts
export declare function widen(box: Input<Box>, by: bigint | number): Box
export declare function widen(labelled: { box: Input<Box>; by: bigint | number }): Box
```

A Choice is declared twice under its one name — the Type a value of it *is*,
and the constructors a host spells one *with* — which TypeScript keeps apart by
itself.

```ts
export type Shape =
	| { $case: "Shape#Circle"; radius: bigint }
	| { $case: "Shape#Blank" }

export declare const Shape: {
	Circle<Payload_ extends { radius: bigint | number }>(payload: Payload_): Payload_ & { $case: "Shape#Circle" }
	Blank: { $case: "Shape#Blank" }
}
```

A constructor is a spelling — it writes the tag onto the payload it was handed
and marshals nothing — and its declaration says exactly that: it takes any
payload the boundary would accept and answers *that* payload with the tag on
it, its own Types kept. `Shape.Circle({ radius: 3n })` is a `Shape`;
`Shape.Circle({ radius: 3 })` is an `Input<Shape>`, which is what it holds until
it crosses.

A Choice with no payloads is the string-literal union of its Case names, which
is what an enumeration looks like on this side. Its table is the same two
declarations, holding the strings themselves — so `Direction.Up` typechecks
everywhere `"Up"` does, being the same value.

```ts
export type Direction = "Up" | "Down"

export declare const Direction: { readonly Up: "Up"; readonly Down: "Down" }
export declare function turn(p0: Direction): Direction
```

What the boundary cannot carry is declared `never` rather than spelled out,
because a declaration is only worth having if the calls it admits are the calls
that work. An overloaded Method is `never` — which Overload a call means is
decided by the Argument Types, which a JavaScript value does not carry. So is a
nested `Optional` — both of its levels would be `undefined` — and so is a Type
Parameter in an input position: a Type Parameter is a shape that has not been
decided yet, and a value going *in* has to be built against a shape. So is a
Union a bare Case name has no unambiguous spelling in — beside a `String`, or
beside another Choice's Case of the same name — where TypeScript reads
`"Up" | string` as `string`, and printing the arms honestly would promise a
Parameter taking any string at all while the boundary refuses every value
there. A named Type whose members read differently going in — a refusal among
them, or a callback, whose own directions turn around — is spelled out at that
Parameter, with the difference on the member it belongs to. Each refusal is
declared in the words the boundary would have thrown, so what a reader is shown
and what a caller would have been told are one sentence.

```ts
export declare function firstOf(
	p0: Array<never /* ItemType is a Type Parameter — there is no shape to build a value against until it is applied. */>,
): unknown /* ItemType is a Type Parameter — there is no shape to build a value against until it is applied. */ | undefined
```

A generic Function is declared without its Type Parameters. A Descriptor
carries the shapes a value crosses *as*, and a Type Parameter never is one —
declaring `<ItemType>` would promise a caller a Type to apply on a call that
can not be made.

## In a bundler

`essence()` is a Vite plugin and `essenceEsbuild()` an esbuild one. Both compile
an imported `.es` file where the bundler asks for its text, and serve it as
**marshalled JavaScript** — the same values `loadModule` hands over, with no
build step and no artifact to manage.

```js
import { essence } from "@essence-lang/client/vite-plugin"

export default { plugins: [essence()] }
```

```js
import { PI, square } from "./math/Math.es"

square(12n) // 144n
PI.toString() // "157/50"
```

The esbuild shape of the same plugin lives one door over, at
`@essence-lang/client/esbuild-plugin`.

What the import resolves to is a generated wrapper: it imports the entry's
compiled Module, imports the interpreter from
`@essence-lang/client/marshal-runtime`, imports the runtime from
`@essence-lang/runtime`, and carries the **Descriptor** the compiler wrote for
that Module. Everything the compiler had to know about the boundary was decided
at build time and written down; what ships is the reading of it. No compiler
reaches the browser.

Behind the wrapper the graph is served **one file at a time**: each `.es` file
becomes one JavaScript module, importing its siblings, the standard library's
prelude and the runtime by name, and your bundler resolves, shakes and splits
all of it exactly as it does the rest of your code.

Both bare specifiers — the interpreter and the runtime — are resolved by the
host, which is what keeps one copy of each in the build: one `EssenceRational`,
and one hidden Type key for every Essence value the app holds. Both packages
are dependencies of this one, so an installer that hoists puts them within
reach; under a strict layout (pnpm's default), add `@essence-lang/runtime` to
your own dependencies.

`diagnostics: "minimal"` strips the printed Types out of the embedded
Descriptor. The boundary decides exactly the same way; its refusals stop naming
the Type they refused.

**A wrapper's constants are read once, not on every read.** A JavaScript
module's exports are bindings and an emitted Module's are values, so every
constant is marshalled at the wrapper's own evaluation — which is where the two
doors differ from each other. An export the boundary can not map refuses the
whole Module here rather than only itself, which in a build is the better half
of the trade: the alternative is a page that renders and then throws somewhere
else entirely. And a marshalled `List` or Record is **one object shared by every
importer** — a host that pushes onto one changes what every other holder of that
Module sees. Copy it if you mean to change it.

**As many `.es` entries per build as you like.** Every file of every graph is
served under one id, so two entries that reach a common source hold one copy of
it, one prelude and one runtime — and a value built by one entry is recognised
by the other. It rests on how the Modules are emitted: under the plugin's
target the Compiler spells every Module and every Case tag relative to the
project root, so a shared file's JavaScript is the same text whichever entry
compiled it.

While a dev server is serving, a `<Name>.d.es.ts` is written beside each
compiled file — the `javascript` view, which is what the import resolves to,
and where TypeScript looks for the declarations of a `.es` import under
`allowArbitraryExtensions`. `declarations` turns it on in a build or off in a
server.

### `?raw`

The raw door, in a build: `?raw` serves the compiled Module itself,
unmarshalled — Essence's own values, under the names the Rewriter emitted them
as. Build values for it out of `@essence-lang/runtime`, which your build
resolves to the very copy those Modules were compiled against.

```js
import { square } from "./math/Math.es?raw"
import { createInteger } from "@essence-lang/runtime/Integer"
import { typeKeySymbol } from "@essence-lang/runtime/type"

let squared = square(createInteger(12))

squared[typeKeySymbol] // "Integer"
```

It is the same Module the marshalled door is a wrapper around — one copy in the
build, one Type key — so values pass between the two doors freely. Where
declarations are on, the `bundle` view is written beside the source as
`<Name>.raw.d.es.ts`; TypeScript will not resolve a `?raw` specifier itself, so
reach those declarations by name, as `./Math.raw.es`, or declare `*.es?raw` in
your environment file.

## The raw door

`raw` holds every export under the name its author wrote and marshals nothing.
Values there are Essence's own: an Integer is a tagged object holding a
`number` while its value is one a double carries exactly and a `bigint` beyond
that, and the Symbol it is tagged with is minted when the bundle is evaluated,
so the constructors come out of that bundle too, on `bridge`. Those constructors
take the same numbers the marshalled door does and refuse the same ones —
`bridge.integer(1.5)` and `bridge.integer(2 ** 53)` throw rather than tag a
value that is not an Integer. The marshalled
door does not show that split — `toJS` answers a `bigint` for every Integer, so
that an export's Type does not change the day a value crosses 2^53.
`marshaller` is the same boundary `exports` was built through, bound to it.

```js
let math = await loadModule("./math/Math.es")
let { toJS, fromJS } = math.marshaller
let squared = math.surface.values.square

toJS(math.raw.square(fromJS(12n, squared.parameterTypes[0].type))) // 144n
```

## Prebuilt

The third way in, for an application that ships rather than compiles: build the
pair once with `esc`, and load it wherever it lands.

```
esc build App.es -o dist/app.js --embed
```

That writes `dist/app.js` — the bundle, with the runtime's own Type key and
value constructors in it — and `dist/app.descriptor.json` beside it, which is
the boundary between Essence and JavaScript written down.

```js
import { loadPrebuilt } from "@essence-lang/client/prebuilt"

let app = await loadPrebuilt("./dist/app.js")

app.exports.greet("world")
```

`loadPrebuilt` reads that JSON, imports that bundle and binds one to the other.
It looks for the sidecar beside the bundle under the name `esc` wrote it as; a
second argument names one somewhere else. What comes back is `exports`, `raw`,
`bridge`, `interpreter` and the `descriptor` itself — everything `loadModule`
answers with except the two things only a compile can produce, an Export
Surface and a Marshaller over it.

**Nothing on this path reaches the compiler.** `@essence-lang/client/prebuilt`
imports the interpreter and `node:fs`/`node:path`/`node:url` — and no compiler,
which is the whole point of a Descriptor being JSON: the describing happened at build time, and a shipped
application does not need a toolchain installed to talk to the Essence inside
it. Deploy the two files.

Declarations for the pair come from the same Descriptor, so a build that wants
them can call `generateDeclarations` where it has a compiler — during the build,
not during the load.

## What this does not do yet

- **Generics.** A Type Parameter is a shape that has not been decided yet, and
  a value going in has to be built against a shape — so an Argument at a Type
  Parameter position is refused, and only an empty `List` gets through. A
  generic Function is still perfectly callable through `raw`, where nothing is
  marshalled.
- **Overloads.** A JavaScript value carries no Type, so nothing at the boundary
  can decide which Overload a call means. Each Overload is on `raw` under its
  own `name__overload$N`.
- **Nested Optionals.** `Optional<T>` is `T | undefined`, and `undefined` does
  not nest. `Optional<Optional<T>>` is refused in both directions rather than
  collapsed into the one level JavaScript can spell.
- **Compiling in a browser.** The compiler reads files and shells out to
  esbuild. What a browser can run is the *output* — which is what the bundler
  plugins are for.
- **Checked refinements.** A refined Type marshals as its base, unproven. The
  predicate belongs at the boundary, and will run there once refinements land.
