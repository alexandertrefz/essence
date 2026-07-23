declarations {

	§ Indices and character counts are by Unicode code point, not UTF-16 code
	§ unit — so `characterAt` never returns a lone surrogate, and `length`
	§ counts what a reader would call characters. `splitOn` matches its
	§ separator on the raw String, which is correct regardless of unit, except
	§ on the empty separator, which splits into code points rather than code
	§ units; `characters` IS that case, and every Method below that reads
	§ positions is written on top of it, so the code-point view is the only one
	§ a Program can observe. The one Method still matching raw code units is
	§ `replaceEvery`, whose empty-part behaviour no Essence expression can
	§ spell — see its note.
	namespace String for String is Equatable, is Printable, is Comparable {
		§§ Whether this String has no characters at all.
		§§
		§§ @returns true for the empty String, false otherwise
		isEmpty() -> Boolean {
			<- @::length()::is(0)
		}

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
		is(_ other: String) -> Boolean {
			<- @::compareTo(other)::is(Ordering#Equal)
		}

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
		prepend(_ other: String) -> String {
			<- other::append(@)
		}

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
		contains(_ other: String) -> Boolean {
			<- match @::firstIndexOf(other) -> Boolean {
				case Nothing { <- false }
				case _ { <- true }
			}
		}

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
		characters() -> List<String> {
			§ Splitting on the empty separator is defined to split by code
			§ point, which is exactly what a character is here.
			<- @::splitOn("")
		}

		§§ The character at the given position, counting from zero.
		§§
		§§ @returns the character, or `Nothing` when the position is outside the String.
		characterAt(_ index: Integer) -> Optional<String> {
			<- @::characters()::itemAt(index)
		}

		§§ The String with every character in upper case.
		uppercased() -> String

		§§ The String with every character in lower case.
		lowercased() -> String

		§§ The String without surrounding whitespace.
		trimmed() -> String {
			<- @::trimmedAtStart()::trimmedAtEnd()
		}

		§§ The String without leading whitespace.
		trimmedAtStart() -> String

		§§ The String without trailing whitespace.
		trimmedAtEnd() -> String

		§§ Whether the String begins with the given one.
		startsWith(_ prefix: String) -> Boolean {
			§ A prefix longer than the String slices to the whole String, which
			§ can not equal it — so the too-long case answers `false` without a
			§ guard of its own.
			<- @::slice(from 0, to prefix::length())::is(prefix)
		}

		§§ Whether the String does not begin with the given one.
		doesNotStartWith(_ prefix: String) -> Boolean {
			<- @::startsWith(prefix)::negate()
		}

		§§ Whether the String ends with the given one.
		endsWith(_ suffix: String) -> Boolean {
			§ A suffix longer than the String makes the start position
			§ negative, which `slice` clamps to zero — the whole String, which
			§ can not equal a longer suffix, so that case answers `false` too.
			§ The length is bound once: `length` walks the characters, and
			§ both ends of the slice need it.
			constant characterCount = @::length()

			<- @::slice(
				from characterCount::subtract(suffix::length()),
				to characterCount,
			)::is(suffix)
		}

		§§ Whether the String does not end with the given one.
		doesNotEndWith(_ suffix: String) -> Boolean {
			<- @::endsWith(suffix)::negate()
		}

		§ NATIVE on purpose. `@::splitOn(part)::joinWith(replacement)` is the
		§ obvious body and it is WRONG: on the empty part the runtime places
		§ the replacement at every UTF-16 code UNIT boundary — before the
		§ first character and after the last one included, and between the two
		§ halves of an astral character — while the Essence body would join
		§ code points with no outer separators. Essence can not see code units
		§ at all, so no body reproduces it; the native stays until the
		§ empty-part case is respecified.

		§§ The String with every occurrence of one part replaced by another.
		§§
		§§ @returns the String with the replacements made.
		replaceEvery(_ part: String, with replacement: String) -> String

		§§ The String joined to itself the given number of times.
		§§
		§§ @returns the repeated String; the empty String for a count below one.
		repeated(_ count: Integer) -> String {
			§ A count below one repeats into the empty List, which joins to the
			§ empty String.
			<- List.repeating(@, times count)::joinWith("")
		}

		§§ The String with its characters in the opposite order.
		reversed() -> String {
			<- @::characters()::reversed()::joinWith("")
		}

		§§ The characters from one position up to, but not including, another.
		§§
		§§ @param from the first position to include, counting from zero.
		§§ @param to the position to stop before.
		§§ @returns the String of that range of characters.
		slice(from: Integer, to: Integer) -> String {
			§ `List.slice` clamps each end to the List and answers the empty
			§ List for an empty or inverted range, which is exactly what a
			§ String slice does with its own bounds.
			<- @::characters()::slice(from from, to to)::joinWith("")
		}

		§§ The position of the first occurrence of the given String.
		§§
		§§ @returns the zero-based position, or `Nothing` when it does not occur.
		firstIndexOf(_ part: String) -> Optional<Integer> {
			§ The empty part occurs at the very start of every String, the
			§ empty String included — and splitting on it would answer the
			§ length of the first CHARACTER instead, so it is answered here.
			if part::isEmpty() { <- 0 }

			constant pieces = @::splitOn(part)

			§ One piece means the separator was never found.
			if pieces::length()::is(1) { <- nothing }

			§ Splitting always yields at least one piece, so the fallback is
			§ unreachable; the first piece is everything before the first
			§ occurrence, and its length is that occurrence's position.
			<- pieces::firstItem()::otherwise("")::length()
		}

		§§ The String padded at the front, with the given String, up to the given length.
		§§
		§§ @param to the length to reach.
		§§ @param with the String to pad with, repeated as needed.
		§§ @returns the padded String; unchanged when it is already that long.
		paddedAtStart(to: Integer, with pad: String) -> String {
			§ An empty pad has nothing to repeat, and a String already that
			§ long needs nothing — both leave it as it is.
			if pad::isEmpty() { <- @ }

			constant characterCount = @::length()

			if to::isLessThanOrEqualTo(characterCount) { <- @ }

			constant needed = to::subtract(characterCount)

			§ The pad has at least one character, so repeating it `needed`
			§ times is at least `needed` characters long; slicing to `needed`
			§ cuts a partial pad off the end, the way the padding is built
			§ character by character.
			<- @::prepend(pad::repeated(needed)::slice(from 0, to needed))
		}

		§§ The String padded at the end, with the given String, up to the given length.
		§§
		§§ @param to the length to reach.
		§§ @param with the String to pad with, repeated as needed.
		§§ @returns the padded String; unchanged when it is already that long.
		paddedAtEnd(to: Integer, with pad: String) -> String {
			if pad::isEmpty() { <- @ }

			constant characterCount = @::length()

			if to::isLessThanOrEqualTo(characterCount) { <- @ }

			constant needed = to::subtract(characterCount)

			<- @::append(pad::repeated(needed)::slice(from 0, to needed))
		}

		§§ Orders the String against another, by character code point.
		§§
		§§ @param other the String to order against
		§§ @returns `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.
		compareTo(_ other: String) -> Ordering

		§§ Represents the String as itself — Strings are their own representation.
		§§
		§§ @returns the String itself.
		toString() -> String {
			<- @
		}
	}
}
