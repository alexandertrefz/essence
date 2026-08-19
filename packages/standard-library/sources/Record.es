import {
	Boolean   from "./Boolean.es"
	Equatable from "./Protocols.es"
	Printable from "./Protocols.es"
}

declarations {

	namespace Record for Record is Equatable, is Printable {
		§§ Answers whether the Record has the same members and values as another.
		§§
		§§ The order the members stand in does not matter.
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
