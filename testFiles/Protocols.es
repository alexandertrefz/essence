implementation {

	§§ Anything with an area to measure.
	protocol Measurable {
		area() -> Number
	}

	type Rectangle = { width: Integer, height: Integer }
	type Circle = { radius: Integer }

	namespace RectangleMeasurable for Rectangle is Measurable {
		area() -> Number {
			<- @.width::multiplyWith(@.height)
		}
	}

	namespace CircleMeasurable for Circle is Measurable {
		area() -> Number {
			§ Close enough to π for a demonstration.
			<- @.radius::multiplyWith(@.radius)::multiplyWith(355/113)
		}
	}

	§§ Works for any Type with a Measurable conformance in scope.
	function describeArea <infer Shape is Measurable>(_ shape: Shape) -> String {
		<- match shape::area() -> String {
			case Integer  { <- @::toString() }
			case Rational { <- @::toString() }
			case Algebraic { <- @::toString() }
			case Transcendental { <- @::toString() }
		}
	}

	__print(describeArea({ width = 3, height = 4 }))
	__print(describeArea({ radius = 2 }))

	§ The builtin Types conform to the core Protocols — Equatable and
	§ Printable for all of them, and Comparable for the ordered ones:
	§ Integer, Rational, Algebraic and String. (Transcendentals order only
	§ through Number, so they carry no Comparable conformance of their own.)

	function smallerOf <infer Item is Comparable>(_ a: Item, _ b: Item) -> Item {
		<- match a::compareTo(b) -> Item {
			case #Less    { <- a }
			case #Equal   { <- a }
			case #Greater { <- b }
		}
	}

	__print(smallerOf(5, 3))
	__print(smallerOf(1/2, 1/3))
	__print(1::compareTo(2)::toString())
	__print(Ordering#Less::is(1::compareTo(2)))
}
