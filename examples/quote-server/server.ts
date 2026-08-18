import type { Input } from "@essence-lang/client"
import {
	EssenceCallError,
	EssenceMarshalError,
} from "@essence-lang/client/errors"

// NOTE: An ordinary import. The Bun plugin registered in `essence.ts` (see
// `bunfig.toml`) compiles the Module graph behind it and serves it as
// marshalled JavaScript: `quote` is a Function taking a plain object and
// answering one, `catalog` is an Array of them, and `Pricing.d.es.ts` beside
// the source is what TypeScript reads their Types from. Under `bun --hot`, an
// edit to any `.es` file in the graph reloads this module with the new rules.
import { catalog, type Order, quote } from "./rules/Pricing.es"

// NOTE: JavaScript's JSON has no spelling for a bigint, and every Integer
// crosses the boundary as one — the Type never depends on how big a value
// happens to be. Every amount here is cents, well inside what a double holds
// exactly, so a Number is a faithful spelling on the way out. A host that
// dealt in amounts past 2^53 would send them as strings instead.
function toJSON(value: unknown, status: number = 200): Response {
	return new Response(
		JSON.stringify(
			value,
			(_, held) => (typeof held === "bigint" ? Number(held) : held),
			"\t",
		),
		{ status, headers: { "content-type": "application/json" } },
	)
}

const port = Number(process.env.PORT ?? 3000)

const server = Bun.serve({
	port,
	routes: {
		"/catalog": { GET: () => toJSON(catalog) },

		"/quote": {
			POST: async (request) => {
				let body: unknown

				try {
					body = await request.json()
				} catch {
					return toJSON({ error: "The body is not JSON." }, 400)
				}

				try {
					// NOTE: The boundary is the validation. `quote` declares what an
					// Order is — the keys, their Types, that `zone` is one of three
					// names, that `coupon` may be missing — and a body that does not
					// fit is refused BEFORE any rule runs, with the path to the
					// member that did not fit. Nothing here checks a field by hand.
					let answer = quote(body as Input<Order>)

					// NOTE: A Choice comes back tagged. `Rejected` is a well-formed
					// order the shop can not price — a different status from a body
					// the boundary refused.
					if (answer.$case === "Quote#Rejected") {
						return toJSON(answer, 422)
					}

					return toJSON(answer)
				} catch (error) {
					if (
						error instanceof EssenceMarshalError ||
						error instanceof EssenceCallError
					) {
						return toJSON({ error: error.message }, 400)
					}

					throw error
				}
			},
		},
	},

	fetch() {
		return toJSON({ error: "No such route." }, 404)
	},
})

console.log(`listening on http://localhost:${server.port}`)
