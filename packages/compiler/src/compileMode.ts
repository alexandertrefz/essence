// NOTE: The compile MODE — what a run asked to be enriched out of the sources
// beyond the implementation every compile reads. It is one fact about a whole
// invocation rather than about a file: `esc` opens one Session in it, links
// every component of the graph under it, and names every bundle it emits by it.
//
// NOTE: It lives HERE, in a leaf of its own, because everything that reads the
// mode is downstream of it and nothing it could have shared a file with is.
// `documents.ts` and `modules/link.ts` both hand it on, and both import the
// Enricher — which is where the mode is finally READ — so declaring it in
// either would have the Enricher importing back up through the seam that calls
// it. A leaf costs nothing and can be imported from anywhere.

// NOTE: The facets, in the order a key spells them. Everything below is derived
// from this array, which is the whole point of the file: a facet added here
// joins the type, joins `modeOf`, joins `completeMode` and joins BOTH cache
// keys at once. Before this existed the pair was re-declared inline at ten
// seams and maintained by hand in two hash compositions, and a facet could
// perfectly well join the mode without joining either.
const MODE_FACETS = [
	// NOTE: Whether this compile ASKED for the tests — `essence test`, `esc
	// check` and the Editor's test session do, and nothing else. A build and a
	// run leave every `tests { … }` block in the graph parsed and unenriched,
	// which is the whole of what "a test costs a shipped Program nothing"
	// means: the Program that comes out has never heard of it.
	"tests",
	// NOTE: And whether it asked for the goals a Module's own Namespace
	// declarations promise, synthesized as property tests and reported beside
	// the written ones. `essence test --contracts` and the
	// `essence.test.contracts` setting are what ask; it means nothing without
	// `tests`, which is the mode the section it is appended to exists in at all.
	"contracts",
] as const

export type CompileModeFacet = (typeof MODE_FACETS)[number]

export type CompileMode = { [Facet in CompileModeFacet]?: boolean }

// NOTE: The mode ALONE, out of whatever is carrying it. A `CompileRequest` and
// a `LinkOptions` ARE modes — they say `tests` and `contracts` and a great deal
// else — so a seam handing one on to something that takes more than the mode
// has to hand over the mode rather than itself.
export function modeOf(mode: CompileMode): CompileMode {
	let picked: CompileMode = {}

	for (let facet of MODE_FACETS) {
		picked[facet] = mode[facet]
	}

	return picked
}

// NOTE: Every facet answered, because one seam wants no unanswered ones: a
// worker's `begin` REQUIRES them, so that a second caller can not open a worker
// as a build and compile every file of a test run without the section the run
// exists to check. See `WorkerRequest`.
export function completeMode(mode: CompileMode = {}): Required<CompileMode> {
	let complete = {} as Required<CompileMode>

	for (let facet of MODE_FACETS) {
		complete[facet] = mode[facet] === true
	}

	return complete
}

// NOTE: What the mode contributes to a name that means "these exact bytes". A
// test compile enriches a section a build drops, and a contract compile
// synthesizes a suite that is not in the file at all — out of sources that are
// byte for byte the same, so the graph's own hash can not tell any of them
// apart and this is what does. Without it `essence test` would be handed the
// bundle `essence build` wrote, and a plain run the one the contract run wrote.
//
// NOTE: Empty where nothing was asked for, and the emptiness is load-bearing:
// every key spelled before there was a mode to name still names the same bytes,
// so an ordinary build's cache survived the day this joined the key.
export function modeKey(mode: CompileMode): string {
	return MODE_FACETS.filter((facet) => mode[facet] === true).join("|")
}
