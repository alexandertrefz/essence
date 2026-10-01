import type { common } from "@essence-lang/interfaces"

// The one bottom-up walk every pass shares. It never mutates, and hands back
// an unchanged Node as itself. See "The shared walk" in DEVELOPMENT.md.

type ExpressionNode = common.typedSimple.ExpressionNode
type ImplementationNode = common.typedSimple.ImplementationNode
type FunctionDefinitionNode = common.typedSimple.FunctionDefinitionNode
type ArgumentNode = common.typedSimple.ArgumentNode

// One Expression in, its replacement out. Answering the argument leaves it
// alone.
type ExpressionRewrite = (node: ExpressionNode) => ExpressionNode

// One Node in a Statement position, which an Expression written for its
// effects also stands in. Such a Node is offered to both hooks.
type StatementRewrite = (node: ImplementationNode) => ImplementationNode

// A whole body, after each Statement in it was walked. The one hook that may
// change how many Statements there are. Answer the given array to change
// nothing.
type BodyRewrite = (
	nodes: Array<ImplementationNode>,
) => Array<ImplementationNode>

// The hooks a pass asks for, all offered by one walk. See "Hooks" in
// DEVELOPMENT.md.
type NodeRewrites = {
	expression?: ExpressionRewrite
	statement?: StatementRewrite
	body?: BodyRewrite
	// Whether to descend into a Parameter's default, which has no Statement
	// before it to lift work into. A pass that rewrites in place, or only
	// reads, asks.
	parameterDefaults?: true
}

// Bottom-up for Statements too: a Statement's Expressions and bodies are
// rewritten before it is offered.
export function rewriteNodes(
	program: common.typedSimple.Program,
	rewrites: NodeRewrites,
): common.typedSimple.Program {
	let nodes = walkBody(program.implementation.nodes, rewrites)
	let tests = walkTests(program.tests, rewrites)

	if (nodes === program.implementation.nodes && tests === program.tests) {
		return program
	}

	return {
		...program,
		implementation: { ...program.implementation, nodes },
		tests,
	}
}

// Walked by the same passes as the implementation, so `eliminate-dead-code`
// sees what a test reads. Null in every compile that did not ask for tests.
function walkTests(
	section: common.typedSimple.TestsSectionNode | null,
	rewrites: NodeRewrites,
): common.typedSimple.TestsSectionNode | null {
	if (section === null) {
		return null
	}

	let nodes = walkTestsNodes(section.nodes, rewrites)

	return nodes === section.nodes ? section : { ...section, nodes }
}

// A Scope's run of Nodes. Not `walkBody`, so the `body` hook can never drop a
// test. Each test's own body goes through `walkBody`.
function walkTestsNodes(
	nodes: Array<common.typedSimple.TestsNode>,
	rewrites: NodeRewrites,
): Array<common.typedSimple.TestsNode> {
	return mapArray(nodes, (node) => {
		if (node.nodeType === "TestEntry") {
			let name =
				node.name === null ? null : walkExpression(node.name, rewrites)
			let body = walkBody(node.body, rewrites)

			return name === node.name && body === node.body
				? node
				: { ...node, name, body }
		}

		if (node.nodeType === "TestRows") {
			let name =
				node.name === null ? null : walkExpression(node.name, rewrites)
			let rows = mapArray(node.rows, (row) =>
				walkExpression(row, rewrites),
			)
			// Not `walkBody`, which could part the bindings from their row.
			let bindings = mapArray(node.bindings, (binding) =>
				walkImplementation(binding, rewrites),
			)
			let body = walkBody(node.body, rewrites)

			return name === node.name &&
				rows === node.rows &&
				bindings === node.bindings &&
				body === node.body
				? node
				: { ...node, name, rows, bindings, body }
		}

		if (node.nodeType === "TestProperties") {
			let name =
				node.name === null ? null : walkExpression(node.name, rewrites)
			// A generator's Expressions are ordinary Expressions of the Module.
			let parameters = mapArray(node.parameters, (parameter) => {
				let generator = walkGenerator(parameter.generator, rewrites)

				return generator === parameter.generator
					? parameter
					: { ...parameter, generator }
			})
			let body = walkBody(node.body, rewrites)

			return name === node.name &&
				parameters === node.parameters &&
				body === node.body
				? node
				: { ...node, name, parameters, body }
		}

		if (node.nodeType === "TestScope") {
			let scoped = walkTestsNodes(node.nodes, rewrites)

			return scoped === node.nodes ? node : { ...node, nodes: scoped }
		}

		return walkImplementation(node, rewrites)
	})
}

function walkGenerator(
	generator: common.typedSimple.TestGenerator,
	rewrites: NodeRewrites,
): common.typedSimple.TestGenerator {
	if (generator.kind === "list") {
		let item = walkGenerator(generator.item, rewrites)

		return item === generator.item ? generator : { ...generator, item }
	}

	if (generator.kind === "dictionary") {
		let key = walkGenerator(generator.key, rewrites)
		let value = walkGenerator(generator.value, rewrites)
		let keyConformance = walkWitness(generator.keyConformance, rewrites)

		return key === generator.key &&
			value === generator.value &&
			keyConformance === generator.keyConformance
			? generator
			: {
					...generator,
					key,
					value,
					...(keyConformance === undefined ? {} : { keyConformance }),
				}
	}

	if (generator.kind === "record" || generator.kind === "case") {
		let members = mapArray(generator.members, (member) => {
			let walked = walkGenerator(member.generator, rewrites)

			return walked === member.generator
				? member
				: { ...member, generator: walked }
		})

		return members === generator.members
			? generator
			: { ...generator, members }
	}

	if (generator.kind === "union") {
		let members = mapArray(generator.members, (member) =>
			walkGenerator(member, rewrites),
		)

		return members === generator.members
			? generator
			: { ...generator, members }
	}

	if (generator.kind === "refined") {
		let base = walkGenerator(generator.base, rewrites)
		let checks = mapArray(generator.checks, (check) =>
			walkExpression(check, rewrites),
		)

		return base === generator.base && checks === generator.checks
			? generator
			: { ...generator, base, checks }
	}

	if (generator.kind === "generated") {
		let call = walkExpression(generator.call, rewrites)
		let shrink = walkExpression(generator.shrink, rewrites)

		return call === generator.call && shrink === generator.shrink
			? generator
			: { ...generator, call, shrink }
	}

	return generator
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

// One Expression, walked by the switch a Program's Expressions are walked by.
// See "Positions" in DEVELOPMENT.md.
export function rewriteExpressionsIn(
	node: ExpressionNode,
	rewrite: ExpressionRewrite,
): ExpressionNode {
	return walkExpression(node, { expression: rewrite })
}

// One run of Statements, walked and then offered whole. Every body goes
// through this, once.
function walkBody(
	nodes: Array<ImplementationNode>,
	rewrites: NodeRewrites,
): Array<ImplementationNode> {
	let walked = mapArray(nodes, (node) => walkImplementation(node, rewrites))

	return rewrites.body === undefined ? walked : rewrites.body(walked)
}

// Maps every entry in order, but copies only once an entry changed.
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

// Keeps the insertion order, which the runtime's Record equality and printer
// read off the emitted literal.
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

// Every Statement position, offered once, after its children.
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
			// A Method's body is walked, but its Function literal is emitted as
			// a class member, not a value, and is not offered.
			let methods = mapRecord(node.methods, (entry) => {
				let value = walkFunctionDefinition(entry.method.value, rewrites)

				if (value === entry.method.value) {
					return entry
				}

				return { ...entry, method: { ...entry.method, value } }
			})

			// A native Method's shim has only its Parameter defaults to walk.
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
		// The Arguments a turn evaluates, then the values it assigns, in the
		// order they run. None is offered as a Statement, which a pass could move.
		case "TailCallStatement": {
			let bindings = mapArray(node.bindings, (binding) => {
				let value = walkExpression(binding.value, rewrites)

				return value === binding.value ? binding : { ...binding, value }
			})
			let assignments = mapArray(node.assignments, (assignment) => {
				let value = walkExpression(assignment.value, rewrites)

				return value === assignment.value
					? assignment
					: { ...assignment, value }
			})

			return bindings === node.bindings &&
				assignments === node.assignments
				? node
				: { ...node, bindings, assignments }
		}
		case "IntrinsicStatement":
			return walkIntrinsicStatementChildren(node, rewrites)
		// Walked as the Handler it holds. Nothing is offered as a Statement,
		// since moving one would lose the early return of a `require`.
		case "TestAssertionStatement": {
			let value = walkExpression(node.value, rewrites)
			let matcher =
				node.matcher === null
					? null
					: walkHandler(node.matcher, rewrites)

			return value === node.value && matcher === node.matcher
				? node
				: { ...node, value, matcher }
		}
		// A provided Method's body is walked as a Namespace Method's is.
		case "ProtocolDeclarationStatement": {
			let methods = mapRecord(node.methods, (entry) => {
				let value = walkFunctionDefinition(entry.method.value, rewrites)

				if (value === entry.method.value) {
					return entry
				}

				return { ...entry, method: { ...entry.method, value } }
			})

			return methods === node.methods ? node : { ...node, methods }
		}
		// A Type Alias holds only a name and a Type here.
		case "TypeAliasStatement":
			return node
		default:
			return walkExpression(node, rewrites)
	}
}

// The same positions, in the same order, as the Expression it was lowered
// from.
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

// Walked like the call it replaced. A Parameter is a binding and is not
// offered.
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

// The body, and the Parameter defaults when a pass asked for them.
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

// The one place a default is walked, for a Function, a Method, and the
// bodiless frame synthesized for a native's defaults.
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

// The Expression positions a Node holds, and only those. A `base` and a
// `member` are Identifiers but not values.
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
			// A dispatch case's own Arguments, its witnesses and the Function literals
			// compiled for its Method, are Expressions the Program evaluates.
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
			let keyConformance = walkWitness(node.keyConformance, rewrites)

			if (
				lhs === node.lhs &&
				rhs === node.rhs &&
				keyConformance === node.keyConformance
			) {
				return node
			}

			return {
				...node,
				lhs,
				rhs,
				...(keyConformance === undefined ? {} : { keyConformance }),
			}
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
		case "DictionaryValue": {
			let entries = mapArray(node.entries, (entry) => {
				let key = walkExpression(entry.key, rewrites)
				let value = walkExpression(entry.value, rewrites)

				return key === entry.key && value === entry.value
					? entry
					: { key, value }
			})
			let keyConformance =
				node.keyConformance === null
					? null
					: walkExpression(node.keyConformance, rewrites)

			if (
				entries === node.entries &&
				keyConformance === node.keyConformance
			) {
				return node
			}

			return { ...node, entries, keyConformance }
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
		// In evaluation order: each arm's Condition, then its value, and the
		// `otherwise` value last. Passes that hoist or pool read the run order here.
		case "Define": {
			let arms = mapArray(node.arms, (arm) => {
				let condition = walkExpression(arm.condition, rewrites)
				let value = walkExpression(arm.value, rewrites)

				return condition === arm.condition && value === arm.value
					? arm
					: { ...arm, condition, value }
			})
			let otherwise = walkExpression(node.otherwise, rewrites)

			if (arms === node.arms && otherwise === node.otherwise) {
				return node
			}

			return { ...node, arms, otherwise }
		}
		case "ConformanceValue": {
			let conditions = mapArray(node.conditions, (condition) =>
				walkExpression(condition, rewrites),
			)
			// A witness of the group is no value of its own, and its
			// conditions stand in the group's.
			let groupConditions =
				node.groupConditions === undefined
					? undefined
					: mapArray(node.groupConditions, (condition) =>
							walkExpression(condition, rewrites),
						)

			return conditions === node.conditions &&
				groupConditions === node.groupConditions
				? node
				: {
						...node,
						conditions,
						...(groupConditions === undefined
							? {}
							: { groupConditions }),
					}
		}
		case "CaseValue": {
			let value =
				node.value === null
					? null
					: walkExpression(node.value, rewrites)

			return value === node.value ? node : { ...node, value }
		}
		// The operand of either keyword is an ordinary Expression.
		case "Start":
		case "Complete": {
			let expression = walkExpression(node.expression, rewrites)

			return expression === node.expression
				? node
				: { ...node, expression }
		}
		case "Intrinsic":
			return walkIntrinsicChildren(node, rewrites)
		// An instrumented point is offered as the Expression it wraps.
		case "TestTrace": {
			let value = walkExpression(node.value, rewrites)

			return value === node.value ? node : { ...node, value }
		}
		// A coverage counter likewise, where it wraps a value at all.
		case "CoverageCounter": {
			let value =
				node.value === null
					? null
					: walkExpression(node.value, rewrites)

			return value === node.value ? node : { ...node, value }
		}
		// The leaves.
		case "StringValue":
		case "IntegerValue":
		case "RationalValue":
		case "BooleanValue":
		case "Identifier":
			return node
	}
}

// A witness a Node carries beside its Expressions, walked like a bounded
// call's trailing Arguments. `pool-constants` shares one across its sites.
function walkWitness(
	witness: common.typedSimple.ExpressionNode | undefined,
	rewrites: NodeRewrites,
): common.typedSimple.ExpressionNode | undefined {
	return witness === undefined ? undefined : walkExpression(witness, rewrites)
}

// Walked the same whether the Match is an Expression or lowered. A residual
// Type test must stay a JavaScript condition. See "Positions" in
// DEVELOPMENT.md.
function walkHandlers(
	handlers: Array<common.typedSimple.MatchHandler>,
	rewrites: NodeRewrites,
): Array<common.typedSimple.MatchHandler> {
	return mapArray(handlers, (handler) => walkHandler(handler, rewrites))
}

// One Handler, which is also all an assertion such as `require #Value = x`
// holds.
function walkHandler(
	handler: common.typedSimple.MatchHandler,
	rewrites: NodeRewrites,
): common.typedSimple.MatchHandler {
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
	// `memberTypes` holds Types, but `memberTests`, which `compile-type-tests`
	// compiled them into, holds Expressions.
	let memberTests =
		handler.memberTests === null
			? null
			: mapRecord(handler.memberTests, (test) =>
					walkExpression(test, rewrites),
				)
	let guard =
		handler.guard === null ? null : walkExpression(handler.guard, rewrites)
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
}

// Walked like any other Node, so a later pass reads what an earlier one left.
function walkIntrinsicChildren(
	node: common.typedSimple.IntrinsicNode,
	rewrites: NodeRewrites,
): ExpressionNode {
	switch (node.kind) {
		// A `tag-test`'s value and an `essence-boolean`'s test are offered like any
		// other. A pass may not answer the raw JavaScript test with an Essence Boolean,
		// which would leave an object where a condition belongs.
		case "tag-test":
		case "essence-boolean":
		// A `raw-boolean`'s value is an Essence Boolean, though the Node answers a raw
		// one.
		case "raw-boolean":
		// A pooled reference's value may not change without its `key`. Only the
		// rewriter reads it, since `pool-constants` runs last.
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
		// The leaves. An `omitted-argument` is a position held open, not a value.
		case "type-descriptor":
		case "direct-method":
		case "omitted-argument":
			return node
		// A lowered operation's operands are the Invocation's Arguments, in their
		// order.
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
		// The base is the Parameter being rebuilt and the fallback is the default's
		// own Expression. `member` is a name, not a Node.
		case "member-or-default": {
			let base = walkExpression(node.base, rewrites)
			let fallback = walkExpression(node.fallback, rewrites)

			if (base === node.base && fallback === node.fallback) {
				return node
			}

			return { ...node, base, fallback }
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
		// The items a turn appends, offered as the `append` Arguments were.
		case "list-build": {
			let additions = mapArray(node.additions, (addition) => {
				let value = walkExpression(addition.value, rewrites)

				return value === addition.value
					? addition
					: { ...addition, value }
			})

			return additions === node.additions ? node : { ...node, additions }
		}
		// In evaluation order: the held Expressions, the reads of them, then each
		// branch's test and its own Arguments.
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
		// The same loop as the Statement form, wrapped in an arrow where no Statement
		// can stand.
		case "inline-loop": {
			let driver = walkInlineLoopDriver(node.driver, rewrites)

			return driver === node.driver ? node : { ...node, driver }
		}
	}
}
