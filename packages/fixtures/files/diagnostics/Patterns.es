§ This file does not compile — on purpose.
§
§ Every statement below triggers a different Diagnostic about Patterns, so
§ that the Compiler's error output can be read end to end in one run:
§
§     bun packages/cli/bin/esc check packages/fixtures/files/diagnostics/Patterns.es
§
§ The Parser reports two of these and stops the run before the Enricher ever
§ sees the file, so `redundant-pattern-binder` and `pattern-without-body` live
§ in `Syntax.es` beside the rest of the Parser's own report — a parse error
§ here would leave everything below it unshown.
§
§ Keep it broken. If a change makes one of these compile, the Diagnostic it
§ was showcasing no longer has a home.

implementation {
	constant rectangle = { width = 3, height = 4 }

	§ refutable-pattern — a Declaration can not decline a value, so a member
	§ matched against a written one has nowhere to fall through to.
	constant { width = 0, height } = rectangle

	§ refutable-pattern, at depth — the rule reaches a nested Pattern, because
	§ what it is about is whether the Pattern can decline at all.
	constant nested = { origin = { x = 1, y = 2 } }

	constant { origin as { x = 0, y } } = nested

	§ refutable-pattern — a Parameter is bound after the call has already been
	§ made, which is the same reason.
	function area(of { width = 1, height }: {
		width: Integer,
		height: Integer,
	}) -> Integer {
		<- width::multiply(with height)
	}

	§ unknown-member — a Declaration naming a member the value has not got has
	§ bound a name to nothing. A Matcher may name one, because that merely
	§ writes an arm nothing takes, and `unreachable-case` reports that instead.
	constant { widht } = rectangle

	§ duplicate-variable — two binders of one name, which the Pattern spells
	§ out twice under `as`. Nothing Pattern-specific reports it: each binder is
	§ declared for real, and the second declaration collides like any other.
	constant { width as measure, height as measure } = rectangle

	§ unbindable-case-payload — a binder that is one NAME names what the
	§ constructor takes, and a Case carrying several has nothing single to
	§ name. The help says which form does take it apart.
	choice Shape {
		Rectangle { width: Integer, height: Integer },
		Circle { radius: Integer },
	}

	constant shape: Shape = #Circle({ radius = 1 })

	constant sized = match shape -> Integer {
		case #Rectangle(box) { <- 0 }
		case #Circle(radius) { <- radius }
	}
}
