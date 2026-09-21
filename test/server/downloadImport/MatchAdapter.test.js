const { expect } = require('chai')

const { MatchAdapter, estimateDurationMinutes, buildSearchStrings, toCandidate } = require('../../../server/downloadImport/MatchAdapter')
const { parseReleaseName } = require('../../../server/downloadImport/ReleaseParser')

/**
 * @param {Object} books books to return from search()
 * @param {Error|null} [throwError]
 */
function stubBookFinder(books, throwError = null) {
  return {
    calls: [],
    async search(libraryItem, provider, title, author, isbn, asin, options) {
      this.calls.push({ libraryItem, provider, title, author, isbn, asin, options })
      if (throwError) throw throwError
      return books
    }
  }
}

describe('downloadImport/MatchAdapter', () => {
  describe('estimateDurationMinutes', () => {
    it('converts bytes and bitrate to minutes', () => {
      // 38400000 bytes * 8 / 64000 bits-per-second = 4800s = 80 min
      expect(estimateDurationMinutes(38400000, 64)).to.equal(80)
    })
    it('returns null for missing inputs', () => {
      expect(estimateDurationMinutes(0, 64)).to.be.null
      expect(estimateDurationMinutes(1000, 0)).to.be.null
      expect(estimateDurationMinutes(null, 64)).to.be.null
    })
  })

  describe('buildSearchStrings', () => {
    it('uses the ASIN as the search title when present and valid', () => {
      const release = parseReleaseName('Robert Jordan - The Eye of the World (B001ABCDEF)')
      const { searchTitle, searchAuthor } = buildSearchStrings(release)
      expect(searchTitle).to.equal('B001ABCDEF')
      expect(searchAuthor).to.equal('Robert Jordan')
    })

    it('falls back to the parsed title', () => {
      const { searchTitle } = buildSearchStrings(parseReleaseName('The Eye of the World'))
      expect(searchTitle).to.equal('The Eye of the World')
    })
  })

  describe('toCandidate', () => {
    it('normalizes BookFinder result fields', () => {
      const candidate = toCandidate({ title: 'T', author: 'A', asin: 'B001ABCDEF', duration: 600, matchConfidence: 0.9, extra: 'dropped' })
      expect(candidate).to.deep.equal({
        title: 'T',
        author: 'A',
        asin: 'B001ABCDEF',
        publishedYear: null,
        cover: null,
        durationMinutes: 600,
        matchConfidence: 0.9
      })
    })
  })

  describe('match', () => {
    it('returns no_matches without a searchable title', async () => {
      const adapter = new MatchAdapter(stubBookFinder([]))
      const result = await adapter.match({ title: '', author: null, asin: null })
      expect(result.status).to.equal('no_matches')
    })

    it('auto-matches when the best candidate clears the threshold', async () => {
      const finder = stubBookFinder([
        { title: 'The Way of Kings', author: 'Brandon Sanderson', matchConfidence: 0.92 },
        { title: 'Other Book', author: 'Someone', matchConfidence: 0.5 }
      ])
      const adapter = new MatchAdapter(finder)
      const result = await adapter.match(parseReleaseName('Brandon Sanderson - The Way of Kings'), { threshold: 0.8 })

      expect(result.status).to.equal('matched')
      expect(result.confidence).to.equal(0.92)
      expect(result.candidates).to.have.lengthOf(2)
      expect(result.candidates[0].title).to.equal('The Way of Kings')
      expect(result.manual).to.be.false
    })

    it('routes below-threshold matches to needs_review', async () => {
      const finder = stubBookFinder([{ title: 'Sort of Close', author: 'A', matchConfidence: 0.61 }])
      const adapter = new MatchAdapter(finder)
      const result = await adapter.match(parseReleaseName('Brandon Sanderson - The Way of Kings'), { threshold: 0.8 })
      expect(result.status).to.equal('needs_review')
      expect(result.confidence).to.equal(0.61)
    })

    it('treats unscored candidates as needs_review, not matched', async () => {
      const finder = stubBookFinder([{ title: 'No Score', author: 'A' }])
      const adapter = new MatchAdapter(finder)
      const result = await adapter.match(parseReleaseName('Some Title'), { threshold: 0.8 })
      expect(result.status).to.equal('needs_review')
      expect(result.confidence).to.be.null
      expect(result.candidates).to.have.lengthOf(1)
    })

    it('returns no_matches when BookFinder finds nothing', async () => {
      const adapter = new MatchAdapter(stubBookFinder([]))
      const result = await adapter.match(parseReleaseName('Obscure Book XYZ'))
      expect(result.status).to.equal('no_matches')
    })

    it('survives a BookFinder throw as no_matches', async () => {
      const adapter = new MatchAdapter(stubBookFinder([], new Error('network down')))
      const result = await adapter.match(parseReleaseName('Some Title'))
      expect(result.status).to.equal('no_matches')
    })

    it('passes the exact-ASIN title to BookFinder and a duration stub when estimating', async () => {
      const finder = stubBookFinder([{ title: 'The Eye of the World', author: 'Robert Jordan', matchConfidence: 1.0 }])
      const adapter = new MatchAdapter(finder)
      const release = parseReleaseName('Robert Jordan - The Eye of the World (B001ABCDEF)')
      const result = await adapter.match(release, { durationMinutes: 60, threshold: 0.8 })

      expect(result.status).to.equal('matched')
      expect(finder.calls).to.have.lengthOf(1)
      expect(finder.calls[0].title).to.equal('B001ABCDEF')
      expect(finder.calls[0].asin).to.equal('B001ABCDEF')
      expect(finder.calls[0].libraryItem).to.deep.equal({ media: { duration: 3600 } })
    })
  })

  describe('manualMatch', () => {
    it('marks an explicit candidate pick as matched and manual', async () => {
      const adapter = new MatchAdapter(stubBookFinder([]))
      const result = await adapter.manualMatch({ candidate: { title: 'Picked', author: 'A', matchConfidence: 0.4 } })
      expect(result.status).to.equal('matched')
      expect(result.manual).to.be.true
      expect(result.candidates[0].matchConfidence).to.equal(0.4)
    })

    it('boosts a manual candidate without a score to 1.0', async () => {
      const adapter = new MatchAdapter(stubBookFinder([]))
      const result = await adapter.manualMatch({ candidate: { title: 'Picked', author: 'A' } })
      expect(result.candidates[0].matchConfidence).to.equal(1.0)
    })

    it('rejects an invalid manual ASIN', async () => {
      const adapter = new MatchAdapter(stubBookFinder([]))
      const result = await adapter.manualMatch({ asin: 'not-an-asin' })
      expect(result.status).to.equal('no_matches')
    })

    it('looks up a valid manual ASIN through BookFinder', async () => {
      const finder = stubBookFinder([{ title: 'The Eye of the World', author: 'Robert Jordan' }])
      const adapter = new MatchAdapter(finder)
      const result = await adapter.manualMatch({ asin: 'b001abcdef' })
      expect(result.status).to.equal('matched')
      expect(result.confidence).to.equal(1.0)
      expect(finder.calls[0].title).to.equal('B001ABCDEF')
    })
  })
})
