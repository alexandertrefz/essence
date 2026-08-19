§ This file does not compile — on purpose.
§
§ Every declaration below triggers a different Protocol Diagnostic, so that the
§ Compiler's error output can be read end to end:
§
§     bun packages/cli/bin/esc check packages/fixtures/files/diagnostics/Protocols.es
§
§ Keep it broken. If a change makes one of these compile, the Diagnostic it
§ was showcasing no longer has a home.

implementation {
	§ method-not-on-protocol — the body of a provided Method sees `@` as the
	§ Protocol and as nothing else, so `toString` is out of reach here however
	§ many conformers happen to have one.
	protocol Sized {
		size() -> Integer

		describe() -> String {
			<- @::toString()
		}
	}

	§ where-on-protocol-extension — a Protocol declares no Type Parameters, so
	§ a condition has nothing to bound.
	protocol Ordered is Comparable where Item is Comparable {
		first() -> Integer
	}

	§ unwritable-provided-method — a static Method has no receiver for `@` to
	§ stand for, and an `overload` entry has no single signature to be emitted
	§ under.
	protocol Creatable {
		static create() -> Self {
			<- @
		}

		overload combine {
			(_ other: Self) -> Self {
				<- other
			}

			(_ others: List<Self>) -> Self
		}
	}

	§ recursive-protocol — each of the two extends the other, so neither
	§ surface can ever be finished. Both are named, and both keep their own
	§ Methods so that a Namespace conforming to either still reports about
	§ itself.
	protocol Listed is Sorted {
		count() -> Integer
	}

	protocol Sorted is Listed {
		lowest() -> Integer
	}
}
