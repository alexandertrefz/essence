implementation {

	§ Next 2 lines are equivalent.
	__print(Integer.add(66, 34))
	__print(66::add(34))

	§ Next 2 lines are equivalent.
	__print(Integer.subtract(1234, 234))
	__print(1234::subtract(234))
	
	§ Next 2 lines are equivalent.
	__print(Integer.divide(20000, 2))
	__print(20000::divide(2))

	§ Next 2 lines are equivalent.
	__print(Integer.multiply(100, 1000))
	__print(100::multiply(1000))

	§ You can chain and nest these calls as well, of course.
	__print(100::add(11)::multiply(5)::divide(1110::divide(2)))

	§ And you can use numbers of any size, even exceeding the limits of IEEE 754.
	__print(9_007_199_254_740_991::multiply(500))

	§ When Integers are not enough, you can use Fractions.
	__print(Fraction.divide(1/2, 1/6))
	__print(1/2::divide(1/6))

	__print(1/2::multiply(2)::divide(6))

}
