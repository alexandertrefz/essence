import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { FIXTURES_DIRECTORY, fixturePath } from "@essence-lang/fixtures"
import type { common } from "@essence-lang/interfaces"

import { canonicalPath } from "../documents"
import { enrich } from "../enricher/index"
import { loadStdlib } from "../enricher/stdlib"
import { loadModuleGraph } from "../modules/graph"
import { linkModuleGraph } from "../modules/link"
import { parseWithDiagnostics } from "../parser"
import {
	findParserChild,
	forEachParserChild,
	type ParserNode,
	parserNodeKinds,
} from "../visitor/parser"
import {
	findTypedChild,
	forEachTypedChild,
	type TypedNode,
	typedNodeKinds,
} from "../visitor/typed"

// Programs that between them write every kind of node. A kind added without a
// fixture here fails the coverage specs.
const shapesSource = `implementation {
	choice Shape {
		Circle { radius: Integer },
		Square { side: Integer } = { side = 1 },
		Dot,
	}

	constant unit = 1
}

export {
	Shape
	unit
}
`

const mainSource = `import {
	from "./Shapes.es" {
		Shape as Figure
		unit
	}
}

implementation {
	type Point = { x: Integer, y: Integer }
	type Small = Integer where @::isLessThan(10)
	type Even = Integer where @::isEven()
	type Labelled<T> = T | String
	type Check = (_: Integer) -> Boolean

	choice Holder<Item> {
		Full { item: Item },
		Vacant,
	}

	protocol Sized {
		size() -> Integer

		isEmpty() -> Boolean {
			<- @::size()::is(0)
		}
	}

	protocol Shaped is Sized {
		static zero() -> Integer

		overload measure {
			(_ value: Integer) -> Integer
			(_ value: String) -> Integer
		}

		overload static made {
			(_ value: Integer) -> Integer
			(_ value: String) -> Integer
		}
	}

	namespace Points for Point is Sized {
		static origin = Point ~> { x = 0, y = 0 }

		size() -> Integer {
			<- @.x::add(@.y)
		}

		static zero() -> Integer {
			<- 0
		}

		overload shifted {
			(by amount: Integer) -> Point {
				<- { @ with x = @.x::add(amount) }
			}
			(to other: Point) -> Point {
				<- other
			}
		}

		overload static from {
			(_ x: Integer) -> Point {
				<- { x, y = x }
			}
			(_ text: String) -> Point {
				<- { x = text::length(), y = 0 }
			}
		}
	}

	namespace Holders <infer Item> for Holder<Item> is Sized where Item is Sized {
		size() -> Integer {
			<- 1
		}
	}

	function area<infer Item is Sized = Point>(of item: Item, _ scale: Integer = 1) -> Integer {
		<- item::size()::multiply(with scale)
	}

	function describe(_ shape: Figure) -> String {
		<- match shape -> String {
			case #Circle({ radius }) where radius::isGreaterThan(unit) {
				<- "big {radius}"
			}
			case Figure#Square(square) {
				<- square.side::toString()
			}
			case _ {
				<- "dot"
			}
		}
	}

	function grade(_ score: Integer) -> String {
		<- define -> String {
			as "A" if score::isGreaterThan(90)
			as "F" otherwise
		}
	}

	function classify(_ value: Integer | String) -> Integer {
		<- match value -> Integer {
			case 0 {
				<- 1
			}
			case Integer {
				<- 2
			}
			case String {
				<- 3
			}
		}
	}

	function loaded() -> Future<Integer> {
		constant running = start Async.deferred(() {
			<- 3
		})

		<- complete running
	}

	constant { x, y } = Point ~> { x = 1, y = 2 }
	variable total = x::add(y)
	total = total::add(1)
	constant ratio = 3/4
	constant flag = true
	constant names = ["a", "b"]
	constant ages = ["kim" = 7]
	constant older = [ages with "sam" = 9]
	constant moved = { Points.origin with x = 2 }
	constant nested = { point = { x = 1, y = 2 } }
	constant deeper = { nested with point.x = 5 }
	constant grouped = { nested with point.{ x = 3, y = 4 } }
	constant layered = { inner = { point = { x = 1, y = 2 } } }
	constant through = {
		layered with
			inner.point.x = 5,
			inner.point.y = 6,
	}
	constant descended = { layered with inner.{ point.x = 7, point.y = 8 } }
	constant widths = [Points.origin]::map(.x)
	constant check: Check = (_ value: Integer) -> Boolean {
		<- value::isGreaterThan(0)
	}
	constant held = Holder<Integer>#Full({ item = 1 })
	constant circle = Figure#Circle({ radius = 2 })
	constant dot = Figure#Dot
	constant firstName = names[0]
	constant chosen = Points.from(1)::<Points>shifted(by 2)

	if flag {
		Terminal.print(describe(circle))
	}

	if total::isGreaterThan(3) {
		Terminal.print(grade(total))
	} else {
		Terminal.print(classify(total))
	}
}

export {
	area
	from "./Shapes.es" {
		Shape
	}
	describe
}

tests {
	constant base = 2

	test "adds" tagged fast {
		expect base::add(1)::is(3)
		require #Full(content) = held
		require { x = 1 } = Points.origin
		expect base matches snapshot "2"
	}

	suite "tables" skipped "later" {
		test "row {row}" across [1, 2] (row: Integer) {
			expect row::isGreaterThan(0)
		}

		test "pattern rows" across [Points.origin] ({ x, y }: Point) {
			expect x::is(y)
		}
	}

	test "properties" for any (
		value: Integer,
		small: Small,
		even: Even,
		pair: { even: Even },
		text: List<String>,
	) {
		expect value::is(value)
	}
}
`

// The forms only the standard library may write. A typed native shim comes
// from the standard library itself.
const declarationsSource = `declarations {
	namespace Boxes <infer ItemType> for List<ItemType> {
		firstItem() -> Integer

		static wrap <Item>(_ value: Item) -> List<Item>

		static emptyCount: Integer

		overload combine {
			(_ other: Integer) -> Integer
			(_ other: String) -> Integer {
				<- 0
			}
		}

		overload static make {
			(_ other: Integer) -> Integer
			(_ other: String) -> Integer
		}
	}

	overload function combineAll {
		(_ other: Integer) -> Integer
		(of other: String) -> Integer {
			<- 0
		}
	}
}
`

// Export blocks as they stand while a group is being written. Each is read
// alone, by the Parser only.
const unfinishedSources = [
	'implementation {\n\tconstant a = 1\n}\n\nexport {\n\ta\n\tfrom "./b.es" {\n\t}\n}\n',
	'implementation {\n\tconstant a = 1\n}\n\nexport {\n\ta\n\tfrom "./b.es" {\n',
	'import {\n\tfrom "./b.es" {\n\t}\n}\n\nimplementation {\n\tconstant a = 1\n}\n',
]

// The second `b` takes the first one's key in the Record, so the Methods stand
// out of written order around the property between them.
const duplicateMethodSource = [
	"implementation {",
	"\tnamespace Twice for Integer {",
	"\t\tb() -> Integer {",
	"\t\t\t<- 1",
	"\t\t}",
	"",
	"\t\ta() -> Integer {",
	"\t\t\t<- 2",
	"\t\t}",
	"",
	"\t\tstatic q = 3",
	"",
	"\t\tb() -> Integer {",
	"\t\t\t<- 3",
	"\t\t}",
	"\t}",
	"}",
].join("\n")

function fixturePrograms(): {
	parsed: Array<ParserNode>
	typed: Array<TypedNode>
	library: Array<TypedNode>
} {
	let directory = canonicalPath(path.join(tmpdir(), "essence-visitor"))
	let files: Record<string, string> = {
		[path.join(directory, "Main.es")]: mainSource,
		[path.join(directory, "Shapes.es")]: shapesSource,
	}
	let linked = linkModuleGraph(
		loadModuleGraph(path.join(directory, "Main.es"), {
			readFile: (filePath) => files[filePath],
		}),
		{ tests: true },
	)
	let modules = [...linked.modules.values()]
	let declarations = parseWithDiagnostics(declarationsSource, {
		allowDeclarationsHeader: true,
	})

	return {
		parsed: [
			...modules.map((module) => module.module.program),
			declarations.program,
			...unfinishedSources.map(
				(source) => parseWithDiagnostics(source).program,
			),
		],
		typed: modules.map((module) => module.program),
		library: loadStdlib().typedPrograms,
	}
}

// Every fixture file and every showcase, each read alone with its tests. A
// showcase is broken on purpose, so its trees are the ones the Parser
// recovers.
function corpusPrograms(): {
	parsed: Array<ParserNode>
	typed: Array<TypedNode>
} {
	let files = [FIXTURES_DIRECTORY, fixturePath("diagnostics")].flatMap(
		(directory) =>
			readdirSync(directory)
				.filter((name) => name.endsWith(".es"))
				.map((name) => path.join(directory, name)),
	)
	let parsed: Array<ParserNode> = []
	let typed: Array<TypedNode> = []

	for (let file of files) {
		let source = readFileSync(file, "utf-8")
		let program = parseWithDiagnostics(source).program

		parsed.push(program)
		typed.push(enrich(program, { tests: true, source }).program)
	}

	return { parsed, typed }
}

// How often a full recursive walk with the visitor reaches each node.
function visitCounts<Node extends { nodeType: string }>(
	roots: Array<Node>,
	forEachChild: (node: Node, visit: (child: Node) => void) => void,
): Map<Node, number> {
	let counts = new Map<Node, number>()

	function visit(node: Node) {
		counts.set(node, (counts.get(node) ?? 0) + 1)
		forEachChild(node, visit)
	}

	for (let root of roots) {
		visit(root)
	}

	return counts
}

// Every object carrying a `nodeType` that some field reaches, found by reading
// every field. A Type is not entered, and neither is a field the table skips
// for holding copies of nodes reached elsewhere.
function reflectiveNodes(
	roots: Array<object>,
	skippedFields: ReadonlySet<string>,
): Set<object> {
	let nodes = new Set<object>()
	let seen = new Set<object>()

	function scan(value: unknown) {
		if (value === null || typeof value !== "object" || seen.has(value)) {
			return
		}

		let fields = value as Record<string, unknown>

		if (typeof fields.type === "string" && !("nodeType" in fields)) {
			return
		}

		seen.add(value)

		if ("nodeType" in fields) {
			nodes.add(value)
		}

		for (let key of Object.keys(fields)) {
			if (!skippedFields.has(key)) {
				scan(fields[key])
			}
		}
	}

	for (let root of roots) {
		scan(root)
	}

	return nodes
}

// The nodes a walk reached more than once, missed, or reached beyond what the
// fields hold. Compared by identity both ways, since `toEqual` does not
// compare large Sets of objects member by member.
function mismatches(
	counts: Map<object, number>,
	reflective: Set<object>,
): Record<string, Array<string>> {
	let kind = (node: object) => (node as { nodeType: string }).nodeType

	return {
		repeated: [...counts]
			.filter(([, count]) => count > 1)
			.map(([node]) => kind(node)),
		unvisited: [...reflective]
			.filter((node) => !counts.has(node))
			.map(kind),
		unexpected: [...counts.keys()]
			.filter((node) => !reflective.has(node))
			.map(kind),
	}
}

const noMismatches = { repeated: [], unvisited: [], unexpected: [] }

function kindsOf(nodes: Iterable<{ nodeType: string }>): Array<string> {
	return [...new Set([...nodes].map((node) => node.nodeType))].sort()
}

function startOf(node: { nodeType: string }): common.Cursor | null {
	let fields = node as {
		position?: common.Position
		value?: { position?: common.Position }
		name?: { position?: common.Position }
	}

	return (
		fields.position?.start ??
		fields.value?.position?.start ??
		fields.name?.position?.start ??
		null
	)
}

function isAtOrBefore(a: common.Cursor, b: common.Cursor): boolean {
	return a.line < b.line || (a.line === b.line && a.column <= b.column)
}

describe("The child tables", () => {
	let { parsed, typed, library } = fixturePrograms()
	let corpus = corpusPrograms()

	it("reach every kind of the Parser AST from the fixtures", () => {
		expect(kindsOf(visitCounts(parsed, forEachParserChild).keys())).toEqual(
			[...parserNodeKinds].sort(),
		)
	})

	it("reach every kind of the typed AST from the fixtures, and a native shim from the standard library", () => {
		let shims = kindsOf(
			visitCounts(library, forEachTypedChild).keys(),
		).filter((kind) => kind === "NativeShim")

		expect(
			[
				...kindsOf(visitCounts(typed, forEachTypedChild).keys()),
				...shims,
			].sort(),
		).toEqual([...typedNodeKinds].sort())
	})

	it("reach each parsed node once, and every node a field holds", () => {
		expect(
			mismatches(
				visitCounts(parsed, forEachParserChild),
				reflectiveNodes(parsed, new Set()),
			),
		).toEqual(noMismatches)
	})

	it("reach each typed node once, and every node a field holds", () => {
		let programs = [...typed, ...library]

		expect(
			mismatches(
				visitCounts(programs, forEachTypedChild),
				reflectiveNodes(programs, new Set(["dispatch"])),
			),
		).toEqual(noMismatches)
	})

	it("reach each node of every fixture file and showcase once, in both trees", () => {
		expect(
			mismatches(
				visitCounts(corpus.parsed, forEachParserChild),
				reflectiveNodes(corpus.parsed, new Set()),
			),
		).toEqual(noMismatches)
		expect(
			mismatches(
				visitCounts(corpus.typed, forEachTypedChild),
				reflectiveNodes(corpus.typed, new Set(["dispatch"])),
			),
		).toEqual(noMismatches)
	})

	it("reach each node once where a duplicate Method breaks written order, in both trees", () => {
		let program = parseWithDiagnostics(duplicateMethodSource).program
		let typedProgram = enrich(program).program

		expect(
			mismatches(
				visitCounts([program], forEachParserChild),
				reflectiveNodes([program], new Set()),
			),
		).toEqual(noMismatches)
		expect(
			mismatches(
				visitCounts([typedProgram], forEachTypedChild),
				reflectiveNodes([typedProgram], new Set(["dispatch"])),
			),
		).toEqual(noMismatches)
	})

	it("visit a parsed node's children in written order", () => {
		let misplaced: Array<string> = []

		function visit(node: ParserNode) {
			let previous: common.Cursor | null = null

			forEachParserChild(node, (child) => {
				let start = startOf(child)

				if (start === null) {
					return
				}

				if (previous !== null && !isAtOrBefore(previous, start)) {
					misplaced.push(`${child.nodeType} in ${node.nodeType}`)
				}

				previous = start
			})
			forEachParserChild(node, visit)
		}

		for (let program of [...parsed, ...corpus.parsed]) {
			visit(program)
		}

		expect(misplaced).toEqual([])
	})

	it("visit a typed Handler's Matcher literal, Guard and body in written order", () => {
		let source = [
			"implementation {",
			"\tfunction pick(_ value: Integer, _ limit: Integer) -> Integer {",
			"\t\t<- match value -> Integer {",
			"\t\t\tcase 1 where limit::isGreaterThan(0) {",
			"\t\t\t\t<- limit",
			"\t\t\t}",
			"\t\t\tcase _ {",
			"\t\t\t\t<- 0",
			"\t\t\t}",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")
		let program = typedProgramOf(source)
		let match = findTyped(program, (node) => node.nodeType === "Match")
		let children: Array<string> = []

		forEachTypedChild(match!, (child) => {
			children.push(`${child.nodeType}@${startOf(child)?.line}`)
		})

		expect(children).toEqual([
			"Identifier@3",
			"IntegerValue@4",
			"MethodInvocation@4",
			"ReturnStatement@5",
			"ReturnStatement@8",
		])
	})

	// Each place reads `field key container`.
	it("tell each visit where in a parsed node the child stands", () => {
		let program = parseOnly(
			[
				"implementation {",
				"\tchoice Holder<Item, Other> {",
				"\t\tFull { item: Item } = { item = 1 },",
				"\t\tVacant,",
				"\t}",
				"",
				"\tnamespace Sizes for Integer {",
				"\t\tstatic unit = 1",
				"",
				"\t\tdoubled() -> Integer {",
				"\t\t\t<- @::add(@)",
				"\t\t}",
				"\t}",
				"",
				"\tfunction pick(_ value: Integer) -> String {",
				"\t\tif value::isGreaterThan(1) {",
				"\t\t\tconstant a = 1",
				"\t\t} else {",
				"\t\t\tconstant b = 2",
				"\t\t}",
				"",
				"\t\t<- match value -> String {",
				"\t\t\tcase 1 where value::isGreaterThan(0) {",
				'\t\t\t\t<- "one"',
				"\t\t\t}",
				"\t\t\tcase _ {",
				"\t\t\t\t<- define -> String {",
				'\t\t\t\t\tas "many" if value::isGreaterThan(9)',
				'\t\t\t\t\tas "few" otherwise',
				"\t\t\t\t}",
				"\t\t\t}",
				"\t\t}",
				"\t}",
				"}",
			].join("\n"),
		)
		let placesOf = (kind: string) => {
			let places: Array<string> = []

			forEachParserChild(
				findParsed(program, (node) => node.nodeType === kind)!,
				(_child, _state, field, key, container) =>
					places.push(`${field} ${key} ${container}`),
			)

			return places
		}

		expect(placesOf("ChoiceDeclarationStatement")).toEqual([
			"name undefined undefined",
			"generics 0 undefined",
			"generics 1 undefined",
			"name 0 cases",
			"type 0 cases",
			"defaultValue 0 cases",
			"name 1 cases",
		])
		expect(placesOf("NamespaceDefinitionStatement")).toEqual([
			"name undefined undefined",
			"targetType undefined undefined",
			"name unit properties",
			"value unit properties",
			"methods doubled undefined",
		])
		expect(placesOf("IfElseStatement")).toEqual([
			"condition undefined undefined",
			"trueBody 0 undefined",
			"falseBody 0 undefined",
		])
		expect(placesOf("Match")).toEqual([
			"value undefined undefined",
			"returnType undefined undefined",
			"matcher 0 handlers",
			"guard 0 handlers",
			"body 0 handlers",
			"matcher 1 handlers",
			"body 1 handlers",
		])
		expect(placesOf("Define")).toEqual([
			"returnType undefined undefined",
			"value 0 arms",
			"condition 0 arms",
			"value undefined otherwise",
		])
	})

	it("tell each visit where in a typed node the child stands", () => {
		let program = typedProgramOf(
			[
				"implementation {",
				"\ttype Standing = { team: String, points: Integer }",
				"",
				"\tfunction score(_ standing: Standing) -> Integer {",
				"\t\t<- match standing -> Integer {",
				"\t\t\tcase { points = 3 } {",
				"\t\t\t\t<- 1",
				"\t\t\t}",
				"\t\t\tcase _ {",
				"\t\t\t\t<- 0",
				"\t\t\t}",
				"\t\t}",
				"\t}",
				"",
				"\tconstant point = { x = 1, y = 2 }",
				"}",
			].join("\n"),
		)
		let placesOf = (kind: string) => {
			let places: Array<string> = []

			forEachTypedChild(
				findTyped(program, (node) => node.nodeType === kind)!,
				(_child, _state, field, key, container) =>
					places.push(`${field} ${key} ${container}`),
			)

			return places
		}

		expect(placesOf("RecordValue")).toEqual([
			"members x undefined",
			"members y undefined",
		])
		expect(placesOf("Match")).toEqual([
			"value undefined undefined",
			"memberLiterals 0 handlers",
			"body 0 handlers",
			"body 1 handlers",
		])
	})

	// A property's generator nests a generator per Record member, and each
	// Expression in it reports the property's field as its container.
	it("tell a nested generator's Expressions the property's field", () => {
		let pair = typed
			.map((program) =>
				findTyped(
					program,
					(node) =>
						node.nodeType === "TestProperty" &&
						node.name === "pair",
				),
			)
			.find((node) => node !== undefined)
		let places: Array<string> = []

		forEachTypedChild(pair!, (_child, _state, field, key, container) =>
			places.push(`${field} ${key} ${container}`),
		)

		expect(places).toEqual(["checks 0 generator"])
	})

	it("stop at the first child whose visit answers, and answer that", () => {
		let program = parseOnly(
			"implementation {\n\tconstant a = f(b, c, d)\n}",
		)
		let call = findParsed(
			program,
			(node) => node.nodeType === "FunctionInvocation",
		)
		let visited: Array<string> = []

		let found = findParserChild(call!, (child) => {
			visited.push(child.nodeType)

			return child.nodeType === "Argument" ? "an Argument" : undefined
		})

		expect(found).toBe("an Argument")
		expect(visited).toEqual(["Identifier", "Argument"])
	})

	it("visit every child whatever the visit answers", () => {
		let program = parseOnly(
			"implementation {\n\tconstant a = f(b, c, d)\n}",
		)
		let call = findParsed(
			program,
			(node) => node.nodeType === "FunctionInvocation",
		)
		let visited: Array<string> = []

		forEachParserChild(call!, (child) => visited.push(child.nodeType))

		expect(visited).toEqual([
			"Identifier",
			"Argument",
			"Argument",
			"Argument",
		])
	})

	it("leave a subtree alone where the walker does not descend", () => {
		let program = parseOnly(
			[
				"implementation {",
				"\tconstant inner = (_ x: Integer) -> Integer {",
				"\t\t<- x::add(hidden)",
				"\t}",
				"\tconstant outer = shown",
				"}",
			].join("\n"),
		)
		let names: Array<string> = []

		function visit(node: ParserNode) {
			if (node.nodeType === "FunctionValue") {
				return
			}

			if (node.nodeType === "Identifier") {
				names.push(node.content)
			}

			forEachParserChild(node, visit)
		}

		visit(program)

		expect(names).toEqual(["inner", "outer", "shown"])
	})

	it("hand the walker's own state to each visit", () => {
		let program = parseOnly(
			[
				"implementation {",
				"\tfunction outer() -> Integer {",
				"\t\tconstant inner = () -> Integer {",
				"\t\t\t<- deepest",
				"\t\t}",
				"",
				"\t\t<- shallow",
				"\t}",
				"}",
			].join("\n"),
		)
		let depths: Record<string, number> = {}

		// Values only. The return Types are Identifiers too.
		function visit(node: ParserNode, depth: number) {
			if (node.nodeType === "Identifier" && /^[a-z]/.test(node.content)) {
				depths[node.content] = depth
			}

			forEachParserChild(
				node,
				visit,
				node.nodeType === "FunctionDefinition" ? depth + 1 : depth,
			)
		}

		visit(program, 0)

		expect(depths).toEqual({
			outer: 0,
			inner: 1,
			deepest: 2,
			shallow: 1,
		})
	})
})

function parseOnly(source: string) {
	return parseWithDiagnostics(source).program
}

function typedProgramOf(source: string): TypedNode {
	let directory = canonicalPath(path.join(tmpdir(), "essence-visitor-order"))
	let entry = path.join(directory, "Main.es")
	let linked = linkModuleGraph(
		loadModuleGraph(entry, { readFile: () => source }),
	)

	return linked.modules.get(entry)!.program
}

function findParsed(
	node: ParserNode,
	test: (node: ParserNode) => boolean,
): ParserNode | undefined {
	return test(node)
		? node
		: findParserChild(node, (child) => findParsed(child, test))
}

function findTyped(
	node: TypedNode,
	test: (node: TypedNode) => boolean,
): TypedNode | undefined {
	return test(node)
		? node
		: findTypedChild(node, (child) => findTyped(child, test))
}
