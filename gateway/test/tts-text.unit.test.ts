import { Cause, Effect, Exit, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { bengaliRatio, validateTtsText } from '../src/lib/tts-text.js';

const BENGALI = 'আজকের আবহাওয়া খুব সুন্দর';

/**
 * The tag of the rejection, or NO_ERROR when the text passed. A crash the
 * validator never declared shows up as DEFECT rather than passing quietly.
 */
function tagOf(text: string, maxLength: number): string {
  const exit = Effect.runSyncExit(validateTtsText(text, maxLength));
  if (Exit.isSuccess(exit)) return 'NO_ERROR';
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure) ? failure.value._tag : 'DEFECT';
}

describe('bengaliRatio', () => {
  it('is 1 for pure Bengali regardless of whitespace', () => {
    expect(bengaliRatio(BENGALI)).toBe(1);
  });

  it('is 0 for empty and whitespace-only text', () => {
    expect(bengaliRatio('')).toBe(0);
    expect(bengaliRatio('   \n\t')).toBe(0);
  });

  it('counts non-Bengali characters against the ratio', () => {
    expect(bengaliRatio('abc')).toBe(0);
    expect(bengaliRatio('আব cd')).toBe(0.5);
  });
});

describe('validateTtsText', () => {
  it('accepts pure Bengali', () => {
    expect(tagOf(BENGALI, 1000)).toBe('NO_ERROR');
  });

  it('accepts Bengali with digits, punctuation, and a loanword', () => {
    const realWorld = 'আগামীকাল সকাল ১০টায় সভা অনুষ্ঠিত হবে; বিস্তারিত সময়সূচি email করা হয়েছে।';
    expect(tagOf(realWorld, 1000)).toBe('NO_ERROR');
  });

  it('rejects empty and whitespace-only text as TextEmpty', () => {
    expect(tagOf('', 1000)).toBe('TextEmpty');
    expect(tagOf('   ', 1000)).toBe('TextEmpty');
  });

  it('rejects text over the length cap as TextTooLong', () => {
    expect(tagOf('আ'.repeat(1001), 1000)).toBe('TextTooLong');
    expect(tagOf('আ'.repeat(1000), 1000)).toBe('NO_ERROR');
  });

  it('rejects predominantly non-Bengali text as TextNotBengali', () => {
    expect(tagOf('hello world this is english', 1000)).toBe('TextNotBengali');
    expect(tagOf(`mostly english text here ${BENGALI.slice(0, 4)}`, 1000)).toBe('TextNotBengali');
  });

  it('reports the measured ratio and the cap it missed', () => {
    const exit = Effect.runSyncExit(validateTtsText('abcd আব', 1000));
    const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none();
    expect(Option.isSome(failure) && failure.value._tag === 'TextNotBengali').toBe(true);
    if (Option.isSome(failure) && failure.value._tag === 'TextNotBengali') {
      expect(failure.value.ratio).toBeCloseTo(1 / 3);
      expect(failure.value.minimumRatio).toBe(0.5);
    }
  });
});
