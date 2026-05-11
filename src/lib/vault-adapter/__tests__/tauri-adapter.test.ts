// Tests for TauriVaultAdapter — verifies each method dispatches to the
// expected Tauri command name, that desktop/web shape impedance is
// surfaced through the `CONTRACT GAP` paths, and that the genuinely
// unsupported methods throw a named error rather than fabricating data.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type InvokeArgs = Record<string, unknown> | undefined
type InvokeHandler = (cmd: string, args: InvokeArgs) => unknown

let invokeHandler: InvokeHandler = () => {
  throw new Error('no invoke handler registered for this test')
}
const invokeMock = vi.fn(async (cmd: string, args?: InvokeArgs) => invokeHandler(cmd, args))

const convertFileSrcMock = vi.fn(
  (path: string, protocol?: string) => `asset://localhost/${protocol ?? 'asset'}/${path}`,
)

type ListenHandler<T> = (event: { payload: T }) => void
let lastListenEvent: string | null = null
let lastListenHandler: ListenHandler<unknown> | null = null
const unlistenMock = vi.fn(() => undefined)

const listenMock = vi.fn(async <T>(eventName: string, handler: ListenHandler<T>) => {
  lastListenEvent = eventName
  lastListenHandler = handler as ListenHandler<unknown>
  return unlistenMock
})

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  convertFileSrc: convertFileSrcMock,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}))

beforeEach(() => {
  invokeMock.mockClear()
  convertFileSrcMock.mockClear()
  listenMock.mockClear()
  unlistenMock.mockClear()
  lastListenEvent = null
  lastListenHandler = null
})

afterEach(() => {
  invokeHandler = () => {
    throw new Error('no invoke handler registered for this test')
  }
})

async function importAdapter() {
  return await import('../tauri-adapter')
}

describe('TauriVaultAdapter', () => {
  it('listVaults reads `load_vault_list` and maps entries to the contract', async () => {
    invokeHandler = (cmd) => {
      if (cmd === 'load_vault_list') {
        return {
          vaults: [
            { label: 'Work', path: '/home/u/Vaults/work' },
            { label: 'Personal', path: '/home/u/Vaults/personal', alias: 'Home' },
          ],
        }
      }
      throw new Error(`unexpected invoke: ${cmd}`)
    }
    const { TauriVaultAdapter } = await importAdapter()
    const adapter = new TauriVaultAdapter()
    const vaults = await adapter.listVaults()
    expect(vaults).toHaveLength(2)
    expect(vaults[0].id).toBe('/home/u/Vaults/work')
    expect(vaults[0].slug).toBe('work')
    expect(vaults[1].name).toBe('Home')
  })

  it('getVault matches by path id and throws if missing', async () => {
    invokeHandler = () => ({
      vaults: [{ label: 'Work', path: '/v/work' }],
    })
    const { TauriVaultAdapter, TauriAdapterNotImplementedError } = await importAdapter()
    const adapter = new TauriVaultAdapter()
    const vault = await adapter.getVault('/v/work')
    expect(vault.id).toBe('/v/work')

    await expect(adapter.getVault('/v/missing')).rejects.toBeInstanceOf(
      TauriAdapterNotImplementedError,
    )
  })

  it('createVault dispatches to `create_empty_vault` + `save_vault_list`', async () => {
    const invocations: Array<{ cmd: string; args: InvokeArgs }> = []
    invokeHandler = (cmd, args) => {
      invocations.push({ cmd, args })
      if (cmd === 'load_vault_list') {
        return {
          vaults: [{ label: 'Old', path: '/v/old' }],
          default_workspace_path: '/home/u/Vaults',
        }
      }
      if (cmd === 'create_empty_vault') return '/home/u/Vaults/new-vault'
      if (cmd === 'save_vault_list') return undefined
      throw new Error(`unexpected invoke: ${cmd}`)
    }
    const { TauriVaultAdapter } = await importAdapter()
    const adapter = new TauriVaultAdapter()
    const vault = await adapter.createVault({ name: 'New Vault', slug: 'new-vault' })
    expect(vault.id).toBe('/home/u/Vaults/new-vault')
    expect(vault.slug).toBe('new-vault')

    const commands = invocations.map((i) => i.cmd)
    expect(commands).toContain('create_empty_vault')
    expect(commands).toContain('save_vault_list')
  })

  it('listFolders flattens the tree returned by `list_vault_folders`', async () => {
    invokeHandler = (cmd, args) => {
      expect(cmd).toBe('list_vault_folders')
      expect(args).toEqual({ path: '/v/work' })
      return [
        {
          name: 'Projects',
          path: 'Projects',
          children: [{ name: 'Laputa', path: 'Projects/Laputa', children: [] }],
        },
      ]
    }
    const { TauriVaultAdapter } = await importAdapter()
    const adapter = new TauriVaultAdapter()
    const folders = await adapter.listFolders('/v/work')
    expect(folders.map((f) => f.id)).toEqual(['Projects', 'Projects/Laputa'])
    expect(folders[1].parentId).toBe('Projects')
  })

  it('listNotes reads `list_vault`, filters by folder, and paginates', async () => {
    invokeHandler = (cmd) => {
      expect(cmd).toBe('list_vault')
      return [
        { path: '/v/a.md', filename: 'a.md', title: 'A', fileSize: 100, modifiedAt: 30, archived: false },
        {
          path: '/v/Projects/b.md',
          filename: 'b.md',
          title: 'B',
          fileSize: 60,
          modifiedAt: 20,
          archived: false,
        },
        {
          path: '/v/Projects/c.md',
          filename: 'c.md',
          title: 'C',
          fileSize: 30,
          modifiedAt: 10,
          archived: false,
        },
      ]
    }
    const { TauriVaultAdapter } = await importAdapter()
    const adapter = new TauriVaultAdapter()
    const page = await adapter.listNotes('/v', { folderId: 'Projects', limit: 1 })
    expect(page.items).toHaveLength(1)
    expect(page.items[0].id).toBe('/v/Projects/b.md')
    expect(page.items[0].folderId).toBe('Projects')
    expect(page.nextCursor).toBe('1')
  })

  it('createNote dispatches `create_note_content` with a constructed path', async () => {
    let captured: InvokeArgs = undefined
    invokeHandler = (cmd, args) => {
      if (cmd === 'create_note_content') {
        captured = args
        return undefined
      }
      throw new Error(`unexpected invoke: ${cmd}`)
    }
    const { TauriVaultAdapter } = await importAdapter()
    const adapter = new TauriVaultAdapter()
    const note = await adapter.createNote('/v', {
      title: 'Hello World',
      bodyMd: '# h',
      folderId: 'Projects',
    })
    expect(note.id).toBe('/v/Projects/hello-world.md')
    expect(captured).toMatchObject({
      path: '/v/Projects/hello-world.md',
      content: '# h',
      vaultPath: '/v',
    })
  })

  it('saveNote dispatches `save_note_content` and mirrors version+1', async () => {
    invokeHandler = (cmd, args) => {
      expect(cmd).toBe('save_note_content')
      expect(args).toEqual({ path: '/v/a.md', content: 'body' })
      return undefined
    }
    const { TauriVaultAdapter } = await importAdapter()
    const adapter = new TauriVaultAdapter()
    const result = await adapter.saveNote('/v/a.md', {
      bodyMd: 'body',
      frontmatter: {},
      expectedVersion: 4,
    })
    expect(result).toEqual({ version: 5 })
  })

  it('deleteNote dispatches `delete_note`', async () => {
    invokeHandler = (cmd, args) => {
      expect(cmd).toBe('delete_note')
      expect(args).toEqual({ path: '/v/a.md' })
      return 'deleted'
    }
    const { TauriVaultAdapter } = await importAdapter()
    const adapter = new TauriVaultAdapter()
    await adapter.deleteNote('/v/a.md')
  })

  it('rename routes folder renames to `rename_vault_folder`', async () => {
    invokeHandler = (cmd, args) => {
      expect(cmd).toBe('rename_vault_folder')
      expect(args).toMatchObject({
        vaultPath: '/v',
        folderPath: 'Old',
        newName: 'New',
      })
      return { old_path: 'Old', new_path: 'New', affected_notes: [], updated_link_count: 0 }
    }
    const { TauriVaultAdapter } = await importAdapter()
    const adapter = new TauriVaultAdapter()
    const result = await adapter.rename('/v', 'Old', 'New')
    expect(result).toEqual({ affectedNoteIds: [], updatedLinkCount: 0 })
  })

  it('rename routes note renames to `update_wikilinks_for_renames`', async () => {
    const seen: string[] = []
    invokeHandler = (cmd) => {
      seen.push(cmd)
      return null
    }
    const { TauriVaultAdapter } = await importAdapter()
    const adapter = new TauriVaultAdapter()
    await adapter.rename('/v', '/v/a.md', '/v/b.md')
    expect(seen).toContain('update_wikilinks_for_renames')
  })

  it('search dispatches `search_vault` with the documented arg shape', async () => {
    invokeHandler = (cmd, args) => {
      expect(cmd).toBe('search_vault')
      expect(args).toMatchObject({ vaultPath: '/v', query: 'foo', mode: 'prefix', limit: 20 })
      return {
        results: [{ path: '/v/a.md', title: 'A', snippet: 'foo', score: 0.9 }],
        query: 'foo',
        mode: 'prefix',
        elapsed_ms: 7,
      }
    }
    const { TauriVaultAdapter } = await importAdapter()
    const adapter = new TauriVaultAdapter()
    const result = await adapter.search('/v', 'foo', 'prefix')
    expect(result.results[0].noteId).toBe('/v/a.md')
    expect(result.mode).toBe('prefix')
  })

  it('uploadAttachment throws TauriAdapterNotImplementedError (contract gap)', async () => {
    const { TauriVaultAdapter, TauriAdapterNotImplementedError } = await importAdapter()
    const adapter = new TauriVaultAdapter()
    await expect(
      adapter.uploadAttachment(new Blob([new Uint8Array([1, 2])], { type: 'image/png' }), {
        mime: 'image/png',
        size: 2,
        sha256: '',
        filename: 'p.png',
      }),
    ).rejects.toBeInstanceOf(TauriAdapterNotImplementedError)
  })

  it('getAttachmentUrl resolves via `convertFileSrc`', async () => {
    const { TauriVaultAdapter } = await importAdapter()
    const adapter = new TauriVaultAdapter()
    const url = await adapter.getAttachmentUrl('/v/attachments/x.png')
    expect(url).toMatch(/^asset:\/\/localhost/)
    expect(convertFileSrcMock).toHaveBeenCalledWith('/v/attachments/x.png')
  })

  it('streamAi listens on `ai-model-stream` and bridges desktop events to AiStreamEvent', async () => {
    invokeHandler = (cmd) => {
      expect(cmd).toBe('stream_ai_model')
      return 'session-id'
    }
    const { TauriVaultAdapter } = await importAdapter()
    const adapter = new TauriVaultAdapter()
    const events: unknown[] = []
    const controller = await adapter.streamAi(
      {
        vaultId: '/v',
        model: 'gpt-test',
        messages: [
          { role: 'system', content: 'you are helpful' },
          { role: 'user', content: 'hi' },
        ],
      },
      (e) => events.push(e),
    )
    expect(lastListenEvent).toBe('ai-model-stream')
    expect(typeof lastListenHandler).toBe('function')
    lastListenHandler!({ payload: { kind: 'TextDelta', text: 'a' } })
    lastListenHandler!({ payload: { kind: 'Done' } })
    expect(events).toEqual([
      { type: 'token', delta: 'a' },
      { type: 'done' },
    ])
    controller.abort()
    expect(unlistenMock).toHaveBeenCalled()
  })
})
