module.exports = (wallaby) => ({
	files: ["src/**/*.ts", "!src/tests/*.ts"],

	tests: ["src/tests/*.ts"],

	env: {
		type: "node",
	},

	testFramework: "jest",
})
