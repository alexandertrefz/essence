import type { parser } from "@essence-lang/interfaces"

// A Namespace member is a Method, a static Method or an `overload` block of
// either. A `declarations` Program adds native signatures and blocks mixing
// both. `methodsOf` answers the bodies, `nativeSignaturesOf` the signatures.

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

// A native signature has no body, but writes Type names, Parameter names and
// Parameter defaults.
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
