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
	§ Method returns except an `Optional` — an `ItemType | Nothing` Union
	§ belongs to no Namespace, so `showMaybe` matches it apart first.
	function show <infer Value is Printable>(_ label: String, _ value: Value) -> Nothing {
		__print(label::append(" => ")::append(value::toString()))
		<- nothing
	}

	function showMaybe <infer Value is Printable>(
		_ label: String,
		_ value: Optional<Value>,
	) -> Nothing {
		<- show(label, match value -> String {
			case Nothing { <- "Nothing" }
			case Value { <- @::toString() }
		})
	}

	§ An Algebraic can not be written as a literal — it is only ever reached
	§ through `squareRoot`, whose result is an Optional the caller has to
	§ match apart. These two hand one to a body so that the Methods needing
	§ an Algebraic receiver or Argument read as ordinary calls.
	function withRootTwo(_ body: (_ rootTwo: Algebraic) -> Nothing) -> Nothing {
		<- match 2::squareRoot() -> Nothing {
			case Algebraic { <- body(@) }
			case Integer { <- nothing }
			case Nothing { <- nothing }
		}
	}

	function withTwoRoots(
		_ body: (_ rootTwo: Algebraic, _ rootThree: Algebraic) -> Nothing,
	) -> Nothing {
		<- withRootTwo((_ rootTwo: Algebraic) -> Nothing {
			<- match 3::squareRoot() -> Nothing {
				case Algebraic { <- body(rootTwo, @) }
				case Integer { <- nothing }
				case Nothing { <- nothing }
			}
		})
	}

	constant greeting = "Hello, World"
	constant emptyText = ""
	constant numbers = [3, 1, 2, 1, 4]
	constant singleNumber = [7]
	constant noNumbers: List<Integer> = []
	constant noRationals: List<Rational> = []
	constant noMixedNumbers: List<Integer | Rational> = []
	constant noNestedNumbers: List<List<Integer>> = []

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
	show("String.prepend(_ String)", greeting::prepend(">> "))
	show("String.prepend(_ String) [empty]", greeting::prepend(emptyText))
	show("String.append(_ String)", greeting::append("!"))
	show("String.append(_ String) [empty]", greeting::append(emptyText))
	show("String.splitOn(_ String)", "a,b,c"::splitOn(","))
	show("String.splitOn(_ String) [no match]", greeting::splitOn(";"))
	show("String.splitOn(_ String) [empty separator]", "abc"::splitOn(""))
	show("String.splitOn(_ String) [empty receiver]", emptyText::splitOn(","))
	show("String.contains(_ String)", greeting::contains("lo,"))
	show("String.contains(_ String) [absent]", greeting::contains("zz"))
	show("String.doesNotContain(_ String)", greeting::doesNotContain("zz"))
	show("String.doesNotContain(_ String) [present]", greeting::doesNotContain("lo,"))
	show("String.length()", greeting::length())
	show("String.length() [empty]", emptyText::length())
	show("String.length() [astral]", "a😀b"::length())
	show("String.characters()", "a😀b"::characters())
	show("String.characters() [empty]", emptyText::characters())
	showMaybe("String.characterAt(_ Integer)", greeting::characterAt(1))
	showMaybe("String.characterAt(_ Integer) [zero]", greeting::characterAt(0))
	showMaybe("String.characterAt(_ Integer) [negative]", greeting::characterAt(-1))
	showMaybe("String.characterAt(_ Integer) [at length]", greeting::characterAt(greeting::length()))
	show("String.uppercased()", greeting::uppercased())
	show("String.uppercased() [empty]", emptyText::uppercased())
	show("String.lowercased()", greeting::lowercased())
	show("String.trimmed()", "  spaced  "::trimmed())
	show("String.trimmed() [nothing to trim]", greeting::trimmed())
	show("String.trimmedAtStart()", "  spaced  "::trimmedAtStart())
	show("String.trimmedAtEnd()", "  spaced  "::trimmedAtEnd())
	show("String.startsWith(_ String)", greeting::startsWith("Hello"))
	show("String.startsWith(_ String) [absent]", greeting::startsWith("World"))
	show("String.startsWith(_ String) [empty prefix]", greeting::startsWith(emptyText))
	show("String.doesNotStartWith(_ String)", greeting::doesNotStartWith("World"))
	show("String.doesNotStartWith(_ String) [present]", greeting::doesNotStartWith("Hello"))
	show("String.endsWith(_ String)", greeting::endsWith("World"))
	show("String.endsWith(_ String) [absent]", greeting::endsWith("Hello"))
	show("String.doesNotEndWith(_ String)", greeting::doesNotEndWith("!"))
	show("String.doesNotEndWith(_ String) [present]", greeting::doesNotEndWith("World"))
	show("String.replaceEvery(_ String, with: String)", greeting::replaceEvery("o", with "0"))
	show("String.replaceEvery(_ String, with: String) [no match]", greeting::replaceEvery("z", with "0"))
	show("String.repeated(_ Integer)", "ab"::repeated(3))
	show("String.repeated(_ Integer) [zero]", "ab"::repeated(0))
	show("String.repeated(_ Integer) [negative]", "ab"::repeated(-1))
	show("String.reverse()", greeting::reverse())
	show("String.reverse() [astral]", "a😀b"::reverse())
	show("String.slice(from: Integer, to: Integer)", greeting::slice(from 0, to 5))
	show("String.slice(from: Integer, to: Integer) [empty range]", greeting::slice(from 3, to 3))
	show("String.slice(from: Integer, to: Integer) [past the end]", greeting::slice(from 7, to 99))
	showMaybe("String.firstIndexOf(_ String)", greeting::firstIndexOf("World"))
	showMaybe("String.firstIndexOf(_ String) [absent]", greeting::firstIndexOf("zz"))
	show("String.paddedAtStart(to: Integer, with: String)", "7"::paddedAtStart(to 3, with "0"))
	show("String.paddedAtStart(to: Integer, with: String) [already long enough]", greeting::paddedAtStart(to 3, with "0"))
	show("String.paddedAtEnd(to: Integer, with: String)", "7"::paddedAtEnd(to 3, with "."))
	show("String.paddedAtEnd(to: Integer, with: String) [already long enough]", greeting::paddedAtEnd(to 3, with "."))
	show("String.compareTo(_ String)", "app"::compareTo("apple"))
	show("String.compareTo(_ String) [equal]", greeting::compareTo("Hello, World"))
	show("String.compareTo(_ String) [greater]", "b"::compareTo("a"))
	show("String.toString()", greeting::toString())
	show("String.toString() [empty]", emptyText::toString())

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
	showMaybe("Integer.divideBy(_ Integer)", 1110::divideBy(2))
	showMaybe("Integer.divideBy(_ Integer) [by zero]", 1::divideBy(0))
	showMaybe("Integer.divideBy(_ Rational)", 1::divideBy(1/2))
	showMaybe("Integer.divideBy(_ Rational) [by zero]", 1::divideBy(0/1))
	show("Integer.multiplyWith(_ Integer)", 100::multiplyWith(1000))
	show("Integer.multiplyWith(_ Integer) [beyond IEEE 754]", 9_007_199_254_740_991::multiplyWith(500))
	show("Integer.multiplyWith(_ Rational)", 3::multiplyWith(1/3))
	show("Integer.multiplyWith(_ Transcendental)", 2::multiplyWith(Number.PI))
	show("Integer.multiplyWith(_ Transcendental) [collapses to Rational]", 0::multiplyWith(Number.PI))
	show("Integer.isLessThan(_ Integer)", 1::isLessThan(2))
	show("Integer.isLessThan(_ Integer) [equal]", 2::isLessThan(2))
	show("Integer.isLessThan(_ Rational)", 1::isLessThan(3/2))
	show("Integer.isLessThan(_ Rational) [greater]", 2::isLessThan(3/2))
	show("Integer.isLessThanOrEqualTo(_ Integer)", 2::isLessThanOrEqualTo(2))
	show("Integer.isLessThanOrEqualTo(_ Integer) [greater]", 3::isLessThanOrEqualTo(2))
	show("Integer.isLessThanOrEqualTo(_ Rational)", 2::isLessThanOrEqualTo(3/2))
	show("Integer.isLessThanOrEqualTo(_ Rational) [less]", 1::isLessThanOrEqualTo(3/2))
	show("Integer.isGreaterThan(_ Integer)", 3::isGreaterThan(2))
	show("Integer.isGreaterThan(_ Integer) [equal]", 2::isGreaterThan(2))
	show("Integer.isGreaterThan(_ Rational)", 1::isGreaterThan(3/2))
	show("Integer.isGreaterThan(_ Rational) [greater]", 2::isGreaterThan(3/2))
	show("Integer.isGreaterThanOrEqualTo(_ Integer)", 2::isGreaterThanOrEqualTo(2))
	show("Integer.isGreaterThanOrEqualTo(_ Integer) [less]", 1::isGreaterThanOrEqualTo(2))
	show("Integer.isGreaterThanOrEqualTo(_ Rational)", 2::isGreaterThanOrEqualTo(3/2))
	show("Integer.isGreaterThanOrEqualTo(_ Rational) [less]", 1::isGreaterThanOrEqualTo(3/2))
	showMaybe("Integer.squareRoot() [perfect square]", 9::squareRoot())
	showMaybe("Integer.squareRoot() [irrational]", 2::squareRoot())
	showMaybe("Integer.squareRoot() [zero]", 0::squareRoot())
	showMaybe("Integer.squareRoot() [negative]", -1::squareRoot())
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
	showMaybe("Integer.remainderOf(dividingBy: Integer)", 7::remainderOf(dividingBy 3))
	showMaybe("Integer.remainderOf(dividingBy: Integer) [negative dividend]", -7::remainderOf(dividingBy 3))
	showMaybe("Integer.remainderOf(dividingBy: Integer) [by zero]", 7::remainderOf(dividingBy 0))
	showMaybe("Integer.toThePowerOf(_ Integer)", 2::toThePowerOf(10))
	showMaybe("Integer.toThePowerOf(_ Integer) [zero exponent]", 2::toThePowerOf(0))
	showMaybe("Integer.toThePowerOf(_ Integer) [negative exponent]", 2::toThePowerOf(-2))
	showMaybe("Integer.toThePowerOf(_ Integer) [zero to a negative power]", 0::toThePowerOf(-1))
	showMaybe("Integer.clampedBetween(_ Integer, and: Integer) [above]", 15::clampedBetween(1, and 10))
	showMaybe("Integer.clampedBetween(_ Integer, and: Integer) [below]", -2::clampedBetween(1, and 10))
	showMaybe("Integer.clampedBetween(_ Integer, and: Integer) [within]", 5::clampedBetween(1, and 10))
	showMaybe("Integer.clampedBetween(_ Integer, and: Integer) [inverted bounds]", 5::clampedBetween(10, and 1))
	showMaybe("Integer.parse(_ String)", Integer.parse("42"))
	showMaybe("Integer.parse(_ String) [negative]", Integer.parse("-42"))
	showMaybe("Integer.parse(_ String) [not a number]", Integer.parse("nope"))
	showMaybe("Integer.parse(_ String) [empty]", Integer.parse(emptyText))
	show("Integer.toString()", 42::toString())
	show("Integer.toString() [negative]", -42::toString())
	show("Integer.compareTo(_ Integer)", 1::compareTo(2))
	show("Integer.compareTo(_ Integer) [equal]", 2::compareTo(2))
	show("Integer.compareTo(_ Integer) [greater]", 3::compareTo(2))

	withRootTwo((_ rootTwo: Algebraic) -> Nothing {
		show("Integer.add(_ Algebraic)", 1::add(rootTwo))
		show("Integer.subtract(_ Algebraic)", 1::subtract(rootTwo))
		show("Integer.divideBy(_ Algebraic)", 1::divideBy(rootTwo))
		show("Integer.multiplyWith(_ Algebraic)", 3::multiplyWith(rootTwo))
		show("Integer.multiplyWith(_ Algebraic) [collapses to Rational]", 0::multiplyWith(rootTwo))
		<- nothing
	})

	§ ——— Rational —————————————————————————————————————————————————————————
	showMaybe("Rational.of(_ Integer, over: Integer)", Rational.of(1, over 2))
	showMaybe("Rational.of(_ Integer, over: Integer) [over zero]", Rational.of(1, over 0))
	showMaybe("Rational.of(_ Integer, over: Integer) [not reduced]", Rational.of(4, over 8))
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
	showMaybe("Rational.divideBy(_ Rational)", 1/2::divideBy(1/6))
	showMaybe("Rational.divideBy(_ Rational) [by zero]", 1/2::divideBy(0/1))
	showMaybe("Rational.divideBy(_ Integer)", 1/2::divideBy(2))
	showMaybe("Rational.divideBy(_ Integer) [by zero]", 1/2::divideBy(0))
	show("Rational.multiplyWith(_ Rational)", 1/2::multiplyWith(2/3))
	show("Rational.multiplyWith(_ Integer)", 1/2::multiplyWith(2))
	show("Rational.multiplyWith(_ Transcendental)", 1/2::multiplyWith(Number.PI))
	show("Rational.multiplyWith(_ Transcendental) [collapses to Rational]", 0/1::multiplyWith(Number.PI))
	show("Rational.isLessThan(_ Rational)", 1/2::isLessThan(2/3))
	show("Rational.isLessThan(_ Rational) [greater]", 2/3::isLessThan(1/2))
	show("Rational.isLessThan(_ Integer)", 1/2::isLessThan(1))
	show("Rational.isLessThan(_ Integer) [greater]", 3/2::isLessThan(1))
	show("Rational.isLessThanOrEqualTo(_ Rational)", 1/2::isLessThanOrEqualTo(1/2))
	show("Rational.isLessThanOrEqualTo(_ Rational) [greater]", 2/3::isLessThanOrEqualTo(1/2))
	show("Rational.isLessThanOrEqualTo(_ Integer)", 1/2::isLessThanOrEqualTo(0))
	show("Rational.isLessThanOrEqualTo(_ Integer) [less]", 1/2::isLessThanOrEqualTo(1))
	show("Rational.isGreaterThan(_ Rational)", 2/3::isGreaterThan(1/2))
	show("Rational.isGreaterThan(_ Rational) [less]", 1/2::isGreaterThan(2/3))
	show("Rational.isGreaterThan(_ Integer)", 1/2::isGreaterThan(1))
	show("Rational.isGreaterThan(_ Integer) [greater]", 3/2::isGreaterThan(1))
	show("Rational.isGreaterThanOrEqualTo(_ Rational)", 1/2::isGreaterThanOrEqualTo(1/2))
	show("Rational.isGreaterThanOrEqualTo(_ Rational) [less]", 1/2::isGreaterThanOrEqualTo(2/3))
	show("Rational.isGreaterThanOrEqualTo(_ Integer)", 3/2::isGreaterThanOrEqualTo(1))
	show("Rational.isGreaterThanOrEqualTo(_ Integer) [less]", 1/2::isGreaterThanOrEqualTo(1))
	showMaybe("Rational.squareRoot() [perfect square]", 1/4::squareRoot())
	showMaybe("Rational.squareRoot() [irrational]", 1/2::squareRoot())
	showMaybe("Rational.squareRoot() [negative]", -1/2::squareRoot())
	show("Rational.numerator()", 3/4::numerator())
	show("Rational.denominator()", 3/4::denominator())
	show("Rational.absolute()", -3/4::absolute())
	show("Rational.negate()", 3/4::negate())
	showMaybe("Rational.reciprocal()", 3/4::reciprocal())
	showMaybe("Rational.reciprocal() [of zero]", 0/1::reciprocal())
	show("Rational.isWholeNumber()", 4/2::isWholeNumber())
	show("Rational.isWholeNumber() [fractional]", 3/4::isWholeNumber())
	show("Rational.round()", 7/2::round())
	show("Rational.round() [negative]", -7/2::round())
	show("Rational.roundDown()", 7/2::roundDown())
	show("Rational.roundDown() [negative]", -7/2::roundDown())
	show("Rational.roundUp()", 7/2::roundUp())
	show("Rational.roundUp() [negative]", -7/2::roundUp())
	show("Rational.truncate()", 7/2::truncate())
	show("Rational.truncate() [negative]", -7/2::truncate())
	showMaybe("Rational.toThePowerOf(_ Integer)", 2/3::toThePowerOf(2))
	showMaybe("Rational.toThePowerOf(_ Integer) [zero exponent]", 2/3::toThePowerOf(0))
	showMaybe("Rational.toThePowerOf(_ Integer) [negative exponent]", 2/3::toThePowerOf(-2))
	showMaybe("Rational.toThePowerOf(_ Integer) [zero to a negative power]", 0/1::toThePowerOf(-1))
	showMaybe("Rational.parse(_ String)", Rational.parse("0.75"))
	showMaybe("Rational.parse(_ String) [not a number]", Rational.parse("nope"))
	show("Rational.toString()", 3/4::toString())
	show("Rational.toString() [whole]", 4/2::toString())
	show("Rational.toString(formatAs: String) [decimal]", 1/2::toString(formatAs "decimal"))
	show("Rational.toString(formatAs: String) [fraction]", 1/2::toString(formatAs "fraction"))
	show("Rational.compareTo(_ Rational)", 1/2::compareTo(2/3))
	show("Rational.compareTo(_ Rational) [equal]", 1/2::compareTo(2/4))
	show("Rational.compareTo(_ Rational) [greater]", 2/3::compareTo(1/2))

	withRootTwo((_ rootTwo: Algebraic) -> Nothing {
		show("Rational.add(_ Algebraic)", 1/2::add(rootTwo))
		show("Rational.subtract(_ Algebraic)", 1/2::subtract(rootTwo))
		show("Rational.divideBy(_ Algebraic)", 1/2::divideBy(rootTwo))
		show("Rational.multiplyWith(_ Algebraic)", 1/2::multiplyWith(rootTwo))
		show("Rational.multiplyWith(_ Algebraic) [collapses to Rational]", 0/1::multiplyWith(rootTwo))
		<- nothing
	})

	§ ——— Algebraic ————————————————————————————————————————————————————————
	withTwoRoots((_ rootTwo: Algebraic, _ rootThree: Algebraic) -> Nothing {
		show("Algebraic.is(_ Algebraic)", rootTwo::is(rootTwo))
		show("Algebraic.is(_ Algebraic) [differing radicals]", rootTwo::is(rootThree))
		show("Algebraic.isNot(_ Algebraic)", rootTwo::isNot(rootThree))
		show("Algebraic.isNot(_ Algebraic) [equal]", rootTwo::isNot(rootTwo))
		show("Algebraic.compareTo(_ Algebraic)", rootTwo::compareTo(rootThree))
		show("Algebraic.compareTo(_ Algebraic) [equal]", rootTwo::compareTo(rootTwo))
		show("Algebraic.compareTo(_ Algebraic) [greater]", rootThree::compareTo(rootTwo))
		show("Algebraic.add(_ Integer)", rootTwo::add(1))
		show("Algebraic.add(_ Rational)", rootTwo::add(1/2))
		showMaybe("Algebraic.add(_ Algebraic) [same radical]", rootTwo::add(rootTwo))
		showMaybe("Algebraic.add(_ Algebraic) [differing radicals]", rootTwo::add(rootThree))
		show("Algebraic.subtract(_ Integer)", rootTwo::subtract(1))
		show("Algebraic.subtract(_ Rational)", rootTwo::subtract(1/2))
		showMaybe("Algebraic.subtract(_ Algebraic) [same radical]", rootTwo::subtract(rootTwo))
		showMaybe("Algebraic.subtract(_ Algebraic) [differing radicals]", rootTwo::subtract(rootThree))
		show("Algebraic.multiplyWith(_ Integer)", rootTwo::multiplyWith(3))
		show("Algebraic.multiplyWith(_ Integer) [by zero]", rootTwo::multiplyWith(0))
		show("Algebraic.multiplyWith(_ Rational)", rootTwo::multiplyWith(1/2))
		showMaybe("Algebraic.multiplyWith(_ Algebraic) [same radical]", rootTwo::multiplyWith(rootTwo))
		showMaybe("Algebraic.multiplyWith(_ Algebraic) [differing radicals]", rootTwo::multiplyWith(rootThree))
		showMaybe("Algebraic.divideBy(_ Integer)", rootTwo::divideBy(2))
		showMaybe("Algebraic.divideBy(_ Integer) [by zero]", rootTwo::divideBy(0))
		showMaybe("Algebraic.divideBy(_ Rational)", rootTwo::divideBy(1/2))
		showMaybe("Algebraic.divideBy(_ Rational) [by zero]", rootTwo::divideBy(0/1))
		showMaybe("Algebraic.divideBy(_ Algebraic) [same radical]", rootTwo::divideBy(rootTwo))
		showMaybe("Algebraic.divideBy(_ Algebraic) [differing radicals]", rootTwo::divideBy(rootThree))
		show("Algebraic.absolute()", rootTwo::absolute())
		show("Algebraic.absolute() [negative]", rootTwo::negate()::absolute())
		show("Algebraic.negate()", rootTwo::negate())
		show("Algebraic.toString()", rootTwo::toString())
		<- nothing
	})

	§ ——— Transcendental ———————————————————————————————————————————————————
	show("Transcendental.is(_ Transcendental)", Number.PI::is(Number.PI))
	show("Transcendental.is(_ Transcendental) [differing]", Number.PI::is(Number.TAU))
	show("Transcendental.isNot(_ Transcendental)", Number.PI::isNot(Number.TAU))
	show("Transcendental.isNot(_ Transcendental) [equal]", Number.PI::isNot(Number.PI))
	show("Transcendental.add(_ Integer)", Number.PI::add(1))
	show("Transcendental.add(_ Rational)", Number.PI::add(1/2))
	show("Transcendental.add(_ Transcendental)", Number.PI::add(Number.PI))
	show("Transcendental.subtract(_ Integer)", Number.PI::subtract(1))
	show("Transcendental.subtract(_ Rational)", Number.PI::subtract(1/2))
	show("Transcendental.subtract(_ Transcendental) [collapses to Rational]", Number.PI::subtract(Number.PI))
	show("Transcendental.subtract(_ Transcendental) [stays Transcendental]", Number.TAU::subtract(Number.PI))
	show("Transcendental.multiplyWith(_ Integer)", Number.PI::multiplyWith(2))
	show("Transcendental.multiplyWith(_ Integer) [by zero]", Number.PI::multiplyWith(0))
	show("Transcendental.multiplyWith(_ Rational)", Number.PI::multiplyWith(1/2))
	showMaybe("Transcendental.divideBy(_ Integer)", Number.PI::divideBy(2))
	showMaybe("Transcendental.divideBy(_ Integer) [by zero]", Number.PI::divideBy(0))
	showMaybe("Transcendental.divideBy(_ Rational)", Number.PI::divideBy(1/2))
	showMaybe("Transcendental.divideBy(_ Rational) [by zero]", Number.PI::divideBy(0/1))
	showMaybe("Transcendental.divideBy(_ Transcendental) [proportional]", Number.TAU::divideBy(Number.PI))
	show("Transcendental.absolute()", Number.PI::absolute())
	show("Transcendental.absolute() [negative]", Number.PI::negate()::absolute())
	show("Transcendental.negate()", Number.PI::negate())
	show("Transcendental.toString()", Number.PI::toString())

	§ ——— Number ———————————————————————————————————————————————————————————
	§ Reached through the Namespace spelling throughout, because the `::`
	§ spelling only lands here when no narrower Namespace matches — every
	§ Method below shares its name with one on Integer or Rational.
	show("Number.PI", Number.PI)
	show("Number.TAU", Number.TAU)

	withRootTwo((_ rootTwo: Algebraic) -> Nothing {
		show("Number.is(_ Number) [Integer]", Number.is(2, 2/1))
		show("Number.is(_ Number) [Rational]", Number.is(1/2, 1))
		show("Number.is(_ Number) [Algebraic]", Number.is(rootTwo, 2))
		show("Number.is(_ Number) [Transcendental]", Number.is(Number.PI::multiplyWith(2), Number.TAU))
		show("Number.isNot(_ Number) [Integer]", Number.isNot(2, 2/1))
		show("Number.isNot(_ Number) [Rational]", Number.isNot(1/2, 1))
		show("Number.isNot(_ Number) [Algebraic]", Number.isNot(rootTwo, 2))
		show("Number.isNot(_ Number) [Transcendental]", Number.isNot(Number.PI, Number.TAU))
		show("Number.toString() [Integer]", Number.toString(42))
		show("Number.toString() [Rational]", Number.toString(3/4))
		show("Number.toString() [Algebraic]", Number.toString(rootTwo))
		show("Number.toString() [Transcendental]", Number.toString(Number.PI))
		show("Number.compareTo(_ Number) [Integer]", Number.compareTo(3, Number.PI))
		show("Number.compareTo(_ Number) [Rational]", Number.compareTo(22/7, Number.PI))
		show("Number.compareTo(_ Number) [Algebraic]", Number.compareTo(rootTwo, 3/2))
		show("Number.compareTo(_ Number) [Transcendental]", Number.compareTo(Number.PI, Number.TAU))
		show("Number.isLessThan(_ Number) [Integer]", Number.isLessThan(3, Number.PI))
		show("Number.isLessThan(_ Number) [Rational]", Number.isLessThan(22/7, Number.PI))
		show("Number.isLessThan(_ Number) [Algebraic]", Number.isLessThan(rootTwo, 3/2))
		show("Number.isLessThan(_ Number) [Transcendental]", Number.isLessThan(Number.PI, Number.TAU))
		show("Number.isLessThanOrEqualTo(_ Number) [Integer]", Number.isLessThanOrEqualTo(4, Number.PI))
		show("Number.isLessThanOrEqualTo(_ Number) [Rational]", Number.isLessThanOrEqualTo(22/7, Number.PI))
		show("Number.isLessThanOrEqualTo(_ Number) [Algebraic]", Number.isLessThanOrEqualTo(rootTwo, rootTwo))
		show("Number.isLessThanOrEqualTo(_ Number) [Transcendental]", Number.isLessThanOrEqualTo(Number.PI, Number.PI))
		show("Number.isGreaterThan(_ Number) [Integer]", Number.isGreaterThan(4, Number.PI))
		show("Number.isGreaterThan(_ Number) [Rational]", Number.isGreaterThan(22/7, Number.PI))
		show("Number.isGreaterThan(_ Number) [Algebraic]", Number.isGreaterThan(rootTwo, 3/2))
		show("Number.isGreaterThan(_ Number) [Transcendental]", Number.isGreaterThan(Number.TAU, Number.PI))
		show("Number.isGreaterThanOrEqualTo(_ Number) [Integer]", Number.isGreaterThanOrEqualTo(3, Number.PI))
		show("Number.isGreaterThanOrEqualTo(_ Number) [Rational]", Number.isGreaterThanOrEqualTo(22/7, Number.PI))
		show("Number.isGreaterThanOrEqualTo(_ Number) [Algebraic]", Number.isGreaterThanOrEqualTo(rootTwo, rootTwo))
		show("Number.isGreaterThanOrEqualTo(_ Number) [Transcendental]", Number.isGreaterThanOrEqualTo(Number.TAU, Number.PI))
		show("Number.isBetween(_ Number, and: Number) [Integer]", Number.isBetween(5, 1, and 10))
		show("Number.isBetween(_ Number, and: Number) [Rational]", Number.isBetween(22/7, 3, and 4))
		show("Number.isBetween(_ Number, and: Number) [Algebraic]", Number.isBetween(rootTwo, 1, and 2))
		show("Number.isBetween(_ Number, and: Number) [Transcendental]", Number.isBetween(Number.PI, 3, and 22/7))
		show("Number.isBetween(_ Number, and: Number) [outside]", Number.isBetween(Number.PI, 22/7, and 4))
		show("Number.isBetween(_ Number, and: Number) [on the bound]", Number.isBetween(5, 5, and 5))
		<- nothing
	})

	show("Number.sum(_ List<Integer>)", Number.sum([1, 2, 3]))
	show("Number.sum(_ List<Integer>) [empty]", Number.sum(noNumbers))
	show("Number.sum(_ List<Rational>)", Number.sum([1/2, 1/3]))
	show("Number.sum(_ List<Rational>) [empty]", Number.sum(noRationals))
	show("Number.sum(_ List<Integer | Rational>)", Number.sum([1, 1/2, 1/2]))
	show("Number.sum(_ List<Integer | Rational>) [empty]", Number.sum(noMixedNumbers))
	show("Number.product(_ List<Integer>)", Number.product([2, 3, 4]))
	show("Number.product(_ List<Integer>) [empty]", Number.product(noNumbers))
	show("Number.product(_ List<Rational>)", Number.product([1/2, 2/3]))
	show("Number.product(_ List<Rational>) [empty]", Number.product(noRationals))
	show("Number.product(_ List<Integer | Rational>)", Number.product([2, 1/2, 3]))
	show("Number.product(_ List<Integer | Rational>) [empty]", Number.product(noMixedNumbers))
	showMaybe("Number.average(_ List<Integer>)", Number.average([1, 2]))
	showMaybe("Number.average(_ List<Integer>) [empty]", Number.average(noNumbers))
	showMaybe("Number.average(_ List<Rational>)", Number.average([1/2, 1/3]))
	showMaybe("Number.average(_ List<Rational>) [empty]", Number.average(noRationals))
	showMaybe("Number.average(_ List<Integer | Rational>)", Number.average([1, 1/2]))
	showMaybe("Number.average(_ List<Integer | Rational>) [empty]", Number.average(noMixedNumbers))
	show("Number.lowestNumber(_ Integer, _ Integer)", Number.lowestNumber(3, 2))
	show("Number.lowestNumber(_ Rational, _ Rational)", Number.lowestNumber(1/2, 1/3))
	show("Number.lowestNumber(_ Integer, _ Rational)", Number.lowestNumber(1, 2/3))
	show("Number.lowestNumber(_ Rational, _ Integer)", Number.lowestNumber(2/3, 1))
	showMaybe("Number.lowestNumber(_ List<Integer>)", Number.lowestNumber([3, 1, 2]))
	showMaybe("Number.lowestNumber(_ List<Integer>) [empty]", Number.lowestNumber(noNumbers))
	showMaybe("Number.lowestNumber(_ List<Rational>)", Number.lowestNumber([1/2, 1/3]))
	showMaybe("Number.lowestNumber(_ List<Rational>) [empty]", Number.lowestNumber(noRationals))
	showMaybe("Number.lowestNumber(_ List<Integer | Rational>)", Number.lowestNumber([1, 1/2]))
	showMaybe("Number.lowestNumber(_ List<Integer | Rational>) [empty]", Number.lowestNumber(noMixedNumbers))
	show("Number.greatestNumber(_ Integer, _ Integer)", Number.greatestNumber(3, 2))
	show("Number.greatestNumber(_ Rational, _ Rational)", Number.greatestNumber(1/2, 1/3))
	show("Number.greatestNumber(_ Integer, _ Rational)", Number.greatestNumber(1, 2/3))
	show("Number.greatestNumber(_ Rational, _ Integer)", Number.greatestNumber(2/3, 1))
	showMaybe("Number.greatestNumber(_ List<Integer>)", Number.greatestNumber([3, 1, 2]))
	showMaybe("Number.greatestNumber(_ List<Integer>) [empty]", Number.greatestNumber(noNumbers))
	showMaybe("Number.greatestNumber(_ List<Rational>)", Number.greatestNumber([1/2, 1/3]))
	showMaybe("Number.greatestNumber(_ List<Rational>) [empty]", Number.greatestNumber(noRationals))
	showMaybe("Number.greatestNumber(_ List<Integer | Rational>)", Number.greatestNumber([1, 1/2]))
	showMaybe("Number.greatestNumber(_ List<Integer | Rational>) [empty]", Number.greatestNumber(noMixedNumbers))

	§ ——— Nothing ——————————————————————————————————————————————————————————
	show("Nothing.is(_ Nothing)", nothing::is(nothing))
	show("Nothing.isNot(_ Nothing)", nothing::isNot(nothing))
	show("Nothing.toString()", nothing::toString())

	§ ——— Optional —————————————————————————————————————————————————————————
	show("Optional.otherwise<ItemType>(_ ItemType) [present]", numbers::firstItem()::otherwise(0))
	show("Optional.otherwise<ItemType>(_ ItemType) [Nothing]", noNumbers::firstItem()::otherwise(42))

	§ ——— Ordering —————————————————————————————————————————————————————————
	constant less: Ordering = #Less
	constant equal: Ordering = #Equal
	constant greater: Ordering = #Greater

	show("Ordering.is(_ Ordering) [Less]", less::is(#Less))
	show("Ordering.is(_ Ordering) [Equal]", equal::is(#Equal))
	show("Ordering.is(_ Ordering) [Greater]", greater::is(#Greater))
	show("Ordering.is(_ Ordering) [differing]", less::is(#Greater))
	show("Ordering.isNot(_ Ordering) [Less]", less::isNot(#Equal))
	show("Ordering.isNot(_ Ordering) [Equal]", equal::isNot(#Equal))
	show("Ordering.isNot(_ Ordering) [Greater]", greater::isNot(#Less))
	show("Ordering.toString() [Less]", less::toString())
	show("Ordering.toString() [Equal]", equal::toString())
	show("Ordering.toString() [Greater]", greater::toString())

	§ ——— Record ———————————————————————————————————————————————————————————
	§ LOAD-BEARING: `point` prints as `{ x = 1, y = 2 }`, well under sixty
	§ characters. `getStringRepresentation` has a bug where a Record whose
	§ single-line form reaches sixty characters is printed with every field
	§ doubled and wrapped across lines — which would put a value on more than
	§ one line and break the one-line-per-call contract the golden test reads
	§ by. Keep every printed Record here short until that bug is fixed.
	constant point = { x = 1, y = 2 }

	show("Record.is(_ {})", point::is({ x = 1, y = 2 }))
	show("Record.is(_ {}) [differing]", point::is({ x = 1, y = 3 }))
	show("Record.isNot(_ {})", point::isNot({ x = 1, y = 3 }))
	show("Record.isNot(_ {}) [equal]", point::isNot({ x = 1, y = 2 }))
	show("Record.keys()", point::keys())
	show("Record.toString()", point::toString())

	§ ——— List —————————————————————————————————————————————————————————————
	show("List.is<ItemType is Equatable>(_ List<ItemType>)", numbers::is([3, 1, 2, 1, 4]))
	show("List.is<ItemType is Equatable>(_ List<ItemType>) [differing]", numbers::is(singleNumber))
	show("List.is<ItemType is Equatable>(_ List<ItemType>) [both empty]", noNumbers::is([]))
	show("List.isNot<ItemType is Equatable>(_ List<ItemType>)", numbers::isNot(singleNumber))
	show("List.isNot<ItemType is Equatable>(_ List<ItemType>) [equal]", numbers::isNot([3, 1, 2, 1, 4]))
	show("List.toString<ItemType>()", numbers::toString())
	show("List.toString<ItemType>() [empty]", noNumbers::toString())
	show("List.toString<ItemType>() [single]", singleNumber::toString())
	show("List.length<ItemType>()", numbers::length())
	show("List.length<ItemType>() [empty]", noNumbers::length())
	show("List.hasItems<ItemType>()", numbers::hasItems())
	show("List.hasItems<ItemType>() [empty]", noNumbers::hasItems())
	show("List.isEmpty<ItemType>()", noNumbers::isEmpty())
	show("List.isEmpty<ItemType>() [populated]", numbers::isEmpty())
	show("List.contains<ItemType is Equatable>(_ ItemType)", numbers::contains(4))
	show("List.contains<ItemType is Equatable>(_ ItemType) [absent]", numbers::contains(9))
	show("List.doesNotContain<ItemType is Equatable>(_ ItemType)", numbers::doesNotContain(9))
	show("List.doesNotContain<ItemType is Equatable>(_ ItemType) [present]", numbers::doesNotContain(4))
	showMaybe("List.firstItem<ItemType>()", numbers::firstItem())
	showMaybe("List.firstItem<ItemType>() [empty]", noNumbers::firstItem())
	showMaybe("List.firstItem<ItemType>(where: (_ ItemType) -> Boolean)", numbers::firstItem(where (item) { <- item::isGreaterThan(2) }))
	showMaybe("List.firstItem<ItemType>(where: (_ ItemType) -> Boolean) [no match]", numbers::firstItem(where (item) { <- item::isGreaterThan(9) }))
	showMaybe("List.lastItem<ItemType>()", numbers::lastItem())
	showMaybe("List.lastItem<ItemType>() [empty]", noNumbers::lastItem())
	showMaybe("List.lastItem<ItemType>() [single]", singleNumber::lastItem())
	show("List.removeFirst<ItemType>()", numbers::removeFirst())
	show("List.removeFirst<ItemType>() [empty]", noNumbers::removeFirst())
	show("List.removeFirst<ItemType>(_ Integer)", numbers::removeFirst(2))
	show("List.removeFirst<ItemType>(_ Integer) [zero]", numbers::removeFirst(0))
	show("List.removeFirst<ItemType>(_ Integer) [past the end]", numbers::removeFirst(99))
	show("List.removeFirst<ItemType>(_ Integer) [negative]", numbers::removeFirst(-1))
	show("List.removeAt<ItemType>(_ Integer)", numbers::removeAt(2))
	show("List.removeAt<ItemType>(_ Integer) [zero]", numbers::removeAt(0))
	show("List.removeAt<ItemType>(_ Integer) [negative]", numbers::removeAt(-1))
	show("List.removeAt<ItemType>(_ Integer) [at length]", numbers::removeAt(numbers::length()))
	show("List.removeEvery<ItemType is Equatable>(_ ItemType)", numbers::removeEvery(1))
	show("List.removeEvery<ItemType is Equatable>(_ ItemType) [absent]", numbers::removeEvery(9))
	show("List.removeEvery<ItemType>(where: (_ ItemType) -> Boolean)", numbers::removeEvery(where (item) { <- item::isGreaterThan(2) }))
	show("List.removeEvery<ItemType>(where: (_ ItemType) -> Boolean) [no match]", numbers::removeEvery(where (item) { <- item::isGreaterThan(9) }))
	show("List.removeLast<ItemType>()", numbers::removeLast())
	show("List.removeLast<ItemType>() [empty]", noNumbers::removeLast())
	show("List.removeLast<ItemType>(_ Integer)", numbers::removeLast(2))
	show("List.removeLast<ItemType>(_ Integer) [zero]", numbers::removeLast(0))
	show("List.removeLast<ItemType>(_ Integer) [past the end]", numbers::removeLast(99))
	show("List.removeDuplicates<ItemType is Equatable>()", numbers::removeDuplicates())
	show("List.removeDuplicates<ItemType is Equatable>() [empty]", noNumbers::removeDuplicates())
	show("List.prepend<ItemType>(_ ItemType)", numbers::prepend(9))
	show("List.prepend<ItemType>(contentsOf: List<ItemType>)", numbers::prepend(contentsOf [8, 9]))
	show("List.prepend<ItemType>(contentsOf: List<ItemType>) [empty]", numbers::prepend(contentsOf noNumbers))
	show("List.append<ItemType>(_ ItemType)", numbers::append(9))
	show("List.append<ItemType>(contentsOf: List<ItemType>)", numbers::append(contentsOf [8, 9]))
	show("List.append<ItemType>(contentsOf: List<ItemType>) [empty]", numbers::append(contentsOf noNumbers))
	show("List.map<ItemType, Result>(_ (_ ItemType) -> Result)", numbers::map((item) { <- item::toString() }))
	show("List.map<ItemType, Result>(_ (_ ItemType) -> Result) [empty]", noNumbers::map((item) { <- item::toString() }))
	show("List.reduce<ItemType, Result>(startingWith: Result, _ (_ Result, _ ItemType) -> Result)", numbers::reduce(startingWith 0, (total, item) { <- total::add(item) }))
	show("List.reduce<ItemType, Result>(startingWith: Result, _ (_ Result, _ ItemType) -> Result) [empty]", noNumbers::reduce(startingWith 0, (total, item) { <- total::add(item) }))
	show("List.keepEvery<ItemType>(where: (_ ItemType) -> Boolean)", numbers::keepEvery(where (item) { <- item::isGreaterThan(1) }))
	show("List.keepEvery<ItemType>(where: (_ ItemType) -> Boolean) [no match]", numbers::keepEvery(where (item) { <- item::isGreaterThan(9) }))
	showMaybe("List.itemAt<ItemType>(_ Integer)", numbers::itemAt(2))
	showMaybe("List.itemAt<ItemType>(_ Integer) [zero]", numbers::itemAt(0))
	showMaybe("List.itemAt<ItemType>(_ Integer) [negative]", numbers::itemAt(-1))
	showMaybe("List.itemAt<ItemType>(_ Integer) [at length]", numbers::itemAt(numbers::length()))
	showMaybe("List.itemAt<ItemType>(_ Integer) [empty]", noNumbers::itemAt(0))
	showMaybe("List.firstIndexOf<ItemType is Equatable>(_ ItemType)", numbers::firstIndexOf(1))
	showMaybe("List.firstIndexOf<ItemType is Equatable>(_ ItemType) [absent]", numbers::firstIndexOf(9))
	show("List.slice<ItemType>(from: Integer, to: Integer)", numbers::slice(from 1, to 3))
	show("List.slice<ItemType>(from: Integer, to: Integer) [empty range]", numbers::slice(from 2, to 2))
	show("List.slice<ItemType>(from: Integer, to: Integer) [past the end]", numbers::slice(from 3, to 99))
	show("List.reverse<ItemType>()", numbers::reverse())
	show("List.reverse<ItemType>() [empty]", noNumbers::reverse())
	show("List.sorted<ItemType is Comparable>()", [3, 1, 2]::sorted())
	show("List.sorted<ItemType is Comparable>() [Strings]", ["banana", "apple"]::sorted())
	show("List.sorted<ItemType is Comparable>() [empty]", noNumbers::sorted())
	show("List.sortedBy<ItemType>(_ (_ ItemType, _ ItemType) -> Ordering)", numbers::sortedBy((first, second) { <- first::compareTo(second) }))
	show("List.sortedBy<ItemType>(_ (_ ItemType, _ ItemType) -> Ordering) [empty]", noNumbers::sortedBy((first, second) { <- first::compareTo(second) }))
	show("List.compareTo<ItemType is Comparable>(_ List<ItemType>)", [1, 2]::compareTo([1, 3]))
	show("List.compareTo<ItemType is Comparable>(_ List<ItemType>) [equal]", [1, 2]::compareTo([1, 2]))
	show("List.compareTo<ItemType is Comparable>(_ List<ItemType>) [shorter]", [1]::compareTo([1, 2]))
	show("List.compareTo<ItemType is Comparable>(_ List<ItemType>) [both empty]", noNumbers::compareTo([]))
	show("List.anyItem<ItemType>(matches: (_ ItemType) -> Boolean)", numbers::anyItem(matches (item) { <- item::isGreaterThan(3) }))
	show("List.anyItem<ItemType>(matches: (_ ItemType) -> Boolean) [no match]", numbers::anyItem(matches (item) { <- item::isGreaterThan(9) }))
	show("List.anyItem<ItemType>(matches: (_ ItemType) -> Boolean) [empty]", noNumbers::anyItem(matches (item) { <- item::isGreaterThan(0) }))
	show("List.everyItem<ItemType>(matches: (_ ItemType) -> Boolean)", numbers::everyItem(matches (item) { <- item::isGreaterThan(0) }))
	show("List.everyItem<ItemType>(matches: (_ ItemType) -> Boolean) [no match]", numbers::everyItem(matches (item) { <- item::isGreaterThan(3) }))
	show("List.everyItem<ItemType>(matches: (_ ItemType) -> Boolean) [empty]", noNumbers::everyItem(matches (item) { <- item::isGreaterThan(0) }))
	show("List.countOf<ItemType is Equatable>(_ ItemType)", numbers::countOf(1))
	show("List.countOf<ItemType is Equatable>(_ ItemType) [absent]", numbers::countOf(9))
	show("List.countOf<ItemType>(where: (_ ItemType) -> Boolean)", numbers::countOf(where (item) { <- item::isGreaterThan(1) }))
	show("List.countOf<ItemType>(where: (_ ItemType) -> Boolean) [no match]", numbers::countOf(where (item) { <- item::isGreaterThan(9) }))
	show("List.insertAt<ItemType>(_ Integer, with: ItemType)", numbers::insertAt(2, with 99))
	show("List.insertAt<ItemType>(_ Integer, with: ItemType) [zero]", numbers::insertAt(0, with 99))
	show("List.insertAt<ItemType>(_ Integer, with: ItemType) [at length]", numbers::insertAt(numbers::length(), with 99))
	show("List.insertAt<ItemType>(_ Integer, with: ItemType) [negative]", numbers::insertAt(-1, with 99))
	show("List.replaceAt<ItemType>(_ Integer, with: ItemType)", numbers::replaceAt(0, with 99))
	show("List.replaceAt<ItemType>(_ Integer, with: ItemType) [at length]", numbers::replaceAt(numbers::length(), with 99))
	show("List.replaceAt<ItemType>(_ Integer, with: ItemType) [negative]", numbers::replaceAt(-1, with 99))
	showMaybe("List.lastIndexOf<ItemType is Equatable>(_ ItemType)", numbers::lastIndexOf(1))
	showMaybe("List.lastIndexOf<ItemType is Equatable>(_ ItemType) [absent]", numbers::lastIndexOf(9))
	show("List.joinWith<ItemType is Printable>(_ String)", ["a", "b", "c"]::joinWith(" + "))
	show("List.joinWith<ItemType is Printable>(_ String) [empty]", noNumbers::joinWith(", "))
	show("List.joinWith<ItemType is Printable>(_ String) [single]", singleNumber::joinWith(", "))
	§ LOAD-BEARING: `partition` returns a Record, and its printed form
	§ `{ matching = [ 2, 4 ], rest = [ 3, 1, 1 ] }` sits at forty-three
	§ characters — seventeen under the sixty at which `getStringRepresentation`
	§ trips its field-doubling bug and wraps across lines. A larger `numbers`
	§ List here would cross that line and break the golden. Keep it short.
	show("List.partition<ItemType>(where: (_ ItemType) -> Boolean)", numbers::partition(where (item) { <- item::isEven() }))
	show("List.partition<ItemType>(where: (_ ItemType) -> Boolean) [empty]", noNumbers::partition(where (item) { <- item::isEven() }))
	§ One pair only: the pretty printer wraps a Record List past sixty
	§ characters, and every line of this file's output has to stay one line.
	show("List.pairedWith<ItemType, Other>(_ List<Other>)", ["a"]::pairedWith([1, 2, 3]))
	show("List.pairedWith<ItemType, Other>(_ List<Other>) [empty]", ["a", "b"]::pairedWith(noNumbers))
	showMaybe("List.splitInto<ItemType>(groupsOf: Integer)", [1, 2, 3, 4, 5]::splitInto(groupsOf 2))
	showMaybe("List.splitInto<ItemType>(groupsOf: Integer) [zero]", numbers::splitInto(groupsOf 0))
	showMaybe("List.splitInto<ItemType>(groupsOf: Integer) [negative]", numbers::splitInto(groupsOf -1))
	showMaybe("List.splitInto<ItemType>(groupsOf: Integer) [empty]", noNumbers::splitInto(groupsOf 2))
	show("List.repeating<ItemType>(_ ItemType, times: Integer)", List.repeating("x", times 3))
	show("List.repeating<ItemType>(_ ItemType, times: Integer) [zero]", List.repeating("x", times 0))
	show("List.repeating<ItemType>(_ ItemType, times: Integer) [negative]", List.repeating("x", times -1))
	show("List.of(integersFrom: Integer, through: Integer)", List.of(integersFrom 1, through 5))
	show("List.of(integersFrom: Integer, through: Integer) [single]", List.of(integersFrom 1, through 1))
	show("List.of(integersFrom: Integer, through: Integer) [inverted]", List.of(integersFrom 5, through 1))

	§ ——— NestedList ———————————————————————————————————————————————————————
	show("NestedList.flatten<ItemType>()", [[1, 2], [3]]::flatten())
	show("NestedList.flatten<ItemType>() [empty]", noNestedNumbers::flatten())

}
