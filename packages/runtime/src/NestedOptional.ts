// NOTE: The runtime module of the `NestedOptional` Namespace — an Optional
// whose payload is itself an Optional. Its one Method, `flatten`, is written in
// Essence (`packages/standard-library/sources/Optional.es`), so there is nothing native
// here; the module stays because the Rewriter imports one per builtin Namespace
// by name, exactly as `Optional.ts` did before this Choice existed.
export {}
