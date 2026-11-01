# Odyn extensions

Every extension in Odyn's Marketplace lives here: the ones made by Odyn and the ones made by everyone else. Odyn downloads an extension only when someone installs it.

## How it works

- Each extension is a folder in [`extensions/`](extensions). Its `package.json` describes it in an `odyn` section (the manifest).
- Extensions are built with [`@odyn-app/api`](https://www.npmjs.com/package/@odyn-app/api), Odyn's public building kit. It's the only part of Odyn an extension can use.
- When a change is merged and an extension's `version` has gone up, a workflow builds it, attaches it to a GitHub release, and adds it to [`index.json`](index.json). That's the list Odyn reads.
- Odyn checks each download's size and checksum (a fingerprint of the file) against `index.json` before unpacking it. Every extension runs sandboxed, and each call it makes is checked against the permissions the user agreed to.

## Make an extension

The [extension docs](https://www.odyn.build/docs/extensions) cover what extensions can and can't do, every permission and limit, and the full reference. [CONTRIBUTING.md](CONTRIBUTING.md) is the step-by-step for adding one here.

## Commands

```bash
bun install
bun run build            # build every extension into build/
bun run build phones     # build only the ones named
bun run typecheck
bun run test
bun run release          # dry run: shows what would be released
```

## Licence

MIT. See [LICENSE](LICENSE).

<!-- CodeRabbit test -->
