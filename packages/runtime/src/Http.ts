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

// The one runtime module that reaches another machine. The test result cache
// finds it by its file name. See "HTTP requests" in DEVELOPMENT.md.
//
// The Request as the native contract renders it, with every default filled in.
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

// The answer's header keys compare as `String::is` does, so the key encoding
// agrees with them and the witness carries the `structural` brand.
const headerKeys: EquatableWitness<StringType> = {
	is: (first, second) => createBoolean(stringEquals(first, second)),
	isNot: (first, second) => createBoolean(!stringEquals(first, second)),
	structural: true,
}

// Keyed by the tag Type, so a Case added to the Choice and missed here is a
// type error rather than a request sent wrongly.
const METHOD_NAMES: Record<HttpMethodType[typeof typeKeySymbol], string> = {
	"HttpMethod#Get": "GET",
	"HttpMethod#Post": "POST",
	"HttpMethod#Put": "PUT",
	"HttpMethod#Patch": "PATCH",
	"HttpMethod#Delete": "DELETE",
	"HttpMethod#Head": "HEAD",
	"HttpMethod#Options": "OPTIONS",
}

// `#Refuse` is sent as `"manual"` and refused by `send`, so the reason a
// Program reads is this library's own.
const REDIRECT_MODES: Record<
	RedirectsType[typeof typeKeySymbol],
	"follow" | "manual"
> = {
	"Redirects#Follow": "follow",
	"Redirects#Manual": "manual",
	"Redirects#Refuse": "manual",
}

// A 304 is an answer, not a redirect. A browser answers an `opaqueredirect`
// with no status, so the Type is read too.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

function isRedirect(answered: Response): boolean {
	return (
		answered.type === "opaqueredirect" ||
		REDIRECT_STATUSES.has(answered.status)
	)
}

// The methods that carry no body. Refused here, before anything is sent.
const BODILESS_METHODS = new Set(["GET", "HEAD"])

// A header name is an HTTP token: these characters and no others.
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

// Any other scheme is `#InvalidUrl`, since `fetch` on some hosts reads a `file:`
// URL.
const SCHEMES = new Set(["http:", "https:"])

// Looked up per call, and through `typeof`, since a bare `fetch` throws on a
// host without one.
function hostFetch(): typeof fetch | null {
	return typeof fetch === "function" ? fetch : null
}

// A refused connection arrives as "fetch failed" with the refusal in its
// `cause`, so the cause is read too.
function reasonOf(thrown: unknown): string {
	if (!(thrown instanceof Error)) {
		return String(thrown)
	}

	let cause = thrown.cause

	return cause instanceof Error && cause.message !== ""
		? `${thrown.message}: ${cause.message}`
		: thrown.message
}

// What a stopped run answers, so that no Program sees it.
function neverAnswers<Value>(): Promise<Value> {
	return new Promise<Value>(() => {})
}

// The one native of the Namespace. Every verb in `Http.es` is written on it.
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

		// Decided before anything is sent, as `#Unreachable` with this
		// library's own reason.
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

// Pairs in the order they were set, so two spellings of one name stay two.
function headersOf(
	headers: DictionaryType<StringType, StringType>,
): Array<[string, string]> {
	return liveEntriesOf(headers).map(([name, value]) => [
		(name as StringType).value,
		(value as StringType).value,
	])
}

// The answer's headers with lowercased names. A repeated `set-cookie` is joined
// as `Headers` joins every other name. Only `getSetCookie()` could tell the
// cookies apart again.
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
