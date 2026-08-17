import { parameterDefaults } from "@essence-lang/compiler/helpers"
import type { common, parser } from "@essence-lang/interfaces"

import { typedHandlerExpressions } from "./matchHandlerChildren"
import { isAtOrBefore } from "./positions"
import {
	buildRenameIndex,
	type Declaration,
	occurrenceAt,
	type RenameIndex,
} from "./rename"

// NOTE: The Call Hierarchy is single-document and stateless. Nothing survives a
// request: an Item round-trips its `selectionRange`, so the incoming and
// outgoing requests re-parse the document and resolve the Declaration at that
// Position again — exactly what every other request in this Server does.
//
// Callers and callees ARE the rename index's Declarations. The index already
// knows which name at which Position binds to which Function, Method or static
// Method, including the ones that resolve through Types rather than through a
// Scope, so the walk below only has to ask it. A callee the index has no
// Declaration for — a builtin, or a standard library Method living in another
// document — is skipped rather than offered as an item nothing can be expanded
// from; a single document is all this feature can honestly answer for.

export type CallHierarchyItemKind =
	| "function"
	| "method"
	| "staticMethod"
	| "property"
	| "implementation"

export type CallHierarchyItem = {
	name: string
	kind: CallHierarchyItemKind
	// NOTE: The Namespace a Method or Property belongs to — null for a free
	// Function and for the implementation block.
	container: string | null
	// NOTE: `range` spans the whole declaring construct, `selectionRange` just
	// the name, mirroring the LSP's CallHierarchyItem. `selectionRange` is what
	// the item is re-resolved from, so it has to be the Declaration's
	// definition and nothing else.
	range: common.Position
	selectionRange: common.Position
}

export type CallSite = {
	caller: CallHierarchyItem
	callee: CallHierarchyItem
	// NOTE: Where the callee's name is written at the call site — what an
	// Editor reveals when the reader picks the call out of the tree.
	range: common.Position
}

export type CallHierarchyCalls = {
	item: CallHierarchyItem
	ranges: Array<common.Position>
}

// NOTE: The kinds a call can target. A Constant or Variable holding a Function
// value is deliberately NOT one of them, in prepare and at call sites alike:
// the name binds to a value, and which Function that value is at any given call
// is a question about data flow — reassignment, conditional binding, a Function
// returned from another Function — that a lexical single-document index cannot
// answer. Showing the declaration of the Constant as the callee would be a
// guess dressed as a fact.
const callableKinds = new Set<Declaration["kind"]>([
	"function",
	"method",
	"staticMethod",
])

type Context = {
	enrichedProgram: common.typed.Program | null
	index: RenameIndex
	// NOTE: Occurrence Position → the Declaration it binds to, so that a call
	// site resolves its callee by the Position of the name it wrote.
	declarationAt: Map<string, Declaration>
	// NOTE: Definition Position → the Item declared there. Built from the
	// Parser AST, so that an Item exists for every Function and Method even
	// when enrichment failed and the typed walk contributes nothing.
	items: Map<string, CallHierarchyItem>
	topLevel: CallHierarchyItem
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

	collectItems(program.implementation.nodes, null, items)

	return {
		enrichedProgram,
		index,
		declarationAt,
		items,
		topLevel: topLevelItem(program),
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

	// NOTE: A builtin has no definition, so it is refused here along with
	// everything else the document does not declare.
	if (
		!callableKinds.has(declaration.kind) ||
		declaration.definition === null
	) {
		return null
	}

	return context.items.get(positionKey(declaration.definition)) ?? null
}

// NOTE: The synthetic caller every top level Statement attributes to. The
// implementation block is not a Declaration and can never be called, so it only
// ever appears as an incoming caller — asking it for ITS callers resolves
// nothing and answers with an empty list, which is the truth.
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

// NOTE: Item geometry comes off the Parser AST — it survives Type errors, and
// it is the same walk whether the request is a prepare or an expansion, so an
// Item is byte-for-byte the one the client sent back.
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

	// NOTE: A re-declaration shares the first Declaration in the rename index,
	// whose `definition` is the first name Position — so the first Item at a
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

			// NOTE: A Function declared inside another body is a free Function
			// of its own, not a member of whatever encloses it — so the
			// container does not travel into bodies.
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
		case "RecordValue":
			for (let member of Object.values(node.members)) {
				collectItemsFromNode(member.value, container, items)
			}

			return
		case "ListValue":
			for (let value of node.values) {
				collectItemsFromNode(value, container, items)
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
		case "ProtocolDeclarationStatement":
		case "ChoiceDeclarationStatement":
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
				// NOTE: A native static Property has no value to span to — its
				// range is then just its name.
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

		// NOTE: The Method wrappers carry no Position of their own — the range
		// is the span from the name to the end of the last Overload. One Item
		// covers the whole Overload set, since the rename index gives the set
		// one Declaration.
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

function spanning(a: common.Position, b: common.Position): common.Position {
	return {
		start: isAtOrBefore(a.start, b.start) ? a.start : b.start,
		end: isAtOrBefore(a.end, b.end) ? b.end : a.end,
	}
}

/**************/
/* Call sites */
/**************/

// NOTE: ONE walk of the typed AST with an explicit caller stack — the enclosing
// named declaration is threaded down rather than searched for afterwards, so a
// call knows its caller by construction.
//
// A Function VALUE pushes nothing: a lambda has no name to show and no
// Declaration to expand, so its calls attribute to the nearest enclosing named
// caller, which is where the reader would look for them anyway. Statements at
// the top level attribute to the synthetic implementation caller.
function collectSites(context: Context): Array<CallSite> {
	let sites: Array<CallSite> = []

	if (context.enrichedProgram === null) {
		return sites
	}

	visitBody(
		context.enrichedProgram.implementation.nodes,
		context.topLevel,
		context,
		sites,
	)

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

// NOTE: `position` is where the callee's NAME is written — an Identifier for a
// Function, the member of a Lookup for a static Method, the member of a Method
// Invocation otherwise. The index binds all three; anything it does not bind is
// a name this document does not declare.
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

// NOTE: `= @::length()` IS a call, and it is made by the Declaration the default
// is written on — so it is an outgoing call of that Function or Method, exactly
// as one written in the body is.
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

				// NOTE: Every Overload body is walked, and every one of them
				// attributes to the same Item — Overloads share a name, and so
				// share the single Declaration the rename index gives them.
				// Calls therefore aggregate across the Overload set, exactly as
				// renaming does. The typed Invocation Nodes carry an
				// `overloadedMethodIndex`, so splitting the set apart stays
				// possible if it ever turns out to be what a reader wants.
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

				// NOTE: A native Method has no body, and the frame the Compiler
				// synthesizes for its defaults is where its calls live —
				// `slice(from start: Integer = 0, to end: Integer =
				// @::length())` calls `length`, and the hierarchy has to say so.
				for (let shim of node.nativeShims) {
					visitDefaults(
						shim.parameters,
						callerFor(member.name.position, caller, context),
						context,
						sites,
					)
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
		case "FunctionInvocation":
			if (node.name.nodeType === "Identifier") {
				recordCall(node.name.position, caller, context, sites)
			} else if (
				node.name.nodeType === "Lookup" &&
				node.name.base.type.type === "Namespace"
			) {
				// NOTE: `Namespace.staticMethod(…)` — a Lookup through a
				// Namespace, which the typed pass of the rename index binds to
				// the static Method's Declaration.
				recordCall(node.name.member.position, caller, context, sites)
			}

			visitNode(node.name, caller, context, sites)
			visitArguments(node.arguments, caller, context, sites)
			return
		case "MethodInvocation":
			// NOTE: The receiver is walked before the call is recorded, so that
			// a chain reports its calls in the order they are written.
			visitNode(node.base, caller, context, sites)

			// NOTE: A Method call on a Union receiver dispatches per member
			// Type, and its `namespace` is then a placeholder — the statically
			// resolved targets live one per `dispatch` case. Those are skipped:
			// each case names its Namespace by name only, and turning a
			// Namespace name plus a Method name back into a Declaration needs
			// the member index rename keeps to itself. Attributing the call to
			// the placeholder instead would name whichever Namespace happens to
			// answer to the empty name, which is none.
			//
			// The same skip covers the ordinary state of a document being typed
			// in: until enrichment resolves a receiver, `namespace.name` is the
			// empty string, nothing in the index sits at the member's Position,
			// and the call is simply not a call yet.
			if (node.dispatch === null) {
				recordCall(node.member.position, caller, context, sites)
			}

			visitArguments(node.arguments, caller, context, sites)
			return
		case "Lookup":
			visitNode(node.base, caller, context, sites)
			return
		case "Combination":
			visitNode(node.lhs, caller, context, sites)
			visitNode(node.rhs, caller, context, sites)
			return
		case "Match":
			visitNode(node.value, caller, context, sites)

			for (let handler of node.handlers) {
				// NOTE: A Handler holds Expressions outside its body — the
				// literal it compares against and the Guard both hold calls,
				// and a walk that visited only `body` would report a Function
				// called exclusively from a `where` clause as called by nobody.
				for (let expression of typedHandlerExpressions(handler)) {
					visitNode(expression, caller, context, sites)
				}

				visitBody(handler.body, caller, context, sites)
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
		case "ProtocolDeclarationStatement":
		case "ChoiceDeclarationStatement":
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
