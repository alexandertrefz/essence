§ Every Diagnostic in this file is a Warning: the Program compiles, and what
§ is wrong is the description rather than the code it describes.

implementation {
	§§ Greets a subject.
	§§
	§§ @param subject who to greet
	§§ @returns the finished greeting
	function greet(subject: String) -> String {
		<- "Hello, "::append(subject)
	}

	§§ Joins two Strings.
	§§
	§§ @param lft — the text to put first
	§§ @param right — the text to put after it
	§§ @returns — the two joined together
	function join(left: String, right: String) -> String {
		<- left::append(right)
	}

	§§ The subject greeted when none is given.
	§§
	§§ @param subject — who to greet
	constant defaultSubject = "World"

	__print(greet(subject defaultSubject))
	__print(join(left "Hello, ", right "Essence!"))
}
