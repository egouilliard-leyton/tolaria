import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { SyncToCloudDialog } from '../SyncToCloudDialog'
import type { SyncableNote } from '../useSyncToCloud'
import type { Attachment, Note, Vault, VaultAdapter } from '../../../lib/vault-adapter/types'

interface StubAdapter extends VaultAdapter {
  createVault?: (input: { name: string; slug: string }) => Promise<Vault>
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
})
