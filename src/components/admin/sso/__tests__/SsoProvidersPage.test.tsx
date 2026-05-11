import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { SsoProvider } from '@/lib/admin-api'
import { SsoProvidersPage } from '../SsoProvidersPage'

vi.mock('@/lib/admin-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/admin-api')>(
    '@/lib/admin-api',
  )
  return {
    ...actual,
    listSsoProviders: vi.fn(),
    createSsoProvider: vi.fn(),
    updateSsoProvider: vi.fn(),
    deleteSsoProvider: vi.fn(),
  }
})

import * as adminApi from '@/lib/admin-api'

const sampleProvider: SsoProvider = {
  id: 'prov_1',
  name: 'Acme IdP',
  issuerUrl: 'https://idp.acme.example/application/o/tolaria/',
  clientId: 'tolaria-acme',
  scopes: ['openid', 'profile', 'email'],
  defaultRole: 'member',
  jitProvisioning: true,
  clientSecretSet: true,
}

describe('SsoProvidersPage', () => {
  const listMock = vi.mocked(adminApi.listSsoProviders)
  const createMock = vi.mocked(adminApi.createSsoProvider)
  const deleteMock = vi.mocked(adminApi.deleteSsoProvider)

  beforeEach(() => {
    vi.clearAllMocks()
    listMock.mockResolvedValue([sampleProvider])
    createMock.mockResolvedValue({ ...sampleProvider, id: 'prov_2', name: 'New' })
    deleteMock.mockResolvedValue()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders the loaded provider list', async () => {
    render(<SsoProvidersPage locale="en" />)
    expect(await screen.findByText('Acme IdP')).toBeInTheDocument()
    expect(listMock).toHaveBeenCalledTimes(1)
  })

  // G02: the SPA must read the server's `jitProvisioning` / `clientSecretSet`
  // vocabulary directly without throwing or treating it as undefined. If the
  // renamed fields regressed back to `jit` / `hasSecret`, the JIT and secret
  // status cells would render the "off" / "missing" copy here.
  it('surfaces the renamed jitProvisioning and clientSecretSet fields', async () => {
    listMock.mockResolvedValueOnce([
      { ...sampleProvider, jitProvisioning: true, clientSecretSet: true },
    ])
    render(<SsoProvidersPage locale="en" />)
    expect(await screen.findByText('Acme IdP')).toBeInTheDocument()
    expect(screen.getByText('On')).toBeInTheDocument()
    expect(screen.getByText('Set')).toBeInTheDocument()
  })

  it('reflects jitProvisioning=false and clientSecretSet=false', async () => {
    listMock.mockResolvedValueOnce([
      { ...sampleProvider, jitProvisioning: false, clientSecretSet: false },
    ])
    render(<SsoProvidersPage locale="en" />)
    expect(await screen.findByText('Acme IdP')).toBeInTheDocument()
    expect(screen.getByText('Off')).toBeInTheDocument()
    expect(screen.getByText('Missing')).toBeInTheDocument()
  })

  it('shows the empty state when no providers exist', async () => {
    listMock.mockResolvedValueOnce([])
    render(<SsoProvidersPage locale="en" />)
    expect(
      await screen.findByText(/No providers yet/i),
    ).toBeInTheDocument()
  })

  it('renders an error message when loading fails', async () => {
    listMock.mockRejectedValueOnce(new Error('boom'))
    render(<SsoProvidersPage locale="en" />)
    expect(
      await screen.findByText('Failed to load SSO providers.'),
    ).toBeInTheDocument()
  })

  it('opens the create dialog and submits the form', async () => {
    render(<SsoProvidersPage locale="en" />)
    await screen.findByText('Acme IdP')

    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }))

    await screen.findByRole('dialog')

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'New IdP' },
    })
    fireEvent.change(screen.getByLabelText('Issuer URL'), {
      target: { value: 'https://idp.example.com/' },
    })
    fireEvent.change(screen.getByLabelText('Client ID'), {
      target: { value: 'cid' },
    })
    fireEvent.change(screen.getByLabelText('Client secret'), {
      target: { value: 'secret-value' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Create provider' }))

    await waitFor(() => {
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'New IdP',
          issuerUrl: 'https://idp.example.com/',
          clientId: 'cid',
          clientSecret: 'secret-value',
          scopes: ['openid', 'profile', 'email'],
          defaultRole: 'member',
          jitProvisioning: true,
        }),
      )
    })
  })

  it('shows inline validation when issuer URL is invalid', async () => {
    render(<SsoProvidersPage locale="en" />)
    await screen.findByText('Acme IdP')

    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }))
    await screen.findByRole('dialog')

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Bad' },
    })
    fireEvent.change(screen.getByLabelText('Issuer URL'), {
      target: { value: 'not a url' },
    })
    fireEvent.change(screen.getByLabelText('Client ID'), {
      target: { value: 'cid' },
    })
    fireEvent.change(screen.getByLabelText('Client secret'), {
      target: { value: 'secret' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Create provider' }))

    expect(
      await screen.findByText('Enter a valid HTTPS issuer URL.'),
    ).toBeInTheDocument()
    expect(createMock).not.toHaveBeenCalled()
  })
})
