const { Request, Response, NextFunction } = require('express')

const Logger = require('../Logger')

/**
 * Admin API for the download-import engine. All routes sit behind the
 * router-level auth middleware and are admin-gated here.
 *
 * @typedef {Request & { user: import('../models/User') }} RequestWithUser
 */

/**
 * Serialize a queue row for API output (works for Sequelize rows and plain objects).
 *
 * @param {Object} row
 * @returns {Object}
 */
function serializeQueueRow(row) {
  if (!row) return null
  return typeof row.toJSON === 'function' ? row.toJSON() : { ...row }
}

class DownloadImportController {
  constructor() {}

  /**
   * Admin-only gate for download-import routes.
   *
   * @this {import('../routers/ApiRouter')}
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   * @param {NextFunction} next
   */
  middleware(req, res, next) {
    if (!req.user.isAdminOrUp) {
      return res.sendStatus(403)
    }
    next()
  }

  /**
   * GET: /api/download-import/status
   *
   * @this {import('../routers/ApiRouter')}
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async getStatus(req, res) {
    const manager = this.downloadImportManager
    if (!manager) return res.sendStatus(503)

    const libraries = []
    for (const config of manager.enabledLibraries.values()) {
      libraries.push({
        id: config.library.id,
        name: config.library.name,
        watchRoots: config.roots,
        threshold: config.threshold,
        client: config.clientConfig?.type || null
      })
    }
    res.json({ enabled: manager.isEnabled(), libraries })
  }

  /**
   * POST: /api/download-import/reload
   * Re-read download-import configuration from the database (after settings changes).
   *
   * @this {import('../routers/ApiRouter')}
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async reload(req, res) {
    const manager = this.downloadImportManager
    if (!manager) return res.sendStatus(503)

    try {
      await manager.refreshFromLibraries()
      res.sendStatus(200)
    } catch (error) {
      Logger.error(`[DownloadImportController] Reload failed: ${error.message}`)
      res.status(500).send({ error: 'Failed to reload download-import configuration' })
    }
  }

  /**
   * GET: /api/download-import/queue?status=&libraryId=
   *
   * @this {import('../routers/ApiRouter')}
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async getQueue(req, res) {
    const manager = this.downloadImportManager
    if (!manager) return res.sendStatus(503)

    try {
      const rows = await manager.getQueueItems({ status: req.query.status || null, libraryId: req.query.libraryId || null })
      res.json({ queue: rows.map(serializeQueueRow) })
    } catch (error) {
      Logger.error(`[DownloadImportController] Queue list failed: ${error.message}`)
      res.status(500).send({ error: 'Failed to list download-import queue' })
    }
  }

  /**
   * POST: /api/download-import/queue/:id/retry
   *
   * @this {import('../routers/ApiRouter')}
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async retry(req, res) {
    const manager = this.downloadImportManager
    if (!manager) return res.sendStatus(503)

    try {
      const row = await manager.retry(req.params.id)
      res.json({ queueItem: serializeQueueRow(row) })
    } catch (error) {
      Logger.error(`[DownloadImportController] Retry failed: ${error.message}`)
      res.status(400).send({ error: error.message })
    }
  }

  /**
   * POST: /api/download-import/queue/:id/dismiss
   *
   * @this {import('../routers/ApiRouter')}
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async dismiss(req, res) {
    const manager = this.downloadImportManager
    if (!manager) return res.sendStatus(503)

    try {
      const row = await manager.dismiss(req.params.id)
      res.json({ queueItem: serializeQueueRow(row) })
    } catch (error) {
      Logger.error(`[DownloadImportController] Dismiss failed: ${error.message}`)
      res.status(400).send({ error: error.message })
    }
  }

  /**
   * POST: /api/download-import/queue/:id/match
   * Body: { asin } or { candidate: { index } } - manual match resolution.
   *
   * @this {import('../routers/ApiRouter')}
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async manualMatch(req, res) {
    const manager = this.downloadImportManager
    if (!manager) return res.sendStatus(503)

    try {
      const row = await manager.applyManualMatch(req.params.id, {
        asin: req.body?.asin || null,
        candidate: req.body?.candidate || null
      })
      res.json({ queueItem: serializeQueueRow(row) })
    } catch (error) {
      Logger.error(`[DownloadImportController] Manual match failed: ${error.message}`)
      res.status(400).send({ error: error.message })
    }
  }

  /**
   * POST: /api/download-import/queue/:id/search
   * Body: { title, author } - re-run the provider search for a Match review
   * row ("refine search"); updates candidates without importing.
   *
   * @this {import('../routers/ApiRouter')}
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async search(req, res) {
    const manager = this.downloadImportManager
    if (!manager) return res.sendStatus(503)

    try {
      const row = await manager.searchQueueItem(req.params.id, {
        title: req.body?.title || '',
        author: req.body?.author || ''
      })
      res.json({ queueItem: serializeQueueRow(row) })
    } catch (error) {
      Logger.error(`[DownloadImportController] Search failed: ${error.message}`)
      res.status(400).send({ error: error.message })
    }
  }

  /**
   * POST: /api/download-import/dry-run
   * Body: { path, libraryId } - plan an import without writing anything.
   *
   * @this {import('../routers/ApiRouter')}
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async dryRun(req, res) {
    const manager = this.downloadImportManager
    if (!manager) return res.sendStatus(503)

    if (!req.body?.path || !req.body?.libraryId) {
      return res.status(400).send({ error: 'Both path and libraryId are required' })
    }

    try {
      const result = await manager.dryRun(req.body.path, req.body.libraryId)
      res.json({
        releaseName: result.releaseName,
        releaseInfo: result.releaseInfo,
        stability: result.stability,
        matchResult: result.matchResult,
        plan: result.plan
      })
    } catch (error) {
      Logger.error(`[DownloadImportController] Dry run failed: ${error.message}`)
      res.status(400).send({ error: error.message })
    }
  }
}

module.exports = new DownloadImportController()
