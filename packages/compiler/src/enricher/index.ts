import type { common, enricher, parser } from "@essence/interfaces"

import {
	collectDiagnostics,
	containsErrors,
	primary,
	report,
	reportError,
} from "../diagnostics/index"
import { collectAnnotations } from "./annotations"
import { builtinMembers, builtinProtocols, builtinTypes } from "./builtins"
import {
	enrichNode,
	enrichOverloadedFunctionStatement,
	type HoistedTypes,
	resolveNamespaceDefinitionStatementType,
} from "./enrichers"
import {
	invalidateNamespacesInScope,
	referencedTypeNames,
	resolveChoiceDeclarationStatementType,
	resolveFunctionSignatureType,
	resolveNativeFunctionStatementType,
	resolveOverloadedFunctionStatementType,
	resolveProtocolDeclarationStatementType,
	resolveTypeAliasStatementType,
} from "./resolvers"
import { scopeMap } from "./scope"

// NOTE: Names to leave OUT of the top level Scope, per table. Exactly one
// caller needs this: the Language Server, editing a standard library source.
// That file's declarations are ALREADY in the builtin tables — the loader put
// them there — so enriching it against the untouched tables reports every one
// of them as a redeclaration of itself. Subtracting them makes the document
// the declaration of its own names again, which is what it is.
export type ShadowedBuiltins = {
	members: Set<string>
	types: Set<string>
	protocols: Set<string>
}

const withoutShadowed = <Value>(
	table: Record<string, Value>,
	names: Set<string> | undefined,
): Record<string, Value> =>
	names === undefined || names.size === 0
		? table
		: Object.fromEntries(
				Object.entries(table).filter(([name]) => !names.has(name)),
			)

export const enrich = (
	program: parser.Program,
	options: {
		shadowedBuiltins?: ShadowedBuiltins
		// NOTE: Only the Language Server sets this, for Hovers over a written
		// Type. A compile leaves it off and the collector stays null.
		annotations?: boolean
	} = {},
): {
	program: common.typed.Program
	diagnostics: Array<common.Diagnostic>
	annotations: Array<common.TypeAnnotation>
} => {
	let shadowed = options.shadowedBuiltins
	let annotations: Array<common.TypeAnnotation> = []

	let { result, diagnostics } = collectDiagnostics(
		(): common.typed.Program => {
			let members: Record<string, common.Type> = scopeMap(
				withoutShadowed(builtinMembers(), shadowed?.members),
			)

			let topLevelScope: enricher.Scope = {
				parent: null,
				members,
				// NOTE: The builtins are declared in TypeScript, not in
				// Essence — there is no source Position to point a
				// Diagnostic at.
				declarations: scopeMap(),
				constants: new Set(Object.keys(members)),
				types: scopeMap(
					withoutShadowed(builtinTypes(), shadowed?.types),
				),
				protocols: scopeMap(
					withoutShadowed(builtinProtocols(), shadowed?.protocols),
				),
			}

			let enrichSection = () =>
				enrichImplementation(program.implementation, topLevelScope)

			if (options.annotations !== true) {
				return {
					nodeType: "Program",
					implementation: enrichSection(),
					position: program.position,
				}
			}

			// NOTE: The collector opens AFTER the builtin tables are built, and
			// that is not a matter of taste either. Building them is what loads
			// the standard library on the first call of a process, and that
			// load enriches ~20 OTHER files — every annotation in every one of
			// them would land in THIS document's index, at Positions that mean
			// nothing here.
			let collected = collectAnnotations(enrichSection)

			annotations = collected.annotations

			return {
				nodeType: "Program",
				implementation: collected.result,
				position: program.position,
			}
		},
	)

	return { program: result, diagnostics, annotations }
}

// NOTE: Several Programs enriched into ONE shared Scope, which is how the
// standard library is read: its files are one declaration space, not a chain
// of imports. Hoisting runs ONCE over every file's Nodes concatenated, so the
// speculative rounds resolve across file boundaries too — a Protocol declared
// in one file and a Namespace conforming to it in another hoist in whichever
// order they happen to resolve, exactly as two Statements in one file do.
// Diagnostics are collected per Program, so each stays attributable to the
// file it came from.
export const enrichPrograms = (
	programs: Array<parser.Program>,
	scope: enricher.Scope,
): Array<{
	program: common.typed.Program
	diagnostics: Array<common.Diagnostic>
}> => {
	// NOTE: The hoist spans every file, so it runs BEFORE any Program's
	// collection is open — a Diagnostic reported from inside it would land in
	// whatever collection happens to surround the load instead. The standard
	// library loads lazily, inside the first compile of a process, so "whatever
	// surrounds it" is a user Program: a cycle in a library file would load
	// without a single per-file Diagnostic and stamp its own, library
	// positioned, errors onto that compile. The hoist hands them over per Node
	// here, and each is replayed into the collection of the Program its Node
	// was written in.
	let hoistDiagnostics = new Map<
		parser.ImplementationNode,
		Array<common.Diagnostic>
	>()

	let hoistedTypes = hoistDeclarations(
		programs.flatMap((program) => program.implementation.nodes),
		scope,
		(node, diagnostics) => {
			let collected = hoistDiagnostics.get(node)

			if (collected === undefined) {
				hoistDiagnostics.set(node, [...diagnostics])
			} else {
				collected.push(...diagnostics)
			}
		},
	)

	return programs.map((program) => {
		let { result, diagnostics } = collectDiagnostics(
			(): common.typed.Program => {
				for (let node of program.implementation.nodes) {
					for (let diagnostic of hoistDiagnostics.get(node) ?? []) {
						report(diagnostic)
					}
				}

				return {
					nodeType: "Program",
					implementation: enrichImplementation(
						program.implementation,
						scope,
						hoistedTypes,
					),
					position: program.position,
				}
			},
		)

		return { program: result, diagnostics }
	})
}

type HoistableStatementNode =
	| parser.TypeAliasStatementNode
	| parser.ChoiceDeclarationStatementNode
	| parser.FunctionStatementNode
	| parser.NativeFunctionStatementNode
	| parser.OverloadedFunctionStatementNode
	| parser.NamespaceDefinitionStatementNode
	| parser.ProtocolDeclarationStatementNode

function isHoistable(
	node: parser.ImplementationNode,
): node is HoistableStatementNode {
	return (
		node.nodeType === "TypeAliasStatement" ||
		node.nodeType === "ChoiceDeclarationStatement" ||
		node.nodeType === "FunctionStatement" ||
		node.nodeType === "NativeFunctionStatement" ||
		node.nodeType === "OverloadedFunctionStatement" ||
		node.nodeType === "NamespaceDefinitionStatement" ||
		node.nodeType === "ProtocolDeclarationStatement"
	)
}

type HoistableTypeNode =
	| parser.TypeAliasStatementNode
	| parser.ChoiceDeclarationStatementNode

// NOTE: Where the Diagnostics the hoist itself reports go. A lone Program
// hoists inside its own collection and the default sink just reports them on;
// `enrichPrograms` hoists every file at once, before any collection is open,
// and needs each one attributed to the Node's own Program — which is why the
// Node comes along.
type HoistDiagnosticSink = (
	node: parser.ImplementationNode,
	diagnostics: Array<common.Diagnostic>,
) => void

const reportOnwards: HoistDiagnosticSink = (_node, diagnostics) => {
	for (let diagnostic of diagnostics) {
		report(diagnostic)
	}
}

// NOTE: The Type names a Type declaration mentions. The body — an alias' Type,
// a Choice's payloads — is read minus the declaration's own Type Parameters:
// `choice Holder<Item> { Full { value: Item } }` mentions nothing, because
// `Item` there is the Parameter and not whatever else `Item` may name further
// out. A Generic's `defaultType` counts too, and counts UNFILTERED: the body
// resolves in a Scope holding the Parameters, but a default resolves in the one
// AROUND the declaration, where a Parameter shadows nothing — so the `B` in
// `type B<B = B> = { x: Integer }` names the declaration being made, and a
// cycle through a default is just as unresolvable as one through a payload.
function typeNamesMentionedBy(
	node: HoistableTypeNode,
): Array<parser.IdentifierNode> {
	let parameters = new Set(
		node.generics.map((generic) => generic.name.content),
	)
	let bodyReferences: Array<parser.IdentifierNode> = []

	if (node.nodeType === "TypeAliasStatement") {
		bodyReferences.push(...referencedTypeNames(node.type))
	} else {
		for (let choiceCase of node.cases) {
			if (choiceCase.type !== null) {
				bodyReferences.push(...referencedTypeNames(choiceCase.type))
			}
		}
	}

	return [
		...node.generics.flatMap((generic) =>
			generic.defaultType === null
				? []
				: referencedTypeNames(generic.defaultType),
		),
		...bodyReferences.filter(
			(reference) => !parameters.has(reference.content),
		),
	]
}

// NOTE: The one recursive shape this pass does NOT own — a generic Choice that
// names itself in a payload, which `resolveGenericCaseMembers` reports as
// `recursive-generic-choice` member by member and resolves to Error, so the
// declaration hoists regardless. The test mirrors that one exactly, Type
// Parameters included, so that the two can never both fire on the same
// declaration.
function namesItselfInAPayload(node: HoistableTypeNode): boolean {
	return (
		node.nodeType === "ChoiceDeclarationStatement" &&
		node.generics.length > 0 &&
		node.cases.some(
			(choiceCase) =>
				choiceCase.type !== null &&
				referencedTypeNames(choiceCase.type).some(
					(reference) => reference.content === node.name.content,
				),
		)
	)
}

// NOTE: Which declaration each hoistable Type name belongs to, and which of
// those names each of them mentions — the graph the cycle search runs on. Two
// restrictions make an edge mean "resolving this needs that one resolved
// first": a name the surrounding Scope ALREADY holds (a builtin, a standard
// library Type) is not one of these declarations, because the hoist refuses to
// overwrite an occupied slot and the redeclaration is reported as a duplicate;
// and of two declarations spelling the same name only the first can ever reach
// Scope. Each edge keeps the FIRST Identifier that spells it, so a Diagnostic
// has a Position to point at.
function typeDeclarationGraph(
	nodes: Array<HoistableTypeNode>,
	scope: enricher.Scope,
): {
	declarations: Map<string, HoistableTypeNode>
	edges: Map<string, Map<string, parser.IdentifierNode>>
} {
	let declarations = new Map<string, HoistableTypeNode>()

	for (let node of nodes) {
		if (
			scope.types[node.name.content] == null &&
			!declarations.has(node.name.content)
		) {
			declarations.set(node.name.content, node)
		}
	}

	let edges = new Map<string, Map<string, parser.IdentifierNode>>()

	for (let [name, node] of declarations) {
		let mentioned = new Map<string, parser.IdentifierNode>()

		for (let reference of typeNamesMentionedBy(node)) {
			if (
				declarations.has(reference.content) &&
				!mentioned.has(reference.content)
			) {
				mentioned.set(reference.content, reference)
			}
		}

		edges.set(name, mentioned)
	}

	return { declarations, edges }
}

// NOTE: The shortest way from `start` back to itself through `members`, as the
// names it passes on the way — empty when `start` names itself outright. Only
// ever asked about a declaration already known to be part of a cycle, so its
// cost is paid by broken Programs alone; the search that FINDS the cycles is
// the linear one below.
function cyclePathThrough(
	start: string,
	members: Set<string>,
	edges: Map<string, Map<string, parser.IdentifierNode>>,
): Array<string> {
	let previous = new Map<string, string>()
	let queue = [start]

	while (queue.length > 0) {
		let current = queue.shift()!

		for (let target of edges.get(current)?.keys() ?? []) {
			if (!members.has(target)) {
				continue
			}

			if (target === start) {
				let path: Array<string> = []

				for (
					let step = current;
					step !== start;
					step = previous.get(step)!
				) {
					path.unshift(step)
				}

				return path
			}

			if (!previous.has(target)) {
				previous.set(target, current)
				queue.push(target)
			}
		}
	}

	return []
}

// NOTE: Tarjan's strongly connected components over the declaration graph: one
// depth-first walk, linear in declarations and mentions, because this runs on
// EVERY compile — the standard library's included, where there is no cycle to
// find. A component of two or more declarations is a cycle by construction; a
// lone one is only cyclic when it names itself.
function recursiveTypeDeclarationGroups(
	nodes: Array<HoistableTypeNode>,
	scope: enricher.Scope,
): Array<{
	members: Array<HoistableTypeNode>
	edges: Map<string, Map<string, parser.IdentifierNode>>
}> {
	let { declarations, edges } = typeDeclarationGraph(nodes, scope)
	let indices = new Map<string, number>()
	let lowLinks = new Map<string, number>()
	let stack: Array<string> = []
	let onStack = new Set<string>()
	let groups: Array<Array<string>> = []
	let nextIndex = 0

	let visit = (name: string): void => {
		indices.set(name, nextIndex)
		lowLinks.set(name, nextIndex)
		nextIndex += 1
		stack.push(name)
		onStack.add(name)

		for (let target of edges.get(name)?.keys() ?? []) {
			if (!indices.has(target)) {
				visit(target)
				lowLinks.set(
					name,
					Math.min(lowLinks.get(name)!, lowLinks.get(target)!),
				)
			} else if (onStack.has(target)) {
				lowLinks.set(
					name,
					Math.min(lowLinks.get(name)!, indices.get(target)!),
				)
			}
		}

		if (lowLinks.get(name) !== indices.get(name)) {
			return
		}

		let group: Array<string> = []

		for (;;) {
			let member = stack.pop()!

			onStack.delete(member)
			group.push(member)

			if (member === name) {
				break
			}
		}

		if (group.length > 1 || edges.get(name)?.has(name) === true) {
			groups.push(group)
		}
	}

	for (let name of declarations.keys()) {
		if (!indices.has(name)) {
			visit(name)
		}
	}

	// NOTE: Tarjan pops components in the order it finishes them, which is
	// neither the order the declarations were written in nor a stable one.
	// Members and groups alike are put back into declaration order, so that the
	// Diagnostics read down the file — one cycle at a time — rather than in an
	// order that would change with an unrelated edit.
	let order = new Map(nodes.map((node, index) => [node, index]))
	let indexOf = (node: HoistableTypeNode) => order.get(node)!

	return groups
		.map((group) => ({
			members: group
				.map((name) => declarations.get(name)!)
				.sort((left, right) => indexOf(left) - indexOf(right)),
			edges,
		}))
		.sort(
			(left, right) =>
				indexOf(left.members[0]) - indexOf(right.members[0]),
		)
}

// NOTE: Every recursive Type declaration, reported once per member of the cycle
// it belongs to, and handed back so the hoist can poison it. A cycle can not be
// resolved at all — a Type declaration is substituted where it is named, so
// resolving one that (transitively) names itself would never finish — which is
// why the Diagnostic is raised HERE, before the hoist rounds, rather than being
// left to a resolution that would report the members it could not find instead.
function reportRecursiveTypeDeclarations(
	nodes: Array<HoistableTypeNode>,
	scope: enricher.Scope,
	sink: HoistDiagnosticSink,
): Array<HoistableTypeNode> {
	let recursiveNodes: Array<HoistableTypeNode> = []

	for (let group of recursiveTypeDeclarationGroups(nodes, scope)) {
		if (
			group.members.length === 1 &&
			namesItselfInAPayload(group.members[0])
		) {
			continue
		}

		let members = new Set(group.members.map((node) => node.name.content))

		for (let node of group.members) {
			let name = node.name.content
			// NOTE: An empty path is a declaration that names ITSELF: every
			// member of a group of two or more is reachable from itself through
			// the others, so the search only comes back empty where a self
			// mention closed the cycle on the spot. Either way the name it ends
			// on is one this declaration mentions, so the edge holding the
			// Identifier to point at is there.
			let through = cyclePathThrough(name, members, group.edges)
			let reference = group.edges
				.get(name)!
				.get(through.length === 0 ? name : through[0])!
			let kind =
				node.nodeType === "ChoiceDeclarationStatement"
					? "Choice"
					: "Type"
			let notes = [
				"A Type declaration is substituted wherever it is named, so a declaration that names itself would never finish resolving.",
			]

			if (through.length > 0) {
				let path = [name, ...through, name]
				let sentence = `'${path[0]}' names '${path[1]}'`

				for (let step = 2; step < path.length; step += 1) {
					sentence += `, which names '${path[step]}'`
				}

				notes.unshift(`${sentence} again.`)
			}

			let { diagnostics } = collectDiagnostics((): void => {
				reportError(
					through.length === 0
						? `${kind} '${name}' names itself`
						: `${kind} '${name}' names itself through '${through[0]}'`,
					reference.position,
					{
						code: "recursive-type-declaration",
						labels: [
							primary(
								reference.position,
								through.length === 0
									? "this names the declaration being made"
									: `this names '${through[0]}'`,
							),
						],
						notes,
						helps: [
							"Recursive Type declarations are not part of the language yet — break the cycle.",
						],
					},
				)
			})

			sink(node, diagnostics)
			recursiveNodes.push(node)
		}
	}

	return recursiveNodes
}

// NOTE: Type Aliases, Functions & Namespaces are order-independent — their
// Types are hoisted into scope before the statement-by-statement enrichment,
// so that top level declarations can reference each other regardless of
// their order, including mutually recursive Functions.
//
// Hoisting is speculative: declarations are resolved in rounds until no
// further declaration resolves cleanly. Whatever can not be hoisted (because
// it is broken, a duplicate, or references Variables — which are deliberately
// not hoisted) is left to the in-order enrichment, which reports its
// Diagnostics.
function hoistDeclarations(
	nodes: Array<parser.ImplementationNode>,
	scope: enricher.Scope,
	sink: HoistDiagnosticSink = reportOnwards,
): HoistedTypes {
	let hoistedTypes: HoistedTypes = new Map()
	let pendingNodes = nodes.filter(isHoistable)

	// NOTE: The recursive Type declarations are diagnosed and taken out of the
	// rounds BEFORE they start, and the name of each is seeded as an Error in
	// their place. Without the seed every declaration naming one of them fails
	// to hoist too, and the in-order enrichment then reports each of them as a
	// Type that "is not declared" — cascading Diagnostics about names the
	// Program does declare, instead of the one about the cycle. The seed is
	// written straight into the map rather than through `declareTypeInScope`,
	// whose occupied-slot check would report a duplicate declaration.
	let recursiveNodes = reportRecursiveTypeDeclarations(
		pendingNodes.filter(
			(node): node is HoistableTypeNode =>
				node.nodeType === "TypeAliasStatement" ||
				node.nodeType === "ChoiceDeclarationStatement",
		),
		scope,
		sink,
	)

	if (recursiveNodes.length > 0) {
		let recursive = new Set<parser.ImplementationNode>(recursiveNodes)

		for (let node of recursiveNodes) {
			scope.types[node.name.content] = { type: "Error" }
		}

		pendingNodes = pendingNodes.filter((node) => !recursive.has(node))
	}

	while (pendingNodes.length > 0) {
		let remainingNodes: Array<HoistableStatementNode> = []
		// NOTE: The Protocols this round can still hoist. A Namespace conforming
		// to one of them can not have its conditional bounds woven yet — and a
		// Namespace Type reaching Scope without them is exactly what let a use
		// site above the declaration solve against an unbounded Method — so it
		// throws instead and lands in `remainingNodes` for the next round.
		let pendingProtocols = new Set(
			pendingNodes
				.filter(
					(node) => node.nodeType === "ProtocolDeclarationStatement",
				)
				.map((node) => node.name.content),
		)

		for (let node of pendingNodes) {
			let speculation: {
				result: common.Type | common.ProtocolType
				diagnostics: Array<common.Diagnostic>
			}

			try {
				speculation = collectDiagnostics(
					(): common.Type | common.ProtocolType => {
						if (node.nodeType === "TypeAliasStatement") {
							return resolveTypeAliasStatementType(node, scope)
						} else if (
							node.nodeType === "ChoiceDeclarationStatement"
						) {
							return resolveChoiceDeclarationStatementType(
								node,
								scope,
							)
						} else if (node.nodeType === "FunctionStatement") {
							return resolveFunctionSignatureType(
								node.value,
								scope,
							)
						} else if (
							node.nodeType === "NativeFunctionStatement"
						) {
							return resolveNativeFunctionStatementType(
								node,
								scope,
							)
						} else if (
							node.nodeType === "OverloadedFunctionStatement"
						) {
							return resolveOverloadedFunctionStatementType(
								node,
								scope,
							)
						} else if (
							node.nodeType === "ProtocolDeclarationStatement"
						) {
							return resolveProtocolDeclarationStatementType(
								node,
								scope,
							)
						} else {
							return resolveNamespaceDefinitionStatementType(
								node,
								scope,
								{
									deferOnPendingConformance: pendingProtocols,
								},
							)
						}
					},
				)
			} catch {
				remainingNodes.push(node)
				continue
			}

			let targetMap: Record<string, common.Type | common.ProtocolType> =
				node.nodeType === "TypeAliasStatement" ||
				node.nodeType === "ChoiceDeclarationStatement"
					? scope.types
					: node.nodeType === "ProtocolDeclarationStatement"
						? scope.protocols
						: scope.members

			// NOTE: Errors are what disqualify a speculative resolution —
			// a Declaration that could not be typed yet is one to retry in a
			// later round, once whatever it names has been hoisted. A Warning
			// says nothing about whether the Type resolved, and rejecting on
			// one would let a Warning about the Documentation above a Function
			// keep that Function out of Scope, so every call ABOVE it would
			// report `unknown-name` — a typo in a Comment breaking the Program
			// underneath it.
			//
			// The Warnings the kept reading found are handed to the sink here,
			// since a hoisted Type is reused rather than resolved a second time
			// and they would otherwise be dropped with the collection. They go
			// through the sink for the same reason the pre-pass' Diagnostics
			// do: a Warning about the Documentation in a standard library file
			// belongs to THAT file, not to whichever Program the lazy load
			// happened to sit inside. `report` deduplicates, so the paths that
			// DO resolve again cost nothing.
			if (
				!containsErrors(speculation.diagnostics) &&
				targetMap[node.name.content] == null
			) {
				sink(node, speculation.diagnostics)

				targetMap[node.name.content] = speculation.result

				// NOTE: "Which Namespaces can this Scope see" is memoised
				// against a version that every declaration bumps, and the hoist
				// writes into the Scope DIRECTLY rather than through
				// `declareVariableInScope`, which is what usually bumps it. It
				// has to bump it itself, because something DOES ask during the
				// rounds: a bodied static Property's value is enriched while its
				// Namespace resolves. Without this the first such value memoises
				// the Namespaces hoisted SO FAR, and every Method call resolved
				// afterwards — in every file — is answered from that half-built
				// table, so a whole standard library fails to enrich over one
				// Property that reads a Method.
				if (targetMap === scope.members) {
					invalidateNamespacesInScope(
						scope,
						node.name.content,
						speculation.result as common.Type,
					)
				}

				if (
					node.nodeType === "FunctionStatement" ||
					node.nodeType === "NativeFunctionStatement" ||
					node.nodeType === "OverloadedFunctionStatement" ||
					node.nodeType === "NamespaceDefinitionStatement"
				) {
					scope.constants.add(node.name.content)
				}

				hoistedTypes.set(node, speculation.result)
			} else {
				remainingNodes.push(node)
			}
		}

		if (remainingNodes.length === pendingNodes.length) {
			break
		}

		pendingNodes = remainingNodes
	}

	// NOTE: Each recursive declaration is resolved once, with the seeded Errors
	// in Scope: the back edges of the cycle resolve to Error silently, so what
	// comes out is a structurally real Type whose recursive members are Error —
	// enough for the rest of the Program to be enriched against, and no
	// `unknown-type` about a name that IS declared. It happens after the rounds
	// so that a NON-recursive declaration the cycle also names has been hoisted
	// by then, and its Diagnostics are re-reported so a genuine typo inside a
	// cycle still surfaces. Handing the Type over as a hoisted one is what keeps
	// the in-order enrichment from resolving — and re-declaring — it again.
	for (let node of recursiveNodes) {
		let { result, diagnostics } = collectDiagnostics((): common.Type => {
			// NOTE: The same guard the rounds above keep, for the same reason:
			// resolving a declaration is expected to report and recover, so
			// anything thrown past here is a Compiler bug — and one that would
			// otherwise escape `enrich` altogether rather than becoming a
			// Diagnostic. The seeded Error stays in its place, which is what
			// the rest of the Program is enriched against.
			try {
				return node.nodeType === "TypeAliasStatement"
					? resolveTypeAliasStatementType(node, scope)
					: resolveChoiceDeclarationStatementType(node, scope)
			} catch (error) {
				reportError(
					`Internal Compiler Error: ${
						error instanceof Error ? error.message : String(error)
					}`,
					node.position,
					{
						code: "internal-error",
						labels: [
							primary(node.position, "the Compiler threw here"),
						],
						notes: [
							"This is a bug in the Compiler, not in the Program.",
						],
					},
				)

				return { type: "Error" }
			}
		})

		sink(node, diagnostics)

		scope.types[node.name.content] = result
		hoistedTypes.set(node, result)
	}

	return hoistedTypes
}

// NOTE: `hoistedTypes` is passed in when the hoist already ran over a WIDER
// set of Nodes than this section's — the standard library hoists every file at
// once before any of them is enriched. A lone Program hoists its own.
const enrichImplementation = (
	implementation: parser.ImplementationSectionNode,
	scope: enricher.Scope,
	hoistedTypes: HoistedTypes = hoistDeclarations(implementation.nodes, scope),
): common.typed.ImplementationSectionNode => {
	return {
		nodeType: "ImplementationSection",
		nodes: implementation.nodes.flatMap((node) => {
			// NOTE: A native free Function declares a name bound to a runtime
			// export and has nothing to emit — no body — so it carries no typed
			// Node into the tree, exactly as a native Namespace Method carries
			// none; the Rewriter reaches it through the runtime bindings. An
			// `overload function` block is handled inside the try below, because
			// its BODIED entries DO carry Nodes (its native entries do not).
			if (node.nodeType === "NativeFunctionStatement") {
				return []
			}

			// NOTE: Expected errors are reported as Diagnostics and recovered
			// from in place — anything thrown past this point is a Compiler
			// bug. It is reported as a Diagnostic as well, so that a single
			// broken statement can not take down the enrichment of the
			// remaining Program.
			try {
				// NOTE: An `overload function` block is not one Node but one
				// per BODIED entry — each becomes a top-level Function named
				// `<name>__overload$N` for its slot in the hoisted Type, the
				// native entries carrying none. The body enrich sits inside
				// this try so a broken entry becomes an `internal-error`
				// Diagnostic like any other, rather than aborting the file.
				if (node.nodeType === "OverloadedFunctionStatement") {
					return enrichOverloadedFunctionStatement(
						node,
						scope,
						hoistedTypes.get(node),
					)
				}

				return [enrichNode(node, scope, hoistedTypes)]
			} catch (error) {
				reportError(
					`Internal Compiler Error: ${
						error instanceof Error ? error.message : String(error)
					}`,
					node.position,
					{
						code: "internal-error",
						labels: [
							primary(node.position, "the Compiler threw here"),
						],
						notes: [
							"This is a bug in the Compiler, not in the Program.",
						],
					},
				)

				return []
			}
		}),
		position: implementation.position,
	}
}
