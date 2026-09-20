import type { common } from "@essence-lang/interfaces"

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
export function isSpellableType(type: common.Type): boolean {
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
			return isSpellableType(type.itemType)
		case "Future":
		case "Started":
			return isSpellableType(type.valueType)
		case "Dictionary":
			return (
				isSpellableType(type.keyType) && isSpellableType(type.valueType)
			)
		// NOTE: A Record Alias prints under its own name, and an applied generic
		// one under that name with its Arguments — the Union's rule below asked
		// one Type over, because `printType` now answers both the same way.
		// What its members are made of stops mattering once the name is what
		// gets written: `Standing` parses wherever the Alias is in scope.
		case "Record":
			if (type.name !== undefined) {
				return true
			}

			if (type.alias !== undefined) {
				return type.alias.typeArguments.every(isSpellableType)
			}

			return Object.values(type.members).every(isSpellableType)
		// NOTE: A Choice prints under its own name and an applied Alias under
		// its own with the Arguments spelled out; a bare structural Union is
		// the pipe list, which is written the same way it prints.
		case "UnionType":
			if (type.name !== undefined) {
				return true
			}

			if (type.alias !== undefined) {
				return type.alias.typeArguments.every(isSpellableType)
			}

			return type.types.every(isSpellableType)
		// NOTE: The alias is the spelling — the predicate is what the
		// Declaration says, not what a use site writes. An applied generic one
		// prints its Arguments, so those have to be writable too.
		case "Refinement":
			return (type.typeArguments ?? []).every(isSpellableType)
		default:
			return false
	}
}
