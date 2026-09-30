import { createString, quotedText, type StringType } from "./String"
import { typeKeySymbol } from "./type"

// A builtin Choice whose Cases each carry a reason. `Http.send` builds them.
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

// Native so that a String payload is quoted. See "Builtin Choices" in
// DEVELOPMENT.md.
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
