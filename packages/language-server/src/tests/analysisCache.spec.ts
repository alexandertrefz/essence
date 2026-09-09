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
	ShutdownRequest,
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

// NOTE: A Module nothing imports and that imports nothing — a second root of
// whatever workspace it is put in, and therefore a second link.
const soloSource = `implementation {\n\tconstant solo = 1\n}\n\nexport {\n\tsolo\n}\n`

// NOTE: Two Modules importing each other, which nothing else imports: the one
// shape a dependency graph can hold that has no root at all, since neither
// member is a file with no in-edge. `Loop.es` is the broken one deliberately —
// it is the member that is NOT chosen as the entry, so its Diagnostics only
// reach the Editor because the other member's graph reached it.
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

// NOTE: The shape a project of tests has: N files importing one library, none
// of them importing another, which is N roots and therefore N links — that count
// is inherent, one graph per file nothing imports, and it is not what the sweep's
// chunking is about. What it is about is the order: analysing all of them inside
// one callback is a Server that answers nothing until the last of them is done.
//
// Each root carries a few hundred declarations of its OWN, so that linking one
// is work a clock can see. What rides on that is the pair of tests that type
// mid-sweep: they read what the loop did once the keystroke has been answered, a
// debounce window later, and a queue that had drained inside those 200 ms would
// make the reading say nothing. Cheaper roots do not make those tests faster —
// they make them need more of them. Nothing they ASSERT is a fact about the
// clock, so a machine fast enough to drain the queue leaves them saying nothing
// rather than saying something false.
//
// Every test built on this declares its own timeout. A fixture sized to outlast
// a debounce window here is several seconds of work on a slower machine, and the
// runner's default is five.
function heavyFanOut(
	roots: Array<number>,
	declarations = 400,
): Record<string, string> {
	let files: Record<string, string> = {
		"Shared.es": `implementation {\n\tconstant shared = 1\n}\n\nexport {\n\tshared\n}\n`,
	}

	for (let index of roots) {
		// NOTE: Two digits, so that the order a name sorts in is the order the
		// number counts in — the Server analyses the roots in path order, and a
		// test that waits for the last of them has to be able to name it.
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

// NOTE: The same shape with one more Module in it. `Library.es` is BROKEN, and
// the two files importing it are the FIRST root and the LAST — a dependency
// shared by two roots standing at either end of the queue, which is the case a
// batch firing mid-sweep can get wrong. Every other root imports an `Other.es`
// of the same size instead, so that every root reaches three files and the queue
// keeps path order: were the Library the only second Module, the two roots
// holding it would reach further than the rest, sort to the front, and the sweep
// would be done with both of them before anything could be typed.
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
			"Importer.es": `import {\n\tfrom "./Plain.es" { Colour }\n}\n\nimplementation {\n\tconstant chosen: Colour = #Red\n}\n`,
		})

		workspace.analysisOf(pathOf("Importer.es"))

		let plain = workspace.analysisOf(pathOf("Plain.es"))!

		expect(plain.dependencies.size).toBe(0)
		expect(plain.enrichedProgram).not.toBeNull()
	})

	// NOTE: And what is held for one survives a keystroke next door. A file
	// writing neither section can not name anything another file declares, so
	// nothing an importer does can move what it means — and an importer is what
	// it has while its own `export` block is still being written, which is the
	// state this is about. Dropping it with the component is an enrichment per
	// keystroke in the importer for as long as the file is unfinished, and the
	// graph that reaches it will never fill it back in.
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

		// NOTE: Its own text moving is the other question, and that still drops
		// everything this holds for it.
		open("Plain.es", `${plainSource}\n`, 2)

		expect(workspace.isAnalysed(pathOf("Plain.es"))).toBe(false)
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

	// NOTE: The set an edit obliges the Server to publish again, which is the
	// dependents and not the component. A sibling importing the same Module
	// imports nothing from this one, so nothing it means can have moved — and it
	// is its own graph root, so including it costs a whole link.
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
		// NOTE: The undirected walk still answers with all three, because a
		// rename through the shared name has to reach every file writing it.
		expect(workspace.componentOf(pathOf("Left.es")).sort()).toEqual(
			[pathOf("Shared.es"), pathOf("Left.es"), pathOf("Right.es")].sort(),
		)
	})

	// NOTE: The unit of analysis. A root is a file no other file imports, which
	// is where a dependency graph starts — the roots between them reach every
	// file of the workspace, so analysing those analyses all of it.
	it("should answer with the files nothing imports as the roots of the workspace", () => {
		let { workspace, pathOf } = workspaceOf({
			...chain,
			"Solo.es": soloSource,
		})

		expect(workspace.roots()).toEqual(
			[pathOf("Solo.es"), pathOf("Top.es")].sort(),
		)
	})

	// NOTE: "Closest to root", which is what a cycle nobody imports needs: no
	// member of it has the empty in-edge set a root has, so the first half of
	// the rule covers none of it. The member reaching the most others is taken
	// instead, and its graph covers the rest.
	it("should take the closest to a root of a cycle nobody imports", () => {
		let { workspace, pathOf } = workspaceOf({ ...chain, ...cycle })

		expect(workspace.roots()).toEqual(
			[pathOf("Circle.es"), pathOf("Top.es")].sort(),
		)
	})

	// NOTE: What an edit obliges the Server to run, which is never every root. A
	// root that does not reach the edited file was judged against text that did
	// not move, so re-linking it would find exactly what it found before — the
	// invariant that keeps a keystroke in a Module thirty roots share from
	// costing thirty links for the roots that merely share a dependency with it.
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

	// NOTE: How the Server finds what a batch of roots was supposed to judge and
	// did not — a root that threw, a graph that could not read one of its
	// Modules. It answers about the text the file holds NOW, and it answers
	// without producing anything: a coverage check that analysed to answer would
	// be the analysis it exists to decide against.
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

	// NOTE: Which Module of a graph an analysis collects annotations for is
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

	// NOTE: A request that arrives inside the window pays for the graph the
	// window was going to link anyway — the ROOT above this document, not the
	// document's own smaller graph. Both would otherwise be linked, since the
	// Editor asks for Semantic Tokens and a Hover in the same 200 ms in which
	// the analysis is due, and the root's graph already holds the document. Whoever
	// asks first pays, once, and that is still true now that what gets analysed
	// is a whole project rather than a tab.
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
			// NOTE: The root nobody has open was published all the same, out of
			// the graph the Hover paid for.
			expect(session.diagnosticsFor(files.pathOf("Top.es"))).toEqual([])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// NOTE: The same window, measured from the request an Editor actually sends
	// first. Semantic Tokens, Document Symbols and Code Actions all arrive
	// inside the 200 ms after a keystroke, so this is the ordinary shape of
	// typing rather than a race — and a file that is not itself a root would
	// otherwise pay for its own graph and then for the root's, every window,
	// for as long as the reader keeps typing.
	it("should link once for a keystroke a Semantic Tokens request beat", async () => {
		let files = makeSessionWorkspace(chain)
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Middle.es"), middleSource)
			await session.settle(600)

			let counts = session.counts()

			await session.change(
				files.pathOf("Middle.es"),
				`${middleSource}\n§ typing\n`,
			)
			await session.request(SemanticTokensRequest.type, {
				textDocument: { uri: uriFor(files.pathOf("Middle.es")) },
			})
			await session.settle(600)

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

	// NOTE: A watched file changing schedules the roots reaching it, and a file
	// that did not exist a moment ago is reached through the edge its importer's
	// specifier records whether or not it was there. However many files that
	// comes to, one window and one link is what it must cost.
	it("should coalesce a watched file change into one window", async () => {
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
		let importerSource = `import {\n\tfrom "./Base.es" { thing }\n}\n\nimplementation {\n\tTerminal.print(thing::toString())\n}\n`
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
				position: positionOf(importerSource, "{ thing }", 3),
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

	// NOTE: Refreshing a file whose meaning moved is why the root above it runs
	// at all; sending one the list it already has is a wire message and a
	// client-side rebuild for a file the reader is not even in — and a
	// workspace-wide analysis has one of those per file it holds.
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
	// sibling's graph contains another's, so every sibling would pay for its own
	// link on every keystroke in any of them. With all of them open, which is
	// where that cost was first paid; the test below it is the same invariant
	// with none of them open, which is where the roots could have lost it.
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

			await session.settle(1000)

			let counts = session.counts()

			await session.change(
				files.pathOf("Root0.es"),
				`${fanIn["Root0.es"]!}\n`,
			)
			await session.settle(800)

			expect(session.tallySince(counts).links).toBe(1)

			// NOTE: The other direction still fans out, which is what the roots
			// reaching a change are FOR: editing what they all import DOES
			// change what every one of them means.
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

	// NOTE: The same invariant with none of the siblings open, which is where
	// analysing a whole workspace could have lost it: every one of those files
	// is a root now, and scheduling all the roots rather than the ones REACHING
	// the keystroke would be a link apiece on every keystroke in any of them.
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
			await session.settle(1000)

			let counts = session.counts()

			await session.change(
				files.pathOf("Root0.es"),
				`${fanIn["Root0.es"]!}\n`,
			)
			await session.settle(800)

			expect(session.tallySince(counts).links).toBe(1)
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// NOTE: A file writing NEITHER Module section has TWO answers about it — its
	// own, and the one the graph reaching it made and threw away — and only one
	// of them may be published, or the Problems panel changes twice per keystroke
	// in the importer. Its own is the one that is kept: it is what every request
	// over that file reads, and it is what the reader sees when they open it.
	//
	// The state is an ordinary one. A file is section-less while its `export`
	// block is still being written, and the importer that is waiting for it is
	// already naming it.
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
			await session.settle(800)

			// NOTE: The graph's answer holds the first of these and not the
			// second, so this is the file's own.
			expect(session.codesFor(files.pathOf("Plain.es"))).toEqual([
				"syntax-error",
				"assignment-type-mismatch",
			])

			let mark = session.publishMark()

			await session.change(
				files.pathOf("Importer.es"),
				`${importer}\n§ typing\n`,
			)
			await session.settle(800)

			expect(
				session
					.publishesSince(mark)
					.filter(
						(entry) =>
							entry.uri === uriFor(files.pathOf("Plain.es")),
					),
			).toEqual([])
			expect(session.codesFor(files.pathOf("Plain.es"))).toEqual([
				"syntax-error",
				"assignment-type-mismatch",
			])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// NOTE: And answering for itself must not mean being re-analysed for ever. A
	// section-less file is one the graph deliberately holds nothing for, so it
	// reads as uncovered after every window — while nothing an importer does can
	// change what it means, since it can not name anything the importer declares.
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
			await session.settle(1200)

			expect(session.codesFor(files.pathOf("Plain0.es"))).toEqual([
				"assignment-type-mismatch",
			])

			let counts = session.counts()

			await session.change(
				files.pathOf("Main.es"),
				`${unfinished["Main.es"]!}\n§ typing\n`,
			)
			await session.settle(1200)

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

	// NOTE: Closing a file hands it back to disk, and the roots reaching it have
	// to RUN for what the FILE says to reach the Editor — no keystroke is going
	// to land in a document the reader just closed, so nothing else would ask
	// them to. Nothing is cleared by a close any more; the test below this one
	// is the half of that which nothing imports.
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

	// NOTE: The window goes with the client. A closing Editor hands every buffer
	// back to disk, and each of those schedules an analysis — one firing after
	// the connection has gone publishes into nothing, and a throw out of a timer
	// callback is the process rather than a failed request. Nothing else in this
	// file would notice: every publish is wrapped, so the analysis simply runs
	// for an Editor that is not there.
	it("should stop a pending analysis when the client shuts down", async () => {
		let broken = `implementation {\n\tconstant amount: Integer = "two"\n}\n`
		let files = makeSessionWorkspace({ "Broken.es": broken })
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Broken.es"), broken)
			await session.settle(800)

			let mark = session.publishMark()

			// NOTE: An edit that moves the list, sent inside the window and
			// followed by the shutdown request — an analysis that did fire would
			// publish, and there would be a message here to see.
			await session.change(
				files.pathOf("Broken.es"),
				`implementation {\n\tconstant amount = 2\n}\n`,
			)
			await session.client.sendRequest(ShutdownRequest.type)
			await session.settle(800)

			expect(session.publishesSince(mark)).toEqual([])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// NOTE: The whole feature, in one assertion: a file nobody opened, that
	// nothing open imports, is reported on. What the Problems panel used to hold
	// was the open documents and their dependencies, so a mistake anywhere else
	// in the project was invisible until somebody happened to open the file.
	it("should report on a file nobody opened and nothing open imports", async () => {
		let lonely = `implementation {\n\tconstant lonely: Integer = "one"\n}\n`
		let files = makeSessionWorkspace({ ...chain, "Lonely.es": lonely })
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.settle(800)

			expect(session.codesFor(files.pathOf("Lonely.es"))).toEqual([
				"assignment-type-mismatch",
			])
			// NOTE: A file with nothing wrong with it is published as an
			// explicitly empty list rather than left unmentioned, which is what
			// tells the Problems panel it has been looked at.
			expect(session.diagnosticsFor(files.pathOf("Base.es"))).toEqual([])
			expect(session.diagnosticsFor(files.pathOf("Top.es"))).toEqual([])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// NOTE: The other half of reporting on a whole project: a project holds
	// `.es` files that are not its sources — a corpus kept deliberately broken
	// is the one this repository holds — and a panel that lists those is a panel
	// nobody reads. `essence.exclude` in the nearest `package.json` is how a
	// project says which directories those are, and it is the same list the test
	// walk reads.
	it("should not report on a directory the project excludes", async () => {
		let lonely = `implementation {\n\tconstant lonely: Integer = "one"\n}\n`
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
			await session.settle(800)

			expect(
				session.diagnosticsFor(files.pathOf("corpus/Wrong.es")),
			).toBe(undefined)
			expect(session.diagnosticsFor(files.pathOf("Top.es"))).toEqual([])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// NOTE: Excluded from the WALK, not from the Server. A reader looking
	// straight at a file is owed its Diagnostics — what the setting declines is
	// the panel listing files nobody asked about.
	it("should report on an excluded file that is open", async () => {
		let lonely = `implementation {\n\tconstant lonely: Integer = "one"\n}\n`
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
			await session.settle(800)
			await session.open(files.pathOf("corpus/Wrong.es"), lonely)
			await session.settle(800)

			expect(session.codesFor(files.pathOf("corpus/Wrong.es"))).toEqual([
				"assignment-type-mismatch",
			])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// NOTE: The manifest is watched, so a reader who has just drawn the boundary
	// somewhere else watches the panel answer rather than being told to restart
	// the editor.
	it("should report on what the manifest stops excluding", async () => {
		let lonely = `implementation {\n\tconstant lonely: Integer = "one"\n}\n`
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
			await session.settle(800)

			expect(
				session.diagnosticsFor(files.pathOf("corpus/Wrong.es")),
			).toBe(undefined)

			writeFileSync(
				files.pathOf("package.json"),
				JSON.stringify({ essence: { exclude: [] } }),
			)
			await session.watchedFileChanged([
				{ filePath: files.pathOf("package.json"), type: 2 },
			])
			await session.settle(800)

			expect(session.codesFor(files.pathOf("corpus/Wrong.es"))).toEqual([
				"assignment-type-mismatch",
			])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// NOTE: What a whole workspace costs to report on: one link per ROOT, and
	// nothing per file beneath one. Two roots here — the chain's Top, whose
	// graph holds Middle and Base, and a Module nothing imports.
	it("should link once per root at startup", async () => {
		let files = makeSessionWorkspace({ ...chain, "Solo.es": soloSource })
		let session = startSession()

		try {
			let counts = session.counts()

			await session.initialize([files.root])
			await session.settle(800)

			expect(session.tallySince(counts).links).toBe(2)
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// NOTE: The sweep is a QUEUE, drained one root per callback, and this is what
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
			// NOTE: The LAST root of the queue, so that the document the reader
			// is looking at is the one the sweep would get to last — which is the
			// case the chunking is for.
			await session.open(files.pathOf("Root23.es"), fanOut["Root23.es"]!)
			// NOTE: The tally rather than a publish, because the tally is a
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
			// NOTE: Which is to say the sweep had roots left when the answer
			// arrived. Unchunked, this is exactly the count of the roots: the
			// batch was one callback, and nothing was answered until it returned.
			expect(session.tallySince(counts).links).toBeLessThan(roots.length)

			// NOTE: And it goes on to cover everything it was queued for — being
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

	// NOTE: A keystroke mid-sweep, which is the interleaving the queue could have
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
			// NOTE: Root00 is the first root of the queue, and its swept
			// Diagnostics have to be on the client before the mark is taken —
			// otherwise the mark is behind the sweep's own publish and the wait
			// below answers to that rather than to the keystroke.
			expect(
				await session.waitForPublishOf(files.pathOf("Root00.es"), 0),
			).toBe(true)

			let mark = session.publishMark()
			let bursts = session.watchLinkBursts()

			// NOTE: A keystroke that MOVES the file's list, so the publish
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
			// NOTE: Two: the one root the keystroke reaches, and the sweep's next
			// entry, which land between the same two polls because a due timer
			// runs ahead of the check phase the sweep's callback waits in.
			// Swallowing the queue is not two — it is every root still owed,
			// linked inside the one callback the reader is waiting on.
			expect(bursts.most()).toBeLessThanOrEqual(2)

			// NOTE: The sweep then finishes the roots it still owed, and the
			// answer to the keystroke survives it: Root00 was dropped from the
			// queue by the batch that analysed it, so nothing published it again
			// out of the text it no longer holds.
			expect(
				await session.waitForPublishOf(files.pathOf("Root47.es"), 0),
			).toBe(true)

			bursts.stop()

			// NOTE: One link per root and one more for the keystroke, which is
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

	// NOTE: A dependency changing HANDS mid-sweep, which is the other thing a
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
			// NOTE: Root00 is the first root of the queue and the Library is in
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

			// NOTE: The import taken away, which is the whole event: Root00
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
			// NOTE: Still on the client — though it is the log below that pins
			// it. A clear and the publish that undoes it leave the same state
			// behind, and only the messages tell the two apart.
			expect(session.codesFor(files.pathOf("Library.es"))).toEqual([
				"assignment-type-mismatch",
			])

			// NOTE: And still, once the root that took it over has run and the
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

	// NOTE: The other half of the shutdown test above. A sweep is a queue with a
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

			// NOTE: After the shutdown has been ANSWERED, which is what makes the
			// mark deterministic: the response is written behind every publish
			// the Server had already sent, so nothing that crossed the pipe
			// before it is counted as coming after.
			let mark = session.publishMark()

			await session.settle(1500)

			expect(session.publishesSince(mark)).toEqual([])
			// NOTE: And the sweep really was unfinished, or this would assert
			// that a Server with nothing left to do published nothing. The settle
			// above is several times what the roots left would have taken.
			expect(session.tallySince(counts).links).toBeLessThan(roots.length)
		} finally {
			await session.dispose()
			files.dispose()
		}
	}, 60_000)

	// NOTE: A keystroke refreshes every root that IMPORTS what changed, and a
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
			await session.settle(800)

			expect(session.diagnosticsFor(files.pathOf("Reader.es"))).toEqual(
				[],
			)

			await session.change(
				files.pathOf("Shared.es"),
				`implementation {\n\tconstant shared: Integer = "one"\n}\n\nexport {\n\tshared\n}\n`,
			)
			await session.settle(800)

			expect(session.codesFor(files.pathOf("Reader.es"))).toEqual([
				"dependency-has-errors",
			])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// NOTE: The one document no root can ever stand in for: a buffer opened from
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
			await session.settle(800)

			expect(
				session.diagnosticsFor(files.pathOf("outside/Outside.es")),
			).toEqual([])

			await session.change(
				files.pathOf("inside/Base.es"),
				`implementation {\n\tconstant thing: Integer = "one"\n}\n\nexport {\n\tthing\n}\n`,
			)
			await session.settle(800)

			expect(
				session.codesFor(files.pathOf("outside/Outside.es")),
			).toEqual(["dependency-has-errors"])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// NOTE: A closed file's Diagnostics are still true — they are what the file
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
			await session.settle(800)

			expect(session.codesFor(files.pathOf("Broken.es"))).toEqual([
				"assignment-type-mismatch",
			])

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

	// NOTE: The other half of that. A file that is gone has nothing to say, and
	// nobody but this Server is going to take its squiggles down — it owned them
	// itself, since nothing imports it.
	it("should clear the Diagnostics of a file that was deleted", async () => {
		let broken = `implementation {\n\tconstant amount: Integer = "two"\n}\n`
		let files = makeSessionWorkspace({ "Broken.es": broken })
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.settle(800)

			expect(session.codesFor(files.pathOf("Broken.es"))).toEqual([
				"assignment-type-mismatch",
			])

			rmSync(path.join(files.root, "Broken.es"))
			await session.watchedFileChanged([
				{ filePath: files.pathOf("Broken.es"), type: 3 },
			])
			await session.settle(800)

			expect(session.diagnosticsFor(files.pathOf("Broken.es"))).toEqual(
				[],
			)
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// NOTE: The mirror of a file being deleted, and the case a walk of the roots
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
			await session.settle(800)

			expect(session.codesFor(files.pathOf("Leaf.es"))).toEqual([
				"assignment-type-mismatch",
			])

			await session.change(
				files.pathOf("Top.es"),
				`implementation {\n\tconstant top = 1\n}\n`,
			)
			await session.settle(800)

			// NOTE: The whole subtree under the dropped edge, not only the file
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

	// NOTE: The same promotion, made by a deletion rather than by a keystroke.
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
			await session.settle(800)

			expect(session.codesFor(files.pathOf("Leaf.es"))).toEqual([
				"assignment-type-mismatch",
			])

			rmSync(path.join(files.root, "Top.es"))
			await session.watchedFileChanged([
				{ filePath: files.pathOf("Top.es"), type: 3 },
			])
			await session.settle(800)

			expect(session.codesFor(files.pathOf("Leaf.es"))).toEqual([
				"assignment-type-mismatch",
			])
			expect(session.codesFor(files.pathOf("Mid.es"))).toEqual([
				"dependency-has-errors",
			])
			// NOTE: And the file that IS gone is still cleared, which is the
			// other half of the same batch.
			expect(session.diagnosticsFor(files.pathOf("Top.es"))).toEqual([])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// NOTE: And with the promoted file OPEN, which is the worst of the three: a
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
			await session.settle(800)

			expect(session.codesFor(files.pathOf("Library.es"))).toEqual([
				"assignment-type-mismatch",
			])

			rmSync(path.join(files.root, "Main.es"))
			await session.watchedFileChanged([
				{ filePath: files.pathOf("Main.es"), type: 3 },
			])
			await session.settle(800)

			expect(session.codesFor(files.pathOf("Library.es"))).toEqual([
				"assignment-type-mismatch",
			])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// NOTE: A file something starts importing stops being a root, and its
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
			await session.settle(800)

			expect(session.codesFor(files.pathOf("Library.es"))).toEqual([
				"assignment-type-mismatch",
			])

			let mark = session.publishMark()

			writeFileSync(path.join(files.root, "Main.es"), importing)
			await session.watchedFileChanged([
				{ filePath: files.pathOf("Main.es"), type: 2 },
			])
			await session.settle(800)

			// NOTE: The importer really did become the only root — it has the
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

	// NOTE: And the other direction, which is the same requirement read
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
			await session.settle(800)

			expect(session.codesFor(files.pathOf("Library.es"))).toEqual([
				"assignment-type-mismatch",
			])

			let mark = session.publishMark()

			writeFileSync(path.join(files.root, "Main.es"), alone)
			await session.watchedFileChanged([
				{ filePath: files.pathOf("Main.es"), type: 2 },
			])
			await session.settle(800)

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

	// NOTE: A cycle nobody imports is the one shape with no root in it at all,
	// and the member reaching the most others is analysed in its place. The
	// broken file is the OTHER member: it is reported on only because the
	// entry's graph reached it.
	it("should report on a cycle nobody imports", async () => {
		let files = makeSessionWorkspace(cycle)
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.settle(800)

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

	// NOTE: And a cycle can be MADE by a deletion, which is where "closest to
	// root" has to be worked out again rather than once at startup: the file
	// above it was the only root either member had, and losing it leaves two
	// files importing each other and nothing else.
	it("should analyse a cycle that loses the file above it", async () => {
		let above = `import {\n\tfrom "./Circle.es" { circled }\n}\n\nimplementation {\n\tconstant seen = circled(1)\n}\n`
		let files = makeSessionWorkspace({ ...cycle, "Above.es": above })
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.settle(1000)

			expect(session.codesFor(files.pathOf("Loop.es"))).toEqual([
				"assignment-type-mismatch",
			])

			rmSync(path.join(files.root, "Above.es"))
			await session.watchedFileChanged([
				{ filePath: files.pathOf("Above.es"), type: 3 },
			])
			await session.settle(1000)

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

	// NOTE: The coverage fallback — "closest to root we can actually analyse".
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
			await session.settle(1200)

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

	// NOTE: A build drops the `tests { … }` section, so the Editor is the only
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
			await session.settle(600)

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
