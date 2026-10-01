import {
	caseDefaults,
	memberExpression,
	parameterDefaults,
} from "@essence-lang/compiler/helpers"
import type { common, parser } from "@essence-lang/interfaces"

import {
	assertionExpressions,
	typedAssertionExpressions,
} from "./assertionChildren"
import { defineExpressions } from "./defineArmChildren"
import { typedHandlerExpressions } from "./matchHandlerChildren"
import { isAtOrBefore } from "./positions"
import {
	buildRenameIndex,
	type Declaration,
	occurrenceAt,
	type RenameIndex,
} from "./rename"
import { programBodies, typedProgramSections } from "./sections"

// The Call Hierarchy of one document, stateless: an Item round-trips its
// `selectionRange`, and each request resolves it again. Callers and callees are
// rename index Declarations; a callee it lacks, such as a builtin, is skipped.

export type CallHierarchyItemKind =
	| "function"
	| "method"
	| "staticMethod"
	| "property"
	| "implementation"

export type CallHierarchyItem = {
	name: string
	kind: CallHierarchyItemKind
	// The Namespace a Method or Property belongs to; null for a free Function and
	// the implementation block.
	container: string | null
	// `range` spans the whole construct, `selectionRange` the name. The Item is
	// resolved again from `selectionRange`, so it must be the definition.
	range: common.Position
	selectionRange: common.Position
}

type CallSite = {
	caller: CallHierarchyItem
	callee: CallHierarchyItem
	// Where the callee's name is written at the call site.
	range: common.Position
}

export type CallHierarchyCalls = {
	item: CallHierarchyItem
	ranges: Array<common.Position>
}

// The kinds a call can target. A Constant holding a Function is not one: which
// Function it holds is a data-flow question a lexical index cannot answer.
const callableKinds = new Set<Declaration["kind"]>([
	"function",
	"method",
	"staticMethod",
])

type Context = {
	enrichedProgram: common.typed.Program | null
	index: RenameIndex
	// Occurrence Position to Declaration, to resolve a call site's callee.
	declarationAt: Map<string, Declaration>
	// Definition Position to Item, built from the Parser AST so every Item exists
	// even when enrichment failed.
	items: Map<string, CallHierarchyItem>
	topLevel: CallHierarchyItem
	// The one caller for everything in the `tests` block, or null without one.
	// Tests cannot be called, so the section stands as a single caller.
	testsLevel: CallHierarchyItem | null
}

export function prepareCallHierarchy(
	program: parser.Program,
	cursor: common.Cursor,
	enrichedProgram: common.typed.Program | null = null,
): CallHierarchyItem | null {
	return itemAt(buildContext(program, enrichedProgram), cursor)
}

export function findIncomingCalls(
	program: parser.Program,
	cursor: common.Cursor,
	enrichedProgram: common.typed.Program | null = null,
): Array<CallHierarchyCalls> {
	let context = buildContext(program, enrichedProgram)
	let item = itemAt(context, cursor)

	if (item === null) {
		return []
	}

	let key = itemKey(item)

	return group(
		collectSites(context).filter((site) => itemKey(site.callee) === key),
		(site) => site.caller,
	)
}

export function findOutgoingCalls(
	program: parser.Program,
	cursor: common.Cursor,
	enrichedProgram: common.typed.Program | null = null,
): Array<CallHierarchyCalls> {
	let context = buildContext(program, enrichedProgram)
	let item = itemAt(context, cursor)

	if (item === null) {
		return []
	}

	let key = itemKey(item)

	return group(
		collectSites(context).filter((site) => itemKey(site.caller) === key),
		(site) => site.callee,
	)
}

export function collectCallSites(
	program: parser.Program,
	enrichedProgram: common.typed.Program | null = null,
): Array<CallSite> {
	return collectSites(buildContext(program, enrichedProgram))
}

function buildContext(
	program: parser.Program,
	enrichedProgram: common.typed.Program | null,
): Context {
	let index = buildRenameIndex(program, enrichedProgram)
	let declarationAt = new Map<string, Declaration>()

	for (let occurrence of index) {
		let key = positionKey(occurrence.position)

		if (!declarationAt.has(key)) {
			declarationAt.set(key, occurrence.declaration)
		}
	}

	let items = new Map<string, CallHierarchyItem>()

	for (let body of programBodies(program)) {
		collectItems(body, null, items)
	}

	return {
		enrichedProgram,
		index,
		declarationAt,
		items,
		topLevel: topLevelItem(program),
		testsLevel: testsItem(program),
	}
}

function itemAt(
	context: Context,
	cursor: common.Cursor,
): CallHierarchyItem | null {
	let occurrence = occurrenceAt(context.index, cursor)

	if (occurrence === null) {
		return null
	}

	let { declaration } = occurrence

	// A builtin has no definition, so it is refused.
	if (
		!callableKinds.has(declaration.kind) ||
		declaration.definition === null
	) {
		return null
	}

	return context.items.get(positionKey(declaration.definition)) ?? null
}

// The made-up caller of every top level Statement. Nothing calls it, so its
// own callers are an empty list.
function topLevelItem(program: parser.Program): CallHierarchyItem {
	let position = program.implementation.position

	return {
		name: program.kind,
		kind: "implementation",
		container: null,
		range: position,
		selectionRange: {
			start: position.start,
			end: {
				line: position.start.line,
				column: position.start.column + program.kind.length,
			},
		},
	}
}

// The same for the `tests` block and every test and suite in it.
function testsItem(program: parser.Program): CallHierarchyItem | null {
	if (program.tests === null) {
		return null
	}

	let position = program.tests.position

	return {
		name: "tests",
		kind: "implementation",
		container: null,
		range: position,
		selectionRange: {
			start: position.start,
			end: {
				line: position.start.line,
				column: position.start.column + "tests".length,
			},
		},
	}
}

function itemKey(item: CallHierarchyItem): string {
	return positionKey(item.selectionRange)
}

function positionKey(position: common.Position): string {
	return `${position.start.line}:${position.start.column}-${position.end.line}:${position.end.column}`
}

function group(
	sites: Array<CallSite>,
	pick: (site: CallSite) => CallHierarchyItem,
): Array<CallHierarchyCalls> {
	let groups = new Map<string, CallHierarchyCalls>()

	for (let site of sites) {
		let item = pick(site)
		let key = itemKey(item)
		let entry = groups.get(key)

		if (entry === undefined) {
			entry = { item, ranges: [] }
			groups.set(key, entry)
		}

		entry.ranges.push(site.range)
	}

	return [...groups.values()]
}

/*********/
/* Items */
/*********/

// Item geometry comes off the Parser AST, which survives Type errors, so an
// Item is the same for a prepare and an expansion.
function collectItems(
	nodes: Array<parser.ImplementationNode>,
	container: string | null,
	items: Map<string, CallHierarchyItem>,
) {
	for (let node of nodes) {
		collectItemsFromNode(node, container, items)
	}
}

function addItem(
	item: CallHierarchyItem,
	items: Map<string, CallHierarchyItem>,
) {
	let key = itemKey(item)

	// A re-declaration shares the first Declaration, so the first Item at a
	// Position is the one call sites resolve to.
	if (!items.has(key)) {
		items.set(key, item)
	}
}

function collectItemsFromNode(
	node: parser.ImplementationNode,
	container: string | null,
	items: Map<string, CallHierarchyItem>,
) {
	switch (node.nodeType) {
		case "FunctionStatement":
			addItem(
				{
					name: node.name.content,
					kind: "function",
					container,
					range: node.position,
					selectionRange: node.name.position,
				},
				items,
			)

			// A Function declared in a body is a free Function, so the container does not
			// travel into bodies.
			collectItems(node.value.body, null, items)
			return
		case "OverloadedFunctionStatement":
			addItem(
				{
					name: node.name.content,
					kind: "function",
					container,
					range: node.position,
					selectionRange: node.name.position,
				},
				items,
			)

			for (let method of node.methods) {
				if (method.nodeType === "FunctionValue") {
					collectItems(method.value.body, null, items)
				}
			}

			return
		case "NamespaceDefinitionStatement":
			collectNamespaceItems(node, items)
			return
		case "ProtocolDeclarationStatement":
			collectProtocolItems(node, items)
			return
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
			collectItemsFromNode(node.value, container, items)
			return
		case "IfStatement":
			collectItemsFromNode(node.condition, container, items)
			collectItems(node.body, container, items)
			return
		case "IfElseStatement":
			collectItemsFromNode(node.condition, container, items)
			collectItems(node.trueBody, container, items)
			collectItems(node.falseBody, container, items)
			return
		case "ReturnStatement":
			collectItemsFromNode(node.expression, container, items)
			return
		case "ExpectStatement":
		case "RequireStatement":
			for (let expression of assertionExpressions(node)) {
				collectItemsFromNode(expression, container, items)
			}

			return
		case "FunctionValue":
			collectItems(node.value.body, container, items)
			return
		case "FunctionInvocation":
			collectItemsFromNode(node.name, container, items)
			collectItemsFromArguments(node.arguments, container, items)
			return
		case "MethodInvocation":
			collectItemsFromNode(node.base, container, items)
			collectItemsFromArguments(node.arguments, container, items)
			return
		case "Lookup":
			collectItemsFromNode(node.base, container, items)
			return
		case "Start":
		case "Complete":
			collectItemsFromNode(node.expression, container, items)
			return
		case "RefusedValue":
			collectItemsFromNode(node.base, container, items)
			return
		case "Combination":
			collectItemsFromNode(node.lhs, container, items)
			collectItemsFromNode(node.rhs, container, items)
			return
		case "Match":
			collectItemsFromNode(node.value, container, items)

			for (let handler of node.handlers) {
				if (handler.guard !== null) {
					collectItemsFromNode(handler.guard, container, items)
				}

				collectItems(handler.body, container, items)
			}

			return
		case "Define":
			for (let expression of defineExpressions(node)) {
				collectItemsFromNode(expression, container, items)
			}

			return
		case "RecordValue":
			for (let member of Object.values(node.members)) {
				collectItemsFromNode(memberExpression(member), container, items)
			}

			return
		case "ListValue":
			for (let value of node.values) {
				collectItemsFromNode(value, container, items)
			}

			return
		case "DictionaryValue":
			for (let entry of node.entries) {
				collectItemsFromNode(entry.key, container, items)
				collectItemsFromNode(entry.value, container, items)
			}

			return
		case "InterpolatedStringValue":
			for (let segment of node.segments) {
				if (segment.kind === "expression") {
					collectItemsFromNode(segment.expression, container, items)
				}
			}

			return
		case "CaseValue":
			if (node.value !== null) {
				collectItemsFromNode(node.value, container, items)
			}

			return
		case "ChoiceDeclarationStatement":
			// A Case payload's default may call something, which is an incoming edge.
			for (let defaultValue of caseDefaults(node.cases)) {
				collectItemsFromNode(defaultValue, container, items)
			}

			return
		// A path only reads members (`path-is-members-only`), so it calls nothing.
		case "MemberPath":
		case "TypeAliasStatement":
		case "Identifier":
		case "Self":
		case "StringValue":
		case "IntegerValue":
		case "RationalValue":
		case "BooleanValue":
			return
	}
}

function collectItemsFromArguments(
	nodeArguments: Array<parser.ArgumentNode>,
	container: string | null,
	items: Map<string, CallHierarchyItem>,
) {
	for (let argument of nodeArguments) {
		collectItemsFromNode(argument.value, container, items)
	}
}

function collectNamespaceItems(
	node: parser.NamespaceDefinitionStatementNode,
	items: Map<string, CallHierarchyItem>,
) {
	let container = node.name.content

	for (let property of Object.values(node.properties)) {
		addItem(
			{
				name: property.name.content,
				kind: "property",
				container,
				// A native static Property has no value, so its range is its name.
				range: spanning(
					property.name.position,
					property.value?.position ?? property.name.position,
				),
				selectionRange: property.name.position,
			},
			items,
		)

		if (property.value !== null) {
			collectItemsFromNode(property.value, null, items)
		}
	}

	for (let member of Object.values(node.methods)) {
		let methods =
			member.nodeType === "OverloadedMethod" ||
			member.nodeType === "OverloadedStaticMethod" ||
			member.nodeType === "OverloadedMethodSignatures" ||
			member.nodeType === "OverloadedStaticMethodSignatures"
				? member.methods
				: member.nodeType === "SimpleMethodSignature" ||
					  member.nodeType === "StaticMethodSignature"
					? [member.signature]
					: [member.method]

		let isStatic =
			member.nodeType === "StaticMethod" ||
			member.nodeType === "OverloadedStaticMethod" ||
			member.nodeType === "StaticMethodSignature" ||
			member.nodeType === "OverloadedStaticMethodSignatures"

		// The range runs from the name to the end of the last Overload. One Item
		// covers the set, which the rename index gives one Declaration.
		let range = member.name.position

		for (let method of methods) {
			range = spanning(range, method.position)
		}

		addItem(
			{
				name: member.name.content,
				kind: isStatic ? "staticMethod" : "method",
				container,
				range,
				selectionRange: member.name.position,
			},
			items,
		)

		for (let method of methods) {
			if (method.nodeType === "FunctionValue") {
				collectItems(method.value.body, null, items)
			}
		}
	}
}

// Only a provided Method is an Item: no call binds to a requirement.
function collectProtocolItems(
	node: parser.ProtocolDeclarationStatementNode,
	items: Map<string, CallHierarchyItem>,
) {
	let container = node.name.content

	for (let member of Object.values(node.methods)) {
		let signatures =
			member.nodeType === "OverloadedProtocolMethod" ||
			member.nodeType === "OverloadedStaticProtocolMethod"
				? member.signatures
				: [member.signature]

		if (signatures.every((signature) => signature.body === null)) {
			continue
		}

		let isStatic =
			member.nodeType === "StaticProtocolMethod" ||
			member.nodeType === "OverloadedStaticProtocolMethod"

		let range = member.name.position

		for (let signature of signatures) {
			range = spanning(
				range,
				signature.body?.position ?? signature.position,
			)
		}

		addItem(
			{
				name: member.name.content,
				kind: isStatic ? "staticMethod" : "method",
				container,
				range,
				selectionRange: member.name.position,
			},
			items,
		)

		for (let { body } of signatures) {
			if (body !== null) {
				collectItems(body.value.body, null, items)
			}
		}
	}
}

function spanning(a: common.Position, b: common.Position): common.Position {
	return {
		start: isAtOrBefore(a.start, b.start) ? a.start : b.start,
		end: isAtOrBefore(a.end, b.end) ? b.end : a.end,
	}
}

/**************/
/* Call sites */
/**************/

// One walk of the typed AST, threading the enclosing named caller down. A
// Function value pushes nothing, so its calls go to the nearest named caller;
// top level Statements go to the implementation caller.
function collectSites(context: Context): Array<CallSite> {
	let sites: Array<CallSite> = []

	if (context.enrichedProgram === null) {
		return sites
	}

	for (let section of typedProgramSections(context.enrichedProgram)) {
		let caller =
			section.kind === "implementation"
				? context.topLevel
				: (context.testsLevel ?? context.topLevel)

		visitBody([...section.head, ...section.nodes], caller, context, sites)
	}

	return sites
}

function visitBody(
	nodes: Array<common.typed.ImplementationNode>,
	caller: CallHierarchyItem,
	context: Context,
	sites: Array<CallSite>,
) {
	for (let node of nodes) {
		visitNode(node, caller, context, sites)
	}
}

function callerFor(
	position: common.Position,
	fallback: CallHierarchyItem,
	context: Context,
): CallHierarchyItem {
	return context.items.get(positionKey(position)) ?? fallback
}

// A native Method's calls live in the frame the Compiler synthesizes for its
// defaults: `to end: Integer = @::length()` calls `length`.
function visitNativeShims(
	node: common.typed.NamespaceDefinitionStatementNode,
	caller: CallHierarchyItem,
	context: Context,
	sites: Array<CallSite>,
) {
	for (let shim of node.nativeShims) {
		visitDefaults(
			shim.parameters,
			memberItem(node.name.content, shim.memberName, context) ?? caller,
			context,
			sites,
		)
	}
}

// A shim keeps no Position, so its native Method's Item is found by name.
function memberItem(
	container: string,
	name: string,
	context: Context,
): CallHierarchyItem | null {
	for (let item of context.items.values()) {
		if (item.container === container && item.name === name) {
			return item
		}
	}

	return null
}

// `position` is where the callee's name is written. A name the index does not
// bind is one this document does not declare.
function recordCall(
	position: common.Position,
	caller: CallHierarchyItem,
	context: Context,
	sites: Array<CallSite>,
) {
	let declaration = context.declarationAt.get(positionKey(position))

	if (
		declaration === undefined ||
		declaration.definition === null ||
		!callableKinds.has(declaration.kind)
	) {
		return
	}

	let callee = context.items.get(positionKey(declaration.definition))

	if (callee === undefined) {
		return
	}

	sites.push({ caller, callee, range: position })
}

// `= @::length()` is an outgoing call of the Function the default is on.
function visitDefaults(
	parameters: Array<common.typed.ParameterNode>,
	caller: CallHierarchyItem,
	context: Context,
	sites: Array<CallSite>,
) {
	for (let defaultValue of parameterDefaults(parameters)) {
		visitNode(defaultValue, caller, context, sites)
	}
}

function visitNode(
	node: common.typed.ImplementationNode,
	caller: CallHierarchyItem,
	context: Context,
	sites: Array<CallSite>,
) {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
			visitNode(node.value, caller, context, sites)
			return
		case "FunctionStatement": {
			let functionCaller = callerFor(node.name.position, caller, context)

			visitDefaults(node.value.parameters, functionCaller, context, sites)
			visitBody(node.value.body, functionCaller, context, sites)

			return
		}
		case "NamespaceDefinitionStatement":
			for (let property of Object.values(node.properties)) {
				visitNode(
					property.value,
					callerFor(property.name.position, caller, context),
					context,
					sites,
				)
			}

			for (let member of Object.values(node.methods)) {
				let methods =
					member.nodeType === "OverloadedMethod" ||
					member.nodeType === "OverloadedStaticMethod"
						? member.methods
						: [member.method]

				// Every Overload body attributes to the one Item the set shares, as renaming
				// does. `overloadedMethodIndex` would allow splitting them.
				for (let method of methods) {
					let methodCaller = callerFor(
						member.name.position,
						caller,
						context,
					)

					visitDefaults(
						method.value.parameters,
						methodCaller,
						context,
						sites,
					)
					visitBody(method.value.body, methodCaller, context, sites)
				}
			}

			visitNativeShims(node, caller, context, sites)

			return
		case "ProtocolDeclarationStatement":
			for (let member of Object.values(node.methods)) {
				let methods =
					member.nodeType === "OverloadedMethod" ||
					member.nodeType === "OverloadedStaticMethod"
						? member.methods
						: [member.method]
				let methodCaller = callerFor(
					member.name.position,
					caller,
					context,
				)

				for (let method of methods) {
					visitDefaults(
						method.value.parameters,
						methodCaller,
						context,
						sites,
					)
					visitBody(method.value.body, methodCaller, context, sites)
				}
			}

			return
		case "IfStatement":
			visitNode(node.condition, caller, context, sites)
			visitBody(node.body, caller, context, sites)
			return
		case "IfElseStatement":
			visitNode(node.condition, caller, context, sites)
			visitBody(node.trueBody, caller, context, sites)
			visitBody(node.falseBody, caller, context, sites)
			return
		case "ReturnStatement":
			visitNode(node.expression, caller, context, sites)
			return
		// A call in an assertion counts, so tests reach the Functions they exercise.
		case "ExpectStatement":
		case "RequireStatement":
			for (let expression of typedAssertionExpressions(node)) {
				visitNode(expression, caller, context, sites)
			}

			return
		case "FunctionInvocation":
			if (node.name.nodeType === "Identifier") {
				recordCall(node.name.position, caller, context, sites)
			} else if (
				node.name.nodeType === "Lookup" &&
				node.name.base.type.type === "Namespace"
			) {
				// `Namespace.staticMethod(…)`, a Lookup the rename index binds
				// to the static Method.
				recordCall(node.name.member.position, caller, context, sites)
			}

			visitNode(node.name, caller, context, sites)
			visitArguments(node.arguments, caller, context, sites)
			return
		case "MethodInvocation":
			// The receiver first, so a chain reports its calls in written order.
			visitNode(node.base, caller, context, sites)

			// A call on a Union receiver dispatches per member Type, and its `namespace`
			// is a placeholder, so it is skipped. So is a receiver not yet resolved,
			// whose `namespace.name` is empty.
			if (node.dispatch === null) {
				recordCall(node.member.position, caller, context, sites)
			}

			visitArguments(node.arguments, caller, context, sites)
			return
		case "Lookup":
			visitNode(node.base, caller, context, sites)
			return
		// Calls under `start` and `complete` count too.
		case "Start":
		case "Complete":
			visitNode(node.expression, caller, context, sites)
			return
		case "RefusedValue":
			visitNode(node.base, caller, context, sites)
			return
		case "Combination":
			visitNode(node.lhs, caller, context, sites)
			visitNode(node.rhs, caller, context, sites)
			return
		case "Match":
			visitNode(node.value, caller, context, sites)

			for (let handler of node.handlers) {
				// A Handler's literal and Guard hold calls outside its body.
				for (let expression of typedHandlerExpressions(handler)) {
					visitNode(expression, caller, context, sites)
				}

				visitBody(handler.body, caller, context, sites)
			}

			return
		// A `define` is Expressions only, Conditions included.
		case "Define":
			for (let expression of defineExpressions(node)) {
				visitNode(expression, caller, context, sites)
			}

			return
		case "RecordValue":
			for (let member of Object.values(node.members)) {
				visitNode(member, caller, context, sites)
			}

			return
		case "ListValue":
			for (let value of node.values) {
				visitNode(value, caller, context, sites)
			}

			return
		case "DictionaryValue":
			for (let entry of node.entries) {
				visitNode(entry.key, caller, context, sites)
				visitNode(entry.value, caller, context, sites)
			}

			return
		case "InterpolatedStringValue":
			for (let segment of node.segments) {
				if (segment.kind === "expression") {
					visitNode(segment.expression, caller, context, sites)
				}
			}

			return
		case "FunctionValue":
			visitBody(node.value.body, caller, context, sites)
			return
		case "CaseValue":
			if (node.value !== null) {
				visitNode(node.value, caller, context, sites)
			}

			return
		case "ChoiceDeclarationStatement":
			for (let defaultValue of caseDefaults(node.cases)) {
				visitNode(defaultValue, caller, context, sites)
			}

			return
		case "TypeAliasStatement":
		case "Identifier":
		case "Self":
		case "StringValue":
		case "IntegerValue":
		case "RationalValue":
		case "BooleanValue":
			return
	}
}

function visitArguments(
	nodeArguments: Array<common.typed.ArgumentNode>,
	caller: CallHierarchyItem,
	context: Context,
	sites: Array<CallSite>,
) {
	for (let argument of nodeArguments) {
		visitNode(argument.value, caller, context, sites)
	}
}
