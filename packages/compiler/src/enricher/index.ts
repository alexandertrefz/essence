// The enricher resolves and types a parsed Program. `./enrich` drives the
// walkers in `./enrichers` and `./resolvers`.
export {
	enrich,
	type EnrichedProgramInput,
	enrichPrograms,
	type EnrichProgramsOptions,
	enrichTestsSection,
	type ShadowedBuiltins,
	topLevelScope,
	type TopLevelScopeOptions,
} from "./enrich"
export type { LateNames } from "./turns"
