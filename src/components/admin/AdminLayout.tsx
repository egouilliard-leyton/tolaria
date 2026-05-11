import * as React from 'react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { AppLocale } from '@/lib/i18n'
import { createTranslator } from '@/lib/i18n'

import type { UserRole } from '@/lib/admin-api'
import { AccessDenied } from './AccessDenied'
import { SsoProvidersPage } from './sso/SsoProvidersPage'
import { MembersPage } from './users/MembersPage'

export type AdminSection = 'sso' | 'members'

interface AdminLayoutProps {
  /** Role of the current user. Renders `AccessDenied` for non-admins. */
  role: UserRole | null | undefined
  locale?: AppLocale
  defaultSection?: AdminSection
  onSectionChange?: (section: AdminSection) => void
}

const ALLOWED_ROLES: ReadonlySet<UserRole> = new Set(['owner', 'admin'])

export function AdminLayout({
  role,
  locale = 'en',
  defaultSection = 'sso',
  onSectionChange,
}: AdminLayoutProps) {
  const t = createTranslator(locale)
  const [section, setSection] = React.useState<AdminSection>(defaultSection)

  if (!role || !ALLOWED_ROLES.has(role)) {
    return <AccessDenied locale={locale} />
  }

  const handleChange = (next: string) => {
    if (next !== 'sso' && next !== 'members') return
    setSection(next)
    onSectionChange?.(next)
  }

  return (
    <div data-slot="admin-layout" className="flex h-full w-full">
      <Tabs
        value={section}
        onValueChange={handleChange}
        orientation="vertical"
        className="flex h-full w-full gap-6 p-6"
      >
        <aside className="w-56 shrink-0 border-r pr-4">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('admin.layout.title')}
          </h2>
          <TabsList variant="line" className="flex w-full flex-col items-stretch gap-1 bg-transparent p-0">
            <TabsTrigger value="sso" className="justify-start">
              {t('admin.sso.tabLabel')}
            </TabsTrigger>
            <TabsTrigger value="members" className="justify-start">
              {t('admin.users.tabLabel')}
            </TabsTrigger>
          </TabsList>
        </aside>
        <main className="flex-1 min-w-0">
          <TabsContent value="sso">
            <SsoProvidersPage locale={locale} />
          </TabsContent>
          <TabsContent value="members">
            <MembersPage locale={locale} />
          </TabsContent>
        </main>
      </Tabs>
    </div>
  )
}
