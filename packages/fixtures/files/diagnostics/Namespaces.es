§ This file does not compile — on purpose.
§
§ Every declaration below triggers a different Namespace Diagnostic, so that
§ the Compiler's error output can be read end to end:
§
§     bun packages/cli/bin/esc check packages/fixtures/files/diagnostics/Namespaces.es
§
§ Keep it broken. If a change makes one of these compile, the Diagnostic it
§ was showcasing no longer has a home.

implementation {
	§ at-in-static-method — a static Method is called on the Namespace and has
	§ no receiver, so '@' inside one stands for nothing. Called twice below,
	§ which is what the Quick Fix reads: dropping 'static' would change how
	§ every one of those calls is written, so it is withheld here and the Help
	§ says what taking it would cost.
	namespace Counters for Integer {
		static doubled() -> Integer {
			<- @::multiply(with 2)
		}
	}

	constant first = Counters.doubled()

	constant second = Counters.doubled()
}
