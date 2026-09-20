§§ Three mistakes, one per stage of the Compiler, in one file.
§§
§§ The Enricher's `unknown-name` used to be the whole report: the Validator
§§ only ran over a Program the Enricher had nothing to say about, so the two
§§ Diagnostics above it took two more runs to find. Every stage runs now, and
§§ the report comes out in the order the lines are written.
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
