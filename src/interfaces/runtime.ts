export interface IScope {
	parent: IScope | null
	[key: string]: any
}

export interface INativeScope {
	[key: string]: any
}
