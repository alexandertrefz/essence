§ Asynchronous work at the boundary. A Future is a description of work and a
§ Started is one run of it, and both cross as a `Promise` — at a call's ANSWER,
§ which is the one position that says when the work should run. The rest of this
§ Module is the positions that do not say so, each of them refused: work inside a
§ value, work at a Parameter, and work a constant holds.

implementation {

	§ Work a Record carries, which is the position a Descriptor is walked to
	§ rather than met at.
	type Job = { work: Future<Integer> }

	§ A completing body. Calling it BUILDS a future and runs none of it, so the
	§ boundary is what starts it — one run per call, which is what a Future
	§ means.
	function doubled(_ value: Integer) -> Future<Integer> {
		<- complete Async.deferred(() { <- value::multiply(with 2) })
	}

	§ Work that waits, so that a run can be stopped while it is still going on.
	§ A stopped wait never answers: the timer is cleared and the promise it was
	§ going to settle is left alone.
	function greeted(
		_ name: String,
		after milliseconds: Integer,
	) -> Future<String> {
		<- complete Async.sleep(milliseconds milliseconds)::map((waited) {
			<- name
		})
	}

	§ One RUN rather than a description: `start` puts the future above in flight
	§ and answers the run of it, which crosses as the promise that run holds.
	§ Nothing here starts it again, however often it is waited for.
	function running(_ value: Integer) -> Started<Integer> {
		<- start doubled(value)
	}

	§ Work the HOST does. A callback declared to answer a Future is called at
	§ every start rather than once — that is what makes it a description — so a
	§ callback that is never started is never called at all.
	function loaded(
		_ key: String,
		using load: (_: String) -> Future<String>,
	) -> Future<String> {
		<- complete load(key)
	}

	§ The same callback, built into work and never started — so the host is
	§ never called. Building a future runs nothing at all, which is the whole of
	§ what makes one a description.
	function shelved(
		_ key: String,
		using load: (_: String) -> Future<String>,
	) -> Integer {
		constant unread = load(key)

		<- 1
	}

	§ And the same callback run again while it fails, which is the whole of what
	§ a description buys over an answer: a Promise holds one answer however often
	§ it is awaited, where work can be run again.
	function attempted(
		_ key: String,
		using load: (_: String) -> Future<Result<String, String>>,
	) -> Future<Result<String, String>> {
		<- complete load(key)::attempt(times 2)
	}

	§ A Function that completes nothing and answers a future it was handed —
	§ so its answer crosses and its Parameter does not, which is one Function
	§ standing on both sides of the rule.
	function ran(_ work: Future<Integer>) -> Future<Integer> {
		<- work
	}

	§ A List of work, refused for the same reason one level along — and beside
	§ it the answer that is not refused: every run started at once, and one
	§ future of all their values.
	function together(_ jobs: List<Future<Integer>>) -> Future<List<Integer>> {
		<- jobs::all()
	}

	§ Work inside a Record, which is refused in both directions.
	function queued(_ job: Job) -> Job {
		<- job
	}

	§ Work that answers with work. The outer future crosses as a promise, and
	§ what it answers with is a value — so the inner one is refused where it
	§ arrives rather than where it was declared.
	function nested(_ value: Integer) -> Future<Future<Integer>> {
		<- Async.deferred(() { <- doubled(value) })
	}

	§ A Dictionary a future answers with, which is a Dictionary on this boundary
	§ exactly as one a Function answers with is: the door question is asked of
	§ what work ANSWERS as well as of what a call does.
	function counted(
		_ entries: Dictionary<String, Integer>,
	) -> Future<Dictionary<String, Integer>> {
		<- complete Async.deferred(() { <- entries })
	}

	§ Work a constant holds. There is no call here to have asked for it, so
	§ reading the name is refused rather than answered with a run nobody asked
	§ to start.
	constant work = Async.deferred(() { <- 7 })
}

export {
	Job
	attempted
	counted
	doubled
	greeted
	loaded
	nested
	queued
	ran
	running
	shelved
	together
	work
}
