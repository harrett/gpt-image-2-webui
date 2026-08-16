"use client"

import { useCallback, useEffect, useMemo, useState } from "react"

import {
  createTransferSlot,
  summarizeTransfers,
  updateTransferSlot,
  type TransferSlot,
  type TransferTracker,
} from "@/lib/transfer-progress"

/**
 * Tracks the wait/download split of one or more in-flight `/api/images` calls.
 *
 * Shared by the studio (up to four parallel requests) and the canvas editor
 * (one), so both surfaces report the same thing: how much of the wall-clock
 * time was the model working versus the image coming down the wire.
 */
export function useTransferProgress() {
  const [slots, setSlots] = useState<TransferSlot[]>([])
  const [expectedSlots, setExpectedSlots] = useState(1)
  const [clock, setClock] = useState(0)
  const isTracking = slots.length > 0

  // Elapsed timers and the pre-first-byte creep are functions of wall-clock
  // time, not of state, so an in-flight run needs its own heartbeat to repaint.
  // The heartbeat carries the timestamp rather than a counter so the summary
  // stays a pure function of state.
  useEffect(() => {
    if (!isTracking) {
      return
    }

    const intervalId = window.setInterval(() => setClock(Date.now()), 250)

    return () => window.clearInterval(intervalId)
  }, [isTracking])

  const summary = useMemo(
    () => summarizeTransfers(slots, expectedSlots, clock),
    [clock, expectedSlots, slots]
  )

  const begin = useCallback((expected: number) => {
    setSlots([])
    setExpectedSlots(Math.max(expected, 1))
    setClock(Date.now())
  }, [])

  const reset = useCallback(() => setSlots([]), [])

  const createTracker = useCallback((): TransferTracker => {
    const id = crypto.randomUUID()

    setSlots((current) => [...current, createTransferSlot(id)])

    return {
      // Drop the failed slot rather than parking it at 0%: the retry that
      // replaces it registers its own slot, and a dead one would otherwise hold
      // the bar down for the rest of the run.
      onFailure: () => setSlots((current) => current.filter((slot) => slot.id !== id)),
      onFinish: () =>
        setSlots((current) =>
          updateTransferSlot(current, id, (slot) => ({
            ...slot,
            finishedAt: Date.now(),
            phase: "done",
          }))
        ),
      onHeaders: (totalBytes) =>
        setSlots((current) =>
          updateTransferSlot(current, id, (slot) => ({
            ...slot,
            firstByteAt: Date.now(),
            phase: "downloading",
            totalBytes,
          }))
        ),
      onProgress: (receivedBytes) =>
        setSlots((current) =>
          updateTransferSlot(current, id, (slot) => ({ ...slot, receivedBytes }))
        ),
    }
  }, [])

  return { begin, createTracker, reset, summary }
}
