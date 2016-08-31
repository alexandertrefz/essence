import {
	IValueNode,
} from '../Interfaces'

export let generateValueNode = (type: string, value: any, members: any): IValueNode => {
	return {
		nodeType: 'Value',
		type,
		value,
		members,
	}
}
