module.exports = {
	rootDir: "src",
	collectCoverage: true,
	coveragePathIgnorePatterns: [
		"src/parser/grammar.ts",
		"src/tests",
		"testFiles",
		"wallaby.js",
		"src/coverage",
	],
	preset: "ts-jest",
	testEnvironment: "node",
}
