declarations {

	§ The core Protocols every conforming builtin Namespace fulfills. `Self`
	§ stands for the conforming Namespace's target Type.

	§§ Anything that can be compared for equality.
	protocol Equatable {
		§§ Answers whether both values are equal.
		§§
		§§ @param _ — the value to compare with
		§§ @returns — `true` when the values are equal.
		is(_ other: Self) -> Boolean

		§ Provided, so a conformer writes `is` alone and answers both. The
		§ body is an `if` rather than `@::is(other)::negate()`. Reaching
		§ `Boolean::negate` would need `Boolean` imported here, and
		§ `Boolean.es` imports this file. That is a second cycle in a graph
		§ that has one; see DEVELOPMENT.md, The shape of the graph is frozen.
		§
		§ This body is read as well as run. An `if` that answers one Boolean
		§ in each branch spells out the call it asks. So `isNot` is `is`
		§ negated, and the `else` of `if n::isNot(0)` proves a refinement
		§ written on `@::is(0)`. The conformer that answered gives the leaf
		§ its Namespace. See DEVELOPMENT.md, Why bodies look the way they do.

		§§ Answers whether the values differ.
		§§
		§§ @param _ — the value to compare with
		§§ @returns — `true` when the values differ.
		isNot(_ other: Self) -> Boolean {
			if @::is(other) {
				<- false
			} else {
				<- true
			}
		}
	}

	§§ Anything that can represent itself as a String.
	protocol Printable {
		§§ Answers the value as a String.
		§§
		§§ @returns — the String representation of the value.
		toString() -> String
	}
}

export {
	Equatable
	Printable
}
