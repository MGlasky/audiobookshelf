const Logger = require('../Logger')
const { WEBHOOK_EVENTS, WEBHOOK_TIMEOUT_MS } = require('./constants')
const Database = require('../Database')

/**
 * Outbound webhook for import pipeline events (Feature Blueprint, stage 4).
 * The real consumer is Mike's n8n flow, which relays to Telegram via the
 * Task-a-Tron 9000 bot; anything that answers HTTP POST with JSON works.
 *
 * Delivery is best-effort by design: a webhook failure is logged and never
 * fails the import pipeline. The URL lives in server settings
 * (`downloadImportWebhookUrl`); when unset, sends are skipped entirely.
 */

/**
 * Build the flat event payload n8n maps onto its Telegram message.
 * Pure so tests can assert the exact shape.
 *
 * @param {DownloadImportWebhookEvent} event
 * @param {Object} queueItem
 * @param {string} [timestamp] ISO timestamp override (tests)
 * @returns {Object}
 */
function buildWebhookPayload(event, queueItem, timestamp = null) {
  const parsed = queueItem.parsedMetadata || {}
  return {
    event,
    timestamp: timestamp || new Date().toISOString(),
    source: 'audiobookshelf-download-import',
    releaseName: queueItem.releaseName || null,
    title: parsed.title || null,
    author: parsed.author || null,
    libraryId: queueItem.libraryId || null,
    status: queueItem.status || null,
    confidence: typeof queueItem.confidence === 'number' ? queueItem.confidence : null,
    sourcePath: queueItem.sourcePath || null,
    destinationPath: queueItem.destinationPath || null,
    errorStage: queueItem.errorStage || null,
    errorReason: queueItem.errorReason || null
  }
}

class DownloadImportWebhook {
  /**
   * @param {Object} [deps]
   * @param {Object} [deps.db] Database-like (defaults to the Database singleton)
   */
  constructor(deps = {}) {
    this.db = deps.db || Database
  }

  /**
   * Configured webhook URL, or empty string when unset/invalid. Only http(s)
   * is allowed - the engine must never be coaxed into file:// or other schemes.
   *
   * @returns {string}
   */
  get webhookUrl() {
    const url = String(this.db.serverSettings?.downloadImportWebhookUrl || '').trim()
    if (!url) return ''
    if (!/^https?:\/\//i.test(url)) {
      Logger.warn('[DownloadImport] Ignoring webhook URL with unsupported scheme')
      return ''
    }
    return url
  }

  /**
   * Deliver an event. Never rejects - all failures are logged and reported in
   * the returned result so pipeline callers can fire-and-forget safely.
   *
   * @param {DownloadImportWebhookEvent} event
   * @param {Object} queueItem
   * @returns {Promise<{ delivered: boolean, skipped: boolean, error: string|null, status: number|null }>}
   */
  async send(event, queueItem) {
    if (!Object.values(WEBHOOK_EVENTS).includes(event)) {
      return { delivered: false, skipped: true, error: `Unknown webhook event "${event}"`, status: null }
    }

    const url = this.webhookUrl
    if (!url) {
      return { delivered: false, skipped: true, error: null, status: null }
    }

    const payload = buildWebhookPayload(event, queueItem)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS)
      })
      if (!response.ok) {
        Logger.warn(`[DownloadImport] Webhook "${event}" delivery failed: HTTP ${response.status}`)
        return { delivered: false, skipped: false, error: `HTTP ${response.status}`, status: response.status }
      }
      Logger.info(`[DownloadImport] Webhook "${event}" delivered`)
      return { delivered: true, skipped: false, error: null, status: response.status }
    } catch (error) {
      Logger.error(`[DownloadImport] Webhook "${event}" delivery error: ${error.message}`)
      return { delivered: false, skipped: false, error: error.message, status: null }
    }
  }
}

module.exports = DownloadImportWebhook
module.exports.buildWebhookPayload = buildWebhookPayload
