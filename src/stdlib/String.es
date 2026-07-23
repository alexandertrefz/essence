declarations {

	§ Indices and character counts are by Unicode code point, not UTF-16 code
	§ unit — so `characterAt` never returns a lone surrogate, and `length`
	§ counts what a reader would call characters. Substring Methods
	§ (`startsWith`, `replaceEvery`, …) match on the raw String, which is
	§ correct regardless of unit — as does `splitOn`, except on the empty
	§ separator, which splits into code points rather than code units.
	namespace String for String is Equatable, is Printable, is Comparable {
		§§ Whether this String has no characters at all.
		§§
		§§ @returns true for the empty String, false otherwise
		isEmpty() -> Boolean

		§§ Whether this String has at least one character — the opposite of `isEmpty`.
		§§
		§§ @returns `true` when the String is not empty.
		hasAnyContent() -> Boolean {
			<- @::isEmpty()::negate()
		}

		§§ Checks whether the String has exactly the same characters as another.
		§§
		§§ @param other the String to compare against
		§§ @returns `true` when the Strings are equal.
		is(_ other: String) -> Boolean

		§§ Checks whether the String differs from another in any character.
		§§
		§§ @param other the String to compare against
		§§ @returns `true` when the Strings are not equal.
		isNot(_ other: String) -> Boolean {
			<- @::is(other)::negate()
		}

		§§ Joins another String onto the front of this one.
		§§
		§§ Neither String is changed — the joined result is returned.
		§§
		§§ @param other the String to add to the front
		§§ @returns the two Strings joined together
		prepend(_ other: String) -> String

		§§ Joins another String onto the end of this one.
		§§
		§§ Neither String is changed — the joined result is returned.
		§§
		§§ @param other the String to add to the end
		§§ @returns the two Strings joined together
		append(_ other: String) -> String

		§§ Splits the String at every occurrence of the given separator. `joinWith` on the resulting List is the return trip.
		§§
		§§ @param separator the separator to split at
		§§ @returns the List of pieces, without the separator.
		splitOn(_ separator: String) -> List<String>

		§§ Whether the given String occurs anywhere in this one.
		§§
		§§ @param other the String to look for
		§§ @returns `true` when it occurs.
		contains(_ other: String) -> Boolean

		§§ Whether the given String occurs nowhere in this one.
		§§
		§§ @param other the String to look for
		§§ @returns `true` when it does not occur.
		doesNotContain(_ other: String) -> Boolean {
			<- @::contains(other)::negate()
		}

		§§ How many characters the String has.
		§§
		§§ @returns the number of characters.
		length() -> Integer

		§§ The String's characters, each as its own single-character String.
		§§
		§§ @returns the List of characters.
		characters() -> List<String>

		§§ The character at the given position, counting from zero.
		§§
		§§ @returns the character, or `Nothing` when the position is outside the String.
		characterAt(_ index: Integer) -> Optional<String>

		§§ The String with every character in upper case.
		uppercased() -> String

		§§ The String with every character in lower case.
		lowercased() -> String

		§§ The String without surrounding whitespace.
		trimmed() -> String

		§§ The String without leading whitespace.
		trimmedAtStart() -> String

		§§ The String without trailing whitespace.
		trimmedAtEnd() -> String

		§§ Whether the String begins with the given one.
		startsWith(_ prefix: String) -> Boolean

		§§ Whether the String does not begin with the given one.
		doesNotStartWith(_ prefix: String) -> Boolean {
			<- @::startsWith(prefix)::negate()
		}

		§§ Whether the String ends with the given one.
		endsWith(_ suffix: String) -> Boolean

		§§ Whether the String does not end with the given one.
		doesNotEndWith(_ suffix: String) -> Boolean {
			<- @::endsWith(suffix)::negate()
		}

		§§ The String with every occurrence of one part replaced by another.
		§§
		§§ @returns the String with the replacements made.
		replaceEvery(_ part: String, with replacement: String) -> String

		§§ The String joined to itself the given number of times.
		§§
		§§ @returns the repeated String; the empty String for a count below one.
		repeated(_ count: Integer) -> String

		§§ The String with its characters in the opposite order.
		reversed() -> String

		§§ The characters from one position up to, but not including, another.
		§§
		§§ @param from the first position to include, counting from zero.
		§§ @param to the position to stop before.
		§§ @returns the String of that range of characters.
		slice(from: Integer, to: Integer) -> String

		§§ The position of the first occurrence of the given String.
		§§
		§§ @returns the zero-based position, or `Nothing` when it does not occur.
		firstIndexOf(_ part: String) -> Optional<Integer>

		§§ The String padded at the front, with the given String, up to the given length.
		§§
		§§ @param to the length to reach.
		§§ @param with the String to pad with, repeated as needed.
		§§ @returns the padded String; unchanged when it is already that long.
		paddedAtStart(to: Integer, with pad: String) -> String

		§§ The String padded at the end, with the given String, up to the given length.
		§§
		§§ @param to the length to reach.
		§§ @param with the String to pad with, repeated as needed.
		§§ @returns the padded String; unchanged when it is already that long.
		paddedAtEnd(to: Integer, with pad: String) -> String

		§§ Orders the String against another, by character code point.
		§§
		§§ @param other the String to order against
		§§ @returns `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.
		compareTo(_ other: String) -> Ordering

		§§ Represents the String as itself — Strings are their own representation.
		§§
		§§ @returns the String itself.
		toString() -> String
	}
}
