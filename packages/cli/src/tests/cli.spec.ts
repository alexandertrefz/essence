import { afterAll, afterEach, describe, expect, it } from "bun:test"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
	defaultConfiguration,
	PROJECT_FILE_NAME,
	type ProjectConfiguration,
	readProjectConfiguration,
} from "@essence-lang/compiler/configuration"
import { closestMatch } from "@essence-lang/compiler/helpers"
import { optimiserPassNames } from "@essence-lang/compiler/optimiser"
import { testDiagnostic } from "@essence-lang/compiler/tests/diagnosticFactory"
import { fixturePath } from "@essence-lang/fixtures"
import { spawnAndWait } from "@essence-lang/fixtures/spawn"
import { STDLIB_DIRECTORY } from "@essence-lang/standard-library"

import { EXIT_SUCCESS, EXIT_USAGE, runCheck, runRun } from "../actions"
import {
	optimiserOptionsFor,
	type OptionValues,
	parseArguments,
	UsageError,
} from "../args"
import {
	commands,
	type CommandSpec,
	findCommand,
	globalOptions,
	PROGRAM,
	PROJECT_FILE,
} from "../commands"
import { colorChoiceFor, createContext, version } from "../context"
import { runtimeArguments } from "../execute"
import {
	renderCommandHelp,
	renderOverview,
	renderUsageLine,
	wrap,
} from "../help"
import { debugAdapterCompile, run } from "../index"
import {
	defaultOutputFor,
	looksLikeGlob,
	resolveInputFiles,
	resolveOutputFiles,
} from "../inputs"
import { type JSONReport, toJSONReport } from "../json"
import {
	type CompileOutcome,
	compileFile,
	type CompileRequest,
	descriptorFileName,
} from "../pipeline"
import {
	createWorkerPool,
	defaultWorkerCount,
	shouldUseWorkers,
	workerFileName,
} from "../pool"
import {
	readsProjectConfiguration,
	resolveProjectOptions,
} from "../projectOptions"
import {
	countDiagnostics,
	formatBytes,
	formatDuration,
	pluralise,
	renderDiagnosticsFor,
} from "../report"
import { createCompileSession, groupEntries } from "../session"
import { isInteractive, type Terminal, truncate } from "../terminal"
import {
	createPalette,
	createTheme,
	stripAnsi,
	supportsColor,
	supportsUnicode,
	visibleLength,
} from "../theme"
import { within, withFiles } from "./harness"

// A bundle cache of this run's own, so specs neither read nor fill the user's.
// It is set before anything compiles, since the cache path is read on every use.
let bundleCache = mkdtempSync(path.join(tmpdir(), "essence-cli-cache-"))
// A result cache of its own too, for the same reason.
let resultCache = mkdtempSync(path.join(tmpdir(), "essence-cli-results-"))

process.env.ESSENCE_CLI_CACHE = bundleCache
process.env.ESSENCE_RESULTS_CACHE = resultCache

afterAll(() => {
	rmSync(bundleCache, { recursive: true, force: true })
	rmSync(resultCache, { recursive: true, force: true })
})

// The originals of the globals `capture` and `runBundle` hijack. A test that
// times out mid-await never reaches its `finally`. So the `afterEach` restores
// them, and an abandoned hijack costs one test rather than the file.
const originalLog = console.log
const originalStandardOut = process.stdout.write
const originalStandardError = process.stderr.write

afterEach(() => {
	console.log = originalLog
	process.stdout.write = originalStandardOut
	process.stderr.write = originalStandardError
})

type Command = NonNullable<ReturnType<typeof findCommand>>

const buildCommand = findCommand("build") as Command
const runCommand = findCommand("run") as Command
const formatCommand = findCommand("format") as Command

// Everything the CLI writes, a delegate's output included, goes through
// `process.stdout` and `process.stderr`, so a spec holds both for the call.
async function capture(
	invoke: () => Promise<number>,
): Promise<{ code: number; out: string; err: string }> {
	let out = ""
	let err = ""
	let writeOut = process.stdout.write
	let writeErr = process.stderr.write

	process.stdout.write = ((chunk: string): boolean => {
		out += chunk

		return true
	}) as typeof process.stdout.write
	process.stderr.write = ((chunk: string): boolean => {
		err += chunk

		return true
	}) as typeof process.stderr.write

	try {
		return { code: await invoke(), out, err }
	} finally {
		process.stdout.write = writeOut
		process.stderr.write = writeErr
	}
}

function outcome(overrides: Partial<CompileOutcome> = {}): CompileOutcome {
	return {
		inputFileName: "Source.es",
		outputFileName: "Source.js",
		ok: true,
		sourceText: "",
		modules: [],
		diagnostics: [],
		timings: [{ name: "parse", duration: 1.5 }],
		duration: 12.25,
		bytes: 2048,
		gzipBytes: 512,
		failedStage: null,
		stack: null,
		cached: false,
		...overrides,
	}
}

// `--version` must answer the manifest's version, not a fallback.
describe("esc --version", () => {
	it("reports the version the manifest declares", () => {
		let manifest = JSON.parse(
			readFileSync(
				fileURLToPath(import.meta.resolve("../../package.json")),
				"utf8",
			),
		) as { version: string }

		expect(version).toBe(manifest.version)
		expect(version).toMatch(/^\d+\.\d+\.\d+/)
	})
})

describe("CLI", () => {
	describe("parseArguments", () => {
		it("defaults to the build Command", () => {
			let invocation = parseArguments(["HelloWorld.es"])

			expect(invocation.command.name).toBe("build")
			expect(invocation.commandWasExplicit).toBe(false)
			expect(invocation.files).toEqual(["HelloWorld.es"])
		})

		it("recognises an explicit Command", () => {
			let invocation = parseArguments(["check", "HelloWorld.es"])

			expect(invocation.command.name).toBe("check")
			expect(invocation.commandWasExplicit).toBe(true)
			expect(invocation.files).toEqual(["HelloWorld.es"])
		})

		it("resolves Command aliases", () => {
			expect(parseArguments(["b", "a.es"]).command.name).toBe("build")
			expect(parseArguments(["w", "a.es"]).command.name).toBe("watch")
		})

		it("reads short and long Options", () => {
			let invocation = parseArguments([
				"build",
				"-o",
				"out.js",
				"--minify",
				"a.es",
			])

			expect(invocation.options.out).toBe("out.js")
			expect(invocation.options.minify).toBe(true)
			expect(invocation.files).toEqual(["a.es"])
		})

		// A path is never mistaken for a mistyped Command, however close it looks.
		it("treats a file name as a file rather than an unknown Command", () => {
			let invocation = parseArguments(["build.es"])

			expect(invocation.command.name).toBe("build")
			expect(invocation.files).toEqual(["build.es"])
		})

		it("suggests a Command for a near miss", () => {
			try {
				parseArguments(["buld", "a.es"])
				expect.unreachable()
			} catch (error) {
				expect(error).toBeInstanceOf(UsageError)
				expect((error as UsageError).suggestion).toContain("esc build")
			}
		})

		it("reports an unknown Option against the Command it was given to", () => {
			try {
				parseArguments(["build", "--nonsense", "a.es"])
				expect.unreachable()
			} catch (error) {
				expect(error).toBeInstanceOf(UsageError)
				expect((error as UsageError).command?.name).toBe("build")
				expect((error as UsageError).message).toContain("--nonsense")
			}
		})

		it("suggests a near-miss Option", () => {
			try {
				parseArguments(["build", "--minfy", "a.es"])
				expect.unreachable()
			} catch (error) {
				expect((error as UsageError).suggestion).toContain("--minify")
			}
		})

		it("reads the optimisation Options", () => {
			let invocation = parseArguments([
				"build",
				"--no-optimise",
				"--without-optimisation",
				"collapse-construction",
				"--without-optimisation",
				"collapse-combinations",
				"a.es",
			])

			expect(invocation.options.noOptimise).toBe(true)
			expect(invocation.options.withoutOptimisation).toEqual([
				"collapse-construction",
				"collapse-combinations",
			])
			expect(invocation.files).toEqual(["a.es"])
		})

		// `--embed` is on the two Commands that write an artifact, and on no other.
		it("reads --embed on the Commands that write a bundle", () => {
			expect(parseArguments(["build", "a.es"]).options.embed).toBe(false)
			expect(
				parseArguments(["build", "--embed", "a.es"]).options.embed,
			).toBe(true)
			expect(
				parseArguments(["watch", "--embed", "a.es"]).options.embed,
			).toBe(true)

			for (let command of ["run", "check"]) {
				expect(() =>
					parseArguments([command, "--embed", "a.es"]),
				).toThrow(UsageError)
			}
		})

		it("leaves every pass on when neither is given", () => {
			let options = parseArguments(["build", "a.es"]).options

			expect(options.noOptimise).toBe(false)
			expect(options.withoutOptimisation).toEqual([])
			expect(optimiserOptionsFor(options)).toEqual({
				enabled: true,
				disabledPasses: new Set(),
				coverage: false,
			})
		})

		// An unknown pass name must be reported, or the flag would silently do nothing.
		it("refuses an optimisation pass it does not have", () => {
			try {
				parseArguments([
					"build",
					"--without-optimisation",
					"collapse-nonsense",
					"a.es",
				])
				expect.unreachable()
			} catch (error) {
				expect(error).toBeInstanceOf(UsageError)
				expect((error as UsageError).command?.name).toBe("build")
				expect((error as UsageError).message).toContain(
					"collapse-nonsense",
				)
			}
		})

		it("names every pass when the misspelling is not a near miss", () => {
			try {
				parseArguments([
					"build",
					"--without-optimisation",
					"zzzzzzzzzz",
					"a.es",
				])
				expect.unreachable()
			} catch (error) {
				for (let name of optimiserPassNames) {
					expect((error as UsageError).suggestion).toContain(name)
				}
			}
		})

		it("suggests a near-miss pass name", () => {
			try {
				parseArguments([
					"build",
					"--without-optimisation",
					"collapse-constructions",
					"a.es",
				])
				expect.unreachable()
			} catch (error) {
				expect((error as UsageError).suggestion).toContain(
					"collapse-construction",
				)
			}
		})

		it("hands arguments after -- to the program", () => {
			let invocation = parseArguments([
				"run",
				"a.es",
				"--",
				"--port",
				"8080",
			])

			expect(invocation.files).toEqual(["a.es"])
			expect(invocation.programArguments).toEqual(["--port", "8080"])
		})

		it("refuses program arguments for Commands that run nothing", () => {
			expect(() => parseArguments(["build", "a.es", "--", "x"])).toThrow(
				UsageError,
			)
		})

		it("rejects a --jobs value that is not a positive whole number", () => {
			expect(() => parseArguments(["build", "-j", "0", "a.es"])).toThrow(
				UsageError,
			)
			expect(() =>
				parseArguments(["build", "-j", "two", "a.es"]),
			).toThrow(UsageError)
			expect(
				parseArguments(["build", "-j", "4", "a.es"]).options.jobs,
			).toBe(4)
		})

		it("accepts --help without any file", () => {
			expect(parseArguments(["--help"]).options.help).toBe(true)
			expect(parseArguments(["build", "--help"]).options.help).toBe(true)
		})

		it("names the invoked program in what it suggests", () => {
			try {
				parseArguments(["buld", "a.es"], "essence")
				expect.unreachable()
			} catch (error) {
				expect((error as UsageError).suggestion).toContain(
					"essence build",
				)
			}

			try {
				parseArguments(["build", "--nonsense", "a.es"], "essence")
				expect.unreachable()
			} catch (error) {
				expect((error as UsageError).message).toContain("essence build")
			}

			expect(() =>
				parseArguments(["build", "a.es", "--", "x"], "essence"),
			).toThrow("essence build does not pass arguments")
		})

		// The Formatter parses its own flags, so nothing after `format` is read here,
		// not even a bare `--`.
		it("captures a passthrough Command's arguments verbatim", () => {
			let invocation = parseArguments([
				"format",
				"--check",
				"--stdin-filepath",
				"src/App.es",
				"--",
				"weird.es",
			])

			expect(invocation.command.name).toBe("format")
			expect(invocation.commandWasExplicit).toBe(true)
			expect(invocation.rawArguments).toEqual([
				"--check",
				"--stdin-filepath",
				"src/App.es",
				"--",
				"weird.es",
			])
			expect(invocation.files).toEqual([])
			expect(invocation.programArguments).toEqual([])
		})

		it("does not read a passthrough Command's flags as its own", () => {
			expect(() => parseArguments(["format", "--check"])).not.toThrow()
			expect(() => parseArguments(["fmt", "--nonsense"])).not.toThrow()
			expect(() => parseArguments(["lsp", "--stdio"])).not.toThrow()
			expect(() => parseArguments(["dap", "--anything"])).not.toThrow()
			expect(parseArguments(["fmt", "--check"]).command.name).toBe(
				"format",
			)
			expect(parseArguments(["lsp", "--stdio"]).rawArguments).toEqual([
				"--stdio",
			])
		})

		// `--help` is answered from the Command table, so `essence format --help` matches
		// `essence help format`, and `essence lsp --help` starts no Server.
		it("answers --help itself for a passthrough Command", () => {
			expect(parseArguments(["format", "--help"]).options.help).toBe(true)
			expect(parseArguments(["lsp", "-h"]).options.help).toBe(true)
			expect(parseArguments(["format", "--check"]).options.help).toBe(
				false,
			)
		})

		it("leaves rawArguments empty for every other Command", () => {
			expect(parseArguments(["check", "a.es"]).rawArguments).toEqual([])
			expect(
				parseArguments(["run", "a.es", "--", "-x"]).rawArguments,
			).toEqual([])
		})
	})

	describe("closestMatch", () => {
		it("finds a plausible correction", () => {
			expect(closestMatch("buld", ["build", "check"])).toBe("build")
		})

		it("offers nothing when there is no near match", () => {
			expect(closestMatch("xyzzy", ["build", "check"])).toBe(null)
		})
	})

	describe("Command table", () => {
		// Help comes from the Command table, so an undocumented Option would render
		// empty.
		it("documents every Option", () => {
			for (let command of commands) {
				for (let option of [...command.options, ...globalOptions]) {
					expect(option.summary.length).toBeGreaterThan(0)
				}
			}
		})

		it("gives every Command a usage line and a description", () => {
			for (let command of commands) {
				expect(command.usage.length).toBeGreaterThan(0)
				expect(command.description.length).toBeGreaterThan(0)
			}
		})

		it("keeps Command names and aliases unique", () => {
			let seen = new Set<string>()

			for (let command of commands) {
				for (let name of [command.name, ...command.aliases]) {
					expect(seen.has(name)).toBe(false)
					seen.add(name)
				}
			}
		})

		it("parses every documented example", () => {
			for (let command of commands) {
				for (let example of command.examples) {
					let argv = example.command.split(" ").slice(1)

					expect(() => parseArguments(argv)).not.toThrow()
				}
			}
		})
	})

	describe("help", () => {
		let context = {
			palette: createPalette(createTheme(false, true)),
			width: 80,
			version: "1.2.3",
			programName: "esc",
		}

		it("lists every Command in the overview", () => {
			let overview = renderOverview(context)

			for (let command of commands) {
				expect(overview).toContain(command.name)
			}
		})

		it("shows the version in the overview", () => {
			expect(renderOverview(context)).toContain("1.2.3")
		})

		it("documents every Option of a Command", () => {
			let rendered = renderCommandHelp(buildCommand, context)

			for (let option of buildCommand.options) {
				expect(rendered).toContain(`--${option.name}`)
			}
		})

		it("never leaves trailing whitespace on a line", () => {
			for (let line of renderOverview(context).split("\n")) {
				expect(line).toBe(line.trimEnd())
			}

			for (let command of commands) {
				for (let line of renderCommandHelp(command, context).split(
					"\n",
				)) {
					expect(line).toBe(line.trimEnd())
				}
			}
		})

		it("stays inside the given measure", () => {
			for (let line of renderOverview({ ...context, width: 80 }).split(
				"\n",
			)) {
				expect(visibleLength(line)).toBeLessThanOrEqual(88)
			}
		})

		it("offers the Formatter and the Language Server in the overview", () => {
			let overview = renderOverview(context)

			expect(overview).toContain("format")
			expect(overview).toContain("lsp")
			expect(overview).toContain("dap")
			expect(overview).toContain("Format Essence sources in place")
			expect(overview).toContain("Start the Essence Language Server")
			expect(overview).toContain("Start the Essence Debug Adapter")
		})

		// Help names the program as it was invoked, so its lines paste back into the
		// user's shell.
		it("renders the name the binary was invoked as", () => {
			let asEssence = renderOverview({
				...context,
				programName: "essence",
			})

			expect(asEssence).toContain("essence <command> [file...] [options]")
			expect(asEssence).toContain("essence help <command>")
			expect(asEssence).toContain("essence run HelloWorld.es")
			expect(asEssence).not.toMatch(/\besc\b/)

			let asEsc = renderOverview(context)

			expect(asEsc).toContain("esc <command> [file...] [options]")
			expect(asEsc).toContain("esc help <command>")
			expect(asEsc).not.toContain("essence <command>")
		})

		it("renders the invoked name in Command help", () => {
			let rendered = renderCommandHelp(runCommand, {
				...context,
				programName: "essence",
			})

			expect(rendered).toContain("essence run <file> [options]")
			expect(rendered).toContain("essence run App.es -- --port 8080")
			expect(rendered).not.toMatch(/\besc\b/)
			expect(renderCommandHelp(runCommand, context)).toContain("esc run")
		})

		it("never leaves the placeholder in rendered text", () => {
			for (let programName of ["esc", "essence"]) {
				let rendered = [
					renderOverview({ ...context, programName }),
					...commands.map((command) =>
						renderCommandHelp(command, { ...context, programName }),
					),
					...commands.map((command) =>
						renderUsageLine(command, { ...context, programName }),
					),
				].join("\n")

				expect(rendered).not.toContain(PROGRAM)
			}
		})

		// A passthrough Command's delegate ignores `--json` and `--quiet`, so its help
		// does not list them.
		it("leaves the global Options out of a passthrough Command's help", () => {
			let rendered = renderCommandHelp(formatCommand, {
				...context,
				programName: "essence",
			})

			expect(rendered).toContain("essence format <files...> [options]")
			expect(rendered).toContain("--stdin-filepath")
			expect(rendered).not.toContain("GLOBAL OPTIONS")
			expect(rendered).not.toContain("--json")
			expect(renderCommandHelp(buildCommand, context)).toContain(
				"GLOBAL OPTIONS",
			)
		})
	})

	describe("wrap", () => {
		it("breaks text at the given width", () => {
			let lines = wrap("one two three four five six", 11)

			for (let line of lines) {
				expect(line.length).toBeLessThanOrEqual(11)
			}

			expect(lines.join(" ")).toBe("one two three four five six")
		})

		it("returns nothing for empty text", () => {
			expect(wrap("", 20)).toEqual([])
		})
	})

	describe("inputs", () => {
		it("names the output after the input", () => {
			expect(defaultOutputFor("src/App.es")).toBe("src/App.js")
			expect(defaultOutputFor("App.es")).toBe("App.js")
		})

		it("recognises glob patterns", () => {
			expect(looksLikeGlob("src/*.es")).toBe(true)
			expect(looksLikeGlob("src/App.es")).toBe(false)
		})

		it("requires at least one file", async () => {
			await expect(resolveInputFiles([], buildCommand)).rejects.toThrow(
				UsageError,
			)
		})

		it("fails when a pattern matches nothing", async () => {
			await expect(
				resolveInputFiles([fixturePath("*.nothing")], buildCommand),
			).rejects.toThrow(UsageError)
		})

		// An absolute pattern, since `glob` resolves against the working directory.
		it("expands a glob", async () => {
			let files = await resolveInputFiles(
				[fixturePath("*.es")],
				buildCommand,
			)

			expect(files.length).toBeGreaterThan(1)
			expect(files).toContain(fixturePath("HelloWorld.es"))
		})

		it("treats --out as a file for a single input", async () => {
			let outputs = await resolveOutputFiles(
				["a.es"],
				"build/app.js",
				buildCommand,
			)

			expect(outputs.get("a.es")).toBe("build/app.js")
		})

		it("treats --out as a directory for several inputs", async () => {
			let outputs = await resolveOutputFiles(
				["src/a.es", "src/b.es"],
				"dist",
				buildCommand,
			)

			expect(outputs.get("src/a.es")).toBe("dist/a.js")
			expect(outputs.get("src/b.es")).toBe("dist/b.js")
		})

		it("treats a trailing separator as a directory", async () => {
			let outputs = await resolveOutputFiles(
				["a.es"],
				"dist/",
				buildCommand,
			)

			expect(outputs.get("a.es")).toBe("dist/a.js")
		})

		// Flattening several directories into one can make two sources collide, which
		// must be an error.
		it("refuses inputs that would overwrite each other", async () => {
			await expect(
				resolveOutputFiles(
					["one/App.es", "two/App.es"],
					"dist/",
					buildCommand,
				),
			).rejects.toThrow(UsageError)
		})

		it("defaults to writing beside each source", async () => {
			let outputs = await resolveOutputFiles(
				["src/a.es", "other/b.es"],
				undefined,
				buildCommand,
			)

			expect(outputs.get("src/a.es")).toBe("src/a.js")
			expect(outputs.get("other/b.es")).toBe("other/b.js")
		})
	})

	describe("worker dispatch", () => {
		// One entry is one graph, which one worker compiles, however large.
		it("stays on the main thread for one file", () => {
			expect(
				shouldUseWorkers({
					fileCount: 1,
					totalBytes: 400,
					emit: true,
					jobs: undefined,
				}),
			).toBe(false)
			expect(
				shouldUseWorkers({
					fileCount: 1,
					totalBytes: 200_000,
					emit: false,
					jobs: undefined,
				}),
			).toBe(false)
		})

		it("uses workers for a batch that emits", () => {
			expect(
				shouldUseWorkers({
					fileCount: 4,
					totalBytes: 4_000,
					emit: true,
					jobs: undefined,
				}),
			).toBe(false)
			expect(
				shouldUseWorkers({
					fileCount: 8,
					totalBytes: 4_000,
					emit: true,
					jobs: undefined,
				}),
			).toBe(true)
		})

		// A check only divides enrichment, which pays off only for a large batch.
		it("keeps a check on the main thread until the sources are large", () => {
			expect(
				shouldUseWorkers({
					fileCount: 40,
					totalBytes: 130_000,
					emit: false,
					jobs: undefined,
				}),
			).toBe(false)
			expect(
				shouldUseWorkers({
					fileCount: 6,
					totalBytes: 430_000,
					emit: false,
					jobs: undefined,
				}),
			).toBe(true)
		})

		it("honours an explicit --jobs either way", () => {
			expect(
				shouldUseWorkers({
					fileCount: 40,
					totalBytes: 900_000,
					emit: true,
					jobs: 1,
				}),
			).toBe(false)
			expect(
				shouldUseWorkers({
					fileCount: 1,
					totalBytes: 10,
					emit: false,
					jobs: 4,
				}),
			).toBe(true)
		})

		it("never asks for more workers than there are files", () => {
			expect(defaultWorkerCount(1)).toBe(1)
			expect(defaultWorkerCount(2)).toBeLessThanOrEqual(2)
			expect(defaultWorkerCount(1000)).toBeLessThanOrEqual(4)
		})

		// The worker file matches how `pool.ts` runs: the published package has no
		// `worker.ts`.
		it("boots the worker its own module could be", () => {
			expect(workerFileName("file:///checkout/cli/src/pool.ts")).toBe(
				"./worker.ts",
			)
			expect(workerFileName("file:///install/cli/dist/pool.js")).toBe(
				"./worker.js",
			)
		})

		// A worker learns its run's mode either way. A slot boots on its first
		// job, after the first `begin`, and a later `begin` reaches the running
		// worker. A file whose tests do not compile shows the mode it opened in.
		it("opens a worker booted after begin in the run's mode", async () => {
			let directory = mkdtempSync(path.join(tmpdir(), "essence-pool-"))
			let entry = path.join(directory, "Mode.tests.es")
			let request: CompileRequest = {
				inputFileName: entry,
				outputFileName: null,
				minify: false,
				sourcemap: false,
			}
			let pool = createWorkerPool(1)

			writeFileSync(
				entry,
				[
					"tests {",
					'\ttest "asserts a String" {',
					'\t\texpect "not a Boolean"',
					"\t}",
					"}",
					"",
				].join("\n"),
			)

			try {
				pool.begin([entry], { tests: true })

				let asked = await pool.compile({ ...request, tests: true })

				expect(asked.ok).toBe(false)
				expect(
					asked.diagnostics.map((diagnostic) => diagnostic.code),
				).toContain("expect-not-boolean")

				pool.begin([entry])

				let plain = await pool.compile(request)

				expect(plain.diagnostics).toEqual([])
				expect(plain.ok).toBe(true)
			} finally {
				await pool.dispose()
				rmSync(directory, { recursive: true, force: true })
			}
		})
	})

	describe("formatting", () => {
		it("scales byte counts", () => {
			expect(formatBytes(512)).toBe("512 B")
			expect(formatBytes(2048)).toBe("2.0 kB")
			expect(formatBytes(1_500_000)).toBe("1.50 MB")
		})

		it("keeps durations readable at every scale", () => {
			expect(formatDuration(0.25)).toBe("0.25 ms")
			expect(formatDuration(2.5)).toBe("2.5 ms")
			expect(formatDuration(61.4)).toBe("61 ms")
			expect(formatDuration(1300)).toBe("1.30 s")
		})

		it("pluralises counts", () => {
			expect(pluralise(1, "error")).toBe("1 error")
			expect(pluralise(2, "error")).toBe("2 errors")
		})

		it("counts Diagnostics by severity", () => {
			let counts = countDiagnostics([
				testDiagnostic({ severity: "error", message: "a" }),
				testDiagnostic({ severity: "warning", message: "b" }),
				testDiagnostic({ severity: "error", message: "c" }),
			])

			expect(counts).toEqual({ errors: 2, warnings: 1 })
		})
	})

	describe("colour support", () => {
		let tty = { isTTY: true } as NodeJS.WriteStream
		let pipe = { isTTY: false } as NodeJS.WriteStream

		it("follows the terminal by default", () => {
			expect(supportsColor("auto", tty, {})).toBe(true)
			expect(supportsColor("auto", pipe, {})).toBe(false)
		})

		it("honours NO_COLOR", () => {
			expect(supportsColor("auto", tty, { NO_COLOR: "1" })).toBe(false)
		})

		it("honours FORCE_COLOR", () => {
			expect(supportsColor("auto", pipe, { FORCE_COLOR: "1" })).toBe(true)
			expect(supportsColor("auto", pipe, { FORCE_COLOR: "0" })).toBe(
				false,
			)
		})

		it("treats a dumb terminal as colourless", () => {
			expect(supportsColor("auto", tty, { TERM: "dumb" })).toBe(false)
		})

		// An explicit flag outranks both the environment and the terminal.
		it("lets the flags override everything", () => {
			expect(supportsColor("always", pipe, { NO_COLOR: "1" })).toBe(true)
			expect(supportsColor("never", tty, { FORCE_COLOR: "1" })).toBe(
				false,
			)
		})

		it("maps flags to a choice", () => {
			expect(colorChoiceFor({ color: false, noColor: false })).toBe(
				"auto",
			)
			expect(colorChoiceFor({ color: true, noColor: false })).toBe(
				"always",
			)
			expect(colorChoiceFor({ color: true, noColor: true })).toBe("never")
		})

		it("emits nothing when colour is off", () => {
			let palette = createPalette(createTheme(false, true))

			expect(palette.error("boom")).toBe("boom")
		})

		it("emits escapes when colour is on", () => {
			let palette = createPalette(createTheme(true, true))

			expect(stripAnsi(palette.error("boom"))).toBe("boom")
			expect(palette.error("boom")).not.toBe("boom")
		})

		it("falls back to ASCII symbols without Unicode", () => {
			expect(createTheme(false, false).symbols.success).toBe("+")
			expect(createTheme(false, true).symbols.success).toBe("✔")
		})

		it("reads the locale for Unicode support", () => {
			expect(supportsUnicode({ LANG: "en_US.UTF-8" }, "darwin")).toBe(
				true,
			)
			expect(supportsUnicode({ LANG: "C" }, "darwin")).toBe(false)
		})
	})

	describe("terminal", () => {
		it("treats CI as non-interactive", () => {
			let tty = { isTTY: true } as NodeJS.WriteStream

			expect(isInteractive(tty, {})).toBe(true)
			expect(isInteractive(tty, { CI: "true" })).toBe(false)
		})

		it("leaves short lines alone", () => {
			expect(truncate("hello", 20)).toBe("hello")
		})

		it("truncates by visible width, ignoring escapes", () => {
			let palette = createPalette(createTheme(true, true))
			let truncated = truncate(palette.error("abcdefghij"), 5)

			expect(visibleLength(truncated)).toBeLessThanOrEqual(5)
		})

		// A terminal with no known width reports zero columns, which must not truncate
		// every line.
		it("does not truncate when the width is unknown", () => {
			expect(truncate("hello", 0)).toBe("hello")
		})
	})

	describe("JSON report", () => {
		it("flattens Diagnostics to plain positions", () => {
			let report = toJSONReport(
				[
					outcome({
						ok: false,
						diagnostics: [
							testDiagnostic({
								severity: "error",
								message: "Broken.",
								code: "unknown-name",
								position: {
									start: { line: 3, column: 5 },
									end: { line: 3, column: 9 },
								},
							}),
						],
					}),
				],
				{ command: "check", version: "1.2.3", duration: 20 },
			)

			expect(report.ok).toBe(false)
			expect(report.errors).toBe(1)
			expect(report.warnings).toBe(0)
			expect(report.files[0].diagnostics[0]).toEqual({
				file: "Source.es",
				severity: "error",
				message: "Broken.",
				code: "unknown-name",
				line: 3,
				column: 5,
				endLine: 3,
				endColumn: 9,
			})
		})

		it("reports a Diagnostic without a Position as having none", () => {
			let report = toJSONReport(
				[
					outcome({
						ok: false,
						diagnostics: [
							testDiagnostic({
								severity: "error",
								message: "No idea.",
							}),
						],
					}),
				],
				{ command: "build", version: "1.2.3", duration: 1 },
			)

			expect(report.files[0].diagnostics[0].line).toBe(null)
			expect(report.files[0].diagnostics[0].code).toBe("internal-error")
		})

		it("keeps stage timings", () => {
			let report = toJSONReport([outcome()], {
				command: "build",
				version: "1.2.3",
				duration: 20,
			})

			expect(report.files[0].stages).toEqual({ parse: 1.5 })
			expect(report.files[0].bytes).toBe(2048)
			expect(report.ok).toBe(true)
		})
	})
})

// The CLI and the Language Server agree about a file, since both route
// through `documents.ts`. So `esc check` accepts a standard library source's
// `declarations` header, as the Editor does.
describe("CLI on a standard library source", () => {
	it("checks a standard library source without Diagnostics", async () => {
		let fileNames = readdirSync(STDLIB_DIRECTORY).filter((fileName) =>
			fileName.endsWith(".es"),
		)

		expect(fileNames.length).toBeGreaterThan(0)

		for (let fileName of fileNames) {
			let outcome = await compileFile({
				inputFileName: path.resolve(STDLIB_DIRECTORY, fileName),
				outputFileName: null,
				minify: false,
				sourcemap: false,
			})

			expect([fileName, outcome.diagnostics]).toEqual([fileName, []])
			expect([fileName, outcome.ok]).toEqual([fileName, true])
		}
	})

	// A test compile is what runs a source's `@example` blocks. A source that
	// declares a Protocol with provided Methods declares one the prelude
	// already carries, and the two must not be named twice.
	it("compiles every standard library source for its tests", async () => {
		let fileNames = readdirSync(STDLIB_DIRECTORY).filter((fileName) =>
			fileName.endsWith(".es"),
		)

		// Written out, since a compile that emits nothing never rewrites.
		let directory = mkdtempSync(path.join(tmpdir(), "essence-stdlib-tests-"))

		try {
			for (let fileName of fileNames) {
				let outcome = await compileFile({
					inputFileName: path.resolve(STDLIB_DIRECTORY, fileName),
					outputFileName: path.join(directory, `${fileName}.js`),
					minify: false,
					sourcemap: false,
					tests: true,
				})

				expect([fileName, outcome.diagnostics]).toEqual([fileName, []])
				expect([fileName, outcome.ok]).toEqual([fileName, true])
			}
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})

	// Only the standard library may open with `declarations { … }`; the CLI rejects
	// it elsewhere, as the Editor does.
	it("still rejects a 'declarations' header outside the standard library", async () => {
		let filePath = path.resolve(
			tmpdir(),
			`essence-declarations-${process.pid}.es`,
		)

		writeFileSync(filePath, "declarations {\n\tnamespace Empty {}\n}\n")

		try {
			let outcome = await compileFile({
				inputFileName: filePath,
				outputFileName: null,
				minify: false,
				sourcemap: false,
			})

			expect(
				outcome.diagnostics.map((diagnostic) => diagnostic.code),
			).toContain("declarations-outside-stdlib")
		} finally {
			rmSync(filePath, { force: true })
		}
	})
})

// One binary is installed as `essence` and `esc`, and every name exposes every
// Command. The invoked name is threaded through every line printed.
describe("the name the binary was invoked as", () => {
	it("says essence when it was invoked as essence", async () => {
		let { code, out } = await capture(() => run(["help"], "essence"))

		expect(code).toBe(0)
		expect(out).toContain("essence <command> [file...] [options]")
		expect(out).toContain("essence help <command>")
		expect(out).not.toMatch(/\besc\b/)
	})

	it("says esc when it was invoked as esc", async () => {
		let { code, out } = await capture(() => run(["help"], "esc"))

		expect(code).toBe(0)
		expect(out).toContain("esc <command> [file...] [options]")
		expect(out).not.toMatch(/\bessence\b/)
	})

	// A caller that names no program gets `esc`, so specs and scripts can drive the
	// CLI directly.
	it("defaults to esc when nobody says", async () => {
		let { code, out } = await capture(() => run(["help"]))

		expect(code).toBe(0)
		expect(out).toContain("esc <command> [file...] [options]")
		expect(out).not.toMatch(/\bessence\b/)
	})

	it("names the invoked program in a usage error", async () => {
		let { code, err } = await capture(() =>
			run(["build", "--nonsense", "a.es"], "essence"),
		)

		expect(code).toBe(2)
		expect(err).toContain('Unknown option "--nonsense" for essence build.')
		expect(err).toContain("essence help build")
		expect(err).toContain("essence build <file...> [options]")
		expect(err).not.toMatch(/\besc\b/)
	})

	// A usage error outside any Command still names the program, and comes as JSON
	// when asked.
	it("names the invoked program in a JSON usage error", async () => {
		let { code, out } = await capture(() =>
			run(["buld", "--json"], "essence"),
		)

		expect(code).toBe(2)
		expect(JSON.parse(out).command).toBe("essence")
	})
})

describe("essence format", () => {
	// Both forms are one screen from esc's own Command table, and
	// `essence lsp --help` must not start a Server.
	it("answers help the same way through help format and format --help", async () => {
		let viaHelp = await capture(() => run(["help", "format"], "essence"))
		let viaFlag = await capture(() => run(["format", "--help"], "essence"))

		expect(viaHelp.code).toBe(0)
		expect(viaFlag.code).toBe(0)
		expect(viaFlag.out).toBe(viaHelp.out)
		expect(viaHelp.out).toContain("essence format <files...> [options]")
		expect(viaHelp.out).toContain("--stdin-filepath <path>")
		expect(viaHelp.out).not.toContain("GLOBAL OPTIONS")
	})

	it("accepts a formatted source", async () => {
		let { code } = await capture(() =>
			run(["format", "--check", fixturePath("HelloWorld.es")], "essence"),
		)

		expect(code).toBe(0)
	})

	// `--check` is the Formatter's flag, which only a passthrough delivers intact.
	it("reports an unformatted source without reading --check itself", async () => {
		let filePath = path.resolve(
			tmpdir(),
			`essence-format-${process.pid}.es`,
		)

		writeFileSync(
			filePath,
			'implementation {\n  Terminal.inspect("hi")\n}\n',
		)

		try {
			let { code, out } = await capture(() =>
				run(["format", "--check", filePath], "essence"),
			)

			expect(code).toBe(1)
			expect(out).toContain(`essence-format-${process.pid}.es`)
			expect(readFileSync(filePath, "utf8")).toContain(
				'  Terminal.inspect("hi")',
			)
		} finally {
			rmSync(filePath, { force: true })
		}
	})

	it("formats a source in place through the fmt alias", async () => {
		let filePath = path.resolve(tmpdir(), `essence-fmt-${process.pid}.es`)

		writeFileSync(
			filePath,
			'implementation {\n  Terminal.inspect("hi")\n}\n',
		)

		try {
			let { code } = await capture(() =>
				run(["fmt", filePath], "essence"),
			)

			expect(code).toBe(0)
			expect(readFileSync(filePath, "utf8")).toBe(
				'implementation {\n\tTerminal.inspect("hi")\n}\n',
			)
		} finally {
			rmSync(filePath, { force: true })
		}
	})
})

// No spec starts the Server, which holds stdio open until the other end closes.
// This only checks that asking about it does not start it.
describe("essence lsp", () => {
	it("documents itself without starting a Server", async () => {
		let { code, out } = await capture(() => run(["help", "lsp"], "essence"))

		expect(code).toBe(0)
		expect(out).toContain("essence lsp")
		expect(out).toContain("Language Server Protocol")
		expect(out).not.toContain("GLOBAL OPTIONS")
	})
})

// The same holds for the Debug Adapter.
describe("essence dap", () => {
	it("documents itself without starting an Adapter", async () => {
		let { code, out } = await capture(() => run(["help", "dap"], "essence"))

		expect(code).toBe(0)
		expect(out).toContain("essence dap")
		expect(out).toContain("Debug Adapter Protocol")
		expect(out).not.toContain("GLOBAL OPTIONS")
	})
})

// Installs what an abandoned hijack leaves, without timing a test out. The next
// test asserts that the `afterEach` restored the globals.
describe("an abandoned output hijack", () => {
	it("leaves the globals held, as a timed-out test would", () => {
		console.log = (() => {}) as typeof console.log
		process.stdout.write = (() => true) as typeof process.stdout.write
		process.stderr.write = (() => true) as typeof process.stderr.write

		expect(console.log).not.toBe(originalLog)
	})

	it("hands the next test the real ones back", () => {
		expect(console.log).toBe(originalLog)
		expect(process.stdout.write).toBe(originalStandardOut)
		expect(process.stderr.write).toBe(originalStandardError)
	})
})

// `essence check` must not load tools it never calls, so the Formatter, the
// Language Server and the Debug Adapter are imported at their point of use.
describe("delegation stays lazy", () => {
	let sourceDirectory = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
	)

	it("imports the delegates nowhere statically", () => {
		let fileNames = readdirSync(sourceDirectory).filter((fileName) =>
			fileName.endsWith(".ts"),
		)

		expect(fileNames.length).toBeGreaterThan(0)

		for (let fileName of fileNames) {
			let source = readFileSync(
				path.resolve(sourceDirectory, fileName),
				"utf8",
			)

			expect([
				fileName,
				/from\s+"@essence-lang\/(?:formatter|language-server|debug-adapter)/.test(
					source,
				),
			]).toEqual([fileName, false])
		}
	})

	it("reaches them through a dynamic import instead", () => {
		let source = readFileSync(
			path.resolve(sourceDirectory, "index.ts"),
			"utf8",
		)

		expect(source).toContain('await import("@essence-lang/formatter/cli")')
		expect(source).toContain(
			'await import("@essence-lang/language-server")',
		)
		expect(source).toContain('await import("@essence-lang/debug-adapter")')
	})
})

// A Module graph belongs to a directory, so a test that needs one writes it
// outside the repository and removes it afterwards.
async function withModules<Value>(
	files: Record<string, string>,
	body: (directory: string) => Promise<Value>,
): Promise<Value> {
	let directory = mkdtempSync(path.join(tmpdir(), "esc-modules-"))

	try {
		for (let [fileName, source] of Object.entries(files)) {
			let filePath = path.join(directory, fileName)

			mkdirSync(path.dirname(filePath), { recursive: true })
			writeFileSync(filePath, source)
		}

		return await body(directory)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

function captureTerminal(): { terminal: Terminal; lines: Array<string> } {
	let lines: Array<string> = []

	return {
		lines,
		terminal: {
			stdout: process.stdout,
			stderr: process.stderr,
			isInteractive: false,
			width: 80,
			out: (text: string) => {
				lines.push(text)
			},
			err: () => {},
		},
	}
}

// One job, so a test compiles in this process without booting a worker.
function testOptions(overrides: Partial<OptionValues> = {}): OptionValues {
	return {
		help: false,
		version: false,
		verbose: false,
		quiet: false,
		json: false,
		color: false,
		noColor: true,
		out: undefined,
		watch: false,
		execute: false,
		clear: false,
		sourcemap: false,
		noSourcemap: false,
		minify: false,
		noMinify: false,
		embed: false,
		noEmbed: false,
		tests: false,
		noOptimise: false,
		withoutOptimisation: [],
		jobs: 1,
		filter: undefined,
		tag: [],
		skipTag: [],
		coverage: false,
		coverageReport: null,
		coverageOut: undefined,
		mutate: false,
		mutationLimit: null,
		strict: false,
		bench: false,
		contracts: false,
		noContracts: false,
		update: false,
		seed: undefined,
		cases: null,
		...overrides,
	}
}

async function checkAsJSON(files: Array<string>): Promise<JSONReport> {
	let { terminal, lines } = captureTerminal()
	let context = createContext(testOptions({ json: true }), "esc", terminal)

	await runCheck(
		context,
		findCommand("check") as NonNullable<ReturnType<typeof findCommand>>,
		files,
	)

	return JSON.parse(lines.join("\n")) as JSONReport
}

function plainReport() {
	let theme = createTheme(false, false)

	return {
		terminal: captureTerminal().terminal,
		theme,
		palette: createPalette(theme),
		verbose: false,
		quiet: false,
	}
}

// The bundle is imported rather than spawned, since a child would write to the
// test runner's streams. Both of a Program's outputs go to one buffer in order:
// `Terminal.inspect` writes through `console.log`, and `Terminal.print` and
// `Terminal.write` through the stream.
async function runBundle(fileName: string): Promise<Array<string>> {
	let written = ""
	let log = console.log
	let out = process.stdout.write

	console.log = (...values: Array<unknown>) => {
		written += `${values.map((value) => String(value)).join(" ")}\n`
	}

	process.stdout.write = ((chunk: unknown) => {
		written += String(chunk)

		return true
	}) as typeof process.stdout.write

	try {
		await import(fileName)
	} finally {
		console.log = log
		process.stdout.write = out
	}

	return written === "" ? [] : written.replace(/\n$/, "").split("\n")
}

const brokenDependency = {
	"Dep.es": [
		"implementation {",
		"",
		"\tfunction halve(_ amount: Integer) -> Integer {",
		'\t\t<- "not a Number"',
		"\t}",
		"}",
		"",
		"export {",
		"\thalve",
		"}",
		"",
	].join("\n"),
	"Main.es": [
		"import {",
		'\tfrom "./Dep.es" { halve }',
		"}",
		"",
		"implementation {",
		"",
		"\tTerminal.inspect(halve(4)::toString())",
		"}",
		"",
	].join("\n"),
}

const sharedDependency = {
	"Dep.es": [
		"implementation {",
		"",
		"\tfunction halve(_ amount: Integer) -> Integer {",
		"\t\t<- amount::divide(by 2)::round(toward #TowardZero)",
		"\t}",
		"}",
		"",
		"export {",
		"\thalve",
		"}",
		"",
	].join("\n"),
	"Main.es": [
		"import {",
		'\tfrom "./Dep.es" { halve }',
		"}",
		"",
		"implementation {",
		"",
		"\tTerminal.inspect(halve(9)::toString())",
		"}",
		"",
	].join("\n"),
}

describe("CLI on a Module graph", () => {
	// The whole graph as one bundle, run: five files, a cycle and a Namespace reached
	// only by implicit dispatch. Three lines of output show each Module body ran once.
	it("compiles the Module fixtures into one standalone file and runs it", async () => {
		let directory = mkdtempSync(path.join(tmpdir(), "esc-bundle-"))

		try {
			let outputFileName = path.join(directory, "Main.js")
			let compiled = await compileFile({
				inputFileName: fixturePath("modules", "Main.es"),
				outputFileName,
				minify: false,
				sourcemap: false,
			})

			expect(compiled.diagnostics).toEqual([])
			expect(compiled.ok).toBe(true)
			expect(
				compiled.modules.map((module) =>
					path.basename(module.fileName),
				),
			).toEqual(["A.es", "B.es", "Geometry.es", "Math.es", "Main.es"])
			expect(readdirSync(directory)).toEqual(["Main.js"])

			let emitted = readFileSync(outputFileName, "utf8")

			// Standalone: the runtime is inlined, and nothing resolves at run time.
			expect(emitted).not.toMatch(/^import\s/m)
			expect(emitted).not.toContain("require(")

			// The Bundler labels each inlined Module with its specifier, so the labels show
			// five Modules and one prelude, one copy each.
			expect(
				[...emitted.matchAll(/^\/\/ (essence:\S+)$/gm)].map(
					(match) => match[1],
				),
			).toEqual([
				"essence:$prelude",
				"essence:./B.es",
				"essence:./A.es",
				"essence:./Geometry.es",
				"essence:./math/Math.es",
				"essence:./Main.es",
			])

			expect(await runBundle(outputFileName)).toEqual([
				"area: 12",
				"25",
				"157",
			])
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})

	// A Diagnostic renders against the source it was reported in, so every Module
	// carries its own source through the outcome.
	it("reports a dependency's Diagnostics under the dependency's own name", async () => {
		await withModules(brokenDependency, async (directory) => {
			let outcome = await compileFile({
				inputFileName: path.join(directory, "Main.es"),
				outputFileName: null,
				minify: false,
				sourcemap: false,
			})

			expect(outcome.ok).toBe(false)
			expect(
				outcome.modules.map((module) => path.basename(module.fileName)),
			).toEqual(["Dep.es", "Main.es"])

			let [dependency, entry] = outcome.modules

			expect(
				dependency?.diagnostics.map((diagnostic) => diagnostic.code),
			).toEqual(["return-type-mismatch"])
			// The entry's own Diagnostic says why it did not compile, over the import, as
			// the Editor shows it.
			expect(
				entry?.diagnostics.map((diagnostic) => diagnostic.code),
			).toEqual(["dependency-has-errors"])
			expect(outcome.diagnostics).toHaveLength(2)

			let rendered = stripAnsi(
				renderDiagnosticsFor(outcome, plainReport()) ?? "",
			)

			expect(rendered).toContain("Dep.es")
			expect(rendered).toContain('<- "not a Number"')
			expect(rendered).not.toContain("Terminal.inspect")
		})
	})

	// `esc check Dep.es Main.es`, where the second imports the first. Both compile,
	// but the shared file is reported once, by the outcome that owns it.
	it("reports a file that is both an entry and a dependency exactly once", async () => {
		await withModules(brokenDependency, async (directory) => {
			let report = await checkAsJSON([
				path.join(directory, "Dep.es"),
				path.join(directory, "Main.es"),
			])

			expect(report.ok).toBe(false)
			expect(report.files).toHaveLength(2)

			let diagnostics = report.files.flatMap((file) => file.diagnostics)

			// Dep.es's mistake once, and Main.es's own answer for why it did not compile.
			expect(
				diagnostics.map((diagnostic) => [
					path.basename(diagnostic.file),
					diagnostic.code,
				]),
			).toEqual([
				["Dep.es", "return-type-mismatch"],
				["Main.es", "dependency-has-errors"],
			])
			expect(report.errors).toBe(2)
			expect(report.files.map((file) => file.ok)).toEqual([false, false])
		})
	})

	// A Diagnostic belongs to the file it was written in, often not the compiled
	// one.
	it("names the file each Diagnostic was written in under --json", async () => {
		await withModules(brokenDependency, async (directory) => {
			let report = await checkAsJSON([path.join(directory, "Main.es")])

			expect(report.files).toHaveLength(1)
			expect(path.basename(report.files[0]!.input)).toBe("Main.es")
			expect(
				report.files[0]!.diagnostics.map((diagnostic) => [
					path.basename(diagnostic.file),
					diagnostic.line,
				]),
			).toEqual([
				["Dep.es", 4],
				["Main.es", 2],
			])
		})
	})

	// The entry reaches the broken file only through a facade, and still reports on
	// the import leading there.
	it("reports a dependency broken behind a re-export on the entry", async () => {
		await withModules(
			{
				"Dep.es": brokenDependency["Dep.es"],
				"Facade.es": [
					"implementation {}",
					"",
					"export {",
					'\tfrom "./Dep.es" { halve }',
					"}",
					"",
				].join("\n"),
				"Main.es": brokenDependency["Main.es"].replace(
					"./Dep.es",
					"./Facade.es",
				),
			},
			async (directory) => {
				let report = await checkAsJSON([
					path.join(directory, "Main.es"),
				])

				expect(report.ok).toBe(false)
				expect(
					report.files[0]!.diagnostics.map((diagnostic) => [
						path.basename(diagnostic.file),
						diagnostic.code,
						diagnostic.message,
					]),
				).toEqual([
					[
						"Dep.es",
						"return-type-mismatch",
						"This value does not fit the declared return Type",
					],
					[
						"Facade.es",
						"dependency-has-errors",
						"./Dep.es has errors of its own",
					],
					[
						"Main.es",
						"dependency-has-errors",
						"./Facade.es has errors of its own",
					],
				])
			},
		)
	})

	// Both files built in one invocation share the dependency's typed Program, which
	// is emitted twice and simplified once.
	it("emits a Module twice over without simplifying it twice", async () => {
		await withModules(sharedDependency, async (directory) => {
			let session = createCompileSession([
				path.join(directory, "Main.es"),
				path.join(directory, "Dep.es"),
			])
			let compile = (fileName: string) =>
				compileFile(
					{
						inputFileName: path.join(directory, `${fileName}.es`),
						outputFileName: path.join(directory, `${fileName}.js`),
						minify: false,
						sourcemap: false,
					},
					undefined,
					session,
				)

			let main = await compile("Main")
			let dependency = await compile("Dep")

			expect(main.diagnostics).toEqual([])
			expect(dependency.diagnostics).toEqual([])
			expect(dependency.ok).toBe(true)

			expect(await runBundle(path.join(directory, "Main.js"))).toEqual([
				'"4"',
			])
		})
	})

	// Which entries a worker gets together: an entry importing another shares its
	// worker, and an unrelated file may go anywhere.
	it("gathers the entries whose graphs overlap", async () => {
		await withModules(
			{
				...brokenDependency,
				"Other.es": ["implementation {", "}", ""].join("\n"),
			},
			async (directory) => {
				let groups = groupEntries([
					path.join(directory, "Main.es"),
					path.join(directory, "Other.es"),
					path.join(directory, "Dep.es"),
				]).map((group) =>
					group.map((fileName) => path.basename(fileName)).sort(),
				)

				expect(groups).toHaveLength(2)
				expect(groups).toContainEqual(["Dep.es", "Main.es"])
				expect(groups).toContainEqual(["Other.es"])
			},
		)
	})
})

// The optimisation flags must reach the Compiler, so this builds a real fixture
// through `compileFile` and reads the output.
describe("the optimisation Options", () => {
	async function build(
		optimisation: CompileRequest["optimisation"],
	): Promise<{ emitted: string; printed: Array<string> }> {
		let directory = mkdtempSync(path.join(tmpdir(), "esc-optimise-"))

		try {
			let outputFileName = path.join(directory, "Loops.js")
			let compiled = await compileFile({
				inputFileName: fixturePath("Loops.es"),
				outputFileName,
				minify: false,
				sourcemap: false,
				optimisation,
			})

			expect(compiled.diagnostics).toEqual([])
			expect(compiled.ok).toBe(true)

			return {
				emitted: readFileSync(outputFileName, "utf8"),
				printed: await runBundle(outputFileName),
			}
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	}

	// Only the Program's own emission is checked, since the inlined runtime
	// calls `createList` however the Program compiled. The bundler labels each
	// inlined module and emits the entry last, after the final label.
	function userModuleOf(emitted: string): string {
		let start = emitted.lastIndexOf("// essence:")

		expect(start).toBeGreaterThan(-1)

		return emitted.slice(start)
	}

	it("optimises when nothing is said", async () => {
		let { emitted } = await build(undefined)
		let program = userModuleOf(emitted)

		expect(program).not.toContain("createRecord(")
		expect(program).not.toContain("createList(")
		expect(program).not.toContain("Object.assign(")
	})

	it("emits the Program as written with the phase off", async () => {
		let optimised = await build(undefined)
		let plain = await build({
			enabled: false,
			disabledPasses: new Set(),
		})

		expect(plain.emitted).toContain("createRecord(")
		expect(plain.emitted).toContain("createList(")
		expect(plain.emitted).toContain("Object.assign(")
		expect(plain.printed).toEqual(optimised.printed)
	})

	it("turns one named pass off and leaves the rest running", async () => {
		let optimised = await build(undefined)
		let partial = await build({
			enabled: true,
			disabledPasses: new Set(["collapse-construction"]),
		})

		expect(partial.emitted).toContain("createRecord(")
		// The pass not named still ran, read off the Program's own emission.
		expect(userModuleOf(partial.emitted)).not.toContain("Object.assign(")
		expect(partial.printed).toEqual(optimised.printed)
	})
})

// What a debug session builds, driven directly rather than through a spawned
// adapter.
describe("the Debug Adapter's compile", () => {
	it("emits the Program as written", async () => {
		let directory = mkdtempSync(path.join(tmpdir(), "esc-dap-"))

		try {
			let outputFileName = path.join(directory, "Loops.js")
			let result = await debugAdapterCompile()(
				fixturePath("Loops.es"),
				outputFileName,
			)

			expect(result.diagnostics).toEqual([])
			expect(result.ok).toBe(true)
			expect(result.bundlePath).toBe(outputFileName)

			let emitted = readFileSync(outputFileName, "utf8")

			// The shapes the passes would remove all remain, since a debugger steps through
			// Statements and reads bindings.
			expect(emitted).toContain("createRecord(")
			expect(emitted).toContain("createList(")
			expect(emitted).toContain("Object.assign(")
			expect(emitted).not.toContain("$pool_")
			expect(emitted).not.toContain("$loop_")
			// It still runs and prints what an optimised build prints.
			expect(await runBundle(outputFileName)).toEqual([
				"55",
				"321",
				"15",
				"128",
				"128",
				"15",
				"2",
			])
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})
})

// `build` writes the map beside the output, and `run` inlines it, since its
// scratch output is deleted when the program exits. Either way the map holds
// only Essence sources.
describe("source maps", () => {
	it("adds --enable-source-maps exactly for Node with a map", () => {
		expect(runtimeArguments(true, false)).toEqual(["--enable-source-maps"])
		expect(runtimeArguments(true, true)).toEqual([])
		expect(runtimeArguments(false, false)).toEqual([])
		expect(runtimeArguments(false, true)).toEqual([])
	})

	it("writes a linked map holding only Essence sources beside the output", async () => {
		let directory = mkdtempSync(path.join(tmpdir(), "essence-sourcemap-"))

		try {
			let outputFileName = path.join(directory, "HelloWorld.js")
			let outcome = await compileFile({
				inputFileName: fixturePath("HelloWorld.es"),
				outputFileName,
				minify: false,
				sourcemap: true,
			})

			expect(outcome.ok).toBe(true)

			let map = JSON.parse(
				readFileSync(`${outputFileName}.map`, "utf-8"),
			) as { sources: Array<string>; sourcesContent: Array<string> }

			expect(map.sources.length).toBeGreaterThan(0)
			expect(
				map.sources.filter((source) => !source.endsWith(".es")),
			).toEqual([])
			expect(readFileSync(outputFileName, "utf-8")).toContain(
				"sourceMappingURL=HelloWorld.js.map",
			)
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})

	it("rides the map inside the bundle when asked to", async () => {
		let directory = mkdtempSync(path.join(tmpdir(), "essence-sourcemap-"))

		try {
			let outputFileName = path.join(directory, "HelloWorld.js")
			let outcome = await compileFile({
				inputFileName: fixturePath("HelloWorld.es"),
				outputFileName,
				minify: false,
				sourcemap: true,
				sourcemapMode: "inline",
			})

			expect(outcome.ok).toBe(true)
			expect(existsSync(`${outputFileName}.map`)).toBe(false)
			expect(readFileSync(outputFileName, "utf-8")).toContain(
				"sourceMappingURL=data:application/json;base64,",
			)
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})
})

// `--embed` builds a Module for a JavaScript host to load, with the runtime
// bridge inside and a Descriptor beside it. `loadPrebuilt`'s own spec loads the
// pair; this only checks `esc` writes both.
describe("essence build --embed", () => {
	// A Module of its own, since importing a fixture program would run it and print.
	const embeddable = {
		"Doubling.es": [
			"implementation {",
			"",
			"\tfunction doubled(_ value: Integer) -> Integer {",
			"\t\t<- value::multiply(with 2)",
			"\t}",
			"}",
			"",
			"export {",
			"\tdoubled",
			"}",
			"",
		].join("\n"),
	}

	// The rule on this side. `descriptorPath` states it in the client, whose spec
	// holds the two together.
	it("names the Descriptor after the bundle", () => {
		expect(descriptorFileName("dist/app.js")).toBe(
			"dist/app.descriptor.json",
		)
		expect(descriptorFileName("/build/app.mjs")).toBe(
			"/build/app.descriptor.json",
		)
		// A dot in a directory is no extension, and a name that is only an extension has
		// nothing to replace.
		expect(descriptorFileName("/opt/v1.2/app")).toBe(
			"/opt/v1.2/app.descriptor.json",
		)
		expect(descriptorFileName("/build/.app")).toBe(
			"/build/.app.descriptor.json",
		)
	})

	it("writes the Descriptor beside a bundle carrying the bridge", async () => {
		await withModules(embeddable, async (directory) => {
			let outputFileName = path.join(directory, "out", "Doubling.mjs")
			let outcome = await compileFile({
				inputFileName: path.join(directory, "Doubling.es"),
				outputFileName,
				minify: false,
				sourcemap: false,
				embed: true,
			})

			expect(outcome.ok).toBe(true)
			expect(readdirSync(path.dirname(outputFileName)).sort()).toEqual([
				"Doubling.descriptor.json",
				"Doubling.mjs",
			])

			let descriptor = JSON.parse(
				readFileSync(descriptorFileName(outputFileName), "utf8"),
			) as { exports: Record<string, { kind: string; emitted: string }> }

			expect(descriptor.exports.doubled?.kind).toBe("function")

			// The bundle itself, imported: the bridge is its default export, recognised by
			// its Type key.
			let bundle = (await import(
				pathToFileURL(outputFileName).href
			)) as Record<string, { typeKey?: symbol }>

			expect(typeof bundle.default?.typeKey).toBe("symbol")
			expect(bundle.default?.typeKey?.description).toBe("$type")
			expect(
				bundle[descriptor.exports.doubled?.emitted ?? ""],
			).toBeTypeOf("function")
		})
	})

	// A graph, so the Descriptor must describe the entry rather than the last linked
	// Module. Both files export a name, so picking the wrong one would still compile.
	it("describes the entry rather than something it imports", async () => {
		await withModules(
			{
				"Dep.es": [
					"implementation {",
					"",
					"\tfunction halved(_ value: Integer) -> Integer {",
					"\t\t<- value::divide(by 2)::round(toward #TowardZero)",
					"\t}",
					"}",
					"",
					"export {",
					"\thalved",
					"}",
					"",
				].join("\n"),
				"Main.es": [
					"import {",
					'\tfrom "./Dep.es" { halved }',
					"}",
					"",
					"implementation {",
					"",
					"\tfunction quartered(_ value: Integer) -> Integer {",
					"\t\t<- halved(halved(value))",
					"\t}",
					"}",
					"",
					"export {",
					"\tquartered",
					"}",
					"",
				].join("\n"),
			},
			async (directory) => {
				let outputFileName = path.join(directory, "out", "Main.mjs")
				let outcome = await compileFile({
					inputFileName: path.join(directory, "Main.es"),
					outputFileName,
					minify: false,
					sourcemap: false,
					embed: true,
				})

				expect(outcome.ok).toBe(true)

				let descriptor = JSON.parse(
					readFileSync(descriptorFileName(outputFileName), "utf8"),
				) as { exports: Record<string, unknown> }

				expect(Object.keys(descriptor.exports)).toEqual(["quartered"])
			},
		)
	})

	// Off by default: nothing extra is written or bundled.
	it("leaves a build that did not ask for it alone", async () => {
		await withModules(embeddable, async (directory) => {
			let outputFileName = path.join(directory, "out", "Doubling.mjs")
			let outcome = await compileFile({
				inputFileName: path.join(directory, "Doubling.es"),
				outputFileName,
				minify: false,
				sourcemap: false,
			})

			expect(outcome.ok).toBe(true)
			expect(readdirSync(path.dirname(outputFileName))).toEqual([
				"Doubling.mjs",
			])

			let bundle = (await import(
				pathToFileURL(outputFileName).href
			)) as Record<string, unknown>

			expect(bundle.default).toBeUndefined()
		})
	})
})

describe("essence run", () => {
	// `--out` may name a directory, so what runs is the bundle the Compiler wrote
	// into it.
	it("executes the bundle it wrote into an --out directory", async () => {
		await withModules(
			{ "Quiet.es": 'implementation {\n\tTerminal.write("")\n}\n' },
			async (directory) => {
				let outDirectory = path.join(directory, "out")

				mkdirSync(outDirectory)

				let context = createContext(
					testOptions({
						quiet: true,
						out: outDirectory + path.sep,
					}),
					"essence",
					captureTerminal().terminal,
				)

				let code = await runRun(
					context,
					runCommand,
					[path.join(directory, "Quiet.es")],
					[],
				)

				expect(code).toBe(EXIT_SUCCESS)
				expect(existsSync(path.join(outDirectory, "Quiet.js"))).toBe(
					true,
				)
			},
		)
	})

	// `--json` changes only how the compile is reported: the exit code is still the
	// program's. The program overflows the stack at run time, so a non-zero exit
	// means it ran. It runs as a child with captured streams, so the stack trace is
	// asserted rather than printed into this suite's output.
	it("still executes the program and answers its exit code under --json", async () => {
		await withModules(
			{
				"Overflow.es": [
					"implementation {",
					"\tfunction deepen(_ n: Integer) -> Integer {",
					"\t\tif n::isGreaterThan(0) {",
					"\t\t\t<- deepen(n::add(1))::add(0)",
					"\t\t} else {",
					"\t\t\t<- 0",
					"\t\t}",
					"\t}",
					"",
					"\tTerminal.write(deepen(1)::toString())",
					"}",
					"",
				].join("\n"),
			},
			async (directory) => {
				let binary = fileURLToPath(
					import.meta.resolve("../../bin/essence"),
				)
				let result = await spawnAndWait(
					[
						process.execPath,
						binary,
						"run",
						path.join(directory, "Overflow.es"),
						"--json",
						"--no-optimise",
					],
					{ env: { ...process.env } },
				)

				let report = JSON.parse(result.stdout) as JSONReport

				expect(report.command).toBe("run")
				expect(report.ok).toBe(true)
				expect(result.stderr).toContain(
					"Maximum call stack size exceeded",
				)
				expect(result.code).not.toBe(EXIT_SUCCESS)
			},
		)
	})

	// A Module whose top level waits, and an entry reading what it waited for.
	// Emitted Modules are ESM, so the importer awaits the top-level `await`.
	it("waits for a Module whose top level completes before the entry runs", async () => {
		await withModules(
			{
				"Store.es": [
					"implementation {",
					"\tconstant loaded = complete Async.deferred(() {",
					'\t\tTerminal.print("the Module waited")',
					"",
					"\t\t<- 7",
					"\t})",
					"",
					"\tfunction held() -> Integer {",
					"\t\t<- loaded",
					"\t}",
					"}",
					"",
					"export {",
					"\theld",
					"}",
					"",
				].join("\n"),
				"Main.es": [
					"import {",
					'\tfrom "./Store.es" { held }',
					"}",
					"",
					"implementation {",
					'\tTerminal.print("the Program starts")',
					"\tTerminal.print(held()::toString())",
					"}",
					"",
				].join("\n"),
			},
			async (directory) => {
				let binary = fileURLToPath(
					import.meta.resolve("../../bin/essence"),
				)
				let result = await spawnAndWait(
					[
						process.execPath,
						binary,
						"run",
						path.join(directory, "Main.es"),
						"--quiet",
					],
					{ env: { ...process.env } },
				)

				expect(result.code).toBe(EXIT_SUCCESS)
				// The Program's three lines, after what the command wrote about compiling.
				expect(
					result.stdout
						.split("\n")
						.filter((line) => !line.startsWith("  ")),
				).toEqual(["the Module waited", "the Program starts", "7", ""])
			},
		)
	})

	// Only a real child shows where a program's output lands. Under `--json` it goes
	// to stderr, so `… --json | jq` still works.
	it("keeps stdout a single JSON document while the program prints under --json", async () => {
		await withModules(
			{
				"Noisy.es": [
					"implementation {",
					'\tTerminal.print("hello from the program")',
					"}",
					"",
				].join("\n"),
			},
			async (directory) => {
				let binary = fileURLToPath(
					import.meta.resolve("../../bin/essence"),
				)
				// The environment is passed explicitly, since Bun does not pass a child the
				// `process.env` assignments that name this suite's bundle cache.
				let result = await spawnAndWait(
					[
						process.execPath,
						binary,
						"run",
						path.join(directory, "Noisy.es"),
						"--json",
					],
					{ env: { ...process.env } },
				)

				let report = JSON.parse(result.stdout) as JSONReport

				expect(report.command).toBe("run")
				expect(report.ok).toBe(true)
				expect(result.stderr).toContain("hello from the program")
				expect(result.code).toBe(EXIT_SUCCESS)
			},
		)
	})
})

// The project file's reading is the Compiler's spec. This covers where a setting
// meets its flag.
describe("the project's settings against the flags", () => {
	function withSettings(
		overrides: (configuration: ProjectConfiguration) => void = () => {},
	): ProjectConfiguration {
		let configuration = defaultConfiguration()

		configuration.filePath = path.join("/project", "essence.json")
		configuration.root = "/project"
		overrides(configuration)

		return configuration
	}

	function resolve(
		argv: Array<string>,
		configuration: ProjectConfiguration = withSettings(),
	): OptionValues {
		let invocation = parseArguments(argv, "essence")

		return resolveProjectOptions(
			invocation.options,
			configuration,
			invocation.command,
		)
	}

	// Which commands read the file: not `check`, the Formatter or the servers.
	it("reads the project file for the commands it speaks to", () => {
		expect(
			commands
				.filter((command) => readsProjectConfiguration(command))
				.map((command) => command.name),
		).toEqual(["build", "run", "watch", "test", "init"])
	})

	it("takes the value a flag named, and the project's where none did", () => {
		let configuration = withSettings((settings) => {
			settings.test.cases = 250
			settings.test.coverage.report = "lcov"
			settings.test.coverage.out = "/project/reports"
		})

		expect(resolve(["test"], configuration).cases).toBe(250)
		expect(resolve(["test", "--cases", "10"], configuration).cases).toBe(10)
		expect(resolve(["test"], configuration).coverageReport).toBe("lcov")
		expect(
			resolve(["test", "--coverage-report", "json"], configuration)
				.coverageReport,
		).toBe("json")
		expect(resolve(["test"], configuration).coverageOut).toBe(
			"/project/reports",
		)
		expect(
			resolve(["test", "--coverage-out", "here"], configuration)
				.coverageOut,
		).toBe("here")
	})

	// Collecting coverage is a choice about one run. A configured format or
	// directory does not turn it on.
	it("does not turn coverage on because a format was configured", () => {
		let configuration = withSettings((settings) => {
			settings.test.coverage.report = "lcov"
		})

		expect(resolve(["test"], configuration).coverage).toBe(false)
		expect(resolve(["test", "--coverage"], configuration).coverage).toBe(
			true,
		)
		expect(
			resolve(["test", "--coverage-report", "json"], configuration)
				.coverage,
		).toBe(true)
	})

	it("turns a switch on where either says so, and --no-… off whatever", () => {
		let configuration = withSettings((settings) => {
			settings.build.sourcemap = true
			settings.build.minify = true
			settings.build.embed = true
		})

		expect(resolve(["build", "a.es"], configuration)).toMatchObject({
			sourcemap: true,
			minify: true,
			embed: true,
		})
		expect(
			resolve(
				[
					"build",
					"a.es",
					"--no-sourcemap",
					"--no-minify",
					"--no-embed",
				],
				configuration,
			),
		).toMatchObject({ sourcemap: false, minify: false, embed: false })
		expect(
			resolve(["build", "a.es", "--sourcemap", "--minify", "--embed"]),
		).toMatchObject({ sourcemap: true, minify: true, embed: true })
		expect(resolve(["build", "a.es"])).toMatchObject({
			sourcemap: false,
			minify: false,
			embed: false,
		})
	})

	it("refuses both twins of a switch", () => {
		for (let flag of ["sourcemap", "minify", "embed"]) {
			try {
				resolve(["build", "a.es", `--${flag}`, `--no-${flag}`])
				expect.unreachable()
			} catch (error) {
				expect(error).toBeInstanceOf(UsageError)
				expect((error as UsageError).message).toBe(
					`--${flag} and --no-${flag} contradict each other — say one.`,
				)
				expect((error as UsageError).command?.name).toBe("build")
			}
		}
	})

	// `--no-embed` is offered where `--embed` is, which excludes `run`.
	it("offers each way out beside the flag it undoes", () => {
		let named = (name: string) =>
			(findCommand(name) as CommandSpec).options.map(
				(option) => option.name,
			)

		expect(named("build")).toEqual(
			expect.arrayContaining(["no-sourcemap", "no-minify", "no-embed"]),
		)
		expect(named("watch")).toEqual(
			expect.arrayContaining(["no-sourcemap", "no-minify", "no-embed"]),
		)
		expect(named("run")).toEqual(
			expect.arrayContaining(["no-sourcemap", "no-minify"]),
		)
		expect(named("run")).not.toContain("no-embed")
	})

	it("leaves the Optimiser off where either says so", () => {
		let configuration = withSettings((settings) => {
			settings.build.optimise = false
		})

		expect(resolve(["build", "a.es"], configuration).noOptimise).toBe(true)
		expect(resolve(["build", "a.es"]).noOptimise).toBe(false)
		expect(resolve(["build", "a.es", "--no-optimise"]).noOptimise).toBe(
			true,
		)
	})

	it("unions the passes the project leaves out with the flag's", () => {
		let configuration = withSettings((settings) => {
			settings.build.withoutOptimisations = [
				"pool-constants",
				"fold-constants",
			]
		})

		expect(
			resolve(
				[
					"build",
					"a.es",
					"--without-optimisation",
					"fold-constants",
					"--without-optimisation",
					"inline-loops",
				],
				configuration,
			).withoutOptimisation,
		).toEqual(["fold-constants", "inline-loops", "pool-constants"])
	})

	// A configured `out` is always a directory, so it arrives with a trailing
	// separator, and a single bundle is never written as `dist`.
	it("writes bundles where the project says, as a directory", () => {
		let configuration = withSettings((settings) => {
			settings.build.out = path.resolve("/project/dist")
		})

		expect(resolve(["build", "a.es"], configuration).out).toBe(
			`${path.resolve("/project/dist")}${path.sep}`,
		)
		expect(
			resolve(["build", "a.es", "-o", "out.js"], configuration).out,
		).toBe("out.js")
		expect(resolve(["build", "a.es"]).out).toBeUndefined()
	})
})

// End to end: a bare `essence build` finds the project file by walking up from
// the working directory and obeys it.
describe("a project's build settings, end to end", () => {
	// Spawned in the directory the build starts in, not via `process.chdir`.
	// The bundler's child process keeps the working directory it started in,
	// so later builds would resolve against a removed directory.
	async function build(
		directory: string,
		essenceArguments: Array<string>,
	): Promise<{ code: number; err: string }> {
		let binary = fileURLToPath(import.meta.resolve("../../bin/essence"))
		let result = await spawnAndWait(
			[
				process.execPath,
				binary,
				"build",
				...essenceArguments,
				"--no-color",
			],
			{ cwd: directory, env: { ...process.env } },
		)

		return { code: result.code ?? 1, err: result.stderr }
	}

	it("writes where the project says, with the map it asked for", async () => {
		await withModules(
			{
				"essence.json": `{ "build": { "out": "dist", "sourcemap": true } }`,
				"Quiet.es": 'implementation {\n\tTerminal.write("")\n}\n',
			},
			async (directory) => {
				let { code, err } = await build(directory, ["Quiet.es"])
				let written = path.join(directory, "dist", "Quiet.js")

				expect([code, err]).toEqual([EXIT_SUCCESS, err])
				expect(existsSync(written)).toBe(true)
				expect(existsSync(`${written}.map`)).toBe(true)
			},
		)
	})

	// Each setting can be overridden by its negative flag.
	it("lets one run out of what the project configured", async () => {
		await withModules(
			{
				"essence.json": `{ "build": { "sourcemap": true } }`,
				"Quiet.es": 'implementation {\n\tTerminal.write("")\n}\n',
			},
			async (directory) => {
				let { code, err } = await build(directory, [
					"Quiet.es",
					"--no-sourcemap",
				])

				expect([code, err]).toEqual([EXIT_SUCCESS, err])
				expect(existsSync(path.join(directory, "Quiet.js.map"))).toBe(
					false,
				)
				expect(
					readFileSync(
						path.join(directory, "Quiet.js"),
						"utf8",
					).includes("sourceMappingURL"),
				).toBe(false)
			},
		)
	})

	it("refuses a run that wrote both twins of a flag", async () => {
		let { code, err } = await capture(() =>
			run(
				["build", "Quiet.es", "--minify", "--no-minify", "--no-color"],
				"essence",
			),
		)

		expect(code).toBe(EXIT_USAGE)
		expect(err).toContain(
			"--minify and --no-minify contradict each other — say one.",
		)
	})
})

describe("essence init", () => {
	// The Help names the file that is read.
	it("spells the project file the way the reader does", () => {
		expect(PROJECT_FILE).toBe(PROJECT_FILE_NAME)
	})

	// The written file lands in the working directory and reads cleanly.
	it("writes a project file the reader reads back", async () => {
		await withModules({ "keep.txt": "" }, async (directory) =>
			within(directory, async () => {
				let { code, out } = await capture(() =>
					run(["init", "--no-color"], "essence"),
				)
				// Compared through `process.cwd()`: on macOS `/var` links to `/private/var`, and
				// the reader answers with the path it was given.
				let root = process.cwd()
				let written = path.join(root, "essence.json")

				expect(code).toBe(EXIT_SUCCESS)
				expect(out).toContain("wrote")
				expect(out).toContain("essence.json")
				expect(existsSync(written)).toBe(true)

				let configuration = readProjectConfiguration(root)

				expect(configuration.problems).toEqual([])
				expect(configuration.root).toBe(root)
				expect(configuration.exclude).toEqual([])
				expect(configuration.test.skipTags).toEqual([])
				expect(configuration.test.contracts).toBe(false)
				expect(readFileSync(written, "utf8")).toContain(
					"// Directories under this project that are not its sources.",
				)
			}),
		)
	})

	// An existing file holds a project's own decisions, so it is never overwritten.
	it("refuses a directory that already holds one, and writes nothing", async () => {
		await withModules(
			{ "essence.json": `{ "test": { "skipTags": ["slow"] } }` },
			async (directory) =>
				within(directory, async () => {
					let { code, err } = await capture(() =>
						run(["init", "--no-color"], "essence"),
					)

					expect(code).toBe(EXIT_USAGE)
					expect(err).toContain("essence.json already exists.")
					expect(
						readFileSync(
							path.join(process.cwd(), "essence.json"),
							"utf8",
						),
					).toBe(`{ "test": { "skipTags": ["slow"] } }`)
				}),
		)
	})

	// A project inside a project is allowed, as for a monorepo package, but may be a
	// mistake, so it is written and reported.
	it("writes under a project that already governs, and says so", async () => {
		await withModules(
			{
				"essence.json": `{ "test": { "skipTags": ["slow"] } }`,
				"inner/keep.txt": "",
			},
			async (directory) =>
				within(path.join(directory, "inner"), async () => {
					let { code, out } = await capture(() =>
						run(["init", "--no-color"], "essence"),
					)

					expect(code).toBe(EXIT_SUCCESS)
					expect(
						existsSync(path.join(process.cwd(), "essence.json")),
					).toBe(true)
					expect(out).toContain("governs the directory above")
					expect(
						readProjectConfiguration(process.cwd()).test.skipTags,
					).toEqual([])
				}),
		)
	})
})

// The reports about a path on the command line, each with its Help: a near
// miss for a missing file, a directory's files, and permissions.
describe("a path that can not be read", () => {
	it("should answer a near miss against the files beside it", () =>
		withFiles(
			{ "src/Main.es": "implementation {}\n" },
			async (directory) => {
				let { code, out, err } = await capture(() =>
					run(
						[
							"check",
							"--no-color",
							path.join(directory, "src/Mian.es"),
						],
						PROGRAM,
					),
				)

				expect(code).not.toBe(EXIT_SUCCESS)
				expect(`${out}${err}`).toContain("No such file")
				expect(`${out}${err}`).toContain("Did you mean")
				expect(`${out}${err}`).toContain("Main.es")
			},
		))

	it("should ask for the path where nothing is near it", () =>
		withFiles(
			{ "src/Main.es": "implementation {}\n" },
			async (directory) => {
				let { code, out, err } = await capture(() =>
					run(
						[
							"check",
							"--no-color",
							path.join(directory, "src/Completely-Different.es"),
						],
						PROGRAM,
					),
				)

				expect(code).not.toBe(EXIT_SUCCESS)
				expect(`${out}${err}`).toContain(
					"Help: Check the path, and that the file is saved where it says.",
				)
			},
		))

	// The advice is a Help, not part of the message.
	it("should offer the glob for a directory as a Help", () =>
		withFiles(
			{ "src/Main.es": "implementation {}\n" },
			async (directory) => {
				let { code, out, err } = await capture(() =>
					run(
						["check", "--no-color", path.join(directory, "src")],
						PROGRAM,
					),
				)

				expect(code).not.toBe(EXIT_SUCCESS)
				expect(`${out}${err}`).toContain("is a directory")
				expect(`${out}${err}`).toContain(
					"Pass the source files inside it instead",
				)
				expect(`${out}${err}`).toContain("src/*.es")
			},
		))

	// Each Help names a path, and the command run again on that path reads it.
	// The path is taken from the printed Help, so a Help that names the wrong
	// one fails here.
	describe("followed", () => {
		let helpedPath = (printed: string): string => {
			let quoted = /Help: [^']*'([^']+)'/.exec(printed)

			if (quoted === null) {
				throw new Error(`No path in: ${printed}`)
			}

			return quoted[1] as string
		}

		let reportedCode = (printed: string): string | undefined =>
			/\[([a-z-]+)\]/.exec(printed)?.[1]

		it("should check the file a near miss names", () =>
			withFiles(
				{ "src/Main.es": "implementation {}\n" },
				async (directory) => {
					let refused = await capture(() =>
						run(
							[
								"check",
								"--no-color",
								path.join(directory, "src/Mian.es"),
							],
							PROGRAM,
						),
					)
					let { code } = await capture(() =>
						run(
							[
								"check",
								"--no-color",
								helpedPath(`${refused.out}${refused.err}`),
							],
							PROGRAM,
						),
					)

					expect(reportedCode(`${refused.out}${refused.err}`)).toBe(
						"file-not-found",
					)
					expect(code).toBe(EXIT_SUCCESS)
				},
			))

		// The CLI expands the glob itself, so the Help's spelling is passed as
		// written, as a shell that matched nothing would pass it.
		it("should check the files the glob for a directory names", () =>
			withFiles(
				{
					"src/Main.es": "implementation {}\n",
					"src/Other.es": "implementation {}\n",
				},
				async (directory) => {
					let refused = await capture(() =>
						run(
							[
								"check",
								"--no-color",
								path.join(directory, "src"),
							],
							PROGRAM,
						),
					)
					let { code, out, err } = await capture(() =>
						run(
							[
								"check",
								"--no-color",
								helpedPath(`${refused.out}${refused.err}`),
							],
							PROGRAM,
						),
					)

					expect(reportedCode(`${refused.out}${refused.err}`)).toBe(
						"not-a-file",
					)
					expect(code).toBe(EXIT_SUCCESS)
					expect(`${out}${err}`).toContain("2 files checked")
				},
			))
	})
})
