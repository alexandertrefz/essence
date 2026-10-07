import type { common, enricher, parser } from "@essence-lang/interfaces"

import { primary, reportError, secondary } from "../diagnostics/index"

type OuterRead = {
	read: common.Position
	// An assignment to the outer name rather than a read of it.
	assigned: boolean
	// Where the binding the read reached was declared, null for a builtin.
	declared: common.Position | null
}

// The names each Scope read from a Scope around it, each with its first read.
// A Scope lives for one enrichment, so nothing here outlives a compile.
const outerReads = new WeakMap<enricher.Scope, Map<string, OuterRead>>()

// Notes a read that reached past its own Scope on every Scope it passed. A
// refused read reached nothing. A Parameter's default runs before the body's
// block, so the body's Scope does not count it. See "Names a block reads
// before it declares them" in DEVELOPMENT.md.
export function noteOuterRead(
	node: parser.IdentifierNode,
	type: common.Type,
	scope: enricher.Scope,
	assigned = false,
): void {
	let passed: Array<enricher.Scope> = []
	let current: enricher.Scope | null = scope

	while (current !== null && !Object.hasOwn(current.members, node.content)) {
		passed.push(current)
		current = current.parent
	}

	if (current === null || type.type === "Error") {
		return
	}

	let declared = current.declarations[node.content] ?? null

	for (let each of passed) {
		if (each.parameterDefaultBarrier !== undefined) {
			continue
		}

		let reads = outerReads.get(each) ?? new Map<string, OuterRead>()

		if (!reads.has(node.content)) {
			reads.set(node.content, { read: node.position, assigned, declared })
		}

		outerReads.set(each, reads)
	}
}

// Refuses a declaration of a name its block already read from outside.
export function refuseShadowingAfterRead(
	identifier: parser.IdentifierNode | string,
	scope: enricher.Scope,
): void {
	if (typeof identifier === "string") {
		return
	}

	let name = identifier.content
	let earlier = outerReads.get(scope)?.get(name)

	if (earlier === undefined) {
		return
	}

	let use = earlier.assigned ? "assignment" : "read"
	let verb = earlier.assigned ? "assigned" : "read"

	reportError(
		`'${name}' is declared after this block ${verb} another '${name}'`,
		identifier.position,
		{
			code: "shadowing-after-read",
			labels: [
				primary(
					identifier.position,
					`declared here, so '${name}' names this one throughout the block`,
				),
				secondary(
					earlier.read,
					`this ${use} reaches the outer '${name}'`,
				),
				...(earlier.declared === null
					? []
					: [secondary(earlier.declared, `the outer '${name}'`)]),
			],
			notes: [
				"A name means one thing throughout a block, so a block that reads an outer name can not declare its own of that name.",
			],
			helps: [
				`Give this declaration a name of its own, and rename the reads of it that follow, so the outer '${name}' stays the one ${verb} above.`,
			],
		},
	)
}
