import {
	from "./Boolean.es" { Boolean }
	from "./Integer.es" {
		NonNegativeInteger
		PositiveInteger
	}
	from "./List.es" {
		List
		NonEmptyList
	}
	from "./Optional.es" { Optional }
	from "./Protocols.es" {
		Equatable
		Printable
	}
}

declarations {

	§ The predicate asks nothing about the key Type or the value Type. One
	§ predicate serves every Dictionary, and both Type Arguments stay in the base.

	§§ A Dictionary proven to have an entry in it, as a checked refinement of `Dictionary`.
	§§
	§§ The proof is what lets `length` answer above zero, and `keys`, `values` and `entries` answer a List with something in it. A Dictionary written down with an entry in it carries the proof. A Dictionary a Program is handed earns it through an `if` asking `hasEntries`, and `set` answers with this Type whatever it was given.
	type NonEmptyDictionary<KeyType, ValueType> = Dictionary<KeyType, ValueType>
		where @::hasEntries()

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
	namespace Dictionary<infer KeyType, infer ValueType>
		for Dictionary<KeyType, ValueType>
		is Equatable where KeyType is Equatable, ValueType is Equatable,
		is Printable where KeyType is Printable, ValueType is Printable
	{
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
		toString<infer KeyType is Printable, infer ValueType is Printable>()
			-> String

		§§ Answers whether the Dictionary has no entries at all.
		§§
		§§ @returns — `true` for the empty Dictionary.
		isEmpty() -> Boolean

		§ The quantified entry folds a Boolean over the entries, on `reduce`'s
		§ early-stopping entry, so the walk stops at the entry that decides the
		§ answer. Written on `everyEntry(where:)` it would build a whole
		§ Dictionary per call and then ask whether it holds anything.
		§
		§ Only the check stops early. The fold sees its first entry after
		§ `entries()` has built one Record per entry, so the Method allocates for
		§ the whole Dictionary whatever it answers. No other spelling exists here. A
		§ Dictionary has no `reduce` of its own, and a walk that stopped before
		§ the List was built would be a native.

		§§ Answers whether the Dictionary has an entry, or has an entry the check accepts.
		§§
		§§ @returns — `true` when the Dictionary has an entry, or when the check accepts an entry.
		overload hasEntries {
			§§ Answers whether the Dictionary has at least one entry.
			§§
			§§ It is the opposite of `isEmpty`.
			§§
			§§ @returns — `true` when the Dictionary is not empty.
			() -> Boolean {
				§ This body is read as well as run. A predicate written as one
				§ call on `@` is that call. So a refinement written on either
				§ name is one Type, and the `else` of an `if` asking `isEmpty`
				§ proves `NonEmptyDictionary`. See DEVELOPMENT.md, Why bodies
				§ look the way they do.
				<- @::isEmpty()::negate()
			}

			§§ Answers whether the check accepts at least one entry.
			§§
			§§ The walk stops at the first accepted entry. The empty Dictionary has no entry to accept, so it answers `false`.
			§§
			§§ @param where — the check each entry is offered to
			§§ @returns — `true` when the check accepts an entry.
			(
				where check: (_: { key: KeyType, value: ValueType }) -> Boolean,
			) -> Boolean {
				<- @::entries()
					::reduce(startingWith false, step (found, entry) {
						if check(entry) {
							<- #Done(true)
						} else {
							<- #Continue(found)
						}
					})
			}
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
		§§ @returns — the number of entries, which is never negative.
		length() -> NonNegativeInteger

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
		§§ A key that is already there keeps its place and takes the new value. A key that is not there is added at the end. Equality is the keys' own `is`. The answer holds the entry that was set, so it is never empty.
		§§
		§§ @param _ — the key to set
		§§ @param to — the value the key holds
		§§ @returns — the Dictionary with that entry, which certainly has an entry.
		set<infer KeyType is Equatable>(
			_ key: KeyType,
			to value: ValueType,
		) -> NonEmptyDictionary<KeyType, ValueType>

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

		§ The filter and its complement are native for the reason `map` is.
		§ The answer reuses the receiver's key encodings rather than encoding
		§ the kept keys a second time, which an Essence body through `of` did.
		§ Neither needs an `Equatable` bound. The receiver's keys are distinct
		§ already, and keeping some of them can not make two collide.
		§
		§ Measured on a thousand keys with half kept, best of five. String
		§ keys take 29 µs through `of` and 23 µs native. Record keys take
		§ 100 µs and 25 µs, and payload Case keys 75 µs and 29 µs. The gap
		§ is one encoding per kept key, so it widens for a composite key.

		§§ Answers a new Dictionary without every entry the check accepts.
		§§
		§§ Each entry is offered to the check, and the entries it rejects keep their order. A check that accepts every entry answers the empty Dictionary.
		§§
		§§ @param where — the check each entry is offered to
		§§ @returns — the Dictionary of the entries the check rejects.
		removeEvery(
			where check: (_: { key: KeyType, value: ValueType }) -> Boolean,
		) -> Dictionary<KeyType, ValueType>

		§§ Answers a new Dictionary of every entry the check accepts.
		§§
		§§ Each entry is offered to the check, and the accepted entries keep their order. It is named as `List::everyItem(where:)` is.
		§§
		§§ @param where — the check each entry is offered to
		§§ @returns — the Dictionary of accepted entries.
		everyEntry(
			where check: (_: { key: KeyType, value: ValueType }) -> Boolean,
		) -> Dictionary<KeyType, ValueType>

		§ Native for the reason the two filters above are: the answer reuses
		§ the receiver's key encodings. It needs no `Equatable` bound either,
		§ since transforming the values can not make two keys collide.

		§§ Answers a new Dictionary with the given transform applied to every entry.
		§§
		§§ The keys are kept, and what the transform answers becomes the value of the entry it was handed. The answer holds the same keys in the same order.
		§§
		§§ @param _ — the transform each entry is handed to
		§§ @returns — the Dictionary of transformed values.
		map<infer Other>(
			_ transform: (_: { key: KeyType, value: ValueType }) -> Other,
		) -> Dictionary<KeyType, Other>

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
				§ Two Dictionaries are in reach inside the fold. The
				§ Function is asked about the one bound here: `mine` is the
				§ receiver, and `merged` is what the fold has built so far.
				§ Reading `merged` instead would hand the Function a value an
				§ earlier round had already chosen. The two answer alike as
				§ it happens, since `other`'s keys are distinct. No round
				§ revisits a key an earlier one wrote. That is a theorem
				§ about the Argument rather than the promise this entry
				§ makes, and `mine` is the promise written down.
				constant mine = @

				<- other
					::entries()
					::reduce(startingWith mine, (merged, entry) {
						<- match mine::value(at entry.key)
							-> Dictionary<KeyType, ValueType>
						{
							case #Value(held) {
								<- merged::set(
									entry.key,
									to choose(held, entry.value),
								)
							}
							case #Empty {
								<- merged::set(entry.key, to entry.value)
							}
						}
					})
			}
		}
	}

	§ The Methods the proof changes. A NonEmptyDictionary already answers every
	§ Method of `Dictionary`. A Namespace of its own is for the Methods that
	§ answer better for having the proof.
	§
	§ Four spend it, and each is `Dictionary`'s own native under this
	§ Namespace's name. The `length` entry answers a `PositiveInteger`. The three
	§ halves a Dictionary is read as answer a `NonEmptyList`. There is one key,
	§ one value and one entry for every entry the receiver holds. The fifth
	§ entry, `map`, carries the proof rather than spending it, for the reason
	§ `NonEmptyList::map` does: one transformed value for every entry.
	§
	§ Every entry is native, because the promise can not be said in Essence.
	§ Written `<- @::length()` on a proven receiver, it is this very Method, and
	§ the Validator refuses it as `infinite-recursion`. See DEVELOPMENT.md, A
	§ receiver narrowed by evidence.
	§
	§ The `set` entry is absent for the opposite reason. It answers a
	§ `NonEmptyDictionary` on `Dictionary` itself, whatever it was handed, as
	§ `List::append(_:)` does.
	§
	§ `update` and `merge` are absent for neither reason: they do not carry the
	§ proof, and a proven receiver comes out of either one unproven. Both keep
	§ a Dictionary non-empty all the same, since an update rewrites a value and
	§ a merge only ever adds. So a twin here could carry the proof honestly,
	§ written in Essence over `set`, whose answer is proven. It is deferred:
	§ four copied bodies and their golden lines weigh more than a proof one
	§ `if` takes back.
	namespace NonEmptyDictionary<infer KeyType, infer ValueType>
		for NonEmptyDictionary<KeyType, ValueType>
	{
		§§ Answers how many entries the Dictionary has, which is at least one.
		§§
		§§ @returns — the number of entries, which is above zero.
		length() -> PositiveInteger

		§§ Answers the keys, in the order they were first set.
		§§
		§§ @returns — the List of keys, which certainly has something in it.
		keys() -> NonEmptyList<KeyType>

		§§ Answers the values, in the order their keys were first set.
		§§
		§§ @returns — the List of values, which certainly has something in it.
		values() -> NonEmptyList<ValueType>

		§§ Answers the entries, in the order their keys were first set.
		§§
		§§ Each entry is a Record of a `key` and a `value`, which a Pattern can take apart.
		§§
		§§ @returns — the List of entries, which certainly has something in it.
		entries() -> NonEmptyList<{ key: KeyType, value: ValueType }>

		§§ Answers a new Dictionary with the given transform applied to every entry.
		§§
		§§ The keys are kept, and what the transform answers becomes the value of the entry it was handed. The answer holds the same keys in the same order.
		§§
		§§ @param _ — the transform each entry is handed to
		§§ @returns — the Dictionary of transformed values, which certainly has an entry.
		map<infer Other>(
			_ transform: (_: { key: KeyType, value: ValueType }) -> Other,
		) -> NonEmptyDictionary<KeyType, Other>
	}

	§ The bridge from the first container to the second, and the Methods a List
	§ answers through it. Three cross it: `group(on:)`, `tally()` and
	§ `index(on:)` each answer a Dictionary keyed by something read off the
	§ items. None is a Method of `List`. What a List becomes here is a
	§ Dictionary, so the file that owns the answer owns them. That is why
	§ `NumberList.es` owns the aggregates a List of Numbers answers.
	§
	§ A fourth, `removeDuplicates`, used to cross and come back. It was
	§ `tally`'s keys, and it dragged the whole store into any Program asking a
	§ List for its distinct items. It is a `List` native over a plain Map now,
	§ beside three other set-shaped Methods. The encoding it needs is a
	§ runtime module of its own; the note above `List::removeDuplicates` says
	§ why.
	§
	§ `group(on:)` replaced a `List::group(on:)` that folded a List of group
	§ Records, scanning the groups opened so far for each item. Over the same
	§ 20,000 items it took 195 ms, where this native takes 0.8 ms. The List
	§ of groups it answered is one `entries()` away from this answer.
	§
	§ The name says what the receiver becomes, which is what a reader of a
	§ grouping call has to be told. A `DictionaryList` would name the answer and
	§ leave the receiver unsaid. Its target is `List<ItemType>`, the widest
	§ there is, which is `KeyedNumberList`'s target too. It shares no Method
	§ name with any Namespace a List reaches. So the target decides nothing
	§ here, and the name is the whole of what a reader has.
	§
	§ The three crossings are native, and none could be anything else. Grouping
	§ promises each group has an item in it, and tallying promises each count
	§ is above zero. Indexing has a proven twin below whose promise is about
	§ the answer. An Essence body building any of them out of `set` and
	§ `append` would answer a bare `Dictionary` of bare Lists.
	namespace GroupedList<infer ItemType> for List<ItemType> {
		§§ Answers the items grouped under the key the given Function reads off each one.
		§§
		§§ The groups stand in the order their keys first appear, and the items of a group keep the order they had. Every group holds at least one item, and the empty List answers the empty Dictionary. Equality is the keys' own `is`. The List of groups is what `entries()` answers: one Record per group, holding the `key` and its items under `value`.
		§§
		§§ @param on — the key read off each item
		§§ @returns — the Dictionary of groups, each of which has an item in it.
		group<infer Key is Equatable>(
			on key: (_: ItemType) -> Key,
		) -> Dictionary<Key, NonEmptyList<ItemType>>

		§§ Answers how many times each item occurs.
		§§
		§§ The items stand in the order they first appear. Equality is the items' own `is`.
		§§
		§§ @returns — the Dictionary of counts, each of which is above zero.
		tally<infer ItemType is Equatable>()
			-> Dictionary<ItemType, PositiveInteger>

		§§ Answers the items under the key the given Function reads off each one, one item per key.
		§§
		§§ A later item with the same key replaces the earlier one as the value. The key keeps the place it was first met at, as `set` does. The keys stand in the order they first appear. Equality is the keys' own `is`. To keep every item under a key, use `group(on:)`.
		§§
		§§ @param on — the key read off each item
		§§ @returns — the Dictionary of items, keyed by what the Function read off each.
		index<infer Key is Equatable>(
			on key: (_: ItemType) -> Key,
		) -> Dictionary<Key, ItemType>
	}

	§ The same crossings with the receiver's proof in hand, and the one thing
	§ that proof changes. A List with an item in it puts that item in a group,
	§ under a count, or at a key. So the Dictionary it answers holds an entry,
	§ and the keys of that Dictionary are a List with something in it. None
	§ of the entries above can promise that, because the empty List groups
	§ into the empty Dictionary and tallies into it too.
	§
	§ It mirrors `GroupedList`, and sits after it for the reason every proven
	§ Namespace sits after the one it narrows. All three entries are
	§ `GroupedList`'s own natives under this Namespace's names. So each pair
	§ is one Function under two names and can not come apart.
	namespace GroupedNonEmptyList<infer ItemType> for NonEmptyList<ItemType> {
		§§ Answers the items grouped under the key the given Function reads off each one.
		§§
		§§ The groups stand in the order their keys first appear, and the items of a group keep the order they had. Every group holds at least one item. Equality is the keys' own `is`.
		§§
		§§ @param on — the key read off each item
		§§ @returns — the Dictionary of groups, which certainly has a group in it.
		group<infer Key is Equatable>(
			on key: (_: ItemType) -> Key,
		) -> NonEmptyDictionary<Key, NonEmptyList<ItemType>>

		§§ Answers how many times each item occurs.
		§§
		§§ The items stand in the order they first appear. Equality is the items' own `is`.
		§§
		§§ @returns — the Dictionary of counts, which certainly has a count in it.
		tally<infer ItemType is Equatable>()
			-> NonEmptyDictionary<ItemType, PositiveInteger>

		§§ Answers the items under the key the given Function reads off each one, one item per key.
		§§
		§§ A later item with the same key replaces the earlier one as the value. The key keeps the place it was first met at, as `set` does. The keys stand in the order they first appear. Equality is the keys' own `is`.
		§§
		§§ @param on — the key read off each item
		§§ @returns — the Dictionary of items, which certainly has an entry in it.
		index<infer Key is Equatable>(
			on key: (_: ItemType) -> Key,
		) -> NonEmptyDictionary<Key, ItemType>
	}
}

export {
	Dictionary
	GroupedList
	GroupedNonEmptyList
	NonEmptyDictionary
}
