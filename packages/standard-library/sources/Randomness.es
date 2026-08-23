import {
	NonEmptyList from "./List.es"
}

declarations {

	§ A `Randomness` is the one value in the language that changes. Every Method
	§ here answers a value and advances the source, so two reads answer two
	§ values. That is what a `Generatable` body needs: asking for a name and then
	§ for a score must not answer the same draw twice.
	§
	§ The Type is a bare tag rather than a `choice`. A Case carries a payload a
	§ Program can read, and what a source holds is the runner's business.
	§ Nothing here builds one. A property test builds a source from its seed and
	§ hands it to `generate`, which is the only place one is met.
	§
	§ Every entry is native, because the state a draw advances can not be written
	§ in Essence at all.
	namespace Randomness for Randomness {
		§§ Answers `true` or `false`, with each answer equally likely.
		§§
		§§ @returns — `true` or `false`.
		boolean() -> Boolean

		§§ Answers a whole number between two bounds, with both bounds included.
		§§
		§§ The two bounds name the same range in either order.
		§§
		§§ @param between — one bound of the range.
		§§ @param and — the other bound of the range.
		§§ @returns — a number from the range, with each one equally likely.
		integer(between low: Integer, and high: Integer) -> Integer

		§§ Answers an exact fraction between two bounds, with both bounds included.
		§§
		§§ The denominator is one of the small ones a reader recognises. The two bounds name the same range in either order.
		§§
		§§ @param between — one bound of the range.
		§§ @param and — the other bound of the range.
		§§ @returns — a fraction from the range.
		rational(between low: Rational, and high: Rational) -> Rational

		§§ Answers a String of the given number of characters or fewer.
		§§
		§§ The characters are letters, digits and a space, with four characters that are outside ASCII among them. A bound of zero or less answers the empty String.
		§§
		§§ @param upTo — the greatest number of characters the answer can have.
		§§ @returns — a String of that length or shorter.
		string(upTo length: Integer) -> String

		§§ Answers one item of the List, with each item equally likely.
		§§
		§§ @param from — the items to choose from, which certainly has one.
		§§ @returns — an item of the List.
		pick<infer ItemType>(from items: NonEmptyList<ItemType>) -> ItemType
	}

	§ `Generatable` is declared beside `Randomness` rather than in a file of its
	§ own. Its one requirement names a source, and neither half is usable without
	§ the other. A file for the Protocol alone would import this one for a single
	§ name.

	§§ Anything a property test can build values of.
	protocol Generatable {
		§§ Answers a value of the conforming Type, built from a source of randomness.
		§§
		§§ A property test derives a generator from the Type where a Namespace declares no conformance. Declaring one replaces that generator, for a Type whose values carry an invariant the derived one can not know about.
		§§
		§§ @param from — the source to draw from.
		§§ @returns — a value of the conforming Type.
		static generate(from source: Randomness) -> Self
	}
}

export {
	Generatable
	Randomness
}
