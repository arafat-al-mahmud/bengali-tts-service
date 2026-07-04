import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/errors.js';
import { bengaliRatio, validateTtsText } from '../src/lib/tts-text.js';

const BENGALI = 'আজকের আবহাওয়া খুব সুন্দর';

function codeOf(fn: () => void): string {
  try {
    fn();
    return 'NO_ERROR';
  } catch (err) {
    if (err instanceof ApiError) return err.code;
    throw err;
  }
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
    expect(codeOf(() => validateTtsText(BENGALI, 1000))).toBe('NO_ERROR');
  });

  it('accepts Bengali with digits, punctuation, and a loanword', () => {
    const realWorld = 'আগামীকাল সকাল ১০টায় সভা অনুষ্ঠিত হবে; বিস্তারিত সময়সূচি email করা হয়েছে।';
    expect(codeOf(() => validateTtsText(realWorld, 1000))).toBe('NO_ERROR');
  });

  it('rejects empty and whitespace-only text as TEXT_EMPTY', () => {
    expect(codeOf(() => validateTtsText('', 1000))).toBe('TEXT_EMPTY');
    expect(codeOf(() => validateTtsText('   ', 1000))).toBe('TEXT_EMPTY');
  });

  it('rejects text over the length cap as TEXT_TOO_LONG', () => {
    expect(codeOf(() => validateTtsText('আ'.repeat(1001), 1000))).toBe('TEXT_TOO_LONG');
    expect(codeOf(() => validateTtsText('আ'.repeat(1000), 1000))).toBe('NO_ERROR');
  });

  it('rejects predominantly non-Bengali text as TEXT_NOT_BENGALI', () => {
    expect(codeOf(() => validateTtsText('hello world this is english', 1000))).toBe(
      'TEXT_NOT_BENGALI',
    );
    expect(codeOf(() => validateTtsText(`mostly english text here ${BENGALI.slice(0, 4)}`, 1000))).toBe(
      'TEXT_NOT_BENGALI',
    );
  });
});
