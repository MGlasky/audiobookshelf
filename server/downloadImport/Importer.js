const Path = require('path')
const fs = require('../libs/fsExtra')
const Logger = require('../Logger')
const globals = require('../utils/globals')

const { parseReleaseName } = require('./ReleaseParser')

/**
 * Naming normalization (decision D2) and file materialization.
 *
 * Destinations follow {Author}/{Series}/{Title} when a series is detected,
 * falling back to {Author}/{Title}. Files are hardlinked when source and
 * destination share a filesystem (inode-preserving so torrents keep
 * seeding) and copied otherwise. Sources are never deleted.
 */

/**
 * @typedef SourceFile
 * @property {string} sourcePath absolute path
 * @property {string} relativePath path within the release directory
 * @property {number} sizeBytes
 * @property {string} [destPath] set when the plan executes
 */

/**
 * @typedef ImportPlan
 * @property {'hardlink'|'copy'} mode
 * @property {boolean} sameFilesystem
 * @property {string} destinationPath absolute final item folder
 * @property {SourceFile[]} files
 */

/**
 * @typedef ImportResult
 * @property {boolean} success
 * @property {'hardlink'|'copy'} mode
 * @property {string} destinationPath
 * @property {number} importedFiles
 * @property {boolean} verified
 * @property {string|null} error
 */

/** File types that ride along with the audio (artwork, metadata, supplements). */
const COMPANION_TYPE_SETS = ['SupportedImageTypes', 'TextFileTypes', 'MetadataFileTypes', 'SupportedEbookTypes']

const ILLEGAL_FS_CHARS = /[/\\:*?"<>|\x00-\x1f]/g

/**
 * Make a release-name segment safe as a filesystem folder name.
 *
 * @param {string} name
 * @returns {string}
 */
function sanitizeFolderName(name) {
  if (!name) return ''
  return name
    .replace(ILLEGAL_FS_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
}

/**
 * Destination folder segments for a release. Segment order follows D2:
 * {Author}/{Series}/{Title}, with {Author}/{Title} when no series exists.
 * A missing author degrades to "Unknown Author" so the layout stays valid.
 *
 * @param {import('./ReleaseParser').ReleaseInfo} releaseInfo
 * @returns {string[]}
 */
function buildDestinationSegments(releaseInfo) {
  const segments = [sanitizeFolderName(releaseInfo.author) || 'Unknown Author']
  if (releaseInfo.series) segments.push(sanitizeFolderName(releaseInfo.series))
  segments.push(sanitizeFolderName(releaseInfo.title) || 'Unknown Title')
  return segments.filter((segment) => segment.length > 0)
}

/**
 * True when a file's extension is in one of the named type arrays.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isImportableFile(filePath) {
  const ext = Path.extname(filePath).slice(1).toLowerCase()
  if (!ext) return false
  if (globals.SupportedAudioTypes.includes(ext)) return true
  return COMPANION_TYPE_SETS.some((key) => Array.isArray(globals[key]) && globals[key].includes(ext))
}

/**
 * Walk a release directory collecting importable files. Symlinks are
 * skipped: they can point outside the release and would be materialized.
 *
 * @param {string} dirPath
 * @param {number} [maxFiles] safety cap
 * @returns {Promise<SourceFile[]>}
 */
async function listImportableFiles(dirPath, maxFiles = 50000) {
  const files = []
  const walk = async (current, prefix) => {
    if (files.length >= maxFiles) return
    const entries = await fs.readdir(current)
    for (const entry of entries) {
      if (files.length >= maxFiles) return
      const entryPath = Path.join(current, entry)
      const relativePath = prefix ? Path.join(prefix, entry) : entry
      const stat = await fs.lstat(entryPath)
      if (stat.isSymbolicLink()) {
        Logger.warn(`[DownloadImport] Skipping symlink during import: ${entryPath}`)
        continue
      }
      if (stat.isDirectory()) {
        await walk(entryPath, relativePath)
        continue
      }
      if (!stat.isFile() || !isImportableFile(entryPath)) continue
      files.push({ sourcePath: entryPath, relativePath, sizeBytes: Number(stat.size || 0) })
    }
  }
  await walk(dirPath, '')
  return files
}

/**
 * Determine whether source and destination root share a filesystem.
 *
 * @param {string} sourcePath
 * @param {string} destinationRoot
 * @returns {Promise<boolean>}
 */
async function isSameFilesystem(sourcePath, destinationRoot) {
  try {
    const [sourceStat, destStat] = await Promise.all([fs.stat(sourcePath), fs.stat(destinationRoot)])
    return sourceStat.dev === destStat.dev
  } catch (error) {
    Logger.error(`[DownloadImport] Filesystem comparison failed: ${error.message}`)
    return false
  }
}

/**
 * Build an import plan for a release directory.
 *
 * @param {string} sourcePath absolute path of the completed release
 * @param {string} libraryRoot absolute path of the destination library folder
 * @param {import('./ReleaseParser').ReleaseInfo} releaseInfo
 * @param {Object} [options]
 * @param {'hardlink'|'copy'} [options.forceMode] test/override hook; auto-detects when omitted
 * @returns {Promise<ImportPlan>}
 */
async function buildImportPlan(sourcePath, libraryRoot, releaseInfo, options = {}) {
  const segments = buildDestinationSegments(releaseInfo)
  const destinationPath = Path.join(libraryRoot, ...segments)
  const files = await listImportableFiles(sourcePath)
  const sameFilesystem = await isSameFilesystem(sourcePath, libraryRoot)

  let mode
  if (options.forceMode) {
    mode = options.forceMode
  } else if (process.platform === 'win32') {
    mode = 'copy'
  } else {
    mode = sameFilesystem ? 'hardlink' : 'copy'
  }

  return { mode, sameFilesystem, destinationPath, files }
}

/**
 * Materialize one file. Hardlinks unlink an existing destination first so
 * re-runs are idempotent (fs.link fails on EEXIST).
 *
 * @param {SourceFile} file with destPath set
 * @param {'hardlink'|'copy'} mode
 * @returns {Promise<void>}
 */
async function materializeFile(file, mode) {
  await fs.ensureDir(Path.dirname(file.destPath))
  if (mode === 'hardlink') {
    await fs.unlink(file.destPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
    await fs.link(file.sourcePath, file.destPath)
  } else {
    await fs.copyFile(file.sourcePath, file.destPath)
  }
}

/**
 * Verify a completed import: every planned file exists at the destination
 * with the planned size; hardlinked files must additionally share the
 * source inode.
 *
 * @param {ImportPlan} plan
 * @returns {Promise<boolean>}
 */
async function verifyImport(plan) {
  for (const file of plan.files) {
    const destStat = await fs.stat(file.destPath).catch(() => null)
    if (!destStat || !destStat.isFile()) {
      Logger.error(`[DownloadImport] Verification failed, missing destination file: ${file.destPath}`)
      return false
    }
    if (file.sizeBytes !== undefined && Number(destStat.size) !== Number(file.sizeBytes)) {
      Logger.error(`[DownloadImport] Verification failed, size mismatch: ${file.destPath}`)
      return false
    }
    if (plan.mode === 'hardlink') {
      const sourceStat = await fs.stat(file.sourcePath).catch(() => null)
      if (!sourceStat || sourceStat.dev !== destStat.dev || sourceStat.ino !== destStat.ino) {
        Logger.error(`[DownloadImport] Verification failed, inode mismatch: ${file.destPath}`)
        return false
      }
    }
  }
  return true
}

/**
 * Execute an import plan. Never touches the source directory.
 *
 * @param {ImportPlan} plan
 * @returns {Promise<ImportResult>}
 */
async function executeImport(plan) {
  if (!plan.files.length) {
    return { success: false, mode: plan.mode, destinationPath: plan.destinationPath, importedFiles: 0, verified: false, error: 'No importable files found in source' }
  }

  try {
    await fs.ensureDir(plan.destinationPath)
    let importedFiles = 0
    for (const file of plan.files) {
      file.destPath = Path.join(plan.destinationPath, file.relativePath)
      await materializeFile(file, plan.mode)
      importedFiles++
    }

    const verified = await verifyImport(plan)
    if (!verified) {
      return { success: false, mode: plan.mode, destinationPath: plan.destinationPath, importedFiles, verified: false, error: 'Import verification failed' }
    }

    return { success: true, mode: plan.mode, destinationPath: plan.destinationPath, importedFiles, verified: true, error: null }
  } catch (error) {
    Logger.error(`[DownloadImport] Import failed: ${error.message}`)
    return { success: false, mode: plan.mode, destinationPath: plan.destinationPath, importedFiles: 0, verified: false, error: error.message }
  }
}

module.exports = {
  sanitizeFolderName,
  buildDestinationSegments,
  buildImportPlan,
  executeImport,
  verifyImport,
  isImportableFile,
  listImportableFiles
}
