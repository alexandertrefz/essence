import {
	Boolean   from "./Boolean.es"
	Integer   from "./Integer.es"
	Optional  from "./Optional.es"
	Equatable from "./Protocols.es"
	Printable from "./Protocols.es"
	Rational  from "./Rational.es"
}

declarations {

	§ A number that is provably not algebraic. For now it is the linear
	§ slice `a + b·π + c·e` over the bases Pi and E, which keeps Pi, Tau and
	§ E exact. Whether a value over both bases can equal another number is
	§ an open problem, so Transcendental does not conform to Comparable.
	§ Comparison against another kind is still total, through the covering
	§ `Number`.
	namespace Transcendental for Transcendental is Equatable, is Printable {
		§ `is` and `absolute` are native. Neither reaches a primitive this
		§ Namespace declares. Equality is decided by the canonical form
		§ itself, and the sign of `a + b·π + c·e` needs an ordering
		§ Transcendental declares nowhere. Reading the covering `Number`
		§ instead puts the whole numeric tower behind an equality check; see
		§ DEVELOPMENT.md, Why bodies look the way they do.

		§§ Answers whether both Transcendentals have the same canonical form.
		§§
		§§ Every component is held reduced, so agreement is structural. On a single base that agreement is exactly numeric equality.
		§§
		§§ @param _ — the Transcendental to compare with
		§§ @returns — `true` when the canonical forms agree.
		is(_ other: Transcendental) -> Boolean

		§§ Answers whether the Transcendentals have different canonical forms.
		§§
		§§ On a single base the two are then different numbers.
		§§
		§§ @param _ — the Transcendental to compare with
		§§ @returns — `true` when the canonical forms differ.
		isNot(_ other: Transcendental) -> Boolean {
			<- @::is(other)::negate()
		}

		§§ Answers the Transcendental as a String, in the exact symbolic form: `π`, `2·π`, `e` or `1 + π + e`.
		toString() -> String

		§§ Answers the exact sum of the Transcendental and a number.
		§§
		§§ Two Transcendentals can cancel their π and e terms, which leaves a Rational.
		overload add {
			(_ other: Integer) -> Transcendental

			(_ other: Rational) -> Transcendental

			§§ Answers the exact sum of the two Transcendentals.
			§§
			§§ The π and e parts can cancel, which leaves a Rational.
			(_ other: Transcendental) -> Rational | Transcendental
		}

		§§ Answers the exact difference of the Transcendental and a number.
		§§
		§§ Subtracting equal π and e terms leaves a Rational.
		overload subtract {
			(_ other: Integer) -> Transcendental {
				<- @::add(other::negate())
			}

			(_ other: Rational) -> Transcendental {
				<- @::add(other::negate())
			}

			(_ other: Transcendental) -> Rational | Transcendental {
				<- @::add(other::negate())
			}
		}

		§§ Answers the exact product of the Transcendental and an Integer or a Rational.
		§§
		§§ Multiplying by zero answers zero. Two Transcendentals can not be multiplied: `π·π` and `π·e` leave the linear grammar.
		overload multiply {
			(with other: Integer) -> Transcendental | Rational

			(with other: Rational) -> Transcendental | Rational
		}

		§§ Answers the exact quotient of the Transcendental and a number.
		§§
		§§ Dividing by an Integer or a Rational is empty only for zero. Dividing by another Transcendental answers a Rational when the two are proportional: `Tau::divide(by Pi)` is `2`. Anything else is empty. The `defaultingTo:` entries answer the given value in place of empty.
		overload divide {
			(by other: Integer) -> Optional<Transcendental>

			(by other: Rational) -> Optional<Transcendental>

			§§ Answers the exact quotient of the two Transcendentals.
			§§
			§§ Proportional values answer a Rational: `Tau::divide(by Pi)` is `2`. Anything else is empty, including π divided by e.
			(by other: Transcendental) -> Optional<Rational>

			§§ Answers the exact quotient of the Transcendental and an Integer.
			§§
			§§ A zero divisor answers the given value.
			§§
			§§ @param by — the divisor
			§§ @param defaultingTo — the value to answer with when there is no quotient
			§§ @returns — the quotient, or the given value in its place.
			(
				by other: Integer,
				defaultingTo fallback: Transcendental,
			) -> Transcendental {
				<- @::divide(by other)::value(defaultingTo fallback)
			}

			§§ Answers the exact quotient of the Transcendental and a Rational.
			§§
			§§ A zero divisor answers the given value.
			§§
			§§ @param by — the divisor
			§§ @param defaultingTo — the value to answer with when there is no quotient
			§§ @returns — the quotient, or the given value in its place.
			(
				by other: Rational,
				defaultingTo fallback: Transcendental,
			) -> Transcendental {
				<- @::divide(by other)::value(defaultingTo fallback)
			}

			§§ Answers the exact quotient of the two Transcendentals.
			§§
			§§ Where the two are not proportional, the answer is the given value.
			§§
			§§ @param by — the divisor
			§§ @param defaultingTo — the value to answer with when there is no quotient
			§§ @returns — the quotient, or the given value in its place.
			(
				by other: Transcendental,
				defaultingTo fallback: Rational,
			) -> Rational {
				<- @::divide(by other)::value(defaultingTo fallback)
			}
		}

		§§ Answers the Transcendental without its sign, which is its distance from zero.
		§§
		§§ A value on a single base can never equal a Rational, so its sign is exact. A value that mixes π and e decides its sign by refining an interval, down to a documented precision limit.
		absolute() -> Transcendental

		§§ Answers the Transcendental with its sign flipped.
		§§
		§§ At least one base term keeps its non-zero coefficient, so the answer is again a Transcendental.
		negate() -> Transcendental
	}
}

export {
	Transcendental
}
