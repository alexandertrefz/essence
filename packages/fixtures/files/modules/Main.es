import {
	from "./A.es" {
		Amount
		averaged
	}
	from "./Geometry.es" {
		Rectangle
		RectangleMeasurable
	}
	from "./math/Math.es" {
		PI as Pi
		square
	}
}

implementation {

	§ `RectangleMeasurable` is never named below — `::area()` dispatches through
	§ it, which is what makes the import a use rather than an unused entry.
	function describe(_ shape: Rectangle) -> String {
		<- "area: {shape::area()}"
	}

	function scaled(_ { cents }: Amount) -> Rational {
		<- cents::multiply(with Pi)
	}

	Terminal.print(describe(Rectangle.of(width 3, height 4))) § area: 12
	Terminal.print(square(5)) § 25
	Terminal.print(scaled(averaged({ cents = 50 }))) § 157
}

export {
	describe
	from "./Geometry.es" { Rectangle }
}
