// The compile mode: what a whole run asks the enricher for beyond the
// implementation. It is a leaf module, so the enricher that reads it and the
// callers that hand it on all import it without a cycle.

// The facets, in the order a key spells them. The type, `modeOf`,
// `completeMode` and `modeKey` all derive from this array.
const MODE_FACETS = [
	// Whether the run enriches `tests { … }` blocks. A build and a run parse
	// them and drop them.
	"tests",
	// Whether the run also synthesizes the goals a Module's Namespace
	// declarations promise as property tests. It means nothing without `tests`.
	"contracts",
	// Whether the run binds onto each exported Namespace the provided Methods
	// its Protocols give it, so a JavaScript host can call them there.
	"embed",
] as const

type CompileModeFacet = (typeof MODE_FACETS)[number]

export type CompileMode = { [Facet in CompileModeFacet]?: boolean }

// The mode alone, out of a `CompileRequest` or `LinkOptions` that carries
// much else.
export function modeOf(mode: CompileMode): CompileMode {
	let picked: CompileMode = {}

	for (let facet of MODE_FACETS) {
		picked[facet] = mode[facet]
	}

	return picked
}

// Every facet answered, as a worker's `begin` requires, so that no worker
// compiles a test run as a build. See `WorkerRequest`.
export function completeMode(mode: CompileMode = {}): Required<CompileMode> {
	let complete = {} as Required<CompileMode>

	for (let facet of MODE_FACETS) {
		complete[facet] = mode[facet] === true
	}

	return complete
}

// The mode's part of a bundle's cache key. Each mode compiles the same sources
// to different bytes, so `essence test` never gets the bundle `essence build`
// wrote. Empty when nothing was asked for.
export function modeKey(mode: CompileMode): string {
	return MODE_FACETS.filter((facet) => mode[facet] === true).join("|")
}
