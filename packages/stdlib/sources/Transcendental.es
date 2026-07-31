import {
	Boolean   from "./Boolean.es"
	Integer   from "./Integer.es"
	Optional  from "./Optional.es"
	Equatable from "./Protocols.es"
	Printable from "./Protocols.es"
	Rational  from "./Rational.es"
}

declarations {

	§ A number that is provably not algebraic — for now the linear slice
	§ `a + b·π + c·e` over the two constant bases, which is how Pi, Tau
	§ and E stay exact. `is` means equality of canonical forms: reflexive
	§ and sound, and for values on a single base it coincides with numeric
	§ equality — whether a value mixing both bases can ever equal another
	§ number is an open problem, which is why Transcendental deliberately
	§ does NOT conform to Comparable. Every cross-kind comparison is still
	§ total through the `Number` Namespace, whose covering `compare`
	§ hand-writes those cells.
	namespace Transcendental for Transcendental is Equatable, is Printable {
		§ `is` and `absolute` are native for one reason: neither can be
		§ written on a primitive this Namespace has. Equality is the canonical
		§ form's own — every component is held reduced, so agreement is
		§ structural — and the sign of `a + b·π + c·e` needs an ordering the
		§ deliberately-not-Comparable Transcendental declares nowhere. Both
		§ once asked the covering `Number` instead, which put the entire
		§ numeric tower behind an equality check and behind an absolute value.

		§§ Whether both Transcendentals have the same canonical form.
		§§
		§§ For values on a single base this is exactly numeric equality.
		§§
		§§ @param other — the Transcendental to compare with
		§§ @returns — `true` when the canonical forms agree.
		is(_ other: Transcendental) -> Boolean

		§§ Whether the Transcendentals have different canonical forms — on a single base, different numbers.
		§§
		§§ @param other — the Transcendental to compare with
		§§ @returns — `true` when the canonical forms differ.
		isNot(_ other: Transcendental) -> Boolean {
			<- @::is(other)::negate()
		}

		§§ Adds a number to this Transcendental, exactly. Two Transcendentals may cancel their π and e terms, leaving a Rational.
		overload add {
			(_ other: Integer) -> Transcendental

			(_ other: Rational) -> Transcendental

			§§ Adds another Transcendental — the π and e parts may cancel, collapsing the sum to a Rational.
			(_ other: Transcendental) -> Rational | Transcendental
		}

		§§ Subtracts a number from this Transcendental, exactly. Subtracting equal π and e terms leaves a Rational.
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

		§§ Multiplies this Transcendental with an Integer or Rational, exactly — multiplying by zero collapses to zero. Two Transcendentals can not be multiplied: `π·π` or `π·e` would leave the linear grammar.
		overload multiply {
			(with other: Integer) -> Transcendental | Rational

			(with other: Rational) -> Transcendental | Rational
		}

		§§ Divides this Transcendental by a number, exactly. Dividing by an Integer or Rational is empty only for zero; dividing by another Transcendental succeeds exactly when the two are proportional — `Tau::divide(by Pi)` is `2` — and is empty otherwise.
		overload divide {
			(by other: Integer) -> Optional<Transcendental>

			(by other: Rational) -> Optional<Transcendental>

			§§ Divides by another Transcendental. Proportional values give an exact Rational — Tau divided by Pi is exactly 2. Anything else — π divided by e most famously — is not representable yet and is empty.
			(by other: Transcendental) -> Optional<Rational>
		}

		§§ The Transcendental without its sign — its distance from zero. A value on a single base can never equal a rational, so its sign is decidable; a value mixing π and e refines to a deep documented precision cutoff.
		absolute() -> Transcendental

		§§ The Transcendental with its sign flipped. At least one base term keeps its non-zero coefficient, so the result is again a Transcendental.
		negate() -> Transcendental

		§§ The exact symbolic form — `π`, `2·π`, `e` or `1 + π + e`.
		toString() -> String
	}
}

export {
	Transcendental
}
