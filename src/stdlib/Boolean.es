declarations {

	§§ The two truth values, `true` and `false`, and the logic that combines them.
	namespace Boolean for Boolean is Equatable, is Printable {
		§§ The opposite truth value — `false` for `true`, `true` for `false`.
		negate() -> Boolean

		§§ Checks whether the Boolean has the same truth value as another.
		§§
		§§ @param other the Boolean to compare against
		§§ @returns `true` when both are equal.
		is(_ other: Boolean) -> Boolean

		§§ Checks whether the Boolean has a different truth value than another.
		§§
		§§ @param other the Boolean to compare against
		§§ @returns `true` when the two differ.
		isNot(_ other: Boolean) -> Boolean {
			<- @::is(other)::negate()
		}

		§§ Logical conjunction — `true` only when this Boolean and the given one are both `true`.
		§§
		§§ @param other the other Boolean
		and(_ other: Boolean) -> Boolean

		§ `or` stays native deliberately. De Morgan expresses it —
		§ `@::negate()::and(other::negate())::negate()` — but that is four
		§ Method calls where the runtime does one `||`, on the most-used
		§ primitive in the language. `negate`, `is` and `and` are the anchors
		§ everything else here is built from, so they stay native too.
		§§ Logical disjunction — `true` when this Boolean, the given one, or both are `true`.
		§§
		§§ @param other the other Boolean
		or(_ other: Boolean) -> Boolean

		§§ Exclusive disjunction — `true` when exactly one of this Boolean and the given one is `true`.
		§§
		§§ @param other the other Boolean
		exclusiveOr(_ other: Boolean) -> Boolean {
			<- @::is(other)::negate()
		}

		§§ Represents the Boolean as a String — `"true"` or `"false"`.
		toString() -> String {
			if @ {
				<- "true"
			}

			<- "false"
		}
	}
}
