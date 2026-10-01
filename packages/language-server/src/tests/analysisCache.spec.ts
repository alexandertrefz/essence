import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { canonicalPath } from "@essence-lang/compiler/documents"
import type { Hover } from "vscode-languageserver"
import {
	CodeActionRequest,
	CompletionRequest,
	DocumentSymbolRequest,
	HoverRequest,
	InlayHintRequest,
	PrepareRenameRequest,
	SemanticTokensRequest,
	ShutdownRequest,
} from "vscode-languageserver/node"

import { analyseDocument } from "../analyse"
import { compilationCounts, resetCompilationCounts } from "../compilation"
import { uriOf } from "../server"
import {
	createWorkspace,
	type OpenDocument,
	type Workspace,
} from "../workspace"
import { makeSessionWorkspace, startSession } from "./lspSession"

// What the cache and the request loop guarantee: costs only a counter can see,
// and what happens between two requests. `compilationCounts` counts the
// Compiler entry points the Server ran, and a link type-checks every Module of
// a graph.

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

// Top imports Middle, which imports Base. Editing the middle invalidates what
// depends on it, and analysing any file fills the cache for all three.
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
	from "./Base.es" { Amount }
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
	from "./Base.es" { Amount }
	Money
	averaged
}
`

const topSource = `import {
	from "./Middle.es" { Amount }
	from "./Middle.es" { Money }
	from "./Middle.es" { averaged }
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

// A Module that imports nothing and that nothing imports: a second root, and
// so a second link.
const soloSource = `implementation {\n\tconstant solo = 1\n}\n\nexport {\n\tsolo\n}\n`

// Two Modules importing each other, which nothing else imports, so neither is
// a root. `Loop.es` is broken and not chosen as the entry, so its Diagnostics
// arrive through the other member's graph.
const circleSource = `import {
	from "./Loop.es" { flagged }
}

implementation {
	function circled(_ n: Integer) -> Integer {
		<- n
	}

	function both(_ n: Integer) -> Integer {
		<- flagged(n)
	}
}

export {
	circled
	both
}
`

const loopSource = `import {
	from "./Circle.es" { circled }
}

implementation {
	constant broken: Integer = "no"

	function flagged(_ n: Integer) -> Integer {
		<- circled(n)
	}
}

export {
	flagged
	broken
}
`

const cycle = {
	"Circle.es": circleSource,
	"Loop.es": loopSource,
}

// Many roots importing one library, each linked on its own. Each root carries
// many declarations of its own, so the sweep is meant to outlast a debounce
// window and a keystroke to land mid-sweep. On a machine that drains the queue
// first, the mid-sweep specs pass without testing anything; they never fail
// falsely. Every spec built on this sets its own timeout.
function heavyFanOut(
	roots: Array<number>,
	declarations = 400,
): Record<string, string> {
	let files: Record<string, string> = {
		"Shared.es": `implementation {\n\tconstant shared = 1\n}\n\nexport {\n\tshared\n}\n`,
	}

	for (let index of roots) {
		// Two digits, so names sort in counting order. The Server analyses the
		// roots in path order, and a spec names the last of them.
		let name = String(index).padStart(2, "0")
		let filler = Array.from(
			{ length: declarations },
			(_, position) =>
				`\tfunction filled${name}n${position}(_ value: Integer) -> Integer {\n\t\t<- value::add(shared)::multiply(with ${position + 1})\n\t}`,
		).join("\n")

		files[`Root${name}.es`] =
			`import {\n\tfrom "./Shared.es" { shared }\n}\n\nimplementation {\n\tconstant seen${name} = shared\n${filler}\n}\n`
	}

	return files
}

// The same shape with a broken `Library.es`, imported by the first and the
// last root. A dependency shared by both ends of the queue is what a mid-sweep
// batch can get wrong. Every other root imports an `Other.es` of the same size,
// so the queue keeps path order.
function heavyFanOutOverALibrary(
	roots: Array<number>,
	declarations = 400,
): Record<string, string> {
	let files: Record<string, string> = {
		"Shared.es": `implementation {\n\tconstant shared = 1\n}\n\nexport {\n\tshared\n}\n`,
		"Other.es": `implementation {\n\tconstant other = 1\n}\n\nexport {\n\tother\n}\n`,
		"Library.es": `implementation {\n\tconstant broken: Integer = "one"\n\tconstant library = 1\n}\n\nexport {\n\tlibrary\n}\n`,
	}
	let last = roots[roots.length - 1]

	for (let index of roots) {
		let name = String(index).padStart(2, "0")
		let filler = Array.from(
			{ length: declarations },
			(_, position) =>
				`\tfunction filled${name}n${position}(_ value: Integer) -> Integer {\n\t\t<- value::add(shared)::multiply(with ${position + 1})\n\t}`,
		).join("\n")
		let holdsLibrary = index === roots[0] || index === last
		let second = holdsLibrary
			? `\tfrom "./Library.es" { library }`
			: `\tfrom "./Other.es" { other }`
		let held = holdsLibrary ? "library" : "other"

		files[`Root${name}.es`] =
			`import {\n\tfrom "./Shared.es" { shared }\n${second}\n}\n\nimplementation {\n\tconstant seen${name} = shared\n\tconstant held${name} = ${held}\n${filler}\n}\n`
	}

	return files
}

// Nested String interpolation deep enough to exhaust the Lexer's call stack,
// a Compiler throw an Editor's text can reach. It is far past the edge, since
// the stack left depends on the caller's depth.
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

	// The cache fills a whole component from one analysis, which is sound only
	// if a Module's Diagnostics do not depend on where the graph started.
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

	// What a Module reaches, not what the graph reaches. The Server publishes
	// these under the other files' URIs and owns them afterwards.
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
		// Collecting the annotations runs a second link, since the collector
		// opens for one Module at a time. It must keep the typed Program the
		// index was built against.
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

	// An Editor may report the same version for a document it re-opened,
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
		// The same link filled Base again. An edit invalidates the component,
		// and one link restores it.
		expect(workspace.enrichedOf(pathOf("Base.es"))).not.toBe(base!)
		expect(compilationCounts.links).toBe(relinks + 1)
	})

	// The edges are kept rather than rebuilt, so an edit invalidates a
	// component without parsing the workspace.
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
				'\tfrom "./Middle.es" { Amount }',
				'\tfrom "./Middle.es" { Amount }\n\tfrom "./Aside.es" { tag }',
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
		// Nothing was written, so the next uncancelled ask produces a complete
		// answer.
		expect(workspace.analysisOf(pathOf("Top.es"))).not.toBeNull()
		expect(workspace.enrichedOf(pathOf("Top.es"))).not.toBeNull()
	})

	// A file that writes neither section is a Program of its own everywhere,
	// even as a dependency. It has one enrichment and one Choice identity.
	it("should keep a section-less dependency's own enrichment", () => {
		let { workspace, pathOf } = workspaceOf({
			"Plain.es": `implementation {\n\tchoice Colour {\n\t\tRed\n\t\tBlue\n\t}\n}\n`,
			"Importer.es": `import {\n\tfrom "./Plain.es" { Colour }\n}\n\nimplementation {\n\tconstant chosen: Colour = #Red\n}\n`,
		})

		workspace.analysisOf(pathOf("Importer.es"))

		let plain = workspace.analysisOf(pathOf("Plain.es"))!

		expect(plain.dependencies.size).toBe(0)
		expect(plain.enrichedProgram).not.toBeNull()
	})

	// It survives an edit in the importer, since a section-less file names
	// nothing another file declares. The graph reaching it would never fill it
	// back in.
	it("should keep a section-less dependency's enrichment through an edit in the importer", () => {
		let plainSource = `implementation {\n\tchoice Colour {\n\t\tRed\n\t\tBlue\n\t}\n}\n`
		let importerSource = `import {\n\tfrom "./Plain.es" { Colour }\n}\n\nimplementation {\n\tconstant chosen: Colour = #Red\n}\n`
		let { workspace, pathOf, open } = workspaceOf({
			"Plain.es": plainSource,
			"Importer.es": importerSource,
		})

		workspace.analysisOf(pathOf("Importer.es"))

		let plain = workspace.enrichedOf(pathOf("Plain.es"))

		expect(plain).not.toBeNull()

		open("Importer.es", `${importerSource}\n`, 2)

		expect(workspace.isAnalysed(pathOf("Plain.es"))).toBe(true)

		let enriched = compilationCounts.enrichments

		expect(workspace.enrichedOf(pathOf("Plain.es"))).toBe(plain!)
		expect(compilationCounts.enrichments).toBe(enriched)

		// Its own text moving drops everything held for it.
		open("Plain.es", `${plainSource}\n`, 2)

		expect(workspace.isAnalysed(pathOf("Plain.es"))).toBe(false)
	})

	// A graph records the edge of a specifier naming a missing file too, so
	// the file appearing invalidates its importer. See "Dependency edges" in
	// packages/language-server/DEVELOPMENT.md.
	it("should invalidate an importer once the file its specifier names appears", () => {
		let { workspace, root, pathOf } = workspaceOf({
			"Importer.es": `import {\n\tfrom "./Base.es" { thing }\n}\n\nimplementation {\n\tTerminal.print(thing::toString())\n}\n`,
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

	// An edit obliges the Server to republish the dependents, not the
	// component. A sibling importing the same Module imports nothing from this
	// one.
	it("should reach a file's dependents without reaching its siblings", () => {
		let { workspace, pathOf } = workspaceOf({
			"Shared.es": `implementation {\n\tconstant shared = 1\n}\n\nexport {\n\tshared\n}\n`,
			"Left.es": `import {\n\tfrom "./Shared.es" { shared }\n}\n\nimplementation {\n\tTerminal.print(shared::toString())\n}\n`,
			"Right.es": `import {\n\tfrom "./Shared.es" { shared }\n}\n\nimplementation {\n\tTerminal.print(shared::toString())\n}\n`,
		})

		expect(workspace.dependentsOf(pathOf("Shared.es")).sort()).toEqual(
			[pathOf("Shared.es"), pathOf("Left.es"), pathOf("Right.es")].sort(),
		)
		expect(workspace.dependentsOf(pathOf("Left.es"))).toEqual([
			pathOf("Left.es"),
		])
		// The undirected walk answers with all three, since a rename through the
		// shared name reaches every file writing it.
		expect(workspace.componentOf(pathOf("Left.es")).sort()).toEqual(
			[pathOf("Shared.es"), pathOf("Left.es"), pathOf("Right.es")].sort(),
		)
	})

	// A root is a file no other file imports. The roots between them reach
	// every file of the workspace. See "Roots" in
	// packages/language-server/DEVELOPMENT.md.
	it("should answer with the files nothing imports as the roots of the workspace", () => {
		let { workspace, pathOf } = workspaceOf({
			...chain,
			"Solo.es": soloSource,
		})

		expect(workspace.roots()).toEqual(
			[pathOf("Solo.es"), pathOf("Top.es")].sort(),
		)
	})

	// No member of a cycle nobody imports is a root, so the member reaching
	// the most others is taken, and its graph covers the rest.
	it("should take the closest to a root of a cycle nobody imports", () => {
		let { workspace, pathOf } = workspaceOf({ ...chain, ...cycle })

		expect(workspace.roots()).toEqual(
			[pathOf("Circle.es"), pathOf("Top.es")].sort(),
		)
	})

	// An edit runs the roots reaching the edited file, not every root. A root
	// that does not reach it was judged against text that did not move.
	it("should answer with the roots reaching a file rather than every root", () => {
		let { workspace, pathOf } = workspaceOf({
			"Shared.es": `implementation {\n\tconstant shared = 1\n}\n\nexport {\n\tshared\n}\n`,
			"Left.es": `import {\n\tfrom "./Shared.es" { shared }\n}\n\nimplementation {\n\tTerminal.print(shared::toString())\n}\n`,
			"Right.es": `import {\n\tfrom "./Shared.es" { shared }\n}\n\nimplementation {\n\tTerminal.print(shared::toString())\n}\n`,
			"Solo.es": soloSource,
		})

		expect(workspace.roots()).toEqual(
			[pathOf("Left.es"), pathOf("Right.es"), pathOf("Solo.es")].sort(),
		)
		expect(workspace.rootsReaching([pathOf("Shared.es")])).toEqual(
			[pathOf("Left.es"), pathOf("Right.es")].sort(),
		)
		expect(workspace.rootsReaching([pathOf("Left.es")])).toEqual([
			pathOf("Left.es"),
		])
	})

	// How the Server finds what a batch was to judge and did not. It answers
	// about the file's current text without analysing anything.
	it("should say whether a file is analysed without analysing it", () => {
		let { workspace, pathOf, open } = workspaceOf(chain)

		expect(workspace.isAnalysed(pathOf("Base.es"))).toBe(false)

		let counted = compilationCounts.links

		workspace.analysisOf(pathOf("Top.es"))

		expect(workspace.isAnalysed(pathOf("Base.es"))).toBe(true)
		expect(compilationCounts.links).toBe(counted + 1)

		open("Base.es", `${baseSource}\n`, 2)

		expect(workspace.isAnalysed(pathOf("Base.es"))).toBe(false)
		expect(compilationCounts.links).toBe(counted + 1)
	})

	// A root's analysis is cached whole, so asking again for a Module beneath
	// it collects nothing. Every path that analyses a root passes the Server's
	// focus. See "Analysing a graph" in packages/language-server/DEVELOPMENT.md.
	it("should not collect a Module's annotations for a root it already analysed", () => {
		let { workspace, pathOf } = workspaceOf(chain)

		workspace.analysisOf(pathOf("Top.es"))

		let linked = compilationCounts.links

		workspace.analysisOf(pathOf("Top.es"), {
			annotationsFor: pathOf("Middle.es"),
		})

		expect(compilationCounts.links).toBe(linked)

		workspace.analysisOf(pathOf("Middle.es"), { annotations: true })

		expect(compilationCounts.links).toBe(linked + 1)
	})

	// This text makes the Lexer run out of call stack. `fileOf` is called from
	// the debounced analysis' timer callback, where a throw ends the process, so
	// it answers with a Diagnostic.
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

	// A dependency the Parser cannot read throws out of the link, into
	// `analysisOf`'s catch. The answer is kept, annotations included, so a Hover
	// does not throw again.
	it("should cache the answer for a document whose analysis threw", () => {
		let { workspace, pathOf } = workspaceOf({
			"Deep.es": `${unparseableSource}\nexport {\n\ta\n}\n`,
			"Uses.es": `import {\n\tfrom "./Deep.es" { a }\n}\n\nimplementation {\n\tTerminal.print(a)\n}\n`,
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
	// The contract the other specs here stand on. The `essence/idle` answer
	// comes behind every publish, and a Server with nothing to do answers at
	// once.
	it("should answer essence/idle behind the publish it waited for, and at once with nothing pending", async () => {
		let broken = `implementation {\n\tconstant amount: Integer = "two"\n}\n`
		let files = makeSessionWorkspace({ "Broken.es": broken })
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Broken.es"), broken)
			await session.settle()

			expect(session.codesFor(files.pathOf("Broken.es"))).toEqual([
				"assignment-type-mismatch",
			])

			let quiet = session.counts()
			let mark = session.publishMark()

			await session.settle()

			expect(session.tallySince(quiet).total).toBe(0)
			expect(session.publishesSince(mark)).toEqual([])

			await session.change(
				files.pathOf("Broken.es"),
				`implementation {\n\tconstant amount = 2\n}\n`,
			)
			await session.settle()

			expect(
				session.publishesSince(mark).map((entry) => entry.uri),
			).toEqual([uriFor(files.pathOf("Broken.es"))])
			expect(session.codesFor(files.pathOf("Broken.es"))).toEqual([])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	it("should compile nothing during a typing burst and once in the debounce window", async () => {
		let files = makeSessionWorkspace(chain)
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Middle.es"), middleSource)
			await session.open(files.pathOf("Top.es"), topSource)
			await session.settle()

			let burst = session.counts()

			for (let index = 0; index < 20; index++) {
				await session.change(
					files.pathOf("Middle.es"),
					`${middleSource}\n§ ${index}\n`,
				)
			}

			expect(session.tallySince(burst).total).toBe(0)

			let window = session.counts()

			await session.settle()

			// One link for the component, whichever open document's timer fired
			// first.
			expect(session.tallySince(window).links).toBe(1)
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// A request inside the window pays for the graph the window would link
	// anyway, the root's, not the document's own. Whoever asks first pays, once.
	it("should answer a request that arrives before the analysis, and analyse only once", async () => {
		let files = makeSessionWorkspace(chain)
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Middle.es"), middleSource)
			await session.settle()
			await session.change(
				files.pathOf("Middle.es"),
				middleSource.replace("by 2", "by 4"),
			)

			// Inside the debounce window on purpose. The Hover computes the
			// analysis, and the debounced one finds it.
			let hover = await session.request<Hover | null>(HoverRequest.type, {
				textDocument: { uri: uriFor(files.pathOf("Middle.es")) },
				position: positionOf(middleSource, "averaged(_ amount", 2),
			})

			expect(hover.result).not.toBeNull()
			expect(hover.compilations.links).toBe(1)

			let settled = session.counts()

			await session.settle()

			expect(session.tallySince(settled).links).toBe(0)
			expect(session.diagnosticsFor(files.pathOf("Middle.es"))).toEqual(
				[],
			)
			// The root nobody has open was published from the graph the Hover
			// paid for.
			expect(session.diagnosticsFor(files.pathOf("Top.es"))).toEqual([])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// The same window, from the request an Editor sends first. Semantic Tokens
	// arrive inside the window after a keystroke, so this is ordinary typing.
	it("should link once for a keystroke a Semantic Tokens request beat", async () => {
		let files = makeSessionWorkspace(chain)
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Middle.es"), middleSource)
			await session.settle()

			let counts = session.counts()

			await session.change(
				files.pathOf("Middle.es"),
				`${middleSource}\n§ typing\n`,
			)
			await session.request(SemanticTokensRequest.type, {
				textDocument: { uri: uriFor(files.pathOf("Middle.es")) },
			})
			await session.settle()

			expect(session.tallySince(counts).links).toBe(1)
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
			await session.settle()

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

			// Rename walks the component to join the symbol across Modules,
			// parsing files nobody has open. It enriches nothing, and the walk is
			// kept.
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
			await session.settle()

			let source = session.cancellationSource()
			let pending = session.request(
				SemanticTokensRequest.type,
				{
					textDocument: { uri: uriFor(files.pathOf("Middle.es")) },
				},
				source.token,
			)

			source.cancel()

			// `RequestCancelled`, the protocol's answer for a request nobody is
			// waiting for.
			await expect(pending).rejects.toMatchObject({ code: -32800 })
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// A request is answered on the version it named or not at all.
	// `ContentModified`, since vscode-languageclient throws for a
	// `RequestCancelled` whose own token is not cancelled.
	it("should abandon a request the document moved on from", async () => {
		let files = makeSessionWorkspace(chain)
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Middle.es"), middleSource)
			await session.settle()

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

	// A watched file changing schedules the roots reaching it, a new file
	// included. It costs one window and one link.
	it("should coalesce a watched file change into one window", async () => {
		let files = makeSessionWorkspace(chain)
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Base.es"), baseSource)
			await session.open(files.pathOf("Middle.es"), middleSource)
			await session.open(files.pathOf("Top.es"), topSource)
			await session.settle()

			let watched = session.counts()

			await session.watchedFileChanged([
				{ filePath: files.pathOf("Base.es"), type: 2 },
			])
			await session.settle()

			expect(session.tallySince(watched).links).toBe(1)
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// Completion reads the document's Namespaces off the cached analysis, so a
	// signature naming an imported Type prints it.
	it("should print imported Types in the Method listing of a Module", async () => {
		let files = makeSessionWorkspace(chain)
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Middle.es"), middleSource)
			await session.settle()

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

			expect(halved?.detail).toBe("() -> Amount")
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// The file binds `Sized` only as `Measurable`, so an outline that
	// wrote `Sized` would name a Protocol the file can not read.
	it("should spell a bound in the outline the way the document names its Protocol", async () => {
		let sized = [
			"implementation {",
			"\tprotocol Sized {",
			"\t\tsize() -> Integer",
			"\t}",
			"",
			"\tfunction measure <infer Item is Sized>(_ item: Item) -> Integer {",
			"\t\t<- item::size()",
			"\t}",
			"}",
			"",
			"export {",
			"\tSized",
			"\tmeasure",
			"}",
			"",
		].join("\n")
		let main = [
			"import {",
			'\tfrom "./Sized.es" {',
			"\t\tSized as Measurable",
			"\t\tmeasure",
			"\t}",
			"}",
			"",
			"implementation {",
			"\tfunction relay <infer Item is Measurable>(_ item: Item) -> Integer {",
			"\t\t<- measure(item)",
			"\t}",
			"}",
			"",
			"export {",
			"\trelay",
			"}",
			"",
		].join("\n")
		let files = makeSessionWorkspace({ "Main.es": main, "Sized.es": sized })
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Main.es"), main)
			await session.settle()

			let symbols = await session.request<
				Array<{ name: string; detail?: string }>
			>(DocumentSymbolRequest.type, {
				textDocument: { uri: uriFor(files.pathOf("Main.es")) },
			})

			expect(
				symbols.result.find((symbol) => symbol.name === "relay")
					?.detail,
			).toBe("<Item is Measurable>(_ Item) -> Integer")
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// Writing the import before creating the file is the ordinary order. Both
	// the publish and the Hover's answer must follow the new file.
	it("should re-answer an importer once the Module it names is created", async () => {
		let importerSource = `import {\n\tfrom "./Base.es" { thing }\n}\n\nimplementation {\n\tTerminal.print(thing::toString())\n}\n`
		let files = makeSessionWorkspace({ "Importer.es": importerSource })
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Importer.es"), importerSource)
			await session.settle()

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
			await session.settle()

			expect(session.codesFor(files.pathOf("Importer.es"))).toEqual([])

			let hover = await session.request<Hover | null>(HoverRequest.type, {
				textDocument: { uri: uriFor(files.pathOf("Importer.es")) },
				position: positionOf(importerSource, "{ thing }", 3),
			})

			expect(JSON.stringify(hover.result)).toContain("Integer")
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// Each file has its own deadline, so a document is analysed while another
	// is typed in. The burst waits by design, so the spec writes out the budget
	// `scripts/testBudget.ts` gives every spec. See "The debounce window" in
	// packages/language-server/DEVELOPMENT.md.
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
			await session.settle()

			await session.change(
				files.pathOf("Apart.es"),
				`implementation {\n\tconstant apart: Integer = "two"\n}\n`,
			)

			// A clock, deliberately: a burst is keystrokes arriving faster than
			// the window closes. Settling between them would let the window fire.
			for (let index = 0; index < 12; index++) {
				await session.change(
					files.pathOf("Alone.es"),
					`implementation {\n\tconstant alone = ${index}\n}\n`,
				)
				await new Promise<void>((resolve) => {
					setTimeout(resolve, 60)
				})
			}

			// Read before the burst can drain, so this is about the schedule.
			expect(session.codesFor(files.pathOf("Apart.es"))).toEqual([
				"assignment-type-mismatch",
			])
		} finally {
			await session.dispose()
			files.dispose()
		}
	}, 60_000)

	// The version the list was computed against lets a client drop a publish
	// that raced a keystroke.
	it("should name the buffer version every publish was computed against", async () => {
		let files = makeSessionWorkspace(chain)
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Middle.es"), middleSource)
			await session.settle()

			let mark = session.publishMark()

			// An edit that changes the Diagnostics, since an unchanged list is
			// never sent.
			await session.change(
				files.pathOf("Middle.es"),
				middleSource.replace(
					"amount::halved()",
					"amount::halvedAgain()",
				),
			)
			await session.settle()

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

	// A list is sent only when it differs from the last one sent to that
	// URI.
	it("should send a dependent nothing when its Diagnostics did not change", async () => {
		let files = makeSessionWorkspace(chain)
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Base.es"), baseSource)
			await session.open(files.pathOf("Middle.es"), middleSource)
			await session.open(files.pathOf("Top.es"), topSource)
			await session.settle()

			let mark = session.publishMark()
			let counts = session.counts()

			await session.change(files.pathOf("Base.es"), `${baseSource}\n`)
			await session.settle()

			// The analysis ran, and only the send was skipped.
			expect(session.tallySince(counts).links).toBeGreaterThan(0)
			expect(session.publishesSince(mark)).toEqual([])

			await session.change(
				files.pathOf("Base.es"),
				baseSource.replace("with 2", 'with "two"'),
			)
			await session.settle()

			expect(session.codesFor(files.pathOf("Base.es"))).not.toEqual([])
			expect(session.codesFor(files.pathOf("Middle.es"))).toEqual([
				"dependency-has-errors",
			])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// One Module several files import. No sibling's graph contains another's,
	// so a keystroke in one must not link them all. Here all of them are open.
	it("should link once for a keystroke however many siblings share the dependency", async () => {
		let roots = [0, 1, 2, 3, 4, 5]
		let fanIn: Record<string, string> = {
			"Shared.es": `implementation {\n\tconstant shared = 1\n}\n\nexport {\n\tshared\n}\n`,
		}

		for (let index of roots) {
			fanIn[`Root${index}.es`] =
				`import {\n\tfrom "./Shared.es" { shared }\n}\n\nimplementation {\n\tconstant seen${index} = shared\n}\n`
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

			await session.settle()

			let counts = session.counts()

			await session.change(
				files.pathOf("Root0.es"),
				`${fanIn["Root0.es"]!}\n`,
			)
			await session.settle()

			expect(session.tallySince(counts).links).toBe(1)

			// Editing what they all import does change what each means, so that
			// edit fans out.
			await session.change(
				files.pathOf("Shared.es"),
				`implementation {\n\tconstant shared: Integer = "one"\n}\n\nexport {\n\tshared\n}\n`,
			)
			await session.settle()

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

	// The same with none of the siblings open, when every sibling is a root.
	// Only the roots reaching the keystroke run.
	it("should link once for a keystroke in a leaf root nothing else is open beside", async () => {
		let siblings = [0, 1, 2, 3, 4, 5]
		let fanIn: Record<string, string> = {
			"Shared.es": `implementation {\n\tconstant shared = 1\n}\n\nexport {\n\tshared\n}\n`,
		}

		for (let index of siblings) {
			fanIn[`Root${index}.es`] =
				`import {\n\tfrom "./Shared.es" { shared }\n}\n\nimplementation {\n\tconstant seen${index} = shared\n}\n`
		}

		let files = makeSessionWorkspace(fanIn)
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Root0.es"), fanIn["Root0.es"]!)
			await session.settle()

			let counts = session.counts()

			await session.change(
				files.pathOf("Root0.es"),
				`${fanIn["Root0.es"]!}\n`,
			)
			await session.settle()

			expect(session.tallySince(counts).links).toBe(1)
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// A file writing neither Module section has its own answer and the graph's.
	// Its own is published, since every request over the file reads it. See
	// "The analysis loop" in packages/language-server/DEVELOPMENT.md.
	it("should publish a section-less dependency's own answer rather than the graph's", async () => {
		let plain = `implementation {\n\tconstant amount: Integer = "two"\n\tconstant broken = (\n}\n`
		let importer = `import {\n\tfrom "./Plain.es" { amount }\n}\n\nimplementation {\n\tconstant here = 1\n}\n`
		let files = makeSessionWorkspace({
			"Plain.es": plain,
			"Importer.es": importer,
		})
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Importer.es"), importer)
			await session.settle()

			// The graph's answer holds the syntax error and not the mismatch, so
			// a list holding both, in file order, is the file's own.
			expect(session.codesFor(files.pathOf("Plain.es"))).toEqual([
				"assignment-type-mismatch",
				"syntax-error",
			])

			let mark = session.publishMark()

			await session.change(
				files.pathOf("Importer.es"),
				`${importer}\n§ typing\n`,
			)
			await session.settle()

			expect(
				session
					.publishesSince(mark)
					.filter(
						(entry) =>
							entry.uri === uriFor(files.pathOf("Plain.es")),
					),
			).toEqual([])
			expect(session.codesFor(files.pathOf("Plain.es"))).toEqual([
				"assignment-type-mismatch",
				"syntax-error",
			])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// A section-less file reads as uncovered after every window, but nothing an
	// importer does can change it, so it is not enriched again.
	it("should not re-enrich the dependencies that write neither section", async () => {
		let plain = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
		let unfinished: Record<string, string> = {}

		for (let index of plain) {
			unfinished[`Plain${index}.es`] =
				`implementation {\n\tconstant value${index} = ${index}\n}\n`
		}

		unfinished["Plain0.es"] =
			`implementation {\n\tconstant value0: Integer = "zero"\n}\n`
		unfinished["Main.es"] =
			`import {\n${plain.map((index) => `\tvalue${index} from "./Plain${index}.es"`).join("\n")}\n}\n\nimplementation {\n\tconstant here = 1\n}\n`

		let files = makeSessionWorkspace(unfinished)
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Main.es"), unfinished["Main.es"]!)
			await session.settle()

			expect(session.codesFor(files.pathOf("Plain0.es"))).toEqual([
				"assignment-type-mismatch",
			])

			let counts = session.counts()

			await session.change(
				files.pathOf("Main.es"),
				`${unfinished["Main.es"]!}\n§ typing\n`,
			)
			await session.settle()

			expect(session.tallySince(counts).enrichments).toBe(0)
			expect(session.tallySince(counts).links).toBe(1)
			expect(session.codesFor(files.pathOf("Plain0.es"))).toEqual([
				"assignment-type-mismatch",
			])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// Closing a file hands it back to disk, and the roots reaching it run
	// again so the file's text reaches the Editor. A close clears nothing.
	it("should keep a closed Module's Diagnostics through the documents importing it", async () => {
		let broken = `implementation {\n\tconstant amount: Integer = "two"\n}\n\nexport {\n\tamount\n}\n`
		let importer = `import {\n\tfrom "./Broken.es" { amount }\n}\n\nimplementation {\n\tTerminal.print(amount::toString())\n}\n`
		let files = makeSessionWorkspace({
			"Broken.es": broken,
			"Importer.es": importer,
		})
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Importer.es"), importer)
			await session.settle()

			expect(session.codesFor(files.pathOf("Broken.es"))).toEqual([
				"assignment-type-mismatch",
			])

			await session.open(files.pathOf("Broken.es"), broken)
			await session.settle()
			await session.close(files.pathOf("Broken.es"))
			await session.settle()

			expect(session.codesFor(files.pathOf("Broken.es"))).toEqual([
				"assignment-type-mismatch",
			])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// The entry reaches the broken file only through a re-exporting facade,
	// and its own Problems say which import to follow.
	it("should report on the entry a broken Module it reaches through a re-export", async () => {
		let measure = `implementation {\n\tconstant amount: Integer = "two"\n}\n\nexport {\n\tamount\n}\n`
		let facade = `implementation {}\n\nexport {\n\tfrom "./Measure.es" { amount }\n}\n`
		let main = `import {\n\tfrom "./Facade.es" { amount }\n}\n\nimplementation {\n\tTerminal.print(amount::toString())\n}\n`
		let files = makeSessionWorkspace({
			"Facade.es": facade,
			"Main.es": main,
			"Measure.es": measure,
		})
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Main.es"), main)
			await session.settle()

			expect(session.codesFor(files.pathOf("Measure.es"))).toEqual([
				"assignment-type-mismatch",
			])
			expect(session.codesFor(files.pathOf("Facade.es"))).toEqual([
				"dependency-has-errors",
			])
			expect(session.codesFor(files.pathOf("Main.es"))).toEqual([
				"dependency-has-errors",
			])
			expect(
				session.diagnosticsFor(files.pathOf("Main.es"))?.[0]?.message,
			).toStartWith("./Facade.es has errors of its own")
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// The debounced analysis is a timer callback, and a throw out of one ends
	// the process. `unparseableSource` reaches that state.
	it("should keep answering after opening a document the Parser can not read", async () => {
		let files = makeSessionWorkspace({
			...chain,
			"Deep.es": unparseableSource,
		})
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Middle.es"), middleSource)
			await session.settle()
			await session.open(files.pathOf("Deep.es"), unparseableSource)
			await session.settle()

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

	// The window goes with the client. A closing Editor's buffers each schedule
	// an analysis, which must not fire after the connection has gone.
	it("should stop a pending analysis when the client shuts down", async () => {
		let broken = `implementation {\n\tconstant amount: Integer = "two"\n}\n`
		let files = makeSessionWorkspace({ "Broken.es": broken })
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Broken.es"), broken)
			await session.settle()

			let mark = session.publishMark()

			// An edit that moves the list, then the shutdown request. A window
			// the shutdown failed to clear would publish before the settle answers.
			await session.change(
				files.pathOf("Broken.es"),
				`implementation {\n\tconstant amount = 2\n}\n`,
			)
			await session.client.sendRequest(ShutdownRequest.type)
			await session.settle()

			expect(session.publishesSince(mark)).toEqual([])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// A file nobody opened, that nothing open imports, is reported on.
	it("should report on a file nobody opened and nothing open imports", async () => {
		let lonely = `implementation {\n\tconstant lonely: Integer = "one"\n}\n`
		let files = makeSessionWorkspace({ ...chain, "Lonely.es": lonely })
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.settle()

			expect(session.codesFor(files.pathOf("Lonely.es"))).toEqual([
				"assignment-type-mismatch",
			])
			// A file with nothing wrong is published as an empty list, which
			// tells the Problems panel it was looked at.
			expect(session.diagnosticsFor(files.pathOf("Base.es"))).toEqual([])
			expect(session.diagnosticsFor(files.pathOf("Top.es"))).toEqual([])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// A project may hold `.es` files that are not its sources. `exclude` in the
	// nearest `essence.json` names their directories, as the test walk reads it.
	const excludingCorpus = JSON.stringify({ exclude: ["corpus"] })
	const lonely = `implementation {\n\tconstant lonely: Integer = "one"\n}\n`

	it("should not report on a directory the project excludes", async () => {
		let files = makeSessionWorkspace({
			"essence.json": excludingCorpus,
			...chain,
			"corpus/Wrong.es": lonely,
		})
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.settle()

			expect(
				session.diagnosticsFor(files.pathOf("corpus/Wrong.es")),
			).toBe(undefined)
			expect(session.diagnosticsFor(files.pathOf("Top.es"))).toEqual([])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// Excluded from the walk, not from the Server. An open file is owed its
	// Diagnostics.
	it("should report on an excluded file that is open", async () => {
		let files = makeSessionWorkspace({
			"essence.json": excludingCorpus,
			...chain,
			"corpus/Wrong.es": lonely,
		})
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.settle()
			await session.open(files.pathOf("corpus/Wrong.es"), lonely)
			await session.settle()

			expect(session.codesFor(files.pathOf("corpus/Wrong.es"))).toEqual([
				"assignment-type-mismatch",
			])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// The project file is watched, so moving the boundary updates the panel
	// without a restart.
	it("should report on what the project file stops excluding", async () => {
		let files = makeSessionWorkspace({
			"essence.json": excludingCorpus,
			...chain,
			"corpus/Wrong.es": lonely,
		})
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.settle()

			expect(
				session.diagnosticsFor(files.pathOf("corpus/Wrong.es")),
			).toBe(undefined)

			writeFileSync(
				files.pathOf("essence.json"),
				JSON.stringify({ exclude: [] }),
			)
			await session.watchedFileChanged([
				{ filePath: files.pathOf("essence.json"), type: 2 },
			])
			await session.settle()

			expect(session.codesFor(files.pathOf("corpus/Wrong.es"))).toEqual([
				"assignment-type-mismatch",
			])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// A corpus that was reported on goes quiet once the project excludes it.
	// The walk runs again, and the squiggles it stops owning are cleared.
	it("should stop reporting on what the project file starts excluding", async () => {
		let files = makeSessionWorkspace({
			"essence.json": "{}",
			...chain,
			"corpus/Wrong.es": lonely,
		})
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.settle()

			expect(session.codesFor(files.pathOf("corpus/Wrong.es"))).toEqual([
				"assignment-type-mismatch",
			])

			writeFileSync(files.pathOf("essence.json"), excludingCorpus)
			await session.watchedFileChanged([
				{ filePath: files.pathOf("essence.json"), type: 2 },
			])
			await session.settle()

			expect(session.codesFor(files.pathOf("corpus/Wrong.es"))).toEqual(
				[],
			)
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// A mistake in the project file is a Warning with a span on the project
	// file. The setting falls back to its default, and the note says so.
	it("should publish what the project file could not be read as", async () => {
		let files = makeSessionWorkspace({
			"essence.json": JSON.stringify({ excludes: ["corpus"] }),
			...chain,
		})
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.settle()

			expect(session.codesFor(files.pathOf("essence.json"))).toEqual([
				"unknown-setting",
			])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// Read out of the buffer while one is open, which is why the extension
	// forwards `essence.json`. See "Project files" in
	// packages/language-server/DEVELOPMENT.md.
	it("should read an open project file out of its unsaved text", async () => {
		let files = makeSessionWorkspace({ "essence.json": "{}", ...chain })
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.settle()

			expect(session.codesFor(files.pathOf("essence.json"))).toEqual([])

			await session.open(
				files.pathOf("essence.json"),
				JSON.stringify({ excludes: ["corpus"] }),
				"jsonc",
			)
			await session.settle()

			expect(session.codesFor(files.pathOf("essence.json"))).toEqual([
				"unknown-setting",
			])

			// The file on disk answers again once the buffer is gone.
			await session.close(files.pathOf("essence.json"))
			await session.settle()

			expect(session.codesFor(files.pathOf("essence.json"))).toEqual([])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// An open project file is never treated as Essence. The one lookup every
	// request reads a buffer through refuses it.
	it("should answer no Essence request over an open project file", async () => {
		let files = makeSessionWorkspace({ "essence.json": "{}", ...chain })
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("essence.json"), "{}", "jsonc")
			await session.settle()

			let uri = uriOf(files.pathOf("essence.json"))
			let tokens = await session.request<{ data: Array<number> }>(
				SemanticTokensRequest.type,
				{ textDocument: { uri } },
			)
			let hover = await session.request<Hover | null>(HoverRequest.type, {
				textDocument: { uri },
				position: { line: 0, character: 1 },
			})

			expect(tokens.result).toEqual({ data: [] })
			expect(hover.result).toBe(null)
			expect(session.codesFor(files.pathOf("essence.json"))).toEqual([])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// Nothing is read from a `package.json`'s `essence` key. The key gets a
	// Diagnostic, since its author may believe the setting is in force.
	it("should say that a manifest's essence key has moved", async () => {
		let files = makeSessionWorkspace({
			"package.json": JSON.stringify({
				essence: { exclude: ["corpus"] },
			}),
			...chain,
			"corpus/Wrong.es": lonely,
		})
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.settle()

			expect(session.codesFor(files.pathOf("package.json"))).toEqual([
				"moved-setting",
			])
			expect(session.codesFor(files.pathOf("corpus/Wrong.es"))).toEqual([
				"assignment-type-mismatch",
			])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// A manifest changing costs the settings alone: no walk, no analysis, no
	// test run.
	it("should republish a manifest's Diagnostic without analysing anything", async () => {
		let files = makeSessionWorkspace({ ...chain })
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.settle()

			expect(session.diagnosticsFor(files.pathOf("package.json"))).toBe(
				undefined,
			)

			let before = session.counts()

			writeFileSync(
				files.pathOf("package.json"),
				JSON.stringify({ essence: { exclude: ["corpus"] } }),
			)
			await session.watchedFileChanged([
				{ filePath: files.pathOf("package.json"), type: 1 },
			])
			await session.settle()

			expect(session.codesFor(files.pathOf("package.json"))).toEqual([
				"moved-setting",
			])
			// No link. A project file changing sets the folders again and drops
			// every cached analysis, while a manifest drops the settings alone.
			expect(session.tallySince(before).links).toBe(0)
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// A whole workspace costs one link per root and nothing per file beneath
	// one. Here the chain's Top and a Module nothing imports are the roots.
	it("should link once per root at startup", async () => {
		let files = makeSessionWorkspace({ ...chain, "Solo.es": soloSource })
		let session = startSession()

		try {
			let counts = session.counts()

			await session.initialize([files.root])
			await session.settle()

			expect(session.tallySince(counts).links).toBe(2)
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// The sweep is a queue drained one root per callback, so a request is
	// answered from its middle. Each hop of the round trip costs one root, since
	// the sweep yields with `setImmediate`. See "The workspace sweep" in
	// packages/language-server/DEVELOPMENT.md.
	it("should answer a request sent while the startup sweep is still running", async () => {
		let roots = [
			0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
			19, 20, 21, 22, 23,
		]
		let fanOut = heavyFanOut(roots)
		let files = makeSessionWorkspace(fanOut)
		let session = startSession()

		try {
			let counts = session.counts()

			await session.initialize([files.root])
			// The last root of the queue, so the open document is the one the
			// sweep reaches last.
			await session.open(files.pathOf("Root23.es"), fanOut["Root23.es"]!)
			// The tally rather than a publish, since it is a counter in this
			// process. One link means the sweep has started.
			await session.waitForLinks(counts, 1)

			let hover = await session.request<Hover | null>(HoverRequest.type, {
				textDocument: { uri: uriFor(files.pathOf("Root23.es")) },
				position: positionOf(
					fanOut["Root23.es"]!,
					"filled23n0(_ value",
					2,
				),
			})

			expect(hover.result).not.toBeNull()
			// The sweep had roots left when the answer arrived.
			expect(session.tallySince(counts).links).toBeLessThan(roots.length)

			// It then covers everything it was queued for. The last root by path
			// is analysed last, so its Diagnostics mean the sweep finished.
			expect(
				await session.waitForPublishOf(files.pathOf("Root23.es"), 0),
			).toBe(true)

			expect(
				roots.map((index) =>
					session.diagnosticsFor(
						files.pathOf(
							`Root${String(index).padStart(2, "0")}.es`,
						),
					),
				),
			).toEqual(roots.map(() => []))
		} finally {
			await session.dispose()
			files.dispose()
		}
	}, 60_000)

	// A keystroke mid-sweep runs the roots reaching the change, not every
	// queued root that has never published. It is read as the most graphs one
	// turn of the loop linked, which does not depend on the machine's speed.
	it("should link only the roots reaching a keystroke made during a sweep", async () => {
		let roots = [
			0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
			19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
			36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47,
		]
		let fanOut = heavyFanOut(roots)
		let files = makeSessionWorkspace(fanOut)
		let session = startSession()

		try {
			let counts = session.counts()

			await session.initialize([files.root])
			await session.open(files.pathOf("Root00.es"), fanOut["Root00.es"]!)
			await session.waitForLinks(counts, 1)
			// Root00 is first in the queue. Its swept Diagnostics must reach the
			// client before the mark, so the wait answers to the keystroke.
			expect(
				await session.waitForPublishOf(files.pathOf("Root00.es"), 0),
			).toBe(true)

			let mark = session.publishMark()
			let bursts = session.watchLinkBursts()

			// A keystroke that moves the file's list, so its publish is not
			// deduplicated away.
			await session.change(
				files.pathOf("Root00.es"),
				fanOut["Root00.es"]!.replace(
					"constant seen00 = shared",
					'constant seen00: Integer = "one"',
				),
			)

			expect(
				await session.waitForPublishOf(files.pathOf("Root00.es"), mark),
			).toBe(true)
			// The root the keystroke reaches and the sweep's next entry land
			// between two polls, since a due timer runs before the check phase.
			expect(bursts.most()).toBeLessThanOrEqual(2)

			// The sweep finishes, and the answer to the keystroke survives it,
			// since the batch dropped Root00 from the queue.
			expect(
				await session.waitForPublishOf(files.pathOf("Root47.es"), 0),
			).toBe(true)

			bursts.stop()

			// One link per root and one for the keystroke, in any interleaving,
			// since the queue drops the root the batch analysed.
			expect(session.tallySince(counts).links).toBe(roots.length + 1)
			expect(session.codesFor(files.pathOf("Root00.es"))).toEqual([
				"assignment-type-mismatch",
			])
			expect(
				roots
					.slice(1)
					.map((index) =>
						session.diagnosticsFor(
							files.pathOf(
								`Root${String(index).padStart(2, "0")}.es`,
							),
						),
					),
			).toEqual(roots.slice(1).map(() => []))
		} finally {
			await session.dispose()
			files.dispose()
		}
	}, 60_000)

	// A dependency changing hands mid-sweep. Its new owner is still queued, so
	// the orphan is held until the sweep ends. A queue drained first makes this
	// pass without testing anything. See "Who owns a published list" in
	// packages/language-server/DEVELOPMENT.md.
	it("should keep a dependency's Diagnostics a queued root still owes", async () => {
		let roots = [
			0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
			19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
			36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47,
		]
		let fanOut = heavyFanOutOverALibrary(roots)
		let files = makeSessionWorkspace(fanOut)
		let session = startSession()

		try {
			let counts = session.counts()

			await session.initialize([files.root])
			await session.open(files.pathOf("Root00.es"), fanOut["Root00.es"]!)
			await session.waitForLinks(counts, 1)
			// Root00 is first in the queue and reaches the Library, so the
			// Library's Diagnostics are on the client before the mark.
			expect(
				await session.waitForPublishOf(files.pathOf("Library.es"), 0),
			).toBe(true)
			expect(session.codesFor(files.pathOf("Library.es"))).toEqual([
				"assignment-type-mismatch",
			])

			let mark = session.publishMark()

			// Root00 stops importing the Library, and the only other importer is
			// a root the sweep has not reached.
			await session.change(
				files.pathOf("Root00.es"),
				fanOut["Root00.es"]!.replace(
					'\tfrom "./Library.es" { library }\n',
					"",
				).replace(
					"constant held00 = library",
					"constant held00 = shared",
				),
			)

			expect(
				await session.waitForPublishOf(files.pathOf("Root00.es"), mark),
			).toBe(true)
			// Still on the client. A clear and the publish undoing it leave the
			// same state, so the log pins it.
			expect(session.codesFor(files.pathOf("Library.es"))).toEqual([
				"assignment-type-mismatch",
			])

			// And still once the new owner has run and the sweep has ended.
			expect(
				await session.waitForPublishOf(files.pathOf("Root47.es"), 0),
			).toBe(true)
			await session.settle()

			expect(session.codesFor(files.pathOf("Library.es"))).toEqual([
				"assignment-type-mismatch",
			])
			expect(
				session
					.publishesSince(mark)
					.filter(
						(entry) =>
							entry.uri === uriFor(files.pathOf("Library.es")),
					),
			).toEqual([])
		} finally {
			await session.dispose()
			files.dispose()
		}
	}, 60_000)

	// A sweep has a callback armed, so a client leaving mid-sweep must stop the
	// queue, or it publishes into a closed connection.
	it("should stop a sweep in flight when the client shuts down", async () => {
		let roots = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
		let files = makeSessionWorkspace(heavyFanOut(roots))
		let session = startSession()

		try {
			let counts = session.counts()

			await session.initialize([files.root])
			await session.waitForLinks(counts, 1)
			await session.client.sendRequest(ShutdownRequest.type)

			// After the shutdown is answered, since the response is written
			// behind every publish already sent.
			let mark = session.publishMark()

			// A queue the shutdown failed to stop would publish before the settle
			// answers.
			await session.settle()

			expect(session.publishesSince(mark)).toEqual([])
			// The sweep was unfinished, or this would prove nothing.
			expect(session.tallySince(counts).links).toBeLessThan(roots.length)
		} finally {
			await session.dispose()
			files.dispose()
		}
	}, 60_000)

	// A keystroke refreshes every root that imports what changed, open or not.
	it("should refresh an unopened dependent root when a shared Module changes", async () => {
		let shared = `implementation {\n\tconstant shared = 1\n}\n\nexport {\n\tshared\n}\n`
		let reader = `import {\n\tfrom "./Shared.es" { shared }\n}\n\nimplementation {\n\tTerminal.print(shared::toString())\n}\n`
		let files = makeSessionWorkspace({
			"Shared.es": shared,
			"Reader.es": reader,
		})
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Shared.es"), shared)
			await session.settle()

			expect(session.diagnosticsFor(files.pathOf("Reader.es"))).toEqual(
				[],
			)

			await session.change(
				files.pathOf("Shared.es"),
				`implementation {\n\tconstant shared: Integer = "one"\n}\n\nexport {\n\tshared\n}\n`,
			)
			await session.settle()

			expect(session.codesFor(files.pathOf("Reader.es"))).toEqual([
				"dependency-has-errors",
			])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// A buffer outside the workspace folders is in no root set and no graph
	// reaches it. It is an entry of its own, scheduled by what it reads.
	it("should refresh an open buffer outside the folders when what it imports changes", async () => {
		let base = `implementation {\n\tconstant thing = 1\n}\n\nexport {\n\tthing\n}\n`
		let outside = `import {\n\tfrom "../inside/Base.es" { thing }\n}\n\nimplementation {\n\tconstant seen = thing\n}\n`
		let files = makeSessionWorkspace({
			"inside/Base.es": base,
			"outside/Outside.es": outside,
		})
		let session = startSession()

		try {
			await session.initialize([path.join(files.root, "inside")])
			await session.open(files.pathOf("outside/Outside.es"), outside)
			await session.open(files.pathOf("inside/Base.es"), base)
			await session.settle()

			expect(
				session.diagnosticsFor(files.pathOf("outside/Outside.es")),
			).toEqual([])

			await session.change(
				files.pathOf("inside/Base.es"),
				`implementation {\n\tconstant thing: Integer = "one"\n}\n\nexport {\n\tthing\n}\n`,
			)
			await session.settle()

			expect(
				session.codesFor(files.pathOf("outside/Outside.es")),
			).toEqual(["dependency-has-errors"])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// A closed file's Diagnostics are what the file on disk says, so they
	// stay. Nothing imports this one.
	it("should keep the Diagnostics of a broken file nothing imports when it is closed", async () => {
		let broken = `implementation {\n\tconstant amount: Integer = "two"\n}\n`
		let files = makeSessionWorkspace({ "Broken.es": broken })
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Broken.es"), broken)
			await session.settle()

			expect(session.codesFor(files.pathOf("Broken.es"))).toEqual([
				"assignment-type-mismatch",
			])

			await session.close(files.pathOf("Broken.es"))
			await session.settle()

			expect(session.codesFor(files.pathOf("Broken.es"))).toEqual([
				"assignment-type-mismatch",
			])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// A deleted file has nothing to say, and the Server, which owned its
	// squiggles, takes them down.
	it("should clear the Diagnostics of a file that was deleted", async () => {
		let broken = `implementation {\n\tconstant amount: Integer = "two"\n}\n`
		let files = makeSessionWorkspace({ "Broken.es": broken })
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.settle()

			expect(session.codesFor(files.pathOf("Broken.es"))).toEqual([
				"assignment-type-mismatch",
			])

			rmSync(path.join(files.root, "Broken.es"))
			await session.watchedFileChanged([
				{ filePath: files.pathOf("Broken.es"), type: 3 },
			])
			await session.settle()

			expect(session.diagnosticsFor(files.pathOf("Broken.es"))).toEqual(
				[],
			)
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// Dropping an import promotes what it named to a root, which reaches nothing
	// that changed. `entriesFor` also runs a root that has never published.
	it("should keep reporting on a Module whose only importer stops importing it", async () => {
		let leaf = `implementation {\n\tconstant amount: Integer = "two"\n}\n\nexport {\n\tamount\n}\n`
		let mid = `import {\n\tfrom "./Leaf.es" { amount }\n}\n\nimplementation {\n\tconstant here = amount\n}\n\nexport {\n\there\n}\n`
		let top = `import {\n\tfrom "./Mid.es" { here }\n}\n\nimplementation {\n\tconstant top = here\n}\n`
		let files = makeSessionWorkspace({
			"Leaf.es": leaf,
			"Mid.es": mid,
			"Top.es": top,
		})
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Top.es"), top)
			await session.settle()

			expect(session.codesFor(files.pathOf("Leaf.es"))).toEqual([
				"assignment-type-mismatch",
			])

			await session.change(
				files.pathOf("Top.es"),
				`implementation {\n\tconstant top = 1\n}\n`,
			)
			await session.settle()

			// The whole subtree under the dropped edge. Leaf's Diagnostics reach
			// the Editor through Mid now.
			expect(session.codesFor(files.pathOf("Leaf.es"))).toEqual([
				"assignment-type-mismatch",
			])
			expect(session.codesFor(files.pathOf("Mid.es"))).toEqual([
				"dependency-has-errors",
			])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// The same promotion, made by a deletion. The deleted file is retired, and
	// what it owned must pass to the new root rather than be cleared.
	it("should keep reporting on a Module whose only importer was deleted", async () => {
		let leaf = `implementation {\n\tconstant amount: Integer = "two"\n}\n\nexport {\n\tamount\n}\n`
		let mid = `import {\n\tfrom "./Leaf.es" { amount }\n}\n\nimplementation {\n\tconstant here = amount\n}\n\nexport {\n\there\n}\n`
		let top = `import {\n\tfrom "./Mid.es" { here }\n}\n\nimplementation {\n\tconstant top = here\n}\n`
		let files = makeSessionWorkspace({
			"Leaf.es": leaf,
			"Mid.es": mid,
			"Top.es": top,
		})
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.settle()

			expect(session.codesFor(files.pathOf("Leaf.es"))).toEqual([
				"assignment-type-mismatch",
			])

			rmSync(path.join(files.root, "Top.es"))
			await session.watchedFileChanged([
				{ filePath: files.pathOf("Top.es"), type: 3 },
			])
			await session.settle()

			expect(session.codesFor(files.pathOf("Leaf.es"))).toEqual([
				"assignment-type-mismatch",
			])
			expect(session.codesFor(files.pathOf("Mid.es"))).toEqual([
				"dependency-has-errors",
			])
			// The deleted file itself is cleared.
			expect(session.diagnosticsFor(files.pathOf("Top.es"))).toEqual([])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// With the promoted file open. An open document a root reaches is no entry
	// of its own, so its Diagnostics belonged to the deleted importer.
	it("should keep the Diagnostics of an open Module whose only importer was deleted", async () => {
		let library = `implementation {\n\tconstant amount: Integer = "two"\n}\n\nexport {\n\tamount\n}\n`
		let main = `import {\n\tfrom "./Library.es" { amount }\n}\n\nimplementation {\n\tconstant here = amount\n}\n`
		let files = makeSessionWorkspace({
			"Library.es": library,
			"Main.es": main,
		})
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Library.es"), library)
			await session.settle()

			expect(session.codesFor(files.pathOf("Library.es"))).toEqual([
				"assignment-type-mismatch",
			])

			rmSync(path.join(files.root, "Main.es"))
			await session.watchedFileChanged([
				{ filePath: files.pathOf("Main.es"), type: 3 },
			])
			await session.settle()

			expect(session.codesFor(files.pathOf("Library.es"))).toEqual([
				"assignment-type-mismatch",
			])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// A file something starts importing stops being a root. The new owner
	// publishes the same list before the old entry retires, so nothing goes over
	// the wire.
	it("should hand a file over silently when it stops being a root", async () => {
		let library = `implementation {\n\tconstant amount: Integer = "two"\n}\n\nexport {\n\tamount\n}\n`
		let alone = `implementation {\n\tconstant here = 1\n}\n\nexport {\n\there\n}\n`
		let importing = `import {\n\tfrom "./Library.es" { amount }\n}\n\nimplementation {\n\tconstant here = amount\n}\n\nexport {\n\there\n}\n`
		let files = makeSessionWorkspace({
			"Library.es": library,
			"Main.es": alone,
		})
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.settle()

			expect(session.codesFor(files.pathOf("Library.es"))).toEqual([
				"assignment-type-mismatch",
			])

			let mark = session.publishMark()

			writeFileSync(path.join(files.root, "Main.es"), importing)
			await session.watchedFileChanged([
				{ filePath: files.pathOf("Main.es"), type: 2 },
			])
			await session.settle()

			// The importer became the only root, with the Diagnostic that says
			// it imported something broken.
			expect(session.codesFor(files.pathOf("Main.es"))).toEqual([
				"dependency-has-errors",
			])
			expect(session.codesFor(files.pathOf("Library.es"))).toEqual([
				"assignment-type-mismatch",
			])
			expect(
				session
					.publishesSince(mark)
					.filter(
						(entry) =>
							entry.uri === uriFor(files.pathOf("Library.es")),
					),
			).toEqual([])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// A file that becomes a root takes its own Diagnostics over in the same
	// batch. The clear waits until every analysis of the batch has published.
	it("should take a file over silently when it becomes a root", async () => {
		let library = `implementation {\n\tconstant amount: Integer = "two"\n}\n\nexport {\n\tamount\n}\n`
		let importing = `import {\n\tfrom "./Library.es" { amount }\n}\n\nimplementation {\n\tconstant here = amount\n}\n`
		let alone = `implementation {\n\tconstant here = 1\n}\n`
		let files = makeSessionWorkspace({
			"Library.es": library,
			"Main.es": importing,
		})
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.settle()

			expect(session.codesFor(files.pathOf("Library.es"))).toEqual([
				"assignment-type-mismatch",
			])

			let mark = session.publishMark()

			writeFileSync(path.join(files.root, "Main.es"), alone)
			await session.watchedFileChanged([
				{ filePath: files.pathOf("Main.es"), type: 2 },
			])
			await session.settle()

			expect(session.codesFor(files.pathOf("Library.es"))).toEqual([
				"assignment-type-mismatch",
			])
			expect(session.codesFor(files.pathOf("Main.es"))).toEqual([])
			expect(
				session
					.publishesSince(mark)
					.filter(
						(entry) =>
							entry.uri === uriFor(files.pathOf("Library.es")),
					),
			).toEqual([])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// A cycle nobody imports has no root, so the member reaching the most others
	// is analysed. The broken file is the other member.
	it("should report on a cycle nobody imports", async () => {
		let files = makeSessionWorkspace(cycle)
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.settle()

			expect(session.codesFor(files.pathOf("Loop.es"))).toEqual([
				"assignment-type-mismatch",
			])
			expect(session.codesFor(files.pathOf("Circle.es"))).toEqual([
				"dependency-has-errors",
			])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// A deletion can make a cycle nobody imports, so its entry is worked out
	// again rather than once at startup.
	it("should analyse a cycle that loses the file above it", async () => {
		let above = `import {\n\tfrom "./Circle.es" { circled }\n}\n\nimplementation {\n\tconstant seen = circled(1)\n}\n`
		let files = makeSessionWorkspace({ ...cycle, "Above.es": above })
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.settle()

			expect(session.codesFor(files.pathOf("Loop.es"))).toEqual([
				"assignment-type-mismatch",
			])

			rmSync(path.join(files.root, "Above.es"))
			await session.watchedFileChanged([
				{ filePath: files.pathOf("Above.es"), type: 3 },
			])
			await session.settle()

			expect(session.codesFor(files.pathOf("Loop.es"))).toEqual([
				"assignment-type-mismatch",
			])
			expect(session.codesFor(files.pathOf("Circle.es"))).toEqual([
				"dependency-has-errors",
			])
			expect(session.diagnosticsFor(files.pathOf("Above.es"))).toEqual([])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// A root the Compiler threw on judged nothing beneath it. The fallback
	// analyses the files the batch should have covered and did not.
	it("should report on the files beneath a root that could not be read", async () => {
		let deep = `${unparseableSource}\nexport {\n\ta\n}\n`
		let uses = `import {\n\tfrom "./Deep.es" { a }\n}\n\nimplementation {\n\tTerminal.print(a)\n}\n`
		let files = makeSessionWorkspace({ "Deep.es": deep, "Uses.es": uses })
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.settle()

			expect(session.codesFor(files.pathOf("Uses.es"))).toEqual([
				"internal-error",
			])
			expect(session.codesFor(files.pathOf("Deep.es"))).toEqual([
				"internal-error",
			])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// A build drops the `tests { … }` section, so the Server's Workspace types
	// it.
	it("should report on a tests section, which no build ever sees", async () => {
		let source = [
			"implementation {",
			"\tconstant one = 1",
			"}",
			"",
			"tests {",
			'\ttest "typed" {',
			"\t\texpect one",
			"\t}",
			"}",
			"",
		].join("\n")
		let files = makeSessionWorkspace({ "Typed.es": source })
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Typed.es"), source)
			await session.settle()

			expect(session.codesFor(files.pathOf("Typed.es"))).toEqual([
				"expect-not-boolean",
			])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})
})

function uriFor(filePath: string): string {
	return `file://${filePath.split("/").map(encodeURIComponent).join("/")}`
}

// A Position by what it points at, zero-based as the protocol counts. The
// sources are tab-indented, so a column counted by hand would be fragile.
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
