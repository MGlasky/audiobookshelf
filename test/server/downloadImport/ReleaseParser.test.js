const { expect } = require('chai')
const { parseReleaseName, isValidASINFormat, extractASIN, extractNarrators, extractYear, extractSeriesParenthetical, stripQualityTokens } = require('../../../server/downloadImport/ReleaseParser')

describe('downloadImport/ReleaseParser', () => {
  describe('parseReleaseName', () => {
    it('parses "Author - Title"', () => {
      expect(parseReleaseName('Robert Jordan - The Eye of the World')).to.deep.equal({
        title: 'The Eye of the World',
        author: 'Robert Jordan',
        series: null,
        seriesSequence: null,
        asin: null,
        publishedYear: null,
        narrators: []
      })
    })

    it('treats the middle segment of a 3-part name as the series', () => {
      const parsed = parseReleaseName('Brandon Sanderson - Stormlight Archive - The Way of Kings')
      expect(parsed.author).to.equal('Brandon Sanderson')
      expect(parsed.series).to.equal('Stormlight Archive')
      expect(parsed.title).to.equal('The Way of Kings')
    })

    it('parses "Title by Author"', () => {
      const parsed = parseReleaseName('The Way of Kings by Brandon Sanderson')
      expect(parsed.title).to.equal('The Way of Kings')
      expect(parsed.author).to.equal('Brandon Sanderson')
    })

    it('does not split on multiple " by " separators', () => {
      const parsed = parseReleaseName('By Force of arms by the Sea by Someone')
      expect(parsed.author).to.be.null
      expect(parsed.title).to.equal('By Force of arms by the Sea by Someone')
    })

    it('extracts a parenthesized ASIN as an exact-match shortcut', () => {
      const parsed = parseReleaseName('Robert Jordan - The Eye of the World (B001ABCDEF)')
      expect(parsed.asin).to.equal('B001ABCDEF')
      expect(parsed.title).to.equal('The Eye of the World')
      expect(parsed.author).to.equal('Robert Jordan')
    })

    it('extracts an "ASIN: XXX" parenthetical', () => {
      const parsed = parseReleaseName('The Eye of the World (ASIN: B001ABCDEF)')
      expect(parsed.asin).to.equal('B001ABCDEF')
      expect(parsed.title).to.equal('The Eye of the World')
    })

    it('extracts trailing {Narrators} braces', () => {
      const parsed = parseReleaseName('Robert Jordan - The Eye of the World {Kate Reading, Michael Kramer}')
      expect(parsed.narrators).to.deep.equal(['Kate Reading', 'Michael Kramer'])
      expect(parsed.title).to.equal('The Eye of the World')
    })

    it('extracts a parenthesized year', () => {
      const parsed = parseReleaseName('Robert Jordan - The Eye of the World (1990)')
      expect(parsed.publishedYear).to.equal('1990')
      expect(parsed.title).to.equal('The Eye of the World')
    })

    it('extracts a bracketed year', () => {
      const parsed = parseReleaseName('The Eye of the World [1990]')
      expect(parsed.publishedYear).to.equal('1990')
    })

    it('parses "(Series, Book 2)" parenthetical series', () => {
      const parsed = parseReleaseName('Brandon Sanderson - The Way of Kings (The Stormlight Archive, Book 2)')
      expect(parsed.series).to.equal('The Stormlight Archive')
      expect(parsed.seriesSequence).to.equal('2')
      expect(parsed.title).to.equal('The Way of Kings')
      expect(parsed.author).to.equal('Brandon Sanderson')
    })

    it('parses "(Series Book 2)" without comma', () => {
      const parsed = parseReleaseName('The Way of Kings (The Stormlight Archive Book 2)')
      expect(parsed.series).to.equal('The Stormlight Archive')
      expect(parsed.seriesSequence).to.equal('2')
    })

    it('parses "(Series, Vol. 2)"', () => {
      const parsed = parseReleaseName('The Way of Kings (The Stormlight Archive, Vol. 2)')
      expect(parsed.series).to.equal('The Stormlight Archive')
      expect(parsed.seriesSequence).to.equal('2')
    })

    it('parses fractional sequences like 0.5', () => {
      const parsed = parseReleaseName('Novella (The Series, Book 0.5)')
      expect(parsed.seriesSequence).to.equal('0.5')
    })

    it('does not mistake a bare edition note for a series', () => {
      const parsed = parseReleaseName('The Way of Kings (Unabridged)')
      expect(parsed.series).to.be.null
      expect(parsed.title).to.equal('The Way of Kings')
    })

    it('strips quality tokens and formats', () => {
      const parsed = parseReleaseName('Robert Jordan - The Eye of the World (Audiobook) (Unabridged) 64kbps MP3')
      expect(parsed.title).to.equal('The Eye of the World')
      expect(parsed.author).to.equal('Robert Jordan')
    })

    it('combines multiple conventions in one name', () => {
      const parsed = parseReleaseName('Brandon Sanderson - The Way of Kings (The Stormlight Archive, Book 2) (2010) {Kate Reading, Michael Kramer} (B001ABCDEF) Unabridged')
      expect(parsed).to.deep.equal({
        title: 'The Way of Kings',
        author: 'Brandon Sanderson',
        series: 'The Stormlight Archive',
        seriesSequence: '2',
        asin: 'B001ABCDEF',
        publishedYear: '2010',
        narrators: ['Kate Reading', 'Michael Kramer']
      })
    })

    it('handles a bare title with nothing else', () => {
      const parsed = parseReleaseName('Some Release Name')
      expect(parsed.title).to.equal('Some Release Name')
      expect(parsed.author).to.be.null
      expect(parsed.series).to.be.null
    })

    it('returns an empty result for invalid input', () => {
      expect(parseReleaseName(null).title).to.equal('')
      expect(parseReleaseName('').title).to.equal('')
    })
  })

  describe('isValidASINFormat', () => {
    it('accepts 10-character alphanumeric ASINs', () => {
      expect(isValidASINFormat('B001ABCDEF')).to.be.true
      expect(isValidASINFormat('1234567890')).to.be.true
    })
    it('rejects wrong shapes', () => {
      expect(isValidASINFormat('B001ABCDE')).to.be.false
      expect(isValidASINFormat('B001ABCDEFG')).to.be.false
      expect(isValidASINFormat('B001ABCDEF '.trim())).to.be.true
      expect(isValidASINFormat('')).to.be.false
      expect(isValidASINFormat(null)).to.be.false
    })
  })

  describe('helpers', () => {
    it('extractASIN leaves non-ASIN parens alone', () => {
      const [remaining, asin] = extractASIN('The Title (Unabridged)')
      expect(asin).to.be.null
      expect(remaining).to.equal('The Title (Unabridged)')
    })

    it('extractYear only matches 4 digits', () => {
      const [remaining, year] = extractYear('The Title (19900)')
      expect(year).to.be.null
      expect(remaining).to.equal('The Title (19900)')
    })

    it('extractSeriesParenthetical requires a sequence', () => {
      const [remaining, series, sequence] = extractSeriesParenthetical('The Title (Just A Note)')
      expect(series).to.be.null
      expect(sequence).to.be.null
      expect(remaining).to.equal('The Title (Just A Note)')
    })

    it('stripQualityTokens removes standalone tokens but keeps real words', () => {
      expect(stripQualityTokens('The Word mp3 CD')).to.equal('The Word CD')
      expect(stripQualityTokens('Audiobook Unabridged 320kbps')).to.equal('')
    })
  })
})
