import type { common, enricher, parser } from "@essence-lang/interfaces"

import { modulePathOf } from "./scope"

// The Types written in a source, paired with what each resolved to. Only the
// language server reads them, so this is `null` while nobody collects. Hoisting
// resolves an annotation once per round and enrichment again; keyed by the
// parser Node, the last resolution wins and the repeats collapse.
let activeAnnotations: Map<
	parser.TypeDeclarationNode,
	{ type: common.Type; modulePath: string | null }
> | null = null

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

// Opened around a whole enrichment, not per hoisting round. A hoisted Type
// Alias, Choice, Protocol or Namespace target is not resolved again, so its
// annotations exist only inside a round. `modulePath` keeps one Module's
// annotations, since a group hoists its files interleaved. The standard
// library records under no Module path.
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
