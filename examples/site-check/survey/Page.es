implementation {

	§ The whole of this example's HTML reading. A page is text, and the one
	§ thing the survey wants out of it is the title, so nothing here parses
	§ anything: two cuts at the tags, and the text between them.

	§§ Answers the text of a page's `title` element.
	§§
	§§ The tags are read as they are written in lower case, which is what the pages this example asks for send. A page with no title, or one whose tag is never closed, answers nothing.
	§§
	§§ @param _ — the page as the host sent it
	§§ @returns — the title, with the whitespace around it trimmed, or nothing.
	function titleOf(_ page: String) -> Optional<String> {
		<- page::split(onFirst "<title>")
			::andThen((opened) {
				<- opened.trailing::split(onFirst "</title>")
			})
			::map((closed) { <- closed.leading::trim() })
	}
}

export {
	titleOf
}

tests {
	test "reads the text between the two tags" {
		require titleOf("<head><title>Beans</title></head>")::is("Beans")
	}

	test "trims what a pretty-printed page leaves around it" {
		require titleOf("<title>\n\tBeans, roasted\n</title>")
			::is("Beans, roasted")
	}

	test "answers nothing for a page that has no title" {
		expect titleOf("<head></head>")::isEmpty()
	}

	test "answers nothing where the tag is never closed" {
		expect titleOf("<title>Beans")::isEmpty()
	}

	test "keeps the case of the title it found" {
		require titleOf("<title>BEANS</title>")::is("BEANS")
	}
}
