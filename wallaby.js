module.exports = function (wallaby) {
	return {
		files: [
			'src/*.ts'
		],

		tests: [
			'src/tests/*.ts'
		],

		env: {
			type: 'node'
		},

		testFramework: 'jasmine'
	}
}
