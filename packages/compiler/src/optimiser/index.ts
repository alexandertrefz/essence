import type { common } from "@essence-lang/interfaces"

import { eraseRefinements } from "../helpers/eraseRefinements"
import { type DeclaredNamespaces, declaredNamespaces } from "./namespaces"
import { collapseCombinations } from "./passes/collapseCombinations"
import { collapseConstruction } from "./passes/collapseConstruction"
import { compileTypeTests } from "./passes/compileTypeTests"
import { compileUnionDispatch } from "./passes/compileUnionDispatch"
import { devirtualiseWitnesses } from "./passes/devirtualiseWitnesses"
import { elideFinalMatchTest } from "./passes/elideFinalMatchTest"
import { eliminateDeadCode } from "./passes/eliminateDeadCode"
import { foldConstants } from "./passes/foldConstants"
import { inlineLoops } from "./passes/inlineLoops"
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
	run: (
		program: common.typedSimple.Program,
		namespaces: DeclaredNamespaces,
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
	compileTypeTests,
	lowerUnitCaseEquality,
	lowerScalarOperations,
	compileUnionDispatch,
	devirtualiseWitnesses,
	lowerMatchesToStatements,
	inlineLoops,
	foldConstants,
	pruneDeadMatchArms,
	elideFinalMatchTest,
	eliminateDeadCode,
	collapseConstruction,
	collapseCombinations,
	poolConstants,
]

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
	if (!options.enabled) {
		return "off"
	}

	return `on:${[...options.disabledPasses].sort().join(",")}`
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

	if (!options.enabled) {
		return erased
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

		result = pass.run(result, namespaces)
	}

	return result
}
