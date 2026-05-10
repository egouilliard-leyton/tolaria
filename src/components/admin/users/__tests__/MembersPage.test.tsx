import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { Member } from '@/lib/admin-api'
import { MembersPage } from '../MembersPage'

vi.mock('@/lib/admin-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/admin-api')>(
    '@/lib/admin-api',
  )
  return {
    ...actual,
    listUsers: vi.fn(),
    inviteUser: vi.fn(),
    updateUserRole: vi.fn(),
    removeUser: vi.fn(),
  }
})

import * as adminApi from '@/lib/admin-api'

const owner: Member = {
  id: 'u_owner',
  email: 'owner@example.com',
  role: 'owner',
  createdAt: '2026-01-01T00:00:00Z',
}

const member: Member = {
  id: 'u_member',
  email: 'pat@example.com',
  role: 'member',
  createdAt: '2026-02-01T00:00:00Z',
}

describe('MembersPage', () => {
  const listMock = vi.mocked(adminApi.listUsers)
  const inviteMock = vi.mocked(adminApi.inviteUser)

  beforeEach(() => {
    vi.clearAllMocks()
    listMock.mockResolvedValue([owner, member])
    inviteMock.mockResolvedValue({
      inviteUrl: 'https://app.example.com/invite/abc',
      member: {
        id: 'u_new',
        email: 'new@example.com',
        role: 'member',
        createdAt: '2026-05-10T00:00:00Z',
      },
    })

    // Stub clipboard.writeText regardless of jsdom support.
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  it('renders members from the API', async () => {
    render(<MembersPage locale="en" />)
    expect(await screen.findByText('owner@example.com')).toBeInTheDocument()
    expect(screen.getByText('pat@example.com')).toBeInTheDocument()
  })

  it('shows the empty state when no members exist', async () => {
    listMock.mockResolvedValueOnce([])
    render(<MembersPage locale="en" />)
    expect(await screen.findByText('No members yet.')).toBeInTheDocument()
  })

  it('shows the loading message while fetching', () => {
    listMock.mockReturnValueOnce(new Promise(() => undefined))
    render(<MembersPage locale="en" />)
    expect(screen.getByText('Loading members…')).toBeInTheDocument()
  })

  it('opens the invite dialog and copies the link on success', async () => {
    render(<MembersPage locale="en" />)
    await screen.findByText('pat@example.com')

    fireEvent.click(screen.getByRole('button', { name: 'Invite member' }))
    await screen.findByRole('dialog')

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'new@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Generate invite' }))

    await waitFor(() => {
      expect(inviteMock).toHaveBeenCalledWith('new@example.com', 'member')
    })
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'https://app.example.com/invite/abc',
      )
    })
    expect(await screen.findByText('Invite link copied')).toBeInTheDocument()
  })

  it('rejects an obviously invalid email', async () => {
    render(<MembersPage locale="en" />)
    await screen.findByText('pat@example.com')

    fireEvent.click(screen.getByRole('button', { name: 'Invite member' }))
    await screen.findByRole('dialog')

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'not-an-email' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Generate invite' }))

    expect(
      await screen.findByText('Enter a valid email address.'),
    ).toBeInTheDocument()
    expect(inviteMock).not.toHaveBeenCalled()
  })
})
