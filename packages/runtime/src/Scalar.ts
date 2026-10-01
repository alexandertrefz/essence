import type { IntegerType } from "./Integer"
import type { RationalType } from "./Rational"

// The `Scalar` Namespace, written in Essence in `Number.es`. A Scalar is an
// Integer or a Rational and carries that Type's tag. See "Namespace modules"
// in DEVELOPMENT.md.
export type ScalarType = IntegerType | RationalType
