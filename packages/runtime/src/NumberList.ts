// NOTE: The runtime module of the `NumberList` Namespace — the aggregates a
// mixed List of Numbers answers. Every Method of it is written in Essence
// (`packages/standard-library/sources/NumberList.es`), delegating to a `Number`
// static, so there is nothing native here. The module stays because the
// Rewriter imports one per builtin Namespace by name, exactly as
// `NestedOptional.ts` does.
export {}
