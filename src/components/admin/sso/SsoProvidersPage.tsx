import * as React from 'react'
import { MoreHorizontalIcon } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  ApiError,
  createSsoProvider,
  deleteSsoProvider,
  listSsoProviders,
  updateSsoProvider,
} from '@/lib/admin-api'
import type {
  SsoProvider,
  SsoProviderInput,
} from '@/lib/admin-api'
import type { AppLocale } from '@/lib/i18n'
import { createTranslator } from '@/lib/i18n'

import { SsoProviderForm } from './SsoProviderForm'

interface SsoProvidersPageProps {
  locale?: AppLocale
}

type DialogMode =
  | { kind: 'closed' }
  | { kind: 'create' }
  | { kind: 'edit'; provider: SsoProvider }

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; providers: SsoProvider[] }
  | { kind: 'error'; message: string }

export function SsoProvidersPage({ locale = 'en' }: SsoProvidersPageProps) {
  const t = createTranslator(locale)
  const [state, setState] = React.useState<LoadState>({ kind: 'loading' })
  const [dialog, setDialog] = React.useState<DialogMode>({ kind: 'closed' })
  const [pendingDeleteId, setPendingDeleteId] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      const providers = await listSsoProviders()
      setState({ kind: 'ready', providers })
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : t('admin.sso.list.loadFailed')
      setState({ kind: 'error', message })
    }
  }, [t])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const handleSubmit = async (input: SsoProviderInput) => {
    if (dialog.kind === 'edit') {
      await updateSsoProvider(dialog.provider.id, input)
    } else {
      await createSsoProvider(input)
    }
    setDialog({ kind: 'closed' })
    await refresh()
  }

  const handleDelete = async (provider: SsoProvider) => {
    setPendingDeleteId(provider.id)
    setActionError(null)
    try {
      await deleteSsoProvider(provider.id)
      await refresh()
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : t('admin.sso.list.deleteFailed')
      setActionError(message)
    } finally {
      setPendingDeleteId(null)
    }
  }

  return (
    <section data-slot="admin-sso-page" className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{t('admin.sso.heading')}</h1>
          <p className="text-sm text-muted-foreground">{t('admin.sso.subheading')}</p>
        </div>
        <Button onClick={() => setDialog({ kind: 'create' })}>
          {t('admin.sso.addProvider')}
        </Button>
      </header>

      {actionError && (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}

      <SsoProvidersBody
        state={state}
        locale={locale}
        pendingDeleteId={pendingDeleteId}
        onEdit={(provider) => setDialog({ kind: 'edit', provider })}
        onDelete={handleDelete}
      />

      <Dialog
        open={dialog.kind !== 'closed'}
        onOpenChange={(open) => {
          if (!open) setDialog({ kind: 'closed' })
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog.kind === 'edit'
                ? t('admin.sso.dialog.editTitle')
                : t('admin.sso.dialog.createTitle')}
            </DialogTitle>
            <DialogDescription>
              {dialog.kind === 'edit'
                ? t('admin.sso.dialog.editDescription')
                : t('admin.sso.dialog.createDescription')}
            </DialogDescription>
          </DialogHeader>
          {dialog.kind !== 'closed' && (
            <SsoProviderForm
              key={dialog.kind === 'edit' ? dialog.provider.id : 'create'}
              initial={dialog.kind === 'edit' ? dialog.provider : undefined}
              locale={locale}
              onSubmit={handleSubmit}
              onCancel={() => setDialog({ kind: 'closed' })}
            />
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}

interface SsoProvidersBodyProps {
  state: LoadState
  locale: AppLocale
  pendingDeleteId: string | null
  onEdit: (provider: SsoProvider) => void
  onDelete: (provider: SsoProvider) => void
}

function SsoProvidersBody({
  state,
  locale,
  pendingDeleteId,
  onEdit,
  onDelete,
}: SsoProvidersBodyProps) {
  const t = createTranslator(locale)
  if (state.kind === 'loading') {
    return (
      <p className="text-sm text-muted-foreground" data-slot="admin-sso-loading">
        {t('admin.sso.list.loading')}
      </p>
    )
  }
  if (state.kind === 'error') {
    return (
      <p role="alert" className="text-sm text-destructive">
        {state.message}
      </p>
    )
  }
  if (state.providers.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-slot="admin-sso-empty">
        {t('admin.sso.list.empty')}
      </p>
    )
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('admin.sso.table.name')}</TableHead>
          <TableHead>{t('admin.sso.table.issuer')}</TableHead>
          <TableHead>{t('admin.sso.table.defaultRole')}</TableHead>
          <TableHead>{t('admin.sso.table.jit')}</TableHead>
          <TableHead>{t('admin.sso.table.secret')}</TableHead>
          <TableHead className="w-12 text-right">
            <span className="sr-only">{t('admin.sso.table.actions')}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {state.providers.map((provider) => (
          <TableRow key={provider.id} data-testid={`sso-provider-row-${provider.id}`}>
            <TableCell className="font-medium">{provider.name}</TableCell>
            <TableCell className="max-w-xs truncate text-muted-foreground">
              {provider.issuerUrl}
            </TableCell>
            <TableCell>
              <Badge variant="secondary">
                {t(
                  `admin.sso.form.role.${provider.defaultRole}` as Parameters<
                    ReturnType<typeof createTranslator>
                  >[0],
                )}
              </Badge>
            </TableCell>
            <TableCell>
              {provider.jitProvisioning
                ? t('admin.sso.table.jit.on')
                : t('admin.sso.table.jit.off')}
            </TableCell>
            <TableCell>
              {provider.clientSecretSet
                ? t('admin.sso.table.secret.set')
                : t('admin.sso.table.secret.missing')}
            </TableCell>
            <TableCell className="text-right">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('admin.sso.table.rowActions', {
                      name: provider.name,
                    })}
                    disabled={pendingDeleteId === provider.id}
                  >
                    <MoreHorizontalIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => onEdit(provider)}>
                    {t('admin.sso.table.edit')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => onDelete(provider)}
                    variant="destructive"
                  >
                    {t('admin.sso.table.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
