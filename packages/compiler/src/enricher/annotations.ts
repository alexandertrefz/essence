import type { common, enricher, parser } from "@essence/interfaces"

import { modulePathOf } from "./scope"

// NOTE: The Types written down in a source, paired with what each one resolved
// to. Module state, exactly as the Diagnostic list is — `resolveType` would
// otherwise have to thread a collector through itself and its ~35 callers, for
// something no stage of the Compiler reads.
//
// NULL rather than an empty Map when nobody is collecting: only the Language
// Server ever asks for this, and a compile must not pay a Map write per
// annotation for a Hover it will never render.
//
// Keyed by the parser NODE, not by its Position, so that `Map.set` IS the
// last-write-wins rule. The same annotation is resolved more than once —
// hoisting resolves declarations speculatively in rounds and the in-order
// enrichment re-resolves most of them afterwards — and the LAST resolution is
// always the authoritative one, because the Scope those rounds resolve against
// is one object that only ever grows. Keying by Position would say the same
// thing less exactly; keying by node also collapses the repeats, so the index
// stays one entry per annotation rather than one per round.
let activeAnnotations: Map<
	parser.TypeDeclarationNode,
	{ type: common.Type; modulePath: string | null }
> | null = null

// NOTE: The Scope is only consulted when a collector is open — the walk to its
// Module path is not free, and a compile records nothing.
export function recordAnnotation(
	node: parser.TypeDeclarationNode,
	type: common.Type,
	scope: enricher.Scope,
): void {
	if (activeAnnotations === null) {
		return
	}

	activeAnnotations.set(node, { type, modulePath: modulePathOf(scope) })
}

// NOTE: Opened ONCE, around a whole enrichment — NOT per speculative round the
// way `collectDiagnostics` is, and that is not a matter of taste. A hoisted
// Type Alias, Choice, Protocol or Namespace target is never re-resolved
// afterwards (`enrichStatement` reuses the hoisted Type), so its annotations
// exist ONLY inside a speculation. Scoping the collector to a round would
// discard precisely those, and the index would answer for almost nothing.
// NOTE: `modulePath` filters the collection to the annotations recorded while
// enriching ONE Module — a group of Modules hoists every file's declarations
// interleaved, so a collector spanning the group holds every file's
// annotations, at Positions that mean nothing outside their own file. The
// standard library's lazy load records under no Module path at all and is
// filtered away by the same comparison.
export function collectAnnotations<T>(
	work: () => T,
	options: { modulePath?: string | null } = {},
): {
	result: T
	annotations: Array<common.TypeAnnotation>
} {
	let previousAnnotations = activeAnnotations
	activeAnnotations = new Map()

	try {
		let result = work()

		return {
			result,
			annotations: [...activeAnnotations]
				.filter(
					([, entry]) =>
						options.modulePath === undefined ||
						entry.modulePath === options.modulePath,
				)
				.map(([node, entry]) => ({
					position: node.position,
					type: entry.type,
				})),
		}
	} finally {
		activeAnnotations = previousAnnotations
	}
}
