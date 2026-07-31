§ Doubling the Comment sigil turns a private note into Documentation of

§ whatever is declared below it. A `§§` block is Markdown, and an Editor shows

§ it on Hover, in Signature Help and next to a Completion.

implementation {

	§§ Anything this program knows how to greet.
	type Greetable = String | Integer

	§§ The subject greeted when none is given.
	constant defaultSubject = "World"

	§§ Builds a greeting for a subject.
	§§
	§§ Supports **Markdown** — the text reaches the Editor unchanged.
	§§
	§§ A tag carrying its text on its own line separates the two with an
	§§ em-dash, which is where the description begins and how an Editor renders
	§§ the tag back.
	§§
	§§ @param subject — who to greet
	§§ @returns — the finished greeting
	function greet(subject: String) -> String {
		<- "Hello, {subject}!"
	}

	§§ Leaves the description of each tag to the lines below it, which is the
	§§ other way to write one — a tag head alone needs no separator, and the
	§§ lines under it run on until the next tag starts.
	§§
	§§ @param first
	§§ the greeting to say first
	§§ @param second
	§§ the greeting to say after it
	§§ @returns
	§§ both greetings, one after the other
	function greetTwice(first: String, second: String) -> String {
		<- "{first} {second}"
	}

	§ An ordinary Comment stays a private note. Nothing below it is
	§ documented, and no Editor ever shows this text.
	function shout(_ message: String) -> String {
		<- "{message}!!!"
	}

	§§ A Parameter written on a line of its own carries a block of its own,
	§§ which reads better than an `@param` tag once there are several.
	function join(
		§§ the text to put first
		left: String,
		§§ the text to put after it
		right: String,
	) -> String {
		<- left::append(right)
	}

	§§ Turns Integers into something a person can read.
	namespace Readable for Integer {
		§§ Spells this Integer out as text.
		§§
		§§ @returns — the Integer written as a String
		text() -> String {
			<- @::toString()
		}

		§§ Combines this Integer with another.
		§§
		§§ Each Overload documents itself; this text covers the ones that do
		§§ not bother to.
		overload combine {
			§§ Adds one other Integer.
			(_ other: Integer) -> Integer {
				<- @::add(other)
			}

			§ This Overload says nothing of its own, so the block above
			§ `overload` is what an Editor shows for it.
			(_ other: Integer, _ third: Integer) -> Integer {
				<- @::add(other)::add(third)
			}
		}
	}

	§§ Greetings that belong to no particular value.
	namespace Greetings {
		§§ The greeting used when nothing else fits.
		static fallback = "Hello, stranger!"

		§§ Greets a whole room at once.
		§§
		§§ @param count — how many people are present
		static forCrowd(count: Integer) -> String {
			<- "Hello, all {count::text()} of you!"
		}
	}

	Terminal.inspect(greet(subject defaultSubject))
	Terminal.inspect(greetTwice(first "Hello!", second "Hello again!"))
	Terminal.inspect(shout("Look"))
	Terminal.inspect(join(left "Hello, ", right "Essence!"))
	Terminal.inspect(1::combine(2)::text())
	Terminal.inspect(1::combine(2, 3)::text())
	Terminal.inspect(Greetings.fallback)
	Terminal.inspect(Greetings.forCrowd(count 3))
}
