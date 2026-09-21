const QBittorrentQualifier = require('./QBittorrentQualifier')
const NZBGetQualifier = require('./NZBGetQualifier')

/**
 * Registry of download client qualifiers (decision D1). Unknown client types
 * are rejected loudly rather than silently passing qualification.
 *
 * @type {Map<string, typeof QBittorrentQualifier | typeof NZBGetQualifier>}
 */
const QUALIFIER_TYPES = new Map([
  ['qbittorrent', QBittorrentQualifier],
  ['nzbget', NZBGetQualifier]
])

/**
 * @param {string} type
 * @returns {boolean}
 */
function isQualifierType(type) {
  return QUALIFIER_TYPES.has(type)
}

/**
 * Normalize a pipeline candidate into the contract the qualifier classes
 * expect: `{ name, dirPath, client }`. The manager speaks in `{ name, path }`;
 * the qualifiers read `dirPath` and `candidate.client`. Building this in one
 * place is what keeps the two vocabularies from drifting apart again.
 *
 * @param {Object} candidate raw pipeline candidate ({ name, path })
 * @param {Object|null} clientConfig download client config for the watch root
 * @param {Object|null} [cleanupConfig] optional cleanup thresholds
 * @returns {{ name: string, dirPath: string, client: Object|null, cleanup: Object|null }}
 */
function buildClientCandidate(candidate, clientConfig, cleanupConfig = null) {
  return {
    name: String(candidate?.name || candidate?.releaseName || ''),
    dirPath: String(candidate?.dirPath || candidate?.path || ''),
    client: clientConfig || null,
    cleanup: cleanupConfig || null
  }
}

/**
 * Run the qualifier for a candidate. When no client is configured for the
 * watch root, qualification is filesystem-only (already enforced via the
 * stability check) and passes through.
 *
 * @param {Object} candidate raw pipeline candidate ({ name, path })
 * @param {Object|null} clientConfig null/undefined for filesystem-only roots
 * @returns {Promise<QualifierResult>}
 */
async function qualifyCandidate(candidate, clientConfig) {
  if (!clientConfig || !clientConfig.type) {
    return { qualified: true, reason: 'complete', detail: 'No download client configured - filesystem-only qualification' }
  }

  const QualifierClass = QUALIFIER_TYPES.get(clientConfig.type)
  if (!QualifierClass) {
    return {
      qualified: false,
      reason: 'failed',
      detail: `Unknown download client type "${clientConfig.type}"`,
      transient: false
    }
  }

  return new QualifierClass().qualify(buildClientCandidate(candidate, clientConfig))
}

/**
 * Ask the download client whether a verified-import source may be removed
 * (decision D4). Stricter than qualifyCandidate: qBittorrent must report the
 * seed requirement met, NZBGet must show a complete history entry. When no
 * client is configured the answer is always no - filesystem-only roots never
 * qualify for deletion.
 *
 * @param {Object} candidate raw pipeline candidate ({ name, path })
 * @param {Object|null} clientConfig null/undefined for filesystem-only roots
 * @param {Object|null} [cleanupConfig] optional thresholds ({ minRatio, minSeedHours })
 * @returns {Promise<SourceRemovalResult>}
 */
async function checkSourceRemovable(candidate, clientConfig, cleanupConfig = null) {
  if (!clientConfig || !clientConfig.type) {
    return { removable: false, reason: 'no_client', detail: 'No download client configured - sources are never deleted without client-side confirmation' }
  }

  const QualifierClass = QUALIFIER_TYPES.get(clientConfig.type)
  if (!QualifierClass || typeof new QualifierClass().isSourceRemovable !== 'function') {
    return { removable: false, reason: 'unknown_client', detail: `Unknown download client type "${clientConfig.type}"` }
  }

  return new QualifierClass().isSourceRemovable(buildClientCandidate(candidate, clientConfig, cleanupConfig))
}

module.exports = {
  QUALIFIER_TYPES,
  isQualifierType,
  buildClientCandidate,
  qualifyCandidate,
  checkSourceRemovable
}
