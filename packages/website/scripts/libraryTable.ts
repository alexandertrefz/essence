/*
 * The reader's side of the standard library reference: which pages exist, in
 * what order, and how each page groups what the placement rules put on it.
 *
 * WHERE a declaration goes is not written here. `libraryPages.ts` decides that
 * by rule, from what each declaration is for, and throws on anything the rules
 * leave homeless. What this table holds is what no rule can know: the order a
 * reader meets the pages in, the reader groups inside each one — `Searching`
 * rather than "predicates" — and which group a provided member belongs to.
 *
 * Every member is keyed `Namespace::member`, exactly once. A member the sources
 * gain and this table does not list stops the generator, and a key naming a
 * member the sources no longer declare stops it too, so the table cannot drift
 * from the library in either direction without somebody deciding where the
 * change belongs.
 *
 * `description` and `taughtOn` only seed a page the generator creates. Once a
 * page exists they are its own, and `--sync` keeps them.
 *
 * Seeded from the documentation campaign's `library.json` (2026-09-11).
 */

export interface GroupDefinition {
	/** The `##` heading. Kept identical across pages for the same idea. */
	label: string
	/** Declared members, `Namespace::member`, in the order the group shows them. */
	members: string[]
	/** Provided and derived member names the group also shows. */
	provided?: string[]
}

export interface PageDefinition {
	/** `list` — the page is `/docs/library/<slug>`. */
	slug: string
	title: string
	/** The sidebar's order; the hand-written overview is 10. */
	order: number
	/** Seeds the page's frontmatter `description` when the generator creates it. */
	description: string
	/** Seeds the page's "Taught on" line: the Language pages that teach the type. */
	taughtOn: string[]
	groups: GroupDefinition[]
	/** `library/list#group` — the pages or anchors the page ends by pointing to. */
	seeAlso?: string[]
	/** One hand-written paragraph under the lede, for a fact no declaration states. */
	note?: string
}

export const PAGES: PageDefinition[] = [
	{
		slug: "integer",
		title: "Integer",
		order: 20,
		description:
			"Whole numbers of any size that never overflow: arithmetic, parsing, testing and printing.",
		taughtOn: [
			"language/method-calls",
			"language/numbers",
			"language/checked-refinements",
		],
		groups: [
			{
				label: "Creating",
				members: ["Integer::parse"],
			},
			{
				label: "Equality, ordering and printing",
				members: [
					"Integer::is",
					"Integer::isNot",
					"Integer::compare",
					"Integer::toString",
				],
			},
			{
				label: "Arithmetic",
				members: [
					"Integer::add",
					"NonNegativeInteger::add",
					"PositiveInteger::add",
					"Integer::subtract",
					"Integer::multiply",
					"NonZeroInteger::multiply",
					"NonNegativeInteger::multiply",
					"PositiveInteger::multiply",
					"Integer::divide",
					"NonZeroInteger::divide",
					"Integer::remainder",
					"Integer::quotient",
					"Integer::raise",
					"NonZeroInteger::raise",
					"PositiveInteger::raise",
					"Integer::squareRoot",
					"NonNegativeInteger::squareRoot",
					"PositiveInteger::squareRoot",
				],
			},
			{
				label: "Comparing",
				members: [
					"Integer::isLessThan",
					"Integer::isLessThanOrEqualTo",
					"Integer::isGreaterThan",
					"Integer::isGreaterThanOrEqualTo",
				],
				provided: ["isBetween", "clamp"],
			},
			{
				label: "Testing",
				members: [
					"Integer::isEven",
					"Integer::isOdd",
					"Integer::isPositive",
					"Integer::isNegative",
					"Integer::isZero",
					"Integer::isWholeNumber",
					"Integer::isMultiple",
					"Integer::isPrime",
				],
			},
			{
				label: "Sign and rounding",
				members: [
					"Integer::absolute",
					"NonZeroInteger::absolute",
					"Integer::negate",
					"NonZeroInteger::negate",
					"Integer::round",
					"Integer::approximate",
				],
			},
			{
				label: "Number theory",
				members: [
					"Integer::greatestCommonDivisor",
					"Integer::leastCommonMultiple",
					"Integer::factorial",
					"NonNegativeInteger::factorial",
				],
			},
			{
				label: "Converting",
				members: ["Integer::toRational"],
			},
		],
	},
	{
		slug: "rational",
		title: "Rational",
		order: 30,
		description:
			"Exact fractions in lowest terms: arithmetic, rounding, and the forms a Rational prints in.",
		taughtOn: ["language/method-calls", "language/numbers"],
		groups: [
			{
				label: "Creating",
				members: ["Rational::of", "Rational::parse"],
			},
			{
				label: "Equality, ordering and printing",
				members: [
					"Rational::is",
					"Rational::isNot",
					"Rational::compare",
					"Rational::toString",
				],
			},
			{
				label: "Arithmetic",
				members: [
					"Rational::add",
					"NonNegativeRational::add",
					"PositiveRational::add",
					"Rational::subtract",
					"Rational::multiply",
					"NonZeroRational::multiply",
					"NonNegativeRational::multiply",
					"PositiveRational::multiply",
					"Rational::divide",
					"Rational::remainder",
					"Rational::quotient",
					"Rational::raise",
					"Rational::squareRoot",
					"NonNegativeRational::squareRoot",
					"PositiveRational::squareRoot",
				],
			},
			{
				label: "Comparing",
				members: [
					"Rational::isLessThan",
					"Rational::isLessThanOrEqualTo",
					"Rational::isGreaterThan",
					"Rational::isGreaterThanOrEqualTo",
				],
				provided: ["isBetween", "clamp"],
			},
			{
				label: "Testing",
				members: [
					"Rational::isWholeNumber",
					"Rational::isPositive",
					"Rational::isNegative",
					"Rational::isZero",
				],
			},
			{
				label: "Parts",
				members: [
					"Rational::numerator",
					"NonZeroRational::numerator",
					"Rational::denominator",
					"Rational::absolute",
					"NonZeroRational::absolute",
				],
			},
			{
				label: "Sign and rounding",
				members: [
					"Rational::negate",
					"NonZeroRational::negate",
					"Rational::reciprocal",
					"NonZeroRational::reciprocal",
					"Rational::round",
					"Rational::approximate",
				],
			},
			{
				label: "Converting",
				members: ["Rational::toRational"],
			},
		],
	},
	{
		slug: "number",
		title: "Number",
		order: 40,
		description:
			"The union of every kind of number: the constants Pi, Tau, E and GoldenRatio, totals, parsing, and comparing across kinds.",
		taughtOn: ["language/numbers", "language/unions-and-type-aliases"],
		groups: [
			{
				label: "Constants",
				members: [
					"Number::Pi",
					"Number::Tau",
					"Number::E",
					"Number::GoldenRatio",
				],
			},
			{
				label: "Aggregates",
				members: [
					"Number::sum",
					"Number::product",
					"Number::average",
					"Number::lowest",
					"Number::highest",
				],
			},
			{
				label: "Creating",
				members: ["Number::parse"],
			},
			{
				label: "Cross-kind equality, ordering and printing",
				members: ["Number::is", "Number::compare", "Number::toString"],
				provided: ["isNot"],
			},
			{
				label: "Comparing",
				members: [],
				provided: [
					"isLessThan",
					"isLessThanOrEqualTo",
					"isGreaterThan",
					"isGreaterThanOrEqualTo",
					"isBetween",
					"clamp",
				],
			},
			{
				label: "Mixed arithmetic",
				members: ["Scalar::add", "Scalar::multiply"],
			},
		],
	},
	{
		slug: "algebraic",
		title: "Algebraic",
		order: 50,
		description:
			"Exact irrational numbers such as square roots: arithmetic, comparison, rounding and printing.",
		taughtOn: ["language/numbers"],
		groups: [
			{
				label: "Equality, ordering and printing",
				members: [
					"Algebraic::is",
					"Algebraic::compare",
					"Algebraic::toString",
				],
				provided: ["isNot"],
			},
			{
				label: "Arithmetic",
				members: [
					"Algebraic::add",
					"Algebraic::subtract",
					"Algebraic::multiply",
					"Algebraic::divide",
					"Algebraic::raise",
				],
			},
			{
				label: "Comparing",
				members: [],
				provided: [
					"isLessThan",
					"isLessThanOrEqualTo",
					"isGreaterThan",
					"isGreaterThanOrEqualTo",
					"isBetween",
					"clamp",
				],
			},
			{
				label: "Testing",
				members: [
					"Algebraic::isPositive",
					"Algebraic::isNegative",
					"Algebraic::isZero",
					"Algebraic::isWholeNumber",
				],
			},
			{
				label: "Sign and rounding",
				members: [
					"Algebraic::absolute",
					"Algebraic::negate",
					"Algebraic::approximate",
					"Algebraic::round",
					"Algebraic::decimalExponent",
				],
			},
		],
	},
	{
		slug: "transcendental",
		title: "Transcendental",
		order: 60,
		description:
			"Exact numbers built on π and e, such as `Number.Pi`: arithmetic, testing, rounding and printing.",
		taughtOn: ["language/numbers"],
		// Checked against the Compiler: `3::isLessThan(Number.Pi)` prints `true`.
		note: "`compare(to:withPrecision:)` returns `Optional<Ordering>`, so `Transcendental` does not conform to `Comparable`. The ordering methods of [`Number`](/docs/library/number#comparing) accept one: `3::isLessThan(Number.Pi)` is `true`.",
		groups: [
			{
				label: "Equality and printing",
				members: [
					"Transcendental::is",
					"Transcendental::compare",
					"Transcendental::toString",
				],
				provided: ["isNot"],
			},
			{
				label: "Arithmetic",
				members: [
					"Transcendental::add",
					"Transcendental::subtract",
					"Transcendental::multiply",
					"Transcendental::divide",
				],
			},
			{
				label: "Testing",
				members: [
					"Transcendental::isPositive",
					"Transcendental::isNegative",
					"Transcendental::isZero",
					"Transcendental::isWholeNumber",
				],
			},
			{
				label: "Sign and rounding",
				members: [
					"Transcendental::absolute",
					"Transcendental::negate",
					"Transcendental::approximate",
					"Transcendental::round",
					"Transcendental::decimalExponent",
				],
			},
		],
	},
	{
		slug: "boolean",
		title: "Boolean",
		order: 70,
		description:
			"The methods on `true` and `false`: logic, comparison and printing.",
		taughtOn: ["language/method-calls", "language/conditions"],
		groups: [
			{
				label: "Equality, ordering and printing",
				members: [
					"Boolean::is",
					"Boolean::compare",
					"Boolean::toString",
				],
				provided: ["isNot"],
			},
			{
				label: "Logic",
				members: [
					"Boolean::negate",
					"Boolean::and",
					"Boolean::or",
					"Boolean::exclusiveOr",
				],
			},
			{
				label: "Comparing",
				members: [],
				provided: [
					"isLessThan",
					"isLessThanOrEqualTo",
					"isGreaterThan",
					"isGreaterThanOrEqualTo",
				],
			},
		],
	},
	{
		slug: "string",
		title: "String",
		order: 80,
		description:
			"Text, measured in characters: searching, cutting, building, changing case, and comparing.",
		taughtOn: ["language/programs-and-values", "language/strings"],
		groups: [
			{
				label: "Creating",
				members: ["String::of"],
			},
			{
				label: "Equality, ordering and printing",
				members: ["String::is", "String::compare", "String::toString"],
				provided: ["isNot"],
			},
			{
				label: "Comparing",
				members: [],
				provided: [
					"isLessThan",
					"isLessThanOrEqualTo",
					"isGreaterThan",
					"isGreaterThanOrEqualTo",
				],
			},
			{
				label: "Testing content",
				members: [
					"String::isEmpty",
					"String::hasCharacters",
					"String::isOneCharacter",
					"String::hasOnlyDigits",
					"String::hasOnlyLetters",
					"String::hasOnlyLettersOrDigits",
					"String::hasOnlyWhitespace",
				],
			},
			{
				label: "Searching",
				members: [
					"String::contains",
					"String::doesNotContain",
					"String::starts",
					"String::doesNotStart",
					"String::ends",
					"String::doesNotEnd",
					"String::firstIndex",
					"String::lastIndex",
					"String::everyIndex",
					"String::count",
				],
			},
			{
				label: "Reading",
				members: [
					"String::lines",
					"String::words",
					"String::length",
					"NonEmptyString::length",
					"String::characters",
					"NonEmptyString::characters",
					"String::character",
					"String::firstCharacter",
					"NonEmptyString::firstCharacter",
					"String::lastCharacter",
					"NonEmptyString::lastCharacter",
					"String::codePoints",
				],
			},
			{
				label: "Building",
				members: [
					"String::prepend",
					"String::append",
					"String::repeat",
					"NonEmptyString::repeat",
					"String::pad",
					"String::indent",
					"String::separate",
				],
			},
			{
				label: "Cutting",
				members: [
					"String::split",
					"String::trim",
					"String::slice",
					"String::remove",
					"String::truncate",
				],
			},
			{
				label: "Changing case and form",
				members: [
					"String::uppercase",
					"NonEmptyString::uppercase",
					"String::lowercase",
					"NonEmptyString::lowercase",
					"String::normalize",
					"String::replaceEvery",
					"String::replaceFirst",
					"String::reverse",
					"NonEmptyString::reverse",
					"String::capitalize",
					"String::quote",
				],
			},
		],
	},
	{
		slug: "list",
		title: "List",
		order: 90,
		description:
			"Ordered collections of items: reading, searching, transforming, sorting and totalling, each method returning a new List.",
		taughtOn: ["language/lists", "language/iteration"],
		groups: [
			{
				label: "Creating",
				members: ["List::repeat", "List::of"],
			},
			{
				label: "Equality, ordering and printing",
				members: ["List::is", "List::compare", "List::toString"],
				provided: ["isNot"],
			},
			{
				label: "Comparing",
				members: [],
				provided: [
					"isLessThan",
					"isLessThanOrEqualTo",
					"isGreaterThan",
					"isGreaterThanOrEqualTo",
				],
			},
			{
				label: "Testing",
				members: [
					"List::hasItems",
					"List::isEmpty",
					"List::hasOnlyItems",
					"List::hasNoItems",
					"List::hasDuplicates",
					"List::isSorted",
				],
			},
			{
				label: "Searching",
				members: [
					"List::contains",
					"List::doesNotContain",
					"List::starts",
					"List::doesNotStart",
					"List::ends",
					"List::doesNotEnd",
					"List::firstIndex",
					"List::lastIndex",
					"List::everyIndex",
					"List::count",
				],
			},
			{
				label: "Reading",
				members: [
					"List::length",
					"NonEmptyList::length",
					"List::firstItem",
					"NonEmptyList::firstItem",
					"List::lastItem",
					"NonEmptyList::lastItem",
					"List::item",
					"List::indices",
					"NonEmptyList::indices",
					"List::onlyItem",
					"List::enumerate",
					"NonEmptyList::enumerate",
					"List::lowestItem",
					"NonEmptyList::lowestItem",
					"List::highestItem",
					"NonEmptyList::highestItem",
					"List::firstItems",
					"List::lastItems",
				],
			},
			{
				label: "Adding and replacing",
				members: [
					"List::prepend",
					"NonEmptyList::prepend",
					"List::append",
					"NonEmptyList::append",
					"List::insert",
					"List::replace",
					"NonEmptyList::replace",
					"List::pad",
				],
			},
			{
				label: "Removing",
				members: [
					"List::removeFirst",
					"List::remove",
					"List::removeEvery",
					"List::removeLast",
					"List::removeDuplicates",
					"NonEmptyList::removeDuplicates",
				],
			},
			{
				label: "Transforming",
				members: [
					"List::map",
					"NonEmptyList::map",
					"List::reduce",
					"NonEmptyList::reduce",
					"List::everyItem",
					"List::accumulate",
					"List::everyValue",
				],
			},
			{
				label: "Ordering",
				members: [
					"List::reverse",
					"NonEmptyList::reverse",
					"List::sort",
					"NonEmptyList::sort",
				],
			},
			{
				label: "Slicing and splitting",
				members: [
					"List::slice",
					"List::partition",
					"List::split",
					"NonEmptyList::split",
					"List::windows",
					"List::runs",
				],
			},
			{
				label: "Combining",
				members: ["List::join", "List::pair", "NonEmptyList::pair"],
			},
			{
				label: "Nested lists",
				members: [
					"NestedList::flatten",
					"NonEmptyNestedList::flatten",
					"NestedList::transpose",
				],
			},
			{
				label: "Lists of Optionals and Results",
				members: [
					"OptionalList::values",
					"ResultList::values",
					"OptionalList::allValues",
					"ResultList::allValues",
					"OptionalList::firstValue",
					"ResultList::reasons",
					"ResultList::partition",
				],
			},
			{
				label: "Grouping into a Dictionary",
				members: [
					"GroupedList::group",
					"GroupedNonEmptyList::group",
					"GroupedList::tally",
					"GroupedNonEmptyList::tally",
					"GroupedList::index",
					"GroupedNonEmptyList::index",
				],
			},
			{
				label: "Lists of numbers: totals",
				members: [
					"IntegerList::sum",
					"RationalList::sum",
					"NumberList::sum",
					"KeyedNumberList::sum",
					"IntegerList::product",
					"RationalList::product",
					"NumberList::product",
					"KeyedNumberList::product",
					"IntegerList::runningTotal",
					"RationalList::runningTotal",
					"NumberList::runningTotal",
				],
			},
			{
				label: "Lists of numbers: statistics",
				members: [
					"IntegerList::average",
					"RationalList::average",
					"NumberList::average",
					"KeyedNumberList::average",
					"NonEmptyIntegerList::average",
					"NonEmptyRationalList::average",
					"NonEmptyNumberList::average",
					"NonEmptyKeyedNumberList::average",
					"IntegerList::lowestNumber",
					"RationalList::lowestNumber",
					"NumberList::lowestNumber",
					"NonEmptyIntegerList::lowestNumber",
					"NonEmptyRationalList::lowestNumber",
					"NonEmptyNumberList::lowestNumber",
					"IntegerList::highestNumber",
					"RationalList::highestNumber",
					"NumberList::highestNumber",
					"NonEmptyIntegerList::highestNumber",
					"NonEmptyRationalList::highestNumber",
					"NonEmptyNumberList::highestNumber",
					"IntegerList::median",
					"RationalList::median",
					"NumberList::median",
					"NonEmptyIntegerList::median",
					"NonEmptyRationalList::median",
					"NonEmptyNumberList::median",
					"IntegerList::percentile",
					"RationalList::percentile",
					"NumberList::percentile",
					"NonEmptyIntegerList::percentile",
					"NonEmptyRationalList::percentile",
					"NonEmptyNumberList::percentile",
					"IntegerList::mode",
					"RationalList::mode",
					"NumberList::mode",
					"NonEmptyIntegerList::mode",
					"NonEmptyRationalList::mode",
					"NonEmptyNumberList::mode",
					"IntegerList::variance",
					"RationalList::variance",
					"NumberList::variance",
					"NonEmptyIntegerList::variance",
					"NonEmptyRationalList::variance",
					"NonEmptyNumberList::variance",
					"IntegerList::standardDeviation",
					"RationalList::standardDeviation",
					"NumberList::standardDeviation",
					"NonEmptyIntegerList::standardDeviation",
					"NonEmptyRationalList::standardDeviation",
					"NonEmptyNumberList::standardDeviation",
				],
			},
		],
	},
	{
		slug: "dictionary",
		title: "Dictionary",
		order: 100,
		description:
			"Values found by key: reading, testing, changing entries and transforming, each change returning a new Dictionary.",
		taughtOn: ["language/dictionaries"],
		groups: [
			{
				label: "Creating",
				members: ["Dictionary::of"],
			},
			{
				label: "Equality and printing",
				members: ["Dictionary::is", "Dictionary::toString"],
				provided: ["isNot"],
			},
			{
				label: "Testing",
				members: [
					"Dictionary::isEmpty",
					"Dictionary::hasEntries",
					"Dictionary::hasKey",
					"Dictionary::hasValue",
					"Dictionary::hasOnlyEntries",
					"Dictionary::hasNoEntries",
				],
			},
			{
				label: "Reading",
				members: [
					"Dictionary::length",
					"NonEmptyDictionary::length",
					"Dictionary::value",
					"Dictionary::keys",
					"NonEmptyDictionary::keys",
					"Dictionary::values",
					"NonEmptyDictionary::values",
					"Dictionary::entries",
					"NonEmptyDictionary::entries",
					"Dictionary::firstEntry",
					"NonEmptyDictionary::firstEntry",
				],
			},
			{
				label: "Changing entries",
				members: [
					"Dictionary::set",
					"Dictionary::update",
					"Dictionary::remove",
					"Dictionary::removeEvery",
				],
			},
			{
				label: "Transforming",
				members: [
					"Dictionary::everyEntry",
					"Dictionary::map",
					"NonEmptyDictionary::map",
					"Dictionary::merge",
					"Dictionary::sort",
					"NonEmptyDictionary::sort",
					"Dictionary::count",
				],
			},
		],
		seeAlso: [
			"library/list#group",
			"library/list#tally",
			"library/list#index",
		],
	},
	{
		slug: "optional",
		title: "Optional",
		order: 110,
		description:
			"A value that is there or is not, and the methods that test, read, transform and fall back from it.",
		taughtOn: ["language/optional"],
		groups: [
			{
				label: "Equality and printing",
				members: [
					"Optional::is",
					"Optional::isNot",
					"Optional::toString",
				],
			},
			{
				label: "Testing",
				members: ["Optional::hasValue", "Optional::isEmpty"],
			},
			{
				label: "Reading",
				members: ["Optional::value"],
			},
			{
				label: "Transforming",
				members: [
					"Optional::map",
					"Optional::andThen",
					"Optional::keep",
				],
			},
			{
				label: "Falling back",
				members: ["Optional::or"],
			},
			{
				label: "Combining and converting",
				members: [
					"Optional::pair",
					"Optional::toList",
					"Optional::toResult",
				],
			},
			{
				label: "Nested",
				members: ["NestedOptional::flatten"],
			},
		],
		seeAlso: [
			"library/list#values",
			"library/list#allValues",
			"library/list#firstValue",
		],
	},
	{
		slug: "result",
		title: "Result",
		order: 120,
		description:
			"A value or the reason it is missing, and the methods that test, read, transform and recover from it.",
		taughtOn: ["language/result"],
		groups: [
			{
				label: "Equality and printing",
				members: ["Result::is", "Result::isNot", "Result::toString"],
			},
			{
				label: "Testing",
				members: ["Result::hasValue", "Result::hasFailed"],
			},
			{
				label: "Reading",
				members: ["Result::value", "Result::reason"],
			},
			{
				label: "Transforming",
				members: [
					"Result::map",
					"Result::andThen",
					"Result::mapFailure",
				],
			},
			{
				label: "Recovering and falling back",
				members: ["Result::recover", "Result::keep", "Result::or"],
			},
			{
				label: "Converting",
				members: ["Result::toList"],
			},
			{
				label: "Nested",
				members: ["NestedResult::flatten"],
			},
		],
		seeAlso: [
			"library/list#values",
			"library/list#reasons",
			"library/list#partition",
			"library/list#allValues",
		],
	},
	{
		slug: "record",
		title: "Record",
		order: 130,
		description:
			"The methods every record has: equality, printing and reading its keys.",
		taughtOn: ["language/records"],
		groups: [
			{
				label: "Equality and printing",
				members: ["Record::is", "Record::toString"],
				provided: ["isNot"],
			},
			{
				label: "Reading",
				members: ["Record::keys"],
			},
		],
	},
	{
		slug: "ordering",
		title: "Ordering",
		order: 140,
		description:
			"What `compare` returns, `#Less`, `#Equal` or `#Greater`, and `then` for ordering by a second key.",
		taughtOn: ["language/protocols", "language/lists"],
		groups: [
			{
				label: "The cases",
				members: [],
				provided: ["is", "toString", "cases", "isNot"],
			},
			{
				label: "Chaining",
				members: ["Ordering::then"],
			},
		],
	},
	{
		slug: "loop",
		title: "loop and Step",
		order: 150,
		description:
			"The `loop` functions and `Step`: repeat a function while a condition holds, across a range of integers, or until it returns `#Done`.",
		taughtOn: ["language/iteration"],
		groups: [
			{
				label: "Predicate loops",
				members: ["loop::while", "loop::until"],
			},
			{
				label: "Counted loops",
				members: ["loop::through", "loop::upTo", "loop::downTo"],
			},
			{
				label: "Loops the body can stop",
				members: [
					"loop::step",
					"loop::through-step",
					"loop::upTo-step",
					"loop::downTo-step",
				],
			},
		],
	},
	{
		slug: "randomness",
		title: "Randomness",
		order: 160,
		description:
			"A source of random values: seed one, draw Booleans, Integers, Rationals and Strings, and pick or shuffle.",
		taughtOn: ["language/tests"],
		groups: [
			{
				label: "Creating a source",
				members: ["Randomness::entropy", "Randomness::seeded"],
			},
			{
				label: "Drawing values",
				members: [
					"Randomness::drawBoolean",
					"Randomness::drawInteger",
					"Randomness::drawRational",
					"Randomness::drawString",
				],
			},
			{
				label: "Choosing from a List",
				members: ["Randomness::pick", "Randomness::shuffle"],
			},
		],
		seeAlso: ["library/protocols#Generatable"],
	},
	{
		slug: "terminal",
		title: "Terminal",
		order: 170,
		description:
			"Printing for the program's reader, inspecting for its author, and reading its input.",
		taughtOn: ["language/programs-and-values"],
		groups: [
			{
				label: "Writing",
				members: ["Terminal::print", "Terminal::write"],
			},
			{
				label: "Inspecting",
				members: ["Terminal::inspect", "Terminal::describe"],
			},
			{
				label: "Reading input",
				members: [
					"Terminal::readLine",
					"Terminal::readAll",
					"Terminal::ask",
				],
			},
		],
	},
	{
		slug: "future",
		title: "Future",
		order: 190,
		description:
			"Work that has not run: a description to start, and one run of it to wait for.",
		taughtOn: [],
		groups: [],
	},
	{
		slug: "protocols",
		title: "Protocols",
		order: 180,
		description:
			"The six protocols of the standard library: what each one requires, what it provides, and who conforms.",
		taughtOn: ["language/protocols"],
		groups: [],
	},
]
