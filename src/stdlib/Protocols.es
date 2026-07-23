declarations {

	§ The core Protocols every conforming builtin Namespace fulfills. `Self`
	§ stands for the conforming Namespace's target Type.

	§§ Anything that can be compared for equality.
	protocol Equatable {
		§§ Answers whether both values are equal.
		§§
		§§ @param other the value to compare with
		§§ @returns `true` when the values are equal.
		is(_ other: Self) -> Boolean

		§§ Answers whether the values differ.
		§§
		§§ @param other the value to compare with
		§§ @returns `true` when the values differ.
		isNot(_ other: Self) -> Boolean
	}

	§§ Anything that can represent itself as a String.
	protocol Printable {
		§§ Represents the value as a String.
		§§
		§§ @returns the String representation of the value.
		toString() -> String
	}

	§§ Anything with a total order among its values.
	protocol Comparable {
		§§ Orders the value against another one of the same Type.
		§§
		§§ @param other the value to compare with
		§§ @returns `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.
		compareTo(_ other: Self) -> Ordering
	}
}
