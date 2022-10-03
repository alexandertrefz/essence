implementation {

	variable Integer | Fraction union = 1/2

	__print(match union {
		case Integer -> Integer {
			<- @::multiply(2)
		}

		case Fraction -> Integer {
			<- 1
		}
	})

}
