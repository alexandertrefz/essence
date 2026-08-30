§ Deliberately broken: Dictionaries the Enricher turns away — a key written
§ twice, an update in the pair of brackets the other form wants, entries that
§ do not fit the base's slots — and one `if` that compiles and asks twice.

implementation {
	constant ages: Dictionary<String, Integer> = ["alex" = 39, "sam" = 25]
	constant config = { port = 80, host = "localhost" }

	§ A Dictionary holds one value per key, so the second entry would take the
	§ first one's place and nothing would say the first was ever there. The key
	§ is the VALUE and not the characters: `2/4` and `1/2` are one key.
	constant twice = ["alex" = 39, "alex" = 40]
	constant halves = [1/2 = "a", 2/4 = "b"]

	§ A Record is updated in braces and a Dictionary in brackets. The two are
	§ different forms and not two styles of one form, so each is told which
	§ pair its base wants rather than measured against the form it is in.
	constant moved = [config with port = 90]
	constant merged = { ages with ages }

	§ An update may only set keys of the Dictionary's key Type, with the Type
	§ it declared for its values.
	constant wrongKey = [ages with 1 = 40]
	constant wrongValue = [ages with "kim" = "seven"]

	§ And a whole Dictionary merged in has to hold both of them.
	constant names: Dictionary<String, String> = ["kim" = "seven"]
	constant both = [ages with names]

	§ redundant-key-check — `hasKey` IS the lookup, so a branch entered by the
	§ key being there and opening with the same `value(at:)` walks the
	§ Dictionary twice for one answer. A Warning rather than a refusal: the
	§ Program is right, it just asks twice.
	if ages::hasKey("alex") {
		constant age = ages::value(at "alex", defaultingTo 0)
	}
}
