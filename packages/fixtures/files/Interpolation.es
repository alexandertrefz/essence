implementation {

	§ A String Literal interpolates any Printable value written in a `{ … }`
	§ hole — the `toString` is implied, exactly as `List::join(with:)` calls it
	§ for its items. A String with no hole is an ordinary String Literal.

	constant name = "World"
	constant count = 3

	§ Values of different Types, each rendered by its own `toString`.
	__print("Hello, {name}! You have {count} left.")
	__print("one plus two is {1::add(2)}") § the Integer renders itself
	__print("the answer is {count::isBetween(1, and 5)}") § a Boolean

	§ A hole holds a whole Expression, not just a name.
	__print("reversed: {name::reverse()}, upper: {name::uppercased()}")

	§ Escapes: a quote, a backslash, and a literal brace inside a String.
	__print("she said \"hi\" \\ wrote \{braces\}")

	§ A hole nested inside a hole's own String.
	__print("greeting is {"Hello, {name}"}")

	§ An empty hole renders the empty String, so this is just the two words.
	__print("empty{""}between")

	§ Interpolation is an ordinary String Expression — it can be named, passed
	§ and combined like any other.
	constant sentence = "{name} has {count} apples"
	__print(sentence::append(" today"))
}
