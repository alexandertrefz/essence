import {
	enrichDocument as enrichDocumentUncounted,
	parseDocument as parseDocumentUncounted,
} from "@essence-lang/compiler/documents"
import {
	linkModuleGraph as linkModuleGraphUncounted,
	loadModuleGraph as loadModuleGraphUncounted,
} from "@essence-lang/compiler/modules"

// NOTE: Every Compiler entry point this Server runs goes through here, and
// nowhere else imports them directly. The point is the counters: "how many
// times did answering this request compile something" is the only question
// that tells a cache that works from a cache that merely exists, and it can
// not be asked from outside the process. A test asserts the exact number for a
// typing burst followed by a Hover — that assertion is what stops a future
// request from quietly re-parsing the document it was handed.
//
// The counters are four integer increments on paths that each cost
// milliseconds, so they are not conditional on anything: a counter that is
// only kept in a test build is a counter the shipped Server can not be
// measured by.
export const compilationCounts = {
	// NOTE: Text to a Parser AST. The graph parses through its own code path
	// inside the Compiler, so a `loadModuleGraph` covers as many parses as the
	// graph has Modules and none of them are counted here.
	parses: 0,
	// NOTE: A Parser AST to a typed Program, for a document analysed on its
	// own — a file that writes neither Module section, or a probe.
	enrichments: 0,
	// NOTE: A Module graph read and parsed, entry included.
	graphs: 0,
	// NOTE: One graph-wide enrichment. This is the expensive one: it enriches
	// and Type-checks every Module the entry reaches.
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

export const linkModuleGraph: typeof linkModuleGraphUncounted = (
	graph,
	options,
) => {
	compilationCounts.links += 1

	return linkModuleGraphUncounted(graph, options)
}
