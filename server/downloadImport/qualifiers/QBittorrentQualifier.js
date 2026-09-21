const Logger = require('../../Logger')

/**
 * qBittorrent Web API v2 qualifier.
 * Login for a session cookie, then find the torrent whose save/content path
 * matches the download directory and check its state and progress.
 */
class QBittorrentQualifier {
  /**
   * @returns {string}
   */
  get type() {
    return 'qbittorrent'
  }

  /**
   * @param {string} baseUrl
   * @param {Object} config
   * @returns {Promise<string>} session cookie value
   */
  async login(baseUrl, config) {
    const params = new URLSearchParams()
    params.append('username', config.username || '')
    params.append('password', config.password || '')

    const response = await fetch(`${baseUrl}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(10000)
    })
    if (!response.ok) {
      throw new Error(`login failed: HTTP ${response.status}`)
    }
    const body = await response.text()
    if (body !== 'Ok.') {
      throw new Error('login rejected')
    }

    const cookies = response.headers.get('set-cookie') || ''
    const sidMatch = cookies.match(/SID=([^;]+)/)
    if (!sidMatch) {
      throw new Error('no session cookie returned')
    }
    return sidMatch[1]
  }

  /**
   * States in which the torrent has finished downloading (may still be seeding).
   */
  static get COMPLETE_STATES() {
    return ['uploading', 'pausedUP', 'stalledUP', 'queuedUP', 'forcedUP', 'checkingUP']
  }

  /**
   * Terminal failure states - retrying will not help.
   */
  static get FAILED_STATES() {
    return ['error', 'missingFiles']
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
      const sid = await this.login(baseUrl, config)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10000)
      let torrents
      try {
        const response = await fetch(`${baseUrl}/api/v2/torrents/info`, {
          headers: { Cookie: `SID=${sid}` },
          signal: controller.signal
        })
        if (!response.ok) throw new Error(`torrents/info failed: HTTP ${response.status}`)
        torrents = await response.json()
      } finally {
        clearTimeout(timeout)
      }
      if (!Array.isArray(torrents)) {
        throw new Error('unexpected torrents/info response')
      }

      const wantedDir = normalizePathForCompare(candidate.dirPath)
      const torrent = torrents.find((t) => {
        const savePath = normalizePathForCompare(t.save_path)
        const contentPath = normalizePathForCompare(t.content_path)
        return savePath === wantedDir || contentPath === wantedDir
      })

      if (!torrent) {
        return {
          qualified: false,
          reason: 'not_found',
          detail: `No torrent found with save_path "${candidate.dirPath}"`,
          transient: false
        }
      }

      if (QBittorrentQualifier.COMPLETE_STATES.includes(torrent.state) && Number(torrent.progress) >= 1) {
        return { qualified: true, reason: 'complete', detail: `qBittorrent: ${torrent.state}` }
      }

      if (QBittorrentQualifier.FAILED_STATES.includes(torrent.state)) {
        return { qualified: false, reason: 'failed', detail: `qBittorrent: ${torrent.state}`, transient: false }
      }

      return {
        qualified: false,
        reason: 'incomplete',
        detail: `qBittorrent: ${torrent.state} (${Math.round((torrent.progress || 0) * 100)}%)`,
        transient: true
      }
    } catch (error) {
      Logger.error(`[DownloadImport] qBittorrent qualifier error: ${error.message}`)
      return { qualified: false, reason: 'client_unreachable', detail: error.message, transient: true }
    }
  }
}

/**
 * Normalize a path for client-side comparison (POSIX separators, no trailing slash).
 *
 * @param {string} path
 * @returns {string}
 */
function normalizePathForCompare(path) {
  let normalized = String(path || '').replace(/\\/g, '/')
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}

module.exports.QBittorrentQualifier = QBittorrentQualifier
module.exports.normalizePathForCompare = normalizePathForCompare
