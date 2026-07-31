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

Values crossing the boundary are Essence's own — an Integer is a tagged object
holding a `bigint`, not a `number` — and every one of them carries its Type on
a Symbol that is minted when the bundle is evaluated. So the constructors come
out of the bundle too, on `bridge`, rather than being imported from the
runtime: a value built anywhere else is a value that bundle cannot recognise.

```js
let math = await loadModule("./math/Math.es")

math.raw.square(math.bridge.integer(12n))
```

Marshalling those values to and from ordinary JavaScript is the next slice.
