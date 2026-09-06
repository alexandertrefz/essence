import {
	from "./Protocols.es" {
		Equatable
		Printable
	}
}

declarations {

	§§ The two truth values, `true` and `false`, and the logic that combines them.
	namespace Boolean for Boolean is Equatable, is Printable {
		§§ Answers whether the Boolean has the same truth value as another.
		§§
		§§ @param _ — the Boolean to compare against
		§§ @returns — `true` when both are equal.
		is(_ other: Boolean) -> Boolean

		§§ Answers the Boolean as a String: `"true"` or `"false"`.
		§§
		§§ @example
		§§   expect true::toString()::is("true")
		§§   expect false::toString()::is("false")
		toString() -> String {
			if @ {
				<- "true"
			} else {
				<- "false"
			}
		}

		§§ Answers the opposite truth value: `false` for `true`, and `true` for `false`.
		negate() -> Boolean

		§§ Answers the logical conjunction: `true` only when both Booleans are `true`.
		§§
		§§ @example
		§§   expect true::and(true)
		§§   expect true::and(false)::negate()
		§§
		§§ @param _ — the other Boolean
		and(_ other: Boolean) -> Boolean

		§ `or` stays native. De Morgan expresses it as
		§ `@::negate()::and(other::negate())::negate()`, four Method calls
		§ where the runtime does one `||`. The primitives `negate`, `is` and
		§ `and` stay native for the same reason.
		§§ Answers the logical disjunction: `true` when either Boolean is `true`.
		§§
		§§ @param _ — the other Boolean
		or(_ other: Boolean) -> Boolean

		§§ Answers the exclusive disjunction: `true` when exactly one Boolean is `true`.
		§§
		§§ @param _ — the other Boolean
		exclusiveOr(_ other: Boolean) -> Boolean {
			<- @::is(other)::negate()
		}
	}
}

export {
	Boolean
}
