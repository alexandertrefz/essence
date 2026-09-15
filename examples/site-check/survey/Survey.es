import {
	from "./Page.es" { titleOf }
}

implementation {

	§ The survey itself. `Http.get` answers a Future, so asking one address is
	§ a description of work rather than a wait, and asking twenty is a List of
	§ descriptions. `all(atMost:)` is what turns that List into one description
	§ that keeps a few of them in flight at a time.
	§
	§ Nothing below reaches a host except the one closure in `surveyed`. Every
	§ other Function takes the asking as a Parameter, which is what lets the
	§ `tests { … }` section drive the whole survey off `Async.deferred`.

	§§ What asking one address answered with.
	§§
	§§ A status is not a failure: a host that answers 404 answered, and 404 is an `#Answered`. The other two Cases are the ways a request produces no answer at all.
	choice Outcome {
		Answered { status: Integer, title: Optional<String> },
		Unreachable { reason: String },
		TooSlow,
	}

	§§ One address and what asking it answered with.
	type Report = { url: String, outcome: Outcome }

	§§ Every address that was asked, and how many of them answered well.
	type Survey = { reports: List<Report>, successful: Integer }

	§ Pure, and the whole of the reading: an Optional for the deadline around a
	§ Result for the request, flattened into the three Cases a reader cares
	§ about.
	function reportFor(
		_ url: String,
		from answer: Optional<Result<Response, HttpFailure>>,
	) -> Report {
		<- match answer -> Report {
			case #Value(result) {
				<- match result -> Report {
					case #Value(response) {
						<- {
							url,
							outcome = #Answered({
								status = response.status,
								title = titleOf(response.body),
							}),
						}
					}
					case #Failure(reason) {
						<- { url, outcome = #Unreachable(reason::toString()) }
					}
				}
			}
			case #Empty { <- { url, outcome = #TooSlow } }
		}
	}

	§ An ordinary body: it completes nothing and answers a Future it assembled.
	§ `within` starts the request itself, so a run it gives up on is stopped.
	function checked(
		_ url: String,
		asking ask: (_: String) -> Future<Result<Response, HttpFailure>>,
		within limit: Integer,
	) -> Future<Report> {
		<- ask(url)
			::within(milliseconds limit)
			::map((answer) { <- reportFor(url, from answer) })
	}

	function successes(_ reports: List<Report>) -> Integer {
		<- reports
			::everyItem(where (report) {
				<- match report.outcome -> Boolean {
					case #Answered({ status }) {
						<- status::isBetween(200, and 299)
					}
					case #Unreachable { <- false }
					case #TooSlow     { <- false }
				}
			})
			::length()
	}

	§ A completing body: it waits, so it answers a Future of what comes after
	§ the wait. The summing below the `complete` reads the List of Reports the
	§ way any other Function would.
	function collected(
		_ urls: List<String>,
		asking ask: (_: String) -> Future<Result<Response, HttpFailure>>,
		atMost bound: Integer,
		within limit: Integer,
	) -> Future<Survey> {
		§ A List of descriptions, and then one description of all of them.
		constant work    = urls::map((url) {
			<- checked(url, asking ask, within limit)
		})
		constant reports = complete work::all(atMost bound)

		<- { reports, successful = successes(reports) }
	}

	§§ Answers work that asks every address for its page, a few at a time.
	§§
	§§ Nothing is asked while the answer is being built. Each start asks every address again.
	§§
	§§ The requests run concurrently up to the given bound, and each one is given five seconds. The answer holds one Report per address, in the order they were given.
	§§
	§§ @param _ — the addresses to ask
	§§ @param atMost — how many requests to have in flight at once
	§§ @returns — work answering the Survey.
	function surveyed(
		_ urls: List<String>,
		atMost bound: Integer,
	) -> Future<Survey> {
		<- collected(
			urls,
			asking (url) { <- Http.get(url) },
			atMost bound,
			within 5_000,
		)
	}
}

export {
	Outcome
	Report
	Survey
	surveyed
}

tests {

	§ Four doubles, each the shape `collected` asks for: an address in, work
	§ out. `Async.deferred` is what makes them work rather than values, so the
	§ survey runs exactly as it does against a host — started once per address,
	§ a few at a time — without a host anywhere.

	function answering(_ url: String) -> Future<Result<Response, HttpFailure>> {
		<- Async.deferred(() {
			<- Result<Response, HttpFailure>#Value({
				status = 200,
				headers = ["content-type" = "text/html"],
				body = "<html><title>Page at {url}</title></html>",
			})
		})
	}

	function missing(_ url: String) -> Future<Result<Response, HttpFailure>> {
		<- Async.deferred(() {
			<- Result<Response, HttpFailure>#Value({
				status = 404,
				headers = [=],
				body = "nothing here",
			})
		})
	}

	function refusing(_ url: String) -> Future<Result<Response, HttpFailure>> {
		<- Async.deferred(() {
			<- Result<Response, HttpFailure>#Failure(
				#Unreachable("connection refused")
			)
		})
	}

	§ A completing body: it waits, so it hands back the Future the wait is
	§ inside. Fifty milliseconds against a one-millisecond deadline.
	function dawdling(_ url: String) -> Future<Result<Response, HttpFailure>> {
		complete Async.sleep(milliseconds 50)

		<- Result<Response, HttpFailure>#Value({
			status = 200,
			headers = [=],
			body = "<title>late</title>",
		})
	}

	test "reports the status and the title a host answered with" {
		constant survey = complete collected(
			["https://example.test/beans"],
			asking answering,
			atMost 2,
			within 1_000,
		)

		require #Value(report) = survey.reports::firstItem()
		require #Answered({ status, title }) = report.outcome

		expect status::is(200)
		expect title::is("Page at https://example.test/beans")
		expect survey.successful::is(1)
	}

	test "reports a 404 as an answer rather than a failure" {
		constant survey = complete collected(
			["https://example.test/gone"],
			asking missing,
			atMost 2,
			within 1_000,
		)

		require #Value(report) = survey.reports::firstItem()
		require #Answered({ status, title }) = report.outcome

		expect status::is(404)
		expect title::isEmpty()
		expect survey.successful::isZero()
	}

	test "reports a host it never reached" {
		constant survey = complete collected(
			["https://example.test/nowhere"],
			asking refusing,
			atMost 2,
			within 1_000,
		)

		require #Value(report) = survey.reports::firstItem()
		require #Unreachable(reason) = report.outcome

		expect reason::contains("connection refused")
		expect survey.successful::isZero()
	}

	test "gives up on a host that takes longer than the deadline" {
		constant survey = complete collected(
			["https://example.test/slow"],
			asking dawdling,
			atMost 2,
			within 1,
		)

		require #Value(report) = survey.reports::firstItem()
		require #TooSlow = report.outcome

		expect survey.successful::isZero()
	}

	test "answers in the order the addresses were given, whatever the bound" {
		constant urls   = [
			"https://example.test/a",
			"https://example.test/b",
			"https://example.test/c",
			"https://example.test/d",
		]
		constant survey = complete collected(
			urls,
			asking answering,
			atMost 2,
			within 1_000,
		)

		expect survey.reports::map(.url)::is(urls)
		expect survey.successful::is(4)
	}

	test "builds the work without asking anything" {
		constant work  = collected(
			["https://example.test/a"],
			asking refusing,
			atMost 1,
			within 1_000,
		)
		constant once  = complete work
		constant twice = complete work

		expect once::is(twice)
	}
}
