// NOTE: The entry a session debugging a test launches. A test bundle publishes
// its registry on `$tests` and runs nothing on its own — `essence test` is what
// drives one — so debugging a test means a script that loads the bundle and asks
// it for exactly that test. This module writes that script.
//
// NOTE: It is a SEPARATE file from the bundle rather than an epilogue appended
// to it, and the difference matters to the debugger: the bundle stays the file
// the source map describes, byte for byte, so every breakpoint the session
// addresses to it lands where the map says. What is launched and what is mapped
// are two files, which is why the session carries both.
//
// NOTE: Written as source text rather than shipped as a file because it has to
// name the bundle beside it and the ids to run, and a file would have to be
// found at run time in a package that may be bundled into one.

// NOTE: Rendered by the runner rather than by the reporter this repository
// already has: the script runs inside the debuggee, where the only thing it may
// depend on is the bundle it loads. Everything it prints reaches a reader
// through the Debug Console.
export function testRunnerSource(
	bundleFileName: string,
	ids: Array<string>,
): string {
	return `import { $tests } from ${JSON.stringify(`./${bundleFileName}`)}

const ids = ${JSON.stringify(ids)}
const registry = $tests.registry()

const summary = $tests.run(registry, {
	filters: ids.length === 0 ? {} : { ids },
	sink: (event) => {
		if (event.kind === "test-pass") {
			console.log(\`✓ \${event.name}\`)
		} else if (event.kind === "test-fail") {
			console.log(\`✗ \${event.name}\`)

			for (const failure of event.failures ?? []) {
				if (failure.span !== null) {
					console.log(\`    \${failure.form} \${failure.span.source}\`)
				}

				const comparison = failure.comparison

				if (comparison !== null && comparison.left !== null) {
					console.log(
						\`      \${comparison.left} \${
							comparison.kind === "is" ? "is not" : "is"
						} \${comparison.right}\`,
					)
				}
			}

			if (event.error !== null && event.error !== undefined) {
				console.log(\`    \${event.error}\`)
			}
		} else if (event.kind === "test-skip") {
			console.log(\`– \${event.name} — \${event.reason}\`)
		} else if (event.kind === "output") {
			process.stdout.write(event.text)
		}
	},
})

console.log(
	\`\${summary.passed} passed, \${summary.failed} failed, \${
		summary.deselected
	} deselected\`,
)

// NOTE: The same code \`essence test\` answers with, so that a debug session
// that ran a failing test is a session that failed.
if (summary.failed > 0) {
	process.exitCode = 1
}
`
}
