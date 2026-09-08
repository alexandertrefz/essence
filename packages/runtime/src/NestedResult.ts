// NOTE: The runtime module of the `NestedResult` Namespace — a Result whose
// value is itself a Result. Its one Method, `flatten`, is written in Essence
// (`packages/standard-library/sources/Result.es`), so there is nothing native
// here; the module stays because the Rewriter imports one per builtin Namespace
// by name, exactly as `NestedOptional.ts` does.
export {}
