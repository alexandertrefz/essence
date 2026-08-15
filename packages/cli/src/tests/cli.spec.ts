import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
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
import { fileURLToPath } from "node:url"

import { closestMatch } from "@essence-lang/compiler/helpers"
import { optimiserPassNames } from "@essence-lang/compiler/optimiser"
import { testDiagnostic } from "@essence-lang/compiler/tests/diagnosticFactory"
import { fixturePath } from "@essence-lang/fixtures"
import { STDLIB_DIRECTORY } from "@essence-lang/standard-library"

import { EXIT_SUCCESS, runCheck, runRun } from "../actions"
import {
	optimiserOptionsFor,
	type OptionValues,
	parseArguments,
	UsageError,
} from "../args"
import { commands, findCommand, globalOptions, PROGRAM } from "../commands"
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
} from "../pipeline"
import { defaultWorkerCount, shouldUseWorkers, workerFileName } from "../pool"
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

type Command = NonNullable<ReturnType<typeof findCommand>>

const buildCommand = findCommand("build") as Command
const runCommand = findCommand("run") as Command
const formatCommand = findCommand("format") as Command

// NOTE: Everything the CLI writes goes through `process.stdout` and
// `process.stderr`, including what a delegate writes for itself, so driving
// `run` from a spec means holding both for the length of the call.
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
		...overrides,
	}
}

// NOTE: `esc --version` answered "unknown" for as long as it took to notice.
// The version was read from a path counted out from `context.ts`, that module
// moved one directory up when the CLI became its own package, and the `catch`
// around the read turned a wrong path into a plausible-looking answer instead
// of a failure. It is an import now, so the path can not be wrong — and this
// says the value reaching `--version` is the manifest's, which is the part an
// import alone does not promise.
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

		// NOTE: A path is never mistaken for a mistyped Command, however
		// closely it happens to resemble one.
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

		it("leaves every pass on when neither is given", () => {
			let options = parseArguments(["build", "a.es"]).options

			expect(options.noOptimise).toBe(false)
			expect(options.withoutOptimisation).toEqual([])
			expect(optimiserOptionsFor(options)).toEqual({
				enabled: true,
				disabledPasses: new Set(),
			})
		})

		// NOTE: A pass name that names no pass is a mistake the user can only
		// see if it is reported: silently, every pass would keep running and
		// the flag would look like a pass that does nothing.
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

		// NOTE: The Formatter parses its own flags, so nothing after `format`
		// may be read here — a flag esc has never heard of is not a mistake
		// there, and a bare `--` is not a separator to fold away.
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

		// NOTE: --help is answered from the Command table rather than forwarded,
		// so that `essence format --help` and `essence help format` are one
		// screen — and so that `essence lsp --help` cannot start a Server that
		// nobody is talking to.
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
		// NOTE: Help is generated from the Command table, so an Option that is
		// added without documentation would silently produce an empty entry.
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

		// NOTE: The same table is rendered under whichever name the binary was
		// invoked as. Every line of it has to name that one — help that says
		// `esc` to somebody who typed `essence` cannot be pasted back into
		// their shell.
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

		// NOTE: A passthrough Command's arguments are read by the tool it
		// delegates to, which has never heard of --json or --quiet, so listing
		// them under its help would document flags that do nothing.
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

		// NOTE: An absolute pattern rather than one relative to the working
		// directory, because `glob` resolves against the cwd and a spec must
		// not care which directory `bun test` was started from.
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

		// NOTE: Flattening several directories into one output directory can
		// make two sources collide; that has to be an error rather than a
		// silent overwrite.
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
		// NOTE: One entry is one graph and a graph is one worker's, so a second
		// worker has nothing to take — however large the file is.
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

		// NOTE: Checking divides enrichment and nothing else, and there is not
		// enough of it to divide until the batch is a quarter of a megabyte.
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

		// NOTE: The worker is booted as whatever `pool.ts` itself is running
		// as — in the published package the sources are compiled, and there is
		// no `worker.ts` to boot.
		it("boots the worker its own module could be", () => {
			expect(workerFileName("file:///checkout/cli/src/pool.ts")).toBe(
				"./worker.ts",
			)
			expect(workerFileName("file:///install/cli/dist/pool.js")).toBe(
				"./worker.js",
			)
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

		// NOTE: An explicit flag is the user's decision and outranks both the
		// environment and the terminal.
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

		// NOTE: A terminal with no known width reports zero columns. Taking
		// that literally would truncate every line down to an ellipsis.
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

// NOTE: The CLI and the Language Server have to agree about the file in front
// of them. `esc check packages/standard-library/sources/List.es` used to reject the `declarations { …
// }` header of the very sources the compiler loads at startup — while the
// Editor reported the same file clean — so a compiler developer could not
// check their own transcription. Both now route through `documents.ts`.
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

	// NOTE: The permission is the standard library's alone — an ordinary file
	// that opens with `declarations { … }` is still rejected, by the CLI as
	// much as by the Editor.
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

// NOTE: One binary is installed under several names, and every name exposes
// every Command — `esc` is `essence` under its old name. The name is not a
// label on the help screen but the name of the program the user is talking to,
// so it is threaded from the executable through every line either one prints.
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

	// NOTE: `esc` is what a caller who says nothing gets, so that the CLI can be
	// driven directly — by a spec, or by a script older than the second name —
	// without the name of the program changing under it.
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

	// NOTE: A usage error that belongs to no Command still has to say who could
	// not read the arguments, and a caller who asked for JSON gets the failure
	// in JSON too.
	it("names the invoked program in a JSON usage error", async () => {
		let { code, out } = await capture(() =>
			run(["buld", "--json"], "essence"),
		)

		expect(code).toBe(2)
		expect(JSON.parse(out).command).toBe("essence")
	})
})

describe("essence format", () => {
	// NOTE: Both forms are one screen, rendered from esc's own Command table:
	// the Formatter's flags are documented there, and `essence lsp --help` must
	// not start a Server that nobody is talking to.
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

	// NOTE: --check is the Formatter's flag, not esc's. Reaching the Formatter
	// verbatim is the whole point of a passthrough Command: read here, it would
	// have been an unknown option and never have arrived.
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

// NOTE: There is deliberately no spec that starts the Server: it holds stdio
// open until the other end closes it, which in a test runner is forever. What
// can be said here is that asking about it does not start it — which is why
// `--help` is answered from the Command table rather than forwarded.
describe("essence lsp", () => {
	it("documents itself without starting a Server", async () => {
		let { code, out } = await capture(() => run(["help", "lsp"], "essence"))

		expect(code).toBe(0)
		expect(out).toContain("essence lsp")
		expect(out).toContain("Language Server Protocol")
		expect(out).not.toContain("GLOBAL OPTIONS")
	})
})

// NOTE: The same holds for the Debug Adapter, for the same reason.
describe("essence dap", () => {
	it("documents itself without starting an Adapter", async () => {
		let { code, out } = await capture(() => run(["help", "dap"], "essence"))

		expect(code).toBe(0)
		expect(out).toContain("essence dap")
		expect(out).toContain("Debug Adapter Protocol")
		expect(out).not.toContain("GLOBAL OPTIONS")
	})
})

// NOTE: `essence check` must not pay for tools it never calls. The Formatter,
// the Language Server and the Debug Adapter are reached through `import(…)` at
// the point of use, and a static import anywhere in the package would load all
// of them — with everything they import — before the first argument had been
// read.
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

// NOTE: A Module graph belongs to a directory rather than to a file — a
// specifier is a path from one Module to another — so a test that needs one
// writes it outside the repository and takes it down again afterwards.
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

// NOTE: One job, so that a test compiles in this process: a worker would
// answer the same and boot a second copy of the Compiler to do it.
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
		minify: false,
		noOptimise: false,
		withoutOptimisation: [],
		jobs: 1,
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

// NOTE: The bundle is imported rather than started as a program, which is what
// `esc run` does with this very file: a child process inherits the test
// runner's streams, so what it printed could not be read back here.
// NOTE: Both doors a Program writes through, into one buffer in writing order:
// `Terminal.inspect` ends its line through `console.log`, while
// `Terminal.print` and `Terminal.write` go to the stream, there being no way to
// spell "no newline" through the console. A harness holding only `console.log`
// would read a printing Program as silent, and silence is what every comparison
// below would then be making.
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
		'\thalve from "./Dep.es"',
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
		'\thalve from "./Dep.es"',
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
	// NOTE: The whole graph as one bundle, run. Five files, a cycle among them
	// and a Namespace reached only through implicit dispatch — and three lines
	// of output, which is what says every Module body ran exactly once: a
	// Module the bundle carries two copies of prints six.
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

			// NOTE: Standalone: the runtime is inlined and nothing is left to
			// resolve at run time.
			expect(emitted).not.toMatch(/^import\s/m)
			expect(emitted).not.toContain("require(")

			// NOTE: The Bundler labels each Module it inlines with the
			// specifier it came in under, so the labels are the bundle's own
			// account of what it carries: five Modules and one prelude, one
			// copy each.
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
				"157/1",
			])
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})

	// NOTE: A Diagnostic is rendered against the source it was reported in.
	// The importer's text at the dependency's line numbers would underline
	// whatever happens to be written there, which is why every Module carries
	// its own source through the outcome.
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
			expect(entry?.diagnostics).toEqual([])
			expect(outcome.diagnostics).toHaveLength(1)

			let rendered = stripAnsi(
				renderDiagnosticsFor(outcome, plainReport()) ?? "",
			)

			expect(rendered).toContain("Dep.es")
			expect(rendered).toContain('<- "not a Number"')
			expect(rendered).not.toContain("Terminal.inspect")
		})
	})

	// NOTE: `esc check Dep.es Main.es`, where the second imports the first.
	// Both are entries, so both are compiled — but the graph is one graph, and
	// the file they share is reported by the outcome that owns it. Counted per
	// entry instead, a batch says two errors where the reader finds one.
	it("reports a file that is both an entry and a dependency exactly once", async () => {
		await withModules(brokenDependency, async (directory) => {
			let report = await checkAsJSON([
				path.join(directory, "Dep.es"),
				path.join(directory, "Main.es"),
			])

			expect(report.ok).toBe(false)
			expect(report.errors).toBe(1)
			expect(report.files).toHaveLength(2)

			let diagnostics = report.files.flatMap((file) => file.diagnostics)

			expect(diagnostics).toHaveLength(1)
			expect(path.basename(diagnostics[0]!.file)).toBe("Dep.es")
			expect(report.files.map((file) => file.ok)).toEqual([false, false])
		})
	})

	// NOTE: The file a Diagnostic belongs to is the file it was written in,
	// which with Modules is regularly not the file that was compiled.
	it("names the file each Diagnostic was written in under --json", async () => {
		await withModules(brokenDependency, async (directory) => {
			let report = await checkAsJSON([path.join(directory, "Main.es")])

			expect(report.files).toHaveLength(1)
			expect(path.basename(report.files[0]!.input)).toBe("Main.es")
			expect(report.files[0]!.diagnostics).toHaveLength(1)
			expect(path.basename(report.files[0]!.diagnostics[0]!.file)).toBe(
				"Dep.es",
			)
			expect(report.files[0]!.diagnostics[0]!.line).toBe(4)
		})
	})

	// NOTE: Both files built in one invocation, so the dependency's typed
	// Program is the one the entry's graph holds. It may be emitted from twice
	// and simplified once: the Simplifier writes an overloaded Method's mangled
	// name onto the typed Node it read it off, and a second pass mangles it
	// again into a Method nothing declares — which surfaced as a bundle
	// importing a name the runtime does not export.
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

	// NOTE: Which entries a worker is handed together. Workers share nothing,
	// so an entry that imports another entry belongs in one of them, while an
	// unrelated file is free to go anywhere.
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

// NOTE: The flags are only worth having if they reach the Compiler, so this
// drives them through the same `compileFile` the commands run and reads the
// file that comes out. A fixture, rather than a snippet: what the Options have
// to hold for is a real build.
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

	// NOTE: An absence is only the Program's to answer for inside the Program's
	// own emission. What is read back is the whole BUNDLE — the runtime esbuild
	// inlined ahead of it — and a runtime Method that builds a List goes on
	// calling `createList` however the Program was compiled, so a bundle-wide
	// absence is a claim about which runtime Methods this fixture happens to
	// reach rather than about the Optimiser. esbuild labels each inlined module
	// with its path and emits the entry last, so the Essence source's own
	// emission is everything past the final label.
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
		// NOTE: The pass that was NOT named still ran — read off the Program's
		// own emission for the same reason as above.
		expect(userModuleOf(partial.emitted)).not.toContain("Object.assign(")
		expect(partial.printed).toEqual(optimised.printed)
	})
})

// NOTE: What a debug session builds. The Adapter is handed what compiling
// MEANS, and this is the function that means it — driven here rather than
// through a spawned adapter, so the claim is about the compile itself.
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

			// NOTE: The shapes the registry takes away, all still standing —
			// a debugger steps through Statements, stops on bindings and reads
			// their values back, and half of the passes exist to drop exactly
			// those.
			expect(emitted).toContain("createRecord(")
			expect(emitted).toContain("createList(")
			expect(emitted).toContain("Object.assign(")
			expect(emitted).not.toContain("$pool_")
			expect(emitted).not.toContain("$loop_")
			// NOTE: And it still runs, and prints what an optimised build of
			// the same file prints.
			expect(await runBundle(outputFileName)).toEqual([
				"55",
				"15",
				"128",
				"128",
				"2",
			])
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})
})

// NOTE: The two homes a map can have, driven through the same `compileFile`
// the commands run: `build` writes it beside the output, while `run`'s
// scratch directory is deleted the moment the program exits — so `run` rides
// the map inside the bundle, where a stack trace can still be read through
// it. Either way the map holds Essence sources alone.
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

describe("essence run", () => {
	// NOTE: `--out` may name a directory. What runs has to be the bundle the
	// compiler actually wrote into it — resolved per file inside the plan —
	// never the directory path the option was given as.
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

	// NOTE: --json changes how the compilation is reported, not what `run`
	// does — the command documents itself as exiting with the program's own
	// exit code, with no --json qualification. The program here overflows the
	// stack at run time, something no Diagnostic can see, so a non-zero exit
	// can only mean it actually ran.
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
				let { terminal, lines } = captureTerminal()
				let context = createContext(
					testOptions({ json: true, noOptimise: true }),
					"essence",
					terminal,
				)

				let code = await runRun(
					context,
					runCommand,
					[path.join(directory, "Overflow.es")],
					[],
				)

				let report = JSON.parse(lines.join("\n")) as JSONReport

				expect(report.command).toBe("run")
				expect(report.ok).toBe(true)
				expect(code).not.toBe(EXIT_SUCCESS)
			},
		)
	})

	// NOTE: The one assertion the in-process harness can not make — the
	// program's streams are inherited, so only a real child process shows
	// where its printing lands. --json promises stdout carries the report as
	// a single JSON document and nothing else, so the program's own output is
	// routed to stderr, and a printing program must not break `… --json | jq`.
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
				let result = spawnSync(
					process.execPath,
					[binary, "run", path.join(directory, "Noisy.es"), "--json"],
					{ encoding: "utf-8" },
				)

				let report = JSON.parse(result.stdout) as JSONReport

				expect(report.command).toBe("run")
				expect(report.ok).toBe(true)
				expect(result.stderr).toContain("hello from the program")
				expect(result.status).toBe(EXIT_SUCCESS)
			},
		)
	})
})
