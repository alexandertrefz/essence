import type { common } from "@essence-lang/interfaces"

// NOTE: A Namespace a provided body's emission names without the body writing
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

// NOTE: Every such Namespace in a typed provided body, but one a block around
// the reach declares. A witness names its Namespace once for each Method in its
// map, so a witness whose map is empty names none.
export function typedBodyNamespaceReaches(
	body: common.typed.FunctionValueNode,
): Array<NamespaceReach> {
	let reaches: Array<NamespaceReach> = []
	let seen = new WeakMap<object, Set<ReadonlySet<string>>>()

	// NOTE: `declared` holds the Namespaces the blocks around `value` declare.
	// Each is emitted as a class of its block, so there its name is that class
	// and never the Program's Namespace.
	let visit = (
		value: unknown,
		at: common.Position,
		declared: ReadonlySet<string>,
	): void => {
		if (typeof value !== "object" || value === null) {
			return
		}

		if (Array.isArray(value)) {
			let block = blockNamespaces(value, declared)

			for (let item of value) {
				visit(item, at, block)
			}

			return
		}

		let record = value as Record<string, unknown>
		let visits = seen.get(record) ?? new Set<ReadonlySet<string>>()

		// NOTE: A Type names no Namespace, and a Protocol declared inside the
		// body is emitted apart from it.
		if (
			(typeof record.type === "string" &&
				record.nodeType === undefined) ||
			record.nodeType === "ProtocolDeclarationStatement" ||
			visits.has(declared)
		) {
			return
		}

		seen.set(record, visits.add(declared))

		let position = (record.position as common.Position | undefined) ?? at
		let reach = (found: NamespaceReach): void => {
			if (!declared.has(found.namespace)) {
				reaches.push(found)
			}
		}

		if (record.nodeType === "MethodInvocation") {
			let invocation =
				record as unknown as common.typed.MethodInvocationNode

			if (invocation.dispatch !== null) {
				for (let branch of invocation.dispatch) {
					if (branch.providedBy === undefined) {
						reach({
							kind: "call",
							namespace: branch.namespaceName,
							member: invocation.member.name,
							position: invocation.member.position,
						})
					}
				}
			} else if (invocation.namespace.type.providedBy === undefined) {
				reach({
					kind: "call",
					namespace: invocation.namespace.name,
					member: invocation.member.name,
					position: invocation.member.position,
				})
			}
		} else if (record.nodeType === "Lookup") {
			let lookup = record as unknown as common.typed.LookupNode

			if (
				lookup.namespaceName !== undefined &&
				lookup.providedBy === undefined
			) {
				reach({
					kind: "call",
					namespace: lookup.namespaceName,
					member: lookup.member.content,
					position: lookup.member.position,
				})
			}
		} else if (
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
						position,
					})
				}
			}
		}

		// NOTE: A String hole's witness is asked for by the hole.
		let hole =
			record.kind === "expression" &&
			typeof record.expression === "object" &&
			record.expression !== null
				? ((record.expression as { position?: common.Position })
						.position ?? position)
				: position

		for (let [key, item] of Object.entries(record)) {
			if (key !== "position") {
				visit(item, key === "conformance" ? hole : position, declared)
			}
		}
	}

	visit(body, body.position, NO_NAMESPACES)

	return reaches
}

const NO_NAMESPACES: ReadonlySet<string> = new Set()

// NOTE: The Namespaces declared in a block and around it, or `declared` itself
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
