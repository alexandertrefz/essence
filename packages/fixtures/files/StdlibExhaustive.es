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
	show("String.length()", greeting::length())
	show("String.length() [empty]", emptyText::length())
	show("String.length() [astral]", "a😀b"::length())
	show("String.characters()", "a😀b"::characters())
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
		"String.character(at: Integer, defaultingTo: String)",
		greeting::character(at 1, defaultingTo "?"),
	)
	show(
		"String.character(at: Integer, defaultingTo: String) [outside]",
		greeting::character(at 99, defaultingTo "?"),
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
	show("String.repeat(times: Integer)", "ab"::repeat(times 3))
	show("String.repeat(times: Integer) [zero]", "ab"::repeat(times 0))
	show("String.repeat(times: Integer) [negative]", "ab"::repeat(times -1))
	show("String.reverse()", greeting::reverse())
	show("String.reverse() [astral]", "a😀b"::reverse())
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

	§ ——— Boolean ——————————————————————————————————————————————————————————
	show("Boolean.negate()", true::negate())
	show("Boolean.negate() [false]", false::negate())
	show("Boolean.is(_ Boolean)", true::is(true))
	show("Boolean.is(_ Boolean) [differing]", true::is(false))
	show("Boolean.isNot(_ Boolean)", true::isNot(false))
	show("Boolean.isNot(_ Boolean) [equal]", false::isNot(false))
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
	§ Namespace is called under a label of its own further down.
	constant computedTwo   = 1::add(1)
	constant computedThree = 1::add(2)
	constant computedEight = 4::add(4)
	constant computedNine  = 4::add(5)
	constant computedTen   = 5::add(5)
	constant computedZero  = 1::subtract(1)

	constant computedHundred       = 99::add(1)
	constant computedNegativeThree = 0::subtract(3)

	§ A written Rational proves it is not zero exactly as a written Integer
	§ does, so these keep the calls below on the entries taking a Rational that
	§ might be. Each is the sum of two halves of itself, which the exact
	§ arithmetic answers in lowest terms — so each holds the parts the written
	§ form holds.
	constant computedHalf          = 1/4::add(1/4)
	constant computedSixth         = 1/12::add(1/12)
	constant computedThreeQuarters = 1/2::add(1/4)

	§ One over the range a JavaScript number holds exactly, computed so that
	§ the multiplication below is Integer's own.
	constant computedHugeInteger = 9_007_199_254_740_990::add(1)

	show("Integer.is(_ Integer)", 7::is(7))
	show("Integer.is(_ Integer) [differing]", 7::is(8))
	show("Integer.isNot(_ Integer)", 7::isNot(8))
	show("Integer.isNot(_ Integer) [equal]", 7::isNot(7))
	show("Integer.is(_ Rational)", 7::is(7/1))
	show("Integer.is(_ Rational) [fractional]", 7::is(1/2))
	show("Integer.isNot(_ Rational)", 7::isNot(1/2))
	show("Integer.isNot(_ Rational) [equal]", 7::isNot(7/1))
	show("Integer.add(_ Integer)", 66::add(34))
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
	show("Integer.divide(by: NonZeroInteger)", 1110::divide(by 2))
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
	show("Integer.absolute()", -5::absolute())
	show("Integer.absolute() [positive]", 5::absolute())
	show("Integer.negate()", 5::negate())
	show("Integer.negate() [zero]", 0::negate())
	show("Integer.round(toward?: Rounding) [no direction named]", 5::round())
	show("Integer.round(toward?: Rounding)", -5::round(toward #Up))
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
	show(
		"Integer.parse(_ String, defaultingTo: Integer)",
		Integer.parse("42", defaultingTo 0),
	)
	show(
		"Integer.parse(_ String, defaultingTo: Integer) [not a number]",
		Integer.parse("nope", defaultingTo 0),
	)
	show("Integer.toString()", 42::toString())
	show("Integer.toString() [negative]", -42::toString())
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
	constant provenSix: NonZeroInteger = 6

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

	§ ——— NonNegativeInteger ————————————————————————————————————————————————
	§ The one Method a sign proves. The receivers are declared rather than
	§ written, so that the calls above keep reaching Integer's own entry: a
	§ written `4` proves its sign for itself and comes here instead.
	constant provenFour: NonNegativeInteger  = 4
	constant provenThree: NonNegativeInteger = 3
	constant provenZero: NonNegativeInteger  = 0

	show("NonNegativeInteger.squareRoot()", provenFour::squareRoot())
	show(
		"NonNegativeInteger.squareRoot() [irrational]",
		provenThree::squareRoot(),
	)
	show("NonNegativeInteger.squareRoot() [zero]", provenZero::squareRoot())

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
	show("Rational.numerator()", 3/4::numerator())
	show("Rational.denominator()", 3/4::denominator())
	show("Rational.absolute()", -3/4::absolute())
	show("Rational.negate()", 3/4::negate())
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
		"Rational.toString(as: NumberFormat, places: Integer)",
		5/3::toString(as NumberFormat#Decimal, places 2),
	)
	show(
		"Rational.toString(as: NumberFormat, places: Integer) [padded]",
		1/2::toString(as NumberFormat#Decimal, places 2),
	)
	show(
		"Rational.toString(as: NumberFormat, places: Integer) [negative]",
		-5/3::toString(as NumberFormat#Decimal, places 2),
	)
	show(
		"Rational.toString(as: NumberFormat, places: Integer) [a half rounds away from zero]",
		1/8::toString(as NumberFormat#Decimal, places 2),
	)
	show(
		"Rational.toString(as: NumberFormat, places: Integer) [no places]",
		2/3::toString(as NumberFormat#Decimal, places 0),
	)
	show(
		"Rational.toString(as: NumberFormat, places: Integer) [fraction ignores the count]",
		3/4::toString(as NumberFormat#Fraction, places 2),
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
	§ as as an Argument. So both calls here are written where they stand.
	show(
		"NonZeroRational.multiply(with: NonZeroRational)",
		1/2::multiply(with 2/3),
	)
	show("NonZeroRational.reciprocal()", 3/4::reciprocal())

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
		show("Algebraic.isPositive()", rootTwo::isPositive())
		show(
			"Algebraic.isPositive() [negative]",
			rootTwo::negate()::isPositive(),
		)
		show("Algebraic.isNegative()", rootTwo::negate()::isNegative())
		show("Algebraic.isNegative() [positive]", rootTwo::isNegative())
		show("Algebraic.absolute()", rootTwo::absolute())
		show("Algebraic.absolute() [negative]", rootTwo::negate()::absolute())
		show("Algebraic.negate()", rootTwo::negate())
		show("Algebraic.toString()", rootTwo::toString())
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
	show("Transcendental.absolute()", Number.Pi::absolute())
	show(
		"Transcendental.absolute() [negative]",
		Number.Pi::negate()::absolute(),
	)
	show("Transcendental.negate()", Number.Pi::negate())
	show("Transcendental.toString()", Number.Pi::toString())

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
		§ The four inequalities, `isBetween` and `clamp` are `Orderable`'s
		§ provided Methods, and every conformer has a rung of its own. These
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
	show("Number.sum(_ List<Integer | Rational>)", Number.sum([1, 1/2, 1/2]))
	show(
		"Number.sum(_ List<Integer | Rational>) [empty]",
		Number.sum(noMixedNumbers),
	)
	show("Number.product(_ List<Integer>)", Number.product([2, 3, 4]))
	show("Number.product(_ List<Integer>) [empty]", Number.product(noNumbers))
	show("Number.product(_ List<Rational>)", Number.product([1/2, 2/3]))
	show(
		"Number.product(_ List<Rational>) [empty]",
		Number.product(noRationals),
	)
	show(
		"Number.product(_ List<Integer | Rational>)",
		Number.product([2, 1/2, 3]),
	)
	show(
		"Number.product(_ List<Integer | Rational>) [empty]",
		Number.product(noMixedNumbers),
	)
	show("Number.average(_ List<Integer>)", Number.average(twoNumbers))
	show("Number.average(_ List<Integer>) [empty]", Number.average(noNumbers))
	show("Number.average(_ List<Rational>)", Number.average(twoRationals))
	show(
		"Number.average(_ List<Rational>) [empty]",
		Number.average(noRationals),
	)
	show(
		"Number.average(_ List<Integer | Rational>)",
		Number.average(twoMixedNumbers),
	)
	show(
		"Number.average(_ List<Integer | Rational>) [empty]",
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
		"Number.average(_ List<Integer | Rational>, defaultingTo: Rational)",
		Number.average(twoMixedNumbers, defaultingTo 0/1),
	)
	show(
		"Number.average(_ List<Integer | Rational>, defaultingTo: Rational) [empty]",
		Number.average(noMixedNumbers, defaultingTo 0/1),
	)
	§ The same Lists written where they stand, which is the proof these entries
	§ ask for. Each answers the mean itself where the twin above it answers an
	§ Optional.
	show("Number.average(_ NonEmptyList<Integer>)", Number.average([1, 2]))
	show("Number.average(_ NonEmptyList<Rational>)", Number.average([1/2, 1/3]))
	show(
		"Number.average(_ NonEmptyList<Integer | Rational>)",
		Number.average([1, 1/2]),
	)
	show("Number.lowestNumber(_ Integer, _ Integer)", Number.lowestNumber(3, 2))
	show(
		"Number.lowestNumber(_ Rational, _ Rational)",
		Number.lowestNumber(1/2, 1/3),
	)
	show(
		"Number.lowestNumber(_ Integer, _ Rational)",
		Number.lowestNumber(1, 2/3),
	)
	show(
		"Number.lowestNumber(_ Rational, _ Integer)",
		Number.lowestNumber(2/3, 1),
	)
	show(
		"Number.lowestNumber(_ List<Integer>)",
		Number.lowestNumber(threeNumbers),
	)
	show(
		"Number.lowestNumber(_ List<Integer>) [empty]",
		Number.lowestNumber(noNumbers),
	)
	show(
		"Number.lowestNumber(_ List<Rational>)",
		Number.lowestNumber(twoRationals),
	)
	show(
		"Number.lowestNumber(_ List<Rational>) [empty]",
		Number.lowestNumber(noRationals),
	)
	show(
		"Number.lowestNumber(_ List<Integer | Rational>)",
		Number.lowestNumber(twoMixedNumbers),
	)
	show(
		"Number.lowestNumber(_ List<Integer | Rational>) [empty]",
		Number.lowestNumber(noMixedNumbers),
	)
	show(
		"Number.lowestNumber(_ List<Integer>, defaultingTo: Integer)",
		Number.lowestNumber(threeNumbers, defaultingTo 0),
	)
	show(
		"Number.lowestNumber(_ List<Integer>, defaultingTo: Integer) [empty]",
		Number.lowestNumber(noNumbers, defaultingTo 0),
	)
	show(
		"Number.lowestNumber(_ List<Rational>, defaultingTo: Rational)",
		Number.lowestNumber(twoRationals, defaultingTo 0/1),
	)
	show(
		"Number.lowestNumber(_ List<Rational>, defaultingTo: Rational) [empty]",
		Number.lowestNumber(noRationals, defaultingTo 0/1),
	)
	show(
		"Number.lowestNumber(_ List<Integer | Rational>, defaultingTo: Integer | Rational)",
		Number.lowestNumber(twoMixedNumbers, defaultingTo 0),
	)
	show(
		"Number.lowestNumber(_ List<Integer | Rational>, defaultingTo: Integer | Rational) [empty]",
		Number.lowestNumber(noMixedNumbers, defaultingTo 0),
	)
	show(
		"Number.lowestNumber(_ NonEmptyList<Integer>)",
		Number.lowestNumber([3, 1, 2]),
	)
	§ One item, which is the seed the fold starts from and the answer it ends
	§ with.
	show(
		"Number.lowestNumber(_ NonEmptyList<Integer>) [single]",
		Number.lowestNumber([7]),
	)
	show(
		"Number.lowestNumber(_ NonEmptyList<Rational>)",
		Number.lowestNumber([1/2, 1/3]),
	)
	show(
		"Number.lowestNumber(_ NonEmptyList<Integer | Rational>)",
		Number.lowestNumber([1, 1/2]),
	)
	show(
		"Number.highestNumber(_ Integer, _ Integer)",
		Number.highestNumber(3, 2),
	)
	show(
		"Number.highestNumber(_ Rational, _ Rational)",
		Number.highestNumber(1/2, 1/3),
	)
	show(
		"Number.highestNumber(_ Integer, _ Rational)",
		Number.highestNumber(1, 2/3),
	)
	show(
		"Number.highestNumber(_ Rational, _ Integer)",
		Number.highestNumber(2/3, 1),
	)
	show(
		"Number.highestNumber(_ List<Integer>)",
		Number.highestNumber(threeNumbers),
	)
	show(
		"Number.highestNumber(_ List<Integer>) [empty]",
		Number.highestNumber(noNumbers),
	)
	show(
		"Number.highestNumber(_ List<Rational>)",
		Number.highestNumber(twoRationals),
	)
	show(
		"Number.highestNumber(_ List<Rational>) [empty]",
		Number.highestNumber(noRationals),
	)
	show(
		"Number.highestNumber(_ List<Integer | Rational>)",
		Number.highestNumber(twoMixedNumbers),
	)
	show(
		"Number.highestNumber(_ List<Integer | Rational>) [empty]",
		Number.highestNumber(noMixedNumbers),
	)
	show(
		"Number.highestNumber(_ List<Integer>, defaultingTo: Integer)",
		Number.highestNumber(threeNumbers, defaultingTo 0),
	)
	show(
		"Number.highestNumber(_ List<Integer>, defaultingTo: Integer) [empty]",
		Number.highestNumber(noNumbers, defaultingTo 0),
	)
	show(
		"Number.highestNumber(_ List<Rational>, defaultingTo: Rational)",
		Number.highestNumber(twoRationals, defaultingTo 0/1),
	)
	show(
		"Number.highestNumber(_ List<Rational>, defaultingTo: Rational) [empty]",
		Number.highestNumber(noRationals, defaultingTo 0/1),
	)
	show(
		"Number.highestNumber(_ List<Integer | Rational>, defaultingTo: Integer | Rational)",
		Number.highestNumber(twoMixedNumbers, defaultingTo 0),
	)
	show(
		"Number.highestNumber(_ List<Integer | Rational>, defaultingTo: Integer | Rational) [empty]",
		Number.highestNumber(noMixedNumbers, defaultingTo 0),
	)
	show(
		"Number.highestNumber(_ NonEmptyList<Integer>)",
		Number.highestNumber([3, 1, 2]),
	)
	show(
		"Number.highestNumber(_ NonEmptyList<Rational>)",
		Number.highestNumber([1/2, 1/3]),
	)
	show(
		"Number.highestNumber(_ NonEmptyList<Integer | Rational>)",
		Number.highestNumber([1, 1/2]),
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
	show("Optional.isEmpty<ItemType>()", noNumbers::firstItem()::isEmpty())
	show(
		"Optional.isEmpty<ItemType>() [present]",
		numbers::firstItem()::isEmpty(),
	)
	show(
		"Optional.map<ItemType, ResultType>(_ (_ ItemType) -> ResultType)",
		numbers::firstItem()::map((item) { <- item::multiply(with 10) }),
	)
	show(
		"Optional.map<ItemType, ResultType>(_ (_ ItemType) -> ResultType) [empty]",
		noNumbers::firstItem()::map((item) { <- item::multiply(with 10) }),
	)
	show(
		"Optional.andThen<ItemType, ResultType>(_ (_ ItemType) -> Optional<ResultType>)",
		numbers::firstItem()::andThen((item) { <- numbers::item(at item) }),
	)
	show(
		"Optional.andThen<ItemType, ResultType>(_ (_ ItemType) -> Optional<ResultType>) [empty]",
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
	constant asFraction: NumberFormat = #Fraction
	constant asDecimal: NumberFormat  = #Decimal

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

	§ ——— Rounding —————————————————————————————————————————————————————————
	constant toNearest: Rounding    = #Nearest
	constant toDown: Rounding       = #Down
	constant toUp: Rounding         = #Up
	constant toTowardZero: Rounding = #TowardZero

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
	show(
		"List.doesNotContain<ItemType is Equatable>(_ ItemType)",
		numbers::doesNotContain(9),
	)
	show(
		"List.doesNotContain<ItemType is Equatable>(_ ItemType) [present]",
		numbers::doesNotContain(4),
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
		"List.removeDuplicates<ItemType is Equatable>()",
		numbers::removeDuplicates(),
	)
	show(
		"List.removeDuplicates<ItemType is Equatable>() [empty]",
		noNumbers::removeDuplicates(),
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
		"List.map<ItemType, Result>(_ (_ ItemType) -> Result)",
		numbers::map((item) { <- item::toString() }),
	)
	show(
		"List.map<ItemType, Result>(_ (_ ItemType) -> Result) [empty]",
		noNumbers::map((item) { <- item::toString() }),
	)
	show(
		"List.reduce<ItemType, Result>(startingWith: Result, _ (_ Result, _ ItemType) -> Result)",
		numbers::reduce(startingWith 0, (total, item) { <- total::add(item) }),
	)
	show(
		"List.reduce<ItemType, Result>(startingWith: Result, _ (_ Result, _ ItemType) -> Result) [empty]",
		noNumbers::reduce(startingWith 0, (total, item) {
			<- total::add(item)
		}),
	)
	show(
		"List.reduce<ItemType, Result>(startingWith: Result, step: (_ Result, _ ItemType) -> Step<Result, Result>)",
		numbers::reduce(startingWith 0, step (total, item) {
			<- #Continue(total::add(item))
		}),
	)
	show(
		"List.reduce<ItemType, Result>(startingWith: Result, step: (_ Result, _ ItemType) -> Step<Result, Result>) [early stop]",
		numbers::reduce(startingWith 0, step (total, item) {
			if total::isGreaterThan(3) {
				<- #Done(total)
			}

			<- #Continue(total::add(item))
		}),
	)
	show(
		"List.reduce<ItemType, Result>(startingWith: Result, step: (_ Result, _ ItemType) -> Step<Result, Result>) [empty]",
		noNumbers::reduce(startingWith 0, step (total, item) {
			<- #Continue(total::add(item))
		}),
	)
	show(
		"List.everyItem<ItemType>(where: (_ ItemType) -> Boolean)",
		numbers::everyItem(where (item) { <- item::isGreaterThan(1) }),
	)
	show(
		"List.everyItem<ItemType>(where: (_ ItemType) -> Boolean) [no match]",
		numbers::everyItem(where (item) { <- item::isGreaterThan(9) }),
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
	§ `{ matching = [2, 4], rest = [3, 1, 1] }` sits at thirty-nine
	§ characters — twenty-one under the sixty at which `getStringRepresentation`
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
		"List.of(integersFrom: Integer, through: Integer) [inverted]",
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
	§ Grouping, over three kinds of key. The first shows the order the groups
	§ stand in, which is the order their keys were first met. The third reads
	§ its key with a member path, as `sort(on:)` does, and its items are read
	§ down to their tags for the reason the `[tie]` lines above are: a Record
	§ per item would wrap the line.
	show(
		"List.group<ItemType, Key is Equatable>(on: (_ ItemType) -> Key)",
		numbers::group(on (item) { <- item }),
	)
	show(
		"List.group<ItemType, Key is Equatable>(on: (_ ItemType) -> Key) [Boolean key]",
		numbers::group(on (item) { <- item::isEven() }),
	)
	show(
		"List.group<ItemType, Key is Equatable>(on: (_ ItemType) -> Key) [member path]",
		tiedRows
			::group(on .n)
			::map((found) {
				<- { key = found.key, tags = found.items::map(.tag) }
			}),
	)
	show(
		"List.group<ItemType, Key is Equatable>(on: (_ ItemType) -> Key) [one group]",
		[7]::group(on (item) { <- item }),
	)
	show(
		"List.group<ItemType, Key is Equatable>(on: (_ ItemType) -> Key) [empty]",
		noNumbers::group(on (item) { <- item }),
	)

	§ ——— NestedList ———————————————————————————————————————————————————————
	show("NestedList.flatten<ItemType>()", [[1, 2], [3]]::flatten())
	show("NestedList.flatten<ItemType>() [empty]", noNestedNumbers::flatten())

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

	show("OptionalList.values<ItemType>()", someMaybes::values())
	show("OptionalList.values<ItemType>() [all empty]", allEmpty::values())
	show("OptionalList.values<ItemType>() [empty]", noMaybes::values())

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
		"NonEmptyList.removeDuplicates<ItemType is Equatable>()",
		provenNumbers::removeDuplicates(),
	)
	show(
		"NonEmptyList.removeDuplicates<ItemType is Equatable>() [proof carried]",
		provenNumbers::removeDuplicates()::lastItem(),
	)
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
		"NonEmptyList.map<ItemType, Result>(_ (_ ItemType) -> Result)",
		provenWords::map((word) { <- word::length() }),
	)
	show(
		"NonEmptyList.map<ItemType, Result>(_ (_ ItemType) -> Result) [proof carried]",
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

	§ The proofs a Method HANDS OVER rather than ones a literal carries. Each
	§ receiver below is a call to a `List` Method that says what it builds is
	§ not empty, written where a Constant of the Type would otherwise stand —
	§ so what resolves these to `NonEmptyList` is the return Type alone, with
	§ no annotation and no doorway anywhere in front of them. The label test
	§ in `stdlibGolden.spec.ts` asks which Namespace each call landed in, so
	§ a promise quietly weakened back to `List` fails here by name.
	show(
		"NonEmptyList.firstItem<ItemType>() [from List.of]",
		List.of(integersFrom 3, through 7)::firstItem(),
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
		"NumberList.lowestNumber(defaultingTo: Integer | Rational)",
		mixedNumbers::lowestNumber(defaultingTo 0),
	)
	show(
		"NumberList.lowestNumber(defaultingTo: Integer | Rational) [empty]",
		noMixedNumbers::lowestNumber(defaultingTo 0),
	)
	show("NumberList.highestNumber()", mixedNumbers::highestNumber())
	show("NumberList.highestNumber() [empty]", noMixedNumbers::highestNumber())
	show(
		"NumberList.highestNumber(defaultingTo: Integer | Rational)",
		mixedNumbers::highestNumber(defaultingTo 0),
	)
	show(
		"NumberList.highestNumber(defaultingTo: Integer | Rational) [empty]",
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
		List.of(integersFrom 1, through 4)::average(),
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
		"KeyedNumberList.sum<ItemType>(on: (_ ItemType) -> Integer | Rational)",
		rows::sum(on .m),
	)
	show(
		"KeyedNumberList.average<ItemType>(on: (_ ItemType) -> Integer | Rational)",
		rows::average(on .n),
	)
	show(
		"KeyedNumberList.average<ItemType>(on: (_ ItemType) -> Integer | Rational) [empty]",
		noRows::average(on .n),
	)
	show(
		"KeyedNumberList.average<ItemType>(on: (_ ItemType) -> Integer | Rational, defaultingTo: Rational)",
		rows::average(on .r, defaultingTo 0/1),
	)
	show(
		"KeyedNumberList.average<ItemType>(on: (_ ItemType) -> Integer | Rational, defaultingTo: Rational) [empty]",
		noRows::average(on .r, defaultingTo 0/1),
	)

	§ ——— NonEmptyKeyedNumberList —————————————————————————————————————————
	§ The one keyed aggregate the proof changes: `map` carries it to the List
	§ of numbers, whose mean is bare. `sum(on:)` is total already, so a proven
	§ receiver keeps reaching `KeyedNumberList` for it.
	show(
		"NonEmptyKeyedNumberList.average<ItemType>(on: (_ ItemType) -> Integer | Rational)",
		provenRows::average(on .n),
	)
	show(
		"KeyedNumberList.sum<ItemType>(on: (_ ItemType) -> Integer) [proven receiver]",
		provenRows::sum(on .n),
	)

	§ ——— loop ————————————————————————————————————————————————————————————
	§ The free-Function loop family. `loop` belongs to no Namespace, so its
	§ labels carry no prefix — the coverage net learns them from the member
	§ table just as it learns a Namespace's Methods.
	show(
		"loop<State>(from: Integer, through: Integer, startingWith: State, step: (_ Integer, _ State) -> State)",
		loop(from 1, through 5, startingWith 0, step (index, total) {
			<- total::add(index)
		}),
	)
	show(
		"loop<State>(from: Integer, through: Integer, startingWith: State, step: (_ Integer, _ State) -> State) [down]",
		loop(from 3, through 1, startingWith "", step (index, acc) {
			<- acc::append(index::toString())
		}),
	)
	show(
		"loop<State>(from: Integer, upTo: Integer, startingWith: State, step: (_ Integer, _ State) -> State)",
		loop(from 0, upTo 5, startingWith 0, step (index, total) {
			<- total::add(index)
		}),
	)
	show(
		"loop<State>(from: Integer, upTo: Integer, startingWith: State, step: (_ Integer, _ State) -> State) [zero turns]",
		loop(from 0, upTo 0, startingWith 99, step (index, total) {
			<- total::add(index)
		}),
	)
	show(
		"loop<State>(startingWith: State, while: (_ State) -> Boolean, step: (_ State) -> State)",
		loop(startingWith 1, while (n) { <- n::isLessThan(100) }, step (n) {
			<- n::multiply(with 2)
		}),
	)
	show(
		"loop<State>(startingWith: State, while: (_ State) -> Boolean, step: (_ State) -> State) [zero turns]",
		loop(startingWith 500, while (n) { <- n::isLessThan(100) }, step (n) {
			<- n::multiply(with 2)
		}),
	)
	show(
		"loop<State>(startingWith: State, until: (_ State) -> Boolean, step: (_ State) -> State)",
		loop(
			startingWith 1,
			until (n) { <- n::isGreaterThanOrEqualTo(100) },
			step (n) { <- n::multiply(with 2) },
		),
	)
	show(
		"loop<State>(startingWith: State, until: (_ State) -> Boolean, step: (_ State) -> State) [zero turns]",
		loop(
			startingWith 500,
			until (n) { <- n::isGreaterThanOrEqualTo(100) },
			step (n) { <- n::multiply(with 2) },
		),
	)
	show(
		"loop<State, Result>(startingWith: State, step: (_ State) -> Step<State, Result>)",
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
}
