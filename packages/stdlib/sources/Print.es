declarations {

	§§ Prints a value to the console and answers with that same value — so a `__print` can wrap any Expression without changing what it evaluates to.
	§§
	§§ @param value — the value to print
	§§ @returns — the value it was given, unchanged.
	function __print<infer Item>(_ value: Item) -> Item
}

export {
	__print
}
