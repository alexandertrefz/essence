// NOTE: The runtime module of the `Response` Namespace — what a host answered
// with. Both of its Methods are written in Essence
// (`packages/standard-library/sources/Http.es`): one reads the status and one
// reads a header, and neither needs anything the Record does not hold. So there
// is nothing native here; the module stays because the Rewriter imports one per
// builtin Namespace by name, exactly as `NestedResult.ts` does.
export {}
