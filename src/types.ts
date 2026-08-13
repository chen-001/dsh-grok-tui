/**
 * Grok leader wire protocol types (mirror of
 * xai-grok-shell/src/leader/protocol.rs from the grok-build snapshot).
 *
 * Framing: 4-byte big-endian length + JSON, 64MB cap. All messages are
 * tagged `type` with snake_case discriminants.
 * @module dsh-grok-tui/types
 */

/** Cap on a single frame's JSON payload. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024

/** Protocol version advertised to clients; bump only with the grok client. */
export const LEADER_PROTOCOL_VERSION = 1

/** Client-reported capabilities during registration. */
export interface ClientCapabilities {
  yolo_mode?: boolean
  auto_mode?: boolean
  default_model?: string
  client_version?: string
  code_nav_enabled?: boolean
  terminal?: boolean
  fs_read?: boolean
  fs_write?: boolean
}

/** Client → server messages. */
export type ClientMessage =
  | {
    type: 'register'
    client_type: string
    mode: 'stdio' | 'headless'
    capabilities?: ClientCapabilities
  }
  | { type: 'acp'; payload: string }
  | { type: 'control'; request_id: string; command: ControlCommand }
  | { type: 'ping' }
  | { type: 'disconnect' }

/** Leader-side control commands the client may issue. */
export type ControlCommand =
  | { type: 'get_leader_info' }
  | { type: 'cpu_profile_status' }
  | { type: 'start_cpu_profile'; output?: string; frequency_hz?: number }
  | { type: 'stop_cpu_profile' }
  | { type: 'workspace_start'; cwd: string; hub_url?: string }
  | { type: 'workspace_pause' }
  | { type: 'workspace_resume' }
  | { type: 'workspace_stop' }
  | { type: 'workspace_status' }
  | { type: 'relaunch_for_update'; to_version: string }
  | { type: string; [key: string]: unknown }

/** Leader-side control results. */
export interface ControlError {
  code: string
  message: string
  details?: unknown
}

export interface LeaderInfo {
  pid: number
  socket_path: string
  lock_path: string
  ws_url_suffix: string
  leader_protocol_version: number
  leader_binary_version: string
  profiling_supported: boolean
  profiling_compiled_in: boolean
  cpu_profile_active: boolean
  profile_formats: unknown[]
}

export type ControlPayload = { type?: never; [key: string]: unknown }

/** Server → client messages. */
export type ServerMessage =
  | {
    type: 'registered'
    client_id: number
    ready: boolean
    leader_protocol_version?: number
    leader_binary_version?: string
    leader_capabilities?: { control_v1?: boolean; relaunch_v1?: boolean }
  }
  | { type: 'acp'; payload: string }
  | {
    type: 'control_result'
    request_id: string
    result: { Ok?: ControlPayload } | { Err?: ControlError }
  }
  | { type: 'pong' }
  | { type: 'error'; code: number; message: string }
  | {
    type: 'shutting_down'
    reason: 'auto_update' | 'idle_timeout' | 'manual'
    delay_ms: number
  }
  | { type: 'shutdown' }
  | { type: 'leader_ready' }
