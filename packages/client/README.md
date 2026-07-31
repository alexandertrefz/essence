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
so the Program inside it is evaluated once. The cache lives in the platform's
own cache directory; `ESSENCE_CLIENT_CACHE` moves it.

Source that does not compile throws an `EssenceCompileError` whose message is
the report `esc` prints: the excerpt, the underline, the Notes and the Helps,
one block per file.

## Values

`exports` holds the Module's constants as ordinary JavaScript.

```js
let math = await loadModule("./math/Math.es")

math.exports.PI.toString() // "157/50"
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

Functions and Namespaces are not on `exports` yet — calling is the next slice.
Until then they are reached through `raw`, which holds every export under the
name its author wrote and marshals nothing. Values there are Essence's own: an
Integer is a tagged object holding a `bigint`, and the Symbol it is tagged with
is minted when the bundle is evaluated, so the constructors come out of that
bundle too, on `bridge`. `marshaller` is the same boundary `exports` was built
through, bound to that bridge.

```js
let math = await loadModule("./math/Math.es")
let { toJS, fromJS } = math.marshaller
let squared = math.surface.values.square

toJS(math.raw.square(fromJS(12n, squared.parameterTypes[0].type))) // 144n
```
