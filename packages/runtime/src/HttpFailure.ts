import { createString, quotedText, type StringType } from "./String"
import { typeKeySymbol } from "./type"

// NOTE: `HttpFailure` is a builtin Choice whose every Case carries a reason, so
// this module holds more than the tags `HttpMethod.ts` and `Redirects.ts` hold.
// The natives ANSWER one — `Http.send` is the only caller — so the three
// constructors live here, and so does the rendering, for the reason
// `Result.toString` is native: an Essence body renders a payload through a hole,
// and a hole renders a String bare, so `#Unreachable("")` would print as a word
// and a pair of parentheses.
export type InvalidUrlType = {
	[typeKeySymbol]: "HttpFailure#InvalidUrl"
	url: StringType
}

export type UnreachableType = {
	[typeKeySymbol]: "HttpFailure#Unreachable"
	reason: StringType
}

export type InvalidBodyType = {
	[typeKeySymbol]: "HttpFailure#InvalidBody"
	reason: StringType
}

export type HttpFailureType = InvalidUrlType | UnreachableType | InvalidBodyType

// NOTE: No shared instances, unlike the payload-free Choices beside this one. A
// Case carrying a reason is a value built per failure, and two failures with the
// same reason are two values that compare equal — which is what the derived
// equality decides, by tag and by payload.
export function invalidUrl(url: string): InvalidUrlType {
	return { [typeKeySymbol]: "HttpFailure#InvalidUrl", url: createString(url) }
}

export function unreachable(reason: string): UnreachableType {
	return {
		[typeKeySymbol]: "HttpFailure#Unreachable",
		reason: createString(reason),
	}
}

export function invalidBody(reason: string): InvalidBodyType {
	return {
		[typeKeySymbol]: "HttpFailure#InvalidBody",
		reason: createString(reason),
	}
}

// NOTE: The `#` sigil is left out, as `Result` prints `Failure` and `Ordering`
// prints `Less`. A rendering names the Case; it does not quote the Expression
// that builds it. The parentheses stay, because every Case here carries
// something to put in them.
export function toString(failure: HttpFailureType): StringType {
	if (failure[typeKeySymbol] === "HttpFailure#InvalidUrl") {
		return createString(`InvalidUrl(${quotedText(failure.url.value)})`)
	}

	return createString(
		`${
			failure[typeKeySymbol] === "HttpFailure#Unreachable"
				? "Unreachable"
				: "InvalidBody"
		}(${quotedText(failure.reason.value)})`,
	)
}
