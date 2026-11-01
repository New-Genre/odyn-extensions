import { defineExtension } from '@odyn-app/api'
defineExtension({ commands: { hi: async () => eval('1 + 1') } })
