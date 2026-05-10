import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import { AdminLayout } from '../AdminLayout'

vi.mock('@/lib/admin-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/admin-api')>(
    '@/lib/admin-api',
  )
  return {
    ...actual,
    listSsoProviders: vi.fn().mockResolvedValue([]),
    listUsers: vi.fn().mockResolvedValue([]),
  }
})

describe('AdminLayout', () => {
  it('renders the access-denied state for non-admin roles', () => {
    render(<AdminLayout role="member" locale="en" />)
    expect(screen.getByRole('alert')).toHaveTextContent('Admin access required')
  })

  it('renders the access-denied state when role is missing', () => {
    render(<AdminLayout role={null} locale="en" />)
    expect(screen.getByRole('alert')).toHaveTextContent('Admin access required')
  })

  it('renders both tabs for admins', () => {
    render(<AdminLayout role="admin" locale="en" />)
    expect(screen.getByRole('tab', { name: 'SSO providers' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Members' })).toBeInTheDocument()
  })
})
