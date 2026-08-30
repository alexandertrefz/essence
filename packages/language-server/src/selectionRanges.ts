import {
	caseDefaults,
	memberExpression,
	parameterDefaults,
} from "@essence-lang/compiler/helpers"
import type { common, parser } from "@essence-lang/interfaces"

import { assertionExpressions } from "./assertionChildren"
import { matcherValueExpressions } from "./matchHandlerChildren"
import { contains } from "./positions"
import { type ParserSection, programSections } from "./sections"

// NOTE: "Expand selection" wants the chain of ever-larger constructs
// containing the cursor. Collecting every Position on the path down the
// Parser AST gives exactly that, innermost first — the client turns the chain
// into nested ranges and steps through them.

export function findSelectionRanges(
	program: parser.Program,
	cursor: common.Cursor,
): Array<common.Position> {
	let chain: Array<common.Position> = []

	// NOTE: The innermost Section the cursor is in, and the Sections around it —
	// so expanding out of a Statement inside a test reaches the test, then the
	// suite, then the `tests { … }` block, each as the form it is written as.
	// The implementation is filtered out along the way for a cursor inside the
	// tests block: the two are Scopes one inside the other and spans side by
	// side, and only a span containing the cursor belongs in the chain.
	let section = innermostSection(programSections(program), cursor)

	if (section !== null) {
		for (let enclosing of ancestry(section)) {
			if (contains(enclosing.position, cursor)) {
				chain.push(enclosing.position)
			}
		}

		collectFromBody([...section.head, ...section.nodes], cursor, chain)
	}

	// NOTE: Innermost first, and duplicates dropped — a Statement wrapping a
	// single Expression often shares its Position exactly.
	return dropRepeats(chain.reverse())
}

// NOTE: The LAST Section containing the cursor, which is the innermost one:
// `programSections` hands them out outermost first, so anything nested in a
// Section stands after it.
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

// NOTE: Outermost first, the Section itself last.
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

// NOTE: A Parameter's `= expression` default is a span of its own, inside no
// body — so expanding a selection from inside `= @::length()` has to descend
// here or it jumps straight to the whole Declaration. Answers whether the cursor
// was in one, since a cursor inside a default is not in the body.
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
			if (collectFromDefaults(node.value.parameters, cursor, chain)) {
				return
			}

			collectFromBody(node.value.body, cursor, chain)
			return
		case "NamespaceDefinitionStatement": {
			for (let property of Object.values(node.properties)) {
				// NOTE: A native static Property has no value to descend into.
				if (property.value !== null) {
					descend(property.value, cursor, chain)
				}
			}

			for (let member of Object.values(node.methods)) {
				// NOTE: Only bodied Methods have a block to select within — the
				// body-less native signatures (declarations mode) are skipped.
				let methods: Array<parser.FunctionValueNode> = []

				if (
					member.nodeType === "SimpleMethod" ||
					member.nodeType === "StaticMethod"
				) {
					methods = [member.method]
				} else if (
					member.nodeType === "OverloadedMethod" ||
					member.nodeType === "OverloadedStaticMethod"
				) {
					methods = member.methods
				} else if (
					member.nodeType === "OverloadedMethodSignatures" ||
					member.nodeType === "OverloadedStaticMethodSignatures"
				) {
					methods = member.methods.filter(
						(entry): entry is parser.FunctionValueNode =>
							entry.nodeType === "FunctionValue",
					)
				}

				for (let method of methods) {
					if (contains(method.position, cursor)) {
						chain.push(method.position)

						if (
							!collectFromDefaults(
								method.value.parameters,
								cursor,
								chain,
							)
						) {
							collectFromBody(method.value.body, cursor, chain)
						}

						return
					}
				}
			}

			return
		}
		case "ChoiceDeclarationStatement":
			// NOTE: A Case payload's `= { … }` is a span inside no body, like a
			// Parameter's — without this, expanding a selection from inside one
			// jumps straight to the whole Choice.
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
				// NOTE: A Pattern's by-value members are the only part of a
				// Matcher that is smaller than the Matcher itself — a literal
				// Matcher's value spans the whole Matcher, so it would only
				// repeat a range the chain already has.
				for (let value of matcherValueExpressions(handler.matcher)) {
					descend(value, cursor, chain)
				}

				if (handler.guard !== null) {
					descend(handler.guard, cursor, chain)
				}

				collectFromBody(handler.body, cursor, chain)
			}

			return
		case "FunctionValue":
			if (collectFromDefaults(node.value.parameters, cursor, chain)) {
				return
			}

			collectFromBody(node.value.body, cursor, chain)
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
			// NOTE: The ENTRY stands on the chain between the key or value and
			// the whole literal, because a Dictionary entry is the one
			// member-shaped Node in the language that has a Position of its own
			// covering `key = value`. A Record member has none, which is why a
			// Record can not do this and a Dictionary can: widening from `39`
			// reaches `"alex" = 39` before it reaches the brackets.
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
		case "CaseValue":
			if (node.value !== null) {
				descend(node.value, cursor, chain)
			}

			return
		// NOTE: The path itself was pushed by whoever descended into it; what
		// is left is the one step the cursor stands on, so expanding a
		// selection from `city` reaches `.address.city` and then the Argument.
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

function descend(
	node: parser.ImplementationNode,
	cursor: common.Cursor,
	chain: Array<common.Position>,
) {
	if (!contains(node.position, cursor)) {
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
