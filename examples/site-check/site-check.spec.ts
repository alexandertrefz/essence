import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { spawnAndWait } from "@essence-lang/fixtures/spawn"
import type { Server } from "bun"

// The survey's own tests use `Async.deferred` doubles, so they need no host.
// This spec makes real requests. `Http.get` reaches a host, and a status and
// title cross the boundary as a `$case` object and a string.
const EXAMPLE = import.meta.dirname
const REPOSITORY = path.join(EXAMPLE, "..", "..")
const ESSENCE = path.join(REPOSITORY, "packages", "cli", "bin", "essence")

// Bundle and result caches of this run's own, so the spec neither reads nor
// fills the user's. It runs `essence test` in the example's directory, where a
// reader's next run would replay a stored answer.
const cache = mkdtempSync(path.join(tmpdir(), "essence-site-check-cache-"))
const results = mkdtempSync(path.join(tmpdir(), "essence-site-check-results-"))

// A host of this spec's own on a free port, so nothing reaches the network.
// The address that answers nothing is an unbound loopback port, which the
// kernel refuses at once.
const UNREACHABLE = "http://127.0.0.1:1/"

let server: Server<undefined> | null = null
let origin = ""

function pageAt(title: string | null, body: string): Response {
	return new Response(
		`<html><head>${title === null ? "" : `<title>\n\t${title}\n</title>`}</head><body>${body}</body></html>`,
		{ headers: { "content-type": "text/html" } },
	)
}

// Awaited, since this process is the host: a synchronous wait would block the
// event loop that must answer the requests.
async function check(
	urls: Array<string>,
): Promise<{ lines: Array<string>; code: number }> {
	let run = Bun.spawn([process.execPath, "check.ts", ...urls], {
		cwd: EXAMPLE,
		env: { ...process.env, ESSENCE_CLI_CACHE: cache },
		stdout: "pipe",
		stderr: "pipe",
	})
	let [out, failure, code] = await Promise.all([
		new Response(run.stdout).text(),
		new Response(run.stderr).text(),
		run.exited,
	])

	if (code !== 0 && code !== 1) {
		throw new Error(`check.ts failed:\n${out}\n${failure}`)
	}

	return { lines: out.trimEnd().split("\n"), code }
}

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		routes: {
			"/": () => pageAt("Beans, roasted", "welcome"),
			"/plain": () => new Response("no markup here"),
			"/gone": () => new Response("<title>Gone</title>", { status: 404 }),
		},
		fetch: () => new Response("?", { status: 404 }),
	})
	origin = `http://localhost:${server.port}`
})

afterAll(() => {
	server?.stop(true)
	rmSync(cache, { recursive: true, force: true })
	rmSync(results, { recursive: true, force: true })
})

describe("examples/site-check", () => {
	it("passes the survey's own tests", async () => {
		let run = await spawnAndWait(
			[process.execPath, ESSENCE, "test", "survey", "--no-color"],
			{
				cwd: EXAMPLE,
				env: {
					...process.env,
					ESSENCE_CLI_CACHE: cache,
					ESSENCE_RESULTS_CACHE: results,
				},
			},
		)
		let out = run.stdout

		expect(out).toContain(
			"reports a 404 as an answer rather than a failure",
		)
		expect(out).toContain("reads the text between the two tags")
		expect(out).not.toContain("failed")
		expect(run.code).toBe(0)
	}, 60_000)

	it("reads a status and a title off every address, in the order given", async () => {
		let { lines, code } = await check([
			`${origin}/`,
			`${origin}/plain`,
			`${origin}/gone`,
		])

		// The addresses' written order, whatever order the runs finished in,
		// since `all(atMost:)` keeps the receiver's order.
		expect(lines).toEqual([
			`200 Beans, roasted\t${origin}/`,
			`200 (no title)\t${origin}/plain`,
			`404 Gone\t${origin}/gone`,
			"2 of 3 answered",
		])
		expect(code).toBe(1)
	}, 60_000)

	it("reports a host it never reached, and says so in its exit code", async () => {
		let { lines, code } = await check([`${origin}/`, UNREACHABLE])

		expect(lines[0]).toBe(`200 Beans, roasted\t${origin}/`)
		expect(lines[1]).toContain(UNREACHABLE)
		expect(lines[1]).toContain("Unreachable(")
		expect(lines.at(-1)).toBe("1 of 2 answered")
		expect(code).toBe(1)
	}, 60_000)

	it("exits zero when every address answered", async () => {
		let { lines, code } = await check([`${origin}/`, `${origin}/plain`])

		expect(lines.at(-1)).toBe("2 of 2 answered")
		expect(code).toBe(0)
	}, 60_000)

	it("typechecks against the declarations the plugin wrote", async () => {
		let tsc = await spawnAndWait(
			[
				process.execPath,
				path.join(REPOSITORY, "node_modules", ".bin", "tsc"),
				"--noEmit",
			],
			{ cwd: EXAMPLE },
		)

		expect(tsc.stdout + tsc.stderr).toBe("")
		expect(tsc.code).toBe(0)
	}, 60_000)
})
