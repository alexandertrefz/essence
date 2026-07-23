import type { common, parser } from "../interfaces/index"
import { documentationOf, renderDocumentation } from "./documentation"
import { contains, isSmaller } from "./positions"
import {
	printCaseWithPayload,
	printConformanceClauses,
	printSignature,
	printType,
	signaturesOf,
	withoutSelf,
} from "./printType"

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

// NOTE: `parserProgram` is only ever passed for a standard library source, and
// only because a body-less native Method signature has NO typed Node. The
// Enricher drops one deliberately — there is no body to emit, and putting one
// in the typed tree would make the Simplifier emit a definition under a
// runtime export's name. So the Method Types are all there (on the typed
// Namespace's `type`) while every Position that could locate the cursor inside
// a signature is only in the parsed source. `visitNativeSignatures` pairs the
// two up. Without it every Hover inside `src/stdlib/*.es` answered with the
// enclosing Namespace, whatever it was aimed at — and String, Integer and
// Rational are hundreds of these signatures each.
export function findHover(
	program: common.typed.Program,
	cursor: common.Cursor,
	parserProgram: parser.Program | null = null,
): HoverInfo | null {
	let state: State = { cursor, best: null }

	visitBody(program.implementation.nodes, state)

	if (parserProgram !== null) {
		visitNativeSignatures(parserProgram, program, state)
	}

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
			// NOTE: A Namespace that declares conformance reads back as its
			// whole declaration head — `namespace List<infer Item> for
			// List<Item>, is Equatable, is Comparable where Item is Comparable`
			// — spelled by hand like a Protocol or Choice so the clauses show.
			// One without clauses keeps the plain name-and-Type Hover.
			if (node.conformsTo.length > 0) {
				let generics =
					node.type.generics.length === 0
						? ""
						: `<${node.type.generics
								.map(printGenericDeclaration)
								.join(", ")}>`

				let target =
					node.targetType === null
						? ""
						: ` for ${printType(node.targetType)}`

				let content = `namespace ${node.name.content}${generics}${target}${printConformanceClauses(
					node.conformsTo,
				)}`

				for (let position of [node.position, node.name.position]) {
					if (wins(state, position)) {
						state.best = {
							position,
							content,
							documentation: renderDocumentation(node.documentation),
						}
					}
				}
			} else {
				consider(
					state,
					node.position,
					node.type,
					node.name.content,
					node.documentation,
				)
				visitIdentifier(node.name, state, undefined, node.documentation)
			}

			for (let property of Object.values(node.properties)) {
				visitIdentifier(
					property.name,
					state,
					`static ${property.name.content}`,
					property.documentation,
				)
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

				// NOTE: The name is typed as the Method itself, so hovering it
				// describes the whole Method — every Overload at once, since
				// the name is what they share.
				visitIdentifier(member.name, state, label)

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
		case "ProtocolDeclarationStatement": {
			// NOTE: A Protocol is not a Type, so its Hover is spelled by hand —
			// the declaration keyword, the name, and each required signature.
			let requirements = Object.entries(node.protocolType.methods)
				.flatMap(([name, method]) => {
					let signatures = signaturesOf(method) ?? []
					let isStatic =
						method.type === "StaticMethod" ||
						method.type === "OverloadedStaticMethod"

					return signatures.map((signature) =>
						printSignature(
							signature,
							isStatic ? `static ${name}` : name,
						),
					)
				})
				.join("\n")

			let content =
				requirements === ""
					? `protocol ${node.name.content}`
					: `protocol ${node.name.content}\n${requirements}`

			for (let position of [node.position, node.name.position]) {
				if (wins(state, position)) {
					state.best = {
						position,
						content,
						documentation: renderDocumentation(node.documentation),
					}
				}
			}

			return
		}
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
		case "CaseValue":
			consider(state, node.position, node.type, null)

			// NOTE: The Choice's half names the Union, the Case's half the
			// constructed Case — both are hoverable on their own.
			if (node.choice !== null) {
				visitIdentifier(node.choice, state)
			}

			if (node.type.type === "Case") {
				if (wins(state, node.caseName.position)) {
					state.best = {
						position: node.caseName.position,
						content: printCaseWithPayload(node.type),
						documentation: null,
					}
				}
			} else {
				visitIdentifier(node.caseName, state)
			}

			if (node.value !== null) {
				visitNode(node.value, state)
			}

			return
		case "ChoiceDeclarationStatement": {
			// NOTE: Like a Protocol, a Choice's declaration Hover is spelled
			// by hand — the keyword, the name, and each Case with its payload
			// shape.
			let caseLine = (caseType: common.CaseType): string => {
				let members = Object.entries(caseType.members).map(
					([memberName, memberType]) =>
						`${memberName}: ${printType(memberType)}`,
				)

				return members.length === 0
					? `#${caseType.name}`
					: `#${caseType.name} { ${members.join(", ")} }`
			}

			let content = [
				`choice ${node.name.content}`,
				...node.cases.map((choiceCase) => caseLine(choiceCase.type)),
			].join("\n")

			for (let position of [node.position, node.name.position]) {
				if (wins(state, position)) {
					state.best = {
						position,
						content,
						documentation: renderDocumentation(node.documentation),
					}
				}
			}

			for (let choiceCase of node.cases) {
				if (wins(state, choiceCase.name.position)) {
					state.best = {
						position: choiceCase.name.position,
						content: printCaseWithPayload(choiceCase.type),
						documentation: null,
					}
				}
			}

			return
		}
		case "StringValue":
		case "IntegerValue":
		case "RationalValue":
		case "BooleanValue":
		case "NothingValue":
			consider(state, node.position, node.type, null)
			return
	}
}

// NOTE: A Namespace's own Type Parameter, rendered as declared — `infer Item`,
// or `Item is Comparable` where it carries a bound. Used only for the
// declaration-head Hover; call sites render Generics through `printType`.
function printGenericDeclaration(generic: common.GenericDeclaration): string {
	let inferKeyword = generic.infer ? "infer " : ""
	let constraint =
		generic.constraint == null ? "" : ` is ${generic.constraint}`

	return `${inferKeyword}${generic.name}${constraint}`
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

/**********************************/
/* Body-less native declarations  */
/**********************************/

// NOTE: What the pass below can and can not answer for, so the gap is written
// down rather than discovered:
//
//   • the Method NAME — the full signature and its `§§` text. The whole point.
//   • a Parameter's INTERNAL name (`other` in `_ other: Boolean`) — read back
//     off the resolved Parameter, so it says what the annotation resolved TO,
//     not what was typed.
//   • a Parameter's and the return Type's ANNOTATION — same, resolved.
//   • a native static PROPERTY's name and its annotation.
//
// NOT covered: the Type Parameters of a generic signature (`<Item>`), and the
// INSIDE of a compound annotation — hovering `Item` within `List<Item>` still
// answers with `List<Item>`, because the resolved Type is reachable only as a
// whole and this pass deliberately does not re-resolve anything. Hovering the
// annotation itself is the common case and it is covered.

function namespaceTypesOf(
	program: common.typed.Program,
): Map<string, common.NamespaceType> {
	let types = new Map<string, common.NamespaceType>()

	for (let node of program.implementation.nodes) {
		if (node.nodeType === "NamespaceDefinitionStatement") {
			types.set(node.name.content, node.type)
		}
	}

	return types
}

// NOTE: The signature entries of one parser Method Node, paired index by index
// with the resolved Overloads. A bodied entry is skipped — it has a typed Node
// of its own, and the pass above already answered for it.
function nativeSignatureEntries(
	member: parser.NamespaceMethods[string],
	methodType: common.MethodType,
): Array<{
	signature: parser.NativeMethodSignatureNode
	resolved: common.BaseFunction
}> {
	let signatures: Array<
		parser.NativeMethodSignatureNode | parser.FunctionValueNode
	> = []

	switch (member.nodeType) {
		case "SimpleMethodSignature":
		case "StaticMethodSignature":
			signatures = [member.signature]
			break
		case "OverloadedMethodSignatures":
		case "OverloadedStaticMethodSignatures":
			signatures = member.methods
			break
		default:
			return []
	}

	let resolved =
		methodType.type === "OverloadedMethod" ||
		methodType.type === "OverloadedStaticMethod"
			? methodType.overloads
			: [methodType]

	let entries: Array<{
		signature: parser.NativeMethodSignatureNode
		resolved: common.BaseFunction
	}> = []

	signatures.forEach((signature, index) => {
		let overload = resolved[index]

		if (signature.nodeType === "NativeMethodSignature" && overload) {
			entries.push({ signature, resolved: overload })
		}
	})

	return entries
}

function considerType(
	state: State,
	node: parser.TypeDeclarationNode | null,
	type: common.Type | common.GenericUse | undefined,
	label: string | null = null,
) {
	if (node == null || type === undefined) {
		return
	}

	consider(state, node.position, type as common.Type, label)
}

function visitNativeSignatures(
	parserProgram: parser.Program,
	program: common.typed.Program,
	state: State,
) {
	let namespaceTypes = namespaceTypesOf(program)

	for (let node of parserProgram.implementation.nodes) {
		if (node.nodeType !== "NamespaceDefinitionStatement") {
			continue
		}

		let namespaceType = namespaceTypes.get(node.name.content)

		if (namespaceType === undefined) {
			continue
		}

		for (let [name, property] of Object.entries(node.properties)) {
			// NOTE: Only the VALUE-less ones — a Property with a value has a
			// typed Node already.
			if (property.value !== null) {
				continue
			}

			let type = namespaceType.properties[name]

			consider(
				state,
				property.name.position,
				(type ?? { type: "Unknown" }) as common.Type,
				`static ${name}`,
				property.documentation,
			)
			considerType(state, property.type, type)
		}

		for (let [name, member] of Object.entries(node.methods)) {
			let methodType = namespaceType.methods[name]

			if (methodType === undefined) {
				continue
			}

			let entries = nativeSignatureEntries(member, methodType)

			if (entries.length === 0) {
				continue
			}

			let isStatic =
				methodType.type === "StaticMethod" ||
				methodType.type === "OverloadedStaticMethod"
			let label = isStatic ? `static ${name}` : name

			// NOTE: The name is typed as the Method itself — every Overload at
			// once, since the name is what they share.
			consider(state, member.name.position, methodType, label)

			for (let { signature, resolved } of entries) {
				considerSignatures(
					state,
					signature.position,
					[isStatic ? resolved : withoutSelf(resolved)],
					label,
					signature.documentation,
				)

				// NOTE: The receiver Parameter is injected ahead of the
				// written ones on a non-static signature, so the resolved list
				// is one longer than the parsed one.
				let offset = isStatic ? 0 : 1

				signature.parameters.forEach((parameter, index) => {
					let parameterType = resolved.parameterTypes[index + offset]

					if (parameterType === undefined) {
						return
					}

					considerType(state, parameter.type, parameterType.type)

					for (let identifier of [
						parameter.externalName,
						parameter.internalName,
					]) {
						if (identifier !== null) {
							consider(
								state,
								identifier.position,
								parameterType.type as common.Type,
								identifier.content,
							)
						}
					}
				})

				considerType(state, signature.returnType, resolved.returnType)
			}
		}
	}
}
