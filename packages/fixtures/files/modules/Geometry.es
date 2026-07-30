implementation {

	§ A Module's names are private unless its `export { … }` block lists them:
	§ `centimetres` below is an implementation detail nobody else can reach.
	type Rectangle = { width: Integer, height: Integer }

	namespace Rectangle for Rectangle {
		static of(width: Integer, height: Integer) -> Rectangle {
			<- { width = width, height = height }
		}
	}

	§ Importing `Rectangle` does not bring this along — a Namespace has to be
	§ imported by name before `rect::area()` resolves through it.
	namespace RectangleMeasurable for Rectangle {
		area() -> Integer {
			<- @.width::multiply(with @.height)
		}

		perimeter() -> Integer {
			<- @.width::add(@.height)::multiply(with 2)
		}
	}

	function centimetres(_ millimetres: Integer) -> Integer {
		<- millimetres::divide(by 10)::round(toward #TowardZero)
	}
}

export {
	Rectangle
	RectangleMeasurable
}
