const Path = require('path')
const os = require('os')
const fs = require('../../../server/libs/fsExtra')
const { expect } = require('chai')

const { DownloadImportManager } = require('../../../server/downloadImport/DownloadImportManager')
const { DownloadImportStatus } = require('../../../server/downloadImport/constants')

/**
 * Stage-3 queue-surface behaviors: restart recovery (every transient state
 * keeps a defined exit across a server restart) and Match review refine
 * search (candidates refresh without importing).
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
    async findAll({ where } = {}) {
      if (!where?.status) return rows
      const statuses = Array.isArray(where.status) ? where.status : [where.status]
      return rows.filter((row) => statuses.includes(row.status))
    }
  }
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

function fakeDb(library, queueModel) {
  return {
    serverSettings: { downloadImportEnabled: true },
    libraryModel: { findAll: async () => [library] },
    libraryFolderModel: {},
    downloadImportQueueModel: queueModel
  }
}

/** MatchAdapter stub with a scripted refine-search result (echoes strings like the real adapter). */
function fakeMatchAdapter() {
  return {
    search: async (payload) => ({
      status: 'needs_review',
      confidence: 0.42,
      candidates: [
        { title: 'Refined Title', author: 'Refined Author', asin: 'B0REFINED0', publishedYear: '2020', cover: null, durationMinutes: 600, matchConfidence: 0.42 }
      ],
      searchTitle: payload.title,
      searchAuthor: payload.author,
      provider: 'audible',
      manual: true
    })
  }
}

/**
 * Manager wired to the fake db with processQueueItem stubbed out - recovery
 * tests only need to observe which rows re-enter the pipeline, not run it.
 */
function managerWithStubbedPipeline(db, library) {
  const manager = new DownloadImportManager({ db, matchAdapter: fakeMatchAdapter() })
  manager.enabledLibraries.set(library.id, { library, roots: library.librarySettings.downloadImportWatchRoots })

  const processed = []
  manager.processQueueItem = async (queueItem) => {
    processed.push(queueItem)
    return queueItem
  }
  manager.processed = processed
  return manager
}

describe('downloadImport/queue surface', () => {
  let tmpRoot
  let watchRoot
  const openManagers = []

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(Path.join(os.tmpdir(), 'abs-queue-surface-'))
    watchRoot = Path.join(tmpRoot, 'watch')
    await fs.ensureDir(watchRoot)
  })

  afterEach(async () => {
    while (openManagers.length) openManagers.pop().watcher?.close()
    await fs.remove(tmpRoot)
  })

  /** Library watching the tmp watchRoot, queue model seeded with rows. */
  function setupQueue(rows) {
    const library = {
      id: 'lib_1',
      name: 'Audiobooks',
      mediaType: 'book',
      libraryFolders: [{ id: 'folder_1', path: Path.join(tmpRoot, 'library') }]
    }
    library.settings = librarySettings({ downloadImportWatchRoots: [watchRoot] })
    Object.defineProperty(library, 'librarySettings', {
      get() {
        return library.settings
      }
    })

    const queueModel = fakeQueueModel()
    for (const values of rows) {
      queueModel.create({
        libraryId: 'lib_1',
        watchRoot,
        ...values
      })
    }

    const manager = managerWithStubbedPipeline(fakeDb(library, queueModel), library)
    openManagers.push(manager)
    return { manager, queueModel, rows: queueModel.rows }
  }

  describe('restart recovery', () => {
    it('re-enters transient rows into the pipeline on init', async () => {
      const transientStatuses = [
        DownloadImportStatus.DETECTED,
        DownloadImportStatus.QUALIFYING,
        DownloadImportStatus.IDENTIFYING,
        DownloadImportStatus.NORMALIZING,
        DownloadImportStatus.IMPORTING
      ]
      const { manager } = setupQueue(transientStatuses.map((status, i) => ({ sourcePath: Path.join(watchRoot, `transient-${i}`), releaseName: `transient-${i}`, status })))

      await manager.init()

      expect(manager.processed.map((row) => row.status)).to.have.members(transientStatuses)
    })

    it('leaves match review and terminal rows for the user or history', async () => {
      const { manager } = setupQueue([
        { sourcePath: Path.join(watchRoot, 'review-row'), releaseName: 'review-row', status: DownloadImportStatus.MATCH_REVIEW },
        { sourcePath: Path.join(watchRoot, 'imported-row'), releaseName: 'imported-row', status: DownloadImportStatus.IMPORTED },
        { sourcePath: Path.join(watchRoot, 'error-row'), releaseName: 'error-row', status: DownloadImportStatus.ERROR },
        { sourcePath: Path.join(watchRoot, 'parked-row'), releaseName: 'parked-row', status: DownloadImportStatus.PARKED },
        { sourcePath: Path.join(watchRoot, 'skipped-row'), releaseName: 'skipped-row', status: DownloadImportStatus.SKIPPED }
      ])

      await manager.init()

      expect(manager.processed).to.have.lengthOf(0)
    })

    it('does not recover when the engine flag is off', async () => {
      const { manager } = setupQueue([{ sourcePath: Path.join(watchRoot, 'qualifying-row'), releaseName: 'qualifying-row', status: DownloadImportStatus.QUALIFYING }])
      manager.db.serverSettings.downloadImportEnabled = false

      await manager.init()

      expect(manager.processed).to.have.lengthOf(0)
    })

    it('skips rows whose library is no longer configured for import', async () => {
      // Row points at a library the manager has no config for (config exists for lib_1 only)
      const { manager } = setupQueue([{ libraryId: 'lib_gone', sourcePath: Path.join(watchRoot, 'orphan-row'), releaseName: 'orphan-row', status: DownloadImportStatus.QUALIFYING }])

      await manager.init()

      expect(manager.processed).to.have.lengthOf(0)
    })
  })

  describe('refine search', () => {
    it('refreshes candidates and parks the row in Match review without importing', async () => {
      const { manager, rows } = setupQueue([{ sourcePath: Path.join(watchRoot, 'low-conf'), releaseName: 'low-conf', status: DownloadImportStatus.ERROR, errorStage: 'qualify', errorReason: 'never mind' }])

      const emitted = []
      manager.onQueueChange = (queueItem) => emitted.push(queueItem)

      const updated = await manager.searchQueueItem(rows[0].id, { title: 'better title', author: 'better author' })

      expect(updated.status).to.equal(DownloadImportStatus.MATCH_REVIEW)
      expect(updated.matchData.candidates).to.have.lengthOf(1)
      expect(updated.matchData.searchTitle).to.equal('better title')
      expect(updated.matchData.searchAuthor).to.equal('better author')
      expect(updated.matchData.manual).to.equal(true)
      expect(emitted).to.have.lengthOf(1)
      expect(emitted[0].id).to.equal(rows[0].id)
    })

    it('keeps an existing Match review row in Match review', async () => {
      const { manager, rows } = setupQueue([{ sourcePath: Path.join(watchRoot, 'review-row'), releaseName: 'review-row', status: DownloadImportStatus.MATCH_REVIEW }])

      const updated = await manager.searchQueueItem(rows[0].id, { title: 'again' })

      expect(updated.status).to.equal(DownloadImportStatus.MATCH_REVIEW)
    })

    it('refuses to search without any search strings', async () => {
      const { manager, rows } = setupQueue([{ sourcePath: Path.join(watchRoot, 'review-row'), releaseName: 'review-row', status: DownloadImportStatus.MATCH_REVIEW }])

      let error = null
      try {
        await manager.searchQueueItem(rows[0].id, { title: '', author: '' })
      } catch (err) {
        error = err
      }

      expect(error?.message).to.equal('Provide a title or author to search')
      expect(rows[0].status).to.equal(DownloadImportStatus.MATCH_REVIEW)
    })

    it('throws when the library is no longer configured for import', async () => {
      const { manager, rows } = setupQueue([{ sourcePath: Path.join(watchRoot, 'review-row'), releaseName: 'review-row', status: DownloadImportStatus.MATCH_REVIEW }])
      manager.enabledLibraries.clear()

      let error = null
      try {
        await manager.searchQueueItem(rows[0].id, { title: 'something' })
      } catch (err) {
        error = err
      }

      expect(error?.message).to.equal('Library is no longer configured for download import')
    })
  })
})
