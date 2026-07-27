import {
	Circle          from "./Shapes.es"
	Ellipse         from "./Shapes.es"
	Rectangle       from "./Shapes.es"
	area            from "./Shapes.es"
	area as measure from "./Shapes.es"
}

implementation {

	§ `measure` is declared here and imported above — the entry is what gives
	§ way, so this declaration keeps the name. Nothing then reads `area`.
	function measure(_ shape: Rectangle) -> Integer {
		<- shape.width::multiply(with shape.height)
	}
}

export {
	measure
	Circle from "./Shapes.es"
}
