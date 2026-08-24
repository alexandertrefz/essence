import type { common } from "@essence-lang/interfaces"

import { builtinNamespaces, builtinProtocols } from "../enricher/builtins"
import { overloadIndexOf, resolveOverloadedMethodName } from "../helpers/index"
import { withoutOverloadSuffix } from "../optimiser/purity"
import { rewriteNodes } from "../optimiser/walk"

// NOTE: Coverage says a line RAN; mutation says a bug there would be CAUGHT. A
// mutant is this Module's one deliberate lie about a Program — a comparison
// rotated a step, a Case swapped for its sibling, a branch turned inside out —
// and the question a run asks of it is whether any test notices.
//
// NOTE: It works on a SIMPLIFIED Program, and on the implementation alone. The
// tests section is not mutated, for the reason the coverage pass does not count
// it: what is under test is the code, and a lie told inside a test is a lie
// about the question rather than about the answer. Enumeration happens
// post-simplify and PRE-optimise, so a site stands where the author wrote it
// and no instrumentation the Optimiser added is ever mistaken for one.
//
// NOTE: Every mutant this Module produces is TYPE-SHAPED by construction, and
// that is the whole discipline: a mutated Program is never enriched again, so
// nothing downstream would catch a lie that does not typecheck. A Case swap
// demands the identical member-name shape, a literal nudge answers the same
// Type, a branch swap moves Statements that were already there, and a member
// swap is refused outright unless the Namespace it is aimed at declares the
// name AT THE SAME ARITY, or the Protocol that answered the call wrote a body
// for it — see `swappableMember`. Where a site can not be shown to be sound it
// is silently not a site; the walker's reach improves later, and a mutant
// nobody can trust is worse than a mutant nobody made.

export type MutationSite = {
	// NOTE: The site's position in the walk, which is its NAME: `applyMutation`
	// walks the same Program the same way and applies the rewrite the id lands
	// on. Ids are assigned before the per-line cap below drops anything, so
	// what a cap leaves out does not renumber what it keeps.
	id: number
	// NOTE: Which file the site is in. A simplified Program does not know its
	// own path — one Program is one Module's, and the caller is what pairs the
	// two — so it is stamped here by whoever enumerates.
	module: string | null
	position: common.Position
	operator: MutationOperator
	// NOTE: The finished sentence fragment a report reads out — "swap
	// ::isGreaterThan for ::isGreaterThanOrEqualTo". It is spelled HERE, once,
	// so the human report and the event stream can never disagree about what a
	// mutant did.
	description: string
}

export type MutationOperator =
	| "comparison"
	| "equality"
	| "arithmetic"
	| "boolean"
	| "branch"
	| "integer"
	| "case"

// NOTE: At most this many sites on one line of source. A line dense enough to
// carry more is a line where the fifth mutant tells a reader nothing the first
// four did not, and the cost of a mutant is a whole compile and a run of every
// test that reaches it. Dropped from the END of the line's own sites, which is
// the walk's order, so the answer is the same every time it is asked.
const SITES_PER_LINE = 4

// NOTE: The comparison rotations, each a SINGLE step: a bound moved by one, or
// an order reversed. `isLessThan` against `isGreaterThanOrEqualTo` is two steps
// and is left out — it is the negation, which a test that checks anything at
// all already fails, so the mutant would be killed by everything and would
// distinguish no suite from another.
//
// NOTE: Both steps for EVERY member, which is the rule stated above and not a
// rule with two members exempt from it. `isLessThanOrEqualTo` reversed is
// `isGreaterThanOrEqualTo` — a bound written the wrong way round, which is the
// commonest comparison bug there is — and leaving the two `…OrEqualTo` names
// with only their bound-moving step made them the two names a suite could get
// backwards without the score moving.
//
// NOTE: Maps rather than object literals, all three of them, and that is not a
// preference. A Method's name is user text — `toString`, `valueOf`,
// `constructor` are all perfectly good members — and an object literal answers
// every one of those out of `Object.prototype` rather than saying it has none.
const COMPARISON_SWAPS = new Map<string, Array<string>>([
	["isLessThan", ["isLessThanOrEqualTo", "isGreaterThan"]],
	["isLessThanOrEqualTo", ["isLessThan", "isGreaterThanOrEqualTo"]],
	["isGreaterThan", ["isGreaterThanOrEqualTo", "isLessThan"]],
	["isGreaterThanOrEqualTo", ["isGreaterThan", "isLessThanOrEqualTo"]],
])

// NOTE: `is` against `isNot` is the one equality rotation there is, and it is
// the sharpest mutant in the set: a test that asserts a value rather than
// merely exercising it kills it, and one that does not, does not.
const EQUALITY_SWAPS = new Map<string, Array<string>>([
	["is", ["isNot"]],
	["isNot", ["is"]],
])

// NOTE: Addition against subtraction both ways, and multiplication toward
// addition one way. The reverse — `add` toward `multiply` — is left out
// because it agrees with the original wherever the operands are 2 and 2, and a
// mutant that is sometimes not one is a mutant whose survival says nothing.
const ARITHMETIC_SWAPS = new Map<string, Array<string>>([
	["add", ["subtract"]],
	["subtract", ["add"]],
	["multiply", ["add"]],
])

// #region Enumerating and applying

// NOTE: Every mutation this Program admits, in walk order. Deterministic
// throughout: the walk is the Optimiser's own, which is a fixed reading of the
// tree, and every table above is an array rather than a set.
export function enumerateMutations(
	program: common.typedSimple.Program,
	module: string | null = null,
): Array<MutationSite> {
	let found: Array<MutationSite> = []

	walkMutations(program, (site) => {
		found.push({ ...site, module })

		return false
	})

	return withinLineCap(found)
}

// NOTE: A fresh Program with exactly one site rewritten. The Program handed in
// is untouched — the walk rebuilds only the spine above the Node it replaced,
// exactly as an Optimiser pass does — so the Session's simplified Program stays
// the unmutated one every other entry of the run is compiled from.
//
// NOTE: It THROWS on an id it can not find. A stale site is a bug in whoever
// held it — a walker that changed under a saved list, an id from another
// Module — and compiling the unmutated Program instead would report every test
// as failing to kill a mutant that was never there.
export function applyMutation(
	program: common.typedSimple.Program,
	site: number,
): common.typedSimple.Program {
	let applied = false
	let mutated = walkMutations(program, (candidate) => {
		if (candidate.id !== site) {
			return false
		}

		applied = true

		return true
	})

	if (!applied) {
		throw new Error(`No mutation site ${site} in this Module`)
	}

	return mutated
}

// NOTE: The cap, applied to the enumerated list rather than to the walk, which
// is what keeps an id meaning the same site whether or not the line it is on
// was crowded.
function withinLineCap(sites: Array<MutationSite>): Array<MutationSite> {
	let perLine = new Map<number, number>()

	return sites.filter((site) => {
		let line = site.position.start.line
		let taken = perLine.get(line) ?? 0

		perLine.set(line, taken + 1)

		return taken < SITES_PER_LINE
	})
}

// #endregion

// #region The walk

// NOTE: What the walk offers, before it is known whether anybody wants it. The
// id is the running count over the whole walk, so it is fixed by the shape of
// the Program and by nothing else.
type Candidate = {
	id: number
	position: common.Position
	operator: MutationOperator
	description: string
}

// NOTE: One lie about one Node, ready to be told: what family it belongs to,
// the sentence a report reads out, and the replacement itself, built only if
// anybody asks. Every producer below answers with these and `offer` consumes
// them, so what a candidate IS is spelled once rather than restated at each end
// of every hand-off.
export type MutationCandidate<Node> = {
	operator: MutationOperator
	description: string
	rewrite: () => Node
}

// NOTE: One walk, shared by enumeration and application, because two walks
// would be two chances to disagree about which site an id names. `take`
// answers whether THIS candidate is the one to apply; enumeration records and
// always declines, application accepts exactly once.
function walkMutations(
	program: common.typedSimple.Program,
	take: (candidate: Candidate) => boolean,
): common.typedSimple.Program {
	let context = contextOf(program)
	let next = 0
	// NOTE: A Node's candidates are offered in order and at most one of them is
	// taken, which is what makes three nudges of one literal three sites rather
	// than one. The Node handed back is the last replacement anybody asked for,
	// or the Node itself.
	let offer = <Node>(
		node: Node,
		position: common.Position,
		candidates: Array<MutationCandidate<Node>>,
	): Node => {
		let result = node

		for (let candidate of candidates) {
			let id = next

			next += 1

			if (
				take({
					id,
					position,
					operator: candidate.operator,
					description: candidate.description,
				})
			) {
				result = candidate.rewrite()
			}
		}

		return result
	}

	// NOTE: The implementation ALONE — the tests section is walked past, so no
	// id is ever spent on a Node inside it and nothing there can be mutated.
	let mutated = rewriteNodes(
		{ ...program, tests: null },
		{
			expression: (node) => mutateExpression(node, context, offer),
			statement: (node) => mutateStatement(node, context, offer),
		},
	)

	return mutated.implementation === program.implementation
		? program
		: { ...program, implementation: mutated.implementation }
}

type Offer = <Node>(
	node: Node,
	position: common.Position,
	candidates: Array<MutationCandidate<Node>>,
) => Node

// NOTE: What every producer below answers with — a lie about one Expression,
// which is every position this walker tells one in.
type ExpressionCandidate = MutationCandidate<common.typedSimple.ExpressionNode>

function mutateStatement(
	node: common.typedSimple.ImplementationNode,
	context: MutationContext,
	offer: Offer,
): common.typedSimple.ImplementationNode {
	if (node.nodeType !== "ConditionalStatement") {
		return node
	}

	let position = node.position

	// NOTE: A Conditional the Compiler synthesized has no Position and is not a
	// site — the same line `instrument-coverage` draws, and for the same
	// reason: a report can not point at one.
	if (position === undefined) {
		return node
	}

	// NOTE: A NARROWING doorway is left alone. Swapping the bodies of `if
	// value::is(#Value(x))` would run the body that was type-checked against
	// the refinement in the branch where the refinement does not hold — the
	// mutant is not type-shaped, it fails everything it touches, and a mutant
	// killed by every test distinguishes no suite from another.
	//
	// NOTE: Asked of the CONDITION rather than of `node.narrows`, because the
	// same refusal has to reach the member swaps inside that condition and a
	// swap is offered at a Node the walk has already passed by the time this
	// runs. One set answers both — see `narrowingConditions`.
	if (context.narrowed.has(node.condition)) {
		return node
	}

	// NOTE: Two empty bodies are a Conditional with nothing to swap.
	if (node.trueBody.length === 0 && node.falseBody.length === 0) {
		return node
	}

	return offer(node, position, [
		{
			operator: "branch",
			// NOTE: The condition is INVERTED by swapping the two bodies rather
			// than by wrapping it in a negation. No Node is invented, nothing
			// has to be proven about the Type of a synthesized call, and what a
			// reader is told is what actually happened.
			description: "swap the branches of this if",
			rewrite: () => ({
				...node,
				trueBody: node.falseBody,
				falseBody: node.trueBody,
			}),
		},
	])
}

function mutateExpression(
	node: common.typedSimple.ExpressionNode,
	context: MutationContext,
	offer: Offer,
): common.typedSimple.ExpressionNode {
	let position = node.position

	// NOTE: Only what the SOURCE wrote. The Simplifier builds literals,
	// Optionals and witnesses nobody asked for, and those carry no Position —
	// which is exactly the line between a mutant a reader can be shown and one
	// they can not.
	if (position === undefined) {
		return node
	}

	switch (node.nodeType) {
		case "MethodInvocation":
			return offer(node, position, memberSwaps(node, context))
		case "BooleanValue":
			return offer(node, position, [
				{
					operator: "boolean",
					description: `swap ${node.value} for ${!node.value}`,
					rewrite: () => ({ ...node, value: !node.value }),
				},
			])
		case "IntegerValue":
			return offer(node, position, integerNudges(node))
		case "CaseValue":
			return offer(node, position, caseSwaps(node, context))
		default:
			return node
	}
}

// NOTE: `+1`, `−1` and `→0`, in that order — the off-by-one either way and the
// boundary. Repeats are dropped rather than counted: a literal `1` nudged down
// and a literal `1` taken to zero are the SAME mutant, and a literal `0` taken
// to zero is the Program itself, which nothing can kill and which would be
// reported as a survivor for ever.
function integerNudges(
	node: common.typedSimple.IntegerValueNode,
): Array<ExpressionCandidate> {
	let value: bigint

	try {
		value = BigInt(node.value)
	} catch {
		// NOTE: A literal the Lexer accepted is a literal `BigInt` reads, so
		// this is unreachable — and it is here because the field is a String
		// and a throw out of a walk would take a whole compile with it.
		return []
	}

	let nudges = [...new Set([value + 1n, value - 1n, 0n])].filter(
		(nudged) => nudged !== value,
	)

	return nudges.map((nudged) => ({
		operator: "integer" as const,
		description: `swap ${node.value} for ${nudged}`,
		rewrite: (): common.typedSimple.ExpressionNode => ({
			...node,
			value: nudged.toString(),
		}),
	}))
}

// NOTE: A construction swapped for a SIBLING Case of the same Choice. It is the
// operator an exhaustive language makes possible and a line-counting one can
// not: the Cases are a closed set, so "no test notices this being a #Draw" is a
// complete statement rather than a guess.
function caseSwaps(
	node: common.typedSimple.CaseValueNode,
	context: MutationContext,
): Array<ExpressionCandidate> {
	if (node.type.type !== "Case") {
		return []
	}

	let sibling = nextSibling(node.type, context)

	if (sibling === null) {
		return []
	}

	return [
		{
			operator: "case",
			description: `swap #${node.type.name} for #${sibling.name}`,
			rewrite: (): common.typedSimple.ExpressionNode => ({
				...node,
				tag: `${sibling.choice}#${sibling.name}`,
				type: sibling,
			}),
		},
	]
}

// NOTE: The next Case of the Choice in DECLARATION order, wrapping around, with
// the same member names. Payload-free swaps freely with payload-free; anything
// else has to carry the very members the construction already built, because
// the payload Expression is kept as it stands and a Case that wanted other
// names would be handed a Record that has none of them.
//
// NOTE: One sibling rather than all of them. A Choice of six Cases would
// otherwise put five mutants on one construction, each of them a compile and a
// run, to answer a question the first one answers.
function nextSibling(
	type: common.CaseType,
	context: MutationContext,
): common.CaseType | null {
	let siblings = context.choices.get(type.choice)

	if (siblings === undefined) {
		return null
	}

	let index = siblings.findIndex((each) => each.name === type.name)

	if (index === -1) {
		return null
	}

	let members = Object.keys(type.members).join(",")

	for (let step = 1; step < siblings.length; step++) {
		let candidate = siblings[(index + step) % siblings.length]!

		if (Object.keys(candidate.members).join(",") === members) {
			return candidate
		}
	}

	return null
}

// NOTE: The three families of Method-name swap, offered in one order so that a
// call site's sites are the same sites every time they are counted.
function memberSwaps(
	node: common.typedSimple.MethodInvocationNode,
	context: MutationContext,
): Array<ExpressionCandidate> {
	let member = withoutOverloadSuffix(node.member.name)
	let families: Array<[MutationOperator, Array<string>]> = [
		["equality", EQUALITY_SWAPS.get(member) ?? []],
		["comparison", COMPARISON_SWAPS.get(member) ?? []],
		["arithmetic", ARITHMETIC_SWAPS.get(member) ?? []],
	]
	let swaps: Array<ExpressionCandidate> = []

	// NOTE: Nothing inside the condition of a NARROWING `if`, for the reason
	// that already leaves the doorway itself alone: `if n::isNot(0)` is what
	// typed the body it opens, and a mutant that asks a different question
	// there runs a body against a refinement nobody proved — which fails
	// everything it touches and distinguishes no suite from another. It is the
	// same set the branch swap consults, asked of the condition and of every
	// Node the condition is written out of, because a condition is read as a
	// conjunction and the narrowing leaves of one are nested inside it.
	if (context.narrowed.has(node)) {
		return []
	}

	for (let [operator, targets] of families) {
		for (let target of targets) {
			let name = swappableMember(node, member, target, context)

			if (name === null) {
				continue
			}

			swaps.push({
				operator,
				description: `swap ::${member} for ::${target}`,
				rewrite: (): common.typedSimple.ExpressionNode => ({
					...node,
					member: { name },
				}),
			})
		}
	}

	return swaps
}

// NOTE: The mangled name to call INSTEAD, or null where this swap can not be
// shown to be sound. It is the whole of what keeps a mutant honest: a mutated
// Program is never enriched again, so a swap onto a member the Namespace does
// not declare would emit a call to `undefined` and be counted as killed by
// whichever test happened to reach it — a false kill, which is the one answer a
// mutation score must never give.
//
// NOTE: A Method a PROTOCOL provided is answered by the Protocol rather than by
// the Namespace named on the call: `5::isNot(3)` is `Integer`'s conformance
// reaching `Equatable`'s one body. So the swap is sound exactly when the SAME
// Protocol wrote a body for the target — that body is the Function the emitted
// call names, and a target the Protocol merely REQUIRES has no body anywhere to
// name. `Equatable` requires `is` and provides `isNot`, so a provided `isNot`
// has nowhere to rotate to; `Orderable` provides all four comparisons, so a
// user Type that conforms to it offers the same rotations a builtin does.
//
// NOTE: Asked of the standard library's Protocol table, which is the only one
// in reach here — the walk runs on a SIMPLIFIED Program and the Enricher's
// Scope, where a Module's own Protocols live, is long gone by then. A Method a
// Module's own Protocol provided is refused rather than guessed at, and it
// becomes swappable when the sites a Module offers do.
function swappableMember(
	node: common.typedSimple.MethodInvocationNode,
	member: string,
	target: string,
	context: MutationContext,
): string | null {
	let overload = overloadIndexOf(node.member.name)

	if (node.providedBy !== undefined) {
		// NOTE: And never where the call site was MANGLED. A provided Method is
		// emitted under its plain name, so a mangled call is one whose Protocol
		// declared Overloads and whose target's slot is not this one's to
		// assume.
		return overload === null && provides(node.providedBy, target)
			? target
			: null
	}

	let declared = context.namespaces.get(node.base.name)

	if (declared === undefined) {
		return null
	}

	// NOTE: A Namespace the MODULE declares carries its Methods already
	// mangled, so the name to call is the name to look for. A builtin carries a
	// Method TYPE per member, and the index the call site was mangled with has
	// to be a slot that Method actually has: two members of one Namespace need
	// not have the same number of Overloads, and calling the fourth Overload of
	// a Method that has two is calling nothing at all.
	//
	// NOTE: Both of them check the ARITY, and for one reason: the Arguments the
	// call site already wrote are handed on untouched. Two Methods that happen
	// to share a slot need not take the same number of values, and a swap onto
	// one that does not would crash wherever it ran — which this run would
	// record as a KILL the tests never earned, the one answer this file's own
	// header forbids.
	if (declared.kind === "module") {
		let name =
			overload === null
				? target
				: resolveOverloadedMethodName(target, overload)
		let replacement = ownMethod(declared.methods, name)
		let original = ownMethod(declared.methods, node.member.name)

		return replacement !== undefined &&
			original !== undefined &&
			replacement.isStatic === original.isStatic &&
			replacement.method.value.parameters.length ===
				original.method.value.parameters.length
			? name
			: null
	}

	let method = ownMethod(declared.methods, target)

	if (method === undefined) {
		return null
	}

	if (overload === null) {
		return method.type === "SimpleMethod" || method.type === "StaticMethod"
			? target
			: null
	}

	if (
		method.type !== "OverloadedMethod" &&
		method.type !== "OverloadedStaticMethod"
	) {
		return null
	}

	let replacement = method.overloads[overload]
	let original = ownMethod(declared.methods, member)

	if (
		replacement === undefined ||
		original === undefined ||
		original.type !== method.type
	) {
		return null
	}

	// NOTE: The two Overloads have to take the same number of values, because
	// the Arguments the call site already wrote are handed on untouched. The
	// LABELS need not agree — `multiply(with 2)` and `add(2)` are one emitted
	// call each, positional by the time anything runs — and the Types are the
	// same by the way these families are written: every member in them is
	// declared over the same operand Types in the same order.
	let originalOverload = original.overloads[overload]

	return originalOverload !== undefined &&
		originalOverload.parameterTypes.length ===
			replacement.parameterTypes.length
		? resolveOverloadedMethodName(target, overload)
		: null
}

// NOTE: `hasOwn` and not a bare read, for the reason the tables above are Maps:
// `methods["toString"]` answers out of `Object.prototype` for a Namespace that
// declares no such Method, and the answer is a Function no call site could ever
// reach.
function ownMethod<Method>(
	methods: Record<string, Method>,
	name: string,
): Method | undefined {
	return Object.hasOwn(methods, name) ? methods[name] : undefined
}

// NOTE: Whether a Protocol wrote the BODY this swap would call. `providedMethods`
// names the Protocol each provided Method belongs to, and it has to be this one:
// a name an ancestor wrote is emitted under the ancestor's, so a swap onto it
// from here would name a Function that is not there.
function provides(protocolName: string, member: string): boolean {
	return (
		ownMethod(builtinProtocols(), protocolName)?.providedMethods?.[
			member
		] === protocolName
	)
}

// #endregion

// #region What the walk has to know

// NOTE: A Namespace as this Module can see it: the one it DECLARES, whose
// mangled member names are simply the keys it emitted, or a BUILTIN, whose
// Method Types the standard library snapshot has already answered. A Namespace
// imported from another Module of the graph is neither, and a swap aimed at one
// is refused — the sites a Module offers improve when this does.
type KnownNamespace =
	| { kind: "module"; methods: common.typedSimple.Methods }
	| { kind: "builtin"; methods: Record<string, common.MethodType> }

type MutationContext = {
	namespaces: Map<string, KnownNamespace>
	// NOTE: Every Choice this Module can name a Case of, in DECLARATION order,
	// with each Case's whole Type — which is what a swap needs and a tag alone
	// can not give. Read out of the Module's own Type Aliases the way
	// `instrument-coverage` reads them, and topped up from the constructions
	// themselves so that a Choice declared in another Module is still swappable
	// among the Cases this one builds.
	choices: Map<string, Array<common.CaseType>>
	// NOTE: Every Node the condition of a NARROWING `if` is written out of, the
	// condition itself included. It is one set because it answers one question
	// asked in two places — see `mutateStatement` and `memberSwaps` — and it is
	// gathered here because the walk that offers sites reaches a condition's
	// Nodes before it reaches the `if` they belong to.
	narrowed: Set<common.typedSimple.ExpressionNode>
}

// NOTE: One context per Program, kept. A mutation run walks ONE simplified
// Program once to enumerate its sites and once more per mutant it compiles out
// of it — hundreds of times, on the same object, through a Session that holds
// that object for the length of the run. What the context reads is a whole
// second walk of the Module plus the standard library's Namespace table, and
// none of it can have changed: the walk never mutates the Program it is handed.
//
// NOTE: A WeakMap, so a Program a Session has finished with takes its context
// with it rather than pinning it for the length of the process.
const CONTEXTS = new WeakMap<common.typedSimple.Program, MutationContext>()

function contextOf(program: common.typedSimple.Program): MutationContext {
	let held = CONTEXTS.get(program)

	if (held !== undefined) {
		return held
	}

	let context = readContext(program)

	CONTEXTS.set(program, context)

	return context
}

function readContext(program: common.typedSimple.Program): MutationContext {
	let namespaces = new Map<string, KnownNamespace>()

	for (let namespace of builtinNamespaces()) {
		namespaces.set(namespace.name, {
			kind: "builtin",
			methods: namespace.methods,
		})
	}

	let choices = new Map<string, Array<common.CaseType>>()

	let remember = (type: common.CaseType): void => {
		let held = choices.get(type.choice)

		if (held === undefined) {
			choices.set(type.choice, [type])

			return
		}

		if (!held.some((each) => each.name === type.name)) {
			held.push(type)
		}
	}

	let narrowed = new Set<common.typedSimple.ExpressionNode>()

	// NOTE: The declared Choices FIRST, so a Choice this Module declares is
	// ordered the way it was written rather than the way it happens to be
	// constructed — which is what makes "the next sibling" a reader's next
	// sibling.
	rewriteNodes(
		{ ...program, tests: null },
		{
			statement: (node) => {
				if (node.nodeType === "NamespaceDefinitionStatement") {
					namespaces.set(node.name.name, {
						kind: "module",
						methods: node.methods,
					})
				}

				if (node.nodeType === "TypeAliasStatement") {
					for (let type of declaredCases(node.type, node.name.name)) {
						remember(type)
					}
				}

				// NOTE: `narrows` is spelled HERE and nowhere else. What the
				// walk needs is not "is this `if` a doorway" but "may this Node
				// be mutated", and the two are one question with one answer.
				if (node.nodeType === "ConditionalStatement" && node.narrows) {
					collectCondition(program, node.condition, narrowed)
				}

				return node
			},
			expression: (node) => {
				if (
					node.nodeType === "CaseValue" &&
					node.type.type === "Case"
				) {
					remember(node.type)
				}

				return node
			},
		},
	)

	return { namespaces, choices, narrowed }
}

// NOTE: Every Node of one condition, gathered by walking it as a Program of its
// own — an Expression IS an `ImplementationNode`, so the walk that reads a whole
// Module reads one Expression without a second walker being written for it. The
// hook answers with the Node it was handed, so nothing is rebuilt and the
// identities the mutation walk will meet are the identities gathered here.
function collectCondition(
	program: common.typedSimple.Program,
	condition: common.typedSimple.ExpressionNode,
	found: Set<common.typedSimple.ExpressionNode>,
): void {
	rewriteNodes(
		{
			...program,
			implementation: { ...program.implementation, nodes: [condition] },
			tests: null,
		},
		{
			expression: (node) => {
				found.add(node)

				return node
			},
		},
	)
}

// NOTE: A Choice's own Cases, read off the Type Alias it erased to — the same
// reading `instrument-coverage` does, and for the same reason: what tells a
// Choice from an ordinary alias is that its Union is Cases, that they all
// belong to one Choice, and that the Choice is the one the alias names.
function declaredCases(
	type: common.Type,
	name: string,
): Array<common.CaseType> {
	if (type.type === "GenericAlias") {
		return declaredCases(type.aliasedType, name)
	}

	if (type.type !== "UnionType" || type.types.length === 0) {
		return []
	}

	let cases: Array<common.CaseType> = []

	for (let member of type.types) {
		if (member.type !== "Case" || member.choice !== name) {
			return []
		}

		cases.push(member)
	}

	return cases
}

// #endregion
