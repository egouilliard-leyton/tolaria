import type { AppLocale } from '@/lib/i18n'
import { createTranslator } from '@/lib/i18n'

interface AccessDeniedProps {
  locale?: AppLocale
}

export function AccessDenied({ locale = 'en' }: AccessDeniedProps) {
  const t = createTranslator(locale)
  return (
    <div
      role="alert"
      data-slot="admin-access-denied"
      className="flex min-h-[40vh] flex-col items-center justify-center gap-2 px-6 text-center"
    >
      <h1 className="text-lg font-semibold">{t('admin.accessDenied.title')}</h1>
      <p className="max-w-prose text-sm text-muted-foreground">
        {t('admin.accessDenied.description')}
      </p>
    </div>
  )
}
