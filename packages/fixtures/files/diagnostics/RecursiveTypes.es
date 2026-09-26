§ This file does not compile — on purpose.
§
§ Recursive Type declarations are not part of the language yet, and every shape
§ a recursion can take is below, so that the Compiler's error output for them can
§ be read end to end in one run:
§
§     bun packages/cli/bin/esc check packages/fixtures/files/diagnostics/RecursiveTypes.es
§
§ What is being showcased as much as the Diagnostics is what is NOT reported:
§ every name in a cycle stays declared, so `Alongside` below — which names one of
§ them without being part of any cycle — says nothing, and neither does the
§ Constant under it.
§
§ Keep it broken. If a change makes one of these compile, the Diagnostic it was
§ showcasing no longer has a home.

implementation {
	§ recursive-type-declaration — a Type Alias that names itself, the shortest
	§ cycle there is.
	type Node = { value: Integer, next: Node }

	§ recursive-type-declaration — a mutually recursive pair. Both halves report,
	§ each pointing at the name that carries the cycle onwards.
	choice Signal {
		Wrapped { command: Command },
	}

	choice Command {
		Wrapping { signal: Signal },
	}

	§ recursive-type-declaration — a longer way round, through an Alias and a
	§ Choice both; the note spells the whole path.
	type Wrapper = Wrapped

	choice Wrapped {
		Inner { wrapper: Wrapper },
	}

	§ recursive-type-declaration — a Generic's default Type counts as naming, so
	§ this is a cycle of one.
	type Boxed<Item = Boxed<Integer>> = { value: Item }

	§ recursive-type-declaration — two predicates, each checking a value against
	§ the other's refinement, so neither can be read first. Both report.
	type Low = Integer where @::isBelow(5)

	type High = Integer where @::isAbove(5)

	namespace Bounds for Integer {
		isBelow(_ limit: High) -> Boolean {
			<- @::isLessThan(limit)
		}

		isAbove(_ limit: Low) -> Boolean {
			<- @::isGreaterThan(limit)
		}
	}

	§ Silent: `Node` is one of the names above, declared as the Type nothing can
	§ be checked against, so naming it is not an error of its own.
	type Alongside = { node: Node }

	constant alongside: Alongside = { node = { value = 1, next = 2 } }
}
