// When the editor may save: never over someone else's newer change.
import type { ExtensionNote } from '@odyn-app/api'

export type SaveDecision = 'save' | 'skip' | 'conflict'

/**
 * `started` is the copy the edits began from, `fresh` the copy just read back,
 * `text` what the person has typed. A document that is gone, or that someone
 * else changed since `started`, is a clash; one that already says `text` needs
 * no save.
 */
export function saveDecision(started: ExtensionNote, fresh: ExtensionNote | null, text: string): SaveDecision {
  if (fresh === null) return 'conflict'
  if (fresh.markdown === text) return 'skip'
  if (fresh.markdown !== started.markdown) return 'conflict'
  return 'save'
}
