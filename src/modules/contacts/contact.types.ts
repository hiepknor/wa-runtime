export const CONTACT_IDENTITY_TYPES = ['LID', 'PHONE_JID', 'PHONE', 'OTHER_JID'] as const;
export type ContactIdentityType = (typeof CONTACT_IDENTITY_TYPES)[number];

export const CONTACT_NAME_SOURCES = [
  'OPENWA_CONTACT_NAME',
  'GROUP_PARTICIPANT_NAME',
  'OPENWA_PUSH_NAME',
] as const;
export type ContactNameSource = (typeof CONTACT_NAME_SOURCES)[number];

export interface NormalizedContactIdentity {
  type: Exclude<ContactIdentityType, 'PHONE'>;
  value: string;
  phone: string | null;
}

