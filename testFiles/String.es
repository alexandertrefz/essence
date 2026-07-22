implementation {

	constant greeting = "Hello, World"

	§ Length and case.
	__print(greeting::length())            § 12
	__print(greeting::uppercased())        § "HELLO, WORLD"
	__print(greeting::lowercased())        § "hello, world"

	§ Searching and testing.
	__print(greeting::startsWith("Hello")) § true
	__print(greeting::doesNotEndWith("!")) § true
	__print(greeting::firstIndexOf("World")) § 7
	__print(greeting::contains("lo,"))     § true

	§ Producing new Strings.
	__print(greeting::reversed())          § "dlroW ,olleH"
	__print(greeting::replaceEvery("o", with "0")) § "Hell0, W0rld"
	__print(greeting::slice(from 0, to 5)) § "Hello"
	__print("ab"::repeated(3))             § "ababab"
	__print("  spaced  "::trimmed())       § "spaced"

	§ Padding reaches a length, counting characters.
	__print("7"::paddedAtStart(to 3, with "0"))  § "007"
	__print("7"::paddedAtEnd(to 3, with "."))    § "7.."

	§ Characters, each its own single-character String.
	__print(greeting::characterAt(1))      § "e"
	__print(greeting::characterAt(99))     § Nothing
	__print(greeting::characters()::length()) § 12

	§ Indices count Unicode code points, so an emoji stays whole.
	constant emoji = "a😀b"
	__print(emoji::length())               § 3
	__print(emoji::characterAt(1))         § "😀"
	__print(emoji::firstIndexOf("b"))      § 2
	__print(emoji::reversed())             § "b😀a"

	§ String is Comparable now, so a List of Strings sorts with a real
	§ comparator, and `compareTo` orders by code point.
	__print(["banana", "apple", "cherry"]::sortedBy((a, b) {
		<- a::compareTo(b)
	}))                                    § ["apple", "banana", "cherry"]

	__print("app"::compareTo("apple")::toString()) § "Less"

}
