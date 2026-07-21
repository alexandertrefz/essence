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

	§ `Irrational` names exactly the Union of the two new Types.
	constant someIrrational: Irrational = Number.PI

	__print(match someIrrational -> String {
		case Algebraic { <- "algebraic" }
		case Transcendental { <- "transcendental" }
	})

}
