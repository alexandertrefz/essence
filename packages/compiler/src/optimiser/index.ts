import type { common } from "@essence-lang/interfaces"

import { collapseCombinations } from "./passes/collapseCombinations"
import { collapseConstruction } from "./passes/collapseConstruction"

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
	run: (program: common.typedSimple.Program) => common.typedSimple.Program
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

// NOTE: THE canonical order. It is fixed: a pass added by a later work package
// is INSERTED where it belongs rather than appended, because what a pass finds
// in front of it is part of what it was written against. Turning one off never
// reorders the rest.
export const optimiserPasses: ReadonlyArray<OptimiserPass> = [
	collapseConstruction,
	collapseCombinations,
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

export function optimise(
	program: common.typedSimple.Program,
	options: OptimiserOptions = defaultOptimiserOptions,
): common.typedSimple.Program {
	if (!options.enabled) {
		return program
	}

	let result = program

	for (let pass of optimiserPasses) {
		if (options.disabledPasses.has(pass.name)) {
			continue
		}

		result = pass.run(result)
	}

	return result
}
