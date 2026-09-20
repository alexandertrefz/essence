import { matchesType } from "@essence-lang/compiler/helpers"
import { printType } from "@essence-lang/compiler/printType"
import type { common } from "@essence-lang/interfaces"

import { typeNamedAt } from "./namedTypes"

// NOTE: WHERE a Type is about to be written, for the half of "can this be
// written down" that depends on the place: a name is a spelling only where it
// names something, and `Point` is a Type Declaration in the file that declares
// it and an `unknown-type` in the file next door. The cursor is where the TEXT
// lands rather than where the value was written — an extracted Function is
// spelled at the position it is inserted at, and what a body declares is out of
// reach there.
export type SpellingScope = {
	program: common.typed.Program
	cursor: common.Cursor
}

// NOTE: Whether a Type can be WRITTEN — the question `printType` does not
// answer. It prints a Function signature as `(_ Integer) -> Integer` and a Case
// as `Choice#Case`, and neither is a Type Declaration the Parser accepts; a
// Type Parameter prints under a name that means nothing outside the Declaration
// that introduced it; and `Unknown`, `Error` and the unapplied generic
// containers print a tag rather than a Type at all.
//
// A refactoring that has to write an annotation asks here first and turns the
// selection away when the answer is no, rather than producing source that does
// not parse.
//
// NOTE: `at` is what turns "this shape has a spelling" into "this shape has a
// spelling HERE". Left out, the answer is the old one — every name is taken as
// readable — which is what a caller holding no typed Program to read Scopes off
// can ask. Every caller that writes into source hands one in, because a Record
// Alias prints under its own name and a name the position can not resolve is an
// `unknown-type` rather than an annotation. Such a caller reaches for
// `spellTypeAt`, which also knows what to write instead.
export function isSpellableType(
	type: common.Type,
	at: SpellingScope | null = null,
): boolean {
	switch (type.type) {
		case "Boolean":
		case "String":
		case "Integer":
		case "Rational":
		case "Algebraic":
		case "Transcendental":
		case "Randomness":
			return true
		case "List":
			return isSpellableType(type.itemType, at)
		case "Future":
		case "Started":
			return isSpellableType(type.valueType, at)
		case "Dictionary":
			return (
				isSpellableType(type.keyType, at) &&
				isSpellableType(type.valueType, at)
			)
		// NOTE: A Record Alias prints under its own name, and an applied generic
		// one under that name with its Arguments — the Union's rule below asked
		// one Type over, because `printType` now answers both the same way.
		// What its members are made of stops mattering once the name is what
		// gets written: `Standing` parses wherever the Alias is in scope, and
		// `at` is what asks whether it is.
		case "Record":
			if (type.name !== undefined) {
				return namesTypeAt(type.name, type, at)
			}

			if (type.alias !== undefined) {
				return (
					namesSomethingAt(type.alias.name, at) &&
					type.alias.typeArguments.every((typeArgument) =>
						isSpellableType(typeArgument, at),
					)
				)
			}

			return Object.values(type.members).every((member) =>
				isSpellableType(member, at),
			)
		// NOTE: A Choice prints under its own name and an applied Alias under
		// its own with the Arguments spelled out; a bare structural Union is
		// the pipe list, which is written the same way it prints.
		case "UnionType":
			if (type.name !== undefined) {
				return namesTypeAt(type.name, type, at)
			}

			if (type.alias !== undefined) {
				return (
					namesSomethingAt(type.alias.name, at) &&
					type.alias.typeArguments.every((typeArgument) =>
						isSpellableType(typeArgument, at),
					)
				)
			}

			return type.types.every((arm) => isSpellableType(arm, at))
		// NOTE: The alias is the spelling — the predicate is what the
		// Declaration says, not what a use site writes. An applied generic one
		// prints its Arguments, so those have to be writable too.
		case "Refinement":
			return (
				namesSomethingAt(type.name, at) &&
				(type.typeArguments ?? []).every((typeArgument) =>
					isSpellableType(typeArgument, at),
				)
			)
		default:
			return false
	}
}

// NOTE: The text to WRITE for a Type at a position, or null where there is
// none. Not the question a label asks: an Inlay Hint reading `: Point` is
// information wherever the reader is standing, and only the edit behind it has
// to be source the file can hold.
//
// A spelling the position can not read falls back to the shape underneath it,
// which is what these edits wrote before a Record could be named at all:
// `{ x: Integer, y: Integer }` is the same Type as `Point` and needs nothing
// imported. Where even that has no spelling — a Choice IS its Cases, and a Case
// is not a Type anybody writes — there is nothing to write and the caller
// withholds the edit.
export function spellTypeAt(
	type: common.Type,
	at: SpellingScope | null = null,
): string | null {
	if (isSpellableType(type, at)) {
		return printType(type)
	}

	if (at === null) {
		return null
	}

	let structural = withoutUnreadableSpellings(type, at)

	return isSpellableType(structural, at) ? printType(structural) : null
}

// NOTE: Whether the NAME resolves, where the text is going, to the very Type it
// is being written for — the whole of the rule, and the reason asking whether
// the name resolves at all is not enough. Two Modules may each declare a
// `Shape`, and the one in reach here is the one this file's own Declarations
// and its import block name; writing the other one's spelling names a different
// Type under the same word.
//
// Matched both ways round, which for a Record is the members agreeing and for a
// Choice is the Cases being the same Cases — a Case carries the Module that
// declared it, so one Module's `Shape` never answers for another's.
function namesTypeAt(
	name: string,
	type: common.Type,
	at: SpellingScope | null,
): boolean {
	if (at === null) {
		return true
	}

	let found = typeInScope(name, at)

	return (
		found !== null && matchesType(found, type) && matchesType(type, found)
	)
}

// NOTE: The looser question, for the spellings that are not the Type itself but
// a Declaration it was made FROM: an applied generic Alias prints `Box<Integer>`
// where `Box` names `{ value: Item }`, which is no Type the application equals.
// So what is asked of those is that the word still names a Type here — enough
// to tell an Alias this file can not see from one it can, which is what the
// reports were about, and short of telling two same-named generic Aliases
// apart. A Refinement is read the same way and for the same reason.
function namesSomethingAt(name: string, at: SpellingScope | null): boolean {
	return at === null || typeInScope(name, at) !== null
}

// NOTE: What the name means where the text lands, read off the document's own
// Scopes — the Language Server's mirror of `findTypeInScope`, which is what the
// Enricher reads the applied edit with. The import block is asked after them,
// because a name this file declares shadows one it imports, and its entries are
// read here rather than through `ImportedNames` so that every caller can ask:
// the typed entry carries what the name bound, which is the Type wherever a
// Type is what came across.
//
// Exported for the writer that has a question of its own to ask of the answer:
// a Case is written as the CHOICE it belongs to, so what a table column asks is
// whether the word names a Union that HOLDS the Case, which is not the equality
// every other spelling is held to.
export function typeInScope(
	name: string,
	at: SpellingScope,
): common.Type | null {
	let declared = typeNamedAt(name, at.cursor, at.program)

	if (declared !== null) {
		return declared
	}

	for (let entry of at.program.imports?.entries ?? []) {
		if ((entry.alias ?? entry.name) === name && entry.type !== null) {
			return entry.type
		}
	}

	return null
}

// NOTE: The same Type with the names the position can not read taken off it, so
// that what is left is the shape — `List<Point>` becomes `List<{ x: Integer,
// y: Integer }>` where `Point` is somebody else's word, and stays `List<Point>`
// where it is this file's. A name that IS in reach is left standing rather than
// stripped with the rest: the reader wrote that Alias, and an annotation
// spelling their own shape back at them is the thing Aliases exist to stop.
//
// A Union holding Cases is left exactly as it stands. There is no shape under a
// Choice — its arms are Cases, and a Case is not a Type a Declaration writes —
// so the strip has nothing to hand back, and the caller finds it unspellable,
// which is the withheld edit.
//
// NOTE: The visiting set is the back-edge guard `withoutRecordNames` carries,
// and is defence rather than a case that arises: the only Types that lead back
// to themselves go through a Choice, and a Choice stops the walk one line up.
function withoutUnreadableSpellings(
	type: common.Type,
	at: SpellingScope,
): common.Type {
	let visiting = new Set<common.Type>()

	let readable = (type: common.RecordType | common.UnionType): boolean =>
		type.name !== undefined
			? namesTypeAt(type.name, type, at)
			: type.alias !== undefined && namesSomethingAt(type.alias.name, at)

	let strip = (type: common.Type): common.Type => {
		if (visiting.has(type)) {
			return type
		}

		visiting.add(type)

		try {
			switch (type.type) {
				case "Record": {
					if (readable(type)) {
						return type
					}

					let members: Record<string, common.Type> = {}

					for (let [name, member] of Object.entries(type.members)) {
						members[name] = strip(member)
					}

					return { type: "Record", members }
				}
				case "UnionType": {
					if (
						readable(type) ||
						type.types.some((arm) => arm.type === "Case")
					) {
						return type
					}

					return { type: "UnionType", types: type.types.map(strip) }
				}
				case "List": {
					let itemType = strip(type.itemType)

					return itemType === type.itemType
						? type
						: { type: "List", itemType }
				}
				case "Future": {
					let valueType = strip(type.valueType)

					return valueType === type.valueType
						? type
						: { type: "Future", valueType }
				}
				case "Started": {
					let valueType = strip(type.valueType)

					return valueType === type.valueType
						? type
						: { type: "Started", valueType }
				}
				case "Dictionary": {
					let keyType = strip(type.keyType)
					let valueType = strip(type.valueType)

					return keyType === type.keyType &&
						valueType === type.valueType
						? type
						: { type: "Dictionary", keyType, valueType }
				}
				default:
					return type
			}
		} finally {
			visiting.delete(type)
		}
	}

	return strip(type)
}
