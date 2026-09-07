import type { IntegerType } from "./Integer"
import type { RationalType } from "./Rational"

// NOTE: `Scalar` is the Union `Integer | Rational`, so it has no representation
// of its own — a Scalar value IS an Integer or a Rational, carrying that Type's
// own tag. Both Methods of its Namespace
// (`packages/standard-library/sources/Number.es`) are written in Essence, over
// the members' arithmetic, so this module holds no native: it is here because
// every builtin Namespace is imported under its own name, and the type below is
// what a native taking a Scalar would spell. `natives.generated.ts` renders an
// empty contract for it, exactly as it does for `Rounding`.
export type ScalarType = IntegerType | RationalType
