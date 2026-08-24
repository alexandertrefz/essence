import { parentPort } from "node:worker_threads"

import type { CompileMode } from "@essence-lang/compiler/compileMode"

import { type CompileRequest, compileFile } from "./pipeline"
import { type CompileSession, createCompileSession } from "./session"

// NOTE: The Enricher is a single synchronous call that can take most of a
// second on a large file. Running it on the main thread would freeze the
// spinner exactly when there is finally something worth spinning about, so
// compilation happens here and the main thread is left free to draw.

// NOTE: Every facet of the mode is REQUIRED here rather than left optional. The
// mode is the whole run's and a worker is opened in it — a `begin` that forgets
// to say opens the worker as a build, which compiles every file of a test run
// without the section the run exists to check. Requiring them is what makes the
// two places a `begin` is written say the same thing, and asking for
// `Required<CompileMode>` is what keeps that true of a facet added later.
export type WorkerRequest =
	| ({ type: "begin"; entries: Array<string> } & Required<CompileMode>)
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
			session = createCompileSession(message.entries, message)

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
