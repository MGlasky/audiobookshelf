const Path = require('path')
const EventEmitter = require('events')
const WatcherLib = require('../libs/watcher/watcher')
const fs = require('../libs/fsExtra')
const Logger = require('../Logger')

const { filePathToPOSIX, shouldIgnoreFile } = require('../utils/fileUtils')
const globals = require('../utils/globals')
const { isTempArtifactName, WATCH_BATCH_DELAY_MS, STABILITY_POLL_INTERVAL_SECONDS, STABILITY_TIMEOUT_MS } = require('./constants')

/** Milliseconds between stability probes, derived from the seconds-based constant. */
const STABILITY_POLL_MS = STABILITY_POLL_INTERVAL_SECONDS * 1000

/**
 * @typedef WatchRoot
 * @property {string} path absolute directory to watch
 * @property {string} libraryId library downloads from this root import into
 */

/**
 * @typedef DirectorySnapshot
 * @property {number} fileCount
 * @property {number} totalSizeBytes
 * @property {number} maxMtimeMs newest mtime of any file within
 * @property {number} audioFileCount files with a supported audio extension
 * @property {string[]} tempFiles paths of in-progress artifacts (".part", ".!qB", "_UNPACK")
 */

/**
 * Walk a directory and summarize its contents. Skips dotfiles and does not
 * follow symlinks (no cycles, no escaping the tree). A missing directory
 * returns null.
 *
 * @param {string} dirPath
 * @param {number} [maxFiles=100000] hard cap against pathological trees
 * @returns {Promise<DirectorySnapshot|null>}
 */
async function snapshotDirectory(dirPath, maxFiles = 100000) {
  if (!(await fs.pathExists(dirPath))) return null

  const snapshot = { fileCount: 0, totalSizeBytes: 0, maxMtimeMs: 0, audioFileCount: 0, tempFiles: [] }

  /**
   * @param {string} current
   * @returns {Promise<boolean>} false to stop the walk (over the cap)
   */
  const walk = async (current) => {
    const entries = await fs.readdir(current).catch(() => [])
    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      if (snapshot.fileCount > maxFiles) return false

      const entryPath = Path.join(current, entry)
      const stat = await fs.lstat(entryPath).catch(() => null)
      if (!stat) continue
      if (stat.isSymbolicLink()) continue

      if (stat.isDirectory()) {
        const keepGoing = await walk(entryPath)
        if (!keepGoing) return false
        continue
      }

      snapshot.fileCount++
      snapshot.totalSizeBytes += Number(stat.size || 0)
      snapshot.maxMtimeMs = Math.max(snapshot.maxMtimeMs, stat.mtimeMs)
      if (isTempArtifactName(entry)) snapshot.tempFiles.push(entryPath)
      const ext = Path.extname(entry).slice(1).toLowerCase()
      if (ext && globals.SupportedAudioTypes.includes(ext)) snapshot.audioFileCount++
    }
    return true
  }

  await walk(dirPath)
  return snapshot
}

/**
 * Two snapshots describe the same, unmodified file set.
 *
 * @param {DirectorySnapshot|null} a
 * @param {DirectorySnapshot|null} b
 * @returns {boolean}
 */
function snapshotsAreEqual(a, b) {
  if (!a || !b) return false
  return a.fileCount === b.fileCount && a.totalSizeBytes === b.totalSizeBytes && a.maxMtimeMs === b.maxMtimeMs
}

/**
 * Wait until a directory's file set has held stable for `stabilityWindowMs`
 * (sampled every `pollMs`), or until `timeoutMs` elapses. In-progress
 * artifacts (".part", ".!qB", "_UNPACK") keep the directory unstable.
 *
 * @param {string} dirPath
 * @param {number} [stabilityWindowMs]
 * @param {number} [pollMs]
 * @param {number} [timeoutMs]
 * @returns {Promise<{stable:boolean, snapshot:DirectorySnapshot|null, reason:string}>}
 */
async function waitForDirectoryStability(dirPath, stabilityWindowMs = 0, pollMs = STABILITY_POLL_MS, timeoutMs = STABILITY_TIMEOUT_MS) {
  const startedAt = Date.now()
  let previous = await snapshotDirectory(dirPath)

  // Wait out in-progress artifacts before starting the stability clock
  while (previous && previous.tempFiles.length && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    previous = await snapshotDirectory(dirPath)
  }

  let firstStableAt = null

  while (Date.now() - startedAt < timeoutMs) {
    if (!previous) {
      return { stable: false, snapshot: null, reason: 'directory_missing' }
    }
    if (previous.tempFiles.length) {
      firstStableAt = null
    } else if (firstStableAt === null) {
      firstStableAt = Date.now()
    } else if (Date.now() - firstStableAt >= stabilityWindowMs) {
      return { stable: true, snapshot: previous, reason: 'stable' }
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs))
    const current = await snapshotDirectory(dirPath)
    if (!snapshotsAreEqual(previous, current)) {
      firstStableAt = null
    }
    previous = current
  }

  return { stable: false, snapshot: previous, reason: previous?.tempFiles.length ? 'temp_artifacts' : 'timeout' }
}

/**
 * Watches download roots for new release directories. Reuses the vendored
 * watcher package (same as the library FolderWatcher) with event batching:
 * per-file events are debounced into per-directory detections so a download
 * client writing thousands of files triggers one detection.
 *
 * Events:
 *  - 'detected' ({ rootPath, dirPath, releaseName }) - a non-temp directory
 *    under a watch root saw activity and settled after the batch delay
 *  - 'error' (error)
 */
class DownloadWatcher extends EventEmitter {
  constructor() {
    super()

    /** @type {WatchRoot[]} */
    this.watchRoots = []
    /** @type {WatcherLib[]} */
    this.rootWatchers = []

    /** @type {Map<string, { rootPath: string, dirPath: string, releaseName: string }>} */
    this.pendingCandidates = new Map()
    /** @type {NodeJS.Timeout} */
    this.pendingTimeout = null
    this.pendingDelay = WATCH_BATCH_DELAY_MS

    this.closed = false
  }

  /**
   * Start watching the given roots. Existing directories are ignored (the
   * DownloadImportManager reconciles pre-existing downloads on boot).
   *
   * @param {WatchRoot[]} watchRoots
   */
  start(watchRoots) {
    this.close()
    this.watchRoots = watchRoots || []

    for (const root of this.watchRoots) {
      const watcher = new WatcherLib([root.path], {
        ignored: /(^|[\\/\\])\../, // ignore dotfiles
        renameDetection: true,
        renameTimeout: 2000,
        recursive: true,
        ignoreInitial: true,
        persistent: true
      })
      watcher
        .on('add', (path) => this.onWatchEvent(root, filePathToPOSIX(path)))
        .on('change', () => {
          // metadata-only changes are not download activity
        })
        .on('unlink', (path) => this.onWatchEvent(root, filePathToPOSIX(path)))
        .on('rename', (path, pathNext) => this.onWatchEvent(root, filePathToPOSIX(pathNext) || filePathToPOSIX(path)))
        .on('error', (error) => {
          Logger.error(`[DownloadWatcher] ${error}`)
          this.emit('error', error)
        })
        .on('close', () => {
          Logger.debug(`[DownloadWatcher] Watcher closed for "${root.path}"`)
        })

      this.rootWatchers.push(watcher)
      Logger.info(`[DownloadWatcher] Watching "${root.path}" for library ${root.libraryId}`)
    }

    this.closed = false
  }

  /**
   * Stop watching and drop any pending batch.
   */
  close() {
    if (this.pendingTimeout) {
      clearTimeout(this.pendingTimeout)
      this.pendingTimeout = null
    }
    this.pendingCandidates.clear()
    for (const watcher of this.rootWatchers) {
      watcher.close()
    }
    this.rootWatchers = []
    this.watchRoots = []
    this.closed = true
  }

  /**
   * Map a raw file event to the release candidate it belongs to: the immediate
   * child directory of the watch root. Files directly in the root are not
   * release candidates.
   *
   * @param {WatchRoot} root
   * @param {string} eventPath
   * @returns {{ dirPath: string, releaseName: string }|null}
   */
  resolveCandidate(root, eventPath) {
    const relPath = filePathToPOSIX(Path.relative(root.path, eventPath))
    if (!relPath || relPath === '.' || relPath.startsWith('..')) return null

    const [firstSegment] = relPath.split('/')
    if (!firstSegment || firstSegment.startsWith('.')) return null
    if (shouldIgnoreFile(firstSegment)) return null

    return {
      dirPath: Path.join(root.path, firstSegment),
      releaseName: firstSegment
    }
  }

  /**
   * Watcher event handler - batch the event into pending candidates and
   * (re)start the batch delay timer.
   *
   * @param {WatchRoot} root
   * @param {string} eventPath
   */
  onWatchEvent(root, eventPath) {
    if (this.closed) return
    const candidate = this.resolveCandidate(root, eventPath)
    if (!candidate) return

    const key = `${root.path}|${candidate.releaseName}`
    this.pendingCandidates.set(key, { rootPath: root.path, dirPath: candidate.dirPath, releaseName: candidate.releaseName })

    if (this.pendingTimeout) clearTimeout(this.pendingTimeout)
    this.pendingTimeout = setTimeout(() => this.flushPending(), this.pendingDelay)
  }

  /**
   * Batch delay elapsed - emit detections for candidates whose directories
   * still exist and are not named as in-progress artifacts.
   */
  flushPending() {
    this.pendingTimeout = null
    const pending = [...this.pendingCandidates.values()]
    this.pendingCandidates.clear()

    for (const candidate of pending) {
      if (isTempArtifactName(candidate.releaseName)) {
        Logger.debug(`[DownloadWatcher] Skipping in-progress download "${candidate.releaseName}"`)
        continue
      }
      Logger.debug(`[DownloadWatcher] Detected download "${candidate.releaseName}" in "${candidate.rootPath}"`)
      this.emit('detected', candidate)
    }
  }
}

module.exports = {
  DownloadWatcher,
  snapshotDirectory,
  snapshotsAreEqual,
  waitForDirectoryStability
}
