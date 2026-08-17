import {
	Printable from "./Protocols.es"
	String    from "./String.es"
}

declarations {

	§ Where written text lands. A terminal offers two streams and no more —
	§ `#Output` is what the Program answers WITH, `#Error` is what it complains
	§ ABOUT — so the pair is a `choice` rather than a String naming a file
	§ handle, exactly as `Side` and `Rounding` are. Every entry that writes
	§ takes one under a `to` label, defaulted to `#Output`: the default is a
	§ Case of the Choice, written where every reader of the signature sees it.
	choice Stream {
		Output,
		Error,
	}

	§ Everything a Program can put in front of a person. There are exactly three
	§ Methods here, and they are three because the audiences are three
	§ different things.
	§
	§ `print` is for the Program's READER. It renders through the value's own
	§ `Printable` conformance, so a String prints as its text and not as a
	§ quoted Literal, and it ends the line — which is what "print" has meant
	§ for as long as there have been terminals.
	§
	§ `inspect` is for the Program's AUTHOR. It renders the STRUCTURE — Strings
	§ quoted, Cases as their tags, Records and Lists laid out — for any value
	§ at all, conformance or no conformance, and it answers with the very value
	§ it was handed so it can be wrapped around any Expression without changing
	§ what that Expression evaluates to.
	§
	§ `write` is the primitive both of the others are built on: text, exactly as
	§ given, with nothing added and no newline. `write` and `inspect` are
	§ native; `print` is written in Essence on top of `write`. The Stream is a
	§ DEFAULT on each of them rather than an entry of its own — a native carries
	§ its default exactly as a bodied Method does, and the Compiler synthesizes
	§ the frame `write`'s needs.
	namespace Terminal {
		§§ Prints a value for the Program's reader — its own `toString`, and then a newline. A String prints as its text, without the quotes a Literal is written with. Writes to `#Output` unless a `to` Stream says otherwise.
		§§
		§§ @param value — the value to print, rendered by its `Printable` conformance.
		§§ @param to — the Stream the line lands on; `#Output` when it is left out.
		static print<infer Value is Printable>(
			_ value: Value,
			to stream: Stream = #Output,
		) -> {} {
			§ The hole renders the value through its `Printable` conformance,
			§ which IS the `toString` this Method promises — writing the call
			§ out would be the redundant spelling of the same thing.
			§
			§ The newline is added HERE, once, rather than in either native —
			§ which is what keeps `write` honest about writing exactly what it
			§ was given.
			<- Terminal.write("{value}\n", to stream)
		}

		§§ Writes text exactly as given — no newline, no quotes, nothing added. The primitive `print` is built on. Writes to `#Output` unless a `to` Stream says otherwise.
		§§
		§§ @param text — the text to write, unchanged.
		§§ @param to — the Stream the text lands on; `#Output` when it is left out.
		static write(_ text: String, to stream: Stream = #Output) -> {}

		§§ Prints a value for the Program's AUTHOR — the structural form, with Strings quoted, Cases shown as their tags and Records and Lists laid out. Takes any value, conformance or none, and answers with that same value, so it can wrap any Expression without changing what it evaluates to.
		§§
		§§ @param value — the value to inspect
		§§ @returns — the value it was given, unchanged.
		static inspect<infer Value>(_ value: Value) -> Value
	}
}

export {
	Stream
	Terminal
}
