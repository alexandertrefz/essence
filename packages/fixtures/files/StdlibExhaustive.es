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
		__print("{label} => {value}")
		<- {}
	}

	§ An Algebraic can not be written as a literal — it is only ever reached
	§ through `squareRoot`, whose result is an Optional the caller has to
	§ match apart. These two hand one to a body so that the Methods needing
	§ an Algebraic receiver or Argument read as ordinary calls.
	function withRootTwo(_ body: (_ rootTwo: Algebraic) -> {}) -> {} {
		<- match 2::squareRoot() -> {} {
			case #Value(root) {
				<- match root -> {} {
					case Algebraic { <- body(@) }
					case Integer   { <- {} }
				}
			}

			case #Empty { <- {} }
		}
	}

	function withTwoRoots(
		_ body: (_ rootTwo: Algebraic, _ rootThree: Algebraic) -> {},
	) -> {} {
		<- withRootTwo((_ rootTwo: Algebraic) -> {} {
			<- match 3::squareRoot() -> {} {
				case #Value(root) {
					<- match root -> {} {
						case Algebraic { <- body(rootTwo, @) }
						case Integer   { <- {} }
					}
				}

				case #Empty { <- {} }
			}
		})
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
	show("String.hasAnyContent()", greeting::hasAnyContent())
	show("String.hasAnyContent() [empty]", emptyText::hasAnyContent())
	show("String.is(_ String)", greeting::is("Hello, World"))
	show("String.is(_ String) [differing]", greeting::is("nope"))
	show("String.is(_ String) [both empty]", emptyText::is(""))
	show("String.isNot(_ String)", greeting::isNot("nope"))
	show("String.isNot(_ String) [equal]", greeting::isNot("Hello, World"))
	show(
		"String.is(_ String, comparing: Case) [sensitive]",
		"Hello"::is("hello", comparing Case#Sensitive),
	)
	show(
		"String.is(_ String, comparing: Case) [insensitive]",
		"Hello"::is("hello", comparing Case#Insensitive),
	)
	show(
		"String.is(_ String, comparing: Case) [insensitive, differing]",
		"Hello"::is("world", comparing Case#Insensitive),
	)
	show("String.prepend(_ String)", greeting::prepend(">> "))
	show("String.prepend(_ String) [empty]", greeting::prepend(emptyText))
	show("String.append(_ String)", greeting::append("!"))
	show("String.append(_ String) [empty]", greeting::append(emptyText))
	show("String.split(on: String)", "a,b,c"::split(on ","))
	show("String.split(on: String) [no match]", greeting::split(on ";"))
	show("String.split(on: String) [empty separator]", "abc"::split(on ""))
	show("String.split(on: String) [empty receiver]", emptyText::split(on ","))
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
	show("String.uppercase()", greeting::uppercase())
	show("String.uppercase() [empty]", emptyText::uppercase())
	show("String.lowercase()", greeting::lowercase())
	show("String.trim()", "  spaced  "::trim())
	show("String.trim() [nothing to trim]", greeting::trim())
	show("String.trim(at: Side) [start]", "  spaced  "::trim(at Side#Start))
	show("String.trim(at: Side) [end]", "  spaced  "::trim(at Side#End))
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
		"String.slice(from: Integer, to: Integer)",
		greeting::slice(from 0, to 5),
	)
	show(
		"String.slice(from: Integer, to: Integer) [empty range]",
		greeting::slice(from 3, to 3),
	)
	show(
		"String.slice(from: Integer, to: Integer) [past the end]",
		greeting::slice(from 7, to 99),
	)
	show(
		"String.slice(from: Integer, to: Integer) [negative to]",
		greeting::slice(from 0, to -1),
	)
	show(
		"String.slice(from: Integer, to: Integer) [negative from]",
		greeting::slice(from -5, to 12),
	)
	show(
		"String.slice(from: Integer, to: Integer) [both negative]",
		greeting::slice(from -5, to -1),
	)
	show(
		"String.slice(from: Integer, to: Integer) [negative past the start]",
		greeting::slice(from -99, to 5),
	)
	show("String.firstIndex(of: String)", greeting::firstIndex(of "World"))
	show(
		"String.firstIndex(of: String) [absent]",
		greeting::firstIndex(of "zz"),
	)
	show("String.lastIndex(of: String)", "a-b-a"::lastIndex(of "a"))
	show("String.lastIndex(of: String) [absent]", greeting::lastIndex(of "zz"))
	show("String.pad(to: Integer, with: String)", "7"::pad(to 3, with "0"))
	show(
		"String.pad(to: Integer, with: String) [already long enough]",
		greeting::pad(to 3, with "0"),
	)
	show(
		"String.pad(to: Integer, with: String, at: Side) [end]",
		"7"::pad(to 3, with ".", at Side#End),
	)
	show(
		"String.pad(to: Integer, with: String, at: Side) [end, already long enough]",
		greeting::pad(to 3, with ".", at Side#End),
	)
	show(
		"String.pad(to: Integer, with: String, at: Side) [both ends, even]",
		"7"::pad(to 5, with "-", at Side#BothEnds),
	)
	show(
		"String.pad(to: Integer, with: String, at: Side) [both ends, odd]",
		"7"::pad(to 4, with "-", at Side#BothEnds),
	)
	show(
		"String.pad(to: Integer, with: String, at: Side) [both ends, multi-character]",
		"ab"::pad(to 8, with "xy", at Side#BothEnds),
	)
	show("String.compare(to: String)", "app"::compare(to "apple"))
	show(
		"String.compare(to: String) [equal]",
		greeting::compare(to "Hello, World"),
	)
	show("String.compare(to: String) [greater]", "b"::compare(to "a"))
	show(
		"String.compare(to: String, comparing: Case) [sensitive]",
		"abc"::compare(to "ABC", comparing Case#Sensitive),
	)
	show(
		"String.compare(to: String, comparing: Case) [insensitive, equal]",
		"abc"::compare(to "ABC", comparing Case#Insensitive),
	)
	show(
		"String.compare(to: String, comparing: Case) [insensitive, less]",
		"abc"::compare(to "ABD", comparing Case#Insensitive),
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
	show("String.normalize()", accented::normalize())
	show(
		"String.normalize(as: NormalizationForm) [compatibility folds ligature]",
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
	constant computedTwo   = 1::add(1)
	constant computedThree = 1::add(2)
	constant computedEight = 4::multiply(with 2)

	constant computedNegativeThree = 0::subtract(3)

	show("Integer.is(_ Integer)", 7::is(7))
	show("Integer.is(_ Integer) [differing]", 7::is(8))
	show("Integer.isNot(_ Integer)", 7::isNot(8))
	show("Integer.isNot(_ Integer) [equal]", 7::isNot(7))
	show("Integer.add(_ Integer)", 66::add(34))
	show("Integer.add(_ Integer) [negative]", 66::add(-100))
	show("Integer.add(_ Rational)", 1::add(1/2))
	show("Integer.add(_ Transcendental)", 1::add(Number.PI))
	show("Integer.subtract(_ Integer)", 1234::subtract(234))
	show("Integer.subtract(_ Rational)", 1::subtract(1/2))
	show("Integer.subtract(_ Transcendental)", 1::subtract(Number.PI))
	show("Integer.divide(by: Integer)", 1110::divide(by computedTwo))
	show("Integer.divide(by: Integer) [by zero]", 1::divide(by 0))
	show("Integer.divide(by: Rational)", 1::divide(by 1/2))
	show("Integer.divide(by: Rational) [by zero]", 1::divide(by 0/1))
	show("Integer.divide(by: NonZeroInteger)", 1110::divide(by 2))
	show("Integer.multiply(with: Integer)", 100::multiply(with 1000))
	show(
		"Integer.multiply(with: Integer) [beyond IEEE 754]",
		9_007_199_254_740_991::multiply(with 500),
	)
	show("Integer.multiply(with: Rational)", 3::multiply(with 1/3))
	show("Integer.multiply(with: Transcendental)", 2::multiply(with Number.PI))
	show(
		"Integer.multiply(with: Transcendental) [collapses to Rational]",
		0::multiply(with Number.PI),
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
	show("Integer.squareRoot() [perfect square]", 9::squareRoot())
	show("Integer.squareRoot() [irrational]", 2::squareRoot())
	show("Integer.squareRoot() [zero]", 0::squareRoot())
	show("Integer.squareRoot() [negative]", -1::squareRoot())
	show("Integer.absolute()", -5::absolute())
	show("Integer.absolute() [positive]", 5::absolute())
	show("Integer.negate()", 5::negate())
	show("Integer.negate() [zero]", 0::negate())
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
	show("Integer.raise(to: Integer)", 2::raise(to 10))
	show("Integer.raise(to: Integer) [zero exponent]", 2::raise(to 0))
	show("Integer.raise(to: Integer) [negative exponent]", 2::raise(to -2))
	show(
		"Integer.raise(to: Integer) [zero to a negative power]",
		0::raise(to -1),
	)
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
	show("Integer.toString()", 42::toString())
	show("Integer.toString() [negative]", -42::toString())
	show("Integer.compare(to: Integer)", 1::compare(to 2))
	show("Integer.compare(to: Integer) [equal]", 2::compare(to 2))
	show("Integer.compare(to: Integer) [greater]", 3::compare(to 2))

	withRootTwo((_ rootTwo: Algebraic) -> {} {
		show("Integer.add(_ Algebraic)", 1::add(rootTwo))
		show("Integer.subtract(_ Algebraic)", 1::subtract(rootTwo))
		show("Integer.divide(by: Algebraic)", 1::divide(by rootTwo))
		show("Integer.multiply(with: Algebraic)", 3::multiply(with rootTwo))
		show(
			"Integer.multiply(with: Algebraic) [collapses to Rational]",
			0::multiply(with rootTwo),
		)
		<- {}
	})

	§ ——— NonZeroInteger ———————————————————————————————————————————————————
	§ The one Method a proven Integer has that a bare one does not. Both
	§ operands have to be proven, and a value written down is its own proof —
	§ so the receiver is declared and the Argument is written where it stands.
	constant provenSix: NonZeroInteger = 6

	show(
		"NonZeroInteger.multiply(with: NonZeroInteger)",
		provenSix::multiply(with 7),
	)

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
	show("Rational.is(_ Rational)", 1/2::is(2/4))
	show("Rational.is(_ Rational) [differing]", 1/2::is(1/3))
	show("Rational.isNot(_ Rational)", 1/2::isNot(1/3))
	show("Rational.isNot(_ Rational) [equal]", 1/2::isNot(2/4))
	show("Rational.add(_ Rational)", 1/2::add(1/3))
	show("Rational.add(_ Rational) [collapses to a whole]", 1/2::add(1/2))
	show("Rational.add(_ Integer)", 1/2::add(1))
	show("Rational.add(_ Transcendental)", 1/2::add(Number.PI))
	show("Rational.subtract(_ Rational)", 1/2::subtract(1/3))
	show("Rational.subtract(_ Integer)", 1/2::subtract(1))
	show("Rational.subtract(_ Transcendental)", 1/2::subtract(Number.PI))
	show("Rational.divide(by: Rational)", 1/2::divide(by 1/6))
	show("Rational.divide(by: Rational) [by zero]", 1/2::divide(by 0/1))
	show("Rational.divide(by: Integer)", 1/2::divide(by 2))
	show("Rational.divide(by: Integer) [by zero]", 1/2::divide(by 0))
	show("Rational.multiply(with: Rational)", 1/2::multiply(with 2/3))
	show("Rational.multiply(with: Integer)", 1/2::multiply(with 2))
	show(
		"Rational.multiply(with: Transcendental)",
		1/2::multiply(with Number.PI),
	)
	show(
		"Rational.multiply(with: Transcendental) [collapses to Rational]",
		0/1::multiply(with Number.PI),
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
	show("Rational.squareRoot() [perfect square]", 1/4::squareRoot())
	show("Rational.squareRoot() [irrational]", 1/2::squareRoot())
	show("Rational.squareRoot() [negative]", -1/2::squareRoot())
	show("Rational.numerator()", 3/4::numerator())
	show("Rational.denominator()", 3/4::denominator())
	show("Rational.absolute()", -3/4::absolute())
	show("Rational.negate()", 3/4::negate())
	show("Rational.reciprocal()", 3/4::reciprocal())
	show("Rational.reciprocal() [of zero]", 0/1::reciprocal())
	show("Rational.isWholeNumber()", 4/2::isWholeNumber())
	show("Rational.isWholeNumber() [fractional]", 3/4::isWholeNumber())
	show("Rational.round()", 7/2::round())
	show("Rational.round() [negative]", -7/2::round())
	show("Rational.round(toward: Rounding)", 7/2::round(toward #Nearest))
	show(
		"Rational.round(toward: Rounding) [negative nearest]",
		-7/2::round(toward #Nearest),
	)
	show("Rational.round(toward: Rounding) [down]", 7/2::round(toward #Down))
	show(
		"Rational.round(toward: Rounding) [negative down]",
		-7/2::round(toward #Down),
	)
	show("Rational.round(toward: Rounding) [up]", 7/2::round(toward #Up))
	show(
		"Rational.round(toward: Rounding) [negative up]",
		-7/2::round(toward #Up),
	)
	show(
		"Rational.round(toward: Rounding) [toward zero]",
		7/2::round(toward #TowardZero),
	)
	show(
		"Rational.round(toward: Rounding) [negative toward zero]",
		-7/2::round(toward #TowardZero),
	)
	show(
		"Rational.round(toward: Rounding) [whole is its own ceiling]",
		4/2::round(toward #Up),
	)
	show(
		"Rational.round(toward: Rounding) [below a half]",
		1/4::round(toward #Nearest),
	)
	show("Rational.raise(to: Integer)", 2/3::raise(to 2))
	show("Rational.raise(to: Integer) [zero exponent]", 2/3::raise(to 0))
	show("Rational.raise(to: Integer) [negative exponent]", 2/3::raise(to -2))
	show(
		"Rational.raise(to: Integer) [zero to a negative power]",
		0/1::raise(to -1),
	)
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
	show("Rational.toString()", 3/4::toString())
	show("Rational.toString() [whole]", 4/2::toString())
	show(
		"Rational.toString(formatAs: NumberFormat) [decimal]",
		1/2::toString(formatAs NumberFormat#Decimal),
	)
	show(
		"Rational.toString(formatAs: NumberFormat) [fraction]",
		1/2::toString(formatAs NumberFormat#Fraction),
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
		show("Algebraic.multiply(with: Integer)", rootTwo::multiply(with 3))
		show(
			"Algebraic.multiply(with: Integer) [by zero]",
			rootTwo::multiply(with 0),
		)
		show("Algebraic.multiply(with: Rational)", rootTwo::multiply(with 1/2))
		show(
			"Algebraic.multiply(with: Algebraic) [same radical]",
			rootTwo::multiply(with rootTwo),
		)
		show(
			"Algebraic.multiply(with: Algebraic) [differing radicals]",
			rootTwo::multiply(with rootThree),
		)
		show("Algebraic.divide(by: Integer)", rootTwo::divide(by 2))
		show("Algebraic.divide(by: Integer) [by zero]", rootTwo::divide(by 0))
		show("Algebraic.divide(by: Rational)", rootTwo::divide(by 1/2))
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
		show("Algebraic.absolute()", rootTwo::absolute())
		show("Algebraic.absolute() [negative]", rootTwo::negate()::absolute())
		show("Algebraic.negate()", rootTwo::negate())
		show("Algebraic.toString()", rootTwo::toString())
		<- {}
	})

	§ ——— Transcendental ———————————————————————————————————————————————————
	show("Transcendental.is(_ Transcendental)", Number.PI::is(Number.PI))
	show(
		"Transcendental.is(_ Transcendental) [differing]",
		Number.PI::is(Number.TAU),
	)
	show("Transcendental.isNot(_ Transcendental)", Number.PI::isNot(Number.TAU))
	show(
		"Transcendental.isNot(_ Transcendental) [equal]",
		Number.PI::isNot(Number.PI),
	)
	show("Transcendental.add(_ Integer)", Number.PI::add(1))
	show("Transcendental.add(_ Rational)", Number.PI::add(1/2))
	show("Transcendental.add(_ Transcendental)", Number.PI::add(Number.PI))
	show("Transcendental.subtract(_ Integer)", Number.PI::subtract(1))
	show("Transcendental.subtract(_ Rational)", Number.PI::subtract(1/2))
	show(
		"Transcendental.subtract(_ Transcendental) [collapses to Rational]",
		Number.PI::subtract(Number.PI),
	)
	show(
		"Transcendental.subtract(_ Transcendental) [stays Transcendental]",
		Number.TAU::subtract(Number.PI),
	)
	show("Transcendental.multiply(with: Integer)", Number.PI::multiply(with 2))
	show(
		"Transcendental.multiply(with: Integer) [by zero]",
		Number.PI::multiply(with 0),
	)
	show(
		"Transcendental.multiply(with: Rational)",
		Number.PI::multiply(with 1/2),
	)
	show("Transcendental.divide(by: Integer)", Number.PI::divide(by 2))
	show(
		"Transcendental.divide(by: Integer) [by zero]",
		Number.PI::divide(by 0),
	)
	show("Transcendental.divide(by: Rational)", Number.PI::divide(by 1/2))
	show(
		"Transcendental.divide(by: Rational) [by zero]",
		Number.PI::divide(by 0/1),
	)
	show(
		"Transcendental.divide(by: Transcendental) [proportional]",
		Number.TAU::divide(by Number.PI),
	)
	show("Transcendental.absolute()", Number.PI::absolute())
	show(
		"Transcendental.absolute() [negative]",
		Number.PI::negate()::absolute(),
	)
	show("Transcendental.negate()", Number.PI::negate())
	show("Transcendental.toString()", Number.PI::toString())

	§ ——— Number ———————————————————————————————————————————————————————————
	§ Reached through the Namespace spelling throughout, because the `::`
	§ spelling only lands here when no narrower Namespace matches — every
	§ Method below shares its name with one on Integer or Rational.
	show("Number.PI", Number.PI)
	show("Number.TAU", Number.TAU)

	withRootTwo((_ rootTwo: Algebraic) -> {} {
		show("Number.is(_ Number) [Integer]", Number.is(2, 2/1))
		show("Number.is(_ Number) [Rational]", Number.is(1/2, 1))
		show("Number.is(_ Number) [Algebraic]", Number.is(rootTwo, 2))
		show(
			"Number.is(_ Number) [Transcendental]",
			Number.is(Number.PI::multiply(with 2), Number.TAU),
		)
		show("Number.isNot(_ Number) [Integer]", Number.isNot(2, 2/1))
		show("Number.isNot(_ Number) [Rational]", Number.isNot(1/2, 1))
		show("Number.isNot(_ Number) [Algebraic]", Number.isNot(rootTwo, 2))
		show(
			"Number.isNot(_ Number) [Transcendental]",
			Number.isNot(Number.PI, Number.TAU),
		)
		show("Number.toString() [Integer]", Number.toString(42))
		show("Number.toString() [Rational]", Number.toString(3/4))
		show("Number.toString() [Algebraic]", Number.toString(rootTwo))
		show("Number.toString() [Transcendental]", Number.toString(Number.PI))
		show(
			"Number.compare(to: Number) [Integer]",
			Number.compare(3, to Number.PI),
		)
		show(
			"Number.compare(to: Number) [Rational]",
			Number.compare(22/7, to Number.PI),
		)
		show(
			"Number.compare(to: Number) [Algebraic]",
			Number.compare(rootTwo, to 3/2),
		)
		show(
			"Number.compare(to: Number) [Transcendental]",
			Number.compare(Number.PI, to Number.TAU),
		)
		show(
			"Number.isLessThan(_ Number) [Integer]",
			Number.isLessThan(3, Number.PI),
		)
		show(
			"Number.isLessThan(_ Number) [Rational]",
			Number.isLessThan(22/7, Number.PI),
		)
		show(
			"Number.isLessThan(_ Number) [Algebraic]",
			Number.isLessThan(rootTwo, 3/2),
		)
		show(
			"Number.isLessThan(_ Number) [Transcendental]",
			Number.isLessThan(Number.PI, Number.TAU),
		)
		show(
			"Number.isLessThanOrEqualTo(_ Number) [Integer]",
			Number.isLessThanOrEqualTo(4, Number.PI),
		)
		show(
			"Number.isLessThanOrEqualTo(_ Number) [Rational]",
			Number.isLessThanOrEqualTo(22/7, Number.PI),
		)
		show(
			"Number.isLessThanOrEqualTo(_ Number) [Algebraic]",
			Number.isLessThanOrEqualTo(rootTwo, rootTwo),
		)
		show(
			"Number.isLessThanOrEqualTo(_ Number) [Transcendental]",
			Number.isLessThanOrEqualTo(Number.PI, Number.PI),
		)
		show(
			"Number.isGreaterThan(_ Number) [Integer]",
			Number.isGreaterThan(4, Number.PI),
		)
		show(
			"Number.isGreaterThan(_ Number) [Rational]",
			Number.isGreaterThan(22/7, Number.PI),
		)
		show(
			"Number.isGreaterThan(_ Number) [Algebraic]",
			Number.isGreaterThan(rootTwo, 3/2),
		)
		show(
			"Number.isGreaterThan(_ Number) [Transcendental]",
			Number.isGreaterThan(Number.TAU, Number.PI),
		)
		show(
			"Number.isGreaterThanOrEqualTo(_ Number) [Integer]",
			Number.isGreaterThanOrEqualTo(3, Number.PI),
		)
		show(
			"Number.isGreaterThanOrEqualTo(_ Number) [Rational]",
			Number.isGreaterThanOrEqualTo(22/7, Number.PI),
		)
		show(
			"Number.isGreaterThanOrEqualTo(_ Number) [Algebraic]",
			Number.isGreaterThanOrEqualTo(rootTwo, rootTwo),
		)
		show(
			"Number.isGreaterThanOrEqualTo(_ Number) [Transcendental]",
			Number.isGreaterThanOrEqualTo(Number.TAU, Number.PI),
		)
		show(
			"Number.isBetween(_ Number, and: Number) [Integer]",
			Number.isBetween(5, 1, and 10),
		)
		show(
			"Number.isBetween(_ Number, and: Number) [Rational]",
			Number.isBetween(22/7, 3, and 4),
		)
		show(
			"Number.isBetween(_ Number, and: Number) [Algebraic]",
			Number.isBetween(rootTwo, 1, and 2),
		)
		show(
			"Number.isBetween(_ Number, and: Number) [Transcendental]",
			Number.isBetween(Number.PI, 3, and 22/7),
		)
		show(
			"Number.isBetween(_ Number, and: Number) [outside]",
			Number.isBetween(Number.PI, 22/7, and 4),
		)
		show(
			"Number.isBetween(_ Number, and: Number) [on the bound]",
			Number.isBetween(5, 5, and 5),
		)
		<- {}
	})

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
	show("Number.average(_ List<Integer>)", Number.average([1, 2]))
	show("Number.average(_ List<Integer>) [empty]", Number.average(noNumbers))
	show("Number.average(_ List<Rational>)", Number.average([1/2, 1/3]))
	show(
		"Number.average(_ List<Rational>) [empty]",
		Number.average(noRationals),
	)
	show("Number.average(_ List<Integer | Rational>)", Number.average([1, 1/2]))
	show(
		"Number.average(_ List<Integer | Rational>) [empty]",
		Number.average(noMixedNumbers),
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
	show("Number.lowestNumber(_ List<Integer>)", Number.lowestNumber([3, 1, 2]))
	show(
		"Number.lowestNumber(_ List<Integer>) [empty]",
		Number.lowestNumber(noNumbers),
	)
	show(
		"Number.lowestNumber(_ List<Rational>)",
		Number.lowestNumber([1/2, 1/3]),
	)
	show(
		"Number.lowestNumber(_ List<Rational>) [empty]",
		Number.lowestNumber(noRationals),
	)
	show(
		"Number.lowestNumber(_ List<Integer | Rational>)",
		Number.lowestNumber([1, 1/2]),
	)
	show(
		"Number.lowestNumber(_ List<Integer | Rational>) [empty]",
		Number.lowestNumber(noMixedNumbers),
	)
	show(
		"Number.greatestNumber(_ Integer, _ Integer)",
		Number.greatestNumber(3, 2),
	)
	show(
		"Number.greatestNumber(_ Rational, _ Rational)",
		Number.greatestNumber(1/2, 1/3),
	)
	show(
		"Number.greatestNumber(_ Integer, _ Rational)",
		Number.greatestNumber(1, 2/3),
	)
	show(
		"Number.greatestNumber(_ Rational, _ Integer)",
		Number.greatestNumber(2/3, 1),
	)
	show(
		"Number.greatestNumber(_ List<Integer>)",
		Number.greatestNumber([3, 1, 2]),
	)
	show(
		"Number.greatestNumber(_ List<Integer>) [empty]",
		Number.greatestNumber(noNumbers),
	)
	show(
		"Number.greatestNumber(_ List<Rational>)",
		Number.greatestNumber([1/2, 1/3]),
	)
	show(
		"Number.greatestNumber(_ List<Rational>) [empty]",
		Number.greatestNumber(noRationals),
	)
	show(
		"Number.greatestNumber(_ List<Integer | Rational>)",
		Number.greatestNumber([1, 1/2]),
	)
	show(
		"Number.greatestNumber(_ List<Integer | Rational>) [empty]",
		Number.greatestNumber(noMixedNumbers),
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
	show(
		"Optional.otherwise<ItemType>(_ ItemType) [present]",
		numbers::firstItem()::otherwise(0),
	)
	show(
		"Optional.otherwise<ItemType>(_ ItemType) [empty]",
		noNumbers::firstItem()::otherwise(42),
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
		"Optional.keep<ItemType>(where: (_ ItemType) -> Boolean)",
		numbers::firstItem()::keep(where (item) { <- item::isPositive() }),
	)
	show(
		"Optional.keep<ItemType>(where: (_ ItemType) -> Boolean) [rejected]",
		numbers::firstItem()::keep(where (item) { <- item::isNegative() }),
	)

	§ Equality is DERIVED, not written — a Choice compares by tag and then by
	§ payload, through the payload's own `is`.
	show(
		"Choice_Equatable.is(_ Optional<ItemType>)",
		numbers::firstItem()::is(#Value(3)),
	)
	show(
		"Choice_Equatable.is(_ Optional<ItemType>) [different payload]",
		numbers::firstItem()::is(#Value(1)),
	)
	show(
		"Choice_Equatable.is(_ Optional<ItemType>) [empty against value]",
		noNumbers::firstItem()::is(#Value(3)),
	)
	show(
		"Choice_Equatable.is(_ Optional<ItemType>) [both empty]",
		noNumbers::firstItem()::is(#Empty),
	)
	show(
		"Choice_Equatable.isNot(_ Optional<ItemType>)",
		numbers::firstItem()::isNot(#Value(2)),
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
	show("Ordering.toString() [Less]", less::toString())
	show("Ordering.toString() [Equal]", equal::toString())
	show("Ordering.toString() [Greater]", greater::toString())

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
	show("Side.toString() [Start]", atStart::toString())
	show("Side.toString() [End]", atEnd::toString())
	show("Side.toString() [BothEnds]", atBothEnds::toString())

	§ ——— Case —————————————————————————————————————————————————————————————
	constant sensitive: Case   = #Sensitive
	constant insensitive: Case = #Insensitive

	show("Choice_Equatable.is(_ Case) [Sensitive]", sensitive::is(#Sensitive))
	show(
		"Choice_Equatable.is(_ Case) [Insensitive]",
		insensitive::is(#Insensitive),
	)
	show("Choice_Equatable.is(_ Case) [differing]", sensitive::is(#Insensitive))
	show(
		"Choice_Equatable.isNot(_ Case) [differing]",
		sensitive::isNot(#Insensitive),
	)
	show("Choice_Equatable.isNot(_ Case) [same]", sensitive::isNot(#Sensitive))
	show("Case.toString() [Sensitive]", sensitive::toString())
	show("Case.toString() [Insensitive]", insensitive::toString())

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
		"NormalizationForm.toString() [ComposedCanonical]",
		composedCanonical::toString(),
	)
	show(
		"NormalizationForm.toString() [DecomposedCanonical]",
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
	show("NumberFormat.toString() [Fraction]", asFraction::toString())
	show("NumberFormat.toString() [Decimal]", asDecimal::toString())

	§ ——— Rounding —————————————————————————————————————————————————————————
	constant toNearest: Rounding    = #Nearest
	constant toDown: Rounding       = #Down
	constant toUp: Rounding         = #Up
	constant toTowardZero: Rounding = #TowardZero

	show("Choice_Equatable.is(_ Rounding)", toNearest::is(#Nearest))
	show("Choice_Equatable.is(_ Rounding) [differing]", toNearest::is(#Down))
	show("Choice_Equatable.isNot(_ Rounding)", toNearest::isNot(#Down))
	show("Choice_Equatable.isNot(_ Rounding) [same]", toDown::isNot(#Down))
	show("Rounding.toString() [Nearest]", toNearest::toString())
	show("Rounding.toString() [Down]", toDown::toString())
	show("Rounding.toString() [Up]", toUp::toString())
	show("Rounding.toString() [TowardZero]", toTowardZero::toString())

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
	show(
		"List.isNot<ItemType is Equatable>(_ List<ItemType>)",
		numbers::isNot(singleNumber),
	)
	show(
		"List.isNot<ItemType is Equatable>(_ List<ItemType>) [equal]",
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
	show("List.lastItem<ItemType>()", numbers::lastItem())
	show("List.lastItem<ItemType>() [empty]", noNumbers::lastItem())
	show("List.lastItem<ItemType>() [single]", singleNumber::lastItem())
	show("List.removeFirst<ItemType>()", numbers::removeFirst())
	show("List.removeFirst<ItemType>() [empty]", noNumbers::removeFirst())
	show("List.removeFirst<ItemType>(_ Integer)", numbers::removeFirst(2))
	show(
		"List.removeFirst<ItemType>(_ Integer) [zero]",
		numbers::removeFirst(0),
	)
	show(
		"List.removeFirst<ItemType>(_ Integer) [past the end]",
		numbers::removeFirst(99),
	)
	show(
		"List.removeFirst<ItemType>(_ Integer) [negative]",
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
	show("List.removeLast<ItemType>()", numbers::removeLast())
	show("List.removeLast<ItemType>() [empty]", noNumbers::removeLast())
	show("List.removeLast<ItemType>(_ Integer)", numbers::removeLast(2))
	show("List.removeLast<ItemType>(_ Integer) [zero]", numbers::removeLast(0))
	show(
		"List.removeLast<ItemType>(_ Integer) [past the end]",
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
		"List.keepEvery<ItemType>(where: (_ ItemType) -> Boolean)",
		numbers::keepEvery(where (item) { <- item::isGreaterThan(1) }),
	)
	show(
		"List.keepEvery<ItemType>(where: (_ ItemType) -> Boolean) [no match]",
		numbers::keepEvery(where (item) { <- item::isGreaterThan(9) }),
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
		"List.firstIndex<ItemType is Equatable>(of: ItemType)",
		numbers::firstIndex(of 1),
	)
	show(
		"List.firstIndex<ItemType is Equatable>(of: ItemType) [absent]",
		numbers::firstIndex(of 9),
	)
	show(
		"List.slice<ItemType>(from: Integer, to: Integer)",
		numbers::slice(from 1, to 3),
	)
	show(
		"List.slice<ItemType>(from: Integer, to: Integer) [empty range]",
		numbers::slice(from 2, to 2),
	)
	show(
		"List.slice<ItemType>(from: Integer, to: Integer) [past the end]",
		numbers::slice(from 3, to 99),
	)
	show(
		"List.slice<ItemType>(from: Integer, to: Integer) [negative to]",
		numbers::slice(from 0, to -1),
	)
	show(
		"List.slice<ItemType>(from: Integer, to: Integer) [negative from]",
		numbers::slice(from -2, to 5),
	)
	show(
		"List.slice<ItemType>(from: Integer, to: Integer) [both negative]",
		numbers::slice(from -3, to -1),
	)
	show(
		"List.slice<ItemType>(from: Integer, to: Integer) [negative past the start]",
		numbers::slice(from -99, to 2),
	)
	show("List.reverse<ItemType>()", numbers::reverse())
	show("List.reverse<ItemType>() [empty]", noNumbers::reverse())
	show("List.sort<ItemType is Comparable>()", [3, 1, 2]::sort())
	show(
		"List.sort<ItemType is Comparable>() [Strings]",
		["banana", "apple"]::sort(),
	)
	show("List.sort<ItemType is Comparable>() [empty]", noNumbers::sort())
	show(
		"List.sort<ItemType>(by: (_ ItemType, _ ItemType) -> Ordering)",
		numbers::sort(by (first, second) { <- first::compare(to second) }),
	)
	show(
		"List.sort<ItemType>(by: (_ ItemType, _ ItemType) -> Ordering) [empty]",
		noNumbers::sort(by (first, second) { <- first::compare(to second) }),
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
		"List.anyItem<ItemType>(where: (_ ItemType) -> Boolean)",
		numbers::anyItem(where (item) { <- item::isGreaterThan(3) }),
	)
	show(
		"List.anyItem<ItemType>(where: (_ ItemType) -> Boolean) [no match]",
		numbers::anyItem(where (item) { <- item::isGreaterThan(9) }),
	)
	show(
		"List.anyItem<ItemType>(where: (_ ItemType) -> Boolean) [empty]",
		noNumbers::anyItem(where (item) { <- item::isGreaterThan(0) }),
	)
	show(
		"List.everyItem<ItemType>(where: (_ ItemType) -> Boolean)",
		numbers::everyItem(where (item) { <- item::isGreaterThan(0) }),
	)
	show(
		"List.everyItem<ItemType>(where: (_ ItemType) -> Boolean) [no match]",
		numbers::everyItem(where (item) { <- item::isGreaterThan(3) }),
	)
	show(
		"List.everyItem<ItemType>(where: (_ ItemType) -> Boolean) [empty]",
		noNumbers::everyItem(where (item) { <- item::isGreaterThan(0) }),
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
	show(
		"List.lastIndex<ItemType is Equatable>(of: ItemType)",
		numbers::lastIndex(of 1),
	)
	show(
		"List.lastIndex<ItemType is Equatable>(of: ItemType) [absent]",
		numbers::lastIndex(of 9),
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
	§ `{ matching = [ 2, 4 ], rest = [ 3, 1, 1 ] }` sits at forty-three
	§ characters — seventeen under the sixty at which `getStringRepresentation`
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
	§ One pair only: the pretty printer wraps a Record List past sixty
	§ characters, and every line of this file's output has to stay one line.
	show(
		"List.pair<ItemType, Other>(with: List<Other>)",
		["a"]::pair(with [1, 2, 3]),
	)
	show(
		"List.pair<ItemType, Other>(with: List<Other>) [empty]",
		["a", "b"]::pair(with noNumbers),
	)
	show(
		"List.split<ItemType>(intoGroupsOf: Integer)",
		[1, 2, 3, 4, 5]::split(intoGroupsOf 2),
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
		"List.repeat<ItemType>(_ ItemType, times: Integer)",
		List.repeat("x", times 3),
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

	§ ——— NestedList ———————————————————————————————————————————————————————
	show("NestedList.flatten<ItemType>()", [[1, 2], [3]]::flatten())
	show("NestedList.flatten<ItemType>() [empty]", noNestedNumbers::flatten())

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
		loop(startingWith 1, until (n) {
			<- n::isGreaterThanOrEqualTo(100)
		}, step (n) { <- n::multiply(with 2) }),
	)
	show(
		"loop<State>(startingWith: State, until: (_ State) -> Boolean, step: (_ State) -> State) [zero turns]",
		loop(startingWith 500, until (n) {
			<- n::isGreaterThanOrEqualTo(100)
		}, step (n) { <- n::multiply(with 2) }),
	)
	show(
		"loop<State, Result>(startingWith: State, step: (_ State) -> Step<State, Result>)",
		loop(startingWith { index = 1, total = 0 }, step (state) {
			if state.index::isGreaterThan(5) {
				<- #Done(state.total)
			}

			<- #Continue({ state with index = state.index::add(1),
			total = state.total::add(state.index) })
		}),
	)
}
