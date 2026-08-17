implementation {

	constant greeting = "Hello, World"

	§ Length and case.
	Terminal.inspect(greeting::length()) § 12
	Terminal.inspect(greeting::uppercase()) § "HELLO, WORLD"
	Terminal.inspect(greeting::lowercase()) § "hello, world"

	§ Searching and testing.
	Terminal.inspect(greeting::starts(with "Hello")) § true
	Terminal.inspect(greeting::doesNotEnd(with "!")) § true
	Terminal.inspect(greeting::firstIndex(of "World")) § Optional#Value(7)
	Terminal.inspect(greeting::contains("lo,")) § true

	§ Producing new Strings.
	Terminal.inspect(greeting::reverse()) § "dlroW ,olleH"
	Terminal.inspect(greeting::replaceEvery("o", with "0")) § "Hell0, W0rld"
	Terminal.inspect(greeting::slice(from 0, to 5)) § "Hello"
	§ Both ends of `slice` carry a default, so a head and a tail each name one
	§ position. `to` defaults to `@::length()` — a default that reads the
	§ receiver.
	Terminal.inspect(greeting::slice(from 7)) § "World"
	Terminal.inspect(greeting::slice(to 5)) § "Hello"
	Terminal.inspect("ab"::repeat(times 3)) § "ababab"
	Terminal.inspect("  spaced  "::trim()) § "spaced"

	§ Padding reaches a length, counting characters.
	Terminal.inspect("7"::pad(to 3, with "0")) § "007"
	Terminal.inspect("7"::pad(to 3, with ".", at Side#End)) § "7.."

	§ Characters, each its own single-character String.
	Terminal.inspect(greeting::character(at 1)) § Optional#Value("e")
	Terminal.inspect(greeting::character(at 99)) § Optional#Empty
	Terminal.inspect(greeting::characters()::length()) § 12

	§ Indices count Unicode code points, so an emoji stays whole.
	constant emoji = "a😀b"
	Terminal.inspect(emoji::length()) § 3
	Terminal.inspect(emoji::character(at 1)) § Optional#Value("😀")
	Terminal.inspect(emoji::firstIndex(of "b")) § Optional#Value(2)
	Terminal.inspect(emoji::reverse()) § "b😀a"

	§ String is Comparable now, so a List of Strings sorts with a real
	§ comparator, and `compare` orders by code point.
	Terminal.inspect(
		["banana", "apple", "cherry"]::sort(by (a, b) { <- a::compare(to b) }),
	) § ["apple", "banana", "cherry"]

	Terminal.inspect("app"::compare(to "apple")::toString()) § "Less"
}
