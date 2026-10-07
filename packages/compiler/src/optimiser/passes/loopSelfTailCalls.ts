import type { common } from "@essence-lang/interfaces"

import { conformanceParameterName } from "../../helpers/names"
import {
	findSimpleChild,
	forEachSimpleChild,
	type SimpleNode,
} from "../../visitor/typedSimple"
import type { OptimiserPass } from "../index"
import { rewriteExpressionsIn, rewriteNodes } from "../walk"

// Turns a self call in tail position into a loop turn. The Parameters are
// rebound and the body runs again from the top, so a deep recursion needs one
// frame on every host. See "loop-self-tail-calls" in DEVELOPMENT.md.

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

// What a call must name to call itself: a Function's Identifier, a Namespace
// and the mangled member, or a provided Method's conformance Parameter and
// member. Another Overload is not a self call.
type SelfIdentity =
	| { kind: "function"; name: string }
	| { kind: "method"; namespace: string; member: string }
	| { kind: "provided"; conformance: string; member: string }

// One Argument of a tail call. `omitted` covers the `omitted-argument`
// intrinsic and an Argument list that stops short.
type TailArgument =
	| { kind: "written"; value: ExpressionNode }
	| { kind: "omitted" }

// One tail call, with the names an enclosing block binds where it stands, such
// as a Handler's `_self`.
type TailSite = {
	shadowed: ReadonlySet<string>
	arguments: Array<TailArgument>
}

class Looping {
	// Numbered across the Program, so nested loops never share a label.
	private count = 0

	statement(node: ImplementationNode): ImplementationNode {
		if (node.nodeType === "FunctionStatement") {
			let value = this.looped(node.value, {
				kind: "function",
				name: node.name.name,
			})

			return value === null ? node : { ...node, value }
		}

		if (node.nodeType === "NamespaceDefinitionStatement") {
			let methods = this.loopedMethods(node.methods, (member) => ({
				kind: "method",
				namespace: node.name.name,
				member,
			}))

			return methods === node.methods ? node : { ...node, methods }
		}

		// See "A provided Method" in DEVELOPMENT.md.
		if (node.nodeType === "ProtocolDeclarationStatement") {
			let methods = this.loopedMethods(node.methods, (member) => ({
				kind: "provided",
				conformance: conformanceParameterName("Self"),
				member,
			}))

			return methods === node.methods ? node : { ...node, methods }
		}

		return node
	}

	// The Methods, each looped where it can be, or the same object where none
	// is.
	private loopedMethods(
		methods: common.typedSimple.Methods,
		identityOf: (member: string) => SelfIdentity,
	): common.typedSimple.Methods {
		let looped: common.typedSimple.Methods | undefined

		for (let [member, entry] of Object.entries(methods)) {
			let value = this.looped(entry.method.value, identityOf(member))

			if (value === null) {
				continue
			}

			looped ??= { ...methods }
			looped[member] = { ...entry, method: { ...entry.method, value } }
		}

		return looped ?? methods
	}

	// One Function looped, or null where it has no tail self call or can not be
	// shown to loop the same.
	private looped(
		definition: FunctionDefinitionNode,
		identity: SelfIdentity,
	): FunctionDefinitionNode | null {
		if (definition.completing === true) {
			return null
		}

		let parameters = definition.parameters
		let names = parameters.map((parameter) => parameter.internalName.name)

		// A Parameter named like the Function, or a Method's Namespace, shadows
		// it, so the body makes no self call. A provided Method's conformance is
		// its last Parameter, the one the witness appends to every call.
		if (
			identity.kind === "provided"
				? names.indexOf(identity.conformance) !== names.length - 1
				: names.includes(
						identity.kind === "function"
							? identity.name
							: identity.namespace,
					)
		) {
			return null
		}

		// Empty, since at the head of the body a Parameter means itself.
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

// Unspellable in Essence, since the lexer reads `_` as a Symbol. `$tail_3` is a
// label, `$tail_3_t0` a held Argument, and a slot is the Parameter's name with
// `_p` appended.
const labelPrefix = "$tail_"
const temporaryInfix = "_t"
const slotSuffix = "_p"
const selfName = "_self"

// What was decided about the Parameters after reading every tail call.
type LoopPlan = {
	// The Parameters as declared, read for the Type of a hole a turn hands
	// one.
	declaredParameters: Array<ParameterNode>
	// The names the body reads. A slotted Parameter's name becomes a turn's
	// `const`.
	names: Array<string>
	// Per Parameter, its slot, or null where it is assigned in place or never.
	slots: Array<string | null>
	// The defaults a turn takes again, read under the slot names.
	fallbacks: Array<ExpressionNode | null>
	// Parameters some turn assigns in place, whose old value an Argument may
	// read.
	directlyAssigned: ReadonlySet<string>
	// Parameters the body's prologue rebuilds from a Record default. A turn
	// that leaves one out hands it `undefined`, and its copy is a `let`.
	rebuilt: ReadonlySet<number>
}

// The hole a call leaves for an omitted Argument. The next turn's prologue
// consumes it before anything reads the name.
function omittedArgument(
	parameter: ParameterNode,
): common.typedSimple.OmittedArgumentNode {
	return {
		nodeType: "Intrinsic",
		kind: "omitted-argument",
		type: parameter.internalName.type,
	}
}

// The plan, or null where this Function may not be looped.
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

			// Shadowed where the call stands, so it goes through a slot nothing
			// shadows.
			if (site.shadowed.has(names[index]!)) {
				slotted.add(index)
			}

			// A default this turn takes again reads earlier Parameters by name,
			// so a shadowed one goes through a slot too.
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

	// A default is evaluated where the turn assigns, with no turn binding to
	// capture. So a default whose Function literal mentions a rebound Parameter
	// declines the Function. A literal mentioning nothing is safe.
	let rebound = new Set([...assigned].map((index) => names[index]!))

	for (let parameter of parameters) {
		if (parameter.defaultValue === null) {
			continue
		}

		for (let name of capturedNames([parameter.defaultValue])) {
			if (rebound.has(name)) {
				return null
			}
		}
	}

	// A Parameter a Function literal in the body mentions is captured, so it is
	// slotted, and the body reads a `const` of the turn.
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
		// The name becomes a `const` at the head of the loop body, so a body
		// binding it again would be a `SyntaxError`. Essence refuses that
		// already.
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

		// A default renamed wholesale may not bind names itself, through a
		// Match's `_self` or a Function literal's Parameters.
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

// The Parameters a prologue rebuilds from a Record default, as in
// `options.retries ?? 3`. Only the top level can hold such an assignment.
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

// Whether this turn changes the Parameter at `index`. Passing the Parameter
// itself, as a Method walking on `@` does, changes nothing.
function rebinds(site: TailSite, index: number, name: string): boolean {
	let argument = site.arguments[index]

	if (argument === undefined) {
		return false
	}

	// An omitted Argument takes the default again, since a turn is a call.
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
		// No Position on the slot. The turn's `const` carries the reader's
		// name.
		internalName: {
			nodeType: "Identifier",
			name: slot,
			type: parameter.internalName.type,
		},
		defaultValue: fallback,
	}
}

// `const rest = rest_p;` at the head of every turn, one binding per turn.
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
			// A `let` where the prologue assigns the name.
			isConstant: !plan.rebuilt.has(index),
		})
	}

	return copies
}

// Everything one tail call is written from.
type Turn = {
	identity: SelfIdentity
	shadowed: ReadonlySet<string>
	plan: LoopPlan
	label: string
	temporary: () => string
}

// The answer: the call, a coverage counter leading the call, or a `define`
// whose arms answer here. Anything else gives null.
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

		// A leading counter is written as the Statement before the turn.
		return [
			{ ...expression, value: null },
			...rest,
		] satisfies Array<ImplementationNode>
	}

	return expression.nodeType === "Define"
		? defineLadder(expression, position, turn)
		: null
}

// `<- define { … }` as its ladder of Conditionals, where an arm answers with a
// tail call. Other arms keep their own Returns.
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

// The turn: every Argument evaluated, then the changed Parameters rebound,
// then the body from the top.
function tailCallStatement(
	call: SelfCallNode,
	position: common.Position | undefined,
	turn: Turn,
): common.typedSimple.TailCallStatementNode | null {
	let { plan, shadowed } = turn

	// `alignedArguments` refuses too many Arguments. Asked again so the plan
	// and the turn agree.
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

	// Every changed Argument is held when any of them mentions a Parameter
	// assigned in place, or a written one follows an omitted one.
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
			// No default here means the prologue rebuilds the Parameter from
			// the hole.
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

// Every self call one answer holds, read the way `tailAnswer` writes it.
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

// The Argument for one Parameter. The simplifier ordered them by Parameter,
// so a short list leaves the trailing defaults out.
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

// The Arguments against the Parameters, or null where they do not line up,
// which the enricher never lets through.
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

		// Neither a default nor a prologue, so a turn could bind nothing.
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

// Whether this Expression itself, not a part of it, calls the Function.
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

	let base =
		identity.kind === "method" ? identity.namespace : identity.conformance

	// A provided Method or a derived Equatable is another body.
	if (
		expression.nodeType !== "MethodInvocation" ||
		expression.base.name !== base ||
		expression.member.name !== identity.member ||
		expression.providedBy !== undefined ||
		expression.derivedDescriptor !== undefined ||
		shadowed.has(base)
	) {
		return null
	}

	// The witness appends the conformance the body is curried with, which runs
	// this body for the name, so a turn hands it on unchanged. See "A provided
	// Method" in DEVELOPMENT.md.
	return identity.kind === "method"
		? expression
		: {
				...expression,
				arguments: [
					...expression.arguments,
					{
						nodeType: "Argument",
						name: null,
						value: {
							nodeType: "Identifier",
							name: base,
							type: { type: "Unknown" },
						},
					},
				],
			}
}

// Every Return from this Function, with the names shadowed where it stands.
// Null leaves a Statement as it is.
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
		// A copy, since the set grows as the block is read.
		return visit(node, new Set(shadowed))
	}

	if (node.nodeType === "ConditionalStatement") {
		let trueBody = descendReturns(node.trueBody, shadowed, visit)
		let falseBody = descendReturns(node.falseBody, shadowed, visit)

		return trueBody === node.trueBody && falseBody === node.falseBody
			? null
			: [{ ...node, trueBody, falseBody }]
	}

	// Only a lowered Statement whose answer is the Function's holds its
	// Returns.
	if (
		node.nodeType !== "IntrinsicStatement" ||
		node.kind !== "statement-match" ||
		node.result.kind !== "return"
	) {
		return null
	}

	let inner = new Set(shadowed)

	// A Handler binds `_self` to the matched value, except for `match @`.
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

// What a Statement binds in its block, as the rewriter asks it.
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

// Whether any of the names occurs in the subtree. It may over-answer, at the
// cost of a temporary, a slot or a declined Function. `renamed` may not.
function mentionsAnyName(
	node: SimpleNode,
	names: ReadonlySet<string>,
): boolean {
	if (names.size === 0) {
		return false
	}

	if (node.nodeType === "Identifier") {
		return names.has(node.name)
	}

	return findSimpleChild(node, nameInChild, names) ?? false
}

function nameInChild(
	child: SimpleNode,
	names: ReadonlySet<string>,
): true | undefined {
	return mentionsAnyName(child, names) || undefined
}

// Whether anything inside declares a name: a Match, a Function literal or a
// lowered Statement.
function bindsInside(node: SimpleNode): boolean {
	if (
		node.nodeType === "Match" ||
		node.nodeType === "FunctionValue" ||
		node.nodeType === "IntrinsicStatement"
	) {
		return true
	}

	return findSimpleChild(node, bindsInChild) ?? false
}

function bindsInChild(child: SimpleNode): true | undefined {
	return bindsInside(child) || undefined
}

// Every name a Function literal in the subtree mentions, which a closure could
// capture. Missing one would let a closure read the next turn's value.
function capturedNames(nodes: ReadonlyArray<SimpleNode>): ReadonlySet<string> {
	let names = new Set<string>()

	for (let node of nodes) {
		collectCaptured(node, names)
	}

	return names
}

// Outside every Function literal, where a name is no capture.
function collectCaptured(node: SimpleNode, names: Set<string>): void {
	forEachSimpleChild(
		node,
		node.nodeType === "FunctionValue" ||
			node.nodeType === "FunctionStatement"
			? collectInside
			: collectCaptured,
		names,
	)
}

function collectInside(node: SimpleNode, names: Set<string>): void {
	if (node.nodeType === "Identifier") {
		names.add(node.name)
	}

	forEachSimpleChild(node, collectInside, names)
}

// Renames slotted Parameters through the shared walk, which knows `opts.n` is a
// member read and not a Parameter. A default holding a Function literal never
// reaches here.
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
