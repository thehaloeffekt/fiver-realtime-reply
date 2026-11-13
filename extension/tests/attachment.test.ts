import { describe, expect, it } from 'vitest';
import { describeBody } from '../src/lib/toast';

describe('attachment rule', () => {
  it.each([
    ['1 File', 1, 'Sent 1 file. Check Fiverr.'],
    ['2 Files', 2, 'Sent 2 files. Check Fiverr.'],
    ['12 Files', 12, 'Sent 12 files. Check Fiverr.'],
    ['  3 Files  ', 3, 'Sent 3 files. Check Fiverr.'],
  ])('"%s" is an attachment-only message', (body, files, text) => {
    expect(describeBody(body)).toEqual({ kind: 'attachment', files, text });
  });

  it.each(['1 File attached', 'File', '1 file', '1  File', 'Files', 'see 2 Files', '1 Filess', '-1 File', '1.5 Files'])(
    '"%s" is normal text',
    (body) => {
      expect(describeBody(body)).toEqual({ kind: 'text', text: body.trim() });
    },
  );

  it('turns an empty body into the empty-message line', () => {
    expect(describeBody('')).toEqual({ kind: 'empty', text: '(empty message, check Fiverr)' });
    expect(describeBody('  \n ')).toEqual({ kind: 'empty', text: '(empty message, check Fiverr)' });
  });

  it('keeps text messages as they are (text + file shows only the text)', () => {
    expect(describeBody('Here is the brief')).toEqual({ kind: 'text', text: 'Here is the brief' });
  });
});
