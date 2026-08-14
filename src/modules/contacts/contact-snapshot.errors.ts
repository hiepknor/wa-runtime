export class ContactSnapshotConflictError extends Error {
  constructor() {
    super('Contact snapshot contains conflicting identity observations');
    this.name = 'ContactSnapshotConflictError';
  }
}
