import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import type { Subprocess } from "bun"

// NOTE: The pricing rules are tested where they are written — `Pricing.es`,
// `Money.es` and `Catalog.es` each carry a `tests { … }` section, and
// `essence test` runs them. What is left here is what only a bun spec can say:
// that the BOUNDARY carries those answers out — the JSON a client sends
// becoming Essence values, a Choice becoming `{ $case: … }`, a body the
// decoder can not read becoming a 400 that names the path — and that the
// project typechecks against the declarations the plugin wrote.
const EXAMPLE = import.meta.dirname
const REPOSITORY = path.join(EXAMPLE, "..", "..")
const ESSENCE = path.join(REPOSITORY, "packages", "cli", "bin", "essence")

// NOTE: A bundle cache of this run's own, so that a spec compiling the rules
// neither answers out of the user's cache nor fills it — and a result cache
// beside it, for the same reason and one more: this spec runs `essence test` in
// the example's OWN directory, so an answer left in the user's store would be
// replayed by the next run a reader does there by hand.
const cache = mkdtempSync(path.join(tmpdir(), "essence-quote-cache-"))
const results = mkdtempSync(path.join(tmpdir(), "essence-quote-results-"))

let server: Subprocess<"ignore", "pipe", "pipe"> | null = null
let origin = ""

async function post(body: unknown): Promise<{ status: number; json: any }> {
	let response = await fetch(`${origin}/quote`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	})

	return { status: response.status, json: await response.json() }
}

beforeAll(async () => {
	server = Bun.spawn([process.execPath, "server.ts"], {
		cwd: EXAMPLE,
		env: { ...process.env, PORT: "0" },
		stdout: "pipe",
		stderr: "pipe",
	})

	let reader = server.stdout.getReader()
	let decoder = new TextDecoder()
	let seen = ""

	while (!seen.includes("listening on")) {
		let { value, done } = await reader.read()

		if (done) {
			throw new Error(
				`the server exited before listening:\n${await new Response(server.stderr).text()}`,
			)
		}

		seen += decoder.decode(value)
	}

	origin = seen.match(/listening on (\S+)/)![1]!
}, 30_000)

afterAll(() => {
	server?.kill()
	rmSync(cache, { recursive: true, force: true })
	rmSync(results, { recursive: true, force: true })
})

describe("examples/quote-server", () => {
	it("passes the rules' own tests", () => {
		let run = Bun.spawnSync(
			[process.execPath, ESSENCE, "test", "rules", "--no-color"],
			{
				cwd: EXAMPLE,
				env: {
					...process.env,
					ESSENCE_CLI_CACHE: cache,
					ESSENCE_RESULTS_CACHE: results,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		)
		let out = run.stdout.toString()

		expect(out).toContain("prices an order exactly, cent by cent")
		expect(out).toContain("takes a rate exactly and rounds once")
		expect(out).not.toContain("failed")
		expect(run.exitCode).toBe(0)
	})

	it("serves the catalog as plain JSON", async () => {
		let response = await fetch(`${origin}/catalog`)
		let products = (await response.json()) as Array<{ sku: string }>

		expect(response.status).toBe(200)
		expect(products.map((product) => product.sku)).toContain("BEAN-250")
	})

	// NOTE: The same order `Pricing.es` prices in its own tests, asked for
	// over HTTP — so what is being checked here is that every member of the
	// Case survives the crossing, not that the arithmetic is right.
	it("carries a price out as plain JSON, member for member", async () => {
		let { status, json } = await post({
			lines: [
				{ sku: "BEAN-1KG", quantity: 2 },
				{ sku: "MUG-01", quantity: 1 },
			],
			zone: "Europe",
			coupon: "WELCOME10",
		})

		expect(status).toBe(200)
		expect(json.$case).toBe("Quote#Priced")
		expect(json.subtotal).toBe(7780)
		expect(json.discount).toBe(778)
		expect(json.shipping).toBe(2740)
		expect(json.tax).toBe(1851)
		expect(json.total).toBe(11593)
		expect(json.display).toBe("€115.93")
		expect(json.lines.map((line: { sku: string }) => line.sku)).toEqual([
			"BEAN-1KG",
			"MUG-01",
		])
	})

	it("rejects an order it can not price, naming every problem", async () => {
		let { status, json } = await post({
			lines: [
				{ sku: "SCALE-01", quantity: 1 },
				{ sku: "NOPE", quantity: 1 },
			],
			zone: "Domestic",
			coupon: "FREE",
		})

		expect(status).toBe(422)
		expect(json.$case).toBe("Quote#Rejected")
		expect(
			json.problems.map((problem: { $case: string }) => problem.$case),
		).toEqual([
			"Problem#OutOfStock",
			"Problem#UnknownSku",
			"Problem#UnknownCoupon",
		])
	})

	it("refuses a body the boundary can not read, with the path", async () => {
		let wrongQuantity = await post({
			lines: [{ sku: "BEAN-250", quantity: "two" }],
			zone: "Domestic",
		})

		expect(wrongQuantity.status).toBe(400)
		expect(wrongQuantity.json.error).toContain(".lines[0].quantity")
		expect(wrongQuantity.json.error).toContain("expected Integer")

		let wrongZone = await post({
			lines: [{ sku: "BEAN-250", quantity: 1 }],
			zone: "Mars",
		})

		expect(wrongZone.status).toBe(400)
		expect(wrongZone.json.error).toContain("expected Zone")

		let notJSON = await post("{not json")

		expect(notJSON.status).toBe(400)
	})

	it("typechecks against the declarations the plugin wrote", () => {
		let tsc = Bun.spawnSync(
			[
				process.execPath,
				path.join(REPOSITORY, "node_modules", ".bin", "tsc"),
				"--noEmit",
			],
			{ cwd: EXAMPLE, stdout: "pipe", stderr: "pipe" },
		)

		expect(tsc.stdout.toString() + tsc.stderr.toString()).toBe("")
		expect(tsc.exitCode).toBe(0)
	})
})
