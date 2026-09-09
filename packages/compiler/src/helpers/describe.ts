import type { common } from "@essence-lang/interfaces"

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
		case "Dictionary":
			return `Dictionary<${describeType(type.keyType)}, ${describeType(
				type.valueType,
			)}>`
		case "GenericDictionary":
			return "Dictionary"
		case "Record":
			return `{ ${Object.entries(type.members)
				.map(
					([memberName, memberType]) =>
						`${memberName}: ${describeType(memberType)}`,
				)
				.join(", ")} }`
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
