import type { BundleMap, OriginalPosition } from "./maps"
import { demangleName } from "./names"

// How a CDP stack becomes the one the user reads: user, standard library and
// glue frames, with a `match` shown as one frame. See "The call stack" in
// DEVELOPMENT.md.

export type CdpCallFrame = {
	callFrameId: string
	functionName: string
	location: { scriptId: string; lineNumber: number; columnNumber?: number }
	// Carried by every real pause and read by `scopes`, not by
	// `presentFrames`.
	scopeChain?: Array<{
		type: string
		name?: string
		object: { objectId?: string }
	}>
}

export type PresentedFrame = {
	// The raw CDP frame whose scope chain `scopes` reads. A merged frame keeps
	// the inner index, whose chain holds the handler's own bindings.
	callFrameIndex: number
	name: string
	kind: "user" | "stdlib" | "glue"
	// 1-based line and 0-based column, as the map has them. The session
	// converts for the client.
	source: OriginalPosition | null
}

function classify(
	frame: CdpCallFrame,
	original: OriginalPosition | null,
): PresentedFrame["kind"] {
	if (original !== null) {
		return "user"
	}

	return frame.functionName.startsWith("$es_") ? "stdlib" : "glue"
}

export function presentFrames(
	frames: Array<CdpCallFrame>,
	map: BundleMap | null,
	glueFrames: "hide" | "subtle",
): Array<PresentedFrame> {
	let annotated = frames.map((frame, index) => {
		let original =
			map?.originalPositionFor({
				line: frame.location.lineNumber,
				column: frame.location.columnNumber ?? 0,
			}) ?? null

		return {
			callFrameIndex: index,
			name: frame.functionName,
			kind: classify(frame, original),
			source: original,
		}
	})

	// An anonymous user frame over a user frame of the same source is a
	// `match`, and takes its caller's name. See "The call stack" in
	// DEVELOPMENT.md.
	let merged: Array<PresentedFrame> = []
	let index = 0

	while (index < annotated.length) {
		let frame = annotated[index]!

		if (frame.kind === "user" && frame.name === "") {
			let caller = annotated[index + 1]

			if (
				caller !== undefined &&
				caller.kind === "user" &&
				caller.source!.source === frame.source!.source
			) {
				merged.push({ ...frame, name: caller.name })
				index += 2

				continue
			}
		}

		merged.push(frame)
		index += 1
	}

	let presented = merged.filter(
		(frame) => glueFrames === "subtle" || frame.kind !== "glue",
	)

	// Still anonymous after the merge: the module's top level, the last user
	// frame, named after its file; or a `match` over glue, named `match`.
	let lastUserIndex = presented.findLastIndex(
		(frame) => frame.kind === "user",
	)

	return presented.map((frame, index) => ({
		...frame,
		name:
			frame.name === ""
				? index === lastUserIndex
					? (frame.source?.source.split("/").pop() ?? "match")
					: "match"
				: frame.kind === "glue"
					? frame.name
					: demangleName(frame.name),
	}))
}
