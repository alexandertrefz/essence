§ Deliberately broken: a member path with a call attached. A path is the
§ Function that reads its members, so there is nothing for a call to be on.

implementation {
	type Line = { total: Rational, label: String }

	constant lines: List<Line> = []

	§ A Method call on the value a path reads.
	constant rounded = lines::map(.total::rounded())
}
