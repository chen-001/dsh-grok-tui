/**
 * ACP channel over one leader connection: adapts the SDK's object-message
 * Stream to the leader's length-prefixed `acp` frames. Control-plane frames
 * (register/ping/control) never enter the ACP stream — the connection pump
 * handles them and pushes only `acp` payloads here.
 * @module dsh-grok-tui/stream
 */

import type { AnyMessage, Stream } from '@agentclientprotocol/sdk'
import type { LeaderConnection } from './leader.ts'

/** A bidirectional ACP object channel over a leader connection. */
export interface AcpChannel {
  /** The SDK Stream handed to `AgentSideConnection`. */
  stream: Stream
  /** Parse and enqueue one raw ACP JSON-RPC payload from the wire. */
  push(payload: string): void
  /** Close the readable side (connection teardown). */
  close(): void
}

/**
 * Build an ACP channel for one leader connection.
 * @param conn - the accepted leader connection (owns the socket writes).
 * @returns the channel: stream + push/close.
 */
export function acpChannel(conn: LeaderConnection): AcpChannel {
  let controller: ReadableStreamDefaultController<AnyMessage> | undefined
  let closed = false
  const stream: Stream = {
    readable: new ReadableStream<AnyMessage>({
      start(inner) {
        controller = inner
      },
      cancel() {
        closed = true
      },
    }),
    writable: new WritableStream<AnyMessage>({
      write(message) {
        conn.sendAcp(JSON.stringify(message))
      },
    }),
  }
  return {
    stream,
    push(payload: string): void {
      if (closed || controller === undefined) return
      try {
        controller.enqueue(JSON.parse(payload) as AnyMessage)
      } catch {
        // Invalid ACP JSON on the wire: drop the frame.
      }
    },
    close(): void {
      if (closed) return
      closed = true
      controller?.close()
    },
  }
}
