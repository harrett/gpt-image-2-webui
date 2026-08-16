"use client"

import type { ReactNode } from "react"
import { CheckCircle2Icon, LoaderCircleIcon } from "lucide-react"

import { Progress } from "@/components/ui/progress"
import { studioMessages, type Locale } from "@/lib/i18n"
import {
  formatBytes,
  formatDuration,
  formatTransferRate,
  type TransferSummary,
} from "@/lib/transfer-progress"
import { cn } from "@/lib/utils"

/**
 * Splits one run into the two waits the user actually feels: the upstream
 * generating (no bytes yet) and the multi-MB body coming down the wire. Without
 * this, a four-minute run reads as "the model is slow" when three of those
 * minutes were the download.
 */
export function TransferTimeline({
  className,
  locale,
  summary,
}: {
  className?: string
  locale: Locale
  summary: TransferSummary
}) {
  const text = studioMessages[locale]
  const isWaiting = summary.waitingCount > 0
  const isDownloading = summary.downloadingCount > 0
  const hasDownloadStarted = isDownloading || summary.receivedBytes > 0
  const downloadDetail = hasDownloadStarted
    ? [
        summary.totalBytes
          ? `${formatBytes(summary.receivedBytes)} / ${summary.isTotalEstimated ? "≈" : ""}${formatBytes(summary.totalBytes)}`
          : formatBytes(summary.receivedBytes),
        summary.bytesPerSecond
          ? formatTransferRate(summary.bytesPerSecond)
          : text.transferSpeedMeasuring,
        summary.etaMs
          ? text.transferEtaLabel.replace("{value}", formatDuration(summary.etaMs))
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : text.transferDownloadPending

  return (
    <div className={cn("flex flex-col gap-2.5 rounded-md border bg-muted/30 px-3 py-2.5", className)}>
      <div className="flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        <span>{text.transferTitle}</span>
        <span className="font-mono tracking-normal">{summary.percent}%</span>
      </div>

      <TransferPhaseRow
        detail={formatDuration(summary.waitElapsedMs)}
        label={text.transferWaitingLabel}
        state={isWaiting ? "active" : "done"}
      />

      <TransferPhaseRow
        detail={hasDownloadStarted ? formatDuration(summary.downloadElapsedMs) : ""}
        label={text.transferDownloadLabel}
        state={isDownloading ? "active" : hasDownloadStarted ? "done" : "pending"}
      >
        {hasDownloadStarted && (
          <>
            <Progress value={summary.downloadPercent} className="h-1 rounded-sm" />
            <span className="font-mono text-[10px] leading-tight text-muted-foreground">
              {downloadDetail}
            </span>
          </>
        )}
      </TransferPhaseRow>

      <p className="text-[10px] leading-snug text-muted-foreground">{text.transferHint}</p>
    </div>
  )
}

function TransferPhaseRow({
  children,
  detail,
  label,
  state,
}: {
  children?: ReactNode
  detail: string
  label: string
  state: "active" | "done" | "pending"
}) {
  return (
    <div className="flex items-start gap-2">
      <span aria-hidden className="mt-0.5 grid size-3.5 shrink-0 place-items-center">
        {state === "done" ? (
          <CheckCircle2Icon className="size-3.5 text-primary" />
        ) : state === "active" ? (
          <LoaderCircleIcon className="size-3.5 animate-spin text-primary" />
        ) : (
          <span className="size-1.5 rounded-full bg-muted-foreground/40" />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              "truncate text-[11px]",
              state === "pending" ? "text-muted-foreground" : "text-foreground"
            )}
          >
            {label}
          </span>
          {detail && (
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{detail}</span>
          )}
        </div>
        {children}
      </div>
    </div>
  )
}
