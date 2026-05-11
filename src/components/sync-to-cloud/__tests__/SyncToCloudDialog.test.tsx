import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { SyncToCloudDialog } from '../SyncToCloudDialog'
import type { Checkpoint, SyncableAttachment, SyncableNote } from '../useSyncToCloud'
import type {
  Attachment,
  Folder,
  Note,
  Vault,
  VaultAdapter,
} from '../../../lib/vault-adapter/types'

interface StubAdapter extends VaultAdapter {
  createVault?: (input: { name: string; slug: string }) => Promise<Vault>
  createFolder?: (
    vaultId: string,
    input: { name: string; parentId: string | null },
  ) => Promise<Folder>
}

function makeAdapter(overrides: Partial<StubAdapter> = {}): StubAdapter {
  const defaults: StubAdapter = {
    listVaults: vi.fn(async () => [
      {
        id: 'cloud-1',
        slug: 'work',
        name: 'Work',
        createdAt: '2026-01-01T00:00:00Z',
        settings: {},
      },
    ]),
    getVault: vi.fn(async () => {
      throw new Error('not implemented')
    }),
    listFolders: vi.fn(async () => []),
    listNotes: vi.fn(async () => ({ items: [], nextCursor: null })),
    getNote: vi.fn(async () => {
      throw new Error('not implemented')
    }),
    createNote: vi.fn(async (vaultId: string, body) => ({
      id: `note-${body.title}`,
      vaultId,
      folderId: null,
      slug: body.title.toLowerCase(),
      title: body.title,
      modifiedAt: '2026-01-02T00:00:00Z',
      wordCount: 0,
      bodyMd: body.bodyMd ?? '',
      frontmatter: body.frontmatter ?? {},
      version: 1,
      createdAt: '2026-01-02T00:00:00Z',
    })) as VaultAdapter['createNote'],
    saveNote: vi.fn(async () => ({ version: 2 })),
    deleteNote: vi.fn(async () => undefined),
    rename: vi.fn(async () => ({ affectedNoteIds: [], updatedLinkCount: 0 })),
    search: vi.fn(async () => ({ results: [], query: '', mode: 'full', elapsedMs: 0 })),
    uploadAttachment: vi.fn(async () => ({ id: 'a1' } as Attachment)),
    getAttachmentUrl: vi.fn(async () => 'about:blank'),
    streamAi: vi.fn(async () => new AbortController()),
    createVault: vi.fn(async ({ name, slug }) => ({
      id: `cloud-${slug}`,
      slug,
      name,
      createdAt: '2026-01-03T00:00:00Z',
      settings: {},
    })),
  }
  return { ...defaults, ...overrides }
}

function defaultNotes(): SyncableNote[] {
  return [
    {
      path: '/vault/note-a.md',
      filename: 'note-a.md',
      title: 'Note A',
      readBody: vi.fn(async () => '# A\nbody'),
    },
    {
      path: '/vault/note-b.md',
      filename: 'note-b.md',
      title: 'Note B',
      readBody: vi.fn(async () => '# B\nbody'),
    },
  ]
}

function renderDialog(overrides: Partial<React.ComponentProps<typeof SyncToCloudDialog>> = {}) {
  const adapter = overrides.adapterOverride ?? makeAdapter()
  const props: React.ComponentProps<typeof SyncToCloudDialog> = {
    open: true,
    onOpenChange: vi.fn(),
    vaultPath: '/vault',
    vaultName: 'Local Vault',
    vaultSlug: 'local-vault',
    apiBaseUrl: 'https://api.test.tolaria',
    notesProvider: vi.fn(async () => ({ notes: defaultNotes(), attachments: [] })),
    persistConfig: vi.fn(),
    adapterOverride: adapter,
    ...overrides,
  }
  const utils = render(<SyncToCloudDialog {...props} />)
  return { ...utils, props, adapter }
}

beforeEach(() => {
  vi.useRealTimers()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SyncToCloudDialog', () => {
  it('shows the sign-in form by default and advances when a token is pasted', async () => {
    const adapter = makeAdapter()
    renderDialog({ adapterOverride: adapter })

    expect(screen.getByTestId('sync-step-sign-in')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('sync-token-input'), {
      target: { value: 'jwt-abc' },
    })
    fireEvent.click(screen.getByTestId('sync-submit-token'))

    await waitFor(() => expect(screen.getByTestId('sync-step-destination')).toBeInTheDocument())
    expect(adapter.listVaults).toHaveBeenCalledTimes(1)
  })

  it('shows the destination list once vaults load and advances on selection', async () => {
    const adapter = makeAdapter()
    renderDialog({ adapterOverride: adapter })

    fireEvent.change(screen.getByTestId('sync-token-input'), { target: { value: 'jwt' } })
    fireEvent.click(screen.getByTestId('sync-submit-token'))

    const option = await screen.findByTestId('sync-vault-option-cloud-1')
    fireEvent.click(option)
    await waitFor(() => expect(screen.getByTestId('sync-step-progress')).toBeInTheDocument())
  })

  it('creates a new cloud vault when the user fills the create form', async () => {
    const adapter = makeAdapter({
      listVaults: vi.fn(async () => []),
    })
    renderDialog({ adapterOverride: adapter })

    fireEvent.change(screen.getByTestId('sync-token-input'), { target: { value: 'jwt' } })
    fireEvent.click(screen.getByTestId('sync-submit-token'))

    const nameInput = await screen.findByTestId('sync-new-vault-name')
    fireEvent.change(nameInput, { target: { value: 'Brand New' } })
    fireEvent.change(screen.getByTestId('sync-new-vault-slug'), {
      target: { value: 'brand-new' },
    })
    fireEvent.click(screen.getByTestId('sync-create-vault'))

    await waitFor(() => expect(screen.getByTestId('sync-step-progress')).toBeInTheDocument())
    expect((adapter as StubAdapter).createVault).toHaveBeenCalledWith({
      name: 'Brand New',
      slug: 'brand-new',
    })
  })

  it('iterates notes, calls createNote for each, and finishes on the complete step', async () => {
    const adapter = makeAdapter()
    const notes = defaultNotes()
    const persist = vi.fn()
    const onSynced = vi.fn()
    renderDialog({
      adapterOverride: adapter,
      notesProvider: async () => ({ notes }),
      persistConfig: persist,
      onSynced,
    })

    fireEvent.change(screen.getByTestId('sync-token-input'), { target: { value: 'jwt' } })
    fireEvent.click(screen.getByTestId('sync-submit-token'))
    fireEvent.click(await screen.findByTestId('sync-vault-option-cloud-1'))

    await waitFor(() => expect(screen.getByTestId('sync-step-complete')).toBeInTheDocument())
    expect(adapter.createNote).toHaveBeenCalledTimes(2)
    expect(adapter.createNote).toHaveBeenNthCalledWith(1, 'cloud-1', expect.objectContaining({ title: 'Note A' }))
    expect(adapter.createNote).toHaveBeenNthCalledWith(2, 'cloud-1', expect.objectContaining({ title: 'Note B' }))
    expect(persist).toHaveBeenCalledWith(
      '/vault',
      expect.objectContaining({ enabled: true, vaultId: 'cloud-1' }),
    )
    expect(onSynced).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }))
  })

  it('continues syncing when one note POST fails and surfaces the error', async () => {
    const failing = makeAdapter({
      createNote: vi.fn(async (vaultId: string, body: { title: string }) => {
        if (body.title === 'Note A') throw new Error('boom')
        return {
          id: 'note-b',
          vaultId,
          folderId: null,
          slug: 'note-b',
          title: 'Note B',
          modifiedAt: '2026-01-02T00:00:00Z',
          wordCount: 0,
          bodyMd: '',
          frontmatter: {},
          version: 1,
          createdAt: '2026-01-02T00:00:00Z',
        } as Note
      }) as VaultAdapter['createNote'],
    })
    renderDialog({ adapterOverride: failing })

    fireEvent.change(screen.getByTestId('sync-token-input'), { target: { value: 'jwt' } })
    fireEvent.click(screen.getByTestId('sync-submit-token'))
    fireEvent.click(await screen.findByTestId('sync-vault-option-cloud-1'))

    await waitFor(() => expect(screen.getByTestId('sync-step-complete')).toBeInTheDocument())
    expect(failing.createNote).toHaveBeenCalledTimes(2)
    expect(screen.getByText(/Note A/)).toBeInTheDocument()
    expect(screen.getByText(/boom/)).toBeInTheDocument()
  })

  it('shows an error and stays on sign-in when listVaults rejects', async () => {
    const broken = makeAdapter({
      listVaults: vi.fn(async () => {
        throw new Error('network down')
      }),
    })
    renderDialog({ adapterOverride: broken })

    fireEvent.change(screen.getByTestId('sync-token-input'), { target: { value: 'jwt' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('sync-submit-token'))
    })

    expect(screen.getByTestId('sync-sign-in-error')).toHaveTextContent('network down')
    expect(screen.getByTestId('sync-step-sign-in')).toBeInTheDocument()
  })

  it('creates folder hierarchy before notes and binds each note to its folder', async () => {
    const callLog: string[] = []
    let folderSerial = 0
    const adapter = makeAdapter({
      createFolder: vi.fn(async (vaultId: string, input: { name: string; parentId: string | null }) => {
        callLog.push(`folder:${input.parentId ?? 'root'}/${input.name}`)
        const id = `folder-${++folderSerial}`
        return {
          id,
          vaultId,
          parentId: input.parentId,
          name: input.name,
          position: 0,
          updatedAt: '2026-01-04T00:00:00Z',
        } satisfies Folder
      }) as StubAdapter['createFolder'],
      createNote: vi.fn(async (vaultId: string, body: { title: string; folderId?: string | null }) => {
        callLog.push(`note:${body.title}@${body.folderId ?? 'root'}`)
        return {
          id: `note-${body.title}`,
          vaultId,
          folderId: body.folderId ?? null,
          slug: body.title.toLowerCase(),
          title: body.title,
          modifiedAt: '2026-01-02T00:00:00Z',
          wordCount: 0,
          bodyMd: '',
          frontmatter: {},
          version: 1,
          createdAt: '2026-01-02T00:00:00Z',
        } as Note
      }) as VaultAdapter['createNote'],
    })

    const notes: SyncableNote[] = [
      {
        path: '/vault/projects/2026/note-deep.md',
        filename: 'note-deep.md',
        title: 'Deep',
        folderPath: 'projects/2026',
        readBody: vi.fn(async () => 'deep body'),
      },
      {
        path: '/vault/projects/note-shallow.md',
        filename: 'note-shallow.md',
        title: 'Shallow',
        folderPath: 'projects',
        readBody: vi.fn(async () => 'shallow body'),
      },
    ]

    renderDialog({
      adapterOverride: adapter,
      notesProvider: async () => ({ notes, attachments: [] }),
    })

    fireEvent.change(screen.getByTestId('sync-token-input'), { target: { value: 'jwt' } })
    fireEvent.click(screen.getByTestId('sync-submit-token'))
    fireEvent.click(await screen.findByTestId('sync-vault-option-cloud-1'))

    await waitFor(() => expect(screen.getByTestId('sync-step-complete')).toBeInTheDocument())

    // Folders must come strictly before notes, and the parent folder
    // ("projects") must come before the child ("projects/2026").
    const firstNoteIdx = callLog.findIndex((entry) => entry.startsWith('note:'))
    const lastFolderIdx = callLog
      .map((entry, idx) => (entry.startsWith('folder:') ? idx : -1))
      .filter((idx) => idx >= 0)
      .pop() as number
    expect(lastFolderIdx).toBeLessThan(firstNoteIdx)
    expect(callLog[0]).toBe('folder:root/projects')
    expect(callLog[1]).toBe('folder:folder-1/2026')

    // Each note must have been bound to the cloud folder id created for
    // its parent folder.
    expect(callLog).toContain('note:Deep@folder-2')
    expect(callLog).toContain('note:Shallow@folder-1')
  })

  it('skips already-completed items when a checkpoint is present', async () => {
    // Pre-seed the checkpoint as if a previous run completed Note A and
    // its folder. Note B should be the only `createNote` call.
    const checkpoint: Checkpoint = {
      cloudVaultId: 'cloud-1',
      cloudSubscriptionId: '',
      completedFolderPaths: ['projects'],
      completedNotePaths: ['/vault/note-a.md'],
      completedAttachmentSlugs: [],
      folderIdsByPath: { projects: 'folder-existing' },
      noteIdsByPath: { '/vault/note-a.md': 'note-already-uploaded' },
      lastUpdatedAt: Date.now(),
    }
    localStorage.setItem(
      'tolaria.cloudSync.checkpoint./vault',
      JSON.stringify(checkpoint),
    )

    const adapter = makeAdapter({
      createFolder: vi.fn() as StubAdapter['createFolder'],
    })
    const notes: SyncableNote[] = [
      {
        path: '/vault/note-a.md',
        filename: 'note-a.md',
        title: 'Note A',
        folderPath: 'projects',
        readBody: vi.fn(async () => '# A'),
      },
      {
        path: '/vault/note-b.md',
        filename: 'note-b.md',
        title: 'Note B',
        folderPath: 'projects',
        readBody: vi.fn(async () => '# B'),
      },
    ]

    try {
      renderDialog({
        adapterOverride: adapter,
        notesProvider: async () => ({ notes, attachments: [] }),
      })

      fireEvent.change(screen.getByTestId('sync-token-input'), { target: { value: 'jwt' } })
      fireEvent.click(screen.getByTestId('sync-submit-token'))
      fireEvent.click(await screen.findByTestId('sync-vault-option-cloud-1'))

      await waitFor(() => expect(screen.getByTestId('sync-step-complete')).toBeInTheDocument())

      // Folder was already completed → must NOT be recreated.
      expect(adapter.createFolder).not.toHaveBeenCalled()
      // Only Note B should be uploaded; Note A was in the checkpoint.
      expect(adapter.createNote).toHaveBeenCalledTimes(1)
      expect(adapter.createNote).toHaveBeenCalledWith(
        'cloud-1',
        expect.objectContaining({ title: 'Note B', folderId: 'folder-existing' }),
      )
    } finally {
      localStorage.removeItem('tolaria.cloudSync.checkpoint./vault')
    }
  })

  it('uploads attachments after the owner note is created so they can be bound', async () => {
    const callLog: Array<{ kind: string; detail: string; noteIdAtCall?: string | null }> = []
    const adapter = makeAdapter({
      createNote: vi.fn(async (vaultId: string, body: { title: string }) => {
        callLog.push({ kind: 'createNote', detail: body.title })
        return {
          id: `cloud-note-${body.title}`,
          vaultId,
          folderId: null,
          slug: body.title.toLowerCase(),
          title: body.title,
          modifiedAt: '2026-01-02T00:00:00Z',
          wordCount: 0,
          bodyMd: '',
          frontmatter: {},
          version: 1,
          createdAt: '2026-01-02T00:00:00Z',
        } as Note
      }) as VaultAdapter['createNote'],
      uploadAttachment: vi.fn(async (_blob: Blob, meta: { filename: string; noteId?: string | null }) => {
        callLog.push({
          kind: 'uploadAttachment',
          detail: meta.filename,
          noteIdAtCall: meta.noteId ?? null,
        })
        return {
          id: 'att-1',
          vaultId: 'cloud-1',
          noteId: meta.noteId ?? null,
          mime: 'image/png',
          sizeBytes: 4,
          sha256: 'deadbeef',
          url: 'https://r2.example/att-1',
        } as Attachment
      }) as VaultAdapter['uploadAttachment'],
      getNote: vi.fn(async () => {
        throw new Error('rewrite disabled in this test')
      }),
    })

    const note: SyncableNote = {
      path: '/vault/note-a.md',
      filename: 'note-a.md',
      title: 'Note A',
      readBody: vi.fn(async () => '![alt](attachments/foo.png)'),
    }
    const attachment: SyncableAttachment = {
      slug: '/vault/attachments/foo.png',
      filename: 'foo.png',
      blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }),
      mime: 'image/png',
      ownerNotePath: '/vault/note-a.md',
      // No bodyUrl ⇒ rewrite step is skipped, getNote will NOT be called.
      rewriteInBody: false,
    }

    renderDialog({
      adapterOverride: adapter,
      notesProvider: async () => ({ notes: [note], attachments: [attachment] }),
    })

    fireEvent.change(screen.getByTestId('sync-token-input'), { target: { value: 'jwt' } })
    fireEvent.click(screen.getByTestId('sync-submit-token'))
    fireEvent.click(await screen.findByTestId('sync-vault-option-cloud-1'))

    await waitFor(() => expect(screen.getByTestId('sync-step-complete')).toBeInTheDocument())

    const noteIdx = callLog.findIndex((entry) => entry.kind === 'createNote')
    const attIdx = callLog.findIndex((entry) => entry.kind === 'uploadAttachment')
    expect(noteIdx).toBeGreaterThanOrEqual(0)
    expect(attIdx).toBeGreaterThan(noteIdx)
    // The attachment must have been bound to the cloud note id that
    // came out of the createNote call right before it.
    expect(callLog[attIdx]?.noteIdAtCall).toBe('cloud-note-Note A')
  })

  it('continues syncing remaining items when a single note fails', async () => {
    let calls = 0
    const adapter = makeAdapter({
      createNote: vi.fn(async (vaultId: string, body: { title: string }) => {
        calls += 1
        if (body.title === 'Note A') throw new Error('boom')
        return {
          id: `cloud-note-${body.title}`,
          vaultId,
          folderId: null,
          slug: body.title.toLowerCase(),
          title: body.title,
          modifiedAt: '2026-01-02T00:00:00Z',
          wordCount: 0,
          bodyMd: '',
          frontmatter: {},
          version: 1,
          createdAt: '2026-01-02T00:00:00Z',
        } as Note
      }) as VaultAdapter['createNote'],
    })

    renderDialog({ adapterOverride: adapter })

    fireEvent.change(screen.getByTestId('sync-token-input'), { target: { value: 'jwt' } })
    fireEvent.click(screen.getByTestId('sync-submit-token'))
    fireEvent.click(await screen.findByTestId('sync-vault-option-cloud-1'))

    await waitFor(() => expect(screen.getByTestId('sync-step-complete')).toBeInTheDocument())
    // Both notes attempted (loop continues past the failure).
    expect(calls).toBe(2)
    // Note B succeeded (1 created, 1 failed).
    expect(screen.getByTestId('sync-step-complete')).toHaveTextContent('Synced 1 item')
    expect(screen.getByTestId('sync-step-complete')).toHaveTextContent('1 item(s) failed')
  })
})
