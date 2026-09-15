import {
	from "./Boolean.es" { Boolean }
	from "./Dictionary.es" { Dictionary }
	from "./Future.es" { Future }
	from "./Integer.es" { Integer }
	from "./Optional.es" { Optional }
	from "./Orderable.es" { Orderable }
	from "./Protocols.es" {
		Equatable
		Printable
	}
	from "./Result.es" { Result }
	from "./String.es" { String }
}

declarations {

	§ The one Namespace of this library that reaches outside the Program. It
	§ answers a Future, so a request is a description until something starts
	§ it, and the waiting is written with `complete` like any other wait.
	§
	§ One native, `send`. The six verbs are written in Essence on it. Each
	§ builds a Request and hands it over, and none knows anything the record
	§ does not say. So the surface a Program reads is Essence, and what
	§ crosses to the host is one Function taking one value.
	§
	§ A deadline is `::within(milliseconds:)` and a second attempt is
	§ `::attempt(times:)`. Both are Methods of `Future`, and neither is
	§ repeated here. That is the whole reason a request is a Future rather
	§ than a call that blocks.

	§§ Which method of HTTP a request is made with.
	§§
	§§ `#Get` is what a request that names none is made with. The Cases are the seven methods this library sends, spelled as the Choice a `method` member takes.
	choice HttpMethod {
		Get,
		Post,
		Put,
		Patch,
		Delete,
		Head,
		Options,
	}

	§ `Equatable` and `Printable` are both derived for a Choice of Cases that
	§ carry no payload. This Namespace declares the two and writes neither; see
	§ DEVELOPMENT.md, Why bodies look the way they do.
	namespace HttpMethod for HttpMethod is Equatable, is Printable {}

	§§ What a request does with a redirect a host answers with.
	§§
	§§ Under `#Follow` the request is made again at the new address, which is what a request that names no Case does. Under `#Manual` the redirect is the answer where the host hands it over. On Node and Bun it carries the status and the `location` header that says where it points. A browser answers an opaque redirect instead, with no status and no headers. Under `#Refuse` a redirect is a `#Failure`, and its reason is `#Unreachable`.
	choice Redirects {
		Follow,
		Manual,
		Refuse,
	}

	§ Derived for the reason `HttpMethod`'s two are derived.
	namespace Redirects for Redirects is Equatable, is Printable {}

	§ A status is not a failure. A host that answers 404 answered, and what it
	§ answered is a Response a Program reads. These three Cases are the ways a
	§ request produces no Response at all. Asking about a status it did get is
	§ `Response::isSuccessful`.

	§§ Why a request answered with no Response.
	§§
	§§ The Case `#InvalidUrl` is an address this library does not send to. It covers an address that can not be read at all, and one whose scheme is neither `http` nor `https`.
	§§
	§§ The Case `#Unreachable` is a host that was not reached. It covers a refused connection, a name that does not resolve and a certificate that was not accepted. It also covers a host with no way to send a request. A redirect a request refused to follow is one. So is a request this library refused to send. A `#Get` or a `#Head` carrying a body is one, and so is a header name HTTP does not allow.
	§§
	§§ The Case `#InvalidBody` is an answer whose body could not be read. The answer had been delivered, and reading its bytes failed part way.
	§§
	§§ A status is none of these. A host that answers 404 answered, and 404 is a Response.
	choice HttpFailure {
		InvalidUrl { url: String },
		Unreachable { reason: String },
		InvalidBody { reason: String },
	}

	§ Equality is derived here, as it is for every Choice. Printing is not.
	§ A derived rendering prints the Case name alone, and every Case here
	§ carries a reason that would go missing. So `toString` is written, and it
	§ is native for the reason `Result::toString` is. An Essence body renders
	§ the payload through a hole, and a hole renders a String bare. So
	§ `#Unreachable("")` would print as a word and a pair of parentheses.
	namespace HttpFailure for HttpFailure is Equatable, is Printable {
		§§ Answers the failure as a String, written `InvalidUrl(…)`, `Unreachable(…)` or `InvalidBody(…)`.
		§§
		§§ The reason is quoted, as a String payload is quoted inside any structure. The `#` sigil is left out, as `Result` prints `Failure` and `Ordering` prints `Less`.
		§§
		§§ @returns — the rendering of the Case and its reason.
		toString() -> String
	}

	§ The request is a Record rather than a builder. Every member but the
	§ address has a default. So `Http.send({ url = "…" })` is a whole request,
	§ and a member a call cares about is written by name beside it. The
	§ defaults live on `send`'s Parameter, which is where a Record's defaults
	§ are written in this language.

	§§ A request to send.
	§§
	§§ Only `url` has to be written. The default on `Http.send` fills in a `#Get` with no headers, no body and `#Follow`.
	§§
	§§ The body is a String or nothing. A request carrying one names its own `content-type` in the headers, because this library adds none.
	type Request = {
		url: String,
		method: HttpMethod,
		headers: Dictionary<String, String>,
		body: Optional<String>,
		redirects: Redirects,
	}

	§§ What a host answered with.
	§§
	§§ The header keys are lowercase, which is what makes a Dictionary the right shape for them. HTTP header names do not differ by case, and `header(named:)` reads one under any spelling.
	§§
	§§ A name a host sent twice is one entry, with its values joined by `, `. That is what a host does to every other header name, and `set-cookie` is joined the same way here. Two cookies joined like that can not be read apart again, because a cookie's `Expires` holds a comma.
	§§
	§§ The body is text, decoded as UTF-8. Bytes that are not text are read as replacement characters, so an answer that is not text is a Response with a lossy body.
	type Response = {
		status: Integer,
		headers: Dictionary<String, String>,
		body: String,
	}

	§ Both are written in Essence. One reads the status and one reads a
	§ header, and neither needs anything the Record does not already hold.
	namespace Response for Response {
		§§ Answers whether the status is one of the successful ones.
		§§
		§§ The successful statuses are 200 through 299. A redirect, a refusal and a host error are each a Response that answers `false` here.
		§§
		§§ @example
		§§   constant answered: Response = {
		§§     status = 204,
		§§     headers = [=],
		§§     body = "",
		§§   }
		§§
		§§   expect answered::isSuccessful()
		§§
		§§ @returns — `true` when the status is between 200 and 299.
		isSuccessful() -> Boolean {
			<- @.status::isBetween(200, and 299)
		}

		§§ Answers the header of the given name, whatever case it is written in.
		§§
		§§ The keys of a Response are lowercase, so the name is lowercased before it is looked up. A header the answer does not carry answers nothing.
		§§
		§§ @example
		§§   constant answered: Response = {
		§§     status = 200,
		§§     headers = ["content-type" = "text/plain"],
		§§     body = "hi",
		§§   }
		§§
		§§   expect answered::header(named "Content-Type")::is("text/plain")
		§§   expect answered::header(named "accept")::isEmpty()
		§§
		§§ @param named — the name of the header, in any case
		§§ @returns — the header's value, or nothing where the answer carries none.
		header(named name: String) -> Optional<String> {
			<- @.headers::value(at name::lowercase())
		}
	}

	§§ Requests to a host, as work that has not run.
	namespace Http {
		§ The one native, and the one door to the host. Everything below it
		§ builds a Request and calls it.
		§
		§ The answer is a `Result` inside a `Future`, and the two levels say
		§ different things. The Future is work that has not run. The Result is
		§ whether the run reached a host at all.

		§§ Answers work that sends the given request and answers with what the host said.
		§§
		§§ Nothing is sent while the answer is being built. Each start sends the request again, so a request that is started twice is made twice.
		§§
		§§ A request that reaches a host answers `#Value` with its Response, whatever the status is. A request that reaches none answers `#Failure` with the reason.
		§§
		§§ A run that is stopped never answers. The runs that `within` and `race` leave behind are stopped, and what one would have answered is never read.
		§§
		§§ @param _ — the request to send; every member but `url` has a default
		§§ @returns — work answering the Response, or the reason there is none.
		static send(
			_ request: Request = {
				method = #Get,
				headers = [=],
				body = #Empty,
				redirects = #Follow,
			},
		) -> Future<Result<Response, HttpFailure>>

		§ The six verbs. Each is one call of `send` with the method written
		§ in, which is what makes them Essence rather than six natives. The
		§ headers are a default rather than an Overload, for the reason the
		§ Stream on `Terminal.write` is one. Both call forms stay writable and
		§ the Namespace declares one entry rather than two.
		§
		§ Six for seven Cases. There is no `options` here, because a Program
		§ asking what a host answers writes `Http.send({ url, method =
		§ #Options })` and asks for nothing else. The Case is reachable and the
		§ verb would be a name for one call.

		§§ Answers work that asks the given address for what it holds.
		§§
		§§ @param _ — the address to ask
		§§ @param headers — the headers to send; none when it is left out
		§§ @returns — work answering the Response, or the reason there is none.
		static get(
			_ url: String,
			headers: Dictionary<String, String> = [=],
		) -> Future<Result<Response, HttpFailure>> {
			<- Http.send({ url, method = #Get, headers })
		}

		§§ Answers work that sends the given body to the address.
		§§
		§§ @param _ — the address to send to
		§§ @param body — the body to send
		§§ @param headers — the headers to send; none when it is left out
		§§ @returns — work answering the Response, or the reason there is none.
		static post(
			_ url: String,
			body: String,
			headers: Dictionary<String, String> = [=],
		) -> Future<Result<Response, HttpFailure>> {
			<- Http.send({
				url,
				method = #Post,
				headers,
				body = Optional<String>#Value(body),
			})
		}

		§§ Answers work that puts the given body at the address.
		§§
		§§ @param _ — the address to put to
		§§ @param body — the body to send
		§§ @param headers — the headers to send; none when it is left out
		§§ @returns — work answering the Response, or the reason there is none.
		static put(
			_ url: String,
			body: String,
			headers: Dictionary<String, String> = [=],
		) -> Future<Result<Response, HttpFailure>> {
			<- Http.send({
				url,
				method = #Put,
				headers,
				body = Optional<String>#Value(body),
			})
		}

		§§ Answers work that sends the given body as a change to what the address holds.
		§§
		§§ @param _ — the address to change
		§§ @param body — the body to send
		§§ @param headers — the headers to send; none when it is left out
		§§ @returns — work answering the Response, or the reason there is none.
		static patch(
			_ url: String,
			body: String,
			headers: Dictionary<String, String> = [=],
		) -> Future<Result<Response, HttpFailure>> {
			<- Http.send({
				url,
				method = #Patch,
				headers,
				body = Optional<String>#Value(body),
			})
		}

		§§ Answers work that asks the address to remove what it holds.
		§§
		§§ @param _ — the address to ask
		§§ @param headers — the headers to send; none when it is left out
		§§ @returns — work answering the Response, or the reason there is none.
		static delete(
			_ url: String,
			headers: Dictionary<String, String> = [=],
		) -> Future<Result<Response, HttpFailure>> {
			<- Http.send({ url, method = #Delete, headers })
		}

		§§ Answers work that asks the address for the headers alone.
		§§
		§§ The answer carries the headers a `get` would answer with, and an empty body.
		§§
		§§ @param _ — the address to ask
		§§ @param headers — the headers to send; none when it is left out
		§§ @returns — work answering the Response, or the reason there is none.
		static head(
			_ url: String,
			headers: Dictionary<String, String> = [=],
		) -> Future<Result<Response, HttpFailure>> {
			<- Http.send({ url, method = #Head, headers })
		}
	}
}

export {
	Http
	HttpFailure
	HttpMethod
	Redirects
	Request
	Response
}
