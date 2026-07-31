implementation {

	§ A recursive Type declaration is not part of the language yet — a
	§ `choice Tree` whose Node carries two more Trees may not name itself,
	§ directly or through another declaration. Until it can, tree-shaped data
	§ lives flat: this file keeps a directory tree as the List of its paths,
	§ and every question about the tree is a walk over that List.

	constant entries = [
		"Readme.md",
		"sources",
		"sources/Lexer.es",
		"sources/Parser.es",
		"tests",
		"tests/Lexer.es",
	]

	§ An entry is a directory exactly when another entry sits inside it.
	function isDirectory(
		_ entry: String,
		within tree: List<String>,
	) -> Boolean {
		<- tree::anyItem(where (other) {
			<- other::starts(with entry::append("/"))
		})
	}

	§ An entry renders as its last segment, indented one step per separator —
	§ the depth a Node would have carried is written in the path itself.
	function rendered(_ entry: String, within tree: List<String>) -> String {
		constant segments = entry::split(on "/")
		constant indent   = "  "::repeat(times segments::length()::subtract(1))
		constant name     = segments::lastItem()::otherwise(entry)

		if isDirectory(entry, within tree) {
			<- "{indent}{name}/"
		} else {
			<- "{indent}{name}"
		}
	}

	§ Sorting the paths is what puts every directory directly above its
	§ contents — a path sorts ahead of every path it is a prefix of.
	entries
		::sort()
		::map((entry) { <- __print(rendered(entry, within entries)) })

	§ And the usual tree questions are List questions.
	constant files = entries::removeEvery(where (entry) {
		<- isDirectory(entry, within entries)
	})

	__print(
		"{files::length()} files, {
			entries::length()::subtract(files::length())
		} directories",
	)
}
