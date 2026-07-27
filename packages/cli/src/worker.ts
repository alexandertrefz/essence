import { parentPort } from "node:worker_threads"

import { type CompileRequest, compileFile } from "./pipeline"
import { type CompileSession, createCompileSession } from "./session"

// NOTE: The Enricher is a single synchronous call that can take most of a
// second on a large file. Running it on the main thread would freeze the
// spinner exactly when there is finally something worth spinning about, so
// compilation happens here and the main thread is left free to draw.

export type WorkerRequest =
	| { type: "begin"; entries: Array<string> }
	| { type: "compile"; id: number; request: CompileRequest }

export type WorkerResponse =
	| { type: "ready" }
	| { type: "progress"; id: number; stage: string }
	| { type: "result"; id: number; outcome: unknown }

let port = parentPort

if (port !== null) {
	let channel = port
	// NOTE: The entries this worker was given, as one Session, so that a Module
	// two of them import is read and enriched once here. A worker shares
	// nothing with its siblings: a Module two workers were both given is
	// enriched in each, which is why the entries are handed out in graph-shaped
	// sets rather than one at a time.
	let session: CompileSession | null = null

	channel.on("message", (message: WorkerRequest) => {
		if (message.type === "begin") {
			session = createCompileSession(message.entries)

			return
		}

		if (message.type !== "compile") {
			return
		}

		compileFile(
			message.request,
			(stage) => {
				channel.postMessage({
					type: "progress",
					id: message.id,
					stage,
				} satisfies WorkerResponse)
			},
			session ?? undefined,
		).then((outcome) => {
			channel.postMessage({
				type: "result",
				id: message.id,
				outcome,
			} satisfies WorkerResponse)
		})
	})

	channel.postMessage({ type: "ready" } satisfies WorkerResponse)
}
