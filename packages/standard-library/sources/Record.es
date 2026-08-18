import {
	Boolean   from "./Boolean.es"
	Equatable from "./Protocols.es"
	Printable from "./Protocols.es"
}

declarations {

	namespace Record for Record is Equatable, is Printable {
		§§ Checks whether the Record has the same members and values as another.
		§§
		§§ The order the members stand in does not matter.
		§§
		§§ @param _ — the Record to compare against
		§§ @returns — `true` when the Records are equal.
		is(_ other: Record) -> Boolean

		§§ Checks whether the Record has different members than another, or a different value under one of them.
		§§
		§§ @param _ — the Record to compare against
		§§ @returns — `true` when the Records are not equal.
		isNot(_ other: Record) -> Boolean {
			<- @::is(other)::negate()
		}

		§ `entries` and `values` exist in the runtime and stay undeclared:
		§ their return Types need an `Anything` Type, which arrives with the
		§ JSON design.

		§§ Answers the names of the Record's members.
		§§
		§§ @returns — the member names, as a List of Strings.
		keys() -> List<String>

		§§ Represents the Record and its members as a String.
		§§
		§§ @returns — the String representation of the Record.
		toString() -> String
	}
}

export {
	Record
}
