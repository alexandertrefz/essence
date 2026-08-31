// NOTE: The Enricher resolves and types a parsed Program. This barrel is the
// phase's name; `./enrich` is the driver, and the walkers it drives live beside
// it in `./enrichers` and `./resolvers`.
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
