import type { parser } from "@essence-lang/interfaces"

// NOTE: A Namespace member is one of six things — a Method, a static Method, an
// `overload` block of either, and, in a `declarations { … }` Program, a
// body-less native signature or a block mixing the two. Every walker that
// descends into a Namespace has to take that apart, and five of them had done it
// inline: one silently left the native signatures out, which is how a `= …`
// default written on a native stayed invisible to Semantic Tokens and to the
// rename index.
//
// So the split is written once. `methodsOf` answers with what has a BODY to walk
// and `nativeSignaturesOf` with what has only a signature — together they cover
// every entry of every member, and neither ever answers with the same Node.

export function methodsOf(
	member: parser.NamespaceMethods[string],
): Array<parser.FunctionValueNode> {
	if (
		member.nodeType === "SimpleMethod" ||
		member.nodeType === "StaticMethod"
	) {
		return [member.method]
	}

	if (
		member.nodeType === "OverloadedMethod" ||
		member.nodeType === "OverloadedStaticMethod"
	) {
		return member.methods
	}

	if (
		member.nodeType === "OverloadedMethodSignatures" ||
		member.nodeType === "OverloadedStaticMethodSignatures"
	) {
		return member.methods.filter(
			(entry): entry is parser.FunctionValueNode =>
				entry.nodeType === "FunctionValue",
		)
	}

	return []
}

// NOTE: A body-less native signature has no Function definition to walk, but it
// still WRITES Type names (`Boolean`, `List<Item>`, `Ordering`), Parameter names
// and — the one part of it that is Essence rather than a promise about the
// runtime — a Parameter's `= expression` default.
export function nativeSignaturesOf(
	member: parser.NamespaceMethods[string],
): Array<parser.NativeMethodSignatureNode> {
	if (
		member.nodeType === "SimpleMethodSignature" ||
		member.nodeType === "StaticMethodSignature"
	) {
		return [member.signature]
	}

	if (
		member.nodeType === "OverloadedMethodSignatures" ||
		member.nodeType === "OverloadedStaticMethodSignatures"
	) {
		return member.methods.filter(
			(entry): entry is parser.NativeMethodSignatureNode =>
				entry.nodeType === "NativeMethodSignature",
		)
	}

	return []
}
