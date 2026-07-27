import type { BundleMap, OriginalPosition } from "./maps"
import { demangleName } from "./names"

// NOTE: How a CDP stack becomes the one the user reads. Three kinds of frame
// come up from the debuggee: `user` frames that map to a `.es` line, standard
// library frames — unmapped, but named `$es_<Namespace>_<member>` — and glue:
// dispatch trampolines, the inlined runtime, module bootstrap. Glue is hidden
// by default (`glueFrames: "subtle"` shows it greyed out); standard library
// frames stay, subtle, under their Essence names — they are the frames a user
// DOES want to see of a `sorted` that called their comparator.

export type CdpCallFrame = {
	callFrameId: string
	functionName: string
	location: { scriptId: string; lineNumber: number; columnNumber?: number }
	// NOTE: Carried by every real pause and read by `scopes`; the frame
	// presentation itself never looks inside.
	scopeChain?: Array<{
		type: string
		name?: string
		object: { objectId?: string }
	}>
}

export type PresentedFrame = {
	// NOTE: Which raw CDP frame this presents — `scopes` reads the frame's
	// scope chain off it, so a merged frame keeps the INNER index, whose
	// chain holds the handler's own bindings.
	callFrameIndex: number
	name: string
	kind: "user" | "stdlib" | "glue"
	// NOTE: 1-based line, 0-based column — the map's own conventions; the
	// session converts for the client.
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

	// NOTE: The match merge. A `match` lowers to an immediately-invoked
	// function, so pausing inside a handler shows an anonymous frame over the
	// enclosing function — one construct, two frames. The anonymous frame
	// absorbs its caller's NAME while keeping its own position and scope
	// chain, and the caller's frame disappears. The guard is deliberate: only
	// an anonymous frame, only user-mapped, only over a user frame of the
	// same source — a Function value passed to the standard library sits over
	// glue instead, and V8 names one bound to a declaration after it, so
	// neither is absorbed.
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

	// NOTE: What is left anonymous after the merge is one of two things: a
	// module's own top level — the LAST user frame there is, best named after
	// its file — or a match sitting over glue, which reads as the construct
	// it is.
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
