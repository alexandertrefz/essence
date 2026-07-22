§ This file does not compile — on purpose.
§
§ Every declaration below triggers a different conditional-conformance
§ Diagnostic, so that the Compiler's error output can be read end to end:
§
§     bun bin/esc check testFiles/diagnostics/Conformance.es
§
§ Keep it broken. If a change makes one of these compile, the Diagnostic it
§ was showcasing no longer has a home.

implementation {
	§ unknown-where-generic — the condition names 'Other', which is not one of
	§ this Namespace's Type Parameters.
	namespace Unknown<infer Item> for { value: Item }
		is Comparable where Other is Comparable
	{
		compareTo(_ other: { value: Item }) -> Ordering {
			<- Ordering#Equal
		}
	}

	§ conflicting-where-condition — 'Item' is bound twice in one clause.
	namespace Conflicting<infer Item> for { value: Item }
		is Comparable where Item is Comparable, Item is Equatable
	{
		compareTo(_ other: { value: Item }) -> Ordering {
			<- @.value::compareTo(other.value)
		}
	}

	§ unsatisfied-conformance-condition — a List of Lists of Booleans can not be
	§ sorted, because Boolean is not Comparable. The because-chain names each
	§ level of the failure.
	constant ordered = [[true], [false]]::sorted()
}
