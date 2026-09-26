§ This file does not compile — on purpose.
§
§ Every declaration below triggers a different conditional-conformance
§ Diagnostic, so that the Compiler's error output can be read end to end:
§
§     bun packages/cli/bin/esc check packages/fixtures/files/diagnostics/Conformance.es
§
§ Keep it broken. If a change makes one of these compile, the Diagnostic it
§ was showcasing no longer has a home.

implementation {
	§ unknown-where-generic — the condition names 'Other', which is not one of
	§ this Namespace's Type Parameters.
	namespace Unknown<infer Item> for { value: Item }
		is Comparable where Other is Comparable
	{
		compare(to other: { value: Item }) -> Ordering {
			<- Ordering#Equal
		}
	}

	§ conflicting-where-condition — 'Item' is bound twice in one clause.
	namespace Conflicting<infer Item> for { value: Item }
		is Comparable where Item is Comparable, Item is Equatable
	{
		compare(to other: { value: Item }) -> Ordering {
			<- @.value::compare(to other.value)
		}
	}

	§ unsatisfied-conformance-condition — a List of Lists of Records can not be
	§ sorted, because a Record is not Comparable. The because-chain names each
	§ level of the failure.
	constant ordered = [[{ x = 1 }], [{ x = 2 }]]::sort()

	§ shadowed-type-parameter — 'Item' is already this Namespace's Parameter,
	§ and a second one carries no 'infer', so nothing could ever bind it.
	namespace Shadowing<infer Item> for { value: Item } {
		held<Item>() -> Item {
			<- @.value
		}
	}

	§ restated-inferred-parameter — the bound is what this Method has to say;
	§ 'infer' is the Namespace's own word and is already written above.
	namespace Restating<infer Item> for { value: Item } {
		shown<infer Item is Printable>() -> String {
			<- "{@.value}"
		}
	}

	§ unsatisfied-bound — 'Item' is the Namespace's, unbounded, and 'sort' needs
	§ 'Comparable'. The Help writes the bound onto this Method.
	namespace Unbounded<infer Item> for { items: List<Item> } {
		ordered() -> List<Item> {
			<- @.items::sort()
		}
	}

	§ duplicate-type-parameter — one '<…>' naming 'Item' twice. Only the last
	§ bound would take effect, so the first is thrown away; a Type Parameter
	§ carries one bound and the report says which two were written.
	namespace Twice<infer Item> for { items: List<Item> } {
		described<Item is Comparable, Item is Printable>() -> String {
			<- "{@.items::sort()}"
		}
	}

	§ unsatisfied-bound again, and the OTHER answer: 'toString' fulfils
	§ 'Printable', so a bound of its own would break the promise the conformance
	§ makes — the edit belongs on the 'where', and nothing offers the per-Method
	§ one the Help withholds.
	namespace Fulfilling<infer Item, infer Tag>
		for { items: List<Item>, tag: Tag }
		is Printable where Tag is Printable
	{
		toString() -> String {
			<- "{@.tag} {@.items::sort()::length()}"
		}
	}
}
