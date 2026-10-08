import type { parser } from "@essence-lang/interfaces"

import { primary, reportError } from "../diagnostics/index"
import { closestMatch } from "../helpers/suggest"
import { findParserChild, type ParserNode } from "../visitor/index"

// A `where` condition naming no Type Parameter of its Namespace. Declaring the
// name compiles only where the target Type names it, since the target is all
// that proves a condition at a use site. Otherwise a near miss of a Type
// Parameter the target names, and no other condition binds, is offered.
export function reportUnknownWhereGeneric(
	condition: parser.WhereConditionNode,
	clause: parser.ConformanceClauseNode,
	namespace: parser.NamespaceDefinitionStatementNode,
): void {
	let name = condition.generic.content
	let target = namespace.targetType
	let named = target !== null && namesType(target, name)
	let bound = new Set(clause.conditions.map((other) => other.generic.content))
	let suggestion = named
		? null
		: closestMatch(
				name,
				namespace.generics
					.map((generic) => generic.name.content)
					.filter(
						(candidate) =>
							!bound.has(candidate) &&
							target !== null &&
							namesType(target, candidate),
					),
			)

	reportError(
		`'${name}' is not a Type Parameter of this Namespace`,
		condition.generic.position,
		{
			code: "unknown-where-generic",
			labels: [
				primary(condition.generic.position, "no such Type Parameter"),
			],
			notes:
				named || suggestion !== null
					? []
					: [
							`The target Type never names '${name}', so a Type Parameter of that name would have nothing to prove the condition with.`,
						],
			helps: [
				named
					? `Declare it in the Namespace's Generic list: '<infer ${name}>'.`
					: suggestion === null
						? "Drop this condition."
						: `Did you mean '${suggestion}'?`,
			],
			// The name as the condition wrote it, for the Quick Fix that
			// declares it, or the near miss it is changed to.
			...(named
				? { data: { kind: "undeclared-parameter", name } }
				: suggestion === null
					? {}
					: { data: { kind: "suggestion", suggestion } }),
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
