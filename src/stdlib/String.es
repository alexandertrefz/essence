declarations {

	§ Which end of a String a Method works on. It lives here because both of
	§ its users do — `trim(at:)` and `pad(…, at:)` — and it is what keeps each
	§ of them ONE Method instead of the three and two they used to be. A fixed
	§ set of modes is a Choice, never a String: `trim(at "start")` would be a
	§ typo waiting to happen, and `trim(at Side#Start)` is exhaustively checked.
	choice Side {
		Start,
		End,
		BothEnds,
	}

	§ The same shape as `Ordering`'s Namespace — unit Cases compared and
	§ printed by tag, with nothing else to say about them. The `Equatable`
	§ conformance is DECLARED and not written: every Choice derives equality
	§ from its tags, so `is` and `isNot` would be the same nested match here
	§ that they were for every other Choice.
	namespace Side for Side is Equatable, is Printable {
		§§ Represents the Side as `Start`, `End` or `BothEnds`.
		§§
		§§ @returns the name of the Side variant.
		toString() -> String {
			<- match @ -> String {
				case #Start { <- "Start" }
				case #End { <- "End" }
				case #BothEnds { <- "BothEnds" }
			}
		}
	}

	§ Indices and character counts are by Unicode code point, not UTF-16 code
	§ unit — so `character(at:)` never returns a lone surrogate, and `length`
	§ counts what a reader would call characters. `split` matches its
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

		§§ Splits the String at every occurrence of the given separator. `join(with:)` on the resulting List is the return trip.
		§§
		§§ @param separator the separator to split at
		§§ @returns the List of pieces, without the separator.
		split(on separator: String) -> List<String>

		§§ Whether the given String occurs anywhere in this one.
		§§
		§§ @param other the String to look for
		§§ @returns `true` when it occurs.
		contains(_ other: String) -> Boolean {
			<- @::firstIndex(of other)::hasValue()
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
			<- @::split(on "")
		}

		§§ The character at the given position, counting from zero.
		§§
		§§ @returns the character, or `Nothing` when the position is outside the String.
		character(at index: Integer) -> Optional<String> {
			<- @::characters()::item(at index)
		}

		§§ The String with every character in upper case.
		uppercased() -> String

		§§ The String with every character in lower case.
		lowercased() -> String

		§ One Method, not three. `trim(at:)` is the single native — it reads
		§ the Case and calls the matching JavaScript intrinsic — and the
		§ no-Argument entry is written on top of it, naming the end it means.
		§ `BothEnds` is the default because trimming usually means both.

		§§ The String without surrounding whitespace — at both ends when called with no Argument, or at the given end.
		§§
		§§ @returns the trimmed String.
		overload trim {
			() -> String {
				<- @::trim(at Side#BothEnds)
			}

			§§ @param at the end to trim
			(at side: Side) -> String
		}

		§§ Whether the String begins with the given one.
		starts(with prefix: String) -> Boolean {
			§ A prefix longer than the String slices to the whole String, which
			§ can not equal it — so the too-long case answers `false` without a
			§ guard of its own.
			<- @::slice(from 0, to prefix::length())::is(prefix)
		}

		§§ Whether the String does not begin with the given one.
		doesNotStart(with prefix: String) -> Boolean {
			<- @::starts(with prefix)::negate()
		}

		§§ Whether the String ends with the given one.
		ends(with suffix: String) -> Boolean {
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
		doesNotEnd(with suffix: String) -> Boolean {
			<- @::ends(with suffix)::negate()
		}

		§ NATIVE on purpose. `@::split(on part)::join(with replacement)` is the
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
		repeat(times count: Integer) -> String {
			§ A count below one repeats into the empty List, which joins to the
			§ empty String.
			<- List.repeat(@, times count)::join(with "")
		}

		§§ The String with its characters in the opposite order.
		reverse() -> String {
			<- @::characters()::reverse()::join(with "")
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
			<- @::characters()::slice(from from, to to)::join(with "")
		}

		§§ The position of the first occurrence of the given String.
		§§
		§§ @returns the zero-based position, or `Nothing` when it does not occur.
		firstIndex(of part: String) -> Optional<Integer> {
			§ The empty part occurs at the very start of every String, the
			§ empty String included — and splitting on it would answer the
			§ length of the first CHARACTER instead, so it is answered here.
			if part::isEmpty() { <- 0 }

			constant pieces = @::split(on part)

			§ One piece means the separator was never found.
			if pieces::length()::is(1) { <- nothing }

			§ Splitting always yields at least one piece, so the fallback is
			§ unreachable; the first piece is everything before the first
			§ occurrence, and its length is that occurrence's position.
			<- pieces::firstItem()::otherwise("")::length()
		}

		§ The same collapse the trim family got, and for the same reason. The
		§ `at:` entry answers for every `Side`, so nothing about the Choice is
		§ left unhandled: `BothEnds` centres, which is what padding both ends
		§ means. Both entries are Essence — the padding is built out of
		§ `repeat` and `slice`, exactly as the two Methods here did before.

		§§ The String padded with the given String up to the given length — at the front when no end is named, or at the given end.
		§§
		§§ @param to the length to reach.
		§§ @param with the String to pad with, repeated as needed.
		§§ @returns the padded String; unchanged when it is already that long.
		overload pad {
			(to length: Integer, with padding: String) -> String {
				<- @::pad(to length, with padding, at Side#Start)
			}

			§§ @param at the end to pad
			(to length: Integer, with padding: String, at side: Side) -> String {
				§ An empty padding has nothing to repeat, and a String already
				§ that long needs nothing — both leave it as it is.
				if padding::isEmpty() { <- @ }

				constant characterCount = @::length()

				if length::isLessThanOrEqualTo(characterCount) { <- @ }

				constant needed = length::subtract(characterCount)

				§ The padding has at least one character, so repeating it
				§ `needed` times is at least `needed` characters long; slicing
				§ cuts a partial repeat off the end, the way padding is built
				§ character by character.
				constant filler = padding::repeat(times needed)

				§ `@` is the SCRUTINEE inside a match, not the receiver, so the
				§ String has to be bound before the match to stay reachable in
				§ the Case bodies.
				constant text = @

				<- match side -> String {
					case #Start {
						<- text::prepend(filler::slice(from 0, to needed))
					}

					case #End {
						<- text::append(filler::slice(from 0, to needed))
					}

					case #BothEnds {
						§ Centring splits the padding between the two ends. An
						§ odd count can not split evenly, so the extra
						§ character goes to the END — the text sits one to the
						§ left, which is what centring in a fixed width
						§ conventionally does. `quotient` can only answer
						§ `Nothing` for a zero divisor, and this one is two.
						constant atStart = needed::quotient(dividingBy 2)::otherwise(0)

						<- text::prepend(filler::slice(from 0, to atStart))
							::append(filler::slice(from 0, to needed::subtract(atStart)))
					}
				}
			}
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
