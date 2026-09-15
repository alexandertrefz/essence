// NOTE: `Started` is one RUN of a Future, and everything that builds, starts or
// waits for one lives in `Future.ts` — the two are one mechanism, and a run has
// no representation apart from the description it came from. This module is here
// because every builtin Namespace is imported under its own name, and the type
// below is what a native answering a Started would spell. `natives.generated.ts`
// renders an empty contract for it, exactly as it does for `Scalar`.
export type { StartedType } from "./Future"
