import * as path from "node:path"

import type { common, enricher } from "@essence-lang/interfaces"

import { primary, secondary } from "../diagnostics/index"
import { eraseRefinements } from "./eraseRefinements"
import { closestMatch } from "./suggest"
import {
	type AsynchronyMismatch,
	asynchronyMismatch,
	choiceArgumentBounds,
	decidesAnUndecidedSlot,
	flattenUnionMembers,
	genericNamesMentioned,
	matchesType,
} from "./types"
import { removalEvidence, undeclaredMembers } from "./undeclaredMembers"

// The name a Generic is shown under. `createFreshenedInference` renames a
// callee's Generics per call to the name, a zero-width space and a counter, and
// `borrowedGenericName` appends the space alone. An unbound one keeps that name
// in the stamped Types. No written Generic holds a zero-width space, so
// stripping it touches nothing written.
export function displayGenericName(name: common.GenericName): string {
	return name.replace(/\u200B\d*$/, "")
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

// The nominal identity of a Protocol, by the Choice rule. One declared below
// its Program's top level also carries its name's Position, since it may shadow
// another of its name in the same Module.
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

// The name the reading file writes a declaration under, given its declared
// name and a Type carrying it. Null where the file binds it under no name. See
// "Spelling a name for the reader" in DEVELOPMENT.md.
export type Spelling = (declared: string, type: common.Type) => string | null

export const declaredSpelling: Spelling = (declared) => declared

// The name to write for a Case's Choice, the declared one where the reader
// binds none.
export function spellChoiceName(
	type: common.CaseType,
	spell: Spelling,
): string {
	return written(spell, displayChoiceName(type.choice), type)
}

// The name to write, the declared one where the reader binds none.
function written(
	spell: Spelling,
	declared: string,
	carrier: common.Type,
): string {
	return spell(declared, carrier) ?? declared
}

// Whether a name binding `bound` binds the declaration `carrier` names under
// `declared`. A Choice is told by the identity its Cases carry, since two
// Modules may each declare a `Box`. Any other declaration is told by its name.
export function bindsDeclaration(
	bound: common.Type,
	declared: string,
	carrier: common.Type,
): boolean {
	let identity = choiceCarried(carrier)

	return (
		isDeclaration(bound) &&
		(identity === null
			? declaredNameOf(bound) === declared
			: choiceCarried(bound) === identity)
	)
}

// Whether a Type is a declaration rather than one application of one. A
// Generic Alias of a Choice under another name is an application, since
// `type Flipped<A, B> = Pair<B, A>` orders its Type Parameters its own way. An
// import alias keeps the Choice's own name on the Alias.
export function isDeclaration(type: common.Type): boolean {
	switch (type.type) {
		case "GenericAlias":
			return declaredNameOf(type) === type.name
		case "UnionType":
		case "Record":
			return type.alias === undefined
		default:
			return true
	}
}

// The name a Type was declared under, or null for one declared under none.
export function declaredNameOf(type: common.Type): string | null {
	let identity = choiceCarried(type)

	if (identity !== null) {
		return displayChoiceName(identity)
	}

	switch (type.type) {
		case "GenericAlias":
		case "Refinement":
			return type.name
		case "Record":
		case "UnionType":
			return type.name ?? type.alias?.name ?? null
		default:
			return null
	}
}

// The identity of the Choice a Type is, or one of its Cases or applications
// is, or null.
export function choiceCarried(type: common.Type): string | null {
	if (type.type === "GenericAlias") {
		return choiceCarried(type.aliasedType)
	}

	if (type.type === "Case") {
		return type.choice
	}

	if (type.type !== "UnionType") {
		return null
	}

	let members = flattenUnionMembers(type)
	let first = members[0]

	return first?.type === "Case" &&
		members.every(
			(member) =>
				member.type === "Case" && member.choice === first.choice,
		)
		? first.choice
		: null
}

// The reader's spelling from a typed Program alone, as after enrichment: the
// names its import entries and top-level Choices bind. A name the Program
// declares itself is its own, since only a Choice's identity tells two
// Modules' declarations apart. A Choice of another Module that nothing here
// binds answers null, and so does any other name where `strict` asks.
export function programSpelling(
	program: common.typed.Program,
	strict = false,
): Spelling {
	let imported = (program.imports?.entries ?? []).flatMap((entry) =>
		entry.type === null
			? []
			: [{ name: entry.alias ?? entry.name, type: entry.type }],
	)
	let choices = program.implementation.nodes.flatMap((node) =>
		node.nodeType === "ChoiceDeclarationStatement"
			? [{ name: node.name.content, type: node.type }]
			: [],
	)
	let declaredHere = new Set(
		program.implementation.nodes.flatMap((node) =>
			node.nodeType === "TypeAliasStatement" ? [node.name.content] : [],
		),
	)

	return (declared, carrier) => {
		let identity = choiceCarried(carrier)

		if (identity === null) {
			return declaredHere.has(declared)
				? declared
				: (imported.find((binding) =>
						bindsDeclaration(binding.type, declared, carrier),
					)?.name ?? (strict ? null : declared))
		}

		if (!identity.includes("#")) {
			return declared
		}

		return (
			[...imported, ...choices].find((binding) =>
				bindsDeclaration(binding.type, declared, carrier),
			)?.name ?? null
		)
	}
}

// A Type on one line, as a Diagnostic names it: the spelling a reader knows
// from their source. `printType` is the hover's form.
export function describeType(type: common.Type): string {
	return spellType(type, declaredSpelling)
}

// The conjunction a written receiver proves where no declared refinement
// covers it, named as its declaration would read, `String where …`. See
// "Written receivers" in packages/compiler/src/enricher/DEVELOPMENT.md.
function isReceiverConjunction(type: common.RefinementType): boolean {
	return type.receiverConjunction === true
}

// `describeType`, with every declared name as `spell` writes it.
export function spellType(type: common.Type, spell: Spelling): string {
	let described = (inner: common.Type) => spellType(inner, spell)

	switch (type.type) {
		case "UnionType":
			if (type.name !== undefined) {
				return written(spell, type.name, type)
			}

			if (type.alias !== undefined) {
				return `${written(spell, type.alias.name, type)}<${type.alias.typeArguments
					.map(described)
					.join(", ")}>`
			}

			return type.types.map(described).join(" | ")
		case "Case":
			return `${spellCaseChoice(type, spell)}#${type.name}`
		// A refinement is named, not spelled out, and an applied one with all
		// its Arguments, even Type Parameters. A bare `NonEmptyList` is not a
		// Type a reader can write. No reader declared a written receiver's
		// conjunction, so it is named by the base the reader wrote.
		case "Refinement":
			if (isReceiverConjunction(type)) {
				return described(type.base)
			}

			return type.typeArguments === undefined
				? written(spell, type.name, type)
				: `${written(spell, type.name, type)}<${type.typeArguments
						.map(described)
						.join(", ")}>`
		case "List":
			return `List<${described(type.itemType)}>`
		case "GenericList":
			return "List"
		case "Future":
			return `Future<${described(type.valueType)}>`
		case "Started":
			return `Started<${described(type.valueType)}>`
		case "Dictionary":
			return `Dictionary<${described(type.keyType)}, ${described(
				type.valueType,
			)}>`
		case "GenericDictionary":
			return "Dictionary"
		// A Record reached through an Alias is named, as a Union is, and
		// `describeRecordShape` spells out members where a mismatch needs them.
		// `describeType` gives the declaring file's name, even where an import
		// renamed it.
		case "Record":
			if (type.name !== undefined) {
				return written(spell, type.name, type)
			}

			if (type.alias !== undefined) {
				return `${written(spell, type.alias.name, type)}<${type.alias.typeArguments
					.map(described)
					.join(", ")}>`
			}

			return spellRecordShape(type, spell)
		case "Function":
		case "SimpleMethod":
		case "StaticMethod":
			return spellFunctionSignature(type, spell)
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

// What a report calls a Type that no Type Annotation can spell and nothing
// stands in for, or null for any other. That is an Overload set, since no
// Namespace is a value. A Case has no spelling either, but its Choice has one,
// and callers offer that edit first. A Function Type can be spelled.
export function unnameableTarget(type: common.Type): string | null {
	return type.type === "OverloadedMethod" ||
		type.type === "OverloadedStaticMethod"
		? "an overloaded Function"
		: null
}

// Why no Namespace is offered for the Type, or null where one can be.
export function unnameableTargetNote(type: common.Type): string | null {
	let target = unnameableTarget(type)

	return target === null
		? null
		: `No Namespace can be declared for ${target} — no Type Annotation can spell it, so no 'for' clause can name it.`
}

// A Namespace's head for the Type, written after `name`, as a Help spells it. A
// Type Parameter the Type mentions is not in scope where the Namespace stands,
// so the head declares it: `<infer T> for (_: T) -> T`.
export function namespaceHead(
	type: common.Type,
	name: string = "",
	spell: Spelling = declaredSpelling,
): string {
	let parameters = [...genericNamesMentioned(type)].map(
		(parameter) => `infer ${displayGenericName(parameter)}`,
	)
	let target = `for ${spellType(type, spell)}`

	if (parameters.length > 0) {
		return `${name}<${parameters.join(", ")}> ${target}`
	}

	return name === "" ? target : `${name} ${target}`
}

// The `where` clause a Namespace for the Type needs on its conformance, or
// nothing. A Type Parameter it infers in a bounded position of an applied Choice
// carries that bound. One a Function only mentions carries none.
export function namespaceWhere(
	type: common.Type,
	parametersOf: (choice: string) => Array<common.GenericDeclaration>,
	// The name the reader's file binds a bound's Protocol under.
	spellBound: (identity: string) => string = displayProtocolName,
): string {
	let conditions = [
		...choiceArgumentBounds(
			type,
			genericNamesMentioned(type),
			parametersOf,
		),
	].map(
		([name, bound]) =>
			`${displayGenericName(name)} is ${spellBound(bound)}`,
	)

	return conditions.length === 0 ? "" : ` where ${conditions.join(", ")}`
}

// A member Type as a `case` writes it. A Case Matcher takes no Type Arguments
// and covers every application of its Case, so a Case is spelled without them.
// A Case of a Choice the reader has no name for is written bare, since a bare
// Case resolves against the matched value. Where another of `members` shares
// its name, nothing can be written, and the answer is null. A refinement is no
// Matcher, so its base is written.
export function spellMatcher(
	type: common.Type,
	spell: Spelling,
	members: ReadonlyArray<common.Type> = [],
): string | null {
	if (type.type !== "Case") {
		return spellType(eraseRefinements(type), spell)
	}

	let name = spell(displayChoiceName(type.choice), type)
	let shared = members.some(
		(member) =>
			member.type === "Case" &&
			member.name === type.name &&
			member.choice !== type.choice,
	)

	if (name !== null) {
		return `${name}#${type.name}`
	}

	return shared ? null : `#${type.name}`
}

// A Type spelled without the names its declarations gave it, as a Matcher a
// reader can write in any Module. Null where it holds a part that can not be
// spelled so.
export function spellShape(type: common.Type): string | null {
	switch (type.type) {
		case "Integer":
		case "Rational":
		case "String":
		case "Boolean":
			return type.type
		case "Refinement":
			return spellShape(type.base)
		case "List": {
			let item = spellShape(type.itemType)

			return item === null ? null : `List<${item}>`
		}
		case "Dictionary": {
			let key = spellShape(type.keyType)
			let value = spellShape(type.valueType)

			return key === null || value === null
				? null
				: `Dictionary<${key}, ${value}>`
		}
		case "Record": {
			let members = Object.entries(type.members).map(
				([name, memberType]) => {
					let shape = spellShape(memberType)

					return shape === null ? null : `${name}: ${shape}`
				},
			)

			if (members.includes(null)) {
				return null
			}

			return members.length === 0 ? "{}" : `{ ${members.join(", ")} }`
		}
		default:
			return null
	}
}

// The Choice a Case belongs to, applied as `Box<Integer>` where the Case carries
// the Type Arguments an application bound.
export function describeCaseChoice(type: common.CaseType): string {
	return spellCaseChoice(type, declaredSpelling)
}

export function spellCaseChoice(
	type: common.CaseType,
	spell: Spelling,
): string {
	let choiceName = spellChoiceName(type, spell)

	return type.typeArguments === undefined
		? choiceName
		: `${choiceName}<${type.typeArguments
				.map((typeArgument) => spellType(typeArgument, spell))
				.join(", ")}>`
}

// The prefixes that pick among the Cases a bare `#Case` could mean, and whether
// each still needs Type Arguments written. Two applications of one Choice
// differ only in their Type Arguments, so where `applied` holds they are named
// with them, as a construction can write. A Case Matcher writes none and covers
// every application, so otherwise each Choice is one prefix.
export function caseCandidatePrefixes(
	candidates: Array<common.CaseType>,
	applied: boolean,
	spell: Spelling = declaredSpelling,
	// The prefix for a candidate whose Choice is written another way, as
	// through a generic Alias, or null.
	written: (
		candidate: common.CaseType,
	) => { name: string; generic: boolean } | null = () => null,
): Array<{ name: string; generic: boolean }> {
	return candidates.flatMap((candidate) => {
		let sameChoice = candidates.filter(
			(other) => other.choice === candidate.choice,
		)

		if (!applied && sameChoice[0] !== candidate) {
			return []
		}

		return [
			written(candidate) ?? {
				name:
					applied && sameChoice.length > 1
						? spellCaseChoice(candidate, spell)
						: spellChoiceName(candidate, spell),
				generic: candidate.choiceGenerics !== undefined,
			},
		]
	})
}

// What `ambiguous-case` says beside its Helps, given how many prefixes they
// offer. Two applications of one Choice are one declaration, so there the
// report counts applications rather than Choices.
export function ambiguousCaseWording(
	caseName: string,
	candidates: Array<common.CaseType>,
	where: string,
	prefixes: number,
	spell: Spelling = declaredSpelling,
): { message: string; label: string; notes: Array<string> } {
	let declaring = [
		...new Map(
			candidates.map((candidate) => [candidate.choice, candidate]),
		).values(),
	].map((candidate) => spellChoiceName(candidate, spell))
	let notes = declaring.map(
		(choiceName) => `'${choiceName}' declares '#${caseName}'.`,
	)

	if (declaring.length === 1) {
		return {
			message: `Case '#${caseName}' fits more than one application of '${declaring[0]}'`,
			label: `${countOf(prefixes, "application")} of '${declaring[0]}' ${where} have it`,
			notes,
		}
	}

	return {
		message: `Case '#${caseName}' is declared by more than one Choice`,
		label: `${countOf(declaring.length, "Choice")} ${where} declare it`,
		notes,
	}
}

// Why the runtime can not tell two dispatch branches' member Types apart. Two
// applications of one Case differ only in their Type Arguments. Any other pair
// is answered as Functions, whose Signatures do not reach the runtime.
export function erasedDispatchEvidence(
	earlier: common.Type,
	later: common.Type,
	spell: Spelling = declaredSpelling,
): { note: string; help: string } {
	if (
		earlier.type === "Case" &&
		later.type === "Case" &&
		earlier.choice === later.choice
	) {
		return {
			note: `${spellType(earlier, spell)} and ${spellType(later, spell)} differ only in their Type Arguments, which do not survive to runtime.`,
			help: `Write the receiver's Type as one application of '${spellChoiceName(earlier, spell)}'.`,
		}
	}

	return {
		note: "A Function's Signature does not survive to be checked — a member Type naming a callback is only ever asked whether the value is callable, which makes two of them ask the same question.",
		help: "Tell the two member Types apart by something that survives to runtime — a member whose Type is not a Function.",
	}
}

// A function Type as a Type Annotation spells it, `(_: Integer) -> Integer`,
// with labels but no internal names. A Method named rather than called shows
// its receiver as the first Parameter.
function spellFunctionSignature(
	functionType: common.BaseFunction,
	spell: Spelling,
): string {
	let parameters = functionType.parameterTypes
		.map(
			(parameter) =>
				`${parameter.name ?? "_"}: ${spellType(parameter.type, spell)}`,
		)
		.join(", ")

	return `(${parameters}) -> ${spellType(functionType.returnType, spell)}`
}

// A Record with its members spelled out, whatever it is called, for a
// mismatch about members. An empty Record is `{}`.
export function describeRecordShape(type: common.RecordType): string {
	return spellRecordShape(type, declaredSpelling)
}

function spellRecordShape(type: common.RecordType, spell: Spelling): string {
	let members = Object.entries(type.members).map(
		([memberName, memberType]) =>
			`${memberName}: ${spellType(memberType, spell)}`,
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

// For Diagnostics: "an Integer", "a User", "an XMLNode". The article follows the
// sound of the first word. See "Articles" in DEVELOPMENT.md.
export function withArticle(description: string): string {
	return `${articleFor(description)} ${description}`
}

function articleFor(description: string): "a" | "an" {
	// A capital with no lowercase letter right after it is read by its name,
	// as in an acronym or a Type Parameter.
	if (/^[A-Z](?![a-z])/.test(description)) {
		return /^[AEFHILMNORSX]/.test(description) ? "an" : "a"
	}

	let word = (/^[A-Za-z][a-z]*/.exec(description)?.[0] ?? "").toLowerCase()

	if (/^(?:hour|honest|honou?r|heir)/.test(word)) {
		return "an"
	}

	if (/^(?:uni|u[^aeioun][aeiou]|eu|one$|once$)/.test(word)) {
		return "a"
	}

	return /^[aeiou]/.test(word) ? "an" : "a"
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

// A Type with each blank an empty Literal left filled in. A Type that had to be
// made up is reported, so a Help offers the spelling as an example.
export function decidedSlots(type: common.Type): {
	spelling: string
	invented: boolean
} {
	let invented = { any: false }

	return {
		spelling: describeType(spelledWithDecidedSlots(type, null, invented)),
		invented: invented.any,
	}
}

// The Help for a receiver whose Type an empty Literal left undecided, spelled
// from that Type.
export function receiverAnnotationHelp(type: common.Type): string {
	let { spelling, invented } = decidedSlots(type)

	return `Annotate what the receiver comes from with '${spelling}'${invented ? ", for instance," : ""} so its Type is decided before the call.`
}

// The Help that writes a call's value out where no Argument decides its Type,
// with each undecided Type as '…'. Only a Type with an empty Literal has one.
export function writtenValueHelps(answer: common.Type): Array<string> {
	let literal =
		answer.type === "List"
			? "[]"
			: answer.type === "Dictionary"
				? "[=]"
				: answer.type === "UnionType" &&
					  (answer.name === "Optional" ||
							answer.alias?.name === "Optional")
					? "#Empty"
					: null

	return literal === null
		? []
		: [
				`Or write the value itself, with the Type it answers written out — 'constant value: ${describeType(answer)} = ${literal}', with the Type you mean in place of each '…'.`,
			]
}

// #region Record mismatches

// What a mismatch between two Records says instead of printing both: the
// members that disagree, and those nobody wrote. Empty for any other mismatch.
// See "Record mismatches" in DEVELOPMENT.md.
export type RecordMismatchEvidence = {
	// The Label the report leads with, at the Position the Diagnostic takes. Null
	// where nothing written can be pointed at.
	lead: common.DiagnosticLabel | null
	labels: Array<common.DiagnosticLabel>
	notes: Array<string>
	helps: Array<string>
	// For the fix that writes a near miss over the misspelled name, carried only
	// where exactly one member is misspelled.
	data: common.DiagnosticData | undefined
}

// How many disagreeing members get a Label, and how many more get a note.
const labelledMembers = 3
const notedMembers = 6

type MemberDifference = {
	// The member's path from the outermost Record, such as `team.code`, for the
	// sentences alone.
	path: string
	// Where the member's value was written, or null outside a Literal and for a
	// note alone. Only the levels a dotted key built carry a name's Position, in
	// `memberPositions`.
	position: common.Position | null
	label: string
	note: string
	// On a member the Record does not declare, the name a fix would write over it.
	suggestion?: string
}

export function recordMismatchEvidence(
	expected: common.Type,
	written: common.Type,
	value: common.typed.ExpressionNode | null,
	options: {
		// Members a default fills in, which are never missing. `partial` lets any
		// member be left out, as an update or a payload default may.
		filled?: ReadonlyArray<string>
		partial?: boolean
		// What the sentences call the expected Record where it has no Alias, such as
		// `'#Get'` for a Case's payload. Top level only.
		subject?: string
		// Set where a Literal may name only declared members, as an Argument and a
		// payload may. See "Undeclared members" in DEVELOPMENT.md.
		refusesUndeclared?: boolean
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
	let refuses = options.refusesUndeclared === true
	let differences = memberDifferences(
		target.shape,
		source,
		literal,
		"",
		subject,
		refuses,
	)
	let missing = missingMemberNames(target.shape, source, differences, options)

	if (differences.length === 0 && missing.length === 0) {
		return emptyRecordMismatch()
	}

	let labelled = differences
		.slice(0, labelledMembers)
		.filter((difference) => difference.position !== null)
	let noted = differences.filter(
		(difference) => !labelled.includes(difference),
	)
	let listed = noted.slice(0, notedMembers)
	let [lead, ...rest] = labelled
	let misspelled = differences.filter(
		(difference) => difference.suggestion !== undefined,
	)
	let removal = refuses
		? removalEvidence(
				target.shape,
				literal,
				misspelled.map((difference) => difference.path),
			)
		: { helps: [], data: undefined }
	// A refusal only about members nobody wrote points at the Literal itself, and
	// its Label names them, so no note repeats them.
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
			// Which arm the differences are measured against, where the position holds
			// more than one Record.
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
		helps: [
			...(misspelled.length === 1
				? [`Did you mean '${misspelled[0]!.suggestion}'?`]
				: []),
			...removal.helps,
		],
		data:
			misspelled.length === 1 && misspelled[0]!.position !== null
				? {
						kind: "record-member",
						member: lastStep(misspelled[0]!.path),
						suggestion: misspelled[0]!.suggestion as string,
					}
				: removal.data,
	}
}

function emptyRecordMismatch(): RecordMismatchEvidence {
	return { lead: null, labels: [], notes: [], helps: [], data: undefined }
}

// The members nobody wrote as one clause, punctuated by the Label or note that
// takes it.
function missingClause(missing: Array<string>): string {
	return missing.length === 1
		? `'${missing[0]}' is missing`
		: `${missing.map((name) => `'${name}'`).join(", ")} are missing`
}

// The Record inside a Type, or null. A refinement is looked through: its
// predicate is refused apart, by `refinementEvidence`.
function recordShapeOf(type: common.Type): common.RecordType | null {
	while (type.type === "Refinement") {
		type = type.base
	}

	return type.type === "Record" ? type : null
}

// The arm of a Union of Records the value is closest to, and how many Record
// arms there are. Fewest differences wins, and the first arm on a tie.
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

// Every member the value writes that the Record does not take, in written
// order, walking into nested Literals. See "Record mismatches" in DEVELOPMENT.md.
function memberDifferences(
	target: common.RecordType,
	source: common.RecordType,
	literal: common.typed.RecordValueNode | null,
	prefix: string,
	subject: string,
	refusesUndeclared = false,
): Array<MemberDifference> {
	let differences: Array<MemberDifference> = []

	for (let [name, writtenType] of Object.entries(source.members)) {
		let path = `${prefix}${name}`
		let position = memberPosition(literal, name)

		if (!Object.hasOwn(target.members, name)) {
			// Only declared members the value has not written are candidates, since
			// suggesting a written one makes the fix a `duplicate-member`.
			let suggestion = closestMatch(
				name,
				Object.keys(target.members).filter(
					(declared) => !Object.hasOwn(source.members, declared),
				),
			)

			differences.push({
				path,
				position,
				// The Label says what is wrong and the Help gives the near miss, as for
				// `unknown-member`. A note past the Labels carries both.
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

		// A nested Literal that fits may still name a member its Type does not
		// declare, where the position refuses that.
		if (
			matchesType(declaredType, writtenType) &&
			!(
				refusesUndeclared &&
				undeclaredMembers(declaredType, literal?.members[name]).length >
					0
			)
		) {
			continue
		}

		let nested = nestedDifferences(
			declaredType,
			writtenType,
			literal,
			name,
			path,
			refusesUndeclared,
		)

		if (nested !== null) {
			differences.push(...nested)

			continue
		}

		// The Label names the member where its Position is the whole Literal's, as in
		// the shorthand `#Circle({ radius = "big" })`.
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

// The differences one step further in. Null where the member is not a Record
// Literal on both sides, or where the nested Literal differs in nothing its
// members explain. The members it leaves out are one more difference, placed
// as the top level places them.
function nestedDifferences(
	declaredType: common.Type,
	writtenType: common.Type,
	literal: common.typed.RecordValueNode | null,
	name: string,
	path: string,
	refusesUndeclared: boolean,
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
		refusesUndeclared,
	)
	let missing = missingMemberNames(target, source, nested, {})

	if (missing.length === 0) {
		return nested.length === 0 ? null : nested
	}

	let clause = missingClause(missing.map((missed) => `${path}.${missed}`))

	return [
		...nested,
		{
			path,
			// A Label on the nested Literal only where nothing inside it has one.
			position:
				nested.length === 0 ? memberPosition(literal, name) : null,
			label: clause,
			note: `${clause}.`,
		},
	]
}

// The members the Record declares and the value does not write. None for a
// partial position or a member a default fills in, as in `missingRecordMembers`,
// nor for one a misspelling accounts for.
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

// Where a member of a written Literal stands: the key's Position on a level a
// dotted key built, otherwise the value's, as `reportUnmergedPathKey` reads them.
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

// What the sentences call the Record a value was measured against: its Alias, or
// what the position calls it, such as "the declared return Type". Never its shape.
function recordSubject(type: common.RecordType, written?: string): string {
	if (type.name !== undefined || type.alias !== undefined) {
		return describeType(type)
	}

	return written ?? "the expected Record"
}

// The member a path ends at, which is the name a fix writes over.
function lastStep(path: string): string {
	return path.slice(path.lastIndexOf(".") + 1)
}

// #endregion

// The Method a value of this Type answers a Boolean question with, for a
// Condition or a `where` clause that answers a value. `::is(…)` is the fallback,
// but an Optional, a String, a List and a number each have a better one.
export function booleanQuestionFor(type: common.Type): string {
	if (type.type === "Refinement") {
		return booleanQuestionFor(type.base)
	}

	// An Optional arrives as its Union, named `Optional` directly or as the Alias of
	// an applied `Optional<Integer>`.
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

// The state of the work, in the clause every report about a forgotten
// `complete` opens with.
export function asynchronyState(mismatch: AsynchronyMismatch): string {
	return mismatch === "unstarted"
		? "This describes work that has not run"
		: "This is still in flight"
}

// The asynchrony mismatch as data, which a Quick Fix reads in place of a Help's
// wording. `not-a-future` carries none, since building a future is a judgement.
export function asynchronyData(
	expected: common.Type,
	actual: common.Type,
	// The fix writes `complete`, so it is withheld where the word would be refused.
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

// The Helps for a mismatch that is one word about asynchrony short, as
// `asynchronyMismatch` decides, in a position where the value is what to change.
export function asynchronyHelps(
	expected: common.Type,
	actual: common.Type,
	// Whether the body around this position may write `complete`. Where it may
	// not, the Help reaches through with `::map` or makes the body one that waits.
	canWait: boolean = true,
	// The barrier that refused the word, if any, whose own edit the Help then
	// names, since such a position has no enclosing Function to declare.
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

// The same Helps in return position, where the body is what to change. A body
// that completes nothing must return a future it builds.
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

// The note and Helps for each position that can not suspend. Each but a property
// body completes the work earlier, into a Constant the position reads. A property
// body is offered a `test` of its own, since nothing in a `for any` run can wait.
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
			// No barrier named, so nothing is claimed about the position.
			return {
				note: "'complete' suspends, and this position is filled in before any asynchrony around it begins.",
				helps: [],
			}
	}
}

// The notes and Helps for a Future or a Started where a value was wanted, such
// as a hole that needs a Printable value. Null for anything that is not work.
// `waits` says whether the body may write `complete`, from `completionContextOf`.
export function unwaitedWorkReport(
	type: common.Type,
	waits: boolean,
	// The barrier that refused the word, as in `barredCompletion`. Null for an
	// ordinary body, whose edit is to its own Declaration.
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
