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

// NOTE: The plugin under a REAL dev server, rather than its hooks called by
// hand — `plugin.spec.ts` does the latter, and this file is the one place the
// claims about hot reloading are checked against what Vite actually does with
// them: which modules an edit invalidates, what is served again afterwards, and
// what happens when the edit does not compile. No browser is attached; what a
// browser would be sent is read off the module graph instead.

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

// NOTE: A project with this package installed in it — see `project` in
// `plugin.spec.ts` for why: the wrapper imports the interpreter by name and the
// served Modules import the runtime by name, and it is the host that resolves
// both.
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

// NOTE: In middleware mode with no watcher of its own — the tests say when a
// file changed, so that nothing depends on the filesystem's timing — and no
// client, since no browser is attached. Dependency optimisation is off: there
// is nothing to pre-bundle, and the scan would go looking for an `index.html`.
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

// NOTE: What Vite's own watcher does when a file changes, driven by hand: the
// watcher is a no-op one under `watch: null`, but the handlers are attached to
// it all the same, and emitting on it reaches them — `watchChange` for every
// plugin, the module graph, and then the HMR propagation. The handler is fired
// rather than awaited by the watcher, so what is waited for is the mark the
// propagation leaves behind: it ends by invalidating every module the file
// belongs to once more, as an HMR update, and that stamps each of them with
// the update's own time. A stamp from after the emit is the whole chain done —
// the plugin told, the graph invalidated, the update sent.
//
// NOTE: Waited for rather than slept through. This used to be a sleep of a
// hundred milliseconds, which was enough here and not on a loaded runner —
// where a module still holding its old transform result was served as if
// nothing had changed, and the test that expected the edit to break the build
// found it still standing.
//
// NOTE: The wait is over the modules the graph holds for the file BEFORE the
// emit, which is what the propagation reaches — a file no served module was
// compiled from is a change Vite has nothing to say about, and asking this to
// wait for it would wait forever. That is refused rather than waited on.
async function changed(server: ViteDevServer, file: string): Promise<void> {
	let modules = [
		...(server.environments.client.moduleGraph.getModulesByFile(file) ??
			[]),
	]

	if (modules.length === 0) {
		throw new Error(`No served module was compiled from ${file}.`)
	}

	// NOTE: Newer than every stamp the modules already carry, and not merely
	// the clock: Vite stamps from a monotonic clock that steps ahead of the
	// wall clock whenever it is read twice in one millisecond, so the stamp of
	// the change BEFORE this one can read as later than now — and a wait
	// keyed on now alone would answer out of it. The new stamp is read after
	// the emit, and the clock never hands out the same value twice.
	let before = Math.max(
		Date.now(),
		...modules.map((module) => module.lastHMRTimestamp + 1),
	)
	// NOTE: Under bun's own per-test timeout of five seconds, for the reason
	// `client.spec.ts` gives: a wait that gives up after the test already
	// has throws where nobody is listening, and bun reports that as a second
	// failure between tests, attributed to nothing.
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

// NOTE: Vite stamps the import of a module it just updated with `&t=<now>`,
// so that a browser fetches it afresh rather than out of its cache. That is
// the one way the text of an unchanged importer moves, and it is not a change
// to it.
function withoutTimestamps(code: string): string {
	return code.replace(/&t=\d+/g, "")
}

function transformResult(server: ViteDevServer, id: string): unknown {
	let node = server.environments.client.moduleGraph.getModuleById(id)

	expect(node).not.toBe(undefined)

	return node!.transformResult
}

// NOTE: What `transformRequest` is handed for a module no filesystem holds. A
// browser asks for `/@id/__x00__essence-raw:…`, and Vite's transform middleware
// unwraps that to the id itself before it transforms — this is that id.
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

			// NOTE: What the wrapper really imports — its Module behind the
			// raw door, and the interpreter, resolved by the host out of
			// `node_modules`.
			expect(importedIds).toContain(`\0${rawSpecifier(main)}`)
			expect(
				importedIds.some((id) => id?.endsWith("/marshal-runtime.ts")),
			).toBe(true)

			let rawMain = await transformed(server, rawUrl(main))

			// NOTE: The runtime, resolved by the host: what the Rewriter wrote
			// as `@essence-lang/runtime/Integer` is served as the file the
			// project's `node_modules` resolves it to.
			expect(rawMain).toContain("/@fs/")
			expect(rawMain).toContain("/runtime/src/Integer.ts")

			let rawImports = [
				...graph.getModuleById(`\0${rawSpecifier(main)}`)!
					.importedModules,
			].map((node) => node.id)

			// NOTE: One served Module imports another by the id the plugin
			// resolves the Rewriter's specifier to — the same id `?raw` on
			// the sibling would reach.
			expect(rawImports).toContain(`\0${rawSpecifier(math)}`)
			// NOTE: And every source it was compiled from is an edge of the
			// graph as well — that is what Vite makes of a watch file — which
			// is what carries an edit to a sibling up to the entry.
			expect(rawImports).toContain(math)
			expect(rawImports).toContain(main)
		} finally {
			await server.close()
		}
	})

	// NOTE: THE hot-reload claim. An edit to a file the entry imports
	// invalidates the served Module of that file and everything that imports
	// it — the entry's Module, the wrapper — and what is served again holds
	// the edit. The wrapper's own text is what it was: the boundary did not
	// change, so what a browser re-evaluates is a wrapper reading new Functions
	// through the same Descriptor.
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

			// NOTE: Invalidated — the transform result is gone from every node
			// on the path from the edited file to the entry, and NOT from the
			// prelude, which no edit to a source can change.
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
			// NOTE: The entry's own Module did not change — it imports
			// `square` and calls it, and both are what they were. Served again
			// because it has to be re-evaluated against the new sibling,
			// byte-identical because nothing in it moved.
			expect(withoutTimestamps(rawMainAfter)).toBe(rawMainBefore)
			expect(withoutTimestamps(wrapperAfter)).toBe(wrapperBefore)
			expect(await transformed(server, PRELUDE_URL)).toBe(preludeBefore)
		} finally {
			await server.close()
		}
	})

	// NOTE: An edit that does not compile. The next request for anything the
	// edit reaches fails with the Compiler's own report — which Vite hands to
	// the browser as an error overlay, leaving the modules it already
	// evaluated running — and the edit that fixes it serves again as if
	// nothing had happened.
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

	// NOTE: The raw door asked for FIRST, before anything that imports the
	// Module has been analysed — which is when the node the served Module
	// hangs off does not exist until its load has returned, and the files the
	// load named would be dropped with it (see `served` in the plugin). An
	// edit has to reach a Module however it was first reached; the order the
	// requests arrive in is a fact about the browser, or the machine.
	//
	// NOTE: This is the one the runner found. The wrapper's analysis warms
	// the raw Module up in the background, and on a machine fast enough that
	// warmup creates the node before a test asks for the Module — so the edge
	// was there by luck, and a loaded runner is where the luck ran out.
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

	// NOTE: Two entries, one edit. Only the entry whose graph reaches the
	// edited file is invalidated; the other keeps its transform result and is
	// not compiled again.
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
