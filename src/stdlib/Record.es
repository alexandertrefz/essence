declarations {

	namespace Record for Record is Equatable, is Printable {
		§§ Checks whether the Records are structurally equal — the same members with equal values, in any order.
		§§
		§§ @param other the Record to compare against
		§§ @returns `true` when the Records are equal.
		is(_ other: Record) -> Boolean

		§§ Checks whether the Records differ structurally — in their members or any member's value.
		§§
		§§ @param other the Record to compare against
		§§ @returns `true` when the Records are not equal.
		isNot(_ other: Record) -> Boolean

		§ `entries` and `values` exist in the runtime but stay undeclared —
		§ their honest return Types need an `Anything` Type, which arrives with
		§ the JSON design.

		§§ The names of the Record's members.
		§§
		§§ @returns the member names, as a List of Strings.
		keys() -> List<String>

		§§ Represents the Record and its members as a String.
		§§
		§§ @returns the String representation of the Record.
		toString() -> String
	}
}
