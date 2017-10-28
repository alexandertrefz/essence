module.exports = function(wallaby) {
	return {
		files: ["src/**/*.ts", "!src/tests/*.ts"],

		filesWithNoCoverageCalculated: ["src/parser/grammar.ts"],

		tests: ["src/tests/*.ts"],

		env: {
			type: "node",
		},

		hints: {
			ignoreCoverage: /ignore coverage/,
		},

		testFramework: "jasmine",
	}
}
