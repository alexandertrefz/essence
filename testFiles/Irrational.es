implementation {

	§ Exact square roots — perfect squares collapse to whole numbers,
	§ everything else stays exact and symbolic.
	__print(9::squareRoot())
	__print(2::squareRoot())
	__print(12::squareRoot())

	constant rootTwo = 2::squareRoot()

	__print(match rootTwo -> String {
		case Algebraic {
			§ The round-trip is exact: √2 · √2 is exactly 2.
			__print(@::multiplyWith(@))

			§ Arithmetic stays symbolic.
			__print(@::add(1))
			__print(@::multiplyWith(3))

			§ Dividing by an Irrational can never fail — no Nothing here.
			__print(1::divideBy(@))

			§ Ordering is exact, too: √2 is below 3/2.
			__print(@::compareTo(3/2)::toString())

			<- @::toString()
		}

		case Integer { <- @::toString() }
		case Nothing { <- "not representable" }
	})

	§ π and TAU are exact Transcendentals now, not approximations.
	__print(Number.PI)
	__print(Number.TAU)

	§ Proportional Transcendentals divide exactly: TAU / π = 2.
	__print(Number.TAU::divideBy(Number.PI))

	§ Numeric equality reaches across representations.
	__print(Number.PI::multiplyWith(2)::is(Number.TAU))

	§ Comparing π against 22/7 is exact and total — the classic bound.
	__print(Number.PI::compareTo(22/7)::toString())

	§ The whole tower is comparable through Number, across any two kinds.
	§ An Integer against π, a Rational against π, two Transcendentals.
	__print(3::isLessThan(Number.PI))              § true  (3 < π)
	__print(4::isLessThan(Number.PI))              § false (4 > π)
	constant piBound = 22/7
	__print(piBound::isGreaterThan(Number.PI))     § true  (22/7 > π)
	__print(Number.PI::isLessThan(Number.TAU))     § true  (π < 2·π)
	__print(Number.TAU::isGreaterThanOrEqualTo(Number.PI))

	§ An Integer now adds across the whole tower, staying exact.
	__print(1::add(Number.PI))                     § 1 + π

	§ An Integer against √2, through Number — √2 ≈ 1.414.
	__print(match 2::squareRoot() -> String {
		case Algebraic {
			<- "1 < √2: "::append(1::isLessThan(@)::toString())
				::append(", 2 > √2: ")::append(2::isGreaterThan(@)::toString())
				::append(", 1 + √2 = ")::append(1::add(@)::toString())
		}
		case Integer { <- "collapsed" }
		case Nothing { <- "none" }
	})

	§ `Irrational` names exactly the Union of the two new Types.
	constant someIrrational: Irrational = Number.PI

	__print(match someIrrational -> String {
		case Algebraic { <- "algebraic" }
		case Transcendental { <- "transcendental" }
	})

}
