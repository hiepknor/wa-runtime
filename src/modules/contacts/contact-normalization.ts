import type { NormalizedContactIdentity } from './contact.types';

const deviceSuffix = /:\d+(?=@)/u;
const phoneJidSuffix = /@(?:c\.us|s\.whatsapp\.net)$/u;
const controlCharacter = /\p{Cc}/u;
const maxContactNameCodePoints = 256;

export function normalizeContactIdentity(rawIdentity: string): NormalizedContactIdentity {
  const identity = rawIdentity.trim().replace(deviceSuffix, '');
  if (identity.endsWith('@lid')) return { type: 'LID', value: identity, phone: null };
  if (phoneJidSuffix.test(identity)) {
    const phone = identity.replace(phoneJidSuffix, '');
    if (/^\d+$/u.test(phone)) return { type: 'PHONE_JID', value: `${phone}@c.us`, phone };
  }
  return { type: 'OTHER_JID', value: identity, phone: null };
}

export function normalizeContactName(
  rawName: string | null | undefined,
  identity: NormalizedContactIdentity,
): string | null {
  const name = rawName?.trim().normalize('NFC');
  if (
    !name
    || [...name].length > maxContactNameCodePoints
    || controlCharacter.test(name)
    || name === identity.value
    || name === identity.phone
    || normalizeContactIdentity(name).value === identity.value
  ) return null;
  return name;
}
