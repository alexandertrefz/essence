export const createIsHelper = (tester: string | Array<string>) => {
	return (input: string): boolean => {
		if (typeof tester === "string") {
			return tester === input
		} else {
			return !!~tester.indexOf(input)
		}
	}
}

export const orHelper = (funcs: Array<(input: string) => boolean>, input: string): boolean => {
	return funcs.map(func => func(input)).reduce((prev, curr) => prev || curr, false)
}
