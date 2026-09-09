implementation {

	§ Every declared Method of every standard library Namespace, called at
	§ least once and printed with a label that names it. This file exists to
	§ be a behaviour net: `src/tests/stdlibGolden.spec.ts` runs it and diffs
	§ its output against a golden capture, so a Method whose result changes
	§ says so by name.
	§
	§ The label is the Method's signature — Namespace, name, Type Parameters
	§ and Parameters, minus the return Type — because a Method with an
	§ `overload` block has several entries that share a name and bind to
	§ different runtime Functions. It is spelled EXACTLY as `printSignature`
	§ spells it, so the coverage test in `stdlibGolden.spec.ts` can compare
	§ the labels this file uses against the declared Methods as two sets: a
	§ Method added to `src/stdlib` and not called here fails that test by
	§ name. A `[note]` suffix separates the extra calls that exercise an edge
	§ case from the everyday one, and is ignored by the comparison.
	§
	§ The label and the value are separated by ` => ` rather than ` -> `,
	§ because a signature spells a Function Parameter with an arrow of its
	§ own — `(where: (_ ItemType) -> Boolean)` — and the reader of a line has
	§ to be able to find where the label ends.

	§ `show` takes anything Printable, which is every Type a standard library
	§ Method returns — an `Optional` included, since it is a Choice with a
	§ Namespace of its own and conforms whenever its payload does. It used to
	§ need a `showMaybe` beside it that matched the Optional apart first.
	function show<infer Value is Printable>(
		_ label: String,
		_ value: Value,
	) -> {} {
		Terminal.inspect("{label} => {value}")
		<- {}
	}

	§ An Algebraic can not be written as a literal — it is only ever reached
	§ through `squareRoot`, whose answer is an Integer or an Algebraic and has
	§ to be matched apart. These two hand one to a body so that the Methods
	§ needing an Algebraic receiver or Argument read as ordinary calls. A
	§ written receiver proves its own sign, so the root is there and no Empty
	§ Case stands between the call and the value.
	function withRootTwo(_ body: (_ rootTwo: Algebraic) -> {}) -> {} {
		<- match 2::squareRoot() -> {} {
			case Algebraic { <- body(@) }
			case Integer   { <- {} }
		}
	}

	function withTwoRoots(
		_ body: (_ rootTwo: Algebraic, _ rootThree: Algebraic) -> {},
	) -> {} {
		<- withRootTwo((_ rootTwo: Algebraic) -> {} {
			<- match 3::squareRoot() -> {} {
				case Algebraic { <- body(rootTwo, @) }
				case Integer   { <- {} }
			}
		})
	}

	§ Which rung of the ladder answers is the receiver's Type to decide, and
	§ the labels below name it. A bare `5::isBetween(1, and 10)` is Integer's
	§ rung, and `asNumber(5)::isBetween(1, and 10)` is the covering
	§ `Number`'s. Both resolve. The coverage gate counts a provided Method
	§ once per conformer, so reaching `Number`'s rung takes a receiver of the
	§ covering Type. This widens one and hands it straight back.
	function asNumber(_ value: Number) -> Number {
		<- value
	}

	§ The two transforms `everyValue` is shown with. Each is declared rather
	§ than written at the call, for the reason given there.
	function evenAsText(_ item: Integer) -> Optional<String> {
		if item::isEven() {
			<- #Value(item::toString())
		} else {
			<- #Empty
		}
	}

	function noText(_ item: Integer) -> Optional<String> {
		<- #Empty
	}

	constant greeting     = "Hello, World"
	constant emptyText    = ""
	constant numbers      = [3, 1, 2, 1, 4]
	constant singleNumber = [7]
	constant noNumbers: List<Integer>    = []
	constant noRationals: List<Rational> = []
	constant noMixedNumbers: List<Integer | Rational> = []
	constant noNestedNumbers: List<List<Integer>>     = []

	§ ——— String ———————————————————————————————————————————————————————————
	show("String.isEmpty()", greeting::isEmpty())
	show("String.isEmpty() [empty]", emptyText::isEmpty())
	show("String.hasCharacters()", greeting::hasCharacters())
	show("String.hasCharacters() [empty]", emptyText::hasCharacters())
	show("String.is(_ String)", greeting::is("Hello, World"))
	show("String.is(_ String) [differing]", greeting::is("nope"))
	show("String.is(_ String) [both empty]", emptyText::is(""))
	show("String.isNot(_ String)", greeting::isNot("nope"))
	show("String.isNot(_ String) [equal]", greeting::isNot("Hello, World"))
	show(
		"String.is(_ String, comparing: CaseSensitivity) [sensitive]",
		"Hello"::is("hello", comparing CaseSensitivity#Sensitive),
	)
	show(
		"String.is(_ String, comparing: CaseSensitivity) [insensitive]",
		"Hello"::is("hello", comparing CaseSensitivity#Insensitive),
	)
	show(
		"String.is(_ String, comparing: CaseSensitivity) [insensitive, differing]",
		"Hello"::is("world", comparing CaseSensitivity#Insensitive),
	)
	show("String.prepend(_ String)", greeting::prepend(">> "))
	show("String.prepend(_ String) [empty]", greeting::prepend(emptyText))
	show("String.append(_ String)", greeting::append("!"))
	show("String.append(_ String) [empty]", greeting::append(emptyText))
	§ The two entries of `split` are told apart by what is known about the
	§ SEPARATOR, so the calls have to be told apart the same way. A separator
	§ the Program COMPUTES might be the empty one, which is the only separator
	§ that answers no pieces at all; one written where it stands is its own
	§ proof that it has a character, and reaches the entry answering a
	§ NonEmptyList.
	constant computedComma     = ","::append(emptyText)
	constant computedSemicolon = ";"::append(emptyText)

	show("String.split(on: String)", "a,b,c"::split(on computedComma))
	show(
		"String.split(on: String) [no match]",
		greeting::split(on computedSemicolon),
	)
	show("String.split(on: String) [empty separator]", "abc"::split(on ""))
	show(
		"String.split(on: String) [empty receiver]",
		emptyText::split(on computedComma),
	)
	show("String.split(on: NonEmptyString)", "a,b,c"::split(on ","))
	show("String.split(on: NonEmptyString) [no match]", greeting::split(on ";"))
	show(
		"String.split(on: NonEmptyString) [empty receiver]",
		emptyText::split(on ","),
	)
	show("String.lines()", "first
second
third"::lines())
	show("String.lines() [single line]", greeting::lines())
	show("String.words()", "  the quick  brown "::words())
	show("String.words() [only whitespace]", "   "::words())
	show("String.contains(_ String)", greeting::contains("lo,"))
	show("String.contains(_ String) [absent]", greeting::contains("zz"))
	show("String.doesNotContain(_ String)", greeting::doesNotContain("zz"))
	show(
		"String.doesNotContain(_ String) [present]",
		greeting::doesNotContain("lo,"),
	)
	show("String.count(of: String)", "banana"::count(of "a"))
	show("String.count(of: String) [empty part]", "banana"::count(of ""))
	show("String.count(of: String) [absent]", "banana"::count(of "zz"))
	§ A RECEIVER written down proves it has a character in it, and reaches
	§ the Namespace that spends the proof. So the calls that have to stay on
	§ `String`'s own entries are given a computed receiver, and
	§ `namespace NonEmptyString` is called under labels of its own below.
	constant astralText = "a😀b"::append(emptyText)
	constant abText     = "ab"::append(emptyText)

	show("String.length()", greeting::length())
	show("String.length() [empty]", emptyText::length())
	show("String.length() [astral]", astralText::length())
	show("String.characters()", astralText::characters())
	show("String.characters() [empty]", emptyText::characters())
	show("String.character(at: Integer)", greeting::character(at 1))
	show("String.character(at: Integer) [zero]", greeting::character(at 0))
	show("String.character(at: Integer) [negative]", greeting::character(at -1))
	show(
		"String.character(at: Integer) [at length]",
		greeting::character(at greeting::length()),
	)
	show(
		"String.character(at: Integer) [from the end, first]",
		greeting::character(at 0::subtract(greeting::length())),
	)
	show(
		"String.character(at: Integer) [before the start]",
		greeting::character(at -99),
	)
	show(
		"String.character(at: Integer, defaultingTo: Character)",
		greeting::character(at 1, defaultingTo "?"),
	)
	show(
		"String.character(at: Integer, defaultingTo: Character) [outside]",
		greeting::character(at 99, defaultingTo "?"),
	)
	show("String.firstCharacter()", greeting::firstCharacter())
	show("String.firstCharacter() [empty]", emptyText::firstCharacter())
	show(
		"String.firstCharacter(defaultingTo: Character)",
		greeting::firstCharacter(defaultingTo "?"),
	)
	show(
		"String.firstCharacter(defaultingTo: Character) [empty]",
		emptyText::firstCharacter(defaultingTo "?"),
	)
	show("String.lastCharacter()", greeting::lastCharacter())
	show("String.lastCharacter() [empty]", emptyText::lastCharacter())
	show(
		"String.lastCharacter(defaultingTo: Character)",
		greeting::lastCharacter(defaultingTo "?"),
	)
	show(
		"String.lastCharacter(defaultingTo: Character) [empty]",
		emptyText::lastCharacter(defaultingTo "?"),
	)
	show("String.uppercase()", greeting::uppercase())
	show("String.uppercase() [empty]", emptyText::uppercase())
	show("String.lowercase()", greeting::lowercase())
	show("String.trim(at?: Side) [no Argument]", "  spaced  "::trim())
	show("String.trim(at?: Side) [nothing to trim]", greeting::trim())
	show("String.trim(at?: Side) [start]", "  spaced  "::trim(at Side#Start))
	show("String.trim(at?: Side) [end]", "  spaced  "::trim(at Side#End))
	show("String.starts(with: String)", greeting::starts(with "Hello"))
	show("String.starts(with: String) [absent]", greeting::starts(with "World"))
	show(
		"String.starts(with: String) [empty prefix]",
		greeting::starts(with emptyText),
	)
	show(
		"String.doesNotStart(with: String)",
		greeting::doesNotStart(with "World"),
	)
	show(
		"String.doesNotStart(with: String) [present]",
		greeting::doesNotStart(with "Hello"),
	)
	show("String.ends(with: String)", greeting::ends(with "World"))
	show("String.ends(with: String) [absent]", greeting::ends(with "Hello"))
	show("String.doesNotEnd(with: String)", greeting::doesNotEnd(with "!"))
	show(
		"String.doesNotEnd(with: String) [present]",
		greeting::doesNotEnd(with "World"),
	)
	show(
		"String.replaceEvery(_ String, with: String)",
		greeting::replaceEvery("o", with "0"),
	)
	show(
		"String.replaceEvery(_ String, with: String) [no match]",
		greeting::replaceEvery("z", with "0"),
	)
	show(
		"String.replaceEvery(_ String, with: String) [empty part]",
		greeting::replaceEvery("", with "0"),
	)
	show(
		"String.replaceFirst(_ String, with: String)",
		"a-a-a"::replaceFirst("a", with "b"),
	)
	show(
		"String.replaceFirst(_ String, with: String) [no match]",
		greeting::replaceFirst("z", with "0"),
	)
	show("String.repeat(times: Integer)", abText::repeat(times 3))
	show("String.repeat(times: Integer) [zero]", abText::repeat(times 0))
	show("String.repeat(times: Integer) [negative]", abText::repeat(times -1))
	show("String.reverse()", greeting::reverse())
	show("String.reverse() [astral]", astralText::reverse())
	show(
		"String.slice(from?: Integer, to?: Integer)",
		greeting::slice(from 0, to 5),
	)
	show(
		"String.slice(from?: Integer, to?: Integer) [empty range]",
		greeting::slice(from 3, to 3),
	)
	show(
		"String.slice(from?: Integer, to?: Integer) [past the end]",
		greeting::slice(from 7, to 99),
	)
	show(
		"String.slice(from?: Integer, to?: Integer) [negative to]",
		greeting::slice(from 0, to -1),
	)
	show(
		"String.slice(from?: Integer, to?: Integer) [negative from]",
		greeting::slice(from -5, to 12),
	)
	show(
		"String.slice(from?: Integer, to?: Integer) [both negative]",
		greeting::slice(from -5, to -1),
	)
	show(
		"String.slice(from?: Integer, to?: Integer) [negative past the start]",
		greeting::slice(from -99, to 5),
	)
	§ The three short spellings the defaults are for — a tail, a head, and the
	§ whole String. `to` defaults to `@::length()`, which reads the receiver.
	show(
		"String.slice(from?: Integer, to?: Integer) [no to]",
		greeting::slice(from 7),
	)
	show(
		"String.slice(from?: Integer, to?: Integer) [no from]",
		greeting::slice(to 5),
	)
	show(
		"String.slice(from?: Integer, to?: Integer) [neither]",
		greeting::slice(),
	)
	show("String.firstIndex(of: String)", greeting::firstIndex(of "World"))
	show(
		"String.firstIndex(of: String) [absent]",
		greeting::firstIndex(of "zz"),
	)
	show(
		"String.firstIndex(of: String, defaultingTo: Integer)",
		greeting::firstIndex(of "World", defaultingTo -1),
	)
	show(
		"String.firstIndex(of: String, defaultingTo: Integer) [absent]",
		greeting::firstIndex(of "zz", defaultingTo -1),
	)
	show("String.lastIndex(of: String)", "a-b-a"::lastIndex(of "a"))
	show("String.lastIndex(of: String) [absent]", greeting::lastIndex(of "zz"))
	show(
		"String.lastIndex(of: String, defaultingTo: Integer)",
		"a-b-a"::lastIndex(of "a", defaultingTo -1),
	)
	show(
		"String.lastIndex(of: String, defaultingTo: Integer) [absent]",
		greeting::lastIndex(of "zz", defaultingTo -1),
	)
	show(
		"String.pad(to: Integer, with?: String, at?: Side) [no end named]",
		"7"::pad(to 3, with "0"),
	)
	show(
		"String.pad(to: Integer, with?: String, at?: Side) [no end named, already long enough]",
		greeting::pad(to 3, with "0"),
	)
	show(
		"String.pad(to: Integer, with?: String, at?: Side) [end]",
		"7"::pad(to 3, with ".", at Side#End),
	)
	show(
		"String.pad(to: Integer, with?: String, at?: Side) [end, already long enough]",
		greeting::pad(to 3, with ".", at Side#End),
	)
	show(
		"String.pad(to: Integer, with?: String, at?: Side) [both ends, even]",
		"7"::pad(to 5, with "-", at Side#BothEnds),
	)
	show(
		"String.pad(to: Integer, with?: String, at?: Side) [both ends, odd]",
		"7"::pad(to 4, with "-", at Side#BothEnds),
	)
	show(
		"String.pad(to: Integer, with?: String, at?: Side) [both ends, multi-character]",
		"ab"::pad(to 8, with "xy", at Side#BothEnds),
	)
	show(
		"String.pad(to: Integer, with?: String, at?: Side) [no padding named]",
		"abc"::pad(to 6),
	)
	show("String.compare(to: String)", "app"::compare(to "apple"))
	show(
		"String.compare(to: String) [equal]",
		greeting::compare(to "Hello, World"),
	)
	show("String.compare(to: String) [greater]", "b"::compare(to "a"))
	show(
		"String.compare(to: String, comparing: CaseSensitivity) [sensitive]",
		"abc"::compare(to "ABC", comparing CaseSensitivity#Sensitive),
	)
	show(
		"String.compare(to: String, comparing: CaseSensitivity) [insensitive, equal]",
		"abc"::compare(to "ABC", comparing CaseSensitivity#Insensitive),
	)
	show(
		"String.compare(to: String, comparing: CaseSensitivity) [insensitive, less]",
		"abc"::compare(to "ABD", comparing CaseSensitivity#Insensitive),
	)
	§ The four inequalities are `Comparable`'s provided Methods, and a String
	§ answers them on its own rung, off the `compare` above.
	show("String.isLessThan(_ String)", "app"::isLessThan("apple"))
	show("String.isLessThan(_ String) [greater]", "b"::isLessThan("a"))
	show(
		"String.isLessThanOrEqualTo(_ String) [equal]",
		"abc"::isLessThanOrEqualTo("abc"),
	)
	show("String.isGreaterThan(_ String)", "b"::isGreaterThan("a"))
	show(
		"String.isGreaterThanOrEqualTo(_ String)",
		"apple"::isGreaterThanOrEqualTo("app"),
	)
	show("String.toString()", greeting::toString())
	show("String.toString() [empty]", emptyText::toString())

	§ Grapheme & normalization. The decomposed forms are derived with
	§ `normalize(as:)` rather than typed as literal combining marks, so the
	§ test does not depend on how the source file was saved.
	constant accented   = "café"
	constant flag       = "🇩🇪"
	constant decomposed = accented::normalize(
		as NormalizationForm#DecomposedCanonical,
	)

	show("String.length() [decomposed grapheme]", decomposed::length())
	show("String.length() [flag is one grapheme]", flag::length())
	show(
		"String.characters() [decomposed stays whole]",
		decomposed::characters(),
	)
	show("String.reverse() [flag not torn]", flag::append("!")::reverse())
	show("String.is(_ String) [NFC equals NFD]", accented::is(decomposed))
	show(
		"String.normalize(as?: NormalizationForm) [no form named]",
		accented::normalize(),
	)
	show(
		"String.normalize(as?: NormalizationForm) [compatibility folds ligature]",
		"ﬁle"::normalize(as NormalizationForm#ComposedCompatibility),
	)

	§ Code points, the level below a character. The astral text is three
	§ characters and four points, which is the difference the two Methods
	§ are told apart by.
	show("String.of(codePoint: NonNegativeInteger)", String.of(codePoint 97))
	show(
		"String.of(codePoint: NonNegativeInteger) [surrogate]",
		String.of(codePoint 55296),
	)
	show(
		"String.of(codePoint: NonNegativeInteger) [past the last point]",
		String.of(codePoint 1114112),
	)
	show(
		"String.of(codePoints: List<Integer>)",
		String.of(codePoints [104, 105]),
	)
	show(
		"String.of(codePoints: List<Integer>) [empty]",
		String.of(codePoints noNumbers),
	)
	show(
		"String.of(codePoints: List<Integer>) [one point names nothing]",
		String.of(codePoints [104, -1]),
	)
	show("String.codePoints()", abText::codePoints())
	show("String.codePoints() [astral]", astralText::codePoints())
	show("String.codePoints() [empty]", emptyText::codePoints())

	§ The character questions. Each is asked of a String that answers and
	§ one that does not, and of the empty String, which every one accepts.
	show("String.isOneCharacter()", "x"::isOneCharacter())
	show("String.isOneCharacter() [two]", abText::isOneCharacter())
	show("String.isOneCharacter() [empty]", emptyText::isOneCharacter())
	show("String.hasOnlyDigits()", "2026"::hasOnlyDigits())
	show("String.hasOnlyDigits() [mixed]", "2026-09"::hasOnlyDigits())
	show("String.hasOnlyDigits() [empty]", emptyText::hasOnlyDigits())
	show("String.hasOnlyLetters()", "Grüße"::hasOnlyLetters())
	show("String.hasOnlyLetters() [decomposed]", decomposed::hasOnlyLetters())
	show("String.hasOnlyLetters() [mixed]", "Rule 34"::hasOnlyLetters())
	show("String.hasOnlyLettersOrDigits()", "route66"::hasOnlyLettersOrDigits())
	show(
		"String.hasOnlyLettersOrDigits() [space]",
		"route 66"::hasOnlyLettersOrDigits(),
	)
	show("String.hasOnlyWhitespace()", "  "::hasOnlyWhitespace())
	show("String.hasOnlyWhitespace() [text]", " x "::hasOnlyWhitespace())

	§ The folding entries. Each is asked under both Cases over the same
	§ two Strings, so the two answers stand beside each other.
	show(
		"String.contains(_ String, comparing: CaseSensitivity)",
		greeting::contains("WORLD", comparing CaseSensitivity#Insensitive),
	)
	show(
		"String.contains(_ String, comparing: CaseSensitivity) [sensitive]",
		greeting::contains("WORLD", comparing CaseSensitivity#Sensitive),
	)
	show(
		"String.doesNotContain(_ String, comparing: CaseSensitivity)",
		greeting::doesNotContain("ZZ", comparing CaseSensitivity#Insensitive),
	)
	show(
		"String.starts(with: String, comparing: CaseSensitivity)",
		greeting::starts(with "hello", comparing CaseSensitivity#Insensitive),
	)
	show(
		"String.starts(with: String, comparing: CaseSensitivity) [sensitive]",
		greeting::starts(with "hello", comparing CaseSensitivity#Sensitive),
	)
	show(
		"String.doesNotStart(with: String, comparing: CaseSensitivity)",
		greeting::doesNotStart(
			with "world",
			comparing CaseSensitivity#Insensitive,
		),
	)
	show(
		"String.ends(with: String, comparing: CaseSensitivity)",
		greeting::ends(with "WORLD", comparing CaseSensitivity#Insensitive),
	)
	show(
		"String.doesNotEnd(with: String, comparing: CaseSensitivity)",
		greeting::doesNotEnd(
			with "HELLO",
			comparing CaseSensitivity#Insensitive,
		),
	)
	show(
		"String.firstIndex(of: String, comparing: CaseSensitivity)",
		greeting::firstIndex(of "WORLD", comparing CaseSensitivity#Insensitive),
	)
	show(
		"String.firstIndex(of: String, comparing: CaseSensitivity) [absent]",
		greeting::firstIndex(of "WORLD", comparing CaseSensitivity#Sensitive),
	)
	show(
		"String.lastIndex(of: String, comparing: CaseSensitivity)",
		"a-B-a"::lastIndex(of "A", comparing CaseSensitivity#Insensitive),
	)
	show(
		"String.count(of: String, comparing: CaseSensitivity)",
		"bAnana"::count(of "A", comparing CaseSensitivity#Insensitive),
	)
	show(
		"String.replaceEvery(_ String, with: String, comparing: CaseSensitivity)",
		"aAa"
			::replaceEvery(
				"a",
				with "-",
				comparing CaseSensitivity#Insensitive,
			),
	)
	show(
		"String.replaceFirst(_ String, with: String, comparing: CaseSensitivity)",
		"aAa"
			::replaceFirst(
				"A",
				with "-",
				comparing CaseSensitivity#Insensitive,
			),
	)

	§ The cuts and the rest of the vocabulary.
	show("String.everyIndex(of: String)", "banana"::everyIndex(of "an"))
	show(
		"String.everyIndex(of: String) [empty part]",
		"banana"::everyIndex(of ""),
	)
	show(
		"String.everyIndex(of: String) [absent]",
		"banana"::everyIndex(of "zz"),
	)
	show("String.split(onFirst: String)", "key=a=b"::split(onFirst "="))
	show("String.split(onFirst: String) [absent]", greeting::split(onFirst "="))
	show(
		"String.split(onFirst: String) [empty separator]",
		"abc"::split(onFirst ""),
	)
	show("String.split(onLast: String)", "key=a=b"::split(onLast "="))
	show("String.split(onLast: String) [absent]", greeting::split(onLast "="))
	show(
		"String.split(on: NonEmptyString, atMost: PositiveInteger)",
		"a=b=c"::split(on "=", atMost 2),
	)
	show(
		"String.split(on: NonEmptyString, atMost: PositiveInteger) [one piece]",
		"a=b=c"::split(on "=", atMost 1),
	)
	show(
		"String.split(on: NonEmptyString, atMost: PositiveInteger) [room to spare]",
		"a=b"::split(on "=", atMost 9),
	)
	show("String.remove(prefix: String)", "/api/users"::remove(prefix "/api"))
	show(
		"String.remove(prefix: String) [absent]",
		greeting::remove(prefix "zz"),
	)
	show("String.remove(suffix: String)", "String.es"::remove(suffix ".es"))
	show(
		"String.remove(suffix: String) [absent]",
		greeting::remove(suffix "zz"),
	)
	show("String.capitalize()", "lions"::capitalize())
	show("String.capitalize() [empty]", emptyText::capitalize())
	show(
		"String.truncate(to: Integer, with?: String)",
		greeting::truncate(to 8),
	)
	show(
		"String.truncate(to: Integer, with?: String) [already short]",
		greeting::truncate(to 99),
	)
	show(
		"String.truncate(to: Integer, with?: String) [no room for the ellipsis]",
		greeting::truncate(to 1),
	)
	show(
		"String.truncate(to: Integer, with?: String) [zero]",
		greeting::truncate(to 0),
	)
	show(
		"String.truncate(to: Integer, with?: String) [named ellipsis]",
		greeting::truncate(to 7, with "..."),
	)
	show("String.indent(by: Integer, with?: String)", "text"::indent(by 2))
	show(
		"String.indent(by: Integer, with?: String) [empty line kept bare]",
		"a

b"::indent(by 1),
	)
	show(
		"String.indent(by: Integer, with?: String) [named unit]",
		"text"::indent(by 1, with "\t"),
	)
	show(
		"String.separate(every: PositiveInteger, with: String, from?: Side)",
		"1234567"::separate(every 3, with ","),
	)
	show(
		"String.separate(every: PositiveInteger, with: String, from?: Side) [from the start]",
		"1234567"::separate(every 3, with ",", from Side#Start),
	)
	show(
		"String.separate(every: PositiveInteger, with: String, from?: Side) [shorter than a group]",
		abText::separate(every 3, with ","),
	)
	show("String.quoted()", greeting::quoted())
	show("String.quoted() [empty]", emptyText::quoted())
	show("String.quoted() [escapes]", "a\"b
c"::quoted())

	§ ——— NonEmptyString ———————————————————————————————————————————————————
	§ What a String proven to have a character answers, and the sister of the
	§ NonEmptyList block further down. A String written where it stands is
	§ its own proof, so every call here is written. The count of the repeat
	§ is written for the same reason: the entry asks for a count above zero.
	show("NonEmptyString.length()", "a😀b"::length())
	show("NonEmptyString.characters()", "a😀b"::characters())
	show("NonEmptyString.firstCharacter()", "a😀b"::firstCharacter())
	show("NonEmptyString.lastCharacter()", "a😀b"::lastCharacter())
	show("NonEmptyString.uppercase()", "Hello, World"::uppercase())
	show("NonEmptyString.lowercase()", "Hello, World"::lowercase())
	show("NonEmptyString.reverse()", "a😀b"::reverse())
	show("NonEmptyString.repeat(times: PositiveInteger)", "ab"::repeat(times 3))

	§ ——— Boolean ——————————————————————————————————————————————————————————
	show("Boolean.negate()", true::negate())
	show("Boolean.negate() [false]", false::negate())
	show("Boolean.is(_ Boolean)", true::is(true))
	show("Boolean.is(_ Boolean) [differing]", true::is(false))
	show("Boolean.isNot(_ Boolean)", true::isNot(false))
	show("Boolean.isNot(_ Boolean) [equal]", false::isNot(false))
	§ `false` before `true`, and the four inequalities `Comparable` provides
	§ over the ordering.
	show("Boolean.compare(to: Boolean)", false::compare(to true))
	show("Boolean.compare(to: Boolean) [greater]", true::compare(to false))
	show("Boolean.compare(to: Boolean) [equal]", true::compare(to true))
	show("Boolean.isLessThan(_ Boolean)", false::isLessThan(true))
	show("Boolean.isLessThan(_ Boolean) [greater]", true::isLessThan(false))
	show(
		"Boolean.isLessThanOrEqualTo(_ Boolean)",
		true::isLessThanOrEqualTo(true),
	)
	show("Boolean.isGreaterThan(_ Boolean)", true::isGreaterThan(false))
	show(
		"Boolean.isGreaterThanOrEqualTo(_ Boolean)",
		false::isGreaterThanOrEqualTo(true),
	)
	show("Boolean.and(_ Boolean)", true::and(true))
	show("Boolean.and(_ Boolean) [false]", true::and(false))
	show("Boolean.or(_ Boolean)", false::or(true))
	show("Boolean.or(_ Boolean) [both false]", false::or(false))
	show("Boolean.exclusiveOr(_ Boolean)", true::exclusiveOr(false))
	show("Boolean.exclusiveOr(_ Boolean) [both true]", true::exclusiveOr(true))
	show("Boolean.toString()", true::toString())
	show("Boolean.toString() [false]", false::toString())

	§ ——— Integer ——————————————————————————————————————————————————————————
	§ The division family tells its entries apart by what is known about the
	§ DIVISOR, so the calls have to be told apart the same way. A divisor the
	§ Program COMPUTES might be anything, so it reaches the entry answering an
	§ Optional; one written where it stands is its own proof that it is not
	§ zero, and reaches the total entry.
	§
	§ `raise` splits the same way on the sign of its EXPONENT, so the two
	§ computed exponents below keep those calls on the entry answering an
	§ Optional. A written non-negative exponent is its own proof and reaches
	§ the total entry.
	§
	§ A RECEIVER written down proves the same things about itself, and reaches
	§ the refined Namespace that spends the proof. So a computed receiver is
	§ what keeps a call on the entry `Integer` declares, and each refined
	§ Namespace is called under a label of its own further down. Each is
	§ computed with `subtract`, the one operation no refined Namespace closes
	§ over: a sum of two written Integers is `PositiveInteger`'s own now, and
	§ would carry its proof into every call below.
	constant computedTwo   = 3::subtract(1)
	constant computedThree = 4::subtract(1)
	constant computedFive  = 6::subtract(1)
	constant computedEight = 9::subtract(1)
	constant computedNine  = 10::subtract(1)
	constant computedTen   = 11::subtract(1)
	constant computedZero  = 1::subtract(1)

	constant computedSixtySix      = 67::subtract(1)
	constant computedHundred       = 101::subtract(1)
	constant computedDividend      = 1111::subtract(1)
	constant computedNegativeThree = 0::subtract(3)
	constant computedNegativeFive  = 0::subtract(5)

	§ A written Rational proves it is not zero exactly as a written Integer
	§ does, so these keep the calls below on the entries taking a Rational that
	§ might be. Each is the sum of two halves of itself, which the exact
	§ arithmetic answers in lowest terms — so each holds the parts the written
	§ form holds. The negative one is a difference, for the same reason.
	constant computedHalf          = 1/4::add(1/4)
	constant computedSixth         = 1/12::add(1/12)
	constant computedThreeQuarters = 1/2::add(1/4)
	constant computedNegativeThreeQuarters = 0/1::subtract(3/4)

	§ One over the range a JavaScript number holds exactly, computed so that
	§ the multiplication below is Integer's own.
	constant computedHugeInteger = 9_007_199_254_740_992::subtract(1)

	show("Integer.is(_ Integer)", 7::is(7))
	show("Integer.is(_ Integer) [differing]", 7::is(8))
	show("Integer.isNot(_ Integer)", 7::isNot(8))
	show("Integer.isNot(_ Integer) [equal]", 7::isNot(7))
	show("Integer.is(_ Rational)", 7::is(7/1))
	show("Integer.is(_ Rational) [fractional]", 7::is(1/2))
	show("Integer.isNot(_ Rational)", 7::isNot(1/2))
	show("Integer.isNot(_ Rational) [equal]", 7::isNot(7/1))
	show("Integer.add(_ Integer)", computedSixtySix::add(34))
	show("Integer.add(_ Integer) [negative]", 66::add(-100))
	show("Integer.add(_ Rational)", 1::add(1/2))
	show("Integer.add(_ Transcendental)", 1::add(Number.Pi))
	show("Integer.subtract(_ Integer)", 1234::subtract(234))
	show("Integer.subtract(_ Rational)", 1::subtract(1/2))
	show("Integer.subtract(_ Transcendental)", 1::subtract(Number.Pi))
	show("Integer.divide(by: Integer)", 1110::divide(by computedTwo))
	show("Integer.divide(by: Integer) [by zero]", 1::divide(by 0))
	show("Integer.divide(by: Rational)", 1::divide(by computedHalf))
	show("Integer.divide(by: Rational) [by zero]", 1::divide(by 0/1))
	show("Integer.divide(by: NonZeroInteger)", computedDividend::divide(by 2))
	show("Integer.divide(by: NonZeroRational)", 1::divide(by 1/2))
	show(
		"Integer.divide(by: Integer, defaultingTo: Rational)",
		1110::divide(by computedTwo, defaultingTo 0/1),
	)
	show(
		"Integer.divide(by: Integer, defaultingTo: Rational) [by zero]",
		1::divide(by 0, defaultingTo 0/1),
	)
	show(
		"Integer.divide(by: Rational, defaultingTo: Rational)",
		1::divide(by computedHalf, defaultingTo 0/1),
	)
	show(
		"Integer.divide(by: Rational, defaultingTo: Rational) [by zero]",
		1::divide(by 0/1, defaultingTo 0/1),
	)
	show(
		"Integer.multiply(with: Integer)",
		computedHundred::multiply(with 1000),
	)
	show(
		"Integer.multiply(with: Integer) [beyond IEEE 754]",
		computedHugeInteger::multiply(with 500),
	)
	show("Integer.multiply(with: Rational)", 3::multiply(with 1/3))
	show(
		"Integer.multiply(with: Transcendental)",
		computedTwo::multiply(with Number.Pi),
	)
	show(
		"Integer.multiply(with: Transcendental) [collapses to Rational]",
		0::multiply(with Number.Pi),
	)
	show("Integer.isLessThan(_ Integer)", 1::isLessThan(2))
	show("Integer.isLessThan(_ Integer) [equal]", 2::isLessThan(2))
	show("Integer.isLessThan(_ Rational)", 1::isLessThan(3/2))
	show("Integer.isLessThan(_ Rational) [greater]", 2::isLessThan(3/2))
	show("Integer.isLessThanOrEqualTo(_ Integer)", 2::isLessThanOrEqualTo(2))
	show(
		"Integer.isLessThanOrEqualTo(_ Integer) [greater]",
		3::isLessThanOrEqualTo(2),
	)
	show("Integer.isLessThanOrEqualTo(_ Rational)", 2::isLessThanOrEqualTo(3/2))
	show(
		"Integer.isLessThanOrEqualTo(_ Rational) [less]",
		1::isLessThanOrEqualTo(3/2),
	)
	show("Integer.isGreaterThan(_ Integer)", 3::isGreaterThan(2))
	show("Integer.isGreaterThan(_ Integer) [equal]", 2::isGreaterThan(2))
	show("Integer.isGreaterThan(_ Rational)", 1::isGreaterThan(3/2))
	show("Integer.isGreaterThan(_ Rational) [greater]", 2::isGreaterThan(3/2))
	show(
		"Integer.isGreaterThanOrEqualTo(_ Integer)",
		2::isGreaterThanOrEqualTo(2),
	)
	show(
		"Integer.isGreaterThanOrEqualTo(_ Integer) [less]",
		1::isGreaterThanOrEqualTo(2),
	)
	show(
		"Integer.isGreaterThanOrEqualTo(_ Rational)",
		2::isGreaterThanOrEqualTo(3/2),
	)
	show(
		"Integer.isGreaterThanOrEqualTo(_ Rational) [less]",
		1::isGreaterThanOrEqualTo(3/2),
	)
	show("Integer.squareRoot() [perfect square]", computedNine::squareRoot())
	show("Integer.squareRoot() [irrational]", computedTwo::squareRoot())
	show("Integer.squareRoot() [zero]", computedZero::squareRoot())
	show("Integer.squareRoot() [negative]", -1::squareRoot())
	show(
		"Integer.squareRoot(defaultingTo: Integer | Algebraic)",
		computedNine::squareRoot(defaultingTo 0),
	)
	show(
		"Integer.squareRoot(defaultingTo: Integer | Algebraic) [negative]",
		-1::squareRoot(defaultingTo 0),
	)
	show("Integer.absolute()", computedNegativeFive::absolute())
	show("Integer.absolute() [positive]", computedFive::absolute())
	show("Integer.negate()", computedFive::negate())
	show("Integer.toRational()", computedFive::toRational())
	show("Integer.negate() [zero]", 0::negate())
	show("Integer.round(toward?: Rounding) [no direction named]", 5::round())
	show("Integer.round(toward?: Rounding)", -5::round(toward #Up))
	show(
		"Integer.round(toPlaces: Integer, toward?: Rounding)",
		5::round(toPlaces 2),
	)
	show(
		"Integer.round(toPlaces: Integer, toward?: Rounding) [negative, down]",
		-5::round(toPlaces 2, toward #Down),
	)
	show(
		"Integer.approximate(toPlaces: NonNegativeInteger, toward?: Rounding)",
		5::approximate(toPlaces 2),
	)
	show(
		"Integer.approximate(toPlaces: NonNegativeInteger, toward?: Rounding) [negative]",
		-5::approximate(toPlaces 0, toward #Up),
	)
	show("Integer.isEven()", 4::isEven())
	show("Integer.isEven() [odd]", 3::isEven())
	show("Integer.isOdd()", -3::isOdd())
	show("Integer.isOdd() [even]", 4::isOdd())
	show("Integer.isPositive()", 1::isPositive())
	show("Integer.isPositive() [zero]", 0::isPositive())
	show("Integer.isNegative()", -1::isNegative())
	show("Integer.isNegative() [zero]", 0::isNegative())
	show("Integer.isZero()", 0::isZero())
	show("Integer.isZero() [non zero]", 1::isZero())
	show("Integer.isWholeNumber()", 5::isWholeNumber())
	show("Integer.isMultiple(of: Integer)", 9::isMultiple(of computedThree))
	show(
		"Integer.isMultiple(of: Integer) [not a multiple]",
		10::isMultiple(of computedThree),
	)
	show(
		"Integer.isMultiple(of: Integer) [zero is a multiple of every Integer]",
		computedZero::isMultiple(of computedThree),
	)
	show(
		"Integer.isMultiple(of: Integer) [by zero]",
		9::isMultiple(of computedZero),
	)
	show("Integer.isPrime()", 97::isPrime())
	show("Integer.isPrime() [composite]", 91::isPrime())
	show("Integer.isPrime() [one]", 1::isPrime())
	show("Integer.isPrime() [negative]", -7::isPrime())
	show("Integer.isPrime() [a Carmichael number]", 561::isPrime())
	show(
		"Integer.greatestCommonDivisor(with: Integer)",
		computedEight::greatestCommonDivisor(with 12),
	)
	show(
		"Integer.greatestCommonDivisor(with: Integer) [negative]",
		computedNegativeFive::greatestCommonDivisor(with 10),
	)
	show(
		"Integer.greatestCommonDivisor(with: Integer) [both zero]",
		computedZero::greatestCommonDivisor(with 0),
	)
	show(
		"Integer.leastCommonMultiple(with: Integer)",
		computedEight::leastCommonMultiple(with 12),
	)
	show(
		"Integer.leastCommonMultiple(with: Integer) [negative]",
		computedNegativeFive::leastCommonMultiple(with 10),
	)
	show(
		"Integer.leastCommonMultiple(with: Integer) [by zero]",
		computedEight::leastCommonMultiple(with 0),
	)
	show("Integer.factorial()", computedFive::factorial())
	show("Integer.factorial() [zero]", computedZero::factorial())
	show("Integer.factorial() [negative]", computedNegativeFive::factorial())
	show(
		"Integer.factorial(defaultingTo: Integer)",
		computedFive::factorial(defaultingTo 0),
	)
	show(
		"Integer.factorial(defaultingTo: Integer) [negative]",
		computedNegativeFive::factorial(defaultingTo 0),
	)
	show(
		"Integer.remainder(dividingBy: Integer)",
		7::remainder(dividingBy computedThree),
	)
	show(
		"Integer.remainder(dividingBy: Integer) [negative dividend]",
		-7::remainder(dividingBy computedThree),
	)
	show(
		"Integer.remainder(dividingBy: Integer) [by zero]",
		7::remainder(dividingBy 0),
	)
	show(
		"Integer.remainder(dividingBy: NonZeroInteger)",
		7::remainder(dividingBy 3),
	)
	show(
		"Integer.remainder(dividingBy: Integer, defaultingTo: Integer)",
		7::remainder(dividingBy computedThree, defaultingTo 0),
	)
	show(
		"Integer.remainder(dividingBy: Integer, defaultingTo: Integer) [by zero]",
		7::remainder(dividingBy 0, defaultingTo 0),
	)
	show(
		"Integer.quotient(dividingBy: Integer)",
		7::quotient(dividingBy computedThree),
	)
	show(
		"Integer.quotient(dividingBy: Integer) [negative dividend]",
		-7::quotient(dividingBy computedThree),
	)
	show(
		"Integer.quotient(dividingBy: Integer) [negative divisor]",
		7::quotient(dividingBy computedNegativeThree),
	)
	show(
		"Integer.quotient(dividingBy: Integer) [by zero]",
		7::quotient(dividingBy 0),
	)
	show(
		"Integer.quotient(dividingBy: NonZeroInteger)",
		7::quotient(dividingBy 3),
	)
	show(
		"Integer.quotient(dividingBy: Integer, defaultingTo: Integer)",
		7::quotient(dividingBy computedThree, defaultingTo 0),
	)
	show(
		"Integer.remainder(dividingBy: NonZeroInteger, as: Division)",
		-7::remainder(dividingBy 3, as #Truncating),
	)
	show(
		"Integer.remainder(dividingBy: NonZeroInteger, as: Division) [Euclidean]",
		-7::remainder(dividingBy 3, as #Euclidean),
	)
	show(
		"Integer.remainder(dividingBy: NonZeroInteger, as: Division) [negative divisor]",
		-7::remainder(dividingBy -3, as #Truncating),
	)
	show(
		"Integer.remainder(dividingBy: NonZeroInteger, as: Division) [no remainder]",
		-6::remainder(dividingBy 3, as #Truncating),
	)
	show(
		"Integer.quotient(dividingBy: NonZeroInteger, toward: Rounding)",
		7::quotient(dividingBy 2, toward #Up),
	)
	show(
		"Integer.quotient(dividingBy: NonZeroInteger, toward: Rounding) [down]",
		7::quotient(dividingBy 2, toward #Down),
	)
	show(
		"Integer.quotient(dividingBy: NonZeroInteger, toward: Rounding) [negative divisor]",
		7::quotient(dividingBy -3, toward #Down),
	)
	show(
		"Integer.quotient(dividingBy: NonZeroInteger, toward: Rounding) [toward zero]",
		-7::quotient(dividingBy 2, toward #TowardZero),
	)
	show(
		"Integer.quotient(dividingBy: Integer, defaultingTo: Integer) [by zero]",
		7::quotient(dividingBy 0, defaultingTo 0),
	)
	show("Integer.raise(to: Integer)", computedTwo::raise(to computedTen))
	show(
		"Integer.raise(to: Integer) [zero exponent]",
		computedTwo::raise(to computedZero),
	)
	show(
		"Integer.raise(to: Integer) [negative exponent]",
		computedTwo::raise(to -2),
	)
	show(
		"Integer.raise(to: Integer) [zero to a negative power]",
		0::raise(to -1),
	)
	show(
		"Integer.raise(to: Integer, defaultingTo: Integer | Rational)",
		computedTwo::raise(to computedTen, defaultingTo 0),
	)
	show(
		"Integer.raise(to: Integer, defaultingTo: Integer | Rational) [zero to a negative power]",
		0::raise(to -1, defaultingTo 0),
	)
	show("Integer.raise(to: NonNegativeInteger)", computedTwo::raise(to 10))
	show(
		"Integer.raise(to: NonNegativeInteger) [zero exponent]",
		computedTwo::raise(to 0),
	)
	show("Integer.raise(to: NonNegativeInteger) [zero base]", 0::raise(to 2))
	show(
		"Integer.clamp(between: Integer, and: Integer) [above]",
		15::clamp(between 1, and 10),
	)
	show(
		"Integer.clamp(between: Integer, and: Integer) [below]",
		-2::clamp(between 1, and 10),
	)
	show(
		"Integer.clamp(between: Integer, and: Integer) [within]",
		5::clamp(between 1, and 10),
	)
	show(
		"Integer.clamp(between: Integer, and: Integer) [inverted bounds]",
		5::clamp(between 10, and 1),
	)
	show(
		"Integer.clamp(between: Integer, and: Integer) [inverted bounds, above]",
		15::clamp(between 10, and 1),
	)
	show("Integer.isBetween(_ Integer, and: Integer)", 5::isBetween(1, and 10))
	show(
		"Integer.isBetween(_ Integer, and: Integer) [outside]",
		15::isBetween(1, and 10),
	)
	show(
		"Integer.isBetween(_ Integer, and: Integer) [on the bound]",
		10::isBetween(1, and 10),
	)
	show(
		"Integer.isBetween(_ Integer, and: Integer) [inverted bounds]",
		5::isBetween(10, and 1),
	)
	show(
		"Integer.isBetween(_ Integer, and: Integer) [inverted bounds, above]",
		15::isBetween(10, and 1),
	)
	show("Integer.parse(_ String)", Integer.parse("42"))
	show("Integer.parse(_ String) [negative]", Integer.parse("-42"))
	show("Integer.parse(_ String) [not a number]", Integer.parse("nope"))
	show("Integer.parse(_ String) [empty]", Integer.parse(emptyText))
	show("Integer.parse(_ String) [leading zeroes]", Integer.parse("007"))
	show("Integer.parse(_ String) [plus sign]", Integer.parse("+42"))
	show("Integer.parse(_ String) [decimal point]", Integer.parse("4.2"))
	show("Integer.parse(_ String) [double sign]", Integer.parse("--42"))
	show("Integer.parse(_ String) [sign alone]", Integer.parse("-"))
	show("Integer.parse(_ String) [inner sign]", Integer.parse("4-2"))
	§ An underscore stands between two digits and nowhere else, which is the
	§ rule the Lexer reads a written Integer by.
	show(
		"Integer.parse(_ String) [separators]",
		Integer.parse("9_007_199_254_740_991"),
	)
	show("Integer.parse(_ String) [leading separator]", Integer.parse("_1"))
	show("Integer.parse(_ String) [trailing separator]", Integer.parse("1_"))
	show("Integer.parse(_ String) [doubled separator]", Integer.parse("1__0"))
	show("Integer.parse(_ String) [separator alone]", Integer.parse("_"))
	show(
		"Integer.parse(_ String, defaultingTo: Integer)",
		Integer.parse("42", defaultingTo 0),
	)
	show(
		"Integer.parse(_ String, defaultingTo: Integer) [not a number]",
		Integer.parse("nope", defaultingTo 0),
	)
	show(
		"Integer.parse(_ String, inBase: Integer)",
		Integer.parse("ff", inBase 16),
	)
	show(
		"Integer.parse(_ String, inBase: Integer) [capital digits]",
		Integer.parse("-FF", inBase 16),
	)
	show(
		"Integer.parse(_ String, inBase: Integer) [digit the base has no room for]",
		Integer.parse("2", inBase 2),
	)
	show(
		"Integer.parse(_ String, inBase: Integer) [base below two]",
		Integer.parse("101", inBase 1),
	)
	show(
		"Integer.parse(_ String, inBase: Integer, defaultingTo: Integer)",
		Integer.parse("zz", inBase 36, defaultingTo 0),
	)
	show(
		"Integer.parse(_ String, inBase: Integer, defaultingTo: Integer) [not a number]",
		Integer.parse("nope", inBase 16, defaultingTo 0),
	)
	show("Integer.toString()", 42::toString())
	show("Integer.toString(inBase: Integer)", 255::toString(inBase 16))
	show(
		"Integer.toString(inBase: Integer) [negative, base two]",
		-5::toString(inBase 2),
	)
	show(
		"Integer.toString(inBase: Integer) [base above thirty-six]",
		255::toString(inBase 99),
	)
	show("Integer.toString() [negative]", -42::toString())
	show(
		"Integer.toString(as: NumberFormat)",
		42::toString(as NumberFormat#Decimal),
	)
	show(
		"Integer.toString(as: NumberFormat) [fraction]",
		42::toString(as NumberFormat#Fraction),
	)
	show(
		"Integer.toString(as: NumberFormat) [scientific]",
		1234::toString(as NumberFormat#Scientific),
	)
	show(
		"Integer.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding)",
		42::toString(as NumberFormat#Decimal, toPlaces 2),
	)
	show(
		"Integer.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [percent]",
		42::toString(as NumberFormat#Percent, toPlaces 1),
	)
	show(
		"Integer.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [scientific, negative]",
		-1234::toString(as NumberFormat#Scientific, toPlaces 2),
	)
	show(
		"Integer.toString(as: NumberFormat, groupingWith: String)",
		1234567::toString(as NumberFormat#Decimal, groupingWith ","),
	)
	show(
		"Integer.toString(as: NumberFormat, groupingWith: String) [under three digits]",
		12::toString(as NumberFormat#Decimal, groupingWith ","),
	)
	show(
		"Integer.toString(as: NumberFormat, toPlaces: Integer, groupingWith: String, toward?: Rounding)",
		1234567
			::toString(as NumberFormat#Decimal, toPlaces 2, groupingWith ","),
	)
	show(
		"Integer.toString(as: NumberFormat, toPlaces: Integer, groupingWith: String, toward?: Rounding) [negative]",
		-1234567
			::toString(as NumberFormat#Decimal, toPlaces 2, groupingWith ","),
	)
	show(
		"Integer.toString(scaledBy: NonNegativeInteger)",
		1234::toString(scaledBy 2),
	)
	show(
		"Integer.toString(scaledBy: NonNegativeInteger) [negative]",
		-1234::toString(scaledBy 2),
	)
	show(
		"Integer.toString(scaledBy: NonNegativeInteger) [below the scale]",
		5::toString(scaledBy 2),
	)
	show(
		"Integer.toString(scaledBy: NonNegativeInteger) [no places]",
		1234::toString(scaledBy 0),
	)
	show(
		"Integer.toString(showingSign: SignStyle)",
		3::toString(showingSign SignStyle#Always),
	)
	show(
		"Integer.toString(showingSign: SignStyle) [negative]",
		-3::toString(showingSign SignStyle#Always),
	)
	show(
		"Integer.toString(showingSign: SignStyle) [zero]",
		0::toString(showingSign SignStyle#Always),
	)
	show(
		"Integer.toString(showingSign: SignStyle) [only negative]",
		3::toString(showingSign SignStyle#Negative),
	)
	show("Integer.compare(to: Integer)", 1::compare(to 2))
	show("Integer.compare(to: Integer) [equal]", 2::compare(to 2))
	show("Integer.compare(to: Integer) [greater]", 3::compare(to 2))

	withRootTwo((_ rootTwo: Algebraic) -> {} {
		show("Integer.add(_ Algebraic)", 1::add(rootTwo))
		show("Integer.subtract(_ Algebraic)", 1::subtract(rootTwo))
		show("Integer.divide(by: Algebraic)", 1::divide(by rootTwo))
		show(
			"Integer.multiply(with: Algebraic)",
			computedThree::multiply(with rootTwo),
		)
		show(
			"Integer.multiply(with: Algebraic) [collapses to Rational]",
			0::multiply(with rootTwo),
		)
		<- {}
	})

	§ ——— NonZeroInteger ———————————————————————————————————————————————————
	§ The Methods a proven Integer has that a bare one does not. The closing
	§ `multiply` entry needs both operands proven, and a value written down is
	§ its own proof — as a receiver as much as as an Argument. The receivers are
	§ declared all the same, so that the Integer entries above keep their
	§ calls. The two irrational entries spend the receiver's proof alone, and
	§ so does `raise`: a base that is not zero has a power at every exponent,
	§ negative ones included. Its second entry takes the exponent's proof as
	§ well, so the base entry is reached with a computed one.
	constant provenSix: NonZeroInteger         = 6
	constant provenNegativeSix: NonZeroInteger = -6

	show(
		"NonZeroInteger.multiply(with: NonZeroInteger)",
		provenSix::multiply(with 7),
	)
	show(
		"NonZeroInteger.multiply(with: Algebraic)",
		provenSix::multiply(with Number.GoldenRatio),
	)
	show(
		"NonZeroInteger.multiply(with: Transcendental)",
		provenSix::multiply(with Number.Pi),
	)
	show("NonZeroInteger.raise(to: Integer)", provenSix::raise(to -3))
	show(
		"NonZeroInteger.raise(to: Integer) [non-negative exponent]",
		provenSix::raise(to computedTwo),
	)
	show("NonZeroInteger.raise(to: NonNegativeInteger)", provenSix::raise(to 2))
	show("NonZeroInteger.divide(by: NonZeroInteger)", provenSix::divide(by 4))
	show(
		"NonZeroInteger.divide(by: NonZeroInteger) [reaches reciprocal bare]",
		provenSix::divide(by 4)::reciprocal(),
	)
	show("NonZeroInteger.absolute()", provenNegativeSix::absolute())
	show("NonZeroInteger.absolute() [positive]", provenSix::absolute())
	show("NonZeroInteger.negate()", provenSix::negate())
	show("NonZeroInteger.negate() [negative]", provenNegativeSix::negate())

	§ ——— NonNegativeInteger ————————————————————————————————————————————————
	§ The Methods a sign proves. The receivers are declared rather than
	§ written, so that the calls above keep reaching Integer's own entry: a
	§ written `4` proves its sign for itself and comes here instead. The
	§ `add` entries are told apart by what is known about the SUMMAND, and a
	§ written `0` proves only that it is not negative.
	constant provenFour: NonNegativeInteger  = 4
	constant provenThree: NonNegativeInteger = 3
	constant provenZero: NonNegativeInteger  = 0

	show("NonNegativeInteger.add(_ PositiveInteger)", provenFour::add(3))
	show(
		"NonNegativeInteger.add(_ PositiveInteger) [zero receiver]",
		provenZero::add(3),
	)
	show("NonNegativeInteger.add(_ NonNegativeInteger)", provenFour::add(0))
	show(
		"NonNegativeInteger.add(_ NonNegativeInteger) [both zero]",
		provenZero::add(0),
	)
	show(
		"NonNegativeInteger.multiply(with: NonNegativeInteger)",
		provenFour::multiply(with 3),
	)
	show(
		"NonNegativeInteger.multiply(with: NonNegativeInteger) [zero]",
		provenFour::multiply(with 0),
	)
	show("NonNegativeInteger.squareRoot()", provenFour::squareRoot())
	show(
		"NonNegativeInteger.squareRoot() [irrational]",
		provenThree::squareRoot(),
	)
	show("NonNegativeInteger.squareRoot() [zero]", provenZero::squareRoot())
	show("NonNegativeInteger.factorial()", provenFour::factorial())
	show("NonNegativeInteger.factorial() [zero]", provenZero::factorial())

	§ ——— PositiveInteger ——————————————————————————————————————————————————
	§ Both proofs at once, and a written Integer above zero is one of these
	§ for itself: `4::squareRoot()` comes here rather than to the Namespace
	§ above. The receivers are declared all the same, for the reason the two
	§ blocks above declare theirs.
	constant provenPositiveFour: PositiveInteger = 4

	show(
		"PositiveInteger.add(_ NonNegativeInteger)",
		provenPositiveFour::add(0),
	)
	show(
		"PositiveInteger.add(_ NonNegativeInteger) [positive summand]",
		provenPositiveFour::add(3),
	)
	show(
		"PositiveInteger.multiply(with: PositiveInteger)",
		provenPositiveFour::multiply(with 3),
	)
	show(
		"PositiveInteger.raise(to: NonNegativeInteger)",
		provenPositiveFour::raise(to 3),
	)
	show(
		"PositiveInteger.raise(to: NonNegativeInteger) [zero exponent]",
		provenPositiveFour::raise(to 0),
	)
	show("PositiveInteger.squareRoot()", provenPositiveFour::squareRoot())
	show("PositiveInteger.squareRoot() [irrational]", 3::squareRoot())

	§ ——— Rational —————————————————————————————————————————————————————————
	§ The two entries of `of` are told apart by what is known about the
	§ DENOMINATOR — the same split the Integer division family above makes, and
	§ the same computed Constants keep these calls on the possibly-zero entry.
	show(
		"Rational.of(_ Integer, over: Integer)",
		Rational.of(1, over computedTwo),
	)
	show(
		"Rational.of(_ Integer, over: Integer) [over zero]",
		Rational.of(1, over 0),
	)
	show(
		"Rational.of(_ Integer, over: Integer) [not reduced]",
		Rational.of(4, over computedEight),
	)
	show("Rational.of(_ Integer, over: NonZeroInteger)", Rational.of(1, over 2))
	show(
		"Rational.of(_ Integer, over: NonZeroInteger) [not reduced]",
		Rational.of(4, over 8),
	)
	show(
		"Rational.of(_ Integer, over: Integer, defaultingTo: Rational)",
		Rational.of(1, over computedTwo, defaultingTo 0/1),
	)
	show(
		"Rational.of(_ Integer, over: Integer, defaultingTo: Rational) [over zero]",
		Rational.of(1, over 0, defaultingTo 0/1),
	)
	show("Rational.is(_ Rational)", 1/2::is(2/4))
	show("Rational.is(_ Rational) [differing]", 1/2::is(1/3))
	show("Rational.isNot(_ Rational)", 1/2::isNot(1/3))
	show("Rational.isNot(_ Rational) [equal]", 1/2::isNot(2/4))
	show("Rational.is(_ Integer)", 4/2::is(2))
	show("Rational.is(_ Integer) [fractional]", 1/2::is(2))
	show("Rational.isNot(_ Integer)", 1/2::isNot(2))
	show("Rational.isNot(_ Integer) [equal]", 4/2::isNot(2))
	show("Rational.add(_ Rational)", 1/2::add(1/3))
	show("Rational.add(_ Rational) [collapses to a whole]", 1/2::add(1/2))
	show("Rational.add(_ Integer)", 1/2::add(1))
	show("Rational.add(_ Transcendental)", 1/2::add(Number.Pi))
	show("Rational.subtract(_ Rational)", 1/2::subtract(1/3))
	show("Rational.subtract(_ Integer)", 1/2::subtract(1))
	show("Rational.subtract(_ Transcendental)", 1/2::subtract(Number.Pi))
	show("Rational.divide(by: Rational)", 1/2::divide(by computedSixth))
	show("Rational.divide(by: Rational) [by zero]", 1/2::divide(by 0/1))
	show("Rational.divide(by: Integer)", 1/2::divide(by computedTwo))
	show("Rational.divide(by: Integer) [by zero]", 1/2::divide(by 0))
	show("Rational.divide(by: NonZeroInteger)", 1/2::divide(by 2))
	show("Rational.divide(by: NonZeroRational)", 1/2::divide(by 1/6))
	show(
		"Rational.divide(by: Rational, defaultingTo: Rational)",
		1/2::divide(by computedSixth, defaultingTo 0/1),
	)
	show(
		"Rational.divide(by: Rational, defaultingTo: Rational) [by zero]",
		1/2::divide(by 0/1, defaultingTo 0/1),
	)
	show(
		"Rational.divide(by: Integer, defaultingTo: Rational)",
		1/2::divide(by computedTwo, defaultingTo 0/1),
	)
	show(
		"Rational.divide(by: Integer, defaultingTo: Rational) [by zero]",
		1/2::divide(by 0, defaultingTo 0/1),
	)
	show("Rational.multiply(with: Rational)", computedHalf::multiply(with 2/3))
	show("Rational.multiply(with: Integer)", 1/2::multiply(with 2))
	show(
		"Rational.multiply(with: Transcendental)",
		1/2::multiply(with Number.Pi),
	)
	show(
		"Rational.multiply(with: Transcendental) [collapses to Rational]",
		0/1::multiply(with Number.Pi),
	)
	show("Rational.isLessThan(_ Rational)", 1/2::isLessThan(2/3))
	show("Rational.isLessThan(_ Rational) [greater]", 2/3::isLessThan(1/2))
	show("Rational.isLessThan(_ Integer)", 1/2::isLessThan(1))
	show("Rational.isLessThan(_ Integer) [greater]", 3/2::isLessThan(1))
	show(
		"Rational.isLessThanOrEqualTo(_ Rational)",
		1/2::isLessThanOrEqualTo(1/2),
	)
	show(
		"Rational.isLessThanOrEqualTo(_ Rational) [greater]",
		2/3::isLessThanOrEqualTo(1/2),
	)
	show("Rational.isLessThanOrEqualTo(_ Integer)", 1/2::isLessThanOrEqualTo(0))
	show(
		"Rational.isLessThanOrEqualTo(_ Integer) [less]",
		1/2::isLessThanOrEqualTo(1),
	)
	show("Rational.isGreaterThan(_ Rational)", 2/3::isGreaterThan(1/2))
	show("Rational.isGreaterThan(_ Rational) [less]", 1/2::isGreaterThan(2/3))
	show("Rational.isGreaterThan(_ Integer)", 1/2::isGreaterThan(1))
	show("Rational.isGreaterThan(_ Integer) [greater]", 3/2::isGreaterThan(1))
	show(
		"Rational.isGreaterThanOrEqualTo(_ Rational)",
		1/2::isGreaterThanOrEqualTo(1/2),
	)
	show(
		"Rational.isGreaterThanOrEqualTo(_ Rational) [less]",
		1/2::isGreaterThanOrEqualTo(2/3),
	)
	show(
		"Rational.isGreaterThanOrEqualTo(_ Integer)",
		3/2::isGreaterThanOrEqualTo(1),
	)
	show(
		"Rational.isGreaterThanOrEqualTo(_ Integer) [less]",
		1/2::isGreaterThanOrEqualTo(1),
	)
	show(
		"Rational.isBetween(_ Rational, and: Rational)",
		1/2::isBetween(1/3, and 2/3),
	)
	show(
		"Rational.isBetween(_ Rational, and: Rational) [outside]",
		1/2::isBetween(2/3, and 3/4),
	)
	show(
		"Rational.isBetween(_ Rational, and: Rational) [inverted bounds]",
		1/2::isBetween(2/3, and 1/3),
	)
	show(
		"Rational.clamp(between: Rational, and: Rational) [above]",
		3/4::clamp(between 1/3, and 2/3),
	)
	show(
		"Rational.clamp(between: Rational, and: Rational) [below]",
		1/4::clamp(between 1/3, and 2/3),
	)
	show(
		"Rational.clamp(between: Rational, and: Rational) [within]",
		1/2::clamp(between 1/3, and 2/3),
	)
	show(
		"Rational.clamp(between: Rational, and: Rational) [inverted bounds]",
		1/2::clamp(between 2/3, and 1/3),
	)
	show("Rational.squareRoot() [perfect square]", 1/4::squareRoot())
	show("Rational.squareRoot() [irrational]", 1/2::squareRoot())
	show("Rational.squareRoot() [negative]", -1/2::squareRoot())
	show(
		"Rational.squareRoot(defaultingTo: Rational | Algebraic)",
		1/4::squareRoot(defaultingTo 0/1),
	)
	show(
		"Rational.squareRoot(defaultingTo: Rational | Algebraic) [negative]",
		-1/2::squareRoot(defaultingTo 0/1),
	)
	show("Rational.numerator()", computedThreeQuarters::numerator())
	show("Rational.denominator()", 3/4::denominator())
	show("Rational.absolute()", computedNegativeThreeQuarters::absolute())
	show("Rational.negate()", computedThreeQuarters::negate())
	show("Rational.toRational()", computedThreeQuarters::toRational())
	show("Rational.reciprocal()", computedThreeQuarters::reciprocal())
	show("Rational.reciprocal() [of zero]", 0/1::reciprocal())
	show(
		"Rational.reciprocal(defaultingTo: Rational)",
		computedThreeQuarters::reciprocal(defaultingTo 0/1),
	)
	show(
		"Rational.reciprocal(defaultingTo: Rational) [of zero]",
		0/1::reciprocal(defaultingTo 0/1),
	)
	show("Rational.isWholeNumber()", 4/2::isWholeNumber())
	show("Rational.isWholeNumber() [fractional]", 3/4::isWholeNumber())
	show("Rational.isPositive()", 3/4::isPositive())
	show("Rational.isPositive() [zero]", 0/1::isPositive())
	show("Rational.isNegative()", -3/4::isNegative())
	show("Rational.isNegative() [zero]", 0/1::isNegative())
	show("Rational.isZero()", 0/1::isZero())
	show("Rational.isZero() [non zero]", 3/4::isZero())
	show("Rational.round(toward?: Rounding) [no direction named]", 7/2::round())
	show(
		"Rational.round(toward?: Rounding) [negative, no direction named]",
		-7/2::round(),
	)
	show("Rational.round(toward?: Rounding)", 7/2::round(toward #Nearest))
	show(
		"Rational.round(toward?: Rounding) [negative nearest]",
		-7/2::round(toward #Nearest),
	)
	show("Rational.round(toward?: Rounding) [down]", 7/2::round(toward #Down))
	show(
		"Rational.round(toward?: Rounding) [negative down]",
		-7/2::round(toward #Down),
	)
	show("Rational.round(toward?: Rounding) [up]", 7/2::round(toward #Up))
	show(
		"Rational.round(toward?: Rounding) [negative up]",
		-7/2::round(toward #Up),
	)
	show(
		"Rational.round(toward?: Rounding) [toward zero]",
		7/2::round(toward #TowardZero),
	)
	show(
		"Rational.round(toward?: Rounding) [negative toward zero]",
		-7/2::round(toward #TowardZero),
	)
	show(
		"Rational.round(toward?: Rounding) [whole is its own ceiling]",
		4/2::round(toward #Up),
	)
	show(
		"Rational.round(toward?: Rounding) [below a half]",
		1/4::round(toward #Nearest),
	)
	show(
		"Rational.round(toward?: Rounding) [a half to the even step]",
		1/2::round(toward #NearestEven),
	)
	show(
		"Rational.round(toward?: Rounding) [a half up to the even step]",
		3/2::round(toward #NearestEven),
	)
	show(
		"Rational.round(toward?: Rounding) [a negative half to the even step]",
		-7/2::round(toward #NearestEven),
	)
	show(
		"Rational.round(toward?: Rounding) [above a half, to the even step]",
		9/4::round(toward #NearestEven),
	)
	show(
		"Rational.round(toPlaces: Integer, toward?: Rounding)",
		5/3::round(toPlaces 2),
	)
	show(
		"Rational.round(toPlaces: Integer, toward?: Rounding) [negative]",
		-5/3::round(toPlaces 2),
	)
	show(
		"Rational.round(toPlaces: Integer, toward?: Rounding) [a half rounds away from zero]",
		1/8::round(toPlaces 2),
	)
	show(
		"Rational.round(toPlaces: Integer, toward?: Rounding) [down]",
		5/3::round(toPlaces 1, toward #Down),
	)
	show(
		"Rational.round(toPlaces: Integer, toward?: Rounding) [no places]",
		2/3::round(toPlaces 0),
	)
	show(
		"Rational.round(toPlaces: Integer, toward?: Rounding) [a count below one]",
		2/3::round(toPlaces -1),
	)
	show(
		"Rational.round(toPlaces: Integer, toward?: Rounding) [a half to the even place]",
		1/8::round(toPlaces 2, toward #NearestEven),
	)
	show(
		"Rational.approximate(toPlaces: NonNegativeInteger, toward?: Rounding)",
		5/3::approximate(toPlaces 2),
	)
	show(
		"Rational.approximate(toPlaces: NonNegativeInteger, toward?: Rounding) [down]",
		5/3::approximate(toPlaces 2, toward #Down),
	)
	show(
		"Rational.approximate(toPlaces: NonNegativeInteger, toward?: Rounding) [no places]",
		5/3::approximate(toPlaces 0),
	)
	§ The Euclidean pairing of two Rationals. A written divisor proves it is
	§ not zero, so the calls reaching the entry that answers an Optional need a
	§ computed one.
	constant computedZeroRational = 1/2::subtract(1/2)

	show(
		"Rational.remainder(dividingBy: Rational)",
		7/2::remainder(dividingBy computedSixth),
	)
	show(
		"Rational.remainder(dividingBy: Rational) [by zero]",
		7/2::remainder(dividingBy computedZeroRational),
	)
	show(
		"Rational.remainder(dividingBy: NonZeroRational)",
		7/2::remainder(dividingBy 1/3),
	)
	show(
		"Rational.remainder(dividingBy: NonZeroRational) [negative dividend]",
		-7/2::remainder(dividingBy 1/3),
	)
	show(
		"Rational.remainder(dividingBy: Rational, defaultingTo: Rational)",
		7/2::remainder(dividingBy computedSixth, defaultingTo 0/1),
	)
	show(
		"Rational.remainder(dividingBy: Rational, defaultingTo: Rational) [by zero]",
		7/2::remainder(dividingBy computedZeroRational, defaultingTo 0/1),
	)
	show(
		"Rational.quotient(dividingBy: Rational)",
		7/2::quotient(dividingBy computedSixth),
	)
	show(
		"Rational.quotient(dividingBy: Rational) [by zero]",
		7/2::quotient(dividingBy computedZeroRational),
	)
	show(
		"Rational.quotient(dividingBy: NonZeroRational)",
		7/2::quotient(dividingBy 1/3),
	)
	show(
		"Rational.quotient(dividingBy: NonZeroRational) [negative divisor]",
		7/2::quotient(dividingBy -1/3),
	)
	show(
		"Rational.quotient(dividingBy: Rational, defaultingTo: Integer)",
		7/2::quotient(dividingBy computedSixth, defaultingTo 0),
	)
	show(
		"Rational.quotient(dividingBy: Rational, defaultingTo: Integer) [by zero]",
		7/2::quotient(dividingBy computedZeroRational, defaultingTo 0),
	)
	§ The same split `Integer::raise` makes, and the same computed exponents
	§ keep these calls on the entry answering an Optional.
	show("Rational.raise(to: Integer)", 2/3::raise(to computedTwo))
	show(
		"Rational.raise(to: Integer) [zero exponent]",
		2/3::raise(to computedZero),
	)
	show("Rational.raise(to: Integer) [negative exponent]", 2/3::raise(to -2))
	show(
		"Rational.raise(to: Integer) [zero to a negative power]",
		0/1::raise(to -1),
	)
	show(
		"Rational.raise(to: Integer, defaultingTo: Rational)",
		2/3::raise(to computedTwo, defaultingTo 0/1),
	)
	show(
		"Rational.raise(to: Integer, defaultingTo: Rational) [zero to a negative power]",
		0/1::raise(to -1, defaultingTo 0/1),
	)
	show("Rational.raise(to: NonNegativeInteger)", 2/3::raise(to 2))
	show(
		"Rational.raise(to: NonNegativeInteger) [zero exponent]",
		2/3::raise(to 0),
	)
	show("Rational.raise(to: NonNegativeInteger) [zero base]", 0/1::raise(to 3))
	show("Rational.parse(_ String)", Rational.parse("0.75"))
	show("Rational.parse(_ String) [not a number]", Rational.parse("nope"))
	show("Rational.parse(_ String) [fraction]", Rational.parse("3/4"))
	show("Rational.parse(_ String) [negative fraction]", Rational.parse("-3/4"))
	show(
		"Rational.parse(_ String) [unreduced fraction]",
		Rational.parse("-3/6"),
	)
	show("Rational.parse(_ String) [negative decimal]", Rational.parse("-1.5"))
	show("Rational.parse(_ String) [whole]", Rational.parse("5"))
	show("Rational.parse(_ String) [zero denominator]", Rational.parse("1/0"))
	show(
		"Rational.parse(_ String) [signed denominator]",
		Rational.parse("1/-2"),
	)
	show("Rational.parse(_ String) [double sign]", Rational.parse("--1/2"))
	show("Rational.parse(_ String) [two slashes]", Rational.parse("1/2/3"))
	show("Rational.parse(_ String) [trailing dot]", Rational.parse("1."))
	show("Rational.parse(_ String) [leading dot]", Rational.parse(".5"))
	show("Rational.parse(_ String) [two dots]", Rational.parse("1.2.3"))
	show("Rational.parse(_ String) [trailing zeroes]", Rational.parse("0.750"))
	show("Rational.parse(_ String) [plus sign]", Rational.parse("+3/4"))
	show("Rational.parse(_ String) [separators]", Rational.parse("+1_000.5"))
	show(
		"Rational.parse(_ String) [separator in the fraction]",
		Rational.parse("0.1_0"),
	)
	§ The two halves are read apart, so a separator against the dot is refused
	§ where joining them would have read it as one between two digits.
	show(
		"Rational.parse(_ String) [separator against the dot]",
		Rational.parse("1_.5"),
	)
	show(
		"Rational.parse(_ String) [signed denominator, plus]",
		Rational.parse("1/+2"),
	)
	show("Rational.parse(_ String) [empty]", Rational.parse(emptyText))
	show(
		"Rational.parse(_ String, defaultingTo: Rational)",
		Rational.parse("0.75", defaultingTo 0/1),
	)
	show(
		"Rational.parse(_ String, defaultingTo: Rational) [not a number]",
		Rational.parse("nope", defaultingTo 0/1),
	)
	show("Rational.toString()", 3/4::toString())
	show("Rational.toString() [whole]", 4/2::toString())
	show(
		"Rational.toString(as: NumberFormat) [decimal]",
		1/2::toString(as NumberFormat#Decimal),
	)
	show(
		"Rational.toString(as: NumberFormat) [fraction]",
		1/2::toString(as NumberFormat#Fraction),
	)
	show(
		"Rational.toString(as: NumberFormat) [fraction, whole]",
		4/2::toString(as NumberFormat#Fraction),
	)
	show(
		"Rational.toString(as: NumberFormat) [percent]",
		3/4::toString(as NumberFormat#Percent),
	)
	show(
		"Rational.toString(as: NumberFormat) [scientific]",
		3/4::toString(as NumberFormat#Scientific),
	)
	show(
		"Rational.toString(as: NumberFormat) [scientific, zero]",
		0/1::toString(as NumberFormat#Scientific),
	)
	show(
		"Rational.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding)",
		5/3::toString(as NumberFormat#Decimal, toPlaces 2),
	)
	show(
		"Rational.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [padded]",
		1/2::toString(as NumberFormat#Decimal, toPlaces 2),
	)
	show(
		"Rational.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [negative]",
		-5/3::toString(as NumberFormat#Decimal, toPlaces 2),
	)
	show(
		"Rational.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [a half rounds away from zero]",
		1/8::toString(as NumberFormat#Decimal, toPlaces 2),
	)
	show(
		"Rational.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [no places]",
		2/3::toString(as NumberFormat#Decimal, toPlaces 0),
	)
	show(
		"Rational.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [fraction ignores the count]",
		3/4::toString(as NumberFormat#Fraction, toPlaces 2),
	)
	show(
		"Rational.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [down]",
		5/3::toString(as NumberFormat#Decimal, toPlaces 2, toward #Down),
	)
	show(
		"Rational.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [negative down]",
		-5/3::toString(as NumberFormat#Decimal, toPlaces 2, toward #Down),
	)
	show(
		"Rational.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [up]",
		5/3::toString(as NumberFormat#Decimal, toPlaces 2, toward #Up),
	)
	show(
		"Rational.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [toward zero]",
		-5/3::toString(as NumberFormat#Decimal, toPlaces 2, toward #TowardZero),
	)
	show(
		"Rational.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [a half to the even digit]",
		1/8::toString(as NumberFormat#Decimal, toPlaces 2, toward #NearestEven),
	)
	show(
		"Rational.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [percent]",
		1/8::toString(as NumberFormat#Percent, toPlaces 1),
	)
	show(
		"Rational.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [scientific]",
		1/3::toString(as NumberFormat#Scientific, toPlaces 4),
	)
	show(
		"Rational.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [scientific carries into the exponent]",
		999/100::toString(as NumberFormat#Scientific, toPlaces 1),
	)
	show(
		"Rational.toString(as: NumberFormat, groupingWith: String)",
		12345678/10000::toString(as NumberFormat#Decimal, groupingWith ","),
	)
	show(
		"Rational.toString(as: NumberFormat, groupingWith: String) [fraction groups both parts]",
		12345678/10000::toString(as NumberFormat#Fraction, groupingWith ","),
	)
	show(
		"Rational.toString(as: NumberFormat, toPlaces: Integer, groupingWith: String, toward?: Rounding)",
		12345678/10000
			::toString(as NumberFormat#Decimal, toPlaces 2, groupingWith ","),
	)
	show(
		"Rational.toString(as: NumberFormat, toPlaces: Integer, groupingWith: String, toward?: Rounding) [down]",
		12345678/10000
			::toString(
				as NumberFormat#Decimal,
				toPlaces 2,
				groupingWith ",",
				toward #Down,
			),
	)
	show(
		"Rational.toString(showingSign: SignStyle)",
		3/4::toString(showingSign SignStyle#Always),
	)
	show(
		"Rational.toString(showingSign: SignStyle) [negative]",
		-3/4::toString(showingSign SignStyle#Always),
	)
	show(
		"Rational.toString(showingSign: SignStyle) [whole]",
		4/2::toString(showingSign SignStyle#Always),
	)
	show(
		"Rational.toString(showingSign: SignStyle) [only negative]",
		3/4::toString(showingSign SignStyle#Negative),
	)
	show("Rational.compare(to: Rational)", 1/2::compare(to 2/3))
	show("Rational.compare(to: Rational) [equal]", 1/2::compare(to 2/4))
	show("Rational.compare(to: Rational) [greater]", 2/3::compare(to 1/2))

	withRootTwo((_ rootTwo: Algebraic) -> {} {
		show("Rational.add(_ Algebraic)", 1/2::add(rootTwo))
		show("Rational.subtract(_ Algebraic)", 1/2::subtract(rootTwo))
		show("Rational.divide(by: Algebraic)", 1/2::divide(by rootTwo))
		show("Rational.multiply(with: Algebraic)", 1/2::multiply(with rootTwo))
		show(
			"Rational.multiply(with: Algebraic) [collapses to Rational]",
			0/1::multiply(with rootTwo),
		)
		<- {}
	})

	§ ——— NonZeroRational ——————————————————————————————————————————————————
	§ The Methods a proven Rational has that a bare one does not, and the
	§ sister of the NonZeroInteger block above. `multiply` needs both operands
	§ proven, and a value written down is its own proof — as a receiver as much
	§ as as an Argument. So every call here is written where it stands.
	show(
		"NonZeroRational.multiply(with: NonZeroRational)",
		1/2::multiply(with 2/3),
	)
	show("NonZeroRational.reciprocal()", 3/4::reciprocal())
	show("NonZeroRational.numerator()", 3/4::numerator())
	show("NonZeroRational.numerator() [negative]", -3/4::numerator())
	show("NonZeroRational.absolute()", -3/4::absolute())
	show("NonZeroRational.absolute() [positive]", 3/4::absolute())
	show("NonZeroRational.negate()", 3/4::negate())
	show("NonZeroRational.negate() [negative]", -3/4::negate())
	show("NonZeroRational.negate() [not reduced]", 2/4::negate())

	§ ——— Scalar ———————————————————————————————————————————————————————————
	§ The two Methods of the Union `Integer | Rational`, which take an
	§ Argument of that Union — the one shape no member Namespace's own
	§ arithmetic accepts. A receiver annotated as the Union reaches them; a
	§ written Integer or Rational is its own kind and reaches that kind's
	§ rung, so both operands here carry the annotation.
	constant scalarReceiver: Scalar = 3
	constant scalarArgument: Scalar = 1/2

	show("Scalar.add(_ Scalar)", scalarReceiver::add(scalarArgument))
	show(
		"Scalar.multiply(with: Scalar)",
		scalarReceiver::multiply(with scalarArgument),
	)

	§ ——— Algebraic ————————————————————————————————————————————————————————
	withTwoRoots((_ rootTwo: Algebraic, _ rootThree: Algebraic) -> {} {
		show("Algebraic.is(_ Algebraic)", rootTwo::is(rootTwo))
		show(
			"Algebraic.is(_ Algebraic) [differing radicals]",
			rootTwo::is(rootThree),
		)
		show("Algebraic.isNot(_ Algebraic)", rootTwo::isNot(rootThree))
		show("Algebraic.isNot(_ Algebraic) [equal]", rootTwo::isNot(rootTwo))
		show("Algebraic.compare(to: Algebraic)", rootTwo::compare(to rootThree))
		show(
			"Algebraic.compare(to: Algebraic) [equal]",
			rootTwo::compare(to rootTwo),
		)
		show(
			"Algebraic.compare(to: Algebraic) [greater]",
			rootThree::compare(to rootTwo),
		)
		show(
			"Algebraic.isLessThan(_ Algebraic)",
			rootTwo::isLessThan(rootThree),
		)
		show(
			"Algebraic.isLessThan(_ Algebraic) [greater]",
			rootThree::isLessThan(rootTwo),
		)
		show(
			"Algebraic.isLessThanOrEqualTo(_ Algebraic)",
			rootTwo::isLessThanOrEqualTo(rootTwo),
		)
		show(
			"Algebraic.isLessThanOrEqualTo(_ Algebraic) [greater]",
			rootThree::isLessThanOrEqualTo(rootTwo),
		)
		show(
			"Algebraic.isGreaterThan(_ Algebraic)",
			rootThree::isGreaterThan(rootTwo),
		)
		show(
			"Algebraic.isGreaterThan(_ Algebraic) [less]",
			rootTwo::isGreaterThan(rootThree),
		)
		show(
			"Algebraic.isGreaterThanOrEqualTo(_ Algebraic)",
			rootTwo::isGreaterThanOrEqualTo(rootTwo),
		)
		show(
			"Algebraic.isGreaterThanOrEqualTo(_ Algebraic) [less]",
			rootTwo::isGreaterThanOrEqualTo(rootThree),
		)
		show(
			"Algebraic.isBetween(_ Algebraic, and: Algebraic)",
			rootTwo::isBetween(rootTwo, and rootThree),
		)
		show(
			"Algebraic.isBetween(_ Algebraic, and: Algebraic) [outside]",
			rootThree::isBetween(rootTwo, and rootTwo),
		)
		show(
			"Algebraic.isBetween(_ Algebraic, and: Algebraic) [inverted bounds]",
			rootTwo::isBetween(rootThree, and rootTwo),
		)
		show(
			"Algebraic.clamp(between: Algebraic, and: Algebraic) [above]",
			rootThree::clamp(between rootTwo, and rootTwo),
		)
		show(
			"Algebraic.clamp(between: Algebraic, and: Algebraic) [within]",
			rootTwo::clamp(between rootTwo, and rootThree),
		)
		show("Algebraic.add(_ Integer)", rootTwo::add(1))
		show("Algebraic.add(_ Rational)", rootTwo::add(1/2))
		show("Algebraic.add(_ Algebraic) [same radical]", rootTwo::add(rootTwo))
		show(
			"Algebraic.add(_ Algebraic) [differing radicals]",
			rootTwo::add(rootThree),
		)
		show("Algebraic.subtract(_ Integer)", rootTwo::subtract(1))
		show("Algebraic.subtract(_ Rational)", rootTwo::subtract(1/2))
		show(
			"Algebraic.subtract(_ Algebraic) [same radical]",
			rootTwo::subtract(rootTwo),
		)
		show(
			"Algebraic.subtract(_ Algebraic) [differing radicals]",
			rootTwo::subtract(rootThree),
		)
		§ The irrational arithmetic tells its entries apart by what is known
		§ about the OTHER operand, exactly as the Integer division family
		§ above does, so the computed Constants keep these calls on the
		§ entries answering a Union or an Optional.
		show(
			"Algebraic.multiply(with: Integer)",
			rootTwo::multiply(with computedThree),
		)
		show(
			"Algebraic.multiply(with: Integer) [by zero]",
			rootTwo::multiply(with 0),
		)
		show(
			"Algebraic.multiply(with: Rational)",
			rootTwo::multiply(with computedHalf),
		)
		show(
			"Algebraic.multiply(with: Algebraic) [same radical]",
			rootTwo::multiply(with rootTwo),
		)
		show(
			"Algebraic.multiply(with: Algebraic) [differing radicals]",
			rootTwo::multiply(with rootThree),
		)
		show(
			"Algebraic.multiply(with: NonZeroInteger)",
			rootTwo::multiply(with 3),
		)
		show(
			"Algebraic.multiply(with: NonZeroRational)",
			rootTwo::multiply(with 1/2),
		)
		show("Algebraic.divide(by: Integer)", rootTwo::divide(by computedTwo))
		show("Algebraic.divide(by: Integer) [by zero]", rootTwo::divide(by 0))
		show("Algebraic.divide(by: Rational)", rootTwo::divide(by computedHalf))
		show(
			"Algebraic.divide(by: Rational) [by zero]",
			rootTwo::divide(by 0/1),
		)
		show(
			"Algebraic.divide(by: Algebraic) [same radical]",
			rootTwo::divide(by rootTwo),
		)
		show(
			"Algebraic.divide(by: Algebraic) [differing radicals]",
			rootTwo::divide(by rootThree),
		)
		show("Algebraic.divide(by: NonZeroInteger)", rootTwo::divide(by 2))
		show("Algebraic.divide(by: NonZeroRational)", rootTwo::divide(by 1/2))
		§ The fallback entries. A sum over differing radicals leaves the
		§ quadratic slice, and so does a product of two values that are not
		§ pure radicals — those are the two shapes the fallback answers for.
		show(
			"Algebraic.add(_ Algebraic, defaultingTo: Rational | Algebraic)",
			rootTwo::add(rootTwo, defaultingTo 0/1),
		)
		show(
			"Algebraic.add(_ Algebraic, defaultingTo: Rational | Algebraic) [differing radicals]",
			rootTwo::add(rootThree, defaultingTo 0/1),
		)
		show(
			"Algebraic.subtract(_ Algebraic, defaultingTo: Rational | Algebraic)",
			rootTwo::subtract(rootTwo, defaultingTo 1/2),
		)
		show(
			"Algebraic.subtract(_ Algebraic, defaultingTo: Rational | Algebraic) [differing radicals]",
			rootTwo::subtract(rootThree, defaultingTo 1/2),
		)
		show(
			"Algebraic.multiply(with: Algebraic, defaultingTo: Rational | Algebraic)",
			rootTwo::multiply(with rootTwo, defaultingTo 0/1),
		)
		show(
			"Algebraic.multiply(with: Algebraic, defaultingTo: Rational | Algebraic) [not pure radicals]",
			rootTwo::add(1)::multiply(with rootThree::add(1), defaultingTo 0/1),
		)
		show(
			"Algebraic.divide(by: Integer, defaultingTo: Algebraic)",
			rootTwo::divide(by computedTwo, defaultingTo rootTwo),
		)
		show(
			"Algebraic.divide(by: Integer, defaultingTo: Algebraic) [by zero]",
			rootTwo::divide(by 0, defaultingTo rootTwo),
		)
		show(
			"Algebraic.divide(by: Rational, defaultingTo: Algebraic)",
			rootTwo::divide(by computedHalf, defaultingTo rootTwo),
		)
		show(
			"Algebraic.divide(by: Rational, defaultingTo: Algebraic) [by zero]",
			rootTwo::divide(by 0/1, defaultingTo rootTwo),
		)
		show(
			"Algebraic.divide(by: Algebraic, defaultingTo: Rational | Algebraic)",
			rootTwo::divide(by rootTwo, defaultingTo 0/1),
		)
		show(
			"Algebraic.divide(by: Algebraic, defaultingTo: Rational | Algebraic) [differing radicals]",
			rootTwo::divide(by rootThree, defaultingTo 0/1),
		)
		show("Algebraic.raise(to: Integer)", rootTwo::raise(to 3))
		show(
			"Algebraic.raise(to: Integer) [collapses to a Rational]",
			rootTwo::raise(to computedTwo),
		)
		show(
			"Algebraic.raise(to: Integer) [zero exponent]",
			rootTwo::raise(to 0),
		)
		show(
			"Algebraic.raise(to: Integer) [negative exponent]",
			rootTwo::raise(to -2),
		)
		show("Algebraic.isPositive()", rootTwo::isPositive())
		show(
			"Algebraic.isPositive() [negative]",
			rootTwo::negate()::isPositive(),
		)
		show("Algebraic.isNegative()", rootTwo::negate()::isNegative())
		show("Algebraic.isNegative() [positive]", rootTwo::isNegative())
		show("Algebraic.isZero()", rootTwo::isZero())
		show("Algebraic.isWholeNumber()", rootTwo::isWholeNumber())
		show("Algebraic.absolute()", rootTwo::absolute())
		show("Algebraic.absolute() [negative]", rootTwo::negate()::absolute())
		show("Algebraic.negate()", rootTwo::negate())
		show("Algebraic.toString()", rootTwo::toString())
		show(
			"Algebraic.toString(as: NumberFormat)",
			rootTwo::toString(as #Decimal),
		)
		show(
			"Algebraic.toString(as: NumberFormat) [fraction is the symbolic form]",
			rootTwo::toString(as #Fraction),
		)
		show(
			"Algebraic.toString(as: NumberFormat) [percent]",
			rootTwo::toString(as #Percent),
		)
		show(
			"Algebraic.toString(as: NumberFormat) [scientific]",
			rootTwo::toString(as #Scientific),
		)
		show(
			"Algebraic.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding)",
			rootTwo::toString(as #Decimal, toPlaces 4),
		)
		show(
			"Algebraic.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [padded with zeroes]",
			rootTwo::subtract(14142/10000)::toString(as #Decimal, toPlaces 3),
		)
		show(
			"Algebraic.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [a count below one]",
			rootTwo::toString(as #Decimal, toPlaces 0),
		)
		show(
			"Algebraic.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [fraction ignores the count]",
			rootTwo::toString(as #Fraction, toPlaces 4),
		)
		show(
			"Algebraic.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [percent]",
			rootTwo::toString(as #Percent, toPlaces 2),
		)
		show(
			"Algebraic.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [scientific]",
			rootTwo::toString(as #Scientific, toPlaces 4),
		)
		show(
			"Algebraic.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [scientific, below the eightieth place]",
			rootTwo
				::divide(by 10::raise(to 90))
				::toString(as #Scientific, toPlaces 4),
		)
		show(
			"Algebraic.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [up]",
			rootTwo::toString(as #Decimal, toPlaces 4, toward #Up),
		)
		show(
			"Algebraic.approximate(toPlaces: NonNegativeInteger, toward?: Rounding)",
			rootTwo::approximate(toPlaces 6),
		)
		show(
			"Algebraic.approximate(toPlaces: NonNegativeInteger, toward?: Rounding) [no places]",
			rootTwo::approximate(toPlaces 0),
		)
		show(
			"Algebraic.approximate(toPlaces: NonNegativeInteger, toward?: Rounding) [down]",
			rootTwo::approximate(toPlaces 3, toward #Down),
		)
		show(
			"Algebraic.approximate(toPlaces: NonNegativeInteger, toward?: Rounding) [negative, toward zero]",
			rootTwo::negate()::approximate(toPlaces 3, toward #TowardZero),
		)
		show("Algebraic.round(toward?: Rounding)", rootTwo::round())
		show(
			"Algebraic.round(toward?: Rounding) [up]",
			rootTwo::round(toward #Up),
		)
		show(
			"Algebraic.round(toward?: Rounding) [negative down]",
			rootTwo::negate()::round(toward #Down),
		)
		show(
			"Algebraic.round(toward?: Rounding) [nearest even reads as nearest]",
			rootTwo::round(toward #NearestEven),
		)
		show(
			"Algebraic.round(toPlaces: Integer, toward?: Rounding)",
			rootTwo::round(toPlaces 4),
		)
		show(
			"Algebraic.round(toPlaces: Integer, toward?: Rounding) [a count below one]",
			rootTwo::round(toPlaces -1),
		)
		show("Algebraic.decimalExponent()", rootTwo::decimalExponent())
		show(
			"Algebraic.decimalExponent() [below one]",
			rootTwo::divide(by 1000)::decimalExponent(),
		)
		<- {}
	})

	§ ——— Transcendental ———————————————————————————————————————————————————
	show("Transcendental.is(_ Transcendental)", Number.Pi::is(Number.Pi))
	show(
		"Transcendental.is(_ Transcendental) [differing]",
		Number.Pi::is(Number.Tau),
	)
	show("Transcendental.isNot(_ Transcendental)", Number.Pi::isNot(Number.Tau))
	show(
		"Transcendental.isNot(_ Transcendental) [equal]",
		Number.Pi::isNot(Number.Pi),
	)
	show(
		"Transcendental.compare(to: Transcendental, withPrecision: PositiveInteger)",
		Number.Pi::compare(to Number.E, withPrecision 1),
	)
	show(
		"Transcendental.compare(to: Transcendental, withPrecision: PositiveInteger) [not told apart]",
		Number.Pi::compare(
			to Number.E::multiply(with 1156/1000),
			withPrecision 2,
		),
	)
	show(
		"Transcendental.compare(to: Transcendental, withPrecision: PositiveInteger) [terms cancel]",
		Number.Pi::compare(to Number.Pi::add(1), withPrecision 1),
	)
	show("Transcendental.add(_ Integer)", Number.Pi::add(1))
	show("Transcendental.add(_ Rational)", Number.Pi::add(1/2))
	show("Transcendental.add(_ Transcendental)", Number.Pi::add(Number.Pi))
	show("Transcendental.subtract(_ Integer)", Number.Pi::subtract(1))
	show("Transcendental.subtract(_ Rational)", Number.Pi::subtract(1/2))
	show(
		"Transcendental.subtract(_ Transcendental) [collapses to Rational]",
		Number.Pi::subtract(Number.Pi),
	)
	show(
		"Transcendental.subtract(_ Transcendental) [stays Transcendental]",
		Number.Tau::subtract(Number.Pi),
	)
	§ The same split as the Algebraic block above: a computed factor or
	§ divisor reaches the entry answering a Union or an Optional, and one
	§ written where it stands proves itself and reaches the total entry.
	show(
		"Transcendental.multiply(with: Integer)",
		Number.Pi::multiply(with computedTwo),
	)
	show(
		"Transcendental.multiply(with: Integer) [by zero]",
		Number.Pi::multiply(with 0),
	)
	show(
		"Transcendental.multiply(with: Rational)",
		Number.Pi::multiply(with computedHalf),
	)
	show(
		"Transcendental.multiply(with: NonZeroInteger)",
		Number.Pi::multiply(with 2),
	)
	show(
		"Transcendental.multiply(with: NonZeroRational)",
		Number.Pi::multiply(with 1/2),
	)
	show(
		"Transcendental.divide(by: Integer)",
		Number.Pi::divide(by computedTwo),
	)
	show(
		"Transcendental.divide(by: Integer) [by zero]",
		Number.Pi::divide(by 0),
	)
	show(
		"Transcendental.divide(by: Rational)",
		Number.Pi::divide(by computedHalf),
	)
	show(
		"Transcendental.divide(by: Rational) [by zero]",
		Number.Pi::divide(by 0/1),
	)
	show(
		"Transcendental.divide(by: Transcendental) [proportional]",
		Number.Tau::divide(by Number.Pi),
	)
	show(
		"Transcendental.divide(by: Transcendental) [π by e]",
		Number.Pi::divide(by Number.E),
	)
	show("Transcendental.divide(by: NonZeroInteger)", Number.Pi::divide(by 2))
	show(
		"Transcendental.divide(by: NonZeroRational)",
		Number.Pi::divide(by 1/2),
	)
	show(
		"Transcendental.divide(by: Integer, defaultingTo: Transcendental)",
		Number.Pi::divide(by computedTwo, defaultingTo Number.E),
	)
	show(
		"Transcendental.divide(by: Integer, defaultingTo: Transcendental) [by zero]",
		Number.Pi::divide(by 0, defaultingTo Number.E),
	)
	show(
		"Transcendental.divide(by: Rational, defaultingTo: Transcendental)",
		Number.Pi::divide(by computedHalf, defaultingTo Number.E),
	)
	show(
		"Transcendental.divide(by: Rational, defaultingTo: Transcendental) [by zero]",
		Number.Pi::divide(by 0/1, defaultingTo Number.E),
	)
	show(
		"Transcendental.divide(by: Transcendental, defaultingTo: Rational)",
		Number.Tau::divide(by Number.Pi, defaultingTo 0/1),
	)
	show(
		"Transcendental.divide(by: Transcendental, defaultingTo: Rational) [π by e]",
		Number.Pi::divide(by Number.E, defaultingTo 0/1),
	)
	show(
		"Transcendental.add(_ Transcendental) [mixed bases]",
		Number.Pi::add(Number.E),
	)
	show(
		"Transcendental.subtract(_ Transcendental) [e parts cancel]",
		Number.Pi::add(Number.E)::subtract(Number.E),
	)
	show("Transcendental.isPositive()", Number.Pi::isPositive())
	show(
		"Transcendental.isPositive() [negative]",
		Number.Pi::negate()::isPositive(),
	)
	show(
		"Transcendental.isPositive() [both bases]",
		Number.Pi::add(Number.E)::isPositive(),
	)
	show("Transcendental.isNegative()", Number.Pi::negate()::isNegative())
	show("Transcendental.isNegative() [positive]", Number.Pi::isNegative())
	show("Transcendental.isZero()", Number.Pi::isZero())
	show("Transcendental.isWholeNumber()", Number.Pi::isWholeNumber())
	show("Transcendental.absolute()", Number.Pi::absolute())
	show(
		"Transcendental.absolute() [negative]",
		Number.Pi::negate()::absolute(),
	)
	show("Transcendental.negate()", Number.Pi::negate())
	show("Transcendental.toString()", Number.Pi::toString())
	show(
		"Transcendental.toString(as: NumberFormat)",
		Number.Pi::toString(as #Decimal),
	)
	show(
		"Transcendental.toString(as: NumberFormat) [fraction is the symbolic form]",
		Number.Pi::toString(as #Fraction),
	)
	show(
		"Transcendental.toString(as: NumberFormat) [percent]",
		Number.Pi::toString(as #Percent),
	)
	show(
		"Transcendental.toString(as: NumberFormat) [scientific]",
		Number.Pi::toString(as #Scientific),
	)
	show(
		"Transcendental.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding)",
		Number.Pi::toString(as #Decimal, toPlaces 4),
	)
	show(
		"Transcendental.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [negative]",
		Number.Pi::negate()::toString(as #Decimal, toPlaces 2),
	)
	show(
		"Transcendental.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [a count below one]",
		Number.E::toString(as #Decimal, toPlaces 0),
	)
	show(
		"Transcendental.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [fraction ignores the count]",
		Number.Pi::toString(as #Fraction, toPlaces 4),
	)
	show(
		"Transcendental.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [percent]",
		Number.Pi::toString(as #Percent, toPlaces 2),
	)
	show(
		"Transcendental.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [scientific]",
		Number.Pi::toString(as #Scientific, toPlaces 4),
	)
	show(
		"Transcendental.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [scientific, below the eightieth place]",
		Number.Pi
			::divide(by 10::raise(to 90))
			::toString(as #Scientific, toPlaces 4),
	)
	show(
		"Transcendental.toString(as: NumberFormat, toPlaces: Integer, toward?: Rounding) [down]",
		Number.Pi::toString(as #Decimal, toPlaces 4, toward #Down),
	)
	show(
		"Transcendental.approximate(toPlaces: NonNegativeInteger, toward?: Rounding)",
		Number.Pi::approximate(toPlaces 5),
	)
	show(
		"Transcendental.approximate(toPlaces: NonNegativeInteger, toward?: Rounding) [no places]",
		Number.E::approximate(toPlaces 0),
	)
	show(
		"Transcendental.approximate(toPlaces: NonNegativeInteger, toward?: Rounding) [up]",
		Number.Pi::approximate(toPlaces 3, toward #Up),
	)
	§ A value over both bases is a Union, since the π and e parts can cancel.
	§ The match is what hands the Transcendental arm to `approximate`.
	show(
		"Transcendental.approximate(toPlaces: NonNegativeInteger, toward?: Rounding) [both bases]",
		match Number.Pi::add(Number.E) -> Rational {
			case Rational       { <- @ }
			case Transcendental { <- @::approximate(toPlaces 6) }
		},
	)
	show("Transcendental.round(toward?: Rounding)", Number.Pi::round())
	show(
		"Transcendental.round(toward?: Rounding) [down]",
		Number.E::round(toward #Down),
	)
	show(
		"Transcendental.round(toward?: Rounding) [negative toward zero]",
		Number.Pi::negate()::round(toward #TowardZero),
	)
	show(
		"Transcendental.round(toPlaces: Integer, toward?: Rounding)",
		Number.Pi::round(toPlaces 2),
	)
	show(
		"Transcendental.round(toPlaces: Integer, toward?: Rounding) [a count below one]",
		Number.Pi::round(toPlaces 0),
	)
	show("Transcendental.decimalExponent()", Number.Pi::decimalExponent())
	show(
		"Transcendental.decimalExponent() [below one]",
		Number.Pi::divide(by 1000)::decimalExponent(),
	)

	§ ——— Number ———————————————————————————————————————————————————————————
	§ Reached through the Namespace spelling throughout, because the `::`
	§ spelling only lands here when no narrower Namespace matches — every
	§ Method below shares its name with one on Integer or Rational.
	show("Number.Pi", Number.Pi)
	show("Number.Tau", Number.Tau)
	show("Number.E", Number.E)
	show("Number.GoldenRatio", Number.GoldenRatio)

	withRootTwo((_ rootTwo: Algebraic) -> {} {
		show("Number.is(_ Number) [Integer]", Number.is(2, 2/1))
		show("Number.is(_ Number) [Rational]", Number.is(1/2, 1))
		show("Number.is(_ Number) [Algebraic]", Number.is(rootTwo, 2))
		show(
			"Number.is(_ Number) [Transcendental]",
			Number.is(Number.Pi::multiply(with 2), Number.Tau),
		)
		show("Number.isNot(_ Number) [Integer]", asNumber(2)::isNot(2/1))
		show("Number.isNot(_ Number) [Rational]", asNumber(1/2)::isNot(1))
		show("Number.isNot(_ Number) [Algebraic]", asNumber(rootTwo)::isNot(2))
		show(
			"Number.isNot(_ Number) [Transcendental]",
			asNumber(Number.Pi)::isNot(Number.Tau),
		)
		show("Number.toString() [Integer]", Number.toString(42))
		show("Number.toString() [Rational]", Number.toString(3/4))
		show("Number.toString() [Algebraic]", Number.toString(rootTwo))
		show("Number.toString() [Transcendental]", Number.toString(Number.Pi))
		show(
			"Number.compare(to: Number) [Integer]",
			Number.compare(3, to Number.Pi),
		)
		show(
			"Number.compare(to: Number) [Rational]",
			Number.compare(22/7, to Number.Pi),
		)
		show(
			"Number.compare(to: Number) [Algebraic]",
			Number.compare(rootTwo, to 3/2),
		)
		show(
			"Number.compare(to: Number) [Transcendental]",
			Number.compare(Number.Pi, to Number.Tau),
		)
		§ The four inequalities are `Comparable`'s provided Methods, and
		§ `isBetween` and `clamp` are `Orderable`'s. Every conformer has a rung
		§ of its own. These
		§ lines exercise the covering `Number`'s rung. That is what `asNumber`
		§ reaches: a bare receiver would be asked of its own kind's rung first.
		show(
			"Number.isLessThan(_ Number) [Integer]",
			asNumber(3)::isLessThan(Number.Pi),
		)
		show(
			"Number.isLessThan(_ Number) [Rational]",
			asNumber(22/7)::isLessThan(Number.Pi),
		)
		show(
			"Number.isLessThan(_ Number) [Algebraic]",
			asNumber(rootTwo)::isLessThan(3/2),
		)
		show(
			"Number.isLessThan(_ Number) [Transcendental]",
			asNumber(Number.Pi)::isLessThan(Number.Tau),
		)
		show(
			"Number.isLessThanOrEqualTo(_ Number) [Integer]",
			asNumber(4)::isLessThanOrEqualTo(Number.Pi),
		)
		show(
			"Number.isLessThanOrEqualTo(_ Number) [Rational]",
			asNumber(22/7)::isLessThanOrEqualTo(Number.Pi),
		)
		show(
			"Number.isLessThanOrEqualTo(_ Number) [Algebraic]",
			asNumber(rootTwo)::isLessThanOrEqualTo(rootTwo),
		)
		show(
			"Number.isLessThanOrEqualTo(_ Number) [Transcendental]",
			asNumber(Number.Pi)::isLessThanOrEqualTo(Number.Pi),
		)
		show(
			"Number.isGreaterThan(_ Number) [Integer]",
			asNumber(4)::isGreaterThan(Number.Pi),
		)
		show(
			"Number.isGreaterThan(_ Number) [Rational]",
			asNumber(22/7)::isGreaterThan(Number.Pi),
		)
		show(
			"Number.isGreaterThan(_ Number) [Algebraic]",
			asNumber(rootTwo)::isGreaterThan(3/2),
		)
		show(
			"Number.isGreaterThan(_ Number) [Transcendental]",
			asNumber(Number.Tau)::isGreaterThan(Number.Pi),
		)
		show(
			"Number.isGreaterThanOrEqualTo(_ Number) [Integer]",
			asNumber(3)::isGreaterThanOrEqualTo(Number.Pi),
		)
		show(
			"Number.isGreaterThanOrEqualTo(_ Number) [Rational]",
			asNumber(22/7)::isGreaterThanOrEqualTo(Number.Pi),
		)
		show(
			"Number.isGreaterThanOrEqualTo(_ Number) [Algebraic]",
			asNumber(rootTwo)::isGreaterThanOrEqualTo(rootTwo),
		)
		show(
			"Number.isGreaterThanOrEqualTo(_ Number) [Transcendental]",
			asNumber(Number.Tau)::isGreaterThanOrEqualTo(Number.Pi),
		)
		show(
			"Number.isBetween(_ Number, and: Number) [Integer]",
			asNumber(5)::isBetween(1, and 10),
		)
		show(
			"Number.isBetween(_ Number, and: Number) [Rational]",
			asNumber(22/7)::isBetween(3, and 4),
		)
		show(
			"Number.isBetween(_ Number, and: Number) [Algebraic]",
			asNumber(rootTwo)::isBetween(1, and 2),
		)
		show(
			"Number.isBetween(_ Number, and: Number) [Transcendental]",
			asNumber(Number.Pi)::isBetween(3, and 22/7),
		)
		show(
			"Number.isBetween(_ Number, and: Number) [outside]",
			asNumber(Number.Pi)::isBetween(22/7, and 4),
		)
		show(
			"Number.isBetween(_ Number, and: Number) [on the bound]",
			asNumber(5)::isBetween(5, and 5),
		)
		show(
			"Number.isBetween(_ Number, and: Number) [inverted bounds]",
			asNumber(Number.Pi)::isBetween(22/7, and 3),
		)
		show(
			"Number.clamp(between: Number, and: Number) [above]",
			asNumber(Number.Pi)::clamp(between 1, and 3),
		)
		show(
			"Number.clamp(between: Number, and: Number) [below]",
			asNumber(rootTwo)::clamp(between 22/7, and 4),
		)
		show(
			"Number.clamp(between: Number, and: Number) [within]",
			asNumber(22/7)::clamp(between 3, and 4),
		)
		show(
			"Number.clamp(between: Number, and: Number) [inverted bounds]",
			asNumber(22/7)::clamp(between 4, and 3),
		)
		<- {}
	})

	§ The Lists the three aggregates below fold, each bound to a `List` Type.
	§ A written List is its own proof of having an item, as an Argument and as
	§ a RECEIVER both, so a literal reaches the entry taking a `NonEmptyList` —
	§ which is what the calls naming that Type do, with a literal each. These
	§ bound names are what keeps the `List` entries called.
	constant twoFruits: List<String>      = ["banana", "apple"]
	constant twoNumbers: List<Integer>    = [1, 2]
	constant threeNumbers: List<Integer>  = [3, 1, 2]
	constant twoRationals: List<Rational> = [1/2, 1/3]
	constant twoMixedNumbers: List<Integer | Rational> = [1, 1/2]

	show("Number.sum(_ List<Integer>)", Number.sum([1, 2, 3]))
	show("Number.sum(_ List<Integer>) [empty]", Number.sum(noNumbers))
	show("Number.sum(_ List<Rational>)", Number.sum([1/2, 1/3]))
	show("Number.sum(_ List<Rational>) [empty]", Number.sum(noRationals))
	show("Number.sum(_ List<Scalar>)", Number.sum([1, 1/2, 1/2]))
	show("Number.sum(_ List<Scalar>) [empty]", Number.sum(noMixedNumbers))
	show("Number.product(_ List<Integer>)", Number.product([2, 3, 4]))
	show("Number.product(_ List<Integer>) [empty]", Number.product(noNumbers))
	show("Number.product(_ List<Rational>)", Number.product([1/2, 2/3]))
	show(
		"Number.product(_ List<Rational>) [empty]",
		Number.product(noRationals),
	)
	show("Number.product(_ List<Scalar>)", Number.product([2, 1/2, 3]))
	show(
		"Number.product(_ List<Scalar>) [empty]",
		Number.product(noMixedNumbers),
	)
	show("Number.average(_ List<Integer>)", Number.average(twoNumbers))
	show("Number.average(_ List<Integer>) [empty]", Number.average(noNumbers))
	show("Number.average(_ List<Rational>)", Number.average(twoRationals))
	show(
		"Number.average(_ List<Rational>) [empty]",
		Number.average(noRationals),
	)
	show("Number.average(_ List<Scalar>)", Number.average(twoMixedNumbers))
	show(
		"Number.average(_ List<Scalar>) [empty]",
		Number.average(noMixedNumbers),
	)
	show(
		"Number.average(_ List<Integer>, defaultingTo: Rational)",
		Number.average(twoNumbers, defaultingTo 0/1),
	)
	show(
		"Number.average(_ List<Integer>, defaultingTo: Rational) [empty]",
		Number.average(noNumbers, defaultingTo 0/1),
	)
	show(
		"Number.average(_ List<Rational>, defaultingTo: Rational)",
		Number.average(twoRationals, defaultingTo 0/1),
	)
	show(
		"Number.average(_ List<Rational>, defaultingTo: Rational) [empty]",
		Number.average(noRationals, defaultingTo 0/1),
	)
	show(
		"Number.average(_ List<Scalar>, defaultingTo: Rational)",
		Number.average(twoMixedNumbers, defaultingTo 0/1),
	)
	show(
		"Number.average(_ List<Scalar>, defaultingTo: Rational) [empty]",
		Number.average(noMixedNumbers, defaultingTo 0/1),
	)
	§ The same Lists written where they stand, which is the proof these entries
	§ ask for. Each answers the mean itself where the twin above it answers an
	§ Optional.
	show("Number.average(_ NonEmptyList<Integer>)", Number.average([1, 2]))
	show("Number.average(_ NonEmptyList<Rational>)", Number.average([1/2, 1/3]))
	show("Number.average(_ NonEmptyList<Scalar>)", Number.average([1, 1/2]))
	show("Number.lowest(_ Integer, _ Integer)", Number.lowest(3, 2))
	show("Number.lowest(_ Rational, _ Rational)", Number.lowest(1/2, 1/3))
	show("Number.lowest(_ Integer, _ Rational)", Number.lowest(1, 2/3))
	show("Number.lowest(_ Rational, _ Integer)", Number.lowest(2/3, 1))
	show("Number.lowest(_ List<Integer>)", Number.lowest(threeNumbers))
	show("Number.lowest(_ List<Integer>) [empty]", Number.lowest(noNumbers))
	show("Number.lowest(_ List<Rational>)", Number.lowest(twoRationals))
	show("Number.lowest(_ List<Rational>) [empty]", Number.lowest(noRationals))
	show("Number.lowest(_ List<Scalar>)", Number.lowest(twoMixedNumbers))
	show("Number.lowest(_ List<Scalar>) [empty]", Number.lowest(noMixedNumbers))
	show(
		"Number.lowest(_ List<Integer>, defaultingTo: Integer)",
		Number.lowest(threeNumbers, defaultingTo 0),
	)
	show(
		"Number.lowest(_ List<Integer>, defaultingTo: Integer) [empty]",
		Number.lowest(noNumbers, defaultingTo 0),
	)
	show(
		"Number.lowest(_ List<Rational>, defaultingTo: Rational)",
		Number.lowest(twoRationals, defaultingTo 0/1),
	)
	show(
		"Number.lowest(_ List<Rational>, defaultingTo: Rational) [empty]",
		Number.lowest(noRationals, defaultingTo 0/1),
	)
	show(
		"Number.lowest(_ List<Scalar>, defaultingTo: Scalar)",
		Number.lowest(twoMixedNumbers, defaultingTo 0),
	)
	show(
		"Number.lowest(_ List<Scalar>, defaultingTo: Scalar) [empty]",
		Number.lowest(noMixedNumbers, defaultingTo 0),
	)
	show("Number.lowest(_ NonEmptyList<Integer>)", Number.lowest([3, 1, 2]))
	§ One item, which is the seed the fold starts from and the answer it ends
	§ with.
	show("Number.lowest(_ NonEmptyList<Integer>) [single]", Number.lowest([7]))
	show("Number.lowest(_ NonEmptyList<Rational>)", Number.lowest([1/2, 1/3]))
	show("Number.lowest(_ NonEmptyList<Scalar>)", Number.lowest([1, 1/2]))
	§ The widest entry, which is the only one an irrational reaches.
	show("Number.lowest(_ Number, _ Number)", Number.lowest(3, Number.Pi))
	show(
		"Number.lowest(_ Number, _ Number) [second is lower]",
		Number.lowest(Number.Pi, 3),
	)
	show("Number.highest(_ Integer, _ Integer)", Number.highest(3, 2))
	show("Number.highest(_ Rational, _ Rational)", Number.highest(1/2, 1/3))
	show("Number.highest(_ Integer, _ Rational)", Number.highest(1, 2/3))
	show("Number.highest(_ Rational, _ Integer)", Number.highest(2/3, 1))
	show("Number.highest(_ List<Integer>)", Number.highest(threeNumbers))
	show("Number.highest(_ List<Integer>) [empty]", Number.highest(noNumbers))
	show("Number.highest(_ List<Rational>)", Number.highest(twoRationals))
	show(
		"Number.highest(_ List<Rational>) [empty]",
		Number.highest(noRationals),
	)
	show("Number.highest(_ List<Scalar>)", Number.highest(twoMixedNumbers))
	show(
		"Number.highest(_ List<Scalar>) [empty]",
		Number.highest(noMixedNumbers),
	)
	show(
		"Number.highest(_ List<Integer>, defaultingTo: Integer)",
		Number.highest(threeNumbers, defaultingTo 0),
	)
	show(
		"Number.highest(_ List<Integer>, defaultingTo: Integer) [empty]",
		Number.highest(noNumbers, defaultingTo 0),
	)
	show(
		"Number.highest(_ List<Rational>, defaultingTo: Rational)",
		Number.highest(twoRationals, defaultingTo 0/1),
	)
	show(
		"Number.highest(_ List<Rational>, defaultingTo: Rational) [empty]",
		Number.highest(noRationals, defaultingTo 0/1),
	)
	show(
		"Number.highest(_ List<Scalar>, defaultingTo: Scalar)",
		Number.highest(twoMixedNumbers, defaultingTo 0),
	)
	show(
		"Number.highest(_ List<Scalar>, defaultingTo: Scalar) [empty]",
		Number.highest(noMixedNumbers, defaultingTo 0),
	)
	show("Number.highest(_ NonEmptyList<Integer>)", Number.highest([3, 1, 2]))
	show("Number.highest(_ NonEmptyList<Rational>)", Number.highest([1/2, 1/3]))
	show("Number.highest(_ NonEmptyList<Scalar>)", Number.highest([1, 1/2]))
	§ The widest entry, which is the only one an irrational reaches.
	show("Number.highest(_ Number, _ Number)", Number.highest(3, Number.Pi))
	show(
		"Number.highest(_ Number, _ Number) [first is higher]",
		Number.highest(Number.Pi, 3),
	)

	§ Reading a number back. The Integer form is tried first, so a whole
	§ number answers an Integer rather than the Rational over one that
	§ `Rational.parse` answers alone.
	show("Number.parse(_ String)", Number.parse("5"))
	show("Number.parse(_ String) [fraction]", Number.parse("3/4"))
	show("Number.parse(_ String) [decimal]", Number.parse("0.75"))
	show("Number.parse(_ String) [not a number]", Number.parse("nope"))
	show(
		"Number.parse(_ String, defaultingTo: Scalar)",
		Number.parse("3/4", defaultingTo 0),
	)
	show(
		"Number.parse(_ String, defaultingTo: Scalar) [not a number]",
		Number.parse("nope", defaultingTo 0),
	)

	§ ——— Optional —————————————————————————————————————————————————————————
	show(
		"Optional.toString<ItemType is Printable>()",
		numbers::firstItem()::toString(),
	)
	show(
		"Optional.toString<ItemType is Printable>() [empty]",
		noNumbers::firstItem()::toString(),
	)
	§ A String payload is QUOTED, because a rendering inside a structure has
	§ to be told from the text around it: without the quotes `#Value("Empty")`
	§ and `#Empty` read alike, and `#Value("")` reads as a pair of empty
	§ parentheses.
	show(
		"Optional.toString<ItemType is Printable>() [String payload]",
		greeting::characters()::firstItem()::toString(),
	)
	show(
		"Optional.value<ItemType>(defaultingTo: ItemType) [present]",
		numbers::firstItem()::value(defaultingTo 0),
	)
	show(
		"Optional.value<ItemType>(defaultingTo: ItemType) [empty]",
		noNumbers::firstItem()::value(defaultingTo 42),
	)
	show("Optional.hasValue<ItemType>()", numbers::firstItem()::hasValue())
	show(
		"Optional.hasValue<ItemType>() [empty]",
		noNumbers::firstItem()::hasValue(),
	)
	§ The quantified entry, beside the bare one: an empty Optional answers
	§ `false` without the check running.
	show(
		"Optional.hasValue<ItemType>(where: (_ ItemType) -> Boolean)",
		numbers::firstItem()::hasValue(where (item) { <- item::isOdd() }),
	)
	show(
		"Optional.hasValue<ItemType>(where: (_ ItemType) -> Boolean) [rejected]",
		numbers::firstItem()::hasValue(where (item) { <- item::isEven() }),
	)
	show(
		"Optional.hasValue<ItemType>(where: (_ ItemType) -> Boolean) [empty]",
		noNumbers::firstItem()::hasValue(where (item) { <- item::isOdd() }),
	)
	show("Optional.isEmpty<ItemType>()", noNumbers::firstItem()::isEmpty())
	show(
		"Optional.isEmpty<ItemType>() [present]",
		numbers::firstItem()::isEmpty(),
	)
	show(
		"Optional.map<ItemType, Other>(_ (_ ItemType) -> Other)",
		numbers::firstItem()::map((item) { <- item::multiply(with 10) }),
	)
	show(
		"Optional.map<ItemType, Other>(_ (_ ItemType) -> Other) [empty]",
		noNumbers::firstItem()::map((item) { <- item::multiply(with 10) }),
	)
	show(
		"Optional.andThen<ItemType, Other>(_ (_ ItemType) -> Optional<Other>)",
		numbers::firstItem()::andThen((item) { <- numbers::item(at item) }),
	)
	show(
		"Optional.andThen<ItemType, Other>(_ (_ ItemType) -> Optional<Other>) [empty]",
		noNumbers::firstItem()::andThen((item) { <- numbers::item(at item) }),
	)
	show(
		"Optional.keep<ItemType>(where: (_ ItemType) -> Boolean)",
		numbers::firstItem()::keep(where (item) { <- item::isPositive() }),
	)
	show(
		"Optional.keep<ItemType>(where: (_ ItemType) -> Boolean) [rejected]",
		numbers::firstItem()::keep(where (item) { <- item::isNegative() }),
	)
	show(
		"Optional.or<ItemType>(_ Optional<ItemType>)",
		numbers::firstItem()::or(noNumbers::firstItem()),
	)
	show(
		"Optional.or<ItemType>(_ Optional<ItemType>) [empty receiver]",
		noNumbers::firstItem()::or(numbers::firstItem()),
	)
	show(
		"Optional.or<ItemType>(_ Optional<ItemType>) [both empty]",
		noNumbers::firstItem()::or(noNumbers::firstItem()),
	)
	show(
		"Optional.pair<ItemType, Other>(with: Optional<Other>)",
		numbers::firstItem()::pair(with greeting::characters()::firstItem()),
	)
	show(
		"Optional.pair<ItemType, Other>(with: Optional<Other>) [empty receiver]",
		noNumbers::firstItem()::pair(with numbers::firstItem()),
	)
	show(
		"Optional.pair<ItemType, Other>(with: Optional<Other>) [empty argument]",
		numbers::firstItem()::pair(with noNumbers::firstItem()),
	)
	show("Optional.toList<ItemType>()", numbers::firstItem()::toList())
	show(
		"Optional.toList<ItemType>() [empty]",
		noNumbers::firstItem()::toList(),
	)
	§ The bridge to the carrier that carries a reason. The reason is read
	§ whether or not the Optional needed one.
	show(
		"Optional.toResult<ItemType, FailureType>(failingWith: FailureType)",
		numbers::firstItem()::toResult(failingWith "no items"),
	)
	show(
		"Optional.toResult<ItemType, FailureType>(failingWith: FailureType) [empty]",
		noNumbers::firstItem()::toResult(failingWith "no items"),
	)

	§ Equality is written, in two shapes: against a whole Optional — same
	§ Case, then the payloads through their own `is` — and against a bare
	§ item, which an empty Optional never is.
	show(
		"Optional.is<ItemType is Equatable>(_ Optional<ItemType>)",
		numbers::firstItem()::is(#Value(3)),
	)
	show(
		"Optional.is<ItemType is Equatable>(_ Optional<ItemType>) [different payload]",
		numbers::firstItem()::is(#Value(1)),
	)
	show(
		"Optional.is<ItemType is Equatable>(_ Optional<ItemType>) [empty against value]",
		noNumbers::firstItem()::is(#Value(3)),
	)
	show(
		"Optional.is<ItemType is Equatable>(_ Optional<ItemType>) [both empty]",
		noNumbers::firstItem()::is(#Empty),
	)
	show(
		"Optional.isNot<ItemType is Equatable>(_ Optional<ItemType>)",
		numbers::firstItem()::isNot(#Value(2)),
	)
	show(
		"Optional.is<ItemType is Equatable>(_ ItemType)",
		numbers::firstItem()::is(3),
	)
	show(
		"Optional.is<ItemType is Equatable>(_ ItemType) [different item]",
		numbers::firstItem()::is(1),
	)
	show(
		"Optional.is<ItemType is Equatable>(_ ItemType) [empty]",
		noNumbers::firstItem()::is(3),
	)
	show(
		"Optional.isNot<ItemType is Equatable>(_ ItemType)",
		numbers::firstItem()::isNot(2),
	)
	show(
		"Optional.isNot<ItemType is Equatable>(_ ItemType) [empty]",
		noNumbers::firstItem()::isNot(3),
	)

	§ The nesting a Union-shaped Optional could not represent: the outer
	§ Optional says whether an item was found, the inner one what it holds.
	constant nestedOptionals: List<Optional<Integer>> = [#Empty, #Value(7)]

	show(
		"NestedOptional.flatten<ItemType>()",
		nestedOptionals::lastItem()::flatten(),
	)
	show(
		"NestedOptional.flatten<ItemType>() [outer empty]",
		nestedOptionals::item(at 9)::flatten(),
	)
	show(
		"NestedOptional.flatten<ItemType>() [inner empty]",
		nestedOptionals::firstItem()::flatten(),
	)

	§ ——— Result ———————————————————————————————————————————————————————————
	§ The sister of the Optional block above: the same carrier, with a reason
	§ where the Optional has nothing. Every receiver is declared, because a
	§ Case written where it stands says nothing about the Type of the other
	§ one.
	constant fine: Result<Integer, String>    = #Value(3)
	constant wrong: Result<Integer, String>   = #Failure("gone")
	constant fineText: Result<String, String> = #Value("a")

	show(
		"Result.toString<ValueType is Printable, FailureType is Printable>()",
		fine::toString(),
	)
	show(
		"Result.toString<ValueType is Printable, FailureType is Printable>() [failed]",
		wrong::toString(),
	)
	§ A String payload is QUOTED, for the reason an Optional's is: without the
	§ quotes a rendering inside a structure can not be told from the text
	§ around it.
	show(
		"Result.toString<ValueType is Printable, FailureType is Printable>() [String payload]",
		fineText::toString(),
	)
	show("Result.hasValue<ValueType, FailureType>()", fine::hasValue())
	show(
		"Result.hasValue<ValueType, FailureType>() [failed]",
		wrong::hasValue(),
	)
	§ The quantified entry, beside the bare one: a failed Result answers
	§ `false` without the check running.
	show(
		"Result.hasValue<ValueType, FailureType>(where: (_ ValueType) -> Boolean)",
		fine::hasValue(where (item) { <- item::isOdd() }),
	)
	show(
		"Result.hasValue<ValueType, FailureType>(where: (_ ValueType) -> Boolean) [rejected]",
		fine::hasValue(where (item) { <- item::isEven() }),
	)
	show(
		"Result.hasValue<ValueType, FailureType>(where: (_ ValueType) -> Boolean) [failed]",
		wrong::hasValue(where (item) { <- item::isOdd() }),
	)
	show("Result.hasFailed<ValueType, FailureType>()", wrong::hasFailed())
	show(
		"Result.hasFailed<ValueType, FailureType>() [present]",
		fine::hasFailed(),
	)
	show("Result.value<ValueType, FailureType>()", fine::value())
	show("Result.value<ValueType, FailureType>() [failed]", wrong::value())
	show(
		"Result.value<ValueType, FailureType>(defaultingTo: ValueType)",
		fine::value(defaultingTo 0),
	)
	show(
		"Result.value<ValueType, FailureType>(defaultingTo: ValueType) [failed]",
		wrong::value(defaultingTo 42),
	)
	show("Result.reason<ValueType, FailureType>()", wrong::reason())
	show("Result.reason<ValueType, FailureType>() [present]", fine::reason())
	show(
		"Result.map<ValueType, FailureType, Other>(_ (_ ValueType) -> Other)",
		fine::map((item) { <- item::multiply(with 10) }),
	)
	show(
		"Result.map<ValueType, FailureType, Other>(_ (_ ValueType) -> Other) [failed]",
		wrong::map((item) { <- item::multiply(with 10) }),
	)
	show(
		"Result.andThen<ValueType, FailureType, Other>(_ (_ ValueType) -> Result<Other, FailureType>)",
		fine::andThen((item) -> Result<Integer, String> {
			<- #Value(item::add(1))
		}),
	)
	show(
		"Result.andThen<ValueType, FailureType, Other>(_ (_ ValueType) -> Result<Other, FailureType>) [failed]",
		wrong::andThen((item) -> Result<Integer, String> {
			<- #Value(item::add(1))
		}),
	)
	show(
		"Result.mapFailure<ValueType, FailureType, Other>(_ (_ FailureType) -> Other)",
		wrong::mapFailure((reason) { <- reason::length() }),
	)
	show(
		"Result.mapFailure<ValueType, FailureType, Other>(_ (_ FailureType) -> Other) [present]",
		fine::mapFailure((reason) { <- reason::length() }),
	)
	show(
		"Result.recover<ValueType, FailureType>(with: (_ FailureType) -> ValueType)",
		wrong::recover(with (reason) { <- reason::length() }),
	)
	show(
		"Result.recover<ValueType, FailureType>(with: (_ FailureType) -> ValueType) [present]",
		fine::recover(with (reason) { <- reason::length() }),
	)
	show(
		"Result.keep<ValueType, FailureType>(where: (_ ValueType) -> Boolean, failingWith: FailureType)",
		fine::keep(where (item) { <- item::isOdd() }, failingWith "even"),
	)
	show(
		"Result.keep<ValueType, FailureType>(where: (_ ValueType) -> Boolean, failingWith: FailureType) [rejected]",
		fine::keep(where (item) { <- item::isEven() }, failingWith "odd"),
	)
	show(
		"Result.keep<ValueType, FailureType>(where: (_ ValueType) -> Boolean, failingWith: FailureType) [failed]",
		wrong::keep(where (item) { <- item::isOdd() }, failingWith "even"),
	)
	show(
		"Result.or<ValueType, FailureType>(_ Result<ValueType, FailureType>)",
		fine::or(wrong),
	)
	show(
		"Result.or<ValueType, FailureType>(_ Result<ValueType, FailureType>) [failed receiver]",
		wrong::or(fine),
	)
	show(
		"Result.or<ValueType, FailureType>(_ Result<ValueType, FailureType>) [both failed]",
		wrong::or(wrong),
	)
	show("Result.toList<ValueType, FailureType>()", fine::toList())
	show("Result.toList<ValueType, FailureType>() [failed]", wrong::toList())

	§ Equality is written, in two shapes: against a whole Result — same Case,
	§ then the payloads through their own `is` — and against a bare value,
	§ which a failed Result never is.
	show(
		"Result.is<ValueType is Equatable, FailureType is Equatable>(_ Result<ValueType, FailureType>)",
		fine::is(#Value(3)),
	)
	show(
		"Result.is<ValueType is Equatable, FailureType is Equatable>(_ Result<ValueType, FailureType>) [different payload]",
		fine::is(#Value(1)),
	)
	show(
		"Result.is<ValueType is Equatable, FailureType is Equatable>(_ Result<ValueType, FailureType>) [both failed]",
		wrong::is(#Failure("gone")),
	)
	show(
		"Result.is<ValueType is Equatable, FailureType is Equatable>(_ Result<ValueType, FailureType>) [value against failure]",
		fine::is(#Failure("gone")),
	)
	show(
		"Result.isNot<ValueType is Equatable, FailureType is Equatable>(_ Result<ValueType, FailureType>)",
		fine::isNot(#Failure("gone")),
	)
	show(
		"Result.is<FailureType is Equatable, ValueType is Equatable>(_ ValueType)",
		fine::is(3),
	)
	show(
		"Result.is<FailureType is Equatable, ValueType is Equatable>(_ ValueType) [different value]",
		fine::is(1),
	)
	show(
		"Result.is<FailureType is Equatable, ValueType is Equatable>(_ ValueType) [failed]",
		wrong::is(3),
	)
	show(
		"Result.isNot<FailureType is Equatable, ValueType is Equatable>(_ ValueType)",
		fine::isNot(2),
	)
	show(
		"Result.isNot<FailureType is Equatable, ValueType is Equatable>(_ ValueType) [failed]",
		wrong::isNot(3),
	)

	§ The two levels a Result of Results carries: the outer one says whether
	§ the step ran, and the inner one what it answered.
	constant nestedValue: Result<Result<Integer, String>, String>   = #Value(
		#Value(7)
	)
	constant nestedFailure: Result<Result<Integer, String>, String> = #Value(
		#Failure("inner")
	)
	constant outerFailure: Result<Result<Integer, String>, String>  = #Failure(
		"outer"
	)

	show(
		"NestedResult.flatten<ValueType, FailureType>()",
		nestedValue::flatten(),
	)
	show(
		"NestedResult.flatten<ValueType, FailureType>() [inner failed]",
		nestedFailure::flatten(),
	)
	show(
		"NestedResult.flatten<ValueType, FailureType>() [outer failed]",
		outerFailure::flatten(),
	)

	§ ——— Ordering —————————————————————————————————————————————————————————
	constant less: Ordering    = #Less
	constant equal: Ordering   = #Equal
	constant greater: Ordering = #Greater

	show("Choice_Equatable.is(_ Ordering) [Less]", less::is(#Less))
	show("Choice_Equatable.is(_ Ordering) [Equal]", equal::is(#Equal))
	show("Choice_Equatable.is(_ Ordering) [Greater]", greater::is(#Greater))
	show("Choice_Equatable.is(_ Ordering) [differing]", less::is(#Greater))
	show("Choice_Equatable.isNot(_ Ordering) [Less]", less::isNot(#Equal))
	show("Choice_Equatable.isNot(_ Ordering) [Equal]", equal::isNot(#Equal))
	show("Choice_Equatable.isNot(_ Ordering) [Greater]", greater::isNot(#Less))
	show("Choice_Printable.toString() [Ordering#Less]", less::toString())
	show("Choice_Printable.toString() [Ordering#Equal]", equal::toString())
	show("Choice_Printable.toString() [Ordering#Greater]", greater::toString())
	show("Ordering.then(_ Ordering)", equal::then(#Greater))
	show("Ordering.then(_ Ordering) [decided]", less::then(#Greater))
	show(
		"Ordering.then(computedBy: () -> Ordering)",
		equal::then(computedBy () -> Ordering { <- #Greater }),
	)
	show(
		"Ordering.then(computedBy: () -> Ordering) [decided]",
		greater::then(computedBy () -> Ordering { <- #Less }),
	)

	§ ——— Side —————————————————————————————————————————————————————————————
	constant atStart: Side    = #Start
	constant atEnd: Side      = #End
	constant atBothEnds: Side = #BothEnds

	show("Choice_Equatable.is(_ Side) [Start]", atStart::is(#Start))
	show("Choice_Equatable.is(_ Side) [End]", atEnd::is(#End))
	show("Choice_Equatable.is(_ Side) [BothEnds]", atBothEnds::is(#BothEnds))
	show("Choice_Equatable.is(_ Side) [differing]", atStart::is(#End))
	show("Choice_Equatable.isNot(_ Side) [differing]", atStart::isNot(#End))
	show("Choice_Equatable.isNot(_ Side) [same]", atStart::isNot(#Start))
	show("Choice_Printable.toString() [Side#Start]", atStart::toString())
	show("Choice_Printable.toString() [Side#End]", atEnd::toString())
	show("Choice_Printable.toString() [Side#BothEnds]", atBothEnds::toString())

	§ ——— CaseSensitivity ——————————————————————————————————————————————————
	constant sensitive: CaseSensitivity   = #Sensitive
	constant insensitive: CaseSensitivity = #Insensitive

	show(
		"Choice_Equatable.is(_ CaseSensitivity) [Sensitive]",
		sensitive::is(#Sensitive),
	)
	show(
		"Choice_Equatable.is(_ CaseSensitivity) [Insensitive]",
		insensitive::is(#Insensitive),
	)
	show(
		"Choice_Equatable.is(_ CaseSensitivity) [differing]",
		sensitive::is(#Insensitive),
	)
	show(
		"Choice_Equatable.isNot(_ CaseSensitivity) [differing]",
		sensitive::isNot(#Insensitive),
	)
	show(
		"Choice_Equatable.isNot(_ CaseSensitivity) [same]",
		sensitive::isNot(#Sensitive),
	)
	show(
		"Choice_Printable.toString() [CaseSensitivity#Sensitive]",
		sensitive::toString(),
	)
	show(
		"Choice_Printable.toString() [CaseSensitivity#Insensitive]",
		insensitive::toString(),
	)

	§ ——— NormalizationForm ————————————————————————————————————————————————
	constant composedCanonical: NormalizationForm   = #ComposedCanonical
	constant decomposedCanonical: NormalizationForm = #DecomposedCanonical

	show(
		"Choice_Equatable.is(_ NormalizationForm)",
		composedCanonical::is(#ComposedCanonical),
	)
	show(
		"Choice_Equatable.is(_ NormalizationForm) [differing]",
		composedCanonical::is(#DecomposedCanonical),
	)
	show(
		"Choice_Equatable.isNot(_ NormalizationForm)",
		composedCanonical::isNot(#DecomposedCanonical),
	)
	show(
		"Choice_Equatable.isNot(_ NormalizationForm) [same]",
		decomposedCanonical::isNot(#DecomposedCanonical),
	)
	show(
		"Choice_Printable.toString() [NormalizationForm#ComposedCanonical]",
		composedCanonical::toString(),
	)
	show(
		"Choice_Printable.toString() [NormalizationForm#DecomposedCanonical]",
		decomposedCanonical::toString(),
	)

	§ ——— NumberFormat ———————————————————————————————————————————————————————
	constant asFraction: NumberFormat   = #Fraction
	constant asDecimal: NumberFormat    = #Decimal
	constant asPercent: NumberFormat    = #Percent
	constant asScientific: NumberFormat = #Scientific

	show("Choice_Equatable.is(_ NumberFormat)", asFraction::is(#Fraction))
	show(
		"Choice_Equatable.is(_ NumberFormat) [differing]",
		asFraction::is(#Decimal),
	)
	show("Choice_Equatable.isNot(_ NumberFormat)", asFraction::isNot(#Decimal))
	show(
		"Choice_Equatable.isNot(_ NumberFormat) [same]",
		asDecimal::isNot(#Decimal),
	)
	show(
		"Choice_Printable.toString() [NumberFormat#Fraction]",
		asFraction::toString(),
	)
	show(
		"Choice_Printable.toString() [NumberFormat#Decimal]",
		asDecimal::toString(),
	)
	show(
		"Choice_Printable.toString() [NumberFormat#Percent]",
		asPercent::toString(),
	)
	show(
		"Choice_Printable.toString() [NumberFormat#Scientific]",
		asScientific::toString(),
	)

	§ ——— Rounding —————————————————————————————————————————————————————————
	constant toNearest: Rounding     = #Nearest
	constant toNearestEven: Rounding = #NearestEven
	constant toDown: Rounding        = #Down
	constant toUp: Rounding          = #Up
	constant toTowardZero: Rounding  = #TowardZero

	show("Choice_Equatable.is(_ Rounding)", toNearest::is(#Nearest))
	show("Choice_Equatable.is(_ Rounding) [differing]", toNearest::is(#Down))
	show("Choice_Equatable.isNot(_ Rounding)", toNearest::isNot(#Down))
	show("Choice_Equatable.isNot(_ Rounding) [same]", toDown::isNot(#Down))
	show(
		"Choice_Printable.toString() [Rounding#Nearest]",
		toNearest::toString(),
	)
	show("Choice_Printable.toString() [Rounding#Down]", toDown::toString())
	show("Choice_Printable.toString() [Rounding#Up]", toUp::toString())
	show(
		"Choice_Printable.toString() [Rounding#TowardZero]",
		toTowardZero::toString(),
	)
	show(
		"Choice_Printable.toString() [Rounding#NearestEven]",
		toNearestEven::toString(),
	)

	§ ——— SignStyle ————————————————————————————————————————————————————————
	constant onlyNegative: SignStyle = #Negative
	constant alwaysSigned: SignStyle = #Always

	show("Choice_Equatable.is(_ SignStyle)", onlyNegative::is(#Negative))
	show(
		"Choice_Equatable.is(_ SignStyle) [differing]",
		onlyNegative::is(#Always),
	)
	show("Choice_Equatable.isNot(_ SignStyle)", onlyNegative::isNot(#Always))
	show(
		"Choice_Equatable.isNot(_ SignStyle) [same]",
		alwaysSigned::isNot(#Always),
	)
	show(
		"Choice_Printable.toString() [SignStyle#Negative]",
		onlyNegative::toString(),
	)
	show(
		"Choice_Printable.toString() [SignStyle#Always]",
		alwaysSigned::toString(),
	)

	§ ——— Division —————————————————————————————————————————————————————————
	constant euclidean: Division  = #Euclidean
	constant truncating: Division = #Truncating

	show("Choice_Equatable.is(_ Division)", euclidean::is(#Euclidean))
	show(
		"Choice_Equatable.is(_ Division) [differing]",
		euclidean::is(#Truncating),
	)
	show("Choice_Equatable.isNot(_ Division)", euclidean::isNot(#Truncating))
	show(
		"Choice_Equatable.isNot(_ Division) [same]",
		truncating::isNot(#Truncating),
	)
	show(
		"Choice_Printable.toString() [Division#Euclidean]",
		euclidean::toString(),
	)
	show(
		"Choice_Printable.toString() [Division#Truncating]",
		truncating::toString(),
	)

	§ ——— SortOrder ————————————————————————————————————————————————————————
	constant ascending: SortOrder  = #Ascending
	constant descending: SortOrder = #Descending

	show("Choice_Equatable.is(_ SortOrder)", ascending::is(#Ascending))
	show(
		"Choice_Equatable.is(_ SortOrder) [differing]",
		ascending::is(#Descending),
	)
	show("Choice_Equatable.isNot(_ SortOrder)", ascending::isNot(#Descending))
	show(
		"Choice_Equatable.isNot(_ SortOrder) [same]",
		descending::isNot(#Descending),
	)
	show(
		"Choice_Printable.toString() [SortOrder#Ascending]",
		ascending::toString(),
	)
	show(
		"Choice_Printable.toString() [SortOrder#Descending]",
		descending::toString(),
	)

	§ ——— Stream ———————————————————————————————————————————————————————————
	constant toOutput: Stream = #Output
	constant toError: Stream  = #Error

	show("Choice_Equatable.is(_ Stream)", toOutput::is(#Output))
	show("Choice_Equatable.is(_ Stream) [differing]", toOutput::is(#Error))
	show("Choice_Equatable.isNot(_ Stream)", toOutput::isNot(#Error))
	show("Choice_Equatable.isNot(_ Stream) [same]", toError::isNot(#Error))
	show("Choice_Printable.toString() [Stream#Output]", toOutput::toString())
	show("Choice_Printable.toString() [Stream#Error]", toError::toString())

	§ ——— Record ———————————————————————————————————————————————————————————
	§ LOAD-BEARING: `point` prints as `{ x = 1, y = 2 }`, well under sixty
	§ characters. `getStringRepresentation` has a bug where a Record whose
	§ single-line form reaches sixty characters is printed with every field
	§ doubled and wrapped across lines — which would put a value on more than
	§ one line and break the one-line-per-call contract the golden test reads
	§ by. Keep every printed Record here short until that bug is fixed.
	constant point = { x = 1, y = 2 }

	show("Record.is(_ \{\})", point::is({ x = 1, y = 2 }))
	show("Record.is(_ \{\}) [differing]", point::is({ x = 1, y = 3 }))
	show("Record.isNot(_ \{\})", point::isNot({ x = 1, y = 3 }))
	show("Record.isNot(_ \{\}) [equal]", point::isNot({ x = 1, y = 2 }))

	§ A Function is the one value with no Type tag on it, and reading that
	§ missing tag used to THROW here rather than answer — a Record holding a
	§ Function could not be compared with itself at all. Equality of Functions
	§ is identity: the same Function is equal to itself, two separately written
	§ ones are not, which is the most that is decidable.
	constant double        = (_ value: Integer) -> Integer {
		<- value::multiply(with 2)
	}
	constant holdingDouble = { fn = double }

	show(
		"Record.is(_ \{\}) [holding a Function]",
		holdingDouble::is(holdingDouble),
	)
	show(
		"Record.is(_ \{\}) [differing Functions]",
		holdingDouble::is({ fn = (_ value: Integer) -> Integer { <- value } }),
	)
	show("Record.keys()", point::keys())
	show("Record.toString()", point::toString())

	§ A Record renders each member for a reader, so a whole Rational member
	§ prints its numerator alone. `Terminal.inspect` keeps the structural
	§ `1/1`, and this line is what holds the two apart.
	show(
		"Record.toString() [whole Rational member]",
		{ ratio = 1/2::add(1/2) }::toString(),
	)

	§ A List member is the second piece the two renderings disagree about.
	§ `List::toString` answers `[1, 2]`, so a Record holding that List says the
	§ same about it, where `Terminal.inspect` keeps the structural `[ 1, 2 ]`.
	show("Record.toString() [List member]", { items = [1, 2] }::toString())

	§ ——— List —————————————————————————————————————————————————————————————
	show(
		"List.is<ItemType is Equatable>(_ List<ItemType>)",
		numbers::is([3, 1, 2, 1, 4]),
	)
	show(
		"List.is<ItemType is Equatable>(_ List<ItemType>) [differing]",
		numbers::is(singleNumber),
	)
	show(
		"List.is<ItemType is Equatable>(_ List<ItemType>) [both empty]",
		noNumbers::is([]),
	)
	show("List.isNot(_ List<ItemType>)", numbers::isNot(singleNumber))
	show(
		"List.isNot(_ List<ItemType>) [equal]",
		numbers::isNot([3, 1, 2, 1, 4]),
	)
	show("List.toString<ItemType is Printable>()", numbers::toString())
	show(
		"List.toString<ItemType is Printable>() [empty]",
		noNumbers::toString(),
	)
	show(
		"List.toString<ItemType is Printable>() [single]",
		singleNumber::toString(),
	)
	§ The rendering is the form the List was WRITTEN in, and a String item is
	§ quoted inside it: `[ a, , b ]` said nothing about how many items there
	§ were. `join(with:)` is the entry that answers the raw text.
	constant words: List<String>           = ["a", "b", "", "c"]
	constant nested: List<List<Integer>>   = [[1, 2], []]
	constant named: List<{ name: String }> = [{ name = "x" }]
	constant halves: List<Rational>        = [1/2, 2/1]
	constant maybeWords: List<Optional<String>> = [#Value("a"), #Empty]

	show("List.toString<ItemType is Printable>() [Strings]", words::toString())
	show("List.toString<ItemType is Printable>() [nested]", nested::toString())
	show("List.toString<ItemType is Printable>() [Records]", named::toString())
	show(
		"List.toString<ItemType is Printable>() [Rationals]",
		halves::toString(),
	)
	show(
		"List.toString<ItemType is Printable>() [Optionals]",
		maybeWords::toString(),
	)
	show("List.length<ItemType>()", numbers::length())
	show("List.length<ItemType>() [empty]", noNumbers::length())
	show("List.hasItems<ItemType>()", numbers::hasItems())
	show("List.hasItems<ItemType>() [empty]", noNumbers::hasItems())
	show("List.isEmpty<ItemType>()", noNumbers::isEmpty())
	show("List.isEmpty<ItemType>() [populated]", numbers::isEmpty())
	show(
		"List.contains<ItemType is Equatable>(_ ItemType)",
		numbers::contains(4),
	)
	show(
		"List.contains<ItemType is Equatable>(_ ItemType) [absent]",
		numbers::contains(9),
	)
	§ The subset question, and the first of the four set-shaped entries. How
	§ many times an item occurs is not asked, so a receiver holding one `1`
	§ contains every item of a List holding two.
	show(
		"List.contains<ItemType is Equatable>(everyItemOf: List<ItemType>)",
		numbers::contains(everyItemOf [4, 3]),
	)
	show(
		"List.contains<ItemType is Equatable>(everyItemOf: List<ItemType>) [repeated]",
		singleNumber::contains(everyItemOf [7, 7]),
	)
	show(
		"List.contains<ItemType is Equatable>(everyItemOf: List<ItemType>) [absent]",
		numbers::contains(everyItemOf [4, 9]),
	)
	show(
		"List.contains<ItemType is Equatable>(everyItemOf: List<ItemType>) [empty]",
		numbers::contains(everyItemOf noNumbers),
	)
	show(
		"List.doesNotContain<ItemType is Equatable>(_ ItemType)",
		numbers::doesNotContain(9),
	)
	show(
		"List.doesNotContain<ItemType is Equatable>(_ ItemType) [present]",
		numbers::doesNotContain(4),
	)
	show(
		"List.starts<ItemType is Equatable>(with: List<ItemType>)",
		numbers::starts(with [3, 1]),
	)
	show(
		"List.starts<ItemType is Equatable>(with: List<ItemType>) [other items]",
		numbers::starts(with [1]),
	)
	show(
		"List.starts<ItemType is Equatable>(with: List<ItemType>) [empty prefix]",
		numbers::starts(with noNumbers),
	)
	show(
		"List.starts<ItemType is Equatable>(with: List<ItemType>) [longer than the List]",
		singleNumber::starts(with numbers),
	)
	show(
		"List.doesNotStart<ItemType is Equatable>(with: List<ItemType>)",
		numbers::doesNotStart(with [1]),
	)
	show(
		"List.doesNotStart<ItemType is Equatable>(with: List<ItemType>) [it does]",
		numbers::doesNotStart(with [3, 1]),
	)
	show(
		"List.ends<ItemType is Equatable>(with: List<ItemType>)",
		numbers::ends(with [1, 4]),
	)
	show(
		"List.ends<ItemType is Equatable>(with: List<ItemType>) [other items]",
		numbers::ends(with [1]),
	)
	show(
		"List.ends<ItemType is Equatable>(with: List<ItemType>) [empty suffix]",
		numbers::ends(with noNumbers),
	)
	show(
		"List.ends<ItemType is Equatable>(with: List<ItemType>) [longer than the List]",
		singleNumber::ends(with numbers),
	)
	show(
		"List.doesNotEnd<ItemType is Equatable>(with: List<ItemType>)",
		numbers::doesNotEnd(with [1]),
	)
	show(
		"List.doesNotEnd<ItemType is Equatable>(with: List<ItemType>) [it does]",
		numbers::doesNotEnd(with [1, 4]),
	)
	show(
		"List.isSorted<ItemType is Comparable>(in?: SortOrder)",
		numbers::isSorted(),
	)
	show(
		"List.isSorted<ItemType is Comparable>(in?: SortOrder) [in order]",
		[1, 2, 2, 3]::isSorted(),
	)
	show(
		"List.isSorted<ItemType is Comparable>(in?: SortOrder) [descending]",
		[3, 2, 1]::isSorted(in #Descending),
	)
	show(
		"List.isSorted<ItemType is Comparable>(in?: SortOrder) [ties either way]",
		[1, 1]::isSorted(in #Descending),
	)
	show(
		"List.isSorted<ItemType is Comparable>(in?: SortOrder) [empty]",
		noNumbers::isSorted(),
	)
	show(
		"List.isSorted<ItemType is Comparable>(in?: SortOrder) [single]",
		singleNumber::isSorted(),
	)
	show("List.firstItem<ItemType>()", numbers::firstItem())
	show("List.firstItem<ItemType>() [empty]", noNumbers::firstItem())
	show(
		"List.firstItem<ItemType>(where: (_ ItemType) -> Boolean)",
		numbers::firstItem(where (item) { <- item::isGreaterThan(2) }),
	)
	show(
		"List.firstItem<ItemType>(where: (_ ItemType) -> Boolean) [no match]",
		numbers::firstItem(where (item) { <- item::isGreaterThan(9) }),
	)
	show(
		"List.firstItem<ItemType>(defaultingTo: ItemType)",
		numbers::firstItem(defaultingTo 0),
	)
	show(
		"List.firstItem<ItemType>(defaultingTo: ItemType) [empty]",
		noNumbers::firstItem(defaultingTo 0),
	)
	show(
		"List.firstItem<ItemType>(where: (_ ItemType) -> Boolean, defaultingTo: ItemType)",
		numbers::firstItem(
			where (item) { <- item::isGreaterThan(2) },
			defaultingTo 0,
		),
	)
	show(
		"List.firstItem<ItemType>(where: (_ ItemType) -> Boolean, defaultingTo: ItemType) [no match]",
		numbers::firstItem(
			where (item) { <- item::isGreaterThan(9) },
			defaultingTo 0,
		),
	)
	show("List.lastItem<ItemType>()", numbers::lastItem())
	show("List.lastItem<ItemType>() [empty]", noNumbers::lastItem())
	show("List.lastItem<ItemType>() [single]", singleNumber::lastItem())
	show(
		"List.lastItem<ItemType>(where: (_ ItemType) -> Boolean)",
		numbers::lastItem(where (item) { <- item::isGreaterThan(2) }),
	)
	show(
		"List.lastItem<ItemType>(where: (_ ItemType) -> Boolean) [no match]",
		numbers::lastItem(where (item) { <- item::isGreaterThan(9) }),
	)
	show(
		"List.lastItem<ItemType>(defaultingTo: ItemType)",
		numbers::lastItem(defaultingTo 0),
	)
	show(
		"List.lastItem<ItemType>(defaultingTo: ItemType) [empty]",
		noNumbers::lastItem(defaultingTo 0),
	)
	show(
		"List.lastItem<ItemType>(where: (_ ItemType) -> Boolean, defaultingTo: ItemType)",
		numbers::lastItem(
			where (item) { <- item::isGreaterThan(2) },
			defaultingTo 0,
		),
	)
	show(
		"List.lastItem<ItemType>(where: (_ ItemType) -> Boolean, defaultingTo: ItemType) [no match]",
		numbers::lastItem(
			where (item) { <- item::isGreaterThan(9) },
			defaultingTo 0,
		),
	)
	show(
		"List.removeFirst<ItemType>(_? Integer) [no count]",
		numbers::removeFirst(),
	)
	show(
		"List.removeFirst<ItemType>(_? Integer) [no count, empty]",
		noNumbers::removeFirst(),
	)
	show("List.removeFirst<ItemType>(_? Integer)", numbers::removeFirst(2))
	show(
		"List.removeFirst<ItemType>(_? Integer) [zero]",
		numbers::removeFirst(0),
	)
	show(
		"List.removeFirst<ItemType>(_? Integer) [past the end]",
		numbers::removeFirst(99),
	)
	show(
		"List.removeFirst<ItemType>(_? Integer) [negative]",
		numbers::removeFirst(-1),
	)
	show(
		"List.removeFirst<ItemType>(while: (_ ItemType) -> Boolean)",
		numbers::removeFirst(while (item) { <- item::isGreaterThan(2) }),
	)
	show(
		"List.removeFirst<ItemType>(while: (_ ItemType) -> Boolean) [every item]",
		numbers::removeFirst(while (item) { <- item::isLessThan(9) }),
	)
	show(
		"List.removeFirst<ItemType>(while: (_ ItemType) -> Boolean) [no item]",
		numbers::removeFirst(while (item) { <- item::isGreaterThan(9) }),
	)
	show(
		"List.removeFirst<ItemType>(while: (_ ItemType) -> Boolean) [empty]",
		noNumbers::removeFirst(while (item) { <- item::isEven() }),
	)
	show("List.remove<ItemType>(at: Integer)", numbers::remove(at 2))
	show("List.remove<ItemType>(at: Integer) [zero]", numbers::remove(at 0))
	show(
		"List.remove<ItemType>(at: Integer) [negative]",
		numbers::remove(at -1),
	)
	show(
		"List.remove<ItemType>(at: Integer) [at length]",
		numbers::remove(at numbers::length()),
	)
	show(
		"List.remove<ItemType>(at: Integer) [from the end, first]",
		numbers::remove(at 0::subtract(numbers::length())),
	)
	show(
		"List.remove<ItemType>(at: Integer) [before the start]",
		numbers::remove(at -99),
	)
	show(
		"List.removeEvery<ItemType is Equatable>(_ ItemType)",
		numbers::removeEvery(1),
	)
	show(
		"List.removeEvery<ItemType is Equatable>(_ ItemType) [absent]",
		numbers::removeEvery(9),
	)
	show(
		"List.removeEvery<ItemType>(where: (_ ItemType) -> Boolean)",
		numbers::removeEvery(where (item) { <- item::isGreaterThan(2) }),
	)
	show(
		"List.removeEvery<ItemType>(where: (_ ItemType) -> Boolean) [no match]",
		numbers::removeEvery(where (item) { <- item::isGreaterThan(9) }),
	)
	§ The difference. Every occurrence of an item the other List holds goes,
	§ and an item it holds that this one does not changes nothing.
	show(
		"List.removeEvery<ItemType is Equatable>(contentsOf: List<ItemType>)",
		numbers::removeEvery(contentsOf [1, 9]),
	)
	show(
		"List.removeEvery<ItemType is Equatable>(contentsOf: List<ItemType>) [empty]",
		numbers::removeEvery(contentsOf noNumbers),
	)
	show(
		"List.removeLast<ItemType>(_? Integer) [no count]",
		numbers::removeLast(),
	)
	show(
		"List.removeLast<ItemType>(_? Integer) [no count, empty]",
		noNumbers::removeLast(),
	)
	show("List.removeLast<ItemType>(_? Integer)", numbers::removeLast(2))
	show("List.removeLast<ItemType>(_? Integer) [zero]", numbers::removeLast(0))
	show(
		"List.removeLast<ItemType>(_? Integer) [past the end]",
		numbers::removeLast(99),
	)
	show(
		"List.removeLast<ItemType>(while: (_ ItemType) -> Boolean)",
		numbers::removeLast(while (item) { <- item::isGreaterThan(1) }),
	)
	show(
		"List.removeLast<ItemType>(while: (_ ItemType) -> Boolean) [every item]",
		numbers::removeLast(while (item) { <- item::isLessThan(9) }),
	)
	show(
		"List.removeLast<ItemType>(while: (_ ItemType) -> Boolean) [no item]",
		numbers::removeLast(while (item) { <- item::isGreaterThan(9) }),
	)
	show(
		"List.removeLast<ItemType>(while: (_ ItemType) -> Boolean) [empty]",
		noNumbers::removeLast(while (item) { <- item::isEven() }),
	)
	show("List.prepend<ItemType>(_ ItemType)", numbers::prepend(9))
	show(
		"List.prepend<ItemType>(contentsOf: List<ItemType>)",
		numbers::prepend(contentsOf [8, 9]),
	)
	show(
		"List.prepend<ItemType>(contentsOf: List<ItemType>) [empty]",
		numbers::prepend(contentsOf noNumbers),
	)
	show("List.append<ItemType>(_ ItemType)", numbers::append(9))
	show(
		"List.append<ItemType>(contentsOf: List<ItemType>)",
		numbers::append(contentsOf [8, 9]),
	)
	show(
		"List.append<ItemType>(contentsOf: List<ItemType>) [empty]",
		numbers::append(contentsOf noNumbers),
	)
	show(
		"List.map<ItemType, Other>(_ (_ ItemType) -> Other)",
		numbers::map((item) { <- item::toString() }),
	)
	show(
		"List.map<ItemType, Other>(_ (_ ItemType) -> Other) [empty]",
		noNumbers::map((item) { <- item::toString() }),
	)
	show(
		"List.reduce<ItemType, Answer>(startingWith: Answer, _ (_ Answer, _ ItemType) -> Answer)",
		numbers::reduce(startingWith 0, (total, item) { <- total::add(item) }),
	)
	show(
		"List.reduce<ItemType, Answer>(startingWith: Answer, _ (_ Answer, _ ItemType) -> Answer) [empty]",
		noNumbers::reduce(startingWith 0, (total, item) {
			<- total::add(item)
		}),
	)
	show(
		"List.reduce<ItemType, Answer>(startingWith: Answer, step: (_ Answer, _ ItemType) -> Step<Answer, Answer>)",
		numbers::reduce(startingWith 0, step (total, item) {
			<- #Continue(total::add(item))
		}),
	)
	show(
		"List.reduce<ItemType, Answer>(startingWith: Answer, step: (_ Answer, _ ItemType) -> Step<Answer, Answer>) [early stop]",
		numbers::reduce(startingWith 0, step (total, item) {
			if total::isGreaterThan(3) {
				<- #Done(total)
			}

			<- #Continue(total::add(item))
		}),
	)
	show(
		"List.reduce<ItemType, Answer>(startingWith: Answer, step: (_ Answer, _ ItemType) -> Step<Answer, Answer>) [empty]",
		noNumbers::reduce(startingWith 0, step (total, item) {
			<- #Continue(total::add(item))
		}),
	)
	show(
		"List.accumulate<ItemType, Answer>(startingWith: Answer, _ (_ Answer, _ ItemType) -> Answer)",
		numbers::accumulate(startingWith 0, (total, item) {
			<- total::add(item)
		}),
	)
	show(
		"List.accumulate<ItemType, Answer>(startingWith: Answer, _ (_ Answer, _ ItemType) -> Answer) [empty]",
		noNumbers::accumulate(startingWith 0, (total, item) {
			<- total::add(item)
		}),
	)
	show(
		"List.accumulate<ItemType, Answer>(startingWith: Answer, _ (_ Answer, _ ItemType) -> Answer) [proof carried]",
		noNumbers
			::accumulate(startingWith 0, (total, item) { <- total::add(item) })
			::firstItem(),
	)
	show(
		"List.everyItem<ItemType>(where: (_ ItemType) -> Boolean)",
		numbers::everyItem(where (item) { <- item::isGreaterThan(1) }),
	)
	show(
		"List.everyItem<ItemType>(where: (_ ItemType) -> Boolean) [no match]",
		numbers::everyItem(where (item) { <- item::isGreaterThan(9) }),
	)
	§ The intersection, which is a filter rather than a set operation: an item
	§ the other List holds is kept every time it occurs, so the repeated `1`
	§ comes back twice.
	show(
		"List.everyItem<ItemType is Equatable>(alsoIn: List<ItemType>)",
		numbers::everyItem(alsoIn [1, 4, 9]),
	)
	show(
		"List.everyItem<ItemType is Equatable>(alsoIn: List<ItemType>) [empty]",
		numbers::everyItem(alsoIn noNumbers),
	)

	§ The transform is a declared Function rather than a literal written at
	§ the call. A Method Generic that stands only in a callback's answer is
	§ solved from a named Function value and not from an annotated literal.
	show(
		"List.everyValue<ItemType, Other>(from: (_ ItemType) -> Optional<Other>)",
		numbers::everyValue(from evenAsText),
	)
	show(
		"List.everyValue<ItemType, Other>(from: (_ ItemType) -> Optional<Other>) [no value]",
		numbers::everyValue(from noText),
	)
	show(
		"List.everyValue<ItemType, Other>(from: (_ ItemType) -> Optional<Other>) [empty]",
		noNumbers::everyValue(from evenAsText),
	)
	show("List.item<ItemType>(at: Integer)", numbers::item(at 2))
	show("List.item<ItemType>(at: Integer) [zero]", numbers::item(at 0))
	show("List.item<ItemType>(at: Integer) [negative]", numbers::item(at -1))
	show(
		"List.item<ItemType>(at: Integer) [at length]",
		numbers::item(at numbers::length()),
	)
	show("List.item<ItemType>(at: Integer) [empty]", noNumbers::item(at 0))
	show(
		"List.item<ItemType>(at: Integer) [from the end, first]",
		numbers::item(at 0::subtract(numbers::length())),
	)
	show(
		"List.item<ItemType>(at: Integer) [before the start]",
		numbers::item(at -99),
	)
	show(
		"List.item<ItemType>(at: Integer, defaultingTo: ItemType)",
		numbers::item(at 2, defaultingTo 0),
	)
	show(
		"List.item<ItemType>(at: Integer, defaultingTo: ItemType) [outside]",
		numbers::item(at 99, defaultingTo 0),
	)
	show(
		"List.firstIndex<ItemType is Equatable>(of: ItemType)",
		numbers::firstIndex(of 1),
	)
	show(
		"List.firstIndex<ItemType is Equatable>(of: ItemType) [absent]",
		numbers::firstIndex(of 9),
	)
	show(
		"List.firstIndex<ItemType>(where: (_ ItemType) -> Boolean)",
		numbers::firstIndex(where (item) { <- item::isGreaterThan(2) }),
	)
	show(
		"List.firstIndex<ItemType>(where: (_ ItemType) -> Boolean) [no match]",
		numbers::firstIndex(where (item) { <- item::isGreaterThan(9) }),
	)
	show(
		"List.firstIndex<ItemType is Equatable>(of: ItemType, defaultingTo: Integer)",
		numbers::firstIndex(of 1, defaultingTo -1),
	)
	show(
		"List.firstIndex<ItemType is Equatable>(of: ItemType, defaultingTo: Integer) [absent]",
		numbers::firstIndex(of 9, defaultingTo -1),
	)
	show(
		"List.firstIndex<ItemType>(where: (_ ItemType) -> Boolean, defaultingTo: Integer)",
		numbers::firstIndex(
			where (item) { <- item::isGreaterThan(2) },
			defaultingTo -1,
		),
	)
	show(
		"List.firstIndex<ItemType>(where: (_ ItemType) -> Boolean, defaultingTo: Integer) [no match]",
		numbers::firstIndex(
			where (item) { <- item::isGreaterThan(9) },
			defaultingTo -1,
		),
	)
	show(
		"List.slice<ItemType>(from?: Integer, to?: Integer)",
		numbers::slice(from 1, to 3),
	)
	show(
		"List.slice<ItemType>(from?: Integer, to?: Integer) [empty range]",
		numbers::slice(from 2, to 2),
	)
	show(
		"List.slice<ItemType>(from?: Integer, to?: Integer) [past the end]",
		numbers::slice(from 3, to 99),
	)
	show(
		"List.slice<ItemType>(from?: Integer, to?: Integer) [negative to]",
		numbers::slice(from 0, to -1),
	)
	show(
		"List.slice<ItemType>(from?: Integer, to?: Integer) [negative from]",
		numbers::slice(from -2, to 5),
	)
	show(
		"List.slice<ItemType>(from?: Integer, to?: Integer) [both negative]",
		numbers::slice(from -3, to -1),
	)
	show(
		"List.slice<ItemType>(from?: Integer, to?: Integer) [negative past the start]",
		numbers::slice(from -99, to 2),
	)
	show(
		"List.slice<ItemType>(from?: Integer, to?: Integer) [no to]",
		numbers::slice(from 2),
	)
	show(
		"List.slice<ItemType>(from?: Integer, to?: Integer) [no from]",
		numbers::slice(to 2),
	)
	show(
		"List.slice<ItemType>(from?: Integer, to?: Integer) [neither]",
		numbers::slice(),
	)
	show("List.reverse<ItemType>()", numbers::reverse())
	show("List.reverse<ItemType>() [empty]", noNumbers::reverse())
	show(
		"List.sort<ItemType is Comparable>(in?: SortOrder)",
		threeNumbers::sort(),
	)
	show(
		"List.sort<ItemType is Comparable>(in?: SortOrder) [Strings]",
		twoFruits::sort(),
	)
	show(
		"List.sort<ItemType is Comparable>(in?: SortOrder) [empty]",
		noNumbers::sort(),
	)
	show(
		"List.sort<ItemType is Comparable>(in?: SortOrder) [ascending named]",
		threeNumbers::sort(in #Ascending),
	)
	show(
		"List.sort<ItemType is Comparable>(in?: SortOrder) [descending]",
		threeNumbers::sort(in #Descending),
	)
	show(
		"List.sort<ItemType is Comparable>(in?: SortOrder) [descending, Strings]",
		twoFruits::sort(in #Descending),
	)
	show(
		"List.sort<ItemType is Comparable>(in?: SortOrder) [descending, empty]",
		noNumbers::sort(in #Descending),
	)
	show(
		"List.sort<ItemType>(by: (_ ItemType, _ ItemType) -> Ordering)",
		numbers::sort(by (first, second) { <- first::compare(to second) }),
	)
	show(
		"List.sort<ItemType>(by: (_ ItemType, _ ItemType) -> Ordering) [empty]",
		noNumbers::sort(by (first, second) { <- first::compare(to second) }),
	)

	§ The keyed entries, which is what a member path was built for. Every one
	§ of them reads its key with one, so the calls below are also what says the
	§ desugar reaches an Argument position. Each printed Record is kept short
	§ for the reason `point` is.
	§ Each `m` is annotated where it is bound rather than inside the literal:
	§ a List literal takes its item Type from the items, so three Records
	§ holding an Integer, a Rational and an Integer answer three shapes rather
	§ than one holding the Union.
	constant mixedTwo: Integer | Rational   = 2
	constant mixedHalf: Integer | Rational  = 1/2
	constant mixedThree: Integer | Rational = 3

	constant rows: List<{
		tag: String,
		n: Integer,
		r: Rational,
		m: Integer | Rational,
	}>   = [
		{ tag = "b", n = 2, r = 3/2, m = mixedTwo },
		{ tag = "a", n = 1, r = 1/2, m = mixedHalf },
		{ tag = "c", n = 3, r = 5/2, m = mixedThree },
	]
	constant noRows: List<{
		tag: String,
		n: Integer,
		r: Rational,
		m: Integer | Rational,
	}> = []
	constant fallbackRow = { tag = "z", n = 0, r = 0/1, m = 0 }

	§ A tie at each end of the order, which no other List here has: two rows
	§ share the lowest key and two share the highest. The four `[tie]` labels
	§ below pin the rule all four blocks promise, that the earlier item is the
	§ one kept.
	constant tiedRows: List<{ tag: String, n: Integer }> = [
		{ tag = "a", n = 1 },
		{ tag = "b", n = 2 },
		{ tag = "c", n = 1 },
		{ tag = "d", n = 2 },
	]

	show(
		"List.sort<ItemType, Key is Comparable>(on: (_ ItemType) -> Key, in?: SortOrder)",
		rows::sort(on .tag)::map(.n),
	)
	show(
		"List.sort<ItemType, Key is Comparable>(on: (_ ItemType) -> Key, in?: SortOrder) [empty]",
		noRows::sort(on .tag)::map(.n),
	)
	show(
		"List.sort<ItemType, Key is Comparable>(on: (_ ItemType) -> Key, in?: SortOrder) [descending]",
		rows::sort(on .tag, in #Descending)::map(.n),
	)
	§ The two lines the stability promise rests on: `a` and `c` share the
	§ lowest key and `b` and `d` the highest, so an unstable sort would put
	§ either pair the other way round in one of the two directions.
	show(
		"List.sort<ItemType, Key is Comparable>(on: (_ ItemType) -> Key, in?: SortOrder) [tie]",
		tiedRows::sort(on .n)::map(.tag),
	)
	show(
		"List.sort<ItemType, Key is Comparable>(on: (_ ItemType) -> Key, in?: SortOrder) [descending, tie]",
		tiedRows::sort(on .n, in #Descending)::map(.tag),
	)
	show(
		"List.lowestItem<ItemType, Key is Comparable>(on: (_ ItemType) -> Key)",
		rows::lowestItem(on .n),
	)
	show(
		"List.lowestItem<ItemType, Key is Comparable>(on: (_ ItemType) -> Key) [empty]",
		noRows::lowestItem(on .n),
	)
	show(
		"List.lowestItem<ItemType, Key is Comparable>(on: (_ ItemType) -> Key, defaultingTo: ItemType)",
		rows::lowestItem(on .n, defaultingTo fallbackRow),
	)
	show(
		"List.lowestItem<ItemType, Key is Comparable>(on: (_ ItemType) -> Key, defaultingTo: ItemType) [empty]",
		noRows::lowestItem(on .n, defaultingTo fallbackRow),
	)
	show(
		"List.lowestItem<ItemType, Key is Comparable>(on: (_ ItemType) -> Key) [tie]",
		tiedRows::lowestItem(on .n),
	)
	show(
		"List.highestItem<ItemType, Key is Comparable>(on: (_ ItemType) -> Key)",
		rows::highestItem(on .n),
	)
	show(
		"List.highestItem<ItemType, Key is Comparable>(on: (_ ItemType) -> Key) [empty]",
		noRows::highestItem(on .n),
	)
	show(
		"List.highestItem<ItemType, Key is Comparable>(on: (_ ItemType) -> Key, defaultingTo: ItemType)",
		rows::highestItem(on .n, defaultingTo fallbackRow),
	)
	show(
		"List.highestItem<ItemType, Key is Comparable>(on: (_ ItemType) -> Key, defaultingTo: ItemType) [empty]",
		noRows::highestItem(on .n, defaultingTo fallbackRow),
	)
	show(
		"List.highestItem<ItemType, Key is Comparable>(on: (_ ItemType) -> Key) [tie]",
		tiedRows::highestItem(on .n),
	)
	§ The keyless pair, on receivers nothing proved anything about: a written
	§ List reaches `NonEmptyList`'s own entries, which answer bare.
	show("List.lowestItem<ItemType is Comparable>()", words::lowestItem())
	show(
		"List.lowestItem<ItemType is Comparable>() [empty]",
		noNumbers::lowestItem(),
	)
	show(
		"List.lowestItem<ItemType is Comparable>(defaultingTo: ItemType)",
		numbers::lowestItem(defaultingTo 0),
	)
	show(
		"List.lowestItem<ItemType is Comparable>(defaultingTo: ItemType) [empty]",
		noNumbers::lowestItem(defaultingTo 0),
	)
	show("List.highestItem<ItemType is Comparable>()", words::highestItem())
	show(
		"List.highestItem<ItemType is Comparable>() [empty]",
		noNumbers::highestItem(),
	)
	show(
		"List.highestItem<ItemType is Comparable>(defaultingTo: ItemType)",
		numbers::highestItem(defaultingTo 0),
	)
	show(
		"List.highestItem<ItemType is Comparable>(defaultingTo: ItemType) [empty]",
		noNumbers::highestItem(defaultingTo 0),
	)
	show(
		"List.compare<ItemType is Comparable>(to: List<ItemType>)",
		[1, 2]::compare(to [1, 3]),
	)
	show(
		"List.compare<ItemType is Comparable>(to: List<ItemType>) [equal]",
		[1, 2]::compare(to [1, 2]),
	)
	show(
		"List.compare<ItemType is Comparable>(to: List<ItemType>) [shorter]",
		[1]::compare(to [1, 2]),
	)
	show(
		"List.compare<ItemType is Comparable>(to: List<ItemType>) [both empty]",
		noNumbers::compare(to []),
	)
	§ And the four inequalities `Comparable` provides over that `compare`,
	§ which a List answers through its conditional conformance.
	show("List.isLessThan(_ List<ItemType>)", [1, 2]::isLessThan([1, 3]))
	show("List.isLessThan(_ List<ItemType>) [prefix]", [1]::isLessThan([1, 2]))
	show(
		"List.isLessThanOrEqualTo(_ List<ItemType>) [equal]",
		[1, 2]::isLessThanOrEqualTo([1, 2]),
	)
	show("List.isGreaterThan(_ List<ItemType>)", [1, 3]::isGreaterThan([1, 2]))
	show(
		"List.isGreaterThanOrEqualTo(_ List<ItemType>)",
		[1, 2]::isGreaterThanOrEqualTo([1, 2]),
	)
	show(
		"List.hasItems<ItemType>(where: (_ ItemType) -> Boolean)",
		numbers::hasItems(where (item) { <- item::isGreaterThan(3) }),
	)
	show(
		"List.hasItems<ItemType>(where: (_ ItemType) -> Boolean) [no match]",
		numbers::hasItems(where (item) { <- item::isGreaterThan(9) }),
	)
	show(
		"List.hasItems<ItemType>(where: (_ ItemType) -> Boolean) [empty]",
		noNumbers::hasItems(where (item) { <- item::isGreaterThan(0) }),
	)
	show(
		"List.hasOnlyItems<ItemType>(where: (_ ItemType) -> Boolean)",
		numbers::hasOnlyItems(where (item) { <- item::isGreaterThan(0) }),
	)
	show(
		"List.hasOnlyItems<ItemType>(where: (_ ItemType) -> Boolean) [no match]",
		numbers::hasOnlyItems(where (item) { <- item::isGreaterThan(3) }),
	)
	show(
		"List.hasOnlyItems<ItemType>(where: (_ ItemType) -> Boolean) [empty]",
		noNumbers::hasOnlyItems(where (item) { <- item::isGreaterThan(0) }),
	)
	show(
		"List.hasNoItems<ItemType>(where: (_ ItemType) -> Boolean)",
		numbers::hasNoItems(where (item) { <- item::isGreaterThan(9) }),
	)
	show(
		"List.hasNoItems<ItemType>(where: (_ ItemType) -> Boolean) [match]",
		numbers::hasNoItems(where (item) { <- item::isGreaterThan(3) }),
	)
	show(
		"List.hasDuplicates<ItemType is Equatable>()",
		numbers::hasDuplicates(),
	)
	show(
		"List.hasDuplicates<ItemType is Equatable>() [all distinct]",
		[1, 2, 3]::hasDuplicates(),
	)
	show(
		"List.hasDuplicates<ItemType is Equatable>() [empty]",
		noNumbers::hasDuplicates(),
	)
	show(
		"List.hasDuplicates<ItemType, Key is Equatable>(on: (_ ItemType) -> Key)",
		tiedRows::hasDuplicates(on .n),
	)
	show(
		"List.hasDuplicates<ItemType, Key is Equatable>(on: (_ ItemType) -> Key) [distinct keys]",
		tiedRows::hasDuplicates(on .tag),
	)
	show(
		"List.hasNoItems<ItemType>(where: (_ ItemType) -> Boolean) [empty]",
		noNumbers::hasNoItems(where (item) { <- item::isGreaterThan(0) }),
	)
	show(
		"List.count<ItemType is Equatable>(of: ItemType)",
		numbers::count(of 1),
	)
	show(
		"List.count<ItemType is Equatable>(of: ItemType) [absent]",
		numbers::count(of 9),
	)
	show(
		"List.count<ItemType>(where: (_ ItemType) -> Boolean)",
		numbers::count(where (item) { <- item::isGreaterThan(1) }),
	)
	show(
		"List.count<ItemType>(where: (_ ItemType) -> Boolean) [no match]",
		numbers::count(where (item) { <- item::isGreaterThan(9) }),
	)
	show(
		"List.insert<ItemType>(_ ItemType, at: Integer)",
		numbers::insert(99, at 2),
	)
	show(
		"List.insert<ItemType>(_ ItemType, at: Integer) [zero]",
		numbers::insert(99, at 0),
	)
	show(
		"List.insert<ItemType>(_ ItemType, at: Integer) [at length]",
		numbers::insert(99, at numbers::length()),
	)
	show(
		"List.insert<ItemType>(_ ItemType, at: Integer) [negative]",
		numbers::insert(99, at -1),
	)
	show(
		"List.insert<ItemType>(_ ItemType, at: Integer) [before the start]",
		numbers::insert(99, at -99),
	)
	show(
		"List.replace<ItemType>(_ ItemType, at: Integer)",
		numbers::replace(99, at 0),
	)
	show(
		"List.replace<ItemType>(_ ItemType, at: Integer) [at length]",
		numbers::replace(99, at numbers::length()),
	)
	show(
		"List.replace<ItemType>(_ ItemType, at: Integer) [negative]",
		numbers::replace(99, at -1),
	)
	show(
		"List.replace<ItemType>(_ ItemType, at: Integer) [from the end, first]",
		numbers::replace(99, at 0::subtract(numbers::length())),
	)
	show(
		"List.replace<ItemType>(_ ItemType, at: Integer) [before the start]",
		numbers::replace(99, at -99),
	)
	§ The transform entry, over the same five positions. It is written on the
	§ entry above, so the two answer the same position the same way — and the
	§ transform is never run where no item stands.
	show(
		"List.replace<ItemType>(at: Integer, _ (_ ItemType) -> ItemType)",
		numbers::replace(at 0, (item) { <- item::multiply(with 10) }),
	)
	show(
		"List.replace<ItemType>(at: Integer, _ (_ ItemType) -> ItemType) [at length]",
		numbers::replace(at numbers::length(), (item) {
			<- item::multiply(with 10)
		}),
	)
	show(
		"List.replace<ItemType>(at: Integer, _ (_ ItemType) -> ItemType) [negative]",
		numbers::replace(at -1, (item) { <- item::multiply(with 10) }),
	)
	show(
		"List.replace<ItemType>(at: Integer, _ (_ ItemType) -> ItemType) [before the start]",
		numbers::replace(at -99, (item) { <- item::multiply(with 10) }),
	)
	show(
		"List.replace<ItemType>(at: Integer, _ (_ ItemType) -> ItemType) [empty]",
		noNumbers::replace(at 0, (item) { <- item::multiply(with 10) }),
	)
	show(
		"List.lastIndex<ItemType is Equatable>(of: ItemType)",
		numbers::lastIndex(of 1),
	)
	show(
		"List.lastIndex<ItemType is Equatable>(of: ItemType) [absent]",
		numbers::lastIndex(of 9),
	)
	show(
		"List.lastIndex<ItemType is Equatable>(of: ItemType, defaultingTo: Integer)",
		numbers::lastIndex(of 1, defaultingTo -1),
	)
	show(
		"List.lastIndex<ItemType is Equatable>(of: ItemType, defaultingTo: Integer) [absent]",
		numbers::lastIndex(of 9, defaultingTo -1),
	)
	show(
		"List.lastIndex<ItemType>(where: (_ ItemType) -> Boolean)",
		numbers::lastIndex(where (item) { <- item::isGreaterThan(2) }),
	)
	show(
		"List.lastIndex<ItemType>(where: (_ ItemType) -> Boolean) [no match]",
		numbers::lastIndex(where (item) { <- item::isGreaterThan(9) }),
	)
	show(
		"List.lastIndex<ItemType>(where: (_ ItemType) -> Boolean, defaultingTo: Integer)",
		numbers::lastIndex(
			where (item) { <- item::isGreaterThan(2) },
			defaultingTo -1,
		),
	)
	show(
		"List.lastIndex<ItemType>(where: (_ ItemType) -> Boolean, defaultingTo: Integer) [no match]",
		numbers::lastIndex(
			where (item) { <- item::isGreaterThan(9) },
			defaultingTo -1,
		),
	)
	show("List.enumerate<ItemType>()", numbers::enumerate())
	show("List.enumerate<ItemType>() [empty]", noNumbers::enumerate())
	show("List.indices<ItemType>()", numbers::indices())
	show("List.indices<ItemType>() [empty]", noNumbers::indices())
	show(
		"List.indices<ItemType>(where: (_ ItemType) -> Boolean)",
		numbers::indices(where (item) { <- item::isEven() }),
	)
	show(
		"List.indices<ItemType>(where: (_ ItemType) -> Boolean) [no match]",
		numbers::indices(where (item) { <- item::isGreaterThan(9) }),
	)
	show(
		"List.indices<ItemType>(where: (_ ItemType) -> Boolean) [empty]",
		noNumbers::indices(where (item) { <- item::isEven() }),
	)
	show(
		"List.everyIndex<ItemType is Equatable>(of: ItemType)",
		numbers::everyIndex(of 1),
	)
	show(
		"List.everyIndex<ItemType is Equatable>(of: ItemType) [absent]",
		numbers::everyIndex(of 9),
	)
	show("List.onlyItem<ItemType>()", singleNumber::onlyItem())
	show("List.onlyItem<ItemType>() [several]", numbers::onlyItem())
	show("List.onlyItem<ItemType>() [empty]", noNumbers::onlyItem())
	show(
		"List.onlyItem<ItemType>(defaultingTo: ItemType)",
		singleNumber::onlyItem(defaultingTo 0),
	)
	show(
		"List.onlyItem<ItemType>(defaultingTo: ItemType) [several]",
		numbers::onlyItem(defaultingTo 0),
	)
	show(
		"List.join<ItemType is Printable>(with: String)",
		["a", "b", "c"]::join(with " + "),
	)
	show(
		"List.join<ItemType is Printable>(with: String) [empty]",
		noNumbers::join(with ", "),
	)
	show(
		"List.join<ItemType is Printable>(with: String) [single]",
		singleNumber::join(with ", "),
	)
	§ LOAD-BEARING: `partition` returns a Record, and its printed form
	§ `{ accepted = [2, 4], refused = [3, 1, 1] }` sits at forty-two
	§ characters — eighteen under the sixty at which `getStringRepresentation`
	§ trips its field-doubling bug and wraps across lines. A larger `numbers`
	§ List here would cross that line and break the golden. Keep it short.
	show(
		"List.partition<ItemType>(where: (_ ItemType) -> Boolean)",
		numbers::partition(where (item) { <- item::isEven() }),
	)
	show(
		"List.partition<ItemType>(where: (_ ItemType) -> Boolean) [empty]",
		noNumbers::partition(where (item) { <- item::isEven() }),
	)
	show(
		"List.partition<ItemType>(while: (_ ItemType) -> Boolean)",
		numbers::partition(while (item) { <- item::isGreaterThan(2) }),
	)
	show(
		"List.partition<ItemType>(while: (_ ItemType) -> Boolean) [every item]",
		numbers::partition(while (item) { <- item::isLessThan(9) }),
	)
	show(
		"List.partition<ItemType>(while: (_ ItemType) -> Boolean) [empty]",
		noNumbers::partition(while (item) { <- item::isEven() }),
	)
	show("List.partition<ItemType>(at: Integer)", numbers::partition(at 2))
	show(
		"List.partition<ItemType>(at: Integer) [negative]",
		numbers::partition(at -1),
	)
	show(
		"List.partition<ItemType>(at: Integer) [past the end]",
		numbers::partition(at 99),
	)
	§ A receiver written down proves it has something in it, and both Methods
	§ below have an entry that spends the proof. So the two receivers that
	§ carry it are declared as plain Lists, which is what keeps these calls on
	§ the entries `List` itself declares. `pair` asks the ARGUMENT for a proof
	§ too, so the empty case reaches `List` through what is paired with it.
	§
	§ One pair only: the pretty printer wraps a Record List past sixty
	§ characters, and every line of this file's output has to stay one line.
	constant oneWord: List<String>      = ["a"]
	constant fiveNumbers: List<Integer> = [1, 2, 3, 4, 5]

	show(
		"List.pair<ItemType, Other>(with: List<Other>)",
		oneWord::pair(with [1, 2, 3]),
	)
	show(
		"List.pair<ItemType, Other>(with: List<Other>) [empty]",
		["a", "b"]::pair(with noNumbers),
	)
	show(
		"List.split<ItemType>(intoGroupsOf: Integer)",
		fiveNumbers::split(intoGroupsOf 2),
	)
	show(
		"List.split<ItemType>(intoGroupsOf: Integer) [zero]",
		numbers::split(intoGroupsOf 0),
	)
	show(
		"List.split<ItemType>(intoGroupsOf: Integer) [negative]",
		numbers::split(intoGroupsOf -1),
	)
	show(
		"List.split<ItemType>(intoGroupsOf: Integer) [empty]",
		noNumbers::split(intoGroupsOf 2),
	)
	show(
		"List.split<ItemType>(intoGroupsOf: Integer) [empty, zero]",
		noNumbers::split(intoGroupsOf 0),
	)
	§ The two entries that cut at a separator. A separator cuts BETWEEN
	§ pieces, so a piece stands before the first cut and after the last one —
	§ which is what makes the answer a NonEmptyList whatever it was handed,
	§ and the empty List answer one empty piece.
	constant separated: List<Integer> = [0, 1, 2, 0, 0, 3]

	show(
		"List.split<ItemType is Equatable>(on: ItemType)",
		separated::split(on 0),
	)
	show(
		"List.split<ItemType is Equatable>(on: ItemType) [absent]",
		fiveNumbers::split(on 9),
	)
	show(
		"List.split<ItemType is Equatable>(on: ItemType) [empty]",
		noNumbers::split(on 0),
	)
	show(
		"List.split<ItemType>(where: (_ ItemType) -> Boolean)",
		fiveNumbers::split(where (item) { <- item::isEven() }),
	)
	show(
		"List.split<ItemType>(where: (_ ItemType) -> Boolean) [proof carried]",
		noNumbers::split(where (item) { <- item::isEven() })::firstItem(),
	)
	§ `repeat` tells its two entries apart by what is known about the COUNT, so
	§ the computed Constant from the Integer section keeps this call on the
	§ entry answering a plain List. A written count above zero is its own proof
	§ and reaches the entry that answers a NonEmptyList; the two written below
	§ it can not, since neither is above zero.
	show(
		"List.repeat<ItemType>(_ ItemType, times: Integer)",
		List.repeat("x", times computedThree),
	)
	show(
		"List.repeat<ItemType>(_ ItemType, times: Integer) [zero]",
		List.repeat("x", times 0),
	)
	show(
		"List.repeat<ItemType>(_ ItemType, times: Integer) [negative]",
		List.repeat("x", times -1),
	)
	show(
		"List.repeat<ItemType>(_ ItemType, times: PositiveInteger)",
		List.repeat("x", times 3),
	)
	show(
		"List.repeat<ItemType>(_ ItemType, times: PositiveInteger) [one]",
		List.repeat("x", times 1),
	)
	show(
		"List.of(integersFrom: Integer, through: Integer)",
		List.of(integersFrom 1, through 5),
	)
	show(
		"List.of(integersFrom: Integer, through: Integer) [single]",
		List.of(integersFrom 1, through 1),
	)
	show(
		"List.of(integersFrom: Integer, through: Integer) [end below the start]",
		List.of(integersFrom 5, through 1),
	)
	show(
		"List.of(integersFrom: Integer, upTo: Integer)",
		List.of(integersFrom 0, upTo 5),
	)
	show(
		"List.of(integersFrom: Integer, upTo: Integer) [end at the start]",
		List.of(integersFrom 0, upTo 0),
	)
	show(
		"List.of(integersFrom: Integer, upTo: Integer) [end below the start]",
		List.of(integersFrom 3, upTo 1),
	)
	show(
		"List.of(integersFrom: Integer, downTo: Integer)",
		List.of(integersFrom 5, downTo 1),
	)
	show(
		"List.of(integersFrom: Integer, downTo: Integer) [single]",
		List.of(integersFrom 1, downTo 1),
	)
	show(
		"List.of(integersFrom: Integer, downTo: Integer) [end above the start]",
		List.of(integersFrom 1, downTo 5),
	)
	show(
		"List.of(integersFrom: Integer, through: Integer, by: NonZeroInteger)",
		List.of(integersFrom 0, through 9, by 3),
	)
	show(
		"List.of(integersFrom: Integer, through: Integer, by: NonZeroInteger) [stepping down]",
		List.of(integersFrom 9, through 0, by -3),
	)
	show(
		"List.of(integersFrom: Integer, through: Integer, by: NonZeroInteger) [step away from the end]",
		List.of(integersFrom 0, through 9, by -3),
	)
	show(
		"List.of(integersFrom: Integer, through: Integer, by: NonZeroInteger) [step past the end]",
		List.of(integersFrom 0, through 5, by 10),
	)
	show(
		"List.of(integersFrom: Integer, upTo: Integer, by: NonZeroInteger)",
		List.of(integersFrom 0, upTo 9, by 3),
	)
	show(
		"List.of(integersFrom: Integer, upTo: Integer, by: NonZeroInteger) [stepping down]",
		List.of(integersFrom 9, upTo 0, by -3),
	)
	show(
		"List.of(integersFrom: Integer, upTo: Integer, by: NonZeroInteger) [end at the start]",
		List.of(integersFrom 0, upTo 0, by 3),
	)
	show(
		"List.of(integersFrom: Integer, downTo: Integer, by: NonZeroInteger)",
		List.of(integersFrom 9, downTo 0, by -3),
	)
	show(
		"List.of(integersFrom: Integer, downTo: Integer, by: NonZeroInteger) [step away from the end]",
		List.of(integersFrom 9, downTo 0, by 3),
	)
	show("List.firstItems<ItemType>(_ Integer)", numbers::firstItems(2))
	show("List.firstItems<ItemType>(_ Integer) [zero]", numbers::firstItems(0))
	show(
		"List.firstItems<ItemType>(_ Integer) [below one]",
		numbers::firstItems(-1),
	)
	show(
		"List.firstItems<ItemType>(_ Integer) [past the length]",
		numbers::firstItems(99),
	)
	show(
		"List.firstItems<ItemType>(_ Integer) [empty]",
		noNumbers::firstItems(2),
	)
	show(
		"List.firstItems<ItemType>(while: (_ ItemType) -> Boolean)",
		numbers::firstItems(while (item) { <- item::isGreaterThan(2) }),
	)
	show(
		"List.firstItems<ItemType>(while: (_ ItemType) -> Boolean) [every item]",
		numbers::firstItems(while (item) { <- item::isLessThan(9) }),
	)
	show(
		"List.firstItems<ItemType>(while: (_ ItemType) -> Boolean) [no item]",
		numbers::firstItems(while (item) { <- item::isGreaterThan(9) }),
	)
	show(
		"List.firstItems<ItemType>(while: (_ ItemType) -> Boolean) [empty]",
		noNumbers::firstItems(while (item) { <- item::isEven() }),
	)
	show("List.lastItems<ItemType>(_ Integer)", numbers::lastItems(2))
	show("List.lastItems<ItemType>(_ Integer) [zero]", numbers::lastItems(0))
	show(
		"List.lastItems<ItemType>(_ Integer) [below one]",
		numbers::lastItems(-1),
	)
	show(
		"List.lastItems<ItemType>(_ Integer) [past the length]",
		numbers::lastItems(99),
	)
	show("List.lastItems<ItemType>(_ Integer) [empty]", noNumbers::lastItems(2))
	show(
		"List.lastItems<ItemType>(while: (_ ItemType) -> Boolean)",
		numbers::lastItems(while (item) { <- item::isGreaterThan(1) }),
	)
	show(
		"List.lastItems<ItemType>(while: (_ ItemType) -> Boolean) [every item]",
		numbers::lastItems(while (item) { <- item::isLessThan(9) }),
	)
	show(
		"List.lastItems<ItemType>(while: (_ ItemType) -> Boolean) [no item]",
		numbers::lastItems(while (item) { <- item::isGreaterThan(9) }),
	)
	show(
		"List.lastItems<ItemType>(while: (_ ItemType) -> Boolean) [empty]",
		noNumbers::lastItems(while (item) { <- item::isEven() }),
	)

	§ The set-shaped transform, which keeps the FIRST occurrence of each item
	§ and the order the kept items stood in. The `on:` entry asks the same of
	§ a key read off each item, so the row a key was first met at is the row
	§ that survives.
	show(
		"List.removeDuplicates<ItemType is Equatable>()",
		numbers::removeDuplicates(),
	)
	show(
		"List.removeDuplicates<ItemType is Equatable>() [empty]",
		noNumbers::removeDuplicates(),
	)
	§ A Rational key and the whole Integer it equals are one item, which is
	§ what the covering `Number`'s own `is` says and what the encoding behind
	§ this walk has to agree with.
	constant twoSpellings: List<Number> = [3, 3/1, 1/2]

	show(
		"List.removeDuplicates<ItemType is Equatable>() [across two numeric kinds]",
		twoSpellings::removeDuplicates(),
	)
	show(
		"List.removeDuplicates<ItemType, Key is Equatable>(on: (_ ItemType) -> Key)",
		tiedRows::removeDuplicates(on .n),
	)
	show(
		"List.removeDuplicates<ItemType, Key is Equatable>(on: (_ ItemType) -> Key) [empty]",
		noNumbers::removeDuplicates(on (item) { <- item }),
	)
	§ Filling up to a length, which is `String::pad` over items — with the
	§ other end as its default, since a List keeps the items it holds where
	§ they stand.
	show(
		"List.pad<ItemType>(to: Integer, with: ItemType, at?: Side)",
		singleNumber::pad(to 3, with 0),
	)
	show(
		"List.pad<ItemType>(to: Integer, with: ItemType, at?: Side) [start]",
		singleNumber::pad(to 3, with 0, at #Start),
	)
	show(
		"List.pad<ItemType>(to: Integer, with: ItemType, at?: Side) [both ends]",
		singleNumber::pad(to 4, with 0, at #BothEnds),
	)
	show(
		"List.pad<ItemType>(to: Integer, with: ItemType, at?: Side) [already long enough]",
		numbers::pad(to 2, with 0),
	)
	show(
		"List.pad<ItemType>(to: Integer, with: ItemType, at?: Side) [empty]",
		noNumbers::pad(to 2, with 0),
	)
	§ The overlapping stretches, and the maximal ones. Each holds an item, so
	§ a total `firstItem` reads off one.
	show("List.windows<ItemType>(of: PositiveInteger)", numbers::windows(of 2))
	show(
		"List.windows<ItemType>(of: PositiveInteger) [whole length]",
		numbers::windows(of 5),
	)
	show(
		"List.windows<ItemType>(of: PositiveInteger) [above the length]",
		numbers::windows(of 6),
	)
	show(
		"List.windows<ItemType>(of: PositiveInteger) [proven stretches]",
		numbers::windows(of 2)::map((window) { <- window::firstItem() }),
	)
	show(
		"List.windows<ItemType>(of: PositiveInteger) [empty]",
		noNumbers::windows(of 2),
	)
	show(
		"List.runs<ItemType>(where: (_ ItemType) -> Boolean)",
		numbers::runs(where (item) { <- item::isLessThan(3) }),
	)
	show(
		"List.runs<ItemType>(where: (_ ItemType) -> Boolean) [no match]",
		numbers::runs(where (item) { <- item::isGreaterThan(9) }),
	)
	show(
		"List.runs<ItemType>(where: (_ ItemType) -> Boolean) [every item]",
		numbers::runs(where (item) { <- item::isLessThan(9) }),
	)
	show(
		"List.runs<ItemType>(where: (_ ItemType) -> Boolean) [empty]",
		noNumbers::runs(where (item) { <- item::isLessThan(9) }),
	)

	§ ——— NestedList ———————————————————————————————————————————————————————
	show("NestedList.flatten<ItemType>()", [[1, 2], [3]]::flatten())
	show("NestedList.flatten<ItemType>() [empty]", noNestedNumbers::flatten())
	§ The shortest inner List decides how many columns there are, as
	§ `pair(with:)` decides how many pairs.
	show(
		"NestedList.transpose<ItemType>()",
		[[1, 2, 3], [4, 5, 6]]::transpose(),
	)
	show(
		"NestedList.transpose<ItemType>() [ragged]",
		[[1, 2, 3], [4]]::transpose(),
	)
	show(
		"NestedList.transpose<ItemType>() [twice]",
		[[1, 2, 3], [4, 5, 6]]::transpose()::transpose(),
	)
	show(
		"NestedList.transpose<ItemType>() [empty inner]",
		[[1, 2], noNumbers]::transpose(),
	)
	show(
		"NestedList.transpose<ItemType>() [empty]",
		noNestedNumbers::transpose(),
	)

	§ ——— OptionalList —————————————————————————————————————————————————————
	§ The Namespace a List of Optionals reaches, as `NestedList` is the one a
	§ List of Lists reaches. Each receiver is declared, because the item Type
	§ is what puts the Namespace in reach.
	constant someMaybes: List<Optional<Integer>> = [
		#Value(1),
		#Empty,
		#Value(3),
	]
	constant allEmpty: List<Optional<Integer>>   = [#Empty, #Empty]
	constant noMaybes: List<Optional<Integer>>   = []

	constant everyMaybe: List<Optional<Integer>> = [#Value(1), #Value(3)]

	show("OptionalList.values<ItemType>()", someMaybes::values())
	show("OptionalList.values<ItemType>() [all empty]", allEmpty::values())
	show("OptionalList.values<ItemType>() [empty]", noMaybes::values())
	§ Where `values` drops an item, `allValues` answers nothing at all.
	show("OptionalList.allValues<ItemType>()", everyMaybe::allValues())
	show(
		"OptionalList.allValues<ItemType>() [one empty]",
		someMaybes::allValues(),
	)
	show("OptionalList.allValues<ItemType>() [empty]", noMaybes::allValues())
	show("OptionalList.firstValue<ItemType>()", someMaybes::firstValue())
	show(
		"OptionalList.firstValue<ItemType>() [all empty]",
		allEmpty::firstValue(),
	)
	show("OptionalList.firstValue<ItemType>() [empty]", noMaybes::firstValue())

	§ ——— ResultList ———————————————————————————————————————————————————————
	§ The Namespace a List of Results reaches, beside the one a List of
	§ Optionals reaches. Each receiver is declared, because the item Type is
	§ what puts the Namespace in reach.
	constant someChecks: List<Result<Integer, String>> = [
		#Value(1),
		#Failure("first"),
		#Value(3),
		#Failure("second"),
	]
	constant everyCheck: List<Result<Integer, String>> = [#Value(1), #Value(3)]
	constant noChecks: List<Result<Integer, String>>   = []

	show("ResultList.values<ValueType, FailureType>()", someChecks::values())
	show(
		"ResultList.values<ValueType, FailureType>() [none failed]",
		everyCheck::values(),
	)
	show(
		"ResultList.values<ValueType, FailureType>() [empty]",
		noChecks::values(),
	)
	show("ResultList.reasons<ValueType, FailureType>()", someChecks::reasons())
	show(
		"ResultList.reasons<ValueType, FailureType>() [none failed]",
		everyCheck::reasons(),
	)
	show(
		"ResultList.reasons<ValueType, FailureType>() [empty]",
		noChecks::reasons(),
	)
	show(
		"ResultList.partition<ValueType, FailureType>()",
		someChecks::partition(),
	)
	show(
		"ResultList.partition<ValueType, FailureType>() [empty]",
		noChecks::partition(),
	)
	§ Where `values` drops a failed Result, `allValues` keeps every reason it
	§ found and answers no values at all.
	show(
		"ResultList.allValues<ValueType, FailureType>()",
		everyCheck::allValues(),
	)
	show(
		"ResultList.allValues<ValueType, FailureType>() [two failed]",
		someChecks::allValues(),
	)
	show(
		"ResultList.allValues<ValueType, FailureType>() [empty]",
		noChecks::allValues(),
	)

	§ ——— NonEmptyList —————————————————————————————————————————————————————————
	§ The Methods a List has to have been PROVEN to answer. A List written down
	§ with something in it is its own proof, so each receiver is declared and
	§ nothing stands in front of these calls asking anything.
	§
	§ Both item Types are here because the Alias is generic: one predicate over
	§ every List, and the Type Argument told apart by the base.
	constant provenWords: NonEmptyList<String>    = ["first", "middle", "last"]
	constant provenOne: NonEmptyList<Integer>     = [7]
	constant provenNumbers: NonEmptyList<Integer> = [3, 1, 2, 1, 4]

	show("NonEmptyList.firstItem<ItemType>()", provenWords::firstItem())
	show("NonEmptyList.lastItem<ItemType>()", provenWords::lastItem())
	show("NonEmptyList.firstItem<ItemType>() [single]", provenOne::firstItem())
	show("NonEmptyList.lastItem<ItemType>() [single]", provenOne::lastItem())
	show("NonEmptyList.length<ItemType>()", provenNumbers::length())
	show("NonEmptyList.length<ItemType>() [single]", provenOne::length())
	show("NonEmptyList.enumerate<ItemType>()", provenWords::enumerate())
	show(
		"NonEmptyList.enumerate<ItemType>() [proof carried]",
		provenWords::enumerate()::firstItem(),
	)
	show("NonEmptyList.indices<ItemType>()", provenNumbers::indices())
	show(
		"NonEmptyList.reduce<ItemType>(_ (_ ItemType, _ ItemType) -> ItemType)",
		provenNumbers::reduce((running, item) { <- running::add(item) }),
	)
	show(
		"NonEmptyList.reduce<ItemType>(_ (_ ItemType, _ ItemType) -> ItemType) [single]",
		provenOne::reduce((running, item) { <- running::add(item) }),
	)
	show(
		"NonEmptyList.lowestItem<ItemType is Comparable>()",
		provenWords::lowestItem(),
	)
	show(
		"NonEmptyList.highestItem<ItemType is Comparable>()",
		provenWords::highestItem(),
	)
	show(
		"NonEmptyList.indices<ItemType>() [proof carried]",
		provenNumbers::indices()::lastItem(),
	)

	§ The transforms that CARRY the proof rather than spending it. Each is shown
	§ twice: once for the value, which has to be the one `List`'s own entry gives
	§ for the same input, and once chained into a Method only a NonEmptyList
	§ answers. That second call is what pins the RETURN Type — an entry weakened
	§ back to `List` would send the chained `firstItem` to `List`'s own and print
	§ an Optional here.
	show(
		"NonEmptyList.prepend<ItemType>(contentsOf: List<ItemType>)",
		provenOne::prepend(contentsOf [8, 9]),
	)
	§ The List added is the EMPTY one, which is what `List`'s own entry can not
	§ get past and what this one never had to: nothing was added and the
	§ receiver was proof enough on its own.
	show(
		"NonEmptyList.prepend<ItemType>(contentsOf: List<ItemType>) [empty]",
		provenOne::prepend(contentsOf noNumbers),
	)
	show(
		"NonEmptyList.prepend<ItemType>(contentsOf: List<ItemType>) [empty, proof carried]",
		provenOne::prepend(contentsOf noNumbers)::lastItem(),
	)
	show(
		"NonEmptyList.append<ItemType>(contentsOf: List<ItemType>)",
		provenOne::append(contentsOf [8, 9]),
	)
	show(
		"NonEmptyList.append<ItemType>(contentsOf: List<ItemType>) [empty]",
		provenOne::append(contentsOf noNumbers),
	)
	show(
		"NonEmptyList.append<ItemType>(contentsOf: List<ItemType>) [empty, proof carried]",
		provenOne::append(contentsOf noNumbers)::firstItem(),
	)
	§ The item Type CHANGES here and the promise does not, because the promise
	§ is about the length: Strings go in, their lengths come out, and there are
	§ as many of one as of the other.
	show(
		"NonEmptyList.map<ItemType, Other>(_ (_ ItemType) -> Other)",
		provenWords::map((word) { <- word::length() }),
	)
	show(
		"NonEmptyList.map<ItemType, Other>(_ (_ ItemType) -> Other) [proof carried]",
		provenWords::map((word) { <- word::length() })::firstItem(),
	)
	show("NonEmptyList.reverse<ItemType>()", provenWords::reverse())
	show(
		"NonEmptyList.reverse<ItemType>() [proof carried]",
		provenWords::reverse()::firstItem(),
	)
	show(
		"NonEmptyList.sort<ItemType is Comparable>(in?: SortOrder)",
		provenNumbers::sort(),
	)
	show(
		"NonEmptyList.sort<ItemType is Comparable>(in?: SortOrder) [proof carried]",
		provenNumbers::sort()::firstItem(),
	)
	show(
		"NonEmptyList.sort<ItemType is Comparable>(in?: SortOrder) [descending]",
		provenNumbers::sort(in #Descending),
	)
	show(
		"NonEmptyList.sort<ItemType is Comparable>(in?: SortOrder) [descending, proof carried]",
		provenNumbers::sort(in #Descending)::firstItem(),
	)
	show(
		"NonEmptyList.sort<ItemType>(by: (_ ItemType, _ ItemType) -> Ordering)",
		provenNumbers::sort(by (first, second) {
			<- second::compare(to first)
		}),
	)
	show(
		"NonEmptyList.sort<ItemType>(by: (_ ItemType, _ ItemType) -> Ordering) [proof carried]",
		provenNumbers
			::sort(by (first, second) { <- second::compare(to first) })
			::firstItem(),
	)

	§ The keyed entries here spend the proof twice over: the sorted List is
	§ still proven, and the lowest and highest answer an item rather than an
	§ Optional.
	constant provenRows: NonEmptyList<{ tag: String, n: Integer }>     = [
		{ tag = "b", n = 2 },
		{ tag = "a", n = 1 },
		{ tag = "c", n = 3 },
	]
	constant tiedProvenRows: NonEmptyList<{ tag: String, n: Integer }> = [
		{ tag = "a", n = 1 },
		{ tag = "b", n = 2 },
		{ tag = "c", n = 1 },
		{ tag = "d", n = 2 },
	]

	show(
		"NonEmptyList.sort<ItemType, Key is Comparable>(on: (_ ItemType) -> Key, in?: SortOrder)",
		provenRows::sort(on .tag)::map(.n),
	)
	show(
		"NonEmptyList.sort<ItemType, Key is Comparable>(on: (_ ItemType) -> Key, in?: SortOrder) [proof carried]",
		provenRows::sort(on .tag)::firstItem(),
	)
	show(
		"NonEmptyList.sort<ItemType, Key is Comparable>(on: (_ ItemType) -> Key, in?: SortOrder) [descending]",
		provenRows::sort(on .tag, in #Descending)::map(.n),
	)
	show(
		"NonEmptyList.sort<ItemType, Key is Comparable>(on: (_ ItemType) -> Key, in?: SortOrder) [descending, tie]",
		tiedProvenRows::sort(on .n, in #Descending)::map(.tag),
	)
	show(
		"NonEmptyList.lowestItem<ItemType, Key is Comparable>(on: (_ ItemType) -> Key)",
		provenRows::lowestItem(on .n),
	)
	show(
		"NonEmptyList.highestItem<ItemType, Key is Comparable>(on: (_ ItemType) -> Key)",
		provenRows::highestItem(on .n),
	)
	show(
		"NonEmptyList.lowestItem<ItemType, Key is Comparable>(on: (_ ItemType) -> Key) [tie]",
		tiedProvenRows::lowestItem(on .n),
	)
	show(
		"NonEmptyList.highestItem<ItemType, Key is Comparable>(on: (_ ItemType) -> Key) [tie]",
		tiedProvenRows::highestItem(on .n),
	)
	show(
		"NonEmptyList.replace<ItemType>(_ ItemType, at: Integer)",
		provenNumbers::replace(99, at 0),
	)
	show(
		"NonEmptyList.replace<ItemType>(_ ItemType, at: Integer) [negative]",
		provenNumbers::replace(99, at -1),
	)
	§ The three positions that name no item at all. Each answers with the
	§ receiver untouched, which keeps the length as surely as a swap does.
	show(
		"NonEmptyList.replace<ItemType>(_ ItemType, at: Integer) [at length]",
		provenNumbers::replace(99, at provenNumbers::length()),
	)
	show(
		"NonEmptyList.replace<ItemType>(_ ItemType, at: Integer) [from the end, first]",
		provenNumbers::replace(99, at 0::subtract(provenNumbers::length())),
	)
	show(
		"NonEmptyList.replace<ItemType>(_ ItemType, at: Integer) [before the start]",
		provenNumbers::replace(99, at -99),
	)
	show(
		"NonEmptyList.replace<ItemType>(_ ItemType, at: Integer) [proof carried]",
		provenNumbers::replace(99, at -99)::lastItem(),
	)
	§ The transform entry, which carries the proof through the `by:`-shaped
	§ route: it hands the entry above an item and answers what that answers.
	show(
		"NonEmptyList.replace<ItemType>(at: Integer, _ (_ ItemType) -> ItemType)",
		provenNumbers::replace(at 0, (item) { <- item::multiply(with 10) }),
	)
	show(
		"NonEmptyList.replace<ItemType>(at: Integer, _ (_ ItemType) -> ItemType) [negative]",
		provenNumbers::replace(at -1, (item) { <- item::multiply(with 10) }),
	)
	show(
		"NonEmptyList.replace<ItemType>(at: Integer, _ (_ ItemType) -> ItemType) [before the start]",
		provenNumbers::replace(at -99, (item) { <- item::multiply(with 10) }),
	)
	show(
		"NonEmptyList.replace<ItemType>(at: Integer, _ (_ ItemType) -> ItemType) [proof carried]",
		provenNumbers
			::replace(at -99, (item) { <- item::multiply(with 10) })
			::lastItem(),
	)
	§ Pairing asks the Argument for the proof the receiver carries, since the
	§ pairing stops with the shorter of the two. One pair only, for the reason
	§ `List`'s own entry shows one.
	show(
		"NonEmptyList.pair<ItemType, Other>(with: NonEmptyList)",
		provenOne::pair(with provenWords),
	)
	show(
		"NonEmptyList.pair<ItemType, Other>(with: NonEmptyList) [proof carried]",
		provenOne::pair(with provenWords)::firstItem(),
	)
	§ Splitting carries the proof twice over: a group is opened for the first
	§ item, and every group it opens holds one. The chained call reads both
	§ back — the outer List has a first group and the group has a first item,
	§ with no Optional between them.
	show(
		"NonEmptyList.split<ItemType>(intoGroupsOf: Integer)",
		provenNumbers::split(intoGroupsOf 2),
	)
	show(
		"NonEmptyList.split<ItemType>(intoGroupsOf: Integer) [zero]",
		provenNumbers::split(intoGroupsOf 0),
	)
	show(
		"NonEmptyList.split<ItemType>(intoGroupsOf: Integer) [proof carried]",
		provenNumbers::split(intoGroupsOf 2)::firstItem()::firstItem(),
	)
	§ Deduplicating keeps the first item whatever else it drops, so a List
	§ with something in it comes out with something in it. Both entries are
	§ shown twice, as the transforms that carry the proof are: once for the
	§ value, which has to be the one `List`'s own entry gives, and once
	§ chained into a Method only a NonEmptyList answers.
	show(
		"NonEmptyList.removeDuplicates<ItemType is Equatable>()",
		provenNumbers::removeDuplicates(),
	)
	show(
		"NonEmptyList.removeDuplicates<ItemType is Equatable>() [proof carried]",
		provenNumbers::removeDuplicates()::lastItem(),
	)
	show(
		"NonEmptyList.removeDuplicates<ItemType, Key is Equatable>(on: (_ ItemType) -> Key)",
		tiedProvenRows::removeDuplicates(on .n),
	)
	show(
		"NonEmptyList.removeDuplicates<ItemType, Key is Equatable>(on: (_ ItemType) -> Key) [proof carried]",
		tiedProvenRows::removeDuplicates(on .n)::lastItem(),
	)

	§ The proofs a Method HANDS OVER rather than ones a literal carries. Each
	§ receiver below is a call to a `List` Method that says what it builds is
	§ not empty, written where a Constant of the Type would otherwise stand —
	§ so what resolves these to `NonEmptyList` is the return Type alone, with
	§ no annotation and no doorway anywhere in front of them. The label test
	§ in `stdlibGolden.spec.ts` asks which Namespace each call landed in, so
	§ a promise quietly weakened back to `List` fails here by name.
	show(
		"NonEmptyList.firstItem<ItemType>() [from List.of]",
		List.of(integersFrom 7, downTo 3)::firstItem(),
	)
	§ The receiver here is EMPTY, which is the whole of what adding an item
	§ proves: the answer has something in it however little the receiver had.
	show(
		"NonEmptyList.lastItem<ItemType>() [from List.append]",
		noNumbers::append(5)::lastItem(),
	)
	show(
		"NonEmptyList.firstItem<ItemType>() [from List.prepend]",
		noNumbers::prepend(5)::firstItem(),
	)
	§ The position is far outside the empty receiver, which is the input the
	§ promise turns on: it clamps rather than dropping the item, so there is
	§ still something in there to ask for.
	show(
		"NonEmptyList.firstItem<ItemType>() [from List.insert]",
		noNumbers::insert(5, at -99)::firstItem(),
	)

	§ ——— NonEmptyNestedList ———————————————————————————————————————————————
	§ The Namespace both proofs together reach. `NestedList::flatten` can
	§ promise nothing, because an outer List with something in it can hold
	§ nothing but empty Lists. With the inner Lists proven as well, the first
	§ group's first item is in the answer, so the answer is not empty.
	constant provenNested: NonEmptyList<NonEmptyList<Integer>> = [[1, 2], [3]]

	show("NonEmptyNestedList.flatten<ItemType>()", provenNested::flatten())
	show(
		"NonEmptyNestedList.flatten<ItemType>() [proof carried]",
		provenNested::flatten()::lastItem(),
	)
	§ The receiver a Method HANDS OVER rather than one written down, which is
	§ the same shape the proven `firstItem` lines use further up: `split` is
	§ what builds a proven List of proven Lists out of a proven List.
	show(
		"NonEmptyNestedList.flatten<ItemType>() [from NonEmptyList.split]",
		provenNumbers::split(intoGroupsOf 2)::flatten(),
	)

	§ ——— IntegerList, RationalList, NumberList ———————————————————————————
	§ The aggregates reached from the List itself. Each item Type has a
	§ Namespace of its own, so the receiver decides which one answers: a written
	§ List of Integers reaches `IntegerList`, one of Rationals `RationalList`,
	§ and a mixed one `NumberList`. Every entry delegates to the `Number` static
	§ of the same name, and the labels below are what says which Namespace the
	§ call landed in.
	constant rationals    = [3/2, 1/2, 5/2]
	constant mixedNumbers = [3, 1/2, 2]

	show("IntegerList.sum()", numbers::sum())
	show("IntegerList.sum() [empty]", noNumbers::sum())
	show("IntegerList.product()", numbers::product())
	show("IntegerList.product() [empty]", noNumbers::product())
	show("IntegerList.runningTotal()", numbers::runningTotal())
	show("IntegerList.runningTotal() [empty]", noNumbers::runningTotal())
	show(
		"IntegerList.runningTotal() [proof carried]",
		noNumbers::runningTotal()::firstItem(),
	)
	show("IntegerList.average()", numbers::average())
	show("IntegerList.average() [empty]", noNumbers::average())
	show(
		"IntegerList.average(defaultingTo: Rational)",
		numbers::average(defaultingTo 0/1),
	)
	show(
		"IntegerList.average(defaultingTo: Rational) [empty]",
		noNumbers::average(defaultingTo 0/1),
	)
	show("IntegerList.lowestNumber()", numbers::lowestNumber())
	show("IntegerList.lowestNumber() [empty]", noNumbers::lowestNumber())
	show(
		"IntegerList.lowestNumber(defaultingTo: Integer)",
		numbers::lowestNumber(defaultingTo 0),
	)
	show(
		"IntegerList.lowestNumber(defaultingTo: Integer) [empty]",
		noNumbers::lowestNumber(defaultingTo 0),
	)
	show("IntegerList.highestNumber()", numbers::highestNumber())
	show("IntegerList.highestNumber() [empty]", noNumbers::highestNumber())
	show(
		"IntegerList.highestNumber(defaultingTo: Integer)",
		numbers::highestNumber(defaultingTo 0),
	)
	show(
		"IntegerList.highestNumber(defaultingTo: Integer) [empty]",
		noNumbers::highestNumber(defaultingTo 0),
	)

	show("RationalList.sum()", rationals::sum())
	show("RationalList.sum() [empty]", noRationals::sum())
	show("RationalList.product()", rationals::product())
	show("RationalList.product() [empty]", noRationals::product())
	show("RationalList.runningTotal()", rationals::runningTotal())
	show("RationalList.runningTotal() [empty]", noRationals::runningTotal())
	show("RationalList.average()", rationals::average())
	show("RationalList.average() [empty]", noRationals::average())
	show(
		"RationalList.average(defaultingTo: Rational)",
		rationals::average(defaultingTo 0/1),
	)
	show(
		"RationalList.average(defaultingTo: Rational) [empty]",
		noRationals::average(defaultingTo 0/1),
	)
	show("RationalList.lowestNumber()", rationals::lowestNumber())
	show("RationalList.lowestNumber() [empty]", noRationals::lowestNumber())
	show(
		"RationalList.lowestNumber(defaultingTo: Rational)",
		rationals::lowestNumber(defaultingTo 0/1),
	)
	show(
		"RationalList.lowestNumber(defaultingTo: Rational) [empty]",
		noRationals::lowestNumber(defaultingTo 0/1),
	)
	show("RationalList.highestNumber()", rationals::highestNumber())
	show("RationalList.highestNumber() [empty]", noRationals::highestNumber())
	show(
		"RationalList.highestNumber(defaultingTo: Rational)",
		rationals::highestNumber(defaultingTo 0/1),
	)
	show(
		"RationalList.highestNumber(defaultingTo: Rational) [empty]",
		noRationals::highestNumber(defaultingTo 0/1),
	)

	show("NumberList.sum()", mixedNumbers::sum())
	show("NumberList.sum() [empty]", noMixedNumbers::sum())

	§ Both members of the Union answer `round` and `isWholeNumber`, so a
	§ total of mixed Numbers reaches each through Union dispatch rather
	§ than through a `match` written here.
	show(
		"Integer.round(toward?: Rounding) [union receiver]",
		twoMixedNumbers::sum()::round(),
	)
	show(
		"Integer.isWholeNumber() [union receiver]",
		twoMixedNumbers::sum()::isWholeNumber(),
	)

	show("NumberList.product()", mixedNumbers::product())
	show("NumberList.product() [empty]", noMixedNumbers::product())
	show("NumberList.runningTotal()", mixedNumbers::runningTotal())
	show("NumberList.runningTotal() [empty]", noMixedNumbers::runningTotal())
	show("NumberList.average()", mixedNumbers::average())
	show("NumberList.average() [empty]", noMixedNumbers::average())
	show(
		"NumberList.average(defaultingTo: Rational)",
		mixedNumbers::average(defaultingTo 0/1),
	)
	show(
		"NumberList.average(defaultingTo: Rational) [empty]",
		noMixedNumbers::average(defaultingTo 0/1),
	)
	show("NumberList.lowestNumber()", mixedNumbers::lowestNumber())
	show("NumberList.lowestNumber() [empty]", noMixedNumbers::lowestNumber())
	show(
		"NumberList.lowestNumber(defaultingTo: Scalar)",
		mixedNumbers::lowestNumber(defaultingTo 0),
	)
	show(
		"NumberList.lowestNumber(defaultingTo: Scalar) [empty]",
		noMixedNumbers::lowestNumber(defaultingTo 0),
	)
	show("NumberList.highestNumber()", mixedNumbers::highestNumber())
	show("NumberList.highestNumber() [empty]", noMixedNumbers::highestNumber())
	show(
		"NumberList.highestNumber(defaultingTo: Scalar)",
		mixedNumbers::highestNumber(defaultingTo 0),
	)
	show(
		"NumberList.highestNumber(defaultingTo: Scalar) [empty]",
		noMixedNumbers::highestNumber(defaultingTo 0),
	)

	§ ——— NonEmptyIntegerList, NonEmptyRationalList, NonEmptyNumberList ————
	§ The same three questions answered BARE, which is what the proof buys. A
	§ written List in receiver position has been proven nothing, so each
	§ receiver here is built by a Method that says what it builds is not empty
	§ — `append` and `List.of` — and the label is what says the call landed in
	§ the proven Namespace rather than the general one.
	show(
		"NonEmptyIntegerList.lowestNumber()",
		noNumbers::append(5)::append(2)::lowestNumber(),
	)
	show(
		"NonEmptyIntegerList.highestNumber()",
		noNumbers::append(5)::append(2)::highestNumber(),
	)
	show(
		"NonEmptyIntegerList.average()",
		List.of(integersFrom 4, downTo 1)::average(),
	)
	show(
		"NonEmptyIntegerList.average() [single]",
		noNumbers::append(5)::average(),
	)
	show(
		"NonEmptyRationalList.lowestNumber()",
		noRationals::append(3/2)::append(1/2)::lowestNumber(),
	)
	show(
		"NonEmptyRationalList.highestNumber()",
		noRationals::append(3/2)::append(1/2)::highestNumber(),
	)
	show(
		"NonEmptyRationalList.average()",
		noRationals::append(3/2)::append(1/2)::average(),
	)
	show(
		"NonEmptyNumberList.lowestNumber()",
		noMixedNumbers::append(3)::append(1/2)::lowestNumber(),
	)
	show(
		"NonEmptyNumberList.highestNumber()",
		noMixedNumbers::append(3)::append(1/2)::highestNumber(),
	)
	§ The total is an Integer here and a Rational in the call below it, so both
	§ arms of the match are walked.
	show(
		"NonEmptyNumberList.average()",
		noMixedNumbers::append(3)::append(1)::average(),
	)
	show(
		"NonEmptyNumberList.average() [rational total]",
		noMixedNumbers::append(3)::append(1/2)::average(),
	)

	§ ——— KeyedNumberList —————————————————————————————————————————————————
	§ The same aggregates over a List of anything, reached through a key. What
	§ has to be a number is what the key answers, so the receiver here is a
	§ List of Records and the label says which entry the key picked.
	show(
		"KeyedNumberList.sum<ItemType>(on: (_ ItemType) -> Integer)",
		rows::sum(on .n),
	)
	show(
		"KeyedNumberList.sum<ItemType>(on: (_ ItemType) -> Integer) [empty]",
		noRows::sum(on .n),
	)
	show(
		"KeyedNumberList.sum<ItemType>(on: (_ ItemType) -> Rational)",
		rows::sum(on .r),
	)
	show(
		"KeyedNumberList.sum<ItemType>(on: (_ ItemType) -> Scalar)",
		rows::sum(on .m),
	)
	show(
		"KeyedNumberList.average<ItemType>(on: (_ ItemType) -> Scalar)",
		rows::average(on .n),
	)
	show(
		"KeyedNumberList.average<ItemType>(on: (_ ItemType) -> Scalar) [empty]",
		noRows::average(on .n),
	)
	show(
		"KeyedNumberList.average<ItemType>(on: (_ ItemType) -> Scalar, defaultingTo: Rational)",
		rows::average(on .r, defaultingTo 0/1),
	)
	show(
		"KeyedNumberList.average<ItemType>(on: (_ ItemType) -> Scalar, defaultingTo: Rational) [empty]",
		noRows::average(on .r, defaultingTo 0/1),
	)

	§ ——— NonEmptyKeyedNumberList —————————————————————————————————————————
	§ The one keyed aggregate the proof changes: `map` carries it to the List
	§ of numbers, whose mean is bare. `sum(on:)` is total already, so a proven
	§ receiver keeps reaching `KeyedNumberList` for it.
	show(
		"NonEmptyKeyedNumberList.average<ItemType>(on: (_ ItemType) -> Scalar)",
		provenRows::average(on .n),
	)
	show(
		"KeyedNumberList.sum<ItemType>(on: (_ ItemType) -> Integer) [proven receiver]",
		provenRows::sum(on .n),
	)

	§ ——— Dictionary ———————————————————————————————————————————————————————
	§ The second container, and the first Type with two Type Parameters. Every
	§ Dictionary printed here reads the way one is written — `["a" = 1]`, and
	§ `[=]` for the empty one — because `show` renders through the Printable
	§ conformance, which a Dictionary has whenever its keys and its values do.
	§
	§ `Dictionary.of` reads both of its Type Arguments off the entries it is
	§ handed, and an empty List of entries carries neither — so the receiver
	§ this section builds its `[empty]` answers from is a List annotated where
	§ it stands. Written down, the empty Dictionary is `[=]`.
	constant noPairs: List<{ key: String, value: Integer }> = []
	constant noKeys: List<String> = []
	constant ages          = Dictionary.of([
		{ key = "alex", value = 39 },
		{ key = "sam", value = 25 },
	])
	constant noAges        = Dictionary.of(noPairs)
	constant raises        = Dictionary.of([
		{ key = "sam", value = 1 },
		{ key = "kim", value = 2 },
	])
	§ The same entries in the other order. Equality is order-insensitive, so
	§ this is the receiver that says so.
	constant agesReordered = Dictionary.of([
		{ key = "sam", value = 25 },
		{ key = "alex", value = 39 },
	])
	constant codes         = Dictionary.of([{ key = "a", value = "b" }])

	show(
		"Dictionary.of<ValueType, KeyType is Equatable>(_ List<\{ key: KeyType, value: ValueType \}>)",
		Dictionary.of([
			{ key = "alex", value = 39 },
			{ key = "sam", value = 25 },
		]),
	)
	§ A later entry with a key already there wins, and the key keeps the place
	§ its first occurrence gave it.
	show(
		"Dictionary.of<ValueType, KeyType is Equatable>(_ List<\{ key: KeyType, value: ValueType \}>) [duplicate key]",
		Dictionary.of([
			{ key = "alex", value = 39 },
			{ key = "sam", value = 25 },
			{ key = "alex", value = 40 },
		]),
	)
	show(
		"Dictionary.of<ValueType, KeyType is Equatable>(_ List<\{ key: KeyType, value: ValueType \}>) [empty]",
		Dictionary.of(noPairs),
	)
	§ The second entry is handed the keys alone and asks a Function for each
	§ value. A key written down twice keeps its first place and the second
	§ answer, exactly as a duplicate entry does above.
	show(
		"Dictionary.of<ValueType, KeyType is Equatable>(_ List<KeyType>, valuedBy: (_ KeyType) -> ValueType)",
		Dictionary.of(["alex", "sam"], valuedBy (name) { <- name::length() }),
	)
	show(
		"Dictionary.of<ValueType, KeyType is Equatable>(_ List<KeyType>, valuedBy: (_ KeyType) -> ValueType) [duplicate key]",
		Dictionary.of(["alex", "sam", "alex"], valuedBy (name) {
			<- name::length()
		}),
	)
	show(
		"Dictionary.of<ValueType, KeyType is Equatable>(_ List<KeyType>, valuedBy: (_ KeyType) -> ValueType) [empty]",
		Dictionary.of(noKeys, valuedBy (name) { <- name::length() }),
	)
	show(
		"Dictionary.is<KeyType is Equatable, ValueType is Equatable>(_ Dictionary<KeyType, ValueType>)",
		ages::is(ages),
	)
	show(
		"Dictionary.is<KeyType is Equatable, ValueType is Equatable>(_ Dictionary<KeyType, ValueType>) [reordered]",
		ages::is(agesReordered),
	)
	show(
		"Dictionary.is<KeyType is Equatable, ValueType is Equatable>(_ Dictionary<KeyType, ValueType>) [differing]",
		ages::is(raises),
	)
	show(
		"Dictionary.is<KeyType is Equatable, ValueType is Equatable>(_ Dictionary<KeyType, ValueType>) [both empty]",
		noAges::is(Dictionary.of(noPairs)),
	)
	show(
		"Dictionary.isNot(_ Dictionary<KeyType, ValueType>)",
		ages::isNot(raises),
	)
	show(
		"Dictionary.isNot(_ Dictionary<KeyType, ValueType>) [equal]",
		ages::isNot(agesReordered),
	)
	show(
		"Dictionary.toString<KeyType is Printable, ValueType is Printable>()",
		ages::toString(),
	)
	§ The empty Dictionary reads `[=]`, which is what tells it from the empty
	§ List, and a String is quoted on either side of the `=`.
	show(
		"Dictionary.toString<KeyType is Printable, ValueType is Printable>() [empty]",
		noAges::toString(),
	)
	show(
		"Dictionary.toString<KeyType is Printable, ValueType is Printable>() [String values]",
		codes::toString(),
	)
	show("Dictionary.isEmpty<KeyType, ValueType>()", ages::isEmpty())
	show("Dictionary.isEmpty<KeyType, ValueType>() [empty]", noAges::isEmpty())
	show("Dictionary.hasEntries<KeyType, ValueType>()", ages::hasEntries())
	show(
		"Dictionary.hasEntries<KeyType, ValueType>() [empty]",
		noAges::hasEntries(),
	)
	§ The quantified entry stops at the entry that decides the answer, and the
	§ empty Dictionary has none to offer the check.
	show(
		"Dictionary.hasEntries<KeyType, ValueType>(where: (_ \{ key: KeyType, value: ValueType \}) -> Boolean)",
		ages::hasEntries(where ({ key, value }) {
			<- value::isGreaterThan(30)
		}),
	)
	show(
		"Dictionary.hasEntries<KeyType, ValueType>(where: (_ \{ key: KeyType, value: ValueType \}) -> Boolean) [nothing accepted]",
		ages::hasEntries(where ({ key, value }) {
			<- value::isGreaterThan(99)
		}),
	)
	show(
		"Dictionary.hasEntries<KeyType, ValueType>(where: (_ \{ key: KeyType, value: ValueType \}) -> Boolean) [empty]",
		noAges::hasEntries(where ({ key, value }) {
			<- value::isGreaterThan(0)
		}),
	)
	show(
		"Dictionary.hasKey<ValueType, KeyType is Equatable>(_ KeyType)",
		ages::hasKey("alex"),
	)
	show(
		"Dictionary.hasKey<ValueType, KeyType is Equatable>(_ KeyType) [absent]",
		ages::hasKey("kim"),
	)
	§ The same question about the other half of an entry, which walks the
	§ values where a key is found through the store.
	show(
		"Dictionary.hasValue<KeyType, ValueType is Equatable>(_ ValueType)",
		ages::hasValue(25),
	)
	show(
		"Dictionary.hasValue<KeyType, ValueType is Equatable>(_ ValueType) [absent]",
		ages::hasValue(1),
	)
	§ The universal quantifier answers `true` for the empty Dictionary, which
	§ has no entry to fail the check, and so does the empty one.
	show(
		"Dictionary.hasOnlyEntries<KeyType, ValueType>(where: (_ \{ key: KeyType, value: ValueType \}) -> Boolean)",
		ages::hasOnlyEntries(where ({ key, value }) {
			<- value::isGreaterThan(20)
		}),
	)
	show(
		"Dictionary.hasOnlyEntries<KeyType, ValueType>(where: (_ \{ key: KeyType, value: ValueType \}) -> Boolean) [one refused]",
		ages::hasOnlyEntries(where ({ key, value }) {
			<- value::isGreaterThan(30)
		}),
	)
	show(
		"Dictionary.hasOnlyEntries<KeyType, ValueType>(where: (_ \{ key: KeyType, value: ValueType \}) -> Boolean) [empty]",
		noAges::hasOnlyEntries(where ({ key, value }) {
			<- value::isGreaterThan(30)
		}),
	)
	show(
		"Dictionary.hasNoEntries<KeyType, ValueType>(where: (_ \{ key: KeyType, value: ValueType \}) -> Boolean)",
		ages::hasNoEntries(where ({ key, value }) {
			<- value::isGreaterThan(50)
		}),
	)
	show(
		"Dictionary.hasNoEntries<KeyType, ValueType>(where: (_ \{ key: KeyType, value: ValueType \}) -> Boolean) [one accepted]",
		ages::hasNoEntries(where ({ key, value }) {
			<- value::isGreaterThan(30)
		}),
	)
	show(
		"Dictionary.hasNoEntries<KeyType, ValueType>(where: (_ \{ key: KeyType, value: ValueType \}) -> Boolean) [empty]",
		noAges::hasNoEntries(where ({ key, value }) {
			<- value::isGreaterThan(30)
		}),
	)
	show("Dictionary.length<KeyType, ValueType>()", ages::length())
	show("Dictionary.length<KeyType, ValueType>() [empty]", noAges::length())
	show(
		"Dictionary.value<ValueType, KeyType is Equatable>(at: KeyType)",
		ages::value(at "alex"),
	)
	show(
		"Dictionary.value<ValueType, KeyType is Equatable>(at: KeyType) [absent]",
		ages::value(at "kim"),
	)
	show(
		"Dictionary.value<ValueType, KeyType is Equatable>(at: KeyType, defaultingTo: ValueType)",
		ages::value(at "alex", defaultingTo 0),
	)
	show(
		"Dictionary.value<ValueType, KeyType is Equatable>(at: KeyType, defaultingTo: ValueType) [absent]",
		ages::value(at "kim", defaultingTo 0),
	)
	show("Dictionary.keys<KeyType, ValueType>()", ages::keys())
	show("Dictionary.keys<KeyType, ValueType>() [empty]", noAges::keys())
	show("Dictionary.values<KeyType, ValueType>()", ages::values())
	show("Dictionary.entries<KeyType, ValueType>()", ages::entries())
	§ The one reading that answers a position. The empty Dictionary has no
	§ first entry, and the `defaultingTo:` entry answers the caller's instead.
	show("Dictionary.firstEntry<KeyType, ValueType>()", ages::firstEntry())
	show(
		"Dictionary.firstEntry<KeyType, ValueType>() [empty]",
		noAges::firstEntry(),
	)
	§ A removed key leaves a tombstoned slot standing where it was, and the
	§ first entry is the first LIVE one rather than the first slot.
	show(
		"Dictionary.firstEntry<KeyType, ValueType>() [after a removal]",
		ages::remove(at "alex")::firstEntry(),
	)
	show(
		"Dictionary.firstEntry<KeyType, ValueType>(defaultingTo: \{ key: KeyType, value: ValueType \})",
		ages::firstEntry(defaultingTo { key = "nobody", value = 0 }),
	)
	show(
		"Dictionary.firstEntry<KeyType, ValueType>(defaultingTo: \{ key: KeyType, value: ValueType \}) [empty]",
		noAges::firstEntry(defaultingTo { key = "nobody", value = 0 }),
	)
	show(
		"Dictionary.set<ValueType, KeyType is Equatable>(_ KeyType, to: ValueType)",
		ages::set("kim", to 7),
	)
	§ A key that is already there keeps the place it had, wherever the new
	§ value came from.
	show(
		"Dictionary.set<ValueType, KeyType is Equatable>(_ KeyType, to: ValueType) [overwrite keeps its place]",
		ages::set("alex", to 40),
	)
	§ And a key that was REMOVED lands at the end when it comes back, which is
	§ the other half of the same rule.
	show(
		"Dictionary.set<ValueType, KeyType is Equatable>(_ KeyType, to: ValueType) [set again after a removal]",
		ages::remove(at "alex")::set("alex", to 40),
	)
	show(
		"Dictionary.update<ValueType, KeyType is Equatable>(at: KeyType, with: (_ ValueType) -> ValueType)",
		ages::update(at "alex", with (age) { <- age::add(1) }),
	)
	show(
		"Dictionary.update<ValueType, KeyType is Equatable>(at: KeyType, with: (_ ValueType) -> ValueType) [absent]",
		ages::update(at "kim", with (age) { <- age::add(1) }),
	)
	show(
		"Dictionary.update<ValueType, KeyType is Equatable>(at: KeyType, defaultingTo: ValueType, with: (_ ValueType) -> ValueType)",
		ages::update(at "alex", defaultingTo 0, with (age) { <- age::add(1) }),
	)
	show(
		"Dictionary.update<ValueType, KeyType is Equatable>(at: KeyType, defaultingTo: ValueType, with: (_ ValueType) -> ValueType) [absent]",
		ages::update(at "kim", defaultingTo 0, with (age) { <- age::add(1) }),
	)
	show(
		"Dictionary.remove<ValueType, KeyType is Equatable>(at: KeyType)",
		ages::remove(at "alex"),
	)
	show(
		"Dictionary.remove<ValueType, KeyType is Equatable>(at: KeyType) [absent]",
		ages::remove(at "kim"),
	)
	§ The plural entry removes a key it is handed twice once, and leaves a key
	§ nothing holds alone. The empty List is the receiver back.
	show(
		"Dictionary.remove<ValueType, KeyType is Equatable>(atEvery: List<KeyType>)",
		ages::remove(atEvery ["alex", "kim"]),
	)
	show(
		"Dictionary.remove<ValueType, KeyType is Equatable>(atEvery: List<KeyType>) [repeated and absent]",
		ages::remove(atEvery ["alex", "alex", "kim"]),
	)
	show(
		"Dictionary.remove<ValueType, KeyType is Equatable>(atEvery: List<KeyType>) [nothing named]",
		ages::remove(atEvery noKeys),
	)
	show(
		"Dictionary.remove<ValueType, KeyType is Equatable>(atEvery: List<KeyType>) [every key]",
		ages::remove(atEvery ages::keys()),
	)
	§ Every callback here is handed the entry Record, so a Pattern takes it
	§ apart where it stands.
	show(
		"Dictionary.removeEvery<KeyType, ValueType>(where: (_ \{ key: KeyType, value: ValueType \}) -> Boolean)",
		ages::removeEvery(where ({ key, value }) {
			<- value::isGreaterThan(30)
		}),
	)
	show(
		"Dictionary.removeEvery<KeyType, ValueType>(where: (_ \{ key: KeyType, value: ValueType \}) -> Boolean) [nothing accepted]",
		ages::removeEvery(where ({ key, value }) { <- key::is("nobody") }),
	)
	show(
		"Dictionary.everyEntry<KeyType, ValueType>(where: (_ \{ key: KeyType, value: ValueType \}) -> Boolean)",
		ages::everyEntry(where ({ key, value }) {
			<- value::isGreaterThan(30)
		}),
	)
	show(
		"Dictionary.everyEntry<KeyType, ValueType>(where: (_ \{ key: KeyType, value: ValueType \}) -> Boolean) [nothing accepted]",
		ages::everyEntry(where ({ key, value }) { <- key::is("nobody") }),
	)
	show(
		"Dictionary.map<KeyType, ValueType, Other>(_ (_ \{ key: KeyType, value: ValueType \}) -> Other)",
		ages::map(({ key, value }) { <- "{key}:{value}" }),
	)
	show(
		"Dictionary.map<KeyType, ValueType, Other>(_ (_ \{ key: KeyType, value: ValueType \}) -> Other) [empty]",
		noAges::map(({ key, value }) { <- "{key}:{value}" }),
	)
	§ The Argument wins on a key both hold, and a key only the Argument holds
	§ is added at the end.
	show(
		"Dictionary.merge<ValueType, KeyType is Equatable>(with: Dictionary<KeyType, ValueType>)",
		ages::merge(with raises),
	)
	show(
		"Dictionary.merge<ValueType, KeyType is Equatable>(with: Dictionary<KeyType, ValueType>) [empty argument]",
		ages::merge(with noAges),
	)
	§ Unless the caller says otherwise. The Function is handed the receiver's
	§ value first and the Argument's second.
	show(
		"Dictionary.merge<ValueType, KeyType is Equatable>(with: Dictionary<KeyType, ValueType>, choosing: (_ ValueType, _ ValueType) -> ValueType)",
		ages::merge(with raises, choosing (mine, theirs) {
			<- mine::add(theirs)
		}),
	)
	§ Merging INTO the empty Dictionary is the Argument, entry for entry: the
	§ receiver holds no key for the Argument to lose one to.
	show(
		"Dictionary.merge<ValueType, KeyType is Equatable>(with: Dictionary<KeyType, ValueType>) [empty receiver]",
		noAges::merge(with ages),
	)
	§ A Dictionary is ordered, so ordering it is a question it can answer. The
	§ receiver is written out of order here, and `scrambled` holds two entries
	§ under one value so the stability of both directions is visible.
	constant scrambled = Dictionary.of([
		{ key = "sam", value = 25 },
		{ key = "alex", value = 39 },
		{ key = "kim", value = 25 },
	])

	show(
		"Dictionary.sort<ValueType, KeyType is Comparable>(in?: SortOrder)",
		scrambled::sort(),
	)
	show(
		"Dictionary.sort<ValueType, KeyType is Comparable>(in?: SortOrder) [descending]",
		scrambled::sort(in #Descending),
	)
	show(
		"Dictionary.sort<ValueType, KeyType is Comparable>(in?: SortOrder) [empty]",
		noAges::sort(),
	)
	§ Two entries whose keys compare equal keep the order they had, whichever
	§ way the sort runs — `sam` stands before `kim` in the receiver and in both
	§ answers.
	show(
		"Dictionary.sort<KeyType, ValueType, Key is Comparable>(on: (_ \{ key: KeyType, value: ValueType \}) -> Key, in?: SortOrder)",
		scrambled::sort(on .value),
	)
	show(
		"Dictionary.sort<KeyType, ValueType, Key is Comparable>(on: (_ \{ key: KeyType, value: ValueType \}) -> Key, in?: SortOrder) [descending]",
		scrambled::sort(on .value, in #Descending),
	)

	§ Counting sees every entry whatever it answers, so the empty Dictionary
	§ and a check nothing passes both answer none.
	show(
		"Dictionary.count<KeyType, ValueType>(where: (_ \{ key: KeyType, value: ValueType \}) -> Boolean)",
		ages::count(where ({ key, value }) { <- value::isGreaterThan(30) }),
	)
	show(
		"Dictionary.count<KeyType, ValueType>(where: (_ \{ key: KeyType, value: ValueType \}) -> Boolean) [nothing accepted]",
		ages::count(where ({ key, value }) { <- key::is("nobody") }),
	)
	show(
		"Dictionary.count<KeyType, ValueType>(where: (_ \{ key: KeyType, value: ValueType \}) -> Boolean) [empty]",
		noAges::count(where ({ key, value }) { <- value::isGreaterThan(0) }),
	)

	§ The edges the pairs above stop one short of. A check that accepts EVERY
	§ entry answers the empty Dictionary, and the empty Dictionary has parts to
	§ answer with as much as any other.
	show(
		"Dictionary.removeEvery<KeyType, ValueType>(where: (_ \{ key: KeyType, value: ValueType \}) -> Boolean) [everything accepted]",
		ages::removeEvery(where ({ key, value }) {
			<- value::isGreaterThan(0)
		}),
	)
	show("Dictionary.values<KeyType, ValueType>() [empty]", noAges::values())
	show("Dictionary.entries<KeyType, ValueType>() [empty]", noAges::entries())

	§ A Dictionary is Printable whenever its keys and its values are, and a
	§ Dictionary is one of the values that can be — so a Dictionary of
	§ Dictionaries prints as the brackets it is written in, all the way down.
	constant nestedAges = ["held" = ages, "none" = noAges]

	show(
		"Dictionary.toString<KeyType is Printable, ValueType is Printable>() [nested]",
		nestedAges::toString(),
	)

	§ Two keys are ONE key when the keys' own `is` says so, and under a
	§ covering `Number` that crosses the kinds: `3/1` is the Integer `3`, so
	§ setting it overwrites rather than adds.
	constant threes: Dictionary<Number, String> = [3 = "integer"]

	show(
		"Dictionary.set<ValueType, KeyType is Equatable>(_ KeyType, to: ValueType) [a whole Rational is its Integer]",
		threes::set(3/1, to "rational"),
	)

	§ A key with no canonical encoding — a Record — is found by asking the
	§ Record's own `is` of every key the Dictionary holds. It costs a walk
	§ rather than a lookup, and nothing about it is visible from here.
	constant seats: Dictionary<{ row: Integer, seat: Integer }, String> = [
		{ row = 1, seat = 2 } = "alex",
		{ row = 4, seat = 1 } = "sam",
	]

	show(
		"Dictionary.value<ValueType, KeyType is Equatable>(at: KeyType) [Record key]",
		seats::value(at { row = 4, seat = 1 }),
	)

	§ ——— NonEmptyDictionary ———————————————————————————————————————————————
	§ The Methods a Dictionary has to have been PROVEN to answer. A Dictionary
	§ written down with an entry in it is its own proof, so the receiver is
	§ declared and nothing stands in front of these calls asking anything.
	constant provenAges: NonEmptyDictionary<String, Integer> = [
		"alex" = 39,
		"sam" = 25,
	]

	show(
		"NonEmptyDictionary.length<KeyType, ValueType>()",
		provenAges::length(),
	)
	show("NonEmptyDictionary.keys<KeyType, ValueType>()", provenAges::keys())
	show(
		"NonEmptyDictionary.values<KeyType, ValueType>()",
		provenAges::values(),
	)
	show(
		"NonEmptyDictionary.entries<KeyType, ValueType>()",
		provenAges::entries(),
	)
	§ The proof spends the Optional `Dictionary`'s own entry answers, so the
	§ entry itself is what a proven receiver reads.
	show(
		"NonEmptyDictionary.firstEntry<KeyType, ValueType>()",
		provenAges::firstEntry(),
	)
	show(
		"NonEmptyDictionary.firstEntry<KeyType, ValueType>() [proof spent]",
		provenAges::firstEntry().value,
	)
	§ Each of the three halves carries its own proof into the answer, which is
	§ what a total `firstItem` reads off it.
	show(
		"NonEmptyDictionary.keys<KeyType, ValueType>() [proof carried]",
		provenAges::keys()::firstItem(),
	)
	show(
		"NonEmptyDictionary.values<KeyType, ValueType>() [proof carried]",
		provenAges::values()::firstItem(),
	)
	show(
		"NonEmptyDictionary.entries<KeyType, ValueType>() [proof carried]",
		provenAges::entries()::firstItem().key,
	)
	show(
		"NonEmptyDictionary.map<KeyType, ValueType, Other>(_ (_ \{ key: KeyType, value: ValueType \}) -> Other)",
		provenAges::map(({ key, value }) { <- value::add(1) }),
	)
	show(
		"NonEmptyDictionary.map<KeyType, ValueType, Other>(_ (_ \{ key: KeyType, value: ValueType \}) -> Other) [proof carried]",
		provenAges::map(({ key, value }) { <- value::add(1) })::length(),
	)
	§ A reordering answers the entries it was handed, so a proven receiver
	§ comes out proven and its `length` is above zero without an `if`.
	show(
		"NonEmptyDictionary.sort<ValueType, KeyType is Comparable>(in?: SortOrder)",
		provenAges::sort(in #Descending),
	)
	show(
		"NonEmptyDictionary.sort<ValueType, KeyType is Comparable>(in?: SortOrder) [proof carried]",
		provenAges::sort()::length(),
	)
	show(
		"NonEmptyDictionary.sort<KeyType, ValueType, Key is Comparable>(on: (_ \{ key: KeyType, value: ValueType \}) -> Key, in?: SortOrder)",
		provenAges::sort(on .value),
	)
	show(
		"NonEmptyDictionary.sort<KeyType, ValueType, Key is Comparable>(on: (_ \{ key: KeyType, value: ValueType \}) -> Key, in?: SortOrder) [proof carried]",
		provenAges::sort(on .value)::keys()::firstItem(),
	)
	§ Setting a key answers this Type on `Dictionary` itself, whatever it was
	§ handed, so even the empty Dictionary answers a proven one.
	show(
		"Dictionary.set<ValueType, KeyType is Equatable>(_ KeyType, to: ValueType) [the answer is proven]",
		noAges::set("kim", to 7)::length(),
	)

	§ ——— GroupedList ——————————————————————————————————————————————————————
	§ The bridge from the first container to the second: the receiver is a
	§ List and the answer is a Dictionary. Each group holds an item and each
	§ count is above zero, which only the native that built them can promise.
	§ The receivers here are computed, because a List written where it stands
	§ proves its own count and would reach the proven Namespace below instead.
	constant seatedGuests = [
		{ name = "alex", home = "north" },
		{ name = "sam", home = "south" },
		{ name = "kim", home = "north" },
	]
	constant votes        = ["a", "b", "a", "c", "a"]
	constant noVotes: List<String> = []

	show(
		"GroupedList.group<ItemType, Key is Equatable>(on: (_ ItemType) -> Key)",
		seatedGuests
			::group(on (guest) { <- guest.home })
			::map(({ key, value }) {
				<- value::map((guest) { <- guest.name })
			}),
	)
	show(
		"GroupedList.group<ItemType, Key is Equatable>(on: (_ ItemType) -> Key) [Boolean key]",
		numbers::group(on (item) { <- item::isEven() }),
	)
	show(
		"GroupedList.group<ItemType, Key is Equatable>(on: (_ ItemType) -> Key) [empty]",
		noVotes::group(on (vote) { <- vote }),
	)
	§ Every group holds at least one item, which is what a total `firstItem`
	§ read off a group says.
	show(
		"GroupedList.group<ItemType, Key is Equatable>(on: (_ ItemType) -> Key) [proven groups]",
		votes
			::group(on (vote) { <- vote })
			::map(({ key, value }) { <- value::firstItem() }),
	)
	§ The groups as a List of Records, which is what `entries` recovers. The
	§ key is read with a member path, as `sort(on:)` reads its key, and the
	§ items are read down to their tags for the reason the `[tie]` lines above
	§ are: a Record per item would wrap the line.
	show(
		"GroupedList.group<ItemType, Key is Equatable>(on: (_ ItemType) -> Key) [entries]",
		tiedRows
			::group(on .n)
			::entries()
			::map(({ key, value }) { <- { key, tags = value::map(.tag) } }),
	)
	show("GroupedList.tally<ItemType is Equatable>()", votes::tally())
	show("GroupedList.tally<ItemType is Equatable>() [empty]", noVotes::tally())
	§ One item per key. A later item with the same key replaces the earlier
	§ one as the value, and the key keeps the place it was first met at, which
	§ is what the order of the keys pins.
	show(
		"GroupedList.index<ItemType, Key is Equatable>(on: (_ ItemType) -> Key)",
		seatedGuests::index(on .home)::map(({ key, value }) { <- value.name }),
	)
	show(
		"GroupedList.index<ItemType, Key is Equatable>(on: (_ ItemType) -> Key) [distinct keys]",
		seatedGuests::index(on .name)::keys(),
	)
	show(
		"GroupedList.index<ItemType, Key is Equatable>(on: (_ ItemType) -> Key) [empty]",
		noVotes::index(on (vote) { <- vote }),
	)

	§ ——— GroupedNonEmptyList ——————————————————————————————————————————————
	§ The same crossings with the receiver's proof in hand. A List with an
	§ item in it puts that item in a group, under a count, or at a key, so the
	§ Dictionary each answers holds an entry — which is what the total `length`
	§ reads off it.
	constant provenVotes: NonEmptyList<String> = ["a", "b", "a"]

	show(
		"GroupedNonEmptyList.group<ItemType, Key is Equatable>(on: (_ ItemType) -> Key)",
		provenVotes::group(on (vote) { <- vote })::length(),
	)
	show(
		"GroupedNonEmptyList.tally<ItemType is Equatable>()",
		provenVotes::tally()::length(),
	)
	show(
		"GroupedNonEmptyList.index<ItemType, Key is Equatable>(on: (_ ItemType) -> Key)",
		provenVotes::index(on (vote) { <- vote })::length(),
	)

	§ ——— loop ————————————————————————————————————————————————————————————
	§ The free-Function loop family. `loop` belongs to no Namespace, so its
	§ labels carry no prefix — the coverage net learns them from the member
	§ table just as it learns a Namespace's Methods. The body is positional
	§ where it runs the walk to its end, and labelled `step` where it answers
	§ with a `Step` and can leave early.
	show(
		"loop<State>(from: Integer, through: Integer, startingWith: State, _ (_ Integer, _ State) -> State)",
		loop(from 1, through 5, startingWith 0, (index, total) {
			<- total::add(index)
		}),
	)
	show(
		"loop<State>(from: Integer, through: Integer, startingWith: State, _ (_ Integer, _ State) -> State) [end below the start]",
		loop(from 3, through 1, startingWith 99, (index, total) {
			<- total::add(index)
		}),
	)
	show(
		"loop<State>(from: Integer, upTo: Integer, startingWith: State, _ (_ Integer, _ State) -> State)",
		loop(from 0, upTo 5, startingWith 0, (index, total) {
			<- total::add(index)
		}),
	)
	show(
		"loop<State>(from: Integer, upTo: Integer, startingWith: State, _ (_ Integer, _ State) -> State) [zero turns]",
		loop(from 0, upTo 0, startingWith 99, (index, total) {
			<- total::add(index)
		}),
	)
	show(
		"loop<State>(from: Integer, downTo: Integer, startingWith: State, _ (_ Integer, _ State) -> State)",
		loop(from 3, downTo 1, startingWith "", (index, acc) {
			<- acc::append(index::toString())
		}),
	)
	show(
		"loop<State>(from: Integer, downTo: Integer, startingWith: State, _ (_ Integer, _ State) -> State) [end above the start]",
		loop(from 3, downTo 9, startingWith "", (index, acc) {
			<- acc::append(index::toString())
		}),
	)
	show(
		"loop<State>(startingWith: State, while: (_ State) -> Boolean, _ (_ State) -> State)",
		loop(startingWith 1, while (n) { <- n::isLessThan(100) }, (n) {
			<- n::multiply(with 2)
		}),
	)
	show(
		"loop<State>(startingWith: State, while: (_ State) -> Boolean, _ (_ State) -> State) [zero turns]",
		loop(startingWith 500, while (n) { <- n::isLessThan(100) }, (n) {
			<- n::multiply(with 2)
		}),
	)
	show(
		"loop<State>(startingWith: State, until: (_ State) -> Boolean, _ (_ State) -> State)",
		loop(
			startingWith 1,
			until (n) { <- n::isGreaterThanOrEqualTo(100) },
			(n) { <- n::multiply(with 2) },
		),
	)
	show(
		"loop<State>(startingWith: State, until: (_ State) -> Boolean, _ (_ State) -> State) [zero turns]",
		loop(
			startingWith 500,
			until (n) { <- n::isGreaterThanOrEqualTo(100) },
			(n) { <- n::multiply(with 2) },
		),
	)
	show(
		"loop<State, Answer>(startingWith: State, step: (_ State) -> Step<State, Answer>)",
		loop(
			startingWith { index = 1, total = 0 },
			step ({ index, total } as state) {
				if index::isGreaterThan(5) {
					<- #Done(total)
				}

				<- #Continue({
					state with
						index = index::add(1),
						total = total::add(index),
				})
			},
		),
	)

	§ The counted entries whose body answers a `Step`. Each is shown twice:
	§ once where the body leaves early, and once where the count runs out and
	§ the State it carried is the answer.
	show(
		"loop<State>(from: Integer, through: Integer, startingWith: State, step: (_ Integer, _ State) -> Step<State, State>)",
		loop(from 1, through 100, startingWith 0, step (index, total) {
			constant next = total::add(index)

			if next::isGreaterThan(10) {
				<- #Done(next)
			}

			<- #Continue(next)
		}),
	)
	show(
		"loop<State>(from: Integer, through: Integer, startingWith: State, step: (_ Integer, _ State) -> Step<State, State>) [count runs out]",
		loop(from 1, through 4, startingWith 0, step (index, total) {
			<- #Continue(total::add(index))
		}),
	)
	show(
		"loop<State>(from: Integer, through: Integer, startingWith: State, step: (_ Integer, _ State) -> Step<State, State>) [end below the start]",
		loop(from 5, through 1, startingWith 42, step (index, total) {
			<- #Continue(total::add(index))
		}),
	)
	show(
		"loop<State>(from: Integer, upTo: Integer, startingWith: State, step: (_ Integer, _ State) -> Step<State, State>)",
		loop(from 0, upTo 5, startingWith 0, step (index, total) {
			<- #Continue(total::add(index))
		}),
	)
	show(
		"loop<State>(from: Integer, upTo: Integer, startingWith: State, step: (_ Integer, _ State) -> Step<State, State>) [zero turns]",
		loop(from 0, upTo 0, startingWith 7, step (index, total) {
			<- #Continue(total::add(index))
		}),
	)
	show(
		"loop<State>(from: Integer, downTo: Integer, startingWith: State, step: (_ Integer, _ State) -> Step<State, State>)",
		loop(from 5, downTo 1, startingWith "", step (index, acc) {
			constant next = acc::append(index::toString())

			if next::length()::is(3) {
				<- #Done(next)
			}

			<- #Continue(next)
		}),
	)
	show(
		"loop<State>(from: Integer, downTo: Integer, startingWith: State, step: (_ Integer, _ State) -> Step<State, State>) [count runs out]",
		loop(from 3, downTo 1, startingWith "", step (index, acc) {
			<- #Continue(acc::append(index::toString()))
		}),
	)
	show(
		"loop<State>(from: Integer, downTo: Integer, startingWith: State, step: (_ Integer, _ State) -> Step<State, State>) [end above the start]",
		loop(from 3, downTo 9, startingWith "", step (index, acc) {
			<- #Continue(acc::append(index::toString()))
		}),
	)
}
