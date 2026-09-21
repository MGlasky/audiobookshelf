const Logger = require('../Logger')
const BookFinder = require('../finders/BookFinder')
const { isValidASIN } = require('../utils/index')

/**
 * Adapter around the existing BookFinder/Audnexus matching path. Turns a
 * parsed release into a match decision against the configured confidence
 * threshold, without the engine touching provider internals.
 *
 * Exact-ASIN handling mirrors the scanner: a valid ASIN (from the release
 * name) is searched as the title, which BookFinder short-circuits to
 * confidence 1.0 via its isTitleAsin branch.
 */

/**
 * @typedef MatchCandidate
 * @property {string} title
 * @property {string} author
 * @property {string|null} asin
 * @property {string|null} publishedYear
 * @property {string|null} cover
 * @property {number|null} durationMinutes
 * @property {number|null} matchConfidence
 */

/**
 * @typedef MatchResult
 * @property {'matched'|'needs_review'|'no_matches'} status
 * @property {number|null} confidence confidence of the best candidate
 * @property {MatchCandidate[]} candidates all candidates worth showing
 * @property {string} searchTitle
 * @property {string} searchAuthor
 * @property {string} provider
 * @property {boolean} manual true when the match came from a manual ASIN/choice
 */

/**
 * Estimate audio duration from total audio bytes and a bitrate assumption.
 * ffprobe is deliberately not used here - download dirs are only summarized,
 * never probed before import.
 *
 * @param {number} audioTotalSizeBytes
 * @param {number} bitrateKbps
 * @returns {number|null} minutes
 */
function estimateDurationMinutes(audioTotalSizeBytes, bitrateKbps) {
  if (!audioTotalSizeBytes || !bitrateKbps || bitrateKbps <= 0) return null
  const seconds = (audioTotalSizeBytes * 8) / (bitrateKbps * 1000)
  if (!isFinite(seconds) || seconds <= 0) return null
  return seconds / 60
}

/**
 * Pick the search strings for BookFinder from parsed release metadata.
 *
 * @param {import('./ReleaseParser').ReleaseInfo} releaseInfo
 * @returns {{ searchTitle: string, searchAuthor: string }}
 */
function buildSearchStrings(releaseInfo) {
  const searchTitle = releaseInfo.asin && isValidASIN(releaseInfo.asin) ? releaseInfo.asin.toUpperCase() : releaseInfo.title || ''
  const searchAuthor = releaseInfo.author || ''
  return { searchTitle, searchAuthor }
}

/**
 * Normalize a BookFinder result into a MatchCandidate.
 *
 * @param {Object} book
 * @returns {MatchCandidate}
 */
function toCandidate(book) {
  return {
    title: book.title || '',
    author: book.author || '',
    asin: book.asin || null,
    publishedYear: book.publishedYear || null,
    cover: book.cover || null,
    durationMinutes: typeof book.duration === 'number' ? book.duration : null,
    matchConfidence: typeof book.matchConfidence === 'number' ? book.matchConfidence : null
  }
}

class MatchAdapter {
  constructor(bookFinder = null) {
    // BookFinder's module exports a singleton instance, not the class
    this.bookFinder = bookFinder || BookFinder
  }

  /**
   * Match a parsed release against the configured provider.
   *
   * @param {import('./ReleaseParser').ReleaseInfo} releaseInfo
   * @param {Object} [options]
   * @param {string} [options.provider] BookFinder provider slug, e.g. "audible" or "audible.us"
   * @param {number|null} [options.durationMinutes] estimated audio duration for confidence scoring
   * @param {number} [options.threshold] minimum auto-match confidence (0-1)
   * @param {number} [options.maxFuzzySearches] BookFinder fuzzy search budget
   * @returns {Promise<MatchResult>}
   */
  async match(releaseInfo, { provider = 'audible', durationMinutes = null, threshold = 0.8, maxFuzzySearches = 3 } = {}) {
    const { searchTitle, searchAuthor } = buildSearchStrings(releaseInfo)

    if (!searchTitle) {
      return { status: 'no_matches', confidence: null, candidates: [], searchTitle, searchAuthor, provider, manual: false }
    }

    const libraryItemStub = durationMinutes ? { media: { duration: durationMinutes * 60 } } : null

    let books = []
    try {
      books = await this.bookFinder.search(libraryItemStub, provider, searchTitle, searchAuthor, '', releaseInfo.asin || '', {
        maxFuzzySearches
      })
    } catch (error) {
      Logger.error(`[DownloadImport] BookFinder search failed: ${error.message}`)
      books = []
    }

    if (!books.length) {
      return { status: 'no_matches', confidence: null, candidates: [], searchTitle, searchAuthor, provider, manual: false }
    }

    const candidates = books.filter((book) => book && typeof book === 'object').map(toCandidate)
    const scored = candidates
      .filter((candidate) => candidate.matchConfidence !== null)
      .sort((a, b) => b.matchConfidence - a.matchConfidence)

    const best = scored[0] || null

    if (best && best.matchConfidence >= threshold) {
      return { status: 'matched', confidence: best.matchConfidence, candidates: scored, searchTitle, searchAuthor, provider, manual: false }
    }

    return {
      status: 'needs_review',
      confidence: best ? best.matchConfidence : null,
      candidates: scored.length ? scored : candidates,
      searchTitle,
      searchAuthor,
      provider,
      manual: false
    }
  }

  /**
   * Resolve a manual match: an ASIN lookup (via the same isTitleAsin
   * short-circuit) or an explicit candidate pick. Manual decisions skip the
   * threshold.
   *
   * @param {Object} payload
   * @param {string} [payload.asin]
   * @param {MatchCandidate} [payload.candidate]
   * @param {Object} [options]
   * @param {string} [options.provider]
   * @returns {Promise<MatchResult>}
   */
  async manualMatch(payload, { provider = 'audible' } = {}) {
    if (payload.candidate) {
      return {
        status: 'matched',
        confidence: payload.candidate.matchConfidence ?? null,
        candidates: [{ ...payload.candidate, matchConfidence: payload.candidate.matchConfidence ?? 1.0 }],
        searchTitle: payload.candidate.title || '',
        searchAuthor: payload.candidate.author || '',
        provider,
        manual: true
      }
    }

    const asin = String(payload.asin || '').toUpperCase()
    if (!isValidASIN(asin)) {
      return { status: 'no_matches', confidence: null, candidates: [], searchTitle: asin, searchAuthor: '', provider, manual: true }
    }

    let books = []
    try {
      books = await this.bookFinder.search(null, provider, asin, '', '', asin, { maxFuzzySearches: 0 })
    } catch (error) {
      Logger.error(`[DownloadImport] Manual ASIN lookup failed: ${error.message}`)
      books = []
    }

    if (!books.length) {
      return { status: 'no_matches', confidence: null, candidates: [], searchTitle: asin, searchAuthor: '', provider, manual: true }
    }

    return {
      status: 'matched',
      confidence: 1.0,
      candidates: books.map(toCandidate),
      searchTitle: asin,
      searchAuthor: '',
      provider,
      manual: true
    }
  }
}

module.exports = {
  MatchAdapter,
  estimateDurationMinutes,
  buildSearchStrings,
  toCandidate
}
