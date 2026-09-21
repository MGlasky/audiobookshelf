const Path = require('path')
const Logger = require('../Logger')
const Database = require('../Database')
const fileUtils = require('../utils/fileUtils')
const LibraryModel = require('../models/Library')
const LibraryItemScanner = require('../scanner/LibraryItemScanner')

const { DownloadImportStatus, QUEUE_EVENT_NAME, STABILITY_POLL_INTERVAL_SECONDS, STABILITY_TIMEOUT_MS } = require('./constants')
const { parseReleaseName } = require('./ReleaseParser')
const { MatchAdapter, estimateDurationMinutes } = require('./MatchAdapter')
const { buildImportPlan, executeImport } = require('./Importer')
const { DownloadWatcher, waitForDirectoryStability, snapshotDirectory } = require('./DownloadWatcher')
const { qualifyCandidate } = require('./qualifiers/index')

/**
 * Orchestrates the download-import pipeline:
 *   watch candidate → stability → qualifier → audio filter → parse →
 *   match → normalize → import → verify → scanner handoff.
 *
 * Everything it does is recorded in DownloadImportQueue rows. It never
 * writes Library/Book/LibraryItem records itself - ingestion is delegated
 * to LibraryItemScanner.scanPotentialNewLibraryItem, and sources are never
 * deleted.
 */

const ACTIVE_STATUSES = [
  DownloadImportStatus.DETECTED,
  DownloadImportStatus.QUALIFYING,
  DownloadImportStatus.IDENTIFYING,
  DownloadImportStatus.MATCH_REVIEW,
  DownloadImportStatus.NORMALIZING,
  DownloadImportStatus.IMPORTING
]

/**
 * Pick the LibraryFolder a destination belongs to.
 *
 * @param {Object} library with libraryFolders
 * @param {string} destinationPath
 * @param {string|null} [preferredFolderId] explicit target from settings
 * @returns {Object|null}
 */
function resolveFolder(library, destinationPath, preferredFolderId = null) {
  const folders = library.libraryFolders || []
  if (!folders.length) return null

  if (preferredFolderId) {
    const preferred = folders.find((folder) => folder.id === preferredFolderId)
    if (preferred) return preferred
  }

  const posixDestination = fileUtils.filePathToPOSIX(destinationPath)
  const containing = folders.find((folder) => posixDestination.startsWith(fileUtils.filePathToPOSIX(folder.path)))
  return containing || folders[0]
}

class DownloadImportManager {
  /**
   * @param {Object} [deps] test overrides
   * @param {Object} [deps.db] Database-like (defaults to the Database singleton)
   * @param {Object} [deps.scanner] scanner with scanPotentialNewLibraryItem
   */
  constructor(deps = {}) {
    /** @type {DownloadWatcher|null} */
    this.watcher = null
    /** @type {Map<string, Object>} libraryId → { library, roots, targetFolderId, threshold, stabilityWindowMinutes, assumedBitrateKbps, clientConfig } */
    this.enabledLibraries = new Map()
    /** @type {Set<string>} "libraryId:sourcePath" keys currently processing */
    this.inFlight = new Set()
    /** Optional listener for queue changes (Server.js wires SocketAuthority here). */
    this.queueChangeListener = null

    this.db = deps.db || Database
    this.scanner = deps.scanner || LibraryItemScanner
    this.matchAdapter = deps.matchAdapter || new MatchAdapter(deps.bookFinder || undefined)
  }

  /**
   * Boot hook. Inert unless the server-level flag is enabled.
   */
  async init() {
    const enabled = this.db.serverSettings?.downloadImportEnabled
    if (!enabled) {
      Logger.debug('[DownloadImport] Engine disabled - not watching')
      return
    }
    await this.refreshFromLibraries()
  }

  /**
   * Reload per-library configuration and rebuild watcher subscriptions.
   */
  async refreshFromLibraries() {
    const libraries = await this.db.libraryModel.findAll({ include: this.db.libraryFolderModel })
    this.enabledLibraries.clear()

    for (const library of libraries) {
      // librarySettings getter never returns null (falls back to defaults)
      const settings = library.librarySettings
      if (!settings?.downloadImportEnabled) continue
      if (!settings.downloadImportWatchRoots?.length) continue
      if (!library.libraryFolders?.length) {
        Logger.warn(`[DownloadImport] Library "${library.name}" has import enabled but no folders - skipping`)
        continue
      }

      this.enabledLibraries.set(library.id, {
        library,
        roots: settings.downloadImportWatchRoots,
        targetFolderId: settings.downloadImportTargetFolderId || null,
        threshold: settings.downloadImportConfidenceThreshold ?? 0.8,
        stabilityWindowMinutes: settings.downloadImportStabilityWindowMinutes ?? 10,
        stabilityPollMs: settings.downloadImportStabilityPollMs ?? STABILITY_POLL_INTERVAL_SECONDS * 1000,
        stabilityTimeoutMs: settings.downloadImportStabilityTimeoutMs ?? STABILITY_TIMEOUT_MS,
        assumedBitrateKbps: settings.downloadImportAssumedBitrateKbps ?? 64,
        clientConfig: settings.downloadImportClient || null
      })
    }

    this.rebuildWatcherSubscriptions()
    Logger.info(`[DownloadImport] Watching ${this.watchRoots.length} root(s) for ${this.enabledLibraries.size} enabled library(ies)`)
  }

  /** @returns {Array<{ path: string, libraryId: string }>} deduped enabled roots as WatchRoots */
  get watchRoots() {
    const byPath = new Map()
    for (const config of this.enabledLibraries.values()) {
      for (const root of config.roots) {
        if (!byPath.has(root)) byPath.set(root, { path: root, libraryId: config.library.id })
      }
    }
    return [...byPath.values()]
  }

  rebuildWatcherSubscriptions() {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    const roots = this.watchRoots
    if (!roots.length) return

    this.watcher = new DownloadWatcher()
    this.watcher.on('detected', ({ rootPath, dirPath }) => {
      this.handleWatchCandidate(rootPath, dirPath).catch((error) => {
        Logger.error(`[DownloadImport] Candidate handling failed: ${error.message}`)
      })
    })
    this.watcher.on('error', (error) => {
      Logger.error(`[DownloadImport] Watcher error: ${error.message}`)
    })
    this.watcher.start(roots)
  }

  /**
   * Emit a queue change to the UI (listener wired at boot).
   *
   * @param {Object} queueItem
   */
  emitQueueChange(queueItem) {
    if (!this.queueChangeListener) return
    try {
      this.queueChangeListener(QUEUE_EVENT_NAME, queueItem)
    } catch (error) {
      Logger.error(`[DownloadImport] Queue change listener failed: ${error.message}`)
    }
  }

  /**
   * Find the enabled-library config responsible for a watch root.
   *
   * @param {string} rootPath
   * @returns {Object|null}
   */
  findConfigForRoot(rootPath) {
    const posixRoot = fileUtils.filePathToPOSIX(rootPath)
    for (const config of this.enabledLibraries.values()) {
      if (config.roots.some((root) => fileUtils.filePathToPOSIX(root) === posixRoot)) return config
    }
    return null
  }

  /**
   * Process a candidate directory surfaced by the watcher.
   *
   * @param {string} rootPath watch root
   * @param {string} candidatePath directory (immediate child of the root)
   * @returns {Promise<Object|null>} the queue row, or null when ignored
   */
  async handleWatchCandidate(rootPath, candidatePath) {
    const config = this.findConfigForRoot(rootPath)
    if (!config) return null

    const sourcePath = fileUtils.filePathToPOSIX(candidatePath)
    const flightKey = `${config.library.id}:${sourcePath}`

    // Skip when an active row already covers this path or it is being processed
    const existing = await this.db.downloadImportQueueModel.findOne({
      where: { libraryId: config.library.id, sourcePath }
    })
    if (existing && ACTIVE_STATUSES.includes(existing.status)) return null
    if (this.inFlight.has(flightKey)) return null
    this.inFlight.add(flightKey)

    let queueItem = existing
    try {
      if (!queueItem) {
        queueItem = await this.db.downloadImportQueueModel.create({
          libraryId: config.library.id,
          folderId: config.targetFolderId,
          watchRoot: fileUtils.filePathToPOSIX(rootPath),
          sourcePath,
          releaseName: Path.basename(sourcePath),
          status: DownloadImportStatus.DETECTED,
          attempts: 0
        })
        this.emitQueueChange(queueItem)
      }

      queueItem = await this.processQueueItem(queueItem, config)
      return queueItem
    } finally {
      this.inFlight.delete(flightKey)
    }
  }

  /**
   * Run one processing pass over a queue row.
   *
   * @param {Object} queueItem
   * @param {Object} config enabled-library config
   * @returns {Promise<Object>} refreshed row
   */
  async processQueueItem(queueItem, config) {
    const sourcePath = queueItem.sourcePath
    try {
      queueItem.attempts = (queueItem.attempts || 0) + 1

      // Qualification: filesystem stability first, then optional client check
      queueItem.status = DownloadImportStatus.QUALIFYING
      await queueItem.save()
      this.emitQueueChange(queueItem)

      const stabilityResult = await waitForDirectoryStability(
        sourcePath,
        config.stabilityWindowMinutes * 60 * 1000,
        config.stabilityPollMs,
        config.stabilityTimeoutMs
      )
      if (!stabilityResult.stable) {
        return await this.finishWithError(queueItem, 'stability', `Directory never became stable (${stabilityResult.reason})`)
      }

      const qualifierResult = await qualifyCandidate({ name: queueItem.releaseName, path: sourcePath }, config.clientConfig)
      if (!qualifierResult.qualified) {
        if (qualifierResult.transient) {
          // Leave the row qualifying - the next watcher event for this directory retries
          Logger.info(`[DownloadImport] ${queueItem.releaseName}: transient qualification: ${qualifierResult.detail}`)
          return queueItem
        }
        return await this.finishWithError(queueItem, 'qualify', qualifierResult.detail || 'Download client did not qualify this release')
      }

      // Audio filter: a directory with no supported audio is not a release
      const snapshot = await snapshotDirectory(sourcePath)
      if (!snapshot || snapshot.audioFileCount === 0) {
        queueItem.status = DownloadImportStatus.SKIPPED
        queueItem.errorStage = 'filter'
        queueItem.errorReason = 'No supported audio files'
        await queueItem.save()
        this.emitQueueChange(queueItem)
        return queueItem
      }

      // Parse
      const releaseInfo = parseReleaseName(queueItem.releaseName)
      queueItem.parsedMetadata = releaseInfo

      // Match
      queueItem.status = DownloadImportStatus.IDENTIFYING
      await queueItem.save()
      this.emitQueueChange(queueItem)

      const durationMinutes = estimateDurationMinutes(snapshot.audioTotalSizeBytes, config.assumedBitrateKbps)
      const matchResult = await this.matchAdapter.match(releaseInfo, {
        provider: 'audible',
        durationMinutes,
        threshold: config.threshold
      })

      queueItem.matchData = {
        candidates: matchResult.candidates,
        searchTitle: matchResult.searchTitle,
        searchAuthor: matchResult.searchAuthor,
        manual: false
      }
      queueItem.confidence = matchResult.confidence

      if (matchResult.status !== 'matched') {
        queueItem.status = DownloadImportStatus.MATCH_REVIEW
        await queueItem.save()
        this.emitQueueChange(queueItem)
        return queueItem
      }

      return await this.importQueueItem(queueItem, config, releaseInfo)
    } catch (error) {
      Logger.error(`[DownloadImport] Processing "${queueItem.releaseName}" failed: ${error.message}`)
      return await this.finishWithError(queueItem, 'pipeline', error.message)
    }
  }

  /**
   * Normalize + import + scanner handoff for a matched queue row.
   *
   * @param {Object} queueItem
   * @param {Object} config enabled-library config
   * @param {import('./ReleaseParser').ReleaseInfo} releaseInfo
   * @returns {Promise<Object>} refreshed row
   */
  async importQueueItem(queueItem, config, releaseInfo) {
    queueItem.status = DownloadImportStatus.NORMALIZING
    await queueItem.save()
    this.emitQueueChange(queueItem)

    const plan = await buildImportPlan(queueItem.sourcePath, this.targetFolderRoot(config), releaseInfo)
    queueItem.importPlan = plan
    queueItem.destinationPath = plan.destinationPath
    await queueItem.save()

    queueItem.status = DownloadImportStatus.IMPORTING
    await queueItem.save()
    this.emitQueueChange(queueItem)

    const result = await executeImport(plan)
    if (!result.success) {
      return await this.finishWithError(queueItem, 'import', result.error || 'Import failed')
    }

    // Scanner handoff - the only ingestion path
    let libraryItem = null
    try {
      libraryItem = await this.handOffToScanner(plan.destinationPath, config)
    } catch (error) {
      return await this.finishWithError(queueItem, 'scan', error.message)
    }

    queueItem.status = DownloadImportStatus.IMPORTED
    queueItem.errorStage = null
    queueItem.errorReason = null
    await queueItem.save()
    this.emitQueueChange(queueItem)
    Logger.info(`[DownloadImport] Imported "${queueItem.releaseName}" (${result.mode}, ${result.importedFiles} files) → ${plan.destinationPath}${libraryItem ? '' : ' (scan pending)'}`)
    return queueItem
  }

  /**
   * Absolute path of the library folder imports materialize into.
   *
   * @param {Object} config
   * @returns {string}
   */
  targetFolderRoot(config) {
    const folder = resolveFolder(config.library, config.library.libraryFolders?.[0]?.path || '/', config.targetFolderId)
    if (!folder) throw new Error(`Library "${config.library.name}" has no folders to import into`)
    return fileUtils.filePathToPOSIX(folder.path)
  }

  /**
   * Delegate ingestion to LibraryItemScanner. Backfills null library
   * settings first: the scanner reads `library.settings` directly, and a
   * null dereference there (audiobooksOnly) is what kills naive handoffs.
   *
   * @param {string} destinationPath
   * @param {Object} config enabled-library config
   * @returns {Promise<Object|null>} the new LibraryItem, when scanned
   */
  async handOffToScanner(destinationPath, config) {
    const library = config.library

    if (!library.settings) {
      Logger.warn(`[DownloadImport] Library "${library.name}" has null settings - backfilling defaults before scan handoff`)
      library.settings = LibraryModel.getDefaultLibrarySettingsForMediaType(library.mediaType)
    }

    const folder = resolveFolder(library, destinationPath, config.targetFolderId)
    if (!folder) throw new Error('No library folder available for scan handoff')

    return this.scanner.scanPotentialNewLibraryItem(destinationPath, library, folder, false)
  }

  /**
   * Move a row to error state.
   *
   * @param {Object} queueItem
   * @param {string} stage
   * @param {string} reason
   * @returns {Promise<Object>}
   */
  async finishWithError(queueItem, stage, reason) {
    queueItem.status = DownloadImportStatus.ERROR
    queueItem.errorStage = stage
    queueItem.errorReason = reason
    await queueItem.save()
    this.emitQueueChange(queueItem)
    return queueItem
  }

  /**
   * Dry run: parse, match, and plan a candidate without writing anything.
   * Returns exactly the data a real run would use (same plan functions).
   *
   * @param {string} candidatePath
   * @param {string} libraryId
   * @returns {Promise<Object>} { releaseName, releaseInfo, stability, matchResult, plan }
   */
  async dryRun(candidatePath, libraryId) {
    const config = this.enabledLibraries.get(libraryId)
    if (!config) throw new Error(`Library ${libraryId} is not configured for download import`)

    const sourcePath = fileUtils.filePathToPOSIX(candidatePath)
    const stability = await waitForDirectoryStability(
      sourcePath,
      config.stabilityWindowMinutes * 60 * 1000,
      config.stabilityPollMs,
      config.stabilityTimeoutMs
    )

    const releaseInfo = parseReleaseName(Path.basename(sourcePath))
    const snapshot = await snapshotDirectory(sourcePath)
    const durationMinutes = estimateDurationMinutes(snapshot?.audioTotalSizeBytes || 0, config.assumedBitrateKbps)

    const matchResult = await this.matchAdapter.match(releaseInfo, {
      provider: 'audible',
      durationMinutes,
      threshold: config.threshold
    })

    const plan = await buildImportPlan(sourcePath, this.targetFolderRoot(config), releaseInfo)
    return { releaseName: Path.basename(sourcePath), releaseInfo, stability, matchResult, plan }
  }

  /**
   * List queue items with optional filters.
   *
   * @param {Object} [options]
   * @returns {Promise<Object[]>}
   */
  async getQueueItems({ libraryId = null, status = null, limit = 50, offset = 0 } = {}) {
    const where = {}
    if (libraryId) where.libraryId = libraryId
    if (status) where.status = status
    return this.db.downloadImportQueueModel.findAll({ where, limit, offset, order: [['createdAt', 'DESC']] })
  }

  /**
   * Retry a failed or review-stuck row: clears the error and reprocesses.
   *
   * @param {string} queueItemId
   * @returns {Promise<Object>} refreshed row
   */
  async retry(queueItemId) {
    const queueItem = await this.db.downloadImportQueueModel.findByPk(queueItemId)
    if (!queueItem) throw new Error('Queue item not found')
    if ([DownloadImportStatus.IMPORTED, DownloadImportStatus.IMPORTING].includes(queueItem.status)) {
      throw new Error('Item already imported')
    }

    const config = this.enabledLibraries.get(queueItem.libraryId)
    if (!config) throw new Error('Library is no longer configured for download import')

    queueItem.errorStage = null
    queueItem.errorReason = null
    queueItem.status = DownloadImportStatus.DETECTED
    await queueItem.save()
    this.emitQueueChange(queueItem)

    return this.processQueueItem(queueItem, config)
  }

  /**
   * Admin dismissal: the user decided not to import.
   *
   * @param {string} queueItemId
   * @returns {Promise<Object>}
   */
  async dismiss(queueItemId) {
    const queueItem = await this.db.downloadImportQueueModel.findByPk(queueItemId)
    if (!queueItem) throw new Error('Queue item not found')
    if (queueItem.status === DownloadImportStatus.IMPORTED) throw new Error('Item already imported')

    queueItem.status = DownloadImportStatus.SKIPPED
    queueItem.errorStage = 'dismissed'
    queueItem.errorReason = 'Dismissed by admin'
    await queueItem.save()
    this.emitQueueChange(queueItem)
    return queueItem
  }

  /**
   * Apply a manual match decision (ASIN or candidate pick) and import.
   *
   * @param {string} queueItemId
   * @param {Object} payload { asin } or { candidate }
   * @returns {Promise<Object>} refreshed row
   */
  async applyManualMatch(queueItemId, payload) {
    const queueItem = await this.db.downloadImportQueueModel.findByPk(queueItemId)
    if (!queueItem) throw new Error('Queue item not found')
    if (queueItem.status === DownloadImportStatus.IMPORTED) throw new Error('Item already imported')

    const config = this.enabledLibraries.get(queueItem.libraryId)
    if (!config) throw new Error('Library is no longer configured for download import')

    const matchResult = await this.matchAdapter.manualMatch(payload, { provider: 'audible' })
    if (matchResult.status !== 'matched') {
      queueItem.matchData = {
        candidates: matchResult.candidates,
        searchTitle: matchResult.searchTitle,
        searchAuthor: matchResult.searchAuthor,
        manual: true
      }
      await queueItem.save()
      this.emitQueueChange(queueItem)
      throw new Error(`Manual match failed: ${matchResult.status}`)
    }

    queueItem.matchData = {
      candidates: matchResult.candidates,
      searchTitle: matchResult.searchTitle,
      searchAuthor: matchResult.searchAuthor,
      manual: true
    }
    queueItem.confidence = matchResult.confidence
    queueItem.parsedMetadata = queueItem.parsedMetadata || parseReleaseName(queueItem.releaseName)

    return this.importQueueItem(queueItem, config, queueItem.parsedMetadata)
  }
}

module.exports = {
  DownloadImportManager,
  resolveFolder
}
