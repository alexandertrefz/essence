import {
	Amount              from "./A.es"
	averaged            from "./A.es"
	Rectangle           from "./Geometry.es"
	RectangleMeasurable from "./Geometry.es"
	PI as Pi            from "./math/Math.es"
	square              from "./math/Math.es"
}

implementation {

	§ `RectangleMeasurable` is never named below — `::area()` dispatches through
	§ it, which is what makes the import a use rather than an unused entry.
	function describe(_ shape: Rectangle) -> String {
		<- "area: {shape::area()}"
	}

	function scaled(_ amount: Amount) -> Rational {
		<- amount.cents::multiply(with Pi)
	}

	Terminal.inspect(describe(Rectangle.of(width 3, height 4))) § "area: 12"
	Terminal.inspect(square(5)::toString()) § "25"
	Terminal.inspect(scaled(averaged({ cents = 50 }))::toString()) § "157/1"
}

export {
	describe
	Rectangle from "./Geometry.es"
}
