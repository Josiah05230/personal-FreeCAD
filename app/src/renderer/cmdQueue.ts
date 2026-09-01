/**
 * Serialised command queue for model-mutating operations.
 *
 * Everything that changes the FreeCAD document (apply an op, delete a feature,
 * undo, roll history, finish a sketch) goes through here. Guarantees:
 *
 *  - commands run strictly in the order they were enqueued, one at a time, so a
 *    fast double-click / key-mash can never interleave two mutations
 *  - a command that throws is caught, reported once, and the queue keeps going -
 *    a bad click never wedges the app
 *  - `busy` reflects whether anything is in flight (drives the spinner + lets
 *    the UI ignore re-entrant clicks)
 */
export type QueueTask<T> = () => Promise<T>

export class CmdQueue {
  private tail: Promise<unknown> = Promise.resolve()
  private depth = 0

  /** called with (error, label) whenever a queued task throws */
  onError: ((err: Error, label: string) => void) | null = null
  /** called when the in-flight count crosses 0 <-> >0 */
  onBusyChange: ((busy: boolean) => void) | null = null

  get busy(): boolean {
    return this.depth > 0
  }

  /**
   * Enqueue `task`. Resolves with its result, or `undefined` if it threw (the
   * error is routed to `onError`, never rejected here - callers can treat a
   * failed command as a no-op and move on).
   */
  run<T>(label: string, task: QueueTask<T>): Promise<T | undefined> {
    const started = this.tail.then(async (): Promise<T | undefined> => {
      if (this.depth++ === 0) this.onBusyChange?.(true)
      try {
        return await task()
      } catch (e) {
        try {
          this.onError?.(e instanceof Error ? e : new Error(String(e)), label)
        } catch {
          /* an onError handler must never break the queue */
        }
        return undefined
      } finally {
        if (--this.depth === 0) this.onBusyChange?.(false)
      }
    })
    // the chain must survive a thrown task; errors are already handled above
    this.tail = started.catch(() => undefined)
    return started
  }
}
