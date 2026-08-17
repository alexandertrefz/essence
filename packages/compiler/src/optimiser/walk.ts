import type { common } from "@essence-lang/interfaces"

// NOTE: One walk over a simplified Program, shared by every Optimiser pass, so
// that a pass is written as the one question it asks — "is THIS Node one I can
// do better than?" — and not as a second copy of the tree's shape. A missed
// position is not a crash: it is an optimisation that silently does not happen
// where it was written to, and, once passes begin rewriting into intrinsics
// that later passes read, a Node the walk does not reach is a Node a pass can
// not fix up either. So every kind is handled by name: the Expression and
// intrinsic switches are exhaustive and answer nothing by default, and the
// Statement switch names each Statement kind before falling through to the
// Expressions — which is what makes a Statement kind added to `typedSimple`
// a compile error, since the fall-through narrows to `ExpressionNode` and a
// Statement is not one.
//
// NOTE: The walk is BOTTOM-UP: a Node's children are rewritten before the Node
// itself is offered to the pass, so a pass reading its own output reads the
// finished form of everything below it and never has to re-walk what it just
// produced.
//
// NOTE: Nothing is mutated. A pass is a pure function of its input — the
// standard library's simplified Programs are a process-wide value the prelude
// cache hands out again and again — so every Node whose children changed is
// rebuilt, and every Node whose children did not is handed back AS ITSELF.
// That identity is what keeps a pass that rewrites one Node in a Program from
// allocating a copy of the whole Program around it.

type ExpressionNode = common.typedSimple.ExpressionNode
type ImplementationNode = common.typedSimple.ImplementationNode
type FunctionDefinitionNode = common.typedSimple.FunctionDefinitionNode
type ArgumentNode = common.typedSimple.ArgumentNode

// NOTE: What a pass hands the walk: one Expression in, its replacement out. An
// answer that IS the argument means "leave this one alone", which is how the
// structural sharing above is kept.
export type ExpressionRewrite = (node: ExpressionNode) => ExpressionNode

// NOTE: And the same for a Statement — one Node standing in a Statement
// POSITION in, its replacement out. "Statement position" is the whole of what
// this offers and is wider than `StatementNode`: an Expression written for its
// effects stands in one, and a Match written that way is exactly what
// `lower-matches-to-statements` is looking for. Such a Node is offered to BOTH
// hooks, the Expression one first, because it is both things at once.
export type StatementRewrite = (node: ImplementationNode) => ImplementationNode

// NOTE: And the same for a BODY — every place a run of Statements stands, which
// is a Program's own nodes, a Function's body, a Match Handler's, a Conditional's
// two and an inlined callback's. It is the one hook that can answer with a
// DIFFERENT NUMBER of Statements than it was given, which is what
// `eliminate-dead-code` needs and what neither hook above can do: a Statement
// rewrite maps one Node to one Node.
//
// NOTE: Offered AFTER every Statement in it has been walked, like everything
// else here, and expected to answer with the array it was GIVEN where it changes
// nothing — the structural sharing the rest of this file keeps rests on it.
export type BodyRewrite = (
	nodes: Array<ImplementationNode>,
) => Array<ImplementationNode>

// NOTE: The hooks a pass asks for, and it may ask for any of them. All are
// offered by ONE walk: `elide-final-match-test` reads a Match that is still an
// Expression and one that has been lowered to a Statement, and two walks would
// be two chances to disagree about what was reached.
export type NodeRewrites = {
	expression?: ExpressionRewrite
	statement?: StatementRewrite
	body?: BodyRewrite
	// NOTE: Whether the walk descends into a Parameter's `= expression` default.
	// OFF by default, and asked for by name, because a default stands in a
	// position that has NO Statement before it: several passes answer an
	// Expression by lifting work into Statements ahead of it —
	// `lower-matches-to-statements` is the plain case, `inline-loops` and
	// `build-lists-in-place` the ones that bind names — and there is nowhere in
	// a Parameter list for any of that to go.
	//
	// A pass that only ever answers an Expression with another Expression has no
	// such trouble, and three of them need to see a default: `fold-constants`
	// and `pool-constants`, because a unit-Case default is built at every call
	// otherwise, and `eliminate-dead-code`, whose reading of what the Program
	// READS is not a rewrite at all — a Constant named only by a default was
	// dropped out from under it.
	parameterDefaults?: true
}

// NOTE: BOTTOM-UP for Statements as well: a Statement's children — its
// Expressions and the Statements of any body it holds — are rewritten before it
// is offered. So a pass reading its own output reads the finished form of
// everything below it, and a Match nested in a Handler's body is lowered before
// the Match holding it is asked about.
export function rewriteNodes(
	program: common.typedSimple.Program,
	rewrites: NodeRewrites,
): common.typedSimple.Program {
	let nodes = walkBody(program.implementation.nodes, rewrites)

	if (nodes === program.implementation.nodes) {
		return program
	}

	return {
		...program,
		implementation: { ...program.implementation, nodes },
	}
}

export function rewriteExpressions(
	program: common.typedSimple.Program,
	rewrite: ExpressionRewrite,
	options: { parameterDefaults?: true } = {},
): common.typedSimple.Program {
	return rewriteNodes(program, { ...options, expression: rewrite })
}

export function rewriteStatements(
	program: common.typedSimple.Program,
	rewrite: StatementRewrite,
): common.typedSimple.Program {
	return rewriteNodes(program, { statement: rewrite })
}

// NOTE: One run of Statements, walked and then offered whole. Every place a body
// can stand goes through this — which is what makes "every body, exactly once"
// a property of this function rather than of five call sites remembering to
// agree.
function walkBody(
	nodes: Array<ImplementationNode>,
	rewrites: NodeRewrites,
): Array<ImplementationNode> {
	let walked = mapArray(nodes, (node) => walkImplementation(node, rewrites))

	return rewrites.body === undefined ? walked : rewrites.body(walked)
}

// NOTE: The copy is not made until something is IN it. Most passes leave most
// of the tree alone — fourteen of them walk it and each is written for one
// shape — so the common answer here is the array that was given, and building
// one to throw away is the whole of what a no-op walk used to cost. Every entry
// is still mapped, in order, exactly once: the laziness is in the allocation,
// not in the work.
function mapArray<Value>(
	values: Array<Value>,
	map: (value: Value) => Value,
): Array<Value> {
	let mapped: Array<Value> | undefined

	for (let index = 0; index < values.length; index++) {
		let value = values[index]!
		let result = map(value)

		if (mapped === undefined) {
			if (result === value) {
				continue
			}

			mapped = values.slice(0, index)
		}

		mapped.push(result)
	}

	return mapped ?? values
}

// NOTE: Insertion order is preserved, which is not a detail — a Record's
// members are emitted in the order they are written, and `Object.keys` over the
// emitted literal is what the runtime's Record equality and its printer read.
// The copy is filled from the same key order it is abandoned in, so a Record
// one member of which changed keeps the order the whole of it was written in.
function mapRecord<Value>(
	members: Record<string, Value>,
	map: (value: Value) => Value,
): Record<string, Value> {
	let names = Object.keys(members)
	let mapped: Record<string, Value> | undefined

	for (let index = 0; index < names.length; index++) {
		let name = names[index]!
		let value = members[name]!
		let result = map(value)

		if (mapped === undefined) {
			if (result === value) {
				continue
			}

			mapped = {}

			for (let earlier = 0; earlier < index; earlier++) {
				let earlierName = names[earlier]!

				mapped[earlierName] = members[earlierName]!
			}
		}

		mapped[name] = result
	}

	return mapped ?? members
}

// NOTE: Every Statement POSITION, offered once. An Expression written for its
// effects stands in one and has already been offered to the Expression hook by
// the time it is offered here — the walk below descends first and asks after,
// as it does everywhere.
function walkImplementation(
	node: ImplementationNode,
	rewrites: NodeRewrites,
): ImplementationNode {
	let walked = walkImplementationChildren(node, rewrites)

	return rewrites.statement === undefined
		? walked
		: rewrites.statement(walked)
}

function walkImplementationChildren(
	node: ImplementationNode,
	rewrites: NodeRewrites,
): ImplementationNode {
	switch (node.nodeType) {
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement": {
			let value = walkExpression(node.value, rewrites)

			return value === node.value ? node : { ...node, value }
		}
		case "NamespaceDefinitionStatement": {
			let properties = mapRecord(node.properties, (value) =>
				walkExpression(value, rewrites),
			)
			// NOTE: A Method's body is walked, the Function literal holding it is
			// not offered to the pass: the Rewriter emits it as a class member
			// rather than as a value, so there is no position there for another
			// kind of Expression to stand in. A Namespace's static Properties
			// above ARE values, and are offered like any other.
			let methods = mapRecord(node.methods, (entry) => {
				let value = walkFunctionDefinition(entry.method.value, rewrites)

				if (value === entry.method.value) {
					return entry
				}

				return { ...entry, method: { ...entry.method, value } }
			})

			// NOTE: A native Method's shim is a Parameter list and nothing
			// else — the Rewriter writes its one-call body out — so the
			// defaults are the whole of what there is to walk here.
			let nativeShims = mapArray(node.nativeShims, (shim) => {
				let parameters = walkParameterDefaults(
					shim.parameters,
					rewrites,
				)

				return parameters === shim.parameters
					? shim
					: { ...shim, parameters }
			})

			if (
				properties === node.properties &&
				methods === node.methods &&
				nativeShims === node.nativeShims
			) {
				return node
			}

			return { ...node, properties, methods, nativeShims }
		}
		case "ConditionalStatement": {
			let condition = walkExpression(node.condition, rewrites)
			let trueBody = walkBody(node.trueBody, rewrites)
			let falseBody = walkBody(node.falseBody, rewrites)

			if (
				condition === node.condition &&
				trueBody === node.trueBody &&
				falseBody === node.falseBody
			) {
				return node
			}

			return { ...node, condition, trueBody, falseBody }
		}
		case "ReturnStatement": {
			let expression = walkExpression(node.expression, rewrites)

			return expression === node.expression
				? node
				: { ...node, expression }
		}
		case "FunctionStatement": {
			let value = walkFunctionDefinition(node.value, rewrites)

			return value === node.value ? node : { ...node, value }
		}
		case "IntrinsicStatement":
			return walkIntrinsicStatementChildren(node, rewrites)
		// NOTE: A Protocol declaration and a Type Alias carry nothing but names
		// and Types by this point — the Rewriter emits nothing at all for
		// either.
		case "ProtocolDeclarationStatement":
		case "TypeAliasStatement":
			return node
		default:
			return walkExpression(node, rewrites)
	}
}

// NOTE: A lowered Statement is walked like the Expression it was lowered from:
// its Handlers' tests, Guards and bodies, and the values it holds under a name,
// are the same positions in the same order. That is what lets the passes after
// `lower-matches-to-statements` — the pool above all — reach what a Match holds
// whether or not it was lowered.
function walkIntrinsicStatementChildren(
	node: common.typedSimple.IntrinsicStatementNode,
	rewrites: NodeRewrites,
): ImplementationNode {
	switch (node.kind) {
		case "statement-match": {
			let value = walkExpression(node.value, rewrites)
			let handlers = walkHandlers(node.handlers, rewrites)

			if (value === node.value && handlers === node.handlers) {
				return node
			}

			return { ...node, value, handlers }
		}
		case "held-expression": {
			let temporaries = mapArray(node.temporaries, (temporary) => {
				let value = walkExpression(temporary.value, rewrites)

				return value === temporary.value
					? temporary
					: { ...temporary, value }
			})
			let expression = walkExpression(node.expression, rewrites)

			if (
				temporaries === node.temporaries &&
				expression === node.expression
			) {
				return node
			}

			return { ...node, temporaries, expression }
		}
		case "inline-loop": {
			let driver = walkInlineLoopDriver(node.driver, rewrites)

			return driver === node.driver ? node : { ...node, driver }
		}
	}
}

// NOTE: An inlined loop is walked like the call it replaced: the Expressions it
// was given, and the Statements of each callback's body — which are Statements
// standing in a Statement position and are offered to BOTH hooks, exactly as the
// Function literal's body was before it was inlined. That is what keeps
// `pool-constants` reaching a literal written inside a loop body and
// `elide-final-match-test` reading a Match written there.
//
// NOTE: A Parameter is a binding rather than a value and is not offered, which
// is how every other Parameter position in this walk is treated.
function walkInlineLoopDriver(
	driver: common.typedSimple.InlineLoopDriver,
	rewrites: NodeRewrites,
): common.typedSimple.InlineLoopDriver {
	switch (driver.kind) {
		case "condition": {
			let seed = walkExpression(driver.seed, rewrites)
			let predicate = walkInlineLoopCallback(driver.predicate, rewrites)
			let step = walkInlineLoopCallback(driver.step, rewrites)

			if (
				seed === driver.seed &&
				predicate === driver.predicate &&
				step === driver.step
			) {
				return driver
			}

			return { ...driver, seed, predicate, step }
		}
		case "counted": {
			let from = walkExpression(driver.from, rewrites)
			let through = walkExpression(driver.through, rewrites)
			let seed = walkExpression(driver.seed, rewrites)
			let step = walkInlineLoopCallback(driver.step, rewrites)

			if (
				from === driver.from &&
				through === driver.through &&
				seed === driver.seed &&
				step === driver.step
			) {
				return driver
			}

			return { ...driver, from, through, seed, step }
		}
		case "general": {
			let seed = walkExpression(driver.seed, rewrites)
			let step = walkInlineLoopCallback(driver.step, rewrites)

			if (seed === driver.seed && step === driver.step) {
				return driver
			}

			return { ...driver, seed, step }
		}
		case "fold": {
			let items = walkExpression(driver.items, rewrites)
			let seed = walkExpression(driver.seed, rewrites)
			let step = walkInlineLoopCallback(driver.step, rewrites)

			if (
				items === driver.items &&
				seed === driver.seed &&
				step === driver.step
			) {
				return driver
			}

			return { ...driver, items, seed, step }
		}
		case "map": {
			let items = walkExpression(driver.items, rewrites)
			let transform = walkInlineLoopCallback(driver.transform, rewrites)

			if (items === driver.items && transform === driver.transform) {
				return driver
			}

			return { ...driver, items, transform }
		}
		case "keep": {
			let items = walkExpression(driver.items, rewrites)
			let check = walkInlineLoopCallback(driver.check, rewrites)

			if (items === driver.items && check === driver.check) {
				return driver
			}

			return { ...driver, items, check }
		}
	}
}

function walkInlineLoopCallback(
	callback: common.typedSimple.InlineLoopCallback,
	rewrites: NodeRewrites,
): common.typedSimple.InlineLoopCallback {
	let body = walkBody(callback.body, rewrites)

	return body === callback.body ? callback : { ...callback, body }
}

// NOTE: The body, and the Parameter defaults for the passes that asked for them
// — see `NodeRewrites.parameterDefaults` for which passes those are and why the
// rest are kept out.
function walkFunctionDefinition(
	node: FunctionDefinitionNode,
	rewrites: NodeRewrites,
): FunctionDefinitionNode {
	let parameters = walkParameterDefaults(node.parameters, rewrites)
	let body = walkBody(node.body, rewrites)

	if (parameters === node.parameters && body === node.body) {
		return node
	}

	return { ...node, parameters, body }
}

// NOTE: The one place a `= expression` default is walked, for every kind of
// Declaration that can carry one — a Function, a Method, and the frame the
// Compiler synthesizes for a native's defaults, which has no body at all and is
// therefore nothing BUT this.
function walkParameterDefaults(
	parameters: Array<common.typedSimple.ParameterNode>,
	rewrites: NodeRewrites,
): Array<common.typedSimple.ParameterNode> {
	if (rewrites.parameterDefaults === undefined) {
		return parameters
	}

	return mapArray(parameters, (parameter) => {
		if (parameter.defaultValue === null) {
			return parameter
		}

		let defaultValue = walkExpression(parameter.defaultValue, rewrites)

		return defaultValue === parameter.defaultValue
			? parameter
			: { ...parameter, defaultValue }
	})
}

function walkArguments(
	args: Array<ArgumentNode>,
	rewrites: NodeRewrites,
): Array<ArgumentNode> {
	return mapArray(args, (argument) => {
		let value = walkExpression(argument.value, rewrites)

		return value === argument.value ? argument : { ...argument, value }
	})
}

function walkExpression(
	node: ExpressionNode,
	rewrites: NodeRewrites,
): ExpressionNode {
	let walked = walkChildren(node, rewrites)

	return rewrites.expression === undefined
		? walked
		: rewrites.expression(walked)
}

// NOTE: The Expression positions a Node holds — and only those. A `type` is
// walked by nobody: it is a Type, not an Expression, and a Match's `matcher` is
// one as well. The two Identifier positions that LOOK like Expressions are left
// alone on purpose: a `MethodInvocation`'s `base` names the answering Namespace
// and a `Lookup`'s `member` the member being read. Neither is a value the
// Program computes, and neither field can hold anything but an Identifier.
function walkChildren(
	node: ExpressionNode,
	rewrites: NodeRewrites,
): ExpressionNode {
	switch (node.nodeType) {
		case "MethodInvocation": {
			let args = walkArguments(node.arguments, rewrites)

			return args === node.arguments ? node : { ...node, arguments: args }
		}
		case "FunctionInvocation": {
			let name = walkExpression(node.name, rewrites)
			let args = walkArguments(node.arguments, rewrites)

			if (name === node.name && args === node.arguments) {
				return node
			}

			return { ...node, name, arguments: args }
		}
		case "UnionMethodInvocation": {
			let base = walkExpression(node.base, rewrites)
			let args = walkArguments(node.arguments, rewrites)
			// NOTE: A dispatch case carries Arguments of its own — the hidden
			// conformance witnesses every branch needs, and the Function
			// literals compiled against THIS branch's Method. Both are ordinary
			// Expressions the Program evaluates, so both are walked.
			let cases = mapArray(node.cases, (dispatch) => {
				let conformanceArguments = walkArguments(
					dispatch.conformanceArguments,
					rewrites,
				)
				let contextualArguments = mapArray(
					dispatch.contextualArguments,
					(entry) => {
						let value = walkExpression(
							entry.argument.value,
							rewrites,
						)

						return value === entry.argument.value
							? entry
							: {
									...entry,
									argument: { ...entry.argument, value },
								}
					},
				)

				if (
					conformanceArguments === dispatch.conformanceArguments &&
					contextualArguments === dispatch.contextualArguments
				) {
					return dispatch
				}

				return {
					...dispatch,
					conformanceArguments,
					contextualArguments,
				}
			})

			if (
				base === node.base &&
				args === node.arguments &&
				cases === node.cases
			) {
				return node
			}

			return { ...node, base, arguments: args, cases }
		}
		case "Combination": {
			let lhs = walkExpression(node.lhs, rewrites)
			let rhs = walkExpression(node.rhs, rewrites)

			if (lhs === node.lhs && rhs === node.rhs) {
				return node
			}

			return { ...node, lhs, rhs }
		}
		case "RecordValue": {
			let members = mapRecord(node.members, (value) =>
				walkExpression(value, rewrites),
			)

			return members === node.members ? node : { ...node, members }
		}
		case "InterpolatedStringValue": {
			let segments = mapArray(node.segments, (segment) => {
				if (segment.kind === "text") {
					return segment
				}

				let expression = walkExpression(segment.expression, rewrites)
				let witness = walkExpression(segment.witness, rewrites)

				if (
					expression === segment.expression &&
					witness === segment.witness
				) {
					return segment
				}

				return { ...segment, expression, witness }
			})

			return segments === node.segments ? node : { ...node, segments }
		}
		case "FunctionValue": {
			let value = walkFunctionDefinition(node.value, rewrites)

			return value === node.value ? node : { ...node, value }
		}
		case "ListValue": {
			let values = mapArray(node.values, (value) =>
				walkExpression(value, rewrites),
			)

			return values === node.values ? node : { ...node, values }
		}
		case "Lookup": {
			let base = walkExpression(node.base, rewrites)

			return base === node.base ? node : { ...node, base }
		}
		case "Match": {
			let value = walkExpression(node.value, rewrites)
			let handlers = walkHandlers(node.handlers, rewrites)

			if (value === node.value && handlers === node.handlers) {
				return node
			}

			return { ...node, value, handlers }
		}
		case "ConformanceValue": {
			let conditions = mapArray(node.conditions, (condition) =>
				walkExpression(condition, rewrites),
			)

			return conditions === node.conditions
				? node
				: { ...node, conditions }
		}
		case "CaseValue": {
			let value =
				node.value === null
					? null
					: walkExpression(node.value, rewrites)

			return value === node.value ? node : { ...node, value }
		}
		case "Intrinsic":
			return walkIntrinsicChildren(node, rewrites)
		// NOTE: The leaves — a Literal holds its own value, an Identifier a
		// name, and neither has anywhere for an Expression to hide.
		case "StringValue":
		case "IntegerValue":
		case "RationalValue":
		case "BooleanValue":
		case "Identifier":
			return node
	}
}

// NOTE: A Match's Handlers, walked the same whether the Match is still an
// Expression or has been lowered to a Statement — one reading, so the two forms
// can not be reached differently.
//
// NOTE: A residual Type test is walked like any other Expression, so a pass that
// runs after the one which wrote it reads it — and, as with the test under an
// `essence-boolean`, what a later pass may not do is answer it with a Node of
// the wrong KIND: it stands where JavaScript says `if (…)`, so an Essence
// Boolean value there would be an object, and every object is true.
function walkHandlers(
	handlers: Array<common.typedSimple.MatchHandler>,
	rewrites: NodeRewrites,
): Array<common.typedSimple.MatchHandler> {
	return mapArray(handlers, (handler) => {
		let typeTest =
			handler.typeTest === null
				? null
				: walkExpression(handler.typeTest, rewrites)
		let literal =
			handler.literal === null
				? null
				: walkExpression(handler.literal, rewrites)
		let memberLiterals =
			handler.memberLiterals === null
				? null
				: mapRecord(handler.memberLiterals, (member) =>
						walkExpression(member, rewrites),
					)
		// NOTE: `memberTypes` holds Types and is walked past; `memberTests` is
		// what `compile-type-tests` compiled them into, and is Expressions like
		// any other — a pass that rewrote every Expression but these would leave
		// a Handler's requirements reading the shape the pass before it replaced.
		let memberTests =
			handler.memberTests === null
				? null
				: mapRecord(handler.memberTests, (test) =>
						walkExpression(test, rewrites),
					)
		let guard =
			handler.guard === null
				? null
				: walkExpression(handler.guard, rewrites)
		let body = walkBody(handler.body, rewrites)

		if (
			typeTest === handler.typeTest &&
			literal === handler.literal &&
			memberLiterals === handler.memberLiterals &&
			memberTests === handler.memberTests &&
			guard === handler.guard &&
			body === handler.body
		) {
			return handler
		}

		return {
			...handler,
			typeTest,
			literal,
			memberLiterals,
			memberTests,
			guard,
			body,
		}
	})
}

// NOTE: An intrinsic is walked like anything else. A pass that runs after the
// one which produced it reads the shape it left — a `direct-record`'s members
// are the Record's members, wherever the Record came from — and a pass that
// only ever sees the Simplifier's own Nodes is a pass whose order in the
// registry decides what it can do.
function walkIntrinsicChildren(
	node: common.typedSimple.IntrinsicNode,
	rewrites: NodeRewrites,
): ExpressionNode {
	switch (node.kind) {
		// NOTE: A `tag-test`'s value and an `essence-boolean`'s test are
		// ordinary positions and are offered like any other — what a later pass
		// may not do is answer one of them with a Node of the wrong KIND. The
		// value under a test is an Essence value, but the test itself is a raw
		// JavaScript boolean, and a pass that rewrote it into an Essence Boolean
		// would leave a value object where a condition belongs. Nothing does:
		// every pass matches the shapes the Simplifier produces, and none of
		// those is a raw one.
		case "tag-test":
		case "essence-boolean":
		// NOTE: A `raw-boolean`'s value is the Essence Boolean it reads the
		// JavaScript one out of, and is an ordinary position like the two
		// above — with the same rule about kinds, from the other side: what
		// stands here is a value, and what this Node ANSWERS is raw.
		case "raw-boolean":
		// NOTE: A pooled reference's value is the value the const band
		// declares, and it is walked like any other — with the one thing a
		// pass may not do being to change it without changing the `key` that
		// says which pooled constant it IS. Nothing does: `pool-constants` is
		// the last pass to run, so nothing reads its output but the Rewriter.
		case "pooled-reference": {
			let value = walkExpression(node.value, rewrites)

			return value === node.value ? node : { ...node, value }
		}
		case "type-test": {
			let value = walkExpression(node.value, rewrites)
			let descriptor = walkExpression(node.descriptor, rewrites)

			if (value === node.value && descriptor === node.descriptor) {
				return node
			}

			return { ...node, value, descriptor }
		}
		// NOTE: The leaves. A Type is not an Expression, and the descriptor is
		// the whole of what a `type-descriptor` holds; a `direct-method` holds
		// two names and no Expression at all; an `omitted-argument` holds
		// nothing whatever — it is a position held open, not a value.
		case "type-descriptor":
		case "direct-method":
		case "omitted-argument":
			return node
		// NOTE: A lowered operation's operands are the Expressions the
		// Invocation was given, in the order it was given them — so a pass
		// running after the one that lowered it reads them, and
		// `pool-constants` finds the literal standing in one.
		case "raw-boolean-op": {
			let operand = walkExpression(node.operand, rewrites)
			let other =
				node.other === null
					? null
					: walkExpression(node.other, rewrites)

			if (operand === node.operand && other === node.other) {
				return node
			}

			return { ...node, operand, other }
		}
		case "raw-compare":
		case "raw-equals":
		case "raw-arithmetic": {
			let left = walkExpression(node.left, rewrites)
			let right = walkExpression(node.right, rewrites)

			if (left === node.left && right === node.right) {
				return node
			}

			return { ...node, left, right }
		}
		case "direct-record": {
			let members = mapRecord(node.members, (value) =>
				walkExpression(value, rewrites),
			)

			return members === node.members ? node : { ...node, members }
		}
		case "direct-case": {
			let members = mapRecord(node.members, (value) =>
				walkExpression(value, rewrites),
			)
			let payload =
				node.payload === null
					? null
					: walkExpression(node.payload, rewrites)

			if (members === node.members && payload === node.payload) {
				return node
			}

			return { ...node, members, payload }
		}
		case "direct-list": {
			let values = mapArray(node.values, (value) =>
				walkExpression(value, rewrites),
			)

			return values === node.values ? node : { ...node, values }
		}
		// NOTE: The items a turn adds to the Array a walk builds. They are the
		// Expressions the `append` calls were given and are offered exactly as
		// those Arguments were, which is what keeps `pool-constants` reaching a
		// literal written inside a build and `fold-constants` folding one.
		case "list-build": {
			let additions = mapArray(node.additions, (addition) => {
				let value = walkExpression(addition.value, rewrites)

				return value === addition.value
					? addition
					: { ...addition, value }
			})

			return additions === node.additions ? node : { ...node, additions }
		}
		// NOTE: A compiled dispatch is walked in the order it evaluates: the
		// Expressions it holds under a name, then the reads of them, then each
		// branch's test and the Arguments that branch alone passes. The reads
		// are ordinary Expressions and are offered like any other — a later pass
		// finding a name there has nothing to do with it, and one finding the
		// Expression itself (where the chain has one branch and holds nothing)
		// may rewrite it exactly as it would anywhere else.
		case "dispatch-chain": {
			let temporaries = mapArray(node.temporaries, (temporary) => {
				let value = walkExpression(temporary.value, rewrites)

				return value === temporary.value
					? temporary
					: { ...temporary, value }
			})
			let receiver = walkExpression(node.receiver, rewrites)
			let args = mapArray(node.arguments, (value) =>
				walkExpression(value, rewrites),
			)
			let cases = mapArray(node.cases, (dispatchCase) => {
				let test =
					dispatchCase.test === null
						? null
						: walkExpression(dispatchCase.test, rewrites)
				let conformanceArguments = mapArray(
					dispatchCase.conformanceArguments,
					(value) => walkExpression(value, rewrites),
				)
				let contextualArguments = mapArray(
					dispatchCase.contextualArguments,
					(contextual) => {
						let value = walkExpression(contextual.value, rewrites)

						return value === contextual.value
							? contextual
							: { ...contextual, value }
					},
				)

				if (
					test === dispatchCase.test &&
					conformanceArguments ===
						dispatchCase.conformanceArguments &&
					contextualArguments === dispatchCase.contextualArguments
				) {
					return dispatchCase
				}

				return {
					...dispatchCase,
					test,
					conformanceArguments,
					contextualArguments,
				}
			})

			if (
				temporaries === node.temporaries &&
				receiver === node.receiver &&
				args === node.arguments &&
				cases === node.cases
			) {
				return node
			}

			return {
				...node,
				temporaries,
				receiver,
				arguments: args,
				cases,
			}
		}
		case "spread-combination": {
			let lhs = walkExpression(node.lhs, rewrites)
			let members = mapRecord(node.members, (value) =>
				walkExpression(value, rewrites),
			)
			let rhs =
				node.rhs === null ? null : walkExpression(node.rhs, rewrites)

			if (
				lhs === node.lhs &&
				members === node.members &&
				rhs === node.rhs
			) {
				return node
			}

			return { ...node, lhs, members, rhs }
		}
		// NOTE: The same walk the Statement form gets, because it is the same
		// loop — one written where a Statement can hold it, one wrapped in an
		// arrow because its position can not.
		case "inline-loop": {
			let driver = walkInlineLoopDriver(node.driver, rewrites)

			return driver === node.driver ? node : { ...node, driver }
		}
	}
}
