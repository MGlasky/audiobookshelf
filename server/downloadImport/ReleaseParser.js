/**
 * Release-name parser for the download-import engine.
 *
 * Parses a download folder name (e.g. from qBittorrent/NZBGet) into structured
 * release metadata: title, author, series, sequence, ASIN, year, narrators.
 *
 * This is intentionally conservative: it extracts what it is confident about
 * and leaves the rest to the matching stage. Anything unparsed stays part of
 * the title so BookFinder can still search on it.
 *
 * Supported conventions (each optional, documented in the tests):
 *  - "Author - Title" / "Author - Series - Title" (3+ segments: first = author, last = title)
 *  - "Title by Author"
 *  - "(ASIN)" or "(ASIN: B00XXXXXXXXX)" - exact-ASIN shortcut, same convention the
 *    scanner parses from folder names (getASIN in server/utils/scandir.js)
 *  - "{Narrators}" trailing braces
 *  - "(Year)" or "[Year]"
 *  - "(Series, Book 2)" / "(Series Book 2)" / "(Series, Vol. 2)" parenthetical series
 *  - Quality tokens (unabridged, abridged, audiobook, formats, bitrates) are stripped
 */

/**
 * Release names use parens or brackets for ASINs. Matching is case-insensitive
 * (release casing varies), so shape validation is strict to avoid false
 * positives on 10-letter words like "UNABRIDGED": real ASINs start with "B0"
 * or are ISBN-10 (9 digits + check digit).
 */
const ASIN_PATTERN = /[\[(](?:ASIN:?\s*)?([A-Z0-9]{10})[\])]/i

/** Trailing "{Narrators}" braces, mirroring scandir's getNarrator. */
const NARRATORS_PATTERN = /^(?<title>.*?)\s*\{(?<narrators>[^}]+)\}$/

/** "(1990)" or "[1990]" */
const YEAR_PATTERN = /[\[(](\d{4})[\])]/

/** "(The Stormlight Archive, Book 2)" / "(The Stormlight Archive, Vol. 2)" */
const SERIES_COMMA_PATTERN = /\((?<series>[^()]+?),\s*(?:(?:book|vol(?:ume)?\.?|episode)\s*)?#?(?<sequence>\d+(?:\.\d{1,2})?)\)$/i

/** "(The Stormlight Archive Book 2)" */
const SERIES_WORD_PATTERN = /\((?<series>[^()]+?)\s+(?:book|vol(?:ume)?\.?|episode)\s+#?(?<sequence>\d+(?:\.\d{1,2})?)\)$/i

/**
 * @typedef {Object} ReleaseInfo
 * @property {string} title
 * @property {string|null} author
 * @property {string|null} series
 * @property {string|null} seriesSequence
 * @property {string|null} asin Uppercased 10-character ASIN, when present
 * @property {string|null} publishedYear
 * @property {string[]} narrators
 */

/** Tokens that mark a bracketed group or standalone word as quality noise, not metadata. */
const QUALITY_TOKENS = ['audiobook', 'unabridged', 'abridged', 'mp3', 'm4b', 'm4a', 'flac', 'opus', 'ogg', 'aac', 'wav', 'nfo', 'epub']

/**
 * @param {string} asin
 * @returns {boolean}
 */
const isValidASINFormat = (asin) => {
  if (!asin || typeof asin !== 'string') return false
  if (!/^[A-Z0-9]{10}$/.test(asin)) return false
  // Guard against 10-letter words (matched case-insensitively) - real ASINs
  // start with "B0" or are ISBN-10 (9 digits + check digit)
  return asin.startsWith('B0') || /^\d{9}[\dX]$/.test(asin)
}

/**
 * Strip quality-noise bracketed groups and standalone tokens from a segment.
 * @param {string} segment
 * @returns {string}
 */
const stripQualityTokens = (segment) => {
  let cleaned = segment.replace(/\s*[\[(]([^\])]*)[\])]/g, (match, inner) => {
    const innerLower = String(inner).toLowerCase()
    return QUALITY_TOKENS.some((token) => innerLower.includes(token)) ? '' : match
  })

  for (const token of QUALITY_TOKENS) {
    cleaned = cleaned.replace(new RegExp(`\\s*\\b${token}\\b\\s*`, 'gi'), ' ')
  }

  // Bitrate noise, e.g. "64kbps" / "320 kbps"
  cleaned = cleaned.replace(/\s*\b\d+\s*kbps\b\s*/gi, ' ')

  return cleaned.replace(/\s{2,}/g, ' ').trim()
}

/**
 * Extract a parenthesized ASIN, e.g. "(B00IWRFP8Y)" or "(ASIN: B00IWRFP8Y)".
 * @param {string} name
 * @returns {[string, string|null]} [remaining, asin]
 */
const extractASIN = (name) => {
  const match = name.match(ASIN_PATTERN)
  if (!match) return [name, null]
  const asin = match[1].toUpperCase()
  if (!isValidASINFormat(asin)) return [name, null]
  return [name.replace(match[0], '').trim(), asin]
}

/**
 * Extract trailing "{Narrators}" braces.
 * @param {string} name
 * @returns {[string, string[]]} [remaining, narrators]
 */
const extractNarrators = (name) => {
  const match = name.match(NARRATORS_PATTERN)
  if (!match || !match.groups) return [name, []]
  const narrators = match.groups.narrators.split(',').map((n) => n.trim()).filter((n) => !!n)
  return [match.groups.title.trim(), narrators]
}

/**
 * Extract "(1990)" / "[1990]".
 * @param {string} name
 * @returns {[string, string|null]} [remaining, year]
 */
const extractYear = (name) => {
  const match = name.match(YEAR_PATTERN)
  if (!match) return [name, null]
  return [name.replace(match[0], '').trim(), match[1]]
}

/**
 * Extract a trailing parenthetical series group. Only matches when a sequence
 * is present ("(Series, Book 2)") so edition notes like "(Unabridged)" are
 * never mistaken for a series.
 *
 * @param {string} name
 * @returns {[string, string|null, string|null]} [remaining, series, sequence]
 */
const extractSeriesParenthetical = (name) => {
  for (const pattern of [SERIES_COMMA_PATTERN, SERIES_WORD_PATTERN]) {
    const match = name.match(pattern)
    if (match && match.groups) {
      return [name.replace(match[0], '').trim(), match.groups.series.trim(), match.groups.sequence]
    }
  }
  return [name, null, null]
}

/**
 * Split "Author - Title" style segments. First segment is the author when
 * there are at least two ' - ' separated segments; the last is the title;
 * a middle segment is treated as a series name (common "Author - Series - Title"
 * release layout).
 *
 * @param {string} name
 * @returns {{ author: string|null, series: string|null, title: string }}
 */
const splitSegments = (name) => {
  const segments = name.split(' - ').map((s) => s.trim()).filter((s) => !!s)
  if (segments.length === 1) {
    return { author: null, series: null, title: segments[0] }
  }
  if (segments.length === 2) {
    return { author: segments[0], series: null, title: segments[1] }
  }
  return { author: segments[0], series: segments.slice(1, -1).join(' - '), title: segments[segments.length - 1] }
}

/**
 * Parse "Title by Author" into its parts. Only applied when there is exactly
 * one " by " separator, to avoid mangling titles that contain " by ".
 * @param {string} name
 * @returns {{ author: string, title: string }|null}
 */
const splitByAuthor = (name) => {
  const lower = name.toLowerCase()
  const index = lower.indexOf(' by ')
  if (index === -1 || lower.indexOf(' by ', index + 1) !== -1) return null
  return {
    title: name.slice(0, index).trim(),
    author: name.slice(index + 4).trim()
  }
}

/**
 * Parse a download folder name into release metadata.
 *
 * Extractions that anchor to the end of the name (narrators, series, year)
 * can appear in any order, so they run in a loop until nothing matches.
 *
 * @param {string} releaseName
 * @returns {ReleaseInfo}
 */
const parseReleaseName = (releaseName) => {
  if (!releaseName || typeof releaseName !== 'string') {
    return { title: '', author: null, series: null, seriesSequence: null, asin: null, publishedYear: null, narrators: [] }
  }

  let remaining = releaseName.trim()
  let asin = null
  let narrators = []
  let series = null
  let seriesSequence = null
  let publishedYear = null

  let changed = true
  while (changed) {
    changed = false

    // Quality noise ("Unabridged", "(Audiobook)", "MP3"...) sits anywhere in the
    // name and would otherwise block the tail-anchored extractions below
    const stripped = stripQualityTokens(remaining)
    if (stripped !== remaining) {
      remaining = stripped
      changed = true
    }

    const narratorsResult = extractNarrators(remaining)
    if (narratorsResult[1].length) {
      remaining = narratorsResult[0]
      narrators = narratorsResult[1]
      changed = true
      continue
    }

    const yearResult = extractYear(remaining)
    if (yearResult[1] !== null && publishedYear === null) {
      remaining = yearResult[0]
      publishedYear = yearResult[1]
      changed = true
      continue
    }

    const seriesResult = extractSeriesParenthetical(remaining)
    if (seriesResult[1] !== null && series === null) {
      remaining = seriesResult[0]
      series = seriesResult[1]
      seriesSequence = seriesResult[2]
      changed = true
      continue
    }

    const asinResult = extractASIN(remaining)
    if (asinResult[1] !== null && asin === null) {
      remaining = asinResult[0]
      asin = asinResult[1]
      changed = true
      continue
    }
  }

  // "Title by Author" only when no ' - ' segments were available for an author
  const segments = splitSegments(remaining)
  let author = segments.author
  let title = segments.title
  if (!author) {
    const byAuthor = splitByAuthor(title)
    if (byAuthor) {
      title = byAuthor.title
      author = byAuthor.author
    }
  }

  if (!series) {
    series = segments.series
  }

  return {
    title: stripQualityTokens(title).trim(),
    author: author ? stripQualityTokens(author).trim() : null,
    series: series ? stripQualityTokens(series).trim() : null,
    seriesSequence,
    asin,
    publishedYear,
    narrators
  }
}

module.exports = {
  parseReleaseName,
  isValidASINFormat,
  stripQualityTokens,
  splitSegments,
  splitByAuthor,
  extractASIN,
  extractNarrators,
  extractYear,
  extractSeriesParenthetical
}
