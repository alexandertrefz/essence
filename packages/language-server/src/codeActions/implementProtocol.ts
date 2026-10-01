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
	providedBodyFulfils,
	providedMethodProtocol,
	writtenRequirementFulfils,
} from "@essence-lang/compiler/helpers"
import type { ImportedNames } from "@essence-lang/compiler/modules"
import { withoutSelf } from "@essence-lang/compiler/printType"
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

// Writes the Methods a `namespace … is P` owes as empty stubs with the
// Protocol's signatures. Offered as the `nonconforming-namespace` Quick Fix on
// the clause, and as a refactoring on the rest of the Namespace head.
//
// Not preferred: each stub's `{}` body is a hole. See "Holes" in
// DEVELOPMENT.md.

// The `Self` of a Protocol's signatures, written as the target Type:
// `is(_ other: Self)` becomes `is(_ other: Point)` in a Namespace `for Point`.
const selfGenericName = "Self"

// A Choice derives some Protocols, as in `derivedConformanceSource`, so a
// stub there would replace a derived answer with a hole.
const equatableProtocolName = "Equatable"

// A Namespace and its typed counterpart: the edit is measured on the parsed
// Node, while what it owes is a question about Types.
type Conformer = {
	node: parser.NamespaceDefinitionStatementNode
	typed: common.typed.NamespaceDefinitionStatementNode
}

export function implementProtocolAction(
	context: FixContext,
): Array<CodeActionEntry> {
	let { diagnostic, program, enrichedProgram, imported, lines } = context

	if (diagnostic.data?.kind !== "missing-requirements") {
		return []
	}

	let { protocol: protocolName, methods } = diagnostic.data
	// Found by the underlined clause, since two Namespaces may serve one
	// Type.
	let conformer = conformersOf(program, enrichedProgram).find((candidate) =>
		candidate.node.conformsTo.some((clause) =>
			isSamePosition(clause.protocol.position, diagnostic.position),
		),
	)

	if (conformer === undefined) {
		return []
	}

	let protocol = protocolNamed(
		protocolsOf(enrichedProgram, imported),
		protocolName,
		conformer.typed.type.conformsTo ?? [],
	)

	if (protocol === undefined) {
		return []
	}

	return entryFor(
		conformer,
		protocol,
		protocolName,
		// Only names the looked-up Protocol requires have a signature to
		// write.
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
	imported: ImportedNames | null,
	lines: Array<string>,
	range: common.Position,
): Array<CodeActionEntry> {
	let protocols = protocolsOf(enrichedProgram, imported)
	let entries: Array<CodeActionEntry> = []

	for (let conformer of conformersOf(program, enrichedProgram)) {
		if (!overlaps(conformer.typed.headPosition, range)) {
			continue
		}

		let granted = conformer.typed.type.conformsTo ?? []

		for (let clause of conformer.typed.conformsTo) {
			let protocol = protocolNamed(protocols, clause.name, granted)

			// On the clause itself the Quick Fix offers the same edit, so
			// this one stands down there.
			if (
				protocol === undefined ||
				overlaps(clause.position, range) ||
				derives(protocol, conformer)
			) {
				continue
			}

			let owed = missingRequirements(
				protocol,
				conformer.typed.type,
				// Another Protocol of the Namespace may provide a
				// body, as the Enricher's own check allows.
				providerIn(
					protocols,
					granted,
					protocol,
					conformer.typed.type.targetType,
				),
			)

			if (
				refusedElsewhere(
					protocols,
					granted,
					protocol,
					owed,
					conformer.typed.type.targetType,
				)
			) {
				continue
			}

			entries.push(
				...entryFor(
					conformer,
					protocol,
					clause.name,
					owed,
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
	// The Protocol as the conformer's file names it.
	spelling: string,
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
			title: `Implement '${spelling}'`,
			kind,
			diagnosticCode: diagnostic?.code ?? null,
			diagnosticPosition: diagnostic?.position ?? null,
			// Each empty body leaves a `missing-return` to answer.
			isPreferred: false,
			edits: [edit],
		},
	]
}

// The Scope the stubs' signatures are spelled in, before the closing brace.
// Null without a typed Program, and then no stub is written.
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

	// The closing brace must still be there.
	if (sliceOf(lines, { start: closingBraceOf(end), end }) !== "}") {
		return null
	}

	if (node.targetType === null) {
		return null
	}

	// The name's line, since a `§§` block moves the Statement's start.
	let indentation = indentationOf(lines, node.name.position.start.line)
	let member = `${indentation}\t`
	// `Self` is the target Type as written, since a printed Record Alias
	// would show its Record shape, `{ side: Integer }`, instead of its name.
	let self = sliceOf(lines, node.targetType.position)
	let scope = at === null ? null : { ...at, typeParameters: new Set([self]) }
	let stubbed = methods.map((name) =>
		stubFor(name, protocol, self, member, scope),
	)

	if (stubbed.includes(null)) {
		return null
	}

	let stubs = stubbed.join("\n")

	// A blank line before the stubs where the Namespace has members.
	let written =
		Object.keys(node.methods).length + Object.keys(node.properties).length

	return insertBeforeClosingBrace(
		end,
		lines,
		written === 0 ? stubs : `\n${stubs}`,
		indentation,
	)
}

// One Method stub. `printSignature` writes a Function Type's `_ Boolean`,
// which a bodied Method cannot use; it needs `label: Type` or `_: Type`.
function stubFor(
	name: string,
	protocol: common.ProtocolType,
	self: string,
	indentation: string,
	at: SpellingScope | null,
): string | null {
	// A GenericUse prints as the written target wherever `Self` appears, so
	// `List<Self>` becomes `List<Square>`.
	let requirement = applyGenericBindings(
		protocol.methods[name]!,
		new Map([[selfGenericName, { type: "GenericUse", name: self }]]),
	) as common.MethodType

	if (
		requirement.type === "OverloadedMethod" ||
		requirement.type === "OverloadedStaticMethod"
	) {
		let isStatic = requirement.type === "OverloadedStaticMethod"
		let signatures = requirement.overloads.map((overload) =>
			signatureOf(isStatic ? overload : withoutSelf(overload), "", at),
		)

		if (signatures.includes(null)) {
			return null
		}

		let entries = signatures
			.map((signature) => `${indentation}\t${signature} {}\n`)
			.join("\n")

		return `${indentation}overload ${isStatic ? "static " : ""}${name} {\n${entries}${indentation}}\n`
	}

	let isStatic = requirement.type === "StaticMethod"
	let signature = signatureOf(
		isStatic ? requirement : withoutSelf(requirement),
		name,
		at,
	)

	return signature === null
		? null
		: `${indentation}${isStatic ? "static " : ""}${signature} {}\n`
}

// The signature with each Type spelled as the Namespace can read it, such as
// a Record's shape for another Module's Alias. Null where a Type has no
// spelling here.
function signatureOf(
	signature: common.BaseFunction,
	name: string,
	at: SpellingScope | null,
): string | null {
	let returnType = spellTypeAt(signature.returnType, at)
	let parameterTypes = signature.parameterTypes.map((parameter) =>
		spellTypeAt(parameter.type, at),
	)

	if (returnType === null || parameterTypes.includes(null)) {
		return null
	}

	// `Self` is the target Type and is never declared.
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
		// A label doubles as the internal name. Without one, `_: Type` binds
		// nothing until the reader names it.
		.map(
			(parameter, index) =>
				`${parameter.name ?? "_"}: ${parameterTypes[index]}`,
		)
		.join(", ")

	return `${name}${generics}(${parameters}) -> ${returnType}`
}

// Whether the Choice derives this Protocol: a Namespace writing none of its
// Methods conforms anyway. The rule is `derivedConformanceSource`'s, asked
// through its builders.
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

// Equality derives for every Choice and has no builder to ask. A Union of
// only Cases is what `choiceTypeOf` answers for.
function isChoice(type: common.Type): boolean {
	let cases = type.type === "UnionType" ? flattenUnionMembers(type) : [type]

	return cases.length > 0 && cases.every((member) => member.type === "Case")
}

// `granted` holds identities, as a Namespace's `conformsTo` does. A body
// counts only where it fulfils `solving`'s requirement. A body whose Protocol
// is out of reach is taken to fulfil it.
function providerIn(
	protocols: Array<ProtocolInReach>,
	granted: ReadonlyArray<string>,
	solving: common.ProtocolType,
	target: common.Type | null,
): (methodName: string) => string | null {
	let byIdentity = new Map(
		protocols.map(({ protocol }) => [protocol.identity, protocol]),
	)
	let fulfils = (provider: string, methodName: string): boolean => {
		let body = byIdentity.get(provider)?.methods[methodName]

		return (
			target === null ||
			body === undefined ||
			providedBodyFulfils(
				methodName,
				solving.methods[methodName],
				body,
				target,
			)
		)
	}

	return (methodName) => {
		for (let identity of granted) {
			let protocol = byIdentity.get(identity)
			let provider =
				protocol === undefined
					? null
					: providedMethodProtocol(protocol, methodName)

			if (provider !== null && fulfils(provider, methodName)) {
				return provider
			}
		}

		return null
	}
}

// Whether a stub written as `solving` declares it would refuse another
// conformance whose body of the name it replaces, as the Enricher judges it.
// The Enricher offers no stub there either.
function refusedElsewhere(
	protocols: Array<ProtocolInReach>,
	granted: ReadonlyArray<string>,
	solving: common.ProtocolType,
	owed: Array<string>,
	target: common.Type | null,
): boolean {
	let reached = protocols
		.map(({ protocol }) => protocol)
		.filter((protocol) => granted.includes(protocol.identity))

	return (
		target !== null &&
		owed.some((methodName) =>
			reached.some(
				(protocol) =>
					providedMethodProtocol(protocol, methodName) !== null &&
					!writtenRequirementFulfils(
						methodName,
						solving.methods[methodName]!,
						protocol.methods[methodName]!,
						target,
					),
			),
		)
	)
}

// Every Protocol the document can name, under its local name: builtins,
// imports with their aliases, and declarations, a tests block's included.
type ProtocolInReach = { spelling: string; protocol: common.ProtocolType }

function protocolsOf(
	enrichedProgram: common.typed.Program | null,
	imported: ImportedNames | null,
): Array<ProtocolInReach> {
	let protocols = [
		...Object.entries(builtinProtocols()),
		...Object.entries(imported?.protocols ?? {}),
	].map(([spelling, protocol]) => ({ spelling, protocol }))

	if (enrichedProgram === null) {
		return protocols
	}

	for (let node of typedProgramNodes(enrichedProgram)) {
		if (node.nodeType === "ProtocolDeclarationStatement") {
			protocols.push({
				spelling: node.name.content,
				protocol: node.protocolType,
			})
		}
	}

	return protocols
}

// The Protocol a clause names, by the identity the Enricher resolved. A
// standard library source redeclares a builtin, and its own is read.
function protocolNamed(
	protocols: Array<ProtocolInReach>,
	spelling: string,
	granted: ReadonlyArray<string>,
): common.ProtocolType | undefined {
	return protocols.findLast(
		(candidate) =>
			candidate.spelling === spelling &&
			granted.includes(candidate.protocol.identity),
	)?.protocol
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

		// Paired by the name's Position, which survives Parser recovery
		// where the Statement's may not.
		let typed = typedNodes.find((candidate) =>
			isSamePosition(candidate.name.position, node.name.position),
		)

		if (typed !== undefined) {
			conformers.push({ node, typed })
		}
	}

	return conformers
}
