import { builtinProtocols } from "@essence-lang/compiler/enricher/builtins"
import {
	derivedEnumerableNamespaceForChoice,
	derivedPrintableNamespaceForChoice,
	enumerableProtocolName,
	printableProtocolName,
} from "@essence-lang/compiler/enricher/resolvers"
import {
	applyGenericBindings,
	displayProtocolName,
	flattenUnionMembers,
	missingRequirements,
	providedMethodProtocol,
} from "@essence-lang/compiler/helpers"
import { printType, withoutSelf } from "@essence-lang/compiler/printType"
import type { common, parser } from "@essence-lang/interfaces"

import { isSamePosition } from "../positions"
import { programNodes, typedProgramNodes } from "../sections"
import { type SpellingScope, spellTypeAt } from "../spellableTypes"
import {
	closingBraceOf,
	indentationOf,
	insertBeforeClosingBrace,
	overlaps,
	sliceOf,
} from "./geometry"
import type { CodeActionEdit, CodeActionEntry, FixContext } from "./index"

// NOTE: The Methods a `namespace … is P` owes, written out as empty Methods
// with the Protocol's own signatures. It is offered twice, on the same edit:
// as the Quick Fix for `nonconforming-namespace`, whose span is the Protocol
// Identifier of the clause, and as a refactoring on the whole Namespace HEAD —
// a reader whose cursor rests on `namespace` or on the target Type is asking
// the same question, and the Diagnostic's span does not reach them there.
//
// Never preferred: every stub it writes has an empty body, so what it buys is
// a hole with the right signature on it rather than a Program that compiles.
//
// NOTE: An empty body is written `{}`, on the signature's own line — the shape
// `esfmt` leaves alone, and the shape the `missing-case` generator already
// writes. Spelled over two lines it was text a reader had to reformat before
// they could commit what the fix gave them.

// NOTE: The `Self` of a Protocol's signatures, which is the conformer's target
// Type at the declaration — `is(_ other: Self)` is written `is(_ other: Point)`
// in a Namespace `for Point`. The same substitution the conformance check makes
// before it compares a requirement to what a Namespace wrote.
const selfGenericName = "Self"

// NOTE: The Protocols a Choice answers without anybody writing a Method for
// them, mirroring `derivedConformanceSource`: the derives are what makes
// `namespace Colour for Colour is Equatable { }` right rather than empty, and
// stubbing `is` into it would replace a derived answer with a hole.
const equatableProtocolName = "Equatable"

// NOTE: A Namespace paired with what the Enricher made of it. The edit is
// measured against the PARSED Node — the braces it is written between, the
// column its members stand at — while what it owes is a question about Types,
// and only the typed side knows the answer.
type Conformer = {
	node: parser.NamespaceDefinitionStatementNode
	typed: common.typed.NamespaceDefinitionStatementNode
}

export function implementProtocolAction(
	context: FixContext,
): Array<CodeActionEntry> {
	let { diagnostic, program, enrichedProgram, lines } = context

	if (diagnostic.data?.kind !== "missing-requirements") {
		return []
	}

	let { protocol: protocolName, methods } = diagnostic.data
	// NOTE: Found by the clause the Diagnostic underlines rather than by name:
	// a file may declare two Namespaces for one Type, and only one of them
	// wrote the clause that was refused.
	let conformer = conformersOf(program, enrichedProgram).find((candidate) =>
		candidate.node.conformsTo.some((clause) =>
			isSamePosition(clause.protocol.position, diagnostic.position),
		),
	)

	if (conformer === undefined) {
		return []
	}

	let protocol = protocolsOf(enrichedProgram)[protocolName]

	if (protocol === undefined) {
		return []
	}

	return entryFor(
		conformer,
		protocol,
		// NOTE: Held to the Protocol in hand. The payload is the Enricher's
		// answer about a Protocol this Server looked up a second time, and a
		// name that is no requirement of it is a name nothing here can write a
		// signature for.
		methods.filter((name) => Object.hasOwn(protocol.methods, name)),
		lines,
		"quickfix",
		diagnostic,
		spelledAt(conformer, enrichedProgram),
	)
}

export function implementProtocolActions(
	program: parser.Program,
	enrichedProgram: common.typed.Program | null,
	lines: Array<string>,
	range: common.Position,
): Array<CodeActionEntry> {
	let protocols = protocolsOf(enrichedProgram)
	let entries: Array<CodeActionEntry> = []

	for (let conformer of conformersOf(program, enrichedProgram)) {
		if (!overlaps(conformer.typed.headPosition, range)) {
			continue
		}

		let granted = conformer.typed.type.conformsTo ?? []

		for (let clause of conformer.typed.conformsTo) {
			let protocol = protocols[clause.name]

			// NOTE: The Quick Fix answers on the clause's own Identifier, and
			// this is the same edit under the same title — so it stands down
			// wherever the request reaches that Identifier, rather than
			// offering the reader one thing twice. What it is FOR is the rest
			// of the head: a cursor on `namespace`, on the Namespace's name or
			// on the target Type is nowhere near the Diagnostic's span.
			if (
				protocol === undefined ||
				overlaps(clause.position, range) ||
				derives(protocol, conformer)
			) {
				continue
			}

			entries.push(
				...entryFor(
					conformer,
					protocol,
					missingRequirements(
						protocol,
						conformer.typed.type,
						// NOTE: Asked of every Protocol the Namespace conforms
						// to, not of this one alone — a Method one clause only
						// REQUIRES may carry another's body, and then nothing
						// is owed for it. The Enricher's own check asks the
						// same question the same way.
						providerIn(protocols, granted),
					),
					lines,
					"refactor.rewrite",
					null,
					spelledAt(conformer, enrichedProgram),
				),
			)
		}
	}

	return entries
}

function entryFor(
	conformer: Conformer,
	protocol: common.ProtocolType,
	methods: Array<string>,
	lines: Array<string>,
	kind: "quickfix" | "refactor.rewrite",
	diagnostic: (common.Diagnostic & { position: common.Position }) | null,
	at: SpellingScope | null,
): Array<CodeActionEntry> {
	if (methods.length === 0) {
		return []
	}

	let edit = stubsEdit(conformer, protocol, methods, lines, at)

	if (edit === null) {
		return []
	}

	return [
		{
			title: `Implement '${protocol.name}'`,
			kind,
			diagnosticCode: diagnostic?.code ?? null,
			diagnosticPosition: diagnostic?.position ?? null,
			// NOTE: A body per stub, and every one of them empty — see the
			// header. Applying this leaves a `missing-return` under each,
			// which is the reader's to answer.
			isPreferred: false,
			edits: [edit],
		},
	]
}

// NOTE: Where the stubs are going to STAND — inside the Namespace, one line
// above its closing brace — which is the Scope their signatures are read in.
// Null where no typed Program was handed in: the names are then written as the
// Protocol spells them, which is what this always did.
function spelledAt(
	conformer: Conformer,
	program: common.typed.Program | null,
): SpellingScope | null {
	return program === null
		? null
		: { program, cursor: conformer.node.position.end }
}

function stubsEdit(
	conformer: Conformer,
	protocol: common.ProtocolType,
	methods: Array<string>,
	lines: Array<string>,
	at: SpellingScope | null,
): CodeActionEdit | null {
	let { node } = conformer
	let end = node.position.end

	// NOTE: Read back off the buffer, as every edit here is. A Position from a
	// stale analysis pointing at something that is no longer a closing brace
	// would write the stubs into the middle of a line.
	if (sliceOf(lines, { start: closingBraceOf(end), end }) !== "}") {
		return null
	}

	if (node.targetType === null) {
		return null
	}

	// NOTE: The NAME's line rather than the Statement's — a `§§` block above
	// the declaration moves the Statement's start onto it, and a head broken
	// over several lines still opens on the line the name is written on.
	let indentation = indentationOf(lines, node.name.position.start.line)
	let member = `${indentation}\t`
	// NOTE: `Self` is written back as the target Type was WRITTEN, read off the
	// buffer rather than printed from the Type. A Record Alias resolves to the
	// Record it names and carries its own name nowhere, so printing the Type
	// would spell `namespace Square for Square is Shape` out as
	// `scaled(by: Integer) -> { side: Integer }` — a signature that fulfills
	// the requirement and says nothing a reader wrote.
	let self = sliceOf(lines, node.targetType.position)
	let stubs = methods
		.map((name) => stubFor(name, protocol, self, member, at))
		.join("\n")

	// NOTE: A blank line in front of the first stub where the Namespace
	// already holds something — its members stand one blank line apart, and a
	// Method written straight under the last one reads as part of it. A body
	// with nothing in it has nothing to be separated from.
	let written =
		Object.keys(node.methods).length + Object.keys(node.properties).length

	return insertBeforeClosingBrace(
		end,
		lines,
		written === 0 ? stubs : `\n${stubs}`,
		indentation,
	)
}

// NOTE: One Method, spelled as the Protocol declares it and as a Namespace has
// to write it. `printSignature` is deliberately NOT what does this: it prints a
// Parameter as `_ Boolean`, which is a Function TYPE's spelling and a syntax
// error in a declaration that carries a body — a bodied Method writes
// `label: Type` or `_: Type`, and the Parameter's own internal name is not on
// the Type at all, so the reader names it when they fill the body in.
function stubFor(
	name: string,
	protocol: common.ProtocolType,
	self: string,
	indentation: string,
	at: SpellingScope | null,
): string {
	// NOTE: Bound to a Type that PRINTS as the written target and is nothing
	// else — a GenericUse is exactly "a Type standing under a name", which is
	// what the source wrote, and it substitutes wherever `Self` appears rather
	// than only where it stands alone: `shrink() -> List<Self>` has to come out
	// as `List<Square>`.
	let requirement = applyGenericBindings(
		protocol.methods[name]!,
		new Map([[selfGenericName, { type: "GenericUse", name: self }]]),
	) as common.MethodType

	if (
		requirement.type === "OverloadedMethod" ||
		requirement.type === "OverloadedStaticMethod"
	) {
		let isStatic = requirement.type === "OverloadedStaticMethod"
		let entries = requirement.overloads
			.map(
				(overload) =>
					`${indentation}\t${signatureOf(
						isStatic ? overload : withoutSelf(overload),
						"",
						at,
					)} {}\n`,
			)
			.join("\n")

		return `${indentation}overload ${isStatic ? "static " : ""}${name} {\n${entries}${indentation}}\n`
	}

	let isStatic = requirement.type === "StaticMethod"
	let signature = signatureOf(
		isStatic ? requirement : withoutSelf(requirement),
		name,
		at,
	)

	return `${indentation}${isStatic ? "static " : ""}${signature} {}\n`
}

// NOTE: Every Type in the signature is spelled as the NAMESPACE can read it,
// not as the Protocol declares it: a requirement naming a Record another Module
// declares is written as the shape where this file has no word for it, which is
// the same Type and needs nothing imported. A Type with no spelling here at all
// is written as the Protocol spells it and left to the reader — a stub is a
// hole with a signature on it, and one name to correct is a better answer than
// no stubs at all.
function signatureOf(
	signature: common.BaseFunction,
	name: string,
	at: SpellingScope | null,
): string {
	let spelled = (type: common.Type): string =>
		spellTypeAt(type, at) ?? printType(type)

	// NOTE: `Self` is never declared — it is the target Type, which the head
	// already names, and `describeSignature` drops it for the same reason.
	let declared = signature.generics.filter(
		(generic) => generic.name !== selfGenericName,
	)
	let generics =
		declared.length === 0
			? ""
			: `<${declared
					.map(
						(generic) =>
							`${generic.infer ? "infer " : ""}${generic.name}${
								generic.constraint == null
									? ""
									: ` is ${displayProtocolName(generic.constraint)}`
							}`,
					)
					.join(", ")}>`
	let parameters = signature.parameterTypes
		// NOTE: The label doubles as the name a body reads the Parameter under,
		// which is the `count: Integer` form every Declaration may write. A
		// Parameter that carries no label binds nothing at all until the reader
		// names it, which is what `_: Type` says.
		.map(
			(parameter) =>
				`${parameter.name ?? "_"}: ${spelled(parameter.type)}`,
		)
		.join(", ")

	return `${name}${generics}(${parameters}) -> ${spelled(signature.returnType)}`
}

// NOTE: Whether this clause is answered by the Choice itself. A Namespace over
// a Choice that writes NONE of a Protocol's Methods conforms without them —
// equality from the Cases' tags, listing and printing from their names — and
// the Enricher accepts exactly that, so an offer to write the stubs here would
// be an offer to replace a derived answer with an empty one. The rule is
// `derivedConformanceSource`'s, asked through the very builders it uses.
function derives(protocol: common.ProtocolType, conformer: Conformer): boolean {
	let target = conformer.typed.targetType

	if (
		target === null ||
		Object.keys(protocol.methods).some((name) =>
			Object.hasOwn(conformer.typed.type.methods, name),
		)
	) {
		return false
	}

	if (protocol.identity === printableProtocolName) {
		return derivedPrintableNamespaceForChoice(target) !== null
	}

	if (protocol.identity === enumerableProtocolName) {
		return derivedEnumerableNamespaceForChoice(target, protocol) !== null
	}

	return protocol.identity === equatableProtocolName && isChoice(target)
}

// NOTE: Equality derives for EVERY Choice, payload or no payload, so this is
// the one derive that has no builder to ask — a Union whose every member is a
// Case is what the Enricher's own `choiceTypeOf` answers for.
function isChoice(type: common.Type): boolean {
	let cases = type.type === "UnionType" ? flattenUnionMembers(type) : [type]

	return cases.length > 0 && cases.every((member) => member.type === "Case")
}

// NOTE: `granted` holds identities, as a Namespace's `conformsTo` does.
function providerIn(
	protocols: Record<string, common.ProtocolType>,
	granted: ReadonlyArray<string>,
): (methodName: string) => string | null {
	let byIdentity = new Map(
		Object.values(protocols).map((protocol) => [
			protocol.identity,
			protocol,
		]),
	)

	return (methodName) => {
		for (let identity of granted) {
			let protocol = byIdentity.get(identity)
			let provider =
				protocol === undefined
					? null
					: providedMethodProtocol(protocol, methodName)

			if (provider !== null) {
				return provider
			}
		}

		return null
	}
}

// NOTE: The document's own Protocols over the ones it inherits — a standard
// library source declares the very Protocols the builtin tables hold, and the
// document's is the one whose requirements belong to it. A Protocol another
// Module publishes is in neither, and a Namespace conforming to one is offered
// nothing: there is no declaration in reach to read a signature off.
function protocolsOf(
	enrichedProgram: common.typed.Program | null,
): Record<string, common.ProtocolType> {
	let protocols: Record<string, common.ProtocolType> = {
		...builtinProtocols(),
	}

	if (enrichedProgram === null) {
		return protocols
	}

	for (let node of typedProgramNodes(enrichedProgram)) {
		if (node.nodeType === "ProtocolDeclarationStatement") {
			protocols[node.name.content] = node.protocolType
		}
	}

	return protocols
}

function conformersOf(
	program: parser.Program,
	enrichedProgram: common.typed.Program | null,
): Array<Conformer> {
	if (enrichedProgram === null) {
		return []
	}

	let typedNodes = typedProgramNodes(enrichedProgram).filter(
		(node): node is common.typed.NamespaceDefinitionStatementNode =>
			node.nodeType === "NamespaceDefinitionStatement",
	)
	let conformers: Array<Conformer> = []

	for (let node of programNodes(program)) {
		if (
			node.nodeType !== "NamespaceDefinitionStatement" ||
			node.conformsTo.length === 0
		) {
			continue
		}

		// NOTE: Paired by the NAME's Position, which the Enricher copies
		// across untouched — the Statement's own Position is the same pair of
		// numbers, but a Namespace the Parser recovered from is the one case
		// where it is not, and a mispairing would write one Namespace's stubs
		// into another.
		let typed = typedNodes.find((candidate) =>
			isSamePosition(candidate.name.position, node.name.position),
		)

		if (typed !== undefined) {
			conformers.push({ node, typed })
		}
	}

	return conformers
}
