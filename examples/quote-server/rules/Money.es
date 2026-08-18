implementation {

	§ An amount of money is a whole number of cents. Cents never lose
	§ anything — an Integer is exact at any size — and a rate applied to them
	§ is a Rational, exact too, so the one rounding a price ever sees is the
	§ one this file does on purpose, back to cents, once.
	namespace Money for Integer {
		§§ The amount as text — `1234` is `€12.34`.
		formatted() -> String {
			constant size  = @::absolute()
			constant euros = size::quotient(dividingBy 100)
			constant cents = size::remainder(dividingBy 100)
				::toString()
				::pad(to 2, with "0")

			if @::isNegative() {
				<- "-€{euros}.{cents}"
			}

			<- "€{euros}.{cents}"
		}

		§§ This amount taken at a rate — `19/100` of `1000` cents is `190` —
		§§ computed exactly and rounded to the nearest cent, halves away from
		§§ zero, once. There is no floating point anywhere in the sum, so
		§§ `1000::percent(19/100)` can not be `189.99999`.
		percent(_ rate: Rational) -> Integer {
			<- @::multiply(with rate)::round()
		}
	}
}

export {
	Money
}

tests {

	suite "Money" {
		test "writes cents as euros" {
			expect 1234::formatted()::is("€12.34")
			expect 7::formatted()::is("€0.07")
			expect 0::formatted()::is("€0.00")
		}

		test "writes a negative amount with the sign in front of it" {
			expect 0::subtract(250)::formatted()::is("-€2.50")
		}

		§ The one rounding a price ever sees. `999 * 19/100` is `189.81`
		§ exactly, and only then does it become a whole number of cents.
		test "takes a rate exactly and rounds once, to the nearest cent" {
			expect 1000::percent(19/100)::is(190)
			expect 999::percent(19/100)::is(190)
			expect 1::percent(1/2)::is(1)
		}
	}
}
