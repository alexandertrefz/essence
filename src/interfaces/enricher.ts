import * as common from "./common";

export type Scope = {
	parent: Scope | null;
	members: {
		[key: string]: common.Type;
	};
};
