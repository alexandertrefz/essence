import { builtinProtocols } from "@essence-lang/compiler/enricher/builtins"
import {
	isSynthesizedName,
	parameterDefaults,
	parameterInternalName,
} from "@essence-lang/compiler/helpers"
import {
	printCaseWithPayload,
	printConformanceClauses,
	printSignature,
	printType,
	signaturesOf,
	withoutSelf,
} from "@essence-lang/compiler/printType"
import type { common, parser } from "@essence-lang/interfaces"

import { documentationOf, renderDocumentation } from "./documentation"
import { typedHandlerExpressions } from "./matchHandlerChildren"
import { contains, isSmaller } from "./positions"

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
	// NOTE: Every Protocol in scope, so a conformance clause can read back as
	// the Protocol it names. Built once per request rather than per clause.
	protocols: Record<string, common.ProtocolType>
}

// NOTE: The Protocols this document declares, over the ones it inherits — a
// standard library source declares the very Protocols the builtin tables
// already hold, and the document's own is the one whose Positions belong to it.
function protocolsOf(
	program: common.typed.Program,
): Record<string, common.ProtocolType> {
	let protocols: Record<string, common.ProtocolType> = {
		...builtinProtocols(),
	}

	for (let node of program.implementation.nodes) {
		if (node.nodeType === "ProtocolDeclarationStatement") {
			protocols[node.name.content] = node.protocolType
		}
	}

	return protocols
}

// NOTE: `parserProgram` is what the passes below pair the typed tree against,
// for the declarations whose parts the typed tree does not carry Positions for
// at all:
//
//   • a body-less native Method signature has NO typed Node. The Enricher drops
//     one deliberately — there is no body to emit, and putting one in the typed
//     tree would make the Simplifier emit a definition under a runtime export's
//     name. So the Method Types are all there (on the typed Namespace's `type`)
//     while every Position that could locate the cursor inside a signature is
//     only in the parsed source. Without `visitNativeSignatures` every Hover
//     inside `packages/standard-library/sources/*.es` answered with the enclosing Namespace, whatever
//     it was aimed at — and String, Integer and Rational are hundreds of these
//     signatures each.
//   • a Protocol's requirements and a Choice's payload members survive
//     enrichment as plain Type Records, with no Position in them anywhere.
//
// Passing it is therefore worth it for EVERY document, not only a standard
// library one: a native signature can not occur outside a declarations file, so
// that pass simply finds nothing in an ordinary Program.
export function findHover(
	program: common.typed.Program,
	cursor: common.Cursor,
	parserProgram: parser.Program | null = null,
	annotations: Array<common.TypeAnnotation> = [],
): HoverInfo | null {
	let state: State = {
		cursor,
		best: null,
		protocols: protocolsOf(program),
	}

	visitBody(program.implementation.nodes, state)

	if (parserProgram !== null) {
		visitNativeSignatures(parserProgram, program, state)
		visitProtocolBodies(parserProgram, program, state)
		visitChoicePayloads(parserProgram, program, state)
		visitModuleSections(parserProgram, program, state)
	}

	visitAnnotations(annotations, state)

	return state.best
}

// NOTE: Every Type annotation the Enricher resolved, paired with what it
// resolved TO. The typed AST erases annotations — a resolved Type carries no
// Position — so without this there is no candidate at an annotation's Position
// at all, and the enclosing declaration, which spans its whole body, answers
// for the cursor instead.
//
// A FLAT list, and no walker: an annotation's Position already says where it
// sits, and `wins` picks the smallest candidate containing the cursor. Nesting
// takes care of itself, because no annotation ever spans exactly what the
// annotation containing it spans — every compound form needs a bracket or an
// operator. Offered LAST so that an exact-span tie resolves to the annotation,
// which is the most specific thing that can be said about its own span.
function visitAnnotations(
	annotations: Array<common.TypeAnnotation>,
	state: State,
) {
	for (let annotation of annotations) {
		consider(state, annotation.position, annotation.type, null)
	}
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
// NOTE: The entries of the two Module sections. The typed entry carries what it
// bound but flattens its names to plain text, and the parser entry still holds
// the Identifiers with their Positions — so the pair is matched by the entry's
// own span, and the Identifier under the cursor answers with the bound Type.
// An entry the linking refused (or a re-export, whose declaration lives in the
// dependency) carries no Type and stays silent; its Diagnostic is already on it.
function visitModuleSections(
	parserProgram: parser.Program,
	program: common.typed.Program,
	state: State,
): void {
	let positionKey = (position: common.Position) =>
		`${position.start.line}:${position.start.column}`

	let typesByEntry = new Map<string, common.Type>()

	for (let entry of [
		...(program.imports?.entries ?? []),
		...(program.exports?.entries ?? []),
	]) {
		if (entry.type !== null) {
			typesByEntry.set(positionKey(entry.position), entry.type)
		}
	}

	let visitEntry = (entry: {
		name: parser.IdentifierNode
		alias: parser.IdentifierNode | null
		position: common.Position
	}) => {
		let type = typesByEntry.get(positionKey(entry.position))

		if (type === undefined) {
			return
		}

		for (let identifier of [entry.name, entry.alias]) {
			if (identifier === null) {
				continue
			}

			// NOTE: A Namespace prints as its bare name, which hovering that
			// very name says nothing with — so it reads back as its
			// declaration head instead, the way the declaring file spells it.
			if (type.type === "Namespace") {
				if (wins(state, identifier.position)) {
					state.best = {
						position: identifier.position,
						content: `namespace ${identifier.content}${
							type.targetType == null
								? ""
								: ` for ${printType(type.targetType)}`
						}`,
						documentation: null,
					}
				}

				continue
			}

			consider(state, identifier.position, type, null)
		}
	}

	for (let entry of parserProgram.imports?.entries ?? []) {
		visitEntry(entry)
	}

	for (let entry of parserProgram.exports?.entries ?? []) {
		visitEntry(entry)
	}
}

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
			// NOTE: The Constant a Pattern holds its value in is named by the
			// Compiler, so hovering it would answer with a name no source
			// wrote. Its value is still visited: the Expression under the
			// cursor is the author's either way.
			if (node.synthesized === "base") {
				visitNode(node.value, state)
				return
			}

			consider(
				state,
				node.headPosition,
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
				node.headPosition,
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

				for (let position of [node.headPosition, node.name.position]) {
					if (wins(state, position)) {
						state.best = {
							position,
							content,
							documentation: renderDocumentation(
								node.documentation,
							),
						}
					}
				}
			} else {
				consider(
					state,
					node.headPosition,
					node.type,
					node.name.content,
					node.documentation,
				)
				visitIdentifier(node.name, state, undefined, node.documentation)
			}

			// NOTE: A Method sees the Namespace's Generics injected into its
			// own list, so this is what a Namespace with no Methods would
			// otherwise lose.
			visitGenericDeclarations(node.generics, state)

			// NOTE: `is Comparable` names a Protocol, so it reads back as that
			// Protocol — the same Hover its declaration gives. Its Position is
			// the Protocol Identifier's alone, not the whole clause. A `where`
			// condition names one of each: the Generic it bounds and the
			// Protocol it bounds it by.
			for (let clause of node.conformsTo) {
				visitProtocolReference(clause.name, clause.position, state)

				for (let condition of clause.conditions) {
					let generic = node.generics.find(
						(candidate) => candidate.name === condition.generic,
					)

					if (
						generic !== undefined &&
						wins(state, condition.genericPosition)
					) {
						state.best = {
							position: condition.genericPosition,
							content: printTypedGenericDeclaration(generic),
							documentation: null,
						}
					}

					visitProtocolReference(
						condition.protocol,
						condition.protocolPosition,
						state,
					)
				}
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
					consider(
						state,
						method.value.headPosition,
						method.type,
						label,
					)
					visitFunctionDefinition(method.value, state)
				}
			}

			// NOTE: A native Method has no typed body, so its Parameters are
			// only ever reached through the frame the Compiler synthesizes for
			// its defaults — which is the only part of a native signature that
			// IS Essence, and the only part a hover has anything to say about
			// beyond what `visitNativeSignatures` reads off the parsed source.
			for (let shim of node.nativeShims) {
				for (let defaultValue of parameterDefaults(shim.parameters)) {
					visitNode(defaultValue, state)
				}
			}

			return
		case "TypeAliasStatement": {
			// NOTE: A checked refinement reads back as what it REFINES on its
			// own Declaration, because its name would say nothing there:
			// `NonZeroInteger: NonZeroInteger` is what naming it would answer,
			// and the predicate is on the very line the cursor is on. Everywhere
			// a VALUE of one is hovered the name is exactly right, which is what
			// `printType` answers — the substitution is for this Declaration and
			// for nowhere else.
			//
			// NOTE: A GENERIC refined Alias is a Generic Alias wrapping the
			// refinement, so its base is one level further in — `NonEmptyList<Item>`
			// reads back as `List<Item>`, which is exactly as much as the
			// non-generic one says.
			let declaredType = refinedAliasBase(node.type) ?? node.type

			consider(
				state,
				node.position,
				declaredType,
				node.name.content,
				node.documentation,
			)
			consider(
				state,
				node.name.position,
				declaredType,
				node.name.content,
				node.documentation,
			)
			visitGenericDeclarations(node.generics, state)
			return
		}
		case "ProtocolDeclarationStatement": {
			let content = describeProtocol(node.name.content, node.protocolType)

			for (let position of [node.headPosition, node.name.position]) {
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
		// NOTE: The `<-` says what the Statement returns. `IfStatement` and
		// `IfElseStatement` stay candidate-less on purpose — there is nothing
		// useful to say about the keyword, and offering the condition's Boolean
		// under it would be worse than saying nothing.
		case "ReturnStatement":
			consider(state, node.position, node.expression.type, null)
			visitNode(node.expression, state)
			return
		case "Identifier":
			// NOTE: A Pattern's bindings read off a Constant the Compiler
			// named, and that Identifier stands at the Pattern's own span — so
			// hovering anywhere in `{ width, height }` answered with
			// `$pattern_2_11`, a name no source wrote and no reader has seen.
			// The binders themselves are Constants of their own and answer for
			// their own spans, which is what a hover there should say.
			if (isSynthesizedName(node.content)) {
				return
			}

			visitIdentifier(node, state)
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
				// NOTE: A Case Matcher's payload shape is spelled out the way a
				// constructed Case value is — for an applied generic Choice its
				// members are the instantiated ones (`state: Integer`), which the
				// scrutinee's Type pins down.
				if (
					handler.matcher.type === "Case" &&
					wins(state, handler.matcherPosition)
				) {
					state.best = {
						position: handler.matcherPosition,
						content: printCaseWithPayload(handler.matcher),
						documentation: null,
					}
				}

				for (let expression of typedHandlerExpressions(handler)) {
					visitNode(expression, state)
				}

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
		case "InterpolatedStringValue":
			consider(state, node.position, node.type, null)

			for (let segment of node.segments) {
				if (segment.kind === "expression") {
					visitNode(segment.expression, state)
				}
			}

			return
		case "FunctionValue":
			consider(state, node.value.headPosition, node.type, null)
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

			// NOTE: A generic Choice reads back with its Type Parameters —
			// `choice Step<State, Result>` — the same way a Namespace's
			// declaration head spells its own. Its Cases then show their payloads
			// in terms of those Parameters (`state: State`), the abstract shape a
			// use site instantiates. A non-generic Choice's Union carries no
			// Parameters, so the head stays bare.
			let generics =
				node.type.type === "GenericAlias" &&
				node.type.generics.length > 0
					? `<${node.type.generics
							.map(printGenericDeclaration)
							.join(", ")}>`
					: ""

			let content = [
				`choice ${node.name.content}${generics}`,
				...node.cases.map((choiceCase) => caseLine(choiceCase.type)),
			].join("\n")

			for (let position of [node.headPosition, node.name.position]) {
				if (wins(state, position)) {
					state.best = {
						position,
						content,
						documentation: renderDocumentation(node.documentation),
					}
				}
			}

			visitGenericDeclarations(node.generics, state)

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
			consider(state, node.position, node.type, null)
			return
	}
}

// NOTE: What a refined Type Alias refines, or null when the Alias declares no
// refinement at all. A generic one is a Generic Alias wrapping the refinement, so
// the base sits one level further in than it does for `NonZeroInteger`.
function refinedAliasBase(type: common.Type): common.Type | null {
	if (type.type === "Refinement") {
		return type.base
	}

	if (
		type.type === "GenericAlias" &&
		type.aliasedType.type === "Refinement"
	) {
		return type.aliasedType.base
	}

	return null
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

// NOTE: The typed Node spells the field `inferred` where the resolved Type
// spells it `infer`. One adapter rather than a cast, so the day the two are
// reconciled this stops compiling instead of quietly reading `undefined`.
function printTypedGenericDeclaration(
	generic: common.typed.GenericDeclarationNode,
): string {
	return printGenericDeclaration({
		name: generic.name,
		infer: generic.inferred,
		constraint: generic.constraint,
		defaultType: generic.defaultType,
	})
}

// NOTE: A Protocol is not a Type, so its Hover is spelled by hand — the
// declaration keyword, the name, and each required signature. Shared with the
// conformance clauses that NAME a Protocol (`is Comparable`), which should read
// back as the Protocol they point at rather than as the Namespace around them.
function describeProtocol(
	name: string,
	protocolType: common.ProtocolType,
): string {
	let requirements = Object.entries(protocolType.methods)
		.flatMap(([methodName, method]) => {
			let signatures = signaturesOf(method) ?? []
			let isStatic =
				method.type === "StaticMethod" ||
				method.type === "OverloadedStaticMethod"

			return signatures.map((signature) =>
				printSignature(
					signature,
					isStatic ? `static ${methodName}` : methodName,
				),
			)
		})
		.join("\n")

	return requirements === ""
		? `protocol ${name}`
		: `protocol ${name}\n${requirements}`
}

// NOTE: A Type Parameter reads back as it was declared — `infer Item is
// Comparable`. Only ever the declaration as a WHOLE: the typed Node keeps its
// name and its bound as plain strings, so `Item` and `Comparable` within it can
// not be told apart, and the whole clause already answers the question.
function visitGenericDeclarations(
	generics: Array<common.typed.GenericDeclarationNode>,
	state: State,
) {
	for (let generic of generics) {
		if (wins(state, generic.position)) {
			state.best = {
				position: generic.position,
				content: printTypedGenericDeclaration(generic),
				documentation: null,
			}
		}
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

// NOTE: A place that NAMES a Protocol rather than declaring one. An unknown
// name offers nothing, so a clause naming a Protocol that does not resolve
// keeps whatever the declaration around it was already saying.
function visitProtocolReference(
	name: string,
	position: common.Position,
	state: State,
) {
	let protocolType = state.protocols[name]

	if (protocolType === undefined || !wins(state, position)) {
		return
	}

	state.best = {
		position,
		content: describeProtocol(name, protocolType),
		documentation: renderDocumentation(protocolType.documentation ?? null),
	}
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
	visitGenericDeclarations(definition.generics, state)

	for (let parameter of definition.parameters) {
		// NOTE: The Parameter as written, so that the cursor on a bare `_` — or
		// on the `:` between a name and its annotation — is answered by the
		// Parameter rather than by the signature around it. Offered BEFORE the
		// names it contains, which are narrower and win on their own spans.
		let declaredType =
			parameter.internalName?.type ?? parameter.externalName?.type ?? null

		if (declaredType !== null) {
			consider(state, parameter.position, declaredType, null)
		}

		if (
			parameter.externalName !== null &&
			parameter.externalName !== parameter.internalName
		) {
			visitIdentifier(parameter.externalName, state)
		}

		// NOTE: A Parameter taken apart by a Pattern has a Compiler-made
		// internal name standing over the Pattern's own span, so offering it
		// would answer a hover anywhere in the Pattern with a name no source
		// wrote. The names the Pattern BINDS are Constants at the head of the
		// body and are visited with it.
		if (
			parameter.internalName !== null &&
			!isSynthesizedName(parameter.internalName.content)
		) {
			visitIdentifier(parameter.internalName, state)
		}

		// NOTE: A default is an Expression written where it stands, so a hover
		// inside `= @::length()` answers about THAT call rather than about the
		// Parameter the call sits on. Visited after the Parameter itself, which
		// is offered over the wider span and loses to anything narrower.
		if (parameter.defaultValue !== null) {
			visitNode(parameter.defaultValue, state)
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

// NOTE: What the pass below answers for, so the division of labour is written
// down rather than discovered:
//
//   • the Method NAME — the full signature and its `§§` text. The whole point.
//   • the signature itself, for the cursor anywhere along it.
//   • a Parameter's EXTERNAL and INTERNAL names (`other` in `_ other: Boolean`)
//     — read back off the resolved Parameter, so each says what the annotation
//     resolved TO, not what was typed.
//   • a native static PROPERTY's name.
//
// The annotations either side of those names are NOT its business: the
// annotation index records every one of them, nested ones included, so
// `visitAnnotations` answers for them in every document rather than only here.

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

					for (let identifier of [
						parameter.externalName,
						parameterInternalName(parameter),
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
			}
		}
	}
}

/*************************************************/
/* Declarations whose parts the typed tree drops */
/*************************************************/

// NOTE: A Protocol's requirements and a Choice's payload members exist in the
// typed tree only as Types — `protocolType.methods` and `caseType.members` are
// plain Records, with no Position anywhere in them. Every name inside either
// declaration therefore had NO candidate at all, and the declaration around it
// answered: hovering `size`, `resize`, `to` or `Self` inside a Protocol gave
// back the whole Protocol, every time.
//
// Both are paired BY NAME with the parsed declaration, the same way
// `visitNativeSignatures` pairs a native Method with its resolved Overloads.
// The annotations either side of these names are not handled here — the
// annotation index already records every one of them.

function protocolSignatureEntries(
	member: parser.ProtocolMethods[string],
	methodType: common.MethodType,
): Array<{
	signature: parser.ProtocolMethodSignatureNode
	resolved: common.BaseFunction
}> {
	let signatures =
		member.nodeType === "OverloadedProtocolMethod" ||
		member.nodeType === "OverloadedStaticProtocolMethod"
			? member.signatures
			: [member.signature]

	let resolved =
		methodType.type === "OverloadedMethod" ||
		methodType.type === "OverloadedStaticMethod"
			? methodType.overloads
			: [methodType]

	let entries: Array<{
		signature: parser.ProtocolMethodSignatureNode
		resolved: common.BaseFunction
	}> = []

	signatures.forEach((signature, index) => {
		let overload = resolved[index]

		if (overload !== undefined) {
			entries.push({ signature, resolved: overload })
		}
	})

	return entries
}

function visitProtocolBodies(
	parserProgram: parser.Program,
	program: common.typed.Program,
	state: State,
) {
	let protocolTypes = new Map<string, common.ProtocolType>()

	for (let node of program.implementation.nodes) {
		if (node.nodeType === "ProtocolDeclarationStatement") {
			protocolTypes.set(node.name.content, node.protocolType)
		}
	}

	for (let node of parserProgram.implementation.nodes) {
		if (node.nodeType !== "ProtocolDeclarationStatement") {
			continue
		}

		let protocolType = protocolTypes.get(node.name.content)

		if (protocolType === undefined) {
			continue
		}

		for (let [name, member] of Object.entries(node.methods)) {
			let methodType = protocolType.methods[name]

			if (methodType === undefined) {
				continue
			}

			let isStatic =
				methodType.type === "StaticMethod" ||
				methodType.type === "OverloadedStaticMethod"
			let label = isStatic ? `static ${name}` : name

			// NOTE: The name is the requirement itself — every Overload at
			// once, since the name is what they share.
			consider(state, member.name.position, methodType, label)

			for (let { signature, resolved } of protocolSignatureEntries(
				member,
				methodType,
			)) {
				considerSignatures(
					state,
					signature.position,
					[isStatic ? resolved : withoutSelf(resolved)],
					label,
					signature.documentation,
				)

				// NOTE: The receiver is injected ahead of the written
				// Parameters on a non-static requirement, exactly as it is on a
				// native Method signature.
				let offset = isStatic ? 0 : 1

				signature.parameters.forEach((parameter, index) => {
					let parameterType = resolved.parameterTypes[index + offset]

					if (parameterType === undefined) {
						return
					}

					for (let identifier of [
						parameter.externalName,
						parameterInternalName(parameter),
					]) {
						if (identifier !== null) {
							consider(
								state,
								identifier.position,
								parameterType.type,
								identifier.content,
							)
						}
					}
				})
			}
		}
	}
}

function visitChoicePayloads(
	parserProgram: parser.Program,
	program: common.typed.Program,
	state: State,
) {
	let choiceCases = new Map<string, Map<string, common.CaseType>>()

	for (let node of program.implementation.nodes) {
		if (node.nodeType === "ChoiceDeclarationStatement") {
			choiceCases.set(
				node.name.content,
				new Map(
					node.cases.map((choiceCase) => [
						choiceCase.name.content,
						choiceCase.type,
					]),
				),
			)
		}
	}

	for (let node of parserProgram.implementation.nodes) {
		if (node.nodeType !== "ChoiceDeclarationStatement") {
			continue
		}

		let cases = choiceCases.get(node.name.content)

		if (cases === undefined) {
			continue
		}

		for (let choiceCase of node.cases) {
			let caseType = cases.get(choiceCase.name.content)

			if (caseType === undefined || choiceCase.type === null) {
				continue
			}

			for (let [memberName, member] of Object.entries(
				choiceCase.type.members,
			)) {
				let memberType = caseType.members[memberName]

				if (memberType === undefined) {
					continue
				}

				consider(state, member.name.position, memberType, memberName)
			}
		}
	}
}
