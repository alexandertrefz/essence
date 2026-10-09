import {
	from "./Integer.es" {
		NonNegativeInteger
		PositiveInteger
	}
	from "./List.es" { NonEmptyList }
}

declarations {

	§ The Type is a bare tag rather than a `choice`. A Case carries a payload a
	§ Program can read, and what a source holds is the runner's business.
	§
	§ Two statics build one, and they answer the two kinds the runtime holds
	§ under that one tag. A seeded source carries four words a draw advances,
	§ which is what `--seed` replays. The entropy source carries nothing and
	§ reads the host. A `Random` Namespace beside a pure `Generator` was the
	§ other shape, and it would be two names for one Type.
	§
	§ The entropy source is deliberately not threaded. A draw answering
	§ `{ value, source }` would thread both kinds, and make every draw a Record
	§ to take apart. The host is one source, so reading it at each draw costs
	§ that kind nothing, and leaves `seeded` the only kind a run replays.
	§
	§ Every entry is native, because the state a draw advances can not be
	§ written in Essence at all.

	§§ A source of random values, and the one value in the language that changes.
	§§
	§§ Every draw answers a value and advances the source, so two draws answer two values. That is what a `Generatable` body needs: asking for a name and then for a score must not answer the same draw twice.
	§§
	§§ A source is carried by hand. A Method that draws takes one as a Parameter, and its caller passes the same source on. Mapping over a List with one source draws once for each item, in the order the items stand in.
	namespace Randomness for Randomness {
		§§ Answers the host's own source of randomness.
		§§
		§§ Every call answers the one source the whole Program draws from. It reads the host at each draw rather than carrying words of its own. So a Constant holding it answers a new value at every draw, and a run that draws from it can not be replayed. Use `seeded(_)` for a run that has to repeat.
		§§
		§§ @returns — the host's source of randomness.
		static entropy() -> Randomness

		§§ Answers a source that draws one sequence for one seed.
		§§
		§§ The same seed, drawn from by the same calls in the same order, answers the same values. The source carries words that every draw advances, so a caller that wants the sequence again builds a second source from the seed. Any text is a seed. A seed is hashed to 32 bits, so two different seeds almost always answer two different sequences.
		§§
		§§ @example
		§§   constant source = Randomness.seeded("league")
		§§   constant replay = Randomness.seeded("league")
		§§
		§§   constant drawn = source::drawInteger(between 1, and 100)
		§§
		§§   expect replay::drawInteger(between 1, and 100)::is(drawn)
		§§
		§§ @param _ — the text the sequence is built from
		§§ @returns — a source that replays.
		static seeded(_ seed: String) -> Randomness

		§§ Answers `true` or `false`.
		§§
		§§ The entry taking no Argument answers each of the two half the time. A chance of `1/4` answers `true` once in four draws. A chance below zero answers `false` at every draw, and a chance above one answers `true` at every draw.
		overload drawBoolean {
			§§ @example
			§§   constant coin = Randomness.seeded("coin")
			§§   constant heads = List.of(integersFrom 1, through 100)
			§§   	::count(where (_) { <- coin::drawBoolean() })
			§§
			§§   expect heads::isBetween(30, and 70)
			§§
			§§ @returns — `true` or `false`, with each equally likely.
			() -> Boolean

			§§ @example
			§§   constant coin = Randomness.seeded("coin")
			§§   constant rare = List.of(integersFrom 1, through 100)
			§§   	::count(where (_) { <- coin::drawBoolean(withProbability 1/4) })
			§§
			§§   expect rare::isBetween(10, and 40)
			§§   expect coin::drawBoolean(withProbability 3/2)
			§§
			§§ @param withProbability — how often the answer is `true`, as a part of one
			§§ @returns — `true` that often, and `false` the rest of the time.
			(withProbability chance: Rational) -> Boolean
		}

		§§ Answers a whole number the source draws.
		§§
		§§ The two bounds name the same range in either order, and both of them are inside it. The `below:` entry counts from zero, and the bound it is given is outside the range.
		overload drawInteger {
			§§ @example
			§§   constant die = Randomness.seeded("dice")
			§§
			§§   expect die::drawInteger(between 1, and 6)::isBetween(1, and 6)
			§§   expect die::drawInteger(between 6, and 1)::isBetween(1, and 6)
			§§   expect die::drawInteger(between 4, and 4)::is(4)
			§§
			§§ @param between — one bound of the range.
			§§ @param and — the other bound of the range.
			§§ @returns — a number from the range, with each one equally likely.
			(between low: Integer, and high: Integer) -> Integer

			§§ @example
			§§   constant source = Randomness.seeded("index")
			§§
			§§   expect source::drawInteger(below 10)::isBetween(0, and 9)
			§§   expect source::drawInteger(below 1)::is(0)
			§§
			§§ @param below — the number the range stops below, proven to be above zero
			§§ @returns — a number from zero up to the bound, with each one equally likely.
			(below bound: PositiveInteger) -> NonNegativeInteger
		}

		§§ Answers an exact fraction between two bounds, with both bounds included.
		§§
		§§ The two bounds name the same range in either order. The entry taking no denominator draws over one of twelve small denominators. Those are 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 100 and 1000. A caller that needs another names it with `over:`. Either way the answer is a Rational in lowest terms. Its denominator is the one drawn over or a divisor of it, so a draw of `105/100` answers `21/20`. A range too narrow to hold a multiple of the denominator answers the lower bound.
		overload drawRational {
			§§ @param between — one bound of the range.
			§§ @param and — the other bound of the range.
			§§ @returns — a fraction from the range, drawn over one of the twelve denominators and reduced.
			(between low: Rational, and high: Rational) -> Rational

			§§ @example
			§§   constant source = Randomness.seeded("prices")
			§§   constant quarter = source::drawRational(between 0/1, and 1/1, over 4)
			§§
			§§   expect [0/1, 1/4, 1/2, 3/4, 1/1]::contains(quarter)
			§§   expect source::drawRational(between 1/10, and 1/5, over 2)::is(1/10)
			§§
			§§ @param between — one bound of the range.
			§§ @param and — the other bound of the range.
			§§ @param over — the denominator every answer is drawn over, proven to be above zero
			§§ @returns — a fraction from the range, drawn over the given denominator and reduced.
			(
				between low: Rational,
				and high: Rational,
				over denominator: PositiveInteger,
			) -> Rational
		}

		§§ Answers a String of the given number of characters or fewer.
		§§
		§§ The characters are letters, digits and a space, with four characters that are outside ASCII among them. A bound of zero or less answers the empty String.
		§§
		§§ @example
		§§   constant source = Randomness.seeded("names")
		§§
		§§   expect source::drawString(upTo 8)::length()::isLessThanOrEqualTo(8)
		§§   expect source::drawString(upTo 0)::isEmpty()
		§§
		§§ @param upTo — the greatest number of characters the answer can have.
		§§ @returns — a String of that length or shorter.
		drawString(upTo length: Integer) -> String

		§§ Answers items of the given List, chosen by the source.
		§§
		§§ The counted entry draws without replacement, so it never answers one item twice, and a count above the length of the List answers every item. The drawn items stand in the order they were drawn. A weight of zero or less is drawn as zero, and weights that are all zero answer as the unweighted entry does.
		overload pick {
			§§ @example
			§§   constant colours: NonEmptyList<String> = ["red", "green", "blue"]
			§§   constant source = Randomness.seeded("colours")
			§§
			§§   expect colours::contains(source::pick(from colours))
			§§
			§§ @param from — the items to choose from, which certainly has one.
			§§ @returns — an item of the List, with each item equally likely.
			<infer ItemType>(from items: NonEmptyList<ItemType>) -> ItemType

			§§ @example
			§§   constant team: NonEmptyList<String> = ["Ada", "Grace", "Alan"]
			§§   constant source = Randomness.seeded("team")
			§§   constant pair = source::pick(2, from team)
			§§
			§§   expect pair::length()::is(2)
			§§   expect pair::hasDuplicates()::negate()
			§§   expect source::pick(5, from team)::sort()::is(["Ada", "Alan", "Grace"])
			§§
			§§ @param _ — how many items to answer, proven to be above zero
			§§ @param from — the items to choose from, which certainly has one.
			§§ @returns — the drawn items, which certainly holds one.
			<infer ItemType>(
				_ count: PositiveInteger,
				from items: NonEmptyList<ItemType>,
			) -> NonEmptyList<ItemType>

			§§ @example
			§§   constant source = Randomness.seeded("prizes")
			§§   constant prize = source::pick(
			§§   	from [
			§§   		{ name = "car", weight = 0/1 },
			§§   		{ name = "pen", weight = 3/4 },
			§§   	],
			§§   	weightedBy .weight,
			§§   )
			§§
			§§   expect prize.name::is("pen")
			§§
			§§ @param from — the items to choose from, which certainly has one.
			§§ @param weightedBy — how likely each item is, against the weights of the others
			§§ @returns — an item of the List, as likely as its own weight.
			<infer ItemType>(
				from items: NonEmptyList<ItemType>,
				weightedBy weight: (_: ItemType) -> Rational,
			) -> ItemType
		}

		§ The proven entry is the same native under the proof, for the reason
		§ `String::split`'s second entry is. A refinement erases before anything
		§ runs, so the runtime binds both entries to one Function.

		§§ Answers a new List holding the same items in an order the source draws.
		§§
		§§ Every order of the items is equally likely. The List it is given is left as it was.
		overload shuffle {
			§§ @example
			§§   constant deck: List<Integer> = [1, 2, 3, 4]
			§§   constant source = Randomness.seeded("deck")
			§§   constant shuffled = source::shuffle(deck)
			§§
			§§   expect shuffled::sort()::is([1, 2, 3, 4])
			§§
			§§ @param _ — the items to reorder
			§§ @returns — the reordered List.
			<infer ItemType>(_ items: List<ItemType>) -> List<ItemType>

			§§ @example
			§§   constant names: NonEmptyList<String> = ["Ada", "Grace", "Alan"]
			§§   constant source = Randomness.seeded("names")
			§§   constant shuffled = source::shuffle(names)
			§§
			§§   expect names::contains(shuffled::firstItem())
			§§   expect shuffled::length()::is(3)
			§§
			§§ @param _ — the items to reorder, which certainly has one
			§§ @returns — the reordered List, which certainly holds one.
			<infer ItemType>(
				_ items: NonEmptyList<ItemType>,
			) -> NonEmptyList<ItemType>
		}
	}

	§ `Generatable` is declared beside `Randomness` rather than in a file of its
	§ own. Its one requirement names a source, and neither half is usable without
	§ the other. A file for the Protocol alone would import this one for a single
	§ name.

	§§ Anything a property test can build values of.
	§§
	§§ A Namespace that declares this conformance replaces the generator a property test derives from the Type. The derived generator also makes a failing value smaller, and a conformance answers `shrink` for that instead. The provided `shrink` answers no candidates, so a Namespace that writes none of its own has its counterexamples reported as they were drawn.
	protocol Generatable {
		§§ Answers a value of the conforming Type, built from a source of randomness.
		§§
		§§ A property test derives a generator from the Type where a Namespace declares no conformance. Declaring one replaces that generator, for a Type whose values carry an invariant the derived one can not know about.
		§§
		§§ @param from — the source to draw from.
		§§ @returns — a value of the conforming Type.
		static generate(from source: Randomness) -> Self

		§ Provided rather than required, and provided as nothing. A Protocol
		§ knows nothing about the values `generate` builds. A requirement would
		§ hold every Namespace that declares this conformance to a second body,
		§ and most have no use for one. So a conformance costs a conformer one
		§ Method, and the Namespace that wants its counterexamples small writes
		§ the other.

		§§ Answers the smaller values a failing one can be reported as.
		§§
		§§ A property test that fails asks its counterexample for these candidates, and reports the first one that fails as well. It asks that value for its own, so a body answering one step smaller each time reports the smallest value the property fails on. The runner tries the candidates in the order the List holds them, and skips one that is the failing value itself. The body here answers no candidates, so a Namespace that writes none of its own reports the value the source drew.
		§§
		§§ @returns — the smaller values, smallest first.
		shrink() -> List<Self> {
			<- []
		}
	}
}

export {
	Generatable
	Randomness
}
