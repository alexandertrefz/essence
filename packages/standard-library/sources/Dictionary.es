import {
	Boolean   from "./Boolean.es"
	List      from "./List.es"
	Optional  from "./Optional.es"
	Equatable from "./Protocols.es"
	Printable from "./Protocols.es"
}

declarations {

	§ The keyed collection, and everything that reads or rebuilds one. Every
	§ Method here is a Query: a Dictionary is never changed in place, and a new
	§ Dictionary is answered.
	§
	§ An entry is the Record `{ key: KeyType, value: ValueType }`. It is what
	§ `entries` answers and what every callback here is handed, so a caller can
	§ take one apart with a Pattern.
	§
	§ The order is the order the keys were first set. Setting a key that is
	§ already there keeps its place. Removing a key and setting it again puts
	§ it at the end.
	§
	§ Key equality is the keys' own `is`, so every Method that compares keys
	§ carries the `Equatable` bound and the Type itself carries none. A `List`
	§ is unbounded for the same reason.
	§
	§ Both conformances are conditional. A Dictionary is equatable and
	§ printable exactly when its keys and its values are, and a use site
	§ solving `Dictionary<KeyType, ValueType> is Equatable` solves both
	§ conditions.
	namespace Dictionary<infer KeyType, infer ValueType> for Dictionary<KeyType, ValueType>
		is Equatable where KeyType is Equatable, ValueType is Equatable,
		is Printable where KeyType is Printable, ValueType is Printable {
		§§ Answers a Dictionary built from a List of entries.
		§§
		§§ Two entries with equal keys collapse into one. The later value wins, and the key keeps the place of its first occurrence. Equality is the keys' own `is`.
		§§
		§§ @param _ — the entries the Dictionary holds
		§§ @returns — the Dictionary of those entries.
		static of<infer KeyType is Equatable>(
			_ entries: List<{ key: KeyType, value: ValueType }>,
		) -> Dictionary<KeyType, ValueType>

		§§ Answers whether the two Dictionaries hold the same keys with equal values.
		§§
		§§ The order the entries stand in does not matter. Each key is found by the keys' own `is`, and each pair of values is compared by the values' own `is`. The Method is available whenever the keys and the values conform to `Equatable`.
		§§
		§§ @param _ — the Dictionary to compare with
		§§ @returns — `true` when the two hold the same entries.
		is<infer KeyType is Equatable, infer ValueType is Equatable>(
			_ other: Dictionary<KeyType, ValueType>,
		) -> Boolean

		§§ Answers the Dictionary and its entries as a String, in the form `["a" = 1, "b" = 2]`.
		§§
		§§ Each key and each value is rendered by its own `toString`, and a String is quoted: `["a" = "b"]`. The empty Dictionary answers `[=]`. The empty List answers `[]`, so the two are never the same text. The Method is available whenever the keys and the values conform to `Printable`.
		§§
		§§ @returns — the String representation of the Dictionary.
		toString<infer KeyType is Printable, infer ValueType is Printable>() -> String

		§§ Answers whether the Dictionary has no entries at all.
		§§
		§§ @returns — `true` for the empty Dictionary.
		isEmpty() -> Boolean

		§§ Answers whether the Dictionary has at least one entry.
		§§
		§§ It is the opposite of `isEmpty`.
		§§
		§§ @returns — `true` when the Dictionary is not empty.
		hasEntries() -> Boolean {
			§ This body is read as well as run. A predicate written as one call
			§ on `@` is that call, so a refinement written on either name is one
			§ Type. See DEVELOPMENT.md, Why bodies look the way they do.
			<- @::isEmpty()::negate()
		}

		§§ Answers whether the Dictionary holds a value for the given key.
		§§
		§§ Equality is the keys' own `is`. The Method is available whenever the keys conform to `Equatable`.
		§§
		§§ @param _ — the key to look for
		§§ @returns — `true` when the key holds a value.
		hasKey<infer KeyType is Equatable>(_ key: KeyType) -> Boolean {
			§ A chain rather than one call on `@`, so it stays a question of its
			§ own. See DEVELOPMENT.md, Why bodies look the way they do.
			<- @::value(at key)::hasValue()
		}

		§§ Answers how many entries the Dictionary has.
		§§
		§§ @returns — the number of entries.
		length() -> Integer

		§§ Answers the value the given key holds.
		§§
		§§ A key that holds no value answers an empty Optional. The `defaultingTo:` entry answers the given value in its place. Equality is the keys' own `is`.
		§§
		§§ @returns — the value the key holds.
		overload value {
			§§ Answers the value the given key holds.
			§§
			§§ Equality is the keys' own `is`. The entry is available whenever the keys conform to `Equatable`.
			§§
			§§ @param at — the key to look for
			§§ @returns — the value in an Optional, or an empty Optional when the key holds no value.
			<infer KeyType is Equatable>(at key: KeyType) -> Optional<ValueType>

			§§ Answers the value the given key holds, or the given fallback when the key holds no value.
			§§
			§§ Equality is the keys' own `is`. The entry is available whenever the keys conform to `Equatable`.
			§§
			§§ @param at — the key to look for
			§§ @param defaultingTo — the value to answer with when the key holds no value
			§§ @returns — the value, or the fallback in its place.
			<infer KeyType is Equatable>(
				at key: KeyType,
				defaultingTo fallback: ValueType,
			) -> ValueType {
				<- @::value(at key)::value(defaultingTo fallback)
			}
		}

		§§ Answers the keys, in the order they were first set.
		§§
		§§ @returns — the List of keys.
		keys() -> List<KeyType>

		§§ Answers the values, in the order their keys were first set.
		§§
		§§ @returns — the List of values.
		values() -> List<ValueType>

		§§ Answers the entries, in the order their keys were first set.
		§§
		§§ Each entry is a Record of a `key` and a `value`, which a Pattern can take apart.
		§§
		§§ @returns — the List of entries.
		entries() -> List<{ key: KeyType, value: ValueType }>

		§§ Answers a new Dictionary with the given key holding the given value.
		§§
		§§ A key that is already there keeps its place and takes the new value. A key that is not there is added at the end. Equality is the keys' own `is`.
		§§
		§§ @param _ — the key to set
		§§ @param to — the value the key holds
		§§ @returns — the Dictionary with that entry.
		set<infer KeyType is Equatable>(
			_ key: KeyType,
			to value: ValueType,
		) -> Dictionary<KeyType, ValueType>

		§§ Answers a new Dictionary with the given key's value transformed.
		§§
		§§ `update(at:with:)` answers the receiver unchanged when the key holds no value. `update(at:defaultingTo:with:)` transforms the given value in its place.
		§§
		§§ @returns — the Dictionary with the transformed value.
		overload update {
			§§ Answers a new Dictionary with the given key's value transformed.
			§§
			§§ A key that holds no value answers the receiver unchanged, and the transform does not run.
			§§
			§§ @param at — the key whose value to transform
			§§ @param with — the transform the value is handed to
			§§ @returns — the Dictionary with the transformed value.
			<infer KeyType is Equatable>(
				at key: KeyType,
				with transform: (_: ValueType) -> ValueType,
			) -> Dictionary<KeyType, ValueType> {
				§ `@` inside a `match` is the scrutinee, so the receiver is
				§ bound above it. See DEVELOPMENT.md, Why bodies look the way
				§ they do.
				constant mine = @

				<- match mine::value(at key) -> Dictionary<KeyType, ValueType> {
					case #Value(held) { <- mine::set(key, to transform(held)) }
					case #Empty       { <- mine }
				}
			}

			§§ Answers a new Dictionary with the given key's value transformed, starting from the given value where the key holds no value.
			§§
			§§ A key that holds no value is set to the transform of the given value.
			§§
			§§ @param at — the key whose value to transform
			§§ @param defaultingTo — the value to transform when the key holds no value
			§§ @param with — the transform the value is handed to
			§§ @returns — the Dictionary with the transformed value.
			<infer KeyType is Equatable>(
				at key: KeyType,
				defaultingTo start: ValueType,
				with transform: (_: ValueType) -> ValueType,
			) -> Dictionary<KeyType, ValueType> {
				<- @::set(
					key,
					to transform(@::value(at key, defaultingTo start)),
				)
			}
		}

		§§ Answers a new Dictionary without the given key.
		§§
		§§ A key that is not there answers the receiver unchanged. Equality is the keys' own `is`.
		§§
		§§ @param at — the key to remove
		§§ @returns — the Dictionary without that entry.
		remove<infer KeyType is Equatable>(
			at key: KeyType,
		) -> Dictionary<KeyType, ValueType>

		§§ Answers a new Dictionary without every entry the check accepts.
		§§
		§§ Each entry is offered to the check, and the entries it rejects keep their order. A check that accepts every entry answers the empty Dictionary.
		§§
		§§ @param where — the check each entry is offered to
		§§ @returns — the Dictionary of the entries the check rejects.
		removeEvery<infer KeyType is Equatable>(
			where check: (_: { key: KeyType, value: ValueType }) -> Boolean,
		) -> Dictionary<KeyType, ValueType> {
			<- @::everyEntry(where (entry) { <- check(entry)::negate() })
		}

		§ The filter, and the complement of `removeEvery(where:)`. It is named
		§ as `List::everyItem(where:)` is, and it rebuilds through `of`, which
		§ encodes the kept keys a second time. A native sharing the receiver's
		§ encodings is what `map` does, and it is worth writing here once a
		§ measurement asks for it.

		§§ Answers a new Dictionary of every entry the check accepts.
		§§
		§§ Each entry is offered to the check, and the accepted entries keep their order.
		§§
		§§ @param where — the check each entry is offered to
		§§ @returns — the Dictionary of accepted entries.
		everyEntry<infer KeyType is Equatable>(
			where check: (_: { key: KeyType, value: ValueType }) -> Boolean,
		) -> Dictionary<KeyType, ValueType> {
			<- Dictionary.of(@::entries()::everyItem(where check))
		}

		§ Native so the answer reuses the receiver's key encodings rather than
		§ encoding the same keys a second time. It needs no `Equatable` bound:
		§ the receiver's keys are distinct already, and transforming the values
		§ can not make two of them collide.

		§§ Answers a new Dictionary with the given transform applied to every entry.
		§§
		§§ The keys are kept, and what the transform answers becomes the value of the entry it was handed. The answer holds the same keys in the same order.
		§§
		§§ @param _ — the transform each entry is handed to
		§§ @returns — the Dictionary of transformed values.
		map<infer Result>(
			_ transform: (_: { key: KeyType, value: ValueType }) -> Result,
		) -> Dictionary<KeyType, Result>

		§§ Answers a new Dictionary holding the entries of both.
		§§
		§§ On a key both hold, the given Dictionary's value wins. The `choosing:` entry hands both values to the caller instead.
		§§
		§§ @returns — the merged Dictionary.
		overload merge {
			§§ Answers a new Dictionary holding the entries of both, where the given Dictionary wins.
			§§
			§§ A key both hold takes the given Dictionary's value. A key only the given Dictionary holds is added at the end.
			§§
			§§ @param with — the Dictionary whose entries to add
			§§ @returns — the merged Dictionary.
			<infer KeyType is Equatable>(
				with other: Dictionary<KeyType, ValueType>,
			) -> Dictionary<KeyType, ValueType> {
				§ `@` is not the receiver inside a callback, so the Dictionary
				§ the fold builds on is bound above it. See DEVELOPMENT.md,
				§ Why bodies look the way they do.
				§
				§ The fold starts from `mine`, which is already a Dictionary
				§ of the answer's Types. A `reduce` binds `Result` from
				§ `startingWith`, and there is no empty Dictionary to write
				§ down.
				constant mine = @

				<- other
					::entries()
					::reduce(startingWith mine, (merged, entry) {
						<- merged::set(entry.key, to entry.value)
					})
			}

			§§ Answers a new Dictionary holding the entries of both, asking the given Function for the value of a key both hold.
			§§
			§§ The Function is handed the receiver's value and then the given Dictionary's value. A key only one of the two holds is taken as it stands.
			§§
			§§ @param with — the Dictionary whose entries to add
			§§ @param choosing — the Function answering the value of a key both hold
			§§ @returns — the merged Dictionary.
			<infer KeyType is Equatable>(
				with other: Dictionary<KeyType, ValueType>,
				choosing choose: (_: ValueType, _: ValueType) -> ValueType,
			) -> Dictionary<KeyType, ValueType> {
				constant mine = @

				<- other
					::entries()
					::reduce(startingWith mine, (merged, entry) {
						<- match mine::value(
							at entry.key,
						) -> Dictionary<KeyType, ValueType> {
							case #Value(held) {
								<- merged::set(
									entry.key,
									to choose(held, entry.value),
								)
							}
							case #Empty       {
								<- merged::set(entry.key, to entry.value)
							}
						}
					})
			}
		}
	}
}

export {
	Dictionary
}
