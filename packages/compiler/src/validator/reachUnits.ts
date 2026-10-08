import type { common } from "@essence-lang/interfaces"

import { displayProtocolName } from "../helpers/describe"
import { forEachHeldRecord } from "../helpers/nodes"
import { forEachTypedChild, type TypedNode } from "../visitor/index"

// What code needs while it runs. See "Use before declaration" in
// DEVELOPMENT.md.
export type Dependency = {
	// A Namespace's class, a top-level Constant, a static Property, whose
	// `name` is `Namespace.member`, or a name bound from another Module of the
	// import cycle.
	kind: "namespace" | "constant" | "property" | "cycle"
	name: string
	position: common.Position
	label: string
	// The top-level Namespace whose class holds the code, which names that
	// class through the class's own binding.
	home: string | null
}

// A body run from here, at `position`, labelled for the Statement it starts in.
export type Run = { target: string; position: common.Position; label: string }

// A stretch of code that runs at once. It is a Statement, a static Property's
// value, or a body's part before or after its first suspension.
export type Unit = {
	id: string
	// A root's place among the Properties its Statement gives values, from 1.
	step: number
	// How a Note names the body, as `'run'` or `'Parity::isEvenly'`.
	name: string
	dependencies: Array<Dependency>
	runs: Array<Run>
	// The bodies whose values escape: stored, handed on or answered.
	escapes: Array<string>
	// Bodies started here whose part after their first suspension runs later.
	tails: Array<{ id: string; position: common.Position }>
	// The first call here that runs a Function value nothing names.
	unknownCall: common.Position | null
}

// A Function's or a Method's body. A completing body runs only when started,
// so a call of it runs nothing.
export type Body = {
	id: string
	head: Unit
	tail: Unit | null
	completing: boolean
	// The top-level Statement whose text holds the body.
	statement: number
}

export type Units = {
	bodies: Map<string, Body>
	roots: Array<Array<Unit>>
	// The bodies each top-level Statement's text holds, nested ones included.
	declared: Array<Array<Body>>
	// For each Statement, the first one at or after it that may suspend.
	suspensions: Array<number>
}

// `declared` is the index of the top-level Statement that declares a
// Constant or a Variable.
type Binding =
	| { kind: "value"; bodies: Array<string> | null; declared?: number }
	| { kind: "namespace"; id: string }

type Scope = { parent: Scope | null; names: Map<string, Binding> }

type Builder = {
	bodies: Map<string, Body>
	literals: WeakMap<object, string>
	count: number
	// The top-level Statement being walked, which holds each body made now.
	statement: number
	// The top-level Namespaces, whose classes are bound where they are written.
	namespaces: ReadonlySet<string>
	// The names bound from another Module of the import cycle.
	cycleMates: ReadonlySet<string>
}

type Walk = {
	build: Builder
	unit: Unit
	scope: Scope
	home: string | null
	body: Body | null
}

// How code uses a value: calls or starts it, binds it to a name, or anything
// else, where a Function value escapes.
type Use = "call" | "bound" | "value"

// A body declared but not walked yet, so every body exists before any call
// to it is read.
type Pending = {
	definition: common.typed.FunctionDefinitionNode
	body: Body
}

// Builds every unit of a Program's top-level Statements.
export function collectUnits(
	nodes: Array<common.typed.ImplementationNode>,
	namespaces: ReadonlySet<string>,
	cycleMates: ReadonlySet<string>,
): Units {
	let build: Builder = {
		bodies: new Map(),
		literals: new WeakMap(),
		count: 0,
		statement: 0,
		namespaces,
		cycleMates,
	}
	let top: Scope = { parent: null, names: new Map() }
	let topWalk = (unit: Unit, home: string | null): Walk => ({
		build,
		unit,
		scope: top,
		home,
		body: null,
	})
	let pending: Array<{
		walk: Pending
		home: string | null
		statement: number
	}> = []

	for (let [index, node] of nodes.entries()) {
		build.statement = index

		if (node.nodeType === "FunctionStatement") {
			let id = `fn ${node.name.content}`

			top.names.set(node.name.content, { kind: "value", bodies: [id] })
			pending.push({
				walk: {
					definition: node.value,
					body: bodyFor(
						build,
						id,
						`'${node.name.content}'`,
						node.value.completing === true,
					),
				},
				home: null,
				statement: index,
			})
		} else if (
			node.nodeType === "ConstantDeclarationStatement" ||
			node.nodeType === "VariableDeclarationStatement"
		) {
			top.names.set(node.name.content, {
				kind: "value",
				bodies: null,
				declared: index,
			})
		} else if (node.nodeType === "NamespaceDefinitionStatement") {
			for (let method of declareMethods(build, node, node.name.content)) {
				pending.push({
					walk: method,
					home: node.name.content,
					statement: index,
				})
			}
		}
	}

	// A body may call a Constant's Function value, which a call through it
	// follows, wherever the body is written.
	for (let [index, node] of nodes.entries()) {
		build.statement = index

		if (node.nodeType === "ConstantDeclarationStatement") {
			let ids = valueOf(node.value, topWalk(newUnit("", ""), null))

			nameLiteral(build, node, ids)
			top.names.set(node.name.content, {
				kind: "value",
				bodies: ids,
				declared: index,
			})
		}
	}

	for (let { walk, home, statement } of pending) {
		build.statement = statement
		walkDefinition(build, walk, top, home)
	}

	let roots = nodes.map((node, index) => {
		build.statement = index

		return rootUnits(node, index, (unit, home) => topWalk(unit, home))
	})
	let declared: Array<Array<Body>> = nodes.map(() => [])

	for (let body of build.bodies.values()) {
		declared[body.statement]?.push(body)
	}

	let suspensions: Array<number> = []
	let next = Number.POSITIVE_INFINITY

	for (let index = nodes.length - 1; index >= 0; index--) {
		if (suspendsMaybe(nodes[index])) {
			next = index
		}

		suspensions[index] = next
	}

	return { bodies: build.bodies, roots, declared, suspensions }
}

// What runs where a top-level Statement is written. A static Property is given
// its value in written order, so each is a unit of its own.
function rootUnits(
	node: common.typed.ImplementationNode,
	index: number,
	walkFor: (unit: Unit, home: string | null) => Walk,
): Array<Unit> {
	let rootUnit = (step: number): Unit => ({
		...newUnit(`statement ${index} ${step}`, ""),
		step,
	})

	switch (node.nodeType) {
		case "FunctionStatement":
		case "ProtocolDeclarationStatement":
		case "TypeAliasStatement":
		case "ChoiceDeclarationStatement":
			return []
		case "NamespaceDefinitionStatement":
			return Object.values(node.properties).flatMap((property, order) => {
				if (property.value.nodeType === "FunctionValue") {
					return []
				}

				let unit = rootUnit(order + 1)

				visitExpression(
					property.value,
					walkFor(unit, node.name.content),
					"value",
				)

				return [unit]
			})
		default: {
			let unit = rootUnit(1)

			visitStatement(node, walkFor(unit, null))

			return [unit]
		}
	}
}

function newUnit(id: string, name: string): Unit {
	return {
		id,
		step: 1,
		name,
		dependencies: [],
		runs: [],
		escapes: [],
		tails: [],
		unknownCall: null,
	}
}

// The body that runs a completing body's Parameter defaults.
export function defaultsOf(id: string): string {
	return `${id} defaults`
}

function bodyFor(
	build: Builder,
	id: string,
	name: string,
	completing: boolean,
): Body {
	let body = build.bodies.get(id)

	if (body === undefined) {
		body = {
			id,
			head: newUnit(id, name),
			tail: null,
			completing,
			statement: build.statement,
		}
		build.bodies.set(id, body)
	}

	return body
}

function resolve(scope: Scope | null, name: string): Binding | undefined {
	for (let current = scope; current !== null; current = current.parent) {
		let binding = current.names.get(name)

		if (binding !== undefined) {
			return binding
		}
	}

	return undefined
}

// The Namespace a written name means. A local one is named by its id and a
// top-level one by its name. One of another Module or the library is null.
function namespaceNamed(walk: Walk, name: string): string | null {
	let binding = resolve(walk.scope, name)

	if (binding?.kind === "namespace") {
		return binding.id
	}

	return walk.build.namespaces.has(name) ? name : null
}

// The Methods and Function Properties of a Namespace, as bodies under `N::m`
// and `N.m`, declared and still to be walked.
function declareMethods(
	build: Builder,
	node: common.typed.NamespaceDefinitionStatementNode,
	id: string,
): Array<Pending> {
	let shown = node.name.content
	let declared: Array<Pending> = []

	for (let [name, method] of Object.entries(node.methods)) {
		let separator =
			method.nodeType === "SimpleMethod" ||
			method.nodeType === "OverloadedMethod"
				? "::"
				: "."
		let values = "method" in method ? [method.method] : method.methods

		for (let value of values) {
			declared.push({
				definition: value.value,
				body: bodyFor(
					build,
					`${id}${separator}${name}`,
					`'${shown}${separator}${name}'`,
					values.length === 1 && value.value.completing === true,
				),
			})
		}
	}

	for (let [name, property] of Object.entries(node.properties)) {
		if (property.value.nodeType === "FunctionValue") {
			declared.push({
				definition: property.value.value,
				body: bodyFor(
					build,
					`${id}.${name}`,
					`'${shown}.${name}'`,
					property.value.value.completing === true,
				),
			})
		}
	}

	return declared
}

function walkDefinition(
	build: Builder,
	{ definition, body }: Pending,
	scope: Scope,
	home: string | null,
): void {
	let inner: Scope = { parent: scope, names: new Map() }
	let walk: Walk = { build, unit: body.head, scope: inner, home, body }
	let defaults: Walk = body.completing
		? {
				...walk,
				unit: bodyFor(build, defaultsOf(body.id), body.head.name, false)
					.head,
			}
		: walk

	for (let parameter of definition.parameters) {
		// A default runs when the call leaves it out, which for a completing
		// body is when its Future is built. A Record default is merged at the
		// body's entry instead.
		if (parameter.defaultValue !== null) {
			visitExpression(
				parameter.defaultValue,
				parameter.type.type === "Record" ? walk : defaults,
				"value",
			)
		}

		if (parameter.internalName !== null) {
			inner.names.set(parameter.internalName.content, {
				kind: "value",
				bodies: null,
			})
		}
	}

	visitStatements(definition.body, walk, body.completing)
}

// `splits` says the statements belong to a completing body, whose part after
// its first sure suspension runs later.
function visitStatements(
	statements: Array<common.typed.ImplementationNode>,
	walk: Walk,
	splits: boolean,
): void {
	for (let statement of statements) {
		visitStatement(statement, walk)

		if (
			splits &&
			walk.body !== null &&
			walk.body.tail === null &&
			suspendsSurely(statement)
		) {
			walk.body.tail = newUnit(
				`${walk.body.id} after suspending`,
				walk.body.head.name,
			)
			walk.unit = walk.body.tail
		}
	}
}

function visitStatement(
	node: common.typed.ImplementationNode,
	walk: Walk,
): void {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement": {
			let ids = valueOf(node.value, walk)

			let declared = resolve(walk.scope, node.name.content)

			nameLiteral(walk.build, node, ids)
			visitExpression(node.value, walk, ids === null ? "value" : "bound")

			// A top-level Constant keeps the Statement declaring it.
			walk.scope.names.set(node.name.content, {
				kind: "value",
				bodies: ids,
				...(walk.scope.parent === null && declared?.kind === "value"
					? { declared: declared.declared }
					: {}),
			})

			return
		}
		case "VariableDeclarationStatement": {
			let declared = resolve(walk.scope, node.name.content)

			visitExpression(node.value, walk, "value")

			// A top-level Variable keeps the Statement declaring it.
			walk.scope.names.set(node.name.content, {
				kind: "value",
				bodies: null,
				...(walk.scope.parent === null && declared?.kind === "value"
					? { declared: declared.declared }
					: {}),
			})

			return
		}
		case "FunctionStatement": {
			let id = `local ${walk.build.count++}`
			let body = bodyFor(
				walk.build,
				id,
				`'${node.name.content}'`,
				node.value.completing === true,
			)

			walk.scope.names.set(node.name.content, {
				kind: "value",
				bodies: [id],
			})
			walkDefinition(
				walk.build,
				{ definition: node.value, body },
				walk.scope,
				walk.home,
			)

			return
		}
		case "NamespaceDefinitionStatement":
			visitLocalNamespace(node, walk)

			return
		case "IfStatement":
			visitExpression(node.condition, walk, "value")
			visitStatements(node.body, nested(walk), false)

			return
		case "IfElseStatement":
			visitExpression(node.condition, walk, "value")
			visitStatements(node.trueBody, nested(walk), false)
			visitStatements(node.falseBody, nested(walk), false)

			return
		case "ReturnStatement":
			visitExpression(node.expression, walk, "value")

			return
		case "ProtocolDeclarationStatement":
		case "TypeAliasStatement":
		case "ChoiceDeclarationStatement":
			return
		default:
			visitExpression(
				node as TypedNode as common.typed.ExpressionNode,
				walk,
				"value",
			)
	}
}

function nested(walk: Walk): Walk {
	return { ...walk, scope: { parent: walk.scope, names: new Map() } }
}

// A Namespace declared inside a body: its static Properties run where it is
// written, and its Methods when called.
function visitLocalNamespace(
	node: common.typed.NamespaceDefinitionStatementNode,
	walk: Walk,
): void {
	let id = `namespace ${walk.build.count++} ${node.name.content}`
	let declared = declareMethods(walk.build, node, id)

	walk.scope.names.set(node.name.content, { kind: "namespace", id })

	for (let method of declared) {
		walkDefinition(walk.build, method, walk.scope, walk.home)
	}

	for (let property of Object.values(node.properties)) {
		if (property.value.nodeType !== "FunctionValue") {
			visitExpression(property.value, walk, "value")
		}
	}
}

// The bodies a Function value may be, or null where nothing names them.
function valueOf(
	node: common.typed.ExpressionNode,
	walk: Walk,
): Array<string> | null {
	switch (node.nodeType) {
		case "FunctionValue":
			return [literalBody(node, walk)]
		case "Identifier": {
			let binding = resolve(walk.scope, node.content)

			return binding?.kind === "value" ? binding.bodies : null
		}
		case "Lookup": {
			let namespace = staticHome(node, walk)
			let id =
				namespace === null
					? null
					: `${namespace}.${node.member.content}`

			return id !== null && walk.build.bodies.has(id) ? [id] : null
		}
		case "FunctionInvocation":
			// A completing body's call answers a Future of it.
			return futures(walk, valueOf(node.name, walk))
		case "MethodInvocation": {
			let id =
				node.dispatch === null &&
				node.namespace.type.providedBy === undefined
					? namespaceNamed(walk, node.namespace.name)
					: null

			return id === null
				? null
				: futures(walk, [`${id}::${node.member.name}`])
		}
		default:
			return null
	}
}

function futures(walk: Walk, ids: Array<string> | null): Array<string> | null {
	return ids !== null &&
		ids.every((id) => walk.build.bodies.get(id)?.completing === true)
		? ids
		: null
}

// The Namespace a Lookup reads a static member off, by the id its bodies are
// kept under.
function staticHome(node: common.typed.LookupNode, walk: Walk): string | null {
	if (
		node.base.nodeType === "Identifier" &&
		node.base.type.type === "Namespace"
	) {
		return namespaceNamed(walk, node.base.content)
	}

	return node.namespaceName !== undefined && node.providedBy === undefined
		? namespaceNamed(walk, node.namespaceName)
		: null
}

// Whether a callee names a Function or a static Method this Module does not
// declare.
function namesOtherCode(
	callee: common.typed.ExpressionNode,
	walk: Walk,
): boolean {
	if (callee.nodeType === "Identifier") {
		return resolve(walk.scope, callee.content) === undefined
	}

	return (
		callee.nodeType === "Lookup" &&
		((callee.base.nodeType === "Identifier" &&
			callee.base.type.type === "Namespace") ||
			callee.namespaceName !== undefined) &&
		staticHome(callee, walk) === null
	)
}

// A top-level Constant or Variable, which holds nothing until its Statement
// runs.
function readConstant(
	walk: Walk,
	node: common.typed.IdentifierNode,
	label: string,
): void {
	let binding = resolve(walk.scope, node.content)

	if (binding?.kind === "value" && binding.declared !== undefined) {
		walk.unit.dependencies.push({
			kind: "constant",
			name: node.content,
			position: node.position,
			label,
			home: walk.home,
		})
	} else if (binding === undefined) {
		useCycleMate(walk, node.content, node.position, label)
	}
}

// A name another Module of the import cycle binds, whose Module body may not
// have run yet.
function useCycleMate(
	walk: Walk,
	name: string,
	position: common.Position,
	label: string,
): void {
	if (walk.build.cycleMates.has(name)) {
		walk.unit.dependencies.push({
			kind: "cycle",
			name,
			position,
			label,
			home: walk.home,
		})
	}
}

function depend(
	walk: Walk,
	namespace: string,
	position: common.Position,
	label: string,
): void {
	if (resolve(walk.scope, namespace)?.kind === "namespace") {
		return
	}

	if (walk.build.namespaces.has(namespace)) {
		walk.unit.dependencies.push({
			kind: "namespace",
			name: namespace,
			position,
			label,
			home: walk.home,
		})
	} else {
		useCycleMate(walk, namespace, position, label)
	}
}

function run(
	walk: Walk,
	ids: Array<string>,
	position: common.Position,
	label: string,
): void {
	for (let id of ids) {
		let body = walk.build.bodies.get(id)

		// A completing body's call builds its Future, which runs the
		// Parameters' defaults and nothing else.
		if (body !== undefined) {
			walk.unit.runs.push({
				target: body.completing ? defaultsOf(id) : id,
				position,
				label,
			})
		}
	}
}

function start(
	walk: Walk,
	ids: Array<string>,
	position: common.Position,
): void {
	for (let id of ids) {
		if (walk.build.bodies.has(id)) {
			walk.unit.runs.push({
				target: id,
				position,
				label: "this starts work that reaches it",
			})
			walk.unit.tails.push({ id, position })
		}
	}
}

// A Note names a Function literal by the Constant holding it.
function nameLiteral(
	build: Builder,
	node: common.typed.ConstantDeclarationStatementNode,
	ids: Array<string> | null,
): void {
	let body = ids?.length === 1 ? build.bodies.get(ids[0]) : undefined

	if (node.value.nodeType === "FunctionValue" && body !== undefined) {
		body.head.name = `'${node.name.content}'`
	}
}

function escape(walk: Walk, node: common.typed.ExpressionNode): void {
	let ids = valueOf(node, walk)

	if (ids !== null) {
		walk.unit.escapes.push(...ids)
	}
}

function unknown(walk: Walk, position: common.Position): void {
	walk.unit.unknownCall ??= position
}

// Registers a Function literal's body once and walks it, with the Scope it is
// written in.
function literalBody(node: common.typed.FunctionValueNode, walk: Walk): string {
	let known = walk.build.literals.get(node)

	if (known !== undefined) {
		return known
	}

	let id = `literal ${walk.build.count++}`

	walk.build.literals.set(node, id)
	walkDefinition(
		walk.build,
		{
			definition: node.value,
			body: bodyFor(
				walk.build,
				id,
				`the Function on line ${node.position.start.line}`,
				node.value.completing === true,
			),
		},
		walk.scope,
		walk.home,
	)

	return id
}

function visitExpression(
	node: common.typed.ExpressionNode,
	walk: Walk,
	use: Use,
): void {
	visitWitnesses(node, walk)

	switch (node.nodeType) {
		case "FunctionValue":
			literalBody(node, walk)

			if (use === "value") {
				escape(walk, node)
			}

			return
		case "Identifier":
			if (node.type.type === "Namespace") {
				depend(walk, node.content, node.position, "this names it")

				return
			}

			readConstant(
				walk,
				node,
				use === "call" ? "this calls it" : "this reads it",
			)

			if (use === "value") {
				escape(walk, node)
			}

			return
		case "FunctionInvocation":
			visitInvocation(node, walk)

			if (use === "value") {
				escape(walk, node)
			}

			return
		case "MethodInvocation":
			visitMethodInvocation(node, walk)

			if (use === "value") {
				escape(walk, node)
			}

			return
		case "Lookup":
			visitLookup(node, walk, use)

			return
		case "Start":
		case "Complete":
			visitStart(node, walk)

			return
		case "Match":
			visitMatch(node, walk)

			return
		default:
			forEachTypedChild(node, (child) =>
				visitExpression(
					child as TypedNode as common.typed.ExpressionNode,
					walk,
					"value",
				),
			)
	}
}

// Starting or completing a Future runs its work. Completing work already
// started starts nothing.
function visitStart(
	node: common.typed.StartNode | common.typed.CompleteNode,
	walk: Walk,
): void {
	let ids = valueOf(node.expression, walk)

	visitExpression(node.expression, walk, "bound")

	if (ids !== null) {
		start(walk, ids, node.position)
	} else if (node.expression.type.type !== "Started") {
		unknown(walk, node.position)
	}
}

function visitMatch(node: common.typed.MatchNode, walk: Walk): void {
	visitExpression(node.value, walk, "value")

	for (let handler of node.handlers) {
		let inner = nested(walk)

		for (let literal of [
			handler.literal,
			...Object.values(handler.memberLiterals ?? {}),
		]) {
			if (literal !== null) {
				visitExpression(literal, inner, "value")
			}
		}

		if (handler.guard !== null) {
			visitExpression(handler.guard, inner, "value")
		}

		visitStatements(handler.body, inner, false)
	}
}

function visitInvocation(
	node: common.typed.FunctionInvocationNode,
	walk: Walk,
): void {
	let callees = valueOf(node.name, walk)

	visitExpression(node.name, walk, "call")

	for (let argument of node.arguments) {
		visitExpression(argument.value, walk, "value")
	}

	if (callees !== null) {
		run(walk, callees, node.name.position, "this call reaches it")

		return
	}

	// Code of another Module or of the library runs a Function value only
	// where it is handed one.
	if (
		namesOtherCode(node.name, walk)
			? handsOnWork(node.arguments.map((argument) => argument.value))
			: isCallable(node.name.type)
	) {
		unknown(walk, node.name.position)
	}
}

function visitMethodInvocation(
	node: common.typed.MethodInvocationNode,
	walk: Walk,
): void {
	visitExpression(node.base, walk, "value")

	for (let argument of node.arguments) {
		visitExpression(argument.value, walk, "value")
	}

	// Each branch's typed copy of a Function literal Argument, which the
	// visitor does not reach.
	for (let branch of node.dispatch ?? []) {
		for (let { argument } of branch.contextualArguments) {
			visitExpression(argument.value, walk, "value")
		}
	}

	let homes =
		node.dispatch === null
			? node.namespace.type.providedBy === undefined
				? [node.namespace.name]
				: []
			: node.dispatch
					.filter((branch) => branch.providedBy === undefined)
					.map((branch) => branch.namespaceName)
	let local = homes.map((home) => namespaceNamed(walk, home))

	for (let home of homes) {
		depend(walk, home, node.member.position, "this Method comes from it")
	}

	for (let id of local) {
		if (id !== null) {
			run(
				walk,
				[`${id}::${node.member.name}`],
				node.member.position,
				"this call reaches it",
			)
		}
	}

	if (
		(local.length === 0 || local.includes(null)) &&
		handsOnWork([
			node.base,
			...node.arguments.map((argument) => argument.value),
		])
	) {
		unknown(walk, node.member.position)
	}
}

function visitLookup(
	node: common.typed.LookupNode,
	walk: Walk,
	use: Use,
): void {
	let namespace = staticHome(node, walk)

	if (
		node.base.nodeType === "Identifier" &&
		node.base.type.type === "Namespace"
	) {
		depend(walk, node.base.content, node.base.position, "this names it")

		// A static Property holds nothing until its initialiser runs.
		if (
			namespace === node.base.content &&
			Object.hasOwn(node.base.type.properties, node.member.content)
		) {
			walk.unit.dependencies.push({
				kind: "property",
				name: `${namespace}.${node.member.content}`,
				position: node.member.position,
				label: "this reads it",
				home: walk.home,
			})
		}
	} else {
		visitExpression(node.base, walk, "bound")

		if (namespace !== null && node.namespaceName !== undefined) {
			depend(
				walk,
				node.namespaceName,
				node.member.position,
				"this member is read off it",
			)
		}
	}

	let id = namespace === null ? null : `${namespace}.${node.member.content}`

	if (use === "value" && id !== null && walk.build.bodies.has(id)) {
		walk.unit.escapes.push(id)
	}
}

// A witness runs the Methods in its map wherever the call it is handed to
// likes, and names its Namespace once for each.
function visitWitnesses(node: TypedNode, walk: Walk): void {
	let at =
		node.nodeType === "MethodInvocation"
			? node.member.position
			: node.nodeType === "FunctionInvocation"
				? node.name.position
				: (node as { position?: common.Position }).position

	forEachHeldRecord(node, (record, field, holder) => {
		if (field === "contextualArguments") {
			return false
		}

		let source = record.source as common.ConformanceSource | undefined

		if (
			typeof record.protocolName !== "string" ||
			source?.kind !== "namespace" ||
			at === undefined
		) {
			return true
		}

		let protocol = displayProtocolName(record.protocolName)
		let hole =
			field === "conformance"
				? (holder.expression as { position?: common.Position } | null)
				: null
		let position = hole?.position ?? at
		let whose = hole === null ? "this call's" : "this value's"

		for (let witness of [source, ...(source.providedWitnesses ?? [])]) {
			let members = Object.values(witness.methodMap)
			let id = namespaceNamed(walk, witness.name)

			if (members.length === 0) {
				continue
			}

			depend(
				walk,
				witness.name,
				position,
				`${whose} ${protocol} conformance comes from it`,
			)

			for (let member of id === null ? [] : members) {
				run(
					walk,
					[`${id}::${member}`, `${id}.${member}`],
					position,
					`${whose} ${protocol} conformance reaches it`,
				)
			}
		}

		return true
	})
}

// Whether a type can hold a Function or a Future, which code given the value
// may run.
function holdsWork(type: common.Type, seen = new Set<object>()): boolean {
	if (seen.has(type)) {
		return false
	}

	seen.add(type)

	switch (type.type) {
		case "Function":
		case "Future":
			return true
		case "List":
			return holdsWork(type.itemType, seen)
		case "Dictionary":
			return (
				holdsWork(type.keyType, seen) || holdsWork(type.valueType, seen)
			)
		case "Record":
		case "Case":
			return Object.values(type.members).some((member) =>
				holdsWork(member, seen),
			)
		case "UnionType":
			return type.types.some(
				(member) =>
					member.type !== "GenericUse" && holdsWork(member, seen),
			)
		case "Refinement":
			return holdsWork(type.base, seen)
		case "GenericAlias":
			return holdsWork(type.aliasedType, seen)
		default:
			return false
	}
}

function handsOnWork(values: Array<common.typed.ExpressionNode>): boolean {
	return values.some((value) => holdsWork(value.type))
}

function isCallable(type: common.Type): boolean {
	return (
		type.type === "Function" ||
		type.type === "StaticMethod" ||
		type.type === "OverloadedStaticMethod"
	)
}

// Whether a Statement surely suspends: it reaches a `complete` that no branch,
// Handler or Function stands around.
function suspendsSurely(node: common.typed.ImplementationNode): boolean {
	let found = false

	let search = (child: TypedNode): void => {
		if (found) {
			return
		}

		switch (child.nodeType) {
			case "Complete":
				found = true

				return
			case "FunctionValue":
			case "FunctionStatement":
			case "NamespaceDefinitionStatement":
			case "Match":
			case "Define":
				return
			case "IfStatement":
			case "IfElseStatement":
				search(child.condition)

				return
			default:
				forEachTypedChild(child, search)
		}
	}

	search(node)

	return found
}

// Whether a top-level Statement may suspend, letting started work go on.
function suspendsMaybe(node: common.typed.ImplementationNode): boolean {
	let found = false

	let search = (child: TypedNode): void => {
		if (found) {
			return
		}

		if (child.nodeType === "Complete") {
			found = true
		} else if (
			child.nodeType !== "FunctionValue" &&
			child.nodeType !== "FunctionStatement" &&
			child.nodeType !== "NamespaceDefinitionStatement"
		) {
			forEachTypedChild(child, search)
		}
	}

	search(node)

	return found
}
