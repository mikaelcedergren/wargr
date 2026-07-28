# wargr.com

Michael Wargr's essays — Angular 22 SSG on cx-framework (light theme), served by Express on the Mac
mini (port 3060). Articles are pulled from `../ghostwriter` (files prefixed `☑` are published) and
rebuilt automatically when ghostwriter changes. See [AGENTS.md](AGENTS.md).

```bash
pnpm install
pnpm build     # import ☑ essays -> prerender -> dist/browser
pnpm start     # serve at http://127.0.0.1:3060  (health: /healthz)
```

`pnpm build` remains the local build. The launchd sync job publishes changed essays and article
images through the shared atomic release command:

```bash
node ../server-ops/bin/site-release.mjs --site wargr --apply
```

The sync signature is recorded only after the command succeeds, so failed builds are retried. The
shared release and rollback contract is documented in
[`../SERVER-STANDARD.md`](../SERVER-STANDARD.md).
