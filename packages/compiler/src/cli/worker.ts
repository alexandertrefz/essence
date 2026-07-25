import { parentPort } from "node:worker_threads"

import { type CompileRequest, compileFile } from "./pipeline"

// NOTE: The Enricher is a single synchronous call that can take most of a
// second on a large file. Running it on the main thread would freeze the
// spinner exactly when there is finally something worth spinning about, so
// compilation happens here and the main thread is left free to draw.

export type WorkerRequest = {
	type: "compile"
	id: number
	request: CompileRequest
}

export type WorkerResponse =
	| { type: "ready" }
	| { type: "progress"; id: number; stage: string }
	| { type: "result"; id: number; outcome: unknown }

let port = parentPort

if (port !== null) {
	let channel = port

	channel.on("message", (message: WorkerRequest) => {
		if (message.type !== "compile") {
			return
		}

		compileFile(message.request, (stage) => {
			channel.postMessage({
				type: "progress",
				id: message.id,
				stage,
			} satisfies WorkerResponse)
		}).then((outcome) => {
			channel.postMessage({
				type: "result",
				id: message.id,
				outcome,
			} satisfies WorkerResponse)
		})
	})

	channel.postMessage({ type: "ready" } satisfies WorkerResponse)
}
