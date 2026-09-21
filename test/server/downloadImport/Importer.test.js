const Path = require('path')
const os = require('os')
const fs = require('../../../server/libs/fsExtra')
const { expect } = require('chai')

const {
  sanitizeFolderName,
  buildDestinationSegments,
  buildImportPlan,
  executeImport,
  isImportableFile,
  listImportableFiles
} = require('../../../server/downloadImport/Importer')
const { parseReleaseName } = require('../../../server/downloadImport/ReleaseParser')

describe('downloadImport/Importer', () => {
  let tmpRoot
  let sourceDir
  let libraryRoot

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(Path.join(os.tmpdir(), 'abs-importer-'))
    sourceDir = Path.join(tmpRoot, 'source')
    libraryRoot = Path.join(tmpRoot, 'library')
    await fs.ensureDir(sourceDir)
    await fs.ensureDir(libraryRoot)
  })

  afterEach(async () => {
    await fs.remove(tmpRoot)
  })

  describe('sanitizeFolderName', () => {
    it('strips filesystem-illegal characters', () => {
      expect(sanitizeFolderName('Book: The? Sequel*')).to.equal('Book The Sequel')
    })
    it('collapses whitespace and trims trailing dots', () => {
      expect(sanitizeFolderName('  Name   .  ')).to.equal('Name')
    })
    it('returns empty for empty input', () => {
      expect(sanitizeFolderName('')).to.equal('')
      expect(sanitizeFolderName(null)).to.equal('')
    })
  })

  describe('buildDestinationSegments (D2 layout)', () => {
    it('uses Author/Series/Title when a series is detected', () => {
      const release = parseReleaseName('Brandon Sanderson - The Way of Kings (The Stormlight Archive, Book 1)')
      expect(release.series).to.equal('The Stormlight Archive')
      expect(buildDestinationSegments(release)).to.deep.equal(['Brandon Sanderson', 'The Stormlight Archive', 'The Way of Kings'])
    })

    it('falls back to Author/Title when no series exists', () => {
      const release = parseReleaseName('Robert Jordan - The Eye of the World')
      expect(buildDestinationSegments(release)).to.deep.equal(['Robert Jordan', 'The Eye of the World'])
    })

    it('degrades a missing author to Unknown Author', () => {
      const release = parseReleaseName('Some Title Only')
      expect(buildDestinationSegments(release)).to.deep.equal(['Unknown Author', 'Some Title Only'])
    })

    it('sanitizes each segment', () => {
      const segments = buildDestinationSegments({ title: 'Title: Part 1', author: 'Author/X', series: null })
      expect(segments).to.deep.equal(['Author X', 'Title Part 1'])
    })
  })

  describe('isImportableFile / listImportableFiles', () => {
    it('accepts supported audio and companion types, rejects unknowns', () => {
      expect(isImportableFile('book.m4b')).to.be.true
      expect(isImportableFile('track.mp3')).to.be.true
      expect(isImportableFile('cover.jpg')).to.be.true
      expect(isImportableFile('metadata.xml')).to.be.true
      expect(isImportableFile('notes.txt')).to.be.true
      expect(isImportableFile('virus.exe')).to.be.false
      expect(isImportableFile('noext')).to.be.false
    })

    it('collects importable files recursively and skips symlinks', async () => {
      await fs.ensureDir(Path.join(sourceDir, 'subdir'))
      await fs.writeFile(Path.join(sourceDir, 'track01.mp3'), 'x'.repeat(10))
      await fs.writeFile(Path.join(sourceDir, 'subdir', 'track02.m4b'), 'y'.repeat(20))
      await fs.writeFile(Path.join(sourceDir, 'cover.jpg'), 'c'.repeat(5))
      await fs.writeFile(Path.join(sourceDir, 'junk.exe'), 'z')
      await fs.symlink(Path.join(sourceDir, 'track01.mp3'), Path.join(sourceDir, 'link.mp3'))

      const files = await listImportableFiles(sourceDir)
      const relativePaths = files.map((f) => f.relativePath).sort()
      expect(relativePaths).to.deep.equal(['cover.jpg', 'subdir/track02.m4b', 'track01.mp3'])
      expect(files.find((f) => f.relativePath === 'track01.mp3').sizeBytes).to.equal(10)
    })
  })

  describe('buildImportPlan + executeImport', () => {
    const releaseName = 'Robert Jordan - The Eye of the World'

    it('hardlinks on the same filesystem and preserves the source', async () => {
      await fs.writeFile(Path.join(sourceDir, 'track01.mp3'), 'a'.repeat(1000))
      await fs.writeFile(Path.join(sourceDir, 'cover.jpg'), 'c'.repeat(50))

      const release = parseReleaseName(releaseName)
      const plan = await buildImportPlan(sourceDir, libraryRoot, release)
      expect(plan.mode).to.equal('hardlink')
      expect(plan.sameFilesystem).to.be.true
      expect(plan.destinationPath).to.equal(Path.join(libraryRoot, 'Robert Jordan', 'The Eye of the World'))

      const result = await executeImport(plan)
      expect(result.success).to.be.true
      expect(result.verified).to.be.true
      expect(result.importedFiles).to.equal(2)

      // inode-preserving hardlink
      const [sourceStat, destStat] = await Promise.all([
        fs.stat(Path.join(sourceDir, 'track01.mp3')),
        fs.stat(Path.join(plan.destinationPath, 'track01.mp3'))
      ])
      expect(destStat.ino).to.equal(sourceStat.ino)
      expect(destStat.nlink).to.be.at.least(2)

      // sources untouched
      expect(await fs.pathExists(Path.join(sourceDir, 'track01.mp3'))).to.be.true
    })

    it('copies when forced and verifies by size', async () => {
      await fs.writeFile(Path.join(sourceDir, 'track01.mp3'), 'a'.repeat(1000))

      const release = parseReleaseName(releaseName)
      const plan = await buildImportPlan(sourceDir, libraryRoot, release, { forceMode: 'copy' })
      expect(plan.mode).to.equal('copy')

      const result = await executeImport(plan)
      expect(result.success).to.be.true
      expect(result.verified).to.be.true

      const [sourceStat, destStat] = await Promise.all([
        fs.stat(Path.join(sourceDir, 'track01.mp3')),
        fs.stat(Path.join(plan.destinationPath, 'track01.mp3'))
      ])
      expect(destStat.size).to.equal(sourceStat.size)
      expect(destStat.ino).to.not.equal(sourceStat.ino)
      expect(await fs.pathExists(Path.join(sourceDir, 'track01.mp3'))).to.be.true
    })

    it('is idempotent on re-run (overwrites its own destination)', async () => {
      await fs.writeFile(Path.join(sourceDir, 'track01.mp3'), 'a'.repeat(1000))
      const release = parseReleaseName(releaseName)

      const firstPlan = await buildImportPlan(sourceDir, libraryRoot, release)
      const first = await executeImport(firstPlan)
      expect(first.success).to.be.true

      const secondPlan = await buildImportPlan(sourceDir, libraryRoot, release)
      const second = await executeImport(secondPlan)
      expect(second.success).to.be.true
      expect(second.importedFiles).to.equal(1)
    })

    it('fails cleanly when the source has no importable files', async () => {
      await fs.writeFile(Path.join(sourceDir, 'readme.exe'), 'z')
      const release = parseReleaseName(releaseName)

      const plan = await buildImportPlan(sourceDir, libraryRoot, release)
      const result = await executeImport(plan)
      expect(result.success).to.be.false
      expect(result.error).to.match(/No importable files/)
      // nothing was created in the library
      const segment = Path.join(libraryRoot, 'Robert Jordan')
      expect(await fs.pathExists(segment)).to.be.false
    })
  })
})
