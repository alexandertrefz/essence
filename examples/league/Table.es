import {
	Outcome  from "./Standings.es"
	Standing from "./Standings.es"
}

implementation {

	§ Everything the rest of the program computes stays exact — a rate is a
	§ Rational, `5/3` is `5/3`. This is the one place a number is rounded, and
	§ it happens as late as it can: when a value is turned into text.
	namespace Decimal {
		§§ A Rational written with `places` decimal places — two unless asked
		§§ otherwise — rounded once, halves away from zero: `5/3` is `1.67`.
		static formatted(_ value: Rational, places: Integer = 2) -> String {
			§ Scale up, round to an Integer, and take that Integer apart into
			§ the digits before the point and after it. `product` of the
			§ repeated tens is the power the language has no operator for.
			§
			§ A quotient by a COMPUTED divisor is an Optional — the divisor
			§ might be zero — unless the divisor is proven not to be. The `if`
			§ is that proof: inside it `scale` is a NonZeroInteger and both
			§ divisions answer bare. Outside it there is nothing to divide by,
			§ and the sensible reading of "no places" is the rounded whole.
			constant scale  = List.repeat(10, times places)::product()
			constant scaled = value::multiply(with scale)::round()
			constant sign   = signOf(scaled)
			constant size   = scaled::absolute()

			if scale::isNot(0)::and(places::isPositive()) {
				constant whole    = size::quotient(dividingBy scale)
				constant fraction = size::remainder(dividingBy scale)
					::toString()
					::pad(to places, with "0")

				<- "{sign}{whole}.{fraction}"
			}

			<- "{sign}{size}"
		}
	}

	function signOf(_ value: Integer) -> String {
		if value::isNegative() {
			<- "-"
		}

		<- ""
	}

	§ A goal difference reads with its sign, and zero reads as itself.
	function signed(_ difference: Integer) -> String {
		if difference::isPositive() {
			<- "+{difference}"
		}

		<- "{difference}"
	}

	§ A column is a padded String. Numbers sit against the right edge of
	§ their column, text against the left.
	function column(_ text: String, width: Integer) -> String {
		<- text::pad(to width, with " ")
	}

	function label(_ text: String, width: Integer) -> String {
		<- text::pad(to width, with " ", at #End)
	}

	constant nameWidth = 18

	namespace Table {
		§§ The table as text: a title, a header, and one row per Standing in
		§§ the order given — so it renders whatever order it is handed, and
		§§ `Standings.ranked` is what makes that the league order.
		static render(
			_ standings: NonEmptyList<Standing>,
			titled title: String,
		) -> String {
			constant header = ""::append(column("#", width 2))
				::append("  ")
				::append(label("Team", width nameWidth))
				::append(column("P", width 3))
				::append(column("W", width 3))
				::append(column("D", width 3))
				::append(column("L", width 3))
				::append(column("F:A", width 8))
				::append(column("GD", width 5))
				::append(column("Pts", width 5))
				::append("  Form")

			§ `enumerate` walks the rows beside the positions they stand at,
			§ and a table counts from one where a List counts from zero.
			constant rows = standings
				::enumerate()
				::map(({ index, item }) {
					<- Table.row(item, at index::add(1))
				})

			<- [title, "-"::repeat(times header::length()), header]
				::append(contentsOf rows)
				::join(with "\n")
		}

		§§ One row. The five most recent outcomes print as the form guide.
		static row(_ standing: Standing, at position: Integer) -> String {
			constant scored   = standing.goalsFor
			constant conceded = standing.goalsAgainst

			<- ""::append(column("{position}", width 2))
				::append("  ")
				::append(label(standing.team.name, width nameWidth))
				::append(column("{standing.played}", width 3))
				::append(column("{standing.won}", width 3))
				::append(column("{standing.drawn}", width 3))
				::append(column("{standing.lost}", width 3))
				::append(column("{scored}:{conceded}", width 8))
				::append(column(signed(standing::goalDifference()), width 5))
				::append(column("{standing.points}", width 5))
				::append("  ")
				::append(standing::recentForm()::join(with ""))
		}
	}
}

export {
	Decimal
	Table
}

tests {

	suite "Decimal" {
		test "writes a rate with two places, rounded once at the end" {
			expect Decimal.formatted(5/3)::is("1.67")
			expect Decimal.formatted(1/2)::is("0.50")
		}

		§ Halves go away from zero, which is why this is `-1.67` and not
		§ `-1.66`.
		test "writes the sign in front of a value below zero" {
			expect Decimal.formatted(0/1::subtract(5/3))::is("-1.67")
		}

		test "writes the whole number where no places were asked for" {
			expect Decimal.formatted(5/3, places 0)::is("2")
		}
	}
}
