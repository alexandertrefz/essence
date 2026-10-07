import { builtinProtocols } from "@essence-lang/compiler/enricher/builtins"
import {
	isSynthesizedName,
	parameterInternalName,
	recordDefaultMembers,
	recordDefaultNesting,
} from "@essence-lang/compiler/helpers"
import {
	printCaseWithPayload,
	printConformanceClauses,
	printSignature,
	printType,
	signaturesOf,
	spellProtocol,
	withoutSelf,
	withProtocolSpellings,
} from "@essence-lang/compiler/printType"
import {
	forEachParserChild,
	forEachTypedChild,
	type ParserNode,
	type TypedNode,
} from "@essence-lang/compiler/visitor"
import type { common, parser } from "@essence-lang/interfaces"

import { documentationOf, renderDocumentation } from "./documentation"
import { contains, isSmaller } from "./positions"
import { protocolSpellings } from "./protocolSpellings"
import { typedProgramNodes, typedProgramSections } from "./sections"

// Hovers over the enriched Program: the smallest typed node containing the
// cursor wins. See "Hover" in DEVELOPMENT.md.

type HoverInfo = {
	position: common.Position
	content: string
	documentation: string | null
}

type State = {
	cursor: common.Cursor
	best: HoverInfo | null
	// Every Protocol in Scope, built once per request, so a conformance clause
	// reads back as the Protocol it names.
	protocols: Record<string, common.ProtocolType>
	// Every Protocol the document declares at any depth, by identity. Built the
	// first time the cursor stands on a clause no imported Protocol answers.
	declaredProtocols: Record<string, common.ProtocolType> | null
	// The Protocols the import block bound, by the name the document writes.
	imported: Record<string, common.ProtocolType>
	program: common.typed.Program
	parserProgram: parser.Program | null
}

type ParsedDeclaration =
	| parser.NamespaceDefinitionStatementNode
	| parser.ProtocolDeclarationStatementNode
	| parser.ChoiceDeclarationStatementNode

// The document's own Protocols over inherited ones: a standard library source
// redeclares Protocols the builtin tables hold, with its own Positions.
function protocolsOf(
	program: common.typed.Program,
): Record<string, common.ProtocolType> {
	let protocols: Record<string, common.ProtocolType> = {
		...builtinProtocols(),
	}

	for (let node of typedProgramNodes(program)) {
		if (node.nodeType === "ProtocolDeclarationStatement") {
			protocols[node.name.content] = node.protocolType
		}
	}

	return protocols
}

// The identities of the Protocols a Namespace's clauses resolved to, its `is`
// clauses' and its `where` conditions'.
function clauseIdentities(type: common.NamespaceType): Array<string> {
	return [
		...(type.conformsTo ?? []),
		...Object.values(type.conformanceConditions ?? {}).flatMap(
			(conditions) => conditions.map((condition) => condition.protocol),
		),
	]
}

// The Protocol a clause naming `name` resolved to. Its identity tells a
// Protocol declared in a body from another of its name, which a table keyed
// by name can not. An imported one is named by its alias, if it has one.
function resolvedProtocol(
	name: string,
	identities: Array<string>,
	state: State,
): common.ProtocolType | undefined {
	let imported = state.imported[name]

	if (imported !== undefined && identities.includes(imported.identity)) {
		return imported
	}

	state.declaredProtocols ??= declaredProtocolsOf(state.program)

	let declared = state.declaredProtocols

	return identities
		.map((identity) => declared[identity])
		.find((protocol) => protocol?.name === name)
}

function declaredProtocolsOf(
	program: common.typed.Program,
): Record<string, common.ProtocolType> {
	let protocols: Record<string, common.ProtocolType> = {}
	let collect = (node: TypedNode) => {
		if (node.nodeType === "ProtocolDeclarationStatement") {
			protocols[node.protocolType.identity] = node.protocolType
		}

		forEachTypedChild(node, collect)
	}

	for (let node of typedProgramNodes(program)) {
		collect(node)
	}

	return protocols
}

// The parsed Program, paired with the typed tree where the typed tree has no
// Positions. See "What the typed tree lacks" in DEVELOPMENT.md.
export function findHover(
	program: common.typed.Program,
	cursor: common.Cursor,
	parserProgram: parser.Program | null = null,
	annotations: Array<common.TypeAnnotation> = [],
	text: string | null = null,
	// The Protocols the import block bound, so an aliased Protocol is spelled as
	// the document spells it. A clause naming one reads back as it.
	imported: Record<string, common.ProtocolType> = {},
): HoverInfo | null {
	return withProtocolSpellings(protocolSpellings(program, imported), () =>
		hoverAt(program, cursor, parserProgram, annotations, text, imported),
	)
}

function hoverAt(
	program: common.typed.Program,
	cursor: common.Cursor,
	parserProgram: parser.Program | null,
	annotations: Array<common.TypeAnnotation>,
	text: string | null,
	imported: Record<string, common.ProtocolType>,
): HoverInfo | null {
	if (text !== null && isInMargin(text, cursor)) {
		return null
	}

	let state: State = {
		cursor,
		best: null,
		protocols: protocolsOf(program),
		declaredProtocols: null,
		imported,
		program,
		parserProgram,
	}

	// Every body the Program holds, test bodies included.
	for (let section of typedProgramSections(program)) {
		for (let node of [...section.head, ...section.nodes]) {
			visitNode(node, state)
		}

		// `for any (a: Integer)` names a value no Statement declares, so the
		// Parameter answers for its own span.
		for (let property of section.properties) {
			consider(state, property.position, property.type, property.name)
		}
	}

	if (parserProgram !== null) {
		visitModuleSections(parserProgram, program, state)
	}

	visitAnnotations(annotations, state)

	return state.best
}

// A line's margins answer nothing: indentation, the space after the last
// character, a blank line. A space between two tokens belongs to what spans
// them.
function isInMargin(text: string, cursor: common.Cursor): boolean {
	let line = lineOf(text, cursor.line)
	let index = cursor.column - 1

	if ((line[index] ?? "").trim() !== "") {
		return false
	}

	return (
		line.slice(0, index).trim() === "" ||
		line.slice(index + 1).trim() === ""
	)
}

// One line of the text, counted from 1, or "" outside it. Hover runs on every
// pointer move, so the rest of the document is not split.
function lineOf(text: string, lineNumber: number): string {
	if (lineNumber < 1) {
		return ""
	}

	let start = 0

	for (let line = 1; line < lineNumber; line++) {
		start = text.indexOf("\n", start) + 1

		if (start === 0) {
			return ""
		}
	}

	let end = text.indexOf("\n", start)

	return text.slice(start, end === -1 ? text.length : end)
}

// Every resolved annotation with what it resolved to, offered last so a tie
// goes to the annotation. An annotation naming a Record Alias answers with its
// members. See "What the typed tree lacks" in DEVELOPMENT.md.
function visitAnnotations(
	annotations: Array<common.TypeAnnotation>,
	state: State,
) {
	for (let annotation of annotations) {
		consider(
			state,
			annotation.position,
			aliasedRecordShape(annotation.type) ?? annotation.type,
			null,
		)
	}
}

function consider(
	state: State,
	position: common.Position,
	type: common.Type,
	label: string | null,
	declared: common.Documentation | null = null,
	// A sentence on what a call may leave out, under the documentation. The
	// signature's `?` still means only that the whole Argument may go.
	note: string | null = null,
) {
	if (!wins(state, position)) {
		return
	}

	let signatures = signaturesOf(type)

	if (signatures !== null) {
		state.best = {
			position,
			content: describeSignatures(signatures, label ?? ""),
			documentation: withNote(
				renderDocumentation(
					documentationFor(
						signatures,
						documentationOf(type) ?? declared,
					),
				),
				note,
			),
		}

		return
	}

	state.best = {
		position,
		content:
			label === null ? printType(type) : `${label}: ${printType(type)}`,
		documentation: withNote(renderDocumentation(declared), note),
	}
}

function withNote(
	documentation: string | null,
	note: string | null,
): string | null {
	if (note === null) {
		return documentation
	}

	return documentation === null ? note : `${documentation}\n\n${note}`
}

function considerSignatures(
	state: State,
	position: common.Position,
	signatures: Array<common.BaseFunction>,
	label: string,
	fallback: common.Documentation | null,
	// The Protocol that provided this Method, under its documentation.
	providedBy: string | null = null,
) {
	if (!wins(state, position)) {
		return
	}

	let documentation = renderDocumentation(
		documentationFor(signatures, fallback),
	)
	let provided =
		providedBy === null
			? null
			: `Provided by \`${spellProtocol(providedBy)}\`.`

	state.best = {
		position,
		content: describeSignatures(signatures, label),
		documentation:
			provided === null
				? documentation
				: documentation === null
					? provided
					: `${documentation}\n\n${provided}`,
	}
}

// A narrowed Overload's own text applies, else the set's. An open set shows
// only the shared text.
function documentationFor(
	signatures: Array<common.BaseFunction>,
	fallback: common.Documentation | null,
): common.Documentation | null {
	if (signatures.length !== 1) {
		return fallback
	}

	return signatures[0].documentation ?? fallback
}

// The Module sections' entries: a typed entry holds the bound Type, its parsed
// entry the Identifiers, matched by span. A refused entry or a re-export stays
// silent.
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

			// A Namespace reads back as its declaration head, since its bare name would
			// repeat the word under the cursor.
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

			// And a Record Alias as its members, for the same reason.
			consider(
				state,
				identifier.position,
				aliasedRecordShape(type) ?? type,
				null,
			)
		}
	}

	for (let entry of parserProgram.imports?.entries ?? []) {
		visitEntry(entry)
	}

	for (let entry of parserProgram.exports?.entries ?? []) {
		visitEntry(entry)
	}
}

// Ties go to the later candidate, and children follow their parents, so the
// deeper node wins. A Type is printed only for a candidate that wins its turn,
// not for every node.
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

// Offers what a node answers, then lets the shared visitor descend, so a kind
// or a field the visitor learns later is walked here too.
function visitNode(node: TypedNode, state: State): void {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
			// The Constant a Pattern or a `require` stores its value in has a made-up
			// name, which is left out.
			if (node.synthesized === "base" || node.synthesized === "subject") {
				visitDeclaration(node, state, null)
				return
			}

			// The name's Type, for the keyword too, since one declaration says one thing.
			// The Statement's own Type would be the shape behind a Record Alias.
			consider(
				state,
				node.headPosition,
				node.name.type,
				node.name.content,
				node.documentation,
			)
			visitDeclaration(node, state, node.name.content, node.documentation)
			return
		// A declaration reads back with its keyword, as written.
		case "FunctionStatement":
			consider(
				state,
				node.headPosition,
				node.type,
				`function ${node.name.content}`,
			)
			visitDeclaration(node, state, `function ${node.name.content}`)
			return
		case "NamespaceDefinitionStatement":
			visitNamespace(node, state)
			return
		case "SimpleMethod":
		case "StaticMethod":
		case "OverloadedMethod":
		case "OverloadedStaticMethod":
			visitMethod(node, state)
			return
		// A native Method's Parameters are reached only through the frame the
		// Compiler synthesizes for its defaults. `visitNativeSignatures` answers
		// for the rest.
		case "NativeShim":
			forEachTypedChild(node, visitDefaultValue, state)
			return
		case "TypeAliasStatement":
			visitTypeAlias(node, state)
			return
		case "ProtocolDeclarationStatement":
			visitProtocol(node, state)
			return
		case "ChoiceDeclarationStatement":
			visitChoice(node, state)
			return
		case "GenericDeclaration":
			visitGenericDeclaration(node, state)
			return
		case "Parameter":
			visitParameter(node, state)
			return
		// The `<-` says what the Statement returns. An `if` offers no candidate:
		// nothing useful can be said about the keyword.
		case "ReturnStatement":
			consider(state, node.position, node.expression.type, null)
			break
		// What a `require` Matcher proved, as a Match Handler's Matcher reads, at the
		// Matcher's span. Its bindings are Constants of the body.
		case "ExpectStatement":
		case "RequireStatement":
			if (
				node.matcher !== null &&
				node.matcher.matcher.type === "Case" &&
				wins(state, node.matcher.matcherPosition)
			) {
				state.best = {
					position: node.matcher.matcherPosition,
					content: printCaseWithPayload(node.matcher.matcher),
					documentation: null,
				}
			}

			break
		case "Identifier":
			// A Pattern's bindings and a `require` read off a Constant with a
			// made-up name at the span written, so it is skipped. What was
			// written there answers for its own.
			if (!isSynthesizedName(node.content)) {
				visitIdentifier(node, state)
			}

			return
		case "MethodInvocation":
			visitMethodInvocation(node, state)
			return
		case "Lookup":
			visitLookup(node, state)
			return
		// What the Keyword answers with: `complete` reads back as the Value awaited,
		// `start` as the `Started` it put in flight. The operand keeps its own Hover.
		case "Start":
		case "Complete":
		// The `define` keyword answers with the whole Expression's Type, as a
		// `match` does.
		case "Define":
		// The literal answers with its own Type, as a written List does.
		case "DictionaryValue":
		case "FunctionInvocation":
		case "Combination":
		case "RecordValue":
		case "ListValue":
		case "InterpolatedStringValue":
		case "StringValue":
		case "IntegerValue":
		case "RationalValue":
		case "BooleanValue":
			consider(state, node.position, node.type, null)
			break
		case "Match":
			consider(state, node.position, node.type, null)

			// A Case Matcher's payload reads as a constructed Case does, instantiated
			// for an applied generic Choice by the scrutinee.
			for (let handler of node.handlers) {
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
			}

			break
		case "FunctionValue":
			// A member path is a Function literal the Compiler wrote. The path answers
			// with its signature and each step with the member it reads; its `_0`
			// Parameter is never offered.
			if (node.synthesized === "path") {
				consider(state, node.position, node.type, null)
				visitMemberPathSteps(node, state)

				return
			}

			consider(state, node.value.headPosition, node.type, null)
			break
		case "Self":
			consider(state, node.position, node.type, "@")
			return
		// The refused value is an `Error`. What it wraps still answers, the value
		// before the brackets or the Namespace refused as a value.
		case "RefusedValue":
			break
		case "CaseValue":
			visitCaseValue(node, state)
			return
	}

	forEachTypedChild(node, visitNode, state)
}

// Descends into a declaration whose own name answers as `label`, with what
// the declaration documents. A null `label` leaves the name out.
function visitDeclaration(
	node: TypedNode,
	state: State,
	label: string | null,
	declared: common.Documentation | null = null,
) {
	forEachTypedChild(
		node,
		(child, state, field, _key, container) => {
			if (
				field !== "name" ||
				container !== undefined ||
				child.nodeType !== "Identifier"
			) {
				visitNode(child, state)
			} else if (label !== null) {
				visitIdentifier(child, state, label, declared)
			}
		},
		state,
	)
}

function visitNamespace(
	node: common.typed.NamespaceDefinitionStatementNode,
	state: State,
) {
	// A Namespace with conformance clauses reads back as its whole declaration
	// head, spelled by hand like a Protocol or Choice. One without keeps the
	// plain Hover.
	let readsAsHead = node.conformsTo.length > 0

	if (readsAsHead) {
		let generics =
			node.type.generics.length === 0
				? ""
				: `<${node.type.generics.map(printGenericDeclaration).join(", ")}>`

		let target =
			node.targetType === null ? "" : ` for ${printType(node.targetType)}`

		let content = `namespace ${node.name.content}${generics}${target}${printConformanceClauses(
			node.conformsTo,
		)}`

		for (let position of [node.headPosition, node.name.position]) {
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
			node.headPosition,
			node.type,
			node.name.content,
			node.documentation,
		)
	}

	// `is Comparable` reads back as that Protocol, on the Protocol Identifier's
	// span. A `where` condition names a Generic and a Protocol.
	let identities = clauseIdentities(node.type)

	for (let clause of node.conformsTo) {
		visitProtocolReference(clause.name, clause.position, identities, state)

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
				identities,
				state,
			)
		}
	}

	// A static property reads back with its keyword.
	forEachTypedChild(
		node,
		(child, state, field, key, container) => {
			if (field !== "name" || child.nodeType !== "Identifier") {
				visitNode(child, state)
			} else if (container === "properties") {
				visitIdentifier(
					child,
					state,
					`static ${child.content}`,
					node.properties[String(key)]?.documentation ?? null,
				)
			} else if (!readsAsHead) {
				visitIdentifier(child, state, undefined, node.documentation)
			}
		},
		state,
	)

	visitNativeSignatures(node, state)
}

// A Namespace's Method. Its name is typed as the Method itself, so it
// describes every Overload, and each body's head as that Overload.
function visitMethod(
	node:
		| common.typed.SimpleMethod
		| common.typed.StaticMethod
		| common.typed.OverloadedMethod
		| common.typed.OverloadedStaticMethod,
	state: State,
) {
	let label =
		node.nodeType === "StaticMethod" ||
		node.nodeType === "OverloadedStaticMethod"
			? `static ${node.name.content}`
			: node.name.content

	forEachTypedChild(
		node,
		(child, state, field) => {
			if (field === "name" && child.nodeType === "Identifier") {
				visitIdentifier(child, state, label)
			} else if (child.nodeType === "FunctionValue") {
				consider(state, child.value.headPosition, child.type, label)
				forEachTypedChild(child, visitNode, state)
			} else {
				visitNode(child, state)
			}
		},
		state,
	)
}

function visitTypeAlias(
	node: common.typed.TypeAliasStatementNode,
	state: State,
) {
	// A refinement reads back as what it refines on its own declaration, and a
	// Record Alias as its members (`aliasedRecordShape`). See "How a declaration
	// reads back" in DEVELOPMENT.md.
	let declaredType =
		refinedAliasBase(node.type) ??
		aliasedRecordShape(node.type) ??
		node.type

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
	visitDeclaration(node, state, null)
}

function visitProtocol(
	node: common.typed.ProtocolDeclarationStatementNode,
	state: State,
) {
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

	// `visitProtocolBodies` answers a provided Method's name and head; its
	// Parameters and body are typed here.
	forEachTypedChild(
		node,
		(child, state, field) => {
			if (field === "methods") {
				forEachTypedChild(child, visitProvidedBody, state)
			} else if (field !== "name") {
				visitNode(child, state)
			}
		},
		state,
	)

	visitProtocolBodies(node, state)
}

function visitProvidedBody(child: TypedNode, state: State, field: string) {
	if (child.nodeType === "FunctionValue") {
		forEachTypedChild(child, visitNode, state)
	} else if (field !== "name") {
		visitNode(child, state)
	}
}

function visitChoice(
	node: common.typed.ChoiceDeclarationStatementNode,
	state: State,
) {
	// Spelled by hand like a Protocol's: the keyword, the name, and each Case
	// with its payload.
	let caseLine = (caseType: common.CaseType): string => {
		let members = Object.entries(caseType.members).map(
			([memberName, memberType]) =>
				`${memberName}: ${printType(memberType)}`,
		)

		return members.length === 0
			? `#${caseType.name}`
			: `#${caseType.name} { ${members.join(", ")} }`
	}

	// A generic Choice reads back with its Type Parameters, `choice Step<State,
	// Answer>`, and its payloads in terms of them.
	let generics =
		node.type.type === "GenericAlias" && node.type.generics.length > 0
			? `<${node.type.generics.map(printGenericDeclaration).join(", ")}>`
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

	// Each Case's name reads as its payload. A payload default's Expressions
	// answer with their own Types.
	forEachTypedChild(
		node,
		(child, state, field, key, container) => {
			if (field !== "name" || child.nodeType !== "Identifier") {
				visitNode(child, state)
			} else if (container === "cases" && wins(state, child.position)) {
				state.best = {
					position: child.position,
					content: printCaseWithPayload(node.cases[Number(key)].type),
					documentation: null,
				}
			}
		},
		state,
	)

	visitChoicePayloads(node, state)
}

// A Type Parameter as declared, as a whole. The typed node keeps its name and
// bound as plain strings without Positions.
function visitGenericDeclaration(
	generic: common.typed.GenericDeclarationNode,
	state: State,
) {
	if (wins(state, generic.position)) {
		state.best = {
			position: generic.position,
			content: printTypedGenericDeclaration(generic),
			documentation: null,
		}
	}
}

function visitParameter(parameter: common.typed.ParameterNode, state: State) {
	// On each span the Parameter offers: as written, its label, and its name.
	let note = omittableMembersNote(parameter)

	// The Parameter as written, so a bare `_` or the `:` answers with the
	// Parameter. Offered before the narrower names it contains.
	consider(state, parameter.position, parameter.type, null, null, note)

	forEachTypedChild(
		parameter,
		(child, state, field) => {
			if (field === "externalName" && child.nodeType === "Identifier") {
				if (child !== parameter.internalName) {
					visitIdentifier(child, state, child.content, null, note)
				}
			} else if (
				field === "internalName" &&
				child.nodeType === "Identifier"
			) {
				// A Pattern Parameter's internal name is made up, so it is not offered.
				// The names the Pattern binds are Constants of the body.
				if (!isSynthesizedName(child.content)) {
					visitIdentifier(child, state, child.content, null, note)
				}
			} else {
				// A default's Expressions answer for themselves, as in `= @::length()`.
				visitNode(child, state)
			}
		},
		state,
	)
}

function visitDefaultValue(child: TypedNode, state: State, field: string) {
	if (field === "defaultValue") {
		visitNode(child, state)
	} else if (child.nodeType === "Parameter") {
		forEachTypedChild(child, visitDefaultValue, state)
	}
}

function visitMethodInvocation(
	node: common.typed.MethodInvocationNode,
	state: State,
) {
	consider(state, node.position, node.type, null)

	forEachTypedChild(
		node,
		(child, state, field) => {
			visitNode(child, state)

			// The Method name stands between the receiver and the Arguments.
			if (field === "base") {
				visitInvokedMethod(node, state)
			}
		},
		state,
	)
}

// The Method name resolves through the Namespace; with Overloads, the invoked
// signature is picked out.
function visitInvokedMethod(
	node: common.typed.MethodInvocationNode,
	state: State,
) {
	// Resolving the signatures copies each Overload, so a name that can not win
	// is not resolved.
	if (!wins(state, node.member.position)) {
		return
	}

	let signatures = invokedSignatures(node)

	if (signatures === null) {
		return
	}

	considerSignatures(
		state,
		node.member.position,
		signatures,
		node.member.name,
		documentationOf(node.namespace.type.methods[node.member.name]),
		// A Method from a Protocol names that Protocol, so the reader can find its
		// declaration. A bounded receiver's witness answers per member.
		node.namespace.type.providedBy ??
			node.namespace.type.providedMembers?.[node.member.name] ??
			null,
	)
}

function visitLookup(node: common.typed.LookupNode, state: State) {
	consider(state, node.position, node.type, null)

	forEachTypedChild(
		node,
		(child, state, field) => {
			if (field !== "member" || child.nodeType !== "Identifier") {
				visitNode(child, state)

				return
			}

			// As for a MethodInvocation, so `Integer.isNot` names `Equatable` as
			// `5::isNot(3)` does.
			let signatures =
				node.providedBy === undefined ? null : signaturesOf(child.type)

			if (node.providedBy !== undefined && signatures !== null) {
				considerSignatures(
					state,
					child.position,
					signatures,
					child.content,
					documentationOf(child.type),
					node.providedBy,
				)
			} else {
				visitIdentifier(child, state)
			}
		},
		state,
	)
}

function visitCaseValue(node: common.typed.CaseValueNode, state: State) {
	consider(state, node.position, node.type, null)

	// The Choice's half names the Union, the Case's half the constructed Case.
	forEachTypedChild(
		node,
		(child, state, field) => {
			if (field !== "caseName" || child.nodeType !== "Identifier") {
				visitNode(child, state)
			} else if (node.type.type !== "Case") {
				visitIdentifier(child, state)
			} else if (wins(state, child.position)) {
				state.best = {
					position: child.position,
					content: printCaseWithPayload(node.type),
					documentation: null,
				}
			}
		},
		state,
	)
}

// What a refined Type Alias refines, or null. A generic one wraps the
// refinement, one level further in.
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

// A Record Alias's members, for its declaration and for a name of it, keeping
// any member that is an Alias named. Null for any other Type and for an
// unnamed Record. A generic Alias's body is unstamped, so any Record body
// answers.
function aliasedRecordShape(type: common.Type): common.Type | null {
	if (type.type === "GenericAlias") {
		return type.aliasedType.type === "Record" ? type.aliasedType : null
	}

	return type.type === "Record" &&
		(type.name !== undefined || type.alias !== undefined)
		? { type: "Record", members: type.members }
		: null
}

// A Type Parameter as declared, `infer Item` or `Item is Comparable`, for
// declarations. Call sites print Generics through `printType`.
function printGenericDeclaration(generic: common.GenericDeclaration): string {
	let inferKeyword = generic.infer ? "infer " : ""
	let constraint =
		generic.constraint == null
			? ""
			: ` is ${spellProtocol(generic.constraint)}`

	return `${inferKeyword}${generic.name}${constraint}`
}

// The typed node spells the field `inferred`, the resolved Type `infer`. An
// adapter rather than a cast, so reconciling the two breaks the build here.
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

// A Protocol's Hover, spelled by hand: the keyword, the name, each required
// signature. A conformance clause naming the Protocol shares it.
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

function visitIdentifier(
	node: common.typed.IdentifierNode,
	state: State,
	label: string = node.content,
	declared: common.Documentation | null = null,
	note: string | null = null,
) {
	consider(state, node.position, node.type, label, declared, note)
}

// A place naming a Protocol. An unknown name offers nothing, so the
// surrounding declaration answers.
function visitProtocolReference(
	name: string,
	position: common.Position,
	identities: Array<string>,
	state: State,
) {
	if (!wins(state, position)) {
		return
	}

	let protocolType =
		resolvedProtocol(name, identities, state) ?? state.protocols[name]

	if (protocolType === undefined) {
		return
	}

	state.best = {
		position,
		content: describeProtocol(name, protocolType),
		documentation: renderDocumentation(protocolType.documentation ?? null),
	}
}

// Outwards in, so the innermost step containing the cursor wins. Only the
// Lookups are the author's; the Parameter and root Identifier are not.
function visitMemberPathSteps(
	node: common.typed.FunctionValueNode,
	state: State,
) {
	let returned = node.value.body[0]

	if (returned?.nodeType !== "ReturnStatement") {
		return
	}

	let expression: common.typed.ExpressionNode = returned.expression

	while (expression.nodeType === "Lookup") {
		consider(state, expression.position, expression.type, null)
		visitIdentifier(expression.member, state)

		expression = expression.base
	}
}

// The members a Record Parameter's default fills in, as one sentence: the
// signature's `?` covers only a whole Argument. Read through the Compiler's
// `recordDefaultMembers`, so there is one answer.
function omittableMembersNote(
	parameter: common.typed.ParameterNode,
): string | null {
	let members = recordDefaultMembers(parameter.type, parameter.defaultValue)

	if (members === null || members.length === 0) {
		return null
	}

	let sentence = `A call may leave ${members.map((name) => `\`${name}\``).join(", ")} out of this Record.`
	// And which of them a path key may reach into, through the same helper.
	let reaching = Object.keys(
		recordDefaultNesting(parameter.type, parameter.defaultValue) ?? {},
	)

	return reaching.length === 0
		? sentence
		: `${sentence} It may reach into ${reaching.map((name) => `\`${name}\``).join(", ")} with a path key.`
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

	// With a resolved Overload, only the invoked signature.
	if (node.overloadedMethodIndex !== null) {
		let invoked = signatures[node.overloadedMethodIndex]

		if (invoked !== undefined) {
			return [invoked]
		}
	}

	return signatures
}

// Each parsed Program's declarations, indexed once, since every Hover over one
// version of a workspace document reads the same parsed Program.
const declarationIndexes = new WeakMap<
	parser.Program,
	Map<string, ParsedDeclaration>
>()

// The parsed declaration a typed one was enriched from, which starts where it
// does, at any depth. Null when the cursor is outside it, since then nothing
// it pairs can win.
function parsedDeclaration(
	state: State,
	position: common.Position,
): ParsedDeclaration | null {
	if (state.parserProgram === null || !contains(position, state.cursor)) {
		return null
	}

	let declarations = declarationIndexes.get(state.parserProgram)

	if (declarations === undefined) {
		declarations = declarationsOf(state.parserProgram)
		declarationIndexes.set(state.parserProgram, declarations)
	}

	return declarations.get(startKey(position)) ?? null
}

function declarationsOf(
	program: parser.Program,
): Map<string, ParsedDeclaration> {
	let declarations = new Map<string, ParsedDeclaration>()

	let visit = (node: ParserNode) => {
		if (
			node.nodeType === "NamespaceDefinitionStatement" ||
			node.nodeType === "ProtocolDeclarationStatement" ||
			node.nodeType === "ChoiceDeclarationStatement"
		) {
			declarations.set(startKey(node.position), node)
		}

		forEachParserChild(node, visit)
	}

	visit(program)

	return declarations
}

function startKey(position: common.Position): string {
	return `${position.start.line}:${position.start.column}`
}

/**********************************/
/* Body-less native declarations  */
/**********************************/

// The signature entries of one parsed Method node, paired by index with the
// resolved Overloads. A bodied entry has a typed node and is skipped.
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

// Answers for a native Method's name, its signature, its Parameters' names as
// resolved, and a native static property's name. The annotations are
// `visitAnnotations`'s. See "What the typed tree lacks" in DEVELOPMENT.md.
function visitNativeSignatures(
	namespace: common.typed.NamespaceDefinitionStatementNode,
	state: State,
) {
	let node = parsedDeclaration(state, namespace.position)

	if (node?.nodeType !== "NamespaceDefinitionStatement") {
		return
	}

	let namespaceType = namespace.type

	for (let [name, property] of Object.entries(node.properties)) {
		// Only those without a value, which have no typed node.
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

		// The name is typed as the Method itself, so it describes every Overload.
		consider(state, member.name.position, methodType, label)

		for (let { signature, resolved } of entries) {
			considerSignatures(
				state,
				signature.position,
				[isStatic ? resolved : withoutSelf(resolved)],
				label,
				signature.documentation,
			)

			// A non-static signature has the receiver injected first, so the resolved
			// list is one longer.
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

/*************************************************/
/* Declarations whose parts the typed tree drops */
/*************************************************/

// A Protocol's requirements and a Choice's payload members are typed as plain
// Records without Positions, so they are paired by name with the parsed
// declaration's. See "What the typed tree lacks" in DEVELOPMENT.md.

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
	protocol: common.typed.ProtocolDeclarationStatementNode,
	state: State,
) {
	let node = parsedDeclaration(state, protocol.position)

	if (node?.nodeType !== "ProtocolDeclarationStatement") {
		return
	}

	let protocolType = protocol.protocolType

	for (let [name, member] of Object.entries(node.methods)) {
		let methodType = protocolType.methods[name]

		if (methodType === undefined) {
			continue
		}

		let isStatic =
			methodType.type === "StaticMethod" ||
			methodType.type === "OverloadedStaticMethod"
		let label = isStatic ? `static ${name}` : name

		// The name is the requirement itself, so it describes every Overload.
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

			// A non-static requirement has the receiver injected first, as a
			// native signature does.
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

function visitChoicePayloads(
	choice: common.typed.ChoiceDeclarationStatementNode,
	state: State,
) {
	let node = parsedDeclaration(state, choice.position)

	if (node?.nodeType !== "ChoiceDeclarationStatement") {
		return
	}

	let cases = new Map(
		choice.cases.map((choiceCase) => [
			choiceCase.name.content,
			choiceCase.type,
		]),
	)

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
