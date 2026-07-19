// Terminal display width of a single code point, replacing the
// `unicode-width` crate. This is an approximation covering the common wide
// (East Asian & emoji) and zero-width (combining mark) ranges rather than the
// full Unicode tables.

const WIDE_RANGES: Array<[number, number]> = [
	[0x1100, 0x115f], // Hangul Jamo
	[0x2e80, 0x303e], // CJK Radicals .. CJK Symbols and Punctuation
	[0x3041, 0x33ff], // Hiragana .. CJK Compatibility
	[0x3400, 0x4dbf], // CJK Extension A
	[0x4e00, 0x9fff], // CJK Unified Ideographs
	[0xa000, 0xa4cf], // Yi Syllables
	[0xa960, 0xa97f], // Hangul Jamo Extended-A
	[0xac00, 0xd7a3], // Hangul Syllables
	[0xf900, 0xfaff], // CJK Compatibility Ideographs
	[0xfe10, 0xfe19], // Vertical Forms
	[0xfe30, 0xfe6f], // CJK Compatibility Forms
	[0xff00, 0xff60], // Fullwidth Forms
	[0xffe0, 0xffe6], // Fullwidth Signs
	[0x1f300, 0x1f64f], // Emoji & Pictographs, Emoticons
	[0x1f680, 0x1f6ff], // Transport & Map Symbols
	[0x1f900, 0x1f9ff], // Supplemental Symbols and Pictographs
	[0x20000, 0x3fffd], // CJK Extensions B..
]

const ZERO_WIDTH_RANGES: Array<[number, number]> = [
	[0x0300, 0x036f], // Combining Diacritical Marks
	[0x1ab0, 0x1aff], // Combining Diacritical Marks Extended
	[0x1dc0, 0x1dff], // Combining Diacritical Marks Supplement
	[0x200b, 0x200f], // Zero-width spaces & direction marks
	[0x20d0, 0x20ff], // Combining Marks for Symbols
	[0xfe00, 0xfe0f], // Variation Selectors
	[0xfe20, 0xfe2f], // Combining Half Marks
]

function isInRanges(
	codePoint: number,
	ranges: Array<[number, number]>,
): boolean {
	return ranges.some(([start, end]) => codePoint >= start && codePoint <= end)
}

// Returns the number of terminal columns occupied by the given code point.
// Control characters report a width of 1, mirroring the renderer's
// `width().unwrap_or(1)` upstream.
export function characterWidth(character: string): number {
	let codePoint = character.codePointAt(0)

	if (codePoint === undefined) {
		return 0
	}

	if (isInRanges(codePoint, ZERO_WIDTH_RANGES)) {
		return 0
	}

	if (isInRanges(codePoint, WIDE_RANGES)) {
		return 2
	}

	return 1
}
