§ Deliberately broken: what the Enricher says about the `= { … }` a Case's
§ payload shape carries.

implementation {

	§ Which members a default fills in is read off the ones it writes, so the
	§ default itself is spelled out — even where the values in it are names.
	constant standardHeaders = { headers = ["Accept"] }

	choice Named {
		Get { url: String, headers: List<String> } = standardHeaders,
	}

	§ A value in a default is written down, or names a Constant of this Module
	§ that holds one. A value worked out where it stands is neither.
	constant sizes = [3, 1, 2]

	choice Computed {
		Get { url: String, retries: Integer } = { retries = sizes::length() },
	}

	§ Following a Constant to another Constant follows one written value to the
	§ next, and is fine as far as it goes — but every leaf has to be written
	§ down, and this one stops at a call.
	constant biggest = sizes::length()

	choice Reached {
		Get { url: String, retries: Integer } = { retries = biggest },
	}

	§ A Variable is no Constant: it holds whatever it was last assigned, and a
	§ payload default is read once, where the Choice is declared.
	variable attempts = 0

	choice Changing {
		Get { url: String, retries: Integer } = { retries = attempts },
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
