import { AsyncLocalStorage } from 'node:async_hooks';

export type CorrelationContext = Readonly<Record<string, string | number | boolean | undefined>>;

const storage = new AsyncLocalStorage<CorrelationContext>();

export function correlationContext(): CorrelationContext {
  return storage.getStore() ?? {};
}

export function withCorrelationContext<T>(context: CorrelationContext, operation: () => T): T {
  return storage.run({ ...correlationContext(), ...context }, operation);
}
