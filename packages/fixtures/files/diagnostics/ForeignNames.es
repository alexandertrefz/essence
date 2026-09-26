§ This file does not compile — on purpose.
§
§ Every name below is one another language declares and this one does not, or a
§ Method reached with the separator another language reaches one with. Each of
§ them parses, so it is the Enricher that answers:
§
§     bun packages/cli/bin/esc check packages/fixtures/files/diagnostics/ForeignNames.es
§
§ Keep it broken. If a change makes one of these compile, the Diagnostic it was
§ showcasing no longer has a home.

implementation {
	choice Light {
		Red,
		Green,
	}

	constant names = ["ada", "alan"]
	constant ready = true
	constant user  = { name = "Ada" }

	§ method-called-with-dot — the Method is there and the separator is not. The
	§ first was called and the second read, which is two Helps and two fixes.
	Terminal.print(names.length())
	Terminal.print(names.length)

	§ type-without-members — no Method of the name answers, so the report stays
	§ what it was and the Help is the one that leads to `unknown-method`.
	Terminal.print(names.at(0))

	§ unknown-member — a Record has members, and this is not one of them. Called,
	§ so the separator is mentioned beside the near miss.
	Terminal.print(user.nam())

	§ foreign-syntax — words another language has. Each names what Essence writes
	§ instead, and the ones that are one word carry a fix.
	constant missing = null
	constant listed  = new
	console.log("hi")

	§ foreign-syntax — the two postfix habits, each of them read as one name. The
	§ second is written in front of a member, so the Help names that member.
	Terminal.print(user!)
	Terminal.print(user?.name)

	§ operator-not-supported — a prefix operator ends no name, so it arrives
	§ inside one and the Help can name the operand.
	constant flipped = !ready

	§ unknown-name — a Case written without the '#' that makes one. The Choice
	§ that declares it is named, and the fix writes the sigil.
	constant light: Light = Red

	Terminal.print(light::is(#Red))
}
