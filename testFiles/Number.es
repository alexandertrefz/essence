implementation {

	§ Next 2 lines are equivalent.
	__print(Integer.add(66, 34))
	__print(66::add(34))

	§ Next 2 lines are equivalent.
	__print(Integer.subtract(1234, 234))
	__print(1234::subtract(234))
	
	§ Next 2 lines are equivalent.
	__print(Integer.divideBy(20000, 2))
	__print(20000::divideBy(2))

	§ Next 2 lines are equivalent.
	__print(Integer.multiplyWith(100, 1000))
	__print(100::multiplyWith(1000))

	§ You can chain and nest these calls as well, of course. Since dividing
	§ might not produce a value, you match on its result before chaining onward.
	constant half = match 1110::divideBy(2) -> Fraction {
		case Fraction {
			<- @
		}

		case Nothing {
			<- 1/1
		}
	}

	__print(100::add(11)::multiplyWith(5)::subtract(1)::divideBy(half))

	§ And you can use numbers of any size, even exceeding the limits of IEEE 754.
	__print(9_007_199_254_740_991::multiplyWith(500))

	§ When Integers are not enough, you can use Fractions.
	__print(Fraction.divideBy(1/2, 1/6))
	__print(1/2::divideBy(1/6))

	__print(1/2::multiplyWith(2)::divideBy(6))

}
