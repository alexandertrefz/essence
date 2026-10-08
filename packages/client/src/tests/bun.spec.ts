import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

import { essenceBun } from "../bun-plugin"
import { REPOSITORY } from "./typecheck"

// The Bun plugin under both hosts. `Bun.build` runs in this process. The
// runtime gets a process of its own, whose `bunfig.toml` preloads the plugin,
// since a runtime plugin is registered for a whole process.

const MATH_MODULE = (body: string) => `implementation {

	constant PI = 314/100

	function squared(_ value: Integer) -> Integer {
		<- ${body}
	}
}

export {
	PI
	squared as square
}
`

const MAIN_MODULE = `import {
	from "./Math.es" { square }
}

implementation {
	constant answer = square(3)
}

export {
	answer
	from "./Math.es" { square }
}
`

let workspace = ""

beforeAll(() => {
	workspace = realpathSync.native(
		mkdtempSync(path.join(tmpdir(), "essence-bun-")),
	)
})

afterAll(() => {
	rmSync(workspace, { recursive: true, force: true })
})

// A project with this package installed, as `project` in `plugin.spec.ts`
// makes one, and a `bunfig.toml` that preloads the plugin.
function project(files: Record<string, string>): string {
	let directory = realpathSync.native(
		mkdtempSync(path.join(workspace, "project-")),
	)
	let scope = path.join(directory, "node_modules", "@essence-lang")

	mkdirSync(scope, { recursive: true })

	for (let name of ["client", "runtime"]) {
		symlinkSync(
			path.join(REPOSITORY, "packages", name),
			path.join(scope, name),
			"dir",
		)
	}

	writeFileSync(
		path.join(directory, "bunfig.toml"),
		'preload = ["./essence.ts"]\n',
	)
	writeFileSync(
		path.join(directory, "essence.ts"),
		`import { plugin } from "bun"
import { essenceBun } from "@essence-lang/client/bun-plugin"

plugin(essenceBun({ root: import.meta.dirname }))
`,
	)

	for (let [name, source] of Object.entries(files)) {
		let filePath = path.join(directory, name)

		mkdirSync(path.dirname(filePath), { recursive: true })
		writeFileSync(filePath, source)
	}

	return directory
}

async function built(
	directory: string,
	entry: string,
): Promise<{ text: string; module: Record<string, unknown> }> {
	let result = await Bun.build({
		entrypoints: [path.join(directory, entry)],
		root: directory,
		target: "bun",
		plugins: [essenceBun()],
	})

	expect(result.success).toBe(true)

	let text = await result.outputs[0]!.text()
	let output = path.join(directory, "out.mjs")

	writeFileSync(output, text)

	return {
		text,
		module: (await import(pathToFileURL(output).href)) as Record<
			string,
			unknown
		>,
	}
}

// A Bun process on the project, read line by line. A test waits for the line
// an edit produces rather than for a fixed time.
function running(
	directory: string,
	...args: Array<string>
): {
	next: (matching: RegExp) => Promise<string>
	stop: () => void
} {
	let child = Bun.spawn(["bun", ...args], {
		cwd: directory,
		stdout: "pipe",
		stderr: "pipe",
	})
	let lines: Array<string> = []
	let waiting: Array<{ matching: RegExp; resolve: (line: string) => void }> =
		[]
	let offer = (line: string) => {
		lines.push(line)

		for (let waiter of waiting.splice(0)) {
			if (waiter.matching.test(line)) {
				waiter.resolve(line)
			} else {
				waiting.push(waiter)
			}
		}
	}
	let read = async (stream: ReadableStream<Uint8Array>) => {
		let decoder = new TextDecoder()
		let rest = ""

		for await (let chunk of stream) {
			rest += decoder.decode(chunk, { stream: true })

			let parts = rest.split("\n")

			rest = parts.pop() ?? ""

			for (let line of parts) {
				offer(line)
			}
		}

		if (rest !== "") {
			offer(rest)
		}
	}

	void read(child.stdout)
	void read(child.stderr)

	return {
		next: (matching) =>
			new Promise((resolve, reject) => {
				let seen = lines.find((line) => matching.test(line))

				if (seen !== undefined) {
					lines.splice(lines.indexOf(seen), 1)
					resolve(seen)

					return
				}

				let timeout = setTimeout(() => {
					reject(
						new Error(
							`No line matching ${matching} within 15 seconds. Output so far:\n${lines.join(
								"\n",
							)}`,
						),
					)
				}, 15_000)

				waiting.push({
					matching,
					resolve: (line) => {
						clearTimeout(timeout)
						lines.splice(lines.indexOf(line), 1)
						resolve(line)
					},
				})
			}),
		stop: () => {
			child.kill()
		},
	}
}

describe("The Bun plugin under Bun.build", () => {
	it("serves an imported `.es` file as marshalled JavaScript", async () => {
		let directory = project({
			"Math.es": MATH_MODULE("value::multiply(with value)"),
			"entry.js": `import { PI, square } from "./Math.es"

export const squared = square(12n)
export const pi = PI.toString()
`,
		})
		let { text, module } = await built(directory, "entry.js")

		expect(module.squared).toBe(144n)
		expect(module.pi).toBe("157/50")
		// A build carries no watch imports.
		expect(text).not.toContain("?source")
	})

	// Only a spec counts List work, so the build defines the flag false and
	// nothing of the count is left.
	it("drops the List work count from what it builds", async () => {
		let directory = project({
			"Lists.es": `implementation {
	function grown(_ count: Integer) -> List<Integer> {
		<- [1, 2]::prepend(count)::remove(at 1)
	}
}

export {
	grown
}
`,
			"entry.js": `import { grown } from "./Lists.es"

export const lengths = grown(3n).length
`,
		})
		let { text, module } = await built(directory, "entry.js")

		expect(module.lengths).toBe(2)
		expect(text).not.toContain("essenceCountsListWork")
	})

	// The plugin's bridge imports the Dictionary door, so a `Map` goes in, the
	// Module adds to it, and the entries come back in order.
	it("carries a Dictionary across the marshalled door", async () => {
		let directory = project({
			"Ledger.es": `implementation {

	function ages(_ value: Dictionary<String, Integer>) -> Dictionary<String, Integer> {
		<- value::set("added", to 9)
	}
}

export {
	ages
}
`,
			"entry.js": `import { ages } from "./Ledger.es"

export const entries = [...ages(new Map([["alex", 39n]]))]
`,
		})
		let { module } = await built(directory, "entry.js")

		expect(module.entries).toEqual([
			["alex", 39n],
			["added", 9n],
		])
	})

	// The asynchrony door: the wrapper and the Module import one `Future.ts`,
	// so the entry awaits the run the wrapper started.
	it("answers a call with a promise the build awaits", async () => {
		let directory = project({
			"Async.es": `implementation {

	function doubled(_ value: Integer) -> Future<Integer> {
		<- complete Async.deferred(() { <- value::multiply(with 2) })
	}
}

export {
	doubled
}
`,
			"entry.js": `import { doubled } from "./Async.es"

export const doubling = doubled(21n)
`,
		})
		let { module } = await built(directory, "entry.js")

		expect(await (module.doubling as Promise<bigint>)).toBe(42n)
	})

	// The raw door and the wrapper hold one Module, so a value built through
	// the build's runtime is one the Module accepts.
	it("holds one Module behind the marshalled door and the raw one", async () => {
		let directory = project({
			"Math.es": MATH_MODULE("value::multiply(with value)"),
			"entry.js": `import { square } from "./Math.es"
import { square as rawSquare } from "./Math.es?raw"
import { createInteger } from "@essence-lang/runtime/Integer"

export const marshalled = square(3n)
export const raw = rawSquare(createInteger(3)).value
`,
		})
		let { module } = await built(directory, "entry.js")

		expect(module.marshalled).toBe(9n)
		expect(module.raw).toBe(9)
	})

	it("serves a file two entries share once", async () => {
		let directory = project({
			"lib/Math.es": MATH_MODULE("value::multiply(with value)"),
			"One.es": `import {
	from "./lib/Math.es" { square }
}

implementation {
	constant one = square(1)
}

export {
	one
}
`,
			"Two.es": `import {
	from "./lib/Math.es" { square }
}

implementation {
	constant two = square(2)
}

export {
	two
}
`,
			"entry.js": `import { one } from "./One.es"
import { two } from "./Two.es"

export const both = [one, two]
`,
		})
		let { text, module } = await built(directory, "entry.js")

		expect(module.both).toEqual([1n, 4n])
		expect(text.match(/function squared\(/g)).toHaveLength(1)
	})

	// Each Module of the cycle is served on its own, and each reads the other's
	// Constant inside a body, which runs once both have loaded.
	it("serves a cycle whose Modules read each other's Constants", async () => {
		let directory = project({
			"A.es": `import {
	from "./B.es" { SCALE }
}

implementation {
	constant OFFSET = 10

	function scaled(_ value: Integer) -> Integer {
		<- value::multiply(with SCALE)
	}
}

export {
	OFFSET
	scaled
}
`,
			"B.es": `import {
	from "./A.es" { OFFSET scaled }
}

implementation {
	constant SCALE = 3

	function shifted(_ value: Integer) -> Integer {
		<- scaled(value)::add(OFFSET)
	}
}

export {
	SCALE
	shifted
}
`,
			"entry.js": `import { shifted } from "./B.es"
import { scaled } from "./A.es"

export const both = [scaled(2n), shifted(2n)]
`,
		})
		let { module } = await built(directory, "entry.js")

		expect(module.both).toEqual([6n, 16n])
	})

	// Each Module reads the other's Constant in a Function written above its
	// own Constant, which is written with its Type, so neither waits. Either
	// Module may load first.
	it("serves a cycle whose Functions read Constants written with their Type below them", async () => {
		for (let imports of [
			['import { f } from "./A.es"', 'import { g } from "./B.es"'],
			['import { g } from "./B.es"', 'import { f } from "./A.es"'],
		]) {
			let directory = project({
				"A.es": `import {
	from "./B.es" { k }
}

implementation {
	function f() -> Integer {
		<- k
	}

	constant a: Integer = 1
}

export {
	a
	f
}
`,
				"B.es": `import {
	from "./A.es" { a }
}

implementation {
	function g() -> Integer {
		<- a
	}

	constant k: Integer = 2
}

export {
	g
	k
}
`,
				"entry.js": `${imports.join("\n")}

export const both = [f(), g()]
`,
			})
			let { module } = await built(directory, "entry.js")

			expect(module.both).toEqual([2n, 1n])
		}
	})
})

describe("The Bun plugin under the runtime", () => {
	it("compiles an imported `.es` file where a script asks for it", async () => {
		let directory = project({
			"src/Math.es": MATH_MODULE("value::multiply(with value)"),
			"src/Main.es": MAIN_MODULE,
			"main.ts": `import { answer, square } from "./src/Main.es"

console.log("answer", answer, "square", square(4n))
`,
		})
		let process = running(directory, "main.ts")

		try {
			expect(await process.next(/^answer/)).toBe("answer 9n square 16n")
		} finally {
			process.stop()
		}
	})

	// Under `bun --hot` an edit to a sibling reloads the Module, the wrapper and
	// the script. A value built before the reload still crosses after it.
	it("reloads under `bun --hot` when a source changes", async () => {
		let directory = project({
			"src/Math.es": MATH_MODULE("value::multiply(with value)"),
			"src/Main.es": MAIN_MODULE,
			"main.ts": `import { answer, square } from "./src/Main.es"
import { square as rawSquare } from "./src/Main.es?raw"
import { createInteger } from "@essence-lang/runtime/Integer"

globalThis.kept ??= rawSquare(createInteger(2))

console.log("answer", answer, "square", square(4n), "kept", rawSquare(globalThis.kept).value)
`,
		})
		let process = running(directory, "--hot", "main.ts")

		try {
			expect(await process.next(/^answer/)).toBe(
				"answer 9n square 16n kept 16",
			)

			writeFileSync(
				path.join(directory, "src", "Math.es"),
				MATH_MODULE("value::multiply(with value)::add(1)"),
			)

			expect(await process.next(/^answer/)).toBe(
				"answer 10n square 17n kept 17",
			)

			// An edit that does not compile is reported, and the fix is
			// printed next.
			writeFileSync(
				path.join(directory, "src", "Math.es"),
				MATH_MODULE('"not an Integer"'),
			)

			expect(await process.next(/return-type-mismatch/)).toContain(
				"[return-type-mismatch]",
			)

			writeFileSync(
				path.join(directory, "src", "Math.es"),
				MATH_MODULE("value::multiply(with value)::add(2)"),
			)

			expect(await process.next(/^answer/)).toBe(
				"answer 11n square 18n kept 18",
			)
		} finally {
			process.stop()
		}
	}, 60_000)
})
