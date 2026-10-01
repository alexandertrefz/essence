import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { FIXTURES_DIRECTORY, fixturePath } from "@essence-lang/fixtures"
import type { common } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { canonicalPath } from "../documents"
import { enrich } from "../enricher/index"
import { loadStdlib } from "../enricher/stdlib"
import { loadModuleGraph } from "../modules/graph"
import { linkModuleGraph } from "../modules/link"
import {
	defaultOptimiserOptions,
	optimise,
	type OptimiserOptions,
	unoptimisedOptions,
} from "../optimiser/index"
import { rewriteNodes } from "../optimiser/walk"
import { parseWithDiagnostics } from "../parser"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"
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
import {
	findSimpleChild,
	forEachSimpleChild,
	type SimpleNode,
	simpleNodeKinds,
} from "../visitor/typedSimple"

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

// A Module whose simplified trees, unoptimised, optimised and instrumented for
// coverage, between them hold every kind. The optimiser writes the intrinsics,
// the loop turns and the counters. It imports `shapesSource`.
const simpleSource = `import {
	from "./Shapes.es" {
		Shape as Figure
		unit
	}
}

implementation {
	type Point = { x: Integer, y: Integer }
	type Box = { size: Integer }
	type Small = Integer where @::isLessThan(10)
	type Even = Integer where @::isEven()
	type Team = { name: String }

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
		isFull() -> Boolean {
			<- @::isEmpty()::negate()
		}
	}

	namespace Holders <infer Item> for Holder<Item> is Sized where Item is Sized {
		size() -> Integer {
			<- 1
		}
	}

	namespace Points for Point is Shaped {
		static origin = Point ~> { x = 0, y = 0 }

		size() -> Integer {
			<- @.x::add(@.y)
		}
	}

	namespace Teams for Team is Generatable {
		static generate(from source: Randomness) -> Team {
			<- { name = "Lions" }
		}
	}

	namespace Boxes for Box {
		tagged(with suffix: String) -> String {
			<- "box{suffix}"
		}
	}

	namespace Flags for Boolean {
		tagged(with suffix: String) -> String {
			<- "flag{suffix}"
		}
	}

	variable either: Box | Boolean = { size = 3 }

	function identityOf(_ value: Integer | Boolean) -> Integer | Boolean {
		<- value
	}

	function flip() -> String {
		either = true

		<- "!"
	}

	function describe(_ shape: Figure) -> String {
		<- match shape -> String {
			case #Circle({ radius }) where radius::isGreaterThan(unit) {
				<- "big {radius}"
			}
			case Figure#Square(square) {
				<- square::toString()
			}
			case _ {
				<- "dot"
			}
		}
	}

	function classify(_ value: Integer | String) -> Integer {
		constant code = match value -> Integer {
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

		<- code
	}

	function grade(_ score: Integer) -> String {
		<- define -> String {
			as "A" if score::isGreaterThan(90)
			as "F" otherwise
		}
	}

	function countdown(_ n: Integer, _ sum: Integer = 0) -> Integer {
		if n::isLessThan(1) {
			<- sum
		} else {
			<- countdown(n::subtract(1))
		}
	}

	function retried(options: { retries: Integer } = { retries = 2 }) -> Integer {
		<- options.retries
	}

	function padded(_ text: String, width: Integer = 4, fill: String = " ") -> String {
		<- "{fill}{text}{width}"
	}

	function full<infer Value is Shaped>(_ value: Value) -> Boolean {
		<- value::isFull()
	}

	function sized<infer Value is Sized>(_ value: Value) -> Integer {
		<- value::size()
	}

	function scored(_ standing: Point | Box) -> Integer {
		<- match standing -> Integer {
			case { x = 3 } {
				<- 1
			}
			case _ {
				<- 0
			}
		}
	}

	function first(_ maybe: Optional<Integer | String>) -> Integer {
		<- match maybe -> Integer {
			case #Value({ value: Integer }) {
				<- 1
			}
			case _ {
				<- 0
			}
		}
	}

	function both(_ a: Boolean, _ b: Boolean) -> Boolean {
		<- a::and(b)::or(a::is(b))
	}

	function loaded() -> Future<Integer> {
		constant running = start Async.deferred(() {
			<- 3
		})

		<- complete running
	}

	either::tagged(with flip())

	constant tagged = either::tagged(with flip())
	constant payload = { item = 1 }
	constant wrapped = Holder<Integer>#Full(payload)
	constant shift = { x = 5 }
	constant shifted = { Points.origin with shift }
	constant listed: List<Integer> | String = [1, 2]
	constant maybe: Optional<Integer | String> = Optional<Integer | String>#Value(2)
	constant lists: List<Integer> | List<String> = [1, 2]

	constant built = loop(from 1, through 4, startingWith [0], (index, list) {
		<- list::append(index)
	})
	constant doubled = [1, 2]::map((item) {
		<- item::multiply(with 2)
	})
	constant ratio = 3/4
	constant ages = ["kim" = 7]
	constant older = [ages with "sam" = 9]
	constant moved = { Points.origin with x = 2 }
	constant held = Holder<Integer>#Full({ item = 1 })
	constant circle = Figure#Circle({ radius = 2 })

	Terminal.inspect(countdown(5))
	Terminal.inspect(retried())
	Terminal.inspect(both(true, false))
	Terminal.inspect(built)
	Terminal.inspect(full(Points.origin))
	Terminal.inspect(sized(Holder<Point>#Full({ item = Points.origin })))
	Terminal.inspect(scored(Points.origin))
	Terminal.inspect(match maybe -> Integer {
		case #Value({ value: Integer }) {
			<- 1
		}
		case _ {
			<- 0
		}
	})
	Terminal.inspect(first(#Value(5)))
	Terminal.inspect([1, 2]::map((item) {
		<- item::add(1)
	}))
	Terminal.inspect(identityOf(5)::toString())
	Terminal.inspect(match either -> String {
		case Box {
			<- "box"
		}
		case _ {
			<- "flag"
		}
	})
	Terminal.inspect(tagged)
	Terminal.inspect(wrapped)
	Terminal.inspect(shifted)
	Terminal.inspect(listed::toString())
	Terminal.inspect(lists::map((item) {
		<- item::toString()
	}))
	Terminal.inspect(padded("a", fill "-"))
	Terminal.inspect(loop(from 1, through 3, startingWith 0, (index, total) {
		<- total::add(index)
	}))
	Terminal.inspect(doubled)
	Terminal.inspect(describe(circle))
	Terminal.inspect(classify(2))
	Terminal.inspect(grade(95))
	Terminal.inspect(ratio)
	Terminal.inspect(older)
	Terminal.inspect(moved)
	Terminal.inspect(held)
}

export {
	countdown
}

tests {
	constant base = 2
	constant mixed: Optional<Integer | String> = #Value(1)

	test "adds {base}" {
		expect base::add(1)::is(3)
		require #Full(content) = held
		expect base matches snapshot "2"
		require { x = 0 } = Points.origin
		require #Value({ value: Integer }) = mixed
	}

	suite "tables" {
		test "row {row}" across [1, 2] (row: Integer) {
			expect row::isGreaterThan(0)
		}

		test "pattern rows" across [Points.origin] ({ x, y }: Point) {
			expect x::is(y)
		}
	}

	test "properties {base}" for any (
		value: Integer,
		small: Small,
		even: Even,
		team: Team,
		pair: { even: Integer },
		texts: List<String>,
		ages: Dictionary<String, Integer>,
		either: Integer | String,
	) {
		expect value::is(value)
	}
}
`

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

// The simplified trees of `simpleSource` and the Module it imports, under each
// option set that writes a kind of its own. The standard library's are built
// as the prelude builds them.
function simplifiedPrograms(): {
	programs: Array<common.typedSimple.Program>
	library: Array<common.typedSimple.Program>
} {
	let directory = canonicalPath(path.join(tmpdir(), "essence-visitor-simple"))
	let files: Record<string, string> = {
		[path.join(directory, "Simple.es")]: simpleSource,
		[path.join(directory, "Shapes.es")]: shapesSource,
	}
	let linked = linkModuleGraph(
		loadModuleGraph(path.join(directory, "Simple.es"), {
			readFile: (filePath) => files[filePath],
		}),
		{ tests: true },
	)
	let optionSets: Array<OptimiserOptions> = [
		unoptimisedOptions,
		defaultOptimiserOptions,
		{ ...defaultOptimiserOptions, coverage: true },
	]
	let programs: Array<common.typedSimple.Program> = []

	for (let module of linked.modules.values()) {
		expect(
			containsErrors([
				...module.diagnostics,
				...validate(module.program),
			]),
		).toBe(false)

		for (let options of optionSets) {
			programs.push(optimise(simplify(module.program), options))
		}
	}

	return {
		programs,
		library: loadStdlib().typedPrograms.flatMap((program) =>
			optionSets
				.slice(0, 2)
				.map((options) =>
					optimise(simplify(structuredClone(program)), options),
				),
		),
	}
}

// Every fixture file that compiles, simplified and optimised with coverage.
function simplifiedCorpus(): Array<common.typedSimple.Program> {
	let programs: Array<common.typedSimple.Program> = []

	for (let name of readdirSync(FIXTURES_DIRECTORY)) {
		if (!name.endsWith(".es")) {
			continue
		}

		let source = readFileSync(path.join(FIXTURES_DIRECTORY, name), "utf-8")
		let parsed = parseWithDiagnostics(source)
		let enriched = enrich(parsed.program, { tests: true, source })

		if (
			containsErrors(parsed.diagnostics) ||
			containsErrors(enriched.diagnostics) ||
			containsErrors(validate(enriched.program))
		) {
			continue
		}

		programs.push(
			optimise(simplify(enriched.program, { source }), {
				...defaultOptimiserOptions,
				coverage: true,
			}),
		)
	}

	return programs
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

// How often the fields hold each node. An optimised tree may hold one node in
// two fields, and each counts. A Type is not entered.
function heldCounts(roots: Array<object>): Map<object, number> {
	let counts = new Map<object, number>()

	function scan(value: unknown) {
		if (value === null || typeof value !== "object") {
			return
		}

		let fields = value as Record<string, unknown>

		if (typeof fields.type === "string" && !("nodeType" in fields)) {
			return
		}

		if ("nodeType" in fields) {
			counts.set(value, (counts.get(value) ?? 0) + 1)
		}

		for (let key of Object.keys(fields)) {
			scan(fields[key])
		}
	}

	for (let root of roots) {
		scan(root)
	}

	return counts
}

// The nodes a walk reached more often or less often than the fields hold
// them, or reached where no field holds them.
function heldMismatches(
	counts: Map<object, number>,
	held: Map<object, number>,
): Record<string, Array<string>> {
	let kind = (node: object) => (node as { nodeType: string }).nodeType

	return {
		repeated: [...counts]
			.filter(([node, count]) => count > (held.get(node) ?? count))
			.map(([node]) => kind(node)),
		unvisited: [...held]
			.filter(([node, count]) => (counts.get(node) ?? 0) < count)
			.map(([node]) => kind(node)),
		unexpected: [...counts.keys()]
			.filter((node) => !held.has(node))
			.map(kind),
	}
}

// A kind told apart by `kind` is spelled with it, as `simpleNodeKinds` does.
function simpleKindsOf(nodes: Iterable<SimpleNode>): Array<string> {
	return kindsOf(
		[...nodes].map((node) =>
			node.nodeType === "Intrinsic" ||
			node.nodeType === "IntrinsicStatement"
				? { nodeType: `${node.nodeType} ${node.kind}` }
				: node,
		),
	)
}

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
	let simple = simplifiedPrograms()
	let simpleCorpus = simplifiedCorpus()

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

	it("reach every kind of the simplified AST from the fixtures, unoptimised, optimised and instrumented", () => {
		expect(
			simpleKindsOf(
				visitCounts<SimpleNode>(
					simple.programs,
					forEachSimpleChild,
				).keys(),
			),
		).toEqual([...simpleNodeKinds].sort())
	})

	it("reach each simplified node as often as the fields hold it", () => {
		let programs = [...simple.programs, ...simple.library, ...simpleCorpus]

		expect(
			heldMismatches(
				visitCounts<SimpleNode>(programs, forEachSimpleChild),
				heldCounts(programs),
			),
		).toEqual(noMismatches)
	})

	// The optimiser's walk offers Expressions after their children, so the
	// visitor's post-order walk, cut down to what it offers, is the same list.
	it("visit a simplified node's children in the order the optimiser's walk offers them", () => {
		let misplaced: Array<string> = []

		for (let program of [
			...simple.programs,
			...simple.library,
			...simpleCorpus,
		]) {
			let offered: Array<SimpleNode> = []

			rewriteNodes(program, {
				parameterDefaults: true,
				expression: (node) => {
					offered.push(node)

					return node
				},
			})

			let offeredNodes = new Set<SimpleNode>(offered)
			let walked: Array<SimpleNode> = []

			function visit(node: SimpleNode) {
				forEachSimpleChild(node, visit)

				if (offeredNodes.has(node)) {
					walked.push(node)
				}
			}

			visit(program)

			let first = walked.findIndex(
				(node, index) => node !== offered[index],
			)

			if (first !== -1 || walked.length !== offered.length) {
				misplaced.push(
					`${walked[first]?.nodeType} for ${offered[first]?.nodeType}`,
				)
			}
		}

		expect(misplaced).toEqual([])
	})

	it("tell each visit where in a simplified node the child stands", () => {
		let placesOf = (test: (node: SimpleNode) => boolean) => {
			let places: Array<string> = []

			forEachSimpleChild(
				simple.programs
					.map((program) => findSimple(program, test))
					.find((node) => node !== undefined)!,
				(child, _state, field, key, container) =>
					places.push(
						`${child.nodeType} ${field} ${key} ${container}`,
					),
			)

			return places
		}

		expect(
			placesOf(
				(node) =>
					node.nodeType === "Intrinsic" &&
					node.kind === "inline-loop" &&
					node.driver.kind === "counted",
			),
		).toEqual([
			"Intrinsic from undefined driver",
			"Intrinsic through undefined driver",
			"Intrinsic seed undefined driver",
			"Identifier parameters 0 driver",
			"Identifier parameters 1 driver",
			"ReturnStatement body 0 driver",
		])
		expect(
			placesOf(
				(node) =>
					node.nodeType === "IntrinsicStatement" &&
					node.kind === "statement-match" &&
					node.result.kind === "declaration",
			),
		).toEqual([
			"Identifier name undefined result",
			"Identifier value undefined undefined",
			"Intrinsic literal 0 handlers",
			"ReturnStatement body 0 handlers",
			"Intrinsic typeTest 1 handlers",
			"ReturnStatement body 1 handlers",
			"Intrinsic typeTest 2 handlers",
			"ReturnStatement body 2 handlers",
		])
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

function findSimple(
	node: SimpleNode,
	test: (node: SimpleNode) => boolean,
): SimpleNode | undefined {
	return test(node)
		? node
		: findSimpleChild(node, (child) => findSimple(child, test))
}

function findTyped(
	node: TypedNode,
	test: (node: TypedNode) => boolean,
): TypedNode | undefined {
	return test(node)
		? node
		: findTypedChild(node, (child) => findTyped(child, test))
}
