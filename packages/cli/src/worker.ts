import { parentPort } from "node:worker_threads"

import type { CompileMode } from "@essence-lang/compiler/compileMode"

import { type CompileRequest, compileFile } from "./pipeline"
import { type CompileSession, createCompileSession } from "./session"

// A compile worker. It compiles the entries the pool assigns it in one Session.

// Every mode facet is required. A `begin` that left one out would open the
// worker as a build, and a test run's bundles would lack their tests.
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
	// The entries this worker was given, as one Session, so a Module two of them
	// import is enriched once.
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
