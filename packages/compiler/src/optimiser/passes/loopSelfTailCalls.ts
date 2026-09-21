import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { rewriteExpressionsIn, rewriteNodes } from "../walk"

// NOTE: Essence has no loop Statement, so the walk the language teaches is
// written as recursion — take the head, answer with the walk of the tail:
//
//   function total(_ rest: List<Integer>, _ sum: Integer) -> Integer {
//       <- match rest::firstItem() -> Integer {
//           case #Empty       { <- sum }
//           case #Value(head) { <- total(rest::removeFirst(), sum::add(head)) }
//       }
//   }
//
// and emitted as a genuinely self-recursive JavaScript Function. JavaScriptCore
// eliminates the frame, so Bun runs that at a hundred thousand items; V8 does
// not, so Node and Deno — both supported hosts, both running the very same
// bundle — throw `RangeError: Maximum call stack size exceeded` at ten thousand.
// A Program that is linear on one supported host and a crash on another is not
// portable, and the language is what makes the shape idiomatic.
//
// NOTE: So the call is not made. A call standing in TAIL POSITION — the answer
// of the Function, with nothing left to do with what it gives back — can not
// observe the frame it would have been given, because that frame does nothing
// but hand the answer straight on. Rebinding the Parameters and taking the body
// from the top says the same thing with one frame:
//
//   function total(rest, sum) {
//       $tail_0: while (true) {
//           …
//           const $tail_0_t0 = removeFirst(rest);
//           rest = $tail_0_t0; sum = …; continue $tail_0;
//       }
//   }
//
// NOTE: TAIL POSITION is a question about the SIMPLIFIED Program, and the answer
// is exactly: the Expression of a Return Statement that returns from THIS
// Function. A Match lowered into Return position holds such Returns in its
// Handlers and a Conditional inside one holds them in its branches, which is
// what makes the walk above a tail call at all; a `define` standing there is
// written out into the ladder of Conditionals it means, because its arms answer
// where it stands. A Return inside a lowered Statement that writes its answer
// somewhere ELSE does not return from the Function, and neither does one inside
// a callback an inlined loop drives or inside a Function literal — so none of
// those is descended into. Anything else the answer is built FROM —
// `f(…)::add(1)`, an Argument of another call, a `complete` — is a call whose
// answer is still worked on, and is left exactly as it was.
//
// NOTE: What the pass must get right is that a turn is a CALL. Every Argument is
// evaluated before any Parameter is rebound, so `<- swap(b, a)` swaps rather
// than writing `a` over `b` and reading it back; a Parameter the call leaves out
// takes its default AFRESH, in the turn it belongs to, reading the Parameters
// before it as that turn bound them; and the whole body runs from the top,
// prologue included, so a Pattern in a Parameter binds again.
//
// NOTE: And that a JavaScript closure captures the VARIABLE. A Parameter a
// Function literal in the body mentions may not be assigned under the closure's
// feet, or a closure built in one turn would read the next turn's value. The
// same is true of a Parameter whose name is SHADOWED where the tail call stands
// — which the receiver `_self` always is inside a Match Handler, since `@` there
// is the matched value. Both are answered the same way: that Parameter is
// renamed to a SLOT the loop assigns, and the name the body reads becomes a
// `const` of the turn. One binding per turn, so what a closure captured stays
// what it captured, and an assignment can not land on a Handler's own binding.
// Parameters needing neither are assigned where they stand, which is what keeps
// the emission of the ordinary walk to the `while` and nothing else.
//
// NOTE: A non-tail self call is left alone — `fib` calls itself twice and only
// the second could ever be one — so a body holding both is looped for the one
// and still recurses for the other. That is why the Function keeps its name, its
// Parameters and its defaults: it is still a Function anything may call.
//
// NOTE: What this pass does NOT do: mutual recursion, which needs a trampoline
// and a decision about what a stack trace should then say; and a COMPLETING
// body, which is declined outright. `complete self(…)` puts the call inside
// `$future.complete(…)`, so it is an Argument and never a tail call — a
// completing body has no tail self call to find — and taking a turn inside the
// current run would give it the run's own cancellation context instead of one of
// its own, which is a different Program.
//
// NOTE: And a Function literal standing in a Parameter's DEFAULT, where the
// literal reads a Parameter a turn rebinds. A default is taken again per turn
// like every other, but it is evaluated where the turn ASSIGNS — so the closure
// it builds captures the loop's own variable, and there is no binding of the
// turn in front of it to capture instead. That is declined outright rather than
// looped a second way, and it is the one shape where a Parameter being CAPTURED
// is answered by declining rather than by a slot.
//
// NOTE: It also declines where the answer is still an EXPRESSION holding
// Statements, which is what a Match in Return position is until
// `lower-matches-to-statements` has run. With that pass off there is no Return
// of this Function to find inside the chain, so this one finds no site and
// changes nothing — less optimisation, which is what turning a pass off means.

export const loopSelfTailCalls: OptimiserPass = {
	name: "loop-self-tail-calls",
	run: (program) => {
		let looping = new Looping()

		return rewriteNodes(program, {
			statement: (node) => looping.statement(node),
		})
	},
}

type ImplementationNode = common.typedSimple.ImplementationNode
type ExpressionNode = common.typedSimple.ExpressionNode
type ParameterNode = common.typedSimple.ParameterNode
type FunctionDefinitionNode = common.typedSimple.FunctionDefinitionNode
type ReturnStatementNode = common.typedSimple.ReturnStatementNode
type MethodInvocationNode = common.typedSimple.MethodInvocationNode
type TailCallBinding = common.typedSimple.TailCallBinding
type SelfCallNode =
	| common.typedSimple.FunctionInvocationNode
	| MethodInvocationNode

// NOTE: Which Function a call has to name to be a call to ITSELF. A free
// Function is named by the Identifier a Function Invocation holds; a Namespace
// Method — static or not, the receiver being Parameter zero either way — by the
// Namespace and the Method Invocation's already-Overload-mangled member, so a
// call to a DIFFERENT Overload of the same name names a different member and is
// not a self call.
//
// NOTE: There is no third entry. A Function literal bound to a Constant can not
// call itself at all — the Enricher answers `'f' is not declared` inside its own
// initialiser — and a Protocol's PROVIDED Method reaches itself through
// `Self__conformance`, a call a conformer may override and so not a call to this
// body.
type SelfIdentity =
	| { kind: "function"; name: string }
	| { kind: "method"; namespace: string; member: string }

// NOTE: One Argument of one tail call, against the Parameter it stands for.
// `omitted` covers both spellings of leaving one out: the `omitted-argument`
// intrinsic that holds a position open, and an Argument list that simply stops
// short of the Parameters with defaults at its end.
type TailArgument =
	| { kind: "written"; value: ExpressionNode }
	| { kind: "omitted" }

// NOTE: One tail call found, with the names SHADOWED where it stands — every
// name an enclosing block binds between the Function's body and this Statement,
// the `_self` a lowered Match binds for its Handlers above all. What a name
// means at a tail call is the whole of what decides how the rebinding is
// written.
type TailSite = {
	shadowed: ReadonlySet<string>
	arguments: Array<TailArgument>
}

class Looping {
	// NOTE: Numbered across the whole Program, so a Function looped inside
	// another Function's body can not declare the label that one is taking its
	// turns through.
	private count = 0

	statement(node: ImplementationNode): ImplementationNode {
		if (node.nodeType === "FunctionStatement") {
			let value = this.looped(node.value, {
				kind: "function",
				name: node.name.name,
			})

			return value === null ? node : { ...node, value }
		}

		if (node.nodeType !== "NamespaceDefinitionStatement") {
			return node
		}

		let looped: common.typedSimple.Methods | undefined

		for (let [member, entry] of Object.entries(node.methods)) {
			let value = this.looped(entry.method.value, {
				kind: "method",
				namespace: node.name.name,
				member,
			})

			if (value === null) {
				continue
			}

			looped ??= { ...node.methods }
			looped[member] = { ...entry, method: { ...entry.method, value } }
		}

		return looped === undefined ? node : { ...node, methods: looped }
	}

	// NOTE: One Function, and null wherever it is left exactly as it was — which
	// is every Function with no tail call to itself, and every one a loop can not
	// be proven to say the same thing as.
	private looped(
		definition: FunctionDefinitionNode,
		identity: SelfIdentity,
	): FunctionDefinitionNode | null {
		if (definition.completing === true) {
			return null
		}

		let parameters = definition.parameters
		let names = parameters.map((parameter) => parameter.internalName.name)

		// NOTE: A Parameter shadows the Function's own name for the whole body,
		// so a Program whose Parameter is called like the Function it stands in
		// — or, for a Method, like the Namespace — makes no self call anywhere
		// in it.
		if (
			names.includes(
				identity.kind === "function"
					? identity.name
					: identity.namespace,
			)
		) {
			return null
		}

		// NOTE: EMPTY, because what this set answers is "does this name mean
		// something OTHER than what it means at the head of the body" — and at
		// the head of the body a Parameter means itself.
		let outer: ReadonlySet<string> = new Set()
		let rebuilt = rebuiltParameters(definition.body, names)
		let sites: Array<TailSite> = []

		descendReturns(definition.body, outer, (node, shadowed) => {
			for (let call of tailCallsOf(node.expression, identity, shadowed)) {
				let args = alignedArguments(call, parameters, rebuilt)

				if (args !== null) {
					sites.push({ shadowed, arguments: args })
				}
			}

			return null
		})

		if (sites.length === 0) {
			return null
		}

		let plan = planOf(definition, parameters, names, sites, rebuilt)

		if (plan === null) {
			return null
		}

		let label = `${labelPrefix}${this.count++}`
		let temporaries = 0
		let temporary = () => `${label}${temporaryInfix}${temporaries++}`
		let body = descendReturns(definition.body, outer, (node, shadowed) =>
			tailAnswer(node.expression, node.position, {
				identity,
				shadowed,
				plan,
				label,
				temporary,
			}),
		)

		return {
			...definition,
			parameters: parameters.map((parameter, index) =>
				plannedParameter(parameter, plan, index),
			),
			body: [...perTurnCopies(parameters, plan), ...body],
			tailLoop: label,
		}
	}
}

// NOTE: Unspellable in Essence, like every other name the Compiler binds for
// itself: the Lexer reads `_` as a Symbol, so no name a Program can write holds
// one. `$tail_3` is the label and `$tail_3_t0` an Argument held until every
// Argument of its turn has been evaluated; a slot is the Parameter's own name
// with `_p` after it, so that a stack frame still says which Parameter is which.
const labelPrefix = "$tail_"
const temporaryInfix = "_t"
const slotSuffix = "_p"
const selfName = "_self"

// NOTE: What was decided about a Function's Parameters once every tail call in
// it has been read.
type LoopPlan = {
	// NOTE: The Parameters as the Function DECLARES them, before any slotting —
	// read for the one thing a turn needs of a Parameter it has no value for:
	// the Type the hole it hands over carries. Named for that: what the Function
	// ends up with is `plannedParameter` of each of these.
	declaredParameters: Array<ParameterNode>
	// NOTE: The names the BODY reads its Parameters under, which slotting never
	// changes: a slotted Parameter's name becomes a `const` of the turn.
	names: Array<string>
	// NOTE: Per Parameter, the slot it is rebound through, or null where it is
	// assigned where it stands. A Parameter no turn rebinds is null too, and is
	// never assigned at all.
	slots: Array<string | null>
	// NOTE: The default each Parameter takes again when a turn leaves it out,
	// read under the slot names — a default is evaluated at the head of a turn
	// as well as at a real call, and both times it must read what the turn bound.
	fallbacks: Array<ExpressionNode | null>
	// NOTE: The Parameters some turn rebinds WHERE THEY STAND — the names an
	// Argument may therefore read the old value of, which is what decides
	// whether a turn has to hold its Arguments before it assigns any of them.
	directlyAssigned: ReadonlySet<string>
	// NOTE: The Parameters the BODY itself writes at its head, which today is
	// exactly the Record-defaulted ones: a PARTIAL default is not a value the
	// Parameter list can hold, so the Simplifier leaves the Parameter required
	// and rebuilds it member by member in a prologue. Two things follow. A turn
	// that leaves such a Parameter out hands it `undefined` — the very thing a
	// call that wrote no Argument hands it — and the prologue, which the loop
	// runs again like every other Statement of the body, rebuilds it from the
	// default. And its per-turn copy is a `let`, because the prologue assigns it.
	rebuilt: ReadonlySet<number>
}

// NOTE: The hole a call leaves where it wrote no Argument, which is what a turn
// assigns to a Parameter the body rebuilds for itself. It is the one place
// `undefined` is deliberately written into emitted code, and it never becomes a
// value: the prologue at the head of the next turn consumes it before anything
// reads the name.
function omittedArgument(
	parameter: ParameterNode,
): common.typedSimple.OmittedArgumentNode {
	return {
		nodeType: "Intrinsic",
		kind: "omitted-argument",
		type: parameter.internalName.type,
	}
}

// NOTE: The plan, or null where this Function may not be looped at all.
function planOf(
	definition: FunctionDefinitionNode,
	parameters: Array<ParameterNode>,
	names: Array<string>,
	sites: Array<TailSite>,
	rebuilt: ReadonlySet<number>,
): LoopPlan | null {
	let assigned = new Set<number>()
	let slotted = new Set<number>()

	for (let site of sites) {
		for (let index = 0; index < parameters.length; index++) {
			if (!rebinds(site, index, names[index]!)) {
				continue
			}

			assigned.add(index)

			// NOTE: The name means something else where this call stands, so an
			// assignment would land on that something else — a Match Handler's
			// `_self`, a Constant of an enclosing block. The slot is the
			// Compiler's own name and is shadowed by nothing.
			if (site.shadowed.has(names[index]!)) {
				slotted.add(index)
			}

			// NOTE: And a default this turn takes again reads the Parameters
			// before it BY NAME where the call stands. One of those that is
			// shadowed there goes through a slot for the same reason.
			if (site.arguments[index]?.kind !== "omitted") {
				continue
			}

			let fallback = parameters[index]!.defaultValue

			for (let earlier = 0; earlier < index; earlier++) {
				if (
					fallback !== null &&
					site.shadowed.has(names[earlier]!) &&
					mentionsAnyName(fallback, new Set([names[earlier]!]))
				) {
					slotted.add(earlier)
				}
			}
		}
	}

	// NOTE: A Parameter's DEFAULT is taken again at the head of every turn, but
	// it is evaluated where the turn ASSIGNS — it IS what a turn assigns — so a
	// Function literal standing in one closes over the variable the loop
	// rebinds, and not over a binding of the turn. A literal in the BODY has the
	// turn's `const` in front of it to capture; a literal in a default stands
	// where there is no such binding to make, whichever way the Parameter it
	// reads is rebound: assigned where it stands it is the one shared variable,
	// and slotted it is read through the slot, which is the variable the loop
	// assigns. So a default whose literal mentions a Parameter some turn rebinds
	// DECLINES the whole Function. Looping it would answer with the last turn's
	// value from every closure an earlier turn built, which is the failure the
	// capture rule exists to prevent — and declining is the answer, rather than
	// evaluating the default into a `const` of its own, because a turn would
	// then bind a name the Parameter list has already bound.
	//
	// NOTE: Asked of the names the literal MENTIONS and not of the literal,
	// because a default that closes over nothing — `= () -> Integer { <- 7 }` —
	// builds per turn exactly the closure a call builds per call.
	let rebound = new Set([...assigned].map((index) => names[index]!))

	for (let parameter of parameters) {
		if (parameter.defaultValue === null) {
			continue
		}

		for (let name of capturedNames(parameter.defaultValue)) {
			if (rebound.has(name)) {
				return null
			}
		}
	}

	// NOTE: A Parameter a Function literal in the body mentions is CAPTURED, and
	// a JavaScript closure captures the variable rather than its value — so a
	// turn that assigned it would rewrite what a closure an earlier turn built
	// reads. The slot holds the rebinding; the body's name becomes a `const` of
	// the turn, which is the binding the closure captures.
	//
	// NOTE: THE BODY, and only the body. A literal in a Parameter default is not
	// answered by a slot at all — it is declined above — so the one capture a
	// slot has to hold is one standing where the turn's `const` can stand in
	// front of it.
	let captured = capturedNames(definition.body)

	for (let index of assigned) {
		if (captured.has(names[index]!)) {
			slotted.add(index)
		}
	}

	let renames = new Map<string, string>()
	let slots = names.map((name, index) => {
		if (!slotted.has(index)) {
			return null
		}

		let slot = `${name}${slotSuffix}`

		renames.set(name, slot)

		return slot
	})

	if (renames.size > 0) {
		// NOTE: The Parameter's own name becomes a `const` at the head of the
		// loop body, so a body declaring that name in the same block would
		// declare it twice. Nothing in Essence can — a Constant may not shadow a
		// Parameter in the Parameter's own Scope — and the check is here because
		// the emission would be a `SyntaxError` rather than a wrong answer if
		// that ever stopped being true.
		for (let name of renames.keys()) {
			if (bindsAtTopLevel(definition.body, name)) {
				return null
			}
		}
	}

	let fallbacks: Array<ExpressionNode | null> = []

	for (let parameter of parameters) {
		let fallback = parameter.defaultValue

		if (fallback === null || renames.size === 0) {
			fallbacks.push(fallback)

			continue
		}

		// NOTE: A default that has to be read under the new names is renamed
		// wholesale, which is right only while nothing inside it binds one of
		// those names again. A Match binds `_self` for its Handlers and a
		// Function literal binds its own Parameters, so a default holding either
		// declines the whole Function rather than being renamed through a Scope
		// this pass does not track.
		if (mentionsAnyName(fallback, new Set(renames.keys()))) {
			if (bindsInside(fallback)) {
				return null
			}

			fallbacks.push(renamed(fallback, renames))

			continue
		}

		fallbacks.push(fallback)
	}

	let directlyAssigned = new Set<string>()

	for (let index of assigned) {
		if (slots[index] === null) {
			directlyAssigned.add(names[index]!)
		}
	}

	return {
		declaredParameters: parameters,
		names,
		slots,
		fallbacks,
		directlyAssigned,
		rebuilt,
	}
}

// NOTE: The Parameters the body assigns at its own head. The Simplifier writes
// one such assignment, and only one: a Parameter whose default is a RECORD keeps
// no default in the Parameter list, because what it means is member by member —
// `options.retries ?? 3` — so the Parameter is rebuilt from whatever arrived
// before the first Statement the author wrote. Asked by NAME at the top level,
// which is where the prologue stands and the only place such an assignment can
// be: Essence has no assignable Parameter, so a `variable` never reaches one.
function rebuiltParameters(
	nodes: Array<ImplementationNode>,
	names: Array<string>,
): ReadonlySet<number> {
	let rebuilt = new Set<number>()

	for (let node of nodes) {
		if (node.nodeType !== "VariableAssignmentStatement") {
			continue
		}

		let index = names.indexOf(node.name.name)

		if (index >= 0) {
			rebuilt.add(index)
		}
	}

	return rebuilt
}

// NOTE: Whether this turn CHANGES the Parameter at `index`. A written Argument
// that is the Parameter's own name, meaning that Parameter where the call
// stands, leaves it exactly as it was — which is what a Method walking on the
// same receiver writes for `@` — and assigning a value to itself is work with no
// answer.
function rebinds(site: TailSite, index: number, name: string): boolean {
	let argument = site.arguments[index]

	if (argument === undefined) {
		return false
	}

	// NOTE: An omitted Argument takes the default AGAIN. It is a rebinding even
	// where the default is a literal, because the language says a default is
	// evaluated per call and a turn is a call.
	if (argument.kind === "omitted") {
		return true
	}

	return !(
		argument.value.nodeType === "Identifier" &&
		argument.value.name === name &&
		!site.shadowed.has(name)
	)
}

function plannedParameter(
	parameter: ParameterNode,
	plan: LoopPlan,
	index: number,
): ParameterNode {
	let slot = plan.slots[index]!
	let fallback = plan.fallbacks[index]!

	if (slot === null) {
		return fallback === parameter.defaultValue
			? parameter
			: { ...parameter, defaultValue: fallback }
	}

	return {
		...parameter,
		// NOTE: No Position on the slot. The name a reader wrote is on the
		// `const` the turn binds, which is the binding the body reads and the one
		// a debugger should point at.
		internalName: {
			nodeType: "Identifier",
			name: slot,
			type: parameter.internalName.type,
		},
		defaultValue: fallback,
	}
}

// NOTE: `const rest = rest_p;` at the head of every turn — one binding per turn,
// which is what a closure built in that turn captures, and a name an assignment
// made inside a Handler can not reach.
function perTurnCopies(
	parameters: Array<ParameterNode>,
	plan: LoopPlan,
): Array<ImplementationNode> {
	let copies: Array<ImplementationNode> = []

	for (let index = 0; index < parameters.length; index++) {
		let slot = plan.slots[index]!

		if (slot === null) {
			continue
		}

		let parameter = parameters[index]!

		copies.push({
			nodeType: "VariableDeclarationStatement",
			name: parameter.internalName,
			value: {
				nodeType: "Identifier",
				name: slot,
				type: parameter.internalName.type,
			},
			type: parameter.internalName.type,
			// NOTE: A `let` for the one Parameter the body writes itself — the
			// prologue that rebuilds a Record default assigns the name, and a
			// `const` would make that a TypeError rather than a merge.
			isConstant: !plan.rebuilt.has(index),
		})
	}

	return copies
}

// NOTE: Everything one tail call has to be written from, gathered so that the
// three shapes an answer can take pass it on rather than each declaring it.
type Turn = {
	identity: SelfIdentity
	shadowed: ReadonlySet<string>
	plan: LoopPlan
	label: string
	temporary: () => string
}

// NOTE: One Expression standing where the Function's answer goes. Three things
// can be there: the call itself; a counter IN FRONT of the call, which `essence
// test --coverage` writes and which is written out as the Statement it always
// was so every turn still counts what it ran; and a `define`, whose arms answer
// where it stands. Everything else answers null and is left alone.
function tailAnswer(
	expression: ExpressionNode,
	position: common.Position | undefined,
	turn: Turn,
): Array<ImplementationNode> | null {
	let call = selfCallOf(expression, turn.identity, turn.shadowed)

	if (call !== null) {
		let statement = tailCallStatement(call, position, turn)

		return statement === null ? null : [statement]
	}

	if (
		expression.nodeType === "CoverageCounter" &&
		expression.leads &&
		expression.value !== null
	) {
		let rest = tailAnswer(expression.value, position, turn)

		if (rest === null) {
			return null
		}

		// NOTE: The counter LEADS, so it already ran in front of what it counts
		// — standing on its own in front of it says the same thing, and is the
		// shape a counter in Statement position has anyway.
		return [
			{ ...expression, value: null },
			...rest,
		] satisfies Array<ImplementationNode>
	}

	return expression.nodeType === "Define"
		? defineLadder(expression, position, turn)
		: null
}

// NOTE: `<- define { as … if … as … otherwise }` as the Conditionals it means —
// written out only where an arm answers with a tail call, because a `define`
// answering with anything else is one Expression and stays one. The arms are
// asked in order and the first that holds answers, which is what a ladder of
// `if`/`else` does; an arm that is not a tail call keeps a Return of its own.
function defineLadder(
	node: common.typedSimple.DefineNode,
	position: common.Position | undefined,
	turn: Turn,
): Array<ImplementationNode> | null {
	let arms = node.arms.map((arm) => tailAnswer(arm.value, position, turn))
	let otherwise = tailAnswer(node.otherwise, position, turn)

	if (otherwise === null && arms.every((arm) => arm === null)) {
		return null
	}

	let returned = (value: ExpressionNode): Array<ImplementationNode> => [
		{ nodeType: "ReturnStatement", expression: value, position },
	]

	let body = otherwise ?? returned(node.otherwise)

	for (let index = node.arms.length - 1; index >= 0; index--) {
		let arm = node.arms[index]!

		body = [
			{
				nodeType: "ConditionalStatement",
				condition: arm.condition,
				narrows: arm.narrows,
				narrowsFalse: arm.narrowsBelow,
				conditionIsRaw: arm.conditionIsRaw,
				trueBody: arms[index] ?? returned(arm.value),
				falseBody: body,
				position,
			},
		]
	}

	return body
}

// NOTE: The turn itself: every Argument evaluated, then every Parameter the call
// changes rebound, then the body from the top.
function tailCallStatement(
	call: SelfCallNode,
	position: common.Position | undefined,
	turn: Turn,
): common.typedSimple.TailCallStatementNode | null {
	let { plan, shadowed } = turn

	// NOTE: The refusal `alignedArguments` makes on the reading walk, made again
	// here so the two can not disagree about what a turn is: a call carrying
	// more Arguments than the Function declares Parameters decided nothing about
	// the plan, and a turn written from it would quietly drop the Arguments the
	// plan has no Parameter for. No Program the Enricher accepted holds one —
	// this is the same defence as the sibling refusal below, and neither is
	// reachable from Essence.
	if (call.arguments.length > plan.names.length) {
		return null
	}

	let args: Array<TailArgument> = []

	for (let index = 0; index < plan.names.length; index++) {
		args.push(argumentAt(call, index))
	}

	let site: TailSite = { shadowed, arguments: args }
	let changing: Array<number> = []

	for (let index = 0; index < plan.names.length; index++) {
		if (rebinds(site, index, plan.names[index]!)) {
			changing.push(index)
		}
	}

	// NOTE: The one question that decides whether the Arguments have to be HELD:
	// can one of them read a Parameter that an earlier assignment has already
	// overwritten? A slotted Parameter never can — the body reads the turn's
	// `const` and the loop assigns the slot — so only the ones assigned where
	// they stand are asked about. A written Argument standing after one that was
	// left out has to be held as well: at a real call every Argument is
	// evaluated before any default fires.
	let holds = false
	let omitted = false

	for (let index of changing) {
		let argument = args[index]!

		if (argument.kind === "omitted") {
			omitted = true

			continue
		}

		if (omitted || mentionsAnyName(argument.value, plan.directlyAssigned)) {
			holds = true
		}
	}

	let bindings: Array<TailCallBinding> = []
	let assignments: Array<TailCallBinding> = []
	let held = new Map<number, ExpressionNode>()

	if (holds) {
		for (let index of changing) {
			let argument = args[index]!

			if (argument.kind === "omitted") {
				continue
			}

			let name = turn.temporary()

			bindings.push({ name, value: argument.value })
			held.set(index, {
				nodeType: "Identifier",
				name,
				type: argument.value.type,
			})
		}
	}

	for (let index of changing) {
		let argument = args[index]!
		let target = plan.slots[index] ?? plan.names[index]!

		if (argument.kind === "written") {
			assignments.push({
				name: target,
				value: held.get(index) ?? argument.value,
			})

			continue
		}

		let fallback = plan.fallbacks[index]

		if (fallback === null || fallback === undefined) {
			// NOTE: No default in the Parameter list means the body rebuilds
			// this Parameter at its head — so the turn hands it the same hole a
			// call that wrote no Argument hands it, and the prologue does the
			// rest. `alignedArguments` has already refused every other way a
			// Parameter can arrive here with nothing to bind.
			if (!plan.rebuilt.has(index)) {
				return null
			}

			assignments.push({
				name: target,
				value: omittedArgument(plan.declaredParameters[index]!),
			})

			continue
		}

		assignments.push({ name: target, value: fallback })
	}

	return {
		nodeType: "TailCallStatement",
		label: turn.label,
		bindings,
		assignments,
		position,
	}
}

// NOTE: Every self call ONE answer holds — the reading half of `tailAnswer`,
// and written beside it so the two can not disagree about what a turn is. The
// plan is decided from what this finds; if it found less, a turn would rebind a
// Parameter the plan never admitted was rebound.
function tailCallsOf(
	expression: ExpressionNode,
	identity: SelfIdentity,
	shadowed: ReadonlySet<string>,
): Array<SelfCallNode> {
	let call = selfCallOf(expression, identity, shadowed)

	if (call !== null) {
		return [call]
	}

	if (
		expression.nodeType === "CoverageCounter" &&
		expression.leads &&
		expression.value !== null
	) {
		return tailCallsOf(expression.value, identity, shadowed)
	}

	if (expression.nodeType !== "Define") {
		return []
	}

	return [
		...expression.arms.flatMap((arm) =>
			tailCallsOf(arm.value, identity, shadowed),
		),
		...tailCallsOf(expression.otherwise, identity, shadowed),
	]
}

// NOTE: The Argument standing for one Parameter. An Essence call is LABELLED and
// the Simplifier has already put the Arguments in Parameter order — the receiver
// at zero, the hidden conformance witnesses at the end — so the position IS the
// Parameter, and an Argument list stopping short of the Parameters with defaults
// at its end leaves each of those out.
function argumentAt(call: SelfCallNode, index: number): TailArgument {
	let argument = call.arguments[index]

	if (argument === undefined) {
		return { kind: "omitted" }
	}

	return argument.value.nodeType === "Intrinsic" &&
		argument.value.kind === "omitted-argument"
		? { kind: "omitted" }
		: { kind: "written", value: argument.value }
}

// NOTE: The Arguments of one call against the Parameters, or null where they do
// not line up — a call carrying more Arguments than the Function declares
// Parameters, or leaving out one that has no default. Neither can happen in a
// Program the Enricher accepted; the pass declines rather than assuming it.
function alignedArguments(
	call: SelfCallNode,
	parameters: Array<ParameterNode>,
	rebuilt: ReadonlySet<number>,
): Array<TailArgument> | null {
	if (call.arguments.length > parameters.length) {
		return null
	}

	let args: Array<TailArgument> = []

	for (let index = 0; index < parameters.length; index++) {
		let argument = argumentAt(call, index)

		// NOTE: A Parameter left out that has neither a default to take again
		// nor a prologue to rebuild it is one this pass can not say what a turn
		// would bind. No Program the Enricher accepted holds one.
		if (
			argument.kind === "omitted" &&
			parameters[index]!.defaultValue === null &&
			!rebuilt.has(index)
		) {
			return null
		}

		args.push(argument)
	}

	return args
}

// NOTE: Whether this Expression is a call to the Function it stands in, asked of
// the Node the answer is built from and of nothing below it: a self call one step
// down is a call whose answer is still worked on.
function selfCallOf(
	expression: ExpressionNode,
	identity: SelfIdentity,
	shadowed: ReadonlySet<string>,
): SelfCallNode | null {
	if (identity.kind === "function") {
		return expression.nodeType === "FunctionInvocation" &&
			expression.name.nodeType === "Identifier" &&
			expression.name.name === identity.name &&
			!shadowed.has(identity.name)
			? expression
			: null
	}

	// NOTE: `providedBy` says the Method came from a Protocol rather than from
	// this Namespace, and `derivedDescriptor` says it is a Choice's derived
	// Equatable — neither is the body this call stands in.
	return expression.nodeType === "MethodInvocation" &&
		expression.base.name === identity.namespace &&
		expression.member.name === identity.member &&
		expression.providedBy === undefined &&
		expression.derivedDescriptor === undefined &&
		!shadowed.has(identity.namespace)
		? expression
		: null
}

// NOTE: Every Return Statement that returns from THIS Function, offered with the
// names shadowed where it stands, and the body rebuilt from what the visitor
// answers. Null leaves the Statement as it is, which is what the reading walk
// always answers.
function descendReturns(
	nodes: Array<ImplementationNode>,
	shadowed: ReadonlySet<string>,
	visit: (
		node: ReturnStatementNode,
		shadowed: ReadonlySet<string>,
	) => Array<ImplementationNode> | null,
): Array<ImplementationNode> {
	let scope = new Set(shadowed)
	let result: Array<ImplementationNode> = []
	let changed = false

	for (let node of nodes) {
		let replacement = descendReturn(node, scope, visit)

		if (replacement === null) {
			result.push(node)
		} else {
			changed = true
			result.push(...replacement)
		}

		bindOf(node, scope)
	}

	return changed ? result : nodes
}

function descendReturn(
	node: ImplementationNode,
	shadowed: Set<string>,
	visit: (
		node: ReturnStatementNode,
		shadowed: ReadonlySet<string>,
	) => Array<ImplementationNode> | null,
): Array<ImplementationNode> | null {
	if (node.nodeType === "ReturnStatement") {
		// NOTE: A COPY, because the set goes on growing as the block is read and
		// the first walk keeps what it was handed to decide the plan with.
		return visit(node, new Set(shadowed))
	}

	if (node.nodeType === "ConditionalStatement") {
		let trueBody = descendReturns(node.trueBody, shadowed, visit)
		let falseBody = descendReturns(node.falseBody, shadowed, visit)

		return trueBody === node.trueBody && falseBody === node.falseBody
			? null
			: [{ ...node, trueBody, falseBody }]
	}

	// NOTE: A lowered Statement is descended into exactly when its answer IS the
	// Function's answer. One that writes its answer to a name holds Returns that
	// answer THAT question and leave the chain; one driving an inlined loop holds
	// a callback's Returns, which answer the callback.
	if (
		node.nodeType !== "IntrinsicStatement" ||
		node.kind !== "statement-match" ||
		node.result.kind !== "return"
	) {
		return null
	}

	let inner = new Set(shadowed)

	// NOTE: `_self` is the name every Handler reads the matched value under, so
	// a Handler is a Scope where the receiver of a Method means something else.
	// Except where the value IS `_self` already — `match @ -> …` binds nothing,
	// and the two names are the same value.
	if (node.binding.kind !== "self") {
		inner.add(selfName)
	}

	if (node.binding.kind === "held") {
		inner.add(node.binding.name)
	}

	let rewritten: Array<common.typedSimple.MatchHandler> | undefined

	for (let index = 0; index < node.handlers.length; index++) {
		let handler = node.handlers[index]!
		let body = descendReturns(handler.body, inner, visit)

		if (body === handler.body) {
			continue
		}

		rewritten ??= [...node.handlers]
		rewritten[index] = { ...handler, body }
	}

	return rewritten === undefined ? null : [{ ...node, handlers: rewritten }]
}

// NOTE: What a Statement binds in the block it stands in — the same four
// Statements the Rewriter asks about when it has to know whether a name it is
// writing to is one the Program bound.
function bindOf(node: ImplementationNode, scope: Set<string>): void {
	switch (node.nodeType) {
		case "VariableDeclarationStatement":
		case "FunctionStatement":
		case "NamespaceDefinitionStatement":
			scope.add(node.name.name)

			return
		case "IntrinsicStatement":
			if (node.result.kind === "declaration") {
				scope.add(node.result.name.name)
			}

			return
		default:
			return
	}
}

function bindsAtTopLevel(
	nodes: Array<ImplementationNode>,
	name: string,
): boolean {
	let scope = new Set<string>()

	for (let node of nodes) {
		bindOf(node, scope)
	}

	return scope.has(name)
}

// NOTE: Whether any of these names occurs anywhere in this subtree, asked
// structurally so that a position added to `typedSimple` later is searched
// without this having to hear about it. It over-answers — an occurrence under a
// Scope that rebound the name is not this one, and a `Lookup`'s member or a
// `MethodInvocation`'s base is not a name a turn can rebind at all — and
// over-answering costs a temporary that was not needed, a slot that was not
// needed or a Function declined, never a wrong answer.
//
// NOTE: Which is why this and `renamed` are asked in opposite voices. This one
// and `capturedNames` may say yes where the honest answer is no; the rename may
// not, because a name it rewrites that meant something else is emitted as a name
// nothing answers to. So the two questions are answered by two walks on purpose:
// this one structural and over-answering, the rename the shared typed walk.
function mentionsAnyName(value: unknown, names: ReadonlySet<string>): boolean {
	if (names.size === 0) {
		return false
	}

	if (Array.isArray(value)) {
		return value.some((entry) => mentionsAnyName(entry, names))
	}

	if (value === null || typeof value !== "object") {
		return false
	}

	let node = value as Record<string, unknown>

	if (
		node["nodeType"] === "Identifier" &&
		typeof node["name"] === "string" &&
		names.has(node["name"])
	) {
		return true
	}

	return Object.values(node).some((entry) => mentionsAnyName(entry, names))
}

// NOTE: Whether anything inside this Expression declares a name — a Match, which
// binds `_self` for its Handlers; a Function literal, which binds its own
// Parameters; a lowered Statement, which binds whatever it holds. A default
// holding one of them may not be renamed wholesale.
function bindsInside(value: unknown): boolean {
	if (Array.isArray(value)) {
		return value.some((entry) => bindsInside(entry))
	}

	if (value === null || typeof value !== "object") {
		return false
	}

	let node = value as Record<string, unknown>
	let kind = node["nodeType"]

	if (
		kind === "Match" ||
		kind === "FunctionValue" ||
		kind === "IntrinsicStatement"
	) {
		return true
	}

	return Object.values(node).some((entry) => bindsInside(entry))
}

// NOTE: Every name a Function literal in this subtree mentions — the Parameters
// a closure could CAPTURE. Asked of the literal's whole subtree, the names it
// binds itself included and a member name it reads included, because admitting
// one Parameter too many costs a `const` per turn and missing one is a closure
// reading the next turn's value.
//
// NOTE: Asked of a BODY, where the answer decides which Parameters are slotted,
// and of a Parameter's DEFAULT, where the answer decides whether the Function is
// looped at all. The Expression it is asked of is never itself the literal: a
// name mentioned outside one is not captured by anything.
function capturedNames(value: unknown): ReadonlySet<string> {
	let names = new Set<string>()

	collectCaptured(value, names, false)

	return names
}

function collectCaptured(
	value: unknown,
	names: Set<string>,
	inside: boolean,
): void {
	if (Array.isArray(value)) {
		for (let entry of value) {
			collectCaptured(entry, names, inside)
		}

		return
	}

	if (value === null || typeof value !== "object") {
		return
	}

	let node = value as Record<string, unknown>
	let kind = node["nodeType"]

	if (inside && kind === "Identifier" && typeof node["name"] === "string") {
		names.add(node["name"])
	}

	let nested =
		inside || kind === "FunctionValue" || kind === "FunctionStatement"

	for (let entry of Object.values(node)) {
		collectCaptured(entry, names, nested)
	}
}

// NOTE: One Expression with the names a slotted Parameter is read under renamed
// — what a default that reads one needs. It is the SHARED walk rather than a
// sweep of its own, and that is the whole of the correctness here: only the
// walk knows which Identifier is a reference to a BINDING and which one names
// something else. A `Lookup`'s `member` is the plain case — `opts.n` reads the
// member `n` off a Record and has nothing to do with a Parameter called `n`,
// and renaming it emits `opts.n_p`, which is `undefined` — and a
// `MethodInvocation`'s `base` names the answering Namespace rather than a value.
// Neither is a name a turn can rebind, so neither is a name to rewrite.
//
// NOTE: The one position the walk does not offer is a Parameter default INSIDE
// this Expression, which nothing but a Function literal can carry — and a
// default holding one of those never reaches here, because `bindsInside`
// declines it first.
function renamed(
	value: ExpressionNode,
	renames: ReadonlyMap<string, string>,
): ExpressionNode {
	return rewriteExpressionsIn(value, (node) => {
		if (node.nodeType !== "Identifier") {
			return node
		}

		let to = renames.get(node.name)

		return to === undefined ? node : { ...node, name: to }
	})
}
