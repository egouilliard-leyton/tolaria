import * as React from "react"

import { cn } from "@/lib/utils"

interface ToastViewportProps extends React.ComponentProps<"div"> {
  message: string | null
  open: boolean
  onDismiss?: () => void
  durationMs?: number
}

function Toast({
  className,
  message,
  open,
  onDismiss,
  durationMs = 4000,
  ...props
}: ToastViewportProps) {
  React.useEffect(() => {
    if (!open || !onDismiss) return
    const id = window.setTimeout(onDismiss, durationMs)
    return () => window.clearTimeout(id)
  }, [open, onDismiss, durationMs])

  if (!open || !message) return null

  return (
    <div
      data-slot="toast"
      role="status"
      aria-live="polite"
      className={cn(
        "fixed bottom-4 right-4 z-[13000] max-w-sm rounded-md border bg-popover text-popover-foreground px-4 py-3 text-sm shadow-md",
        className,
      )}
      {...props}
    >
      {message}
    </div>
  )
}

export { Toast }
