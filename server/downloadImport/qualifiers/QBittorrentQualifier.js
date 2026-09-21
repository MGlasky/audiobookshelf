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
   * States in which seeding has stopped: the torrent is fully downloaded and
   * qBittorrent is no longer uploading it (share limit reached with a pause
   * action, or the user stopped it). `pausedUP` is qBittorrent 4.x naming,
   * `stoppedUP` is the 5.x rename of the same state.
   */
  static get SEEDING_STOPPED_STATES() {
    return ['pausedUP', 'stoppedUP']
  }

  /**
   * Login and fetch the torrent list.
   *
   * @param {string} baseUrl
   * @param {Object} config
   * @returns {Promise<Object[]>} torrents/info array
   */
  async fetchTorrents(baseUrl, config) {
    const sid = await this.login(baseUrl, config)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    try {
      const response = await fetch(`${baseUrl}/api/v2/torrents/info`, {
        headers: { Cookie: `SID=${sid}` },
        signal: controller.signal
      })
      if (!response.ok) throw new Error(`torrents/info failed: HTTP ${response.status}`)
      const torrents = await response.json()
      if (!Array.isArray(torrents)) {
        throw new Error('unexpected torrents/info response')
      }
      return torrents
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * Find the torrent backing a candidate directory.
   *
   * @param {Object[]} torrents
   * @param {string} dirPath
   * @returns {Object|undefined}
   */
  findTorrent(torrents, dirPath) {
    const wantedDir = normalizePathForCompare(dirPath)
    return torrents.find((t) => {
      const savePath = normalizePathForCompare(t.save_path)
      const contentPath = normalizePathForCompare(t.content_path)
      return savePath === wantedDir || contentPath === wantedDir
    })
  }

  /**
   * @param {Object} candidate { dirPath, client }
   * @returns {Promise<QualifierResult>}
   */
  async qualify(candidate) {
    const config = candidate.client || {}
    const baseUrl = String(config.url || '').replace(/\/+$/, '')
    if (!baseUrl) {
      return { qualified: false, reason: 'client_unreachable', detail: 'No URL configured', transient: false }
    }

    try {
      const torrents = await this.fetchTorrents(baseUrl, config)
      const torrent = this.findTorrent(torrents, candidate.dirPath)

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

  /**
   * Decision D4 removal gate: may the verified-import source be deleted?
   * True only when the torrent is fully downloaded AND the seed requirement
   * is met per the Web API - either qBittorrent reports seeding stopped, or
   * the configured cleanup thresholds (min ratio / min seed hours) are met.
   * A torrent that is still seeding (uploading/stalledUP) is never removable.
   *
   * @param {Object} candidate { dirPath, client, cleanup: { minRatio, minSeedHours } }
   * @returns {Promise<SourceRemovalResult>}
   */
  async isSourceRemovable(candidate) {
    const config = candidate.client || {}
    const baseUrl = String(config.url || '').replace(/\/+$/, '')
    if (!baseUrl) {
      return { removable: false, reason: 'no_client', detail: 'No URL configured' }
    }

    try {
      const torrents = await this.fetchTorrents(baseUrl, config)
      const torrent = this.findTorrent(torrents, candidate.dirPath)

      if (!torrent) {
        return {
          removable: false,
          reason: 'not_found',
          detail: `No torrent found with save_path "${candidate.dirPath}" - cannot confirm source is complete`
        }
      }

      if (Number(torrent.progress) < 1) {
        return {
          removable: false,
          reason: 'incomplete',
          detail: `qBittorrent: download only ${Math.round((torrent.progress || 0) * 100)}% complete`
        }
      }

      const state = String(torrent.state || '')
      if (QBittorrentQualifier.SEEDING_STOPPED_STATES.includes(state)) {
        return { removable: true, reason: 'seed_complete', detail: `qBittorrent: seeding stopped (${state})` }
      }

      const minRatio = Number(candidate.cleanup?.minRatio || 0)
      const minSeedHours = Number(candidate.cleanup?.minSeedHours || 0)
      const ratio = Number(torrent.ratio || 0)
      const seedingTimeSeconds = Number(torrent.seeding_time || 0)

      if (minRatio > 0 && ratio >= minRatio) {
        return { removable: true, reason: 'seed_complete', detail: `qBittorrent: ratio ${ratio.toFixed(2)} ≥ min ${minRatio}` }
      }
      if (minSeedHours > 0 && seedingTimeSeconds >= minSeedHours * 3600) {
        const seedHours = Math.round(seedingTimeSeconds / 3600)
        return { removable: true, reason: 'seed_complete', detail: `qBittorrent: seeding time ${seedHours}h ≥ min ${minSeedHours}h` }
      }

      return {
        removable: false,
        reason: 'seeding',
        detail: `qBittorrent: seed requirement not met (${state}, ratio ${ratio.toFixed(2)}, seeding time ${Math.round(seedingTimeSeconds / 3600)}h)`
      }
    } catch (error) {
      Logger.error(`[DownloadImport] qBittorrent cleanup check error: ${error.message}`)
      return { removable: false, reason: 'client_unreachable', detail: error.message }
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

module.exports = QBittorrentQualifier
module.exports.QBittorrentQualifier = QBittorrentQualifier
module.exports.normalizePathForCompare = normalizePathForCompare
