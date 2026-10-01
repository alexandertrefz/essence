import type { common } from "@essence-lang/interfaces"

import { forEachTypedChild, type TypedNode } from "../visitor/index"
import { forEachHeldRecord } from "./nodes"

// A Namespace a provided body's emission names without the body writing
// the name: a Method of it called, or a witness built from its conformance.
export type NamespaceReach =
	| {
			kind: "call"
			namespace: string
			member: string
			position: common.Position
	  }
	| {
			kind: "witness"
			namespace: string
			protocol: string
			position: common.Position
	  }

// Every such Namespace in a typed provided body, but one a block around
// the reach declares. A witness names its Namespace once for each Method in its
// map, so a witness whose map is empty names none.
export function typedBodyNamespaceReaches(
	body: common.typed.FunctionValueNode,
): Array<NamespaceReach> {
	let reaches: Array<NamespaceReach> = []
	let seen = new WeakMap<object, Set<ReadonlySet<string>>>()
	// The Namespaces each block declares, keyed by the block.
	let blocks = new WeakMap<object, ReadonlySet<string>>()

	// `declared` holds the Namespaces the blocks around `node` declare.
	// Each is emitted as a class of its block, so there its name is that class
	// and never the Program's Namespace. `at` is where the node's holder stands.
	let visitNode = (
		node: TypedNode,
		declared: ReadonlySet<string>,
		at: common.Position,
	): void => {
		// A Protocol declared inside the body is emitted apart from it.
		if (node.nodeType === "ProtocolDeclarationStatement") {
			return
		}

		let reach = (found: NamespaceReach): void => {
			if (!declared.has(found.namespace)) {
				reaches.push(found)
			}
		}

		if (node.nodeType === "MethodInvocation") {
			if (node.dispatch !== null) {
				for (let branch of node.dispatch) {
					if (branch.providedBy === undefined) {
						reach({
							kind: "call",
							namespace: branch.namespaceName,
							member: node.member.name,
							position: node.member.position,
						})
					}
				}
			} else if (node.namespace.type.providedBy === undefined) {
				reach({
					kind: "call",
					namespace: node.namespace.name,
					member: node.member.name,
					position: node.member.position,
				})
			}
		} else if (
			node.nodeType === "Lookup" &&
			node.namespaceName !== undefined &&
			node.providedBy === undefined
		) {
			reach({
				kind: "call",
				namespace: node.namespaceName,
				member: node.member.content,
				position: node.member.position,
			})
		}

		let position = (node as { position?: common.Position }).position ?? at

		forEachTypedChild(node, (child, _state, field, key, container) =>
			visitNode(
				child,
				blockAround(node, field, key, container, declared),
				position,
			),
		)

		// Where each object the node holds stands, for a witness built there.
		let places = new Map<object, common.Position>([[node, position]])

		forEachHeldRecord(node, (record, field, holder) => {
			let visits = seen.get(record) ?? new Set<ReadonlySet<string>>()

			if (visits.has(declared)) {
				return false
			}

			seen.set(record, visits.add(declared))

			let place =
				(record.position as common.Position | undefined) ??
				(field === "conformance"
					? holePosition(holder, places)
					: places.get(holder)!)

			places.set(record, place)

			if (
				typeof record.protocolName === "string" &&
				isNamespaceSource(record.source)
			) {
				for (let witness of [
					{ ...record.source, protocolName: record.protocolName },
					...(record.source.providedWitnesses ?? []),
				]) {
					if (Object.keys(witness.methodMap).length > 0) {
						reach({
							kind: "witness",
							namespace: witness.name,
							protocol: witness.protocolName,
							position: place,
						})
					}
				}
			}

			// A dispatch branch's own typed copy of a Function literal Argument,
			// which the visitor does not reach.
			if (field === "contextualArguments") {
				visitNode(
					record.argument as common.typed.ArgumentNode,
					declared,
					place,
				)
			}

			return true
		})
	}

	// The Namespaces the block holding a child declares, and those around it.
	// The block is the child's field, on the node or on the container it names.
	let blockAround = (
		node: TypedNode,
		field: string,
		key: string | number | undefined,
		container: string | undefined,
		declared: ReadonlySet<string>,
	): ReadonlySet<string> => {
		let holder = node as unknown as Record<string, any>
		let standing =
			container === undefined
				? holder
				: key === undefined
					? holder[container]
					: holder[container][key]
		let items: unknown = standing[field]

		if (!Array.isArray(items)) {
			return declared
		}

		let block = blocks.get(items)

		if (block === undefined) {
			block = blockNamespaces(items, declared)
			blocks.set(items, block)
		}

		return block
	}

	visitNode(body, NO_NAMESPACES, body.position)

	// In written order. A node's witnesses are read after its children, and a
	// call's own reach comes before its receiver's.
	return reaches.sort(
		(left, right) =>
			left.position.start.line - right.position.start.line ||
			left.position.start.column - right.position.start.column,
	)
}

const NO_NAMESPACES: ReadonlySet<string> = new Set()

// A String hole's witness is asked for by the hole.
function holePosition(
	segment: Record<string, unknown>,
	places: Map<object, common.Position>,
): common.Position {
	let expression = segment.expression as { position?: common.Position } | null

	return segment.kind === "expression" &&
		typeof expression === "object" &&
		expression !== null
		? (expression.position ?? places.get(segment)!)
		: places.get(segment)!
}

// The Namespaces declared in a block and around it, or `declared` itself
// where the block declares none.
function blockNamespaces(
	items: Array<unknown>,
	declared: ReadonlySet<string>,
): ReadonlySet<string> {
	let names = items.flatMap((item) =>
		typeof item === "object" &&
		item !== null &&
		(item as { nodeType?: unknown }).nodeType ===
			"NamespaceDefinitionStatement"
			? [
					(item as common.typed.NamespaceDefinitionStatementNode).name
						.content,
				]
			: [],
	)

	return names.length === 0 ? declared : new Set([...declared, ...names])
}

function isNamespaceSource(
	source: unknown,
): source is Extract<common.ConformanceSource, { kind: "namespace" }> {
	return (
		typeof source === "object" &&
		source !== null &&
		(source as { kind?: unknown }).kind === "namespace"
	)
}
