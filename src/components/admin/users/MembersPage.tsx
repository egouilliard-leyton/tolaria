import * as React from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Toast } from '@/components/ui/toast'
import {
  ApiError,
  inviteUser,
  listUsers,
  removeUser,
  updateUserRole,
} from '@/lib/admin-api'
import type { Member, UserRole } from '@/lib/admin-api'
import type { AppLocale } from '@/lib/i18n'
import { createTranslator } from '@/lib/i18n'

const ROLE_OPTIONS: UserRole[] = ['owner', 'admin', 'member']
const INVITE_ROLE_OPTIONS: UserRole[] = ['admin', 'member']

interface MembersPageProps {
  locale?: AppLocale
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; members: Member[] }
  | { kind: 'error'; message: string }

type Translate = ReturnType<typeof createTranslator>

export function MembersPage({ locale = 'en' }: MembersPageProps) {
  const t = createTranslator(locale)
  const [state, setState] = React.useState<LoadState>({ kind: 'loading' })
  const [inviteOpen, setInviteOpen] = React.useState(false)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [pendingRoleId, setPendingRoleId] = React.useState<string | null>(null)
  const [toastMessage, setToastMessage] = React.useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      const members = await listUsers()
      setState({ kind: 'ready', members })
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : t('admin.users.list.loadFailed')
      setState({ kind: 'error', message })
    }
  }, [t])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const handleRoleChange = async (member: Member, role: UserRole) => {
    if (member.role === role) return
    setPendingRoleId(member.id)
    setActionError(null)
    try {
      await updateUserRole(member.id, role)
      await refresh()
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : t('admin.users.list.updateFailed')
      setActionError(message)
    } finally {
      setPendingRoleId(null)
    }
  }

  const handleRemove = async (member: Member) => {
    setActionError(null)
    try {
      await removeUser(member.id)
      await refresh()
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : t('admin.users.list.removeFailed')
      setActionError(message)
    }
  }

  const handleInvite = async (email: string, role: UserRole) => {
    const result = await inviteUser(email, role)
    try {
      await navigator.clipboard.writeText(result.inviteUrl)
      setToastMessage(t('admin.users.invite.toastCopied'))
    } catch {
      setToastMessage(t('admin.users.invite.toastShowUrl', { url: result.inviteUrl }))
    }
    setInviteOpen(false)
    await refresh()
  }

  return (
    <section data-slot="admin-members-page" className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{t('admin.users.heading')}</h1>
          <p className="text-sm text-muted-foreground">{t('admin.users.subheading')}</p>
        </div>
        <Button onClick={() => setInviteOpen(true)}>
          {t('admin.users.inviteMember')}
        </Button>
      </header>

      {actionError && (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}

      <MembersBody
        state={state}
        locale={locale}
        pendingRoleId={pendingRoleId}
        onRoleChange={handleRoleChange}
        onRemove={handleRemove}
      />

      <InviteMemberDialog
        open={inviteOpen}
        locale={locale}
        onOpenChange={setInviteOpen}
        onInvite={handleInvite}
      />

      <Toast
        open={toastMessage !== null}
        message={toastMessage}
        onDismiss={() => setToastMessage(null)}
      />
    </section>
  )
}

interface MembersBodyProps {
  state: LoadState
  locale: AppLocale
  pendingRoleId: string | null
  onRoleChange: (member: Member, role: UserRole) => void
  onRemove: (member: Member) => void
}

function MembersBody({
  state,
  locale,
  pendingRoleId,
  onRoleChange,
  onRemove,
}: MembersBodyProps) {
  const t = createTranslator(locale)
  if (state.kind === 'loading') {
    return (
      <p
        className="text-sm text-muted-foreground"
        data-slot="admin-members-loading"
      >
        {t('admin.users.list.loading')}
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
  if (state.members.length === 0) {
    return (
      <p
        className="text-sm text-muted-foreground"
        data-slot="admin-members-empty"
      >
        {t('admin.users.list.empty')}
      </p>
    )
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('admin.users.table.email')}</TableHead>
          <TableHead>{t('admin.users.table.currentRole')}</TableHead>
          <TableHead>{t('admin.users.table.changeRole')}</TableHead>
          <TableHead className="w-32 text-right">
            <span className="sr-only">{t('admin.users.table.actions')}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {state.members.map((member) => (
          <TableRow key={member.id} data-testid={`member-row-${member.id}`}>
            <TableCell className="font-medium">{member.email}</TableCell>
            <TableCell>
              <Badge variant={member.role === 'owner' ? 'default' : 'secondary'}>
                {translateRole(member.role, t)}
              </Badge>
            </TableCell>
            <TableCell>
              <Select
                value={member.role}
                onValueChange={(value) => onRoleChange(member, value as UserRole)}
                disabled={member.role === 'owner' || pendingRoleId === member.id}
              >
                <SelectTrigger
                  size="sm"
                  className="w-32"
                  aria-label={t('admin.users.table.roleSelectLabel', {
                    email: member.email,
                  })}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((role) => (
                    <SelectItem key={role} value={role}>
                      {translateRole(role, t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </TableCell>
            <TableCell className="text-right">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onRemove(member)}
                disabled={member.role === 'owner'}
              >
                {t('admin.users.table.remove')}
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

interface InviteMemberDialogProps {
  open: boolean
  locale: AppLocale
  onOpenChange: (open: boolean) => void
  onInvite: (email: string, role: UserRole) => Promise<void>
}

function InviteMemberDialog({
  open,
  locale,
  onOpenChange,
  onInvite,
}: InviteMemberDialogProps) {
  const t = createTranslator(locale)
  const [email, setEmail] = React.useState('')
  const [role, setRole] = React.useState<UserRole>('member')
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      setEmail('')
      setRole('member')
      setError(null)
      setPending(false)
    }
  }, [open])

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pending) return
    const trimmed = email.trim()
    if (!trimmed) {
      setError(t('admin.users.invite.error.emailRequired'))
      return
    }
    if (!isPlausibleEmail(trimmed)) {
      setError(t('admin.users.invite.error.emailInvalid'))
      return
    }
    setPending(true)
    setError(null)
    try {
      await onInvite(trimmed, role)
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : t('admin.users.invite.error.failed')
      setError(message)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('admin.users.invite.title')}</DialogTitle>
          <DialogDescription>
            {t('admin.users.invite.description')}
          </DialogDescription>
        </DialogHeader>
        <form
          data-slot="admin-invite-form"
          className="flex flex-col gap-4"
          onSubmit={handleSubmit}
          noValidate
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="invite-email">{t('admin.users.invite.email')}</Label>
            <Input
              id="invite-email"
              type="email"
              autoComplete="off"
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'invite-email-error' : undefined}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="invite-role">{t('admin.users.invite.role')}</Label>
            <Select
              value={role}
              onValueChange={(value) => setRole(value as UserRole)}
            >
              <SelectTrigger id="invite-role" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INVITE_ROLE_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {translateRole(option, t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error && (
            <p id="invite-email-error" role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              {t('admin.users.invite.cancel')}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending
                ? t('admin.users.invite.submitting')
                : t('admin.users.invite.send')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function translateRole(role: UserRole, t: Translate): string {
  return t(`admin.users.role.${role}` as Parameters<Translate>[0])
}

function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)
}
