§ This file does not compile — on purpose.
§
§ It is the one place every way a '\u{…}' can be written wrong can be read end
§ to end in one run:
§
§     bun packages/cli/bin/esc check packages/fixtures/files/diagnostics/Escapes.es
§
§ Keep it broken. If a change makes this compile, the Diagnostic it was
§ showcasing no longer has a home.

implementation {
	§ The escape that works, so the refusals below read against something. One
	§ to six hexadecimal digits in braces, naming one character.
	constant reset = "\u{1B}[0m"

	§ unbraced-unicode-escape — the JavaScript and JSON habit. Its '\u' takes
	§ exactly four digits and no braces, so the Help rebrackets exactly the four
	§ that were written and leaves anything behind them alone.
	constant accented = "caf\u00e9"

	§ unbraced-unicode-escape — and its other half. Neither surrogate names a
	§ character, so neither has a rewrite of its own; the two together name one,
	§ and that is the escape the Help offers.
	constant face = "\uD83D\uDE00"

	§ malformed-unicode-escape — braces holding nothing name no code point.
	constant empty = "\u{}"

	§ malformed-unicode-escape — 'G' is not a hexadecimal digit. The digits are
	§ read here rather than handed to a number reader, which would take the '1'
	§ and answer for it.
	constant mistyped = "\u{1G}"

	§ malformed-unicode-escape — seven digits, which is one leading zero more
	§ than a code point has room for. The zeros come off in the Help.
	constant padded = "\u{0000041}"

	§ malformed-unicode-escape — never closed. The scan stops at the closing
	§ quote without consuming it, so this String ends where it was written and
	§ every Statement below it is still read.
	constant unclosed = "\u{1B"

	§ unicode-escape-out-of-range — above U+10FFFF, the highest code point there
	§ is. Every decimal digit is a hexadecimal digit too, so a code point copied
	§ off a chart in decimal looks exactly like this; the Help asks whether that
	§ is what happened rather than assuming it.
	constant tooLarge = "\u{128512}"

	§ surrogate-unicode-escape — U+D800 to U+DFFF are the halves UTF-16 writes a
	§ character above U+FFFF in, and name no character on their own. Nothing is
	§ offered, because there is no character this one stands for.
	constant half = "\u{D800}"

	§ surrogate-unicode-escape — and the pair written out the long way, which is
	§ ONE report over BOTH escapes: the character they spell is what the Help
	§ offers, and the span it rewrites has to cover all of what it answers.
	constant halves = "\u{D83D}\u{DE00}"

	Terminal.inspect([reset, accented, face, empty, mistyped, padded, unclosed, tooLarge, half, halves])
}
