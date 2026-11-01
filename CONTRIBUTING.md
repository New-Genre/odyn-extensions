# Making an extension

This is the step-by-step. For what extensions can and can't do, every permission, limit and manifest field, read the [extension docs](https://www.odyn.build/docs/extensions).

## 1. Create a folder

Add `extensions/<your-id>/` with a `package.json`. The folder name must match `odyn.id`.

```json
{
  "name": "odyn-extension-standup-notes",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "@odyn-app/api": "^0.1.0"
  },
  "odyn": {
    "id": "standup-notes",
    "title": "Standup notes",
    "description": "Turns today's chats into a standup.",
    "author": "Your name",
    "apiVersion": 4,
    "permissions": ["chats:read", "agent:tools"],
    "agent": { "summary": "Writes a standup from today's chats." },
    "commands": [
      {
        "name": "write-standup",
        "title": "Write standup",
        "placement": "agentTool",
        "description": "Lists the chats worked on today."
      }
    ]
  }
}
```

Ask only for the permissions you use. People see the list before they install.

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
    'write-standup': async ({ odyn }) => {
      const chats = await odyn.chats.list()
      return chats.map((chat) => `- ${chat.title}`).join('\n')
    },
  },
})
```

Pages can use Odyn's look: `@import "@odyn-app/api/theme.css";` in your stylesheet, and `Button`, `Skeleton`, `SettingRow` and `Orb` from `@odyn-app/api/ui`.

An extension may only use its own folder and installed packages. The build stops if it reaches anywhere else.

## 3. Try it in Odyn

```bash
bun install
bun run build <your-id>
```

In Odyn, open Marketplace → Extensions → Install from folder, and pick `build/<your-id>`. Choose Reload after each rebuild.

## 4. Open a pull request

The checks type-check, run the tests, build every extension, and check each manifest with the same checker Odyn uses. Once your pull request is reviewed and merged, your extension is released and appears in Odyn's Marketplace.

To release a change later, raise `version` in your `package.json` in the same pull request.
