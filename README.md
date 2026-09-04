# wargr.com

Michael Wargr's essays — Angular 22 SSG on cx-framework plus the private Studio, served by one
compiled TypeScript/Express web process on the Mac mini (port 3060) with a separate listener-free
AI polish worker. Essays are authored in the Studio at `/studio` and stored in the article
database (`data/wargr.db`); the sealed publisher regenerates the tracked presentation snapshot
from the database's published closure. See [AGENTS.md](AGENTS.md).

```bash
pnpm install
pnpm dev              # Angular on 4260, API + worker on 4261, dev database under .run/dev
pnpm generate:content # explicitly regenerate the snapshot from published essays and image masters
pnpm build            # prerender the tracked snapshot and compile the production web/worker
pnpm build:server:release # internal self-contained server-artifact build
pnpm check            # platform, formatting, typecheck, Node contracts, and production build
pnpm e2e              # isolated Chromium smoke test of a temporary production build
pnpm start:web        # serve at http://127.0.0.1:3060 (health: /healthz)
pnpm start:worker     # the compiled polish worker
```

## The Studio

`/studio` is the owner's writing room: essay drafts, the ghostwriter polish loop (four rewrite
intensities carrying the ported voice contract), a bounded round history per essay, and the
publish/unpublish switch. It authenticates one owner (scrypt-hashed password in the web role's
`.env.web`), runs over the typed `/api/studio` contract with compare-and-swap revisions, and is
never indexed. AI rounds run as durable jobs in the worker process, which alone holds
`OPENAI_API_KEY` (in `.env.worker`); paid provider work is fenced by idempotent effect receipts so
a crash never buys the same round twice.

## Publishing

Publishing in the Studio changes only the database. The site changes through the sealed publisher:
its input digest covers exactly the published records (content-derived hashes and publish dates)
and the canonical `article-images/<slug>.png` master bytes — drafts, polish rounds, and session
writes never trigger a rebuild. The locked transaction renders the complete image/source snapshot
in a bounded sibling stage, performs a journaled exact-output swap with crash recovery, records
the generated-source attestation as its durable commit boundary, then activates the shared atomic
browser-only release:

```bash
node ../server-ops/bin/site-release.mjs --site wargr --browser-only --apply
```

Manual (`pnpm generate:content`) and scheduled generation share one persistent kernel-lock inode
(`.run/content-publish.lock`). Scheduled publication uses command-form `lockf -k`; the manual
entrypoint uses fd form and transfers the descriptor into its single Node transaction with `exec`.
Neither path unlinks the inode, and whole-process death releases the lock. The input signature is
recorded only after the release succeeds, so failed builds are retried.

The installed publisher definition (`com.wargr.publisher`) selects a digest-qualified sealed
closure, not `wargr/bin` or sibling `server-ops` code from the mutable checkout. The source guard
permits a clean post-commit/pull/rebase HEAD to become the new authority; a dirty tree must still
match the exact last successful attestation, and scheduled acceptance of a different HEAD permits
only explicit presentation paths. This automated path is explicitly browser-only: server changes
use the shared server-release flow, and anything that can affect both closures uses the paired
transaction ([`../SERVER-STANDARD.md`](../SERVER-STANDARD.md)).

## Server

The production server is a strict NodeNext TypeScript composition over the published
`@mikaelcedergren/cx-framework` server entrypoints (security, sessions, SQLite, durable jobs,
static serving) and compiles to `server/dist/index.js` (web) and `server/dist/worker.js` (jobs).
Its isolated `server/` workspace prevents Angular and other browser-only packages from entering
the deployable artifact. The package comes from GitHub `main`; `pnpm-lock.yaml` records the exact
immutable resolution.

`bin/install-server-daemon` is the check-first installer for the web and jobs definitions;
`bin/install-publisher-daemon` builds and verifies the sealed publisher closure and, during an
authorised unloaded maintenance window, publishes the immutable release and delegates the exact
definition write to the shared `server-ops` installer. Neither installer loads, bootstraps, or
restarts a service. The bounded `publisher-contract.json` is Wargr's sole declaration of the
generator sources, database/image inputs, and log paths in that closure.

The retired ghostwriter repository's essays were migrated into the database once via
`scripts/import-ghostwriter-articles.mjs`; the voice contract lives on in
`server/src/voice-contract.ts`.
