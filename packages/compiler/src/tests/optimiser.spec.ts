import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { fixturePath } from "@essence-lang/fixtures"
import type { common } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import {
	defaultOptimiserOptions,
	optimise,
	type OptimiserOptions,
	optimiserOptionsKey,
	optimiserPasses,
	optimiserPassNames,
} from "../optimiser/index"
import { eliminateDeadCode } from "../optimiser/passes/eliminateDeadCode"
import { pruneDeadMatchArms } from "../optimiser/passes/pruneDeadMatchArms"
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
// so its top-level `__print` calls run.
async function outputOf(javaScript: string): Promise<Array<string>> {
	let directory = mkdtempSync(join(tmpdir(), "essence-optimiser-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, javaScript)

	let output: Array<string> = []
	let originalLog = console.log

	console.log = (...args: Array<unknown>) => {
		output.push(args.map((argument) => String(argument)).join(" "))
	}

	try {
		await import(file)
	} finally {
		console.log = originalLog
		rmSync(directory, { recursive: true, force: true })
	}

	return output
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
// members sharing the one tag, a Record Matcher, and a Type Parameter standing
// where anything at all could arrive. The last two Matches are the ones that
// must NOT be compiled to a tag.
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

	__print(match scalar -> String {
		case Integer { <- "integer" }
		case String  { <- "string" }
	})

	__print(match shape -> Integer {
		case #Circle { <- @.radius }
		case #Blank  { <- 0 }
	})

	__print(match numbers -> Integer {
		case List<Integer> { <- 1 }
		case Integer       { <- 2 }
	})

	__print(match mixed -> Integer {
		case List<String>  { <- 1 }
		case List<Integer> { <- 2 }
	})

	__print(match clicked -> String {
		case { x: Integer, y: Integer } { <- "click" }
		case String                     { <- "text" }
	})

	__print(label(["a"], or [1, 2]))
	__print(label(["a"], or "b"))
}`

// NOTE: One of each thing `pool-constants` declares once — a literal written
// twice, a Rational, a payload-less Case, a Record Matcher's descriptor, a
// conformance witness the standard library answers for, and a witness for a
// Namespace this Program DECLARES, which is the one that must stay where it was
// written. The Boolean is here to be left alone.
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
	constant shape: { x: Integer } | String = { x = 7 }
	constant chosen: Colour = #Red

	__print(1::add(1))
	__print(1/2)
	__print(chosen::is(#Red))
	__print(true)
	__print("a count: {7}")
	__print([2, 1]::sort())
	__print(boxes::sort())
	__print(match shape -> String {
		case String            { <- "text" }
		case { x: Integer }    { <- "a Record" }
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

	__print(red::is(#Green))
	__print(red::isNot(#Green))
	__print(Colour#Red::is(red))
	__print(Colour#Red::isNot(green))
	__print(blank::is(#Blank))
	__print(circle::is(#Blank))
	__print(circle::is(Shape#Circle({ radius = 1 })))
	__print(void::is(#Void))
	__print(held::is(#Void))
	__print(held::is(Box#Holding({ item = 1 })))
	__print(1::isLessThan(2))
}`

// NOTE: Every operation `lower-scalar-operations` writes out, beside the ones
// it must refuse: a mixed-kind comparison and a mixed-kind sum, where the
// widening the covering Namespace decides is not a bigint operation; the
// three-Argument `is`, which is a different Method; and an `and` whose Argument
// PRINTS, which is the whole of what the eager-evaluation rule is for — `noisy`
// runs in a Program that is right and does not run in one that lowered it to
// `&&`.
const scalarOperations = `implementation {
	§§ Prints as it answers, so that skipping it is visible.
	§§
	§§ @returns — always true.
	function noisy() -> Boolean {
		__print("evaluated")

		<- true
	}

	constant a = 3
	constant b = 5
	constant text = "ab"
	constant other = "ba"
	constant yes = true
	constant no = false

	__print(a::isLessThan(b))
	__print(a::isLessThanOrEqualTo(b))
	__print(a::isGreaterThan(b))
	__print(a::isGreaterThanOrEqualTo(b))
	__print(a::is(b))
	__print(a::isNot(b))
	__print(a::add(b))
	__print(a::subtract(b))
	__print(a::multiply(with b))

	__print(text::is(other))
	__print(text::isNot(other))
	__print(text::is("AB", comparing #Insensitive))

	__print(yes::negate())
	__print(yes::and(no))
	__print(yes::or(no))
	__print(no::and(noisy()))

	__print(a::isLessThan(1/2))
	__print(a::add(1/2))
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

				__print("the shadow ran")

				<- true
			}
		}

		<- false::and(1::is(2))
	}

	__print(trick())
	__print(ran)
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
		__print("evaluated")

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

	__print(value::toString())
	__print(items::length())
	__print(items::map((item) { <- "{item}!" }))
	__print(items::sort())
	__print(either::tagged(with "?"))
	__print(either::tagged(with noisy()))
	__print(identity(5)::toString())
	__print(describe(1, or 2))
	__print(describe(1, or true))
	__print(number::multiply(with 2)::toString())
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

	__print(either::tagged(with flip()))
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

	__print("you have {count} left")
	__print("{box}")
	__print("nested: {nested}")
	__print([2, 1]::sort()::toString())
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

	__print(point)
	__print(single)
	__print(awkward)
	__print(items)
	__print(nested)
	__print(circle)
	__print(held)
	__print(blank)
	__print(circle::is(held))
	__print(blank::is(Shape#Blank))
	__print(match circle -> Integer {
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
	__print([[3], [1, 2]]::sort())
	__print([[[2]], [[1]]]::sort())
	__print([1, 2]::compare(to [1, 2, 3])::toString())
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

	__print(base)
	__print(overridden)
	__print(both)
	__print(replaced)
	__print(base::is({ x = 1, y = 2 }))
}`

// NOTE: A Match in each position `lower-matches-to-statements` writes out,
// beside the ones it must leave alone. `radius` answers with `match @ ->`, whose
// value is `_self` already; `holding` answers with `match @.held ->`, which
// READS `_self` and may not bind it in the same Scope; `sized` answers before
// its last Statement, which is the one shape that needs a labelled break;
// `described` is a Declaration's initialiser and the `match` after it is written
// for its effects. The two `__print`s at the end hold a Match mid-Expression,
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
		case #Circle { __print("circle") }
		case #Blank { __print("blank") }
	}

	__print(circle::radius())
	__print(circle::sized())
	__print(small::sized())
	__print(blank::sized())
	__print(box::holding())
	__print(described)
	__print(match blank -> String {
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

	__print(named(1))
	__print(named(-1))
	__print(named("x"))
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

	__print(rendered())
	__print(tagged)
	__print(either)
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
		__print("less")
	} else {
		__print("more")
	}

	if yes::itself() {
		__print("yes")
	} else {
		__print("no")
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

	__print(sum)
	__print(down)
	__print(once)
}`

// NOTE: The two condition-driven entries, which are one driver read two ways.
const conditionLoops = `implementation {
	constant doubled = loop(startingWith 1, while (n) {
		<- n::isLessThan(100)
	}, step (n) { <- n::multiply(with 2) })

	constant same = loop(startingWith 1, until (n) {
		<- n::isGreaterThanOrEqualTo(100)
	}, step (n) { <- n::multiply(with 2) })

	__print(doubled)
	__print(same)
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

	__print(result)
}`

// NOTE: And the same entry answering with a \`Step\` the Compiler can NOT see
// built — held under a name first, which is every other way one can arrive.
const heldStep = `implementation {
	constant stopped = loop(startingWith 0, step (n) {
		constant answer: Step<Integer, Integer> = #Done(n)

		<- answer
	})

	__print(stopped)
}`

// NOTE: List's four walking Methods, and the one call that must stay a call:
// \`map\` given a Function-valued name rather than a literal.
const listWalks = `implementation {
	constant items = [1, 2, 3]

	__print(items::reduce(startingWith 0, (total, item) {
		<- total::add(item)
	}))

	__print(items::reduce(startingWith 0, step (total, item) {
		if item::isGreaterThan(2) {
			<- #Done(total)
		}

		<- #Continue(total::add(item))
	})::toString())

	__print(items::map((item) { <- item::multiply(with 2) })::length())
	__print(items::keepEvery(where (item) {
		<- item::isGreaterThan(1)
	})::length())

	constant double = (_ item: Integer) -> Integer { <- item::multiply(with 2) }

	__print(items::map(double)::length())
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

	__print(trick())
	__print([1, 2]::map((item) { <- item::add(1) })::length())
}`

// NOTE: A walk standing in an Argument, where there is nowhere to write a
// \`while\` and the arrow stays.
const argumentLoop = `implementation {
	__print(loop(startingWith 1, while (n) {
		<- n::isLessThan(10)
	}, step (n) { <- n::multiply(with 2) }))
}`

// NOTE: A walk inside a walk's body, which is what numbers the names apart.
const nestedLoops = `implementation {
	__print(loop(from 1, through 3, startingWith 0, step (index, total) {
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

	__print(answer)

	constant items = [1, 2, 3]

	__print(items::keepEvery(where (items) {
		<- items::isGreaterThan(1)
	})::length())
	__print(items::map((total) { <- total::add(1) })::length())
}`

// NOTE: What the call evaluated, in the order it evaluated it — printed,
// because printing is the only way a Program can tell.
const orderedLoops = `implementation {
	__print(loop(from __print(1), through __print(3), startingWith __print(0),
	step (index, total) { <- total::add(index) }))

	__print(__print([1, 2])::reduce(startingWith __print(0), (total, item) {
		<- total::add(item)
	}))
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
		__print("evaluated")

		<- 2
	}

	constant seconds = 60::multiply(with 60)::multiply(with 24)

	__print(seconds)
	__print(10::subtract(4))
	__print(-7::absolute())
	__print(7::negate())
	__print(1::isLessThan(2))
	__print(2::is(2))
	__print(2::isNot(2))
	__print(1/2::add(1/4))
	__print(1/2::subtract(1/4))
	__print(1/2::multiply(with 2/3))
	__print(4/2::absolute())
	__print(1/2::negate())
	__print(1/2::is(2/4))
	__print(1/2::isLessThan(2/3))
	__print("a"::append("b"))
	__print("b"::prepend("a"))
	__print("a count: {7}, {1/2}, {true}, {"x"}")
	__print(3::add(noisy()))
	__print(1::add(1/2))
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
				__print("the shadow ran")

				<- 9
			}
		}

		<- 1::add(2)
	}

	__print(trick())
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

	__print(match scalar -> String {
		case Integer { <- "an Integer" }
		case Boolean { <- "never" }
		case String  { <- "a String" }
	})

	__print(match shape -> String {
		case #Circle { <- "a Circle" }
		case Integer { <- "never" }
		case #Blank  { <- "Blank" }
	})

	__print(match items -> String {
		case List<String>  { <- "Strings" }
		case List<Integer> { <- "Integers" }
	})

	__print(match record -> String {
		case String         { <- "a String" }
		case { x: Integer } { <- "a Record" }
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
		__print("evaluated")

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

	__print(kept)
	__print(reader())
	__print(counted)
}`

// NOTE: The Node kinds `typedSimple.ExpressionNode` is made of, minus
// `Identifier`. The three Identifier positions the walk leaves alone — the
// Namespace a Method Invocation answers on, the runtime Function a native
// Invocation names, the member a Lookup reads — hold nothing else and are
// nothing the Program computes, so counting Identifiers here would be counting
// the difference between two deliberate answers.
const expressionKinds = new Set([
	"NativeFunctionInvocation",
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
				__print(1)
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

			expect(order).toEqual([
				"expression:IntegerValue",
				"expression:NativeFunctionInvocation",
				"statement:NativeFunctionInvocation",
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

		it("keeps the full check for a Record Matcher", () => {
			// NOTE: A Record's tag says only that it is a Record. What picks
			// this Handler is its MEMBERS, and reading those is a decision tree
			// rather than a tag test.
			let generated = generate(typeTests)

			expect(generated).toContain('type: "Record"')
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

				__print(label(["a"], or "b"))
			}`)

			expect(generated).toMatch(/isValueOfType\(_self, \$pool_\d+\)/)
			expect(generated).toContain('itemType: { type: "Integer" }')
		})

		// NOTE: The standard library's Matches go through the pass as well,
		// inside the prelude the Rewriter builds — `Optional` is a Choice, so
		// every fallible answer in the library is read back by one of these.
		it("compiles the standard library's own Matches", () => {
			let generated = generate(`implementation {
				__print(Integer.parse("7")::otherwise(0))
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

				__print(red::is(#Green))
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

				__print(trick())
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
			// `__print` inside it stops happening. `Boolean` is not shadowed and
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

				__print(false::and(a::isLessThan(1/2)))
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

				__print(loop(from 1, through 3, startingWith 0, step advance))
				__print(4::isEven())
			}`)

			expect(generated).toContain("start.value <= end.value")
			expect(generated).toContain("current.index.value <= end.value")
			expect(bodyOf(generated, "$es_Integer_isEven")).toContain(
				".value === ",
			)
		})

		// NOTE: What lowering the standard library's comparison family COSTS a
		// Program: the bodies stop being reached, so they stop being emitted.
		it("takes the comparison bodies out of the emission", () => {
			let source = `implementation {
				__print(1::isLessThanOrEqualTo(2))
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

					__print(n::add(1))
					__print(n::multiply(with 1))
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

				__print(value::toString())
			}`)

			expect(generated).toContain(
				'value[$type.typeKeySymbol] === "Integer" ? Integer.toString(value) : $es_Boolean_toString(value)',
			)
			expect(generated).not.toContain('=== "Boolean"')
			expect(generated).not.toContain("noDispatchCaseMatched")
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

					__print("{count}")
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

				__print(show(count))
				__print("and {count}")
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
				'{\n\tconst _self = blank;\n\tif (_self[$type.typeKeySymbol] === "Shape#Circle") {\n\t\t$_.__print($pool_',
			)
			expect(generated).not.toContain("$discarded")
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
				"$_.__print(function (_self) {",
			)
		})

		// NOTE: The lever this pass was written for. The standard library reads
		// every fallible answer back through `<- match @ -> …`, which is the one
		// shape that costs nothing at all to write out: the value is `_self`
		// already and the Handlers' Returns are the Method's own.
		it("takes the wrapper off the standard library's own Matches", () => {
			let source = `implementation {
				__print(Integer.parse("7")::otherwise(0))
			}`
			let body = bodyOf(generate(source), "$es_Optional_otherwise")

			expect(body).toContain(
				'const $es_Optional_otherwise = function (_self, fallback) {\n\tif (_self[$type.typeKeySymbol] === "Optional#Value") {',
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

					__print(value::toString())
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

	describe("inline-loops", () => {
		it("writes the counted loop as a for over the bigints", () => {
			// NOTE: The whole of what the counted entry costs, gone: the
			// direction is decided once, the counter IS the bigint its bounds
			// hold, and the `{ index, carried }` Record its Essence body threads
			// through the `while` driver is never built.
			let generated = generate(countedLoop)

			expect(generated).toContain("const $loop_0_from = $pool_0.value;")
			expect(generated).toContain(
				"const $loop_0_up = $loop_0_from <= $loop_0_to;",
			)
			expect(generated).toContain(
				"for (let $loop_0_index = $loop_0_from; $loop_0_up ? $loop_0_index <= $loop_0_to : $loop_0_index >= $loop_0_to; $loop_0_index += $loop_0_delta)",
			)
			expect(generated).not.toContain("loop__overload$3")
			expect(generated).not.toContain("function (")
		})

		it("hands the body the counter as an Integer", () => {
			// NOTE: The one allocation a turn of a counted loop still costs,
			// where the driver built that Integer out of a pooled `1` and an
			// `add`, inside a Record, behind two closure calls.
			expect(generate(countedLoop)).toContain(
				"const index = Integer.createInteger($loop_0_index);",
			)
		})

		it("counts down when the first bound is the greater", async () => {
			expect(
				await expectSamePrintedOutput("inline-loops", countedLoop),
			).toEqual(["55", "6", "2"])
		})

		it("checks a while predicate before each step", () => {
			// NOTE: The predicate is asked first and the walk is left where it
			// answers false, which is the order and the meaning
			// `loop__overload$1` has — a predicate false on the seed answers the
			// seed and the body never runs.
			let generated = generate(conditionLoops)

			expect(generated).toContain(
				"$loop_0:\n\t\twhile (true) {\n\t\t\t{\n\t\t\t\tconst n = $loop_0_state;\n\t\t\t\tif (!(n.value < $pool_1.value))\n\t\t\t\t\tbreak $loop_0;\n\t\t\t}",
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
				"if (n.value >= $pool_1.value)\n\t\t\t\t\tbreak $loop_1;",
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
				"for (let $loop_0_position = 0; $loop_0_position < $loop_0_items.length; $loop_0_position++)",
			)
			expect(generated).not.toContain("List.reduce__overload$1(")
			expect(generated).not.toContain("List.keepEvery(")
		})

		it("answers the accumulator where an early fold runs to the end", () => {
			// NOTE: The two ways `reduce`'s early-stopping entry can finish, and
			// the labelled block is what tells them apart: a `#Done` leaves
			// through it, and falling out of the walk takes the accumulator.
			let generated = generate(listWalks)

			expect(generated).toMatch(
				/\$loop_\d+: \{\n\t\tfor \(let \$loop_\d+_position/,
			)
			expect(generated).toMatch(
				/\t\t\$loop_(\d+)_answer = \$loop_\1_state;\n\t\}/,
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
				"$_.__print((() => {\n\tlet $loop_0_state",
			)
			expect(generated).toContain("\treturn $loop_0_state;\n})())")
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
			).toEqual(['"55"', '"15"', '"128"', '"128"', '"2"'])
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

	describe("fold-constants", () => {
		it("writes the answer where the operation was written", () => {
			let generated = generate(constantFolding)

			expect(generated).toContain("Integer.createInteger(86400n)")
			expect(generated).toContain("Integer.createInteger(6n)")
			expect(generated).toContain("Integer.createInteger(7n)")
			expect(generated).toContain("Integer.createInteger(-7n)")
			expect(generated).not.toContain("Integer.createInteger(60n)")
		})

		it("stores a folded Rational as the Essence body would", () => {
			// NOTE: THE Rational question. `1/2 + 1/4` is worth `3/4` and a
			// Rational holds the parts it was BUILT with — the Essence body
			// cross-multiplies the lowest-terms parts and stores 6 over 8 — so a
			// fold to `3/4` would be a value the unfolded Program never makes.
			// The band says 6 and 8; the Program prints `3/4`.
			let generated = generate(constantFolding)

			expect(generated).toContain("Rational.createRational(6n, 8n)")
			expect(generated).toContain("Rational.createRational(2n, 8n)")
			expect(generated).toContain("Rational.createRational(2n, 6n)")
			// NOTE: `absolute` on a value that is not negative answers the
			// Rational ITSELF, so `4/2` stays four over two.
			expect(generated).toContain("Rational.createRational(4n, 2n)")
			expect(generated).toContain("Rational.createRational(-1n, 2n)")
			// NOTE: The Rational-beside-Rational entries, which are the ones
			// folded. The entry taking an Integer is still emitted — the mixed
			// sum at the end of the Program reaches it, and is left alone.
			expect(generated).not.toContain("$es_Rational_add__overload$1")
			expect(generated).not.toContain("$es_Rational_multiply")
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
			expect(generate(constantFolding)).toContain(".value + ")
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

			expect(generated).not.toContain("Integer.createInteger(3n)")
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
					__print(${large}::multiply(with 10))
				}`),
			).toContain(".value * ")

			expect(
				generate(`implementation {
					__print(${"9".repeat(4090)}::multiply(with 10))
				}`),
			).not.toContain(".value * ")
		})

		it("computes the operations again when it is turned off", () => {
			let generated = generate(constantFolding, {
				enabled: true,
				disabledPasses: new Set(["fold-constants"]),
			})

			expect(generated).toContain("Integer.createInteger(60n)")
			expect(generated).toContain("$es_Rational_add__overload$1(")
			expect(generated).toContain("String.append(")
			expect(generated).not.toContain("Integer.createInteger(86400n)")
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

			expect(generated).toContain("Integer.createInteger(86400n)")
			expect(generated).not.toContain("Integer.createInteger(60n)")
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

			expect(unreachable).toHaveLength(2)
			expect(
				unreachable.every(
					(diagnostic) => diagnostic.severity === "warning",
				),
			).toBe(true)

			let program = simplifiedSource(deadMatchArms)

			expect(
				matchHandlerCount(program) -
					matchHandlerCount(pruneDeadMatchArms.run(program)),
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
			// NOTE: Every Record carries the one tag, so what tells two apart is
			// their members — which is a walk of the value rather than a
			// question about its Type.
			expect(generate(deadMatchArms)).toContain('type: "Record"')
		})

		it("leaves the survivors in the order they were written", () => {
			// NOTE: A Match is first-match-wins, so the order the survivors are
			// written in is the whole of what decides which one answers. Read
			// off the Matchers themselves, by identity: every survivor is the
			// Handler that was there, and their positions in the original chain
			// only ever ascend.
			let program = simplifiedSource(deadMatchArms)
			let before = matchMatchers(program)
			let after = matchMatchers(pruneDeadMatchArms.run(program))

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
			expect(generated).toContain(
				'_self[$type.typeKeySymbol] === "Boolean"',
			)
		})

		it("prints the same thing with the pass off", async () => {
			expect(
				await expectSamePrintedOutput(
					"prune-dead-match-arms",
					deadMatchArms,
				),
			).toEqual(['"an Integer"', '"Blank"', '"Integers"', '"a Record"'])
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

				__print(match scrutinee -> String {
					case String { <- "a String" }
					case Integer where @::isNegative() { <- "a negative" }
					case Integer { <- "an Integer" }
				})
			}`)

			expect(generated).not.toContain("$type.noCaseMatched(_self)")

			let guardedLast = generate(`implementation {
				constant scrutinee: Integer | String = 5

				__print(match scrutinee -> String {
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

				__print(match scrutinee -> String {
					case String { <- "a String" }
					case Integer { <- "an Integer" }
					case 0 { <- "unreachable" }
				})
			}`)

			expect(generated).toContain("$type.noCaseMatched(_self)")
		})

		it("keeps the fall-through where no tag decides the last Handler", () => {
			// NOTE: A Record Matcher asks about members, and the Compiler can
			// not reduce that to a tag — which is exactly where a runtime
			// check and a static Type can part company, so the throw that
			// names it stays.
			let generated = generate(`implementation {
				constant scrutinee: { x: Integer } | String = "text"

				__print(match scrutinee -> String {
					case String { <- "a String" }
					case { x: Integer } { <- "a Record" }
				})
			}`)

			expect(generated).toContain("$type.noCaseMatched(_self)")
		})

		// NOTE: The standard library reads every fallible answer back through
		// a two-Handler Match on `Optional`, so this is most of the prelude's
		// Matches.
		it("elides the standard library's own final tests", () => {
			let body = bodyOf(
				generate(`implementation {
					__print(Integer.parse("7")::otherwise(0))
				}`),
				"$es_Optional_otherwise",
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

			expect(generated).toContain(
				'_self[$type.typeKeySymbol] === "String"',
			)
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

		it("keeps a variable, whatever is done with it", () => {
			// NOTE: An assignment is a Statement this pass does not read, so a
			// `variable` is refused outright rather than reasoned about.
			expect(generate(deadCode)).toContain("let counted")
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
				declaredConstantNames(eliminateDeadCode.run(program)),
			).toEqual([])
			expect(
				declaredConstantNames(eliminateDeadCode.run(exported)),
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
				__print([1, 2, 2]::removeDuplicates())
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
				/const \$pool_\d+ = Integer\.createInteger\(1n\);/,
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
					/const \$pool_\d+ = Integer\.createInteger\(1n\)/g,
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
				generated.indexOf("$_.__print("),
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
			expect(generated).toContain("Integer.createInteger(1n)")
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
				/const \$pool_\d+ = Integer\.createInteger\(1n\);/,
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
})
