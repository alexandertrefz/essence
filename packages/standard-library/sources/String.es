import {
	from "./Boolean.es" { Boolean }
	from "./Comparable.es" { Comparable }
	from "./Integer.es" {
		Integer
		NonNegativeInteger
		PositiveInteger
	}
	from "./List.es" {
		List
		NonEmptyList
	}
	from "./Optional.es" { Optional }
	from "./Ordering.es" { Ordering }
	from "./Protocols.es" {
		Equatable
		Printable
	}
}

declarations {

	§ `trim(at:)` and `pad(…, at:)` are its two users, so it is declared beside
	§ them.

	§§ Which end of a String a Method works on: the start, the end, or both ends.
	§§
	§§ `trim` works on both ends when a call names no side, and `pad` works on the start.
	choice Side {
		Start,
		End,
		BothEnds,
	}

	§ Equality and printing are both derived for a Choice of Cases that carry
	§ no payload. This Namespace declares the two and writes neither; see
	§ DEVELOPMENT.md, Why bodies look the way they do.
	namespace Side for Side is Equatable, is Printable {}

	§§ Whether a String comparison treats upper and lower case as the same.
	§§
	§§ `#Sensitive` tells the two apart, and `#Insensitive` does not. A comparison that names no sensitivity is sensitive.
	choice CaseSensitivity {
		Sensitive,
		Insensitive,
	}

	namespace CaseSensitivity for CaseSensitivity is Equatable, is Printable {}

	§§ Which Unicode normalization form `normalize(as:)` produces.
	§§
	§§ The canonical forms, NFC and NFD, keep the text as it reads. Composed joins a base and its marks, and Decomposed splits them apart. The compatibility forms, NFKC and NFKD, also fold ligatures and superscripts onto plain equivalents, which changes the text.
	choice NormalizationForm {
		ComposedCanonical,
		DecomposedCanonical,
		ComposedCompatibility,
		DecomposedCompatibility,
	}

	namespace NormalizationForm for NormalizationForm
		is Equatable,
		is Printable {}

	§§ A String proven to have a character in it, as a checked refinement of `String`.
	§§
	§§ The proof is what lets `length` answer above zero, and `firstCharacter` and `lastCharacter` answer a character rather than an Optional. A String written down with a character in it carries the proof. A String a Program is handed earns it through an `if` asking `hasCharacters`, or the `else` of one asking `isEmpty`.
	§§
	§§ `split(on:)` reads the proof on its separator rather than on the receiver. A separator with a character in it always leaves a piece, so the answer is a NonEmptyList.
	type NonEmptyString = String where @::hasCharacters()

	§ The predicate is a chain, so it stays a question of its own and this
	§ Type is written on it rather than on `length`. See DEVELOPMENT.md, Why
	§ bodies look the way they do.

	§§ A String of one character, as a checked refinement of `String`.
	§§
	§§ A character is a Unicode grapheme cluster, which is the unit every position Method here counts. The proof is what lets `characters` and `character(at:)` name what they answer. A String written down with one character in it carries the proof.
	§§
	§§ A Character is a String, so it answers everything a String answers and goes wherever a String is wanted.
	type Character = String where @::isOneCharacter()

	§ A character here is a Unicode grapheme cluster: a base with its
	§ combining marks, a ZWJ emoji sequence, a flag's two regional
	§ indicators. The native `split` decides the segmentation (`graphemesOf`
	§ in `String.ts`), and `characters` is `split(on "")`. Every position
	§ Method is written on one of those two or reads the same view natively,
	§ so none cuts a character in half. Both sides of a comparison are
	§ normalized to NFC first, so an accent composed and one decomposed
	§ count, order and compare the same.
	namespace String for String is Equatable, is Printable, is Comparable {
		§ Native, both entries. A code point that names no character has to
		§ be refused, and no Essence expression names a code point at all.

		§§ Builds a String out of Unicode code points.
		§§
		§§ A point that names no character answers nothing. A surrogate names none, and neither does a point past the last one Unicode gives.
		overload static of {
			§§ @example
			§§   expect String.of(codePoint 97)::is("a")
			§§   expect String.of(codePoint 55296)::isEmpty()
			§§
			§§ @param codePoint — the code point to read, proven not to be negative
			§§ @returns — the String of that one character, or nothing when the point names none.
			(codePoint code: NonNegativeInteger) -> Optional<String>

			§§ Builds a String out of a List of Unicode code points.
			§§
			§§ One point that names no character refuses the whole List. A String missing the characters it could not read is a String no caller asked for. An empty List answers the empty String.
			§§
			§§ @example
			§§   expect String.of(codePoints [104, 105])::is("hi")
			§§   expect String.of(codePoints [104, -1])::isEmpty()
			§§
			§§ @param codePoints — the code points to read
			§§ @returns — the String of those characters, or nothing when a point names none.
			(codePoints codes: List<Integer>) -> Optional<String>
		}

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
					case #Sensitive { <- text::compare(to other) }

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
			§ This body is read as well as run. A predicate written as
			§ one call on `@` is that call, so the `else` of an `if`
			§ asking `isEmpty` proves `NonEmptyString`. The chain in
			§ `isEmpty` keeps it a question of its own. See
			§ DEVELOPMENT.md, Why bodies look the way they do.
			<- @::isEmpty()::negate()
		}

		§ The empty part matches nowhere, except as a position at either end.
		§ Every search below answers by that one rule. So `firstIndex(of "")`
		§ is 0 and `lastIndex(of "")` is the length. So `contains("")` is
		§ `true`. And `count(of "")` is 0, while `replaceEvery` and
		§ `replaceFirst` leave the String unchanged. The alternative, an
		§ occurrence between every two characters, would count the length plus
		§ one and put a replacement between the characters. Each entry states
		§ its own answer in its `§§` block; the natives in `String.ts` point
		§ back here.
		§
		§ The three searches are native, so that a question about a position
		§ never builds the pieces `split` builds. The two Booleans and the two
		§ replacements are written on them. Measured on a 10,800-character
		§ ASCII String, one `contains` of a part that does not occur: 504 µs
		§ on `split`, 8 µs on the native `firstIndex`. A Program making
		§ 20,000 of them took 1,856 ms and takes 33 ms.

		§ Every entry below taking a `CaseSensitivity` folds each character
		§ on its own, where `is` and `compare` fold the whole String. A
		§ Method answering a position answers a position of the receiver. A
		§ folding that maps one character onto several code points would
		§ move every position after it. Folding per character keeps a match
		§ as many characters wide as the part is. So the searches, the two
		§ replacements and the two ends all cut on the receiver's own
		§ boundaries. The two rules part company over the Greek final sigma
		§ alone. A whole String folds a closing capital sigma to the final
		§ form, so `"ΟΣ"::is("ος", comparing #Insensitive)` holds where
		§ `contains` of the same part does not.

		§§ Answers whether the given String occurs anywhere in this one.
		§§
		§§ The empty String occurs in every String. The search is case-sensitive unless a `CaseSensitivity` says otherwise.
		§§
		§§ @example
		§§   expect "Lions"::contains("ion")
		§§   expect "Lions"::doesNotContain("Tiger")
		§§   expect "Lions"::contains("ION", comparing #Insensitive)
		overload contains {
			§§ @param _ — the String to look for
			§§ @returns — `true` when it occurs.
			(_ other: String) -> Boolean {
				<- @::firstIndex(of other)::hasValue()
			}

			§§ @param _ — the String to look for
			§§ @param comparing — whether case is significant
			§§ @returns — `true` when it occurs under the given `CaseSensitivity`.
			(
				_ other: String,
				comparing sensitivity: CaseSensitivity,
			) -> Boolean {
				<- @::firstIndex(of other, comparing sensitivity)::hasValue()
			}
		}

		§§ Answers whether the given String occurs nowhere in this one.
		overload doesNotContain {
			§§ @param _ — the String to look for
			§§ @returns — `true` when it does not occur.
			(_ other: String) -> Boolean {
				§ This body is read as well as run, and so are the two
				§ `doesNot` bodies below it. Each asks its contrary's
				§ question over whatever bound the call writes, so the
				§ `else` of an `if` proves a refinement written on either
				§ name. Moving one of the three to native would take that
				§ away. See DEVELOPMENT.md, Why bodies look the way they do.
				<- @::contains(other)::negate()
			}

			§§ @param _ — the String to look for
			§§ @param comparing — whether case is significant
			§§ @returns — `true` when it does not occur under the given `CaseSensitivity`.
			(
				_ other: String,
				comparing sensitivity: CaseSensitivity,
			) -> Boolean {
				<- @::contains(other, comparing sensitivity)::negate()
			}
		}

		§§ Answers whether the String begins with the given one.
		§§
		§§ @example
		§§   expect "Lions"::starts(with "Li")
		§§   expect "Lions"::doesNotStart(with "Ti")
		§§   expect "Lions"::starts(with "li", comparing #Insensitive)
		overload starts {
			§§ @param with — the String to look for at the front
			§§ @returns — `true` when the String begins with it.
			(with prefix: String) -> Boolean {
				§ A prefix longer than the String slices to the whole
				§ String, which can not equal the prefix, so it needs no
				§ guard.
				<- @::slice(to prefix::length())::is(prefix)
			}

			§ Native. The slice above compares two whole Strings. A folded
			§ receiver is compared to a folded prefix character by
			§ character instead; see the note above `contains`.

			§§ @param with — the String to look for at the front
			§§ @param comparing — whether case is significant
			§§ @returns — `true` when the String begins with it under the given `CaseSensitivity`.
			(
				with prefix: String,
				comparing sensitivity: CaseSensitivity,
			) -> Boolean
		}

		§§ Answers whether the String does not begin with the given one.
		overload doesNotStart {
			§§ @param with — the String to look for at the front
			§§ @returns — `true` when the String does not begin with it.
			(with prefix: String) -> Boolean {
				<- @::starts(with prefix)::negate()
			}

			§§ @param with — the String to look for at the front
			§§ @param comparing — whether case is significant
			§§ @returns — `true` when the String does not begin with it under the given `CaseSensitivity`.
			(
				with prefix: String,
				comparing sensitivity: CaseSensitivity,
			) -> Boolean {
				<- @::starts(with prefix, comparing sensitivity)::negate()
			}
		}

		§ Native. The Essence body slices the last `suffix::length()`
		§ characters and compares them: four walks where the intrinsic is
		§ one. The slice in `starts(with:)` needs no `length`, so that one
		§ stays in Essence.

		§§ Answers whether the String ends with the given one.
		overload ends {
			§§ @param with — the String to look for at the end
			§§ @returns — `true` when the String ends with it.
			(with suffix: String) -> Boolean

			§§ @param with — the String to look for at the end
			§§ @param comparing — whether case is significant
			§§ @returns — `true` when the String ends with it under the given `CaseSensitivity`.
			(
				with suffix: String,
				comparing sensitivity: CaseSensitivity,
			) -> Boolean
		}

		§§ Answers whether the String does not end with the given one.
		overload doesNotEnd {
			§§ @param with — the String to look for at the end
			§§ @returns — `true` when the String does not end with it.
			(with suffix: String) -> Boolean {
				<- @::ends(with suffix)::negate()
			}

			§§ @param with — the String to look for at the end
			§§ @param comparing — whether case is significant
			§§ @returns — `true` when the String does not end with it under the given `CaseSensitivity`.
			(
				with suffix: String,
				comparing sensitivity: CaseSensitivity,
			) -> Boolean {
				<- @::ends(with suffix, comparing sensitivity)::negate()
			}
		}

		§§ Answers whether the String is one character long.
		§§
		§§ This is the question the `Character` Type is written on. A String proven to answer `true` here goes wherever a Character is wanted.
		§§
		§§ @example
		§§   expect "a"::isOneCharacter()
		§§   expect "ab"::isOneCharacter()::negate()
		§§
		§§ @returns — `true` when the String holds one character.
		isOneCharacter() -> Boolean {
			§ A chain, so it is a question of its own rather than a reading
			§ of `length`. See DEVELOPMENT.md, Why bodies look the way they
			§ do.
			<- @::length()::is(1)
		}

		§ The four below are native, and each asks the host for a Unicode
		§ character class. That is classification and not a pattern
		§ language. The question is fixed, no part of it is anything a
		§ caller writes, and the answer is a Boolean. The alternative was a
		§ table of code point ranges kept here. It would answer for a
		§ different Unicode version than `is`, `compare` and `normalize` do.
		§ The runtime names the class each one reads.
		§
		§ All four answer `true` for the empty String, which is the answer
		§ `List::hasOnlyItems(where:)` gives an empty List: nothing in it
		§ breaks the rule.

		§§ Answers whether every character of the String is a decimal digit.
		§§
		§§ A digit is any Unicode decimal digit, which is wider than what `Integer.parse` reads: `Integer.parse` reads the notation the language writes. The empty String answers `true`, because nothing in it is not a digit.
		§§
		§§ @example
		§§   expect "2026"::hasOnlyDigits()
		§§   expect "2026-09"::hasOnlyDigits()::negate()
		§§
		§§ @returns — `true` when the String holds decimal digits alone.
		hasOnlyDigits() -> Boolean

		§§ Answers whether every character of the String is a letter.
		§§
		§§ A combining mark counts as part of the letter before it. A mark standing on its own belongs to no letter and answers `false`. The empty String answers `true`.
		§§
		§§ @example
		§§   expect "Grüße"::hasOnlyLetters()
		§§   expect "Rule 34"::hasOnlyLetters()::negate()
		§§
		§§ @returns — `true` when the String holds letters alone.
		hasOnlyLetters() -> Boolean

		§§ Answers whether every character of the String is a letter or a decimal digit.
		§§
		§§ A combining mark counts as part of the character before it. The empty String answers `true`.
		§§
		§§ @example
		§§   expect "route66"::hasOnlyLettersOrDigits()
		§§   expect "route 66"::hasOnlyLettersOrDigits()::negate()
		§§
		§§ @returns — `true` when the String holds letters and digits alone.
		hasOnlyLettersOrDigits() -> Boolean

		§§ Answers whether every character of the String is whitespace.
		§§
		§§ Whitespace is what Unicode calls whitespace, which is the rule `trim` and `words` read. The empty String answers `true`.
		§§
		§§ @example
		§§   expect "   "::hasOnlyWhitespace()
		§§   expect " x "::hasOnlyWhitespace()::negate()
		§§
		§§ @returns — `true` when the String holds whitespace alone.
		hasOnlyWhitespace() -> Boolean

		§§ Answers the lines of the String, split at every line break.
		§§
		§§ A line break is `\n`, `\r` or `\r\n`. A trailing break leaves a final empty line. The empty String is one empty line.
		§§
		§§ @returns — the List of lines, without the line breaks. The List always has a line in it.
		lines() -> NonEmptyList<String> {
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
		§§ @returns — the number of characters, which is never negative.
		length() -> NonNegativeInteger

		§ Native, and the Essence body it replaced was `@::split(on "")`.
		§ The answer is what took it here. A refinement erases before
		§ anything runs, so no expression can say the pieces of the empty
		§ separator are one character each. The native makes that same
		§ call.

		§§ Answers the characters of the String, each as its own String.
		§§
		§§ @returns — the List of characters.
		characters() -> List<Character>

		§ The first entry is native. The Essence body,
		§ `@::characters()::item(at index)`, allocates 10,001 values to read
		§ one character of a String of 10,000.

		§§ Answers the character at the given position, counting from zero.
		§§
		§§ A negative position counts back from the end: -1 is the last character. A position outside the String answers nothing, and the `defaultingTo:` entry answers the given character instead.
		overload character {
			§§ @param at — the position to read
			§§ @returns — the character, or nothing when the position is outside the String.
			(at index: Integer) -> Optional<Character>

			§§ @param at — the position to read
			§§ @param defaultingTo — the character to answer with when the position is outside the String
			§§ @returns — the character, or the given one in its place.
			(at index: Integer, defaultingTo fallback: Character) -> Character {
				<- @::character(at index)::value(defaultingTo fallback)
			}
		}

		§ The first entry is native; see the note above `contains`.

		§§ Answers the position of the first occurrence of the given String.
		§§
		§§ The empty String occurs at position 0. A String that does not occur answers nothing, and the `defaultingTo:` entry answers the given position instead.
		overload firstIndex {
			§§ @param of — the String to look for
			§§ @returns — the zero-based position, or nothing when it does not occur.
			(of part: String) -> Optional<Integer>

			§§ @param of — the String to look for
			§§ @param defaultingTo — the position to answer with when the String does not occur
			§§ @returns — the zero-based position, or the given one in its place.
			(of part: String, defaultingTo fallback: Integer) -> Integer {
				<- @::firstIndex(of part)::value(defaultingTo fallback)
			}

			§ Native, and the same walk with both sides folded; see the note
			§ above `contains`.

			§§ @param of — the String to look for
			§§ @param comparing — whether case is significant
			§§ @returns — the zero-based position, or nothing when it does not occur under the given `CaseSensitivity`.
			(
				of part: String,
				comparing sensitivity: CaseSensitivity,
			) -> Optional<Integer>
		}

		§ The first entry is native, and walks the String from the end. The
		§ occurrence it answers can overlap an earlier one, which a derivation
		§ from `split(on:)` misses. Splitting consumes each match, so `"aaa"`
		§ split on `"aa"` puts the last match at 0, where the last occurrence
		§ begins at 1.

		§§ Answers the position of the last occurrence of the given String.
		§§
		§§ The occurrence can overlap an earlier one: `"aaa"::lastIndex(of "aa")` is 1. The empty String occurs at the length. A String that does not occur answers nothing, and the `defaultingTo:` entry answers the given position instead.
		overload lastIndex {
			§§ @param of — the String to look for
			§§ @returns — the zero-based position, or nothing when it does not occur.
			(of part: String) -> Optional<Integer>

			§§ @param of — the String to look for
			§§ @param defaultingTo — the position to answer with when the String does not occur
			§§ @returns — the zero-based position, or the given one in its place.
			(of part: String, defaultingTo fallback: Integer) -> Integer {
				<- @::lastIndex(of part)::value(defaultingTo fallback)
			}

			§§ @param of — the String to look for
			§§ @param comparing — whether case is significant
			§§ @returns — the zero-based position, or nothing when it does not occur under the given `CaseSensitivity`.
			(
				of part: String,
				comparing sensitivity: CaseSensitivity,
			) -> Optional<Integer>
		}

		§ Both read `character(at:)`, the native that resolves a position.
		§ `List` names its two ends `firstItem` and `lastItem`. A String had
		§ to spell `character(at -1)` to reach its own.

		§§ Answers the first character of the String.
		§§
		§§ The empty String has no first character and answers nothing. The `defaultingTo:` entry answers the given character instead.
		overload firstCharacter {
			§§ @returns — the first character, or nothing when the String is empty.
			() -> Optional<Character> {
				<- @::character(at 0)
			}

			§§ @param defaultingTo — the character to answer with when the String is empty
			§§ @returns — the first character, or the given one in its place.
			(defaultingTo fallback: Character) -> Character {
				<- @::character(at 0, defaultingTo fallback)
			}
		}

		§§ Answers the last character of the String.
		§§
		§§ The empty String has no last character and answers nothing. The `defaultingTo:` entry answers the given character instead.
		overload lastCharacter {
			§§ @returns — the last character, or nothing when the String is empty.
			() -> Optional<Character> {
				<- @::character(at -1)
			}

			§§ @param defaultingTo — the character to answer with when the String is empty
			§§ @returns — the last character, or the given one in its place.
			(defaultingTo fallback: Character) -> Character {
				<- @::character(at -1, defaultingTo fallback)
			}
		}

		§ Native. A code point is the level below a character, and no
		§ Essence expression reaches it. Without this Method nothing
		§ character-level can be computed at all. The `Integer.parse` body
		§ had to look a digit up in a String of the ten of them, once per
		§ digit.

		§§ Answers the Unicode code points of the String.
		§§
		§§ A character is a grapheme cluster and a code point is one point of Unicode. The two counts differ wherever a character is built out of several points. A four-person emoji is one character and seven points.
		§§
		§§ @example
		§§   expect "ab"::codePoints()::is([97, 98])
		§§
		§§ @returns — the List of code points, read off the composed form.
		codePoints() -> List<Integer>

		§ Native, and the same walk `count(of:)` makes; see the note above
		§ `contains`. The Essence spelling calls `firstIndex` and `slice`
		§ once per occurrence, which cuts the rest of the String every time.

		§§ Answers the position of every occurrence of the given String.
		§§
		§§ The occurrences do not overlap, which is the rule `count(of:)` counts by. The empty String occurs at no position.
		§§
		§§ @example
		§§   expect "banana"::everyIndex(of "an")::is([1, 3])
		§§
		§§ @param of — the String to look for
		§§ @returns — the List of zero-based positions, in the order they occur.
		everyIndex(of part: String) -> List<Integer>

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
		§§ `join(with:)` on the answer rebuilds the String. A separator with a character in it always leaves at least one piece, and the entry taking a proven separator answers that.
		overload split {
			§§ @param on — the separator to split at
			§§ @returns — the List of pieces, without the separator.
			(on separator: String) -> List<String>

			§ The same native under the proof: a refinement erases before
			§ anything runs, so the runtime binds both entries to one Function.
			§ The empty separator is the only one that can answer no pieces,
			§ and it is the one this entry refuses.

			§§ Splits the String at every occurrence of a separator proven to have a character.
			§§
			§§ Such a separator cuts between the pieces, and the piece before the first cut is always there. So the answer is never empty.
			§§
			§§ @param on — the separator to split at, proven to have a character
			§§ @returns — the List of pieces, which always holds at least one.
			(on separator: NonEmptyString) -> NonEmptyList<String>

			§ The two below cut at one separator, which is the shape a
			§ `key=value` line wants. The value keeps every separator after
			§ the first. A Program writes them today as a `firstIndex` and
			§ two slices, with the separator's length added in the middle.

			§§ Splits the String at the first occurrence of the given separator.
			§§
			§§ The two pieces are the text before the separator and all the text after it. A separator that does not occur answers nothing. The empty separator occurs at the front, so it answers the empty String and the whole receiver.
			§§
			§§ @example
			§§   constant pair = "key=a=b"::split(onFirst "=")
			§§
			§§   expect pair::hasValue(where (halves) { <- halves.trailing::is("a=b") })
			§§
			§§ @param onFirst — the separator to cut at
			§§ @returns — the text before and after the separator, or nothing when it does not occur.
			(
				onFirst separator: String,
			) -> Optional<{ leading: String, trailing: String }> {
				§ `@` is read inside a Function literal below, so the
				§ receiver is bound here first.
				constant text = @

				<- text::firstIndex(of separator)
					::map((position) {
						<- {
							leading = text::slice(to position),
							trailing = text::slice(
								from position::add(separator::length()),
							),
						}
					})
			}

			§§ Splits the String at the last occurrence of the given separator.
			§§
			§§ The two pieces are the text before the separator and all the text after it. A separator that does not occur answers nothing. The empty separator occurs at the end, so it answers the whole receiver and the empty String.
			§§
			§§ @param onLast — the separator to cut at
			§§ @returns — the text before and after the separator, or nothing when it does not occur.
			(
				onLast separator: String,
			) -> Optional<{ leading: String, trailing: String }> {
				constant text = @

				<- text::lastIndex(of separator)
					::map((position) {
						<- {
							leading = text::slice(to position),
							trailing = text::slice(
								from position::add(separator::length()),
							),
						}
					})
			}

			§ Native. The Essence spelling splits the whole String and joins
			§ the tail back, which builds every piece to throw most of them
			§ away.

			§§ Splits the String at the separator, into no more than the given number of pieces.
			§§
			§§ The last piece keeps every separator the split stopped short of. A count of one answers the receiver alone.
			§§
			§§ @example
			§§   expect "a=b=c"::split(on "=", atMost 2)::is(["a", "b=c"])
			§§
			§§ @param on — the separator to split at, proven to have a character
			§§ @param atMost — how many pieces to answer at the most, proven to be above zero
			§§ @returns — the List of pieces, which always holds at least one.
			(
				on separator: NonEmptyString,
				atMost count: PositiveInteger,
			) -> NonEmptyList<String>
		}

		§ Native; see the note above `contains`. A body on `split(on part)`
		§ builds every piece to count them. A body on `firstIndex` and `slice`
		§ cuts the rest of the String at every occurrence, which is quadratic
		§ in the occurrences. Measured on a 10,800-character ASCII String with
		§ 3,600 occurrences, one count: 537 µs on `split`, 33 µs native.

		§§ Answers how many times the given String occurs in this one.
		§§
		§§ The occurrences do not overlap: `"aaa"::count(of "aa")` is 1. The empty String occurs 0 times.
		overload count {
			§§ @param of — the String to count
			§§ @returns — the number of occurrences.
			(of part: String) -> Integer

			§§ @param of — the String to count
			§§ @param comparing — whether case is significant
			§§ @returns — the number of occurrences under the given `CaseSensitivity`.
			(of part: String, comparing sensitivity: CaseSensitivity) -> Integer
		}

		§§ Answers the String with every character in upper case.
		uppercase() -> String

		§§ Answers the String with every character in lower case.
		lowercase() -> String

		§§ Answers the String in the given Unicode normalization form.
		§§
		§§ Two Strings that look the same can then compare and read the same. The default form is the one `is` and `compare` already work in.
		§§
		§§ The two canonical forms are one text to every other Method here. They differ in the bytes `Terminal.write` emits, so `normalize(as #DecomposedCanonical)::length()` answers what `length()` answered before. The two compatibility forms do change the text.
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
		§§ The occurrences do not overlap. The empty String matches nowhere, so the String comes back unchanged.
		§§
		overload replaceEvery {
			§§ @param _ — the String to look for
			§§ @param with — the String to put in its place
			§§ @returns — the String with the replacements made.
			(_ part: String, with replacement: String) -> String {
				§ The guard is the empty-part rule above `contains`:
				§ `split(on "")::join` would put the replacement between the
				§ characters.
				if part::isEmpty() {
					<- @
				} else {
					<- @::split(on part)::join(with replacement)
				}
			}

			§ Native. The split above cuts on the receiver's own text. A
			§ folded receiver is not the text to build the answer out of;
			§ see the note above `contains`.

			§§ @param _ — the String to look for
			§§ @param with — the String to put in its place
			§§ @param comparing — whether case is significant
			§§ @returns — the String with the replacements made under the given `CaseSensitivity`.
			(
				_ part: String,
				with replacement: String,
				comparing sensitivity: CaseSensitivity,
			) -> String
		}

		§ Written on `firstIndex` and `slice`, so that a String with one
		§ occurrence in it is cut twice rather than split into pieces and
		§ joined back. The guard is the empty-part rule above `contains`:
		§ `firstIndex(of "")` is 0, and cutting there would put the
		§ replacement in front. Measured as a Program making 5,000
		§ replacements in a 10,800-character ASCII String: 629 ms on `split`,
		§ 25 ms here.

		§§ Answers the String with the first occurrence of one part replaced by another.
		§§
		§§ The empty String matches nowhere, so it and a part that does not occur leave the String unchanged.
		§§
		overload replaceFirst {
			§§ @param _ — the String to look for
			§§ @param with — the String to put in its place
			§§ @returns — the String with the first replacement made.
			(_ part: String, with replacement: String) -> String {
				if part::isEmpty() {
					<- @
				}

				§ `@` is rebound inside `match`; see DEVELOPMENT.md, Why
				§ bodies look the way they do.
				constant text = @

				<- match text::firstIndex(of part) -> String {
					case #Empty { <- text }

					case #Value(position) {
						<- text::slice(to position)
							::append(replacement)
							::append(
								text::slice(from position::add(part::length())),
							)
					}
				}
			}

			§ Native, for the reason `replaceEvery`'s folding entry is.

			§§ @param _ — the String to look for
			§§ @param with — the String to put in its place
			§§ @param comparing — whether case is significant
			§§ @returns — the String with the first replacement made under the given `CaseSensitivity`.
			(
				_ part: String,
				with replacement: String,
				comparing sensitivity: CaseSensitivity,
			) -> String
		}

		§ Native. The Essence body builds a List of `count` copies with
		§ `List.repeat` and joins it back into one String.

		§§ Answers the String joined to itself the given number of times.
		§§
		§§ @param times — how many copies to join
		§§ @returns — the repeated String. A count below one answers the empty String.
		repeat(times count: Integer) -> String

		§ Native. The Essence body, `characters()::reverse()::join(with "")`,
		§ segments the joined text afresh. That can pair three regional
		§ indicators into characters the String never had; see DEVELOPMENT.md,
		§ What to weigh before writing the next one.

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
		§§ @param with — the String to pad with, repeated as needed; a space when it is left out.
		§§ @param at — the end to pad; `#Start` when it is left out.
		§§ @returns — the padded String; unchanged when it is already that long.
		pad(
			to length: Integer,
			with padding: String = " ",
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

			§ One copy more than the whole copies that fit reaches at least
			§ `needed` characters, and overshoots by less than one copy. The
			§ alternative, `needed` copies, overshoots by a factor of the
			§ padding's length, and the slice then segments all of it. Measured
			§ as a Program making 200 pads to 10,000 with a ten-character
			§ non-ASCII padding: 937 ms on `needed` copies, 176 ms here. The
			§ divisor is never zero past the guard above, and the fallback is
			§ the `needed` copies, so the filler is long enough either way.
			constant copies = needed
				::quotient(dividingBy padding::length(), defaultingTo needed)
				::add(1)
			constant filler = padding::repeat(times copies)

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

		§§ Answers the String without the given prefix or suffix.
		§§
		§§ The String comes back unchanged when it does not begin or end with the given one. The empty String is a prefix and a suffix of every String, and taking it away changes nothing.
		§§
		§§ @example
		§§   expect "/api/users"::remove(prefix "/api")::is("/users")
		§§   expect "String.es"::remove(suffix ".es")::is("String")
		overload remove {
			§§ @param prefix — the String to take off the front
			§§ @returns — the String without that prefix.
			(prefix part: String) -> String {
				if @::starts(with part) {
					<- @::slice(from part::length())
				} else {
					<- @
				}
			}

			§§ @param suffix — the String to take off the end
			§§ @returns — the String without that suffix.
			(suffix part: String) -> String {
				if @::ends(with part) {
					<- @::slice(to @::length()::subtract(part::length()))
				} else {
					<- @
				}
			}
		}

		§§ Answers the String with its first character in upper case.
		§§
		§§ Every other character is left as it stands. The empty String answers itself.
		§§
		§§ @example
		§§   expect "lions"::capitalize()::is("Lions")
		§§
		§§ @returns — the String with an upper-case first character.
		capitalize() -> String {
			<- @::slice(to 1)::uppercase()::append(@::slice(from 1))
		}

		§§ Answers the String cut down to the given length, ending with an ellipsis.
		§§
		§§ The ellipsis counts toward the length, so the answer is never longer than the length asked for. A String already that short answers itself. A length that leaves no room for the ellipsis answers the ellipsis cut to the length, and a length below one answers the empty String.
		§§
		§§ @example
		§§   expect "Hello, World"::truncate(to 8)::is("Hello, …")
		§§   expect "Hello"::truncate(to 8)::is("Hello")
		§§
		§§ @param to — the length to cut down to
		§§ @param with — the String to end with; a horizontal ellipsis when it is left out
		§§ @returns — the cut String, of that length at the most.
		truncate(to length: Integer, with ellipsis: String = "…") -> String {
			if @::length()::isLessThanOrEqualTo(length) {
				<- @
			}

			if length::isLessThanOrEqualTo(0) {
				<- ""
			}

			constant room = length::subtract(ellipsis::length())

			if room::isLessThanOrEqualTo(0) {
				<- ellipsis::slice(to length)
			} else {
				<- @::slice(to room)::append(ellipsis)
			}
		}

		§§ Answers the String with every line moved in by the given depth.
		§§
		§§ A line that is empty is left as it is, so no line gains whitespace that carries no text. The answer joins the lines with a line feed, whichever line break the String was written with.
		§§
		§§ @example
		§§   expect "text"::indent(by 2)::is("    text")
		§§
		§§ @param by — how many units to move each line in by
		§§ @param with — the unit to move by, repeated as needed; two spaces when it is left out
		§§ @returns — the indented String.
		indent(by depth: Integer, with unit: String = "  ") -> String {
			constant prefix = unit::repeat(times depth)

			<- @::lines()
				::map((line) {
					if line::isEmpty() {
						<- line
					} else {
						<- line::prepend(prefix)
					}
				})
				::join(with "\n")
		}

		§ Native. The counting is by character, so it belongs beside the
		§ other character walks rather than on a number. A card number
		§ reaches it as well as a numeral. The `from:` label names the end
		§ the counting starts at, so `#End` puts the short group at the
		§ front. A `#BothEnds` counts from the end too, because grouping has
		§ a direction rather than two ends. The Choice `trim` and `pad`
		§ already read was taken over a two-Case Choice of its own. That one
		§ would have cost the six registration sites a Choice costs, for one
		§ Method.

		§§ Answers the String with a separator put in every so many characters.
		§§
		§§ The separator goes between the groups and never at either end. A String no longer than one group answers itself.
		§§
		§§ @example
		§§   expect "1234567"::separate(every 3, with ",")::is("1,234,567")
		§§   expect "1234567"::separate(every 3, with ",", from #Start)::is("123,456,7")
		§§
		§§ @param every — how many characters a group holds, proven to be above zero
		§§ @param with — the separator to put between the groups
		§§ @param from — the end to count the groups from; `#End` when it is left out
		§§ @returns — the grouped String.
		separate(
			every size: PositiveInteger,
			with separator: String,
			from side: Side = #End,
		) -> String

		§ Native, and the same Function the printer calls. A String is
		§ quoted inside a List, a Record or a Case and bare on its own. This
		§ is how a Program asks for the first spelling while it builds the
		§ text itself.

		§§ Answers the String as a Program would write it down.
		§§
		§§ The text is put in quotes, and anything a String Literal has to escape is escaped. A character with no spelling of its own is written as its code point.
		§§
		§§ @example
		§§   expect "ab"::quote()::is("\"ab\"")
		§§
		§§ @returns — the quoted String.
		quote() -> String
	}

	§ What a String proven to have a character answers that a bare one can
	§ not, the sister of `namespace NonEmptyList`. Every entry is native, for
	§ the reason that Namespace gives. A refinement erases before anything
	§ runs, so an entry whose promise is about the answer can not be written
	§ in Essence. And `@::length()` on a proven receiver is this Method rather
	§ than the base's.
	§
	§ The proof changes the answer in three ways. A count of at least one
	§ character is a PositiveInteger. The characters, the first one and the
	§ last one are each a piece that is always there. So `characters` answers
	§ a NonEmptyList, and the two ends answer a character rather than an
	§ Optional. The last four entries carry the proof forward instead. None
	§ of them can empty a String that was not empty, and `repeat` is handed a
	§ count above zero.
	§
	§ `trim`, `slice` and `replaceEvery` are the Methods that can empty one,
	§ so none of them is written here.
	§
	§ The four that carry the proof are what an `is` written for a proven
	§ String has to be read against. A witness comparing two lower-cased
	§ receivers with `is` is written in terms of itself, because the
	§ lower-cased String is proven too. Naming the base Type at the
	§ comparison is what stops that. The same edge has been on
	§ `NonEmptyList::reverse` since it was written.
	namespace NonEmptyString for NonEmptyString {
		§§ Answers how many characters the String has, which is at least one.
		§§
		§§ @returns — the number of characters, which is above zero.
		length() -> PositiveInteger

		§§ Answers the characters of the String, each as its own String.
		§§
		§§ @returns — the List of characters, which always holds at least one.
		characters() -> NonEmptyList<Character>

		§§ Answers the first character of the String.
		§§
		§§ The String has a character in it, so there is a first one to answer.
		§§
		§§ @returns — the first character.
		firstCharacter() -> Character

		§§ Answers the last character of the String.
		§§
		§§ The String has a character in it, so there is a last one to answer.
		§§
		§§ @returns — the last character.
		lastCharacter() -> Character

		§§ Answers the String with every character in upper case.
		§§
		§§ Case mapping answers a character for every character it is given, so the answer has one too.
		§§
		§§ @returns — the upper-cased String, which is never empty.
		uppercase() -> NonEmptyString

		§§ Answers the String with every character in lower case.
		§§
		§§ Case mapping answers a character for every character it is given, so the answer has one too.
		§§
		§§ @returns — the lower-cased String, which is never empty.
		lowercase() -> NonEmptyString

		§§ Answers the String with its characters in the opposite order.
		§§
		§§ Reversing keeps every character, so the answer has one too.
		§§
		§§ @returns — the reversed String, which is never empty.
		reverse() -> NonEmptyString

		§§ Answers the String joined to itself the given number of times.
		§§
		§§ The count is above zero, so the answer holds at least one copy of a String that has a character.
		§§
		§§ @param times — how many copies to join, proven to be above zero
		§§ @returns — the repeated String, which is never empty.
		repeat(times count: PositiveInteger) -> NonEmptyString
	}
}

export {
	CaseSensitivity
	Character
	NonEmptyString
	NormalizationForm
	Side
	String
}
