§ This file does not compile — on purpose.
§
§ Every line below is written in another language. The Parser answers each of
§ them with `foreign-syntax` or `operator-not-supported`, naming the habit and
§ the Essence spelling of it:
§
§     bun packages/cli/bin/esc check packages/fixtures/files/diagnostics/ForeignSyntax.es
§
§ Keep it broken. If a change makes one of these compile, the Diagnostic it was
§ showcasing no longer has a home.

implementation {
	§ foreign-syntax — the declaration Keywords. Each is reported once and the
	§ Statement is read on as the one it was meant to be, so `price` and `count`
	§ are declared and nothing that reads them is told otherwise.
	const price = 12
	let count = 3

	§ foreign-syntax — a Comment written in slashes.
	// a note

	§ operator-not-supported — arithmetic, comparison and logic, each named with
	§ the Method it stands for.
	constant total = price + 1
	constant same = price == 12
	constant either = true && false

	§ foreign-syntax — a Statement ended with the Token that ends one elsewhere.
	constant net = 9;

	§ foreign-syntax — a Record member written with the separator every other
	§ language writes an object's with.
	constant origin = { x: 0, y: 0 }

	§ foreign-syntax — a Record reached into rather than rebuilt.
	constant user = { name = "Ada" }
	user.name = "Grace"

	§ foreign-syntax — a Function literal written as an arrow.
	constant double = (n: Integer) => n

	§ foreign-syntax — the conditional operator, which `define` stands for.
	constant chosen = true ? 1 : 2

	§ foreign-syntax — a value answered with the word another language answers
	§ with. Read on as the '<-' it was meant to be.
	function twice(_ n: Integer) -> Integer {
		return n::multiply(with 2)
	}

	§ foreign-syntax — a declaration block this language has no reading for. The
	§ body is read past rather than into, so nothing inside it is reported.
	class Money {
		euros() {}
	}

	§ foreign-syntax — an item read by writing its position in brackets. The
	§ Declaration is read on, so `first` is declared and bound to an Error, and
	§ nothing below it is told a second thing about a mistake answered here.
	constant primes = [2, 3, 5]
	constant first = primes[0]

	§ foreign-syntax — Type Arguments written at the call rather than inferred.
	§ Written last: resynchronisation reads on from the '<' it was refused at,
	§ and the '}' it finds first is the one that ends this block.
	constant identity = twice<Integer>(2)
}
