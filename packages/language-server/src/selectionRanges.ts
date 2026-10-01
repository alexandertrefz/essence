import {
	caseDefaults,
	memberExpression,
	parameterDefaults,
} from "@essence-lang/compiler/helpers"
import type { common, parser } from "@essence-lang/interfaces"

import { assertionExpressions } from "./assertionChildren"
import { defineArmExpressions } from "./defineArmChildren"
import { matcherValueExpressions } from "./matchHandlerChildren"
import { methodsOf, nativeSignaturesOf } from "./namespaceMembers"
import { contains } from "./positions"
import { type ParserSection, programSections } from "./sections"

// The chain of ever larger constructs containing the cursor, innermost first,
// for "Expand selection".

export function findSelectionRanges(
	program: parser.Program,
	cursor: common.Cursor,
): Array<common.Position> {
	let chain: Array<common.Position> = []

	// The innermost Section and those around it, so expanding from a test reaches
	// the suite and the `tests` block. The implementation is filtered out for a
	// cursor in the tests block, whose span lies beside it.
	let section = innermostSection(programSections(program), cursor)

	if (section !== null) {
		for (let enclosing of ancestry(section)) {
			if (contains(enclosing.position, cursor)) {
				chain.push(enclosing.position)
			}
		}

		collectFromBody([...section.head, ...section.nodes], cursor, chain)
	}

	// Innermost first, without repeats: a Statement often shares its
	// Expression's Position.
	return dropRepeats(chain.reverse())
}

// The last Section containing the cursor is the innermost, since
// `programSections` is outermost first.
function innermostSection(
	sections: Array<ParserSection>,
	cursor: common.Cursor,
): ParserSection | null {
	let found: ParserSection | null = null

	for (let section of sections) {
		if (contains(section.position, cursor)) {
			found = section
		}
	}

	return found
}

// Outermost first, the Section itself last.
function ancestry(section: ParserSection): Array<ParserSection> {
	let chain: Array<ParserSection> = []
	let current: ParserSection | null = section

	while (current !== null) {
		chain.unshift(current)
		current = current.parent
	}

	return chain
}

function dropRepeats(
	positions: Array<common.Position>,
): Array<common.Position> {
	return positions.filter((position, positionIndex) => {
		let previous = positions[positionIndex - 1]

		return (
			previous === undefined ||
			previous.start.line !== position.start.line ||
			previous.start.column !== position.start.column ||
			previous.end.line !== position.end.line ||
			previous.end.column !== position.end.column
		)
	})
}

function collectFromBody(
	nodes: Array<parser.ImplementationNode>,
	cursor: common.Cursor,
	chain: Array<common.Position>,
) {
	for (let node of nodes) {
		if (contains(node.position, cursor)) {
			chain.push(node.position)
			collectFromNode(node, cursor, chain)
			return
		}
	}
}

// A Parameter default is a span inside no body, so a cursor in
// `= @::length()` descends here. Answers whether the cursor was in one.
function collectFromDefaults(
	parameters: Array<parser.ParameterNode>,
	cursor: common.Cursor,
	chain: Array<common.Position>,
): boolean {
	for (let defaultValue of parameterDefaults(parameters)) {
		if (contains(defaultValue.position, cursor)) {
			chain.push(defaultValue.position)
			collectFromNode(defaultValue, cursor, chain)

			return true
		}
	}

	return false
}

// A default comes before the body, and the cursor is in at most one.
function collectFromDefinition(
	definition: parser.FunctionDefinitionNode,
	cursor: common.Cursor,
	chain: Array<common.Position>,
) {
	if (!collectFromDefaults(definition.parameters, cursor, chain)) {
		collectFromBody(definition.body, cursor, chain)
	}
}

function collectFromNode(
	node: parser.ImplementationNode,
	cursor: common.Cursor,
	chain: Array<common.Position>,
) {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
			descend(node.value, cursor, chain)
			return
		case "FunctionStatement":
			collectFromDefinition(node.value, cursor, chain)
			return
		case "NamespaceDefinitionStatement": {
			for (let property of Object.values(node.properties)) {
				// A native static Property has no value.
				if (property.value !== null) {
					descend(property.value, cursor, chain)
				}
			}

			// A native signature has no block, but its defaults are spans.
			for (let member of Object.values(node.methods)) {
				collectFromOverloads(methodsOf(member), cursor, chain)
				collectFromOverloads(nativeSignaturesOf(member), cursor, chain)
			}

			return
		}
		case "ProtocolDeclarationStatement":
			for (let member of Object.values(node.methods)) {
				let signatures =
					member.nodeType === "OverloadedProtocolMethod" ||
					member.nodeType === "OverloadedStaticProtocolMethod"
						? member.signatures
						: [member.signature]

				for (let { body } of signatures) {
					if (body !== null && contains(body.position, cursor)) {
						chain.push(body.position)

						if (
							!collectFromDefaults(
								body.value.parameters,
								cursor,
								chain,
							)
						) {
							collectFromBody(body.value.body, cursor, chain)
						}

						return
					}
				}
			}

			return
		case "OverloadedFunctionStatement":
			collectFromOverloads(node.methods, cursor, chain)
			return
		case "TypeAliasStatement":
			descend(node.predicate, cursor, chain)
			return
		case "ChoiceDeclarationStatement":
			// A Case payload's default is a span inside no body, like a Parameter's.
			for (let defaultValue of caseDefaults(node.cases)) {
				descend(defaultValue, cursor, chain)
			}

			return
		case "IfStatement":
			descend(node.condition, cursor, chain)
			collectFromBody(node.body, cursor, chain)
			return
		case "IfElseStatement":
			descend(node.condition, cursor, chain)
			collectFromBody(node.trueBody, cursor, chain)
			collectFromBody(node.falseBody, cursor, chain)
			return
		case "ReturnStatement":
			descend(node.expression, cursor, chain)
			return
		case "ExpectStatement":
		case "RequireStatement":
			for (let expression of assertionExpressions(node)) {
				descend(expression, cursor, chain)
			}

			return
		case "Match":
			descend(node.value, cursor, chain)

			for (let handler of node.handlers) {
				// A Pattern's by-value members are the only part of a Matcher smaller than
				// itself.
				for (let value of matcherValueExpressions(handler.matcher)) {
					descend(value, cursor, chain)
				}

				if (handler.guard !== null) {
					descend(handler.guard, cursor, chain)
				}

				collectFromBody(handler.body, cursor, chain)
			}

			return
		// The arm, which has a Position covering `as VALUE if CONDITION`, stands
		// between what is in it and the whole `define`. A Match Handler has none.
		case "Define":
			for (let arm of node.arms) {
				if (!contains(arm.position, cursor)) {
					continue
				}

				chain.push(arm.position)

				for (let expression of defineArmExpressions(arm)) {
					descend(expression, cursor, chain)
				}
			}

			if (contains(node.otherwise.position, cursor)) {
				chain.push(node.otherwise.position)
				descend(node.otherwise.value, cursor, chain)
			}

			return
		case "FunctionValue":
			collectFromDefinition(node.value, cursor, chain)
			return
		case "RecordValue":
			for (let member of Object.values(node.members)) {
				descend(memberExpression(member), cursor, chain)
			}

			return
		case "ListValue":
			for (let value of node.values) {
				descend(value, cursor, chain)
			}

			return
		case "DictionaryValue":
			// The entry, which has a Position covering `key = value`, stands between its
			// key or value and the literal. A Record member has none.
			for (let entry of node.entries) {
				if (!contains(entry.position, cursor)) {
					continue
				}

				chain.push(entry.position)
				descend(entry.key, cursor, chain)
				descend(entry.value, cursor, chain)
			}

			return
		case "InterpolatedStringValue":
			for (let segment of node.segments) {
				if (segment.kind === "expression") {
					descend(segment.expression, cursor, chain)
				}
			}

			return
		case "MethodInvocation":
			descend(node.base, cursor, chain)
			descendArguments(node.arguments, cursor, chain)
			return
		case "FunctionInvocation":
			descend(node.name, cursor, chain)
			descendArguments(node.arguments, cursor, chain)
			return
		case "Combination":
			descend(node.lhs, cursor, chain)
			descend(node.rhs, cursor, chain)
			return
		case "Lookup":
			descend(node.base, cursor, chain)
			return
		// The operand is a span inside the Keyword's, so the call comes first.
		case "Start":
		case "Complete":
			descend(node.expression, cursor, chain)
			return
		case "RefusedValue":
			descend(node.base, cursor, chain)
			return
		case "CaseValue":
			descend(node.value, cursor, chain)
			return
		// The step the cursor stands on, so `city` widens to `.address.city`.
		case "MemberPath":
			for (let step of node.steps) {
				if (contains(step.position, cursor)) {
					chain.push(step.position)

					return
				}
			}

			return
		case "Identifier":
		case "Self":
		case "StringValue":
		case "IntegerValue":
		case "RationalValue":
		case "BooleanValue":
			return
	}
}

// An `overload` block, which only the standard library writes, may mix bodied
// Functions with native signatures, whose defaults are spans inside no body.
// A Namespace's Methods are read the same way.
function collectFromOverloads(
	methods: Array<parser.FunctionValueNode | parser.NativeMethodSignatureNode>,
	cursor: common.Cursor,
	chain: Array<common.Position>,
) {
	for (let method of methods) {
		if (method.nodeType === "FunctionValue") {
			descend(method, cursor, chain)
		} else {
			collectFromDefaults(method.parameters, cursor, chain)
		}
	}
}

// A missing node, such as an absent predicate, holds nothing.
function descend(
	node: parser.ImplementationNode | null,
	cursor: common.Cursor,
	chain: Array<common.Position>,
) {
	if (node === null || !contains(node.position, cursor)) {
		return
	}

	chain.push(node.position)
	collectFromNode(node, cursor, chain)
}

function descendArguments(
	nodeArguments: Array<parser.ArgumentNode>,
	cursor: common.Cursor,
	chain: Array<common.Position>,
) {
	for (let argument of nodeArguments) {
		descend(argument.value, cursor, chain)
	}
}
