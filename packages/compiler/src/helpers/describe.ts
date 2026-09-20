import type { common } from "@essence-lang/interfaces"

import { primary, secondary } from "../diagnostics/index"
import { closestMatch } from "./suggest"
import {
	type AsynchronyMismatch,
	asynchronyMismatch,
	decidesAnUndecidedSlot,
	flattenUnionMembers,
	matchesType,
} from "./types"

// NOTE: The spelling a Generic is SHOWN under. `createFreshenedInference`
// alpha-renames a callee's Generics for the span of one invocation — `T`
// becomes `T`, a zero-width space and a counter — and a Generic that never
// binds stays under that fresh name in the Types stamped onto the Argument
// Nodes, which is where Hover and Inlay Hints read their Types back from: the
// reader is shown `T117`, since only the separator is invisible. Stripped
// where a name is rendered rather than un-freshened in the Types themselves,
// so the fresh name stays the collision-proof symbol inference needs it to
// be. A source Generic can not carry a zero-width space — the assumption the
// freshening itself rests on — so nothing a Program spells is touched.
export function displayGenericName(name: common.GenericName): string {
	return name.replace(/\u200B\d+$/, "")
}

// NOTE: The nominal identity of a Choice — what tells two Modules' same-named
// Choices apart, and the whole of what `matchTypes` compares a Case by. It is
// the Module's canonical path and the name the declaration wrote, because the
// path alone would join every Choice in one file and the name alone joins the
// two files. The path rather than anything entry-relative: a file reached from
// two entries must not split into two Types, and the Language Server's index
// has no entry at all.
// `modulePath` is null for a Program that is no Module — a single file compile
// and every standard library file identify a Choice by its bare name, which is
// the spelling every emitted tag, `__golden__` file and Diagnostic has carried
// since before Modules.
export function choiceIdentity(
	modulePath: string | null,
	name: string,
): string {
	return modulePath === null ? name : `${modulePath}#${name}`
}

// NOTE: The Choice name a reader wrote, recovered from the identity above:
// everything after the LAST separator, since a Module path may well contain one
// and a Choice's name can not. Every site that PRINTS a Choice goes through
// here — a Diagnostic, Hover or Completion naming the path would be naming
// something the source does not say.
export function displayChoiceName(identity: string): string {
	return identity.slice(identity.lastIndexOf("#") + 1)
}

// NOTE: The Type Arguments an applied refinement is spelled with in a HOVER, or
// null when the bare Alias name says everything. A non-generic refinement carries
// none at all, and an instantiation that bound every Parameter to a Parameter —
// the one a generic Namespace makes of its own target — would only echo the
// header, so it stays terse. The same rule `caseHeader` reads a Case's Arguments
// by, for the same reason and with the same wording.
//
// A DIAGNOSTIC can not be terse this way: it names a Type the reader is asked to
// do something about, and `describeType` spells the Arguments out for that reason
// — see its own NOTE.
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

// NOTE: A compact, one-line description of a Type for Diagnostics — the
// spelling a reader would recognise from their own source, not the internal
// Type tag. `printType` in the Language Server is its Hover-oriented sibling;
// this one is what every Diagnostic message names a Type with.
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
		// NOTE: A checked refinement is named, never spelled out — the reader
		// wrote `NonZeroInteger`, and `Integer where @::isNot(0)` is the
		// Declaration rather than the Type a Diagnostic is about. An applied
		// generic one is named as it was applied: a message about `NonEmptyList` where
		// the reader wrote `NonEmptyList<String>` names half a Type.
		//
		// Which holds just as much where the Arguments are Type PARAMETERS. The
		// Hover's terser rule drops those, and a Diagnostic must not: it names a
		// Type the reader is asked to write, check or pass a value of, and
		// 'NonEmptyList' is not one — a Program spelling it bare is refused for
		// taking no Arguments. So an applied refinement is spelled as applied,
		// whatever it was applied TO, and only a refinement that takes no Arguments
		// at all spells as its name alone.
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
		// NOTE: A Record reached through an Alias is named, on the rule a Union
		// is named by and for the reason a message about nine members spelled
		// out is no message at all: a reader asked to act on a `Standing` is
		// asked about the Declaration they wrote, not about its shape. What the
		// members ARE is the mismatch report's business — `describeRecordShape`
		// is what spells one out, and a mismatch between two Records says which
		// member differs rather than printing either.
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
		// NOTE: An Overload set has no ONE signature to print, and spelling
		// every Overload out would drown the message it sits in — it stays the
		// bare word. A Diagnostic that has an Overload set in hand names the
		// Overloads itself, as per-candidate notes.
		case "OverloadedMethod":
		case "OverloadedStaticMethod":
			return "Function"
		case "Namespace":
			return `Namespace '${type.name}'`
		case "GenericUse":
		case "GenericAlias":
			return displayGenericName(type.name)
		// NOTE: The poison Type is not a Type a Program can hold, write or be
		// told about — it is the Compiler's marker for a position it has
		// nothing to say about, either because the mistake there was already
		// reported or because nothing bound the Type Parameter that stood
		// here. Printing its internal tag put the word `Error` into a message
		// about a Program that declares no such Type: `Result<Integer, String>
		// | Result<Error, Integer>` is what a mismatched nested `flatten`
		// rendered as. The ellipsis says what the slot really holds, which is
		// nothing this Diagnostic knows. `printType`, the Hover's sibling,
		// keeps the tag: it is read by the Compiler's own tests as the evidence
		// that a value WAS poisoned.
		case "Error":
			return "…"
		default:
			return type.type
	}
}

// NOTE: A function-ish Type spelled the way a Type Annotation spells it —
// `(_: Integer) -> Integer`, a labelled Parameter under its label. The bare
// word "Function" named every one of them alike, which made a mismatch read as
// "this is a Function, and it is declared as Function"; the signature is the
// part that differs, so it is the part a Diagnostic has to show. The internal
// name a Declaration may write (`_ x: Integer`) documents the Parameter and is
// not part of the Type, so it can not be printed back.
// A Method NAMED rather than called carries its receiver as the first
// Parameter (see `matchTypes`), and it is printed there — that receiver is
// exactly what makes it not fit a Function of one Argument fewer.
function describeFunctionSignature(functionType: common.BaseFunction): string {
	let parameters = functionType.parameterTypes
		.map(
			(parameter) =>
				`${parameter.name ?? "_"}: ${describeType(parameter.type)}`,
		)
		.join(", ")

	return `(${parameters}) -> ${describeType(functionType.returnType)}`
}

// NOTE: A Record with its members spelled out, whatever it is called — the
// descriptive form `printCaseWithPayload` is for a Case, and the one place a
// named Record still shows its shape: a mismatch is about the members, and a
// report that answered `Standing` on both sides would name the difference
// nowhere. An empty Record is `{}` rather than `{  }`.
export function describeRecordShape(type: common.RecordType): string {
	let members = Object.entries(type.members).map(
		([memberName, memberType]) =>
			`${memberName}: ${describeType(memberType)}`,
	)

	return members.length === 0 ? "{}" : `{ ${members.join(", ")} }`
}

// NOTE: A Parameter is identified by its label where it has one, and by its
// place in the signature where it does not — `_ value: Integer` is written
// without a label on purpose, and inventing one for the Diagnostic would name
// something the reader can not find in the source.
export function describeParameter(
	parameter: common.Parameter | undefined,
	index: number,
): string {
	return parameter?.name != null
		? `Parameter '${parameter.name}'`
		: `Parameter ${index + 1}`
}

// NOTE: How many Arguments a call MUST write — the count a Parameter carrying a
// default no longer adds to. Asked by every report of a call's shape and by
// Signature Help, which is why it is one function rather than a `filter` spelled
// out at each of them.
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

// NOTE: The last Parameter a call has to write, and `-1` when there is none —
// which is where the TRAILING run a call may leave out entirely begins. A
// defaulted Parameter with a required one AFTER it is not in that run: the
// Argument following it still has to be written, and its own label is what
// steps over the default.
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

// NOTE: A signature with defaults accepts a RANGE of Argument counts — "takes 1
// or 2 Arguments", "takes 2 to 4 Arguments" — and each Parameter that may be
// left out says so in its own clause. This one string is what
// `argument-count-mismatch`, `argument-label-mismatch`, `argument-type-mismatch`
// and every `no-matching-overload` note read, so a signature reads the same way
// wherever a call is judged against it.
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

// NOTE: "no Arguments" reads as an absence, so the low end of a range spells it
// as the number it is — "0 to 2 Arguments" — and only an exact zero gets the
// word.
export function describeArgumentCount(required: number, total: number): string {
	if (required === total) {
		return countOf(total, "Argument")
	}

	if (required + 1 === total) {
		return `${required} or ${total} Arguments`
	}

	return `${required} to ${total} Arguments`
}

// NOTE: For Diagnostics — "1 Argument", not "1 Arguments".
export function countOf(count: number, singular: string): string {
	return count === 1 ? `1 ${singular}` : `${count} ${singular}s`
}

// NOTE: For Diagnostics — "this is an Integer", not "this is a Integer".
// Type names are the only thing this is ever applied to, and they are always
// spelled out, so the vowel rule needs no exceptions.
export function withArticle(description: string): string {
	return /^[AEIOU]/i.test(description)
		? `an ${description}`
		: `a ${description}`
}

// NOTE: Which container inside `expected` holds the blank a Diagnostic is about
// — the first one found, because one is all a Diagnostic says a sentence about. A
// slot is the item Type of a List or either half of a Dictionary left `Unknown`,
// which in a Program only ever comes from `[]` or `[=]`: `Unknown` is
// unspellable, so there is nothing else for one to be.
//
// `written` is the Type that was REFUSED, and what it is for is to keep the
// sentence about the blank that did the refusing. Looking at the expected side
// alone said it about refusals that had nothing to do with one: `box = { items =
// [1], others = [] }`, over a `box` whose `items` an earlier assignment decided,
// is refused for the Integers in `items`, and a note about the `others` nothing
// has written into answers a question nobody asked.
//
// Where the two sides are the SAME shape they are walked in lockstep, and a slot
// answers only where the expected side is a blank and the written side decides it
// — the very rule `matchTypes` refused by, asked here in the same words through
// `decidesAnUndecidedSlot`. A Record is walked over the members BOTH sides have,
// because a member an update does not name is one it says nothing about.
//
// Where the shapes differ there is no slot to pair anything with, and the value
// stands opposite the expected Type whole: `items = "a"` over a `variable items =
// []` is measured against `List<Unknown>` and refused, and `List<Unknown>` is
// exactly what the reader is shown and can not act on. So the blank is looked for
// in the expected Type alone — provided the value is not itself a blank, since
// one blank refuses no other.
//
// Null `written` asks that one-sided question outright, for the report that is
// about a blank rather than about a value refused by one: a capture is refused
// because the body around it can never be re-checked, so there is nothing
// standing opposite the blank to compare it with.
function refusedSlotIn(
	expected: common.Type,
	written: common.Type | null,
): "List" | "Dictionary" | null {
	// NOTE: A refinement decides nothing its base has not — what is still
	// undecided about a `NonEmptyList<Unknown>` is the item Type, on either side.
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

	// NOTE: Walked THROUGH rather than reported on. A Future's own slot is never
	// a blank a Program left — a bare `Future` is refused where it is written —
	// but a Future built around an empty List carries one all the same, and the
	// sentence about it is a sentence about that List.
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

	// NOTE: Arm by arm and one-sidedly, because a Union's arms pair with nothing:
	// the value was measured against the whole Union and turned away by all of
	// them at once. A blank standing in one arm is still a blank the reader is
	// shown — `variable x = define { as [] if flag  as "a" otherwise }` leaves one
	// — and it is still the half of `List<Unknown> | String` nobody can act on.
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

// NOTE: The same Type with every undecided slot filled in, to be SPELLED rather
// than compared — an annotation that would have answered the blank, at the exact
// depth the blank sits. Filled in with concrete example Types, which is what
// makes it an example: `List<List<Unknown>>` reads back as `List<List<Integer>>`
// and `{ items: List<Unknown> }` as `{ items: List<Integer> }`, so the reader is
// shown the shape they have to write and not a `List<Integer>` that answers a
// different Declaration.
function spelledWithDecidedSlots(type: common.Type): common.Type {
	switch (type.type) {
		case "Unknown":
			return { type: "Integer" }
		case "List":
			return {
				type: "List",
				itemType: spelledWithDecidedSlots(type.itemType),
			}
		// NOTE: Spelled through, the way the walk above looks through one — the
		// annotation an author writes for a `constant f = Async.deferred(() { <-
		// [] })` is the whole `Future<List<Integer>>`, blank and container and
		// all.
		case "Future":
			return {
				type: "Future",
				valueType: spelledWithDecidedSlots(type.valueType),
			}
		case "Started":
			return {
				type: "Started",
				valueType: spelledWithDecidedSlots(type.valueType),
			}
		case "Dictionary":
			return {
				type: "Dictionary",
				keyType:
					type.keyType.type === "Unknown"
						? { type: "String" }
						: spelledWithDecidedSlots(type.keyType),
				valueType: spelledWithDecidedSlots(type.valueType),
			}
		case "Record":
			return {
				type: "Record",
				members: Object.fromEntries(
					Object.entries(type.members).map(([name, memberType]) => [
						name,
						spelledWithDecidedSlots(memberType),
					]),
				),
			}
		// NOTE: An arm at a time, so a blank standing in one arm of a Union is
		// spelled where it stands and the arms beside it are spelled as they are.
		case "UnionType":
			return {
				...type,
				types: type.types.map(spelledWithDecidedSlots),
			}
		// NOTE: The Type ARGUMENTS as well as the base, because they are what a
		// refinement is printed from: `describeType` spells one as its name and
		// its Type Arguments and never reads the base at all, so filling the base
		// alone filled a blank nobody would see.
		case "Refinement":
			return {
				...type,
				base: spelledWithDecidedSlots(type.base),
				typeArguments: type.typeArguments?.map(spelledWithDecidedSlots),
			}
		default:
			return type
	}
}

// NOTE: What a mismatch has to say when the Type it EXPECTED carries a slot
// nobody decided. `List<Unknown>` names no Type a reader can act on: it is a
// blank, and the value is refused for being a write into a blank rather than for
// holding the wrong thing — which is a refusal nothing else in the Diagnostic
// explains. The note says what the blank is and the help says where it is
// filled in, the same two things `uninferable-item-type` says about the capture
// it refuses, which is the other place an author meets an undecided slot.
//
// `written` is the Type of the value that was refused, because the sentence is
// about a blank that refused something and not about every blank in sight. See
// `refusedSlotIn`: the two are walked together and the evidence is offered only
// where a blank stands opposite a Type that would have decided it.
//
// `name` is what the value is called where the mismatch is reported, so the help
// can show the annotation as it would be written. Null where the report has no
// name to use — a Record update names the value it updates by Expression, a
// return has no name at all — and the shape alone is spelled then.
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
	let spelling = describeType(spelledWithDecidedSlots(expected))

	return {
		notes: [
			dictionary
				? "An empty Dictionary Literal leaves its key and value Types unknown until a write decides them, and nothing has written into this one — an 'Unknown' here is a blank, not a Type."
				: "An empty List Literal leaves its item Type unknown until a write decides it, and nothing has written into this one — the 'Unknown' here is a blank, not a Type.",
		],
		helps: [
			// NOTE: The shape alone where there is no name, because every report
			// that has none is a step away from the Declaration that would answer
			// it — a Record update names the value it updates by Expression, a
			// `<-` and a `define` arm answer a position rather than a name — and
			// the Type is what has to be written wherever that Declaration is.
			`${
				name === null
					? `Annotate the Declaration that creates it — '${spelling}'`
					: `Annotate the Declaration — 'variable ${name}: ${spelling}'`
			} — so what is written into it is judged against the ${dictionary ? "Types" : "Type"} it holds.`,
		],
	}
}

// NOTE: The annotation that would decide the blanks in a Type, spelled as the
// Declaration holding it would be written — the same spelling
// `undecidedSlotEvidence` puts in its help, offered to the one report that names
// a Declaration rather than a refusal. `keyword` is what that Declaration was
// written with: an annotation shown under a `constant` as `variable` is advice
// that does not compile, and so is one that spells the blank's own container
// where the Declaration holds something around it — `variable f: List<Integer> =
// []` under a `constant f = Async.deferred(() { <- [] })` gets both wrong.
//
// `container` says which of the two Literals left the blank, because a
// Dictionary has two slots and no item Type, so the sentences about one are not
// the sentences about the other. Null where the Type holds no blank at all.
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

// NOTE: What a mismatch between two RECORDS says instead of printing both of
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
	// NOTE: The Label the report LEADS with, in place of the "this is a …" one
	// its site would have written over the whole value — and the Position the
	// Diagnostic itself takes, so an Editor underlines the member rather than
	// the Literal around it. Null where nothing was written down to point at: a
	// value that is not a Literal, and a refusal that is only about members
	// NOBODY wrote.
	lead: common.DiagnosticLabel | null
	labels: Array<common.DiagnosticLabel>
	notes: Array<string>
	helps: Array<string>
	// NOTE: For the fix that writes a near miss over the name it was meant to
	// be. Carried only for a SINGLE misspelled member: two of them are two
	// edits, and which one an Editor would apply without asking is not a
	// question a Diagnostic can answer.
	data: common.DiagnosticData | undefined
}

// NOTE: How many disagreeing members get a Label and how many more get a Note.
// Past that the count stands in for them: a report naming fifteen members is one
// nobody reads to the end, and the fifteen are usually one mistake — a value of
// another Type entirely — which the first three already say.
const labelledMembers = 3
const notedMembers = 6

type MemberDifference = {
	// NOTE: The member's path from the outermost Record — `points`, or
	// `team.code` for one a nested Literal got wrong. Read by nothing but the
	// sentences, which is why it is a string rather than a list of steps.
	path: string
	// NOTE: Where the VALUE of the member was written, or null for a member
	// reached through something that is not a Literal. Never the member's NAME:
	// a typed Record keys its members by name and holds no Position for one, and
	// the only Records that carry a name Position are the levels a dotted key
	// was desugared into (see `typed.RecordValueNode.memberPositions`).
	position: common.Position | null
	label: string
	note: string
	// NOTE: Set on a member the Record does not declare at all, to the name it
	// was measured against — what a fix would write over it.
	suggestion?: string
}

export function recordMismatchEvidence(
	expected: common.Type,
	written: common.Type,
	value: common.typed.ExpressionNode | null,
	options: {
		// NOTE: Members a default fills in, which are not missing however
		// little the value writes. `partial` is the whole of that rule rather
		// than a list of names: an update and a payload default may leave out
		// ANY member, so what refuses one is only what it writes.
		filled?: ReadonlyArray<string>
		partial?: boolean
		// NOTE: What the sentences call the expected Record where it has no
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
	// NOTE: A refusal that is ONLY about members nobody wrote has nothing
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
			// NOTE: Which arm the differences below are about, wherever the
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

// NOTE: The members nobody wrote, as one clause — a Label reads it without a
// full stop and a Note with one, and the two are never both written, so the
// sentence is built once and punctuated by whoever takes it.
function missingClause(missing: Array<string>): string {
	return missing.length === 1
		? `'${missing[0]}' is missing`
		: `${missing.map((name) => `'${name}'`).join(", ")} are missing`
}

// NOTE: The Record inside a Type, or null where there is none. A refinement is
// looked through because what its base declares is what a value of it has to
// write — the predicate is a separate refusal with a report of its own, which
// `refinementEvidence` writes.
function recordShapeOf(type: common.Type): common.RecordType | null {
	while (type.type === "Refinement") {
		type = type.base
	}

	return type.type === "Record" ? type : null
}

// NOTE: Which Record the value is compared AGAINST, when the position holds a
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

// NOTE: Every member the value writes that the Record does not take — one it
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
			let suggestion = closestMatch(name, Object.keys(target.members))

			differences.push({
				path,
				position,
				// NOTE: The Label says what is wrong here and the near miss is
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

		// NOTE: "this is" only where the arrow lands on the member ALONE. A
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

// NOTE: The differences one step further in, or null where there is no step to
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

// NOTE: The members the Record declares and the value does not write. Not a
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

// NOTE: Where a member of a written Literal stands. The desugared levels a
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

// NOTE: What the sentences call the Record a value was measured against — its
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

// NOTE: The member a path ends at, which is the name a fix writes over — a
// nested one is spelled from the outside in for the reader and edited where it
// stands.
function lastStep(path: string): string {
	return path.slice(path.lastIndexOf(".") + 1)
}

// #endregion

// NOTE: What a Future or a Started IS, in the clause every report about a
// forgotten `complete` opens with. Three reports say it now — a Type mismatch in
// an ordinary position, one in return position, and a Method call on the
// wrapper instead of on the value — and each of them goes on differently,
// because what a reader should DO about it is different in each. What they must
// not differ about is the state of the work, which is this.
export function asynchronyState(mismatch: AsynchronyMismatch): string {
	return mismatch === "unstarted"
		? "This describes work that has not run"
		: "This is still in flight"
}

// NOTE: The same question the Helps below ask, answered as DATA. A Quick Fix
// reads this rather than a Help's sentence: the wording is written per site and
// is free to change, and a fix keyed on prose breaks silently when it does.
// `not-a-future` carries nothing, because there is no edit to make — what a body
// has to do about it is build a future, which is a judgement.
export function asynchronyData(
	expected: common.Type,
	actual: common.Type,
): common.DiagnosticData | undefined {
	let mismatch = asynchronyMismatch(expected, actual)

	return mismatch === "unstarted" || mismatch === "in-flight"
		? { kind: "asynchrony-mismatch", mismatch }
		: undefined
}

// NOTE: The Helps a mismatch gets where the difference is one missing word about
// asynchrony rather than a wrong value. `asynchronyMismatch` decides WHICH of
// the three it is, by assignability.
//
// This is the ordinary positions' wording — an Argument, a Declaration, an
// Assignment, a `define` arm — where the value is the thing to change.
export function asynchronyHelps(
	expected: common.Type,
	actual: common.Type,
): Array<string> {
	switch (asynchronyMismatch(expected, actual)) {
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

// NOTE: And the same three in RETURN position, where the body is the thing to
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

// NOTE: A Future or a Started where a value was wanted, which is the forgotten
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
						"'complete' only stands in a body that answers a Future, and this position is not one.",
					]),
		],
		helps: waits
			? asynchronyHelps(type.valueType, type)
			: [
					"Declare the enclosing Function '-> Future<…>', which is what lets its body wait, and add 'complete' where the value is read.",
				],
		...(waits ? { data: asynchronyData(type.valueType, type) } : {}),
	}
}
