# Making an extension

This is the step-by-step. For what extensions can and can't do, every permission, limit and manifest field, read the [extension docs](https://www.odyn.build/docs/extensions).

You don't need to clone this repo. The `odyn-extension` tool, which comes with the kit, starts a new extension on your Mac, rebuilds it as you work, and sends it here as a pull request (a proposed change) for review.

## 1. Start one

```bash
bunx --package @odyn-app/api odyn-extension create "Standup notes"
cd standup-notes
bun install
```

This makes a working extension with one command. Its `package.json` holds the manifest — what the extension is and what it asks for:

```json
{
  "name": "odyn-extension-standup-notes",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "odyn-extension dev",
    "build": "odyn-extension build",
    "check": "odyn-extension check",
    "publish": "odyn-extension publish"
  },
  "dependencies": {
    "@odyn-app/api": "^0.2.0"
  },
  "odyn": {
    "id": "standup-notes",
    "title": "Standup notes",
    "description": "Turns today's chats into a standup.",
    "author": "Your name",
    "owners": ["your-github-username"],
    "apiVersion": 4,
    "permissions": ["chats:read"],
    "commands": [
      { "name": "show-standup", "title": "Show standup", "placement": "sidebarPanel" }
    ]
  }
}
```

`owners` lists the GitHub usernames of the people who look after the extension. They're asked to review every change to it. Ask only for the permissions you use — people see the list before they install.

## 2. Write it

What you write depends on what the extension has:

| What it has | Write | Built to |
| --- | --- | --- |
| Commands | `src/index.ts`, calling `defineExtension` | `dist/index.js` |
| A page (above the message box, or in its settings) | `index.html` plus `src/main.tsx` | `dist/panel/` |
| An agent guide | a folder named in `odyn.agent.skillFolder` | copied as it is |

```ts
import { defineExtension } from '@odyn-app/api'

defineExtension({
  commands: {
    'show-standup': async ({ odyn }) => {
      const chats = await odyn.chats.list()
      return { type: 'detail', markdown: chats.map((chat) => `- ${chat.title}`).join('\n') }
    },
  },
})
```

Pages can use Odyn's look: `@import "@odyn-app/api/theme.css";` in your stylesheet, and `Button`, `Skeleton`, `SettingRow` and `Orb` from `@odyn-app/api/ui`.

An extension may only use its own folder and installed packages. The build stops if it reaches anywhere else.

## 3. Try it in Odyn

```bash
bun run dev
```

This rebuilds on every save. In Odyn, open Marketplace → Extensions → Install from folder and pick the extension's folder; Odyn reloads it after each rebuild.

## 4. Publish

```bash
bun run publish
```

The first time, this opens GitHub so you can sign in. It then copies your extension into your own copy of this repo and opens a pull request. The checks type-check, build every extension, and check each manifest with the same checker Odyn uses.

Once it's reviewed and merged, your extension is released and appears in Odyn's Marketplace.

## Updating it later

Raise `version` in your `package.json`, then `bun run publish` again — it updates your open pull request, or opens a new one. Changes to an extension are reviewed by its owners and by Odyn.

To work on an extension that's already published, get just that one:

```bash
bunx --package @odyn-app/api odyn-extension pull standup-notes
```

## What's kept for Odyn's own extensions

Running Mac programs (`programs:run`) and a background helper are only for the extensions Odyn makes. The checker refuses them anywhere else.
