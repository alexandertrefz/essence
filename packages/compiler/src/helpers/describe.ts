import * as path from "node:path"

import type { common, enricher } from "@essence-lang/interfaces"

import { primary, secondary } from "../diagnostics/index"
import { closestMatch } from "./suggest"
import {
	type AsynchronyMismatch,
	asynchronyMismatch,
	decidesAnUndecidedSlot,
	flattenUnionMembers,
	matchesType,
} from "./types"

// The name a Generic is shown under. `createFreshenedInference` renames a
// callee's Generics per call to the name, a zero-width space and a counter. An
// unbound one keeps that name in the stamped Types. No written Generic holds a
// zero-width space, so stripping it touches nothing written.
export function displayGenericName(name: common.GenericName): string {
	return name.replace(/\u200B\d+$/, "")
}

// The Help for a Union no call can dispatch on, shared by the Enricher's
// refused call and the Validator's refused Match. A Match narrows declared Types,
// but Type Parameters erase before it runs. So a Union of Type Parameters is
// answered with one bounded Parameter, spelled with the value's name.
export function undispatchableHelps(
	memberTypes: Array<common.Type>,
	valueName: string | null,
	// The name the reader's file reads a Parameter's bound under.
	spellBound: (
		parameter: common.GenericUse & { constraint: string },
	) => string,
): Array<string> {
	let parameters = memberTypes.filter(
		(memberType): memberType is common.GenericUse =>
			memberType.type === "GenericUse",
	)

	if (parameters.length !== memberTypes.length) {
		return [
			"Narrow the value with a Match Expression before calling the Method.",
		]
	}

	let bounds = new Set(parameters.map((parameter) => parameter.constraint))
	let bounded = parameters[0]
	let declaration = `<infer Item${bounds.size !== 1 || bounded.constraint === undefined ? "" : ` is ${spellBound({ ...bounded, constraint: bounded.constraint })}`}>`
	let spelling =
		valueName === null
			? `'${declaration}', with the Parameter declared as an 'Item'`
			: `'${declaration}(_ ${valueName}: Item)'`

	return [
		`Take one Type Parameter in place of the Union — ${spelling} — since Types erase before a Match runs, and a Match is the only thing that narrows.`,
	]
}

// The nominal identity of a Choice, which `matchTypes` compares a Case by: the
// Module's canonical path and the declared name. The path is not relative to an
// entry, so a file reached from two entries is one Type.
// `modulePath` is null outside a Module, as in a single-file compile or the
// standard library, and the identity is then the bare name.
export function choiceIdentity(
	modulePath: string | null,
	name: string,
): string {
	return modulePath === null ? name : `${modulePath}#${name}`
}

// The Choice name a reader wrote, recovered from a `choiceIdentity`: all after
// the last `#`, which a path may hold and a name can not. Every printed Choice
// name comes from here.
export function displayChoiceName(identity: string): string {
	return identity.slice(identity.lastIndexOf("#") + 1)
}

// The nominal identity of a Protocol, by the Choice rule. One declared
// anywhere but its Program's top level also carries the Position of its name,
// because it may shadow another of its name in the same Module.
export function protocolIdentity(
	modulePath: string | null,
	name: string,
	nestedAt: common.Position | null,
): string {
	let identity = choiceIdentity(modulePath, name)

	return nestedAt === null
		? identity
		: `${identity}@${nestedAt.start.line}:${nestedAt.start.column}`
}

// The declared name inside an identity. A Module path may hold `#` or `@`
// and a name holds neither.
export function displayProtocolName(identity: string): string {
	let name = identity.slice(identity.lastIndexOf("#") + 1)
	let suffix = name.indexOf("@")

	return suffix === -1 ? name : name.slice(0, suffix)
}

// How a Diagnostic names another Module: the specifier an import in this
// one would write, never the canonical path, which differs per checkout.
export function specifierTo(importerPath: string, filePath: string): string {
	let relative = path
		.relative(path.dirname(importerPath), filePath)
		.split(path.sep)
		.join("/")

	return relative.startsWith("../") ? relative : `./${relative}`
}

// The Cases of the Choice a Type Alias declares, or null for an alias such
// as `type Answer = Optional<Integer>` whose Cases belong to another Choice. The
// alias holds the written name, not the Choice's identity.
export function declaredCases(
	type: common.Type,
	name: string,
): Array<common.CaseType> | null {
	if (type.type === "GenericAlias") {
		return declaredCases(type.aliasedType, name)
	}

	if (type.type !== "UnionType" || type.types.length === 0) {
		return null
	}

	let cases: Array<common.CaseType> = []

	for (let member of type.types) {
		if (
			member.type !== "Case" ||
			displayChoiceName(member.choice) !== name
		) {
			return null
		}

		cases.push(member)
	}

	return cases
}

// The Type Arguments a hover spells an applied refinement with, or null where
// the bare name says everything. Arguments that are all Type Parameters only
// echo the header, as in `caseHeader`. `describeType` always spells them.
export function displayedRefinementArguments(
	type: common.RefinementType,
): Array<common.Type> | null {
	if (
		type.typeArguments === undefined ||
		type.typeArguments.every(
			(typeArgument) => typeArgument.type === "GenericUse",
		)
	) {
		return null
	}

	return type.typeArguments
}

// A Type on one line, as a Diagnostic names it: the spelling a reader knows
// from their source. `printType` is the hover's form.
export function describeType(type: common.Type): string {
	switch (type.type) {
		case "UnionType":
			if (type.name !== undefined) {
				return type.name
			}

			if (type.alias !== undefined) {
				return `${type.alias.name}<${type.alias.typeArguments
					.map(describeType)
					.join(", ")}>`
			}

			return type.types.map(describeType).join(" | ")
		case "Case":
			return `${displayChoiceName(type.choice)}#${type.name}`
		// A refinement is named, not spelled out, and an applied one with all
		// its Arguments, even Type Parameters. A bare `NonEmptyList` is not a
		// Type a reader can write.
		case "Refinement":
			return type.typeArguments === undefined
				? type.name
				: `${type.name}<${type.typeArguments
						.map(describeType)
						.join(", ")}>`
		case "List":
			return `List<${describeType(type.itemType)}>`
		case "GenericList":
			return "List"
		case "Future":
			return `Future<${describeType(type.valueType)}>`
		case "Started":
			return `Started<${describeType(type.valueType)}>`
		case "Dictionary":
			return `Dictionary<${describeType(type.keyType)}, ${describeType(
				type.valueType,
			)}>`
		case "GenericDictionary":
			return "Dictionary"
		// A Record reached through an Alias is named, as a Union is, and
		// `describeRecordShape` spells out members where a mismatch needs them.
		// The name is the declaring file's, even where an import renamed it.
		case "Record":
			if (type.name !== undefined) {
				return type.name
			}

			if (type.alias !== undefined) {
				return `${type.alias.name}<${type.alias.typeArguments
					.map(describeType)
					.join(", ")}>`
			}

			return describeRecordShape(type)
		case "Function":
		case "SimpleMethod":
		case "StaticMethod":
			return describeFunctionSignature(type)
		// An Overload set has no one signature. A Diagnostic that holds one
		// names the Overloads in notes of their own.
		case "OverloadedMethod":
		case "OverloadedStaticMethod":
			return "Function"
		case "Namespace":
			return `Namespace '${type.name}'`
		case "GenericUse":
		case "GenericAlias":
			return displayGenericName(type.name)
		// The poison Type marks a slot already reported or never bound, and a
		// Program declares no `Error`, so it prints as an ellipsis. `printType`
		// keeps the tag, which specs read as evidence of poisoning.
		case "Error":
			return "…"
		default:
			return type.type
	}
}

// A function Type as a Type Annotation spells it, `(_: Integer) -> Integer`,
// with labels but no internal names. A Method named rather than called shows
// its receiver as the first Parameter.
function describeFunctionSignature(functionType: common.BaseFunction): string {
	let parameters = functionType.parameterTypes
		.map(
			(parameter) =>
				`${parameter.name ?? "_"}: ${describeType(parameter.type)}`,
		)
		.join(", ")

	return `(${parameters}) -> ${describeType(functionType.returnType)}`
}

// A Record with its members spelled out, whatever it is called, for a
// mismatch about members. An empty Record is `{}`.
export function describeRecordShape(type: common.RecordType): string {
	let members = Object.entries(type.members).map(
		([memberName, memberType]) =>
			`${memberName}: ${describeType(memberType)}`,
	)

	return members.length === 0 ? "{}" : `{ ${members.join(", ")} }`
}

// A Parameter by its label, or by its place where it has none, so the name is
// one the reader can find in the source.
export function describeParameter(
	parameter: common.Parameter | undefined,
	index: number,
): string {
	return parameter?.name != null
		? `Parameter '${parameter.name}'`
		: `Parameter ${index + 1}`
}

// How many Arguments a call must write: the Parameters without a default.
export function requiredParameterCount(
	parameters: ReadonlyArray<common.Parameter>,
): number {
	let required = 0

	for (let parameter of parameters) {
		if (parameter.hasDefault !== true) {
			required++
		}
	}

	return required
}

// The index of the last Parameter a call has to write, or `-1`. The defaulted
// run after it may be left out entirely.
export function lastRequiredParameterIndex(
	parameters: ReadonlyArray<common.Parameter>,
): number {
	let last = -1

	for (let [index, parameter] of parameters.entries()) {
		if (parameter.hasDefault !== true) {
			last = index
		}
	}

	return last
}

// A signature as every call Diagnostic notes it, such as "takes 1 or 2
// Arguments". Each Parameter that may be left out says so.
export function describeSignature(
	parameterTypes: Array<common.Parameter>,
): string {
	if (parameterTypes.length === 0) {
		return "takes no Arguments"
	}

	let required = requiredParameterCount(parameterTypes)

	return `takes ${describeArgumentCount(required, parameterTypes.length)}: ${parameterTypes
		.map(
			(parameter, index) =>
				`${describeParameter(parameter, index)} is ${describeType(parameter.type)}${parameter.hasDefault ? ", which may be left out" : ""}`,
		)
		.join(", ")}`
}

// The low end of a range is a number, as in "0 to 2 Arguments". Only an exact
// zero reads "no Arguments".
export function describeArgumentCount(required: number, total: number): string {
	if (required === total) {
		return countOf(total, "Argument")
	}

	if (required + 1 === total) {
		return `${required} or ${total} Arguments`
	}

	return `${required} to ${total} Arguments`
}

// For Diagnostics: "1 Argument", not "1 Arguments".
export function countOf(count: number, singular: string): string {
	return count === 1 ? `1 ${singular}` : `${count} ${singular}s`
}

// For Diagnostics: "an Integer", not "a Integer". It reads the first letter
// only, so a Type named User reads "an User".
export function withArticle(description: string): string {
	return /^[AEIOU]/i.test(description)
		? `an ${description}`
		: `a ${description}`
}

// The container inside `expected` holding the first blank that refused
// `written`, or the first blank at all for a null `written`. See "Undecided
// slots" in DEVELOPMENT.md.
function refusedSlotIn(
	expected: common.Type,
	written: common.Type | null,
): "List" | "Dictionary" | null {
	// A refinement decides nothing its base has not.
	while (expected.type === "Refinement") {
		expected = expected.base
	}

	while (written !== null && written.type === "Refinement") {
		written = written.base
	}

	if (written !== null && written.type !== expected.type) {
		return decidesAnUndecidedSlot(written)
			? refusedSlotIn(expected, null)
			: null
	}

	// Walked through: a blank inside a Future comes from an empty Literal it
	// was built around.
	if (expected.type === "Future" || expected.type === "Started") {
		return refusedSlotIn(
			expected.valueType,
			written === null
				? null
				: (written as common.FutureType | common.StartedType).valueType,
		)
	}

	if (expected.type === "List") {
		let writtenItemType =
			written === null ? null : (written as common.ListType).itemType

		return expected.itemType.type === "Unknown" &&
			(writtenItemType === null ||
				decidesAnUndecidedSlot(writtenItemType))
			? "List"
			: refusedSlotIn(expected.itemType, writtenItemType)
	}

	if (expected.type === "Dictionary") {
		let other = written as common.DictionaryType | null

		if (
			(expected.keyType.type === "Unknown" &&
				(other === null || decidesAnUndecidedSlot(other.keyType))) ||
			(expected.valueType.type === "Unknown" &&
				(other === null || decidesAnUndecidedSlot(other.valueType)))
		) {
			return "Dictionary"
		}

		return (
			refusedSlotIn(
				expected.keyType,
				other === null ? null : other.keyType,
			) ??
			refusedSlotIn(
				expected.valueType,
				other === null ? null : other.valueType,
			)
		)
	}

	if (expected.type === "Record") {
		let other = written as common.RecordType | null

		for (let [name, memberType] of Object.entries(expected.members)) {
			if (other !== null && !Object.hasOwn(other.members, name)) {
				continue
			}

			let found = refusedSlotIn(
				memberType,
				other === null ? null : other.members[name],
			)

			if (found !== null) {
				return found
			}
		}

		return null
	}

	// Arm by arm and one-sidedly, since the whole Union refused the value.
	if (expected.type === "UnionType") {
		for (let arm of expected.types) {
			let found = refusedSlotIn(arm, null)

			if (found !== null) {
				return found
			}
		}

		return null
	}

	return null
}

// The Type with every blank filled, to spell an annotation, taking each slot
// from `written` where it decides one. `invented` is set where an example stood
// in. See "Undecided slots" in DEVELOPMENT.md.
function spelledWithDecidedSlots(
	type: common.Type,
	written: common.Type | null = null,
	invented: { any: boolean } = { any: false },
): common.Type {
	switch (type.type) {
		case "Unknown":
			// Anything but another blank, since one blank decides no other.
			if (written !== null && written.type !== "Unknown") {
				return written
			}

			invented.any = true

			return { type: "Integer" }
		case "List":
			return {
				type: "List",
				itemType: spelledWithDecidedSlots(
					type.itemType,
					written?.type === "List" ? written.itemType : null,
					invented,
				),
			}
		// Spelled through, since the annotation names the whole
		// `Future<List<Integer>>`.
		case "Future":
			return {
				type: "Future",
				valueType: spelledWithDecidedSlots(
					type.valueType,
					written?.type === "Future" ? written.valueType : null,
					invented,
				),
			}
		case "Started":
			return {
				type: "Started",
				valueType: spelledWithDecidedSlots(
					type.valueType,
					written?.type === "Started" ? written.valueType : null,
					invented,
				),
			}
		case "Dictionary": {
			let other = written?.type === "Dictionary" ? written : null

			return {
				type: "Dictionary",
				// A key nothing decides is spelled as a String.
				keyType:
					type.keyType.type === "Unknown"
						? keyExample(other, invented)
						: spelledWithDecidedSlots(
								type.keyType,
								other?.keyType ?? null,
								invented,
							),
				valueType: spelledWithDecidedSlots(
					type.valueType,
					other?.valueType ?? null,
					invented,
				),
			}
		}
		case "Record": {
			let other = written?.type === "Record" ? written : null

			return {
				type: "Record",
				members: Object.fromEntries(
					Object.entries(type.members).map(([name, memberType]) => [
						name,
						spelledWithDecidedSlots(
							memberType,
							other?.members[name] ?? null,
							invented,
						),
					]),
				),
			}
		}
		// Each arm alone, as `refusedSlotIn` walks them.
		case "UnionType":
			return {
				...type,
				types: type.types.map((arm) =>
					spelledWithDecidedSlots(arm, null, invented),
				),
			}
		// The Type Arguments too, since `describeType` prints a refinement from
		// them and never from its base.
		case "Refinement":
			return {
				...type,
				base: spelledWithDecidedSlots(
					type.base,
					written?.type === "Refinement" ? written.base : written,
					invented,
				),
				typeArguments: type.typeArguments?.map((typeArgument) =>
					spelledWithDecidedSlots(typeArgument, null, invented),
				),
			}
		default:
			return type
	}
}

// A Dictionary key's example is a String, the usual key.
function keyExample(
	written: common.DictionaryType | null,
	invented: { any: boolean },
): common.Type {
	if (written !== null && written.keyType.type !== "Unknown") {
		return written.keyType
	}

	invented.any = true

	return { type: "String" }
}

// The note and Help for a mismatch whose expected Type holds a blank that
// refused `written`. `name` spells the annotation in full, and a null one spells
// the shape alone. See "Undecided slots" in DEVELOPMENT.md.
export function undecidedSlotEvidence(
	expected: common.Type,
	written: common.Type,
	name: string | null,
): { notes: Array<string>; helps: Array<string> } {
	let container = refusedSlotIn(expected, written)

	if (container === null) {
		return { notes: [], helps: [] }
	}

	let dictionary = container === "Dictionary"
	let invented = { any: false }
	let spelling = describeType(
		spelledWithDecidedSlots(expected, written, invented),
	)

	return {
		notes: [
			dictionary
				? "An empty Dictionary Literal leaves its key and value Types unknown until a write decides them, and nothing has written into this one — an 'Unknown' here is a blank, not a Type."
				: "An empty List Literal leaves its item Type unknown until a write decides it, and nothing has written into this one — the 'Unknown' here is a blank, not a Type.",
		],
		helps: [
			// A made-up Type is called an example, so it is not read as
			// the answer.
			`${
				name === null
					? `Annotate the Declaration that creates it — '${spelling}'`
					: `Annotate the Declaration — 'variable ${name}: ${spelling}'`
			}${invented.any ? ", for instance" : ""} — so what is written into it is judged against the ${dictionary ? "Types" : "Type"} it holds.`,
		],
	}
}

// The annotation that decides a Type's blanks, written with the Declaration's
// own `keyword`. `container` says which Literal left the blank, or null where
// the Type holds none.
export function undecidedSlotAnnotation(
	type: common.Type,
	keyword: string,
	name: string,
): { container: "List" | "Dictionary" | null; annotation: string } {
	return {
		container: refusedSlotIn(type, null),
		annotation: `${keyword} ${name}: ${describeType(spelledWithDecidedSlots(type))}`,
	}
}

// #region Record mismatches

// What a mismatch between two RECORDS says instead of printing both of
// them. Two nine-member shapes on two lines is a diff the reader is asked to do
// by eye, and the one thing the Compiler knows and they do not — WHICH member
// disagrees — is the thing neither line says. So the members are compared here
// and the disagreements are what the report carries: a Label on each one that is
// written down, a Note for the ones past the Labels, and the members nobody
// wrote listed once.
//
// Empty for every mismatch that is not between two Records, which is what lets
// the sites spread it without asking first — a String where a Standing was
// wanted is two Types and reads as two Types, and with a Record Alias's name on
// one of them it reads well.
export type RecordMismatchEvidence = {
	// The Label the report LEADS with, in place of the "this is a …" one
	// its site would have written over the whole value — and the Position the
	// Diagnostic itself takes, so an Editor underlines the member rather than
	// the Literal around it. Null where nothing was written down to point at: a
	// value that is not a Literal, and a refusal that is only about members
	// NOBODY wrote.
	lead: common.DiagnosticLabel | null
	labels: Array<common.DiagnosticLabel>
	notes: Array<string>
	helps: Array<string>
	// For the fix that writes a near miss over the name it was meant to
	// be. Carried only for a SINGLE misspelled member: two of them are two
	// edits, and which one an Editor would apply without asking is not a
	// question a Diagnostic can answer.
	data: common.DiagnosticData | undefined
}

// How many disagreeing members get a Label and how many more get a Note.
// Past that the count stands in for them: a report naming fifteen members is one
// nobody reads to the end, and the fifteen are usually one mistake — a value of
// another Type entirely — which the first three already say.
const labelledMembers = 3
const notedMembers = 6

type MemberDifference = {
	// The member's path from the outermost Record — `points`, or
	// `team.code` for one a nested Literal got wrong. Read by nothing but the
	// sentences, which is why it is a string rather than a list of steps.
	path: string
	// Where the VALUE of the member was written, or null for a member
	// reached through something that is not a Literal. Never the member's NAME:
	// a typed Record keys its members by name and holds no Position for one, and
	// the only Records that carry a name Position are the levels a dotted key
	// was desugared into (see `typed.RecordValueNode.memberPositions`).
	position: common.Position | null
	label: string
	note: string
	// Set on a member the Record does not declare at all, to the name it
	// was measured against — what a fix would write over it.
	suggestion?: string
}

export function recordMismatchEvidence(
	expected: common.Type,
	written: common.Type,
	value: common.typed.ExpressionNode | null,
	options: {
		// Members a default fills in, which are not missing however
		// little the value writes. `partial` is the whole of that rule rather
		// than a list of names: an update and a payload default may leave out
		// ANY member, so what refuses one is only what it writes.
		filled?: ReadonlyArray<string>
		partial?: boolean
		// What the sentences call the expected Record where it has no
		// Alias to be called by and the POSITION has a name of its own — a
		// Case's payload is `{ origin: Server, limits: Server }` and is called
		// `'#Get'` everywhere else in its own report. Top level only: a member
		// one step in is named by its own Alias or by nothing, and the position
		// says nothing about it.
		subject?: string
	} = {},
): RecordMismatchEvidence {
	let source = recordShapeOf(written)

	if (source === null) {
		return emptyRecordMismatch()
	}

	let target = closestRecordShape(expected, source)

	if (target === null) {
		return emptyRecordMismatch()
	}

	let literal =
		value !== null && value.nodeType === "RecordValue" ? value : null
	let subject = recordSubject(target.shape, options.subject)
	let differences = memberDifferences(
		target.shape,
		source,
		literal,
		"",
		subject,
	)
	let missing = missingMemberNames(target.shape, source, differences, options)

	if (differences.length === 0 && missing.length === 0) {
		return emptyRecordMismatch()
	}

	let labelled = differences
		.slice(0, labelledMembers)
		.filter((difference) => difference.position !== null)
	let noted = differences.slice(labelled.length)
	let listed = noted.slice(0, notedMembers)
	let [lead, ...rest] = labelled
	let misspelled = differences.filter(
		(difference) => difference.suggestion !== undefined,
	)
	// A refusal that is ONLY about members nobody wrote has nothing
	// inside the Literal to point at, so the Literal itself is what the Label
	// takes — and it says which members, because "this is a { team: { name:
	// String, code: String } }" over a Record the reader is looking at is the
	// shape printed back at them with the answer left out. The Note that would
	// have said the same is then not written: one sentence, in the place the
	// arrow lands.
	let missingLead =
		lead === undefined && literal !== null && missing.length > 0

	return {
		lead:
			lead !== undefined
				? primary(lead.position as common.Position, lead.label)
				: missingLead
					? primary(
							(literal as common.typed.RecordValueNode).position,
							missingClause(missing),
						)
					: null,
		labels: rest.map((difference) =>
			secondary(difference.position as common.Position, difference.label),
		),
		notes: [
			// Which arm the differences below are about, wherever the
			// position holds more than one Record. Without it a list of members
			// reads as a list of everything wrong with the value, when it is the
			// list of everything wrong with it AS ONE of the shapes it could be.
			...(target.among > 1
				? [
						`Compared against ${subject}, the closest of the ${countOf(target.among, "Record")} this Union holds.`,
					]
				: []),
			...listed.map((difference) => difference.note),
			...(noted.length > listed.length
				? [
						`And ${countOf(noted.length - listed.length, "more member")} ${
							noted.length - listed.length === 1
								? "differs"
								: "differ"
						}.`,
					]
				: []),
			...(missing.length === 0 || missingLead
				? []
				: [`${missingClause(missing)}.`]),
		],
		helps:
			misspelled.length === 1
				? [`Did you mean '${misspelled[0]!.suggestion}'?`]
				: [],
		data:
			misspelled.length === 1 && misspelled[0]!.position !== null
				? {
						kind: "record-member",
						member: lastStep(misspelled[0]!.path),
						suggestion: misspelled[0]!.suggestion as string,
					}
				: undefined,
	}
}

function emptyRecordMismatch(): RecordMismatchEvidence {
	return { lead: null, labels: [], notes: [], helps: [], data: undefined }
}

// The members nobody wrote, as one clause — a Label reads it without a
// full stop and a Note with one, and the two are never both written, so the
// sentence is built once and punctuated by whoever takes it.
function missingClause(missing: Array<string>): string {
	return missing.length === 1
		? `'${missing[0]}' is missing`
		: `${missing.map((name) => `'${name}'`).join(", ")} are missing`
}

// The Record inside a Type, or null where there is none. A refinement is
// looked through because what its base declares is what a value of it has to
// write — the predicate is a separate refusal with a report of its own, which
// `refinementEvidence` writes.
function recordShapeOf(type: common.Type): common.RecordType | null {
	while (type.type === "Refinement") {
		type = type.base
	}

	return type.type === "Record" ? type : null
}

// Which Record the value is compared AGAINST, when the position holds a
// Union of them. A value is turned away by every arm at once, and diffing
// against all of them would list a member each arm disagrees about differently —
// so it is diffed against the one it is closest to, and the report says which,
// because "compared against Circle" is the sentence that makes a list of three
// differences readable.
//
// Fewest differences wins, and the FIRST arm on a tie: the arms are compared in
// declaration order, so a tie answers with the one written first, which is the
// one a reader would have looked at.
function closestRecordShape(
	expected: common.Type,
	source: common.RecordType,
): { shape: common.RecordType; among: number } | null {
	let direct = recordShapeOf(expected)

	if (direct !== null) {
		return { shape: direct, among: 1 }
	}

	let type = expected

	while (type.type === "Refinement") {
		type = type.base
	}

	if (type.type !== "UnionType") {
		return null
	}

	let closest: { shape: common.RecordType; differences: number } | null = null
	let among = 0

	for (let arm of flattenUnionMembers(type)) {
		let shape = arm.type === "GenericUse" ? null : recordShapeOf(arm)

		if (shape === null) {
			continue
		}

		among++

		let differences =
			memberDifferences(shape, source, null, "", "").length +
			missingMemberNames(shape, source, [], {}).length

		if (closest === null || differences < closest.differences) {
			closest = { shape, differences }
		}
	}

	return closest === null ? null : { shape: closest.shape, among }
}

// Every member the value writes that the Record does not take — one it
// does not declare at all, and one it declares at another Type. In WRITTEN
// order, because that is the order the reader's eye runs along the line the
// Labels sit under.
//
// A member both sides hold as a Record of their own is walked INTO where the
// value wrote a Literal there, so `team.code` is named at the depth it is wrong
// at rather than the whole `team` being called the wrong shape. One step at a
// time and no further than the Literals go: what a value reached some other way
// holds is not something a Record Literal's members can be pointed at.
function memberDifferences(
	target: common.RecordType,
	source: common.RecordType,
	literal: common.typed.RecordValueNode | null,
	prefix: string,
	subject: string,
): Array<MemberDifference> {
	let differences: Array<MemberDifference> = []

	for (let [name, writtenType] of Object.entries(source.members)) {
		let path = `${prefix}${name}`
		let position = memberPosition(literal, name)

		if (!Object.hasOwn(target.members, name)) {
			// Measured only against members the value has NOT written
			// already. `goalsAgainst = 3` beside `goalAgainst = 4` is one
			// member spelled right and a second nobody declared, and the
			// nearest declared name to the second is the one standing a line
			// above it — so the Help said "Did you mean 'goalsAgainst'?" and
			// the fix that writes it turned one refusal into two, the mismatch
			// and a `duplicate-member` over the pair. A member already written
			// is not what an unknown one was meant to be.
			let suggestion = closestMatch(
				name,
				Object.keys(target.members).filter(
					(declared) => !Object.hasOwn(source.members, declared),
				),
			)

			differences.push({
				path,
				position,
				// The Label says what is wrong here and the near miss is
				// left to the Help, the way `unknown-member` splits the same
				// two facts — a Label repeating a Help is a line the reader
				// reads twice. A member too far down to get a Label carries
				// both in its Note, since it has no Help of its own.
				label: `'${path}' is not a member of ${subject}`,
				note:
					suggestion === null
						? `'${path}' is not a member of ${subject}.`
						: `'${path}' is not a member of ${subject} — '${suggestion}' is.`,
				...(suggestion === null ? {} : { suggestion }),
			})

			continue
		}

		let declaredType = target.members[name] as common.Type

		if (matchesType(declaredType, writtenType)) {
			continue
		}

		let nested = nestedDifferences(
			declaredType,
			writtenType,
			literal,
			name,
			path,
		)

		if (nested !== null) {
			differences.push(...nested)

			continue
		}

		// "this is" only where the arrow lands on the member ALONE. A
		// single-member Case takes a whole Record through its shorthand —
		// `#Circle({ radius = "big" })` is `radius = { radius = "big" }` — and
		// the member's Position is then the Literal's own, so a Label reading
		// "this is …" would be talking about a span that holds more than what it
		// is about. Naming the member is what a Note does anyway, so the Label
		// says the same thing there.
		let named = position !== null && position === literal?.position

		differences.push({
			path,
			position,
			label: named
				? `'${path}' is ${withArticle(describeType(writtenType))}, and ${subject} declares ${withArticle(describeType(declaredType))}`
				: `this is ${withArticle(describeType(writtenType))}, and ${subject} declares ${withArticle(describeType(declaredType))}`,
			note: `'${path}' is ${withArticle(describeType(writtenType))}; ${subject} declares ${withArticle(describeType(declaredType))}.`,
		})
	}

	return differences
}

// The differences one step further in, or null where there is no step to
// take — the member is not a Record on both sides, the value did not write a
// Literal there, or the two Records disagree about nothing the members can
// explain. The last of those is what keeps a walk from answering with silence: a
// member refused for something deeper than its own members is named at its own
// level, which is what the caller does with a null.
function nestedDifferences(
	declaredType: common.Type,
	writtenType: common.Type,
	literal: common.typed.RecordValueNode | null,
	name: string,
	path: string,
): Array<MemberDifference> | null {
	let target = recordShapeOf(declaredType)
	let source = recordShapeOf(writtenType)
	let member = literal?.members[name]

	if (
		target === null ||
		source === null ||
		member === undefined ||
		member.nodeType !== "RecordValue"
	) {
		return null
	}

	let nested = memberDifferences(
		target,
		source,
		member,
		`${path}.`,
		recordSubject(target),
	)
	let missing = missingMemberNames(target, source, nested, {})

	if (nested.length === 0) {
		return missing.length === 0 ? null : []
	}

	return nested
}

// The members the Record declares and the value does not write. Not a
// refusal at all where the position takes a PARTIAL — an update, a payload
// default — and not one for a member a default fills in, which is the same rule
// `missingRecordMembers` answers for an Argument and is asked here in the same
// words.
//
// A member a misspelling already accounts for is left out: `goalAgainst` written
// where `goalsAgainst` was declared is ONE edit, and a report that also lists
// `goalsAgainst` as missing sends the reader to write a tenth member.
function missingMemberNames(
	target: common.RecordType,
	source: common.RecordType,
	differences: Array<MemberDifference>,
	options: { filled?: ReadonlyArray<string>; partial?: boolean },
): Array<string> {
	if (options.partial === true) {
		return []
	}

	let accounted = new Set([
		...(options.filled ?? []),
		...differences.flatMap((difference) =>
			difference.suggestion === undefined ? [] : [difference.suggestion],
		),
	])

	return Object.keys(target.members).filter(
		(name) => !accounted.has(name) && !Object.hasOwn(source.members, name),
	)
}

// Where a member of a written Literal stands. The desugared levels a
// dotted key built carry their keys' Positions and nothing else does, so the
// value's own Position is what the rest are pointed at — the same order
// `reportUnmergedPathKey` reads the two in.
function memberPosition(
	literal: common.typed.RecordValueNode | null,
	name: string,
): common.Position | null {
	if (literal === null) {
		return null
	}

	return (
		literal.memberPositions?.[name] ??
		literal.members[name]?.position ??
		null
	)
}

// What the sentences call the Record a value was measured against — its
// Alias where it has one, and what the POSITION calls it where the Record has no
// name of its own: "the value it updates", "the declared return Type". Every
// site knows that much, and the last fallback is for the two that are about
// nothing a reader wrote. Never the shape: naming every member in a sentence
// ABOUT one of them is the wall this whole report exists to take down.
function recordSubject(type: common.RecordType, written?: string): string {
	if (type.name !== undefined || type.alias !== undefined) {
		return describeType(type)
	}

	return written ?? "the expected Record"
}

// The member a path ends at, which is the name a fix writes over — a
// nested one is spelled from the outside in for the reader and edited where it
// stands.
function lastStep(path: string): string {
	return path.slice(path.lastIndexOf(".") + 1)
}

// #endregion

// The question a value of this Type answers with a Boolean. Every Type has
// `::is(…)` through Equatable, and the four shapes written where a Boolean was
// wanted each have a better one: an Optional is asked whether it holds anything,
// a String and a List whether they carry anything, a number where it stands.
// Named rather than described, because the whole of the reader's next edit is one
// Method call and the NAME of it is the part they have not got.
//
// Two reports ask it — a Condition with no truth in it, and a `where` clause that
// answers a value instead of a question — and one answer keeps them saying the
// same thing about the same Type.
export function booleanQuestionFor(type: common.Type): string {
	if (type.type === "Refinement") {
		return booleanQuestionFor(type.base)
	}

	// An Optional is a Choice, so it arrives as its Union — under its own
	// name where the Declaration is reached directly, and under the Alias's where
	// `Optional<Integer>` was applied.
	if (
		type.type === "UnionType" &&
		(type.name === "Optional" || type.alias?.name === "Optional")
	) {
		return "hasValue()"
	}

	switch (type.type) {
		case "String":
			return "hasCharacters()"
		case "List":
			return "hasItems()"
		case "Integer":
		case "Rational":
			return "isGreaterThan(0)"
		default:
			return "is(…)"
	}
}

// What a Future or a Started IS, in the clause every report about a
// forgotten `complete` opens with. Several reports say it — a Type mismatch in
// an ordinary position, one in return position, a Method call on the wrapper
// instead of on the value, and work standing where a value was wanted — and
// each of them goes on differently, because what a reader should DO about it is
// different in each. What they must not differ about is the state of the work,
// which is this.
export function asynchronyState(mismatch: AsynchronyMismatch): string {
	return mismatch === "unstarted"
		? "This describes work that has not run"
		: "This is still in flight"
}

// The same question the Helps below ask, answered as DATA. A Quick Fix
// reads this rather than a Help's sentence: the wording is written per site and
// is free to change, and a fix keyed on prose breaks silently when it does.
// `not-a-future` carries nothing, because there is no edit to make — what a body
// has to do about it is build a future, which is a judgement.
export function asynchronyData(
	expected: common.Type,
	actual: common.Type,
	// See `asynchronyHelps`. The fix this data offers WRITES the word, so
	// it is withheld wherever the word would be refused — a Quick Fix must never
	// hand the reader a second Diagnostic in place of the first.
	canWait: boolean = true,
): common.DiagnosticData | undefined {
	if (!canWait) {
		return undefined
	}

	let mismatch = asynchronyMismatch(expected, actual)

	return mismatch === "unstarted" || mismatch === "in-flight"
		? { kind: "asynchrony-mismatch", mismatch }
		: undefined
}

// The Helps a mismatch gets where the difference is one missing word about
// asynchrony rather than a wrong value. `asynchronyMismatch` decides WHICH of
// the three it is, by assignability.
//
// This is the ordinary positions' wording — an Argument, a Declaration, an
// Assignment, a `define` arm — where the value is the thing to change.
export function asynchronyHelps(
	expected: common.Type,
	actual: common.Type,
	// Whether the body around this position may write `complete` at all.
	// `false` swaps the word out: a `complete` in a body that answers no Future
	// is `complete-outside-future`, so offering it there — and offering a Quick
	// Fix that writes it — sent the reader from one refusal to the next. What is
	// offered instead is the pair `asynchronyEvidence` offers on the same
	// footing: reach through the Future, or declare the body one that waits.
	//
	// Defaulted, because most positions are inside a body that can wait and the
	// ones that are not have to look it up.
	canWait: boolean = true,
	// And WHY it may not, where the answer is one of the four barriers
	// rather than an ordinary body. "Declare the enclosing Function
	// '-> Future<…>'" is no edit at all inside a property body, which has no
	// enclosing Function, and none inside a Parameter's default, which is filled
	// in before the Function's own asynchrony begins — so where a barrier
	// answered, the edit it names is the barrier's own.
	barrier: enricher.CompletionBarrier | null = null,
): Array<string> {
	let mismatch = asynchronyMismatch(expected, actual)

	if (!canWait && (mismatch === "unstarted" || mismatch === "in-flight")) {
		return barrier === null
			? [
					"'complete' only stands in a body that answers a Future, and this one does not — reach through it with '::map((value) { … })', which answers another Future, or declare the enclosing Function '-> Future<…>'.",
				]
			: [
					"'complete' only stands in a body that answers a Future, and this position is not one — reach through it with '::map((value) { … })', which answers another Future.",
					...barredCompletion(barrier).helps,
				]
	}

	switch (mismatch) {
		case "unstarted":
			return [`${asynchronyState("unstarted")} — add 'complete'.`]
		case "in-flight":
			return [
				`${asynchronyState("in-flight")} — add 'complete' to wait for what it answers with.`,
			]
		case "not-a-future":
			return [
				"Build a future to answer with: 'Async.deferred(…)', or '::map' or '::andThen' on one you already have.",
			]
		default:
			return []
	}
}

// And the same three in RETURN position, where the body is the thing to
// change and one of them reads completely differently: a body that declares a
// future and hands back a bare value has not written a future anywhere, and
// whether it completes anything is what decides what it should do about that.
export function returnAsynchronyHelps(
	expected: common.Type,
	actual: common.Type,
	completing: boolean,
): Array<string> {
	switch (asynchronyMismatch(expected, actual)) {
		case "unstarted":
			return [
				completing
					? "Add 'complete' — this body waits, so it answers with values rather than with futures."
					: "This describes work that has not run — add 'complete', which makes this a body that waits.",
			]
		case "in-flight":
			return [
				`${asynchronyState("in-flight")} — add 'complete' to wait for what it answers with.`,
			]
		case "not-a-future":
			return [
				"This body completes nothing, so it has to RETURN a future — complete something, or build one ('Async.deferred(…)', '::map', '::andThen').",
			]
		default:
			return []
	}
}

// What a position that can not suspend has to be told, per position. The
// four used to share one Note listing all four and one Help offering all three
// edits, and only one line of each was ever about the reader: a property body
// was told to complete the work "above this position", where the generated value
// it completes does not exist yet, and then to move it into a completing
// Function, which is a Future again in a position that still can not wait.
//
// A property body is the one with no edit at all — a generated value can only be
// waited on by machinery the runner does not have — so what it is offered is the
// other test form rather than a spelling that would be refused. The other three
// all reach the same answer from a different direction: the work is completed
// where waiting IS allowed, and the position reads the Constant.
//
// Here rather than in the Enricher because `complete-outside-future` is not the
// only report that stands in one of these positions. Every report that has to
// WITHHOLD the word stands in one too, and each of them used to end in "declare
// the enclosing Function '-> Future<…>'" — which a property body has not got at
// all, and which changes nothing for a Parameter's default.
export function barredCompletion(barrier: enricher.CompletionBarrier | null): {
	note: string
	helps: Array<string>
} {
	switch (barrier) {
		case "parameter-default":
			return {
				note: "A Parameter's default is filled in by the Function itself, before any of its own asynchrony begins.",
				helps: [
					"Complete the work above this Declaration, into a Constant the default reads.",
				],
			}
		case "test-name":
			return {
				note: "A test's name is worked out before the run — the whole section is walked once with no test selected, so that a '--filter' matches what a reader sees.",
				helps: [
					"Complete the work above this test, into a Constant the name reads.",
				],
			}
		case "benchmark-body":
			return {
				note: "A benchmark body is timed over many runs, and waiting for work inside it would time the waiting.",
				helps: [
					"Complete the work above the benchmark, into a Constant the body reads.",
				],
			}
		case "property-body":
			return {
				note: "A property body runs once per generated value, and nothing in a 'for any' run can wait — the value this would complete does not exist until the run that made it.",
				helps: [
					"Assert on the answer in a 'test' of its own, which is run once and awaited.",
				],
			}
		default:
			// No barrier named, which is a Scope that answered nothing at
			// all rather than one of the four. Nothing is known about the
			// position, so nothing is claimed about it.
			return {
				note: "'complete' suspends, and this position is filled in before any asynchrony around it begins.",
				helps: [],
			}
	}
}

// A Future or a Started where a value was wanted, which is the forgotten
// `complete` wearing another Diagnostic's clothes: a hole told that
// `Future<Integer>` is not Printable, an Argument told that it does not conform
// to a bound. Both are one word short, and both would otherwise send the reader
// off to make Futures Printable — which compiles, and prints a description of
// the work instead of the answer.
//
// `waits` is the caller's answer to "may this body write the word here", which is
// `completionContextOf`: a completing body and a Program's top level may, and
// every other position may not. Where it may, the Help is the shared sentence
// every other report about a forgotten `complete` uses and the payload a Quick
// Fix reads rides with it; where it may not, no Help carries the state and the
// Notes say it instead, because the edit is to the enclosing Declaration.
//
// Null for everything that is not work, which leaves each caller's own report
// exactly as it was.
export function unwaitedWorkReport(
	type: common.Type,
	waits: boolean,
	// And which of the four barriers said no, where one did — see
	// `barredCompletion`. Null is an ordinary body that answers something other
	// than a Future, whose edit is to its own Declaration.
	barrier: enricher.CompletionBarrier | null = null,
): {
	notes: Array<string>
	helps: Array<string>
	data?: common.DiagnosticData
} | null {
	if (type.type !== "Future" && type.type !== "Started") {
		return null
	}

	let state = asynchronyState(
		type.type === "Future" ? "unstarted" : "in-flight",
	)
	let barred = barredCompletion(barrier)

	return {
		notes: [
			`${waits ? "" : `${state} — `}${describeType(
				type.valueType,
			)} is what ${withArticle(
				describeType(type),
			)} answers with, once something waits for it.`,
			...(waits
				? []
				: [
						barrier === null
							? "'complete' only stands in a body that answers a Future, and this position is not one."
							: barred.note,
					]),
		],
		helps: waits
			? asynchronyHelps(type.valueType, type)
			: barrier === null
				? [
						"Declare the enclosing Function '-> Future<…>', which is what lets its body wait, and add 'complete' where the value is read.",
					]
				: barred.helps,
		...(waits ? { data: asynchronyData(type.valueType, type) } : {}),
	}
}
