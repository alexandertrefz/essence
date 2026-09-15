implementation {

	§ What the combinators DO, written as a Program whose output says it. The
	§ waits are milliseconds apart rather than instant, because the difference
	§ between running work at once and running it in order is only visible in
	§ what finishes first. A timer fires in the order its delay says, so every
	§ line below is the same on every run.

	function announcing(
		_ name: String,
		after delay: Integer,
	) -> Future<String> {
		constant waited = complete Async.sleep(milliseconds delay)

		Terminal.print("{name} finished")

		<- name
	}

	§ `all` starts every one of them at once, so the shorter wait finishes
	§ first — and the ANSWER is in the receiver's order all the same.
	constant atOnce = [
		announcing("slow", after 20),
		announcing("quick", after 5),
	]::all()

	Terminal.print(complete atOnce) § quick finished, slow finished, [slow, quick]

	§ `inSequence` starts each only once the one before it has answered, so the
	§ order they finish in is the order they were written in.
	constant oneByOne = [
		announcing("first", after 20),
		announcing("second", after 5),
	]::inSequence()

	Terminal.print(complete oneByOne) § first finished, second finished, [first, second]

	§ `all(atMost 1)` is the same walk with a ceiling of one, which is what
	§ makes it the sequential reading of the same Method.
	constant oneAtATime = [
		announcing("left", after 20),
		announcing("right", after 5),
	]::all(atMost 1)

	Terminal.print(complete oneAtATime) § left finished, right finished, [left, right]

	§ `race` answers the first value and STOPS every other run. The stopped one
	§ never announces itself: its wait is cleared and what it would have
	§ answered is never read.
	constant raced = [
		announcing("outrun", after 40),
		announcing("winner", after 5),
	]::race()

	Terminal.print(complete raced) § winner finished, then winner

	§ `within` is the same stopping, on a deadline rather than on a rival.
	Terminal.print(
		complete announcing("late", after 40)::within(milliseconds 5),
	) § Empty
	Terminal.print(
		complete announcing("intime", after 5)::within(milliseconds 40),
	) § intime finished, then Value(intime)

	§ Long enough for both of the stopped runs above to have announced
	§ themselves, had anything gone on running them.
	constant settled = complete Async.sleep(milliseconds 60)

	Terminal.print("nothing else ran") § nothing else ran

	§ `attempt` runs the work again while it fails, and the count is the number
	§ of attempts in all rather than the number of retries after the first.
	constant failing = Async.deferred(() -> Result<Integer, String> {
		Terminal.print("attempted")

		<- #Failure("refused")
	})
	constant working = Async.deferred(() -> Result<Integer, String> {
		Terminal.print("attempted")

		<- #Value(1)
	})

	Terminal.print(complete failing::attempt(times 3)) § attempted three times, then Failure("refused")
	Terminal.print(complete working::attempt(times 3)) § attempted once, then Value(1)

	§ And `firstValue` is the race a fallible answer asks for: the first run
	§ that WORKED rather than the first that finished.
	constant answered = [
		announcing("refused", after 5)
			::map((_ name: String) -> Result<String, String> {
				<- #Failure(name)
			}),
		announcing("accepted", after 20)
			::map((_ name: String) -> Result<String, String> {
				<- #Value(name)
			}),
	]::firstValue()

	Terminal.print(complete answered) § refused finished, accepted finished, Value(accepted)
}
