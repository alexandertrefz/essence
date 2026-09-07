import {
	from "./Boolean.es" { Boolean }
	from "./Protocols.es" {
		Equatable
		Printable
	}
}

declarations {

	namespace Record for Record is Equatable, is Printable {
		§ The native takes no witness for the members. A Record's members are
		§ not Type Parameters, so no conformance can be conditional on them.
		§ Each member is compared through the runtime's universal comparison,
		§ `anyIs`, whatever `is` its own Namespace writes. The Dictionary's key
		§ encoding for a Record rests on exactly that. A Record key encodes by
		§ its members under the same rule, in `compositeText` of the runtime's
		§ `Dictionary.ts`. A change here is a change to that encoding too.

		§§ Answers whether the Record has the same members and values as another.
		§§
		§§ The order the members stand in does not matter. Each member is compared by the structural equality the language itself defines, and not by an `is` the member's own Namespace writes. So a value whose Namespace writes its own `is` compares one way on its own and another way as a member. A Dictionary keyed by Records finds a key by this same comparison.
		§§
		§§ @param _ — the Record to compare against
		§§ @returns — `true` when the Records are equal.
		is(_ other: Record) -> Boolean

		§§ Answers the Record and its members as a String.
		§§
		§§ Each member is written as `name = value`. The value is written the way it prints, so a whole Rational member prints its numerator alone. A String member keeps its quotation marks. A Record too long for one line is written over several lines.
		§§
		§§ @returns — the String representation of the Record.
		toString() -> String

		§ `entries` and `values` stay undeclared until there is an `Anything`
		§ Type to answer with; see README.md.

		§§ Answers the names of the Record's members.
		§§
		§§ @returns — the member names, as a List of Strings.
		keys() -> List<String>
	}
}

export {
	Record
}
