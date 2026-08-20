import { describe, expect, it } from "bun:test"
import path from "node:path"

import {
	describeEnvironment,
	describeServer,
	expandPath,
	findExecutable,
	probeLoginShell,
	resolveCli,
	resolveRuntime,
	resolveServer,
} from "../launch.js"

// NOTE: Every function here is a pure function of its arguments, so a machine
// is a set of paths that exist, an environment, and what the login shell
// would say — and the specs build one per case.
function machine(
	existing: Array<string>,
	overrides: Record<string, unknown> = {},
) {
	return {
		settingName: "essence.bun.path",
		env: { PATH: "/usr/bin:/bin" },
		home: "/home/ada",
		platform: "darwin",
		shell: "/bin/zsh",
		exists: (candidate: string) => existing.includes(candidate),
		list: () => [] as Array<string>,
		run: async () => undefined,
		...overrides,
	}
}

describe("expandPath", () => {
	it("substitutes ${workspaceFolder} and resolves a relative path against it", () => {
		expect(
			expandPath("${workspaceFolder}/packages/language-server/bin/esls", {
				workspaceRoot: "/repo",
			}),
		).toBe("/repo/packages/language-server/bin/esls")

		expect(
			expandPath("packages/cli/bin/essence", { workspaceRoot: "/repo" }),
		).toBe("/repo/packages/cli/bin/essence")
	})

	it("expands a leading tilde to the home directory", () => {
		expect(expandPath("~/tools/essence.js", { home: "/home/ada" })).toBe(
			"/home/ada/tools/essence.js",
		)
	})

	it("leaves an absolute path alone and trims it", () => {
		expect(expandPath("  /opt/essence  ", { workspaceRoot: "/repo" })).toBe(
			"/opt/essence",
		)
	})
})

describe("findExecutable", () => {
	it("prefers PATH over the usual locations", () => {
		let found = findExecutable(
			"bun",
			machine(["/usr/local/bin/bun", "/home/ada/.bun/bin/bun"], {
				env: { PATH: "/usr/local/bin:/usr/bin" },
			}),
		)

		expect(found.path).toBe("/usr/local/bin/bun")
		expect(found.source).toBe("PATH")
	})

	it("falls back to where the installer puts it when PATH is bare", () => {
		let found = findExecutable(
			"bun",
			machine(["/opt/homebrew/bin/bun"], {
				env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
			}),
		)

		expect(found.path).toBe("/opt/homebrew/bin/bun")
		expect(found.source).toBe("usual location")
		expect(found.searched).toContain("/usr/bin")
		expect(found.searched).toContain("/home/ada/.bun/bin")
	})

	it("honours BUN_INSTALL", () => {
		let found = findExecutable(
			"bun",
			machine(["/opt/bun/bin/bun"], {
				env: { PATH: "", BUN_INSTALL: "/opt/bun" },
			}),
		)

		expect(found.path).toBe("/opt/bun/bin/bun")
	})

	it("picks the newest nvm Node", () => {
		let versions = "/home/ada/.nvm/versions/node"
		let found = findExecutable(
			"node",
			machine(
				[
					path.join(versions, "v20.11.0", "bin", "node"),
					path.join(versions, "v22.3.0", "bin", "node"),
				],
				{
					list: (directory: string) =>
						directory === versions ? ["v20.11.0", "v22.3.0"] : [],
				},
			),
		)

		expect(found.path).toBe(path.join(versions, "v22.3.0", "bin", "node"))
	})

	it("looks for .exe and .cmd on Windows", () => {
		let found = findExecutable(
			"bun",
			machine([path.join("C:\\Users\\ada", ".bun", "bin", "bun.exe")], {
				platform: "win32",
				env: { PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\ada" },
			}),
		)

		expect(found.path).toBe(
			path.join("C:\\Users\\ada", ".bun", "bin", "bun.exe"),
		)
	})

	it("answers every directory it searched when nothing is found", () => {
		let found = findExecutable("bun", machine([]))

		expect(found.path).toBeUndefined()
		expect(found.searched).toEqual([
			"/usr/bin",
			"/bin",
			"/home/ada/.bun/bin",
			"/opt/homebrew/bin",
			"/usr/local/bin",
			"/home/linuxbrew/.linuxbrew/bin",
		])
	})
})

describe("probeLoginShell", () => {
	it("believes the last absolute path that exists, below any prompt noise", async () => {
		let answer = await probeLoginShell(
			"bun",
			machine(["/opt/homebrew/bin/bun"], {
				run: async (shell: string, args: Array<string>) => {
					expect(shell).toBe("/bin/zsh")
					expect(args).toEqual(["-ilc", "command -v bun"])

					return "Welcome back!\n/opt/homebrew/bin/bun\n"
				},
			}),
		)

		expect(answer).toBe("/opt/homebrew/bin/bun")
	})

	it("answers nothing on Windows, without a shell, or when the shell says nothing", async () => {
		expect(
			await probeLoginShell("bun", machine([], { platform: "win32" })),
		).toBeUndefined()
		expect(
			await probeLoginShell("bun", machine([], { shell: undefined })),
		).toBeUndefined()
		expect(
			await probeLoginShell("bun", machine([], { run: async () => "" })),
		).toBeUndefined()
	})

	it("does not believe a path that does not exist", async () => {
		expect(
			await probeLoginShell(
				"bun",
				machine([], { run: async () => "/gone/bun\n" }),
			),
		).toBeUndefined()
	})
})

describe("resolveRuntime", () => {
	it("takes the setting as final, existing or not", async () => {
		let context = machine(["/x/bun"])

		expect(await resolveRuntime("bun", "/x/bun", context)).toEqual({
			path: "/x/bun",
			source: "setting",
			searched: [],
		})

		let missing = await resolveRuntime("bun", "/nowhere/bun", context)

		expect(missing.error).toContain("'essence.bun.path'")
		expect(missing.error).toContain("/nowhere/bun")
	})

	it("asks the login shell only after PATH and the usual locations", async () => {
		let asked = false
		let found = await resolveRuntime(
			"bun",
			"",
			machine(["/weird/place/bun"], {
				run: async () => {
					asked = true

					return "/weird/place/bun"
				},
			}),
		)

		expect(asked).toBe(true)
		expect(found.path).toBe("/weird/place/bun")
		expect(found.source).toBe("login shell")
		expect(found.searched).toContain("/opt/homebrew/bin")
	})

	it("reports what it searched when every route fails", async () => {
		let failed = await resolveRuntime("node", undefined, machine([]))

		expect(failed.error).toContain("no 'node' executable was found")
		expect(failed.searched).toContain("/usr/local/bin")
	})
})

describe("describeEnvironment", () => {
	it("recognises the bare launchd PATH on macOS and says to relaunch", () => {
		let lines = describeEnvironment({
			env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
			platform: "darwin",
		})

		expect(lines[0]).toContain("/usr/bin:/bin:/usr/sbin:/sbin")
		expect(lines[1]).toContain("Quit VS Code fully")
		expect(lines[1]).toContain("Reload Window")
	})

	it("only names PATH otherwise", () => {
		expect(
			describeEnvironment({ env: { PATH: "/a:/b" }, platform: "linux" }),
		).toEqual(["PATH as the extension host sees it: '/a:/b'"])
	})
})

describe("resolveServer", () => {
	const bundled = "/ext/server/server.js"

	function context(
		existing: Array<string>,
		resolveBun?: () => Promise<unknown>,
	) {
		return {
			workspaceRoot: "/repo",
			extensionPath: "/ext",
			home: "/home/ada",
			exists: (candidate: string) => existing.includes(candidate),
			resolveBun:
				resolveBun ??
				(async () => ({ error: "no bun", searched: ["/usr/bin"] })),
		}
	}

	it("runs the bundled server as a module with nothing configured", async () => {
		let server = await resolveServer("", context([bundled]))

		expect(server).toEqual({
			kind: "module",
			path: bundled,
			configured: false,
		})
		expect(describeServer(server)).toBe(
			`bundled Language Server '${bundled}', run on VS Code's own Node`,
		)
	})

	it("runs a configured bundle as a module too, never asking for Bun", async () => {
		let server = await resolveServer(
			"~/built/server.js",
			context(["/home/ada/built/server.js"], async () => {
				throw new Error("must not be asked")
			}),
		)

		expect(server).toEqual({
			kind: "module",
			path: "/home/ada/built/server.js",
			configured: true,
		})
	})

	it("runs configured source with the Bun it resolved", async () => {
		let esls = "/repo/packages/language-server/bin/esls"
		let server = await resolveServer(
			"${workspaceFolder}/packages/language-server/bin/esls",
			context([esls, bundled], async () => ({
				path: "/opt/homebrew/bin/bun",
				source: "usual location",
			})),
		)

		expect(server).toEqual({
			kind: "command",
			command: "/opt/homebrew/bin/bun",
			runtimeSource: "usual location",
			path: esls,
			configured: true,
		})
		expect(describeServer(server)).toBe(
			`configured Language Server '${esls}', run with '/opt/homebrew/bin/bun'`,
		)
	})

	it("offers the bundled server as the fallback when Bun cannot be found", async () => {
		let esls = "/repo/packages/language-server/bin/esls"
		let server = await resolveServer(esls, context([esls, bundled]))

		expect(server.error).toContain("needs Bun to run, but no bun")
		expect(server.searched).toEqual(["/usr/bin"])
		expect(server.fallback).toEqual({
			kind: "module",
			path: bundled,
			configured: false,
		})
	})

	it("offers the fallback for a configured path that does not exist", async () => {
		let server = await resolveServer("/nowhere/esls", context([bundled]))

		expect(server.error).toContain("/nowhere/esls")
		expect(server.fallback?.path).toBe(bundled)
	})

	it("has no fallback without a bundle", async () => {
		let missing = await resolveServer("/nowhere/esls", context([]))

		expect(missing.fallback).toBeUndefined()

		let unbuilt = await resolveServer("", context([]))

		expect(unbuilt.error).toContain("bun run build")
	})
})

describe("resolveCli", () => {
	const context = (existing: Array<string>) => ({
		workspaceRoot: "/repo",
		home: "/home/ada",
		exists: (candidate: string) => existing.includes(candidate),
	})

	it("runs a configured bundle as a module and anything else with bun", () => {
		expect(
			resolveCli("/tools/essence.js", context(["/tools/essence.js"])),
		).toEqual({
			kind: "module",
			path: "/tools/essence.js",
			description: "configured CLI '/tools/essence.js'",
		})

		let launcher = "/repo/packages/cli/bin/essence"

		expect(
			resolveCli(
				"${workspaceFolder}/packages/cli/bin/essence",
				context([launcher]),
			).kind,
		).toBe("bun")
	})

	it("refuses a configured path that does not exist", () => {
		let result = resolveCli("/nowhere/essence", context([]))

		expect(result.error).toContain("/nowhere/essence")
		expect(result.kind).toBeUndefined()
	})

	it("finds a checkout's own launcher in the workspace", () => {
		let launcher = path.join("/repo", "packages", "cli", "bin", "essence")

		expect(resolveCli("", context([launcher]))).toEqual({
			kind: "bun",
			path: launcher,
			description: `workspace checkout CLI '${launcher}'`,
		})
	})

	it("otherwise wants the installed essence found", () => {
		expect(resolveCli(undefined, context([]))).toEqual({
			kind: "installed",
			description: "the installed 'essence'",
		})
	})
})
