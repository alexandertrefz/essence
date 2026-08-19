§ Deliberately broken: what the Enricher says about the `= { … }` a Case's
§ payload shape carries.

implementation {

	§ A payload default is spliced into every construction of its Case, and a
	§ construction may stand in a Module that never named the Choice — so a
	§ default says what says itself, and may not read a name.
	constant standardHeaders = { headers = ["Accept"] }

	choice Named {
		Get { url: String, headers: List<String> } = standardHeaders,
	}

	§ The same rule one member down: a member is a literal, or a List, Record
	§ or Case value built out of literals.
	constant none = 0

	choice Computed {
		Get { url: String, retries: Integer } = { retries = none },
	}

	§ A default fills in SOME of the payload's members. It may not name one the
	§ payload does not declare.
	choice Undeclared {
		Get { url: String } = { retries = 0 },
	}

	§ Nor give one a value of another Type — a default stands in for a member
	§ nobody wrote, so it is held to what a written one is held to.
	choice Mistyped {
		Get { url: String, retries: Integer } = { retries = "none" },
	}

	§ A generic Choice's payload members are written in terms of Type
	§ Parameters every use site decides, and a value written at the declaration
	§ can bind none of them.
	choice Box<Value> {
		Full { value: Value, seen: Integer } = { seen = 0 },
		Empty,
	}
}
