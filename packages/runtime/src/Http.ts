import { createBoolean } from "./Boolean"
import { createDictionary, type DictionaryType } from "./Dictionary"
import { type Context, type FutureType, of } from "./Future"
import type { HttpFailureType } from "./HttpFailure"
import { invalidBody, invalidUrl, unreachable } from "./HttpFailure"
import type { HttpMethodType } from "./HttpMethod"
import { createInteger, type IntegerType } from "./Integer"
import { stringEquals } from "./internalHelpers"
import type { EquatableWitness } from "./keyEncoding"
import type { OptionalType } from "./Optional"
import type { RecordType } from "./Record"
import type { RedirectsType } from "./Redirects"
import { createFailure, createValue, type ResultType } from "./Result"
import { createString, type StringType } from "./String"
import { liveEntriesOf, typeKeySymbol } from "./type"

// NOTE: THE ONE RUNTIME MODULE THAT REACHES OUTSIDE THE PROGRAM. Everything
// else in this runtime answers out of values the Program already holds; a
// request goes to a host, and what comes back is not a function of the inputs.
// Two things rest on this module being exactly one file with exactly this name:
// the Optimiser refuses `Http` a place in its purity table, and the test result
// cache refuses to remember a run whose bundle links `Http.ts` — see
// `EFFECTFUL_RUNTIME_LABELS` in `packages/cli/src/resultCache.ts`, which names
// the label esbuild writes for this file.
//
// NOTE: A REQUEST IS A DESCRIPTION. `send` builds a Future and sends nothing:
// the `fetch` below runs when the Future is started, once per start, under the
// context that start made. That is what puts `::within(milliseconds:)` and
// `::attempt(times:)` within reach without a line here — both are Methods of
// `Future`, and a request is a Future like any other.

// NOTE: The Request the Compiler hands over, spelled the way the generated
// native contract renders `Http.es`'s Record. The defaults are filled in before
// this is reached, so every member is here.
type RequestType = RecordType & {
	url: StringType
	method: HttpMethodType
	headers: DictionaryType<StringType, StringType>
	body: OptionalType<StringType>
	redirects: RedirectsType
}

type ResponseType = RecordType & {
	status: IntegerType
	headers: DictionaryType<StringType, StringType>
	body: StringType
}

// NOTE: The witness the answer's header Dictionary is built with. Its keys are
// Strings, and `stringEquals` is what `String::is` decides — the NFC forms
// compared, which for a header name is its own text. It is branded `structural`
// for that reason: the claim the brand makes is that the canonical key encoding
// agrees with the standard library's own `is` for this kind, which for a String
// is the claim `keyEncoding.ts` is written on.
const headerKeys: EquatableWitness<StringType> = {
	is: (first, second) => createBoolean(stringEquals(first, second)),
	isNot: (first, second) => createBoolean(!stringEquals(first, second)),
	structural: true,
}

// NOTE: The verbs, keyed by the Case tag a `HttpMethod` carries. A table rather
// than a chain of comparisons, and rather than slicing the tag apart and
// uppercasing it: what goes on the wire is decided here, where a reader can see
// all seven at once.
//
// NOTE: Keyed by the TAG TYPE rather than by `string`, so a Case added to the
// Choice and forgotten here is a `tsc` error rather than a request quietly sent
// as a GET. The same rule keys the redirect modes below.
const METHOD_NAMES: Record<HttpMethodType[typeof typeKeySymbol], string> = {
	"HttpMethod#Get": "GET",
	"HttpMethod#Post": "POST",
	"HttpMethod#Put": "PUT",
	"HttpMethod#Patch": "PATCH",
	"HttpMethod#Delete": "DELETE",
	"HttpMethod#Head": "HEAD",
	"HttpMethod#Options": "OPTIONS",
}

// NOTE: And the three redirect modes, under the names `fetch` knows them by.
// `#Refuse` is sent as `"manual"` and refused HERE rather than as `"error"`,
// which would have `fetch` reject: the rejection carries the host library's own
// sentence, naming `fetch()` and its options in a value an Essence Program
// prints, and there is no way to tell it apart from a connection that was
// refused. Sent manually, the redirect comes back as an answer this module can
// recognise, and the reason a Program reads is this library's own. Nothing is
// followed either way, which is the whole of what `#Refuse` promises.
const REDIRECT_MODES: Record<
	RedirectsType[typeof typeKeySymbol],
	"follow" | "manual"
> = {
	"Redirects#Follow": "follow",
	"Redirects#Manual": "manual",
	"Redirects#Refuse": "manual",
}

// NOTE: The statuses that carry a `location` and mean "ask there instead". 304
// is not among them: a 3xx that is not a redirect is an answer, and `#Refuse`
// refuses redirects rather than a range of numbers. `opaqueredirect` is what a
// browser answers under `"manual"` instead of the redirect itself — no status
// and no headers — so the Type is read as well as the number.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

function isRedirect(answered: Response): boolean {
	return (
		answered.type === "opaqueredirect" ||
		REDIRECT_STATUSES.has(answered.status)
	)
}

// NOTE: The methods that carry no body. A host library refuses one that does,
// in its own words — "fetch() request with GET/HEAD method cannot have body." —
// which names a Function no Essence Program can reach. Refused here instead, in
// this library's words, before anything is sent.
const BODILESS_METHODS = new Set(["GET", "HEAD"])

// NOTE: A header name is an HTTP token: these characters and no others. A host
// library refuses anything else in its own words too, so the same reading
// applies — what a Program gets back is a sentence about the header it wrote.
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

// NOTE: The schemes this library sends. An address of any other scheme is
// `#InvalidUrl` rather than a request that fails somewhere further down: `fetch`
// on some hosts reads a `file:` URL, and a Program asking `Http.get` for one is
// asking this library for something it does not do.
const SCHEMES = new Set(["http:", "https:"])

// NOTE: Probed PER CALL, for the reason `Terminal.ts` probes its streams per
// write: a read at the top of this module is a side effect esbuild has to keep,
// and a bundle would carry it whether or not the Program sends anything. And a
// bare `fetch` on a host without one is a ReferenceError rather than
// `undefined`, which is why the `typeof` comes first.
function hostFetch(): typeof fetch | null {
	return typeof fetch === "function" ? fetch : null
}

// NOTE: What a thrown value says, as a reason a reader can act on. The `cause`
// is read because that is where the host libraries put the sentence worth
// having: a refused connection arrives as "fetch failed" with the refusal
// underneath it.
function reasonOf(thrown: unknown): string {
	if (!(thrown instanceof Error)) {
		return String(thrown)
	}

	let cause = thrown.cause

	return cause instanceof Error && cause.message !== ""
		? `${thrown.message}: ${cause.message}`
		: thrown.message
}

// NOTE: A run that was stopped never answers. The timer `Async.sleep` clears is
// this promise: what cancellation is throughout this runtime is that the work is
// signalled and its answer is dropped, never observed. Answering a `#Failure`
// here instead would put a reason in front of a Program that a `match` would
// then read and print, which is a cancelled request being visible — and the one
// thing `::within` and `::race` promise is that it is not.
function neverAnswers<Value>(): Promise<Value> {
	return new Promise<Value>(() => {})
}

// NOTE: `Http.send(_ request)` — the one native of the Namespace, and the door
// every verb in `Http.es` is written on.
export function send(
	request: RequestType,
): FutureType<ResultType<ResponseType, HttpFailureType>> {
	return of(async (context: Context) => {
		if (context.signal.aborted) {
			return neverAnswers<ResultType<ResponseType, HttpFailureType>>()
		}

		let fetching = hostFetch()
		let address = request.url.value

		if (fetching === null) {
			return createFailure(
				unreachable("this host has no way to send a request"),
			)
		}

		let target: URL

		try {
			target = new URL(address)
		} catch {
			return createFailure(invalidUrl(address))
		}

		if (!SCHEMES.has(target.protocol)) {
			return createFailure(invalidUrl(address))
		}

		// NOTE: What this library can decide for itself, decided before a socket
		// exists. `#Unreachable` is the Case for all three — a host that was not
		// reached covers one that was never asked — and the reason is this
		// library's own sentence rather than the host library's.
		let method = METHOD_NAMES[request.method[typeKeySymbol]]
		let written = headersOf(request.headers)

		if (
			BODILESS_METHODS.has(method) &&
			request.body[typeKeySymbol] === "Optional#Value"
		) {
			return createFailure(
				unreachable(
					`a ${method} request carries no body, so this one was not sent`,
				),
			)
		}

		for (let [name] of written) {
			if (!HEADER_NAME.test(name)) {
				return createFailure(
					unreachable(
						`'${name}' is not a header name, so this request was not sent`,
					),
				)
			}
		}

		let answered: Response

		try {
			answered = await fetching(target, {
				method,
				headers: written,
				body:
					request.body[typeKeySymbol] === "Optional#Value"
						? request.body.item.value
						: undefined,
				redirect: REDIRECT_MODES[request.redirects[typeKeySymbol]],
				signal: context.signal,
			})
		} catch (thrown) {
			return context.signal.aborted
				? neverAnswers<ResultType<ResponseType, HttpFailureType>>()
				: createFailure(unreachable(reasonOf(thrown)))
		}

		if (
			request.redirects[typeKeySymbol] === "Redirects#Refuse" &&
			isRedirect(answered)
		) {
			return createFailure(
				unreachable(
					"the host answered a redirect, and this request refused to follow one",
				),
			)
		}

		let text: string

		try {
			text = await answered.text()
		} catch (thrown) {
			return context.signal.aborted
				? neverAnswers<ResultType<ResponseType, HttpFailureType>>()
				: createFailure(invalidBody(reasonOf(thrown)))
		}

		return createValue({
			[typeKeySymbol]: "Record",
			status: createInteger(answered.status),
			headers: answeredHeaders(answered),
			body: createString(text),
		} as ResponseType)
	})
}

// NOTE: The request's headers as the host wants them, read off the Dictionary in
// the order they were set. A pair Array rather than an object, so that a name a
// Program wrote twice in two spellings is not silently one key here: the
// Dictionary already decided what one key is, and `Headers` decides the rest.
function headersOf(
	headers: DictionaryType<StringType, StringType>,
): Array<[string, string]> {
	return liveEntriesOf(headers).map(([name, value]) => [
		(name as StringType).value,
		(value as StringType).value,
	])
}

// NOTE: The answer's headers, LOWERCASED into a Dictionary. HTTP header names
// do not differ by case, and a Dictionary's keys do — so one spelling has to be
// the spelling, and lowercase is the one every host already answers with.
// `Response::header(named:)` lowercases what it is asked for and reads the key
// back, which is what makes the lookup case-insensitive without a second
// vocabulary.
//
// NOTE: `Headers` folds a name sent twice into ONE entry, joined with ", " —
// for every name but `set-cookie`, which the Fetch standard exempts, so an
// answer carrying two cookies iterates as two `set-cookie` pairs. A Dictionary
// has one value per key, so the second would overwrite the first and the first
// would be gone with nothing said anywhere. Folded here the way the host folds
// every other name instead: what a Program reads is what it would have read had
// the host done the folding.
//
// NOTE: A joined `set-cookie` is not splittable back — a cookie's `Expires`
// holds a comma of its own — so what this keeps is the fact that a second
// cookie was sent, not a way to read the two apart. A reader of its own over
// `getSetCookie()` is what that would take, and it is not what this answers.
function answeredHeaders(
	answered: Response,
): DictionaryType<StringType, StringType> {
	let entries: Array<[StringType, StringType]> = []
	let seen = new Map<string, number>()

	answered.headers.forEach((value, name) => {
		let key = name.toLowerCase()
		let at = seen.get(key)

		if (at === undefined) {
			seen.set(key, entries.length)
			entries.push([createString(key), createString(value)])

			return
		}

		entries[at]![1] = createString(`${entries[at]![1].value}, ${value}`)
	})

	return createDictionary(entries, headerKeys)
}
