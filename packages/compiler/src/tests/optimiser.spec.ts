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

// NOTE: The Optimiser's own gates: that the registry says what the command line
// and the documentation read off it, that the shared walk reaches every
// Expression a Program holds, that each pass emits what it says it emits, and —
// the contract that matters most — that a Program prints the same thing with a
// pass on as with it off.

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

// NOTE: What the Validator says about a source, which for a Program that
// compiles is Warnings — `unreachable-case` above all, which is the Diagnostic
// `prune-dead-match-arms` acts on. Asked here rather than assumed, so that the
// pass and the Warning can be held to each other.
function validatedDiagnostics(source: string): Array<common.Diagnostic> {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)

	return validate(enriched.program)
}

// NOTE: Every Match's Matchers, in the order the walk reaches the Matches and
// each chain is written — the shape of a Program's Matches, read off the Nodes
// rather than off the emission, so that what a pass does to a chain can be
// stated as what it does to a chain.
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

// NOTE: The Constants a Program declares at its top level, by name — what
// `eliminate-dead-code` either leaves standing or takes away.
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

// NOTE: The Options reach the Rewriter as well as the Optimiser — the standard
// library's own bodies are optimised inside the prelude the Rewriter builds, so
// a Program compiled with a pass off would otherwise import one compiled with it
// on.
function generate(
	source: string,
	options: OptimiserOptions = defaultOptimiserOptions,
): string {
	return rewrite(optimise(simplifiedSource(source), options), options)
}

// NOTE: The other half of every toggle: not what the two builds LOOK like but
// what they DO. The emitted module is written to a throwaway file and imported
// so its top-level `Terminal.inspect` calls run.
async function outputOf(javaScript: string): Promise<Array<string>> {
	let directory = mkdtempSync(join(tmpdir(), "essence-optimiser-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, javaScript)

	// NOTE: Both doors, into one buffer in writing order. `Terminal.inspect`
	// goes through `console.log` and `Terminal.print` through the stream, so a
	// harness holding only `console.log` would read a printing Program as
	// silent — and two silences compare equal, which is the one answer this
	// file must never accept.
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

// NOTE: One emitted top-level const, read out by the name it starts with — the
// standard library's Methods are `$es_<Namespace>_<member>` consts, and an
// Overload's mangled number is nobody's business here. It is what lets a
// question be asked of ONE prelude body rather than of the whole emission.
function bodyOf(generated: string, name: string): string {
	let start = generated.indexOf(`const ${name}`)

	expect(start).toBeGreaterThan(-1)

	let rest = generated.slice(start)
	let end = rest.indexOf("\nconst ")

	return end === -1 ? rest : rest.slice(0, end)
}

// NOTE: The pass contract, as one function: a Program compiled with the named
// pass turned off prints exactly what it prints with the pass on. Every pass
// registers a case of this, over a Program that exercises what it rewrites.
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

// NOTE: One Match per rule `compile-type-tests` decides by: a scalar Matcher, a
// Case Matcher, a List Matcher the scrutinee has one List member for, two List
// members sharing the one tag, a Record Matcher beside a String, and a Type
// Parameter standing where anything at all could arrive. The two List members
// and the Type Parameter are the ones that must NOT be compiled to a tag; the
// Record is compiled to one, because only one member of its Union can carry the
// Record tag and a value carrying it passes the Matcher whole.
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

// NOTE: One Match per rule `compile-record-members` decides by, over Records
// only their MEMBERS tell apart: two Records naming one member under two Types,
// two naming different members (so a read may find nothing), the same two beside
// a String (so the Record tag has to be asked first), a member that is a Type
// Parameter on both sides (which the runtime answers without looking), and a
// nested Record whose INNER member decides.
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

// NOTE: One of each thing `pool-constants` declares once — a literal written
// twice, a Rational, a payload-less Case, a Record Matcher's descriptor, a
// conformance witness the standard library answers for, and a witness for a
// Namespace this Program DECLARES, which is the one that must stay where it was
// written. The Boolean is here to be left alone.
//
// NOTE: The Match is written over TWO Record members, and the second Handler
// names a member only one of them declares whose Type is a Record — which is
// where `compile-record-members` declines, so a descriptor is still there to
// pool. A Record beside a String would not be: one claimant for the Record tag
// makes the whole Matcher a tag test.
//
// NOTE: The witness that gets pooled is the one `sort` is PASSED, rather than
// the one an interpolated hole reads: a hole's witness is consumed on the spot
// and `devirtualise-witnesses` takes it away before the pool sees it, which is
// the coordination between the two written as a Program.
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

// NOTE: A payload-less Case on either side of the comparison, both spellings of
// the question, a Case that DOES carry a payload, and a generic Choice of each
// — the shapes `lower-unit-case-equality` must rewrite beside the ones it must
// leave alone. `1::isLessThan(2)` is here because the Method it reaches is in
// the standard library, which the pass runs over as well.
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

// NOTE: Every operation `lower-scalar-operations` writes out, beside the ones
// it must refuse: a mixed-kind comparison and a mixed-kind sum, where the
// widening the covering Namespace decides is not a bigint operation; the
// three-Argument `is`, which is a different Method; and an `and` whose Argument
// PRINTS, which is the whole of what the eager-evaluation rule is for — `noisy`
// runs in a Program that is right and does not run in one that lowered it to
// `&&`.
//
// NOTE: The product of two PROVEN Integers is here as an operation of its own,
// because the Namespace name is the only thing telling it from the one above it:
// `NonZeroInteger.multiply` is Integer's own product re-exported, reached because
// both operands were proven not to be zero, and the evidence that reached it was
// spent long before this pass runs.
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

// NOTE: A shadowed Namespace standing where an `and` would skip it. `Integer`
// is a Program's own Namespace inside this block and `Boolean` is not, so the
// Invocation being LOWERED is not the one that is shadowed — the shadowed one
// is its Argument, which JavaScript's `&&` would not evaluate because the
// receiver is false. Whether `"the shadow ran"` is printed is the whole of the
// difference between the two Programs.
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
			§§ @param other — ignored
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

// NOTE: One dispatch of each shape `compile-union-dispatch` has to answer for:
// a Union two tags tell apart, one where two members share a tag and the
// descriptors stay, a call whose Arguments are compiled per branch (`map`), one
// whose branches need a conformance witness each (`sort`), a Union of a Record
// and a Boolean, an Argument that PRINTS, a receiver that is a call rather than
// a name, a bounded Type Parameter's catch-all branch, and a four member Union
// whose Methods are overload-mangled. Between them they cover every part of the
// dispatch the runtime used to be handed.
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
	§§ @param value — a member of the Union
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

// NOTE: The dispatch whose ANSWER depends on the order the operands are
// evaluated in: `flip` assigns the very variable the dispatch is reading, so a
// chain that read the receiver where the branch uses it — after the Argument —
// would call the other Namespace's Method and print `"flag!"`. The dispatch
// reads it before the Argument is evaluated, and so does the chain.
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

// NOTE: A witness of each kind a hole can be given — a standard library
// Namespace's, a Namespace this Program DECLARES, and a CONDITIONAL one, which
// is the one that must stay an object because the Function behind its Method is
// curried rather than named. The `sort` at the end is the other half of the
// division of labour: its witness is HANDED to it, so it is `pool-constants`'
// to build once.
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

// NOTE: Records, Lists, Cases with a payload and without, a payload that is a
// Record the Program is holding elsewhere, a member name JavaScript can not
// spell, and a Match reading it all back — the shapes `collapse-construction`
// rewrites, in one Program that prints what it built.
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

// NOTE: The witnesses a CONDITIONAL conformance is built from — `List` is
// Comparable where its Item is, so sorting a List of Lists curries a witness
// onto a witness, and sorting a List of Lists of Lists curries that onto
// another. Two things are asked of this Program: that the
// `boundConformance(…)` call is itself pooled, and — the one that decides
// whether it may be — that the two depths are told APART. They are spelled
// alike down to the last character apart from which witness is curried onto
// them, so a constant answering for both would sort the deeper Lists by the
// shallower one's comparison, which is a wrong ANSWER rather than a slower one.
const conditionalConformances = `implementation {
	Terminal.inspect([[3], [1, 2]]::sort())
	Terminal.inspect([[[2]], [[1]]]::sort())
	Terminal.inspect([1, 2]::compare(to [1, 2, 3])::toString())
}`

// NOTE: A Combination whose right-hand side is a literal, one whose right-hand
// side is a Record the Program is holding, one member overridden and both — the
// shapes `collapse-combinations` rewrites. A right-hand side may only be a
// Partial of what it updates, so there is no member here the left-hand side
// does not already have.
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

// NOTE: A Match in each position `lower-matches-to-statements` writes out,
// beside the ones it must leave alone. `radius` answers with `match @ ->`, whose
// value is `_self` already; `holding` answers with `match @.held ->`, which
// READS `_self` and may not bind it in the same Scope; `sized` answers before
// its last Statement, which is the one shape that needs a labelled break;
// `described` is a Declaration's initialiser and the `match` after it is written
// for its effects. The two prints at the end hold a Match mid-Expression,
// where there is nowhere to write a Statement and the wrapper stays.
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

// NOTE: A Match nested inside another's Handler, in the position whose answer is
// the OUTER Match's — so the inner Handlers answer the outer Declaration's name
// and break out of the outer Match's label, and the inner one declares none of
// its own.
const nestedStatementMatches = `implementation {
	§§ Names a value the long way round.
	§§
	§§ @param value — the value to name
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

// NOTE: A Handler binding the very name the lowered Match writes its answer to,
// in each shape a name can be bound in a Scope the answer is written from: a
// Constant, a Function, a Namespace, a Conditional branch inside a Handler, a
// Handler of a Match nested in Return position, and an assignment rather than a
// Declaration. Every one of them stood in front of the Declaration and took the
// assignment — silently, where the Declaration was a `variable`, and as a
// bundler's refusal to assign a `const` where it was not.
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
			§§ @param n — the Integer to answer for
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

// NOTE: A Match written for its effects whose Handler answers a call that only
// LOOKS like arithmetic — the `Integer` it is answered by is the Program's own,
// and it prints. Whether `"the shadow ran"` is printed is the whole of the
// difference between a Handler whose Return may be dropped and one whose may
// not.
const shadowedDiscardedAnswer = `implementation {
	§§ Runs a Match for its effects, and answers nothing much.
	§§
	§§ @returns — zero.
	function trick() -> Integer {
		§§ Not the standard library's.
		namespace Integer for Integer {
			§§ Nine, whatever it is given.
			§§
			§§ @param other — ignored
			§§ @returns — nine.
			add(_ other: Integer) -> Integer {
				Terminal.inspect("the shadow ran")

				<- 9
			}
		}

		constant scrutinee: Integer | String = 5

		match scrutinee -> Integer {
			case Integer { <- 1::add(2) }
			case String { <- 0 }
		}

		<- 0
	}

	Terminal.inspect(trick())
}`

// NOTE: The same shadow, standing where a Constant nobody reads is bound to it.
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
			§§ @param other — ignored
			§§ @returns — nine.
			add(_ other: Integer) -> Integer {
				Terminal.inspect("the shadow ran")

				<- 9
			}
		}

		constant unread = 1::add(2)

		<- 0
	}

	Terminal.inspect(trick())
}`

// NOTE: A compiled Union dispatch that HOLDS operands, in each Statement
// position the wrapper can be taken off in — a Return, a Declaration and a
// Statement written for its effects — beside `either::tagged(with flip())`,
// whose two held operands must stay in the order they were written.
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
	§§ @param value — a member of the Union
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

// NOTE: A Conditional whose question an earlier pass already asked in
// JavaScript's own terms, beside one whose question is a Boolean the Program
// computed — a Method a Namespace wrote, which answers an Essence Boolean and
// has to be read.
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

// NOTE: One Program per driver `inline-loops` knows, because each is a
// different walk and each is emitted from its own reading of the driver it
// replaces. The counted one first: up, down, and the Statement position that
// takes it without a closure.
const countedLoop = `implementation {
	constant sum = loop(from 1, through 10, startingWith 0, step (
		index,
		total,
	) { <- total::add(index) })

	constant down = loop(from 3, through 1, startingWith 0, step (
		index,
		total,
	) { <- total::add(index) })

	constant once = loop(from 2, through 2, startingWith 0, step (
		index,
		total,
	) { <- total::add(index) })

	Terminal.inspect(sum)
	Terminal.inspect(down)
	Terminal.inspect(once)
}`

// NOTE: The two condition-driven entries, which are one driver read two ways.
const conditionLoops = `implementation {
	constant doubled = loop(startingWith 1, while (n) {
		<- n::isLessThan(100)
	}, step (n) { <- n::multiply(with 2) })

	constant same = loop(startingWith 1, until (n) {
		<- n::isGreaterThanOrEqualTo(100)
	}, step (n) { <- n::multiply(with 2) })

	Terminal.inspect(doubled)
	Terminal.inspect(same)
}`

// NOTE: The general entry, whose body answers with a \`Step\` built at the
// answering position — which is what a body written for it looks like, and what
// this pass reads rather than allocates.
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

// NOTE: And the same entry answering with a \`Step\` the Compiler can NOT see
// built — held under a name first, which is every other way one can arrive.
const heldStep = `implementation {
	constant stopped = loop(startingWith 0, step (n) {
		constant answer: Step<Integer, Integer> = #Done(n)

		<- answer
	})

	Terminal.inspect(stopped)
}`

// NOTE: List's four walking Methods, and the one call that must stay a call:
// \`map\` given a Function-valued name rather than a literal.
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
	Terminal.inspect(items::keepEvery(where (item) {
		<- item::isGreaterThan(1)
	})::length())

	constant double = (_ item: Integer) -> Integer { <- item::multiply(with 2) }

	Terminal.inspect(items::map(double)::length())
}`

// NOTE: The same four walks over a receiver a Program has PROVEN something
// about, beside the twin written the ordinary way — the same three Integers, the
// same callbacks, the same answers. A refinement is erased before the first pass
// runs, so what both hold is one \`List\`; what differs is the Namespace the
// Simplifier named. \`NonEmptyList\` declares a \`map\` of its own, so a proven
// receiver's map is emitted under THAT name, while \`keepEvery\` and both
// \`reduce\` entries have no entry there and are reached by widening, so they
// arrive as \`List\`'s own and were never affected — which is why the gate is
// per-Method rather than per-Namespace.
//
// NOTE: The two transforms after them are what the gate must NOT open.
// \`reverse\` is \`List\`'s own native re-exported like \`map\` and is still not a
// walk this pass knows; \`prepend(contentsOf:)\` is not \`List\`'s Function at all
// but a wrapper calling \`append\` with the two Lists the other way round.
const provenWalks = `implementation {
	constant proven: NonEmptyList<Integer> = [1, 2, 3]
	constant written = [1, 2, 3]

	Terminal.inspect(proven::map((item) { <- item::multiply(with 2) })::length())
	Terminal.inspect(written::map((item) { <- item::multiply(with 2) })::length())

	Terminal.inspect(proven::keepEvery(where (item) {
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

// NOTE: The same claim for the second name, and the difference the second name
// makes: a Program declaring its own \`NonEmptyList\` takes THAT name and no
// other, so its proven walks are left alone and the ones written the ordinary
// way are inlined as they always were.
const shadowedNonEmptyList = `implementation {
	§§ Answers a doubled Integer, from a Namespace named after a builtin.
	§§
	§§ @returns — the doubled Integer.
	function trick() -> Integer {
		§§ Not the standard library's.
		namespace NonEmptyList for Integer {
			§§ The Integer, handed to the given transform.
			§§
			§§ @param transform — the transform to apply
			§§ @returns — whatever the transform answered.
			map(_ transform: (_: Integer) -> Integer) -> Integer {
				<- transform(@)
			}
		}

		<- 21::map((n) { <- n::multiply(with 2) })
	}

	constant proven: NonEmptyList<Integer> = [1, 2]

	Terminal.inspect(trick())
	Terminal.inspect(proven::map((item) { <- item::add(1) })::length())
	Terminal.inspect([1, 2]::map((item) { <- item::add(1) })::length())
}`

// NOTE: A Program that declares a Namespace named \`List\`, which stands in front
// of the builtin for the rest of its block — so a \`map\` written in it may be a
// Method the Program wrote, and every walk in the Program is left alone.
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

	Terminal.inspect(trick())
	Terminal.inspect([1, 2]::map((item) { <- item::add(1) })::length())
}`

// NOTE: A walk standing in an Argument, where there is nowhere to write a
// \`while\` and the arrow stays.
const argumentLoop = `implementation {
	Terminal.inspect(loop(startingWith 1, while (n) {
		<- n::isLessThan(10)
	}, step (n) { <- n::multiply(with 2) }))
}`

// NOTE: A walk inside a walk's body, which is what numbers the names apart.
const nestedLoops = `implementation {
	Terminal.inspect(loop(from 1, through 3, startingWith 0, step (index, total) {
		<- total::add(loop(from 1, through index, startingWith 0, step (
			inner,
			carried,
		) { <- carried::add(inner) }))
	}))
}`

// NOTE: THE Program a rename would answer wrongly. The predicate's Parameter is
// named after a Constant around the call, and the step's body reads THAT
// Constant — so the two must not meet, which they do not when each Parameter is
// bound in a Scope of its own.
const shadowedParameter = `implementation {
	constant total = 100

	constant answer = loop(startingWith 1, while (total) {
		<- total::isLessThan(10)
	}, step (n) { <- n::add(total) })

	Terminal.inspect(answer)

	constant items = [1, 2, 3]

	Terminal.inspect(items::keepEvery(where (items) {
		<- items::isGreaterThan(1)
	})::length())
	Terminal.inspect(items::map((total) { <- total::add(1) })::length())
}`

// NOTE: What the call evaluated, in the order it evaluated it — printed,
// because printing is the only way a Program can tell.
const orderedLoops = `implementation {
	Terminal.inspect(loop(from Terminal.inspect(1), through Terminal.inspect(3), startingWith Terminal.inspect(0),
	step (index, total) { <- total::add(index) }))

	Terminal.inspect(Terminal.inspect([1, 2])::reduce(startingWith Terminal.inspect(0), (total, item) {
		<- total::add(item)
	}))
}`

// NOTE: A List grown at BOTH ends and read every way there is, which is the one
// Program shape the runtime's two representations can be told apart by if
// anything can tell them apart. `prepend` gives a List a second run of items,
// `append` may hand its answer the very Array its receiver holds, and `both` is
// branched twice — so by the time it is printed, two other Lists have grown out
// of the Array it holds and it has to answer its own six items regardless.
//
// NOTE: The Match is here because a Type test WALKS: `List<Integer>` beside
// `List<String>` is the one Matcher pair `compile-type-tests` may not compile
// to a tag, so the check falls to `isValueOfType`, which asks every item — of a
// List carrying them in two runs.
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
	Terminal.inspect(more::keepEvery(where (item) { <- item::isGreaterThan(3) }))
	Terminal.inspect(more::reduce(startingWith 0, (total, item) { <- total::add(item) }))
	Terminal.inspect(front::is([1, 2, 3, 4]))

	Terminal.inspect(match tagged -> Integer {
		case List<String>  { <- 0 }
		case List<Integer> { <- @::length() }
	})
}`

// NOTE: The same List EDITED every way there is, which is the other shape the
// two representations could be told apart by. `slice`, `remove(at:)` and
// `replace(_:at:)` may each answer with a box over the runs their receiver
// holds, viewing less of them, and `insert(_:at:)` hands its ends to the two
// growers — so `both` has four other Lists living on its Arrays by the time it
// is printed, and `window`, which owns neither Array it reads, is grown at both
// ends itself. Every answer is bound BEFORE anything is printed, because
// printing combines a List's runs and a Program that printed as it went would
// only ever edit flat ones.
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

// NOTE: The shape `build-lists-in-place` is FOR: a counted walk whose State is a
// List and whose body only ever appends to it. Both `append` entries are here
// and so is a chain of them, because a turn may add more than one thing, and the
// second link of a chain resolves on `NonEmptyList` rather than on `List` — the
// first `append` proved the receiver is not empty.
const builtList = `implementation {
	constant built = loop(from 1, through 4, startingWith [0], step (index, list) {
		<- list::append(index)
	})

	constant batched = loop(from 1, through 3, startingWith [0], step (index, list) {
		<- list::append(index)::append(contentsOf [index, index])
	})

	§ The other half of the addition: a List under a name, which nothing may
	§ take the Array of, so its items are walked out of the box it is held in.
	constant tail = [7, 8]
	constant joined = loop(from 1, through 2, startingWith [0], step (index, list) {
		<- list::append(contentsOf tail)
	})

	Terminal.inspect(built)
	Terminal.inspect(batched)
	Terminal.inspect(joined)
}`

// NOTE: The other three walks that thread a State, each writing its accumulator
// a different way: a fold's plain entry, a fold that leaves early through
// `#Done`, and the general `Step` walk — which is driven by a `variable` here
// because a walk that read its own accumulator to decide when to stop would be
// declined by the fence.
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

// NOTE: A branch that changes nothing answers the accumulator BARE, which is the
// rebuilding chain with no appends on it — and a `#Done` that answers something
// else entirely leaves with that value while the Array the walk built goes
// nowhere.
const builtBranches = `implementation {
	constant sparse = loop(from 1, through 6, startingWith [0], step (index, list) {
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

// NOTE: The two walks the elisions meet on. `paced` is a `while` walk that
// qualifies — its predicate decides by a `variable` around the call rather than
// by the accumulator — which is the one walk whose State Parameter is elided in
// TWO callbacks. `doubled` takes both elisions at once: its body only ever reads
// what the counter holds, so the counter's Integer is never built, and its
// accumulator is a List built in place, so the State's `const` is never bound.
const builtBesideElisions = `implementation {
	variable turns = 0
	constant paced = loop(startingWith [0], while (list) {
		<- turns::isLessThan(3)
	}, step (list) {
		turns = turns::add(1)

		<- list::append(turns)
	})

	constant doubled = loop(from 1, through 4, startingWith [0], step (
		index,
		list,
	) {
		<- list::append(index::add(1))
	})

	Terminal.inspect(paced)
	Terminal.inspect(doubled)
}`

// NOTE: THE counter-example the fence is drawn for. The old `current` survives
// inside `snapshots`, so pushing onto its Array would rewrite history the
// Program already recorded — and what says so is visible in the body: `current`
// is read twice, once as the receiver being replaced and once as a value handed
// somewhere else.
const retainedAccumulator = `implementation {
	constant history: List<List<Integer>> = []
	constant walked = loop(from 1, through 3, startingWith {
		current = [0],
		snapshots = history,
	}, step (index, state) {
		<- {
			current = state.current::append(index),
			snapshots = state.snapshots::append(state.current),
		}
	})

	Terminal.inspect(walked.current)
	Terminal.inspect(walked.snapshots)
}`

// NOTE: One Program per way of mentioning the accumulator that is not a
// rebuilding chain: a read as innocent as `length`, a name a closure captured, a
// nested walk over it, the accumulator added to ITSELF, and a `prepend`, which
// grows the end a build does not push onto. Every one of them keeps the walk it
// was written in, and the answers are what the copying emission answers.
const declinedAccumulators = `implementation {
	constant read = loop(from 1, through 3, startingWith [0], step (index, list) {
		<- list::append(list::length())
	})

	constant captured = loop(from 1, through 3, startingWith [0], step (
		index,
		list,
	) {
		constant seen = [1]::map((item) { <- list::length() })

		<- list::append(seen::length())
	})

	constant walked = loop(from 1, through 3, startingWith [0], step (
		index,
		list,
	) {
		<- list::append(list::reduce(startingWith 0, (total, item) {
			<- total::add(item)
		}))
	})

	constant doubled = loop(from 1, through 3, startingWith [0], step (
		index,
		list,
	) {
		<- list::append(contentsOf list)
	})

	constant fronted = loop(from 1, through 3, startingWith [0], step (
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

// NOTE: THE seed rule, both halves. A seed the Program was holding before the
// walk is COPIED at entry, so appending to it afterwards must answer the seed's
// own items and the walk's answer must not have grown one — and a walk of no
// turns at all must answer exactly what it was seeded with. The fold over the
// empty List is the only walk here that runs no turns: the counted entry always
// runs at least one, in whichever direction its bounds point.
const seededBuilds = `implementation {
	constant seed = [1, 2]
	constant grown = loop(from 3, through 5, startingWith seed, step (
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

// NOTE: One of everything `fold-constants` works out, beside the operands it
// must refuse: an Argument that PRINTS, which is the whole of what folding
// through a call would cost, and a mixed-kind sum, which reaches a Method whose
// body is not the one being reproduced. The Rationals are the ones that matter
// most — `1/2 + 1/4` must fold to what the Essence body STORES and not to the
// lowest-terms value it is worth.
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

// NOTE: A Program that declares a Namespace named after a builtin, whose `add`
// answers something no arithmetic would — the shape that decides whether the
// enumeration a fold rests on may be read by NAME.
const shadowedArithmetic = `implementation {
	§§ Answers what a Namespace the Program wrote answers.
	§§
	§§ @returns — nine, loudly.
	function trick() -> Integer {
		§§ Not the standard library's.
		namespace Integer for Integer {
			§§ Nine, whatever it is given.
			§§
			§§ @param other — ignored
			§§ @returns — nine.
			add(_ other: Integer) -> Integer {
				Terminal.inspect("the shadow ran")

				<- 9
			}
		}

		<- 1::add(2)
	}

	Terminal.inspect(trick())
}`

// NOTE: A Handler of each shape `prune-dead-match-arms` decides by. Two that
// can never run — a scalar Matcher naming a Type the Union does not have, and
// one naming a Type that is not a member of the Choice being matched — beside
// the ones that must stay: two List members sharing the one runtime tag, where
// the items are what tell them apart, and a Record Matcher beside a Record
// scrutinee, where the members are.
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

// NOTE: A Constant of each kind `eliminate-dead-code` decides by, at a
// Program's top level and inside a Function: one nothing reads, one read only
// from inside a Function, one whose value PRINTS, and a `variable` — which is
// refused whatever is done with it, because an assignment is a Statement this
// pass does not read.
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

// NOTE: The Node kinds `typedSimple.ExpressionNode` is made of, minus
// `Identifier`. The two Identifier positions the walk leaves alone — the
// Namespace a Method Invocation answers on and the member a Lookup reads —
// hold nothing else and are nothing the Program computes, so counting
// Identifiers here would be counting the difference between two deliberate
// answers.
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
])

// NOTE: Every Expression the Program holds, found by reading the tree as plain
// data rather than by asking the walk — which is the whole point: a position
// the walk forgot to descend into is a position only an INDEPENDENT reading can
// name. Gathered by object identity, because the same Node kind occurs
// thousands of times and only identity says whether THIS one was reached.
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
			// NOTE: A Namespace Method's Function literal is not a value the
			// Program evaluates — the Rewriter emits it as a class member — so
			// the walk offers the body inside it and not the literal itself.
			// `isStatic` is the Method wrapper's own field and nothing else's.
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

// NOTE: The four fields a Statement POSITION can stand in — a Program's own
// nodes, a Function or Handler body, and a Conditional's two. Read as plain data
// like the Expressions above, and for the same reason: a position the walk
// forgot is one only an independent reading can name.
const statementFields = new Set(["nodes", "body", "trueBody", "falseBody"])

// NOTE: The ARRAYS themselves rather than what is in them — every run of
// Statements a body hook has to be offered, gathered by identity from the same
// independent reading.
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

	// NOTE: The one transform the stage performs that is NOT a pass. Erasing
	// checked refinements is what makes a Program emittable rather than better,
	// so it has no name to be turned off under and runs whether the phase is on
	// or off — `--no-optimise` compiles the Program as it was written, and a
	// Program as it was written still has no run-time notion of a predicate.
	//
	// NOTE: There is no syntax for a refinement yet, so one is written into a
	// simplified Program by hand — which is also how the Rewriter's refusal below
	// can be asked at all, since every route through the stage takes it away
	// first.
	describe("erasing checked refinements", () => {
		const integer: common.Type = { type: "Integer" }

		const nonZeroInteger: common.Type = {
			type: "Refinement",
			name: "NonZeroInteger",
			base: integer,
			conjuncts: [
				{
					namespaceName: "Integer",
					methodName: "isNot",
					overloadIndex: null,
					args: ["0"],
				},
			],
		}

		// NOTE: A Match over a bare Integer, whose one Handler's Matcher is then
		// refined — the Matcher is the field the Rewriter serializes, so it is
		// the field both halves of this turn on.
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

		// NOTE: Asked of the whole Program rather than of the Matcher, because
		// with the phase on the Match is lowered to Statements and compiled to a
		// tag test on its way through — so what is asserted is that nothing
		// anywhere in what comes out is a refinement, which is the claim.
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

		// NOTE: The second half of the claim, and the reason the first can be
		// trusted: a refinement that DID reach emission fails the compile by
		// name instead of emitting a descriptor `isValueOfType` has no answer to.
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

	// NOTE: The prelude is the standard library's own bodies, optimised once per
	// process and shared by every file compiled in it. It is the one cache the
	// Options have to reach: built under one set and handed to a compilation
	// under another, it would put passes into a Program that asked for them to
	// be left out — and in a test suite, where one process compiles under
	// several, that is not a corner case.
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

	// NOTE: `Everyday.es` and `Match.es` between them hold every Expression
	// shape a Program can carry — Records, Lists, Cases, Combinations, Matches
	// with guards and literal Matchers, interpolation, Namespaces with static
	// Properties, conformance witnesses and a Union-typed receiver.
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
				// NOTE: Once, not merely at least once — a position walked twice
				// would let a pass rewrite its own output, which is the one
				// thing a bottom-up walk promises not to do.
				expect(offered.length).toBe(new Set(offered).size)
				expect(new Set(offered)).toEqual(expected)
				// NOTE: A walk that changed nothing hands back what it was
				// given, whole. Passes are pure functions of their input, and
				// the standard library's Programs are optimised once and read
				// many times.
				expect(walked).toBe(program)
			})
		}

		it("leaves the Program it was given untouched", () => {
			// NOTE: A value no fixture writes, so counting it counts the
			// rewrite and nothing else.
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
			// NOTE: A pass that wrote into its input would corrupt the standard
			// library for every later compilation in the process.
			expect(markers(program)).toBe(0)
		})

		// NOTE: The Statement hook, held to the same three promises the
		// Expression one is: every position, exactly once, and the Program
		// handed back as itself where nothing changed.
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

		// NOTE: The body hook, held to the same three promises: every run of
		// Statements, exactly once, and the Program handed back as itself where
		// nothing changed. It is the one hook that may answer with a different
		// NUMBER of Statements, so a body it never reaches is a body
		// `eliminate-dead-code` can not read.
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

				// NOTE: A Program's own nodes are one body and everything else
				// is a Function, a Handler or a Conditional — Everyday.es is
				// flat and has two, where Match.es has seventeen. What carries
				// the weight is the set below.
				expect(offered.length).toBeGreaterThan(1)
				expect(offered.length).toBe(new Set(offered).size)
				expect(new Set(offered)).toEqual(everyBodyIn(program))
				expect(walked).toBe(program)
			})
		}

		it("offers a Statement after the Expressions below it", () => {
			// NOTE: An Expression written for its effects is BOTH, and the order
			// is what lets a pass reading Statements read what the Expression
			// hook left — `lower-matches-to-statements` reads a compiled
			// dispatch, which `compile-union-dispatch` writes as an Expression.
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

			// NOTE: The callee is walked too — `Terminal.inspect` is a Lookup
			// off an Identifier — because a static Method call is an ordinary
			// `FunctionInvocation` whose name is an Expression like any other.
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
			// NOTE: The whole Choice, gone from the emission — a Case Matcher
			// is the tag it names and nothing else here.
			expect(generated).not.toContain('choice: "Shape"')
		})

		it("compiles a scalar Matcher to its tag", () => {
			// NOTE: A scalar's descriptor check IS one key comparison, whatever
			// it is asked about, so this one needs no argument about what can
			// arrive.
			expect(generate(typeTests)).toContain(
				'_self[$type.typeKeySymbol] === "Integer"',
			)
		})

		it("stops walking a List to find out that it is one", () => {
			// NOTE: The change of complexity. `{ type: "List", itemType: {
			// type: "Integer" } }` means "a List, every item of which is an
			// Integer", so the runtime check walked every item; the scrutinee
			// has one List member, so the tag says which member arrived and
			// the items say nothing further.
			expect(generate(typeTests)).toContain(
				'_self[$type.typeKeySymbol] === "List"',
			)
		})

		it("keeps the full check where two Types share a tag", () => {
			// NOTE: `List<Integer>` and `List<String>` are both `"List"`, and
			// what tells them apart is the items — which is exactly what the
			// full check walks.
			expect(generate(typeTests)).toContain(
				'itemType: { type: "String" }',
			)
		})

		it("compiles a Record Matcher to its tag where one Record can arrive", () => {
			// NOTE: A Record's tag says only that it is a Record, so this needs
			// the argument about what can arrive that a scalar does not: ONE
			// member of `{ x: Integer, y: Integer } | String` carries the Record
			// tag and it implies the Matcher, so a value carrying that tag
			// passes the whole check and a value carrying another fails it
			// before a member is read.
			let generated = generate(typeTests)

			expect(generated).toContain('=== "Record"')
			expect(generated).not.toContain('x: { type: "Integer" }')
		})

		it("keeps the full check where two Records can arrive", () => {
			// NOTE: Both members claim the one tag, so the tag says nothing —
			// what tells them apart is their members, which is
			// `compile-record-members`' business and is turned off here so that
			// what THIS pass leaves can be read.
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
			// NOTE: `List<Integer> | Item` — a value of `Item` can be anything
			// at all, including a List, so the tag does not say which member
			// arrived and the item walk is what decides.
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

		// NOTE: The standard library's Matches go through the pass as well,
		// inside the prelude the Rewriter builds — `Optional` is a Choice, so
		// every fallible answer in the library is read back by one of these.
		it("compiles the standard library's own Matches", () => {
			let generated = generate(`implementation {
				Terminal.inspect(Integer.parse("7")::value(withDefault 0))
			}`)

			expect(generated).toContain(
				'_self[$type.typeKeySymbol] === "Optional#Value"',
			)
			expect(generated).not.toContain('choice: "Optional"')
		})

		// NOTE: The fixture that is nothing but Matches — every Matcher kind
		// the language has, including the Record ones this pass leaves alone.
		it("leaves no Case descriptor in a compiled Match.es", () => {
			let generated = generate(
				readFileSync(fixturePath("Match.es"), "utf8"),
			)

			expect(generated).not.toContain('type: "Case"')
			expect(generated).toContain(
				'_self[$type.typeKeySymbol] === "Optional#Value"',
			)
		})

		// NOTE: A Case Matcher's payload Pattern requires something of a member,
		// and that requirement is a Type check like the Matcher's own — so it
		// goes through this pass too. Left out, it was the one check still
		// asking the runtime the general question with a descriptor rebuilt at
		// every test.
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
				// NOTE: The requirement reads the MEMBER, not `_self`, and the
				// descriptor it is asked against is a pooled Constant rather
				// than an object literal rebuilt on every turn.
				// `compile-record-members` is off, because it takes the
				// descriptor away for this requirement altogether — the test
				// below is where that is pinned.
				expect(
					generate(payloadPattern, {
						enabled: true,
						disabledPasses: new Set(["compile-record-members"]),
					}),
				).toMatch(/isValueOfType\(_self\.payload, \$pool_\d+\)/)
			})

			it("hands the requirement on to the decision tree", () => {
				// NOTE: A requirement that is a Record Matcher goes through the
				// same rules the Matcher's own check does, one level further
				// down: the payload is `Click | KeyPress`, only `KeyPress`
				// declares `key`, and a member one arriving Record does not
				// declare is read through `?.` — which answers the `hasOwn` the
				// walk asked first and the tag comparison after it at once.
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
			// NOTE: `!==`, not a negation of the answer — `isNot` costs what
			// `is` costs.
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
			// NOTE: `#Red::is(red)` asks the same question of the same two
			// values, and the Case that is dropped holds no Expression to
			// evaluate — so there is no work and no order to preserve.
			expect(generate(unitCaseEquality)).toContain(
				'red[$type.typeKeySymbol] === "Colour#Red"',
			)
		})

		it("leaves a Case carrying a payload to the runtime", () => {
			// NOTE: The tag does not decide this one — two Circles differ by
			// their radius — so the comparison stays the call it was.
			expect(generate(unitCaseEquality)).toContain(
				"$helpers.choiceIs(circle,",
			)
		})

		it("lowers a generic Choice's payload-less Case", () => {
			// NOTE: A generic Choice compares through a descriptor, which names
			// the payload members each tag carries. `#Void` carries none, so the
			// descriptor would have read the tags and stopped.
			let generated = generate(unitCaseEquality)

			expect(generated).toContain(
				'_void[$type.typeKeySymbol] === "Box#Void"',
			)
			expect(generated).toContain(
				'held[$type.typeKeySymbol] === "Box#Void"',
			)
			// NOTE: The one descriptor left is the payload comparison below —
			// the only one of the three that needs it, and the only one carrying
			// the witness that is the whole reason a payload can not be answered
			// by a tag.
			expect(generated.split("boundChoiceIs").length - 1).toBe(1)
		})

		it("leaves a generic Choice's payload-carrying Case to its descriptor", () => {
			// NOTE: `#Holding` holds an `Item`, which compares through the
			// witness the caller passed rather than structurally — the one thing
			// a tag can not answer.
			expect(generate(unitCaseEquality)).toContain(
				"$helpers.boundChoiceIs(",
			)
		})

		it("leaves an equality a Namespace writes alone", () => {
			// NOTE: Only equality a Choice DERIVES is a question about tags. A
			// written `is` is a Method, and is called.
			let generated = generate(`implementation {
				choice Colour { Red, Green }

				namespace Colour for Colour is Equatable {
					§§ Every Colour is every other Colour.
					§§
					§§ @param other — the Colour to compare with
					§§ @returns — always true.
					is(_ other: Colour) -> Boolean {
						<- true
					}

					§§ The negation.
					§§
					§§ @param other — the Colour to compare with
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

		// NOTE: The lever this pass was written for. `isLessThan` is
		// `@::compare(to other)::is(#Less)` and the other three inequalities are
		// written on it, so every comparison in every Program ends in this
		// shape — inside the standard library, which is optimised with the
		// Program that reaches it.
		// NOTE: Asked with `lower-scalar-operations` off, because that pass
		// takes the same body further — a comparison of two Integers becomes
		// one bigint comparison and the body stops being emitted at all. What
		// is being asked here is what THIS pass does to it, so the pass that
		// runs after it is turned off; the two together are covered where that
		// one is.
		// NOTE: And `fold-constants` with it, for the same reason once removed —
		// `1::isLessThan(2)` is two literals, so the answer is written out and
		// the body is not reached at all.
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
			// NOTE: And with the pool off as well, so the Case the helper is
			// handed is written where it is passed rather than read out of the
			// band — which is not what this asks about. The scalar lowering is
			// off for the same reason it is off above: it would take the
			// standard library's comparison out of the emission entirely, and
			// so would folding the two literals it is asked about.
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
			// NOTE: `isLessThanOrEqualTo` is `@::isGreaterThan(other)::negate()`
			// — so what a `!` would have stood in front of is a comparison with
			// an opposite to ask, and bigints are totally ordered, with no value
			// unequal to itself the way a floating-point NaN is.
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
			// NOTE: `subtract` is `@::add(other::negate())`, which was two
			// allocations and two calls.
			let generated = generate(scalarOperations)

			expect(generated).toContain("value: a.value + b.value")
			expect(generated).toContain("value: a.value - b.value")
			expect(generated).toContain("value: a.value * b.value")
			expect(generated).not.toContain("Integer.add__overload$1(a,")
		})

		// NOTE: The refinement erases before the first pass runs, so the operands
		// this reads are Integers holding bigints — but the Method the Simplifier
		// emitted is still the refined Namespace's, and a Namespace name is all
		// this pass has to go by. `NonZeroInteger` answers `multiply` by
		// re-exporting Integer's own product, so the two are one operation and are
		// written out as one.
		it("multiplies two proven Integers with the same operator", () => {
			let generated = generate(scalarOperations)

			expect(generated).toContain(
				"value: proven.value * alsoProven.value",
			)
			expect(generated).not.toContain("NonZeroInteger.multiply")
		})

		it("compares two Strings through the runtime's own comparison", () => {
			// NOTE: NOT `===`. Two Strings are equal when their characters are,
			// and the same accent written as one code point and as two is one
			// String — so the normalising comparison decides it, in the one
			// place that has always performed it.
			let generated = generate(scalarOperations)

			expect(generated).toContain("$helpers.stringEquals(text, other)")
			expect(generated).toContain("!$helpers.stringEquals(text, other)")
		})

		it("leaves the String comparison that takes a Case alone", () => {
			// NOTE: `is(_ other, comparing sensitivity)` is a different Method,
			// and what it means is whatever the case-insensitive `compare`
			// means.
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

		// NOTE: THE invariant. `a::and(b)` evaluates `b` and then calls; `a &&
		// b` does not evaluate `b` when `a` is false. Here `b` PRINTS, so the
		// two are different Programs — and the printed output below is what
		// says which one was emitted.
		it("keeps the call where the Argument can be observed", () => {
			expect(generate(scalarOperations)).toContain(
				"Boolean.and(no, noisy())",
			)
		})

		it("leaves a mixed-kind operation to the Namespace that widens it", () => {
			// NOTE: An Integer beside a Rational compares by cross-multiplying
			// and adds by widening — neither is a bigint operation.
			let generated = generate(scalarOperations)

			expect(generated).toContain("$es_Integer_isLessThan__overload$2(a,")
			expect(generated).toContain("$es_Integer_add__overload$2(a,")
		})

		it("leaves a Namespace the Program declares of its own alone", () => {
			// NOTE: `Integer` is free inside a block, and a Namespace declared
			// there REPLACES the builtin for the rest of it — so `isLessThan`
			// here is a Method somebody wrote, and it answers what it was
			// written to answer.
			let generated = generate(`implementation {
				§§ Answers the same thing however it is asked.
				§§
				§§ @returns — true.
				function trick() -> Boolean {
					§§ A liar.
					namespace Integer for Integer {
						§§ Always true.
						§§
						§§ @param other — ignored
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
			// NOTE: The refusal above is about the Invocation being LOWERED, and
			// says nothing about whether that Invocation may be SKIPPED. Here
			// the shadowed Method stands as the Argument of an `and`, whose
			// receiver decides the answer without it — so lowering the `and`
			// puts a Method somebody wrote behind JavaScript's `&&`, and the
			// print inside it stops happening. `Boolean` is not shadowed and
			// `Integer` is, which is exactly the shape a per-Invocation check
			// misses.
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
			// NOTE: `isLessThan` reads as one of the Methods the purity
			// enumeration names, and the entry it names is the one written on
			// the bigint comparison. GIVEN A RATIONAL it is a different entry,
			// written on the covering `Number` Namespace — an Overload that
			// shares the name and not the body — so the enumeration does not
			// answer for it and the `and` stays a call.
			let generated = generate(`implementation {
				constant a = 3

				Terminal.inspect(false::and(a::isLessThan(1/2)))
			}`)

			expect(generated).toContain("Boolean.and(")
			expect(generated).not.toContain(".value && ")
		})

		// NOTE: The standard library is optimised with the Program that reaches
		// it, and its own bodies are written on the Methods this pass lowers:
		// the counted loop driver asks `start::isLessThanOrEqualTo(end)` to
		// decide which way it counts, and `isEven` asks `rest::is(0)`.
		//
		// NOTE: The step callback is a VALUE rather than a literal, which is
		// what keeps the driver in the emission at all — `inline-loops` writes
		// the walk out where every callback is written at the call, and the
		// driver whose body this reads is then reached by nobody. Bound to a
		// name it is reached, and this pass lowers it exactly as before.
		it("lowers the standard library's own bodies", () => {
			let generated = generate(`implementation {
				constant advance = (_ index: Integer, _ total: Integer)
					-> Integer { <- total::add(index) }

				Terminal.inspect(loop(from 1, through 3, startingWith 0, step advance))
				Terminal.inspect(4::isEven())
			}`)

			expect(generated).toContain("start.value <= end.value")
			// NOTE: `index` rather than `current.index` because the driver's
			// `while` predicate takes its State apart with a Pattern — the
			// binding is what the lowered comparison reads.
			expect(generated).toContain("index.value <= end.value")
			expect(bodyOf(generated, "$es_Integer_isEven")).toContain(
				".value === ",
			)
		})

		// NOTE: What lowering the standard library's comparison family COSTS a
		// Program: the bodies stop being reached, so they stop being emitted.
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
					// NOTE: And `fold-constants` off with it, because two literals
					// compared are an answer it writes out — which takes the body
					// out of the emission for a reason that is not this pass's.
					disabledPasses: new Set([
						"lower-scalar-operations",
						"fold-constants",
					]),
				}),
			).toContain("$es_Integer_isLessThanOrEqualTo__overload$1")
		})

		it("reads the operands the passes after it rewrote", () => {
			// NOTE: The walk descends into a lowered operation like anything
			// else, so `pool-constants` — which runs last — finds the literal
			// standing in one and hoists it.
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
				"NonZeroInteger.multiply(proven, alsoProven)",
			)
			expect(generated).toContain("Boolean.negate(yes)")
			expect(generated).toContain(
				"$es_String_is__overload$1(text, other)",
			)
			expect(generated).not.toContain("stringEquals")
		})

		it("prints the same thing with the pass off", async () => {
			// NOTE: `"evaluated"` is in there once, in the middle, which is the
			// eager-evaluation invariant stated as an output: an `and` lowered
			// to `&&` over a printing Argument would print it zero times.
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
				// NOTE: The proven product, which is the same fifteen — the two
				// Namespaces multiply the same two bigints and one of them was
				// entitled to say the answer is not zero.
				"15",
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
				'value[$type.typeKeySymbol] === "Integer" ? Integer.toString(value) : $es_Boolean_toString(value)',
			)
			expect(generated).not.toContain("$type.dispatchMethod")
		})

		it("leaves no dispatch search in a dispatch-heavy Program", () => {
			// NOTE: The array per call, the tuple per case and the copy of the
			// Argument list go with it — they were the search's Arguments and
			// nothing else's.
			expect(generate(unionDispatch)).not.toContain("dispatchMethod")
			expect(
				generate(unionDispatch, {
					enabled: true,
					disabledPasses: new Set(["compile-union-dispatch"]),
				}),
			).toContain("$type.dispatchMethod(")
		})

		it("takes the last case as the else, and the throw with it", () => {
			// NOTE: Two members, one test — the Enricher gave every member of
			// the Union a case, so a value that declined the first has nowhere
			// else to go, and there is nothing left for a fall-through to
			// answer for.
			let generated = generate(`implementation {
				constant value: Integer | Boolean = 5

				Terminal.inspect(value::toString())
			}`)

			expect(generated).toContain(
				'value[$type.typeKeySymbol] === "Integer" ? Integer.toString(value) : $es_Boolean_toString(value)',
			)
			expect(generated).not.toContain('=== "Boolean"')
			expect(generated).not.toContain("noDispatchCaseMatched")
		})

		it("takes a Record case as the else where one member claims the tag", () => {
			// NOTE: What the Record residual unlocked here: one member of the
			// receiver's Union carries the Record tag and satisfies the case, so
			// the last case's check IS the Integer comparison in front of it and
			// there is nothing for a fall-through to answer for.
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
			// NOTE: The other side of the same rule. Two Records claim the tag,
			// so what tells them apart is a member test — which is exactly where
			// a runtime answer and a static Type can part company — and the
			// throw that would name it stays, whether the test is the walk or
			// the tree `compile-record-members` writes over it.
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
			// NOTE: `List<Integer>` and `List<String>` are both `"List"`, so the
			// tag says nothing about which case is meant and the item walk is
			// what decides — the same rule a Match Handler is decided by, asked
			// of the same residual.
			let generated = generate(unionDispatch)

			expect(generated).toMatch(/isValueOfType\(items, \$pool_\d+\)/)
			expect(generated).toMatch(/const \$pool_\d+ = \{\n\ttype: "List"/)
		})

		it("writes one call where every case answers with the same Method", () => {
			// NOTE: `List<Integer>` and `List<String>` both resolve `length` to
			// `List.length`, so the two checks in front of the two identical
			// calls decide nothing — and the descriptor walk each of them costs
			// goes with them, along with the throw the chain ended in.
			let generated = generate(`implementation {
				constant mixed: List<Integer> | List<String> = [1, 2]

				Terminal.inspect(mixed::length())
			}`)

			expect(generated).toContain("List.length(mixed)")
			expect(generated).not.toContain("isValueOfType")
			expect(generated).not.toContain("noDispatchCaseMatched")
		})

		it("keeps the tests where one case answers with another Method", () => {
			// NOTE: The rule is that the branches are the SAME call, not that
			// they share a receiver — two Methods behind two checks is what the
			// checks are for.
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
			// NOTE: The counterpart to a Match's fall-through, and the same
			// trade: a check that could not be reduced to a tag is one where a
			// runtime answer and a static Type can part company, so the throw
			// that names it stays.
			expect(generate(unionDispatch)).toContain(
				"$type.noDispatchCaseMatched()",
			)
		})

		it("builds a branch's own Arguments only in that branch", () => {
			// NOTE: The Function literal `map` is given is compiled once per
			// branch, because what `item` means comes from the branch. The
			// dispatch built the shared one AND both copies at every call and
			// used one; the chain builds the one the branch it takes needs.
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
			// NOTE: `sort` is bounded by `Comparable`, so each branch carries the
			// witness for ITS item Type — two witnesses, one per branch, each
			// built once by the pool rather than per call by the dispatch.
			expect(generate(unionDispatch)).toMatch(
				/List\.sort__overload\$1\(items, \$pool_\d+\).*List\.sort__overload\$1\(items, \$pool_\d+\)/,
			)
		})

		it("writes a name and a literal where the branches use them", () => {
			// NOTE: Nothing is held here: the receiver is a name and the
			// Argument a literal, so each branch reads what the call would have
			// read and there is no wrapper at all.
			let generated = generate(unionDispatch)

			expect(generated).toMatch(
				/\? Boxes\.tagged\(either, \$pool_\d+\) : Flags\.tagged\(either, \$pool_\d+\)/,
			)
		})

		it("holds an operand that can not be read again", () => {
			// NOTE: A receiver that is a CALL is evaluated once, before any
			// test, and read from a name after that — the chain reads it three
			// times over, and calling `identity` three times is not what the
			// Program says.
			expect(generate(unionDispatch)).toContain(
				'($dispatch_0 => $dispatch_0[$type.typeKeySymbol] === "Integer" ? Integer.toString($dispatch_0) : $es_Boolean_toString($dispatch_0))(identity(',
			)
		})

		it("holds the receiver where an Argument could change it", async () => {
			// NOTE: THE order invariant. `flip` assigns `either`, and the
			// dispatch read the receiver BEFORE evaluating the Argument — so a
			// chain that left the receiver where the branches use it would
			// answer for the value after the assignment. Both are held, in the
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
			// NOTE: One `"evaluated"`, wherever the chain goes — the Argument is
			// evaluated before any test, as the dispatch's Argument array was
			// built before any case was tried, and no branch evaluates it again.
			let output = await outputOf(generate(unionDispatch))

			expect(
				output.filter((line) => line === '"evaluated"'),
			).toHaveLength(1)
		})

		it("keeps the cases in the order the Enricher put them", () => {
			// NOTE: A four member Union, tested in declaration order with the
			// last case's test elided — and the overload-mangled name each
			// member resolved to carried through per branch.
			expect(generate(unionDispatch)).toContain(
				'number[$type.typeKeySymbol] === "Integer" ? Integer.multiply__overload$1(number, $pool_',
			)
			expect(generate(unionDispatch)).toMatch(
				/=== "Rational" \? \$es_Rational_multiply__overload\$2.*=== "Algebraic" \? Algebraic\.multiply__overload\$1.*: Transcendental\.multiply__overload\$1/,
			)
		})

		it("puts a catch-all branch last and asks nothing of it", () => {
			// NOTE: A bounded Type Parameter accepts every value there is, so
			// its case can only be tried once everything else has declined —
			// and once it is reached there is nothing left to ask.
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
			// NOTE: Neither pass depends on the other having run: this one asks
			// `residual.ts` itself rather than reading what `compile-type-tests`
			// left behind, so a dispatch is compiled the same either way.
			expect(
				generate(unionDispatch, {
					enabled: true,
					disabledPasses: new Set(["compile-type-tests"]),
				}),
			).toContain('value[$type.typeKeySymbol] === "Integer"')
		})

		it("compiles the chain with the pool turned off", () => {
			// NOTE: With nothing pooled, the descriptor a case still checks
			// against is written at the test, exactly as the search's own tuple
			// carried it.
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

			expect(generated).toContain("Integer.toString(count).value")
			expect(generated).not.toMatch(/\$pool_\d+\.toString\(count\)/)
		})

		it("builds no witness for a hole at all", () => {
			// NOTE: This Program interpolates and passes no witness anywhere,
			// so the map it used to build is nowhere — pooled or not.
			expect(
				generate(`implementation {
					constant count = 3

					Terminal.inspect("{count}")
				}`),
			).not.toContain("toString: Integer.toString")
		})

		it("reaches a Method a Namespace of the Program's own writes", () => {
			// NOTE: Through the same reference every other emission site uses,
			// so a Namespace the Program declares is named as it is named
			// everywhere else. Nothing MOVES: the call stands where the witness
			// stood, so a class that is not hoisted is no more of a problem
			// than it was — which is why this can be taken where
			// `pool-constants` refuses the same witness.
			expect(generate(witnesses)).toContain("Boxes.toString(box).value")
			expect(
				generate(witnesses, {
					enabled: true,
					disabledPasses: new Set(["devirtualise-witnesses"]),
				}),
			).toContain("{ toString: Boxes.toString }.toString(box)")
		})

		it("leaves a conditional conformance's witness alone", () => {
			// NOTE: `boundConformance` curries witnesses onto every Method in
			// the map, so what stands behind `toString` is a Function the call
			// BUILDS. There is no name to put in its place.
			let generated = generate(witnesses)

			expect(generated).toContain("$type.boundConformance(")
			expect(generated).toMatch(/\$pool_\d+\.toString\(nested\)/)
		})

		it("leaves a witness the Program forwards alone", () => {
			// NOTE: A conformance Argument of the enclosing Function is a
			// different value per call, and which Method it holds is the
			// caller's business. The hole INSIDE `show` therefore keeps its
			// property read; the hole at the call site, whose witness the
			// Compiler wrote, does not — and asking both in one Program is what
			// makes this a question about the refusal rather than a question
			// about whether the pass ran.
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
			expect(generated).toContain("Integer.toString(count).value")
		})

		it("leaves the witnesses that are passed to the pool", () => {
			// NOTE: The two passes divide the witnesses between them rather
			// than competing for one: `sort` is HANDED its witness, so the
			// object has to exist and the pool builds it once.
			let generated = generate(witnesses)

			expect(generated).toMatch(
				/const \$pool_\d+ = \{ compare: Integer\.compare \}/,
			)
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
			// NOTE: Neither pass depends on the other having run. With the pool
			// off there is no const to read the witness out of, and the hole
			// still calls the Method directly.
			expect(
				generate(witnesses, {
					enabled: true,
					disabledPasses: new Set(["pool-constants"]),
				}),
			).toContain("Integer.toString(count).value")
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
				'"nested: [ 1, 2 ]"',
				'"[ 1, 2 ]"',
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
			// NOTE: `match @ -> …` matches the receiver, which the Handlers read
			// under the name it is already bound to — and `const _self = _self`
			// would read the name being declared rather than the receiver.
			let generated = generate(statementMatches)

			expect(generated).not.toContain("const _self = _self")
			expect(generated).toContain("static radius(_self) {\n\t\tif (")
		})

		it("binds the matched value in a block of its own", () => {
			// NOTE: The block is what shadows an enclosing `_self` for exactly
			// the length of the chain, as the wrapper's Parameter did.
			expect(generate(statementMatches)).toContain(
				"{\n\tconst _self = circle;\n\tif (",
			)
		})

		it("reads a scrutinee that mentions _self in a Scope of its own", () => {
			// NOTE: `match @.held -> …` READS `_self`, and a `const _self` is
			// hoisted over its own initialiser — so reading the enclosing one
			// from the same block is a `ReferenceError` rather than the value.
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
			// NOTE: The Simplifier gives every Handler body a Return, appending
			// `<- {}` where it has none — so without this every Handler would
			// end in an empty Record built, bound to a name and never read.
			let generated = generate(statementMatches)

			expect(generated).toContain(
				'{\n\tconst _self = blank;\n\tif (_self[$type.typeKeySymbol] === "Shape#Circle") {\n\t\tTerminal.inspect($pool_',
			)
			expect(generated).not.toContain("$discarded")
		})

		it("keeps the answer of a Handler answered by a Namespace the Program declares", async () => {
			// NOTE: Whether answering can be OBSERVED is the question, and a
			// Namespace named after a builtin answers it: `1::add(2)` under one
			// is a Method the Program wrote, and it prints. Asked of the
			// Program's own Namespaces rather than of the name alone.
			let generated = generate(shadowedDiscardedAnswer)

			expect(await outputOf(generated)).toEqual(['"the shadow ran"', "0"])
		})

		it("breaks out of the chain where a Handler answers early", () => {
			// NOTE: A Return in the middle of a Handler body says the rest of the
			// body does not run, which an assignment does not — so the labelled
			// block is what carries that half of what a Return meant.
			let generated = generate(statementMatches)

			expect(generated).toMatch(/\$match_\d+:\n/)
			expect(generated).toMatch(
				/name = \$pool_\d+;\n\t\t\t\t\tbreak \$match_\d+;/,
			)
		})

		it("labels nothing where every Handler answers last", () => {
			// NOTE: A Handler whose last Statement is its answer has nothing
			// after it to skip, so there is nothing to break out of.
			let generated = generate(nestedStatementMatches)
			let labels = [...generated.matchAll(/\$match_\d+:/g)]

			expect(labels).toHaveLength(1)
			expect(generate(statementMatches)).not.toContain("break $match_0")
		})

		it("answers the outer Match from a Match nested in a Handler", () => {
			// NOTE: The inner Match stands in the Return position of the outer
			// Handler, so what its Handlers answer is the outer Declaration's
			// name — and neither of them builds a wrapper.
			let generated = generate(nestedStatementMatches)

			expect(generated).toContain("let name;")
			expect(generated).not.toContain("function (_self)")
			expect(generated).toMatch(/name = \$pool_\d+;\n\t\t\t\t\} else \{/)
		})

		it("keeps the wrapper where a Match stands mid-Expression", () => {
			// NOTE: An Argument is not a place a Statement may be written, so
			// the one Expression JavaScript has that holds Statements is still
			// what a Match there compiles to.
			expect(generate(statementMatches)).toContain(
				"Terminal.inspect(function (_self) {",
			)
		})

		// NOTE: The lever this pass was written for. The standard library reads
		// every fallible answer back through `<- match @ -> …`, which is the one
		// shape that costs nothing at all to write out: the value is `_self`
		// already and the Handlers' Returns are the Method's own.
		it("takes the wrapper off the standard library's own Matches", () => {
			let source = `implementation {
				Terminal.inspect(Integer.parse("7")::value(withDefault 0))
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

		// NOTE: The two Match passes meet on every Handler and this one runs
		// FIRST, so what `elide-final-match-test` reads is what this one left —
		// and it reads a lowered Match exactly as it reads one that was not.
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

		// NOTE: Regression tests — the answer used to be written into the
		// Program's own name from INSIDE the Handler's block, which is a Scope
		// the Program writes Statements into. A Handler declaring that name
		// stood in front of the Declaration: the assignment landed on the
		// Handler's binding, the Declaration kept whatever it was left with,
		// and where the source said `constant` the bundler refused the emission
		// outright rather than run a Program that answers wrongly.
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
				// NOTE: A `break` past the chain lands after the label, so the
				// one assignment has to stand outside it — inside, and a
				// Handler that answered early would answer nothing at all.
				let generated = generate(shadowedAnswerNames)

				expect(generated).toMatch(
					/\$held_answer = answerC;\n\t\t\t\tbreak \$match_\d+;/,
				)
				expect(generated).toMatch(
					/\n\t\}\n\tanswerC = \$held_answer;\n\}/,
				)
			})

			it("holds nothing where no Handler binds the name", () => {
				// NOTE: Which is every Match anyone writes on purpose — the
				// answer goes straight to the name it was always written to.
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
				// NOTE: THE order invariant, asked of the lifted form. `flip`
				// assigns `either`, and the dispatch reads the receiver BEFORE
				// the Argument is evaluated — so the consts stand in the order
				// the Argument array was built in.
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
				// NOTE: There is no wrapper to take away — the chain is the
				// conditional Expression itself, which stands in a Statement
				// position as happily as in any other.
				let generated = generate(`implementation {
					constant value: Integer | Boolean = 5

					Terminal.inspect(value::toString())
				}`)

				expect(generated).not.toContain("$dispatch_0")
			})
		})

		describe("a condition that was already lowered", () => {
			it("asks the test rather than the Boolean it built", () => {
				let generated = generate(conditions)

				expect(generated).toContain("if (a.value < b.value) {")
				expect(generated).not.toContain("Boolean.falseInstance).value")
			})

			it("reads the value of a condition the Program computes", () => {
				// NOTE: A Method a Namespace wrote answers an Essence Boolean,
				// which is an object — and every object is true, so the `value`
				// it holds is what JavaScript has to be asked.
				expect(generate(conditions)).toContain(
					"if (Flags.itself(yes).value) {",
				)
			})

			it("builds the Boolean again when it is turned off", () => {
				expect(
					generate(conditions, {
						enabled: true,
						disabledPasses: new Set([
							"lower-matches-to-statements",
						]),
					}),
				).toContain(
					"if ((a.value < b.value ? Boolean.trueInstance : Boolean.falseInstance).value) {",
				)
			})

			it("prints the same thing with the pass off", async () => {
				expect(
					await expectSamePrintedOutput(
						"lower-matches-to-statements",
						conditions,
					),
				).toEqual(['"less"', '"yes"'])
			})
		})
	})

	// NOTE: `= expression` defaults, against the Optimiser's own contract — any
	// subset of the passes is a correct Program, and a pass never changes what
	// one does. A default is an Expression standing where no pass can lift work
	// in front of it, so `walkFunctionDefinition` offers one only to the passes
	// that ASK; what is asserted here is that the whole registry is undisturbed
	// by calls that leave Arguments out, and that the three passes which do ask
	// reach a default.
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
			case Edge#Front { <- items::firstItem()::value(withDefault 0) }
			case _ { <- items::lastItem()::value(withDefault 0) }
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

		// NOTE: One case per pass, which is the shape every other pass here is
		// held to — a Program full of defaulted calls, with each pass turned off
		// on its own.
		for (let passName of optimiserPassNames) {
			it(`prints the same thing with ${passName} off`, async () => {
				await expectSamePrintedOutput(passName, defaults)
			})
		}

		// NOTE: `pool-constants` is the reason a default is walked at all. A
		// unit-Case default is built by a `createCase` call otherwise — at every
		// call that leaves the Argument out, which is every call of `trim`,
		// `print`, `round` and `normalize` in every Program — where the
		// `overload` block it replaces read a pooled const.
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

			// NOTE: The `createCase` call moves OUT of the parameter list and
			// into the band, which is the whole of what pooling buys here: a
			// default is worked out per CALL, so a call left inside is a call
			// per call.
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

		// NOTE: And a literal one is pooled the same way — the Integer `1` of
		// `removeFirst` was `createInteger(1n)` at every call.
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

		// NOTE: `eliminate-dead-code` drops a Constant nothing READS, and a
		// default is a read — the only one, for a Constant a Declaration names
		// and no body does. Missed, the Constant went and the emitted default
		// named nothing.
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

		// NOTE: `inline-loops` writes a callee's BODY out where the call stands,
		// and the callee's own default parameters are what would have filled the
		// missing Argument in — there is no binding at the call site for them to
		// fill. None of the seven callees it inlines carries a default today, so
		// the guard is asserted against a Namespace that shadows one of them:
		// with the guard, the call keeps its frame and answers correctly.
		describe("a walk this pass inlines, given a default", () => {
			const written =
				"keepEvery(where check: (_: ItemType) -> Boolean) -> List<ItemType>"
			const defaulted =
				"keepEvery(where check: (_: ItemType) -> Boolean = (_ item: ItemType) -> Boolean { <- true }) -> List<ItemType>"

			let replacedStdlib: Stdlib | null = null

			beforeAll(() => {
				let sources = readStdlibFiles().map(
					({ filePath, sourceText }) => {
						if (!filePath.endsWith("List.es")) {
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
	Terminal.inspect([1, 2, 3]::keepEvery(where (_ item: Integer) -> Boolean {
		<- item::isGreaterThan(1)
	}))
}`
			const omitted = `implementation {
	Terminal.inspect([1, 2, 3]::keepEvery())
}`

			it("still inlines a call that writes every Argument", async () => {
				expect(generate(folded)).not.toContain("List.keepEvery")
				expect(await outputOf(generate(folded))).toEqual(["[ 2, 3 ]"])
			})

			// NOTE: The pass writes the CALLEE'S BODY out where the call stands,
			// and the callee's own default parameter is what would have filled
			// the missing Argument in — there is no binding at the call site for
			// it to fill. So the call keeps its frame, which is a missed
			// optimisation rather than a wrong Program.
			it("refuses a call that left an Argument out", async () => {
				expect(generate(omitted)).toContain("$es_List_keepEvery")
				expect(await outputOf(generate(omitted))).toEqual([
					"[ 1, 2, 3 ]",
				])
			})
		})

		// NOTE: A defaulted Integer Parameter is an ordinary binding by the time
		// any Statement runs, so the arithmetic over it lowers exactly as it
		// always did — the default changes the parameter list and nothing about
		// the body.
		it("still lowers arithmetic over a defaulted Integer Parameter", () => {
			expect(generate(defaults)).toContain("value.value * factor.value")
		})
	})

	describe("inline-loops", () => {
		it("writes the counted loop as a for over what the bounds hold", () => {
			// NOTE: The whole of what the counted entry costs, gone: the
			// direction is decided once, the counter IS what its bounds hold,
			// and the `{ index, carried }` Record its Essence body threads
			// through the `while` driver is never built.
			//
			// NOTE: And the KIND of counter is decided while COMPILING, because
			// both bounds are written as Integers a double holds exactly. None
			// of what asks at run time is emitted at all.
			let generated = generate(countedLoop)

			expect(generated).toContain("const $loop_0_from = $pool_0.value;")
			expect(generated).toContain(
				"const $loop_0_up = $loop_0_from <= $loop_0_to;",
			)
			expect(generated).not.toContain("$loop_0_big")
			expect(generated).toContain(
				"const $loop_0_delta = $loop_0_up ? 1 : -1;",
			)
			expect(generated).toContain(
				"for (let $loop_0_index = $loop_0_from; $loop_0_up ? $loop_0_index <= $loop_0_to : $loop_0_index >= $loop_0_to; $loop_0_index += $loop_0_delta)",
			)
			expect(generated).not.toContain("loop__overload$3")
			expect(generated).not.toContain("function (")
		})

		it("decides the counter's kind at run time for a bound it can not read", () => {
			// NOTE: A bound that is not a Literal is a value nothing is known
			// about, so the walk asks which representation the two are holding
			// — and a bigint counter is canonicalised per turn, because the kind
			// is decided from the bounds and canonicality belongs to the value.
			let generated = generate(`implementation {
	function upTo(_ limit: Integer) -> Integer {
		<- loop(from 1, through limit, startingWith 0, step (
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
				"const $loop_0_delta = $loop_0_big ? $loop_0_up ? 1n : -1n : $loop_0_up ? 1 : -1;",
			)
			expect(generated).toContain(
				"for (let $loop_0_index = $loop_0_big ? BigInt($loop_0_from) : $loop_0_from;",
			)
			expect(generated).toContain(
				"const $loop_0_held = $loop_0_big ? Integer.canonical($loop_0_index) : $loop_0_index;",
			)
		})

		it("hands the body the counter raw where no Integer is needed", () => {
			// NOTE: The driver built that Integer out of a pooled `1` and an
			// `add`, inside a Record, behind two closure calls. Now it is not
			// built at all: a counting body reads through to the value at every
			// mention of the counter, so the counter itself is what it is
			// handed. Both bounds are Literals a double holds, so the counter
			// counts in numbers and every value it takes is already the
			// canonical spelling of itself — there is nothing to view it
			// through.
			let generated = generate(countedLoop)

			expect(generated).not.toContain(
				"Integer.createInteger($loop_0_index)",
			)
			expect(generated).not.toContain("$loop_0_held")
			expect(generated).toContain("total + $loop_0_index")
		})

		it("keeps the counter's Integer where the body needs one", () => {
			// NOTE: A body that hands the counter on rather than reading
			// through it needs the Integer, and the swap has to see that. The
			// mention here is an Argument, which is every position that is not
			// a read of the value.
			//
			// NOTE: The Integer is built where it is handed on rather than
			// bound first, because this walk builds its List in place and its
			// whole turn is that one push. What matters here is that the
			// Integer is BUILT — `$loop_0_index` alone would be the swap taken
			// where it must not be.
			let generated = generate(`implementation {
	constant seen = loop(from 1, through 3, startingWith [], step (
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
			// NOTE: The other allocation a turn, and the one that pays: the
			// State is the walk's OWN Integer — nobody outside the walk can hold
			// one — so a walk whose bodies only read what it holds carries the
			// value and builds the Integer once, where the walk answers. It only
			// pays together with the arithmetic answering a raw value, which is
			// why the guarded operation below writes no literal.
			let generated = generate(countedLoop)

			expect(generated).toContain("let $loop_0_state = $pool_2.value;")
			expect(generated).toContain(
				'$loop_0_state = typeof total === "number" && typeof $loop_0_index === "number" && total + $loop_0_index >= -9007199254740991 && total + $loop_0_index <= 9007199254740991 ? total + $loop_0_index : Integer.sum(total, $loop_0_index).value;',
			)
			expect(generated).toContain(
				"sum = Integer.createInteger($loop_0_state);",
			)
			// NOTE: The Parameter's `const` STAYS. The slot is one binding for
			// the whole walk and the Parameter is bound per turn, so a closure
			// the body builds captures the turn it was built in — exactly as
			// capturing the Integer gave it.
			expect(generated).toContain("const total = $loop_0_state;")
		})

		it("keeps the State's Integer where a body needs one", () => {
			// NOTE: The same refusal the counter's swap makes, asked of the
			// State: a body that hands it on keeps the box, and so does one
			// whose State is not exactly an Integer. The Record walk is the
			// second — `state.total` is a member read off a Record, and there is
			// no value under a Record to carry.
			let generated = generate(`implementation {
	§§ Doubles a value.
	§§
	§§ @param value — the value
	§§ @returns — twice the value.
	function twice(_ value: Integer) -> Integer {
		<- value::add(value)
	}

	constant handed = loop(from 1, through 3, startingWith 1, step (
		_index,
		carried,
	) { <- twice(carried) })

	constant built = loop(from 1, through 3, startingWith { total = 0 }, step (
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
			// NOTE: The emission is a decision the Rewriter makes about what
			// reached it, so a pass that leaves a different shape leaves one it
			// simply does not act on. `inline-loops` off is the whole shape
			// gone, and `lower-scalar-operations` off is the arithmetic still a
			// call — with either off there is nothing to carry, and the walk
			// answers what it always did.
			let source = `implementation {
	constant crossed = loop(from 1, through 3, startingWith 9007199254740990, step (
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
			// NOTE: The predicate is asked first and the walk is left where it
			// answers false, which is the order and the meaning
			// `loop__overload$1` has — a predicate false on the seed answers the
			// seed and the body never runs.
			let generated = generate(conditionLoops)

			expect(generated).toContain(
				"$loop_0:\n\t\twhile (true) {\n\t\t\t{\n\t\t\t\tconst n = $loop_0_state;\n\t\t\t\tif (!(n < $pool_1.value))\n\t\t\t\t\tbreak $loop_0;\n\t\t\t}",
			)
			expect(generated).not.toContain("loop__overload$1")
		})

		it("asks an until predicate the opposite question", () => {
			// NOTE: `until` IS `while` with the predicate negated, and its
			// Essence body says so by calling `negate` on the Boolean the
			// predicate answered. Inlined, the question is simply asked the
			// other way round and no Boolean is built to be flipped.
			let generated = generate(conditionLoops)

			expect(generated).toContain(
				"if (n >= $pool_1.value)\n\t\t\t\t\tbreak $loop_1;",
			)
			expect(generated).not.toContain("loop__overload$2")
			expect(generated).not.toContain("Boolean.negate(")
		})

		it("assigns a Step's payload rather than building the Step", () => {
			// NOTE: `#Done(x)` at the answering position is the walk's answer
			// and the end of it; `#Continue(x)` is the next State. Both are
			// written where the Case would have been built.
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
			// NOTE: A `Step` held under a name is a value this Compiler can not
			// see the construction of, so the tag is read exactly as the driver
			// read it — at that one answering position, in a block of its own.
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
			expect(generated).not.toContain("List.keepEvery(")
		})

		it("holds the items and their count before the first turn", () => {
			// NOTE: `List.materialise` rather than `.value` because a List that
			// has been prepended to carries its items in two runs, and the
			// count under a name of its own because the Array a List holds can
			// GROW under the walk — an append to a List sitting at its Array's
			// tip pushes onto that Array, so a body that appends to the very
			// List it walks would otherwise walk what it is writing. Every walk
			// covers the items its receiver held when it began.
			let generated = generate(listWalks)

			// NOTE: The count stands between the receiver and the seed, which is
			// where a fold's seed can not lengthen the walk it seeds — the walk
			// covers what the receiver held when the call began, and
			// `reduce(startingWith list::append(x), …)` is written with the
			// receiver first.
			expect(generated).toContain(
				"const $loop_0_items = List.materialise(items);\n\tconst $loop_0_count = $loop_0_items.length;\n\tlet $loop_0_state =",
			)
			// NOTE: And nowhere does a walk read the Array's own length again.
			expect(generated).not.toMatch(
				/\$loop_\d+_position < \$loop_\d+_items/,
			)
		})

		it("answers the accumulator where an early fold runs to the end", () => {
			// NOTE: The two ways `reduce`'s early-stopping entry can finish, and
			// the labelled block is what tells them apart: a `#Done` leaves
			// through it, and falling out of the walk takes the accumulator.
			//
			// NOTE: The accumulator is an Integer here and the walk carries it
			// raw, so the tail is where its Integer is built —
			// `unboxed-loop-state`, whose exit this is.
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
			// NOTE: The whole of what decides whether a walk is inlined. A
			// Function-valued name is whatever was bound to it, which is not
			// something a Compiler can read — so the same Program holds four
			// walks written out and one call, and the call is the one whose
			// callback was bound to a name first.
			let generated = generate(listWalks)

			expect(generated).toContain("List.map(items, double)")
			expect(generated).toContain("$loop_2_mapped")
		})

		it("walks a proven List's own positions too", () => {
			// NOTE: THE Program the gate was answering wrongly. A refinement is
			// erased before the first pass runs, so `proven` and `written` hold
			// one List and the two walks below are the same walk — but the
			// Simplifier named `NonEmptyList` for the first of them, because
			// that Namespace declares a `map` of its own, and a Namespace name
			// is all this pass has to go by.
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
			// NOTE: `keepEvery` and both `reduce` entries were never affected,
			// and it is worth saying why rather than assuming it: none of the
			// three is declared on `NonEmptyList` — each can answer with fewer
			// items than it was handed, or with no List at all — so a proven
			// receiver reaches `List`'s own entry and is emitted under `List`'s
			// own name. Only `map` needed anything.
			let unoptimised = generate(provenWalks, {
				enabled: false,
				disabledPasses: new Set(),
			})

			expect(unoptimised).toContain("List.keepEvery(proven,")
			expect(unoptimised).toContain("List.reduce__overload$1(proven,")
			expect(unoptimised).toContain("List.reduce__overload$2(proven,")
		})

		it("leaves a proven receiver's other Methods alone", () => {
			// NOTE: What the gate opened is one Method, not a Namespace.
			// `reverse` is `List`'s own native re-exported exactly as `map` is
			// and is still left alone, because this pass walks four Methods and
			// that is not one of them; `prepend(contentsOf:)` is not `List`'s
			// Function at all — it calls `append` with the two Lists the other
			// way round — and a gate written per Namespace would have to weigh
			// that before opening.
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
			// NOTE: A Namespace named after a builtin is nested — the name is
			// taken at the top level — and it REPLACES the builtin for the rest
			// of its block. So a `map` written anywhere in such a Program may be
			// a Method the Program wrote, and the whole Program is refused
			// rather than one Scope of it.
			let generated = generate(shadowedList)

			expect(generated).toContain("List.map(")
			expect(generated).not.toContain("$loop_")
		})

		it("leaves the proven call where the Program declares its own", () => {
			// NOTE: The second name is a name a Program may take too, and taking
			// it refuses the Program's proven walks for the reason taking `List`
			// refuses its ordinary ones. It refuses THOSE and nothing else: the
			// walk written the ordinary way below is still written out, because
			// the name standing in front of a builtin is the one the Program
			// declared and not every name near it.
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
			// NOTE: ONE closure for the whole walk, where the driver built two
			// per turn of it — and nothing in an Expression position can hold a
			// `while` any other way.
			let generated = generate(argumentLoop)

			expect(generated).toContain(
				"Terminal.inspect((() => {\n\tlet $loop_0_state",
			)
			expect(generated).toContain(
				"\treturn Integer.createInteger($loop_0_state);\n})())",
			)
		})

		it("numbers a loop inside a loop apart from the one holding it", () => {
			// NOTE: The names an inlined walk binds stand in the Scope the walk
			// holding it threads its own State in, so two walks numbered from
			// zero would declare one name twice.
			let generated = generate(nestedLoops)

			expect(generated).toContain("$loop_0_state")
			expect(generated).toContain("$loop_1_state")
		})

		it("binds a Parameter where the closure bound it", async () => {
			// NOTE: THE question a rename would answer wrongly. One callback's
			// Parameter is named after a binding around the call, and the OTHER
			// callback's body reads that outer binding — so a Parameter bound
			// anywhere but in a Scope of its own would answer 11 rather than
			// 101, and no Diagnostic would say so.
			expect(
				await expectSamePrintedOutput(
					"inline-loops",
					shadowedParameter,
				),
			).toEqual(["101", "2", "3"])
		})

		it("evaluates what the call was given before the walk", async () => {
			// NOTE: The bounds, the seed and the receiver are evaluated in the
			// order the call passed them, which is the order the driver's own
			// Arguments were evaluated in — printed here, because printing is
			// the only way a Program can tell.
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
			).toEqual(["55", "15", "128", "128", "2"])
		})

		it("prints the same thing with the pass off over a List Program", async () => {
			// NOTE: The fixture that reaches every walking Method there is, and
			// the standard library's own — which are written on `reduce` and
			// `keepEvery` with literal callbacks, so this is where the prelude's
			// own inlining is exercised.
			await expectSamePrintedOutput(
				"inline-loops",
				readFileSync(fixturePath("List.es"), "utf8"),
			)
		})
	})

	describe("build-lists-in-place", () => {
		it("pushes into one Array where the walk rebuilt a List per turn", () => {
			// NOTE: The emission `map` and `keepEvery` already trust, written
			// for an accumulator the Program declared: one Array, a `push` a
			// turn, and the box built once at the exit. There is no State slot
			// at all — the Array IS the State — so the `const` the turn bound
			// the accumulator through is not emitted either.
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
			// NOTE: A turn whose whole body is that one push writes the
			// Argument there. Nothing stands between the binding and the read,
			// so the only reads the substitution moves ahead of the Argument
			// are the Array the walk owns and `push` on it. A turn that does
			// anything more keeps its binding — the second walk pushes twice —
			// because then there IS something in between and this does not try
			// to say what.
			//
			// NOTE: It is worth a turn's allocation: V8 stops keeping the loop
			// in optimised code once the item is bound before it is stored, and
			// a million-turn build measures 76 ms bound against 30 ms pushed
			// where it stands.
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
			// NOTE: `append(contentsOf:)` pushes the other List's logical items
			// onto the Array being built, which is what the native did with the
			// Array it was rebuilding. It can not reach for `materialise`: that
			// answers the OTHER List's own Array.
			let generated = generate(builtList)

			expect(generated).toContain("List.pushItemsOf(tail, $loop_2_built)")
			expect(generated).not.toContain("append__overload$2")
		})

		it("adds a whole List written as a literal as its items", () => {
			// NOTE: The same licence the seed reads a literal under: it is
			// built where it stands, so the walk pushes what it holds rather
			// than boxing it and walking the box straight back out.
			let generated = generate(builtList)

			expect(generated).toContain(
				"$loop_1_built.push(index);\n\t\t\t$loop_1_built.push(index, index);",
			)
		})

		it("builds the box at every edge the State leaves through", () => {
			// NOTE: A `#Done` that answers the accumulator is an exit like the
			// walk's own end, and each one boxes the Array where it stands.
			let generated = generate(builtStates)

			expect(generated).toContain(
				"$loop_1_answer = List.createList($loop_1_built);",
			)
			expect(generated).toContain(
				"$loop_2_answer = List.createList($loop_2_built);",
			)
		})

		it("writes nothing at all for a branch that changes nothing", () => {
			// NOTE: A bare answer is the rebuilding chain with no appends on it,
			// so there is nothing to push and nothing to assign — where the
			// copying emission wrote `$loop_0_state = list`.
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
			// NOTE: The other direction of the same rule: a List the Program
			// held before the walk is never pushed onto, so any seed that is not
			// a literal is copied into an Array of the walk's own. A literal
			// hands its Array over outright, which is what the first test above
			// reads.
			//
			// NOTE: `ownItemsOf` and not `pushItemsOf(seed, [])` — the copy a
			// short walk over a long seed pays in full is the copy `append`
			// performed, and an element-wise loop is not it.
			expect(generate(seededBuilds)).toContain(
				"const $loop_0_built = List.ownItemsOf(seed);",
			)
		})

		it("binds the State in neither body of a condition walk", () => {
			// NOTE: A `while` walk hands ONE State to TWO callbacks, so the
			// Parameter is elided in both or the walk is declined for both.
			let generated = generate(builtBesideElisions)

			expect(generated).toContain("const $loop_0_built = [$pool_")
			expect(generated).toContain("$loop_0_built.push(turns);")
			expect(generated).not.toContain("const list =")
			expect(generated).not.toContain("$loop_0_state")
		})

		it("elides the counter's Integer and the accumulator at once", () => {
			// NOTE: The two elisions on one callback, which is the only place
			// they meet: the counter is Parameter one and the accumulator is
			// Parameter two, so each is written where its own `const` stood.
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
			// NOTE: THE counter-example. `current` stands as the receiver being
			// replaced AND as a value written into `snapshots`, so the walk it
			// is written in keeps the emission it always had.
			let generated = generate(retainedAccumulator)

			expect(generated).not.toContain("_built")
			expect(generated).toContain("$loop_0_state")
		})

		it("declines every mention that is not a rebuilding chain", () => {
			// NOTE: A read, a capture, a nested walk over the accumulator, the
			// accumulator added to itself, and a `prepend`, which grows the end
			// a build does not push onto.
			expect(generate(declinedAccumulators)).not.toContain("_built")
		})

		it("declines a condition walk whose predicate reads the State", () => {
			// NOTE: ONE State handed to TWO bodies, and the predicate has no
			// rebuilding chain to stand in — so every mention it makes is a
			// read. A `while` walk over a List accumulator is declined by that
			// alone unless its predicate reads something else entirely.
			let generated = generate(`implementation {
				constant built = loop(startingWith [0], while (list) {
					<- list::length()::isLessThan(4)
				}, step (list) { <- list::append(1) })

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
			// NOTE: The whole of the sharing question, printed. `seed` is read
			// after two walks have been seeded with it — one that ran turns and
			// one that ran none — and appended to afterwards, and each walk's
			// answer is appended to as well. Every one of those has to answer
			// its own items and no one else's, whichever Array they are stored
			// in.
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
			// NOTE: The fixture that reaches every walking Method there is —
			// nothing in it is a walk this pass admits, and the point of asking
			// is that a pass which changed a Program it declines would be
			// wrong twice over.
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
			// NOTE: THE Rational question — what a fold has to reproduce is
			// what the operation STORES, not only what it is worth. The four
			// same-kind arithmetic entries are natives on the bigint-rational
			// core, which answers in lowest terms, so `1/2 + 1/4` stores 3 over
			// 4 and the fold has to as well: the folded value is the very one
			// the unfolded Program makes.
			let generated = generate(constantFolding)

			expect(generated).toContain("Rational.createRational(3n, 4n)")
			expect(generated).toContain("Rational.createRational(1n, 4n)")
			expect(generated).toContain("Rational.createRational(1n, 3n)")
			// NOTE: CONSTRUCTION is the other half, and it is untouched: a
			// Rational holds the parts it was BUILT with, and `absolute` on a
			// value that is not negative answers the Rational ITSELF — so `4/2`
			// stays four over two.
			expect(generated).toContain("Rational.createRational(4n, 2n)")
			expect(generated).toContain("Rational.createRational(-1n, 2n)")
			// NOTE: The Rational-beside-Rational entries, which are the ones
			// folded. The entry taking an Integer is still emitted — the mixed
			// sum at the end of the Program reaches it, and is left alone.
			expect(generated).not.toContain("Rational.add__overload$1")
			expect(generated).not.toContain("Rational.multiply__overload$1")
		})

		it("renders an interpolation hole whose value is written out", () => {
			// NOTE: Every hole folds, so the interpolation is a String literal
			// — no witness, no `toString`, no pieces concatenated at run time.
			let generated = generate(constantFolding)

			expect(generated).toContain(
				'String.createString("a count: 7, 1/2, true, x")',
			)
			expect(generated).not.toContain("$es_Rational_toString")
			expect(generated).not.toContain("$es_Boolean_toString")
		})

		it("concatenates two Strings that were written out", () => {
			let generated = generate(constantFolding)

			expect(generated).toContain('String.createString("ab")')
			expect(generated).not.toContain("String.append(")
		})

		it("leaves an operation whose operand is a call", () => {
			// NOTE: The whole of what folding through a call would cost: the
			// print inside `noisy` is the answer's own evaluation, and a fold
			// that took it would be a Program that says less.
			//
			// NOTE: It is the runtime entry rather than an inlined guard
			// because the guard reads its operands more than once and a call
			// may only be evaluated once — which is exactly the operand that
			// stopped the fold.
			expect(generate(constantFolding)).toContain("Integer.sum(")
		})

		it("leaves a mixed-kind operation to the Namespace that widens it", () => {
			// NOTE: `1::add(1/2)` reaches the widening entry, whose body is the
			// Rational addition rather than the bigint one this pass
			// reproduces — so the call stays and the Rational entry behind it
			// is still emitted.
			expect(generate(constantFolding)).toContain(
				"$es_Integer_add__overload$2(",
			)
		})

		it("leaves the arithmetic of a Namespace the Program declares", async () => {
			// NOTE: A Namespace named after a builtin stands in front of it for
			// the rest of its block, so `1::add(2)` there is a Method the
			// Program wrote — and it prints.
			let generated = generate(shadowedArithmetic)

			expect(generated).not.toContain("Integer.createInteger(3)")
			expect(await outputOf(generated)).toEqual(['"the shadow ran"', "9"])
		})

		it("refuses a fold larger than the cap", () => {
			// NOTE: 4,096 digits is the ceiling, and no operation folded here
			// can reach it from a Program that fits in memory — this one is
			// written to. What a refused fold costs is the optimisation and
			// nothing else: the Program multiplies where it always did.
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
			expect(generated).toContain("Rational.add__overload$1(")
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

		// NOTE: The pass before it takes every Integer operation this one would
		// otherwise find, so neither may assume the other ran — with the
		// lowering off, the Invocation is still there and is still folded.
		it("folds the Invocation with the lowering off", () => {
			let generated = generate(constantFolding, {
				enabled: true,
				disabledPasses: new Set(["lower-scalar-operations"]),
			})

			expect(generated).toContain("Integer.createInteger(86400)")
			expect(generated).not.toContain("Integer.createInteger(60)")
		})

		// NOTE: And the same on the other side of the hole. A witness is a
		// `direct-method` by the time this pass sees one, because
		// `devirtualise-witnesses` runs first — but it is a `ConformanceValue`
		// with that pass off, and the Method it names is read out of either.
		it("renders a hole whose witness is still a map", () => {
			expect(
				generate(constantFolding, {
					enabled: true,
					disabledPasses: new Set(["devirtualise-witnesses"]),
				}),
			).toContain('String.createString("a count: 7, 1/2, true, x")')
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

		// NOTE: THE correspondence this pass rests on. What it drops is a
		// Handler the Validator has already told the author can never match, so
		// the two are held to each other here rather than each to its own
		// reading: the count of Warnings is the count of Handlers dropped.
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
						),
					),
			).toBe(unreachable.length)
		})

		it("keeps a Handler two Types share a tag with", () => {
			// NOTE: `List<Integer>` and `List<String>` are both `"List"`, and
			// the empty List passes either — so neither Handler is refuted by
			// what the Compiler knows, and the item walk is what decides.
			let generated = generate(deadMatchArms)

			expect(generated).toContain('itemType: { type: "String" }')
			expect(generated).toContain('itemType: { type: "Integer" }')
		})

		it("keeps a Record Handler beside a Record scrutinee", () => {
			// NOTE: Every Record carries the one tag, so a Record Matcher is
			// never refuted by a Record member of the scrutinee's Union —
			// whatever their members say, which is a question about the value
			// rather than about its Type. Read off the Handlers rather than the
			// emission, because what a surviving Record Handler is COMPILED to
			// is a different pass's business: `{ x: Integer } | String` has one
			// claimant for the Record tag, so the Handler that survives here
			// ends up as the chain's `else`.
			let program = simplifiedSource(deadMatchArms)
			let survivors = matchMatchers(
				pruneDeadMatchArms.run(program, declaredNamespaces(program)),
			)

			expect(survivors[3]).toHaveLength(2)
			expect(survivors[3]!.map((matcher) => matcher.type)).toEqual([
				"String",
				"Record",
			])
		})

		it("leaves the survivors in the order they were written", () => {
			// NOTE: A Match is first-match-wins, so the order the survivors are
			// written in is the whole of what decides which one answers. Read
			// off the Matchers themselves, by identity: every survivor is the
			// Handler that was there, and their positions in the original chain
			// only ever ascend.
			let program = simplifiedSource(deadMatchArms)
			let before = matchMatchers(program)
			let after = matchMatchers(
				pruneDeadMatchArms.run(program, declaredNamespaces(program)),
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
			// NOTE: The tag comparison, not the read in front of it — a chain
			// asking about the matched value's tag more than once binds it to a
			// name first, and which side of that the arm is emitted on is not
			// what this test is about.
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

		// NOTE: The Match passes meet on every Handler and none of them may
		// assume another ran. With the tests uncompiled the same Handlers go,
		// and the descriptor that was built to decline them goes with them.
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

			// NOTE: Two Handlers, one test — and no fall-through, because
			// there is nowhere left for a value to fall.
			expect(generated).toContain(
				'if (_self[$type.typeKeySymbol] === "Integer") {',
			)
			expect(generated).not.toContain(
				'_self[$type.typeKeySymbol] === "String"',
			)
		})

		it("keeps the fall-through where the last Handler is Guarded", () => {
			// NOTE: A Guard is the Program's own Boolean, and a Guarded
			// Handler counts toward no exhaustiveness argument — so this one is
			// tested, and something has to answer for a value it declines.
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
			// NOTE: TWO Record members, so the Record tag is claimed by both and
			// says nothing — what tells them apart is their members, which is
			// exactly where a runtime check and a static Type can part company,
			// so the throw that names it stays. A Record beside a String would
			// NOT be this: one claimant makes the whole Matcher a tag test and
			// the elision applies.
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
			// NOTE: The other side of the rule above, and the one this pass
			// gained when `residual.ts` stopped refusing a Record Matcher
			// outright: `{ x: Integer } | String` has one Record member, so the
			// last Handler's check IS the tag comparison and the fall-through
			// after it can not be reached.
			let generated = generate(`implementation {
				constant scrutinee: { x: Integer } | String = "text"

				Terminal.inspect(match scrutinee -> String {
					case String { <- "a String" }
					case { x: Integer } { <- "a Record" }
				})
			}`)

			expect(generated).not.toContain("$type.noCaseMatched(_self)")
		})

		// NOTE: The standard library reads every fallible answer back through
		// a two-Handler Match on `Optional`, so this is most of the prelude's
		// Matches.
		it("elides the standard library's own final tests", () => {
			let body = bodyOf(
				generate(`implementation {
					Terminal.inspect(Integer.parse("7")::value(withDefault 0))
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

			// NOTE: Read off the BOUND tag: the Record Matcher compiles to a
			// tag comparison as well now, so that chain asks about the matched
			// value's tag twice and binds it once — which is the emitted shape
			// `tag-binding` describes, working on a chain it could not reach
			// before.
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

		// NOTE: The two Match passes meet on every Handler, and neither may
		// assume the other ran: with the tests uncompiled, what is dropped
		// here is the descriptor check instead.
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
			// NOTE: Two Records in one Union both carry the Record tag, so the
			// tag says nothing and the members are what decide. One property
			// read and one comparison per member, in place of a call that
			// walked a descriptor tree, asked `Object.entries` of it and asked
			// the runtime about each member Type in turn.
			let generated = generate(recordMembers)

			expect(generated).toContain(
				'_self.value[$type.typeKeySymbol] === "Integer"',
			)
			expect(generated).toContain(
				'_self.value[$type.typeKeySymbol] === "String"',
			)
		})

		it("reads a member that may not be there through an optional chain", () => {
			// NOTE: A Record Matcher is OPEN, so a value whose Type does not
			// declare `radius` may reach the test carrying one, or not carrying
			// it — which is the `Object.hasOwn` the walk asks first. `?.`
			// answers `undefined` for a member that is absent, and `undefined`
			// holds no tag.
			expect(generate(recordMembers)).toContain(
				'_self.radius?.[$type.typeKeySymbol] === "Integer"',
			)
		})

		it("drops a member the static Type already decides", () => {
			// NOTE: `held` is a Type Parameter on both sides, so the runtime
			// answers true for it without reading the value — the tree tests
			// `mark`, which is what tells the two apart, and nothing else.
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
			// NOTE: Two Records AND a String, so no member can be read until
			// the value is known to be a Record at all — and the `&&` is what
			// makes the reads after it safe rather than merely tidy.
			expect(generate(recordMembers)).toContain(
				'_self[$type.typeKeySymbol] === "Record" && _self.radius?.[$type.typeKeySymbol] === "Integer"',
			)
		})

		it("reads a member found on Object.prototype through the optional chain too", () => {
			// NOTE: A Matcher may name `toString`, and a members map is an
			// ordinary JavaScript object — so the Compiler asks `Object.hasOwn`
			// of it rather than reading it, and the emitted read goes through
			// `?.` because no arriving Record declares the member. What the
			// value inherits from `Object.prototype` is a function, which holds
			// no Type key, so the comparison answers what `hasOwn` answers.
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
			// NOTE: The Matcher writes the List member FIRST and the tree reads
			// it LAST: a tag comparison goes ahead of a walk, so the one test
			// that can still cost a call is reached only where the cheap tests
			// have not already declined.
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
			// NOTE: The comparison that decides is one level DOWN from the walk,
			// and cost is what orders them — not depth, which would put the walk
			// of a two-thousand-item List ahead of the read that declines in one
			// comparison and lose to the check the tree replaced. It is safe
			// because a walk is a leaf: the plan descends into a member or walks
			// it, never both, so nothing a walk could guard stands below it.
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
			// NOTE: The same Node stands in three places by the time this runs,
			// and a dispatch case is one of them — so the descriptor walk is
			// retired there by the same rule, without this pass knowing a
			// dispatch from a Match.
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
			// NOTE: A Type Parameter stands beside the Record, so a value
			// reaching the test may be anything — including a Record carrying
			// none of the members. Neither its tag nor what it declares can be
			// named, so the walk, which asks `hasOwn` before every read, stays.
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
			// NOTE: Nothing is known about a member one arriving Record does not
			// declare — not that it is absent, and not what it holds if it is
			// there — so a requirement that is not answered by ONE tag
			// comparison has nothing to be measured against, and the walk stays.
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
			// NOTE: A size rule rather than a soundness one — the walk is one
			// call against one pooled descriptor shared by every site naming the
			// same Matcher, and a tree is written out at each of them. A plan is
			// refused whole or taken whole; a truncated one would ask less than
			// the walk it replaced.
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
			// NOTE: A Type Parameter as the REQUIREMENT is implied by
			// everything, so nothing about what the member holds is left to
			// ask — but one arriving Record does not declare it, so whether it
			// is THERE is still a question, and it is the whole of the test.
			// The tree has no test for that on its own: a test asks a tag or
			// asks the walk, and neither is `Object.hasOwn`. So the plan is
			// refused and the walk goes on asking it.
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

			// NOTE: The same shape with a requirement one comparison answers —
			// which is what the refusal above is NOT, rather than the member
			// being undeclared being refused on its own.
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

		// NOTE: A Type graph that leads back into itself is what every
		// structural walker in this stage carries a guard for. No source-level
		// Program builds one — recursive Type declarations are refused — so the
		// pass is asked directly, exactly as `pool-constants`' key serialiser
		// is.
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

	describe("eliminate-dead-code", () => {
		it("drops a Constant nothing reads", () => {
			let generated = generate(deadCode)

			expect(generated).not.toContain("const dropped")
			expect(generated).not.toContain("droppedInside")
			expect(generated).toContain("const kept")
			expect(generated).toContain("const keptInside")
		})

		it("keeps a Constant whose value PRINTS", () => {
			// NOTE: The Declaration is what runs it, so dropping the name would
			// drop the Program's only way of saying it happened. Purity is the
			// same question `lower-scalar-operations` asks of an Argument it
			// would skip.
			expect(generate(deadCode)).toContain("const loud = noisy()")
		})

		it("keeps a Constant answered by a Namespace the Program declares", async () => {
			// NOTE: The same question, asked of a Program that answers it the
			// other way: `1::add(2)` under a Namespace named after the builtin
			// is a Method the Program wrote, and it prints — so the Declaration
			// nothing reads is the only thing running it, and it stays.
			let generated = generate(shadowedDeadCode)

			expect(generated).toContain("const unread")
			expect(await outputOf(generated)).toEqual(['"the shadow ran"', "0"])
		})

		it("keeps a variable, whatever is done with it", () => {
			// NOTE: An assignment is a Statement this pass does not read, so a
			// `variable` is refused outright rather than reasoned about.
			expect(generate(deadCode)).toContain("let counted")
		})

		it("drops a Constant holding an interpolated String nobody reads", () => {
			// NOTE: A hole CALLS `toString` through its witness, and the witness
			// names which Method — so the call is weighed by the enumeration
			// that weighs a written one. `Integer.toString` is a bigint's
			// decimal spelling and can not be told it did not happen.
			let generated = generate(`implementation {
				constant count = 3
				constant greeting = "you have {count}"

				Terminal.inspect(count)
			}`)

			expect(generated).not.toContain("greeting")
		})

		it("keeps one whose hole is answered by a Namespace with no entry", async () => {
			// NOTE: A Namespace the Program wrote can print, so its `toString`
			// is refused exactly as every other Method of it is — the table is
			// an allowlist and this Namespace is not on it.
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
			// NOTE: What a Module publishes is read by Modules this compilation
			// may never see, so every exported name is a root — asked here of
			// the pass directly, because a Program written as one file has no
			// export block to write.
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
					eliminateDeadCode.run(program, declaredNamespaces(program)),
				),
			).toEqual([])
			expect(
				declaredConstantNames(
					eliminateDeadCode.run(
						exported,
						declaredNamespaces(exported),
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
			// NOTE: A payload the Program holds elsewhere is SPREAD rather than
			// shared, which is what `createCase` does with it — the members are
			// copied onto a value of the Case's own.
			expect(generated).toContain("...payload")
			// NOTE: A unit Case keeps its constructor, which hands out one
			// instance per tag rather than a literal per construction.
			expect(generated).toContain('$type.createCase("Shape#Blank")')
		})

		it("quotes a member name JavaScript can not spell", () => {
			expect(generate(constructions)).toContain('"ok?": ')
		})

		// NOTE: The standard library's own bodies go through the same pass, in
		// the prelude the Rewriter builds — which is where most of a Program's
		// Record and List construction actually happens.
		it("collapses the standard library's bodies too", () => {
			const source = `implementation {
				Terminal.inspect([1, 2, 2]::removeDuplicates())
			}`

			let generated = generate(source)

			// NOTE: `removeDuplicates` folds onto a `[]` it declares, and
			// `append` builds a one-item List to concatenate — both of them
			// Essence bodies, emitted as prelude consts.
			expect(generated).toContain("$es_List_removeDuplicates")
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
			// NOTE: `1::add(1)` writes it twice and the standard library writes
			// it many times over; one const answers for all of them.
			let generated = generate(constants)
			let declarations = [
				...generated.matchAll(
					/const \$pool_\d+ = Integer\.createInteger\(1\)/g,
				),
			]

			expect(declarations).toHaveLength(1)
		})

		it("pools the descriptor a Match still checks against", () => {
			// NOTE: The one that costs most: this object was REBUILT at every
			// test, of every turn of whatever loop the Match sits in.
			let generated = generate(constants)

			expect(generated).toMatch(/isValueOfType\(_self, \$pool_\d+\)/)
			expect(generated).toMatch(/const \$pool_\d+ = \{\n\ttype: "Record"/)
		})

		// NOTE: A Choice's payload may name the Choice, so the descriptor a
		// compiled test embeds can lead back into itself — the shape every
		// structural Type walker in the stage carries a guard for.
		// `JSON.stringify` answered it by throwing, turning a legal Program into
		// a compiler crash. No source-level Program builds one today (recursive
		// Type declarations are refused), so the pass is asked directly.
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
				).implementation.nodes[0]!

				expect(node.nodeType).toBe("Intrinsic")

				return (node as common.typedSimple.PooledReferenceNode).key
			}

			let key = keyOf(descriptorProgram())

			expect(key).toContain("<cycle:")
			expect(keyOf(descriptorProgram())).toBe(key)
		})

		it("pools a conformance witness", () => {
			expect(generate(constants)).toMatch(
				/const \$pool_\d+ = \{ compare: Integer\.compare \}/,
			)
		})

		it("pools the call a conditional witness is bound by", () => {
			// NOTE: `boundConformance` curries witnesses onto Methods and reads
			// nothing else, so the call is as constant as the map it is given —
			// and it was being made at every site and on every turn of the loop
			// that reached one.
			expect(generate(conditionalConformances)).toMatch(
				/const \$pool_\d+ = \$type\.boundConformance\(\{ compare: List\.compare \}, \[\$pool_\d+\]\);/,
			)
		})

		it("tells two depths of curried witness apart", () => {
			// NOTE: The witness for a List of Lists and the witness for a List of
			// Lists of Lists are the same map with a different witness curried
			// onto it. Two constants, and the deeper one reads the shallower.
			let declarations = [
				...generate(conditionalConformances).matchAll(
					/const (\$pool_\d+) = \$type\.boundConformance\(\{ compare: List\.compare \}, \[(\$pool_\d+)\]\);/g,
				),
			]

			expect(declarations).toHaveLength(2)

			let [shallower, deeper] = declarations

			expect(deeper![2]).toEqual(shallower![1]!)
		})

		it("sorts by the witness each depth was given", async () => {
			// NOTE: What a shared constant would answer instead: the inner Lists
			// compared by the comparison written for their items, which orders
			// `[[[2]], [[1]]]` the wrong way round.
			expect(await outputOf(generate(conditionalConformances))).toEqual([
				"[ [ 1, 2 ], [ 3 ] ]",
				"[ [ [ 1 ] ], [ [ 2 ] ] ]",
				'"Less"',
			])
		})

		it("leaves a witness naming a Namespace the Program declares", () => {
			// NOTE: `class Boxes` is emitted below the band and a class is not
			// hoisted, so a const reading one would be a `ReferenceError` at
			// import. The witness stays where it was written.
			expect(generate(constants)).toContain("{ compare: Boxes.compare }")
		})

		it("leaves Booleans alone", () => {
			// NOTE: There are exactly two Boolean objects in a running Program
			// already — pooling one would name what it already has.
			let generated = generate(constants)

			expect(generated).toContain("Boolean.createBoolean(true)")
			expect(generated).not.toMatch(
				/const \$pool_\d+ = Boolean\.createBoolean/,
			)
		})

		it("declares the band between the standard library and the Program", () => {
			// NOTE: The one place it can stand: a pooled witness reads the
			// Function-valued consts above it, and a static Property's value —
			// which runs where its const is emitted — may read a pooled
			// constant.
			let generated = generate(constants)

			expect(generated.indexOf("const $pool_0")).toBeGreaterThan(
				generated.indexOf("const $es_"),
			)
			expect(generated.indexOf("const $pool_0")).toBeLessThan(
				generated.indexOf("Terminal.inspect("),
			)
		})

		// NOTE: The counted loop adds ONE to its index on every turn, and the
		// standard library's driver is where that literal is written — so
		// before this pass a ten thousand turn loop allocated ten thousand
		// Integers to count with.
		//
		// NOTE: With `inline-loops` on there is one `createInteger` left inside
		// a walk, and it is not a literal: the counted loop counts with the
		// bigint its bounds hold and builds the Integer its body is HANDED, once
		// a turn, where the driver built that Integer out of a pooled `1` and an
		// `add`. Every other one is a pooled const.
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
			expect(generated).toContain("{ compare: Integer.compare }")
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

		// NOTE: A pooled constant may only be built where a Program can read
		// it, and the descriptors are only in reach at all because
		// `compile-type-tests` put them in an Expression position — so with
		// that pass off there is less to pool and nothing to go wrong.
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

		it("spreads a right-hand side that is not a literal", () => {
			expect(generate(combinations)).toContain("...changes")
		})

		it("assigns again when it is turned off", () => {
			let generated = generate(combinations, {
				enabled: true,
				disabledPasses: new Set(["collapse-combinations"]),
			})

			expect(generated).toContain("Object.assign(")
		})

		// NOTE: The two collapses meet on `{ base with x = 1 }`, whose
		// right-hand side is a Record literal — and neither may assume the
		// other ran. With construction off the literal is still written out
		// member by member rather than built and copied.
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

	// NOTE: Not a pass, but a claim only this file can make: what a List
	// answers may not depend on which of its representations the Optimiser
	// happened to leave it in. With the registry on, a List literal is a
	// branded object `collapse-construction` wrote out and a walk is a `for`
	// over the Array `List.materialise` answers; with it off, the same literal
	// goes through `List.createList` and the same walk is a native call. A
	// List grown at both ends holds its items in two runs either way, and both
	// builds have to print the same items in the same order.
	//
	// NOTE: The two Lists branched off `both` are what a shared Array can get
	// wrong, and the expectation below is where that is asserted: `more` takes
	// the tip and grows the Array `both` holds, `other` finds that tip taken
	// and copies, and `both` — printed after both of them exist — still answers
	// the six items it was built with. A List reading another's items would
	// print a longer one there, whatever the Optimiser did.
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

	// NOTE: The sibling claim for the edits — what an edited List answers may
	// not depend on which representation it was edited in, nor on whether the
	// Optimiser wrote its literals and its walks out. `both` and `window` are
	// printed LAST as well as first: everything between them lives on the
	// Arrays those two hold, and either of them answering an item another one
	// added would show up there.
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
})
