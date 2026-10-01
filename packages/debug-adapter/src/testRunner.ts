// The script a session debugging a test launches. A test bundle publishes its
// registry on `$tests` and runs nothing itself, so this script loads the
// bundle and runs the requested tests. It prints its own report to the Debug
// Console, since inside the debuggee it may depend on nothing but the bundle.
// See "Debugging a test" in DEVELOPMENT.md.
export function testRunnerSource(
	bundleFileName: string,
	ids: Array<string>,
): string {
	return `import { $tests } from ${JSON.stringify(`./${bundleFileName}`)}

const ids = ${JSON.stringify(ids)}
const registry = $tests.registry()

// Awaited at the top level of the emitted Module, which is ESM and may
// await at its top level: a test that completes something is a test the runner
// waits for, and the summary is only true once every one of them is over.
const summary = await $tests.run(registry, {
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

// The same code \`essence test\` answers with, so that a debug session
// that ran a failing test is a session that failed.
if (summary.failed > 0) {
	process.exitCode = 1
}
`
}
