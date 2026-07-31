implementation {

	§ Exact square roots — perfect squares collapse to whole numbers,
	§ everything else stays exact and symbolic. A negative has no real root, so
	§ the answer is an Optional and `__print` shows the whole of it.
	__print(9::squareRoot())
	__print(2::squareRoot())
	__print(12::squareRoot())

	constant rootTwo = 2::squareRoot()

	__print(match rootTwo -> String {
		case #Value(root) {
			<- match root -> String {
				case Algebraic {
					§ The round-trip is exact: √2 · √2 is exactly 2.
					__print(@::multiply(with @))

					§ Arithmetic stays symbolic.
					__print(@::add(1))
					__print(@::multiply(with 3))

					§ Dividing by an Irrational can never fail — the answer is
					§ not an Optional at all.
					__print(1::divide(by @))

					§ Ordering is exact, too: √2 is below 3/2.
					__print(@::compare(to 3/2)::toString())

					<- @::toString()
				}

				case Integer { <- @::toString() }
			}
		}

		case #Empty { <- "not representable" }
	})

	§ π and Tau are exact Transcendentals now, not approximations.
	__print(Number.Pi)
	__print(Number.Tau)

	§ Proportional Transcendentals divide exactly: Tau / π = 2.
	__print(Number.Tau::divide(by Number.Pi))

	§ Numeric equality reaches across representations.
	__print(Number.Pi::multiply(with 2)::is(Number.Tau))

	§ Comparing π against 22/7 is exact and total — the classic bound.
	__print(Number.Pi::compare(to 22/7)::toString())

	§ The whole tower is comparable through Number, across any two kinds.
	§ An Integer against π, a Rational against π, two Transcendentals.
	__print(3::isLessThan(Number.Pi)) § true  (3 < π)
	__print(4::isLessThan(Number.Pi)) § false (4 > π)
	constant piBound = 22/7
	__print(piBound::isGreaterThan(Number.Pi)) § true  (22/7 > π)
	__print(Number.Pi::isLessThan(Number.Tau)) § true  (π < 2·π)
	__print(Number.Tau::isGreaterThanOrEqualTo(Number.Pi))

	§ An Integer now adds across the whole tower, staying exact.
	__print(1::add(Number.Pi)) § 1 + π

	§ Euler's number is exact too — the slice holds `a + b·π + c·e`, so π
	§ and e coexist symbolically, and enclosures decide their order.
	__print(Number.E)
	__print(Number.E::isLessThan(Number.Pi)) § true (e ≈ 2.718 < π)
	__print(Number.Pi::add(Number.E)) § π + e, exact and symbolic

	§ π and e are not proportional, so their quotient has no exact form yet.
	__print(Number.Pi::divide(by Number.E))

	§ The golden ratio is Algebraic — `(1 + √5) / 2` — and satisfies its
	§ defining identity exactly: φ² is φ + 1.
	__print(Number.GoldenRatio)
	__print(Number.GoldenRatio::multiply(with Number.GoldenRatio)) § φ² …
	__print(Number.GoldenRatio::add(1)) § … is φ + 1

	§ An Integer against √2, through Number — √2 ≈ 1.414.
	__print(match 2::squareRoot() -> String {
		case #Value(root) {
			<- match root -> String {
				case Algebraic {
					<- "1 < √2: {1::isLessThan(@)}, 2 > √2: {
						2::isGreaterThan(@)
					}, 1 + √2 = {1::add(@)}"
				}
				case Integer   { <- "collapsed" }
			}
		}
		case #Empty { <- "none" }
	})

	§ `Irrational` names exactly the Union of the two new Types.
	constant someIrrational: Irrational = Number.Pi

	__print(match someIrrational -> String {
		case Algebraic      { <- "algebraic" }
		case Transcendental { <- "transcendental" }
	})
}
