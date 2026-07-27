// NOTE: The debuggee side of the adapter: Chrome DevTools Protocol over a
// WebSocket, spoken with the global `WebSocket` both Node and Bun ship — the
// surface used (the Debugger and Runtime domains) is small enough that a
// client library would mostly be weight.

type PendingCommand = {
	resolve: (result: unknown) => void
	reject: (error: Error) => void
}

export class CdpConnection {
	private socket: WebSocket
	private nextCommandId = 1
	private pending = new Map<number, PendingCommand>()
	private listeners = new Map<string, Array<(params: never) => void>>()
	private closeListeners: Array<() => void> = []

	private constructor(socket: WebSocket) {
		this.socket = socket

		socket.addEventListener("message", (event) => {
			this.receive(String(event.data))
		})
		socket.addEventListener("close", () => {
			// NOTE: Commands still in flight when the debuggee dies would hang
			// their callers forever — a session that ends mid-step must
			// settle, not stall.
			for (let [, command] of this.pending) {
				command.reject(new Error("the inspector connection closed"))
			}

			this.pending.clear()

			for (let listener of this.closeListeners) {
				listener()
			}
		})
	}

	static connect(url: string): Promise<CdpConnection> {
		return new Promise((resolve, reject) => {
			let socket = new WebSocket(url)

			socket.addEventListener("open", () =>
				resolve(new CdpConnection(socket)),
			)
			socket.addEventListener("error", () =>
				reject(new Error(`could not connect to the inspector at ${url}`)),
			)
		})
	}

	private receive(text: string): void {
		let message = JSON.parse(text) as {
			id?: number
			result?: unknown
			error?: { message: string }
			method?: string
			params?: unknown
		}

		if (message.id !== undefined) {
			let command = this.pending.get(message.id)

			if (command === undefined) {
				return
			}

			this.pending.delete(message.id)

			if (message.error !== undefined) {
				command.reject(new Error(message.error.message))
			} else {
				command.resolve(message.result)
			}

			return
		}

		if (message.method !== undefined) {
			for (let listener of this.listeners.get(message.method) ?? []) {
				;(listener as (params: unknown) => void)(message.params)
			}
		}
	}

	send<Result = unknown>(method: string, params?: object): Promise<Result> {
		return new Promise((resolve, reject) => {
			if (this.socket.readyState !== WebSocket.OPEN) {
				reject(new Error("the inspector connection is not open"))

				return
			}

			let id = this.nextCommandId++

			this.pending.set(id, {
				resolve: resolve as (result: unknown) => void,
				reject,
			})
			this.socket.send(JSON.stringify({ id, method, params }))
		})
	}

	on<Params>(method: string, listener: (params: Params) => void): void {
		let existing = this.listeners.get(method)

		if (existing === undefined) {
			this.listeners.set(method, [listener as (params: never) => void])
		} else {
			existing.push(listener as (params: never) => void)
		}
	}

	onClose(listener: () => void): void {
		this.closeListeners.push(listener)
	}

	close(): void {
		if (
			this.socket.readyState === WebSocket.OPEN ||
			this.socket.readyState === WebSocket.CONNECTING
		) {
			this.socket.close()
		}
	}
}
