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

// NOTE: The Bun plugin under both of its hosts. `Bun.build` is driven in this
// process, the way the esbuild plugin's tests drive esbuild; the RUNTIME is a
// process of its own — `bun` started on a project whose `bunfig.toml` preloads
// the plugin — because a runtime plugin is registered for a whole process and
// this one is running the tests.

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

// NOTE: A project with this package installed in it — see `project` in
// `plugin.spec.ts` for why — and, for the runtime, a `bunfig.toml` that
// preloads the plugin, which is how a project uses it.
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

// NOTE: A Bun process on the project, its output read line by line as it
// arrives — so that a test can wait for the line an edit should produce rather
// than for a fixed time. Killed when the test is done with it.
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
		// NOTE: A build carries no watch imports — those are the runtime's,
		// and a bundle has no watcher to answer to.
		expect(text).not.toContain("?source")
	})

	// NOTE: The raw door and the wrapper, in one build, holding one Module: a
	// value built through the runtime the build resolved is a value the
	// marshalled door's Functions were compiled against.
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

	// NOTE: THE reason for the runtime door: `bun --hot`. Bun reloads a module
	// when a file it read changes, and it read the `.es` sources because the
	// plugin had it — so an edit to a sibling reloads the entry's Module, the
	// wrapper and the script, and what the script prints is the edit. And a
	// value built BEFORE the reload is still a value after it: one runtime for
	// the process, one Type key.
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

			// NOTE: An edit that does not compile is reported and the process
			// stays up; the edit that fixes it is the next thing it prints.
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
