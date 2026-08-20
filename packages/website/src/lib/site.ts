// NOTE: Everything the site says about itself that is not content. Kept in one
// place because the version is printed in four different chrome positions and a
// drifted copy is the kind of wrong nobody notices.

export const SITE_NAME = "essence"
export const SITE_URL = "https://essencelang.org"
export const SITE_DESCRIPTION =
	"A language for the web with exact arithmetic, immutable data and a type system that finds every error before you ship."

/**
 * The version on the npm registry, which the packages carry in lockstep.
 * Nothing displays it at the moment — every version badge came off the site
 * while there was only ever one number to show. Kept here, and kept correct,
 * because putting them back is meant to be a matter of importing it again
 * rather than rediscovering where the number lives.
 */
export const VERSION = "0.1.0"

export const GITHUB_URL = "https://github.com/alexandertrefz/essence"
export const GITHUB_ISSUES_URL = `${GITHUB_URL}/issues`
// NOTE: There is no changelog page and no releases feed yet — the commit log is
// the honest answer to "what changed".
export const GITHUB_COMMITS_URL = `${GITHUB_URL}/commits/master`
export const GITHUB_CONTRIBUTING_URL = `${GITHUB_URL}/blob/master/Readme.md`

/**
 * Where the chrome points. Real pages only — nothing here is aspirational.
 *
 * NOTE: Getting Started is the only documentation section published so far. The
 * Language, Standard Library, Guides and Reference sections are written but are
 * being re-verified against the current compiler, and their entries are held
 * out of this table until they are. What each one becomes when it lands:
 *
 *   languageTour     /docs/language/values-and-constants
 *   patternMatching  /docs/language/pattern-matching
 *   recordsAndLists  /docs/language/records-and-lists
 *   standardLibrary  /docs/standard-library/overview
 *   numbers          /docs/standard-library/numbers
 *   compilerGuide    /docs/guides/using-the-compiler
 *   reference        /docs/reference/diagnostics
 *   diagnostics      /docs/reference/diagnostics
 *
 * Until then the chrome sends those readers to the documentation index, which
 * says which sections are published and which are on the way.
 */
export const ROUTES = {
	home: "/",
	docs: "/docs",
	principles: "/principles",
	goals: "/goals",
	getStarted: "/docs/getting-started/installation",
	firstProgram: "/docs/getting-started/your-first-program",
	projectLayout: "/docs/getting-started/project-layout",
} as const
