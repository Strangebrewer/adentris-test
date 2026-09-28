# Patient event ingestion service

Takes patient events over HTTP, processes each one (a slow ~5s external call, simulated), and keeps a
per-patient state that reflects the events in `ts` order, no matter what order they arrive or finish in.
NestJS, TypeScript and MongoDB.

## Running it

You need Node 22.9+, pnpm and Docker.

```bash
docker compose up -d      # Mongo
pnpm install
pnpm build
pnpm start:api            # terminal 1, port 3000
pnpm start:worker         # terminal 2 (start more for more throughput)
pnpm demo                 # terminal 3
```

`pnpm demo` sends one patient a scrambled burst of events (plus a duplicate and a late one), waits for them
to be processed, and checks the result against the expected `ts`-ordered state.

`pnpm test` runs the tests. The integration tests need the Mongo container running. `.env.example` lists
the settings; all of them have defaults.

API:

- `POST /events` stores the event and answers `202 { id }` straight away. A duplicate gets the same answer.
- `GET /events/:id` shows an event's status and result.
- `GET /patients/:patientId` shows the patient's current state.
- `GET /health` shows queue numbers: depth, in flight, failed, and so on.

## Architecture

The API and the worker are separate processes that only share Mongo.

The API validates an event, writes it to the `rawEvents` collection and answers `202`. It never waits on
processing.

The worker claims events from `rawEvents`, makes the slow call, caches the result on the event, and then
folds it into that patient's state in `patientProjections`. Each worker handles up to 25 events at once.
You scale by running more workers.

## Significant decisions

**Mongo is the queue.** No Redis or message broker. An event is claimed with one atomic update that also
sets a lease (a time after which another worker may take it). That's enough for several workers to share
the work safely, and it keeps everything to one datastore that can run locally in one command.

**The idempotency key is a hash of the event's content.** Events come with no id, and senders retry. The id
is a hash of `patientId`, `type`, `ts` and `data`, with keys sorted and `ts` normalised first, so a retry
produces the same id and Mongo's unique `_id` rejects the second copy. The sender gets the same response
either way.

**An event log plus a derived per-patient state.** Every event is kept in `rawEvents` as received. A
patient's state is a fold of their events in `ts` order. When an event arrives late (behind events already
folded in), the state is recomputed with it in its right place instead of being patched. Snapshots every
20 events keep that recompute short for patients with long histories. The processing logic itself is
deliberately trivial; the brief says only the timing matters.

**Leases and a claim token make crashes safe.** If a worker dies mid-event, the lease runs out and another
worker picks the event up. An event is only marked done after the state includes it, so a crash in between
just means the commit is redone. Every claim also gets a new token, and all later writes check it, so a
worker that was only slow (not dead) can't write after its event has been taken over. Nothing is counted
twice.

**A failed event blocks its patient, visibly.** Errors are retried with backoff, up to 5 times. After that
the event is marked `failed`, and later events for that patient wait behind it. `GET /patients/:id` shows
which event is blocking. I chose a stale but honest state over one that silently skips an event, since
this is clinical data.

## Trade-offs I accepted

- `ts` is trusted as sent. The only check is that it isn't more than 5 minutes in the future, because one
  far-future `ts` would make every later event for that patient look late.
- `ts` must be RFC 3339, which means it needs a UTC offset (`Z` or `+02:00`). That's narrower than "ISO
  8601". Without an offset the same event could land on different instants depending on the server's time
  zone.
- An earlier event is only waited for if it has actually been received. There's no way to know about one
  that was never sent.
- A failed event stalls its patient until someone fixes the cause and re-queues it:

  ```bash
  docker compose exec mongo mongosh adentris --eval \
    'db.rawEvents.updateOne({ _id: "<event id>" }, { $set: { status: "pending", claimableAt: new Date(), attempts: 0, lastError: null } })'
  ```

- The event log grows forever. How long clinical data has to be kept, and where it goes afterwards, is a
  retention decision, not something this service should decide.
- The brief says to persist the outcome in a single collection. `rawEvents` is that collection: it holds
  every event and its outcome. The projection and snapshot collections are caches that can be rebuilt from
  it.
- Throughput: 25 events at once × ~5s is about 300 events a minute per worker, so 1000 a minute takes about
  4 workers.

## What I'd do differently with more time

I'd start simpler. This went well past the suggested effort, mostly because I kept finding edge cases in
concurrent commits for the same patient and adding a mechanism for each one.

The biggest change would be running Mongo as a single-node replica set, so I could use transactions.
Committing an event means writing the event and the patient's state together, and a transaction does that
atomically. That would replace most of the hand-rolled concurrency handling (the claim token checks,
version checks on the state, and snapshot generations) with a few lines. I avoided it at the start to keep
local setup to one plain `docker compose up`, and I think that was the wrong call.

I'd also add real crash testing (killing worker processes under load), and send metrics somewhere proper
instead of just a `/health` endpoint and logs.
