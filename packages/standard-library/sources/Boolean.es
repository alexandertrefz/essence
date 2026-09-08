import {
	from "./Comparable.es" { Comparable }
	from "./Ordering.es" { Ordering }
	from "./Protocols.es" {
		Equatable
		Printable
	}
}

declarations {

	§ `Comparable` is declared and `Orderable` is not, for the reason a String
	§ declares the smaller one. A Boolean can be sorted, and it has no line
	§ for `isBetween` to name a range on. The four inequalities `Comparable`
	§ provides come with it, so `true::isGreaterThan(false)` answers without
	§ anything being written here.

	§§ The two truth values, `true` and `false`, and the logic that combines them.
	namespace Boolean for Boolean is Equatable, is Printable, is Comparable {
		§§ Answers whether the Boolean has the same truth value as another.
		§§
		§§ @param _ — the Boolean to compare against
		§§ @returns — `true` when both are equal.
		is(_ other: Boolean) -> Boolean

		§ Native, like the four primitives below it. The alternative is a
		§ `define` over `@::is(other)`, and a Program sorting three Booleans
		§ measures 225 bytes larger with it. The witness `sort` reads this
		§ Method off is why. A native is a member esbuild shakes, and an
		§ Essence body is a const of its own.

		§§ Orders the Boolean against another one, with `false` before `true`.
		§§
		§§ @param to — the Boolean to order against
		§§ @returns — `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.
		compare(to other: Boolean) -> Ordering

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
		§§ Both sides are evaluated. A call reads its Argument before the Method runs, so a `false` receiver does not stop the other side. Where the other side is expensive, write `define { as other if flag as false otherwise }`.
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
		§§ Both sides are evaluated, as they are for `and`. Where the other side is expensive, write `define { as true if flag as other otherwise }`.
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
