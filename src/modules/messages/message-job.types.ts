export const MESSAGE_JOB_STATUSES = [
  'SCHEDULED',
  'QUEUED',
  'PROCESSING',
  'ACCEPTED',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
  'UNKNOWN',
  'DRY_RUN_COMPLETED',
  'CANCELLED',
] as const;

export type MessageJobStatus = (typeof MESSAGE_JOB_STATUSES)[number];

export interface MessageJob {
  id: string;
  idempotencyKey: string;
  sessionId: string;
  recipientId: string;
  payload: { text: string };
  scheduledAt: Date;
  status: MessageJobStatus;
  dryRun: boolean;
  attemptCount: number;
  openwaMessageId: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageSendQueuePayload {
  messageJobId: string;
}
