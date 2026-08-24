import type { common } from "@essence-lang/interfaces"

import { eraseRefinements } from "../helpers/eraseRefinements"
import { type DeclaredNamespaces, declaredNamespaces } from "./namespaces"
import { buildListsInPlace } from "./passes/buildListsInPlace"
import { collapseCombinations } from "./passes/collapseCombinations"
import { collapseConstruction } from "./passes/collapseConstruction"
import { compileRecordMembers } from "./passes/compileRecordMembers"
import { compileTypeTests } from "./passes/compileTypeTests"
import { compileUnionDispatch } from "./passes/compileUnionDispatch"
import { devirtualiseWitnesses } from "./passes/devirtualiseWitnesses"
import { elideFinalMatchTest } from "./passes/elideFinalMatchTest"
import { eliminateDeadCode } from "./passes/eliminateDeadCode"
import { foldConstants } from "./passes/foldConstants"
import { inlineLoops } from "./passes/inlineLoops"
import { instrumentCoverage } from "./passes/instrumentCoverage"
import { lowerMatchesToStatements } from "./passes/lowerMatchesToStatements"
import { lowerScalarOperations } from "./passes/lowerScalarOperations"
import { lowerUnitCaseEquality } from "./passes/lowerUnitCaseEquality"
import { poolConstants } from "./passes/poolConstants"
import { pruneDeadMatchArms } from "./passes/pruneDeadMatchArms"

// NOTE: The Optimiser is a registry of NAMED passes, run in one fixed order.
// Every transform the Compiler performs on a simplified Program is one of them,
// each is documented in `packages/website/optimisations.md` under the name it
// is registered with, and each can be turned off on its own from the command
// line. Nothing here is a hidden rewrite: a Program that behaves differently
// with a pass off than with it on is a bug in that pass, and the name is what
// lets a reader say which one.
//
// NOTE: A pass may NOT assume another pass ran. Any subset of the registry has
// to produce a correct Program, which is what makes turning one off a
// diagnosis rather than a gamble — so passes cooperate (one leaves a shape the
// next can do more with) but never depend.
//
// NOTE: Every pass is a pure function of its input. The standard library's
// simplified Programs are a process-wide value the prelude cache hands out
// again and again, and a pass that wrote into one would change what a LATER
// compilation in the same process reads.

export type OptimiserPass = {
	// NOTE: Kebab-case, and the same string in three places: the registry, the
	// `--without-optimisation` flag, and the documentation's heading. The gate
	// in `packages/website/tests/optimisationPasses.spec.ts` is what keeps the
	// last of those true.
	name: string
	// NOTE: The Namespaces the Program declares are HANDED to a pass rather
	// than looked up by it. Seven passes need them, the walk that answers
	// reaches every object the Program holds — Types included — and seven of
	// those walks was half of this phase on a large file.
	//
	// NOTE: One answer serves the whole registry because no pass can change it:
	// nothing here builds a `NamespaceDefinitionStatement`, the Simplifier is
	// the only thing that does, and `eliminate-dead-code` — the one pass that
	// removes a Statement at all — removes Constants. So the set is a property
	// of the Program the PHASE was given, not of the Program a pass was given,
	// and a pass added later that declares a Namespace has to compute its own.
	//
	// NOTE: Handed in rather than memoised behind `declaredNamespaces`, because
	// a memo keyed on Program identity would never hit: a pass rebuilds the
	// Program whenever it changes anything, and measured on the fixtures every
	// one of the seven is preceded by a pass that did.
	//
	// NOTE: The Options the phase is running under, so that a pass the caller
	// ASKED for can tell it was asked. Only `instrument-coverage` reads them —
	// everything else here is a transform that is right whenever it is right —
	// and a pass that ignores the parameter simply does not declare it.
	run: (
		program: common.typedSimple.Program,
		namespaces: DeclaredNamespaces,
		options: OptimiserOptions,
	) => common.typedSimple.Program
}

export type OptimiserOptions = {
	// NOTE: The whole phase, off — `--no-optimise`, and what a debug session
	// will build with once the Debug Adapter compiles through here, so that
	// what is stepped through is the Program as it was written.
	enabled: boolean
	// NOTE: The passes to skip, by registered name. An unknown name is refused
	// by the command line rather than ignored here: a misspelt pass that
	// silently stayed on would look exactly like a pass that does not do what
	// its name says.
	disabledPasses: ReadonlySet<string>
	// NOTE: Whether to INSTRUMENT — `essence test --coverage`, and nothing
	// else. It is an opt-in rather than a pass that is on by default, because
	// it is the one entry in the registry that makes a Program do more work
	// rather than less, and because a Program that counts what it ran is not
	// the Program its author wrote.
	//
	// NOTE: It is part of `optimiserOptionsKey`, so no cache keyed on the
	// Options can hand an instrumented bundle to a build or a plain bundle to
	// a coverage run.
	coverage?: boolean
}

// NOTE: Everything on. What `optimise(program)` means with no Options given,
// and what every caller that does not offer the user a say compiles with.
export const defaultOptimiserOptions: OptimiserOptions = {
	enabled: true,
	disabledPasses: new Set(),
}

// NOTE: Everything off — the Program as written. `--no-optimise` is this, and so
// is what `essence dap` compiles a debug session with: what a debugger steps
// through has to be the Program its author wrote, with the Statements in the
// order they were written, every Constant still bound to its name, and every
// Match Handler still tested. Half of the registry exists to take exactly those
// things away.
export const unoptimisedOptions: OptimiserOptions = {
	enabled: false,
	disabledPasses: new Set(),
}

// NOTE: THE canonical order. It is fixed: a pass added by a later work package
// is INSERTED where it belongs rather than appended, because what a pass finds
// in front of it is part of what it was written against. Turning one off never
// reorders the rest.
export const optimiserPasses: ReadonlyArray<OptimiserPass> = [
	// NOTE: First, and it has to be: a counter written before anything else has
	// moved stands where the AUTHOR wrote the code it counts. See the head of
	// `passes/instrumentCoverage.ts`.
	instrumentCoverage,
	compileTypeTests,
	lowerUnitCaseEquality,
	lowerScalarOperations,
	compileUnionDispatch,
	devirtualiseWitnesses,
	lowerMatchesToStatements,
	inlineLoops,
	buildListsInPlace,
	foldConstants,
	pruneDeadMatchArms,
	elideFinalMatchTest,
	compileRecordMembers,
	eliminateDeadCode,
	collapseConstruction,
	collapseCombinations,
	poolConstants,
]

// NOTE: What a pass that does not read them is handed on the path where nobody
// computed them — see `optimise`. Answering the question costs a deep walk of
// everything a Program holds, and the one pass that runs with the phase off
// does not ask it.
const emptyNamespaces: DeclaredNamespaces = {
	all: new Set(),
	nested: new Set(),
}

// NOTE: The instrumentation pass by NAME, spelled once, for the caller that has
// to refuse being asked to turn it off. `essence test --mutate` reads the
// counters this pass writes to learn which tests reach which site, so a run that
// disabled it would report every site in the project as one no test reaches —
// see the refusal in `mutate.ts`.
export const coveragePassName: string = instrumentCoverage.name

export const optimiserPassNames: ReadonlyArray<string> = optimiserPasses.map(
	(pass) => pass.name,
)

export function isOptimiserPassName(name: string): boolean {
	return optimiserPassNames.includes(name)
}

// NOTE: One spelling of a set of Options, for the caches that must not answer
// for the Options they were filled under. The standard library's prelude is
// optimised once per process and shared by every file compiled in it, so a
// second compilation with a pass turned off has to build its own — and this key
// is what tells the two apart. Sorted, so that one set of names spells one key
// however the command line ordered them.
export function optimiserOptionsKey(options: OptimiserOptions): string {
	// NOTE: Coverage is spelled on BOTH sides of the `enabled` check, because
	// it is not an optimisation: `--no-optimise --coverage` still instruments,
	// and the bytes it produces are not the bytes `--no-optimise` alone does.
	//
	// NOTE: And it is spelled as what WILL HAPPEN rather than as what was
	// asked for. With the phase off, the disabled names decide nothing else —
	// so `off` says nothing about them — but they still decide whether the
	// instrumentation runs, and two compiles that emit different bytes may not
	// share a key.
	let instrumenting =
		options.coverage === true &&
		!options.disabledPasses.has(instrumentCoverage.name)

	if (!options.enabled) {
		return instrumenting ? "off+coverage" : "off"
	}

	return `on${instrumenting ? "+coverage" : ""}:${[...options.disabledPasses]
		.sort()
		.join(",")}`
}

// NOTE: The same Options with the instrumentation taken out — what the standard
// library's prelude is built under. A report about a project is a report about
// the project's own files, and instrumenting the library into every bundle
// would cost more than the answer is worth. It is a function rather than a
// second Options object so the caller can not forget the rest of what it was
// given.
export function withoutCoverage(options: OptimiserOptions): OptimiserOptions {
	return options.coverage === true ? { ...options, coverage: false } : options
}

// NOTE: The one transform this stage performs that is NOT a pass, and it runs
// before the `enabled` check rather than in the registry: erasing checked
// refinements is what makes the Program emittable at all, not something it is
// better for. `--no-optimise` compiles the Program as it was written, and a
// Program as it was written still has no run-time notion of a predicate — so
// there is no name to turn this off under, and the registry, whose every entry
// IS such a name, is the wrong place for it. The Rewriter refuses a refinement
// outright, which is what keeps the two halves of that claim together.
//
// NOTE: The stage is where it goes because the stage is wired into every
// pipeline there is — the Compiler's, the standard library prelude's, the
// Language Server's — and a Program only reaches emission through one of them.
export function optimise(
	program: common.typedSimple.Program,
	options: OptimiserOptions = defaultOptimiserOptions,
): common.typedSimple.Program {
	let erased = eraseRefinements(program)

	// NOTE: `--no-optimise` says "do not improve my Program". It does not say
	// "ignore what I asked you to measure" — a coverage run that answered with
	// an empty report because the Optimiser was off would be a silent one. So
	// the instrumentation still runs, and it is still the named pass, so
	// `--without-optimisation instrument-coverage` still turns it off.
	//
	// NOTE: And the Namespaces are NOT computed on this path. Answering costs a
	// deep walk of everything the Program holds, Types included, and the one
	// pass that runs here does not read them — `esc dap` compiles every debug
	// session this way.
	if (!options.enabled) {
		return options.coverage === true &&
			!options.disabledPasses.has(instrumentCoverage.name)
			? instrumentCoverage.run(erased, emptyNamespaces, options)
			: erased
	}

	let result = erased
	// NOTE: Asked of the erased Program, which is what the first pass is given
	// — and, by the argument on `OptimiserPass.run`, what every pass after it
	// would answer for itself.
	let namespaces = declaredNamespaces(erased)

	for (let pass of optimiserPasses) {
		if (options.disabledPasses.has(pass.name)) {
			continue
		}

		result = pass.run(result, namespaces, options)
	}

	return result
}
