interface ContactNameSqlInput {
  contactName: string;
  pushName: string;
}

interface MemberNameSqlInput {
  contactName: string;
  contactSource: string;
  participantName: string;
}

export interface NameProjectionSql {
  name: string;
  source: string;
}

export function contactNameProjectionSql(input: ContactNameSqlInput): NameProjectionSql {
  return {
    name: `COALESCE(${input.contactName}, ${input.pushName})`,
    source: `CASE
      WHEN ${input.contactName} IS NOT NULL THEN 'OPENWA_CONTACT_NAME'
      WHEN ${input.pushName} IS NOT NULL THEN 'OPENWA_PUSH_NAME'
      ELSE NULL
    END`,
  };
}

export function memberNameProjectionSql(input: MemberNameSqlInput): NameProjectionSql {
  return {
    name: `CASE
      WHEN ${input.contactSource} = 'OPENWA_CONTACT_NAME' THEN ${input.contactName}
      WHEN ${input.participantName} IS NOT NULL THEN ${input.participantName}
      WHEN ${input.contactSource} = 'OPENWA_PUSH_NAME' THEN ${input.contactName}
      ELSE NULL
    END`,
    source: `CASE
      WHEN ${input.contactSource} = 'OPENWA_CONTACT_NAME' THEN 'OPENWA_CONTACT_NAME'
      WHEN ${input.participantName} IS NOT NULL THEN 'GROUP_PARTICIPANT_NAME'
      WHEN ${input.contactSource} = 'OPENWA_PUSH_NAME' THEN 'OPENWA_PUSH_NAME'
      ELSE NULL
    END`,
  };
}
