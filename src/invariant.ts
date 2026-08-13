/**
 * Package-owned invariant companion for dsh-grok-tui.
 * @module dsh-grok-tui/invariant
 */

import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
/* jscpd:ignore-start */
import type { Context } from 'cordis'

const PACKAGE_NAME = 'dsh-grok-tui'

export const name = 'grok-server-invariant'
export const inject = ['invariants']

const install: InvariantInstaller = (_ctx, _fail) => {
  // No runtime invariant: this package is a wire-protocol adapter whose only
  // owned relations (accepted sockets are closed with the fiber; the socket
  // file is unlinked on dispose; owned agents are cancelled and joined on
  // disconnect) are enforced by the connection lifecycle itself and verified
  // through the real-composition tests.
}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
