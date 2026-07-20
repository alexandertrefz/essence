import type { common } from "../interfaces/index"
import { documentationOf, renderDocumentation } from "./documentation"
import { contains, isSmaller } from "./positions"
import { printSignature, printType, signaturesOf } from "./printType"

// NOTE: Hovers are resolved on the enriched AST — every Expression carries
// its inferred Type there. The smallest typed node containing the cursor
// wins, so hovering an Identifier inside a larger Expression describes the
// Identifier, not the Expression around it.
//
// Anything callable is rendered the way it is declared — `greet(subject:
// String) -> String` rather than `greet: (subject: String) -> String` — and an
// Overload set that has not been narrowed to one candidate spells out every
// Overload on its own line instead of combining them into a single Type.

export type HoverInfo = {
	position: common.Position
	content: string
	documentation: string | null
}

type State = {
	cursor: common.Cursor
	best: HoverInfo | null
}

export function findHover(
	program: common.typed.Program,
	cursor: common.Cursor,
): HoverInfo | null {
	let state: State = { cursor, best: null }

	visitBody(program.implementation.nodes, state)

	return state.best
}

function consider(
	state: State,
	position: common.Position,
	type: common.Type,
	label: string | null,
	declared: common.Documentation | null = null,
) {
	if (!wins(state, position)) {
		return
	}

	let signatures = signaturesOf(type)

	if (signatures !== null) {
		state.best = {
			position,
			content: describeSignatures(signatures, label ?? ""),
			documentation: renderDocumentation(
				documentationFor(signatures, documentationOf(type) ?? declared),
			),
		}

		return
	}

	state.best = {
		position,
		content:
			label === null ? printType(type) : `${label}: ${printType(type)}`,
		documentation: renderDocumentation(declared),
	}
}

function considerSignatures(
	state: State,
	position: common.Position,
	signatures: Array<common.BaseFunction>,
	label: string,
	fallback: common.Documentation | null,
) {
	if (!wins(state, position)) {
		return
	}

	state.best = {
		position,
		content: describeSignatures(signatures, label),
		documentation: renderDocumentation(
			documentationFor(signatures, fallback),
		),
	}
}

// NOTE: Once the Arguments have narrowed an Overload set to one signature its
// own text is what applies, falling back to whatever documents the set as a
// whole. With the set still open only the shared text can be meant.
function documentationFor(
	signatures: Array<common.BaseFunction>,
	fallback: common.Documentation | null,
): common.Documentation | null {
	if (signatures.length !== 1) {
		return fallback
	}

	return signatures[0].documentation ?? fallback
}

// NOTE: Ties go to the newer candidate — children are visited after their
// parents, so the deeper node wins. Every node in the Program is offered, so
// the Type is only printed once a candidate has actually won.
function wins(state: State, position: common.Position): boolean {
	if (!contains(position, state.cursor)) {
		return false
	}

	return state.best === null || !isSmaller(state.best.position, position)
}

function describeSignatures(
	signatures: Array<common.BaseFunction>,
	label: string,
): string {
	return signatures
		.map((signature) => printSignature(signature, label))
		.join("\n")
}

/***********/
/* Walkers */
/***********/

function visitBody(
	nodes: Array<common.typed.ImplementationNode>,
	state: State,
) {
	for (let node of nodes) {
		visitNode(node, state)
	}
}

function visitNode(node: common.typed.ImplementationNode, state: State) {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
			consider(
				state,
				node.position,
				node.type,
				node.name.content,
				node.documentation,
			)
			visitIdentifier(node.name, state, undefined, node.documentation)
			visitNode(node.value, state)
			return
		case "VariableAssignmentStatement":
			visitIdentifier(node.name, state)
			visitNode(node.value, state)
			return
		// NOTE: Declarations that carry a keyword in the source repeat it, so
		// the Hover reads back as the declaration itself.
		case "FunctionStatement":
			consider(
				state,
				node.position,
				node.type,
				`function ${node.name.content}`,
			)
			visitIdentifier(node.name, state, `function ${node.name.content}`)
			visitFunctionDefinition(node.value, state)
			return
		case "NamespaceDefinitionStatement":
			consider(
				state,
				node.position,
				node.type,
				node.name.content,
				node.documentation,
			)
			visitIdentifier(node.name, state, undefined, node.documentation)

			for (let property of Object.values(node.properties)) {
				visitNode(property.value, state)
			}

			for (let [name, member] of Object.entries(node.methods)) {
				let methods =
					member.nodeType === "OverloadedMethod" ||
					member.nodeType === "OverloadedStaticMethod"
						? member.methods
						: [member.method]

				let isStatic =
					member.nodeType === "StaticMethod" ||
					member.nodeType === "OverloadedStaticMethod"

				let label = isStatic ? `static ${name}` : name

				for (let method of methods) {
					consider(state, method.position, method.type, label)
					visitFunctionDefinition(method.value, state)
				}
			}

			return
		case "TypeAliasStatement":
			consider(
				state,
				node.position,
				node.type,
				node.name.content,
				node.documentation,
			)
			visitIdentifier(node.name, state, undefined, node.documentation)
			return
		case "IfStatement":
			visitNode(node.condition, state)
			visitBody(node.body, state)
			return
		case "IfElseStatement":
			visitNode(node.condition, state)
			visitBody(node.trueBody, state)
			visitBody(node.falseBody, state)
			return
		case "ReturnStatement":
			visitNode(node.expression, state)
			return
		case "Identifier":
			visitIdentifier(node, state)
			return
		case "NativeFunctionInvocation":
			consider(state, node.position, node.type, null)
			visitIdentifier(node.name, state)
			visitArguments(node.arguments, state)
			return
		case "MethodInvocation": {
			consider(state, node.position, node.type, null)
			visitNode(node.base, state)

			// NOTE: The Method name resolves through the Namespace — with an
			// overload the invoked signature is picked out for the Hover.
			let signatures = invokedSignatures(node)

			if (signatures !== null) {
				considerSignatures(
					state,
					node.member.position,
					signatures,
					node.member.name,
					documentationOf(
						node.namespace.type.methods[node.member.name],
					),
				)
			}

			visitArguments(node.arguments, state)
			return
		}
		case "FunctionInvocation":
			consider(state, node.position, node.type, null)
			visitNode(node.name, state)
			visitArguments(node.arguments, state)
			return
		case "Lookup":
			consider(state, node.position, node.type, null)
			visitNode(node.base, state)
			visitIdentifier(node.member, state)
			return
		case "Combination":
			consider(state, node.position, node.type, null)
			visitNode(node.lhs, state)
			visitNode(node.rhs, state)
			return
		case "Match":
			consider(state, node.position, node.type, null)
			visitNode(node.value, state)

			for (let handler of node.handlers) {
				visitBody(handler.body, state)
			}

			return
		case "RecordValue":
			consider(state, node.position, node.type, null)

			for (let member of Object.values(node.members)) {
				visitNode(member, state)
			}

			return
		case "ListValue":
			consider(state, node.position, node.type, null)

			for (let value of node.values) {
				visitNode(value, state)
			}

			return
		case "FunctionValue":
			consider(state, node.position, node.type, null)
			visitFunctionDefinition(node.value, state)
			return
		case "Self":
			consider(state, node.position, node.type, "@")
			return
		case "StringValue":
		case "IntegerValue":
		case "FractionValue":
		case "BooleanValue":
		case "NothingValue":
			consider(state, node.position, node.type, null)
			return
	}
}

function visitIdentifier(
	node: common.typed.IdentifierNode,
	state: State,
	label: string = node.content,
	declared: common.Documentation | null = null,
) {
	consider(state, node.position, node.type, label, declared)
}

function visitArguments(
	nodeArguments: Array<common.typed.ArgumentNode>,
	state: State,
) {
	for (let argument of nodeArguments) {
		visitNode(argument.value, state)
	}
}

function visitFunctionDefinition(
	definition: common.typed.FunctionDefinitionNode,
	state: State,
) {
	for (let parameter of definition.parameters) {
		if (
			parameter.externalName !== null &&
			parameter.externalName !== parameter.internalName
		) {
			visitIdentifier(parameter.externalName, state)
		}

		if (parameter.internalName !== null) {
			visitIdentifier(parameter.internalName, state)
		}
	}

	visitBody(definition.body, state)
}

function invokedSignatures(
	node: common.typed.MethodInvocationNode,
): Array<common.BaseFunction> | null {
	let memberType = node.namespace.type.methods[node.member.name]

	if (memberType === undefined) {
		return null
	}

	let signatures = signaturesOf(memberType)

	if (signatures === null) {
		return null
	}

	// NOTE: With a resolved Overload only the invoked signature is shown —
	// the others are noise once the Arguments have picked one.
	if (node.overloadedMethodIndex !== null) {
		let invoked = signatures[node.overloadedMethodIndex]

		if (invoked !== undefined) {
			return [invoked]
		}
	}

	return signatures
}
