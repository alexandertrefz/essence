// NOTE: The runtime module of the `IntegerList` Namespace — the aggregates a
// List of Integers answers. Every Method of it is written in Essence
// (`packages/standard-library/sources/NumberList.es`), delegating to a `Number`
// static, so there is nothing native here. The module stays because the
// Rewriter imports one per builtin Namespace by name, exactly as
// `NestedOptional.ts` does.
export {}
