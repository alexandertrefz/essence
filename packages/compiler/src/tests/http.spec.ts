import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// The `Http` Namespace end to end, against a server started in this file. A
// golden line would record what some host answered on one day, so `Http.send`
// and its verbs are asserted here. That covers the status, the body, header
// case, redirect modes, what each verb sends, the failures, and stopping a
// request at the server.
//
// No external network. The server listens on an ephemeral port, and every
// address but one is built from it. The unreachable one is port 1 on the
// loopback interface, which nothing binds.
//
// The slow route answers only when it is stopped, or after a wait no test sits
// through. Nothing sleeps for a fixed time. A test waits for the server to say
// what it saw, up to a deadline, so a loaded machine only makes it slower.

// What the server saw, reset before each Program runs.
type Seen = {
	requests: number
	methods: Array<string>
	bodies: Array<string>
	headers: Array<Record<string, string>>
	stopped: number
}

let seen: Seen = freshSeen()
let server: ReturnType<typeof Bun.serve> | null = null
let base = ""

// The waits the slow route holds, each its own `release`. `afterAll` releases
// what is left, so no timer keeps the runner's event loop open.
let pendingWaits = new Set<() => void>()

function freshSeen(): Seen {
	return { requests: 0, methods: [], bodies: [], headers: [], stopped: 0 }
}

function headersOf(request: Request): Record<string, string> {
	let answer: Record<string, string> = {}

	request.headers.forEach((value, name) => {
		answer[name] = value
	})

	return answer
}

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		// The host's idle timeout would end the slow route itself, and the
		// stopping test would pass without stopping anything.
		idleTimeout: 0,
		async fetch(request) {
			let url = new URL(request.url)

			seen.requests += 1
			seen.methods.push(request.method)
			seen.headers.push(headersOf(request))
			seen.bodies.push(await request.text())

			if (url.pathname === "/echo") {
				return new Response(seen.bodies[seen.bodies.length - 1], {
					status: 201,
					headers: {
						"X-Seen-Method": request.method,
						"Content-Type": "text/plain",
					},
				})
			}

			if (url.pathname === "/moved") {
				return new Response("", {
					status: 302,
					headers: { Location: "/hello" },
				})
			}

			if (url.pathname === "/missing") {
				return new Response("gone", { status: 404 })
			}

			if (url.pathname === "/unchanged") {
				return new Response(null, { status: 304 })
			}

			// A name sent twice, in both shapes the Fetch standard
			// distinguishes: `Headers` folds `x-repeated` itself, and exempts
			// `set-cookie`, which iterates as one pair per cookie.
			if (url.pathname === "/repeated") {
				let answer = new Response("repeated", { status: 200 })

				answer.headers.append("set-cookie", "a=1; Path=/")
				answer.headers.append("set-cookie", "b=2; Path=/")
				answer.headers.append("x-repeated", "one")
				answer.headers.append("x-repeated", "two")

				return answer
			}

			if (url.pathname === "/slow") {
				await new Promise<void>((resolve) => {
					let timer = setTimeout(resolve, 30_000)

					let release = (): void => {
						clearTimeout(timer)
						pendingWaits.delete(release)
						resolve()
					}

					pendingWaits.add(release)

					request.signal.addEventListener(
						"abort",
						() => {
							seen.stopped += 1
							release()
						},
						{ once: true },
					)
				})

				return new Response("late", { status: 200 })
			}

			return new Response("hello", {
				status: 200,
				headers: { "X-Custom": "Yes", "Content-Type": "text/plain" },
			})
		},
	})

	base = `http://localhost:${server.port}`
})

afterAll(() => {
	// Each `release` deletes itself from the set, so the set is swapped out
	// before it is walked.
	let waiting = pendingWaits

	pendingWaits = new Set()

	for (let release of waiting) {
		release()
	}

	server?.stop(true)
})

// A Program that completes anything at its top level emits a top-level
// `await`, which only `await import` can load, as in `asynchrony.spec.ts`.
async function run(source: string): Promise<Array<string>> {
	seen = freshSeen()

	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(enriched.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
		[],
	)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	let javaScript = rewrite(optimise(simplify(enriched.program)))
	let directory = mkdtempSync(join(tmpdir(), "essence-http-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, javaScript)

	// `Terminal.print` reaches `process.stdout.write` and `Terminal.inspect`
	// reaches `console.log`, so both are captured.
	let written = ""
	let originalLog = console.log
	let originalOut = process.stdout.write

	console.log = (...args: Array<unknown>) => {
		written += `${args.map((argument) => String(argument)).join(" ")}\n`
	}

	process.stdout.write = ((chunk: unknown) => {
		written += String(chunk)

		return true
	}) as typeof process.stdout.write

	try {
		await import(file)
	} finally {
		console.log = originalLog
		process.stdout.write = originalOut
		rmSync(directory, { recursive: true, force: true })
	}

	// The trailing break is the one `print` wrote, and not a line.
	return written === "" ? [] : written.replace(/\n$/, "").split("\n")
}

// The `match` over a Result that every Program here uses, written once.
function program(body: string): string {
	return `implementation {
	function report(_ answer: Result<Response, HttpFailure>) -> {} {
		<- match answer -> {} {
			case #Value(response) {
				Terminal.print("{response.status} {response.body}")
			}
			case #Failure(reason) { Terminal.print(reason) }
		}
	}

${body}
}`
}

// Waits until the server has seen something, since it learns of a stopped
// request a turn or more after the client stops it.
async function until(
	holds: () => boolean,
	within: number = 5_000,
): Promise<void> {
	let deadline = Date.now() + within

	while (!holds() && Date.now() < deadline) {
		await Bun.sleep(5)
	}
}

describe("Http", () => {
	it("answers the status, the body and the headers a host sent", async () => {
		let output = await run(
			program(`	constant answered = complete Http.get("${base}/hello")

	match answered -> {} {
		case #Value(response) {
			Terminal.print(response.status)
			Terminal.print(response.body)
			Terminal.print(response::isSuccessful())
			Terminal.print(response.headers::value(at "content-type"))
		}
		case #Failure(reason) { Terminal.print(reason) }
	}`),
		)

		expect(output).toEqual(["200", "hello", "true", 'Value("text/plain")'])
	})

	it("reads a header under any case, because its keys are lowercase", async () => {
		let output = await run(
			program(`	constant answered = complete Http.get("${base}/hello")

	match answered -> {} {
		case #Value(response) {
			Terminal.print(response::header(named "X-Custom"))
			Terminal.print(response::header(named "x-custom"))
			Terminal.print(response::header(named "X-CUSTOM"))
			Terminal.print(response::header(named "x-nothing"))
			Terminal.print(response.headers::keys())
		}
		case #Failure(reason) { Terminal.print(reason) }
	}`),
		)

		expect(output.slice(0, 4)).toEqual([
			'Value("Yes")',
			'Value("Yes")',
			'Value("Yes")',
			"Empty",
		])
		expect(output[4]).toContain("x-custom")
		expect(output[4]).not.toContain("X-Custom")
	})

	// A Dictionary holds one value per key, so a second cookie would
	// otherwise overwrite the first.
	it("folds a header a host sent twice, cookies included", async () => {
		let output = await run(
			program(`	constant answered = complete Http.get("${base}/repeated")

	match answered -> {} {
		case #Value(response) {
			Terminal.print(response::header(named "set-cookie"))
			Terminal.print(response::header(named "x-repeated"))
		}
		case #Failure(reason) { Terminal.print(reason) }
	}`),
		)

		expect(output).toEqual([
			'Value("a=1; Path=/, b=2; Path=/")',
			'Value("one, two")',
		])
	})

	it("answers a status that failed as a Response rather than a failure", async () => {
		let output = await run(
			program(`	constant answered = complete Http.get("${base}/missing")

	match answered -> {} {
		case #Value(response) {
			Terminal.print(response.status)
			Terminal.print(response.body)
			Terminal.print(response::isSuccessful())
		}
		case #Failure(reason) { Terminal.print(reason) }
	}`),
		)

		expect(output).toEqual(["404", "gone", "false"])
	})

	it("follows a redirect, hands one back, and refuses one", async () => {
		let output = await run(
			program(`	report(complete Http.get("${base}/moved"))

	constant handed = complete Http.send({ url = "${base}/moved", redirects = #Manual })

	report(handed)

	match handed -> {} {
		case #Value(response) { Terminal.print(response::header(named "location")) }
		case #Failure(reason) { Terminal.print(reason) }
	}

	report(complete Http.send({ url = "${base}/moved", redirects = #Refuse }))`),
		)

		expect(output[0]).toBe("200 hello")
		expect(output[1]).toBe("302 ")
		// Under `#Manual` the redirect is the answer, and a Program reads
		// where it points off the `location` header.
		expect(output[2]).toBe('Value("/hello")')
		// This library's own sentence, never the host library's.
		expect(output[3]).toBe(
			'Unreachable("the host answered a redirect, and this request refused to follow one")',
		)
	})

	// A 304 carries no `location` and means "what you have is current", so it
	// is an answer under every redirect mode.
	it("hands back a 3xx that is no redirect even where redirects are refused", async () => {
		let output = await run(
			program(
				`	report(complete Http.send({ url = "${base}/unchanged", redirects = #Refuse }))`,
			),
		)

		expect(output[0]).toBe("304 ")
	})

	// A host library's refusal names `fetch()`, which no Essence Program can
	// reach, so this library refuses these itself.
	it("refuses a request it can decide about itself, in its own words", async () => {
		let output = await run(
			program(`	report(complete Http.send({ url = "${base}/hello", body = Optional<String>#Value("payload") }))
	report(complete Http.send({ url = "${base}/hello", method = #Head, body = Optional<String>#Value("payload") }))
	report(complete Http.get("${base}/hello", headers ["bad name" = "x"]))`),
		)

		expect(output).toEqual([
			'Unreachable("a GET request carries no body, so this one was not sent")',
			'Unreachable("a HEAD request carries no body, so this one was not sent")',
			`Unreachable("'bad name' is not a header name, so this request was not sent")`,
		])
		expect(seen.requests).toBe(0)
	})

	it("sends the method each verb names, and the body the ones that take one", async () => {
		let output = await run(
			program(`	report(complete Http.get("${base}/echo"))
	report(complete Http.post("${base}/echo", body "posted"))
	report(complete Http.put("${base}/echo", body "put"))
	report(complete Http.patch("${base}/echo", body "patched"))
	report(complete Http.delete("${base}/echo"))
	report(complete Http.head("${base}/echo"))`),
		)

		expect(seen.methods).toEqual([
			"GET",
			"POST",
			"PUT",
			"PATCH",
			"DELETE",
			"HEAD",
		])
		expect(seen.bodies).toEqual(["", "posted", "put", "patched", "", ""])
		// A HEAD answer carries no body, so its Response body is empty.
		expect(output).toEqual([
			"201 ",
			"201 posted",
			"201 put",
			"201 patched",
			"201 ",
			"201 ",
		])
	})

	// The Record default on `send`'s Parameter fills in the members a
	// request leaves out.
	it("fills in every member of a request but the address", async () => {
		let output = await run(
			program(
				`	report(complete Http.send({ url = "${base}/moved" }))`,
			),
		)

		expect(seen.methods).toEqual(["GET", "GET"])
		expect(seen.bodies).toEqual(["", ""])
		expect(output).toEqual(["200 hello"])
	})

	// The second call holds the promise the Request's documentation makes:
	// this library names no `content-type` for a body.
	it("sends the headers a call writes", async () => {
		await run(
			program(`	report(
		complete Http.get(
			"${base}/hello",
			headers ["X-Asked" = "yes", "Accept" = "text/plain"],
		),
	)
	report(
		complete Http.post(
			"${base}/echo",
			body "[1]",
			headers ["Content-Type" = "application/json"],
		),
	)`),
		)

		expect(seen.headers[0]?.["x-asked"]).toBe("yes")
		expect(seen.headers[0]?.["accept"]).toBe("text/plain")
		expect(seen.headers[1]?.["content-type"]).toBe("application/json")
	})

	it("sends nothing until the future is started", async () => {
		let output = await run(
			program(`	constant asked = Http.get("${base}/hello")

	Terminal.print("built")

	report(complete asked)`),
		)

		expect(output).toEqual(["built", "200 hello"])
		expect(seen.requests).toBe(1)
	})

	it("sends again at every start, because a request is a description", async () => {
		await run(
			program(`	constant asked = Http.get("${base}/hello")

	report(complete asked)
	report(complete asked)`),
		)

		expect(seen.requests).toBe(2)
	})

	it("gives up on a slow host, and the host sees the request stop", async () => {
		let output = await run(
			program(`	constant answered = complete Http.get("${base}/slow")
		::within(milliseconds 50)

	Terminal.print(answered::hasValue())`),
		)

		expect(output).toEqual(["false"])

		await until(() => seen.stopped === 1)

		expect(seen.stopped).toBe(1)
	})

	it("answers #InvalidUrl for an address it does not send to", async () => {
		let output = await run(
			program(`	report(complete Http.get("not a url"))
	report(complete Http.get("file:///etc/hosts"))`),
		)

		expect(output).toEqual([
			'InvalidUrl("not a url")',
			'InvalidUrl("file:///etc/hosts")',
		])
		expect(seen.requests).toBe(0)
	})

	it("answers #Unreachable for a host that is not there", async () => {
		let output = await run(
			program(`	report(complete Http.get("http://127.0.0.1:1/"))`),
		)

		expect(output).toHaveLength(1)
		expect(output[0]).toStartWith("Unreachable(")
	})
})
