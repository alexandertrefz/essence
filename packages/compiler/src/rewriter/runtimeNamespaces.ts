// NOTE: The builtin Namespaces that have a runtime module in
// `@essence-lang/runtime`, in the order their imports are emitted. Every one is
// imported unconditionally by a lone Program, under its own name, and a
// Namespace no Program references costs nothing — esbuild shakes an unused
// `import * as <Name>` away entirely. A Method the standard library implements
// in Essence is NOT a member of one of these; it is its own
// `$es_<Namespace>_<member>` const, emitted alongside. The tests cross-check
// this list against the other registration sites — a Namespace here but missing
// a runtime module, or declared in `packages/standard-library/sources` but missing here,
// emits a call to `undefined`.
//
// NOTE: A file of its own, rather than a const in the Rewriter that owns it,
// because the Optimiser asks the same question and asking it through
// `rewriter/index` would close a cycle: the Rewriter reads the standard library
// prelude, the prelude is optimised, and the Optimiser would read the Rewriter.
// Nothing is imported here, so nothing can.
export const runtimeNamespaceNames = [
	"Terminal",
	"String",
	"Integer",
	"NonZeroInteger",
	"Rational",
	"Algebraic",
	"Transcendental",
	"Number",
	"Boolean",
	"Optional",
	"NestedOptional",
	"Ordering",
	"Side",
	"Case",
	"NormalizationForm",
	"NumberFormat",
	"Rounding",
	"Record",
	"List",
	"NestedList",
	"NonEmptyList",
]
