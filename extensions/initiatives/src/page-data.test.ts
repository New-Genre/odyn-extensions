import { describe, expect, test } from 'bun:test'
import type { ChatSummary } from '@odyn-app/api'
import { workspaceOf } from './page-data'

function chat(id: string, workspaceChatId: string | undefined): ChatSummary {
  return { id, projectId: 'project-1', title: id, updatedAt: '2026-11-02', isWorking: false, workspaceChatId }
}

describe('workspaceOf', () => {
  const chats = [chat('main-1', 'main-1'), chat('sub-1', 'main-1'), chat('older', undefined)]

  test('finds the workspace of a chat in the list', () => {
    expect(workspaceOf(chats, 'sub-1')).toBe('main-1')
    expect(workspaceOf(chats, 'main-1')).toBe('main-1')
  })

  test('treats a chat with no workspace as its own', () => {
    expect(workspaceOf(chats, 'older')).toBe('older')
  })

  test('gives nothing for a chat from another project', () => {
    expect(workspaceOf(chats, 'elsewhere')).toBeNull()
  })
})
