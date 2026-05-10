import * as React from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ApiError } from '@/lib/admin-api'
import type {
  ProviderRole,
  SsoProvider,
  SsoProviderInput,
} from '@/lib/admin-api'
import type { AppLocale } from '@/lib/i18n'
import { createTranslator } from '@/lib/i18n'

const DEFAULT_SCOPES = 'openid profile email'
const ROLE_OPTIONS: ProviderRole[] = ['viewer', 'member', 'admin']

interface SsoProviderFormProps {
  initial?: SsoProvider
  locale?: AppLocale
  onSubmit: (input: SsoProviderInput) => Promise<void>
  onCancel: () => void
}

interface FormState {
  name: string
  issuerUrl: string
  clientId: string
  clientSecret: string
  scopes: string
  defaultRole: ProviderRole
  jit: boolean
}

interface FormErrors {
  name?: string
  issuerUrl?: string
  clientId?: string
  clientSecret?: string
  scopes?: string
  form?: string
}

function toScopesString(scopes: string[] | undefined): string {
  if (!scopes || scopes.length === 0) return DEFAULT_SCOPES
  return scopes.join(' ')
}

function fromScopesString(value: string): string[] {
  return value
    .split(/[\s,]+/u)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0)
}

function toInitialState(initial: SsoProvider | undefined): FormState {
  return {
    name: initial?.name ?? '',
    issuerUrl: initial?.issuerUrl ?? '',
    clientId: initial?.clientId ?? '',
    clientSecret: '',
    scopes: toScopesString(initial?.scopes),
    defaultRole: initial?.defaultRole ?? 'member',
    jit: initial?.jit ?? true,
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

type Translate = ReturnType<typeof createTranslator>

function validate(state: FormState, isEditing: boolean, t: Translate): FormErrors {
  const errors: FormErrors = {}
  if (!state.name.trim()) errors.name = t('admin.sso.form.error.nameRequired')
  if (!state.issuerUrl.trim()) {
    errors.issuerUrl = t('admin.sso.form.error.issuerRequired')
  } else if (!isHttpsUrl(state.issuerUrl.trim())) {
    errors.issuerUrl = t('admin.sso.form.error.issuerInvalid')
  }
  if (!state.clientId.trim()) errors.clientId = t('admin.sso.form.error.clientIdRequired')
  if (!isEditing && !state.clientSecret.trim()) {
    errors.clientSecret = t('admin.sso.form.error.clientSecretRequired')
  }
  if (fromScopesString(state.scopes).length === 0) {
    errors.scopes = t('admin.sso.form.error.scopesRequired')
  }
  return errors
}

export function SsoProviderForm({
  initial,
  locale = 'en',
  onSubmit,
  onCancel,
}: SsoProviderFormProps) {
  const t = createTranslator(locale)
  const isEditing = Boolean(initial)
  const [state, setState] = React.useState<FormState>(() => toInitialState(initial))
  const [errors, setErrors] = React.useState<FormErrors>({})
  const [pending, setPending] = React.useState(false)

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setState((prev) => ({ ...prev, [key]: value }))
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pending) return
    const nextErrors = validate(state, isEditing, t)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return

    setPending(true)
    try {
      await onSubmit({
        name: state.name.trim(),
        issuerUrl: state.issuerUrl.trim(),
        clientId: state.clientId.trim(),
        clientSecret: state.clientSecret,
        scopes: fromScopesString(state.scopes),
        defaultRole: state.defaultRole,
        jit: state.jit,
      })
    } catch (err) {
      const message =
        err instanceof ApiError
          ? translateApiError(err, t)
          : t('admin.sso.form.error.submitFailed')
      setErrors({ form: message })
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      data-slot="admin-sso-form"
      className="flex flex-col gap-4"
      onSubmit={handleSubmit}
      noValidate
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="sso-name">{t('admin.sso.form.name')}</Label>
        <Input
          id="sso-name"
          value={state.name}
          onChange={(event) => update('name', event.target.value)}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? 'sso-name-error' : undefined}
          autoFocus
        />
        {errors.name && (
          <p id="sso-name-error" className="text-xs text-destructive">
            {errors.name}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="sso-issuer">{t('admin.sso.form.issuerUrl')}</Label>
        <Input
          id="sso-issuer"
          inputMode="url"
          placeholder="https://idp.example.com/application/o/tolaria/"
          value={state.issuerUrl}
          onChange={(event) => update('issuerUrl', event.target.value)}
          aria-invalid={errors.issuerUrl ? true : undefined}
          aria-describedby={errors.issuerUrl ? 'sso-issuer-error' : undefined}
        />
        {errors.issuerUrl && (
          <p id="sso-issuer-error" className="text-xs text-destructive">
            {errors.issuerUrl}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="sso-client-id">{t('admin.sso.form.clientId')}</Label>
        <Input
          id="sso-client-id"
          value={state.clientId}
          onChange={(event) => update('clientId', event.target.value)}
          aria-invalid={errors.clientId ? true : undefined}
          aria-describedby={errors.clientId ? 'sso-client-id-error' : undefined}
        />
        {errors.clientId && (
          <p id="sso-client-id-error" className="text-xs text-destructive">
            {errors.clientId}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="sso-client-secret">{t('admin.sso.form.clientSecret')}</Label>
        <Input
          id="sso-client-secret"
          type="password"
          autoComplete="new-password"
          value={state.clientSecret}
          onChange={(event) => update('clientSecret', event.target.value)}
          aria-invalid={errors.clientSecret ? true : undefined}
          aria-describedby={
            errors.clientSecret
              ? 'sso-client-secret-error'
              : 'sso-client-secret-hint'
          }
        />
        <p
          id="sso-client-secret-hint"
          className="text-xs text-muted-foreground"
        >
          {isEditing
            ? t('admin.sso.form.clientSecretEditHint')
            : t('admin.sso.form.clientSecretCreateHint')}
        </p>
        {errors.clientSecret && (
          <p id="sso-client-secret-error" className="text-xs text-destructive">
            {errors.clientSecret}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="sso-scopes">{t('admin.sso.form.scopes')}</Label>
        <Input
          id="sso-scopes"
          value={state.scopes}
          onChange={(event) => update('scopes', event.target.value)}
          placeholder={DEFAULT_SCOPES}
          aria-invalid={errors.scopes ? true : undefined}
          aria-describedby={errors.scopes ? 'sso-scopes-error' : 'sso-scopes-hint'}
        />
        <p id="sso-scopes-hint" className="text-xs text-muted-foreground">
          {t('admin.sso.form.scopesHint')}
        </p>
        {errors.scopes && (
          <p id="sso-scopes-error" className="text-xs text-destructive">
            {errors.scopes}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="sso-default-role">{t('admin.sso.form.defaultRole')}</Label>
        <Select
          value={state.defaultRole}
          onValueChange={(value) => update('defaultRole', value as ProviderRole)}
        >
          <SelectTrigger id="sso-default-role" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLE_OPTIONS.map((role) => (
              <SelectItem key={role} value={role}>
                {t(`admin.sso.form.role.${role}` as Parameters<Translate>[0])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col">
          <Label htmlFor="sso-jit" className="cursor-pointer">
            {t('admin.sso.form.jit')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t('admin.sso.form.jitHint')}
          </p>
        </div>
        <Switch
          id="sso-jit"
          checked={state.jit}
          onCheckedChange={(checked) => update('jit', checked)}
        />
      </div>

      {errors.form && (
        <p role="alert" className="text-sm text-destructive">
          {errors.form}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          {t('admin.sso.form.cancel')}
        </Button>
        <Button type="submit" disabled={pending}>
          {pending
            ? t('admin.sso.form.submitting')
            : isEditing
              ? t('admin.sso.form.saveChanges')
              : t('admin.sso.form.create')}
        </Button>
      </div>
    </form>
  )
}

function translateApiError(error: ApiError, t: Translate): string {
  const code = error.code
  const knownCodes: Record<string, Parameters<Translate>[0]> = {
    sso_provider_duplicate: 'admin.sso.form.error.duplicate',
    sso_provider_invalid_issuer: 'admin.sso.form.error.issuerInvalid',
    sso_provider_invalid_secret: 'admin.sso.form.error.clientSecretInvalid',
    forbidden: 'admin.sso.form.error.forbidden',
  }
  const key = knownCodes[code]
  if (key) return t(key)
  return error.message || t('admin.sso.form.error.submitFailed')
}
