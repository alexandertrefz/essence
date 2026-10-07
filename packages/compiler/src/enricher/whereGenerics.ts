import type { parser } from "@essence-lang/interfaces"

import { primary, reportError } from "../diagnostics/index"
import { findParserChild, type ParserNode } from "../visitor/index"

// A `where` condition naming no Type Parameter of its Namespace. Declaring the
// name compiles only where the target Type names it, since the target is all
// that proves a condition at a use site.
export function reportUnknownWhereGeneric(
	condition: parser.WhereConditionNode,
	target: parser.TypeDeclarationNode | null,
): void {
	let name = condition.generic.content
	let named = target !== null && namesType(target, name)

	reportError(
		`'${name}' is not a Type Parameter of this Namespace`,
		condition.generic.position,
		{
			code: "unknown-where-generic",
			labels: [
				primary(condition.generic.position, "no such Type Parameter"),
			],
			notes: named
				? []
				: [
						`The target Type never names '${name}', so a Type Parameter of that name would have nothing to prove the condition with.`,
					],
			helps: [
				named
					? `Declare it in the Namespace's Generic list: '<infer ${name}>'.`
					: "Drop this condition.",
			],
			// The name as the condition wrote it, for the Quick Fix that
			// declares it.
			...(named ? { data: { kind: "undeclared-parameter", name } } : {}),
		},
	)
}

function namesType(target: parser.TypeDeclarationNode, name: string): boolean {
	let names = (node: ParserNode): true | undefined =>
		(node.nodeType === "IdentifierTypeDeclaration" &&
			node.type.content === name) ||
		findParserChild(node, names)
			? true
			: undefined

	return names(target) === true
}
