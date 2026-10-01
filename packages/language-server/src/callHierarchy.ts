import {
	forEachParserChild,
	forEachTypedChild,
	type ParserNode,
	type TypedNode,
} from "@essence-lang/compiler/visitor"
import type { common, parser } from "@essence-lang/interfaces"

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
		for (let node of body) {
			collectItems(node, items)
		}
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
// Item is the same for a prepare and an expansion. A Function declared in a
// body is a free Function, so only a member has a container.
function collectItems(node: ParserNode, items: Map<string, CallHierarchyItem>) {
	switch (node.nodeType) {
		case "FunctionStatement":
		case "OverloadedFunctionStatement":
			addItem(
				{
					name: node.name.content,
					kind: "function",
					container: null,
					range: node.position,
					selectionRange: node.name.position,
				},
				items,
			)
			break
		case "NamespaceDefinitionStatement":
			addNamespaceItems(node, items)
			break
		case "ProtocolDeclarationStatement":
			addProtocolItems(node, items)
			break
	}

	forEachParserChild(node, collectItems, items)
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

function addNamespaceItems(
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
	}
}

// Only a provided Method is an Item: no call binds to a requirement.
function addProtocolItems(
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

// The walk of the typed AST, with the named caller a call is credited to.
type SiteWalk = {
	caller: CallHierarchyItem
	context: Context
	sites: Array<CallSite>
}

// A Function value names no caller, so its calls go to the nearest named one;
// top level Statements go to the implementation caller.
function collectSites(context: Context): Array<CallSite> {
	let sites: Array<CallSite> = []

	if (context.enrichedProgram === null) {
		return sites
	}

	for (let section of typedProgramSections(context.enrichedProgram)) {
		let walk: SiteWalk = {
			caller:
				section.kind === "implementation"
					? context.topLevel
					: (context.testsLevel ?? context.topLevel),
			context,
			sites,
		}

		for (let node of [...section.head, ...section.nodes]) {
			visitSites(node, walk)
		}
	}

	return sites
}

// The walk inside a declaration, crediting its calls to the declaration's
// Item where it has one.
function within(position: common.Position, walk: SiteWalk): SiteWalk {
	return {
		...walk,
		caller: callerFor(position, walk.caller, walk.context),
	}
}

function visitSites(node: TypedNode, walk: SiteWalk): void {
	switch (node.nodeType) {
		case "FunctionStatement":
			forEachTypedChild(
				node,
				visitSites,
				within(node.name.position, walk),
			)
			return
		// Every Overload body attributes to the one Item the set shares, as renaming
		// does. `overloadedMethodIndex` would allow splitting them.
		case "SimpleMethod":
		case "StaticMethod":
		case "OverloadedMethod":
		case "OverloadedStaticMethod":
			forEachTypedChild(
				node,
				visitSites,
				within(node.name.position, walk),
			)
			return
		case "NamespaceDefinitionStatement":
			visitNamespaceSites(node, walk)
			return
		case "FunctionInvocation":
			if (node.name.nodeType === "Identifier") {
				recordCall(node.name.position, walk)
			} else if (
				node.name.nodeType === "Lookup" &&
				node.name.base.type.type === "Namespace"
			) {
				// `Namespace.staticMethod(…)`, a Lookup the rename index binds
				// to the static Method.
				recordCall(node.name.member.position, walk)
			}

			break
		case "MethodInvocation":
			// The receiver first, so a chain reports its calls in written order.
			visitSites(node.base, walk)

			// A call on a Union receiver dispatches per member Type, and its `namespace`
			// is a placeholder, so it is skipped. So is a receiver not yet resolved,
			// whose `namespace.name` is empty.
			if (node.dispatch === null) {
				recordCall(node.member.position, walk)
			}

			forEachTypedChild(node, (child) => {
				if (child !== node.base) {
					visitSites(child, walk)
				}
			})

			return
	}

	forEachTypedChild(node, visitSites, walk)
}

// A property's initialiser calls on the property's behalf, so the Namespace
// walks its own members.
function visitNamespaceSites(
	node: common.typed.NamespaceDefinitionStatementNode,
	walk: SiteWalk,
) {
	for (let property of Object.values(node.properties)) {
		visitSites(property.value, within(property.name.position, walk))
	}

	for (let member of Object.values(node.methods)) {
		visitSites(member, walk)
	}

	visitNativeShims(node, walk)
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
	walk: SiteWalk,
) {
	for (let shim of node.nativeShims) {
		let caller =
			memberItem(node.name.content, shim.memberName, walk.context) ??
			walk.caller

		visitSites(shim, { ...walk, caller })
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
function recordCall(position: common.Position, walk: SiteWalk) {
	let { caller, context, sites } = walk
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
