import {
	§ self-import — a Module's own names are in scope in it already, so an
	§ entry asking for one of them has nowhere to bring it from.
	from "./Mirror.es" { mirrored }
	from "./Shapes.es" {
		Rectangle
		§ unknown-export — the near miss is offered from the names the other
		§ Module does export.
		aera
		§ duplicate-import — the second entry binds a name the first one
		§ already bound.
		area
		area
	}
}

implementation {

	function mirrored(_ shape: Rectangle) -> Integer {
		<- area(shape)
	}
}

export {
	mirrored
}
