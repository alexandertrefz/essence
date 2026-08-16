§ One of `Optional`'s two Cases met WITHOUT the other. An unannotated
§ `#Value(3)` is inferred as the Case alone rather than as the Union an
§ annotation would have named, and `Optional` is the one Choice spelled by
§ ABSENCE on the JavaScript side — so every position below has to read back as
§ the item itself or as `undefined`, never as a `$case`.

implementation {

	constant present = #Value(3)

	constant nought = Optional<Integer>#Empty

	§ The same lone Case nested, because a shape is compiled once and reached
	§ from every position it appears in.
	constant boxed = { held = #Value(3) }

	constant listed = [#Value(3), #Value(4)]
}

export {
	boxed
	listed
	nought
	present
}
