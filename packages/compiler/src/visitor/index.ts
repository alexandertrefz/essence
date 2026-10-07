// The `@essence-lang/compiler/visitor` subpath: one child table per tree, so
// every walk sees the same children. See "The child tables" in DEVELOPMENT.md.

export { findParserChild, forEachParserChild, type ParserNode } from "./parser"
export type { ContainerOf, FieldOf, FieldsHolding } from "./table"
export { findTypedChild, forEachTypedChild, type TypedNode } from "./typed"
export {
	findSimpleChild,
	forEachSimpleChild,
	type SimpleNode,
} from "./typedSimple"
