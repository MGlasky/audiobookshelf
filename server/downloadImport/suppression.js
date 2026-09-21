const Crypto = require('crypto')

/**
 * Stage-5 duplicate suppression. The invariant: the same download must never
 * import twice. A download is identified by its source path plus the download
 * client's identity for it (qBittorrent torrent hash, NZBGet NZBID) when one
 * is available - the two together form the row fingerprint.
 */

/**
 * Materialized dedup key for a queue row.
 *
 * The caller supplies the canonical (filePathToPOSIX) source path; no
 * normalization happens here so the key stays stable across restarts.
 * A row without client identity hashes to a path-only fingerprint - the
 * conservative case: it suppresses re-imports of the same directory.
 *
 * @param {string} sourcePath canonical source directory path
 * @param {string|null} [clientId] download client identity, when known
 * @returns {string} sha256 hex digest
 */
function computeFingerprint(sourcePath, clientId = null) {
  return Crypto.createHash('sha256').update(`${sourcePath}\n${clientId || ''}`).digest('hex')
}

/**
 * Decide what a watcher event for an already-imported source means.
 *
 * Identity comparison rules (client id known / unknown):
 * - stored and current ids both present and different → a new download was
 *   placed in the same directory: reprocess it as a fresh row.
 * - any other combination → the same download (or an indeterminate one):
 *   suppress. Re-importing the same release is the failure mode this
 *   exists to prevent, so the conservative answer wins whenever the client
 *   cannot confirm a changed identity (client removed, unreachable, or
 *   never configured).
 * - when the row never learned an identity but the client now provides one,
 *   the row is upgraded in place (same download, first identification).
 *
 * @param {string|null} storedClientId identity the row imported under
 * @param {{ clientId: string|null, clientKind: string|null }} identity current client probe
 * @returns {{ action: 'suppress'|'new-download', upgraded?: boolean }}
 */
function resolveImportedResurface(storedClientId, identity) {
  const currentId = identity?.clientId || null
  if (storedClientId && currentId && storedClientId !== currentId) {
    return { action: 'new-download' }
  }
  return { action: 'suppress', upgraded: !storedClientId && Boolean(currentId) }
}

module.exports = {
  computeFingerprint,
  resolveImportedResurface
}
