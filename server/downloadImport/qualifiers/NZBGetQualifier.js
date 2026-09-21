const Logger = require('../../Logger')
const { normalizePathForCompare } = require('./QBittorrentQualifier')

/**
 * NZBGet RPC qualifier (JSON-RPC over HTTP with basic auth).
 * Uses "listgroups" to find the download group for the release and checks
 * remaining size / active downloads / post-processing status.
 */
class NZBGetQualifier {
  /**
   * @returns {string}
   */
  get type() {
    return 'nzbget'
  }

  /**
   * @param {Object} config
   * @returns {string} Authorization header value
   */
  authHeader(config) {
    const token = Buffer.from(`${config.username || ''}:${config.password || ''}`).toString('base64')
    return `Basic ${token}`
  }

  /**
   * @param {string} baseUrl
   * @param {string} method
   * @param {Object} config
   * @param {any[]} params
   * @returns {Promise<any>} RPC result
   */
  async rpc(baseUrl, method, config, params = []) {
    const response = await fetch(`${baseUrl}/jsonrpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.authHeader(config)
      },
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(10000)
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const body = await response.json()
    if (body.error !== null && body.error !== undefined) {
      throw new Error(`RPC error: ${JSON.stringify(body.error)}`)
    }
    return body.result
  }

  /**
   * Post-processing status strings that mean the group is done and healthy.
   */
  static get OK_STATUSES() {
    return ['SUCCESS', 'NONE', 'SKIPPED']
  }

  /**
   * @param {QualifierCandidate} candidate
   * @returns {Promise<QualifierResult>}
   */
  async qualify(candidate) {
    const config = candidate.client || {}
    const baseUrl = String(config.url || '').replace(/\/+$/, '')
    if (!baseUrl) {
      return { qualified: false, reason: 'client_unreachable', detail: 'No URL configured', transient: false }
    }

    try {
      const groups = await this.rpc(baseUrl, 'listgroups', config)
      if (!Array.isArray(groups)) {
        throw new Error('unexpected listgroups response')
      }

      const wantedDir = normalizePathForCompare(candidate.dirPath)
      const wantedName = String(candidate.releaseName)
      const group = groups.find((g) => {
        if (normalizePathForCompare(g.DestDir) === wantedDir) return true
        // NZBGet may unpack into a subdirectory named after the NZB
        return normalizePathForCompare(g.DestDir) === normalizePathForCompare(wantedDir.replace(/[\\/]+$/, '')) || g.NZBName === wantedName
      })

      if (!group) {
        return {
          qualified: false,
          reason: 'not_found',
          detail: `No NZBGet group found for "${candidate.releaseName}"`,
          transient: false
        }
      }

      const remainingMb = Number(group.RemainingSizeMB || 0)
      const activeDownloads = Number(group.ActiveDownloads || 0)

      if (remainingMb > 0 || activeDownloads > 0) {
        return {
          qualified: false,
          reason: 'incomplete',
          detail: `NZBGet: ${remainingMb}MB remaining, ${activeDownloads} active`,
          transient: true
        }
      }

      const parStatus = String(group.ParStatus || 'NONE').toUpperCase()
      const unpackStatus = String(group.UnpackStatus || 'NONE').toUpperCase()
      if (!NZBGetQualifier.OK_STATUSES.includes(parStatus) || !NZBGetQualifier.OK_STATUSES.includes(unpackStatus)) {
        return {
          qualified: false,
          reason: 'failed',
          detail: `NZBGet post-processing: par=${parStatus} unpack=${unpackStatus}`,
          transient: false
        }
      }

      return { qualified: true, reason: 'complete', detail: `NZBGet: ${group.Status || 'done'}` }
    } catch (error) {
      Logger.error(`[DownloadImport] NZBGet qualifier error: ${error.message}`)
      return { qualified: false, reason: 'client_unreachable', detail: error.message, transient: true }
    }
  }

  /**
   * Decision D4 removal gate: may the verified-import source be deleted?
   * True only when the release has a complete NZBGet history entry - the
   * download left the queue, finished post-processing, and par verification
   * was clean. No history entry (still queued, or deleted) means the source
   * can never be confirmed complete on the client side.
   *
   * @param {Object} candidate { dirPath, name, client }
   * @returns {Promise<SourceRemovalResult>}
   */
  async isSourceRemovable(candidate) {
    const config = candidate.client || {}
    const baseUrl = String(config.url || '').replace(/\/+$/, '')
    if (!baseUrl) {
      return { removable: false, reason: 'no_client', detail: 'No URL configured' }
    }

    try {
      const history = await this.rpc(baseUrl, 'history', config, [0, 100])
      if (!Array.isArray(history)) {
        throw new Error('unexpected history response')
      }

      const wantedDir = normalizePathForCompare(candidate.dirPath)
      const wantedName = String(candidate.name || candidate.releaseName || '')
      const entry = history.find((h) => {
        if (normalizePathForCompare(h.DestDir) === wantedDir) return true
        return h.NZBName === wantedName
      })

      if (!entry) {
        return {
          removable: false,
          reason: 'not_in_history',
          detail: `No NZBGet history entry for "${wantedName}" - cannot confirm source is complete`
        }
      }

      const status = String(entry.Status || '').toUpperCase()
      const parStatus = String(entry.ParStatus || 'NONE').toUpperCase()
      if (!NZBGetQualifier.OK_STATUSES.includes(parStatus)) {
        return { removable: false, reason: 'par_failed', detail: `NZBGet history: par verification ${parStatus}` }
      }
      if (status !== 'SUCCESS' && status !== 'SUCCESS_WARNING') {
        return { removable: false, reason: 'failed', detail: `NZBGet history status: ${status}` }
      }

      return { removable: true, reason: 'complete_history', detail: `NZBGet history: ${status}` }
    } catch (error) {
      Logger.error(`[DownloadImport] NZBGet cleanup check error: ${error.message}`)
      return { removable: false, reason: 'client_unreachable', detail: error.message }
    }
  }
}

module.exports = NZBGetQualifier
