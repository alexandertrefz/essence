§ Deliberately broken: the written Dictionary forms the Parser itself turns
§ away — an update with nothing after its `with`, a Dictionary written in a
§ Record's braces, an update written the same way, and an entry whose key and
§ value are separated by something other than an `=`.

implementation {
	constant ages = ["alex" = 39]

	§ An update says what it changes. Neither the entries it sets nor the
	§ Dictionary it merges in was written here.
	constant unchanged = [ages with]

	§ Braces write a Record, whose keys are the member names it declares. A key
	§ that is a value is a Dictionary's.
	constant braced = { "alex" = 39 }

	§ The same mistake one Token later, where the `with` had already been read
	§ past and the key list is where the value key stands.
	constant older = { ages with "alex" = 40 }

	§ An entry is `key = value`, and a bracket list that spells the separator
	§ some other way is no Dictionary at all — it is a List that never closed.
	constant colons = ["alex": 39]
}
