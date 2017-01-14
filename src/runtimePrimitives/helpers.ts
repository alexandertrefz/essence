import { parser } from '../interfaces'

type IValueNode = parser.IValueNode

export let generateValueNode = (type: string, value: any, members: any): IValueNode => {
	return {
		nodeType: 'Value',
		type,
		value,
		members,
	}
}
