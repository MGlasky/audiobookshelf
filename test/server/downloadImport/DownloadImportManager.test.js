const Path = require('path')
const os = require('os')
const fs = require('../../../server/libs/fsExtra')
const { expect } = require('chai')

const { DownloadImportManager, resolveFolder } = require('../../../server/downloadImport/DownloadImportManager')
const { DownloadImportStatus } = require('../../../server/downloadImport/constants')
const LibraryModel = require('../../../server/models/Library')

/**
 * In-memory DownloadImportQueue stand-in.
 */
function fakeQueueModel() {
  const rows = []
  let nextId = 1
  const hydrate = (values) => ({
    id: String(nextId++),
    libraryId: null,
    folderId: null,
    watchRoot: null,
    sourcePath: null,
    releaseName: null,
    status: DownloadImportStatus.DETECTED,
    parsedMetadata: null,
    matchData: null,
    confidence: null,
    destinationPath: null,
    importPlan: null,
    errorStage: null,
    errorReason: null,
    attempts: 0,
    ...values,
    save: async function () {
      return this
    }
  })
  return {
    rows,
    async findOne({ where }) {
      return rows.find((row) => row.libraryId === where.libraryId && row.sourcePath === where.sourcePath) || null
    },
    async create(values) {
      const row = hydrate(values)
      rows.push(row)
      return row
    },
    async findByPk(id) {
      return rows.find((row) => row.id === id) || null
    },
    async findAll() {
      return rows
    }
  }
}

/** Library-like object mirroring the model's settings getter. */
function fakeLibrary(overrides = {}) {
  const library = {
    id: 'lib_1',
    name: 'Audiobooks',
    mediaType: 'book',
    settings: null,
    libraryFolders: [{ id: 'folder_1', path: '/library/audiobooks' }],
    ...overrides
  }
  Object.defineProperty(library, 'librarySettings', {
    configurable: true,
    get() {
      return this.settings || LibraryModel.getDefaultLibrarySettingsForMediaType(this.mediaType)
    }
  })
  return library
}

function librarySettings(overrides = {}) {
  return {
    downloadImportEnabled: true,
    downloadImportWatchRoots: [],
    downloadImportTargetFolderId: null,
    downloadImportConfidenceThreshold: 0.8,
    downloadImportStabilityWindowMinutes: 0,
    // fast polling so the suite is not bound by the production cadence
    downloadImportStabilityPollMs: 10,
    downloadImportStabilityTimeoutMs: 1000,
    downloadImportAssumedBitrateKbps: 64,
    downloadImportClient: null,
    ...overrides
  }
}

function fakeDb(library) {
  return {
    serverSettings: { downloadImportEnabled: true },
    libraryModel: { findAll: async () => [library] },
    libraryFolderModel: {},
    downloadImportQueueModel: fakeQueueModel()
  }
}

/** Scanner stub capturing handoffs. */
function fakeScanner(returnValue = { id: 'li_1' }) {
  return {
    calls: [],
    async scanPotentialNewLibraryItem(libraryItemPath, library, folder, isSingleMediaItem) {
      this.calls.push({ libraryItemPath, library, folder, isSingleMediaItem })
      return returnValue
    }
  }
}

/** MatchAdapter stub with a scripted result. */
function fakeMatch(result) {
  return { match: async () => result, manualMatch: async () => result }
}

const matchedResult = (confidence = 0.95) => ({
  status: 'matched',
  confidence,
  candidates: [{ title: 'The Eye of the World', author: 'Robert Jordan', matchConfidence: confidence }],
  searchTitle: 'The Eye of the World',
  searchAuthor: 'Robert Jordan',
  provider: 'audible',
  manual: false
})

describe('downloadImport/DownloadImportManager', () => {
  let tmpRoot
  let watchRoot
  let sourceDir
  const openManagers = []

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(Path.join(os.tmpdir(), 'abs-manager-'))
    watchRoot = Path.join(tmpRoot, 'watch')
    sourceDir = Path.join(watchRoot, 'Robert Jordan - The Eye of the World')
    await fs.ensureDir(Path.join(sourceDir, 'subdir'))
    await fs.writeFile(Path.join(sourceDir, 'track01.mp3'), 'a'.repeat(1000))
    await fs.writeFile(Path.join(sourceDir, 'subdir', 'track02.m4b'), 'b'.repeat(500))
    await fs.writeFile(Path.join(sourceDir, 'cover.jpg'), 'c'.repeat(10))
  })

  afterEach(async () => {
    while (openManagers.length) openManagers.pop().watcher?.close()
    await fs.remove(tmpRoot)
  })

  describe('init', () => {
    it('is inert when the server flag is off', async () => {
      const manager = new DownloadImportManager({ db: { serverSettings: { downloadImportEnabled: false } } })
      await manager.init()
      expect(manager.enabledLibraries.size).to.equal(0)
      expect(manager.watcher).to.be.null
    })
  })

  describe('refreshFromLibraries', () => {
    it('loads only enabled libraries with roots and folders', async () => {
      const enabled = fakeLibrary({ settings: librarySettings({ downloadImportWatchRoots: [watchRoot], downloadImportConfidenceThreshold: 0.7 }) })
      const manager = new DownloadImportManager({ db: fakeDb(enabled) })
      await manager.refreshFromLibraries()

      expect(manager.enabledLibraries.size).to.equal(1)
      expect(manager.watchRoots).to.deep.equal([{ path: watchRoot, libraryId: 'lib_1' }])
      expect(manager.enabledLibraries.get('lib_1').threshold).to.equal(0.7)
      manager.watcher?.close()
    })

    it('skips disabled libraries', async () => {
      const disabled = fakeLibrary({ settings: null })
      const manager = new DownloadImportManager({ db: fakeDb(disabled) })
      await manager.refreshFromLibraries()
      expect(manager.enabledLibraries.size).to.equal(0)
    })
  })

  describe('handleWatchCandidate (happy path to imported)', () => {
    it('detects, qualifies, matches, imports, and hands off to the scanner', async () => {
      const library = fakeLibrary({
        settings: librarySettings({ downloadImportWatchRoots: [watchRoot], downloadImportTargetFolderId: 'folder_1' }),
        libraryFolders: [{ id: 'folder_1', path: Path.join(tmpRoot, 'library') }]
      })
      const scanner = fakeScanner()
      const manager = new DownloadImportManager({ db: fakeDb(library), scanner, matchAdapter: fakeMatch(matchedResult()) })
      openManagers.push(manager)
      await manager.refreshFromLibraries()

      const row = await manager.handleWatchCandidate(watchRoot, sourceDir)
      expect(row.status).to.equal(DownloadImportStatus.IMPORTED)
      expect(row.confidence).to.equal(0.95)
      expect(row.destinationPath).to.equal(Path.join(tmpRoot, 'library', 'Robert Jordan', 'The Eye of the World'))

      // files materialized, source preserved
      expect(await fs.pathExists(Path.join(row.destinationPath, 'track01.mp3'))).to.be.true
      expect(await fs.pathExists(Path.join(row.destinationPath, 'subdir', 'track02.m4b'))).to.be.true
      expect(await fs.pathExists(Path.join(sourceDir, 'track01.mp3'))).to.be.true

      // scanner handoff happened exactly once
      expect(scanner.calls).to.have.lengthOf(1)
      expect(scanner.calls[0].libraryItemPath).to.equal(row.destinationPath)
      expect(scanner.calls[0].isSingleMediaItem).to.be.false
    })
  })

  describe('null.audiobooksOnly landmine (regression)', () => {
    it('backfills null library settings before the scanner handoff', async () => {
      const library = fakeLibrary({
        settings: null,
        libraryFolders: [{ id: 'folder_1', path: Path.join(tmpRoot, 'library') }]
      })
      // The engine config reaches us through the librarySettings getter
      // (defaults are import-enabled for this test) while the raw .settings
      // column is null - exactly the shape that killed the first attempt.
      Object.defineProperty(library, 'librarySettings', {
        get: () => librarySettings({ downloadImportWatchRoots: [watchRoot] })
      })

      const scanner = fakeScanner()
      const manager = new DownloadImportManager({
        db: fakeDb(library),
        scanner,
        matchAdapter: fakeMatch(matchedResult())
      })
      openManagers.push(manager)
      await manager.refreshFromLibraries()

      const row = await manager.handleWatchCandidate(watchRoot, sourceDir)
      expect(row.status).to.equal(DownloadImportStatus.IMPORTED)

      // The scanner must never receive null settings
      expect(scanner.calls).to.have.lengthOf(1)
      const handedSettings = scanner.calls[0].library.settings
      expect(handedSettings).to.be.an('object')
      expect(handedSettings.audiobooksOnly).to.equal(false)
    })

    it('handOffToScanner backfills settings directly', async () => {
      const library = fakeLibrary()
      const scanner = fakeScanner()
      const manager = new DownloadImportManager({ db: fakeDb(library), scanner, matchAdapter: fakeMatch(matchedResult()) })
      const config = { library, targetFolderId: null }

      await manager.handOffToScanner('/library/audiobooks/x', config)
      expect(library.settings).to.be.an('object')
      expect(library.settings.audiobooksOnly).to.equal(false)
    })
  })

  describe('review routing', () => {
    function buildManager(matchResult, overrides = {}) {
      const library = fakeLibrary({ settings: librarySettings(overrides) })
      const scanner = fakeScanner()
      const manager = new DownloadImportManager({ db: fakeDb(library), scanner, matchAdapter: fakeMatch(matchResult) })
      openManagers.push(manager)
      return { manager, scanner }
    }

    it('routes low-confidence matches to match_review', async () => {
      const { manager, scanner } = buildManager(
        {
          status: 'needs_review',
          confidence: 0.4,
          candidates: [{ title: 'Close But No', author: 'A', matchConfidence: 0.4 }],
          searchTitle: 'The Eye of the World',
          searchAuthor: 'Robert Jordan',
          provider: 'audible',
          manual: false
        },
        { downloadImportWatchRoots: [watchRoot] }
      )
      await manager.refreshFromLibraries()

      const row = await manager.handleWatchCandidate(watchRoot, sourceDir)
      expect(row.status).to.equal(DownloadImportStatus.MATCH_REVIEW)
      expect(row.matchData.candidates[0].matchConfidence).to.equal(0.4)
      expect(scanner.calls).to.have.lengthOf(0)
    })

    it('skips directories with no supported audio', async () => {
      const dir = Path.join(watchRoot, 'Not A Book')
      await fs.ensureDir(dir)
      await fs.writeFile(Path.join(dir, 'sample.exe'), 'z')
      const { manager } = buildManager(matchedResult(), { downloadImportWatchRoots: [watchRoot] })
      await manager.refreshFromLibraries()

      const row = await manager.handleWatchCandidate(watchRoot, dir)
      expect(row.status).to.equal(DownloadImportStatus.SKIPPED)
      expect(row.errorStage).to.equal('filter')
    })

    it('ignores candidates when no library claims the root', async () => {
      const { manager } = buildManager(matchedResult())
      const row = await manager.handleWatchCandidate('/some/other/root', sourceDir)
      expect(row).to.be.null
    })
  })

  describe('dryRun', () => {
    it('returns the plan a real run would use, writing nothing', async () => {
      const library = fakeLibrary({
        settings: librarySettings({ downloadImportWatchRoots: [watchRoot] }),
        libraryFolders: [{ id: 'folder_1', path: Path.join(tmpRoot, 'library') }]
      })
      const scanner = fakeScanner()
      const manager = new DownloadImportManager({ db: fakeDb(library), scanner, matchAdapter: fakeMatch(matchedResult()) })
      openManagers.push(manager)
      await manager.refreshFromLibraries()

      const dry = await manager.dryRun(sourceDir, 'lib_1')
      expect(dry.releaseInfo.title).to.equal('The Eye of the World')
      expect(dry.releaseInfo.author).to.equal('Robert Jordan')
      expect(dry.plan.destinationPath).to.equal(Path.join(tmpRoot, 'library', 'Robert Jordan', 'The Eye of the World'))
      expect(dry.plan.files.map((f) => f.relativePath).sort()).to.deep.equal(['cover.jpg', 'subdir/track02.m4b', 'track01.mp3'])

      // nothing materialized, scanner untouched
      expect(await fs.pathExists(dry.plan.destinationPath)).to.be.false
      expect(scanner.calls).to.have.lengthOf(0)
    })
  })

  describe('resolveFolder', () => {
    it('prefers the explicit folder id', () => {
      const library = {
        libraryFolders: [
          { id: 'f1', path: '/library/a' },
          { id: 'f2', path: '/library/b' }
        ]
      }
      expect(resolveFolder(library, '/library/b/x', 'f2').id).to.equal('f2')
    })

    it('falls back to the containing folder, then the first folder', () => {
      const library = {
        libraryFolders: [
          { id: 'f1', path: '/library/a' },
          { id: 'f2', path: '/library/b' }
        ]
      }
      expect(resolveFolder(library, '/library/b/x').id).to.equal('f2')
      expect(resolveFolder(library, '/elsewhere/x').id).to.equal('f1')
      expect(resolveFolder({ libraryFolders: [] }, '/x')).to.be.null
    })
  })

  describe('dismiss and retry', () => {
    it('dismisses a review item as skipped', async () => {
      const library = fakeLibrary({ settings: librarySettings() })
      const manager = new DownloadImportManager({ db: fakeDb(library), matchAdapter: fakeMatch(matchedResult()) })

      const row = await manager.db.downloadImportQueueModel.create({
        libraryId: 'lib_1',
        sourcePath: '/x',
        releaseName: 'x',
        status: DownloadImportStatus.MATCH_REVIEW
      })
      const dismissed = await manager.dismiss(row.id)
      expect(dismissed.status).to.equal(DownloadImportStatus.SKIPPED)
      expect(dismissed.errorStage).to.equal('dismissed')
    })

    it('refuses to dismiss an imported item', async () => {
      const library = fakeLibrary()
      const manager = new DownloadImportManager({ db: fakeDb(library), matchAdapter: fakeMatch(matchedResult()) })
      const row = await manager.db.downloadImportQueueModel.create({
        libraryId: 'lib_1',
        sourcePath: '/x',
        releaseName: 'x',
        status: DownloadImportStatus.IMPORTED
      })
      try {
        await manager.dismiss(row.id)
        throw new Error('should have thrown')
      } catch (error) {
        expect(error.message).to.match(/already imported/)
      }
    })
  })
})
