// Everything the site says about itself that is not content, in one place so
// no copy drifts.

import cliPackage from "../../../cli/package.json" with { type: "json" }

export const SITE_NAME = "essence"
export const SITE_URL = "https://essencelang.org"
/**
 * What every page tells a search engine and a link preview: plain, and naming
 * what people search for. The landing page's hook is `HERO_SUBLINE` instead.
 */
export const SITE_DESCRIPTION =
	"A language for the web with exact arithmetic, immutable data and a type system that finds every error before you ship."

/**
 * The line under the landing page's headline, and nowhere else. Its clauses
 * answer the headline's words in order without repeating them.
 */
export const HERO_SUBLINE =
	"A language for the web that catches your bugs as you are writing them, fits the stack you already have, and is a joy to use."

/**
 * The version of the toolchain the site documents, read at build time from
 * the command line's own `package.json`, since the packages carry it in
 * lockstep. The installation page and "What Essence is" display it; a page
 * that names the release imports it rather than writing the number down.
 */
export const VERSION: string = cliPackage.version

export const GITHUB_URL = "https://github.com/alexandertrefz/essence"
export const GITHUB_ISSUES_URL = `${GITHUB_URL}/issues`
// Without a changelog page or releases feed, the commit log answers "what
// changed".
export const GITHUB_COMMITS_URL = `${GITHUB_URL}/commits/master`
export const GITHUB_CONTRIBUTING_URL = `${GITHUB_URL}/blob/master/Readme.md`

/**
 * Where the chrome points. Every documentation slug here is a real page.
 */
export const ROUTES = {
	home: "/",
	docs: "/docs",
	principles: "/principles",
	goals: "/goals",
	whatEssenceIs: "/docs/getting-started/what-essence-is",
	getStarted: "/docs/getting-started/installation",
	firstProgram: "/docs/getting-started/your-first-program",
	comingFromJavaScript: "/docs/getting-started/coming-from-javascript",
	projects: "/docs/guides/projects",
	library: "/docs/library/overview",
	syntaxGlossary: "/docs/reference/syntax-glossary",
	diagnostics: "/docs/reference/diagnostics",
} as const
