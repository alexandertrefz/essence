import {
	from "./Optional.es" { Optional }
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

	§ Two directions, and three audiences. The `print` Method is for the
	§ Program's reader. The `inspect` and `describe` Methods are for its author.
	§ The `write` Method is the primitive the writing side is built on, and
	§ `readLine` is the reading side's. The `readAll` Method takes what is left
	§ of the input at once, and `ask` is a `write` and a `readLine`. The natives
	§ are `write`, `inspect`, `describe`, `readLine` and `readAll`; `print` and
	§ `ask` are written in Essence on them. The Stream is a default on `print`
	§ and `write`, rather than an entry of its own. A native carries a default
	§ exactly as a bodied Method does. The `inspect` Method takes no Stream:
	§ what it writes is for whoever started the Program.
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

		§ An Optional, because the end of the input is not a failure. It is not
		§ an empty line either. A `String` answer would spell the end of the
		§ input as the empty String, which is what an empty line already is. A
		§ Program reading until the input stops would then never stop.

		§§ Answers the next line of the Program's input, or nothing at the end of it.
		§§
		§§ The line break is not part of the line. A line ends at `\n`, at `\r`, or at the `\r\n` a Windows host writes. The last line of an input that ends without a break is a line. A host with no input answers nothing, as `write` falls back to the console on a host with no stream.
		§§
		§§ @returns — the next line, or nothing at the end of the input.
		static readLine() -> Optional<String>

		§§ Answers everything left in the Program's input, as one String.
		§§
		§§ The text is unchanged, so a break at the end of the input is part of the answer. A text that ends with a break has an empty last line when `lines()` splits it, which is what a trailing break means there. A host with no input answers the empty String.
		§§
		§§ @returns — the rest of the input, unchanged.
		static readAll() -> String

		§§ Writes a prompt with no newline, then answers the next line of the input.
		§§
		§§ The prompt goes to `#Output`. The answer is `readLine`'s, so it is nothing at the end of the input.
		§§
		§§ @param _ — the prompt to write before reading
		§§ @returns — the line that follows the prompt, or nothing at the end of the input.
		static ask(_ prompt: String) -> Optional<String> {
			§ The prompt carries no newline of its own, so that the answer is
			§ written on the line the question is on.
			Terminal.write(prompt)

			<- Terminal.readLine()
		}
	}
}

export {
	Stream
	Terminal
}
