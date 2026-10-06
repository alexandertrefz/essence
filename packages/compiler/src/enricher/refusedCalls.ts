import type { common, enricher, parser } from "@essence-lang/interfaces"

import { collectDiagnostics } from "../diagnostics/index"
import {
	namespacesDeclaringMethod,
	noteReachedName,
	resolveMethodLookupNamespacesForReceiverType,
} from "./resolvers"

// Whether the Arguments being enriched are those of a call that resolved to
// nothing. A Function literal or a member path passed to one has no Parameter
// Types to take. The call's own refusal is the one to report.
let callRefused = false

// Every call sets it for its own Arguments, and a Function literal's body
// clears it. What a nested call or a body holds then reports as anywhere else.
export function underRefusedCall<T>(refused: boolean, work: () => T): T {
	let outer = callRefused

	callRefused = refused

	try {
		return work()
	} finally {
		callRefused = outer
	}
}

export function insideRefusedCall(): boolean {
	return callRefused
}

// The position a refused call's Argument stands in, which no Case construction
// is decided by.
export function refusedPosition(): common.ErrorType | null {
	return callRefused ? { type: "Error" } : null
}

// A `::` call that resolved to no Method still reached the Namespaces that
// declare it, so the linker does not report their imports as unused. See
// "Unused imports" in packages/compiler/src/modules/DEVELOPMENT.md.
export function noteRefusedCallNamespaces(
	node: parser.MethodInvocationNode,
	baseType: common.Type,
	scope: enricher.Scope,
): void {
	let { result } = collectDiagnostics(() =>
		namespacesDeclaringMethod(
			node.member.content,
			resolveMethodLookupNamespacesForReceiverType(
				baseType,
				node.namespaceSpecifier,
				scope,
			),
			baseType,
			scope,
			node.position,
			node.namespaceSpecifier,
		),
	)

	for (let name of result.keys()) {
		noteReachedName(name)
	}
}
