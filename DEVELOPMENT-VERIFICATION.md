# Change-aware development verification

Run `pnpm verify:change` after a coherent local change. It compares the exact current Wargr source
with the last successful proof, reuses checks only while their owned inputs are byte-identical, and
runs independent selected checks together. The first run deliberately executes the complete `pnpm
check` gate.

Useful controls:

```bash
pnpm verify:change --plan
pnpm verify:change --visual
pnpm verify:change --force
pnpm verify:change --full
```

## Wargr map

- Documentation uses formatting only.
- Presentation changes use formatting, types, a production browser build, and the affected real
  article, Studio, or home route in the already-running local product on port `4260`.
- Changes to the tracked generated article snapshot additionally run the repository's build and
  snapshot contracts. They never read the article database.
- E2E changes run the isolated repository-owned E2E command.
- Dependencies, repository authority, server and Studio server code, image masters, content
  generation/transaction and publisher machinery, installers, service/release definitions, and
  this verifier's trust implementation use the complete `pnpm check` gate.
- Unclassified source changes fail conservatively into the complete gate.

Ordinary verification reads only Wargr's tracked presentation snapshot. Only the explicit
generated-content transaction may read the article database, and this verifier never invokes it.
The verifier also never starts, stops, or repairs the development environment. Receipts and
screenshots stay in ignored `.run/verification/` with private permissions and must never be
committed.

The authoritative option meanings, hashing, evidence, escalation, and release-separation contract
lives in the Development root's
[`DEVELOPMENT-VERIFICATION.md`](https://github.com/mikaelcedergren/development-root/blob/main/DEVELOPMENT-VERIFICATION.md).
This file owns only Wargr's checks, paths, publisher boundary, and rendered routes.
