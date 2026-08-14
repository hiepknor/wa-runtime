const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

async function request(baseUrl: string, runtimeKey: string, path: string, init: RequestInit) {
  const response = await fetch(`${baseUrl.replace(/\/$/u, '')}/api/v1${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-runtime-key': runtimeKey,
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`Fixture request failed (${response.status}): ${JSON.stringify(body)}`);
  return body;
}

async function main(): Promise<void> {
  const baseUrl = required('CAMPAIGN_FIXTURE_RUNTIME_URL');
  const runtimeKey = required('CAMPAIGN_FIXTURE_RUNTIME_KEY');
  const sessionId = required('CAMPAIGN_FIXTURE_SESSION_ID');
  const idempotencyKey = required('CAMPAIGN_FIXTURE_IDEMPOTENCY_KEY');
  const groupIds = (process.env.CAMPAIGN_FIXTURE_GROUP_IDS ?? '')
    .split(',').map(value => value.trim()).filter(Boolean);
  const canonical = {
    sessionId,
    name: 'WA Studio campaign fixture',
    text: 'Safe staging preflight fixture. No run is created.',
    scheduleType: 'IMMEDIATE',
  };
  const campaign = await request(baseUrl, runtimeKey, '/campaigns', {
    method: 'POST', headers: { 'idempotency-key': idempotencyKey }, body: JSON.stringify(canonical),
  });
  const campaignId = String(campaign.id);
  await request(baseUrl, runtimeKey, `/campaigns/${campaignId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      name: canonical.name, text: canonical.text, scheduleType: 'IMMEDIATE', scheduledAt: null,
    }),
  });
  await request(baseUrl, runtimeKey, `/campaigns/${campaignId}/targets`, {
    method: 'PUT', body: JSON.stringify({ groupIds }),
  });
  process.stdout.write(`Reset reusable campaign fixture ${campaignId} with ${groupIds.length} targets\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
