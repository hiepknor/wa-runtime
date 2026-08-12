import { createHash } from 'node:crypto';

export function messageRequestHash(input: {
  sessionId: string;
  recipientId: string;
  text: string;
  scheduledAt: string | null;
  dryRun: boolean;
}): string {
  const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt).toISOString() : '';
  return createHash('sha256').update([
    input.sessionId,
    input.recipientId,
    input.text,
    scheduledAt,
    String(input.dryRun),
  ].join('\n')).digest('hex');
}
