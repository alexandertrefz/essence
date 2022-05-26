implementation {

	§ Next 2 lines are equivalent.
	__print(Number.add(66, 34))
	__print(66::add(34))

	§ Next 2 lines are equivalent.
	__print(Number.subtract(1234, 234))
	__print(1234::subtract(234))
	
	§ Next 2 lines are equivalent.
	__print(Number.divide(20000, 2))
	__print(20000::divide(2))

	§ Next 2 lines are equivalent.
	__print(Number.multiply(100, 1000))
	__print(100::multiply(1000))

	§ You can chain and nest these calls as well, of course.
	__print(100::add(11)::multiply(5)::divide(1110::divide(2)))

	§ And you can use numbers of any size, even exceeding the limits of IEEE 754.
	__print(9007199254740991::multiply(500))

}
