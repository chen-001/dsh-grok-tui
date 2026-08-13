/**
 * Proactive session-log health watch for the shared session store.
 *
 * The grok TUI and the DSH Web UI share one persistence root, and the Web
 * UI's history reads go through DSH's strict loader, which the grok server
 * cannot intercept. When either frontend's stale seq counter interleaves a
 * log, the Web UI fails to load that conversation until the log is repaired.
 * This watch periodically scans the shared root for the interleaved signature
 * and repairs stable artifacts, so the window in which a Web history read
 * fails shrinks from "until someone touches the session" to at most one
 * watch interval.
 *
 * Safety rules: artifacts modified within the last two intervals are skipped
 * (an actively writing frontend — never fight a live writer); artifacts
 * unchanged since the previous pass are skipped (already known clean or
 * already healed); the repair itself refuses non-contiguous rebuilds, so
 * genuinely corrupt files are left untouched.
 * @module dsh-grok-tui/session-health
 */

import { glob, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { LoggerService } from 'cordis'
import {
  detectInterleavedArtifact,
  repairInterleavedArtifact,
} from './repair.ts'

/** Default interval between health passes. */
export const DEFAULT_HEALTH_INTERVAL_MS = 15_000

/** One artifact observation used to skip files unchanged since the last pass. */
interface ArtifactIdentity {
  size: number
  mtimeMs: number
}

/** Options for the session-log health watch. */
export interface SessionHealthWatchOptions {
  /** The shared session-persistence root to scan. */
  root: string
  /** Interval between passes (default {@link DEFAULT_HEALTH_INTERVAL_MS}). */
  intervalMs?: number
  /** Logger for repair and failure reports. */
  logger: Pick<LoggerService, 'info' | 'warn'>
}

/** A running health watch; `dispose` stops future passes. */
export interface SessionHealthWatch {
  /** Run one scan-and-repair pass (exposed for tests and manual runs). */
  tick(): Promise<void>
  /** Stop the periodic passes. */
  dispose(): void
}

/**
 * Start the periodic session-log health watch for one shared persistence root.
 * @param options - root, interval, and logger.
 * @returns the watch handle.
 */
export function startSessionHealthWatch(
  options: SessionHealthWatchOptions,
): SessionHealthWatch {
  const intervalMs = options.intervalMs ?? DEFAULT_HEALTH_INTERVAL_MS
  const lastSeen = new Map<string, ArtifactIdentity>()
  let timer: ReturnType<typeof setInterval> | undefined
  // A pass over a large store can take far longer than one interval; without
  // this guard every interval would start ANOTHER concurrent pass (each one
  // decompressing whole artifacts through the zlib thread pool), stacking up
  // to sustained multi-core saturation and starving the host event loop
  // (observed: 355MB store, ~118s per pass, ~487% CPU on `dsh web`). An
  // in-flight pass is skipped; the next interval re-scans.
  let running = false

  const tick = async (): Promise<void> => {
    if (running) {
      options.logger.warn(
        'grok-server: session health pass still running from the previous interval — skipping this tick (store too large for the interval)',
      )
      return
    }
    running = true
    try {
      await tickCore()
    } finally {
      running = false
    }
  }

  const tickCore = async (): Promise<void> => {
    const now = Date.now()
    const paths: string[] = []
    try {
      for await (const path of glob(
        join(options.root, '*', '*', 'session.jsonl.zstd'),
      )) {
        paths.push(path)
      }
    } catch (error: unknown) {
      options.logger.warn(
        `grok-server: session health scan failed: ${String(error)}`,
      )
      return
    }
    for (const path of paths) {
      let identity: ArtifactIdentity
      try {
        const st = await stat(path)
        identity = { size: st.size, mtimeMs: st.mtimeMs }
      } catch {
        // The artifact vanished mid-scan or is unreadable: forget it.
        lastSeen.delete(path)
        continue
      }
      // Never fight a writer that touched the file within the last two
      // intervals; it will be re-checked once it settles.
      if (now - identity.mtimeMs < intervalMs * 2) continue
      const previous = lastSeen.get(path)
      if (
        previous !== undefined &&
        previous.size === identity.size &&
        previous.mtimeMs === identity.mtimeMs
      ) {
        continue
      }
      try {
        if (await detectInterleavedArtifact(path)) {
          // Re-stat: skip if the artifact moved since the initial observation,
          // so the repair cannot race a writer that started mid-check.
          const fresh = await stat(path)
          if (
            fresh.size !== identity.size ||
            fresh.mtimeMs !== identity.mtimeMs
          ) {
            continue
          }
          if (await repairInterleavedArtifact(path)) {
            options.logger.warn(
              `grok-server: session health watch repaired interleaved log ${path}`,
            )
          }
        }
      } catch (error: unknown) {
        options.logger.warn(
          `grok-server: session health check failed for ${path}: ${String(error)}`,
        )
      }
      try {
        const after = await stat(path)
        lastSeen.set(path, { size: after.size, mtimeMs: after.mtimeMs })
      } catch {
        lastSeen.delete(path)
      }
    }
  }

  timer = setInterval(() => {
    void tick()
  }, intervalMs)
  timer.unref?.()

  return {
    tick,
    dispose: () => {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
  }
}
