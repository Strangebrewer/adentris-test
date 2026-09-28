import { setTimeout } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { loadConfig } from './config/app-config';
import { foldAll, PatientState } from './projections/fold';
import { ProcessingResult } from './raw-events/raw-event.model';

/**
 * Shows the service fitting one patient's out-of-order events into `ts` order, over HTTP.
 * Needs Mongo, the API and at least one worker running (see the README). `pnpm demo` runs it.
 * It exits with 1 if the patient's state doesn't come out as expected.
 */

const api = `http://localhost:${loadConfig(process.env).port}`;
const patientId = `demo-${Date.now()}`;
// An hour ago, so no `ts` is rejected for being in the future.
const base = Date.now() - 60 * 60_000;

interface Reading {
  minute: number;
  bpm: number;
}

const BURST: Reading[] = [
  { minute: 3, bpm: 72 },
  { minute: 1, bpm: 68 },
  { minute: 5, bpm: 80 },
  { minute: 2, bpm: 70 },
  { minute: 4, bpm: 75 },
];
const LATE: Reading = { minute: 2.5, bpm: 71 };

/** What the API returns, as JSON. */
interface EventJson {
  id: string;
  ts: string;
  status: string;
  result: ProcessingResult | null;
}
interface PatientJson {
  state: PatientState | null;
  watermarkTs: string | null;
}

interface Sent extends Reading {
  id: string;
}

async function main(): Promise<void> {
  await checkApi();
  console.log(`Patient ${patientId}, against ${api}\n`);

  console.log(`1. Sending ${BURST.length} events out of ts order, minutes ${minutes(BURST)}`);
  const sent: Sent[] = [];
  for (const reading of BURST) sent.push(await send(reading));

  // The same event again, with its fields in a different order and its ts written differently.
  const first = sent[0];
  const { id: duplicateId } = await call<{ id: string }>('POST', '/events', {
    data: { bpm: first.bpm },
    ts: tsOf(first.minute).replace('Z', '+00:00'),
    type: 'heart-rate',
    patientId,
  });
  const same = duplicateId === first.id ? 'the same id, so it is stored once' : 'A DIFFERENT ID';
  console.log(`   Sent minute ${first.minute} again, written differently: got ${same}`);
  await waitUntilDone(sent);

  console.log(`\n2. Sending minute ${LATE.minute} late, after the later minutes have committed`);
  sent.push(await send(LATE));
  await waitUntilDone(sent);

  const matched = await report(sent);
  process.exitCode = matched ? 0 : 1;
}

async function report(sent: Sent[]): Promise<boolean> {
  const patient = await call<PatientJson>('GET', `/patients/${patientId}`);
  const events = await Promise.all(sent.map((s) => call<EventJson>('GET', `/events/${s.id}`)));
  const foldable = events.map((e) => ({ _id: e.id, processingResult: e.result ?? {} }));

  // The service's own results, folded in the order this script expects: by ts, then id.
  const byTs = [...events].sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
  const expected = foldAll(byTs.map((e) => ({ _id: e.id, processingResult: e.result ?? {} })));
  const inArrivalOrder = foldAll(foldable);
  const { state } = patient;
  const matched = isDeepStrictEqual(state, expected);
  const tsOrder = [...sent].sort((a, b) => a.minute - b.minute);

  console.log('\n3. Result');
  console.log(`   Arrival order (minutes): ${minutes(sent)}`);
  console.log(`   ts order (minutes):      ${minutes(tsOrder)}`);
  console.log(`   State: ${state?.eventCount} events, latest ${json(state?.latest)}`);
  console.log(`   Current as of: ${patient.watermarkTs}`);
  console.log(`   Compared with the expected ts-order fold: ${matched ? 'MATCH' : 'MISMATCH'}`);
  console.log(
    `   Folded in arrival order instead, latest would be ${json(inArrivalOrder.latest)}` +
      ` and the digest ${inArrivalOrder.digest === expected.digest ? 'would match' : 'would not'}`,
  );
  return matched;
}

async function send({ minute, bpm }: Reading): Promise<Sent> {
  const body = { patientId, type: 'heart-rate', ts: tsOf(minute), data: { bpm } };
  const { id } = await call<{ id: string }>('POST', '/events', body);
  return { minute, bpm, id };
}

/** Polls the events until they're all done, printing progress whenever it changes. */
async function waitUntilDone(sent: Sent[], timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (true) {
    const events = await Promise.all(sent.map((s) => call<EventJson>('GET', `/events/${s.id}`)));
    const done = events.filter((e) => e.status === 'done').length;
    const progress = `   ${done} of ${events.length} done`;
    if (progress !== last) console.log(progress);
    last = progress;
    if (done === events.length) return;
    if (Date.now() > deadline) {
      throw new Error(`Not all events were done after ${timeoutMs / 1000}s. Is a worker running?`);
    }
    await setTimeout(250);
  }
}

async function checkApi(): Promise<void> {
  try {
    await call('GET', '/health');
  } catch (err) {
    throw new Error(
      `Can't reach a healthy API at ${api}. Start Mongo, the API and a worker first (see the README).`,
      { cause: err },
    );
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

const tsOf = (minute: number) => new Date(base + minute * 60_000).toISOString();
const minutes = (readings: Reading[]) => readings.map((r) => r.minute).join(', ');
const json = (value: unknown) => JSON.stringify(value);

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
