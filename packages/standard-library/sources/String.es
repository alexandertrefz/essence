import {
	Boolean    from "./Boolean.es"
	Comparable from "./Comparable.es"
	Integer    from "./Integer.es"
	List       from "./List.es"
	Optional   from "./Optional.es"
	Ordering   from "./Ordering.es"
	Equatable  from "./Protocols.es"
	Printable  from "./Protocols.es"
}

declarations {

	§ Which end of a String a Method works on. `trim(at:)` and `pad(…, at:)`
	§ are its two users, so it is declared beside them.
	choice Side {
		Start,
		End,
		BothEnds,
	}

	§ Equality and printing are both derived for a Choice of Cases that carry
	§ no payload. This Namespace declares the two and writes neither; see
	§ DEVELOPMENT.md, Why bodies look the way they do.
	namespace Side for Side is Equatable, is Printable {}

	§ Whether a String comparison treats upper and lower case as the same.
	choice CaseSensitivity {
		Sensitive,
		Insensitive,
	}

	namespace CaseSensitivity for CaseSensitivity is Equatable, is Printable {}

	§ Which Unicode normalization form `normalize(as:)` produces. Canonical
	§ (NFC and NFD) keeps the text as it reads, and Compatibility (NFKC and
	§ NFKD) also folds ligatures and superscripts onto plain equivalents.
	§ Composed joins a base and its marks; Decomposed splits them apart.
	choice NormalizationForm {
		ComposedCanonical,
		DecomposedCanonical,
		ComposedCompatibility,
		DecomposedCompatibility,
	}

	namespace NormalizationForm for NormalizationForm
		is Equatable,
		is Printable {}

	§ A character here is a Unicode grapheme cluster: a base with its
	§ combining marks, a ZWJ emoji sequence, a flag's two regional
	§ indicators. The native `split` decides the segmentation (`graphemesOf`
	§ in `String.ts`), and `characters` is `split(on "")`. Every position
	§ Method is written on one of those two, so none cuts a character in
	§ half. Both sides of a comparison are normalized to NFC first, so an
	§ accent composed and one decomposed count, order and compare the same.
	namespace String for String is Equatable, is Printable, is Comparable {
		§§ Answers whether the String has the same characters as another one.
		§§
		§§ The comparison is case-sensitive unless a `CaseSensitivity` says otherwise.
		overload is {
			§§ @param _ — the String to compare against
			§§ @returns — `true` when the Strings are equal.
			(_ other: String) -> Boolean {
				<- @::compare(to other)::is(#Equal)
			}

			§§ @param _ — the String to compare against
			§§ @param comparing — whether case is significant
			§§ @returns — `true` when the Strings are equal under the given `CaseSensitivity`.
			(
				_ other: String,
				comparing sensitivity: CaseSensitivity,
			) -> Boolean {
				<- @::compare(to other, comparing sensitivity)::is(#Equal)
			}
		}

		§§ Orders the String against another one, by character code point.
		§§
		§§ A `CaseSensitivity` of `#Insensitive` folds the case first.
		overload compare {
			§ Native. No Essence expression names a character's code point.

			§§ @param to — the String to order against
			§§ @returns — `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.
			(to other: String) -> Ordering

			§ Case is folded by lower-casing both sides, which approximates
			§ full Unicode case folding. The ordering above then decides.

			§§ @param to — the String to order against
			§§ @param comparing — whether case is significant
			§§ @returns — `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.
			(
				to other: String,
				comparing sensitivity: CaseSensitivity,
			) -> Ordering {
				constant text = @

				<- match sensitivity -> Ordering {
					case #Sensitive   { <- text::compare(to other) }

					case #Insensitive {
						<- text::lowercase()::compare(to other::lowercase())
					}
				}
			}
		}

		§§ Answers the String itself.
		§§
		§§ @returns — the String, unchanged.
		toString() -> String {
			<- @
		}

		§§ Answers whether the String has no characters.
		§§
		§§ @returns — `true` for the empty String, and `false` otherwise.
		isEmpty() -> Boolean {
			<- @::length()::is(0)
		}

		§§ Answers whether the String has at least one character.
		§§
		§§ @returns — `true` when the String is not empty.
		hasCharacters() -> Boolean {
			<- @::isEmpty()::negate()
		}

		§§ Answers whether the given String occurs anywhere in this one.
		§§
		§§ @param _ — the String to look for
		§§ @returns — `true` when it occurs.
		contains(_ other: String) -> Boolean {
			<- @::firstIndex(of other)::hasValue()
		}

		§§ Answers whether the given String occurs nowhere in this one.
		§§
		§§ @param _ — the String to look for
		§§ @returns — `true` when it does not occur.
		doesNotContain(_ other: String) -> Boolean {
			<- @::contains(other)::negate()
		}

		§§ Answers whether the String begins with the given one.
		starts(with prefix: String) -> Boolean {
			§ A prefix longer than the String slices to the whole String,
			§ which can not equal the prefix, so it needs no guard.
			<- @::slice(to prefix::length())::is(prefix)
		}

		§§ Answers whether the String does not begin with the given one.
		doesNotStart(with prefix: String) -> Boolean {
			<- @::starts(with prefix)::negate()
		}

		§ Native. The Essence body slices the last `suffix::length()`
		§ characters and compares them: four walks where the intrinsic is
		§ one. The slice in `starts(with:)` needs no `length`, so that one
		§ stays in Essence.

		§§ Answers whether the String ends with the given one.
		ends(with suffix: String) -> Boolean

		§§ Answers whether the String does not end with the given one.
		doesNotEnd(with suffix: String) -> Boolean {
			<- @::ends(with suffix)::negate()
		}

		§§ Answers the lines of the String, split at every line break.
		§§
		§§ A line break is `\n`, `\r` or `\r\n`. A trailing break leaves a final empty line. The empty String is one empty line.
		§§
		§§ @returns — the List of lines, without the line breaks.
		lines() -> List<String> {
			§ No single `split(on:)` separator expresses all three breaks, so
			§ the other two are folded onto `\n` first. The two-character
			§ break is folded first, or the `\r` in it becomes a line.
			<- @::replaceEvery("\r\n", with "\n")
				::replaceEvery("\r", with "\n")
				::split(on "\n")
		}

		§ Native. `split(on:)` can neither treat every run of whitespace as
		§ one separator nor drop the empty pieces between two of them.

		§§ Answers the words of the String.
		§§
		§§ A word is a run of characters that are not whitespace. The whitespace between the words is dropped.
		§§
		§§ @returns — the List of words, empty when the String is only whitespace.
		words() -> List<String>

		§§ Answers how many characters the String has.
		§§
		§§ @returns — the number of characters.
		length() -> Integer

		§§ Answers the characters of the String, each as its own String.
		§§
		§§ @returns — the List of characters.
		characters() -> List<String> {
			<- @::split(on "")
		}

		§ The first entry is native. The Essence body,
		§ `@::characters()::item(at index)`, allocates 10,001 values to read
		§ one character of a String of 10,000.

		§§ Answers the character at the given position, counting from zero.
		§§
		§§ A negative position counts back from the end: -1 is the last character. A position outside the String answers nothing, and the `defaultingTo:` entry answers the given character instead.
		overload character {
			§§ @param at — the position to read
			§§ @returns — the character, or nothing when the position is outside the String.
			(at index: Integer) -> Optional<String>

			§§ @param at — the position to read
			§§ @param defaultingTo — the character to answer with when the position is outside the String
			§§ @returns — the character, or the given one in its place.
			(at index: Integer, defaultingTo fallback: String) -> String {
				<- @::character(at index)::value(defaultingTo fallback)
			}
		}

		§§ Answers the position of the first occurrence of the given String.
		§§
		§§ The empty String occurs at position 0. A String that does not occur answers nothing, and the `defaultingTo:` entry answers the given position instead.
		overload firstIndex {
			§§ @param of — the String to look for
			§§ @returns — the zero-based position, or nothing when it does not occur.
			(of part: String) -> Optional<Integer> {
				§ The empty part occurs at the start of every String, and
				§ splitting on it would answer the first character's length.
				if part::isEmpty() {
					<- #Value(0)
				} else {
					constant pieces = @::split(on part)

					§ One piece means the separator was never found.
					if pieces::length()::is(1) {
						<- #Empty
					} else {
						§ The first piece is everything before the first
						§ occurrence, so its length is that position and
						§ the fallback never fires.
						<- #Value(pieces::firstItem(defaultingTo "")::length())
					}
				}
			}

			§§ @param of — the String to look for
			§§ @param defaultingTo — the position to answer with when the String does not occur
			§§ @returns — the zero-based position, or the given one in its place.
			(of part: String, defaultingTo fallback: Integer) -> Integer {
				<- @::firstIndex(of part)::value(defaultingTo fallback)
			}
		}

		§§ Answers the position of the last occurrence of the given String.
		§§
		§§ The empty String occurs at the length. A String that does not occur answers nothing, and the `defaultingTo:` entry answers the given position instead.
		overload lastIndex {
			§§ @param of — the String to look for
			§§ @returns — the zero-based position, or nothing when it does not occur.
			(of part: String) -> Optional<Integer> {
				if part::isEmpty() {
					<- #Value(@::length())
				} else {
					§ The last occurrence of the part is the first occurrence
					§ of the reversed part in the reversed String, so
					§ `firstIndex` answers it. A match that far into the
					§ reversal is that far from the right end, so it begins
					§ one part length before that.
					§
					§ Deriving it from `split(on:)` answers the last match
					§ that does not overlap, because splitting consumes each
					§ match. Splitting `"aaa"` on `"aa"` answers 0, where the
					§ last occurrence begins at 1.
					constant length     = @::length()
					constant partLength = part::length()

					<- @::reverse()
						::firstIndex(of part::reverse())
						::map((position) {
							<- length::subtract(position)::subtract(partLength)
						})
				}
			}

			§§ @param of — the String to look for
			§§ @param defaultingTo — the position to answer with when the String does not occur
			§§ @returns — the zero-based position, or the given one in its place.
			(of part: String, defaultingTo fallback: Integer) -> Integer {
				<- @::lastIndex(of part)::value(defaultingTo fallback)
			}
		}

		§§ Joins another String onto the front of this one.
		§§
		§§ @param _ — the String to add to the front
		§§ @returns — the two Strings joined together.
		prepend(_ other: String) -> String {
			<- other::append(@)
		}

		§§ Joins another String onto the end of this one.
		§§
		§§ @param _ — the String to add to the end
		§§ @returns — the two Strings joined together.
		append(_ other: String) -> String

		§§ Splits the String at every occurrence of the given separator.
		§§
		§§ `join(with:)` on the answer rebuilds the String.
		§§
		§§ @param on — the separator to split at
		§§ @returns — the List of pieces, without the separator.
		split(on separator: String) -> List<String>

		§§ Answers how many times the given String occurs in this one.
		§§
		§§ The occurrences do not overlap: `"aaa"::count(of "aa")` is 1. The empty part answers 0.
		§§
		§§ @param of — the String to count
		§§ @returns — the number of occurrences.
		count(of part: String) -> Integer {
			§ Splitting on the part cuts at every occurrence, so there is
			§ one more piece than occurrences. The empty part would cut
			§ between the characters instead.
			if part::isEmpty() {
				<- 0
			} else {
				<- @::split(on part)::length()::subtract(1)
			}
		}

		§§ Answers the String with every character in upper case.
		uppercase() -> String

		§§ Answers the String with every character in lower case.
		lowercase() -> String

		§§ Answers the String in the given Unicode normalization form.
		§§
		§§ Two Strings that look the same can then compare and read the same. The default form is the one `is` and `compare` already work in.
		§§
		§§ @param as — the normalization form to produce; `#ComposedCanonical` when it is left out.
		§§ @returns — the normalized String.
		normalize(as form: NormalizationForm = #ComposedCanonical) -> String

		§§ Answers the String without the whitespace around it.
		§§
		§§ The whitespace goes from both ends when no end is named.
		§§
		§§ @param at — the end to trim; `#BothEnds` when it is left out.
		§§ @returns — the trimmed String.
		trim(at side: Side = #BothEnds) -> String

		§§ Answers the String with every occurrence of one part replaced by another.
		§§
		§§ An empty part matches nothing and leaves the String unchanged.
		§§
		§§ @param _ — the String to look for
		§§ @param with — the String to put in its place
		§§ @returns — the String with the replacements made.
		replaceEvery(_ part: String, with replacement: String) -> String {
			§ The empty part occurs at every position, and
			§ `split(on "")::join` would put the replacement between the
			§ characters. That is a different String, so nothing is replaced.
			if part::isEmpty() {
				<- @
			} else {
				<- @::split(on part)::join(with replacement)
			}
		}

		§§ Answers the String with the first occurrence of one part replaced by another.
		§§
		§§ An empty part, or a part that does not occur, leaves the String unchanged.
		§§
		§§ @param _ — the String to look for
		§§ @param with — the String to put in its place
		§§ @returns — the String with the first replacement made.
		replaceFirst(_ part: String, with replacement: String) -> String {
			§ The empty part is a no-op, as in `replaceEvery`.
			if part::isEmpty() {
				<- @
			} else {
				constant pieces = @::split(on part)

				§ One piece means the part never occurs.
				if pieces::length()::is(1) {
					<- @
				} else {
					§ The first piece is everything before the first
					§ occurrence, and the rest rejoin on the original part.
					constant head = pieces::firstItem(defaultingTo "")

					<- head::append(replacement)
						::append(pieces::removeFirst()::join(with part))
				}
			}
		}

		§ Native. The Essence body builds a List of `count` copies with
		§ `List.repeat` and joins it back into one String.

		§§ Answers the String joined to itself the given number of times.
		§§
		§§ @param times — how many copies to join
		§§ @returns — the repeated String. A count below one answers the empty String.
		repeat(times count: Integer) -> String

		§ Native, and the `lastIndex` derivation above rests on it; see
		§ DEVELOPMENT.md, What to weigh before writing the next one.

		§§ Answers the String with its characters in the opposite order.
		reverse() -> String

		§ Native. The Essence body, `characters()::slice(…)::join(with "")`,
		§ allocates a String per character, two Lists and a join. The native
		§ cuts the window out of the grapheme view and keeps what it cut.

		§§ Answers the characters from one position up to, but not including, another.
		§§
		§§ A negative position counts back from the end, so `slice(from 0, to -1)` drops the last character. An empty or inverted range answers the empty String.
		§§
		§§ @param from — the first position to include; zero when it is left out.
		§§ @param to — the position to stop before; the length when it is left out.
		§§ @returns — the String of that range of characters.
		slice(from start: Integer = 0, to end: Integer = @::length()) -> String

		§§ Answers the String padded with the given String up to the given length.
		§§
		§§ The padding goes at the front when no end is named. `#BothEnds` centres the String.
		§§
		§§ @param to — the length to reach
		§§ @param with — the String to pad with, repeated as needed
		§§ @param at — the end to pad; `#Start` when it is left out.
		§§ @returns — the padded String; unchanged when it is already that long.
		pad(
			to length: Integer,
			with padding: String,
			at side: Side = #Start,
		) -> String {
			if padding::isEmpty() {
				<- @
			}

			constant characterCount = @::length()

			if length::isLessThanOrEqualTo(characterCount) {
				<- @
			}

			constant needed = length::subtract(characterCount)

			§ The padding has at least one character, so repeating it
			§ `needed` times reaches at least `needed` characters.
			constant filler = padding::repeat(times needed)

			§ `@` is rebound inside `match`; see DEVELOPMENT.md, Why bodies
			§ look the way they do.
			constant text = @

			<- match side -> String {
				case #Start { <- text::prepend(filler::slice(to needed)) }

				case #End   { <- text::append(filler::slice(to needed)) }

				case #BothEnds {
					§ Centring splits the padding between the two ends, and
					§ an odd count leaves one character over for the end. A
					§ written `2` is its own refinement proof; see
					§ DEVELOPMENT.md, Why bodies look the way they do.
					constant atStart = needed::quotient(dividingBy 2)

					<- text::prepend(filler::slice(to atStart))
						::append(filler::slice(to needed::subtract(atStart)))
				}
			}
		}
	}
}

export {
	CaseSensitivity
	NormalizationForm
	Side
	String
}
