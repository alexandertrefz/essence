§ Namespaces whose Protocol provides Methods. A host calls a provided Method
§ on the Namespace as Essence does, and one the Namespace writes is its own. A
§ Case of the Choice a Namespace shares its name with keeps that name.

implementation {
	protocol Measurable {
		area() -> Integer

		isEmpty() -> Boolean {
			<- @::area()::is(0)
		}

		scaled(by factor: Integer) -> Integer {
			<- @::area()::multiply(with factor)
		}
	}

	type Rectangle = { width: Integer, height: Integer }

	type Square = { side: Integer }

	namespace Rectangles for Rectangle is Measurable {
		area() -> Integer {
			<- @.width::multiply(with @.height)
		}
	}

	namespace Squares for Square is Measurable {
		area() -> Integer {
			<- @.side::multiply(with @.side)
		}

		isEmpty() -> Boolean {
			<- @.side::isLessThan(2)
		}
	}

	protocol Labelled {
		label() -> String

		Red() -> String {
			<- "{@::label()} in red"
		}

		shout() -> String {
			<- "{@::label()}!"
		}
	}

	choice Colour {
		Red,
		Blue,
	}

	namespace Colour for Colour is Labelled {
		label() -> String {
			<- match @ -> String {
				case #Red  { <- "red" }
				case #Blue { <- "blue" }
			}
		}
	}
}

export {
	Colour
	Labelled
	Measurable
	Rectangle
	Rectangles
	Square
	Squares
}
