# Quote server

An HTTP API that prices orders. [`server.ts`](server.ts) is Bun: it parses
requests, turns answers into JSON, and nothing else. Every rule — the catalog,
volume tiers, coupons, shipping zones, tax, rounding — is Essence, in
[`rules/`](rules/), and reaches the server through an ordinary import:

```ts
import { catalog, type Order, quote } from "./rules/Pricing.es"
```

```sh
cd examples/quote-server
bun start                     # bun --hot server.ts, on http://localhost:3000
```

The Bun plugin registered in [`essence.ts`](essence.ts) (preloaded by
[`bunfig.toml`](bunfig.toml)) compiles the Module graph behind that import and
serves it as marshalled JavaScript. Edit any `.es` file while the server runs
and the next request uses the new rules — `bun --hot` reloads what the plugin
served, and a value built before the reload is still a value after it.

## Try it

A priced order — two kilos of beans and a mug, to somewhere in Europe, with a
welcome coupon:

```sh
curl -s localhost:3000/quote -d '{
  "lines": [{ "sku": "BEAN-1KG", "quantity": 2 }, { "sku": "MUG-01", "quantity": 1 }],
  "zone": "Europe",
  "coupon": "WELCOME10"
}'
```

```json
{
	"lines": [ … ],
	"subtotal": 7780,
	"discount": 778,
	"shipping": 2740,
	"tax": 1851,
	"total": 11593,
	"display": "€115.93",
	"$case": "Quote#Priced"
}
```

A well-formed order the shop can not price — `422`, with every problem, each
carrying what a client needs to fix it:

```sh
curl -s localhost:3000/quote -d '{
  "lines": [{ "sku": "SCALE-01", "quantity": 1 }, { "sku": "NOPE", "quantity": 1 }],
  "zone": "Domestic",
  "coupon": "FREE"
}'
```

```json
{
	"problems": [
		{ "sku": "SCALE-01", "requested": 1, "available": 0, "$case": "Problem#OutOfStock" },
		{ "sku": "NOPE", "$case": "Problem#UnknownSku" },
		{ "code": "FREE", "$case": "Problem#UnknownCoupon" }
	],
	"$case": "Quote#Rejected"
}
```

A body that is not an order at all — `400`, refused by the boundary before any
rule runs, with the path to the member that did not fit:

```sh
curl -s localhost:3000/quote -d '{ "lines": [{ "sku": "BEAN-250", "quantity": "two" }], "zone": "Mars" }'
```

```json
{ "error": "argument 1 → .lines[0].quantity: expected Integer, got the string \"two\"." }
```

## What it shows

- **The boundary is the validation.** `quote` declares what an `Order` is —
  the keys, their Types, that `zone` is one of three names, that `coupon` may
  be missing — and the marshaller refuses anything else with a path. The
  server checks no field by hand.
- **A Choice with no payloads is a string.** `choice Zone { Domestic, Europe,
  Overseas }` crosses as `"Domestic" | "Europe" | "Overseas"` — the JSON a
  client sends *is* the value — while `Quote` and `Problem`, which carry
  payloads, cross as `{ $case: "Quote#Priced", … }` objects the server
  switches on for its status code.
- **`Optional` is absence.** A request without `coupon` is `#Empty` on the
  Essence side; there is no second spelling of "no coupon".
- **Exact money.** Prices are cents (`Integer`), rates are `Rational` — a 5 %
  volume tier and a 15 % coupon add to exactly `1/5` — and
  [`Money.percent`](rules/Money.es) is the one place a rate meets cents and
  rounds. `1234::toString(scaledBy 2)` is what writes them back out as
  `12.34`, so nothing divides by a hundred to render a price. Integers come
  out of the boundary as `bigint`; `server.ts` turns them into JSON numbers,
  and says why that is safe here.
- **A checked line is a `Result`.** [`Pricing.es`](rules/Pricing.es) checks
  each line once into `Result<FineLine, Problem>` — an `Optional` says there
  is no price, a Result says why — and `allValues()` asks the whole order at
  once: every line's value, or every reason where anything failed. It
  *accumulates*, so a client is told everything wrong with its order in one
  answer instead of the first thing; there is no fold written here for either
  half.
- **Typed on both sides.** The plugin writes `rules/Pricing.d.es.ts` beside
  the source, and `tsc` reads the import from it:

  ```ts
  export type Zone = "Domestic" | "Europe" | "Overseas"
  export type Quote =
  	| { $case: "Quote#Priced"; lines: Array<…>; subtotal: bigint; …; display: string }
  	| { $case: "Quote#Rejected"; problems: Array<Problem> }
  export declare function quote(p0: Input<Order>): Quote
  export declare const catalog: Array<Product>
  ```

The pricing rules are tested in Essence, where they are written: `Pricing.es`,
`Money.es` and `Catalog.es` each end in a `tests { … }` section, and a build
drops them before anything is enriched, so they cost the served bundle nothing.

```
$ essence test rules
```

[`quote-server.spec.ts`](quote-server.spec.ts) runs those, then starts the
server on a free port, makes these requests, and typechecks the project against
the generated declarations — the rules in Essence, the boundary in TypeScript.
