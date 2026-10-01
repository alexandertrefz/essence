import { matchesType } from "@essence-lang/compiler/helpers"
import { printType } from "@essence-lang/compiler/printType"
import type { common } from "@essence-lang/interfaces"

import { typeNamedAt } from "./namedTypes"

// Where a Type is about to be written. A name is a spelling only where it
// resolves: `Point` is fine in its own file and an `unknown-type` next door.
// The position is where the text lands, not where the value was written.
export type SpellingScope = {
	program: common.typed.Program
	cursor: common.Cursor
	// The Type Parameters the text is written under that no Scope declares, such
	// as a Protocol's `Self` target.
	typeParameters?: ReadonlySet<string>
}

// Whether a Type can be written, which `printType` does not answer. Function
// signatures, Cases, out-of-scope Type Parameters and tags like `Error` print
// but do not parse. With `at`, a name must also resolve there (`spellTypeAt`).
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
		// A Record Alias, applied or not, is written under its name, which parses
		// wherever the Alias is in Scope; `at` asks whether it is.
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
		// A Choice and an applied Alias are written under their names; a structural
		// Union as its pipe list.
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
		// The alias is the spelling, not the predicate. An applied generic one writes
		// its Arguments, which must be writable too.
		case "Refinement":
			return (
				namesSomethingAt(type.name, at) &&
				(type.typeArguments ?? []).every((typeArgument) =>
					isSpellableType(typeArgument, at),
				)
			)
		case "GenericUse":
			return at?.typeParameters?.has(type.name) === true
		default:
			return false
	}
}

// The text to write for a Type at a position, or null. A name the position
// cannot read falls back to the shape under it, as `{ x: Integer, y: Integer }`
// for `Point`. A Choice has no shape to fall back to, so it is null.
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

// Whether the name resolves, where the text goes, to the very Type it is
// written for, since two Modules may each declare a `Shape`. A Record matches
// on its members, a Choice on its Cases, which carry their declaring Module.
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

// The looser question for an applied generic Alias or a Refinement, whose
// spelling names a Declaration rather than the Type itself. It asks whether the
// word names a Type here at all.
function namesSomethingAt(name: string, at: SpellingScope | null): boolean {
	return at === null || typeInScope(name, at) !== null
}

// What the name means where the text lands: the document's Scopes first, as
// the Enricher's `findTypeInScope` reads them, then the import block. Exported
// for a table column, which asks whether a Union holding a Case is named.
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

// The Type with the names the position cannot read replaced by their shapes,
// keeping names in reach. A Union holding Cases has no shape and is left as it
// is. `visiting` guards against cycles, which only arise through a Choice.
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

					let imported = importedSpelling(type, at)

					if (imported !== null) {
						return imported
					}

					let members: Record<string, common.Type> = {}

					for (let [name, member] of Object.entries(type.members)) {
						members[name] = strip(member)
					}

					return { type: "Record", members }
				}
				case "UnionType": {
					if (readable(type)) {
						return type
					}

					let imported = importedSpelling(type, at)

					if (imported !== null) {
						return imported
					}

					if (type.types.some((arm) => arm.type === "Case")) {
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

// The name an import entry binds a Type under where it differs, as
// `Colour as Hue`, or null.
function importedSpelling(
	type: common.RecordType | common.UnionType,
	at: SpellingScope,
): common.Type | null {
	if (type.name === undefined) {
		return null
	}

	for (let entry of at.program.imports?.entries ?? []) {
		let local = entry.alias ?? entry.name

		if (local !== type.name && namesTypeAt(local, type, at)) {
			return { ...type, name: local }
		}
	}

	return null
}
