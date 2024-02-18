implementation {

	variable union: Integer | Fraction = 1/2

	__print(match union {
		case Integer  -> Integer { <- @::multiplyWith(2) }
		case Fraction -> Integer { <- 1 }
	})

}
