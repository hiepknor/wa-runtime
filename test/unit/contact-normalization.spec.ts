import { describe, expect, it } from 'vitest';
import { normalizeContactIdentity, normalizeContactName } from '../../src/modules/contacts/contact-normalization';

describe('contact normalization', () => {
  it('keeps an unresolved LID first-class and never derives a phone', () => {
    expect(normalizeContactIdentity(' 12345:7@lid ')).toEqual({
      type: 'LID',
      value: '12345@lid',
      phone: null,
    });
  });

  it('folds a Baileys phone JID to the neutral dialect', () => {
    expect(normalizeContactIdentity('628111:3@s.whatsapp.net')).toEqual({
      type: 'PHONE_JID',
      value: '628111@c.us',
      phone: '628111',
    });
  });

  it('does not classify a non-numeric user JID as a phone identity', () => {
    expect(normalizeContactIdentity('customer@s.whatsapp.net')).toEqual({
      type: 'OTHER_JID',
      value: 'customer@s.whatsapp.net',
      phone: null,
    });
  });

  it('normalizes a useful Unicode name and rejects identifiers as names', () => {
    const identity = normalizeContactIdentity('628111@c.us');
    expect(normalizeContactName('  Nguye\u0302̃n  ', identity)).toBe('Nguyễn');
    expect(normalizeContactName('628111', identity)).toBeNull();
    expect(normalizeContactName('628111@c.us', identity)).toBeNull();
    expect(normalizeContactName('628111:9@s.whatsapp.net', identity)).toBeNull();
    expect(normalizeContactName('   ', identity)).toBeNull();
  });

  it('rejects control characters and names beyond the storage bound', () => {
    const identity = normalizeContactIdentity('628111@c.us');
    expect(normalizeContactName('unsafe\u0000name', identity)).toBeNull();
    expect(normalizeContactName('a'.repeat(256), identity)).toBe('a'.repeat(256));
    expect(normalizeContactName('a'.repeat(257), identity)).toBeNull();
  });
});
