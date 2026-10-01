import {
	enrichDocument as enrichDocumentUncounted,
	parseDocument as parseDocumentUncounted,
} from "@essence-lang/compiler/documents"
import {
	linkModuleAgainst as linkModuleAgainstUncounted,
	linkModuleGraph as linkModuleGraphUncounted,
	loadModuleGraph as loadModuleGraphUncounted,
} from "@essence-lang/compiler/modules"

// Every Compiler entry point the Server runs goes through here, counted. A
// spec asserts how many compiles a typing burst and a Hover cost, proving the
// cache works. The counters are always on, so the shipped Server is measurable.
export const compilationCounts = {
	// Text to a Parser AST. A graph's parses happen inside the Compiler and are
	// not counted.
	parses: 0,
	// A Parser AST to a typed Program, for one document: a file writing neither
	// Module section, or a probe, which links against dependencies already linked.
	enrichments: 0,
	// A Module graph read and parsed, entry included.
	graphs: 0,
	// One graph-wide enrichment, which type-checks every Module the entry reaches.
	links: 0,
}

export function resetCompilationCounts(): void {
	compilationCounts.parses = 0
	compilationCounts.enrichments = 0
	compilationCounts.graphs = 0
	compilationCounts.links = 0
}

export const parseDocument: typeof parseDocumentUncounted = (
	source,
	documentPath,
) => {
	compilationCounts.parses += 1

	return parseDocumentUncounted(source, documentPath)
}

export const enrichDocument: typeof enrichDocumentUncounted = (
	program,
	documentPath,
	options,
) => {
	compilationCounts.enrichments += 1

	return enrichDocumentUncounted(program, documentPath, options)
}

export const loadModuleGraph: typeof loadModuleGraphUncounted = (
	entryPath,
	host,
) => {
	compilationCounts.graphs += 1

	return loadModuleGraphUncounted(entryPath, host)
}

export const linkModuleAgainst: typeof linkModuleAgainstUncounted = (
	module,
	context,
	options,
) => {
	compilationCounts.enrichments += 1

	return linkModuleAgainstUncounted(module, context, options)
}

export const linkModuleGraph: typeof linkModuleGraphUncounted = (
	graph,
	options,
) => {
	compilationCounts.links += 1

	return linkModuleGraphUncounted(graph, options)
}
