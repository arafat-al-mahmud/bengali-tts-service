import { Effect } from 'effect';
import { TextEmpty, TextNotBengali, TextTooLong } from './errors.js';

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

export type TtsTextError = TextEmpty | TextTooLong | TextNotBengali;

/**
 * The dominance rule (>= 50% Bengali) rejects text the model would turn
 * into garbage audio while still accepting real-world Bengali that mixes
 * in digits, punctuation, and the occasional loanword.
 *
 * Every way this can reject text is listed in the return type, so adding a
 * fourth rule will not compile until the response for it is decided.
 */
export function validateTtsText(text: string, maxLength: number): Effect.Effect<void, TtsTextError> {
  if (text.trim().length === 0) return Effect.fail(new TextEmpty());

  const actualLength = [...text].length;
  if (actualLength > maxLength) return Effect.fail(new TextTooLong({ maxLength, actualLength }));

  const ratio = bengaliRatio(text);
  if (ratio < MIN_BENGALI_RATIO) {
    return Effect.fail(new TextNotBengali({ ratio, minimumRatio: MIN_BENGALI_RATIO }));
  }

  return Effect.void;
}
