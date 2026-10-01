import type { Input } from "@essence-lang/client"
import {
	EssenceCallError,
	EssenceMarshalError,
} from "@essence-lang/client/errors"

// An ordinary import. The Bun plugin registered in `essence.ts` compiles the
// Module graph to marshalled JavaScript, typed by `Pricing.d.es.ts`. Under
// `bun --hot`, an edit to any `.es` file reloads this module.
import { catalog, type Order, quote } from "./rules/Pricing.es"

// JSON cannot spell a bigint, and every Integer crosses as one. Amounts here are
// cents, well within a double's exact range, so a Number is faithful. Larger
// amounts would go out as strings.
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
					// The boundary validates. A body that does not fit `quote`'s
					// Order is refused before any rule runs, naming the path to
					// the member at fault.
					let answer = quote(body as Input<Order>)

					// A Choice comes back tagged. `Rejected` is a well-formed order
					// the shop cannot price, unlike a body the boundary refused.
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
