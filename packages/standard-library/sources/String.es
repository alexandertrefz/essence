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

	§ Which end of a String a Method works on. It lives here because both of
	§ its users do — `trim(at:)` and `pad(…, at:)` — and it is what keeps each
	§ of them ONE Method instead of the three and two they used to be. A fixed
	§ set of modes is a Choice, never a String: `trim(at "start")` would be a
	§ typo waiting to happen, and `trim(at #Start)` is exhaustively checked.
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
		§§ @returns — the name of the Side variant.
		toString() -> String {
			<- match @ -> String {
				case #Start    { <- "Start" }
				case #End      { <- "End" }
				case #BothEnds { <- "BothEnds" }
			}
		}
	}

	§ Whether a String comparison treats upper and lower case as the same. It
	§ is a Choice rather than a `Boolean` flag for the reason every mode here
	§ is: `is(other, comparing Case#Insensitive)` says at the call site what
	§ `is(other, ignoringCase yes)` would leave to the reader to remember.
	choice Case {
		Sensitive,
		Insensitive,
	}

	§ The same unit-Case shape as `Side`; equality is derived, only `toString`
	§ is written.
	namespace Case for Case is Equatable, is Printable {
		§§ Represents the Case as `Sensitive` or `Insensitive`.
		§§
		§§ @returns — the name of the Case variant.
		toString() -> String {
			<- match @ -> String {
				case #Sensitive   { <- "Sensitive" }
				case #Insensitive { <- "Insensitive" }
			}
		}
	}

	§ Which Unicode normalization form `normalize(as:)` produces. A Choice
	§ rather than a `String` for the reason every mode here is one: the four
	§ forms are a fixed, checkable set. Canonical (NFC/NFD) preserves the text;
	§ Compatibility (NFKC/NFKD) also folds compatibility characters — ligatures,
	§ superscripts — onto their plain equivalents. Composed joins a base and its
	§ marks into single characters where it can; Decomposed splits them apart.
	choice NormalizationForm {
		ComposedCanonical,
		DecomposedCanonical,
		ComposedCompatibility,
		DecomposedCompatibility,
	}

	§ The same unit-Case shape again; equality derived, only `toString` written.
	namespace NormalizationForm for NormalizationForm
		is Equatable,
		is Printable {
		§§ Represents the NormalizationForm by its name.
		§§
		§§ @returns — the name of the NormalizationForm variant.
		toString() -> String {
			<- match @ -> String {
				case #ComposedCanonical       { <- "ComposedCanonical" }
				case #DecomposedCanonical     { <- "DecomposedCanonical" }
				case #ComposedCompatibility   { <- "ComposedCompatibility" }
				case #DecomposedCompatibility { <- "DecomposedCompatibility" }
			}
		}
	}

	§ A "character" here is a Unicode GRAPHEME CLUSTER — a base and its combining
	§ marks, a ZWJ emoji sequence, a flag's two regional indicators — each ONE
	§ character, the way a reader counts them. Indices, `length`, `slice`,
	§ `reverse` and `character(at:)` are all by grapheme, so none ever splits
	§ one. The single native `split` decides this (see `graphemesOf` in
	§ `String.ts`): `characters` IS `split(on "")`, and every position Method is
	§ written on top of `characters`/`split`, so the grapheme view is the only
	§ one a Program can observe. Both sides of a comparison are first normalized
	§ to NFC, so canonically equivalent Strings — an accent composed or
	§ decomposed — count, order and compare the same; `normalize(as:)` reaches
	§ the other forms.
	namespace String for String is Equatable, is Printable, is Comparable {
		§§ Whether this String has no characters at all.
		§§
		§§ @returns — true for the empty String, false otherwise
		isEmpty() -> Boolean {
			<- @::length()::is(0)
		}

		§§ Whether this String has at least one character — the opposite of `isEmpty`.
		§§
		§§ @returns — `true` when the String is not empty.
		hasAnyContent() -> Boolean {
			<- @::isEmpty()::negate()
		}

		§ Both entries are written on `compare`, so `Case#Insensitive` means
		§ exactly what the case-insensitive `compare` below means, and both
		§ inherit whatever `compare` decides about normalization.

		§§ Checks whether the String has the same characters as another — case-sensitively, or as the given `Case` asks.
		overload is {
			§§ @param other — the String to compare against
			§§ @returns — `true` when the Strings are equal.
			(_ other: String) -> Boolean {
				<- @::compare(to other)::is(#Equal)
			}

			§§ @param other — the String to compare against
			§§ @param comparing — whether case is significant
			§§ @returns — `true` when the Strings are equal under the given `Case`.
			(_ other: String, comparing sensitivity: Case) -> Boolean {
				<- @::compare(to other, comparing sensitivity)::is(#Equal)
			}
		}

		§§ Checks whether the String differs from another in any character.
		§§
		§§ @param other — the String to compare against
		§§ @returns — `true` when the Strings are not equal.
		isNot(_ other: String) -> Boolean {
			<- @::is(other)::negate()
		}

		§§ Joins another String onto the front of this one.
		§§
		§§ Neither String is changed — the joined result is returned.
		§§
		§§ @param other — the String to add to the front
		§§ @returns — the two Strings joined together
		prepend(_ other: String) -> String {
			<- other::append(@)
		}

		§§ Joins another String onto the end of this one.
		§§
		§§ Neither String is changed — the joined result is returned.
		§§
		§§ @param other — the String to add to the end
		§§ @returns — the two Strings joined together
		append(_ other: String) -> String

		§§ Splits the String at every occurrence of the given separator. `join(with:)` on the resulting List is the return trip.
		§§
		§§ @param separator — the separator to split at
		§§ @returns — the List of pieces, without the separator.
		split(on separator: String) -> List<String>

		§§ The String's lines, split at every line break. A trailing break leaves a final empty line, and the empty String is one empty line.
		§§
		§§ @returns — the List of lines, without the line breaks.
		lines() -> List<String> {
			§ A line break is any of `\n`, `\r` or `\r\n`, which no single
			§ `split(on:)` separator can express — so the other two forms are
			§ first folded onto `\n`, the two-character one before the bare `\r`
			§ it contains, and one split does the rest.
			<- @::replaceEvery("\r\n", with "\n")
				::replaceEvery("\r", with "\n")
				::split(on "\n")
		}

		§ NATIVE. Words are runs of non-whitespace, so every run of whitespace
		§ is a separator and the empty pieces between adjacent separators are
		§ dropped — neither of which `split(on:)` does.

		§§ The String's words — its runs of non-whitespace characters, with the whitespace between them dropped.
		§§
		§§ @returns — the List of words, empty when the String is only whitespace.
		words() -> List<String>

		§§ Whether the given String occurs anywhere in this one.
		§§
		§§ @param other — the String to look for
		§§ @returns — `true` when it occurs.
		contains(_ other: String) -> Boolean {
			<- @::firstIndex(of other)::hasValue()
		}

		§§ Whether the given String occurs nowhere in this one.
		§§
		§§ @param other — the String to look for
		§§ @returns — `true` when it does not occur.
		doesNotContain(_ other: String) -> Boolean {
			<- @::contains(other)::negate()
		}

		§§ How many characters the String has.
		§§
		§§ @returns — the number of characters.
		length() -> Integer

		§§ The String's characters, each as its own single-character String.
		§§
		§§ @returns — the List of characters.
		characters() -> List<String> {
			§ Splitting on the empty separator is defined to split into grapheme
			§ clusters, which is exactly what a character is here.
			<- @::split(on "")
		}

		§ NATIVE. The Essence body — `@::characters()::item(at index)` — built a
		§ String for every character of the receiver and a List to hold them, in
		§ order to hand back one of them: reading a character of a ten thousand
		§ character String allocated ten thousand and one values. The native is
		§ one read out of the grapheme view `characters()` is made of.

		§§ The character at the given position, counting from zero — or, for a negative position, counting back from the end: -1 is the last character and -length the first.
		§§
		§§ @returns — the character, or nothing when the position is outside the String.
		character(at index: Integer) -> Optional<String>

		§§ The String with every character in upper case.
		uppercase() -> String

		§§ The String with every character in lower case.
		lowercase() -> String

		§ `normalize()` with no Argument is Composed Canonical (NFC), the form
		§ the rest of the Namespace already works in — `is`, `compare` and the
		§ grapheme view all normalize to it — so it is what a Program wants far
		§ more often than not. The `as:` entry is the native, naming the form.

		§§ The String in the given Unicode normalization form, or Composed Canonical (NFC) when none is named — so two Strings that look identical can be made to compare and read the same.
		§§
		§§ @param as — the normalization form to produce; `#ComposedCanonical` when it is left out.
		§§ @returns — the normalized String.
		normalize(as form: NormalizationForm = #ComposedCanonical) -> String

		§ One Method, not three. `trim(at:)` is the single native — it reads
		§ the Case and calls the matching JavaScript intrinsic — and the end it
		§ trims is defaulted, because trimming usually means both.

		§§ The String without surrounding whitespace — at both ends when called with no Argument, or at the given end.
		§§
		§§ @param at — the end to trim; `#BothEnds` when it is left out.
		§§ @returns — the trimmed String.
		trim(at side: Side = #BothEnds) -> String

		§§ Whether the String begins with the given one.
		starts(with prefix: String) -> Boolean {
			§ A prefix longer than the String slices to the whole String, which
			§ can not equal it — so the too-long case answers `false` without a
			§ guard of its own.
			<- @::slice(to prefix::length())::is(prefix)
		}

		§§ Whether the String does not begin with the given one.
		doesNotStart(with prefix: String) -> Boolean {
			<- @::starts(with prefix)::negate()
		}

		§ NATIVE. The Essence body — slice the last `suffix::length()`
		§ characters and compare — is four traversals (two `length` walks, a
		§ `slice`, an `is`) where the intrinsic is one. `starts(with:)` stays
		§ Essence because its slice starts at zero and needs no `length`.

		§§ Whether the String ends with the given one.
		ends(with suffix: String) -> Boolean

		§§ Whether the String does not end with the given one.
		doesNotEnd(with suffix: String) -> Boolean {
			<- @::ends(with suffix)::negate()
		}

		§§ The String with every occurrence of one part replaced by another. An empty part matches nothing and leaves the String unchanged.
		§§
		§§ @param part — the String to look for
		§§ @param with — the String to put in its place
		§§ @returns — the String with the replacements made.
		replaceEvery(_ part: String, with replacement: String) -> String {
			§ The empty part is a no-op: it occurs at every position and
			§ "replacing" it has no agreed meaning that an Essence body can
			§ spell — `split(on "")::join` would join the characters with the
			§ replacement between them, which is a different String and used to
			§ be why this Method was native. Answering the String unchanged is
			§ the one behaviour that needs no code-unit view.
			if part::isEmpty() {
				<- @
			} else {
				<- @::split(on part)::join(with replacement)
			}
		}

		§§ The String with the first occurrence of one part replaced by another. An empty part, or a part that does not occur, leaves the String unchanged.
		§§
		§§ @param part — the String to look for
		§§ @param with — the String to put in its place
		§§ @returns — the String with the first replacement made.
		replaceFirst(_ part: String, with replacement: String) -> String {
			§ The empty part is a no-op, as in `replaceEvery`.
			if part::isEmpty() {
				<- @
			} else {
				constant pieces = @::split(on part)

				§ One piece means the part never occurs — nothing to replace.
				if pieces::length()::is(1) {
					<- @
				} else {
					§ The first piece is everything before the first occurrence;
					§ the rest rejoin on the ORIGINAL part, so only the first
					§ separator is the one that becomes the replacement.
					constant head = pieces::firstItem()::value(withDefault "")

					<- head::append(replacement)
						::append(pieces::removeFirst()::join(with part))
				}
			}
		}

		§ NATIVE. The Essence body — `List.repeat(@, times count)::join(with "")`
		§ — built a List of `count` copies of the String and joined it back into
		§ one. The native repeats the text; a count below one still answers the
		§ empty String, which is what repeating into the empty List gave.

		§§ The String joined to itself the given number of times.
		§§
		§§ @returns — the repeated String; the empty String for a count below one.
		repeat(times count: Integer) -> String

		§ NATIVE. The Essence body — `characters()::reverse()::join` — joins the
		§ reversed characters into plain text, and segmenting that text afresh
		§ does not always read the same characters back: a flag's regional
		§ indicators pair up by position, so reversing three of them re-pairs
		§ them into characters the original never had. The native remembers the
		§ reversed view on the String it answers, which no Essence body can do —
		§ and which is what keeps `reverse` an involution and the `lastIndex`
		§ derivation below sound.

		§§ The String with its characters in the opposite order.
		reverse() -> String

		§ NATIVE. The Essence body — `@::characters()::slice(…)::join(with "")` —
		§ went the long way round through a List: a String per character of the
		§ receiver, a List of them, a second List for the window, and a join to
		§ put the text back together. The native takes the window out of the
		§ grapheme view directly, resolving and clamping the two positions
		§ exactly as `List.slice` did — a negative position counts back from the
		§ end, and an empty or inverted range is the empty String. The answer
		§ carries the clusters it was cut into, exactly as a piece of `split`
		§ does.

		§§ The characters from one position up to, but not including, another. A negative position counts back from the end, so `slice(from 0, to -1)` drops the last character. Left out, `from` is the start and `to` is the end.
		§§
		§§ @param from — the first position to include, counting from zero, or back from the end when negative; zero when it is left out.
		§§ @param to — the position to stop before, counting the same way; the length when it is left out.
		§§ @returns — the String of that range of characters.
		slice(from start: Integer = 0, to end: Integer = @::length()) -> String

		§§ The position of the first occurrence of the given String.
		§§
		§§ @returns — the zero-based position, or nothing when it does not occur.
		firstIndex(of part: String) -> Optional<Integer> {
			§ The empty part occurs at the very start of every String, the
			§ empty String included — and splitting on it would answer the
			§ length of the first CHARACTER instead, so it is answered here.
			if part::isEmpty() {
				<- #Value(0)
			} else {
				constant pieces = @::split(on part)

				§ One piece means the separator was never found.
				if pieces::length()::is(1) {
					<- #Empty
				} else {
					§ Splitting always yields at least one piece, so the
					§ fallback is unreachable; the first piece is everything
					§ before the first occurrence, and its length is that
					§ occurrence's position.
					<- #Value(
						pieces::firstItem()::value(withDefault "")::length()
					)
				}
			}
		}

		§§ The position of the last occurrence of the given String.
		§§
		§§ @returns — the zero-based position, or nothing when it does not occur.
		lastIndex(of part: String) -> Optional<Integer> {
			§ The empty part occurs after the very last character too, so its
			§ last position is the length — the mirror of `firstIndex`, whose
			§ empty part is at position zero.
			if part::isEmpty() {
				<- #Value(@::length())
			} else {
				§ The LAST occurrence of the part is the FIRST occurrence of the
				§ reversed part in the reversed String, so `firstIndex` answers
				§ this one too and only the position has to be counted back from
				§ the end: a match that far into the reversal is that far from the
				§ right, so the occurrence ENDS there and begins one part-length
				§ before that.
				§
				§ Deriving it from `split(on:)` instead — the whole String less
				§ the last piece and the part — answers the last NON-OVERLAPPING
				§ match, because splitting scans left to right and consumes each
				§ match it finds: "aaa" split on "aa" consumes the match at 0 and
				§ leaves "a", giving 0, while the last occurrence of "aa" really
				§ begins at 1.
				constant length     = @::length()
				constant partLength = part::length()

				§ `@` is the RECEIVER of the `map` callback's enclosing Method,
				§ and the callback names its own Parameter — so both lengths are
				§ bound before the call to stay reachable inside it.
				<- @::reverse()
					::firstIndex(of part::reverse())
					::map((position) {
						<- length::subtract(position)::subtract(partLength)
					})
			}
		}

		§ One Method, with the end it pads defaulted. The `at:` Parameter
		§ answers for every `Side`, so nothing about the Choice is left
		§ unhandled: `BothEnds` centres, which is what padding both ends means.
		§ The padding is built out of `repeat` and `slice`.

		§§ The String padded with the given String up to the given length — at the front when no end is named, or at the given end.
		§§
		§§ @param to — the length to reach.
		§§ @param with — the String to pad with, repeated as needed.
		§§ @param at — the end to pad; `#Start` when it is left out.
		§§ @returns — the padded String; unchanged when it is already that long.
		pad(
			to length: Integer,
			with padding: String,
			at side: Side = #Start,
		) -> String {
			§ An empty padding has nothing to repeat, and a String already
			§ that long needs nothing — both leave it as it is.
			if padding::isEmpty() {
				<- @
			}

			constant characterCount = @::length()

			if length::isLessThanOrEqualTo(characterCount) {
				<- @
			}

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
				case #Start { <- text::prepend(filler::slice(to needed)) }

				case #End   { <- text::append(filler::slice(to needed)) }

				case #BothEnds {
					§ Centring splits the padding between the two ends. An
					§ odd count can not split evenly, so the extra
					§ character goes to the END — the text sits one to the
					§ left, which is what centring in a fixed width
					§ conventionally does. The written `2` is its own proof
					§ of not being zero, so this is the total `quotient`
					§ entry and there is nothing to fall back from.
					constant atStart = needed::quotient(dividingBy 2)

					<- text::prepend(filler::slice(to atStart))
						::append(filler::slice(to needed::subtract(atStart)))
				}
			}
		}

		§§ Orders the String against another — by character code point, or as the given `Case` asks.
		overload compare {
			§ NATIVE. Ordering by code point is what the Comparable conformance
			§ names, and there is no Essence expression for a character's code
			§ point.

			§§ @param other — the String to order against
			§§ @returns — `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.
			(to other: String) -> Ordering

			§ Case is folded by lower-casing both sides — a documented
			§ approximation of full Unicode case-folding, close enough for the
			§ everyday comparison this is — then the code-point ordering above
			§ decides. `Case#Sensitive` is that ordering unchanged.

			§§ @param other — the String to order against
			§§ @param comparing — whether case is significant
			§§ @returns — `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.
			(to other: String, comparing sensitivity: Case) -> Ordering {
				§ `@` is the SCRUTINEE inside a match, not the receiver, so the
				§ String is bound before the match to stay reachable in the Case
				§ bodies.
				constant text = @

				<- match sensitivity -> Ordering {
					case #Sensitive   { <- text::compare(to other) }

					case #Insensitive {
						<- text::lowercase()::compare(to other::lowercase())
					}
				}
			}
		}

		§§ Represents the String as itself — Strings are their own representation.
		§§
		§§ @returns — the String itself.
		toString() -> String {
			<- @
		}
	}
}

export {
	Case
	NormalizationForm
	Side
	String
}
