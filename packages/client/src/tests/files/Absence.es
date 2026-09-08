§ One of `Optional`'s two Cases met WITHOUT the other. A construction that
§ names no Union is inferred as the Case alone rather than as the Union an
§ annotation would have named, and `Optional` is the one Choice spelled by
§ ABSENCE on the JavaScript side — so every position below has to read back as
§ the item itself or as `undefined`, never as a `$case`. The Choice is written
§ at each one because `Result` declares a `#Value` too, and a bare sigil in a
§ position that decides nothing is `ambiguous-case`.

implementation {

	constant present = Optional<Integer>#Value(3)

	constant nought = Optional<Integer>#Empty

	§ The same lone Case nested, because a shape is compiled once and reached
	§ from every position it appears in.
	constant boxed = { held = Optional<Integer>#Value(3) }

	constant listed = [
		Optional<Integer>#Value(3),
		Optional<Integer>#Value(4),
	]
}

export {
	boxed
	listed
	nought
	present
}
