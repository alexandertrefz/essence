import type { enricher, parser } from "@essence-lang/interfaces"

import { primary, reportError, secondary } from "../diagnostics/index"

// Called where a `constant` Declaration binds a name, so a refused assignment
// to it can offer the `variable` keyword.
export function recordWrittenConstant(
	name: string,
	scope: enricher.Scope,
): void {
	scope.writtenConstants ??= new Set()
	scope.writtenConstants.add(name)
}

// An assignment to a name `declaringScope` holds as a Constant. Only a name a
// `constant` Declaration wrote can be declared with `variable` instead. A
// Function, a Namespace, a Parameter or an import takes the new value under a
// name of its own, and the answer says so.
export function reportConstantReassignment(
	name: parser.IdentifierNode,
	declaringScope: enricher.Scope,
): boolean {
	let declarationPosition = declaringScope.declarations[name.content] ?? null
	let written = declaringScope.writtenConstants?.has(name.content) === true
	let isNamespace = declaringScope.members[name.content]?.type === "Namespace"

	reportError(`'${name.content}' can not be reassigned`, name.position, {
		code: "constant-reassignment",
		labels: [
			primary(name.position, "assigned to here"),
			...(declarationPosition === null
				? []
				: [
						secondary(
							declarationPosition,
							written
								? "declared as a Constant here"
								: "declared here",
						),
					]),
		],
		notes: written
			? []
			: [
					isNamespace
						? `'${name.content}' is a Namespace, which holds Methods and statics and is no value of its own.`
						: "Only a name declared with 'variable' can be given a new value.",
				],
		helps: [
			written
				? "Declare it with 'variable' instead of 'constant' if it needs to change."
				: "Declare the new value under a name of its own, with 'constant' or 'variable'.",
		],
	})

	return !written
}
