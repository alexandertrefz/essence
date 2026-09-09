implementation {

	§ An amount of money is a whole number of cents. Cents never lose
	§ anything — an Integer is exact at any size — and a rate applied to them
	§ is a Rational, exact too, so the one rounding a price ever sees is the
	§ one this file does on purpose, back to cents, once.
	namespace Money for Integer {
		§§ The amount as text — `1234` is `€12.34`.
		formatted() -> String {
			§ Cents are the last two places of the number, which is what
			§ `scaledBy:` writes: the point two places in from the right, and
			§ a shorter number padded out to reach it. Nothing here divides,
			§ and nothing pads a String by hand.
			§
			§ Only the sign is left, and it goes in front of the SYMBOL rather
			§ than in front of the digits — the one thing no numeric format
			§ has a word for. A shop dealing in thousands would want the digit
			§ groups separated as well, which is the `groupingWith:` entry of
			§ the same Method:
			§ `Rational.of(@, over 100)::toString(as #Decimal, toPlaces 2, groupingWith ",")`.
			§ It is the one rendering that has to build the Rational, and this
			§ shop's amounts never reach it.
			constant amount = @::absolute()::toString(scaledBy 2)

			if @::isNegative() {
				<- "-€{amount}"
			}

			<- "€{amount}"
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
