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

// NOTE: There is deliberately no Statement hook yet. Every pass to date
// rewrites Expressions, and a hook nothing calls is a contract nothing keeps;
// the walk already REACHES every Statement position, so adding one is a matter
// of offering the Node rather than of finding it.
export function rewriteExpressions(
	program: common.typedSimple.Program,
	rewrite: ExpressionRewrite,
): common.typedSimple.Program {
	let nodes = mapArray(program.implementation.nodes, (node) =>
		walkImplementation(node, rewrite),
	)

	if (nodes === program.implementation.nodes) {
		return program
	}

	return {
		...program,
		implementation: { ...program.implementation, nodes },
	}
}

function mapArray<Value>(
	values: Array<Value>,
	map: (value: Value) => Value,
): Array<Value> {
	let changed = false
	let mapped = values.map((value) => {
		let result = map(value)

		if (result !== value) {
			changed = true
		}

		return result
	})

	return changed ? mapped : values
}

// NOTE: Insertion order is preserved, which is not a detail — a Record's
// members are emitted in the order they are written, and `Object.keys` over the
// emitted literal is what the runtime's Record equality and its printer read.
function mapRecord<Value>(
	members: Record<string, Value>,
	map: (value: Value) => Value,
): Record<string, Value> {
	let changed = false
	let mapped: Record<string, Value> = {}

	for (let [name, value] of Object.entries(members)) {
		let result = map(value)

		if (result !== value) {
			changed = true
		}

		mapped[name] = result
	}

	return changed ? mapped : members
}

function walkImplementation(
	node: ImplementationNode,
	rewrite: ExpressionRewrite,
): ImplementationNode {
	switch (node.nodeType) {
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement": {
			let value = walkExpression(node.value, rewrite)

			return value === node.value ? node : { ...node, value }
		}
		case "NamespaceDefinitionStatement": {
			let properties = mapRecord(node.properties, (value) =>
				walkExpression(value, rewrite),
			)
			// NOTE: A Method's body is walked, the Function literal holding it is
			// not offered to the pass: the Rewriter emits it as a class member
			// rather than as a value, so there is no position there for another
			// kind of Expression to stand in. A Namespace's static Properties
			// above ARE values, and are offered like any other.
			let methods = mapRecord(node.methods, (entry) => {
				let value = walkFunctionDefinition(entry.method.value, rewrite)

				if (value === entry.method.value) {
					return entry
				}

				return { ...entry, method: { ...entry.method, value } }
			})

			if (properties === node.properties && methods === node.methods) {
				return node
			}

			return { ...node, properties, methods }
		}
		case "ConditionalStatement": {
			let condition = walkExpression(node.condition, rewrite)
			let trueBody = mapArray(node.trueBody, (entry) =>
				walkImplementation(entry, rewrite),
			)
			let falseBody = mapArray(node.falseBody, (entry) =>
				walkImplementation(entry, rewrite),
			)

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
			let expression = walkExpression(node.expression, rewrite)

			return expression === node.expression
				? node
				: { ...node, expression }
		}
		case "FunctionStatement": {
			let value = walkFunctionDefinition(node.value, rewrite)

			return value === node.value ? node : { ...node, value }
		}
		// NOTE: A Protocol declaration and a Type Alias carry nothing but names
		// and Types by this point — the Rewriter emits nothing at all for
		// either.
		case "ProtocolDeclarationStatement":
		case "TypeAliasStatement":
			return node
		default:
			return walkExpression(node, rewrite)
	}
}

function walkFunctionDefinition(
	node: FunctionDefinitionNode,
	rewrite: ExpressionRewrite,
): FunctionDefinitionNode {
	let body = mapArray(node.body, (entry) =>
		walkImplementation(entry, rewrite),
	)

	return body === node.body ? node : { ...node, body }
}

function walkArguments(
	args: Array<ArgumentNode>,
	rewrite: ExpressionRewrite,
): Array<ArgumentNode> {
	return mapArray(args, (argument) => {
		let value = walkExpression(argument.value, rewrite)

		return value === argument.value ? argument : { ...argument, value }
	})
}

function walkExpression(
	node: ExpressionNode,
	rewrite: ExpressionRewrite,
): ExpressionNode {
	return rewrite(walkChildren(node, rewrite))
}

// NOTE: The Expression positions a Node holds — and only those. A `type` is
// walked by nobody: it is a Type, not an Expression, and a Match's `matcher` is
// one as well. The three Identifier positions that LOOK like Expressions are
// left alone on purpose: a `MethodInvocation`'s `base` names the answering
// Namespace, a `NativeFunctionInvocation`'s `name` the runtime Function and a
// `Lookup`'s `member` the member being read. None of them is a value the
// Program computes, and none of their fields can hold anything but an
// Identifier.
function walkChildren(
	node: ExpressionNode,
	rewrite: ExpressionRewrite,
): ExpressionNode {
	switch (node.nodeType) {
		case "NativeFunctionInvocation":
		case "MethodInvocation": {
			let args = walkArguments(node.arguments, rewrite)

			return args === node.arguments ? node : { ...node, arguments: args }
		}
		case "FunctionInvocation": {
			let name = walkExpression(node.name, rewrite)
			let args = walkArguments(node.arguments, rewrite)

			if (name === node.name && args === node.arguments) {
				return node
			}

			return { ...node, name, arguments: args }
		}
		case "UnionMethodInvocation": {
			let base = walkExpression(node.base, rewrite)
			let args = walkArguments(node.arguments, rewrite)
			// NOTE: A dispatch case carries Arguments of its own — the hidden
			// conformance witnesses every branch needs, and the Function
			// literals compiled against THIS branch's Method. Both are ordinary
			// Expressions the Program evaluates, so both are walked.
			let cases = mapArray(node.cases, (dispatch) => {
				let conformanceArguments = walkArguments(
					dispatch.conformanceArguments,
					rewrite,
				)
				let contextualArguments = mapArray(
					dispatch.contextualArguments,
					(entry) => {
						let value = walkExpression(
							entry.argument.value,
							rewrite,
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
			let lhs = walkExpression(node.lhs, rewrite)
			let rhs = walkExpression(node.rhs, rewrite)

			if (lhs === node.lhs && rhs === node.rhs) {
				return node
			}

			return { ...node, lhs, rhs }
		}
		case "RecordValue": {
			let members = mapRecord(node.members, (value) =>
				walkExpression(value, rewrite),
			)

			return members === node.members ? node : { ...node, members }
		}
		case "InterpolatedStringValue": {
			let segments = mapArray(node.segments, (segment) => {
				if (segment.kind === "text") {
					return segment
				}

				let expression = walkExpression(segment.expression, rewrite)
				let witness = walkExpression(segment.witness, rewrite)

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
			let value = walkFunctionDefinition(node.value, rewrite)

			return value === node.value ? node : { ...node, value }
		}
		case "ListValue": {
			let values = mapArray(node.values, (value) =>
				walkExpression(value, rewrite),
			)

			return values === node.values ? node : { ...node, values }
		}
		case "Lookup": {
			let base = walkExpression(node.base, rewrite)

			return base === node.base ? node : { ...node, base }
		}
		case "Match": {
			let value = walkExpression(node.value, rewrite)
			let handlers = mapArray(node.handlers, (handler) => {
				// NOTE: A residual Type test is walked like any other
				// Expression, so a pass that runs after the one which wrote it
				// reads it — and, as with the test under an `essence-boolean`,
				// what a later pass may not do is answer it with a Node of the
				// wrong KIND: it stands where JavaScript says `if (…)`, so an
				// Essence Boolean value there would be an object, and every
				// object is true.
				let typeTest =
					handler.typeTest === null
						? null
						: walkExpression(handler.typeTest, rewrite)
				let literal =
					handler.literal === null
						? null
						: walkExpression(handler.literal, rewrite)
				let memberLiterals =
					handler.memberLiterals === null
						? null
						: mapRecord(handler.memberLiterals, (member) =>
								walkExpression(member, rewrite),
							)
				let guard =
					handler.guard === null
						? null
						: walkExpression(handler.guard, rewrite)
				let body = mapArray(handler.body, (entry) =>
					walkImplementation(entry, rewrite),
				)

				if (
					typeTest === handler.typeTest &&
					literal === handler.literal &&
					memberLiterals === handler.memberLiterals &&
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
					guard,
					body,
				}
			})

			if (value === node.value && handlers === node.handlers) {
				return node
			}

			return { ...node, value, handlers }
		}
		case "ConformanceValue": {
			let conditions = mapArray(node.conditions, (condition) =>
				walkExpression(condition, rewrite),
			)

			return conditions === node.conditions
				? node
				: { ...node, conditions }
		}
		case "CaseValue": {
			let value =
				node.value === null ? null : walkExpression(node.value, rewrite)

			return value === node.value ? node : { ...node, value }
		}
		case "Intrinsic":
			return walkIntrinsicChildren(node, rewrite)
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

// NOTE: An intrinsic is walked like anything else. A pass that runs after the
// one which produced it reads the shape it left — a `direct-record`'s members
// are the Record's members, wherever the Record came from — and a pass that
// only ever sees the Simplifier's own Nodes is a pass whose order in the
// registry decides what it can do.
function walkIntrinsicChildren(
	node: common.typedSimple.IntrinsicNode,
	rewrite: ExpressionRewrite,
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
			let value = walkExpression(node.value, rewrite)

			return value === node.value ? node : { ...node, value }
		}
		case "type-test": {
			let value = walkExpression(node.value, rewrite)
			let descriptor = walkExpression(node.descriptor, rewrite)

			if (value === node.value && descriptor === node.descriptor) {
				return node
			}

			return { ...node, value, descriptor }
		}
		// NOTE: The leaves. A Type is not an Expression, and the descriptor is
		// the whole of what a `type-descriptor` holds; a `direct-method` holds
		// two names and no Expression at all.
		case "type-descriptor":
		case "direct-method":
			return node
		// NOTE: A lowered operation's operands are the Expressions the
		// Invocation was given, in the order it was given them — so a pass
		// running after the one that lowered it reads them, and
		// `pool-constants` finds the literal standing in one.
		case "raw-boolean-op": {
			let operand = walkExpression(node.operand, rewrite)
			let other =
				node.other === null ? null : walkExpression(node.other, rewrite)

			if (operand === node.operand && other === node.other) {
				return node
			}

			return { ...node, operand, other }
		}
		case "raw-compare":
		case "raw-equals":
		case "raw-arithmetic": {
			let left = walkExpression(node.left, rewrite)
			let right = walkExpression(node.right, rewrite)

			if (left === node.left && right === node.right) {
				return node
			}

			return { ...node, left, right }
		}
		case "direct-record": {
			let members = mapRecord(node.members, (value) =>
				walkExpression(value, rewrite),
			)

			return members === node.members ? node : { ...node, members }
		}
		case "direct-case": {
			let members = mapRecord(node.members, (value) =>
				walkExpression(value, rewrite),
			)
			let payload =
				node.payload === null
					? null
					: walkExpression(node.payload, rewrite)

			if (members === node.members && payload === node.payload) {
				return node
			}

			return { ...node, members, payload }
		}
		case "direct-list": {
			let values = mapArray(node.values, (value) =>
				walkExpression(value, rewrite),
			)

			return values === node.values ? node : { ...node, values }
		}
		case "spread-combination": {
			let lhs = walkExpression(node.lhs, rewrite)
			let members = mapRecord(node.members, (value) =>
				walkExpression(value, rewrite),
			)
			let rhs =
				node.rhs === null ? null : walkExpression(node.rhs, rewrite)

			if (
				lhs === node.lhs &&
				members === node.members &&
				rhs === node.rhs
			) {
				return node
			}

			return { ...node, lhs, members, rhs }
		}
	}
}
