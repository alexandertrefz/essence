import {
	from "./Shapes.es" {
		Circle
		Ellipse
		Rectangle
		area
		area as measure
	}
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
	from "./Shapes.es" { Circle }
}
