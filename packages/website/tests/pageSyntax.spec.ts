import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

import { createProcessor } from "@mdx-js/mdx"

/*
 * Every page parses as MDX, and every `{…}` on it is one the page means.
 *
 * MDX reads a brace in prose as a JavaScript expression, so `'\u{41}'` written
 * outside backticks renders as `\u41` and `'export { … }'` stops the build. A
 * brace meant as text is escaped (`\{ … \}`) or put in backticks. An expression
 * a page does mean is a comment or starts from a name the page imports.
 */

const DOCS_DIRECTORY = path.resolve(import.meta.dirname, "../src/content/docs")

function pagesUnder(directory: string): Array<string> {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		let entryPath = path.join(directory, entry.name)

		if (entry.isDirectory()) {
			return pagesUnder(entryPath)
		}

		return entry.name.endsWith(".mdx") ? [entryPath] : []
	})
}

type Node = {
	type: string
	value?: string
	position?: { start: { line: number } }
	data?: { estree?: { body: Array<any> } }
	children?: Array<Node>
}

function importedNames(tree: Node): Set<string> {
	let names = new Set<string>()

	for (let node of tree.children ?? []) {
		if (node.type !== "mdxjsEsm") {
			continue
		}

		for (let statement of node.data?.estree?.body ?? []) {
			for (let specifier of statement.specifiers ?? []) {
				names.add(specifier.local.name)
			}
		}
	}

	return names
}

// The name an expression starts from: `commands` in `commands.map(…)`.
function rootName(expression: any): string | null {
	while (true) {
		if (expression.type === "Identifier") {
			return expression.name
		}

		if (expression.type === "MemberExpression") {
			expression = expression.object
		} else if (expression.type === "CallExpression") {
			expression = expression.callee
		} else {
			return null
		}
	}
}

function unmeantExpressions(tree: Node): Array<string> {
	let imported = importedNames(tree)
	let found: Array<string> = []

	let visit = (node: Node) => {
		if (
			node.type === "mdxTextExpression" ||
			node.type === "mdxFlowExpression"
		) {
			let body = node.data?.estree?.body ?? []
			let isComment = body.length === 0
			let root =
				body.length === 1 && body[0].type === "ExpressionStatement"
					? rootName(body[0].expression)
					: null

			if (!isComment && (root === null || !imported.has(root))) {
				found.push(`line ${node.position?.start.line}: {${node.value}}`)
			}
		}

		for (let child of node.children ?? []) {
			visit(child)
		}
	}

	visit(tree)

	return found
}

describe("the pages' MDX", () => {
	let processor = createProcessor()

	for (let page of pagesUnder(DOCS_DIRECTORY)) {
		let name = path.relative(DOCS_DIRECTORY, page)

		it(`parses ${name} with no expression it does not mean`, () => {
			let tree = processor.parse(readFileSync(page, "utf8")) as Node

			expect(unmeantExpressions(tree)).toEqual([])
		})
	}
})
