implementation {

	variable union: Integer | Fraction = 1/2

	__print(match union -> Integer {
		case Integer where @::isBetween(0, and 11111) { <- @::multiplyWith(2) }
		case 0        { <- 0 }
		case Integer  { <- @::multiplyWith(2) }
		case 0/0      { <- 1/0 }
		case Fraction { <- 1 }
		case Nothing  { <- 0 }
		case String   { <- 0 }
	})

	match { a = 0, b = 1/1 } -> Integer {
		case { a: Integer } { <- @.a }
		case { a = 6, b: Integer } { <- @.a }
		case Integer  { <- @::multiplyWith(2) }
		case 0/0      { <- 1 }
		case Fraction { <- 1 }
		case Nothing  { <- 0 }
		case String   { <- 0 }
	}
}