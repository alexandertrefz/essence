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
[In a bundler](#in-a-bundler).

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

A constant is marshalled when it is read, not when the Module is loaded, so an
export the boundary has no mapping for — the numeric tower above `Rational`,
today — throws where it is read instead of taking the whole Module with it.
Each read builds a fresh value, exactly as `marshaller.toJS(raw.…)` does.

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
export declare function square(p0: bigint): bigint
```

A Type Alias is declared under the name it was written with and referred to by
it everywhere else, a Choice becomes the union of its Cases, and `Optional<T>`
is `T | undefined`. A Parameter is named by its label; a `_` Parameter by its
position.

What the boundary cannot carry is declared `never` rather than spelled out,
because a declaration is only worth having if the calls it admits are the calls
that work. An overloaded Method is `never` — which Overload a call means is
decided by the Argument Types, which a JavaScript value does not carry. So is a
callback Parameter, so is a nested `Optional` — both of its levels would be
`undefined` — and so is a Type Parameter in an input position: a Type
Parameter is a shape that has not been decided yet, and a value going *in* has
to be built against a shape. A named Type whose members hit one of
these refusals going in is spelled out at that Parameter, with the `never` on
the member that is the mistake. Each refusal is declared in the words the
boundary would have thrown, so what a reader is shown and what a caller would
have been told are one sentence.

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

What the import resolves to is a generated wrapper: it imports the emitted
bundle — the whole Essence graph and the runtime it needs, already bundled, so
the host bundler has nothing left to resolve — imports the interpreter from
`@essence-lang/client/marshal-runtime`, and carries the **Descriptor** the
compiler wrote for that Module. Everything the compiler had to know about the
boundary was decided at build time and written down; what ships is the reading
of it. No compiler reaches the browser.

Because the interpreter is imported by name, the host bundler resolves it —
this package is already a dependency of any project that uses the plugin, and
one copy of it is what keeps one `EssenceRational` in the build.

`diagnostics: "minimal"` strips the printed Types out of the embedded
Descriptor. The boundary decides exactly the same way; its refusals stop naming
the Type they refused.

**One `.es` entry per build.** Each entry compiles to its own standalone
bundle, with its own copy of the runtime and its own hidden Type key — minted
while that bundle was evaluated — so a value built by one is not recognised by
the other, and a `match` on it would take the wrong Case rather than fail.
Importing two `.es` files that reach a common source is therefore refused with
an `EssenceBuildError`: import one entry and reach the rest of the graph
through it, or load the second with `loadModule`, which marshals to plain
JavaScript at every boundary. Two entries that share no source at all are two
unrelated Programs and are left alone.

While a dev server is serving, a `<Name>.d.es.ts` is written beside each
compiled file — the `javascript` view, which is what the import resolves to,
and where TypeScript looks for the declarations of a `.es` import under
`allowArbitraryExtensions`. `declarations` turns it on in a build or off in a
server.

### `?raw`

The raw door, in a build: `?raw` serves the emitted bundle itself,
unmarshalled — Essence's own values, under the names the Rewriter emitted them
as, and the bridge that builds values they accept.

```js
import { square, $bridge_integer, $bridge_typeKey } from "./math/Math.es?raw"

let squared = square($bridge_integer(12n))

squared[$bridge_typeKey] // "Integer"
```

It is the same bundle the marshalled door is a wrapper around — one copy in the
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
`$bridge_integer(1.5)` and `$bridge_integer(2 ** 53)` throw rather than tag a
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

## What this does not do yet

- **Callbacks.** A Function comes out of a Module callable — wrapped against
  the Type its position declared — but one can not be passed *in*. `fromJS`
  against a Function Type says so.
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
- **More than one `.es` entry per bundler build.** See above — the two bundles
  would not recognise each other's values.
- **Compiling in a browser.** The compiler reads files and shells out to
  esbuild. What a browser can run is the *output* — which is what the bundler
  plugins are for.
- **Checked refinements.** A refined Type marshals as its base, unproven. The
  predicate belongs at the boundary, and will run there once refinements land.
