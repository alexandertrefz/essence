import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { spawnAndWait } from "@essence-lang/fixtures/spawn"
import type { Server } from "bun"

// NOTE: The survey is tested where it is written — `Survey.es` and `Page.es`
// each carry a `tests { … }` section, and the doubles there are
// `Async.deferred`, so every path through the survey is checked without a host.
// What is left for this spec is what only a real request can say: that
// `Http.get` reaches a host at all, that a status and a page's title come back
// through the boundary as a `$case` object and a string, and that the one
// `Promise` the command awaits is the whole of the concurrency it writes.
const EXAMPLE = import.meta.dirname
const REPOSITORY = path.join(EXAMPLE, "..", "..")
const ESSENCE = path.join(REPOSITORY, "packages", "cli", "bin", "essence")

// NOTE: A bundle cache of this run's own, so that a spec compiling the survey
// neither answers out of the user's cache nor fills it — and a result cache
// beside it, because this spec runs `essence test` in the example's OWN
// directory, where an answer left in the user's store would be replayed by the
// next run a reader does there by hand.
const cache = mkdtempSync(path.join(tmpdir(), "essence-site-check-cache-"))
const results = mkdtempSync(path.join(tmpdir(), "essence-site-check-results-"))

// NOTE: A host of this spec's own on a free port. Nothing here reaches the
// network: the three pages below are everything the command is pointed at,
// and the one address that answers nothing is a port on loopback that nothing
// binds, which the kernel refuses in a turn.
const UNREACHABLE = "http://127.0.0.1:1/"

let server: Server<undefined> | null = null
let origin = ""

function pageAt(title: string | null, body: string): Response {
	return new Response(
		`<html><head>${title === null ? "" : `<title>\n\t${title}\n</title>`}</head><body>${body}</body></html>`,
		{ headers: { "content-type": "text/html" } },
	)
}

// NOTE: Awaited, because the host the command is pointed at is this process. A
// synchronous wait would hold the event loop that has to answer it, and every
// request would time out against a server that is right here.
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

		// NOTE: The order is the order the addresses were written, whatever
		// order the three runs finished in — `all(atMost:)` answers the
		// receiver's order and nothing else.
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
