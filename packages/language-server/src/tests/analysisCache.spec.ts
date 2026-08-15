import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { canonicalPath } from "@essence-lang/compiler/documents"
import type { Hover } from "vscode-languageserver"
import {
	CodeActionRequest,
	CompletionRequest,
	HoverRequest,
	InlayHintRequest,
	PrepareRenameRequest,
	SemanticTokensRequest,
} from "vscode-languageserver/node"

import { analyseDocument } from "../analyse"
import { compilationCounts, resetCompilationCounts } from "../compilation"
import {
	createWorkspace,
	type OpenDocument,
	type Workspace,
} from "../workspace"
import { makeSessionWorkspace, startSession } from "./lspSession"

// NOTE: What the cache and the request loop around it guarantee. Half of these
// are cost invariants, and they are written as tests because they are invisible
// everywhere else: every request in this package answers correctly whether it
// compiled the document once or five times, so nothing but a counter tells the
// difference — and the difference is the whole feature. The other half are the
// things a cache can get WRONG that no per-request test can see, because they
// are properties of what happens between two requests: what an edit invalidates,
// what a document that is not being typed in is owed, and what goes on the wire.
//
// `compilationCounts` counts the Compiler entry points the Server ran. `links`
// is the expensive one: one link enriches and Type-checks every Module of a
// component.

let directories: Array<string> = []

function workspaceOf(files: Record<string, string>): {
	workspace: Workspace
	root: string
	pathOf: (name: string) => string
	open: (name: string, text: string, version: number) => void
	close: (name: string) => void
} {
	let root = canonicalPath(mkdtempSync(path.join(tmpdir(), "essence-cache-")))

	directories.push(root)

	for (let [name, contents] of Object.entries(files)) {
		let filePath = path.join(root, name)

		mkdirSync(path.dirname(filePath), { recursive: true })
		writeFileSync(filePath, contents)
	}

	let pathOf = (name: string) => canonicalPath(path.join(root, name))
	let buffers = new Map<string, OpenDocument>()
	let workspace = createWorkspace({
		openDocument: (filePath) => buffers.get(filePath),
	})

	workspace.setFolders([root])

	return {
		workspace,
		root,
		pathOf,
		open: (name, text, version) => {
			buffers.set(pathOf(name), { text, version })
			workspace.changed(pathOf(name))
		},
		close: (name) => {
			buffers.delete(pathOf(name))
			workspace.changed(pathOf(name))
		},
	}
}

afterEach(() => {
	for (let directory of directories) {
		rmSync(directory, { recursive: true, force: true })
	}

	directories = []
})

// NOTE: A three file chain — Top imports Middle imports Base — because that is
// the shape every invariant here turns on: editing the middle of it has to
// invalidate what depends on it and nothing else, and analysing any of them has
// to fill the cache for all of them.
const baseSource = `implementation {
	type Amount = { cents: Integer }

	namespace Amount for Amount {
		doubled() -> Amount {
			<- { cents = @.cents::multiply(with 2) }
		}
	}
}

export {
	Amount
}
`

const middleSource = `import {
	Amount from "./Base.es"
}

implementation {
	namespace Money for Amount {
		halved() -> Amount {
			<- { cents = @.cents::divide(by 2)::round(toward #TowardZero) }
		}
	}

	function averaged(_ amount: Amount) -> Amount {
		<- amount::halved()
	}
}

export {
	Amount from "./Base.es"
	Money
	averaged
}
`

const topSource = `import {
	Amount from "./Middle.es"
	Money from "./Middle.es"
	averaged from "./Middle.es"
}

implementation {
	constant start: Amount = { cents = 250 }

	function describe(_ amount: Amount) -> Amount {
		<- averaged(amount)::halved()
	}

	Terminal.print(describe(start).cents::toString())
}
`

const chain = {
	"Base.es": baseSource,
	"Middle.es": middleSource,
	"Top.es": topSource,
}

// NOTE: Nested String interpolation, which the Lexer reads by recursing once per
// level — deep enough and it runs out of call stack, which is a Compiler throw
// reachable from a text an Editor can hold. Deliberately far past where it starts
// failing: how much stack is left depends on how deep the caller already is, and a
// test that sits near the edge would pass or fail by where it is run from.
const unparseableSource = `implementation {\n\tconstant a = ${'"{'.repeat(100000)}1${'}"'.repeat(100000)}\n}\n`

describe("the analysis cache", () => {
	it("should link once for a whole component and answer every Module of it from cache", () => {
		let { workspace, pathOf } = workspaceOf(chain)

		resetCompilationCounts()
		workspace.analysisOf(pathOf("Top.es"))

		expect(compilationCounts.links).toBe(1)

		let after = compilationCounts.links

		workspace.analysisOf(pathOf("Middle.es"))
		workspace.analysisOf(pathOf("Base.es"))
		workspace.enrichedOf(pathOf("Middle.es"))
		workspace.indexOf(pathOf("Base.es"))

		expect(compilationCounts.links).toBe(after)
	})

	// NOTE: The invariant the write-through rides on. If a Module analysed
	// inside a bigger graph could differ from the same Module analysed on its
	// own, filling the cache for a whole component would be filling it with
	// answers that belong to whoever happened to ask first.
	it("should give a Module the same Diagnostics whichever Module the graph was loaded from", () => {
		let { workspace, pathOf } = workspaceOf(chain)
		let viaTop = workspace.analysisOf(pathOf("Top.es"))

		expect(viaTop).not.toBeNull()

		let fromComponent = workspace.analysisOf(pathOf("Middle.es"))!
		let onItsOwn = analyseDocument(middleSource, pathOf("Middle.es"), {
			host: workspace.host,
		})

		expect(fromComponent.diagnostics).toEqual(onItsOwn.diagnostics)
		expect([...fromComponent.dependencies.keys()].sort()).toEqual(
			[...onItsOwn.dependencies.keys()].sort(),
		)
	})

	// NOTE: What a Module reaches, not what the graph the analysis started from
	// reaches. The Server publishes these under the other files' own URIs and
	// owns them afterwards — a file this Module never names would be a squiggle
	// it can not clear.
	it("should report a Module's own dependencies rather than the whole graph's", () => {
		let { workspace, pathOf } = workspaceOf(chain)

		workspace.analysisOf(pathOf("Top.es"))

		expect(
			[
				...workspace.analysisOf(pathOf("Top.es"))!.dependencies.keys(),
			].sort(),
		).toEqual([pathOf("Base.es"), pathOf("Middle.es")].sort())
		expect([
			...workspace.analysisOf(pathOf("Middle.es"))!.dependencies.keys(),
		]).toEqual([pathOf("Base.es")])
		expect([
			...workspace.analysisOf(pathOf("Base.es"))!.dependencies.keys(),
		]).toEqual([])
	})

	it("should keep one typed Program per file and version", () => {
		let { workspace, pathOf } = workspaceOf(chain)
		let first = workspace.enrichedOf(pathOf("Middle.es"))

		expect(first).not.toBeNull()
		expect(workspace.enrichedOf(pathOf("Middle.es"))).toBe(first!)
		expect(workspace.documentOf(pathOf("Middle.es"))!.enrichedProgram).toBe(
			first!,
		)
		// NOTE: Collecting the annotations runs a SECOND link, because the
		// collector only opens for one Module at a time — and it must not swap
		// the typed Program the index was built against out from under it.
		workspace.annotationsOf(pathOf("Middle.es"))

		expect(workspace.enrichedOf(pathOf("Middle.es"))).toBe(first!)
	})

	it("should miss on a version bump and hit on the same version", () => {
		let { workspace, pathOf, open } = workspaceOf(chain)

		open("Middle.es", middleSource, 1)
		workspace.analysisOf(pathOf("Middle.es"))

		let settled = compilationCounts.links

		workspace.analysisOf(pathOf("Middle.es"))

		expect(compilationCounts.links).toBe(settled)

		open("Middle.es", `${middleSource}\n`, 2)
		workspace.analysisOf(pathOf("Middle.es"))

		expect(compilationCounts.links).toBe(settled + 1)
	})

	// NOTE: An Editor may report the same version for a document it re-opened,
	// which is why the text is compared as well as the version.
	it("should miss when a re-opened document reports a version it already used", () => {
		let { workspace, pathOf, open } = workspaceOf(chain)

		open("Middle.es", middleSource, 1)

		let firstProgram = workspace.programOf(pathOf("Middle.es"))

		open("Middle.es", middleSource.replace("halved", "halvedAgain"), 1)

		let secondProgram = workspace.programOf(pathOf("Middle.es"))

		expect(secondProgram).not.toBe(firstProgram!)
		expect(workspace.sourceOf(pathOf("Middle.es"))).toContain("halvedAgain")
	})

	it("should invalidate the whole component when the middle file changes", () => {
		let { workspace, pathOf, open } = workspaceOf(chain)

		workspace.analysisOf(pathOf("Top.es"))

		let base = workspace.enrichedOf(pathOf("Base.es"))
		let top = workspace.enrichedOf(pathOf("Top.es"))

		expect(base).not.toBeNull()
		expect(top).not.toBeNull()

		open("Middle.es", middleSource.replace("halved", "halvedAgain"), 2)

		let relinks = compilationCounts.links

		expect(workspace.enrichedOf(pathOf("Top.es"))).not.toBe(top!)
		expect(compilationCounts.links).toBe(relinks + 1)
		// NOTE: The same link filled Base again, so reading it costs nothing —
		// the component is what an edit invalidates and what one link restores.
		expect(workspace.enrichedOf(pathOf("Base.es"))).not.toBe(base!)
		expect(compilationCounts.links).toBe(relinks + 1)
	})

	// NOTE: The reason the edges are kept rather than rebuilt. This used to read
	// the entries of every known file on every keystroke, which meant a parse
	// and a `realpath` per specifier per file.
	it("should not parse the workspace to invalidate a component", () => {
		let { workspace, pathOf, open } = workspaceOf(chain)

		workspace.analysisOf(pathOf("Top.es"))
		resetCompilationCounts()

		for (let index = 0; index < 20; index++) {
			open("Middle.es", `${middleSource}\n§ ${index}\n`, index + 2)
		}

		expect(compilationCounts).toEqual({
			parses: 0,
			enrichments: 0,
			graphs: 0,
			links: 0,
		})
	})

	it("should follow an import block that changed when the exact component is asked for", () => {
		let { workspace, pathOf, open } = workspaceOf({
			...chain,
			"Aside.es": `implementation {\n\tconstant tag = "aside"\n}\n\nexport {\n\ttag\n}\n`,
		})

		expect(workspace.componentOf(pathOf("Top.es")).sort()).toEqual(
			[pathOf("Top.es"), pathOf("Middle.es"), pathOf("Base.es")].sort(),
		)

		open(
			"Top.es",
			topSource.replace(
				'\tAmount from "./Middle.es"',
				'\tAmount from "./Middle.es"\n\ttag from "./Aside.es"',
			),
			2,
		)

		expect(workspace.componentOf(pathOf("Top.es")).sort()).toEqual(
			[
				pathOf("Top.es"),
				pathOf("Middle.es"),
				pathOf("Base.es"),
				pathOf("Aside.es"),
			].sort(),
		)
	})

	it("should hold nothing for a standard library source", () => {
		let { workspace } = workspaceOf(chain)
		let stdlibPath = canonicalPath(
			path.join(
				import.meta.dir,
				"../../../standard-library/sources/String.es",
			),
		)

		expect(workspace.analysisOf(stdlibPath)).toBeNull()
		expect(workspace.documentOf(stdlibPath)).toBeNull()
	})

	it("should answer nothing rather than half an analysis when cancelled", () => {
		let { workspace, pathOf } = workspaceOf(chain)
		let cancellation = { isCancellationRequested: true }

		expect(
			workspace.analysisOf(pathOf("Top.es"), { cancellation }),
		).toBeNull()
		expect(
			workspace.documentOf(pathOf("Top.es"), { cancellation }),
		).toBeNull()
		// NOTE: Nothing was written either, so the next uncancelled ask still
		// produces a complete answer rather than reading a half filled entry.
		expect(workspace.analysisOf(pathOf("Top.es"))).not.toBeNull()
		expect(workspace.enrichedOf(pathOf("Top.es"))).not.toBeNull()
	})

	// NOTE: A file that writes neither section is a Program of its own
	// everywhere in this Server, even where a graph reaches it as a dependency —
	// two enrichments of one file with different Choice identities is the bug
	// this prevents.
	it("should keep a section-less dependency's own enrichment", () => {
		let { workspace, pathOf } = workspaceOf({
			"Plain.es": `implementation {\n\tchoice Colour {\n\t\tRed\n\t\tBlue\n\t}\n}\n`,
			"Importer.es": `import {\n\tColour from "./Plain.es"\n}\n\nimplementation {\n\tconstant chosen: Colour = #Red\n}\n`,
		})

		workspace.analysisOf(pathOf("Importer.es"))

		let plain = workspace.analysisOf(pathOf("Plain.es"))!

		expect(plain.dependencies.size).toBe(0)
		expect(plain.enrichedProgram).not.toBeNull()
	})

	// NOTE: The asymmetry the edge index used to have. A graph only holds an edge
	// it could READ, so a specifier naming a file that is not there yet recorded
	// nothing — and the importer then kept answering `Error` for that name for as
	// long as the session lasted, however many times the file was created.
	//
	// Writing an import before the file it names is the ordinary order to work in,
	// which is what makes this the worst edge to be missing.
	it("should invalidate an importer once the file its specifier names appears", () => {
		let { workspace, root, pathOf } = workspaceOf({
			"Importer.es": `import {\n\tthing from "./Base.es"\n}\n\nimplementation {\n\tTerminal.print(thing::toString())\n}\n`,
		})

		expect(
			workspace
				.analysisOf(pathOf("Importer.es"))!
				.diagnostics.map((diagnostic) => diagnostic.code),
		).toEqual(["module-not-found", "unknown-name"])

		writeFileSync(
			path.join(root, "Base.es"),
			`implementation {\n\tconstant thing = 1\n}\n\nexport {\n\tthing\n}\n`,
		)
		workspace.changed(pathOf("Base.es"))

		expect(
			workspace.analysisOf(pathOf("Importer.es"))!.diagnostics,
		).toEqual([])
	})

	// NOTE: The set an edit obliges the Server to publish again, which is the
	// dependents and not the component. A sibling importing the same Module
	// imports nothing from this one, so nothing it means can have moved — and it
	// is its own graph root, so including it costs a whole link.
	it("should reach a file's dependents without reaching its siblings", () => {
		let { workspace, pathOf } = workspaceOf({
			"Shared.es": `implementation {\n\tconstant shared = 1\n}\n\nexport {\n\tshared\n}\n`,
			"Left.es": `import {\n\tshared from "./Shared.es"\n}\n\nimplementation {\n\tTerminal.print(shared::toString())\n}\n`,
			"Right.es": `import {\n\tshared from "./Shared.es"\n}\n\nimplementation {\n\tTerminal.print(shared::toString())\n}\n`,
		})

		expect(workspace.dependentsOf(pathOf("Shared.es")).sort()).toEqual(
			[pathOf("Shared.es"), pathOf("Left.es"), pathOf("Right.es")].sort(),
		)
		expect(workspace.dependentsOf(pathOf("Left.es"))).toEqual([
			pathOf("Left.es"),
		])
		// NOTE: The undirected walk still answers with all three, because a
		// rename through the shared name has to reach every file writing it.
		expect(workspace.componentOf(pathOf("Left.es")).sort()).toEqual(
			[pathOf("Shared.es"), pathOf("Left.es"), pathOf("Right.es")].sort(),
		)
	})

	// NOTE: The Lexer recurs once per nesting level of an interpolated String and
	// runs out of call stack before the Parser's own depth guard can refuse it, so
	// this text is a Compiler throw that a buffer can actually hold. It has to come
	// back as a Diagnostic: `fileOf` is called from request handlers, from the edge
	// walk and from the debounced analysis' timer callback, and a throw out of a
	// timer callback is the process.
	it("should answer with a Diagnostic rather than throwing when a file can not be parsed", () => {
		let { workspace, pathOf } = workspaceOf({
			"Deep.es": unparseableSource,
		})

		expect(
			workspace
				.analysisOf(pathOf("Deep.es"))!
				.diagnostics.map((diagnostic) => diagnostic.code),
		).toEqual(["internal-error"])
		expect(workspace.programOf(pathOf("Deep.es"))).not.toBeNull()
		expect(workspace.componentOf(pathOf("Deep.es"))).toEqual([
			pathOf("Deep.es"),
		])
	})

	// NOTE: The graph parses its Modules through the Compiler's own path, so a
	// dependency the Parser can not read throws out of the link rather than out of
	// `fileOf` — into `analysisOf`'s catch, whose whole point is that the answer is
	// KEPT. It was not, for the one field a Hover reads: the guard re-enters
	// whenever the annotations are still null, so every Hover re-threw.
	it("should cache the answer for a document whose analysis threw", () => {
		let { workspace, pathOf } = workspaceOf({
			"Deep.es": `${unparseableSource}\nexport {\n\ta\n}\n`,
			"Uses.es": `import {\n\ta from "./Deep.es"\n}\n\nimplementation {\n\tTerminal.print(a)\n}\n`,
		})

		resetCompilationCounts()

		expect(workspace.annotationsOf(pathOf("Uses.es"))).toEqual([])
		expect(compilationCounts.graphs).toBe(1)
		expect(
			workspace
				.analysisOf(pathOf("Uses.es"))!
				.diagnostics.map((diagnostic) => diagnostic.code),
		).toEqual(["internal-error"])

		let attempted = compilationCounts.graphs

		workspace.annotationsOf(pathOf("Uses.es"))
		workspace.annotationsOf(pathOf("Uses.es"))

		expect(compilationCounts.graphs).toBe(attempted)
	})
})

describe("the Server's request loop", () => {
	it("should compile nothing during a typing burst and once in the debounce window", async () => {
		let files = makeSessionWorkspace(chain)
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Middle.es"), middleSource)
			await session.open(files.pathOf("Top.es"), topSource)
			await session.settle(600)

			let burst = session.counts()

			for (let index = 0; index < 20; index++) {
				await session.change(
					files.pathOf("Middle.es"),
					`${middleSource}\n§ ${index}\n`,
				)
			}

			expect(session.tallySince(burst).total).toBe(0)

			let window = session.counts()

			await session.settle(600)

			// NOTE: One link for the component, whichever of the two open
			// documents' timers happened to fire first — the other reads it.
			expect(session.tallySince(window).links).toBe(1)
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	it("should answer a request that arrives before the analysis, and analyse only once", async () => {
		let files = makeSessionWorkspace(chain)
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Middle.es"), middleSource)
			await session.settle(600)
			await session.change(
				files.pathOf("Middle.es"),
				middleSource.replace("by 2", "by 4"),
			)

			// NOTE: Inside the debounce window on purpose: the Hover computes
			// the analysis itself, and the debounced one that follows finds it.
			let hover = await session.request<Hover | null>(HoverRequest.type, {
				textDocument: { uri: uriFor(files.pathOf("Middle.es")) },
				position: positionOf(middleSource, "averaged(_ amount", 2),
			})

			expect(hover.result).not.toBeNull()
			expect(hover.compilations.links).toBe(1)

			let settled = session.counts()

			await session.settle(600)

			expect(session.tallySince(settled).links).toBe(0)
			expect(session.diagnosticsFor(files.pathOf("Middle.es"))).toEqual(
				[],
			)
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	it("should answer the everyday requests without compiling anything", async () => {
		let files = makeSessionWorkspace(chain)
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Middle.es"), middleSource)
			await session.settle(600)

			let uri = uriFor(files.pathOf("Middle.es"))
			let requests = [
				await session.request(HoverRequest.type, {
					textDocument: { uri },
					position: positionOf(middleSource, "averaged(_ amount", 2),
				}),
				await session.request(SemanticTokensRequest.type, {
					textDocument: { uri },
				}),
				await session.request(InlayHintRequest.type, {
					textDocument: { uri },
					range: {
						start: { line: 0, character: 0 },
						end: { line: 40, character: 0 },
					},
				}),
				await session.request(CodeActionRequest.type, {
					textDocument: { uri },
					range: {
						start: positionOf(middleSource, "averaged(_ amount"),
						end: positionOf(middleSource, "averaged(_ amount"),
					},
					context: { diagnostics: [] },
				}),
			]

			expect(
				requests.map(
					(entry) =>
						entry.compilations.links +
						entry.compilations.enrichments,
				),
			).toEqual([0, 0, 0, 0])

			// NOTE: Rename is the one request that reads the WORKSPACE rather
			// than the document: it walks the component to join the symbol
			// across Modules, which parses the files nobody has open. It
			// enriches nothing, and the walk is kept, so asking twice costs
			// nothing at all.
			await session.request(PrepareRenameRequest.type, {
				textDocument: { uri },
				position: positionOf(middleSource, "averaged(_ amount", 2),
			})

			let again = await session.request(PrepareRenameRequest.type, {
				textDocument: { uri },
				position: positionOf(middleSource, "averaged(_ amount", 2),
			})

			expect(again.compilations.total).toBe(0)
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	it("should abandon a request the Editor cancelled", async () => {
		let files = makeSessionWorkspace(chain)
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Middle.es"), middleSource)
			await session.settle(600)

			let source = session.cancellationSource()
			let pending = session.request(
				SemanticTokensRequest.type,
				{
					textDocument: { uri: uriFor(files.pathOf("Middle.es")) },
				},
				source.token,
			)

			source.cancel()

			// NOTE: `RequestCancelled` — the protocol's own answer for a request
			// nobody is waiting for any more.
			await expect(pending).rejects.toMatchObject({ code: -32800 })
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// NOTE: A request is answered on the version it named or not at all. Its
	// Positions belong to that version, and an answer measured against a later
	// one points at whatever moved into their place.
	//
	// `ContentModified` rather than `RequestCancelled`, because the Editor never
	// asked for this to stop: vscode-languageclient answers a `ContentModified`
	// with the request's default value and THROWS a CancellationError for a
	// `RequestCancelled` whose own token is not cancelled.
	it("should abandon a request the document moved on from", async () => {
		let files = makeSessionWorkspace(chain)
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Middle.es"), middleSource)
			await session.settle(600)

			let pending = session.request(SemanticTokensRequest.type, {
				textDocument: { uri: uriFor(files.pathOf("Middle.es")) },
			})

			await session.change(
				files.pathOf("Middle.es"),
				`${middleSource}\n§ moved on\n`,
			)

			await expect(pending).rejects.toMatchObject({ code: -32801 })
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// NOTE: A watched file changing re-analyses every open document, because a
	// file that did not exist a moment ago is what an unresolved import was
	// waiting for. N documents scheduled must still be one link.
	it("should coalesce a watched file change across every open document", async () => {
		let files = makeSessionWorkspace(chain)
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Base.es"), baseSource)
			await session.open(files.pathOf("Middle.es"), middleSource)
			await session.open(files.pathOf("Top.es"), topSource)
			await session.settle(800)

			let watched = session.counts()

			await session.watchedFileChanged([
				{ filePath: files.pathOf("Base.es"), type: 2 },
			])
			await session.settle(800)

			expect(session.tallySince(watched).links).toBe(1)
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// NOTE: The Completion list used to enrich the document WITHOUT its graph to
	// find the Namespaces it declares, so every signature naming an imported Type
	// printed `Error`. Reading the cache fixed it, which is why this is pinned
	// here rather than left as a happy accident.
	it("should print imported Types in the Method listing of a Module", async () => {
		let files = makeSessionWorkspace(chain)
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Middle.es"), middleSource)
			await session.settle(600)

			let completion = await session.request<
				Array<{ label: string; detail?: string }>
			>(CompletionRequest.type, {
				textDocument: { uri: uriFor(files.pathOf("Middle.es")) },
				position: positionOf(
					middleSource,
					"amount::halved",
					"amount::".length,
				),
			})
			let halved = completion.result.find(
				(entry) => entry.label === "halved",
			)

			expect(halved?.detail).toBe("() -> { cents: Integer }")
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// NOTE: Writing the import first and creating the file second is the ordinary
	// order to work in, and it is the case an edge index built from what a graph
	// could READ can not see — the edge to a file that is not there is the one
	// nothing records. Both halves are checked, because a stale publish and a
	// stale ANSWER are different failures: the Hover said `Error` about a name
	// that resolves.
	it("should re-answer an importer once the Module it names is created", async () => {
		let importerSource = `import {\n\tthing from "./Base.es"\n}\n\nimplementation {\n\tTerminal.print(thing::toString())\n}\n`
		let files = makeSessionWorkspace({ "Importer.es": importerSource })
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Importer.es"), importerSource)
			await session.settle(600)

			expect(session.codesFor(files.pathOf("Importer.es"))).toEqual([
				"module-not-found",
				"unknown-name",
			])

			writeFileSync(
				path.join(files.root, "Base.es"),
				`implementation {\n\tconstant thing = 1\n}\n\nexport {\n\tthing\n}\n`,
			)
			await session.watchedFileChanged([
				{ filePath: files.pathOf("Base.es"), type: 1 },
			])
			await session.settle(600)

			expect(session.codesFor(files.pathOf("Importer.es"))).toEqual([])

			let hover = await session.request<Hover | null>(HoverRequest.type, {
				textDocument: { uri: uriFor(files.pathOf("Importer.es")) },
				position: positionOf(importerSource, "\tthing from", 1),
			})

			expect(JSON.stringify(hover.result)).toContain("Integer")
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// NOTE: One timer restarted by every keystroke is a document that is never
	// analysed while another one is being typed in. Nothing here is stale-wrong —
	// it is simply never published, for as long as the typing goes on.
	it("should analyse a document nobody is typing in during a burst elsewhere", async () => {
		let apart = {
			"Alone.es": `implementation {\n\tconstant alone = 1\n}\n`,
			"Apart.es": `implementation {\n\tconstant apart = 2\n}\n`,
		}
		let files = makeSessionWorkspace(apart)
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Alone.es"), apart["Alone.es"])
			await session.open(files.pathOf("Apart.es"), apart["Apart.es"])
			await session.settle(600)

			await session.change(
				files.pathOf("Apart.es"),
				`implementation {\n\tconstant apart: Integer = "two"\n}\n`,
			)

			for (let index = 0; index < 12; index++) {
				await session.change(
					files.pathOf("Alone.es"),
					`implementation {\n\tconstant alone = ${index}\n}\n`,
				)
				await session.settle(60)
			}

			// NOTE: Read before the burst is given any time to drain, which is
			// what makes this about the schedule rather than about the analysis.
			expect(session.codesFor(files.pathOf("Apart.es"))).toEqual([
				"assignment-type-mismatch",
			])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// NOTE: The version the list was computed against, which is what lets a client
	// throw away a publish that raced a keystroke — the exact window a debounce
	// widens. Free to send, since the analysis is always of the current buffer.
	it("should name the buffer version every publish was computed against", async () => {
		let files = makeSessionWorkspace(chain)
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Middle.es"), middleSource)
			await session.settle(600)

			let mark = session.publishMark()

			// NOTE: An edit that changes the Diagnostics, since one that does not
			// is deliberately never sent.
			await session.change(
				files.pathOf("Middle.es"),
				middleSource.replace(
					"amount::halved()",
					"amount::halvedAgain()",
				),
			)
			await session.settle(600)

			let published = session
				.publishesSince(mark)
				.filter(
					(entry) => entry.uri === uriFor(files.pathOf("Middle.es")),
				)

			expect(published.length).toBeGreaterThan(0)
			expect(published.every((entry) => entry.version === 2)).toBe(true)
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// NOTE: Refreshing a dependent whose meaning moved is why a batch is expanded
	// to them at all; sending one a list it already has is a wire message and a
	// client-side rebuild for a file the reader is not even in.
	it("should send a dependent nothing when its Diagnostics did not change", async () => {
		let files = makeSessionWorkspace(chain)
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Base.es"), baseSource)
			await session.open(files.pathOf("Middle.es"), middleSource)
			await session.open(files.pathOf("Top.es"), topSource)
			await session.settle(800)

			let mark = session.publishMark()
			let counts = session.counts()

			await session.change(files.pathOf("Base.es"), `${baseSource}\n`)
			await session.settle(800)

			// NOTE: The analysis really ran — this is the send being skipped, not
			// the work.
			expect(session.tallySince(counts).links).toBeGreaterThan(0)
			expect(session.publishesSince(mark)).toEqual([])

			await session.change(
				files.pathOf("Base.es"),
				baseSource.replace("with 2", 'with "two"'),
			)
			await session.settle(800)

			expect(session.codesFor(files.pathOf("Base.es"))).not.toEqual([])
			expect(session.codesFor(files.pathOf("Middle.es"))).toEqual([
				"dependency-has-errors",
			])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// NOTE: A fan-in — one Module several files import — is the ordinary shape of
	// a workspace, and it is the one the undirected component gets wrong: no
	// sibling's graph contains another's, so every open sibling paid for its own
	// link on every keystroke in any of them.
	it("should link once for a keystroke however many siblings share the dependency", async () => {
		let roots = [0, 1, 2, 3, 4, 5]
		let fanIn: Record<string, string> = {
			"Shared.es": `implementation {\n\tconstant shared = 1\n}\n\nexport {\n\tshared\n}\n`,
		}

		for (let index of roots) {
			fanIn[`Root${index}.es`] =
				`import {\n\tshared from "./Shared.es"\n}\n\nimplementation {\n\tconstant seen${index} = shared\n}\n`
		}

		let files = makeSessionWorkspace(fanIn)
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Shared.es"), fanIn["Shared.es"]!)

			for (let index of roots) {
				await session.open(
					files.pathOf(`Root${index}.es`),
					fanIn[`Root${index}.es`]!,
				)
			}

			await session.settle(1000)

			let counts = session.counts()

			await session.change(
				files.pathOf("Root0.es"),
				`${fanIn["Root0.es"]!}\n`,
			)
			await session.settle(800)

			expect(session.tallySince(counts).links).toBe(1)

			// NOTE: The other direction still fans out, which is the point of
			// expanding a batch at all: editing what they all import DOES change
			// what every one of them means.
			await session.change(
				files.pathOf("Shared.es"),
				`implementation {\n\tconstant shared: Integer = "one"\n}\n\nexport {\n\tshared\n}\n`,
			)
			await session.settle(1000)

			expect(
				roots.map((index) =>
					session.codesFor(files.pathOf(`Root${index}.es`)),
				),
			).toEqual(roots.map(() => ["dependency-has-errors"]))
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// NOTE: Closing a file hands its Diagnostics back to the Modules that import
	// it, and one of them has to RUN for that to reach the Editor — no keystroke
	// is going to land in a file the reader just closed. Without it a Module
	// closed while broken keeps its squiggles cleared for the rest of the session.
	it("should keep a closed Module's Diagnostics through the documents importing it", async () => {
		let broken = `implementation {\n\tconstant amount: Integer = "two"\n}\n\nexport {\n\tamount\n}\n`
		let importer = `import {\n\tamount from "./Broken.es"\n}\n\nimplementation {\n\tTerminal.print(amount::toString())\n}\n`
		let files = makeSessionWorkspace({
			"Broken.es": broken,
			"Importer.es": importer,
		})
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Importer.es"), importer)
			await session.settle(800)

			expect(session.codesFor(files.pathOf("Broken.es"))).toEqual([
				"assignment-type-mismatch",
			])

			await session.open(files.pathOf("Broken.es"), broken)
			await session.settle(800)
			await session.close(files.pathOf("Broken.es"))
			await session.settle(800)

			expect(session.codesFor(files.pathOf("Broken.es"))).toEqual([
				"assignment-type-mismatch",
			])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// NOTE: The debounced analysis is a timer callback, and a throw out of one is
	// the process — no request left to answer, no Diagnostic, nothing in the log.
	// The Parser reaching that state is not hypothetical: see `unparseableSource`.
	it("should keep answering after opening a document the Parser can not read", async () => {
		let files = makeSessionWorkspace({
			...chain,
			"Deep.es": unparseableSource,
		})
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Middle.es"), middleSource)
			await session.settle(600)
			await session.open(files.pathOf("Deep.es"), unparseableSource)
			await session.settle(800)

			expect(session.codesFor(files.pathOf("Deep.es"))).toEqual([
				"internal-error",
			])

			let hover = await session.request<Hover | null>(HoverRequest.type, {
				textDocument: { uri: uriFor(files.pathOf("Middle.es")) },
				position: positionOf(middleSource, "averaged(_ amount", 2),
			})

			expect(hover.result).not.toBeNull()
		} finally {
			await session.dispose()
			files.dispose()
		}
	})
})

function uriFor(filePath: string): string {
	return `file://${filePath.split("/").map(encodeURIComponent).join("/")}`
}

// NOTE: A Position by what it points AT rather than by a line and column counted
// out by hand — these sources are tab-indented, and a counted column is a fact
// about the whitespace rather than about the name. Zero based, which is what the
// protocol speaks.
function positionOf(
	source: string,
	needle: string,
	offset = 0,
): { line: number; character: number } {
	let lines = source.split("\n")

	for (let line = 0; line < lines.length; line++) {
		let character = lines[line]!.indexOf(needle)

		if (character !== -1) {
			return { line, character: character + offset }
		}
	}

	throw new Error(`'${needle}' is not in this source`)
}
