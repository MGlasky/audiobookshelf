const { expect } = require('chai')

const { computeFingerprint, resolveImportedResurface } = require('../../../server/downloadImport/suppression')

describe('downloadImport/suppression', () => {
  describe('computeFingerprint', () => {
    it('produces a stable sha256 hex digest', () => {
      const fingerprint = computeFingerprint('/downloads/Some Release')
      expect(fingerprint).to.match(/^[0-9a-f]{64}$/)
      expect(fingerprint).to.equal(computeFingerprint('/downloads/Some Release'))
    })

    it('distinguishes path-only rows from identified ones', () => {
      const pathOnly = computeFingerprint('/downloads/Some Release')
      expect(pathOnly).to.equal(computeFingerprint('/downloads/Some Release', null))
      expect(computeFingerprint('/downloads/Some Release', 'hash-a')).to.not.equal(pathOnly)
    })

    it('distinguishes different downloads at the same path and the same download at different paths', () => {
      expect(computeFingerprint('/downloads/Some Release', 'hash-a')).to.not.equal(computeFingerprint('/downloads/Some Release', 'hash-b'))
      expect(computeFingerprint('/downloads/Some Release', 'hash-a')).to.not.equal(computeFingerprint('/downloads/Other Release', 'hash-a'))
    })
  })

  describe('resolveImportedResurface', () => {
    const identity = (clientId) => ({ clientId, clientKind: clientId ? 'qbittorrent' : null })

    it('suppresses when neither the row nor the client has an identity', () => {
      expect(resolveImportedResurface(null, identity(null))).to.deep.equal({ action: 'suppress', upgraded: false })
    })

    it('suppresses when the client confirms the same download identity', () => {
      expect(resolveImportedResurface('hash-a', identity('hash-a'))).to.deep.equal({ action: 'suppress', upgraded: false })
    })

    it('suppresses and upgrades when the row never learned an identity', () => {
      expect(resolveImportedResurface(null, identity('hash-a'))).to.deep.equal({ action: 'suppress', upgraded: true })
    })

    it('suppresses conservatively when the client can no longer confirm the identity', () => {
      expect(resolveImportedResurface('hash-a', identity(null))).to.deep.equal({ action: 'suppress', upgraded: false })
    })

    it('reprocesses when the client confirms a different download at the same path', () => {
      expect(resolveImportedResurface('hash-a', identity('hash-b'))).to.deep.equal({ action: 'new-download' })
    })
  })
})
