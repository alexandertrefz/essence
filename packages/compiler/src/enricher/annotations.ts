import type { common, parser } from "@essence/interfaces"

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
let activeAnnotations: Map<parser.TypeDeclarationNode, common.Type> | null =
	null

export function recordAnnotation(
	node: parser.TypeDeclarationNode,
	type: common.Type,
): void {
	activeAnnotations?.set(node, type)
}

// NOTE: Opened ONCE, around a whole enrichment — NOT per speculative round the
// way `collectDiagnostics` is, and that is not a matter of taste. A hoisted
// Type Alias, Choice, Protocol or Namespace target is never re-resolved
// afterwards (`enrichStatement` reuses the hoisted Type), so its annotations
// exist ONLY inside a speculation. Scoping the collector to a round would
// discard precisely those, and the index would answer for almost nothing.
export function collectAnnotations<T>(work: () => T): {
	result: T
	annotations: Array<common.TypeAnnotation>
} {
	let previousAnnotations = activeAnnotations
	activeAnnotations = new Map()

	try {
		let result = work()

		return {
			result,
			annotations: [...activeAnnotations].map(([node, type]) => ({
				position: node.position,
				type,
			})),
		}
	} finally {
		activeAnnotations = previousAnnotations
	}
}
