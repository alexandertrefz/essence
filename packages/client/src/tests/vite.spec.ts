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

import { createServer, type ViteDevServer } from "vite"

import { rawSpecifier } from "../plugin-core"
import { essence } from "../vite-plugin"
import { REPOSITORY } from "./typecheck"

// The plugin under a real dev server, checking hot reloading against what Vite
// does. No browser is attached, so the module graph is read instead.

const MATH_MODULE = (body: string) => `implementation {

	function squared(_ value: Integer) -> Integer {
		<- ${body}
	}
}

export {
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
}
`

const PRELUDE_URL = "\0essence-prelude"

let workspace = ""

beforeAll(() => {
	workspace = realpathSync.native(
		mkdtempSync(path.join(tmpdir(), "essence-vite-")),
	)
})

afterAll(() => {
	rmSync(workspace, { recursive: true, force: true })
})

// A project with this package installed, as `project` in `plugin.spec.ts`
// makes one.
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

	for (let [name, source] of Object.entries(files)) {
		let filePath = path.join(directory, name)

		mkdirSync(path.dirname(filePath), { recursive: true })
		writeFileSync(filePath, source)
	}

	return directory
}

function squaringProject(extra: Record<string, string> = {}): string {
	return project({
		"src/Main.es": MAIN_MODULE,
		"src/Math.es": MATH_MODULE("value::multiply(with value)"),
		...extra,
	})
}

// Middleware mode with no watcher, since the tests report changes themselves,
// and no client. Dependency optimisation would look for an `index.html`.
async function serve(root: string): Promise<ViteDevServer> {
	return await createServer({
		root,
		configFile: false,
		logLevel: "silent",
		appType: "custom",
		plugins: [essence({ declarations: false })],
		server: { middlewareMode: true, watch: null },
		optimizeDeps: { noDiscovery: true, include: [] },
	})
}

// Emits a change on Vite's no-op watcher, which runs `watchChange`, the graph
// and the HMR propagation without awaiting them. The propagation ends by
// stamping every module of the file with the update's time, so this waits for
// stamps newer than the emit. A file no served module came from is never
// stamped, so it is refused.
async function changed(server: ViteDevServer, file: string): Promise<void> {
	let modules = [
		...(server.environments.client.moduleGraph.getModulesByFile(file) ??
			[]),
	]

	if (modules.length === 0) {
		throw new Error(`No served module was compiled from ${file}.`)
	}

	// Newer than the stamps already there too, since Vite's monotonic clock can
	// run ahead of `Date.now()`.
	let before = Math.max(
		Date.now(),
		...modules.map((module) => module.lastHMRTimestamp + 1),
	)
	// Inside the per-test budget `scripts/testBudget.ts` sets, so the wait never
	// throws after its test has ended.
	let deadline = Date.now() + 4_000
	let stamped = () =>
		modules.every((module) => module.lastHMRTimestamp >= before)

	server.watcher.emit("change", file)

	while (!stamped() && Date.now() < deadline) {
		await new Promise<void>((resolve) => {
			setImmediate(resolve)
		})
	}

	if (!stamped()) {
		throw new Error(
			`Vite had not propagated the change to ${file} within 4 seconds.`,
		)
	}
}

async function transformed(
	server: ViteDevServer,
	url: string,
): Promise<string> {
	let result = await server.environments.client.transformRequest(url)

	expect(result).not.toBe(null)

	return result!.code
}

// Vite stamps the import of an updated module with `&t=<now>`, the one way an
// unchanged importer's text moves.
function withoutTimestamps(code: string): string {
	return code.replace(/&t=\d+/g, "")
}

function transformResult(server: ViteDevServer, id: string): unknown {
	let node = server.environments.client.moduleGraph.getModuleById(id)

	expect(node).not.toBe(undefined)

	return node!.transformResult
}

// The id `transformRequest` gets for a module no filesystem holds, which Vite
// unwraps from a browser's `/@id/__x00__essence-raw:…`.
function rawUrl(file: string): string {
	return `\0${rawSpecifier(file)}`
}

describe("Under a Vite dev server", () => {
	it("serves the wrapper, the Modules behind it and the prelude as one graph", async () => {
		let root = squaringProject()
		let server = await serve(root)

		try {
			let main = path.join(root, "src", "Main.es")
			let math = path.join(root, "src", "Math.es")
			let wrapper = await transformed(server, "/src/Main.es")

			expect(wrapper).toContain("bind($raw,")

			let graph = server.environments.client.moduleGraph
			let importedIds = [
				...graph.getModuleById(main)!.importedModules,
			].map((node) => node.id)

			// The wrapper imports its Module and the interpreter, which the
			// host resolves from `node_modules`.
			expect(importedIds).toContain(`\0${rawSpecifier(main)}`)
			expect(
				importedIds.some((id) => id?.endsWith("/marshal-runtime.ts")),
			).toBe(true)

			let rawMain = await transformed(server, rawUrl(main))

			// The host resolves `@essence-lang/runtime/Integer` to a file.
			expect(rawMain).toContain("/@fs/")
			expect(rawMain).toContain("/runtime/src/Integer.ts")

			let rawImports = [
				...graph.getModuleById(`\0${rawSpecifier(main)}`)!
					.importedModules,
			].map((node) => node.id)

			// A served Module imports another by the id `?raw` would reach.
			expect(rawImports).toContain(`\0${rawSpecifier(math)}`)
			// Every source is an edge of the graph, which carries an edit up.
			expect(rawImports).toContain(math)
			expect(rawImports).toContain(main)
		} finally {
			await server.close()
		}
	})

	// An edit invalidates the edited Module and everything importing it, and
	// the edit is served. The wrapper's text is unchanged, since its boundary is.
	it("invalidates along the import graph, and serves the edit", async () => {
		let root = squaringProject()
		let server = await serve(root)

		try {
			let main = path.join(root, "src", "Main.es")
			let math = path.join(root, "src", "Math.es")
			let wrapperBefore = await transformed(server, "/src/Main.es")
			let rawMainBefore = await transformed(server, rawUrl(main))
			let rawMathBefore = await transformed(server, rawUrl(math))
			let preludeBefore = await transformed(server, PRELUDE_URL)

			expect(rawMathBefore).not.toContain("Integer.sum")

			writeFileSync(
				math,
				MATH_MODULE("value::multiply(with value)::add(1)"),
			)
			await changed(server, math)

			// Invalidated along the path to the entry, but not the prelude.
			expect(transformResult(server, `\0${rawSpecifier(math)}`)).toBe(
				null,
			)
			expect(transformResult(server, `\0${rawSpecifier(main)}`)).toBe(
				null,
			)
			expect(transformResult(server, main)).toBe(null)
			expect(transformResult(server, "\0essence-prelude")).not.toBe(null)

			let rawMathAfter = await transformed(server, rawUrl(math))
			let rawMainAfter = await transformed(server, rawUrl(main))
			let wrapperAfter = await transformed(server, "/src/Main.es")

			expect(rawMathAfter).toContain("Integer.sum")
			// The entry's Module is served again, byte for byte the same.
			expect(withoutTimestamps(rawMainAfter)).toBe(rawMainBefore)
			expect(withoutTimestamps(wrapperAfter)).toBe(wrapperBefore)
			expect(await transformed(server, PRELUDE_URL)).toBe(preludeBefore)
		} finally {
			await server.close()
		}
	})

	// A request the broken edit reaches fails with the compiler's report, and
	// the fix serves again.
	it("fails the request an edit broke, and recovers with the fix", async () => {
		let root = squaringProject()
		let server = await serve(root)

		try {
			let math = path.join(root, "src", "Math.es")

			await transformed(server, "/src/Main.es")
			await transformed(server, rawUrl(math))

			writeFileSync(math, MATH_MODULE('"not an Integer"'))
			await changed(server, math)

			let failure = await server.environments.client
				.transformRequest(rawUrl(math))
				.catch((error: unknown) => error)

			expect(failure).toBeInstanceOf(Error)
			expect((failure as Error).message).toContain(
				"[return-type-mismatch]",
			)

			writeFileSync(
				math,
				MATH_MODULE("value::multiply(with value)::add(2)"),
			)
			await changed(server, math)

			expect(await transformed(server, rawUrl(math))).toContain(
				"createInteger(2)",
			)
		} finally {
			await server.close()
		}
	})

	// The raw door asked for before any importer is analysed, when the
	// Module's node does not exist yet. See "Watch files under Vite" in
	// DEVELOPMENT.md.
	it("reaches a Module served before its importer was analysed", async () => {
		let root = squaringProject()
		let server = await serve(root)

		try {
			let math = path.join(root, "src", "Math.es")

			expect(await transformed(server, rawUrl(math))).not.toContain(
				"createInteger(2)",
			)

			writeFileSync(
				math,
				MATH_MODULE("value::multiply(with value)::add(2)"),
			)
			await changed(server, math)

			expect(transformResult(server, rawUrl(math))).toBe(null)
			expect(await transformed(server, rawUrl(math))).toContain(
				"createInteger(2)",
			)
		} finally {
			await server.close()
		}
	})

	// Only the entry whose graph reaches the edit is compiled again.
	it("leaves an entry the edit does not reach alone", async () => {
		let root = squaringProject({
			"src/Other.es": `implementation {
	constant other = 1
}

export {
	other
}
`,
		})
		let server = await serve(root)

		try {
			let main = path.join(root, "src", "Main.es")
			let math = path.join(root, "src", "Math.es")
			let other = path.join(root, "src", "Other.es")

			await transformed(server, "/src/Main.es")
			await transformed(server, "/src/Other.es")
			await transformed(server, rawUrl(other))

			writeFileSync(
				math,
				MATH_MODULE("value::multiply(with value)::add(1)"),
			)
			await changed(server, math)

			expect(transformResult(server, other)).not.toBe(null)
			expect(
				transformResult(server, `\0${rawSpecifier(other)}`),
			).not.toBe(null)
			expect(transformResult(server, main)).toBe(null)
		} finally {
			await server.close()
		}
	})
})
