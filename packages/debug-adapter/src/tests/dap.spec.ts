import { afterEach, describe, expect, it } from "bun:test"
import * as path from "node:path"

import { DebugClient } from "@vscode/debugadapter-testsupport"

import { adapterCapabilities } from "../session"

const adapterBinary = path.resolve(
	import.meta.dirname,
	"..",
	"..",
	"bin",
	"esdap",
)

// NOTE: The real thing over real stdio — `DebugClient` spawns `bun bin/esdap`
// and speaks DAP at it, which is exactly how a `DebugAdapterExecutable` will.
describe("the DAP handshake", () => {
	let client: DebugClient | null = null

	afterEach(async () => {
		await client?.stop()
		client = null
	})

	it("answers initialize with the adapter's capabilities", async () => {
		client = new DebugClient("bun", adapterBinary, "essence")

		await client.start()

		let response = await client.initializeRequest({
			adapterID: "essence",
			linesStartAt1: true,
			columnsStartAt1: true,
			pathFormat: "path",
		})

		expect(response.body?.supportsConfigurationDoneRequest).toBe(true)
		expect(response.body?.supportsExceptionInfoRequest).toBe(true)
		expect(
			response.body?.exceptionBreakpointFilters?.map(
				(filter) => filter.filter,
			),
		).toEqual(["uncaught", "caught"])
	})

	it("promises over the wire exactly what the module promises", () => {
		expect(adapterCapabilities.supportsConfigurationDoneRequest).toBe(true)
		expect(
			adapterCapabilities.exceptionBreakpointFilters?.find(
				(filter) => filter.filter === "uncaught",
			)?.default,
		).toBe(true)
	})
})
