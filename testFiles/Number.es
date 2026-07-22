implementation {

	§ Every builtin Method has two spellings — through its Namespace, or with
	§ `::` on the value itself. Both lines make the same call.
	__print(Integer.add(66, 34))                      § 100
	__print(66::add(34))                              § 100

	§ The everyday arithmetic, in Method form.
	__print(1234::subtract(234))                      § 1000
	__print(100::multiplyWith(1000))                  § 100000

	§ Division leaves the Integers behind — the result is a Rational — and
	§ dividing by zero answers Nothing, so the result wants a match before
	§ chaining onward.
	constant half = match 1110::divideBy(2) -> Rational {
		case Rational { <- @ }
		case Nothing  { <- 1/1 }
	}

	__print(half)                                     § 555/1
	__print(100::add(11)::multiplyWith(5)::subtract(1)::divideBy(half))  § 554/555

	§ Integers are arbitrarily large — IEEE 754 puts no ceiling here.
	__print(9_007_199_254_740_991::multiplyWith(500)) § 4503599627370495500

	§ Rationals stay exact through every step.
	__print(1/2::divideBy(1/6))                       § 3/1
	__print(1/2::multiplyWith(2)::divideBy(6))        § 1/6

}
