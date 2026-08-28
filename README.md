# wargr.com

Michael Wargr's essays — Angular 22 SSG on cx-framework (light theme), served by the compiled shared
TypeScript/Express runtime on the Mac mini (port 3060). Articles are synchronized from
`../ghostwriter` (files prefixed `☑` are published) into a tracked presentation snapshot. See
[AGENTS.md](AGENTS.md).

```bash
pnpm install
pnpm sync:content  # explicitly regenerate the snapshot from ☑ essays and image masters
pnpm build         # prerender the tracked snapshot and compile the production server
pnpm build:server:release # internal self-contained server-artifact build
pnpm check         # platform, formatting, typecheck, Node contracts, and production build
pnpm e2e           # isolated Chromium smoke test of a temporary production build
pnpm start         # serve at http://127.0.0.1:3060 (health: /healthz)
```

`pnpm build` and CI deliberately compile only the checked-in snapshot, so a clean checkout never
needs Ghostwriter or macOS image tooling. `pnpm sync:content` first proves one non-empty,
collision-free slug inventory, then renders the complete image/source snapshot in a bounded sibling
stage. A journaled exact-output swap restores the old inodes on failure and is recovered before the
next attempt. The scheduled path keeps that journal open until the input and generated-source proofs
succeed, then records the source attestation as the transaction's durable commit boundary. It never
deletes or partially rewrites the tracked presentation while rendering, and a pre-commit failure
also restores the exact previous attestation. Manual and scheduled generation share one persistent
kernel-lock inode. Scheduled publication uses command-form `lockf -k`, keeping the lock owner alive
around its complete multi-command worker; the manual entrypoint uses fd form and transfers that
descriptor into its single Node transaction with `exec`. Neither path unlinks the inode, and
whole-process death releases the lock. Recovery writes a durable restored checkpoint before
removing its backup tree, so another crash during cleanup is retryable. The next attempt removes
only structurally exact bounded pre-journal staging residue before retrying.

The launchd sync job detects changed essays or image masters and publishes the regenerated snapshot
through the shared atomic browser-release command:

```bash
node ../server-ops/bin/site-release.mjs --site wargr --browser-only --apply
```

The installed target definition selects a digest-qualified sealed publisher closure, not
`wargr/bin` or sibling `server-ops` code from the mutable checkout. Its launcher authenticates the
generator, source guard, release tooling, configuration, and Node package closure before execution.
The source guard permits a clean post-commit/pull/rebase HEAD to become the new authority; a dirty
tree must still match the exact last successful attestation. When an existing attestation names a
different HEAD, scheduled adoption additionally accepts only explicit `src/`, `public/`, brand, and
article-image presentation paths; package, lock, workspace/configuration, server, launchd, publisher,
and tooling changes require operator review instead of being smuggled into a browser-only release.
This automated path is explicitly browser-only; a change that can affect the server uses the paired transaction. The input signature
is recorded only after the command succeeds, so failed builds are retried. The shared release and
rollback contract is documented in
[`../SERVER-STANDARD.md`](../SERVER-STANDARD.md).

The production server is a strict NodeNext TypeScript composition of the published
`@mikaelcedergren/cx-framework/server/static-site` runtime and compiles to
`server/dist/index.js`. Its isolated `server/` workspace prevents Angular and other browser-only
packages from entering the deployable server artifact.

The lock and physical browser/server installations resolve published framework `0.9.5` at GitHub
commit `ce40d80dd055ad5de53e5779393993b1fc82db42`, and the clean source and hermetic E2E gates pass.
The root [`WEB-ARCHITECTURE-MIGRATION.md`](../WEB-ARCHITECTURE-MIGRATION.md) owns exact rollout
evidence. The tracked LaunchDaemon template points at the future atomic `current-server` artifact;
it must not be installed or bootstrapped before source-identical candidates are selected through
the authorised paired cutover.

`bin/install-server-daemon` is the check-first web-definition installer. Its default/`--check` mode
is non-mutating; after the authorised first selection, `--apply` validates the selected artifact and
delegates the exact unloaded/target-state write to the shared
[`server-ops` installer contract](../server-ops/README.md#install-service-definitions-after-a-first-selection).
It never owns or changes the separate `com.wargr.sync` publisher definition and never bootstraps or
restarts either job.

`bin/install-publisher-daemon` is the separate check-first publisher installer. `--check` builds and
verifies the sealed closure without persistent changes. After an authorised maintenance window has
left `com.wargr.sync` exactly unloaded and removed its legacy mutable-checkout definition, `--apply`
publishes the immutable release and delegates only the exact definition write to the shared
installer. It never loads, unloads, bootstraps, kickstarts, or restarts the job.
Installed publisher closures retain the selected digest plus at most two authenticated predecessors
under hard count and byte ceilings; older closures are identity-checked again before removal.

Until the authorised cutover, the installed service still requires the exact baseline
`server/index.mjs` wrapper. `pnpm test:selected-runtime` prevents its premature removal or
modification.
