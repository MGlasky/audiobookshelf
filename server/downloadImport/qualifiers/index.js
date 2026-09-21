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
 * Run the qualifier for a candidate. When no client is configured for the
 * watch root, qualification is filesystem-only (already enforced via the
 * stability check) and passes through.
 *
 * @param {QualifierCandidate} candidate
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

  return new QualifierClass().qualify(candidate)
}

module.exports = {
  QUALIFIER_TYPES,
  isQualifierType,
  qualifyCandidate
}
