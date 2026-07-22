§ This file does not compile — on purpose.
§
§ Every statement below triggers a different Diagnostic, so that the
§ Compiler's error output can be read end to end in one run:
§
§     bun bin/esc check testFiles/diagnostics/Dispatch.es
§
§ Keep it broken. If a change makes one of these compile, the Diagnostic it
§ was showcasing no longer has a home.

implementation {
	§ unknown-method — with a near miss offered from the same Namespaces.
	constant length = "essence"::lenght()

	§ no-matching-overload — every candidate signature is listed.
	constant piece = "essence"::prepend()

	§ no-namespace-for-value.
	constant nowhere = { x = 1 }::describe()
}
