import type { common, enricher, parser } from "@essence-lang/interfaces"

import { collectDiagnostics, containsErrors } from "../diagnostics/index"
import { synthesizedName } from "../helpers/names"
import { enrichExpression } from "./enrichers"
import { collectReachedNames } from "./resolvers"
import { childScope } from "./scope"
import { ASSERTION_QUESTIONS, noteAssertionQuestions } from "./tests"

// Which questions an asserted value that is no Boolean answers. Each is asked
// of a name bound to the value's Type, as a call would ask it. So a conformance
// that holds only under a condition, as a List's `Comparable` does, answers
// only where the condition holds. The question's report is dropped, and so
// are the names it reached, which the file did not write.
export function askAssertionQuestions(
	value: common.typed.ExpressionNode,
	scope: enricher.Scope,
): void {
	if (value.type.type === "Boolean" || value.type.type === "Error") {
		return
	}

	let position = value.position
	let asked = synthesizedName("asked", position)
	let name: parser.IdentifierNode = {
		nodeType: "Identifier",
		content: asked,
		position,
	}
	let askedScope = childScope(scope, {
		members: { [asked]: value.type },
		declarations: { [asked]: position },
		constants: new Set([asked]),
	})

	noteAssertionQuestions(
		value,
		ASSERTION_QUESTIONS.filter((question) => {
			let call: parser.MethodInvocationNode = {
				nodeType: "MethodInvocation",
				base: name,
				member: {
					nodeType: "Identifier",
					content: question.method,
					position,
				},
				namespaceSpecifier: null,
				arguments: question.comparing
					? [{ nodeType: "Argument", name: null, value: name }]
					: [],
				position,
			}

			return !containsErrors(
				collectReachedNames(() =>
					collectDiagnostics(() =>
						enrichExpression(call, askedScope),
					),
				).result.diagnostics,
			)
		}).map((question) => question.spelling),
	)
}
