§ This file does not compile — on purpose.
§
§ A Choice derives its equality and its Case listing without anybody declaring
§ them, and both derives are built from the Choice: neither consults a
§ Namespace. So a Namespace that writes one of those Methods and does not say
§ `is Equatable` or `is Enumerable` answers one thing where it is named and
§ another through a bound, and is refused here.
§
§     bun packages/cli/bin/esc check packages/fixtures/files/diagnostics/DerivedConformance.es
§
§ Keep it broken. If a change makes one of these compile, the Diagnostic it
§ was showcasing no longer has a home.

implementation {
	choice Colour {
		Red,
		Green,
		Blue,
	}

	§ undeclared-conformance — `Colour.cases()` would read this Method, and
	§ `<infer Mode is Enumerable>` would read the derived listing of all three.
	namespace Offered for Colour {
		static cases() -> NonEmptyList<Colour> {
			<- [#Red]
		}
	}

	§ undeclared-conformance — the guard is by NAME, exactly as the derive's
	§ own replacement rule is, so a `cases` of the wrong shape suppresses the
	§ listing as surely as a right one would.
	namespace Counted for Colour {
		cases() -> Integer {
			<- 3
		}
	}

	§ undeclared-conformance — equality splits the same way: the derive is
	§ unconditional for every Choice, so a written `is` that declares nothing
	§ answers one thing directly and another through an `is Equatable` bound.
	namespace Compared for Colour {
		is(_ other: Colour) -> Boolean {
			<- true
		}
	}
}
