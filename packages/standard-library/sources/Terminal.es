import {
	from "./Protocols.es" {
		Equatable
		Printable
	}
	from "./String.es" { String }
}

declarations {

	§ A terminal offers those two and no more, so the pair is a `choice` rather
	§ than a String naming a file handle.

	§§ Where written text lands: `#Output` carries what the Program answers with, and `#Error` what it complains about.
	§§
	§§ `#Output` is what a call that names no Stream gets.
	choice Stream {
		Output,
		Error,
	}

	§ Equality and printing are both derived for a Choice of Cases that carry
	§ no payload. This Namespace declares the two and writes neither; see
	§ DEVELOPMENT.md, Why bodies look the way they do.
	namespace Stream for Stream is Equatable, is Printable {}

	§ Four Methods, because the audiences are three. The `print` Method is for
	§ the Program's reader, `inspect` and `describe` are for its author, and
	§ `write` is the primitive they are built on. The natives are `write`,
	§ `inspect` and `describe`, and `print` is written in Essence on `write`.
	§ The Stream is a default on `print` and `write`, rather than an entry of
	§ its own. A native carries a default exactly as a bodied Method does. The
	§ `inspect` Method takes no Stream: what it writes is for whoever started
	§ the Program.
	namespace Terminal {
		§§ Prints a value and a newline, for the reader of the Program.
		§§
		§§ The value renders through its own `toString`. A String prints as its text, without the quotes a Literal is written with. The line goes to `#Output` unless `to` names a different Stream.
		§§
		§§ @param _ — the value to print, rendered by its `Printable` conformance.
		§§ @param to — the Stream the line lands on; `#Output` when it is left out.
		static print<infer Value is Printable>(
			_ value: Value,
			to stream: Stream = #Output,
		) -> {} {
			§ The hole renders the value through its `Printable` conformance,
			§ which is the `toString` this Method promises, so writing the call
			§ out spells it twice. The newline is added here rather than in
			§ either native, so `write` writes exactly what it was given.
			<- Terminal.write("{value}\n", to stream)
		}

		§§ Writes text exactly as given, with no newline and nothing added.
		§§
		§§ This is the primitive `print` is built on. The text goes to `#Output` unless `to` names a different Stream.
		§§
		§§ In a browser, where the host has no streams, the text lands on the console as a line instead. A console has no way to continue a line.
		§§
		§§ @param _ — the text to write, unchanged.
		§§ @param to — the Stream the text lands on; `#Output` when it is left out.
		static write(_ text: String, to stream: Stream = #Output) -> {}

		§§ Prints the structure of a value for the author of the Program, and answers with that value.
		§§
		§§ Strings print quoted, Cases print as their tags, and Records and Lists are laid out. The value needs no conformance. The answer is the value itself, so a call wraps any Expression without changing what that Expression evaluates to.
		§§
		§§ @param _ — the value to inspect
		§§ @returns — the value it was given, unchanged.
		static inspect<infer Value>(_ value: Value) -> Value

		§ The rendering `inspect` writes, handed back instead of written. A
		§ message can then carry a value's structure. It is native for the
		§ reason `inspect` is: the walk that lays a value out is what the Method
		§ is. And `inspect` keeps a native of its own rather than becoming this
		§ call and a `write`. It writes its line through the console, which is
		§ where a Program under test is read from. The 1,195 lines of
		§ `StdlibExhaustive.es` output are captured off `console.log` alone.

		§§ Answers the structure of a value as a String, for the author of the Program.
		§§
		§§ This is the rendering `inspect` writes. Strings are quoted, Cases print as their tags, and Records and Lists are laid out. The value needs no conformance.
		§§
		§§ @param _ — the value to describe
		§§ @returns — the structural rendering.
		static describe<infer Value>(_ value: Value) -> String
	}
}

export {
	Stream
	Terminal
}
