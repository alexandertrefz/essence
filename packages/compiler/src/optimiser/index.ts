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
import { loopSelfTailCalls } from "./passes/loopSelfTailCalls"
import { lowerMatchesToStatements } from "./passes/lowerMatchesToStatements"
import { lowerScalarOperations } from "./passes/lowerScalarOperations"
import { lowerUnitCaseEquality } from "./passes/lowerUnitCaseEquality"
import { poolConstants } from "./passes/poolConstants"
import { pruneDeadMatchArms } from "./passes/pruneDeadMatchArms"
import { unboxConditions } from "./passes/unboxConditions"

// A registry of named passes, run in one fixed order. No pass may assume
// another ran, and none may write into its input. See "The pass registry" in
// DEVELOPMENT.md.

export type OptimiserPass = {
	// Kebab-case, and the flag's and the documentation's name too.
	name: string
	// The Namespaces are computed once per phase and handed in. See "What a
	// pass is handed" in DEVELOPMENT.md.
	run: (
		program: common.typedSimple.Program,
		namespaces: DeclaredNamespaces,
		options: OptimiserOptions,
	) => common.typedSimple.Program
}

export type OptimiserOptions = {
	// False for `--no-optimise`.
	enabled: boolean
	// The passes to skip, by name. The command line refuses an unknown one.
	disabledPasses: ReadonlySet<string>
	// Whether to instrument for `essence test --coverage`. See "Options" in
	// DEVELOPMENT.md.
	coverage?: boolean
}

// Every pass on, for a caller that offers the user no say.
export const defaultOptimiserOptions: OptimiserOptions = {
	enabled: true,
	disabledPasses: new Set(),
}

// The Program as written, which `essence dap` steps through.
export const unoptimisedOptions: OptimiserOptions = {
	enabled: false,
	disabledPasses: new Set(),
}

// The canonical order. See "The pass registry" in DEVELOPMENT.md.
export const optimiserPasses: ReadonlyArray<OptimiserPass> = [
	// First, so a counter stands where the author wrote what it counts.
	instrumentCoverage,
	compileTypeTests,
	lowerUnitCaseEquality,
	lowerScalarOperations,
	compileUnionDispatch,
	devirtualiseWitnesses,
	lowerMatchesToStatements,
	// After every pass that builds an `essence-boolean`.
	unboxConditions,
	inlineLoops,
	buildListsInPlace,
	foldConstants,
	pruneDeadMatchArms,
	elideFinalMatchTest,
	compileRecordMembers,
	// After every pass that shapes a Match, and before the pool and the
	// collapses.
	loopSelfTailCalls,
	eliminateDeadCode,
	collapseConstruction,
	collapseCombinations,
	poolConstants,
]

// Handed to `instrument-coverage` with the phase off, which does not read it.
const emptyNamespaces: DeclaredNamespaces = {
	all: new Set(),
	nested: new Set(),
}

// For `essence test --mutate`, which refuses to run with this pass off.
export const coveragePassName: string = instrumentCoverage.name

export const optimiserPassNames: ReadonlyArray<string> = optimiserPasses.map(
	(pass) => pass.name,
)

export function isOptimiserPassName(name: string): boolean {
	return optimiserPassNames.includes(name)
}

// One spelling of a set of options, for caches such as the prelude's. The
// names are sorted, so their order on the command line does not matter.
export function optimiserOptionsKey(options: OptimiserOptions): string {
	// Whether instrumentation will run, on both sides of `enabled`.
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

// The options the prelude is built under, since a coverage report is about
// the project's own files.
export function withoutCoverage(options: OptimiserOptions): OptimiserOptions {
	return options.coverage === true ? { ...options, coverage: false } : options
}

// Erases refinements first, which is not a pass, then runs the registry. See
// "Erasing refinements" in DEVELOPMENT.md.
export function optimise(
	program: common.typedSimple.Program,
	options: OptimiserOptions = defaultOptimiserOptions,
): common.typedSimple.Program {
	let erased = eraseRefinements(program)

	// Instrumentation still runs with the phase off, and needs no Namespaces.
	if (!options.enabled) {
		return options.coverage === true &&
			!options.disabledPasses.has(instrumentCoverage.name)
			? instrumentCoverage.run(erased, emptyNamespaces, options)
			: erased
	}

	let result = erased
	// Asked once, of the erased Program the first pass is given.
	let namespaces = declaredNamespaces(erased)

	for (let pass of optimiserPasses) {
		if (options.disabledPasses.has(pass.name)) {
			continue
		}

		result = pass.run(result, namespaces, options)
	}

	return result
}
