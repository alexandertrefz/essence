§ Three mistakes in one file, from two stages of the Compiler: the Validator
§ reports the first two and the Enricher the third.
§
§ Every stage runs whatever the stage before it found, so one report holds
§ all three, in the order the lines are written.

implementation {
	type Point = { x: Integer, y: Integer }

	§ The Validator: the Record written here is missing 'y'.
	function origin() -> Point {
		<- { x = 0 }
	}

	§ The Validator again: nothing is returned at all.
	function shifted(_ point: Point) -> Point {
		constant moved = { point with x = point.x::add(1) }
	}

	§ The Enricher: no such name.
	Terminal.print(undeclared)
}
