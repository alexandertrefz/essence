# @essence-lang/client

Load [Essence](https://github.com/alexandertrefz/essence) Modules from
JavaScript. One call takes a path to a `.es` file and answers with its
exports, compiled, bundled and imported on the way in.

```js
import { loadModule } from "@essence-lang/client"

let math = await loadModule("./math/Math.es")
```

There is no build step and no artifact to manage. The whole Module graph is
compiled in memory, the bundle is written under the hash of every source it
was compiled from, and a second load of unchanged sources reuses that file —
so the Program inside it is evaluated once.

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
| `Integer`         | `bigint`                              |
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
`3602879701896397/36028797018963968` rather than `1/10`.

Which direction a value is going decides how it is read. Coming out, a value
says what it is — every Essence value but a Function carries its Type — so
nothing has to be told. Going in, `7` could be an `Integer`, a `Rational` or an
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

A Function of one Record Parameter is positional whatever its label says —
both readings take an object, and a Record is the one that can hold any shape,
so `describe({ width: 3n, height: 4n })` passes the Rectangle.

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

`generateDeclarations` turns a Module's export surface into a TypeScript
declaration file — the same mapping as the table above, read as Types.

```ts
import { generateDeclarations, loadModule } from "@essence-lang/client"

let math = await loadModule("./math/Math.es")

generateDeclarations(math.surface, { moduleName: "Math.es" })
```

```ts
export declare const PI: EssenceRational
export declare function square(p0: bigint): bigint
```

A Type Alias is declared under the name it was written with and referred to by
it everywhere else, a Choice becomes the union of its Cases, `Optional<T>` is
`T | undefined`, and a Type Parameter becomes a TypeScript one wherever it maps
cleanly. A Parameter is named by its label; a `_` Parameter by its position. An
overloaded Method is declared `never`: which Overload a call means is decided by
the Argument Types, so declaring the signatures would typecheck a call that
throws.

## In a bundler

`essence()` is a Vite plugin and `essenceEsbuild()` an esbuild one. Both compile
an imported `.es` file where the bundler asks for its text, and hand back one
standalone Module — the whole Essence graph and the runtime it needs, already
bundled.

```js
import { essence } from "@essence-lang/client/plugin"

export default { plugins: [essence()] }
```

What a build holds this way is the **bundle's** exports: Essence's own values,
under the names the Rewriter emitted them as, and the bridge that builds values
they accept. Not the marshalled ones — the Marshaller reads a Type out of an
export surface and prints its errors with the compiler's own printer, so
shipping it would ship the compiler. Marshal at the edge, with `loadModule`, or
reach for the bridge:

```js
import { square, $bridge_integer } from "./math/Math.es"

square($bridge_integer(12n)) // an Essence Integer
```

While a dev server is serving, a `<Name>.d.es.ts` is written beside each
compiled file, describing exactly that — which is where TypeScript looks for the
declarations of a `.es` import under `allowArbitraryExtensions`. `declarations`
turns it on in a build or off in a server.

## The raw door

`raw` holds every export under the name its author wrote and marshals nothing.
Values there are Essence's own: an Integer is a tagged object holding a
`bigint`, and the Symbol it is tagged with is minted when the bundle is
evaluated, so the constructors come out of that bundle too, on `bridge`.
`marshaller` is the same boundary `exports` was built through, bound to it.

```js
let math = await loadModule("./math/Math.es")
let { toJS, fromJS } = math.marshaller
let squared = math.surface.values.square

toJS(math.raw.square(fromJS(12n, squared.parameterTypes[0].type))) // 144n
```

## What this does not do yet

- **Callbacks.** A Function comes out of a Module as it is and can be called;
  one can not be passed *in*. `fromJS` against a Function Type says so.
- **Overloads.** A JavaScript value carries no Type, so nothing at the boundary
  can decide which Overload a call means. Each Overload is on `raw` under its
  own `name__overload$N`.
- **Compiling in a browser.** The compiler reads files and shells out to
  esbuild. What a browser can run is the *output* — which is what the bundler
  plugins are for.
- **Checked refinements.** A refined Type marshals as its base, unproven. The
  predicate belongs at the boundary, and will run there once refinements land.
