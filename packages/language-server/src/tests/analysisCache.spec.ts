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
		// Nothing was written either, so the next uncancelled ask still
		// produces a complete answer rather than reading a half filled entry.
		expect(workspace.analysisOf(pathOf("Top.es"))).not.toBeNull()
		expect(workspace.enrichedOf(pathOf("Top.es"))).not.toBeNull()
	})

	// A file that writes neither section is a Program of its own everywhere,
	// even as a dependency, so it has one enrichment and one Choice identity.
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

		// Its own text moving is the other question, and that still drops
		// everything this holds for it.
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

	// Which Module of a graph an analysis collects annotations for is
	// decided once and never again: a root's analysis is cached whole, so asking
	// it a second time for a Module BENEATH it reads the cache rather than
	// collecting anything. The Hover that follows then pays for a link of its
	// own — which is why every path that analyses a root has to pass the focus
	// the Server is holding, the test session's results included.
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

	// Excluded from the WALK, not from the Server. A reader looking
	// straight at a file is owed its Diagnostics — what the setting declines is
	// the panel listing files nobody asked about.
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

	// The project file is watched, so a reader who has just drawn the
	// boundary somewhere else watches the panel answer rather than being told
	// to restart the editor.
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

	// And the other direction, which is the one a reader reaches for: a
	// corpus that was being reported on goes quiet the moment the project says
	// it is not a source. The discovery walk has to be answered again, and the
	// squiggles it stops owning have to be cleared rather than left standing on
	// a file nothing will ever analyse again.
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

	// A mistake in the project file is a Warning with a span, published on
	// the project file — the only place a reader would look for it. The setting
	// falls back to its default and the note says so, which is the point: a
	// setting that did not read is a setting the author believes is in force.
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

	// And out of the BUFFER while one is open, because that is the text
	// the reader is looking at. It is the whole reason the extension forwards
	// `essence.json` at all: a Diagnostic that waited for a save would arrive
	// after the mistake had already been obeyed.
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

			// And the file on disk answers again once the buffer is gone
			// — which is what the walk and the run have been obeying all along.
			await session.close(files.pathOf("essence.json"))
			await session.settle()

			expect(session.codesFor(files.pathOf("essence.json"))).toEqual([])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// An open project file is never treated as Essence. Every request that
	// reads a buffer goes through one lookup and it refuses this one — otherwise
	// the Essence Parser would read JSON, and a file that is perfectly well
	// formed would fill the panel with syntax errors.
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

	// The `essence` key of a `package.json` is where these settings used
	// to live. Nothing is read from one now — the corpus it named is walked and
	// reported on — and the key is answered with a Diagnostic on itself rather
	// than with silence, because a setting the author believes is in force is
	// the failure the report exists to prevent.
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

	// A manifest changing costs the settings and nothing else: no walk, no
	// analysis, no test run. All one can say is that its `essence` key has
	// moved, and answering `bun install` with a project rebuilt from scratch
	// would make an install cost more than the install.
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
			// Not one link, which is what tells the two paths apart: a
			// PROJECT file changing sets the folders again, and that drops
			// every cached analysis, so the sweep behind it links the whole
			// workspace from scratch. A manifest drops the settings alone.
			expect(session.tallySince(before).links).toBe(0)
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// What a whole workspace costs to report on: one link per ROOT, and
	// nothing per file beneath one. Two roots here — the chain's Top, whose
	// graph holds Middle and Base, and a Module nothing imports.
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

	// The sweep is a QUEUE, drained one root per callback, and this is what
	// that buys: a request sent while it is running is answered out of the middle
	// of it rather than after the last root. Before the chunking, an Editor that
	// opened a project of two dozen test files asked its first Hover into a Server
	// that would not speak until two dozen graphs had been linked.
	//
	// Deterministic rather than timed, and this is the argument. The sweep hands
	// the loop back between two roots — `setImmediate`, a macrotask, so a turn of
	// the loop separates them and the connection's I/O runs in it — and a request
	// is I/O. Every hop of the round trip is one such turn and therefore costs
	// ONE root, whatever a root happens to cost: reading the request, the
	// `yieldToConnection` the handler makes before it compiles, the answer coming
	// back. That is a handful of roots, and it does not grow with the queue —
	// which is the whole difference, since the single callback it replaced cost
	// every root that was left.
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
			// The LAST root of the queue, so that the document the reader
			// is looking at is the one the sweep would get to last — which is the
			// case the chunking is for.
			await session.open(files.pathOf("Root23.es"), fanOut["Root23.es"]!)
			// The tally rather than a publish, because the tally is a
			// counter in this process and a publish has a pipe between it and
			// the fact it reports. One link is the sweep having started, read at
			// the moment it starts.
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
			// Which is to say the sweep had roots left when the answer
			// arrived. Unchunked, this is exactly the count of the roots: the
			// batch was one callback, and nothing was answered until it returned.
			expect(session.tallySince(counts).links).toBeLessThan(roots.length)

			// And it goes on to cover everything it was queued for — being
			// interruptible is not being abandoned. The last root by path is the
			// last one analysed, so its Diagnostics arriving is the sweep having
			// finished.
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

	// A keystroke mid-sweep, which is the interleaving the queue could have
	// got wrong. `entriesFor` adds every root that has never published, so that a
	// file PROMOTED to one is found — and mid-sweep every root still queued has
	// published nothing, so an unguarded scan reads the whole remaining project
	// as newly promoted and pulls it into the batch the reader is waiting on,
	// which is the one callback the chunking exists to break up. What the batch
	// owes is the roots reaching the change; the rest are owed to the queue,
	// which will reach them.
	//
	// Read as the most graphs any ONE turn of the loop linked rather than as a
	// total at the moment the answer arrives, and this is why. The total is the
	// drain rate racing the 200 ms window: it is a number about the machine, it
	// says nothing at all on one that empties the queue inside that window, and
	// asserting it stays under the count of the roots is asserting that a link
	// stays expensive. What the batch swallowing the queue looks like is not a
	// bigger total — the same roots are linked either way, and only the callback
	// they are linked in differs. So the callback is what is measured, and a
	// reading of two is a reading of one root per callback whatever a root costs.
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
			// Root00 is the first root of the queue, and its swept
			// Diagnostics have to be on the client before the mark is taken —
			// otherwise the mark is behind the sweep's own publish and the wait
			// below answers to that rather than to the keystroke.
			expect(
				await session.waitForPublishOf(files.pathOf("Root00.es"), 0),
			).toBe(true)

			let mark = session.publishMark()
			let bursts = session.watchLinkBursts()

			// A keystroke that MOVES the file's list, so the publish
			// answering it is one the dedup can not swallow — it is the event the
			// burst is read at.
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
			// Two: the one root the keystroke reaches, and the sweep's next
			// entry, which land between the same two polls because a due timer
			// runs ahead of the check phase the sweep's callback waits in.
			// Swallowing the queue is not two — it is every root still owed,
			// linked inside the one callback the reader is waiting on.
			expect(bursts.most()).toBeLessThanOrEqual(2)

			// The sweep then finishes the roots it still owed, and the
			// answer to the keystroke survives it: Root00 was dropped from the
			// queue by the batch that analysed it, so nothing published it again
			// out of the text it no longer holds.
			expect(
				await session.waitForPublishOf(files.pathOf("Root47.es"), 0),
			).toBe(true)

			bursts.stop()

			// One link per root and one more for the keystroke, which is
			// the count whatever order the two of them interleaved in — the
			// queue drops the root the batch analysed rather than analysing it
			// twice, and nothing the batch reached is left for the queue to
			// discover.
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

	// A dependency changing HANDS mid-sweep, which is the other thing a
	// batch firing into a queue can get wrong. A URI is cleared once no entry
	// still reports on it, and what answers that question is what has PUBLISHED
	// — mid-queue a fraction of the project. So the keystroke that takes the
	// Library away from the file the reader is in leaves it owned by a root at
	// the far end of the queue that has published nothing yet, and clearing it
	// on that answer is a squiggle going out and coming back a project's worth of
	// roots later, in a file nobody touched.
	//
	// Read off the wire and off nothing else: under the rule the Library's list
	// never moves, so the dedup sends nothing for it at all, and the flicker is
	// two messages the log holds whatever order they land in. Sized like the
	// keystroke test above and for the same reason — the last root has to still
	// be queued when the window fires — and it fails the way that one does if it
	// is not, by saying nothing rather than by saying something false.
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
			// Root00 is the first root of the queue and the Library is in
			// its graph, so the Library's own Diagnostics are on the client
			// before the mark — which is what makes every publish after it one
			// this keystroke caused.
			expect(
				await session.waitForPublishOf(files.pathOf("Library.es"), 0),
			).toBe(true)
			expect(session.codesFor(files.pathOf("Library.es"))).toEqual([
				"assignment-type-mismatch",
			])

			let mark = session.publishMark()

			// The import taken away, which is the whole event: Root00
			// stops reporting on the Library, and the only other file importing
			// it is the root the sweep has not reached.
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
			// Still on the client — though it is the log below that pins
			// it. A clear and the publish that undoes it leave the same state
			// behind, and only the messages tell the two apart.
			expect(session.codesFor(files.pathOf("Library.es"))).toEqual([
				"assignment-type-mismatch",
			])

			// And still, once the root that took it over has run and the
			// sweep has made every decision it was holding.
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

	// The other half of the shutdown test above. A sweep is a queue with a
	// callback armed, so a client that goes away in the middle of one leaves a
	// project's worth of roots still to analyse and to publish for — into a
	// connection that is not there, where a throw is the process rather than a
	// failed request.
	it("should stop a sweep in flight when the client shuts down", async () => {
		let roots = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
		let files = makeSessionWorkspace(heavyFanOut(roots))
		let session = startSession()

		try {
			let counts = session.counts()

			await session.initialize([files.root])
			await session.waitForLinks(counts, 1)
			await session.client.sendRequest(ShutdownRequest.type)

			// After the shutdown has been ANSWERED, which is what makes the
			// mark deterministic: the response is written behind every publish
			// the Server had already sent, so nothing that crossed the pipe
			// before it is counted as coming after.
			let mark = session.publishMark()

			// A queue the shutdown failed to stop is a queue the settle
			// waits out, and every root it had left would publish on the way.
			await session.settle()

			expect(session.publishesSince(mark)).toEqual([])
			// And the sweep really was unfinished, or this would assert
			// that a Server with nothing left to do published nothing.
			expect(session.tallySince(counts).links).toBeLessThan(roots.length)
		} finally {
			await session.dispose()
			files.dispose()
		}
	}, 60_000)

	// A keystroke refreshes every root that IMPORTS what changed, and a
	// root need not be open to be one. Under the open-document model a mistake
	// pushed into a Module from a file the reader had open simply never appeared
	// in the file that could not survive it.
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

	// The one document no root can ever stand in for: a buffer opened from
	// outside the workspace folders. No discovery walk finds it, so it is in no
	// root set, and nothing imports it, so no graph reaches it — it is an entry
	// of its own, and the only one that has to be scheduled by what it READS
	// rather than by what reads it.
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

	// A closed file's Diagnostics are still true — they are what the file
	// on disk says, and a buffer going away does not change what is written in
	// it. Nothing imports this one, so no importer could publish for it either:
	// under the open-document model closing it cleared its squiggles for the
	// rest of the session.
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

	// The other half of that. A file that is gone has nothing to say, and
	// nobody but this Server is going to take its squiggles down — it owned them
	// itself, since nothing imports it.
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

	// The mirror of a file being deleted, and the case a walk of the roots
	// REACHING a change can not see: a change that drops an import PROMOTES what
	// it named to a root, which by definition reaches nothing that changed. It
	// is what stopped being reached. Nothing else will ever schedule it — no
	// keystroke lands in a file nobody has open — while the analysis of the file
	// that let it go stops reporting on everything underneath it.
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

			// The whole subtree under the dropped edge, not only the file
			// promoted to a root: Mid is what Leaf's Diagnostics reach the
			// Editor through now.
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

	// The same promotion, made by a deletion rather than by a keystroke.
	// Here it is retirement that would clear them: the deleted file is retired
	// and everything it owned is orphaned, and what was beneath it has no other
	// claimant — so the file that is gone takes a project's squiggles with it
	// while every one of them is still true on disk.
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
			// And the file that IS gone is still cleared, which is the
			// other half of the same batch.
			expect(session.diagnosticsFor(files.pathOf("Top.es"))).toEqual([])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// And with the promoted file OPEN, which is the worst of the three: a
	// buffer the reader is looking at goes quiet while the mistake is on the
	// screen in front of them. An open document is not an entry of its own here
	// — a root's graph reaches it — so its Diagnostics belonged to the importer
	// that has just been deleted.
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

	// A file something starts importing stops being a root, and its
	// Diagnostics become the importing root's to publish. The hand-over has to
	// be silent: the new owner publishes before the old entry is retired, and
	// what the two of them say is the same list — a Module's Diagnostics depend
	// on that Module and on what it reaches and on nothing else — so nothing
	// goes over the wire for it at all.
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

			// The importer really did become the only root — it has the
			// Diagnostic that says it imported something broken.
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

	// And the other direction, which is the same requirement read
	// backwards: a file that BECOMES a root takes its own Diagnostics over, and
	// the entry that used to lend them stops reporting on it in the same batch.
	// What each of them says is the same list, so a reader watching the Problems
	// panel sees nothing happen — the clear is held back until every analysis of
	// the batch has published, and by then somebody else is answering.
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

	// A cycle nobody imports is the one shape with no root in it at all,
	// and the member reaching the most others is analysed in its place. The
	// broken file is the OTHER member: it is reported on only because the
	// entry's graph reached it.
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

	// And a cycle can be MADE by a deletion, which is where "closest to
	// root" has to be worked out again rather than once at startup: the file
	// above it was the only root either member had, and losing it leaves two
	// files importing each other and nothing else.
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

	// The coverage fallback — "closest to root we can actually analyse".
	// A root the Compiler threw on judged nothing beneath it, and every file
	// under it used to analyse itself because every file under it was open. The
	// fallback analyses the ones the batch was supposed to cover and did not, so
	// one unreadable file can not hide a project.
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

	// A build drops the `tests { … }` section, so the Editor is the only
	// thing that reports on one while it is being written. The Server's
	// Workspace types it for that reason, and this is what says so.
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

// A Position by what it points AT rather than by a line and column counted
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
