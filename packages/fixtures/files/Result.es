implementation {

	§ The standard library's `Result` in the shape a Program reaches for it.
	§ An Optional says that there is nothing; a Result says why, and the why
	§ is a Type of the Program's own choosing. That is what the second Type
	§ Parameter is for: here it is a Choice of the two things a row can be
	§ wrong about.
	choice Problem {
		NotANumber,
		NotPositive,
	}

	namespace Problem for Problem is Equatable, is Printable {}

	§ The two reasons are bound to Constants of the Choice Type, because a
	§ bare `#NotANumber` written as an Argument is read as that Case alone —
	§ the Type Parameter it binds is `Problem#NotANumber`, and the next call
	§ in the chain then has a Result of a different Type to work on. The
	§ annotation on the Constant is what says `Problem`.
	constant notANumber: Problem  = #NotANumber
	constant notPositive: Problem = #NotPositive

	§ Crossing from the Optional `Integer.parse` answers into a Result is one
	§ call, and the check that follows it is another. Both failures are the
	§ Program's own Cases.
	function priceOf(_ row: String) -> Result<Integer, Problem> {
		<- Integer.parse(row)
			::toResult(failingWith notANumber)
			::keep(
				where (price) { <- price::isPositive() },
				failingWith notPositive,
			)
	}

	constant rows   = ["12", "7", "0", "many"]
	constant priced = rows::map((row) { <- priceOf(row) })
	constant sound  = ["12", "7"]::map((row) { <- priceOf(row) })

	Terminal.inspect(priced::values()) § [ 12, 7 ]
	Terminal.inspect(priced::failures()) § [ Problem#NotPositive, Problem#NotANumber ]
	Terminal.inspect(priced::partition())

	§ Every reason is kept rather than the first one, which is what a Program
	§ checking a whole file of rows wants to report.
	Terminal.inspect(priced::allValues()) § Result#Failure([ … ])
	Terminal.inspect(sound::allValues()) § Result#Value([ 12, 7 ])

	§ One Result at a time is the Optional vocabulary with a reason attached.
	constant one     = priceOf("7")
	constant refused = priceOf("many")

	Terminal.inspect(one::map((price) { <- price::multiply(with 100) })) § Result#Value(700)
	Terminal.inspect(one::value()) § Optional#Value(7)
	Terminal.inspect(refused::reason()) § Optional#Value(Problem#NotANumber)
	Terminal.inspect(refused::value(defaultingTo 0)) § 0
	Terminal.inspect(refused::or(one)) § Result#Value(7)
	Terminal.inspect(refused::recover(with (problem) { <- 0 })) § 0
	Terminal.inspect(refused::mapFailure((problem) { <- problem::toString() })) § Result#Failure("NotANumber")
	Terminal.inspect(
		one::andThen((price) -> Result<Integer, Problem> {
			<- #Value(price::add(1))
		}),
	) § Result#Value(8)
}
