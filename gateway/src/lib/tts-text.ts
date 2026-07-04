import { ApiError } from './errors.js';

const BENGALI_BLOCK_START = 0x0980;
const BENGALI_BLOCK_END = 0x09ff;
const MIN_BENGALI_RATIO = 0.5;

/** Share of non-whitespace codepoints that fall in the Bengali Unicode block. */
export function bengaliRatio(text: string): number {
  let bengali = 0;
  let total = 0;
  for (const char of text) {
    if (/\s/.test(char)) continue;
    total += 1;
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint >= BENGALI_BLOCK_START && codePoint <= BENGALI_BLOCK_END) bengali += 1;
  }
  return total === 0 ? 0 : bengali / total;
}

/**
 * The dominance rule (>= 50% Bengali) rejects text the model would turn
 * into garbage audio while still accepting real-world Bengali that mixes
 * in digits, punctuation, and the occasional loanword.
 */
export function validateTtsText(text: string, maxLength: number): void {
  if (text.trim().length === 0) {
    throw new ApiError(422, 'TEXT_EMPTY', 'Text must not be empty');
  }
  const length = [...text].length;
  if (length > maxLength) {
    throw new ApiError(422, 'TEXT_TOO_LONG', `Text exceeds the maximum length of ${maxLength} characters`, {
      maxLength,
      actualLength: length,
    });
  }
  if (bengaliRatio(text) < MIN_BENGALI_RATIO) {
    throw new ApiError(
      422,
      'TEXT_NOT_BENGALI',
      'Text must be predominantly Bengali (at least half of non-whitespace characters)',
    );
  }
}
