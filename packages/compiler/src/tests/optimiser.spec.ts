import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { fixturePath } from "@essence-lang/fixtures"
import type { common } from "@essence-lang/interfaces"
import { readStdlibFiles } from "@essence-lang/standard-library"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import {
	loadStdlibFrom,
	parseStdlibSource,
	type Stdlib,
	useStdlib,
} from "../enricher/stdlib"
import {
	defaultOptimiserOptions,
	optimise,
	type OptimiserOptions,
	optimiserOptionsKey,
	optimiserPasses,
	optimiserPassNames,
} from "../optimiser/index"
import { declaredNamespaces } from "../optimiser/namespaces"
import { eliminateDeadCode } from "../optimiser/passes/eliminateDeadCode"
import { poolConstants } from "../optimiser/passes/poolConstants"
import { pruneDeadMatchArms } from "../optimiser/passes/pruneDeadMatchArms"
import { recordMatcherTests } from "../optimiser/residual"
import {
	rewriteExpressions,
	rewriteNodes,
	rewriteStatements,
} from "../optimiser/walk"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { stdlibPrelude, withOptimiserOptions } from "../rewriter/stdlibPrelude"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// The Optimiser's gates: the registry, the shared walk and what each pass
// emits. Above all, a Program prints the same with a pass on or off.

function simplified(fileName: string): common.typedSimple.Program {
	return simplifiedSource(readFileSync(fixturePath(fileName), "utf8"))
}

function simplifiedSource(source: string): common.typedSimple.Program {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return simplify(enriched.program)
}

// The Validator's Warnings about a source, such as the `unreachable-case`
// that `prune-dead-match-arms` acts on.
function validatedDiagnostics(source: string): Array<common.Diagnostic> {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)

	return validate(enriched.program)
}

// Every Match's Matchers in walk order, read off the Nodes rather than the
// emission.
function matchMatchers(
	program: common.typedSimple.Program,
): Array<Array<common.Type>> {
	let matchers: Array<Array<common.Type>> = []

	rewriteExpressions(program, (node) => {
		if (node.nodeType === "Match") {
			matchers.push(node.handlers.map((handler) => handler.matcher))
		}

		return node
	})

	return matchers
}

// The Constants a Program declares at its top level, by name.
function declaredConstantNames(
	program: common.typedSimple.Program,
): Array<string> {
	return program.implementation.nodes.flatMap((node) =>
		node.nodeType === "VariableDeclarationStatement" && node.isConstant
			? [node.name.name]
			: [],
	)
}

function matchHandlerCount(program: common.typedSimple.Program): number {
	return matchMatchers(program).reduce(
		(total, handlers) => total + handlers.length,
		0,
	)
}

// The Options reach the Rewriter too, since the prelude it builds is optimised
// with the same passes.
function generate(
	source: string,
	options: OptimiserOptions = defaultOptimiserOptions,
): string {
	return rewrite(optimise(simplifiedSource(source), options), options)
}

// What a build does: the emitted module is written to a throwaway file and
// imported, so its top-level calls run.
async function outputOf(javaScript: string): Promise<Array<string>> {
	let directory = mkdtempSync(join(tmpdir(), "essence-optimiser-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, javaScript)

	// Both outputs into one buffer in writing order. Holding only `console.log`
	// would read a printing Program as silent, and two silences compare equal.
	let written = ""
	let originalLog = console.log
	let originalOut = process.stdout.write

	console.log = (...args: Array<unknown>) => {
		written += `${args.map((argument) => String(argument)).join(" ")}\n`
	}

	process.stdout.write = ((chunk: unknown) => {
		written += String(chunk)

		return true
	}) as typeof process.stdout.write

	try {
		await import(file)
	} finally {
		console.log = originalLog
		process.stdout.write = originalOut
		rmSync(directory, { recursive: true, force: true })
	}

	return written === "" ? [] : written.replace(/\n$/, "").split("\n")
}

// One emitted top-level const, found by the start of its name, so a spec can
// ask about one prelude body. An Overload's suffix is ignored.
function bodyOf(generated: string, name: string): string {
	let start = generated.indexOf(`const ${name}`)

	expect(start).toBeGreaterThan(-1)

	let rest = generated.slice(start)
	let end = rest.indexOf("\nconst ")

	return end === -1 ? rest : rest.slice(0, end)
}

// The pass contract: a Program prints the same with the named pass off as
// with it on.
async function expectSamePrintedOutput(
	passName: string,
	source: string,
): Promise<Array<string>> {
	let withPass = await outputOf(generate(source))
	let withoutPass = await outputOf(
		generate(source, {
			enabled: true,
			disabledPasses: new Set([passName]),
		}),
	)

	expect(withPass).toEqual(withoutPass)

	return withPass
}

// One Match per rule of `compile-type-tests`. Two List members sharing a tag
// and a Type Parameter must not compile to a tag test. The Record does, as the
// only Record member of its Union.
const typeTests = `implementation {
	choice Shape {
		Circle { radius: Integer },
		Blank,
	}

	function label<infer Item>(
		_ items: List<Item>,
		or fallback: List<Integer> | Item,
	) -> Integer {
		<- match fallback -> Integer {
			case List<Integer> { <- 1 }
			case _ { <- 0 }
		}
	}

	constant scalar: Integer | String = 5
	constant shape: Shape = Shape#Circle({ radius = 3 })
	constant numbers: List<Integer> | Integer = [1, 2, 3]
	constant mixed: List<Integer> | List<String> = ["a"]
	constant clicked: { x: Integer, y: Integer } | String = { x = 1, y = 2 }

	Terminal.inspect(match scalar -> String {
		case Integer { <- "integer" }
		case String  { <- "string" }
	})

	Terminal.inspect(match shape -> Integer {
		case #Circle { <- @.radius }
		case #Blank  { <- 0 }
	})

	Terminal.inspect(match numbers -> Integer {
		case List<Integer> { <- 1 }
		case Integer       { <- 2 }
	})

	Terminal.inspect(match mixed -> Integer {
		case List<String>  { <- 1 }
		case List<Integer> { <- 2 }
	})

	Terminal.inspect(match clicked -> String {
		case { x: Integer, y: Integer } { <- "click" }
		case String                     { <- "text" }
	})

	Terminal.inspect(label(["a"], or [1, 2]))
	Terminal.inspect(label(["a"], or "b"))
}`

// One Match per rule of `compile-record-members`, over Records only their
// members tell apart. They differ by member Type, by member name, beside a
// String, by a Type Parameter member and by a nested member.
const recordMembers = `implementation {
	type Circle = { radius: Integer }
	type Rect = { width: Integer, height: Integer }
	type Horizontal = { at: { x: Integer }, name: String }
	type Vertical = { at: { y: String }, name: String }

	function which(_ boxed: { value: Integer } | { value: String }) -> String {
		<- match boxed -> String {
			case { value: Integer } { <- "integer" }
			case { value: String }  { <- "string" }
		}
	}

	function area(_ shape: Circle | Rect) -> String {
		<- match shape -> String {
			case { radius: Integer }                 { <- "circle" }
			case { width: Integer, height: Integer } { <- "rect" }
		}
	}

	function labelled(_ shape: Circle | Rect | String) -> String {
		<- match shape -> String {
			case { radius: Integer }                 { <- "radius" }
			case { width: Integer, height: Integer } { <- "sides" }
			case String                              { <- "text" }
		}
	}

	function tagged<infer Item>(
		_ value: { held: Item, mark: Integer } | { held: Item, mark: String },
	) -> String {
		<- match value -> String {
			case { held: Item, mark: Integer } { <- "integer mark" }
			case { held: Item, mark: String }  { <- "string mark" }
		}
	}

	function axis(_ node: Horizontal | Vertical) -> String {
		<- match node -> String {
			case { at: { x: Integer } } { <- "horizontal" }
			case { at: { y: String } }  { <- "vertical" }
		}
	}

	Terminal.inspect(which({ value = 1 }))
	Terminal.inspect(which({ value = "s" }))
	Terminal.inspect(area({ radius = 1 }))
	Terminal.inspect(area({ width = 2, height = 3 }))
	Terminal.inspect(area({ radius = 1, width = 2, height = 3 }))
	Terminal.inspect(tagged({ held = 1, mark = 2 }))
	Terminal.inspect(tagged({ held = "s", mark = "m" }))
	Terminal.inspect(axis({ at = { x = 1 }, name = "a" }))
	Terminal.inspect(axis({ at = { y = "b" }, name = "c" }))
	Terminal.inspect(labelled({ radius = 1 }))
	Terminal.inspect(labelled("t"))
}`

// One of each thing `pool-constants` declares once. A witness for a Namespace
// the Program declares stays where it was written, and the Boolean is left
// alone. The Match is over two Records, so it is no tag test. Its `at` member
// is declared by one Record only and holds a Record, so `compile-record-members`
// declines and leaves a descriptor to pool. The pooled witness is the one
// `sort` is passed, since `devirtualise-witnesses` removes a hole's.
const constants = `implementation {
	type Box = { value: Integer }

	namespace Boxes for Box is Comparable {
		§§ Compares two Boxes by the value each holds.
		§§
		§§ @param other — the Box to compare with
		§§ @returns — how this Box orders against it.
		compare(to other: Box) -> Ordering {
			<- @.value::compare(to other.value)
		}
	}

	choice Colour { Red, Green }

	constant boxes: List<Box> = [{ value = 3 }, { value = 1 }]
	constant shape: { at: { x: Integer } } | { key: String } = { at = { x = 7 } }
	constant chosen: Colour = #Red

	Terminal.inspect(1::add(1))
	Terminal.inspect(1/2)
	Terminal.inspect(chosen::is(#Red))
	Terminal.inspect(true)
	Terminal.inspect("a count: {7}")
	Terminal.inspect([2, 1]::sort())
	Terminal.inspect(boxes::sort())
	Terminal.inspect(match shape -> String {
		case { key: String }        { <- "text" }
		case { at: { x: Integer } } { <- "a Record" }
	})
}`

// The shapes `lower-unit-case-equality` must rewrite beside those it must leave
// alone. `1::isLessThan(2)` reaches the standard library, which the pass also
// runs over.
const unitCaseEquality = `implementation {
	choice Colour { Red, Green }

	choice Shape {
		Circle { radius: Integer },
		Blank,
	}

	choice Box<Item> {
		Holding { item: Item },
		Void,
	}

	constant red: Colour = #Red
	constant green: Colour = #Green
	constant circle: Shape = Shape#Circle({ radius = 1 })
	constant blank: Shape = #Blank
	constant void: Box<Integer> = #Void
	constant held: Box<Integer> = Box#Holding({ item = 1 })

	Terminal.inspect(red::is(#Green))
	Terminal.inspect(red::isNot(#Green))
	Terminal.inspect(Colour#Red::is(red))
	Terminal.inspect(Colour#Red::isNot(green))
	Terminal.inspect(blank::is(#Blank))
	Terminal.inspect(circle::is(#Blank))
	Terminal.inspect(circle::is(Shape#Circle({ radius = 1 })))
	Terminal.inspect(void::is(#Void))
	Terminal.inspect(held::is(#Void))
	Terminal.inspect(held::is(Box#Holding({ item = 1 })))
	Terminal.inspect(1::isLessThan(2))
}`

// Every operation `lower-scalar-operations` writes out, beside those it must
// refuse: mixed-kind operations, the three-Argument `is`, and an `and` whose
// Argument prints, which must still run. `NonZeroInteger.multiply` is Integer's
// product, while the proven scaling of a Transcendental shares its names but is
// no bigint operation.
const scalarOperations = `implementation {
	§§ Prints as it answers, so that skipping it is visible.
	§§
	§§ @returns — always true.
	function noisy() -> Boolean {
		Terminal.inspect("evaluated")

		<- true
	}

	constant a = 3
	constant b = 5
	constant proven: NonZeroInteger = 3
	constant alsoProven: NonZeroInteger = 5
	constant text = "ab"
	constant other = "ba"
	constant yes = true
	constant no = false

	Terminal.inspect(a::isLessThan(b))
	Terminal.inspect(a::isLessThanOrEqualTo(b))
	Terminal.inspect(a::isGreaterThan(b))
	Terminal.inspect(a::isGreaterThanOrEqualTo(b))
	Terminal.inspect(a::is(b))
	Terminal.inspect(a::isNot(b))
	Terminal.inspect(a::add(b))
	Terminal.inspect(a::subtract(b))
	Terminal.inspect(a::multiply(with b))
	Terminal.inspect(proven::multiply(with alsoProven))
	Terminal.inspect(proven::multiply(with Number.Pi))

	Terminal.inspect(text::is(other))
	Terminal.inspect(text::isNot(other))
	Terminal.inspect(text::is("AB", comparing #Insensitive))

	Terminal.inspect(yes::negate())
	Terminal.inspect(yes::and(no))
	Terminal.inspect(yes::or(no))
	Terminal.inspect(no::and(noisy()))

	Terminal.inspect(a::isLessThan(1/2))
	Terminal.inspect(a::add(1/2))
}`

// The shadowed `Integer` call is the Argument of an `and` whose receiver is
// false, which `&&` would skip. It must still print.
const shadowedArgument = `implementation {
	variable ran = false

	§§ Answers false, having run a Method the Program wrote.
	§§
	§§ @returns — false.
	function trick() -> Boolean {
		§§ A liar that says so.
		namespace Integer for Integer {
			§§ Always true, loudly.
			§§
			§§ @param _ — ignored
			§§ @returns — true
			is(_ other: Integer) -> Boolean {
				ran = true

				Terminal.inspect("the shadow ran")

				<- true
			}
		}

		<- false::and(1::is(2))
	}

	Terminal.inspect(trick())
	Terminal.inspect(ran)
}`

// One dispatch of each shape `compile-union-dispatch` answers for. They cover
// tags, shared tags, per-branch Arguments and witnesses, a Record beside a
// Boolean, a printing Argument, a call receiver, a catch-all and Overloads.
const unionDispatch = `implementation {
	§§ Prints as it answers, so that a skipped or repeated evaluation is visible.
	§§
	§§ @returns — a suffix.
	function noisy() -> String {
		Terminal.inspect("evaluated")

		<- "!"
	}

	§§ Answers what it is given, so that a dispatch's receiver is a call.
	§§
	§§ @param _ — a member of the Union
	§§ @returns — the value.
	function identity(_ value: Integer | Boolean) -> Integer | Boolean {
		<- value
	}

	§§ Renders the fallback, whichever member of the Union it is.
	§§
	§§ @param item — decides what the Type Parameter is
	§§ @param fallback — the value to render
	§§ @returns — the value, written out.
	function describe<infer Item is Printable>(
		_ item: Item,
		or fallback: Item | Boolean,
	) -> String {
		<- fallback::toString()
	}

	type Box = { size: Integer }

	namespace Boxes for Box {
		§§ Names the Box.
		§§
		§§ @param suffix — appended to the name
		§§ @returns — the name.
		tagged(with suffix: String) -> String {
			<- "box{suffix}"
		}
	}

	namespace Flags for Boolean {
		§§ Names the Boolean.
		§§
		§§ @param suffix — appended to the name
		§§ @returns — the name.
		tagged(with suffix: String) -> String {
			<- "flag{suffix}"
		}
	}

	constant number: Number = 5
	constant value: Integer | Boolean = 5
	constant items: List<Integer> | List<String> = ["b", "a"]
	constant either: Box | Boolean = { size = 3 }

	Terminal.inspect(value::toString())
	Terminal.inspect(items::length())
	Terminal.inspect(items::map((item) { <- "{item}!" }))
	Terminal.inspect(items::sort())
	Terminal.inspect(either::tagged(with "?"))
	Terminal.inspect(either::tagged(with noisy()))
	Terminal.inspect(identity(5)::toString())
	Terminal.inspect(describe(1, or 2))
	Terminal.inspect(describe(1, or true))
	Terminal.inspect(number::multiply(with 2)::toString())
}`

// `flip` assigns the variable the dispatch reads, so the chain must read the
// receiver before evaluating the Argument.
const dispatchOrder = `implementation {
	type Box = { size: Integer }

	namespace Boxes for Box {
		§§ Names the Box.
		§§
		§§ @param suffix — appended to the name
		§§ @returns — the name.
		tagged(with suffix: String) -> String {
			<- "box{suffix}"
		}
	}

	namespace Flags for Boolean {
		§§ Names the Boolean.
		§§
		§§ @param suffix — appended to the name
		§§ @returns — the name.
		tagged(with suffix: String) -> String {
			<- "flag{suffix}"
		}
	}

	variable either: Box | Boolean = { size = 3 }

	§§ Changes the receiver out from under the dispatch.
	§§
	§§ @returns — a suffix.
	function flip() -> String {
		either = true

		<- "!"
	}

	Terminal.inspect(either::tagged(with flip()))
}`

// A witness of each kind a hole can be given. The conditional one stays an
// object, since its Method is curried. The `sort` witness is handed on, so
// `pool-constants` builds it.
const witnesses = `implementation {
	type Box = { size: Integer }

	namespace Boxes for Box is Printable, is Comparable {
		§§ Renders the Box as a String.
		§§
		§§ @returns — the Box, written out.
		toString() -> String {
			<- "a box of {@.size}"
		}

		§§ Compares two Boxes by the size each holds.
		§§
		§§ @param other — the Box to compare with
		§§ @returns — how this Box orders against it.
		compare(to other: Box) -> Ordering {
			<- @.size::compare(to other.size)
		}
	}

	constant count = 3
	constant box: Box = { size = 3 }
	constant nested: List<Integer> = [1, 2]

	Terminal.inspect("you have {count} left")
	Terminal.inspect("{box}")
	Terminal.inspect("nested: {nested}")
	Terminal.inspect([2, 1]::sort()::toString())
}`

// A hole whose witness writes no `toString`: another Protocol the
// Namespace conforms to provides the body `Printable` requires.
const providedToString = `implementation {
	protocol Named {
		toString() -> String {
			<- "named"
		}
	}

	type Box = { size: Integer }

	namespace Boxes for Box is Printable, is Named {}

	constant box: Box = { size = 3 }

	Terminal.print("a {box}")
}`

// The shapes `collapse-construction` rewrites, in one Program that prints what
// it built.
const constructions = `implementation {
	choice Shape {
		Circle { radius: Integer },
		Blank,
	}

	constant point = { x = 1, y = 2 }
	constant single = { only = 1 }
	constant awkward = { ok? = 1 }
	constant items = [1, 2, 3]
	constant nested = [[1], [2]]
	constant payload = { radius = 4 }

	constant circle: Shape = Shape#Circle({ radius = 3 })
	constant held: Shape = Shape#Circle(payload)
	constant blank: Shape = Shape#Blank

	Terminal.inspect(point)
	Terminal.inspect(single)
	Terminal.inspect(awkward)
	Terminal.inspect(items)
	Terminal.inspect(nested)
	Terminal.inspect(circle)
	Terminal.inspect(held)
	Terminal.inspect(blank)
	Terminal.inspect(circle::is(held))
	Terminal.inspect(blank::is(Shape#Blank))
	Terminal.inspect(match circle -> Integer {
		case #Circle { <- @.radius }
		case #Blank { <- 0 }
	})
}`

// Sorting Lists of Lists curries a witness onto a witness, and one level deeper
// onto another. The `boundConformance(…)` call is pooled, and the two depths
// must stay apart or the deeper Lists sort wrongly.
const conditionalConformances = `implementation {
	Terminal.inspect([[3], [1, 2]]::sort())
	Terminal.inspect([[[2]], [[1]]]::sort())
	Terminal.inspect([1, 2]::compare(to [1, 2, 3])::toString())
}`

// Derived `Enumerable` witnesses differ only by the tags their helper is
// curried with, which `pool-constants` keys by.
const derivedCaseListings = `implementation {
	choice Colour {
		Red,
		Green,
	}

	choice Size {
		Small,
		Medium,
		Large,
	}

	function count<infer Mode is Enumerable>(_ example: Mode) -> Integer {
		<- Mode.cases()::length()
	}

	constant red: Colour = #Red
	constant small: Size = #Small

	Terminal.inspect(count(red))
	Terminal.inspect(count(small))
	Terminal.inspect(count(red))
}`

// The shapes `collapse-combinations` rewrites. A right-hand side is a Partial,
// so it adds no member the left-hand side lacks.
const combinations = `implementation {
	constant base = { x = 1, y = 2 }
	constant changes = { x = 9 }

	constant overridden = { base with changes }
	constant both = { base with x = 8, y = 9 }
	constant replaced = { base with x = 7 }

	Terminal.inspect(base)
	Terminal.inspect(overridden)
	Terminal.inspect(both)
	Terminal.inspect(replaced)
	Terminal.inspect(base::is({ x = 1, y = 2 }))
}`

// A Match in each position `lower-matches-to-statements` writes out, beside
// those it leaves alone. `sized` answers early and needs a labelled break. A
// Match mid-Expression keeps its wrapper.
const statementMatches = `implementation {
	choice Shape {
		Circle { radius: Integer },
		Blank,
	}

	type Box = { held: Integer | String }

	namespace Shapes for Shape {
		§§ Answers the radius, or zero.
		§§
		§§ @returns — the radius.
		radius() -> Integer {
			<- match @ -> Integer {
				case #Circle { <- @.radius }
				case #Blank { <- 0 }
			}
		}

		§§ Names the Shape by how big it is.
		§§
		§§ @returns — the name.
		sized() -> String {
			constant name = match @ -> String {
				case #Circle {
					if @.radius::isGreaterThan(2) {
						<- "a big circle"
					}

					<- "a circle"
				}
				case #Blank { <- "nothing" }
			}

			<- name
		}
	}

	namespace Boxes for Box {
		§§ Names what the Box holds.
		§§
		§§ @returns — the name.
		holding() -> String {
			<- match @.held -> String {
				case Integer { <- "an Integer" }
				case String { <- "a String" }
			}
		}
	}

	constant circle: Shape = Shape#Circle({ radius = 3 })
	constant small: Shape = Shape#Circle({ radius = 1 })
	constant blank: Shape = #Blank
	constant box: Box = { held = 5 }

	constant described = match circle -> String {
		case #Circle { <- "a circle" }
		case #Blank { <- "nothing" }
	}

	match blank -> {} {
		case #Circle { Terminal.inspect("circle") }
		case #Blank { Terminal.inspect("blank") }
	}

	Terminal.inspect(circle::radius())
	Terminal.inspect(circle::sized())
	Terminal.inspect(small::sized())
	Terminal.inspect(blank::sized())
	Terminal.inspect(box::holding())
	Terminal.inspect(described)
	Terminal.inspect(match blank -> String {
		case #Circle { <- "a circle" }
		case #Blank { <- "nothing" }
	})
}`

// A Match nested in another's Handler answers the outer Declaration and breaks
// out of the outer label.
const nestedStatementMatches = `implementation {
	§§ Names a value the long way round.
	§§
	§§ @param _ — the value to name
	§§ @returns — the name.
	function named(_ value: Integer | String) -> String {
		constant name = match value -> String {
			case Integer {
				<- match value -> String {
					case Integer {
						if @::isGreaterThan(0) {
							<- "a positive Integer"
						}

						<- "an Integer"
					}
					case String { <- "unreachable" }
				}
			}
			case String { <- "a String" }
		}

		<- name
	}

	Terminal.inspect(named(1))
	Terminal.inspect(named(-1))
	Terminal.inspect(named("x"))
}`

// A Handler binding the very name the lowered Match writes its answer to, in
// each shape a name can be bound. None may take the assignment meant for the
// Declaration.
const shadowedAnswerNames = `implementation {
	constant value: Integer | String = 5

	constant answerA = match value -> Integer {
		case Integer {
			constant answerA = 1

			<- answerA::add(5)
		}
		case String { <- 0 }
	}

	constant answerB = match value -> Integer {
		case Integer {
			§§ Answers what it is given, plus one.
			§§
			§§ @param _ — the Integer to answer for
			§§ @returns — one more than it.
			function answerB(_ n: Integer) -> Integer {
				<- n::add(1)
			}

			<- answerB(5)
		}
		case String { <- 0 }
	}

	constant answerC = match value -> Integer {
		case Integer {
			if @::isGreaterThan(1) {
				constant answerC = 7

				<- answerC
			}

			<- 1
		}
		case String { <- 0 }
	}

	constant answerD = match value -> Integer {
		case Integer {
			§§ Not the standard library's, and not read either.
			namespace answerD for Integer {
				§§ Twice this Integer.
				§§
				§§ @returns — twice it.
				doubled() -> Integer {
					<- @::multiply(with 2)
				}
			}

			<- 4::doubled()
		}
		case String { <- 0 }
	}

	constant answerE = match value -> Integer {
		case Integer {
			<- match value -> Integer {
				case Integer {
					constant answerE = 9

					<- answerE
				}
				case String { <- 0 }
			}
		}
		case String { <- 0 }
	}

	variable answerF = 0

	answerF = match value -> Integer {
		case Integer {
			constant answerF = 3

			if @::isGreaterThan(1) {
				<- answerF::add(8)
			}

			<- answerF
		}
		case String { <- 0 }
	}

	Terminal.inspect(answerA)
	Terminal.inspect(answerB)
	Terminal.inspect(answerC)
	Terminal.inspect(answerD)
	Terminal.inspect(answerE)
	Terminal.inspect(answerF)
}`

// A discarded Match whose Handler answers a call that only looks like
// arithmetic: the Program's own `Integer` prints, so the Return may not be
// dropped.
const shadowedDiscardedAnswer = `implementation {
	§§ Runs a Match for its effects, and answers nothing much.
	§§
	§§ @returns — zero.
	function trick() -> Integer {
		§§ Not the standard library's.
		namespace Integer for Integer {
			§§ Nine, whatever it is given.
			§§
			§§ @param _ — ignored
			§§ @returns — nine.
			subtract(_ other: Integer) -> Integer {
				Terminal.inspect("the shadow ran")

				<- 9
			}
		}

		constant scrutinee: Integer | String = 5

		match scrutinee -> Integer {
			case Integer { <- 1::subtract(2) }
			case String { <- 0 }
		}

		<- 0
	}

	Terminal.inspect(trick())
}`

// The same shadow, standing where a Constant nobody reads is bound to it.
// Dropping the Declaration would drop the only thing the call does.
const shadowedDeadCode = `implementation {
	§§ Binds a name nothing reads, and answers zero.
	§§
	§§ @returns — zero.
	function trick() -> Integer {
		§§ Not the standard library's.
		namespace Integer for Integer {
			§§ Nine, whatever it is given.
			§§
			§§ @param _ — ignored
			§§ @returns — nine.
			subtract(_ other: Integer) -> Integer {
				Terminal.inspect("the shadow ran")

				<- 9
			}
		}

		constant unread = 1::subtract(2)

		<- 0
	}

	Terminal.inspect(trick())
}`

// A compiled Union dispatch holding operands, in each Statement position its
// wrapper can be removed in. `either::tagged(with flip())` keeps its operands
// in written order.
const heldDispatches = `implementation {
	type Box = { size: Integer }

	namespace Boxes for Box {
		§§ Names the Box.
		§§
		§§ @param suffix — appended to the name
		§§ @returns — the name.
		tagged(with suffix: String) -> String {
			<- "box{suffix}"
		}
	}

	namespace Flags for Boolean {
		§§ Names the Boolean.
		§§
		§§ @param suffix — appended to the name
		§§ @returns — the name.
		tagged(with suffix: String) -> String {
			<- "flag{suffix}"
		}
	}

	§§ Answers what it is given, so that a dispatch's receiver is a call.
	§§
	§§ @param _ — a member of the Union
	§§ @returns — the value.
	function identity(_ value: Integer | Boolean) -> Integer | Boolean {
		<- value
	}

	§§ Renders a Union whose receiver is a call.
	§§
	§§ @returns — the rendering.
	function rendered() -> String {
		<- identity(5)::toString()
	}

	variable either: Box | Boolean = { size = 3 }

	§§ Changes the receiver out from under the dispatch.
	§§
	§§ @returns — a suffix.
	function flip() -> String {
		either = true

		<- "!"
	}

	constant tagged = either::tagged(with flip())

	identity(5)::toString()

	Terminal.inspect(rendered())
	Terminal.inspect(tagged)
	Terminal.inspect(either)
}`

// A Conditional an earlier pass already lowered, beside one whose question is
// an Essence Boolean a written Method answers.
const conditions = `implementation {
	namespace Flags for Boolean {
		§§ Answers the Boolean it is called on.
		§§
		§§ @returns — the Boolean.
		itself() -> Boolean {
			<- @
		}
	}

	constant a = 3
	constant b = 5
	constant yes = true

	if a::isLessThan(b) {
		Terminal.inspect("less")
	} else {
		Terminal.inspect("more")
	}

	if yes::itself() {
		Terminal.inspect("yes")
	} else {
		Terminal.inspect("no")
	}
}`

// One Program per driver `inline-loops` knows, since each is emitted from its
// own reading. The counted one: up, down, and in Statement position.
const countedLoop = `implementation {
	constant sum = loop(from 1, through 10, startingWith 0, (
		index,
		total,
	) { <- total::add(index) })

	constant down = loop(from 3, downTo 1, startingWith 0, (
		index,
		total,
	) { <- total::add(index) })

	constant once = loop(from 2, through 2, startingWith 0, (
		index,
		total,
	) { <- total::add(index) })

	Terminal.inspect(sum)
	Terminal.inspect(down)
	Terminal.inspect(once)
}`

// The two condition-driven entries, which are one driver read two ways.
const conditionLoops = `implementation {
	constant doubled = loop(startingWith 1, while (n) {
		<- n::isLessThan(100)
	}, (n) { <- n::multiply(with 2) })

	constant same = loop(startingWith 1, until (n) {
		<- n::isGreaterThanOrEqualTo(100)
	}, (n) { <- n::multiply(with 2) })

	Terminal.inspect(doubled)
	Terminal.inspect(same)
}`

// The general entry, whose body builds its `Step` at the answering position,
// which the pass reads rather than allocates.
const generalLoop = `implementation {
	constant limit = 5

	constant result = loop(startingWith { index = 1, total = 0 }, step (state) {
		if state.index::isGreaterThan(limit) {
			<- #Done(state.total)
		}

		<- #Continue({ state with index = state.index::add(1),
		total = state.total::add(state.index) })
	})

	Terminal.inspect(result)
}`

// The same entry answering with a `Step` held under a name first.
const heldStep = `implementation {
	constant stopped = loop(startingWith 0, step (n) {
		constant answer: Step<Integer, Integer> = #Done(n)

		<- answer
	})

	Terminal.inspect(stopped)
}`

// List's walking Methods, and `map` given a Function-valued name, which stays a
// call.
const listWalks = `implementation {
	constant items = [1, 2, 3]

	Terminal.inspect(items::reduce(startingWith 0, (total, item) {
		<- total::add(item)
	}))

	Terminal.inspect(items::reduce(startingWith 0, step (total, item) {
		if item::isGreaterThan(2) {
			<- #Done(total)
		}

		<- #Continue(total::add(item))
	})::toString())

	Terminal.inspect(items::map((item) { <- item::multiply(with 2) })::length())
	Terminal.inspect(items::everyItem(where (item) {
		<- item::isGreaterThan(1)
	})::length())

	constant double = (_ item: Integer) -> Integer { <- item::multiply(with 2) }

	Terminal.inspect(items::map(double)::length())
}`

// The walks over a proven receiver beside the ordinary twin. `NonEmptyList`
// declares its own `map`, so the gate is per Method. `reverse` and
// `prepend(contentsOf:)` are not walks the pass knows.
const provenWalks = `implementation {
	constant proven: NonEmptyList<Integer> = [1, 2, 3]
	constant written = [1, 2, 3]

	Terminal.inspect(proven::map((item) { <- item::multiply(with 2) })::length())
	Terminal.inspect(written::map((item) { <- item::multiply(with 2) })::length())

	Terminal.inspect(proven::everyItem(where (item) {
		<- item::isGreaterThan(1)
	})::length())

	Terminal.inspect(proven::reduce(startingWith 0, (total, item) {
		<- total::add(item)
	}))

	Terminal.inspect(proven::reduce(startingWith 0, step (total, item) {
		if item::isGreaterThan(2) {
			<- #Done(total)
		}

		<- #Continue(total::add(item))
	})::toString())

	Terminal.inspect(proven::reverse()::firstItem())
	Terminal.inspect(proven::prepend(contentsOf [0])::firstItem())
}`

// A Program declaring its own `NonEmptyList` keeps its proven walks as calls,
// while the ordinary ones are still inlined.
const shadowedNonEmptyList = `implementation {
	§§ Answers a doubled Integer, from a Namespace named after a builtin.
	§§
	§§ @returns — the doubled Integer.
	function trick() -> Integer {
		§§ Not the standard library's.
		namespace NonEmptyList for Integer {
			§§ The Integer, handed to the given transform.
			§§
			§§ @param _ — the transform to apply
			§§ @returns — whatever the transform answered.
			map(_ transform: (_: Integer) -> Integer) -> Integer {
				<- transform(@)
			}
		}

		<- 21::map((n) { <- n::multiply(with 2) })
	}

	constant proven: NonEmptyList<Integer> = [1, 2]
	constant written: List<Integer>        = [1, 2]

	Terminal.inspect(trick())
	Terminal.inspect(proven::map((item) { <- item::add(1) })::length())
	Terminal.inspect(written::map((item) { <- item::add(1) })::length())
}`

// A Program declaring a Namespace named `List` keeps every walk a call. The walk
// reads a bound List, since a written one would reach `NonEmptyList`.
const shadowedList = `implementation {
	§§ Answers a doubled Integer, from a Namespace named after a builtin.
	§§
	§§ @returns — the doubled Integer.
	function trick() -> Integer {
		§§ Not the standard library's.
		namespace List for Integer {
			§§ Twice the Integer.
			§§
			§§ @returns — the doubled Integer.
			doubled() -> Integer {
				<- @::multiply(with 2)
			}
		}

		<- 21::doubled()
	}

	constant written: List<Integer> = [1, 2]

	Terminal.inspect(trick())
	Terminal.inspect(written::map((item) { <- item::add(1) })::length())
}`

// A walk in an Argument has nowhere to write a `while`, so the arrow stays.
const argumentLoop = `implementation {
	Terminal.inspect(loop(startingWith 1, while (n) {
		<- n::isLessThan(10)
	}, (n) { <- n::multiply(with 2) }))
}`

// A walk inside a walk's body, whose names are numbered apart.
const nestedLoops = `implementation {
	Terminal.inspect(loop(from 1, through 3, startingWith 0, (index, total) {
		<- total::add(loop(from 1, through index, startingWith 0, (
			inner,
			carried,
		) { <- carried::add(inner) }))
	}))
}`

// The predicate's Parameter shares its name with a Constant the step reads,
// so each Parameter is bound in a Scope of its own.
const shadowedParameter = `implementation {
	constant total = 100

	constant answer = loop(startingWith 1, while (total) {
		<- total::isLessThan(10)
	}, (n) { <- n::add(total) })

	Terminal.inspect(answer)

	constant items = [1, 2, 3]

	Terminal.inspect(items::everyItem(where (items) {
		<- items::isGreaterThan(1)
	})::length())
	Terminal.inspect(items::map((total) { <- total::add(1) })::length())
}`

// The order the call evaluates in, printed.
const orderedLoops = `implementation {
	Terminal.inspect(loop(from Terminal.inspect(1), through Terminal.inspect(3), startingWith Terminal.inspect(0),
	(index, total) { <- total::add(index) }))

	Terminal.inspect(Terminal.inspect([1, 2])::reduce(startingWith Terminal.inspect(0), (total, item) {
		<- total::add(item)
	}))
}`

// A List grown at both ends, sharing its Arrays with two other Lists, and read
// every way. The Match makes `isValueOfType` walk items held in two runs. See
// "Why `type.ts` reads containers itself" in packages/runtime/DEVELOPMENT.md.
const bothEnds = `implementation {
	constant seed = [3, 4]
	constant front = seed::prepend(2)::prepend(1)
	constant both = front::append(5)::append(6)
	constant more = both::append(contentsOf [7, 8])
	constant other = both::append(9)
	constant tagged: List<Integer> | List<String> = front

	Terminal.inspect(seed)
	Terminal.inspect(front)
	Terminal.inspect(both)
	Terminal.inspect(more)
	Terminal.inspect(other)
	Terminal.inspect(more::length())
	Terminal.inspect(more::item(at 0))
	Terminal.inspect(more::item(at 2))
	Terminal.inspect(more::item(at -1))
	Terminal.inspect(more::slice(from 1, to 4))
	Terminal.inspect(more::reverse())
	Terminal.inspect(more::map((item) { <- item::multiply(with 2) }))
	Terminal.inspect(more::everyItem(where (item) { <- item::isGreaterThan(3) }))
	Terminal.inspect(more::reduce(startingWith 0, (total, item) { <- total::add(item) }))
	Terminal.inspect(front::is([1, 2, 3, 4]))

	Terminal.inspect(match tagged -> Integer {
		case List<String>  { <- 0 }
		case List<Integer> { <- @::length() }
	})
}`

// The same List edited every way, with four other Lists living on its Arrays.
// Every answer is bound before anything prints, since printing combines a
// List's runs.
const bothEndsEdited = `implementation {
	constant seed = [4, 5, 6]
	constant both = seed::prepend(3)::prepend(2)::prepend(1)::append(7)::append(8)
	constant window = both::slice(from 1, to 7)

	constant withoutFirst = both::remove(at 0)
	constant withoutMiddle = both::remove(at 3)
	constant withoutLast = both::remove(at -1)
	constant pastTheEnd = both::remove(at 8)
	constant beforeTheStart = both::remove(at -9)

	constant atTheHead = both::insert(0, at 0)
	constant inTheMiddle = both::insert(99, at 3)
	constant atTheTail = both::insert(99, at 8)
	constant beforeTheLast = both::insert(99, at -1)
	constant clampedPastTheEnd = both::insert(99, at 99)

	constant firstReplaced = both::replace(99, at 0)
	constant fifthReplaced = both::replace(99, at 4)
	constant lastReplaced = both::replace(99, at -1)
	constant nothingReplaced = both::replace(99, at 99)

	constant windowReplaced = window::replace(99, at 2)
	constant windowShortened = window::remove(at 2)
	constant windowGrown = window::append(97)
	constant windowLed = window::prepend(96)

	constant firstDropped = both::removeFirst()
	constant lastDropped = both::removeLast()
	constant threeDropped = both::removeFirst(3)
	constant threeTrimmed = both::removeLast(3)

	Terminal.inspect(both)
	Terminal.inspect(window)
	Terminal.inspect(withoutFirst)
	Terminal.inspect(withoutMiddle)
	Terminal.inspect(withoutLast)
	Terminal.inspect(pastTheEnd)
	Terminal.inspect(beforeTheStart)
	Terminal.inspect(atTheHead)
	Terminal.inspect(inTheMiddle)
	Terminal.inspect(atTheTail)
	Terminal.inspect(beforeTheLast)
	Terminal.inspect(clampedPastTheEnd)
	Terminal.inspect(firstReplaced)
	Terminal.inspect(fifthReplaced)
	Terminal.inspect(lastReplaced)
	Terminal.inspect(nothingReplaced)
	Terminal.inspect(windowReplaced)
	Terminal.inspect(windowShortened)
	Terminal.inspect(windowGrown)
	Terminal.inspect(windowLed)
	Terminal.inspect(firstDropped)
	Terminal.inspect(lastDropped)
	Terminal.inspect(threeDropped)
	Terminal.inspect(threeTrimmed)
	Terminal.inspect(both)
	Terminal.inspect(window)
}`

// The shape `build-lists-in-place` is for: a counted walk whose List State is
// only appended to. A chain's second link resolves on `NonEmptyList`. See
// "Lists built in place" in packages/compiler/src/rewriter/DEVELOPMENT.md.
const builtList = `implementation {
	constant built = loop(from 1, through 4, startingWith [0], (index, list) {
		<- list::append(index)
	})

	constant batched = loop(from 1, through 3, startingWith [0], (index, list) {
		<- list::append(index)::append(contentsOf [index, index])
	})

	§ The other half of the addition: a List under a name, which nothing may
	§ take the Array of, so its items are walked out of the box it is held in.
	constant tail = [7, 8]
	constant joined = loop(from 1, through 2, startingWith [0], (index, list) {
		<- list::append(contentsOf tail)
	})

	Terminal.inspect(built)
	Terminal.inspect(batched)
	Terminal.inspect(joined)
}`

// The other walks that thread a State. The `Step` walk stops on a `variable`,
// since reading its own accumulator to stop would be declined.
const builtStates = `implementation {
	constant folded = [1, 2, 3]::reduce(startingWith [0], (accumulated, item) {
		<- accumulated::append(item)
	})

	constant stopped = [1, 2, 3, 4, 5]::reduce(startingWith [0], step (
		accumulated,
		item,
	) {
		if item::isGreaterThan(3) {
			<- #Done(accumulated)
		} else {
			<- #Continue(accumulated::append(item))
		}
	})

	variable turns = 0
	constant stepped = loop(startingWith [0], step (list) {
		turns = turns::add(1)

		if turns::isGreaterThan(3) {
			<- #Done(list)
		} else {
			<- #Continue(list::append(turns))
		}
	})

	Terminal.inspect(folded)
	Terminal.inspect(stopped)
	Terminal.inspect(stepped)
}`

// A branch that changes nothing answers the bare accumulator, and a `#Done`
// answering something else leaves the built Array behind.
const builtBranches = `implementation {
	constant sparse = loop(from 1, through 6, startingWith [0], (index, list) {
		if index::isGreaterThan(3) {
			<- list
		} else {
			<- list::append(index)
		}
	})

	constant elsewhere = [1, 2, 3, 4]::reduce(startingWith [0], step (
		accumulated,
		item,
	) {
		if item::isGreaterThan(2) {
			<- #Done([99])
		} else {
			<- #Continue(accumulated::append(item))
		}
	})

	Terminal.inspect(sparse)
	Terminal.inspect(elsewhere)
}`

// `paced` elides its State Parameter in two callbacks. `doubled` takes both
// elisions: an unbuilt counter Integer and a List built in place.
const builtBesideElisions = `implementation {
	variable turns = 0
	constant paced = loop(startingWith [0], while (list) {
		<- turns::isLessThan(3)
	}, (list) {
		turns = turns::add(1)

		<- list::append(turns)
	})

	constant doubled = loop(from 1, through 4, startingWith [0], (
		index,
		list,
	) {
		<- list::append(index::add(1))
	})

	Terminal.inspect(paced)
	Terminal.inspect(doubled)
}`

// The old `current` survives inside `snapshots`, so pushing onto its Array would
// change a recorded value. The body reads `current` twice, which declines it.
const retainedAccumulator = `implementation {
	constant history: List<List<Integer>> = []
	constant walked = loop(from 1, through 3, startingWith {
		current = [0],
		snapshots = history,
	}, (index, state) {
		<- {
			current = state.current::append(index),
			snapshots = state.snapshots::append(state.current),
		}
	})

	Terminal.inspect(walked.current)
	Terminal.inspect(walked.snapshots)
}`

// One Program per way of mentioning the accumulator outside a rebuilding chain.
// Each is declined and answers as the copying emission does.
const declinedAccumulators = `implementation {
	constant read = loop(from 1, through 3, startingWith [0], (index, list) {
		<- list::append(list::length())
	})

	constant captured = loop(from 1, through 3, startingWith [0], (
		index,
		list,
	) {
		constant seen = [1]::map((item) { <- list::length() })

		<- list::append(seen::length())
	})

	constant walked = loop(from 1, through 3, startingWith [0], (
		index,
		list,
	) {
		<- list::append(list::reduce(startingWith 0, (total, item) {
			<- total::add(item)
		}))
	})

	constant doubled = loop(from 1, through 3, startingWith [0], (
		index,
		list,
	) {
		<- list::append(contentsOf list)
	})

	constant fronted = loop(from 1, through 3, startingWith [0], (
		index,
		list,
	) {
		<- list::prepend(index)
	})

	Terminal.inspect(read)
	Terminal.inspect(captured)
	Terminal.inspect(walked)
	Terminal.inspect(doubled)
	Terminal.inspect(fronted)
}`

// A held seed is copied at entry, so neither the seed nor the answer sees the
// other's appends. The fold over the empty List runs no turns and answers its
// seed.
const seededBuilds = `implementation {
	constant seed = [1, 2]
	constant grown = loop(from 3, through 5, startingWith seed, (
		index,
		list,
	) {
		<- list::append(index)
	})

	constant nothing: List<Integer> = []
	constant untouched = nothing::reduce(startingWith seed, (accumulated, item) {
		<- accumulated::append(item)
	})

	constant itself = seed::reduce(startingWith seed, (accumulated, item) {
		<- accumulated::append(item)
	})

	Terminal.inspect(grown)
	Terminal.inspect(untouched)
	Terminal.inspect(itself)
	Terminal.inspect(seed)
	Terminal.inspect(seed::append(9))
	Terminal.inspect(grown::append(9))
	Terminal.inspect(untouched::append(9))
	Terminal.inspect(seed)
}`

// Everything `fold-constants` works out, beside a printing Argument and a
// mixed-kind sum it refuses. A fold stores what the operation stores: lowest
// terms for `1/2 + 1/4`, the written parts for `4/2`.
const constantFolding = `implementation {
	§§ Prints as it answers, so that an operation folded away would show.
	§§
	§§ @returns — two.
	function noisy() -> Integer {
		Terminal.inspect("evaluated")

		<- 2
	}

	constant seconds = 60::multiply(with 60)::multiply(with 24)

	Terminal.inspect(seconds)
	Terminal.inspect(10::subtract(4))
	Terminal.inspect(-7::absolute())
	Terminal.inspect(7::negate())
	Terminal.inspect(1::isLessThan(2))
	Terminal.inspect(2::is(2))
	Terminal.inspect(2::isNot(2))
	Terminal.inspect(1/2::add(1/4))
	Terminal.inspect(1/2::subtract(1/4))
	Terminal.inspect(1/2::multiply(with 2/3))
	Terminal.inspect(4/2::absolute())
	Terminal.inspect(1/2::negate())
	Terminal.inspect(1/2::is(2/4))
	Terminal.inspect(1/2::isLessThan(2/3))
	Terminal.inspect("a"::append("b"))
	Terminal.inspect("b"::prepend("a"))
	Terminal.inspect("a count: {7}, {1/2}, {true}, {"x"}")
	Terminal.inspect(3::add(noisy()))
	Terminal.inspect(1::add(1/2))
}`

// A hole renders a whole Rational as its numerator alone, so both holes render
// `2`.
const wholeRationalHoles = `implementation {
	Terminal.inspect("{2/1}, {4/2}, {1/2}")
}`

// A Namespace named `Integer` whose `subtract` does no arithmetic. Subtraction
// is used because no refinement of Integer closes over it, so the shadowing
// Namespace answers.
const shadowedArithmetic = `implementation {
	§§ Answers what a Namespace the Program wrote answers.
	§§
	§§ @returns — nine, loudly.
	function trick() -> Integer {
		§§ Not the standard library's.
		namespace Integer for Integer {
			§§ Nine, whatever it is given.
			§§
			§§ @param _ — ignored
			§§ @returns — nine.
			subtract(_ other: Integer) -> Integer {
				Terminal.inspect("the shadow ran")

				<- 9
			}
		}

		<- 1::subtract(2)
	}

	Terminal.inspect(trick())
}`

// Two Handlers that can never run, beside ones that must stay: List members
// sharing a tag, and a Record Matcher beside a Record scrutinee.
const deadMatchArms = `implementation {
	choice Shape {
		Circle { radius: Integer },
		Blank,
	}

	constant scalar: Integer | String = 5
	constant shape: Shape = #Blank
	constant items: List<Integer> | List<String> = [1, 2]
	constant record: { x: Integer } | String = { x = 1 }

	Terminal.inspect(match scalar -> String {
		case Integer { <- "an Integer" }
		case Boolean { <- "never" }
		case String  { <- "a String" }
	})

	Terminal.inspect(match shape -> String {
		case #Circle { <- "a Circle" }
		case Integer { <- "never" }
		case #Blank  { <- "Blank" }
	})

	Terminal.inspect(match items -> String {
		case List<String>  { <- "Strings" }
		case List<Integer> { <- "Integers" }
	})

	Terminal.inspect(match record -> String {
		case String         { <- "a String" }
		case { x: Integer } { <- "a Record" }
	})

	§ The dead Handler LAST, where dropping it leaves a chain
	§ 'elide-final-match-test' then ends in the Handler above it.
	Terminal.inspect(match scalar -> String {
		case Integer { <- "the Integer" }
		case String  { <- "the String" }
		case Boolean { <- "never" }
	})
}`

// A Constant of each kind `eliminate-dead-code` decides by. A `variable` is
// always kept, since the pass does not read assignments.
const deadCode = `implementation {
	constant read = 4

	§§ Prints as it answers, so that a Declaration dropped with it would show.
	§§
	§§ @returns — one.
	function noisy() -> Integer {
		Terminal.inspect("evaluated")

		<- 1
	}

	§§ Reads a Constant declared outside it.
	§§
	§§ @returns — the sum.
	function reader() -> Integer {
		constant droppedInside = 3::add(4)
		constant keptInside = 5::add(6)

		<- keptInside::add(read)
	}

	constant dropped = 60::multiply(with 60)
	constant kept = 2
	constant loud = noisy()

	variable counted = 7

	counted = counted::add(1)

	Terminal.inspect(kept)
	Terminal.inspect(reader())
	Terminal.inspect(counted)
}`

// The Node kinds of `typedSimple.ExpressionNode` but `Identifier`, whose two
// positions the walk leaves alone compute nothing.
const expressionKinds = new Set([
	"FunctionInvocation",
	"MethodInvocation",
	"UnionMethodInvocation",
	"RecordValue",
	"StringValue",
	"InterpolatedStringValue",
	"IntegerValue",
	"RationalValue",
	"BooleanValue",
	"FunctionValue",
	"ListValue",
	"Lookup",
	"Combination",
	"Match",
	"ConformanceValue",
	"CaseValue",
	// The Simplifier's one intrinsic is the `omitted-argument` hole. Every
	// other intrinsic is a pass's output.
	"Intrinsic",
])

// Every Expression the Program holds, read as plain data, since only an
// independent reading finds a position the walk forgot. Gathered by identity.
function everyExpressionIn(program: common.typedSimple.Program): Set<unknown> {
	let found = new Set<unknown>()

	let visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (let entry of value) {
				visit(entry)
			}

			return
		}

		if (value === null || typeof value !== "object") {
			return
		}

		let node = value as Record<string, unknown>

		if (expressionKinds.has(node["nodeType"] as string)) {
			found.add(node)
		}

		for (let [key, entry] of Object.entries(node)) {
			// A Namespace Method's Function literal is emitted as a class member, so
			// the walk offers its body, not the literal. `isStatic` marks the wrapper.
			if (key === "method" && node["isStatic"] !== undefined) {
				visit((entry as Record<string, unknown>)["value"])

				continue
			}

			visit(entry)
		}
	}

	visit(program.implementation.nodes)

	return found
}

// The fields a Statement position can stand in, read as plain data as
// `everyExpressionIn` reads Expressions.
const statementFields = new Set(["nodes", "body", "trueBody", "falseBody"])

// Every Statement Array a body hook must be offered, gathered by identity.
function everyBodyIn(program: common.typedSimple.Program): Set<unknown> {
	let found = new Set<unknown>()

	let visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (let entry of value) {
				visit(entry)
			}

			return
		}

		if (value === null || typeof value !== "object") {
			return
		}

		for (let [key, entry] of Object.entries(
			value as Record<string, unknown>,
		)) {
			if (statementFields.has(key) && Array.isArray(entry)) {
				found.add(entry)
			}

			visit(entry)
		}
	}

	visit(program.implementation)

	return found
}

function everyStatementIn(program: common.typedSimple.Program): Set<unknown> {
	let found = new Set<unknown>()

	let visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (let entry of value) {
				visit(entry)
			}

			return
		}

		if (value === null || typeof value !== "object") {
			return
		}

		for (let [key, entry] of Object.entries(
			value as Record<string, unknown>,
		)) {
			if (statementFields.has(key) && Array.isArray(entry)) {
				for (let statement of entry) {
					if (statement !== null && typeof statement === "object") {
						found.add(statement)
					}
				}
			}

			visit(entry)
		}
	}

	visit(program.implementation)

	return found
}

describe("Optimiser", () => {
	describe("the registry", () => {
		it("names every pass in kebab-case", () => {
			let misspelled = optimiserPassNames.filter(
				(name) => !/^[a-z]+(-[a-z]+)*$/.test(name),
			)

			expect(misspelled).toEqual([])
		})

		it("names each pass once", () => {
			expect([...optimiserPassNames]).toEqual([
				...new Set(optimiserPassNames),
			])
		})

		it("lists the names in the order the passes run", () => {
			expect([...optimiserPassNames]).toEqual(
				optimiserPasses.map((pass) => pass.name),
			)
		})
	})

	// Erasing checked refinements is no pass: it makes a Program emittable, so it
	// runs with the phase off too. A refinement is written into a Program by hand,
	// since every route through the stage erases it.
	describe("erasing checked refinements", () => {
		const integer: common.Type = { type: "Integer" }

		const nonZeroInteger: common.Type = {
			type: "Refinement",
			name: "NonZeroInteger",
			base: integer,
			conjuncts: [
				{
					namespaceName: "Integer",
					methodName: "is",
					negated: true,
					args: ["0"],
				},
			],
		}

		// A Match over a bare Integer whose one Handler's Matcher is then refined, the
		// field the Rewriter serializes.
		function withRefinedMatcher(): common.typedSimple.Program {
			let program = simplifiedSource(`implementation {
				constant value: Integer | String = 1

				Terminal.inspect(match value -> String {
					case Integer { <- "integer" }
					case String  { <- "string" }
				})
			}`)

			let refined = rewriteExpressions(program, (node) => {
				if (node.nodeType !== "Match") {
					return node
				}

				return {
					...node,
					handlers: node.handlers.map((handler) =>
						handler.matcher.type === "Integer"
							? { ...handler, matcher: nonZeroInteger }
							: handler,
					),
				}
			})

			expect(matchMatchers(refined)[0]).toEqual([
				nonZeroInteger,
				{ type: "String" },
			])

			return refined
		}

		// Asked of the whole Program, since with the phase on the Match is lowered and
		// compiled to a tag test.
		it("erases one with the phase on", () => {
			expect(
				JSON.stringify(optimise(withRefinedMatcher())),
			).not.toContain("Refinement")
		})

		it("erases one with the phase off", () => {
			expect(
				matchMatchers(
					optimise(withRefinedMatcher(), {
						enabled: false,
						disabledPasses: new Set(),
					}),
				)[0],
			).toEqual([integer, { type: "String" }])
		})

		it("hands a Program carrying none back as itself", () => {
			let program = simplifiedSource(`implementation {
				Terminal.inspect("nothing to erase")
			}`)

			expect(
				optimise(program, {
					enabled: false,
					disabledPasses: new Set(),
				}),
			).toBe(program)
		})

		// A refinement that reaches emission fails the compile by name.
		it("refuses to emit one that reached the Rewriter", () => {
			expect(() => rewrite(withRefinedMatcher())).toThrow(
				/Internal Compiler Error: a checked refinement reached/,
			)
		})
	})

	describe("the Options key", () => {
		it("tells the phase turned off from the phase turned on", () => {
			expect(
				optimiserOptionsKey({
					...defaultOptimiserOptions,
					enabled: false,
				}),
			).not.toBe(optimiserOptionsKey(defaultOptimiserOptions))
		})

		it("reads one set of disabled passes as one key", () => {
			let first: OptimiserOptions = {
				enabled: true,
				disabledPasses: new Set(["b-pass", "a-pass"]),
			}
			let second: OptimiserOptions = {
				enabled: true,
				disabledPasses: new Set(["a-pass", "b-pass"]),
			}

			expect(optimiserOptionsKey(first)).toBe(optimiserOptionsKey(second))
		})

		it("tells a disabled pass from none", () => {
			expect(
				optimiserOptionsKey({
					enabled: true,
					disabledPasses: new Set(["a-pass"]),
				}),
			).not.toBe(optimiserOptionsKey(defaultOptimiserOptions))
		})
	})

	// The prelude is optimised once per process and shared, so it is cached per
	// set of Options. A test process compiles under several.
	describe("the prelude cache", () => {
		it("builds one prelude per set of Options", () => {
			let optimised = withOptimiserOptions(defaultOptimiserOptions, () =>
				stdlibPrelude(),
			)
			let again = withOptimiserOptions(defaultOptimiserOptions, () =>
				stdlibPrelude(),
			)
			let unoptimised = withOptimiserOptions(
				{ enabled: false, disabledPasses: new Set() },
				() => stdlibPrelude(),
			)

			expect(again).toBe(optimised)
			expect(unoptimised).not.toBe(optimised)
			expect(
				withOptimiserOptions(
					{ enabled: false, disabledPasses: new Set() },
					() => stdlibPrelude(),
				),
			).toBe(unoptimised)
		})
	})

	// `Everyday.es` and `Match.es` between them hold every Expression shape a
	// Program can carry.
	describe("the shared walk", () => {
		for (let fileName of ["Everyday.es", "Match.es", "Loops.es"]) {
			it(`reaches every Expression of ${fileName} exactly once`, () => {
				let program = simplified(fileName)
				let offered: Array<unknown> = []
				let walked = rewriteExpressions(program, (node) => {
					if (node.nodeType !== "Identifier") {
						offered.push(node)
					}

					return node
				})

				let expected = everyExpressionIn(program)

				expect(offered.length).toBeGreaterThan(50)
				// Exactly once, so a pass never rewrites its own output.
				expect(offered.length).toBe(new Set(offered).size)
				expect(new Set(offered)).toEqual(expected)
				// A walk that changed nothing hands back what it was given.
				expect(walked).toBe(program)
			})
		}

		it("leaves the Program it was given untouched", () => {
			// A value no fixture writes, so counting it counts the rewrite.
			const marker = "987654321"

			let program = simplified("Everyday.es")
			let markers = (walked: common.typedSimple.Program): number =>
				[...everyExpressionIn(walked)].filter(
					(node) =>
						(node as Record<string, unknown>)["nodeType"] ===
							"IntegerValue" &&
						(node as Record<string, unknown>)["value"] === marker,
				).length

			expect(markers(program)).toBe(0)

			let rewritten = rewriteExpressions(program, (node) =>
				node.nodeType === "IntegerValue" && node.value === "2"
					? { ...node, value: marker }
					: node,
			)

			expect(rewritten).not.toBe(program)
			expect(markers(rewritten)).toBeGreaterThan(0)
			// Writing into the input would corrupt the prelude for later compilations.
			expect(markers(program)).toBe(0)
		})

		// The Statement hook keeps the same promises: every position, once, and the
		// Program handed back unchanged.
		for (let fileName of ["Everyday.es", "Match.es", "Loops.es"]) {
			it(`reaches every Statement of ${fileName} exactly once`, () => {
				let program = simplified(fileName)
				let offered: Array<unknown> = []
				let walked = rewriteStatements(program, (node) => {
					offered.push(node)

					return node
				})

				expect(offered.length).toBeGreaterThan(20)
				expect(offered.length).toBe(new Set(offered).size)
				expect(new Set(offered)).toEqual(everyStatementIn(program))
				expect(walked).toBe(program)
			})
		}

		// The body hook keeps the same promises. It may answer with a different
		// number of Statements, so `eliminate-dead-code` relies on it.
		for (let fileName of ["Everyday.es", "Match.es", "Loops.es"]) {
			it(`reaches every body of ${fileName} exactly once`, () => {
				let program = simplified(fileName)
				let offered: Array<unknown> = []
				let walked = rewriteNodes(program, {
					body: (nodes) => {
						offered.push(nodes)

						return nodes
					},
				})

				// The set comparison carries the weight; the count is a guard.
				expect(offered.length).toBeGreaterThan(1)
				expect(offered.length).toBe(new Set(offered).size)
				expect(new Set(offered)).toEqual(everyBodyIn(program))
				expect(walked).toBe(program)
			})
		}

		// A shim's prologue merges a Record default into the written Argument,
		// so it is a body like the one a bodied Method's default opens.
		it("walks the prologue of a native Method's shim as a body", () => {
			let http = stdlibPrelude().find(
				(namespace) => namespace.name === "Http",
			)
			let shim = http?.node.nativeShims.find(
				(each) => each.prologue.length > 0,
			)
			let program = simplifiedSource(`implementation {}`)
			let offered: Array<unknown> = []

			expect(shim).toBeDefined()

			rewriteNodes(
				{
					...program,
					implementation: {
						...program.implementation,
						nodes: [http!.node],
					},
				},
				{
					body: (nodes) => {
						offered.push(nodes)

						return nodes
					},
				},
			)

			expect(offered.includes(shim!.prologue)).toBe(true)
		})

		it("offers a Statement after the Expressions below it", () => {
			// An Expression written for its effects is both, so a Statement pass reads
			// what the Expression hook left.
			let program = simplifiedSource(`implementation {
				Terminal.inspect(1)
			}`)
			let order: Array<string> = []

			rewriteNodes(program, {
				expression: (node) => {
					order.push(`expression:${node.nodeType}`)

					return node
				},
				statement: (node) => {
					order.push(`statement:${node.nodeType}`)

					return node
				},
			})

			// The callee is walked too: a static Method call's name is an Expression.
			expect(order).toEqual([
				"expression:Identifier",
				"expression:Lookup",
				"expression:IntegerValue",
				"expression:FunctionInvocation",
				"statement:FunctionInvocation",
			])
		})
	})

	describe("compile-type-tests", () => {
		it("reads a tag instead of building a Type descriptor", () => {
			let generated = generate(typeTests)

			expect(generated).toContain(
				'_self[$type.typeKeySymbol] === "Shape#Circle"',
			)
			// The Choice descriptor is gone: a Case Matcher is its tag.
			expect(generated).not.toContain('choice: "Shape"')
		})

		it("compiles a scalar Matcher to its tag", () => {
			// A scalar's check is one key comparison, whatever can arrive.
			expect(generate(typeTests)).toContain(
				'_self[$type.typeKeySymbol] === "Integer"',
			)
		})

		it("stops walking a List to find out that it is one", () => {
			// The full check walks every item. With one List member, the tag alone
			// says which member arrived.
			expect(generate(typeTests)).toContain(
				'_self[$type.typeKeySymbol] === "List"',
			)
		})

		it("keeps the full check where two Types share a tag", () => {
			// `List<Integer>` and `List<String>` share a tag, so the items decide.
			expect(generate(typeTests)).toContain(
				'itemType: { type: "String" }',
			)
		})

		it("compiles a Record Matcher to its tag where one Record can arrive", () => {
			// Only one member of `{ x: Integer, y: Integer } | String` carries the
			// Record tag, so the tag decides the whole check.
			let generated = generate(typeTests)

			expect(generated).toContain('=== "Record"')
			expect(generated).not.toContain('x: { type: "Integer" }')
		})

		it("keeps the full check where two Records can arrive", () => {
			// Both members share the tag, so their members decide.
			// `compile-record-members` is off, to read what this pass leaves.
			let generated = generate(
				`implementation {
					constant shape: { at: { x: Integer } } | { key: String } = { key = "k" }

					Terminal.inspect(match shape -> String {
						case { at: { x: Integer } } { <- "nested" }
						case { key: String }        { <- "keyed" }
					})
				}`,
				{
					enabled: true,
					disabledPasses: new Set(["compile-record-members"]),
				},
			)

			expect(generated).toMatch(/isValueOfType\(_self, \$pool_\d+\)/)
			expect(generated).toContain('x: { type: "Integer" }')
		})

		it("keeps the full check where a Type Parameter could carry the tag", () => {
			// A value of `Item` may be a List, so the item walk decides.
			let generated = generate(`implementation {
				function label<infer Item>(
					_ items: List<Item>,
					or fallback: List<Integer> | Item,
				) -> Integer {
					<- match fallback -> Integer {
						case List<Integer> { <- 1 }
						case _ { <- 0 }
					}
				}

				Terminal.inspect(label(["a"], or "b"))
			}`)

			expect(generated).toMatch(/isValueOfType\(_self, \$pool_\d+\)/)
			expect(generated).toContain('itemType: { type: "Integer" }')
		})

		// The standard library's Matches go through the pass too, inside the
		// prelude.
		it("compiles the standard library's own Matches", () => {
			let generated = generate(`implementation {
				Terminal.inspect(Integer.parse("7")::value(defaultingTo 0))
			}`)

			expect(generated).toContain(
				'_self[$type.typeKeySymbol] === "Optional#Value"',
			)
			expect(generated).not.toContain('choice: "Optional"')
		})

		// The fixture holding every Matcher kind.
		it("leaves no Case descriptor in a compiled Match.es", () => {
			let generated = generate(
				readFileSync(fixturePath("Match.es"), "utf8"),
			)

			expect(generated).not.toContain('type: "Case"')
			expect(generated).toContain(
				'_self[$type.typeKeySymbol] === "Optional#Value"',
			)
		})

		// A payload Pattern's requirement is a Type check like the Matcher's own,
		// so it goes through this pass too.
		describe("a payload Pattern's requirements", () => {
			const payloadPattern = `implementation {
				type Click = { x: Integer, y: Integer }
				type KeyPress = { key: String }

				choice Event {
					Fired { payload: Click | KeyPress },
					Idle,
				}

				constant event: Event = #Fired({ payload = { key = "a" } })

				Terminal.inspect(match event -> String {
					case #Fired({ key }) { <- key }
					case _               { <- "other" }
				})
			}`

			it("puts the descriptor where it can be pooled", () => {
				// The requirement reads the member against a pooled descriptor.
				// `compile-record-members` is off, since it removes the descriptor.
				expect(
					generate(payloadPattern, {
						enabled: true,
						disabledPasses: new Set(["compile-record-members"]),
					}),
				).toMatch(/isValueOfType\(_self\.payload, \$pool_\d+\)/)
			})

			it("hands the requirement on to the decision tree", () => {
				// A Record requirement follows the Matcher's own rules one level down.
				// Only `KeyPress` declares `key`, so it is read through `?.`.
				expect(generate(payloadPattern)).toContain(
					'_self.payload.key?.[$type.typeKeySymbol] === "String"',
				)
			})

			it("asks the general question when it is turned off", () => {
				expect(
					generate(payloadPattern, {
						enabled: true,
						disabledPasses: new Set(["compile-type-tests"]),
					}),
				).toContain("$type.isValueOfType(_self.payload, {")
			})

			it("prints the same thing with the pass off", async () => {
				expect(
					await expectSamePrintedOutput(
						"compile-type-tests",
						payloadPattern,
					),
				).toEqual(['"a"'])
			})
		})

		it("builds the descriptors again when it is turned off", () => {
			let generated = generate(typeTests, {
				enabled: true,
				disabledPasses: new Set(["compile-type-tests"]),
			})

			expect(generated).toContain('type: "Case"')
			expect(generated).toContain('choice: "Shape"')
			expect(generated).toContain(
				'$type.isValueOfType(_self, { type: "Integer" })',
			)
		})

		it("prints the same thing with the pass off", async () => {
			expect(
				await expectSamePrintedOutput("compile-type-tests", typeTests),
			).toEqual(['"integer"', "3", "1", "1", '"click"', "1", "0"])
		})

		it("prints the same thing with the pass off for every fixture shape", async () => {
			await expectSamePrintedOutput(
				"compile-type-tests",
				readFileSync(fixturePath("Match.es"), "utf8"),
			)
			await expectSamePrintedOutput(
				"compile-type-tests",
				readFileSync(fixturePath("Maybe.es"), "utf8"),
			)
			await expectSamePrintedOutput(
				"compile-type-tests",
				readFileSync(fixturePath("Tree.es"), "utf8"),
			)
		})
	})

	describe("lower-unit-case-equality", () => {
		it("reads a tag instead of calling the runtime's equality", () => {
			let generated = generate(unitCaseEquality)

			expect(generated).toContain(
				'red[$type.typeKeySymbol] === "Colour#Green"',
			)
			expect(generated).not.toContain("$helpers.choiceIs(red,")
		})

		it("asks the opposite question for isNot", () => {
			// `!==` rather than a negated answer.
			expect(generate(unitCaseEquality)).toContain(
				'red[$type.typeKeySymbol] !== "Colour#Green"',
			)
		})

		it("hands back an interned Boolean", () => {
			expect(generate(unitCaseEquality)).toContain(
				"? Boolean.trueInstance : Boolean.falseInstance",
			)
		})

		it("reads the value's tag with the Case on the receiver side", () => {
			// The dropped Case holds no Expression, so there is no order to preserve.
			expect(generate(unitCaseEquality)).toContain(
				'red[$type.typeKeySymbol] === "Colour#Red"',
			)
		})

		it("leaves a Case carrying a payload to the runtime", () => {
			// Two Circles differ by radius, so the comparison stays a call.
			expect(generate(unitCaseEquality)).toContain(
				"$helpers.choiceIs(circle,",
			)
		})

		it("lowers a generic Choice's payload-less Case", () => {
			// `#Void` carries no payload, so its tag decides.
			let generated = generate(unitCaseEquality)

			expect(generated).toContain(
				'_void[$type.typeKeySymbol] === "Box#Void"',
			)
			expect(generated).toContain(
				'held[$type.typeKeySymbol] === "Box#Void"',
			)
			// The one descriptor left is the payload comparison, which needs a witness.
			expect(generated.split("boundChoiceIs").length - 1).toBe(1)
		})

		it("leaves a generic Choice's payload-carrying Case to its descriptor", () => {
			// `#Holding` holds an `Item`, compared through the caller's witness.
			expect(generate(unitCaseEquality)).toContain(
				"$helpers.boundChoiceIs(",
			)
		})

		it("leaves an equality a Namespace writes alone", () => {
			// Only a derived equality is a question about tags. A written `is` is
			// called.
			let generated = generate(`implementation {
				choice Colour { Red, Green }

				namespace Colour for Colour is Equatable {
					§§ Every Colour is every other Colour.
					§§
					§§ @param _ — the Colour to compare with
					§§ @returns — always true.
					is(_ other: Colour) -> Boolean {
						<- true
					}

					§§ The negation.
					§§
					§§ @param _ — the Colour to compare with
					§§ @returns — always false.
					isNot(_ other: Colour) -> Boolean {
						<- @::is(other)::negate()
					}
				}

				constant red: Colour = #Red

				Terminal.inspect(red::is(#Green))
			}`)

			expect(generated).toContain("Colour.is(red,")
			expect(generated).not.toContain(
				'[$type.typeKeySymbol] === "Colour#',
			)
		})

		// Every inequality ends in `@::compare(to other)::is(#Less)` or its twin, in the
		// standard library. `lower-scalar-operations` and `fold-constants` are off,
		// since each would remove the body this reads.
		it("lowers the standard library's own comparisons", () => {
			let body = bodyOf(
				generate(unitCaseEquality, {
					enabled: true,
					disabledPasses: new Set([
						"lower-scalar-operations",
						"fold-constants",
					]),
				}),
				"$es_Integer_isLessThan",
			)

			expect(body).toContain(
				'Integer.compare(_self, other)[$type.typeKeySymbol] === "Ordering#Less"',
			)
			expect(body).not.toContain("choiceIs(")
		})

		it("calls the runtime's equality again when it is turned off", () => {
			// The pool, the scalar lowering and folding are off, so the Case and the
			// comparison body stay where they can be read.
			let generated = generate(unitCaseEquality, {
				enabled: true,
				disabledPasses: new Set([
					"lower-unit-case-equality",
					"lower-scalar-operations",
					"fold-constants",
					"pool-constants",
				]),
			})

			expect(generated).toContain(
				'$helpers.choiceIs(red, $type.createCase("Colour#Green"))',
			)
			expect(generated).toContain(
				'$helpers.choiceIsNot(red, $type.createCase("Colour#Green"))',
			)
			expect(bodyOf(generated, "$es_Integer_isLessThan")).toContain(
				"$helpers.choiceIs(Integer.compare(",
			)
		})

		it("prints the same thing with the pass off", async () => {
			expect(
				await expectSamePrintedOutput(
					"lower-unit-case-equality",
					unitCaseEquality,
				),
			).toEqual([
				"false",
				"true",
				"true",
				"true",
				"true",
				"false",
				"true",
				"true",
				"false",
				"true",
				"true",
			])
		})

		it("prints the same thing with the pass off for every fixture shape", async () => {
			await expectSamePrintedOutput(
				"lower-unit-case-equality",
				readFileSync(fixturePath("Choice.es"), "utf8"),
			)
			await expectSamePrintedOutput(
				"lower-unit-case-equality",
				readFileSync(fixturePath("GenericChoice.es"), "utf8"),
			)
			await expectSamePrintedOutput(
				"lower-unit-case-equality",
				readFileSync(fixturePath("Everyday.es"), "utf8"),
			)
		})
	})

	describe("lower-scalar-operations", () => {
		it("orders two Integers with JavaScript's own operator", () => {
			let generated = generate(scalarOperations)

			expect(generated).toContain("a.value < b.value")
			expect(generated).toContain("a.value > b.value")
		})

		it("asks the opposite question rather than negating the answer", () => {
			// `isLessThanOrEqualTo` negates `isGreaterThan`. Bigints are totally ordered,
			// so the opposite comparison is exact.
			let generated = generate(scalarOperations)

			expect(generated).toContain("a.value <= b.value")
			expect(generated).toContain("a.value >= b.value")
			expect(generated).not.toContain("!(a.value")
		})

		it("compares two Integers by the bigints they hold", () => {
			let generated = generate(scalarOperations)

			expect(generated).toContain("a.value === b.value")
			expect(generated).toContain("a.value !== b.value")
		})

		it("hands back an interned Boolean", () => {
			expect(generate(scalarOperations)).toContain(
				"a.value < b.value ? Boolean.trueInstance : Boolean.falseInstance",
			)
		})

		it("builds an Integer answer in one allocation", () => {
			// `subtract` is `@::add(other::negate())` in Essence.
			let generated = generate(scalarOperations)

			expect(generated).toContain("value: a.value + b.value")
			expect(generated).toContain("value: a.value - b.value")
			expect(generated).toContain("value: a.value * b.value")
			expect(generated).not.toContain("Integer.add__overload$1(a,")
		})

		// The pass goes by Namespace name, and `NonZeroInteger.multiply` re-exports
		// Integer's own product, so it is lowered the same way.
		it("multiplies two proven Integers with the same operator", () => {
			let generated = generate(scalarOperations)

			expect(generated).toContain(
				"value: proven.value * alsoProven.value",
			)
			expect(generated).not.toContain("NonZeroInteger.multiply")
		})

		// The other entries of that name are not two bigints. The operand Types tell
		// them apart, since the pass strips the overload index.
		it("leaves the proven Namespace's irrational entries alone", () => {
			let generated = generate(scalarOperations)

			expect(generated).toContain(
				"$es_NonZeroInteger_multiply__overload$3(proven, Number.Pi)",
			)
		})

		it("compares two Strings through the runtime's own comparison", () => {
			// Not `===`: a composed and a decomposed accent are one String, so the
			// normalising comparison decides.
			let generated = generate(scalarOperations)

			expect(generated).toContain("$helpers.stringEquals(text, other)")
			expect(generated).toContain("!$helpers.stringEquals(text, other)")
		})

		it("leaves the String comparison that takes a Case alone", () => {
			// `is(_ other, comparing sensitivity)` is a different Method.
			expect(generate(scalarOperations)).toContain(
				"$es_String_is__overload$2(text,",
			)
		})

		it("writes Boolean logic out as JavaScript's own", () => {
			let generated = generate(scalarOperations)

			expect(generated).toContain("!yes.value")
			expect(generated).toContain("yes.value && no.value")
			expect(generated).toContain("yes.value || no.value")
		})

		// `a::and(b)` evaluates `b`, and `a && b` may not. Here `b` prints, so the
		// output shows which was emitted.
		it("keeps the call where the Argument can be observed", () => {
			expect(generate(scalarOperations)).toContain(
				"Boolean.and(no, noisy())",
			)
		})

		it("leaves a mixed-kind operation to the Namespace that widens it", () => {
			// An Integer beside a Rational is no bigint operation.
			let generated = generate(scalarOperations)

			expect(generated).toContain("$es_Integer_isLessThan__overload$2(a,")
			expect(generated).toContain("$es_Integer_add__overload$2(a,")
		})

		it("leaves a Namespace the Program declares of its own alone", () => {
			// A Namespace named `Integer` replaces the builtin for the rest of its block,
			// so `isLessThan` is a written Method.
			let generated = generate(`implementation {
				§§ Answers the same thing however it is asked.
				§§
				§§ @returns — true.
				function trick() -> Boolean {
					§§ A liar.
					namespace Integer for Integer {
						§§ Always true.
						§§
						§§ @param _ — ignored
						§§ @returns — true
						isLessThan(_ other: Integer) -> Boolean {
							<- true
						}
					}

					<- 5::isLessThan(3)
				}

				Terminal.inspect(trick())
			}`)

			expect(generated).toContain("$user_Integer.isLessThan(")
			expect(generated).not.toContain(".value < ")
		})

		it("keeps the call where the Argument reaches a Namespace the Program declares", () => {
			// The shadowed Method is the Argument of an `and`, so lowering the `and` would
			// skip it behind `&&`. Only `Integer` is shadowed, not `Boolean`.
			let generated = generate(shadowedArgument)

			expect(generated).toContain("Boolean.and(")
			expect(generated).toContain("$user_Integer.is(")
			expect(generated).not.toContain(".value && ")
		})

		it("prints the same thing with the pass off where the Argument is shadowed", async () => {
			expect(
				await expectSamePrintedOutput(
					"lower-scalar-operations",
					shadowedArgument,
				),
			).toEqual(['"the shadow ran"', "false", "true"])
		})

		it("keeps the call where the Argument is a mixed-kind comparison", () => {
			// Given a Rational, `isLessThan` is the covering `Number` entry, not the
			// bigint one the purity enumeration names, so the `and` stays a call.
			let generated = generate(`implementation {
				constant a = 3

				Terminal.inspect(false::and(a::isLessThan(1/2)))
			}`)

			expect(generated).toContain("Boolean.and(")
			expect(generated).not.toContain(".value && ")
		})

		// The standard library's bodies use the Methods this pass lowers. The step
		// callback is a value, so `inline-loops` leaves the driver in the emission.
		it("lowers the standard library's own bodies", () => {
			let generated = generate(`implementation {
				constant advance = (_ index: Integer, _ total: Integer)
					-> Integer { <- total::add(index) }

				Terminal.inspect(loop(from 1, through 3, startingWith 0, advance))
				Terminal.inspect(4::isEven())
			}`)

			// The driver's predicate binds `index` with a Pattern.
			expect(generated).toContain("index.value <= end.value")
			expect(bodyOf(generated, "$es_Integer_isEven")).toContain(
				".value === ",
			)
		})

		// Lowered comparisons leave their bodies unreached, so they are not emitted.
		it("takes the comparison bodies out of the emission", () => {
			let source = `implementation {
				Terminal.inspect(1::isLessThanOrEqualTo(2))
			}`

			expect(generate(source)).not.toContain(
				"$es_Integer_isLessThanOrEqualTo",
			)
			expect(
				generate(source, {
					enabled: true,
					// `fold-constants` is off, since it would answer the literals itself.
					disabledPasses: new Set([
						"lower-scalar-operations",
						"fold-constants",
					]),
				}),
			).toContain("$es_Integer_isLessThanOrEqualTo__overload$1")
		})

		it("reads the operands the passes after it rewrote", () => {
			// `pool-constants` runs last and finds the literal inside a lowered
			// operation.
			expect(
				generate(`implementation {
					constant n = 2

					Terminal.inspect(n::add(1))
					Terminal.inspect(n::multiply(with 1))
				}`),
			).toContain("value: n.value + $pool_")
		})

		it("calls the Methods again when it is turned off", () => {
			let generated = generate(scalarOperations, {
				enabled: true,
				disabledPasses: new Set(["lower-scalar-operations"]),
			})

			expect(generated).toContain("$es_Integer_isLessThan__overload$1(a,")
			expect(generated).toContain("Integer.add__overload$1(a, b)")
			expect(generated).toContain(
				"NonZeroInteger.multiply__overload$1(proven, alsoProven)",
			)
			expect(generated).toContain("Boolean.negate(yes)")
			expect(generated).toContain(
				"$es_String_is__overload$1(text, other)",
			)
			expect(generated).not.toContain("stringEquals")
		})

		it("prints the same thing with the pass off", async () => {
			// `"evaluated"` prints once: an `and` lowered to `&&` would print it zero
			// times.
			expect(
				await expectSamePrintedOutput(
					"lower-scalar-operations",
					scalarOperations,
				),
			).toEqual([
				"true",
				"true",
				"false",
				"false",
				"false",
				"true",
				"8",
				"-2",
				"15",
				// The proven product, the same fifteen.
				"15",
				// The entry beside it, which stays a call.
				"3·π",
				"false",
				"true",
				"true",
				"false",
				"false",
				"true",
				'"evaluated"',
				"false",
				"false",
				"7/2",
			])
		})

		it("prints the same thing with the pass off for every fixture shape", async () => {
			await expectSamePrintedOutput(
				"lower-scalar-operations",
				readFileSync(fixturePath("Loops.es"), "utf8"),
			)
			await expectSamePrintedOutput(
				"lower-scalar-operations",
				readFileSync(fixturePath("Everyday.es"), "utf8"),
			)
			await expectSamePrintedOutput(
				"lower-scalar-operations",
				readFileSync(fixturePath("String.es"), "utf8"),
			)
			await expectSamePrintedOutput(
				"lower-scalar-operations",
				readFileSync(fixturePath("Number.es"), "utf8"),
			)
		})
	})

	describe("compile-union-dispatch", () => {
		it("reads a tag instead of searching at run time", () => {
			let generated = generate(unionDispatch)

			expect(generated).toContain(
				'value[$type.typeKeySymbol] === "Integer" ? Integer.toString__overload$1(value) : $es_Boolean_toString(value)',
			)
			expect(generated).not.toContain("$type.dispatchMethod")
		})

		it("leaves no dispatch search in a dispatch-heavy Program", () => {
			// The search's Arguments go with it.
			expect(generate(unionDispatch)).not.toContain("dispatchMethod")
			expect(
				generate(unionDispatch, {
					enabled: true,
					disabledPasses: new Set(["compile-union-dispatch"]),
				}),
			).toContain("$type.dispatchMethod(")
		})

		it("takes the last case as the else, and the throw with it", () => {
			// Every member of the Union has a case, so a value that declines the first
			// needs no further test.
			let generated = generate(`implementation {
				constant value: Integer | Boolean = 5

				Terminal.inspect(value::toString())
			}`)

			expect(generated).toContain(
				'value[$type.typeKeySymbol] === "Integer" ? Integer.toString__overload$1(value) : $es_Boolean_toString(value)',
			)
			expect(generated).not.toContain('=== "Boolean"')
			expect(generated).not.toContain("noDispatchCaseMatched")
		})

		it("takes a Record case as the else where one member claims the tag", () => {
			// One member carries the Record tag and satisfies the case, so the last case
			// needs no test of its own.
			let generated = generate(`implementation {
				namespace Circles for { radius: Integer } {
					weight() -> Integer { <- 1 }
				}

				namespace Counts for Integer {
					weight() -> Integer { <- 2 }
				}

				variable shape: Integer | { radius: Integer } = 1

				Terminal.inspect(shape::weight())
			}`)

			expect(generated).toContain(
				'shape[$type.typeKeySymbol] === "Integer" ? Counts.weight(shape) : Circles.weight(shape)',
			)
			expect(generated).not.toContain("noDispatchCaseMatched()")
		})

		it("keeps the throw where two Record cases both claim the tag", () => {
			// Two Records claim the tag, so a member test decides and the throw stays.
			let generated = generate(`implementation {
				namespace Circles for { radius: Integer } {
					weight() -> Integer { <- 1 }
				}

				namespace Rects for { width: Integer } {
					weight() -> Integer { <- 2 }
				}

				variable shape: { radius: Integer } | { width: Integer } = { radius = 1 }

				Terminal.inspect(shape::weight())
			}`)

			expect(generated).toContain(
				'shape.width?.[$type.typeKeySymbol] === "Integer"',
			)
			expect(generated).toContain("$type.noDispatchCaseMatched()")
		})

		it("keeps the full check where two member Types share a tag", () => {
			// `List<Integer>` and `List<String>` share a tag, so the item walk decides, as
			// for a Match Handler.
			let generated = generate(unionDispatch)

			expect(generated).toMatch(/isValueOfType\(items, \$pool_\d+\)/)
			expect(generated).toMatch(/const \$pool_\d+ = \{\n\ttype: "List"/)
		})

		it("writes one call where every case answers with the same Method", () => {
			// Both cases call `List.length`, so the checks decide nothing and go, with the
			// throw.
			let generated = generate(`implementation {
				constant mixed: List<Integer> | List<String> = [1, 2]

				Terminal.inspect(mixed::length())
			}`)

			expect(generated).toContain("List.length(mixed)")
			expect(generated).not.toContain("isValueOfType")
			expect(generated).not.toContain("noDispatchCaseMatched")
		})

		it("keeps the tests where one case answers with another Method", () => {
			// The branches must be the same call, not merely share a receiver.
			let generated = generate(`implementation {
				constant value: Integer | Boolean = 5

				Terminal.inspect(value::toString())
			}`)

			expect(generated).toContain('=== "Integer"')
		})

		it("prints the same thing with a uniform chain collapsed", async () => {
			let source = `implementation {
				constant mixed: List<Integer> | List<String> = [1, 2, 3]

				Terminal.inspect(mixed::length())
			}`

			expect(await outputOf(generate(source))).toEqual(
				await outputOf(
					generate(source, {
						enabled: true,
						disabledPasses: new Set(["compile-union-dispatch"]),
					}),
				),
			)
		})

		it("ends the chain in a throw where the last case still asks something", () => {
			// A check not reduced to a tag can disagree with the static Type, so the
			// throw stays, as at a Match's fall-through.
			expect(generate(unionDispatch)).toContain(
				"$type.noDispatchCaseMatched()",
			)
		})

		it("builds a branch's own Arguments only in that branch", () => {
			// The Function literal given to `map` is compiled per branch, and the chain
			// builds only the copy its branch needs.
			let closures = (generated: string): number =>
				generated.split("function (item)").length - 1

			expect(closures(generate(unionDispatch))).toBe(2)
			expect(
				closures(
					generate(unionDispatch, {
						enabled: true,
						disabledPasses: new Set(["compile-union-dispatch"]),
					}),
				),
			).toBe(3)
		})

		it("gives each branch the conformance witness its Method requires", () => {
			// Each branch carries the pooled witness for its own item Type. The hole for
			// `sort`'s defaulted direction stands between receiver and witness.
			expect(generate(unionDispatch)).toMatch(
				/\$es_List_sort__overload\$1\(items, void 0, \$pool_\d+\).*\$es_List_sort__overload\$1\(items, void 0, \$pool_\d+\)/,
			)
		})

		it("writes a name and a literal where the branches use them", () => {
			// A name and a literal need no holding, so there is no wrapper.
			let generated = generate(unionDispatch)

			expect(generated).toMatch(
				/\? Boxes\.tagged\(either, \$pool_\d+\) : Flags\.tagged\(either, \$pool_\d+\)/,
			)
		})

		it("holds an operand that can not be read again", () => {
			// A call receiver is evaluated once, before any test, and read from a name.
			expect(generate(unionDispatch)).toContain(
				'($dispatch_0 => $dispatch_0[$type.typeKeySymbol] === "Integer" ? Integer.toString__overload$1($dispatch_0) : $es_Boolean_toString($dispatch_0))(identity(',
			)
		})

		it("holds the receiver where an Argument could change it", async () => {
			// `flip` assigns `either`, so the receiver and the Argument are held in the
			// order they were written.
			let generated = generate(dispatchOrder)

			expect(generated).toContain("($dispatch_0, $dispatch_1) =>")
			expect(generated).toContain("(either, flip())")
			expect(
				await expectSamePrintedOutput(
					"compile-union-dispatch",
					dispatchOrder,
				),
			).toEqual(['"box!"'])
		})

		it("evaluates an Argument that can be observed exactly once", async () => {
			// One `"evaluated"`: the Argument is evaluated before any test and never
			// again.
			let output = await outputOf(generate(unionDispatch))

			expect(
				output.filter((line) => line === '"evaluated"'),
			).toHaveLength(1)
		})

		it("keeps the cases in the order the Enricher put them", () => {
			// Tested in declaration order with the last test elided, each branch keeping
			// its own Overload. The written `2` proves non-zero, so the irrationals reach
			// refined entries.
			expect(generate(unionDispatch)).toContain(
				'number[$type.typeKeySymbol] === "Integer" ? Integer.multiply__overload$1(number, $pool_',
			)
			expect(generate(unionDispatch)).toMatch(
				/=== "Rational" \? \$es_Rational_multiply__overload\$2.*=== "Algebraic" \? Algebraic\.multiply__overload\$5.*: Transcendental\.multiply__overload\$3/,
			)
		})

		it("puts a catch-all branch last and asks nothing of it", () => {
			// A bounded Type Parameter accepts every value, so its case comes last and
			// asks nothing.
			expect(generate(unionDispatch)).toContain(
				'fallback[$type.typeKeySymbol] === "Boolean" ? $es_Boolean_toString(fallback) : Item__conformance.toString(fallback)',
			)
		})

		it("searches again when it is turned off", () => {
			let generated = generate(unionDispatch, {
				enabled: true,
				disabledPasses: new Set(["compile-union-dispatch"]),
			})

			expect(generated).toContain("$type.dispatchMethod(value, [], [")
			expect(generated).not.toContain("$dispatch_0")
		})

		it("compiles the chain with the Match tests uncompiled", () => {
			// This pass asks `residual.ts` itself, so it does not depend on
			// `compile-type-tests`.
			expect(
				generate(unionDispatch, {
					enabled: true,
					disabledPasses: new Set(["compile-type-tests"]),
				}),
			).toContain('value[$type.typeKeySymbol] === "Integer"')
		})

		it("compiles the chain with the pool turned off", () => {
			// With nothing pooled, the descriptor is written at the test.
			expect(
				generate(unionDispatch, {
					enabled: true,
					disabledPasses: new Set(["pool-constants"]),
				}),
			).toContain('$type.isValueOfType(items, {\n\ttype: "List"')
		})

		it("prints the same thing with the pass off", async () => {
			expect(
				await expectSamePrintedOutput(
					"compile-union-dispatch",
					unionDispatch,
				),
			).toEqual([
				'"5"',
				"2",
				'[ "b!", "a!" ]',
				'[ "a", "b" ]',
				'"box?"',
				'"evaluated"',
				'"box!"',
				'"5"',
				'"2"',
				'"true"',
				'"10"',
			])
		})

		it("prints the same thing with the whole phase off", async () => {
			expect(
				await outputOf(
					generate(unionDispatch, {
						enabled: false,
						disabledPasses: new Set(),
					}),
				),
			).toEqual(await outputOf(generate(unionDispatch)))
		})
	})

	describe("devirtualise-witnesses", () => {
		it("calls the Method the hole's witness names", () => {
			let generated = generate(witnesses)

			expect(generated).toContain(
				"Integer.toString__overload$1(count).value",
			)
			expect(generated).not.toMatch(/\$pool_\d+\.toString\(count\)/)
		})

		it("builds no witness for a hole at all", () => {
			// The Program interpolates and passes no witness, so no map is built.
			expect(
				generate(`implementation {
					constant count = 3

					Terminal.inspect("{count}")
				}`),
			).not.toContain("toString: Integer.toString__overload$1")
		})

		it("reaches a Method a Namespace of the Program's own writes", () => {
			// The call stands where the witness stood, under the usual reference. With
			// the pass off, `pool-constants` declares the witness after the class.
			expect(generate(witnesses)).toContain("Boxes.toString(box).value")

			let pooled = generate(witnesses, {
				enabled: true,
				disabledPasses: new Set(["devirtualise-witnesses"]),
			})

			expect(pooled).toMatch(
				/class Boxes \{[^]*?\n\}\nconst (\$pool_\d+) = \{ toString: Boxes\.toString \};/,
			)
			expect(pooled).toMatch(/\$pool_\d+\.toString\(box\)/)
		})

		it("leaves a conditional conformance's witness alone", () => {
			// `boundConformance` builds the Function behind `toString`, so there is no
			// name to call instead.
			let generated = generate(witnesses)

			expect(generated).toContain("$type.boundConformance(")
			expect(generated).toMatch(/\$pool_\d+\.toString\(nested\)/)
		})

		it("leaves a witness the Program forwards alone", () => {
			// A forwarded conformance Argument differs per call, so the hole inside
			// `show` keeps its property read. The hole at the call site does not.
			let generated = generate(`implementation {
				§§ Renders whatever it is given.
				§§
				§§ @param item — the value to render
				§§ @returns — the value as a String.
				function show<infer Item is Printable>(
					_ item: Item,
				) -> String {
					<- "it is {item}"
				}

				constant count = 3

				Terminal.inspect(show(count))
				Terminal.inspect("and {count}")
			}`)

			expect(generated).toContain("Item__conformance.toString(item)")
			expect(generated).toContain(
				"Integer.toString__overload$1(count).value",
			)
		})

		it("leaves the witnesses that are passed to the pool", () => {
			// `sort` is handed its witness, so the object must exist and the pool builds
			// it.
			let generated = generate(witnesses)

			expect(generated).toMatch(
				/const \$pool_\d+ = \{\n\tcompare: Integer\.compare,\n/,
			)
		})

		// The map names no `toString` of its own where a Protocol provides
		// it, and a plain index would answer `Object.prototype.toString`.
		// `fold-constants` is off so that this pass is the one asked.
		it("leaves a witness whose `toString` a Protocol provides", async () => {
			expect(
				await outputOf(
					generate(providedToString, {
						enabled: true,
						disabledPasses: new Set(["fold-constants"]),
					}),
				),
			).toEqual(["a named"])
		})

		it("builds the witness again when it is turned off", () => {
			expect(
				generate(witnesses, {
					enabled: true,
					disabledPasses: new Set(["devirtualise-witnesses"]),
				}),
			).toMatch(/\$pool_\d+\.toString\(count\)/)
		})

		it("devirtualises with the pool turned off", () => {
			// Neither pass depends on the other having run. With the pool
			// off there is no const to read the witness out of, and the hole
			// still calls the Method directly.
			expect(
				generate(witnesses, {
					enabled: true,
					disabledPasses: new Set(["pool-constants"]),
				}),
			).toContain("Integer.toString__overload$1(count).value")
		})

		it("prints the same thing with the pass off", async () => {
			expect(
				await expectSamePrintedOutput(
					"devirtualise-witnesses",
					witnesses,
				),
			).toEqual([
				'"you have 3 left"',
				'"a box of 3"',
				'"nested: [1, 2]"',
				'"[1, 2]"',
			])
		})

		it("prints the same thing with the pass off for every fixture shape", async () => {
			await expectSamePrintedOutput(
				"devirtualise-witnesses",
				readFileSync(fixturePath("Interpolation.es"), "utf8"),
			)
			await expectSamePrintedOutput(
				"devirtualise-witnesses",
				readFileSync(fixturePath("ConditionalConformance.es"), "utf8"),
			)
			await expectSamePrintedOutput(
				"devirtualise-witnesses",
				readFileSync(fixturePath("Protocols.es"), "utf8"),
			)
		})
	})

	describe("lower-matches-to-statements", () => {
		it("writes a Match in Return position without a wrapper", () => {
			let generated = generate(statementMatches)

			expect(generated).toContain(
				'static radius(_self) {\n\t\tif (_self[$type.typeKeySymbol] === "Shape#Circle") {\n\t\t\treturn _self.radius;',
			)
			expect(generated).not.toContain("}(_self)")
		})

		it("binds nothing where the matched value is already _self", () => {
			// `match @ -> …` matches the receiver, already `_self`, and
			// `const _self = _self` would read the name being declared.
			let generated = generate(statementMatches)

			expect(generated).not.toContain("const _self = _self")
			expect(generated).toContain("static radius(_self) {\n\t\tif (")
		})

		it("binds the matched value in a block of its own", () => {
			// The block shadows an enclosing `_self` for the length of the chain.
			expect(generate(statementMatches)).toContain(
				"{\n\tconst _self = circle;\n\tif (",
			)
		})

		it("reads a scrutinee that mentions _self in a Scope of its own", () => {
			// `match @.held -> …` reads `_self`, which a `const _self` in the same block
			// would shadow before its initialiser runs.
			let generated = generate(statementMatches)

			expect(generated).toMatch(
				/const (\$matched_\d+) = _self\.held;\n\t\t\t\{\n\t\t\t\tconst _self = \1;/,
			)
		})

		it("writes a Declaration's Match into the name it declares", () => {
			let generated = generate(statementMatches)

			expect(generated).toContain(
				"let described;\n{\n\tconst _self = circle;",
			)
			expect(generated).toContain("\t\tdescribed = $pool_")
		})

		it("drops the answer of a Match written for its effects", () => {
			// The Simplifier appends `<- {}` to a Handler with no Return, so a discarded
			// Match drops that answer.
			let generated = generate(statementMatches)

			expect(generated).toContain(
				'{\n\tconst _self = blank;\n\tif (_self[$type.typeKeySymbol] === "Shape#Circle") {\n\t\tTerminal.inspect($pool_',
			)
			expect(generated).not.toContain("$discarded")
		})

		it("keeps the answer of a Handler answered by a Namespace the Program declares", async () => {
			// Under a Namespace named `Integer`, `1::subtract(2)` is a written Method that
			// prints, so the answer stays.
			let generated = generate(shadowedDiscardedAnswer)

			expect(await outputOf(generated)).toEqual(['"the shadow ran"', "0"])
		})

		it("breaks out of the chain where a Handler answers early", () => {
			// A Return mid-body skips the rest, which an assignment does not, so a
			// labelled block carries it.
			let generated = generate(statementMatches)

			expect(generated).toMatch(/\$match_\d+:\n/)
			expect(generated).toMatch(
				/name = \$pool_\d+;\n\t\t\t\t\tbreak \$match_\d+;/,
			)
		})

		it("labels nothing where every Handler answers last", () => {
			// A Handler whose last Statement is its answer has nothing
			// after it to skip, so there is nothing to break out of.
			let generated = generate(nestedStatementMatches)
			let labels = [...generated.matchAll(/\$match_\d+:/g)]

			expect(labels).toHaveLength(1)
			expect(generate(statementMatches)).not.toContain("break $match_0")
		})

		it("answers the outer Match from a Match nested in a Handler", () => {
			// The inner Match is in the outer Handler's Return position, so its Handlers
			// answer the outer Declaration, with no wrapper.
			let generated = generate(nestedStatementMatches)

			expect(generated).toContain("let name;")
			expect(generated).not.toContain("function (_self)")
			expect(generated).toMatch(/name = \$pool_\d+;\n\t\t\t\t\} else \{/)
		})

		it("keeps the wrapper where a Match stands mid-Expression", () => {
			// An Argument can hold no Statement, so a Match there keeps its wrapper.
			expect(generate(statementMatches)).toContain(
				"Terminal.inspect(function (_self) {",
			)
		})

		// The standard library reads fallible answers through `<- match @ -> …`,
		// which writes out at no cost.
		it("takes the wrapper off the standard library's own Matches", () => {
			let source = `implementation {
				Terminal.inspect(Integer.parse("7")::value(defaultingTo 0))
			}`
			let body = bodyOf(generate(source), "$es_Optional_value")

			expect(body).toContain(
				'const $es_Optional_value = function (_self, fallback) {\n\tif (_self[$type.typeKeySymbol] === "Optional#Value") {',
			)
			expect(body).not.toContain("function (_self) {\n\t\tif")
		})

		it("wraps the chain again when it is turned off", () => {
			let generated = generate(statementMatches, {
				enabled: true,
				disabledPasses: new Set(["lower-matches-to-statements"]),
			})

			expect(generated).toContain("return function (_self) {")
			expect(generated).not.toContain("const _self = circle")
			expect(generated).not.toContain("let described;")
		})

		// This pass runs before `elide-final-match-test`, which reads a lowered Match
		// as it reads any other.
		it("elides the last test of a lowered Match too", () => {
			let generated = generate(statementMatches)

			expect(generated).not.toContain('=== "Shape#Blank"')
			expect(generated).not.toContain("noCaseMatched")
			expect(
				generate(statementMatches, {
					enabled: true,
					disabledPasses: new Set(["elide-final-match-test"]),
				}),
			).toContain('=== "Shape#Blank"')
		})

		it("prints the same thing with the pass off", async () => {
			expect(
				await expectSamePrintedOutput(
					"lower-matches-to-statements",
					statementMatches,
				),
			).toEqual([
				'"blank"',
				"3",
				'"a big circle"',
				'"a circle"',
				'"nothing"',
				'"an Integer"',
				'"a circle"',
				'"nothing"',
			])
		})

		it("prints the same thing with the pass off for a nested Match", async () => {
			expect(
				await expectSamePrintedOutput(
					"lower-matches-to-statements",
					nestedStatementMatches,
				),
			).toEqual(['"a positive Integer"', '"an Integer"', '"a String"'])
		})

		// A Handler declaring the answer's own name must not catch the assignment
		// meant for the Declaration. The answer is held and assigned outside the
		// Handler's block.
		describe("a Handler that binds the answer's own name", () => {
			it("answers what the Program says, for every shape a name is bound in", async () => {
				expect(await outputOf(generate(shadowedAnswerNames))).toEqual([
					"6",
					"6",
					"7",
					"8",
					"9",
					"11",
				])
			})

			it("writes the answer to a name of its own and assigns after the chain", () => {
				let generated = generate(shadowedAnswerNames)

				expect(generated).toContain(
					"let answerA;\n{\n\tlet $held_answer;",
				)
				expect(generated).toContain("\tanswerA = $held_answer;")
			})

			it("assigns after the label a Handler leaves the chain through", () => {
				// A `break` lands after the label, so the assignment stands outside it.
				let generated = generate(shadowedAnswerNames)

				expect(generated).toMatch(
					/\$held_answer = answerC;\n\t\t\t\tbreak \$match_\d+;/,
				)
				expect(generated).toMatch(
					/\n\t\}\n\tanswerC = \$held_answer;\n\}/,
				)
			})

			it("holds nothing where no Handler binds the name", () => {
				// The answer goes straight to its name.
				expect(generate(statementMatches)).not.toContain("$held_answer")
			})

			it("prints the same thing with the pass off", async () => {
				expect(
					await expectSamePrintedOutput(
						"lower-matches-to-statements",
						shadowedAnswerNames,
					),
				).toEqual(["6", "6", "7", "8", "9", "11"])
			})
		})

		it("prints the same thing with the pass off for every fixture shape", async () => {
			await expectSamePrintedOutput(
				"lower-matches-to-statements",
				readFileSync(fixturePath("Match.es"), "utf8"),
			)
			await expectSamePrintedOutput(
				"lower-matches-to-statements",
				readFileSync(fixturePath("Maybe.es"), "utf8"),
			)
			await expectSamePrintedOutput(
				"lower-matches-to-statements",
				readFileSync(fixturePath("Tree.es"), "utf8"),
			)
			await expectSamePrintedOutput(
				"lower-matches-to-statements",
				readFileSync(fixturePath("Everyday.es"), "utf8"),
			)
		})

		describe("a dispatch that holds operands", () => {
			it("holds the names as the consts of a block", () => {
				let generated = generate(heldDispatches)

				expect(generated).toContain(
					"\tconst $dispatch_0 = identity($pool_0);\n\t\treturn $dispatch_0[$type.typeKeySymbol]",
				)
				expect(generated).toContain(
					"let tagged;\n{\n\tconst $dispatch_0 = either;\n\tconst $dispatch_1 = flip();\n\ttagged = ",
				)
				expect(generated).not.toContain("=>")
			})

			it("holds the receiver where an Argument could change it", async () => {
				// `flip` assigns `either`, so the lifted consts keep the written order.
				expect(
					await expectSamePrintedOutput(
						"lower-matches-to-statements",
						heldDispatches,
					),
				).toEqual(['"5"', '"box!"', "true"])
			})

			it("wraps the chain in an arrow again when it is turned off", () => {
				expect(
					generate(heldDispatches, {
						enabled: true,
						disabledPasses: new Set([
							"lower-matches-to-statements",
						]),
					}),
				).toContain("(($dispatch_0, $dispatch_1) =>")
			})

			it("leaves a chain holding nothing where it stands", () => {
				// The chain is itself the conditional Expression, so there is no wrapper.
				let generated = generate(`implementation {
					constant value: Integer | Boolean = 5

					Terminal.inspect(value::toString())
				}`)

				expect(generated).not.toContain("$dispatch_0")
			})
		})
	})

	describe("unbox-conditions", () => {
		describe("a condition that was already lowered", () => {
			it("asks the test rather than the Boolean it built", () => {
				let generated = generate(conditions)

				expect(generated).toContain("if (a.value < b.value) {")
				expect(generated).not.toContain("Boolean.falseInstance).value")
			})

			it("reads the value of a condition the Program computes", () => {
				// A written Method answers an Essence Boolean object, so its `value` is read.
				expect(generate(conditions)).toContain(
					"if (Flags.itself(yes).value) {",
				)
			})

			it("builds the Boolean again when it is turned off", () => {
				expect(
					generate(conditions, {
						enabled: true,
						disabledPasses: new Set(["unbox-conditions"]),
					}),
				).toContain(
					"if ((a.value < b.value ? Boolean.trueInstance : Boolean.falseInstance).value) {",
				)
			})

			it("prints the same thing with the pass off", async () => {
				expect(
					await expectSamePrintedOutput(
						"unbox-conditions",
						conditions,
					),
				).toEqual(['"less"', '"yes"'])
			})
		})

		// Integer arms inside an Integer operation, under every pass. A `define` is a
		// Conditional, and `unboxedInteger` must read it as an Integer rather than as
		// a guarded arithmetic. See "Unboxing" in
		// packages/compiler/src/rewriter/DEVELOPMENT.md.
		describe("a define with Integer arms, under every pass", () => {
			const stepped = `implementation {
	function stepped(_ n: Integer, by step: Integer) -> Integer {
		<- n::add(define {
			as step::multiply(with 2) if n::isGreaterThan(10)
			as step if n::isGreaterThan(0)
			as 0::subtract(step) otherwise
		})
	}

	Terminal.inspect(stepped(20, by 3))
	Terminal.inspect(stepped(5, by 3))
	Terminal.inspect(stepped(0, by 3))
}`

			it("answers the same with every pass on as with them all off", async () => {
				expect(await outputOf(generate(stepped))).toEqual([
					"26",
					"8",
					"-3",
				])
				expect(
					await outputOf(
						generate(stepped, {
							enabled: false,
							disabledPasses: new Set(),
						}),
					),
				).toEqual(["26", "8", "-3"])
			})

			it("reads the chain as the Integer it answers with", () => {
				// The chain is parenthesised and read through one `.value`. A guarded arm
				// keeps its own box inside.
				let body = generate(stepped).split(
					"function stepped(n, step)",
				)[1] as string

				expect(body).toMatch(
					/return Integer\.sum\(n\.value, \(n\.value > .*\)\.value\);/s,
				)
				expect(body).toContain('[$type.typeKeySymbol]: "Integer"')
			})
		})

		// An arm's Condition is read as an `if`'s is, with no Boolean built.
		describe("a define arm's condition", () => {
			const ladder = `implementation {
	constant score = 95

	Terminal.inspect(define {
		as "A" if score::isGreaterThanOrEqualTo(90)
		as "B" if score::isGreaterThanOrEqualTo(80)
		as "F" otherwise
	})
}`

			it("asks the test rather than the Boolean it built", () => {
				let generated = generate(ladder)

				// Two raw comparisons and three answers. The literals are pooled, so the
				// pattern matches their names.
				expect(generated).toMatch(
					/score\.value >= \$pool_\d+\.value \? \$pool_\d+ : score\.value >= \$pool_\d+\.value \? \$pool_\d+ : \$pool_\d+/,
				)
				expect(generated).not.toContain("Boolean.falseInstance).value")
			})

			it("reads the value of a Condition the Program computes", () => {
				// A Condition nothing lowered stays a value, so the ternary reads its
				// `value`.
				let generated = generate(`implementation {
	namespace Flags for Boolean {
		§§ Answers the Boolean it is called on.
		§§
		§§ @returns — the Boolean.
		itself() -> Boolean {
			<- @
		}
	}

	constant yes = true

	Terminal.inspect(define {
		as "yes" if yes::itself()
		as "no" otherwise
	})
}`)

				expect(generated).toContain("Flags.itself(yes).value ?")
			})

			it("builds the Boolean again when it is turned off", () => {
				expect(
					generate(ladder, {
						enabled: true,
						disabledPasses: new Set(["unbox-conditions"]),
					}),
				).toContain(
					"? Boolean.trueInstance : Boolean.falseInstance).value ?",
				)
			})

			it("prints the same thing with the pass off", async () => {
				expect(
					await expectSamePrintedOutput("unbox-conditions", ladder),
				).toEqual(['"A"'])
			})
		})
	})

	// Defaults under the Optimiser's contract. No pass can lift work in front of
	// a default, so `walkFunctionDefinition` offers one only to the passes that
	// ask.
	describe("default parameter values", () => {
		const defaults = `implementation {
	choice Edge {
		Front,
		Back,
	}

	function scaled(_ value: Integer, by factor: Integer = 2) -> Integer {
		<- value::multiply(with factor)
	}

	function edge(at side: Edge = #Front, of items: List<Integer>) -> Integer {
		<- match side -> Integer {
			case Edge#Front { <- items::firstItem()::value(defaultingTo 0) }
			case _ { <- items::lastItem()::value(defaultingTo 0) }
		}
	}

	namespace Windows for List<Integer> {
		upTo(_ end: Integer = @::length()) -> List<Integer> {
			<- @::slice(from 0, to end)
		}
	}

	constant items = [1, 2, 3, 4]

	Terminal.inspect(scaled(21))
	Terminal.inspect(scaled(21, by 3))
	Terminal.inspect(edge(of items))
	Terminal.inspect(edge(at #Back, of items))
	Terminal.inspect(items::upTo())
	Terminal.inspect(items::upTo(2))
	Terminal.inspect(items::map((_ item: Integer) -> Integer { <- scaled(item) }))
}`

		it("prints the same thing with the whole registry off", async () => {
			let all = await outputOf(generate(defaults))
			let none = await outputOf(
				generate(defaults, {
					enabled: false,
					disabledPasses: new Set(),
				}),
			)

			expect(all).toEqual([
				"42",
				"63",
				"1",
				"4",
				"[ 1, 2, 3, 4 ]",
				"[ 1, 2 ]",
				"[ 2, 4, 6, 8 ]",
			])
			expect(none).toEqual(all)
		})

		// A Program full of defaulted calls, with each pass turned off on its own.
		for (let passName of optimiserPassNames) {
			it(`prints the same thing with ${passName} off`, async () => {
				await expectSamePrintedOutput(passName, defaults)
			})
		}

		// A unit-Case default would otherwise build a Case at every call that leaves
		// the Argument out.
		it("pools a unit-Case default", () => {
			let source = `implementation {
				choice Edge {
					Front,
					Back,
				}

				function edge(at side: Edge = #Front) -> Edge {
					<- side
				}

				Terminal.inspect(edge())
			}`

			// A default is worked out per call, so the `createCase` moves out of the
			// parameter list.
			expect(generate(source)).toMatch(
				/function edge\(side = \$pool_\d\)/,
			)
			expect(
				generate(source, {
					enabled: true,
					disabledPasses: new Set(["pool-constants"]),
				}),
			).toContain('function edge(side = $type.createCase("Edge#Front"))')
		})

		// A literal default is pooled the same way.
		it("pools a literal default", () => {
			expect(
				generate(`implementation {
					function f(_ count: Integer = 1) -> Integer {
						<- count
					}

					Terminal.inspect(f())
				}`),
			).toContain("function f(count = $pool_0)")
		})

		// A default reading a Constant is a read, so `eliminate-dead-code` keeps it.
		it("keeps a Constant that only a default reads", async () => {
			let source = `implementation {
				constant fallback = "world"

				function greet(_ name: String = fallback) -> String {
					<- name
				}

				Terminal.inspect(greet())
			}`

			expect(generate(source)).toContain("fallback")
			expect(await outputOf(generate(source))).toEqual(['"world"'])
		})

		// No callee `inline-loops` inlines declares a default, so the guard is asked
		// of a shadowing Namespace that does.
		describe("a walk this pass inlines, given a default", () => {
			// The `@returns` line tells this entry from `removeEvery(where:)`, whose
			// signature is identical.
			const written = `the List of accepted items.
			(where check: (_: ItemType) -> Boolean) -> List<ItemType>`
			const defaulted = `the List of accepted items.
			(where check: (_: ItemType) -> Boolean = (_ item: ItemType) -> Boolean { <- true }) -> List<ItemType>`

			let replacedStdlib: Stdlib | null = null

			beforeAll(() => {
				let sources = readStdlibFiles().map(
					({ filePath, sourceText }) => {
						// The separator excludes `NumberList.es`.
						if (!filePath.endsWith("/List.es")) {
							return parseStdlibSource(filePath, sourceText)
						}

						expect(sourceText).toContain(written)

						return parseStdlibSource(
							filePath,
							sourceText.replace(written, defaulted),
						)
					},
				)

				replacedStdlib = useStdlib(loadStdlibFrom(sources))
			})

			afterAll(() => {
				useStdlib(replacedStdlib)
			})

			const folded = `implementation {
	Terminal.inspect([1, 2, 3]::everyItem(where (_ item: Integer) -> Boolean {
		<- item::isGreaterThan(1)
	}))
}`
			const omitted = `implementation {
	Terminal.inspect([1, 2, 3]::everyItem())
}`

			it("still inlines a call that writes every Argument", async () => {
				expect(generate(folded)).not.toContain("List.everyItem")
				expect(await outputOf(generate(folded))).toEqual(["[ 2, 3 ]"])
			})

			// Inlining the body would leave the default unfilled, so the call keeps its
			// frame.
			it("refuses a call that left an Argument out", async () => {
				expect(generate(omitted)).toContain("$es_List_everyItem")
				expect(await outputOf(generate(omitted))).toEqual([
					"[ 1, 2, 3 ]",
				])
			})
		})

		// A defaulted Parameter is an ordinary binding in the body.
		it("still lowers arithmetic over a defaulted Integer Parameter", () => {
			expect(generate(defaults)).toContain("value.value * factor.value")
		})
	})

	describe("inline-loops", () => {
		it("writes the counted loop as a for over what the bounds hold", () => {
			// The counter is what its bounds hold, and no State Record is built. The entry
			// called decides the direction, and literal bounds decide the counter's kind
			// while compiling. See "Counted walks" in
			// packages/compiler/src/rewriter/DEVELOPMENT.md.
			let generated = generate(countedLoop)

			expect(generated).toContain("const $loop_0_from = $pool_0.value;")
			expect(generated).not.toContain("$loop_0_up")
			expect(generated).not.toContain("$loop_0_big")
			expect(generated).toContain("const $loop_0_delta = 1;")
			expect(generated).toContain(
				"for (let $loop_0_index = $loop_0_from; $loop_0_index <= $loop_0_to; $loop_0_index += $loop_0_delta)",
			)
			expect(generated).toContain(
				"const $loop_1_bound = $loop_1_to <= $loop_1_from ? $loop_1_to : $loop_1_from;",
			)
			expect(generated).toContain("const $loop_1_delta = -1;")
			expect(generated).toContain(
				"for (let $loop_1_index = $loop_1_from; $loop_1_index >= $loop_1_bound; $loop_1_index += $loop_1_delta)",
			)
			expect(generated).not.toContain("loop__overload$3")
			expect(generated).not.toContain("loop__overload$6")
			expect(generated).not.toContain("function (")
		})

		it("decides the counter's kind at run time for a bound it can not read", () => {
			// A bound that is no Literal leaves the counter's kind to run time, and a
			// bigint counter is canonicalised per turn.
			let generated = generate(`implementation {
	function upTo(_ limit: Integer) -> Integer {
		<- loop(from 1, through limit, startingWith 0, (
			index,
			total,
		) { <- total::add(index) })
	}

	Terminal.inspect(upTo(10))
}`)

			expect(generated).toContain(
				'const $loop_0_big = typeof $loop_0_from !== "number" || typeof $loop_0_to !== "number";',
			)
			expect(generated).toContain(
				"const $loop_0_delta = $loop_0_big ? 1n : 1;",
			)
			expect(generated).toContain(
				"for (let $loop_0_index = $loop_0_big ? BigInt($loop_0_from) : $loop_0_from;",
			)
			expect(generated).toContain(
				"const $loop_0_held = $loop_0_big ? Integer.canonical($loop_0_index) : $loop_0_index;",
			)
		})

		it("hands the body the counter raw where no Integer is needed", () => {
			// A body that only reads the counter is handed the raw counter, a number
			// already in canonical form.
			let generated = generate(countedLoop)

			expect(generated).not.toContain(
				"Integer.createInteger($loop_0_index)",
			)
			expect(generated).not.toContain("$loop_0_held")
			expect(generated).toContain("total + $loop_0_index")
		})

		it("keeps the counter's Integer where the body needs one", () => {
			// A body that hands the counter on as an Argument needs the Integer, built
			// where it is handed on.
			let generated = generate(`implementation {
	constant seen = loop(from 1, through 3, startingWith [], (
		index,
		gathered,
	) { <- gathered::append(index) })

	Terminal.inspect(seen)
}`)

			expect(generated).toContain(
				"$loop_0_built.push(Integer.createInteger($loop_0_index));",
			)
		})

		it("counts down when the first bound is the greater", async () => {
			expect(
				await expectSamePrintedOutput("inline-loops", countedLoop),
			).toEqual(["55", "6", "2"])
		})

		it("carries the State as the value its Integer boxes", () => {
			// A State Integer only read by the bodies is carried as its value and built
			// once, where the walk answers. See "Unboxed counters and States" in
			// packages/compiler/src/rewriter/DEVELOPMENT.md.
			let generated = generate(countedLoop)

			expect(generated).toContain("let $loop_0_state = $pool_2.value;")
			expect(generated).toContain(
				'$loop_0_state = typeof total === "number" && typeof $loop_0_index === "number" && total + $loop_0_index >= -9007199254740991 && total + $loop_0_index <= 9007199254740991 ? total + $loop_0_index : Integer.sum(total, $loop_0_index).value;',
			)
			expect(generated).toContain(
				"sum = Integer.createInteger($loop_0_state);",
			)
			// The Parameter's `const` stays, bound per turn, so a closure captures its
			// own turn.
			expect(generated).toContain("const total = $loop_0_state;")
		})

		it("keeps the State's Integer where a body needs one", () => {
			// A body that hands the State on keeps the box, and so does a State that is
			// not exactly an Integer, such as a Record.
			let generated = generate(`implementation {
	§§ Doubles a value.
	§§
	§§ @param _ — the value
	§§ @returns — twice the value.
	function twice(_ value: Integer) -> Integer {
		<- value::add(value)
	}

	constant handed = loop(from 1, through 3, startingWith 1, (
		_index,
		carried,
	) { <- twice(carried) })

	constant built = loop(from 1, through 3, startingWith { total = 0 }, (
		index,
		state,
	) { <- { state with total = state.total::add(index) } })

	Terminal.inspect(handed)
	Terminal.inspect(built)
}`)

			expect(generated).toContain("let $loop_0_state = $pool_0;")
			expect(generated).toContain("$loop_0_state = twice(carried);")
			expect(generated).not.toContain("Integer.createInteger($loop_0_")
			expect(generated).not.toContain("Integer.createInteger($loop_1_")
		})

		it("carries a State alike with any pass turned off", async () => {
			// With `inline-loops` or `lower-scalar-operations` off there is nothing to
			// carry, and the walk answers the same.
			let source = `implementation {
	constant crossed = loop(from 1, through 3, startingWith 9007199254740990, (
		index,
		carried,
	) { <- carried::add(index) })

	constant folded = [1, 2, 3]::reduce(startingWith 9007199254740990, (
		carried,
		item,
	) { <- carried::add(item) })

	Terminal.inspect(crossed)
	Terminal.inspect(folded)
	Terminal.inspect(crossed::is(9007199254740996))
}`

			for (let pass of [
				"inline-loops",
				"lower-scalar-operations",
				"fold-constants",
				"pool-constants",
				"eliminate-dead-code",
				"compile-type-tests",
				"lower-matches-to-statements",
			]) {
				expect(await expectSamePrintedOutput(pass, source)).toEqual([
					"9007199254740996",
					"9007199254740996",
					"true",
				])
			}
		})

		it("checks a while predicate before each step", () => {
			// The predicate is asked first, as in `loop__overload$1`, so one false on the
			// seed answers the seed.
			let generated = generate(conditionLoops)

			expect(generated).toContain(
				"$loop_0:\n\t\twhile (true) {\n\t\t\t{\n\t\t\t\tconst n = $loop_0_state;\n\t\t\t\tif (!(n < $pool_1.value))\n\t\t\t\t\tbreak $loop_0;\n\t\t\t}",
			)
			expect(generated).not.toContain("loop__overload$1")
		})

		it("asks an until predicate the opposite question", () => {
			// `until` is `while` with the predicate negated. Inlined, the question is
			// asked the other way round.
			let generated = generate(conditionLoops)

			expect(generated).toContain(
				"if (n >= $pool_1.value)\n\t\t\t\t\tbreak $loop_1;",
			)
			expect(generated).not.toContain("loop__overload$2")
			expect(generated).not.toContain("Boolean.negate(")
		})

		it("assigns a Step's payload rather than building the Step", () => {
			// `#Done(x)` ends the walk and `#Continue(x)` sets the next State, written
			// where the Case would have been built.
			let generated = generate(generalLoop)

			expect(generated).toContain("$loop_0_answer = state.total;")
			expect(generated).toContain("break $loop_0;")
			expect(generated).toContain(
				"$loop_0_state = {\n\t\t\t\t\t...state,",
			)
			expect(generated).not.toContain('"Step#Done"')
			expect(generated).not.toContain('"Step#Continue"')
		})

		it("reads the tag where the Step is not built at the answer", () => {
			// A held `Step` was built out of sight, so its tag is read at the answering
			// position.
			let generated = generate(heldStep)

			expect(generated).toContain(
				'const $loop_0_step = answer;\n\t\t\t\t\tif ($loop_0_step[$type.typeKeySymbol] === "Step#Done") {\n\t\t\t\t\t\t$loop_0_answer = $loop_0_step.value;\n\t\t\t\t\t\tbreak $loop_0;',
			)
			expect(generated).toContain("$loop_0_state = $loop_0_step.state;")
		})

		it("walks a List's own positions", () => {
			let generated = generate(listWalks)

			expect(generated).toContain(
				"for (let $loop_0_position = 0; $loop_0_position < $loop_0_count; $loop_0_position++)",
			)
			expect(generated).not.toContain("List.reduce__overload$1(")
			expect(generated).not.toContain("List.everyItem__overload$1(")
		})

		it("holds the items and their count before the first turn", () => {
			// `List.materialise`, since a List may hold its items in two runs, and the
			// count is held, since the Array may grow under the walk. A walk covers what
			// its receiver held when it began.
			let generated = generate(listWalks)

			// The count is read before the seed is evaluated, so a seed that appends
			// to the receiver can not lengthen the walk.
			expect(generated).toContain(
				"const $loop_0_items = List.materialise(items);\n\tconst $loop_0_count = $loop_0_items.length;\n\tlet $loop_0_state =",
			)
			// No walk reads the Array's own length again.
			expect(generated).not.toMatch(
				/\$loop_\d+_position < \$loop_\d+_items/,
			)
		})

		it("answers the accumulator where an early fold runs to the end", () => {
			// A `#Done` leaves through the labelled block, and falling out takes the
			// accumulator. The raw Integer accumulator is boxed at that exit.
			let generated = generate(listWalks)

			expect(generated).toMatch(
				/\$loop_\d+: \{\n\t\tfor \(let \$loop_\d+_position/,
			)
			expect(generated).toMatch(
				/\t\t\$loop_(\d+)_answer = Integer\.createInteger\(\$loop_\1_state\);\n\t\}/,
			)
		})

		it("builds the Array beside the walk and wraps it once", () => {
			let generated = generate(listWalks)

			expect(generated).toContain("const $loop_2_mapped = [];")
			expect(generated).toContain("$loop_2_mapped.push(")
			expect(generated).toContain("List.createList($loop_2_mapped)")
			expect(generated).toContain("const $loop_3_kept = [];")
			expect(generated).toContain("$loop_3_kept.push($loop_3_item);")
		})

		it("leaves the call where a callback is a value", () => {
			// A walk is inlined only where its callback is written at the call. A
			// Function-valued name stays a call.
			let generated = generate(listWalks)

			expect(generated).toContain("List.map(items, double)")
			expect(generated).toContain("$loop_2_mapped")
		})

		it("walks a proven List's own positions too", () => {
			// `proven` and `written` hold one List, but the first `map` is named on
			// `NonEmptyList`, which declares its own. Both walks are inlined.
			let generated = generate(provenWalks)

			expect(generated).toContain(
				"const $loop_0_items = List.materialise(proven);",
			)
			expect(generated).toContain("const $loop_0_mapped = [];")
			expect(generated).toContain(
				"const $loop_1_items = List.materialise(written);",
			)
			expect(generated).not.toContain("NonEmptyList.map(")
		})

		it("reaches a proven receiver's other walks by widening", () => {
			// `everyItem` and `reduce` are not declared on `NonEmptyList`, so a proven
			// receiver reaches `List`'s own entries by widening.
			let unoptimised = generate(provenWalks, {
				enabled: false,
				disabledPasses: new Set(),
			})

			expect(unoptimised).toContain("List.everyItem__overload$1(proven,")
			expect(unoptimised).toContain("List.reduce__overload$1(proven,")
			expect(unoptimised).toContain("List.reduce__overload$2(proven,")
		})

		it("leaves a proven receiver's other Methods alone", () => {
			// The gate is per Method. `reverse` is no walk this pass knows, and
			// `prepend(contentsOf:)` is a wrapper around `append`.
			let generated = generate(provenWalks)

			expect(generated).toContain("NonEmptyList.reverse(proven)")
			expect(generated).toContain("NonEmptyList.prepend(proven,")
		})

		it("calls the proven Method again when it is turned off", () => {
			let generated = generate(provenWalks, {
				enabled: true,
				disabledPasses: new Set(["inline-loops"]),
			})

			expect(generated).toContain("NonEmptyList.map(proven,")
			expect(generated).toContain("List.map(written,")
			expect(generated).not.toContain("$loop_")
		})

		it("prints the same thing with the pass off over a proven List", async () => {
			expect(
				await expectSamePrintedOutput("inline-loops", provenWalks),
			).toEqual(["3", "3", "2", "6", '"3"', "3", "0"])
		})

		it("leaves the call where the Program declares its own List", () => {
			// A nested Namespace named `List` replaces the builtin for its block, so the
			// whole Program is refused.
			let generated = generate(shadowedList)

			expect(generated).toContain("List.map(")
			expect(generated).not.toContain("$loop_")
		})

		it("leaves the proven call where the Program declares its own", () => {
			// Taking `NonEmptyList` refuses only the proven walks. The ordinary walk is
			// still inlined.
			let generated = generate(shadowedNonEmptyList)

			expect(generated).toContain("NonEmptyList.map(proven,")
			expect(generated).toContain("const $loop_0_mapped = [];")
		})

		it("writes a walk in Statement position without a closure", () => {
			let generated = generate(countedLoop)

			expect(generated).toContain("let sum;\n{\n\tconst $loop_0_from")
			expect(generated).not.toContain("=> {")
		})

		it("wraps a walk in an arrow where it stands in an Expression", () => {
			// One closure for the whole walk, since an Expression position can hold a
			// `while` no other way.
			let generated = generate(argumentLoop)

			expect(generated).toContain(
				"Terminal.inspect((() => {\n\tlet $loop_0_state",
			)
			expect(generated).toContain(
				"\treturn Integer.createInteger($loop_0_state);\n})())",
			)
		})

		it("numbers a loop inside a loop apart from the one holding it", () => {
			// Nested walks share a Scope, so their names are numbered apart.
			let generated = generate(nestedLoops)

			expect(generated).toContain("$loop_0_state")
			expect(generated).toContain("$loop_1_state")
		})

		it("binds a Parameter where the closure bound it", async () => {
			// One callback's Parameter shares a name with a binding the other callback
			// reads, so each Parameter is bound in a Scope of its own.
			expect(
				await expectSamePrintedOutput(
					"inline-loops",
					shadowedParameter,
				),
			).toEqual(["101", "2", "3"])
		})

		it("evaluates what the call was given before the walk", async () => {
			// The bounds, the seed and the receiver are evaluated in the order the call
			// passed them.
			expect(
				await expectSamePrintedOutput("inline-loops", orderedLoops),
			).toEqual(["1", "3", "0", "6", "[ 1, 2 ]", "0", "3"])
		})

		it("prints the same thing with the pass off", async () => {
			expect(
				await expectSamePrintedOutput(
					"inline-loops",
					readFileSync(fixturePath("Loops.es"), "utf8"),
				),
			).toEqual(["55", "321", "15", "128", "128", "15", "2"])
		})

		it("prints the same thing with the pass off over a List Program", async () => {
			// The fixture reaches every walking Method, including the standard library's
			// own inlined walks.
			await expectSamePrintedOutput(
				"inline-loops",
				readFileSync(fixturePath("List.es"), "utf8"),
			)
		})
	})

	describe("build-lists-in-place", () => {
		it("pushes into one Array where the walk rebuilt a List per turn", () => {
			// One Array, a `push` a turn, and the box built once at the exit. The Array
			// is the State, so no State `const` is bound.
			let generated = generate(builtList)

			expect(generated).toContain("const $loop_0_built = [$pool_")
			expect(generated).toContain(
				"$loop_0_built.push(Integer.createInteger($loop_0_index));",
			)
			expect(generated).toContain(
				"built = List.createList($loop_0_built)",
			)
			expect(generated).not.toContain("$loop_0_state")
			expect(generated).not.toContain("append__overload$1(list,")
		})

		it("pushes the Argument where the const binding it stood", () => {
			// A turn whose whole body is one push writes the Argument in the push. A turn
			// doing more keeps its binding.
			let generated = generate(builtList)

			expect(generated).toContain(
				"$loop_0_built.push(Integer.createInteger($loop_0_index));",
			)
			expect(generated).not.toContain(
				"const index = Integer.createInteger($loop_0_index);",
			)
			expect(generated).toContain(
				"const index = Integer.createInteger($loop_1_index);",
			)
		})

		it("adds a whole List through the runtime's own two-run walk", () => {
			// `append(contentsOf:)` pushes the other List's logical items, not its
			// `materialise`d Array.
			let generated = generate(builtList)

			expect(generated).toContain("List.pushItemsOf(tail, $loop_2_built)")
			expect(generated).not.toContain("append__overload$2")
		})

		it("adds a whole List written as a literal as its items", () => {
			// A literal is built where it stands, so its items are pushed directly.
			let generated = generate(builtList)

			expect(generated).toContain(
				"$loop_1_built.push(index);\n\t\t\t$loop_1_built.push(index, index);",
			)
		})

		it("builds the box at every edge the State leaves through", () => {
			// Every exit, a `#Done` included, boxes the Array.
			let generated = generate(builtStates)

			expect(generated).toContain(
				"$loop_1_answer = List.createList($loop_1_built);",
			)
			expect(generated).toContain(
				"$loop_2_answer = List.createList($loop_2_built);",
			)
		})

		it("writes nothing at all for a branch that changes nothing", () => {
			// A bare answer has nothing to push or assign.
			let generated = generate(builtBranches)

			expect(generated).toContain(
				"if (index.value > $pool_3.value) {\n\t\t\t} else {\n\t\t\t\t$loop_0_built.push(index);\n\t\t\t}",
			)
		})

		it("leaves with a value of its own where the Done carries one", () => {
			let generated = generate(builtBranches)

			expect(generated).toContain(
				'$loop_1_answer = {\n\t\t\t\t\t\t[$type.typeKeySymbol]: "List",\n\t\t\t\t\t\tvalue: [$pool_6]\n\t\t\t\t\t};\n\t\t\t\t\tbreak $loop_1;',
			)
			expect(generated).toContain(
				"\t\t$loop_1_answer = List.createList($loop_1_built);",
			)
		})

		it("copies a seed the Program was holding, once, at entry", () => {
			// A seed that is not a literal is copied once into the walk's own Array,
			// with `ownItemsOf` rather than an element-wise loop.
			expect(generate(seededBuilds)).toContain(
				"const $loop_0_built = List.ownItemsOf(seed);",
			)
		})

		it("binds the State in neither body of a condition walk", () => {
			// A `while` walk hands one State to two callbacks, so both elide it or the
			// walk is declined.
			let generated = generate(builtBesideElisions)

			expect(generated).toContain("const $loop_0_built = [$pool_")
			expect(generated).toContain("$loop_0_built.push(turns);")
			expect(generated).not.toContain("const list =")
			expect(generated).not.toContain("$loop_0_state")
		})

		it("elides the counter's Integer and the accumulator at once", () => {
			// Both elisions on one callback: the counter and the accumulator are each
			// written where their `const` stood.
			let generated = generate(builtBesideElisions)

			expect(generated).toContain(
				'$loop_1_built.push(typeof $loop_1_index === "number"',
			)
			expect(generated).not.toContain("const index =")
			expect(generated).not.toContain("$loop_1_state")
		})

		it("prints the same thing with the pass off beside the elisions", async () => {
			expect(
				await expectSamePrintedOutput(
					"build-lists-in-place",
					builtBesideElisions,
				),
			).toEqual(["[ 0, 1, 2, 3 ]", "[ 0, 2, 3, 4, 5 ]"])
		})

		it("declines a walk that retains what it replaced", () => {
			// `current` is both the receiver replaced and a value written into
			// `snapshots`, so the walk is declined.
			let generated = generate(retainedAccumulator)

			expect(generated).not.toContain("_built")
			expect(generated).toContain("$loop_0_state")
		})

		it("declines every mention that is not a rebuilding chain", () => {
			// Each mention outside a rebuilding chain declines the walk.
			expect(generate(declinedAccumulators)).not.toContain("_built")
		})

		it("declines a condition walk whose predicate reads the State", () => {
			// The predicate has no rebuilding chain, so its mention of the State is a
			// read and declines the walk.
			let generated = generate(`implementation {
				constant built = loop(startingWith [0], while (list) {
					<- list::length()::isLessThan(4)
				}, (list) { <- list::append(1) })

				Terminal.inspect(built)
			}`)

			expect(generated).not.toContain("_built")
		})

		it("rebuilds the List per turn again when it is turned off", () => {
			expect(
				generate(builtList, {
					enabled: true,
					disabledPasses: new Set(["build-lists-in-place"]),
				}),
			).toContain("$loop_0_state = List.append__overload$1(list,")
		})

		it("prints the same thing with the pass off", async () => {
			expect(
				await expectSamePrintedOutput(
					"build-lists-in-place",
					builtList,
				),
			).toEqual([
				"[ 0, 1, 2, 3, 4 ]",
				"[ 0, 1, 1, 1, 2, 2, 2, 3, 3, 3 ]",
				"[ 0, 7, 8, 7, 8 ]",
			])
		})

		it("prints the same thing with the pass off for every walk", async () => {
			expect(
				await expectSamePrintedOutput(
					"build-lists-in-place",
					builtStates,
				),
			).toEqual(["[ 0, 1, 2, 3 ]", "[ 0, 1, 2, 3 ]", "[ 0, 1, 2, 3 ]"])
		})

		it("prints the same thing with the pass off for either branch", async () => {
			expect(
				await expectSamePrintedOutput(
					"build-lists-in-place",
					builtBranches,
				),
			).toEqual(["[ 0, 1, 2, 3 ]", "[ 99 ]"])
		})

		it("prints the same thing with the pass off where it declines", async () => {
			await expectSamePrintedOutput(
				"build-lists-in-place",
				retainedAccumulator,
			)
			await expectSamePrintedOutput(
				"build-lists-in-place",
				declinedAccumulators,
			)
		})

		it("never mutates a seed the Program keeps reading", async () => {
			// `seed` seeds two walks and is appended to afterwards, as are both answers.
			// Each must answer its own items, whichever Array holds them.
			expect(
				await expectSamePrintedOutput(
					"build-lists-in-place",
					seededBuilds,
				),
			).toEqual([
				"[ 1, 2, 3, 4, 5 ]",
				"[ 1, 2 ]",
				"[ 1, 2, 1, 2 ]",
				"[ 1, 2 ]",
				"[ 1, 2, 9 ]",
				"[ 1, 2, 3, 4, 5, 9 ]",
				"[ 1, 2, 9 ]",
				"[ 1, 2 ]",
			])
		})

		it("prints the same thing with the pass off over a List Program", async () => {
			// The fixture holds no walk this pass admits, so it must print the same.
			await expectSamePrintedOutput(
				"build-lists-in-place",
				readFileSync(fixturePath("List.es"), "utf8"),
			)
		})
	})

	describe("fold-constants", () => {
		it("writes the answer where the operation was written", () => {
			let generated = generate(constantFolding)

			expect(generated).toContain("Integer.createInteger(86400)")
			expect(generated).toContain("Integer.createInteger(6)")
			expect(generated).toContain("Integer.createInteger(7)")
			expect(generated).toContain("Integer.createInteger(-7)")
			expect(generated).not.toContain("Integer.createInteger(60)")
		})

		it("stores a folded Rational as the operation would", () => {
			// A fold stores what the operation stores. Rational arithmetic answers in
			// lowest terms, so `1/2 + 1/4` folds to 3 over 4.
			let generated = generate(constantFolding)

			expect(generated).toContain("Rational.createRational(3n, 4n)")
			expect(generated).toContain("Rational.createRational(1n, 4n)")
			expect(generated).toContain("Rational.createRational(1n, 3n)")
			// Construction keeps the written parts, and `absolute` of a value that is not
			// negative answers it unchanged, so `4/2` stays four over two.
			expect(generated).toContain("Rational.createRational(4n, 2n)")
			expect(generated).toContain("Rational.createRational(-1n, 2n)")
			// The Rational-beside-Rational entries are folded. The mixed sum still emits
			// the entry taking an Integer.
			expect(generated).not.toContain("Rational.add__overload$1")
			// A written `1/2` proves non-zero, so its product is `NonZeroRational`'s
			// entry, which the fold knows by name too.
			expect(generated).not.toContain("Rational.multiply__overload$1")
			expect(generated).not.toContain("NonZeroRational.multiply")
		})

		it("renders an interpolation hole whose value is written out", () => {
			// Every hole folds, so the interpolation is a String literal.
			let generated = generate(constantFolding)

			expect(generated).toContain(
				'String.createString("a count: 7, 1/2, true, x")',
			)
			expect(generated).not.toContain("$es_Rational_toString")
			expect(generated).not.toContain("$es_Boolean_toString")
		})

		it("renders a whole Rational hole as its numerator alone", () => {
			// The fold reproduces `Rational::toString`: a whole value renders its
			// numerator alone.
			expect(generate(wholeRationalHoles)).toContain(
				'String.createString("2, 2, 1/2")',
			)
		})

		it("prints the same whole Rational hole with the pass off", async () => {
			expect(
				await expectSamePrintedOutput(
					"fold-constants",
					wholeRationalHoles,
				),
			).toEqual(['"2, 2, 1/2"'])
		})

		it("concatenates two Strings that were written out", () => {
			let generated = generate(constantFolding)

			expect(generated).toContain('String.createString("ab")')
			expect(generated).not.toContain("String.append(")
		})

		it("leaves an operation whose operand is a call", () => {
			// Folding through `noisy` would drop its print. The runtime entry stays,
			// since an inlined guard would read the call more than once.
			expect(generate(constantFolding)).toContain("Integer.sum(")
		})

		it("leaves a mixed-kind operation to the Namespace that widens it", () => {
			// `1::add(1/2)` reaches the widening entry, which is no bigint addition, so
			// the call stays.
			expect(generate(constantFolding)).toContain(
				"$es_Integer_add__overload$2(",
			)
		})

		it("leaves the arithmetic of a Namespace the Program declares", async () => {
			// Under a Namespace named `Integer`, `1::subtract(2)` is a written Method
			// that prints.
			let generated = generate(shadowedArithmetic)

			expect(generated).not.toContain("Integer.createInteger(-1)")
			expect(await outputOf(generated)).toEqual(['"the shadow ran"', "9"])
		})

		it("refuses a fold larger than the cap", () => {
			// The cap is 4,096 digits, written past here on purpose. A refused fold
			// leaves the multiplication in place.
			let large = "9".repeat(4096)

			expect(
				generate(`implementation {
					Terminal.inspect(${large}::multiply(with 10))
				}`),
			).toContain(".value * ")

			expect(
				generate(`implementation {
					Terminal.inspect(${"9".repeat(4090)}::multiply(with 10))
				}`),
			).not.toContain(".value * ")
		})

		it("computes the operations again when it is turned off", () => {
			let generated = generate(constantFolding, {
				enabled: true,
				disabledPasses: new Set(["fold-constants"]),
			})

			expect(generated).toContain("Integer.createInteger(60)")
			// Both operands are written above zero, so the sum is `PositiveRational`'s,
			// which re-exports `Rational`'s.
			expect(generated).toContain("PositiveRational.add(")
			expect(generated).toContain("String.append(")
			expect(generated).not.toContain("Integer.createInteger(86400)")
		})

		it("prints the same thing with the pass off", async () => {
			expect(
				await expectSamePrintedOutput(
					"fold-constants",
					constantFolding,
				),
			).toEqual([
				"86400",
				"6",
				"7",
				"-7",
				"true",
				"true",
				"false",
				"3/4",
				"1/4",
				"1/3",
				"2/1",
				"-1/2",
				"true",
				"true",
				'"ab"',
				'"ab"',
				'"a count: 7, 1/2, true, x"',
				'"evaluated"',
				"5",
				"3/2",
			])
		})

		it("prints the same thing with the pass off for every fixture shape", async () => {
			await expectSamePrintedOutput(
				"fold-constants",
				readFileSync(fixturePath("Everyday.es"), "utf8"),
			)
			await expectSamePrintedOutput(
				"fold-constants",
				readFileSync(fixturePath("Number.es"), "utf8"),
			)
			await expectSamePrintedOutput(
				"fold-constants",
				readFileSync(fixturePath("Interpolation.es"), "utf8"),
			)
			await expectSamePrintedOutput(
				"fold-constants",
				readFileSync(fixturePath("StdlibExhaustive.es"), "utf8"),
			)
		})

		// With the scalar lowering off, the Invocation is still folded.
		it("folds the Invocation with the lowering off", () => {
			let generated = generate(constantFolding, {
				enabled: true,
				disabledPasses: new Set(["lower-scalar-operations"]),
			})

			expect(generated).toContain("Integer.createInteger(86400)")
			expect(generated).not.toContain("Integer.createInteger(60)")
		})

		// With `devirtualise-witnesses` off the witness is still a
		// `ConformanceValue`, and the Method is read out of it.
		it("renders a hole whose witness is still a map", () => {
			expect(
				generate(constantFolding, {
					enabled: true,
					disabledPasses: new Set(["devirtualise-witnesses"]),
				}),
			).toContain('String.createString("a count: 7, 1/2, true, x")')
		})

		it("leaves a hole whose `toString` a Protocol provides", async () => {
			expect(
				await outputOf(
					generate(providedToString, {
						enabled: true,
						disabledPasses: new Set(["devirtualise-witnesses"]),
					}),
				),
			).toEqual(["a named"])
		})
	})

	describe("prune-dead-match-arms", () => {
		it("takes a Handler that can never run out of the chain", () => {
			let generated = generate(deadMatchArms)

			expect(generated).not.toContain('"never"')
			expect(generated).not.toContain(
				'_self[$type.typeKeySymbol] === "Boolean"',
			)
		})

		// The pass drops exactly the Handlers the Validator reports as unreachable.
		it("drops exactly the Handlers the Validator called unreachable", () => {
			let unreachable = validatedDiagnostics(deadMatchArms).filter(
				(diagnostic) => diagnostic.code === "unreachable-case",
			)

			expect(unreachable).toHaveLength(3)
			expect(
				unreachable.every(
					(diagnostic) => diagnostic.severity === "warning",
				),
			).toBe(true)

			let program = simplifiedSource(deadMatchArms)

			expect(
				matchHandlerCount(program) -
					matchHandlerCount(
						pruneDeadMatchArms.run(
							program,
							declaredNamespaces(program),
							defaultOptimiserOptions,
						),
					),
			).toBe(unreachable.length)
		})

		it("keeps a Handler two Types share a tag with", () => {
			// The empty List passes both `List<Integer>` and `List<String>`, so neither
			// Handler is refuted.
			let generated = generate(deadMatchArms)

			expect(generated).toContain('itemType: { type: "String" }')
			expect(generated).toContain('itemType: { type: "Integer" }')
		})

		it("keeps a Record Handler beside a Record scrutinee", () => {
			// A Record Matcher is never refuted by a Record member, since members are a
			// question about the value. Read off the Handlers, since another pass
			// compiles the survivor.
			let program = simplifiedSource(deadMatchArms)
			let survivors = matchMatchers(
				pruneDeadMatchArms.run(
					program,
					declaredNamespaces(program),
					defaultOptimiserOptions,
				),
			)

			expect(survivors[3]).toHaveLength(2)
			expect(survivors[3]!.map((matcher) => matcher.type)).toEqual([
				"String",
				"Record",
			])
		})

		it("leaves the survivors in the order they were written", () => {
			// The first match wins, so survivors keep their order, checked by identity.
			let program = simplifiedSource(deadMatchArms)
			let before = matchMatchers(program)
			let after = matchMatchers(
				pruneDeadMatchArms.run(
					program,
					declaredNamespaces(program),
					defaultOptimiserOptions,
				),
			)

			expect(after).toHaveLength(before.length)

			for (let [index, survivors] of after.entries()) {
				let original = before[index]!
				let positions = survivors.map((matcher) =>
					original.indexOf(matcher),
				)

				expect(positions).not.toContain(-1)
				expect(positions).toEqual(
					[...positions].sort((first, second) => first - second),
				)
			}
		})

		it("tests them again when it is turned off", () => {
			let generated = generate(deadMatchArms, {
				enabled: true,
				disabledPasses: new Set(["prune-dead-match-arms"]),
			})

			expect(generated).toContain('"never"')
			// The tag comparison alone, since a chain may bind the tag to a name first.
			expect(generated).toContain('=== "Boolean"')
		})

		it("prints the same thing with the pass off", async () => {
			expect(
				await expectSamePrintedOutput(
					"prune-dead-match-arms",
					deadMatchArms,
				),
			).toEqual([
				'"an Integer"',
				'"Blank"',
				'"Integers"',
				'"a Record"',
				'"the Integer"',
			])
		})

		it("prints the same thing with the pass off for every fixture shape", async () => {
			await expectSamePrintedOutput(
				"prune-dead-match-arms",
				readFileSync(fixturePath("Match.es"), "utf8"),
			)
			await expectSamePrintedOutput(
				"prune-dead-match-arms",
				readFileSync(fixturePath("Tree.es"), "utf8"),
			)
		})

		// With the tests uncompiled the same Handlers go, with their descriptors.
		it("drops the same Handlers with the tests uncompiled", () => {
			let generated = generate(deadMatchArms, {
				enabled: true,
				disabledPasses: new Set(["compile-type-tests"]),
			})

			expect(generated).not.toContain('"never"')
			expect(generated).not.toContain('{ type: "Boolean" }')
		})
	})

	describe("elide-final-match-test", () => {
		it("emits the last Handler as the else of the chain", () => {
			let generated = generate(typeTests)

			// Two Handlers, one test, and no fall-through.
			expect(generated).toContain(
				'if (_self[$type.typeKeySymbol] === "Integer") {',
			)
			expect(generated).not.toContain(
				'_self[$type.typeKeySymbol] === "String"',
			)
		})

		it("keeps the fall-through where the last Handler is Guarded", () => {
			// A Guarded Handler counts toward no exhaustiveness, so it is tested and the
			// fall-through stays.
			let generated = generate(`implementation {
				constant scrutinee: Integer | String = 5

				Terminal.inspect(match scrutinee -> String {
					case String { <- "a String" }
					case Integer where @::isNegative() { <- "a negative" }
					case Integer { <- "an Integer" }
				})
			}`)

			expect(generated).not.toContain("$type.noCaseMatched(_self)")

			let guardedLast = generate(`implementation {
				constant scrutinee: Integer | String = 5

				Terminal.inspect(match scrutinee -> String {
					case String { <- "a String" }
					case Integer { <- "an Integer" }
					case Integer where @::isNegative() { <- "unreachable" }
				})
			}`)

			expect(guardedLast).toContain("$type.noCaseMatched(_self)")
		})

		it("keeps the fall-through where the last Matcher is a literal", () => {
			let generated = generate(`implementation {
				constant scrutinee: Integer | String = 5

				Terminal.inspect(match scrutinee -> String {
					case String { <- "a String" }
					case Integer { <- "an Integer" }
					case 0 { <- "unreachable" }
				})
			}`)

			expect(generated).toContain("$type.noCaseMatched(_self)")
		})

		it("keeps the fall-through where no tag decides the last Handler", () => {
			// Two Record members share the tag, so a member test decides and the throw
			// stays.
			let generated = generate(`implementation {
				constant scrutinee: { x: Integer } | { key: String } = { key = "k" }

				Terminal.inspect(match scrutinee -> String {
					case { key: String } { <- "a String" }
					case { x: Integer }  { <- "a Record" }
				})
			}`)

			expect(generated).toContain("$type.noCaseMatched(_self)")
		})

		it("elides a last Record Handler one member of the Union claims", () => {
			// `{ x: Integer } | String` has one Record member, so the last Handler's
			// check is the tag and the fall-through is unreachable.
			let generated = generate(`implementation {
				constant scrutinee: { x: Integer } | String = "text"

				Terminal.inspect(match scrutinee -> String {
					case String { <- "a String" }
					case { x: Integer } { <- "a Record" }
				})
			}`)

			expect(generated).not.toContain("$type.noCaseMatched(_self)")
		})

		// The standard library reads fallible answers through a two-Handler Match
		// on `Optional`.
		it("elides the standard library's own final tests", () => {
			let body = bodyOf(
				generate(`implementation {
					Terminal.inspect(Integer.parse("7")::value(defaultingTo 0))
				}`),
				"$es_Optional_value",
			)

			expect(body).toContain(
				'_self[$type.typeKeySymbol] === "Optional#Value"',
			)
			expect(body).not.toContain("Optional#Empty")
			expect(body).not.toContain("noCaseMatched")
		})

		it("tests every Handler again when it is turned off", () => {
			let generated = generate(typeTests, {
				enabled: true,
				disabledPasses: new Set(["elide-final-match-test"]),
			})

			// Read off the bound tag: the chain asks about the tag twice and binds it
			// once.
			expect(generated).toContain('$self_tag === "String"')
			expect(generated).toContain("$type.noCaseMatched(_self)")
		})

		it("prints the same thing with the pass off", async () => {
			expect(
				await expectSamePrintedOutput(
					"elide-final-match-test",
					typeTests,
				),
			).toEqual(['"integer"', "3", "1", "1", '"click"', "1", "0"])
		})

		it("prints the same thing with the pass off for every fixture shape", async () => {
			await expectSamePrintedOutput(
				"elide-final-match-test",
				readFileSync(fixturePath("Match.es"), "utf8"),
			)
			await expectSamePrintedOutput(
				"elide-final-match-test",
				readFileSync(fixturePath("Maybe.es"), "utf8"),
			)
			await expectSamePrintedOutput(
				"elide-final-match-test",
				readFileSync(fixturePath("Everyday.es"), "utf8"),
			)
		})

		// With the tests uncompiled, the descriptor check is what is dropped.
		it("drops the descriptor check with the other Match pass off", () => {
			let generated = generate(typeTests, {
				enabled: true,
				disabledPasses: new Set(["compile-type-tests"]),
			})

			expect(generated).toContain(
				'$type.isValueOfType(_self, { type: "Integer" })',
			)
			expect(generated).not.toContain(
				'$type.isValueOfType(_self, { type: "String" })',
			)
		})
	})

	describe("compile-record-members", () => {
		it("reads the member that discriminates instead of walking a descriptor", () => {
			// Two Records share the tag, so the members decide: one read and one
			// comparison per member, in place of the descriptor walk.
			let generated = generate(recordMembers)

			expect(generated).toContain(
				'_self.value[$type.typeKeySymbol] === "Integer"',
			)
			expect(generated).toContain(
				'_self.value[$type.typeKeySymbol] === "String"',
			)
		})

		it("reads a member that may not be there through an optional chain", () => {
			// A Record Matcher is open, so `radius` may be absent. `?.` answers
			// `undefined`, which holds no tag.
			expect(generate(recordMembers)).toContain(
				'_self.radius?.[$type.typeKeySymbol] === "Integer"',
			)
		})

		it("drops a member the static Type already decides", () => {
			// `held` is a Type Parameter on both sides, so the tree tests only `mark`.
			let generated = generate(recordMembers)

			expect(generated).toContain(
				'_self.mark[$type.typeKeySymbol] === "Integer"',
			)
			expect(generated).not.toContain("_self.held")
		})

		it("descends into a nested Record the inner member decides", () => {
			expect(generate(recordMembers)).toContain(
				'_self.at.x?.[$type.typeKeySymbol] === "Integer"',
			)
		})

		it("keeps the Record tag test where something else can arrive", () => {
			// Beside a String, the Record tag is tested first, and the `&&` guards the
			// member reads.
			expect(generate(recordMembers)).toContain(
				'_self[$type.typeKeySymbol] === "Record" && _self.radius?.[$type.typeKeySymbol] === "Integer"',
			)
		})

		it("reads a member found on Object.prototype through the optional chain too", () => {
			// A Matcher may name `toString`. No arriving Record declares it, so the read
			// goes through `?.`, and the inherited function holds no Type key.
			expect(
				generate(`implementation {
					function inherited(
						_ thing: { toString: String } | { valueOf: Integer },
					) -> String {
						<- match thing -> String {
							case { toString: String } { <- "toString" }
							case { valueOf: Integer } { <- "valueOf" }
						}
					}

					Terminal.inspect(inherited({ toString = "s" }))
				}`),
			).toContain('_self.toString?.[$type.typeKeySymbol] === "String"')
		})

		it("orders a tag comparison ahead of a walk", () => {
			// The List member is written first but read last: tag comparisons go ahead
			// of a walk.
			let generated = generate(`implementation {
				type Wide = { items: List<Integer> | List<String>, tag: Integer }
				type Narrow = { items: List<Integer>, tag: String }

				function describe(_ thing: Wide | Narrow) -> String {
					<- match thing -> String {
						case { items: List<Integer>, tag: Integer } { <- "wide" }
						case _ { <- "other" }
					}
				}

				Terminal.inspect(describe({ items = [1], tag = 1 }))
			}`)

			expect(generated).toMatch(
				/_self\.tag\[\$type\.typeKeySymbol\] === "Integer" && \$type\.isValueOfType\(_self\.items, \$pool_\d+\)/,
			)
		})

		it("orders a comparison BELOW a walk ahead of it too", () => {
			// Cost orders the tests, not depth, so a deeper comparison goes ahead of a
			// walk. A walk is a leaf, so nothing it guards stands below it.
			let generated = generate(`implementation {
				type Wide = { items: List<Integer> | List<String>, flag: { on: Integer } }
				type Narrow = { items: List<Integer>, flag: { on: String } }

				function describe(_ thing: Wide | Narrow) -> String {
					<- match thing -> String {
						case { items: List<Integer>, flag: { on: Integer } } { <- "wide" }
						case _ { <- "other" }
					}
				}

				Terminal.inspect(describe({ items = [1], flag = { on = 1 } }))
			}`)

			expect(generated).toMatch(
				/_self\.flag\.on\[\$type\.typeKeySymbol\] === "Integer" && \$type\.isValueOfType\(_self\.items, \$pool_\d+\)/,
			)
		})

		it("compiles a Union dispatch's case check", () => {
			// A dispatch case holds the same Node as a Match, so the same rule applies.
			let generated = generate(`implementation {
				namespace Circles for { radius: Integer } {
					describe() -> String { <- "circle" }
				}

				namespace Rects for { width: Integer, height: Integer } {
					describe() -> String { <- "rect" }
				}

				variable shape: { radius: Integer } | { width: Integer, height: Integer } = { radius = 1 }

				Terminal.inspect(shape::describe())
			}`)

			expect(generated).toContain(
				'shape.radius?.[$type.typeKeySymbol] === "Integer"',
			)
			expect(generated).not.toContain("isValueOfType")
		})

		it("declines where a value of any kind at all can arrive", () => {
			// Beside a Type Parameter a value may be anything, so the walk stays.
			let generated = generate(`implementation {
				function describe<infer Item>(
					_ value: Item | { x: Integer },
					like witness: Item,
				) -> String {
					<- match value -> String {
						case { x: Integer } { <- "record" }
						case _ { <- "other" }
					}
				}

				Terminal.inspect(describe({ x = 1 }, like { x = 0 }))
			}`)

			expect(generated).toMatch(/isValueOfType\(_self, \$pool_\d+\)/)
		})

		it("declines where a member that may be absent needs a walk", () => {
			// Nothing is known of a member an arriving Record does not declare, so a
			// requirement needing more than one tag comparison keeps the walk.
			let generated = generate(`implementation {
				function describe(
					_ thing: { at: { x: Integer } } | { key: String },
				) -> String {
					<- match thing -> String {
						case { at: { x: Integer } } { <- "nested" }
						case { key: String } { <- "keyed" }
					}
				}

				Terminal.inspect(describe({ key = "k" }))
			}`)

			expect(generated).toMatch(/isValueOfType\(_self, \$pool_\d+\)/)
			expect(generated).toContain('x: { type: "Integer" }')
		})

		it("declines a tree larger than it is worth writing out", () => {
			// A size rule: a tree is written out at every site, while the walk shares
			// one pooled descriptor. A plan is taken or refused whole.
			let generated = generate(`implementation {
				type Wide = { a: Integer, b: Integer, c: Integer, d: Integer, e: Integer, f: Integer, g: Integer, h: Integer, i: Integer }
				type Other = { a: String, b: String, c: String, d: String, e: String, f: String, g: String, h: String, i: String }

				function describe(_ thing: Wide | Other) -> String {
					<- match thing -> String {
						case { a: Integer, b: Integer, c: Integer, d: Integer, e: Integer, f: Integer, g: Integer, h: Integer, i: Integer } { <- "wide" }
						case { a: String } { <- "other" }
					}
				}

				Terminal.inspect(describe({ a = 1, b = 2, c = 3, d = 4, e = 5, f = 6, g = 7, h = 8, i = 9 }))
			}`)

			expect(generated).toMatch(/isValueOfType\(_self, \$pool_\d+\)/)
		})

		it("refuses a plan where all that is left is whether a member is there", () => {
			// A Type Parameter requirement leaves only whether the member is there, which
			// no tree test asks. So the plan is refused and the walk stays.
			let held: common.Type = { type: "GenericUse", name: "Item" }

			expect(
				recordMatcherTests(
					{ type: "Record", members: { held } },
					{
						type: "UnionType",
						types: [
							{ type: "Record", members: { held } },
							{
								type: "Record",
								members: { other: { type: "Integer" } },
							},
						],
					},
				),
			).toBeNull()

			// With a requirement one comparison answers, the plan is taken.
			expect(
				recordMatcherTests(
					{ type: "Record", members: { held: { type: "Integer" } } },
					{
						type: "UnionType",
						types: [
							{ type: "Record", members: { held } },
							{
								type: "Record",
								members: { other: { type: "Integer" } },
							},
						],
					},
				),
			).toEqual([
				{
					path: ["held"],
					check: { kind: "tag", tag: "Integer", optional: true },
				},
			])
		})

		// No source builds a self-referencing Type graph, so the pass is asked
		// directly.
		it("stops descending where a Matcher leads back into itself", () => {
			let outer: common.RecordType = {
				type: "Record",
				members: { x: { type: "Integer" } },
			}
			let inner: common.RecordType = {
				type: "Record",
				members: { back: outer },
			}

			outer.members["m"] = inner

			let arrivingInner: common.RecordType = {
				type: "Record",
				members: { back: { type: "String" } },
			}
			let arriving: common.RecordType = {
				type: "Record",
				members: { m: arrivingInner, x: { type: "String" } },
			}

			let tests = recordMatcherTests(outer, arriving)

			expect(tests).not.toBeNull()
			expect(
				tests!.map(
					(test) => `${test.path.join(".")}:${test.check.kind}`,
				),
			).toEqual(["x:tag", "m.back:descriptor"])
		})

		it("walks the descriptor again when it is turned off", () => {
			let generated = generate(recordMembers, {
				enabled: true,
				disabledPasses: new Set(["compile-record-members"]),
			})

			expect(generated).toMatch(/isValueOfType\(_self, \$pool_\d+\)/)
			expect(generated).toContain('type: "Record"')
		})

		it("prints the same thing with the pass off", async () => {
			expect(
				await expectSamePrintedOutput(
					"compile-record-members",
					recordMembers,
				),
			).toEqual([
				'"integer"',
				'"string"',
				'"circle"',
				'"rect"',
				'"circle"',
				'"integer mark"',
				'"string mark"',
				'"horizontal"',
				'"vertical"',
				'"radius"',
				'"text"',
			])
		})

		it("prints the same thing with the pass off for every fixture shape", async () => {
			await expectSamePrintedOutput(
				"compile-record-members",
				readFileSync(fixturePath("Match.es"), "utf8"),
			)
			await expectSamePrintedOutput(
				"compile-record-members",
				readFileSync(fixturePath("Patterns.es"), "utf8"),
			)
			await expectSamePrintedOutput(
				"compile-record-members",
				readFileSync(fixturePath("Event.es"), "utf8"),
			)
		})
	})

	describe("loop-self-tail-calls", () => {
		// The recursive walk the language teaches. See "Self tail calls" in
		// packages/compiler/src/rewriter/DEVELOPMENT.md.
		const walk = `implementation {
	function total(_ rest: List<Integer>, _ sum: Integer) -> Integer {
		<- match rest::firstItem() -> Integer {
			case #Empty       { <- sum }
			case #Value(head) { <- total(rest::removeFirst(), sum::add(head)) }
		}
	}

	Terminal.print(total([1, 2, 3, 4], 0))
}`

		it("takes a tail call back to the top of the body", async () => {
			let generated = generate(walk)

			expect(generated).toContain("$tail_0:")
			expect(generated).toContain("while (true)")
			expect(generated).toContain("continue $tail_0")
			// The Function does not call itself where its answer goes, which holds on
			// any engine.
			expect(generated).not.toContain("return total(")
			expect(await outputOf(generated)).toEqual(["10"])
		})

		it("leaves a non-tail self call a call", async () => {
			// Both of `fib`'s calls are Arguments of an addition, so nothing is looped.
			let source = `implementation {
	function fib(_ n: Integer) -> Integer {
		if n::isLessThan(2) {
			<- n
		} else {
			<- fib(n::subtract(1))::add(fib(n::subtract(2)))
		}
	}

	Terminal.print(fib(10))
}`
			let generated = generate(source)

			expect(generated).not.toContain("while (true)")
			expect(await outputOf(generated)).toEqual(["55"])
		})

		it("loops the tail call of a body that also recurses", async () => {
			// The answering call becomes a turn, and the Argument call stays a call.
			let source = `implementation {
	function counted(_ n: Integer, _ seen: Integer) -> Integer {
		if n::isLessThan(1) {
			<- seen
		} else {
			if n::is(3) {
				<- counted(1, 0)::add(counted(n::subtract(1), seen::add(1)))
			} else {
				<- counted(n::subtract(1), seen::add(1))
			}
		}
	}

	Terminal.print(counted(5, 0))
}`
			let generated = generate(source)

			expect(generated).toContain("continue $tail_0")
			expect(generated).toContain("counted(")
			expect(await outputOf(generated)).toEqual(
				await outputOf(
					generate(source, {
						enabled: true,
						disabledPasses: new Set(["loop-self-tail-calls"]),
					}),
				),
			)
		})

		it("loops a provided Method and leaves each conformer the body it runs", async () => {
			// The self call through `@` goes through the conformance, which runs a
			// replacement or a re-provided body where the conformer has one.
			let source = `implementation {
	protocol Counting {
		size() -> Integer

		trail(from n: Integer, _ marks: String) -> String {
			if n::isLessThan(1) {
				<- marks
			}

			<- @::trail(from n::subtract(@::size()), "{marks}p")
		}
	}

	protocol Recounting is Counting {
		trail(from n: Integer, _ marks: String) -> String {
			if n::isLessThan(1) {
				<- marks
			}

			<- @::trail(from n::subtract(@::size()), "{marks}r")
		}
	}

	type Plain = { plain: Integer }
	type Replaced = { replaced: Integer }
	type Extended = { extended: Integer }

	namespace Plains for Plain is Counting {
		size() -> Integer { <- @.plain }
	}

	namespace Replaceds for Replaced is Counting {
		size() -> Integer { <- @.replaced }

		trail(from n: Integer, _ marks: String) -> String {
			<- "{marks}{n}"
		}
	}

	namespace Extendeds for Extended is Recounting {
		size() -> Integer { <- @.extended }
	}

	function trailed<infer Item is Counting>(_ item: Item) -> String {
		<- item::trail(from 3, "")
	}

	constant plain: Plain = { plain = 1 }
	constant replaced: Replaced = { replaced = 1 }
	constant extended: Extended = { extended = 1 }

	Terminal.print(plain::trail(from 3, ""))
	Terminal.print(trailed(plain))
	Terminal.print(replaced::trail(from 3, ""))
	Terminal.print(trailed(replaced))
	Terminal.print(extended::trail(from 3, ""))
	Terminal.print(extended::<Counting>trail(from 3, ""))
	Terminal.print(trailed(extended))
}`

			expect(generate(source)).toContain("continue $tail_")
			expect(
				await expectSamePrintedOutput("loop-self-tail-calls", source),
			).toEqual(["ppp", "ppp", "3", "3", "rrr", "rrr", "rrr"])

			// Two unrelated Protocols provide the name. A pick and a bound each run
			// the body of the Protocol they name, whichever clause comes first.
			let unrelated = `implementation {
	protocol Stepping {
		size() -> Integer

		walk(_ n: Integer, _ marks: String) -> String {
			if n::isLessThan(1) {
				<- marks
			}

			<- @::walk(n::subtract(@::size()), "{marks}s")
		}
	}

	protocol Other {
		walk(_ n: Integer, _ marks: String) -> String {
			if n::isLessThan(1) {
				<- marks
			}

			<- @::walk(n::subtract(1), "{marks}o")
		}
	}

	type First = { first: Integer }
	type Second = { second: Integer }

	namespace Firsts for First is Stepping, is Other {
		size() -> Integer { <- 1 }
	}

	namespace Seconds for Second is Other, is Stepping {
		size() -> Integer { <- 1 }
	}

	function viaStepping<infer Item is Stepping>(_ item: Item) -> String {
		<- item::walk(3, "")
	}

	function viaOther<infer Item is Other>(_ item: Item) -> String {
		<- item::walk(3, "")
	}

	constant first: First = { first = 1 }
	constant second: Second = { second = 1 }

	Terminal.print(first::<Stepping>walk(3, ""))
	Terminal.print(first::<Other>walk(3, ""))
	Terminal.print(viaStepping(first))
	Terminal.print(viaOther(first))
	Terminal.print(second::<Stepping>walk(3, ""))
	Terminal.print(second::<Other>walk(3, ""))
	Terminal.print(viaStepping(second))
	Terminal.print(viaOther(second))
}`

			expect(generate(unrelated)).toContain("continue $tail_")
			expect(
				await expectSamePrintedOutput(
					"loop-self-tail-calls",
					unrelated,
				),
			).toEqual(["sss", "ooo", "sss", "ooo", "sss", "ooo", "sss", "ooo"])
		})

		it("rebinds every Parameter at once", async () => {
			// `<- swap(b, a)` must not write `b` over `a` before reading `a`.
			let source = `implementation {
	function swap(_ a: Integer, _ b: Integer, _ turns: Integer) -> Integer {
		if turns::isLessThan(1) {
			<- a
		} else {
			<- swap(b, a, turns::subtract(1))
		}
	}

	Terminal.print(swap(1, 2, 1))
	Terminal.print(swap(1, 2, 2))
}`

			expect(
				await expectSamePrintedOutput("loop-self-tail-calls", source),
			).toEqual(["2", "1"])
		})

		it("holds nothing where no Argument can read what a turn assigns", () => {
			// Arguments that read nothing a turn rebinds need no held names.
			let source = `implementation {
	function countdown(_ n: Integer, _ limit: Integer) -> Integer {
		if n::isLessThan(1) {
			<- limit
		} else {
			<- countdown(0, limit)
		}
	}

	Terminal.print(countdown(3, 7))
}`

			expect(generate(source)).not.toContain("$tail_0_t")
		})

		it("evaluates every Argument of a turn before it assigns any", async () => {
			// A call evaluates its written Arguments left to right, then the defaults.
			// Printing Arguments show the order.
			let source = `implementation {
	function note(_ tag: String, _ value: Integer) -> Integer {
		Terminal.print(tag)

		<- value
	}

	function walk(
		_ turns: Integer,
		first a: Integer = note("dflt-a", 1),
		second b: Integer = note("dflt-b", 2),
		third c: Integer = note("dflt-c", 4),
	) -> Integer {
		if turns::isLessThan(1) {
			<- a::add(b)::add(c)
		} else {
			<- walk(note("arg-turns", turns::subtract(1)), second note("arg-b", 5))
		}
	}

	Terminal.print(walk(2))
}`

			expect(
				await expectSamePrintedOutput("loop-self-tail-calls", source),
			).toEqual([
				"dflt-a",
				"dflt-b",
				"dflt-c",
				"arg-turns",
				"arg-b",
				"dflt-a",
				"dflt-c",
				"arg-turns",
				"arg-b",
				"dflt-a",
				"dflt-c",
				"10",
			])
		})

		it("rebinds each labelled Argument's own Parameter", async () => {
			// Labels must follow declaration order, so an Argument's position is its
			// Parameter.
			let source = `implementation {
	function span(_ turns: Integer, from low: Integer, to high: Integer) -> Integer {
		if turns::isLessThan(1) {
			<- high::subtract(low)
		} else {
			<- span(turns::subtract(1), from low::add(2), to high::add(1))
		}
	}

	Terminal.print(span(0, from 1, to 10))
	Terminal.print(span(3, from 1, to 10))
}`

			expect(
				await expectSamePrintedOutput("loop-self-tail-calls", source),
			).toEqual(["9", "6"])
		})

		it("takes a default again in the turn that left it out", async () => {
			// `by` defaults to `n`, so a turn leaving it out reads the `n` that turn
			// bound.
			let source = `implementation {
	function stepping(_ n: Integer, by step: Integer = n, sum total: Integer) -> Integer {
		if n::isLessThan(1) {
			<- total
		} else {
			<- stepping(n::subtract(1), sum total::add(step))
		}
	}

	Terminal.print(stepping(4, sum 0))
	Terminal.print(stepping(4, by 10, sum 0))
}`
			let generated = generate(source)

			// The default is assigned after the Parameter it reads.
			expect(generated).toContain("step = n")
			expect(
				await expectSamePrintedOutput("loop-self-tail-calls", source),
			).toEqual(["10", "16"])
		})

		it("holds a written Argument that stands after one a turn left out", async () => {
			// The omitted `first` stands before the written `second`, so the turn holds
			// `arg-b` and takes the default after.
			let source = `implementation {
	function note(_ tag: String, _ value: Integer) -> Integer {
		Terminal.print(tag)

		<- value
	}

	function one(_ f: () -> Integer) -> Integer {
		<- f()
	}

	function walk(
		_ turns: Integer,
		first a: Integer = note("dflt-a", 1),
		second b: Integer = note("dflt-b", 2),
	) -> Integer {
		if turns::isLessThan(1) {
			<- a::add(b)::add(one(() -> Integer { <- turns }))
		} else {
			<- walk(turns::subtract(1), second note("arg-b", 5))
		}
	}

	Terminal.print(walk(2))
}`
			let generated = generate(source)

			expect(generated).toContain("const turns = turns_p")
			expect(
				await expectSamePrintedOutput("loop-self-tail-calls", source),
			).toEqual([
				"dflt-a",
				"dflt-b",
				"arg-b",
				"dflt-a",
				"arg-b",
				"dflt-a",
				"6",
			])
		})

		it("renames the Parameter a default reads and not the member", async () => {
			// Slotting renames the Parameter `n`, not the member `opts.n` spelled
			// alike.
			let source = `implementation {
	function one(_ f: () -> Integer) -> Integer {
		<- f()
	}

	function walk(
		_ n: Integer,
		_ opts: { n: Integer },
		by step: Integer = opts.n,
	) -> Integer {
		if n::isLessThan(1) {
			<- step::add(one(() -> Integer { <- n }))
		} else {
			<- walk(n::subtract(1), opts)
		}
	}

	Terminal.print(walk(3, { n = 7 }))
}`
			let generated = generate(source)

			expect(generated).toContain("(n_p, opts, step = opts.n)")
			expect(
				await expectSamePrintedOutput("loop-self-tail-calls", source),
			).toEqual(["7"])
		})

		it("rebuilds a Record-defaulted Parameter per turn", async () => {
			// A Record default is rebuilt in a prologue the loop runs again, so a turn
			// leaving it out gets the default afresh.
			let source = `implementation {
	function defaulted(_ n: Integer, options: { retries: Integer } = { retries = 2 }) -> Integer {
		if n::isLessThan(1) {
			<- options.retries
		} else {
			<- defaulted(n::subtract(1))
		}
	}

	Terminal.print(defaulted(3, options { retries = 9 }))
	Terminal.print(defaulted(0, options { retries = 9 }))
}`

			expect(generate(source)).toContain("options = void 0")
			expect(
				await expectSamePrintedOutput("loop-self-tail-calls", source),
			).toEqual(["2", "9"])
		})

		it("binds a Parameter Pattern again per turn", async () => {
			// The loop goes around the whole body, so a Parameter Pattern binds again
			// each turn.
			let source = `implementation {
	function patterned(
		{ left, right }: { left: Integer, right: Integer },
		_ turns: Integer,
	) -> Integer {
		if turns::isLessThan(1) {
			<- left::subtract(right)
		} else {
			<- patterned({ left = right, right = left }, turns::subtract(1))
		}
	}

	Terminal.print(patterned({ left = 1, right = 2 }, 1))
	Terminal.print(patterned({ left = 1, right = 2 }, 2))
}`

			expect(
				await expectSamePrintedOutput("loop-self-tail-calls", source),
			).toEqual(["1", "-1"])
		})

		it("carries the hidden conformance Argument", async () => {
			// The hidden witness is a Parameter, and a turn rebinds it like any other.
			let source = `implementation {
	function indexOf<infer Item is Equatable>(
		_ rest: List<Item>,
		seeking needle: Item,
		startingAt index: Integer = 0,
	) -> Integer {
		<- match rest::firstItem() -> Integer {
			case #Empty { <- -1 }
			case #Value(head) {
				if head::is(needle) {
					<- index
				} else {
					<- indexOf(rest::removeFirst(), seeking needle, startingAt index::add(1))
				}
			}
		}
	}

	Terminal.print(indexOf([1, 2, 3], seeking 3))
	Terminal.print(indexOf(["a", "b"], seeking "z"))
}`
			let generated = generate(source)

			expect(generated).toContain("continue $tail_0")
			expect(
				await expectSamePrintedOutput("loop-self-tail-calls", source),
			).toEqual(["2", "-1"])
		})

		it("is not a self call to another Overload of the same name", async () => {
			// Each Overload is a member of its own, so the call names a different Method.
			// The entries share an arity, so only the name comparison tells them apart.
			let source = `implementation {
	namespace Steps for Integer {
		overload stepped {
			(_ by: Integer) -> Integer {
				<- @::stepped(times by)
			}

			(times n: Integer) -> Integer {
				<- @::add(n)
			}
		}
	}

	Terminal.print(3::stepped(4))
}`
			let generated = generate(source)

			expect(generated).not.toContain("while (true)")
			expect(await outputOf(generated)).toEqual(["7"])
		})

		it("rebinds a Parameter a Handler shadows", async () => {
			// The Handler's `sum` is the item, not the Parameter of that name, so the
			// turn must assign it.
			let source = `implementation {
	namespace Walker for List<Integer> {
		walked(_ sum: Integer) -> Integer {
			constant items = @

			<- match items::firstItem() -> Integer {
				case #Empty      { <- sum }
				case #Value(sum) { <- items::removeFirst()::walked(sum) }
			}
		}
	}

	Terminal.print([5, 6, 7]::walked(0))
}`
			let generated = generate(source)

			expect(generated).toContain("sum_p = sum")
			expect(
				await expectSamePrintedOutput("loop-self-tail-calls", source),
			).toEqual(["7"])
		})

		it("declines a Function whose name a Constant shadows", async () => {
			// `total` inside the body is the Constant, not the Function.
			let source = `implementation {
	function total(_ n: Integer) -> Integer {
		constant total = 7

		if n::isLessThan(1) {
			<- total
		} else {
			<- total
		}
	}

	Terminal.print(total(3))
}`
			let generated = generate(source)

			expect(generated).not.toContain("while (true)")
			expect(await outputOf(generated)).toEqual(["7"])
		})

		it("gives a captured Parameter a binding per turn", async () => {
			// A closure captures the variable, so a captured Parameter is rebound
			// through a slot and each turn binds its own `const`.
			let source = `implementation {
	function gather(_ n: Integer, _ made: List<() -> Integer>) -> List<Integer> {
		if n::isLessThan(1) {
			<- made::map((_ f: () -> Integer) -> Integer { <- f() })
		} else {
			<- gather(n::subtract(1), made::append(() -> Integer { <- n }))
		}
	}

	Terminal.inspect(gather(3, []))
}`
			let generated = generate(source)

			expect(generated).toContain("const n = n_p")
			expect(
				await expectSamePrintedOutput("loop-self-tail-calls", source),
			).toEqual(["[ 3, 2, 1 ]"])
		})

		it("gives EVERY captured Parameter a binding per turn", async () => {
			// One closure over two rebound Parameters: the rule is per Parameter, so
			// both are slotted.
			let source = `implementation {
	function gather(_ n: Integer, _ m: Integer, _ made: List<() -> Integer>) -> List<Integer> {
		if n::isLessThan(1) {
			<- made::map((_ f: () -> Integer) -> Integer { <- f() })
		} else {
			<- gather(
				n::subtract(1),
				m::add(10),
				made::append(() -> Integer { <- n::add(m) }),
			)
		}
	}

	Terminal.inspect(gather(3, 0, []))
}`
			let generated = generate(source)

			expect(generated).toContain("const n = n_p")
			expect(generated).toContain("const m = m_p")
			expect(
				await expectSamePrintedOutput("loop-self-tail-calls", source),
			).toEqual(["[ 3, 12, 21 ]"])
		})

		it("declines a default that builds a closure over a rebound Parameter", async () => {
			// A default is evaluated where the turn assigns, with no turn `const` for a
			// closure in it to capture. Such a Function is declined.
			let source = `implementation {
	function gather(
		_ n: Integer,
		_ made: List<() -> Integer>,
		_ maker: () -> Integer = () -> Integer { <- n },
	) -> List<Integer> {
		if n::isLessThan(1) {
			<- made::map((_ f: () -> Integer) -> Integer { <- f() })
		} else {
			<- gather(n::subtract(1), made::append(maker))
		}
	}

	Terminal.inspect(gather(3, []))
}`
			let generated = generate(source)

			expect(generated).not.toContain("$tail_")
			expect(
				await expectSamePrintedOutput("loop-self-tail-calls", source),
			).toEqual(["[ 3, 2, 1 ]"])
		})

		it("loops a Function whose default builds a closure over nothing", async () => {
			// This default's closure mentions no Parameter, so the walk is looped.
			let source = `implementation {
	function gather(
		_ n: Integer,
		_ made: List<() -> Integer>,
		_ maker: () -> Integer = () -> Integer { <- 7 },
	) -> List<Integer> {
		if n::isLessThan(1) {
			<- made::map((_ f: () -> Integer) -> Integer { <- f() })
		} else {
			<- gather(n::subtract(1), made::append(maker))
		}
	}

	Terminal.inspect(gather(3, []))
}`
			let generated = generate(source)

			expect(generated).toContain("continue $tail_0")
			expect(
				await expectSamePrintedOutput("loop-self-tail-calls", source),
			).toEqual(["[ 7, 7, 7 ]"])
		})

		it("walks on the same receiver and on another", async () => {
			// `sameReceiver` hands `@` on unchanged, so `_self` is not assigned. `total`
			// walks another value from inside a Handler, so the receiver is slotted.
			let source = `implementation {
	namespace Walker for List<Integer> {
		sameReceiver(_ turns: Integer) -> Integer {
			if turns::isLessThan(1) {
				<- @::length()
			} else {
				<- @::sameReceiver(turns::subtract(1))
			}
		}

		total(_ sum: Integer) -> Integer {
			constant items = @

			<- match items::firstItem() -> Integer {
				case #Empty     { <- sum }
				case #Value(it) { <- items::removeFirst()::total(sum::add(it)) }
			}
		}
	}

	Terminal.print([1, 2, 3]::sameReceiver(4))
	Terminal.print([1, 2, 3]::total(0))
}`
			let generated = generate(source)

			// An unchanged receiver stays the declared Parameter. Inside a Handler `@` is
			// the matched value, so the other receiver goes through a slot.
			expect(generated).toContain("static sameReceiver(_self, turns)")
			expect(generated).toContain("static total(_self_p, sum)")
			expect(generated).toContain("const _self = _self_p")
			expect(
				await expectSamePrintedOutput("loop-self-tail-calls", source),
			).toEqual(["3", "6"])
		})

		it("writes a define's arms out as a ladder", async () => {
			// In Return position a `define` is written as a ladder, so arms answering
			// with a tail call become turns.
			let source = `implementation {
	function ladder(_ n: Integer, _ seen: Integer) -> Integer {
		<- define {
			as seen                                 if n::isLessThan(1)
			as ladder(n::subtract(2), seen::add(2)) if n::isGreaterThan(9)
			as ladder(n::subtract(1), seen::add(1)) otherwise
		}
	}

	Terminal.print(ladder(25, 0))
}`
			let generated = generate(source)

			expect(generated).toContain("continue $tail_0")
			expect(
				await expectSamePrintedOutput("loop-self-tail-calls", source),
			).toEqual(["25"])
		})

		it("never sees a Function that recurses on every path", () => {
			// `infinite-recursion` is decided by the Validator on the source, so no loop
			// can hide it.
			let diagnostics = validatedDiagnostics(`implementation {
	namespace Looping for Integer {
		forever(_ n: Integer) -> Integer { <- @::forever(n::add(1)) }
	}

	Terminal.print(1::forever(0))
}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
				"infinite-recursion",
			)
		})

		it("declines a completing body", async () => {
			// In a completing body the call is inside the wait, so there is no tail
			// call. A turn there would inherit the run's cancellation.
			let source = `implementation {
	function counted(_ n: Integer, _ sum: Integer) -> Future<Integer> {
		constant held = complete Async.deferred(() { <- n })

		if held::isLessThan(1) {
			<- sum
		} else {
			<- complete counted(n::subtract(1), sum::add(n))
		}
	}

	Terminal.print(complete counted(3, 0))
}`
			let generated = generate(source)

			expect(generated).not.toContain("while (true)")
			expect(await outputOf(generated)).toEqual(["6"])
		})

		it("counts every turn it takes under coverage", async () => {
			// `instrument-coverage` runs first, so every turn runs the counters again.
			let instrumented = generate(walk, {
				enabled: true,
				disabledPasses: new Set(),
				coverage: true,
			})

			expect(instrumented).toContain("continue $tail_0")
			expect(await outputOf(instrumented)).toEqual(["10"])
		})

		it("prints the same thing with the pass off", async () => {
			expect(
				await expectSamePrintedOutput("loop-self-tail-calls", walk),
			).toEqual(["10"])

			for (let fixture of [
				"Everyday.es",
				"List.es",
				"Match.es",
				"Tree.es",
				"Loops.es",
				"Patterns.es",
				"Generics.es",
			]) {
				await expectSamePrintedOutput(
					"loop-self-tail-calls",
					readFileSync(fixturePath(fixture), "utf8"),
				)
			}
		})
	})

	describe("eliminate-dead-code", () => {
		it("drops a Constant nothing reads", () => {
			let generated = generate(deadCode)

			expect(generated).not.toContain("const dropped")
			expect(generated).not.toContain("droppedInside")
			expect(generated).toContain("const kept")
			expect(generated).toContain("const keptInside")
		})

		it("keeps a Constant whose value PRINTS", () => {
			// The Declaration is what runs the print, so it stays.
			expect(generate(deadCode)).toContain("const loud = noisy()")
		})

		it("keeps a Constant answered by a Namespace the Program declares", async () => {
			// Under a Namespace named `Integer`, `1::subtract(2)` prints, so its unread
			// Declaration stays.
			let generated = generate(shadowedDeadCode)

			expect(generated).toContain("const unread")
			expect(await outputOf(generated)).toEqual(['"the shadow ran"', "0"])
		})

		it("keeps a variable, whatever is done with it", () => {
			// The pass does not read assignments, so a `variable` always stays.
			expect(generate(deadCode)).toContain("let counted")
		})

		it("drops a Constant holding an interpolated String nobody reads", () => {
			// A hole calls `toString` through its witness, weighed like a written call.
			// `Integer.toString` is pure.
			let generated = generate(`implementation {
				constant count = 3
				constant greeting = "you have {count}"

				Terminal.inspect(count)
			}`)

			expect(generated).not.toContain("greeting")
		})

		it("keeps one whose hole is answered by a Namespace with no entry", async () => {
			// A written Namespace may print, and the purity table is an allowlist.
			let generated = generate(`implementation {
				choice Mood { Loud }

				namespace Mood for Mood is Printable {
					toString() -> String {
						Terminal.print("rendered")

						<- "loud"
					}
				}

				constant mood: Mood = #Loud
				constant unread = "the mood is {mood}"

				Terminal.inspect(1)
			}`)

			expect(generated).toContain("unread")
			expect(await outputOf(generated)).toEqual(["rendered", "1"])
		})

		it("keeps a Constant its Module exports", () => {
			// Every exported name is a root, since other Modules may read it. Asked of
			// the pass directly.
			let program = simplifiedSource(`implementation {
				constant shared = 1::add(2)
			}`)
			let exported: common.typedSimple.Program = {
				...program,
				exports: {
					nodeType: "ExportSection",
					entries: [
						{
							nodeType: "Export",
							name: "shared",
							alias: null,
							modulePath: null,
							runtime: true,
						},
					],
				},
			}

			expect(
				declaredConstantNames(
					eliminateDeadCode.run(
						program,
						declaredNamespaces(program),
						defaultOptimiserOptions,
					),
				),
			).toEqual([])
			expect(
				declaredConstantNames(
					eliminateDeadCode.run(
						exported,
						declaredNamespaces(exported),
						defaultOptimiserOptions,
					),
				),
			).toEqual(["shared"])
		})

		it("declares them again when it is turned off", () => {
			let generated = generate(deadCode, {
				enabled: true,
				disabledPasses: new Set(["eliminate-dead-code"]),
			})

			expect(generated).toContain("const dropped")
			expect(generated).toContain("droppedInside")
		})

		it("prints the same thing with the pass off", async () => {
			expect(
				await expectSamePrintedOutput("eliminate-dead-code", deadCode),
			).toEqual(['"evaluated"', "2", "15", "8"])
		})

		it("prints the same thing with the pass off for every fixture shape", async () => {
			await expectSamePrintedOutput(
				"eliminate-dead-code",
				readFileSync(fixturePath("Everyday.es"), "utf8"),
			)
			await expectSamePrintedOutput(
				"eliminate-dead-code",
				readFileSync(fixturePath("Loops.es"), "utf8"),
			)
			await expectSamePrintedOutput(
				"eliminate-dead-code",
				readFileSync(fixturePath("StdlibExhaustive.es"), "utf8"),
			)
		})
	})

	describe("collapse-construction", () => {
		it("builds a Record in one allocation", () => {
			let generated = generate(constructions)

			expect(generated).toContain('[$type.typeKeySymbol]: "Record"')
			expect(generated).not.toContain("Record.createRecord(")
		})

		it("builds a List in one allocation", () => {
			let generated = generate(constructions)

			expect(generated).toContain('[$type.typeKeySymbol]: "List"')
			expect(generated).not.toContain("List.createList(")
		})

		it("writes a Case's tag onto the Record its payload builds", () => {
			let generated = generate(constructions)

			expect(generated).toContain('[$type.typeKeySymbol]: "Shape#Circle"')
			// A held payload is spread, as `createCase` does.
			expect(generated).toContain("...payload")
			// A unit Case keeps its constructor, which hands out one instance per tag.
			expect(generated).toContain('$type.createCase("Shape#Blank")')
		})

		it("quotes a member name JavaScript can not spell", () => {
			expect(generate(constructions)).toContain('"ok?": ')
		})

		// The standard library's bodies go through the pass too. The List is bound,
		// since a written one would reach `NonEmptyList`.
		it("collapses the standard library's bodies too", () => {
			const source = `implementation {
				constant numbers: List<Integer> = [1, 2, 2]

				Terminal.inspect(numbers::removeLast(9))
			}`

			let generated = generate(source)

			// `removeLast` writes a `[]` for a count past the length.
			expect(generated).toContain("$es_List_removeLast")
			expect(generated).not.toContain("List.createList(")

			let unoptimised = generate(source, {
				enabled: true,
				disabledPasses: new Set(["collapse-construction"]),
			})

			expect(unoptimised).toContain("List.createList(")
		})

		it("emits the constructors again when it is turned off", () => {
			let generated = generate(constructions, {
				enabled: true,
				disabledPasses: new Set(["collapse-construction"]),
			})

			expect(generated).toContain("Record.createRecord(")
			expect(generated).toContain("List.createList(")
			expect(generated).toContain('$type.createCase("Shape#Circle"')
			expect(generated).not.toContain('[$type.typeKeySymbol]: "Record"')
		})

		it("prints the same thing with the pass off", async () => {
			expect(
				await expectSamePrintedOutput(
					"collapse-construction",
					constructions,
				),
			).toEqual([
				"{ x = 1, y = 2 }",
				"{ only = 1 }",
				"{ ok? = 1 }",
				"[ 1, 2, 3 ]",
				"[ [ 1 ], [ 2 ] ]",
				"Shape#Circle(3)",
				"Shape#Circle(4)",
				"Shape#Blank",
				"false",
				"true",
				"3",
			])
		})

		it("prints the same thing with the pass off for every fixture shape", async () => {
			await expectSamePrintedOutput(
				"collapse-construction",
				readFileSync(fixturePath("Loops.es"), "utf8"),
			)
			await expectSamePrintedOutput(
				"collapse-construction",
				readFileSync(fixturePath("Everyday.es"), "utf8"),
			)
		})

		// A Record default's prologue is a `RecordValue`, so it collapses like any
		// other.
		it("collapses the Record a default is merged into", async () => {
			const merged = `implementation {
	type Options = { host: String, retries: Integer }

	function connect(using settings: Options = { retries = 3 }) -> String {
		<- settings.host
	}

	Terminal.inspect(connect(using { host = "h" }))
}`

			let generated = generate(merged)

			expect(generated).toContain('[$type.typeKeySymbol]: "Record"')
			expect(generated).not.toContain("Record.createRecord(")
			expect(
				await expectSamePrintedOutput("collapse-construction", merged),
			).toEqual(['"h"'])
		})
	})

	describe("pool-constants", () => {
		it("builds a constant once and reads it by name", () => {
			let generated = generate(constants)

			expect(generated).toMatch(
				/const \$pool_\d+ = Integer\.createInteger\(1\);/,
			)
			expect(generated).toMatch(
				/const \$pool_\d+ = Rational\.createRational\(1n, 2n\);/,
			)
			expect(generated).toMatch(
				/const \$pool_\d+ = \$type\.createCase\("Colour#Red"\);/,
			)
		})

		it("declares one constant for a value written many times", () => {
			// One const answers for every `1`.
			let generated = generate(constants)
			let declarations = [
				...generated.matchAll(
					/const \$pool_\d+ = Integer\.createInteger\(1\)/g,
				),
			]

			expect(declarations).toHaveLength(1)
		})

		it("pools the descriptor a Match still checks against", () => {
			// Unpooled, the descriptor would be rebuilt at every test.
			let generated = generate(constants)

			expect(generated).toMatch(/isValueOfType\(_self, \$pool_\d+\)/)
			expect(generated).toMatch(/const \$pool_\d+ = \{\n\ttype: "Record"/)
		})

		// A self-referencing descriptor, built by hand since no source can. The
		// back-edge keys as a `<cycle:N>` marker.
		it("keys a descriptor whose graph leads back into itself", () => {
			function descriptorProgram(): common.typedSimple.Program {
				let union: common.UnionType = {
					type: "UnionType",
					name: "Tree",
					types: [],
				}

				union.types.push({
					type: "Case",
					choice: "Tree",
					name: "Node",
					members: {
						weight: { type: "Integer" },
						children: { type: "List", itemType: union },
					},
				})

				return {
					nodeType: "Program",
					imports: null,
					tests: null,
					coverage: null,
					exports: null,
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "Intrinsic",
								kind: "type-descriptor",
								descriptor: union,
								type: { type: "Unknown" },
							},
						],
					},
				}
			}

			function keyOf(program: common.typedSimple.Program): string {
				let node = poolConstants.run(
					program,
					declaredNamespaces(program),
					defaultOptimiserOptions,
				).implementation.nodes[0]!

				expect(node.nodeType).toBe("Intrinsic")

				return (node as common.typedSimple.PooledReferenceNode).key
			}

			let key = keyOf(descriptorProgram())

			expect(key).toContain("<cycle:")
			expect(keyOf(descriptorProgram())).toBe(key)
		})

		it("pools a conformance witness", () => {
			// `Comparable` provides the four inequalities, so a witness
			// for it names Integer's own overrides beside its `compare`.
			expect(generate(constants)).toMatch(
				/const \$pool_\d+ = \{\n\tcompare: Integer\.compare,\n/,
			)
		})

		it("pools the call a conditional witness is bound by", () => {
			// `boundConformance` reads only its Arguments, so the call is as constant as
			// the map it is given.
			expect(generate(conditionalConformances)).toMatch(
				/const \$pool_\d+ = \$type\.providedConformance\(\$type\.boundConformance\(\{ compare: List\.compare \}, \[\$pool_\d+\]\), \{/,
			)
		})

		it("tells two depths of curried witness apart", () => {
			// The two depths are the same map with different curried witnesses, so two
			// constants, the deeper reading the shallower.
			let declarations = [
				...generate(conditionalConformances).matchAll(
					/const (\$pool_\d+) = \$type\.providedConformance\(\$type\.boundConformance\(\{ compare: List\.compare \}, \[(\$pool_\d+)\]\), \{/g,
				),
			]

			expect(declarations).toHaveLength(2)

			let [shallower, deeper] = declarations

			expect(deeper![2]).toEqual(shallower![1]!)
		})

		it("sorts by the witness each depth was given", async () => {
			// A shared constant would order `[[[2]], [[1]]]` the wrong way round.
			expect(await outputOf(generate(conditionalConformances))).toEqual([
				"[ [ 1, 2 ], [ 3 ] ]",
				"[ [ [ 1 ] ], [ [ 2 ] ] ]",
				'"Less"',
			])
		})

		it("tells two Choices' Case listings apart", () => {
			// One const per Choice, keyed by its tags.
			let generated = generate(derivedCaseListings)
			let declarations = [
				...generated.matchAll(
					/const (\$pool_\d+) = \{\n\tcases: \$helpers\.choiceCases\(\[/g,
				),
			]

			expect(declarations).toHaveLength(2)
			expect(generated).toMatch(
				/count\(red, (\$pool_\d+)\)[^]*count\(small, (?!\1)\$pool_\d+\)[^]*count\(red, \1\)/,
			)
		})

		it("lists the Cases of the Choice each witness was given", async () => {
			// A shared constant would count the second Choice's Cases as the first's.
			expect(await outputOf(generate(derivedCaseListings))).toEqual([
				"2",
				"3",
				"2",
			])
		})

		it("declares a witness naming a Namespace below that Namespace", () => {
			// A class is not hoisted, so a witness naming `Boxes` is declared after the
			// class rather than in the band.
			expect(generate(constants)).toMatch(
				/class Boxes \{[^]*?\n\}\nconst \$pool_\d+ = \$type\.providedConformance\(\{ compare: Boxes\.compare \}, \{/,
			)
		})

		it("refuses a witness naming a Namespace declared in a block", () => {
			// Two blocks may declare same-named Namespaces whose witnesses key alike but
			// mean different classes. Both stay where they were written.
			let generated = generate(`implementation {
				type Box = { value: Integer }

				function first(_ boxes: List<Box>) -> List<Box> {
					namespace Boxes for Box is Comparable {
						§§ Compares two Boxes by the value each holds.
						§§
						§§ @param other — the Box to compare with
						§§ @returns — how this Box orders against it.
						compare(to other: Box) -> Ordering {
							<- @.value::compare(to other.value)
						}
					}

					<- boxes::sort()
				}

				function second(_ boxes: List<Box>) -> List<Box> {
					namespace Boxes for Box is Comparable {
						§§ Compares two Boxes by the value each holds.
						§§
						§§ @param other — the Box to compare with
						§§ @returns — how this Box orders against it.
						compare(to other: Box) -> Ordering {
							<- other.value::compare(to @.value)
						}
					}

					<- boxes::sort()
				}

				Terminal.inspect(first([{ value = 3 }, { value = 1 }]))
				Terminal.inspect(second([{ value = 3 }, { value = 1 }]))
			}`)

			expect([
				...generated.matchAll(/\{ compare: Boxes\.compare \}/g),
			]).toHaveLength(2)
			expect(generated).not.toMatch(
				/const \$pool_\d+ = \{ compare: Boxes\.compare \}/,
			)
		})

		it("leaves Booleans alone", () => {
			// A running Program already holds the two Boolean objects.
			let generated = generate(constants)

			expect(generated).toContain("Boolean.createBoolean(true)")
			expect(generated).not.toMatch(
				/const \$pool_\d+ = Boolean\.createBoolean/,
			)
		})

		it("declares the band between the standard library and the Program", () => {
			// A pooled witness reads the prelude consts before it, and a static
			// Property's value may read a pooled constant after it.
			let generated = generate(constants)

			expect(generated.indexOf("const $pool_0")).toBeGreaterThan(
				generated.indexOf("const $es_"),
			)
			expect(generated.indexOf("const $pool_0")).toBeLessThan(
				generated.indexOf("Terminal.inspect("),
			)
		})

		// The counted driver's `1` is pooled. With `inline-loops` on, the one
		// `createInteger` left in a walk builds the Integer the body is handed.
		it("takes the per-turn Integer out of a loop", () => {
			let generated = generate(
				readFileSync(fixturePath("Loops.es"), "utf8"),
			)
			let built = generated
				.split("\n")
				.filter((line) => line.includes("createInteger("))

			expect(built.length).toBeGreaterThan(0)
			expect(
				built.filter(
					(line) =>
						!line.startsWith("const $pool_") &&
						!line.includes("Integer.createInteger($loop_"),
				),
			).toEqual([])
		})

		it("builds them at the site again when it is turned off", () => {
			let generated = generate(constants, {
				enabled: true,
				disabledPasses: new Set(["pool-constants"]),
			})

			expect(generated).not.toContain("$pool_")
			expect(generated).toContain("Integer.createInteger(1)")
			expect(generated).toContain("compare: Integer.compare,")
		})

		it("prints the same thing with the pass off", async () => {
			expect(
				await expectSamePrintedOutput("pool-constants", constants),
			).toEqual([
				"2",
				"1/2",
				"true",
				"true",
				'"a count: 7"',
				"[ 1, 2 ]",
				"[ { value = 1 }, { value = 3 } ]",
				'"a Record"',
			])
		})

		it("prints the same thing with the pass off for every fixture shape", async () => {
			await expectSamePrintedOutput(
				"pool-constants",
				readFileSync(fixturePath("Loops.es"), "utf8"),
			)
			await expectSamePrintedOutput(
				"pool-constants",
				readFileSync(fixturePath("Everyday.es"), "utf8"),
			)
			await expectSamePrintedOutput(
				"pool-constants",
				readFileSync(fixturePath("Interpolation.es"), "utf8"),
			)
			await expectSamePrintedOutput(
				"pool-constants",
				readFileSync(fixturePath("ConditionalConformance.es"), "utf8"),
			)
		})

		// With `compile-type-tests` off fewer descriptors are in reach, so less is
		// pooled.
		it("pools what it can with the Match tests uncompiled", async () => {
			let generated = generate(constants, {
				enabled: true,
				disabledPasses: new Set(["compile-type-tests"]),
			})

			expect(generated).toMatch(
				/const \$pool_\d+ = Integer\.createInteger\(1\);/,
			)
			expect(generated).toContain("$type.isValueOfType(_self, {")

			let all = await outputOf(generate(constants))
			let uncompiled = await outputOf(generated)

			expect(uncompiled).toEqual(all)
		})
	})

	describe("collapse-combinations", () => {
		it("combines two Records with one spread", () => {
			let generated = generate(combinations)

			expect(generated).toContain("...base")
			expect(generated).not.toContain("Object.assign(")
		})

		// `changes` is typed `{ x: Integer }`, so only `x` is read, never whatever
		// else the value holds.
		it("projects a right-hand side that is not a literal", () => {
			let generated = generate(combinations)

			expect(generated).toContain("x: changes.x")
			expect(generated).not.toContain("...changes")
		})

		// With the pass off, `Object.assign` returns for literal right-hand sides.
		// The projection stays.
		it("assigns again when it is turned off", () => {
			let generated = generate(combinations, {
				enabled: true,
				disabledPasses: new Set(["collapse-combinations"]),
			})

			expect(generated).toContain("Object.assign(")
			expect(generated).toContain("x: changes.x")
		})

		// With `collapse-construction` off, a literal right-hand side is still
		// written out member by member.
		it("writes the members out with the other collapse off", () => {
			let generated = generate(combinations, {
				enabled: true,
				disabledPasses: new Set(["collapse-construction"]),
			})

			expect(generated).toContain("...base")
			expect(generated).not.toContain("Object.assign(")
		})

		it("prints the same thing with the pass off", async () => {
			expect(
				await expectSamePrintedOutput(
					"collapse-combinations",
					combinations,
				),
			).toEqual([
				"{ x = 1, y = 2 }",
				"{ x = 9, y = 2 }",
				"{ x = 8, y = 9 }",
				"{ x = 7, y = 2 }",
				"true",
			])
		})

		it("prints the same thing with both collapses off", async () => {
			let all = await outputOf(generate(combinations))
			let neither = await outputOf(
				generate(combinations, {
					enabled: true,
					disabledPasses: new Set([
						"collapse-construction",
						"collapse-combinations",
					]),
				}),
			)
			let none = await outputOf(
				generate(combinations, {
					enabled: false,
					disabledPasses: new Set(),
				}),
			)

			expect(neither).toEqual(all)
			expect(none).toEqual(all)
		})
	})

	// What a List answers may not depend on whether the Optimiser wrote it out.
	// `more` grows the Array `both` holds, `other` copies, and `both` still
	// answers its own six items.
	describe("a List grown at both ends", () => {
		it("prints the same thing with the whole registry off", async () => {
			let all = await outputOf(generate(bothEnds))
			let none = await outputOf(
				generate(bothEnds, {
					enabled: false,
					disabledPasses: new Set(),
				}),
			)

			expect(all).toEqual([
				"[ 3, 4 ]",
				"[ 1, 2, 3, 4 ]",
				"[ 1, 2, 3, 4, 5, 6 ]",
				"[ 1, 2, 3, 4, 5, 6, 7, 8 ]",
				"[ 1, 2, 3, 4, 5, 6, 9 ]",
				"8",
				"Optional#Value(1)",
				"Optional#Value(3)",
				"Optional#Value(8)",
				"[ 2, 3, 4 ]",
				"[ 8, 7, 6, 5, 4, 3, 2, 1 ]",
				"[ 2, 4, 6, 8, 10, 12, 14, 16 ]",
				"[ 4, 5, 6, 7, 8 ]",
				"36",
				"true",
				"4",
			])
			expect(none).toEqual(all)
		})
	})

	// The same for edits. `both` and `window` are printed first and last, since
	// everything between lives on their Arrays.
	describe("a List edited at both ends and in the middle", () => {
		it("prints the same thing with the whole registry off", async () => {
			let all = await outputOf(generate(bothEndsEdited))
			let none = await outputOf(
				generate(bothEndsEdited, {
					enabled: false,
					disabledPasses: new Set(),
				}),
			)

			expect(all).toEqual([
				"[ 1, 2, 3, 4, 5, 6, 7, 8 ]",
				"[ 2, 3, 4, 5, 6, 7 ]",
				"[ 2, 3, 4, 5, 6, 7, 8 ]",
				"[ 1, 2, 3, 5, 6, 7, 8 ]",
				"[ 1, 2, 3, 4, 5, 6, 7 ]",
				"[ 1, 2, 3, 4, 5, 6, 7, 8 ]",
				"[ 1, 2, 3, 4, 5, 6, 7, 8 ]",
				"[ 0, 1, 2, 3, 4, 5, 6, 7, 8 ]",
				"[ 1, 2, 3, 99, 4, 5, 6, 7, 8 ]",
				"[ 1, 2, 3, 4, 5, 6, 7, 8, 99 ]",
				"[ 1, 2, 3, 4, 5, 6, 7, 99, 8 ]",
				"[ 1, 2, 3, 4, 5, 6, 7, 8, 99 ]",
				"[ 99, 2, 3, 4, 5, 6, 7, 8 ]",
				"[ 1, 2, 3, 4, 99, 6, 7, 8 ]",
				"[ 1, 2, 3, 4, 5, 6, 7, 99 ]",
				"[ 1, 2, 3, 4, 5, 6, 7, 8 ]",
				"[ 2, 3, 99, 5, 6, 7 ]",
				"[ 2, 3, 5, 6, 7 ]",
				"[ 2, 3, 4, 5, 6, 7, 97 ]",
				"[ 96, 2, 3, 4, 5, 6, 7 ]",
				"[ 2, 3, 4, 5, 6, 7, 8 ]",
				"[ 1, 2, 3, 4, 5, 6, 7 ]",
				"[ 4, 5, 6, 7, 8 ]",
				"[ 1, 2, 3, 4, 5 ]",
				"[ 1, 2, 3, 4, 5, 6, 7, 8 ]",
				"[ 2, 3, 4, 5, 6, 7 ]",
			])
			expect(none).toEqual(all)
		})
	})
	// `start` and `complete` have effects the Optimiser can not see, so `purity.ts`
	// declares them impure and no pass may move them.
	describe("asynchrony", () => {
		const waiting = `implementation {
	function twice(_ value: Integer) -> Future<Integer> {
		constant held = complete Async.deferred(() { <- value })

		<- held::add(held)
	}

	Terminal.inspect(complete twice(21))
	Terminal.inspect(complete twice(21))
}`

		it("pools no start and no complete", () => {
			// Two identical `complete twice(21)` are two runs, not one value.
			let generated = generate(waiting)

			expect(generated).not.toMatch(/\$pool_\d+ = await/)
			expect(generated).not.toMatch(/\$pool_\d+ = \$future\./)
			expect(
				[...generated.matchAll(/await \$future\.complete\(/g)].length,
			).toBeGreaterThanOrEqual(3)
		})

		it("inlines no walk whose body waits", () => {
			// A body that waits belongs to its own Function, so the walk is not
			// inlined.
			let generated = generate(`implementation {
	function counted() -> Future<Integer> {
		constant seed = Async.deferred(() { <- 0 })
		constant answer = loop(
			from 1,
			through 3,
			startingWith seed,
			(index, total) -> Future<Integer> {
				constant held = complete total

				<- held::add(index)
			},
		)

		<- complete answer
	}

	Terminal.inspect(complete counted())
}`)

			expect(generated).toContain("loop__overload$3")
			expect(generated).not.toContain("$loop_0_index")
		})

		it("reads an Integer through a wait without losing its parentheses", () => {
			// Read through an `await`, the value needs parentheses: `(await …).value`.
			// An operand, since a `complete` bound to a name is read through the name.
			let generated = generate(`implementation {
	function twice(_ value: Integer) -> Future<Integer> {
		<- value::add(complete Async.deferred(() { <- value }))
	}

	Terminal.inspect(complete twice(21))
}`)

			expect(generated).toContain(
				"Integer.sum(value.value, (await $future.complete(",
			)
			expect(generated).toContain("), $ctx)).value)")
		})

		it("answers what a waiting Program answers, optimised and not", async () => {
			expect(await outputOf(generate(waiting))).toEqual(
				await outputOf(
					generate(waiting, {
						enabled: false,
						disabledPasses: new Set(),
					}),
				),
			)
			expect(await outputOf(generate(waiting))).toEqual(["42", "42"])
		})
	})
})
