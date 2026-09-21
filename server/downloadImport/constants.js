/**
 * Constants for the download-import engine (server/downloadImport).
 *
 * This subsystem is self-contained and wired to the rest of the server only at
 * four seams (Server.js, ApiRouter.js, ServerSettings/Library settings, and
 * Database.buildModels). See the Feature Blueprint for the pipeline stages.
 */

/**
 * Queue row states. Every state has an exit; terminal states are 'imported',
 * 'error', 'parked' and 'skipped'.
 *
 * @typedef {string} DownloadImportStatus
 */
const DownloadImportStatus = {
  DETECTED: 'detected',
  QUALIFYING: 'qualifying',
  IDENTIFYING: 'identifying',
  MATCH_REVIEW: 'match_review',
  NORMALIZING: 'normalizing',
  IMPORTING: 'importing',
  IMPORTED: 'imported',
  ERROR: 'error',
  PARKED: 'parked',
  SKIPPED: 'skipped'
}

/**
 * Statuses that a row is actively moved through by the engine.
 * @param {string} status
 * @returns {boolean}
 */
const isTransientStatus = (status) =>
  [DownloadImportStatus.DETECTED, DownloadImportStatus.QUALIFYING, DownloadImportStatus.IDENTIFYING, DownloadImportStatus.NORMALIZING, DownloadImportStatus.IMPORTING].includes(status)

/**
 * Terminal statuses - rows the engine will not process again on its own.
 * @param {string} status
 * @returns {boolean}
 */
const isTerminalStatus = (status) =>
  [DownloadImportStatus.IMPORTED, DownloadImportStatus.ERROR, DownloadImportStatus.PARKED, DownloadImportStatus.SKIPPED].includes(status)

/** Suffixes marking an in-progress download artifact (still being written). */
const TEMP_ARTIFACT_SUFFIXES = ['.part', '.!qB']

/** Substrings marking an in-progress download artifact directory/file. */
const TEMP_ARTIFACT_INCLUDES = ['_UNPACK']

/**
 * Whether a file or directory name is an active temp artifact.
 * Borrowed from the *arr completed-download-handling convention: .part (generic),
 * .!qB (qBittorrent) and _UNPACK (SABnzbd-style extraction dirs).
 *
 * @param {string} name
 * @returns {boolean}
 */
const isTempArtifactName = (name) => {
  if (!name) return false
  const lower = name.toLowerCase()
  if (TEMP_ARTIFACT_SUFFIXES.some((suffix) => lower.endsWith(suffix.toLowerCase()))) return true
  if (TEMP_ARTIFACT_INCLUDES.some((include) => lower.includes(include.toLowerCase()))) return true
  return false
}

/** Default seconds between filesystem stability probes while qualifying. */
const STABILITY_POLL_INTERVAL_SECONDS = 5

/** Default seconds between download-client qualifier checks while qualifying. */
const CLIENT_QUALIFIER_POLL_SECONDS = 30

/** Socket event emitted whenever a queue row is created or updated. */
const QUEUE_EVENT_NAME = 'download_import_queue_updated'

module.exports = {
  DownloadImportStatus,
  isTransientStatus,
  isTerminalStatus,
  isTempArtifactName,
  STABILITY_POLL_INTERVAL_SECONDS,
  CLIENT_QUALIFIER_POLL_SECONDS,
  QUEUE_EVENT_NAME
}
