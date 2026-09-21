const Path = require('path')
const os = require('os')
const http = require('http')
const fs = require('../../../server/libs/fsExtra')
const { expect } = require('chai')

const { DownloadImportManager } = require('../../../server/downloadImport/DownloadImportManager')
const { DownloadImportStatus, WEBHOOK_EVENTS } = require('../../../server/downloadImport/constants')
const { checkSourceRemovable } = require('../../../server/downloadImport/qualifiers/index')
const QBittorrentQualifier = require('../../../server/downloadImport/qualifiers/QBittorrentQualifier')
const NZBGetQualifier = require('../../../server/downloadImport/qualifiers/NZBGetQualifier')
const DownloadImportWebhook = require('../../../server/downloadImport/WebhookNotifier')

/**
 * Stage 4: opt-in source cleanup (decision D4) and webhook notifications.
 * Client-side behavior is exercised against local mock servers only - never
 * against real qBittorrent/NZBGet/n8n infrastructure.
 */

let tempDirCounter = 0
async function makeTempSource() {
  const dir = Path.join(os.tmpdir(), `dl-import-stage4-${process.pid}-${tempDirCounter++}`)
  await fs.mkdirp(Path.join(dir, 'inner'))
  await fs.writeFile(Path.join(dir, 'inner', 'book.mp3'), 'x')
  return dir
}

/** Queue-model stand-in honoring the where clauses the manager sweeps with. */
function fakeQueueModel(rows = []) {
  return {
    rows,
    async findOne({ where }) {
      return rows.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) || null
    },
    async create(values) {
      const row = { cleanedUpAt: null, errorStage: null, errorReason: null, attempts: 0, save: async () => row, ...values }
      rows.push(row)
      return row
    },
    async findByPk(id) {
      return rows.find((row) => row.id === id) || null
    },
    async findAll({ where = {} } = {}) {
      return rows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value))
    }
  }
}

function recordingNotifier() {
  return {
    events: [],
    async send(event, queueItem) {
      this.events.push({ event, releaseName: queueItem.releaseName })
      return { delivered: true, skipped: false, error: null, status: 200 }
    }
  }
}

function makeManager(db, notifier) {
  return new DownloadImportManager({
    db,
    scanner: { scanPotentialNewLibraryItem: async () => ({ id: 'li_1' }) },
    matchAdapter: { match: async () => ({ status: 'matched' }), manualMatch: async () => ({ status: 'matched' }) },
    notifier
  })
}

/** Local mock of the qBittorrent Web API (login + torrents/info). */
function mockQBittorrent(torrents) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url.startsWith('/api/v2/auth/login')) {
        res.setHeader('Set-Cookie', 'SID=mock-session; path=/')
        res.end('Ok.')
        return
      }
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(typeof torrents === 'function' ? torrents() : torrents))
      })
    })
    // Never hold the mocha process open if a failing test skips close()
    server.unref()
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }))
  })
}

/** Local mock of the NZBGet JSON-RPC API. */
function mockNZBGet(history) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ result: typeof history === 'function' ? history() : history, error: null }))
      })
    })
    server.unref()
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }))
  })
}

/** Local capture server for webhook deliveries. */
function mockWebhookTarget(responseStatus = 200) {
  const received = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      received.push({ headers: req.headers, body: JSON.parse(body) })
      res.statusCode = responseStatus
      res.end('{}')
    })
  })
  server.unref()
  return {
    received,
    ready: new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

describe('Stage 4: source cleanup and webhook', () => {
  describe('cleanup is off by default and guarded', () => {
    it('never deletes the source when cleanup is disabled (default)', async () => {
      const sourcePath = await makeTempSource()
      const queueModel = fakeQueueModel()
      const manager = makeManager(
        { serverSettings: { downloadImportEnabled: true, downloadImportCleanupEnabled: false }, downloadImportQueueModel: queueModel },
        recordingNotifier()
      )
      const row = await queueModel.create({
        libraryId: 'lib_1',
        releaseName: 'Some Book',
        sourcePath,
        status: DownloadImportStatus.IMPORTED
      })

      const result = await manager.attemptSourceCleanup(row, { clientConfig: { type: 'qbittorrent', url: 'http://127.0.0.1:1' } })
      expect(result.removed).to.equal(false)
      expect(result.reason).to.equal('disabled')
      expect(await fs.pathExists(sourcePath)).to.equal(true)
      expect(row.cleanedUpAt).to.equal(null)
    })

    it('holds when the client reports the source not yet complete (no deletion)', async () => {
      const sourcePath = await makeTempSource()
      const { server, url } = await mockQBittorrent([
        { save_path: sourcePath, content_path: sourcePath, state: 'stalledUP', progress: 1, ratio: 0.2, seeding_time: 60 }
      ])
      const queueModel = fakeQueueModel()
      const manager = makeManager(
        { serverSettings: { downloadImportEnabled: true, downloadImportCleanupEnabled: true, downloadImportCleanupMinRatio: 0, downloadImportCleanupMinSeedHours: 0 }, downloadImportQueueModel: queueModel },
        recordingNotifier()
      )
      const row = await queueModel.create({
        libraryId: 'lib_1',
        releaseName: 'Some Book',
        sourcePath,
        status: DownloadImportStatus.IMPORTED
      })

      const result = await manager.attemptSourceCleanup(row, { clientConfig: { type: 'qbittorrent', url, username: 'u', password: 'p' } })
      expect(result.removed).to.equal(false)
      expect(result.reason).to.equal('seeding')
      expect(await fs.pathExists(sourcePath)).to.equal(true)
      expect(row.cleanedUpAt).to.equal(null)
      server.close()
    })

    it('removes the source only when the client confirms completion', async () => {
      const sourcePath = await makeTempSource()
      const destinationRoot = Path.join(os.tmpdir(), `dl-import-stage4-dst-${process.pid}-${tempDirCounter++}`)
      const destinationPath = Path.join(destinationRoot, 'Jordan, Robert', 'The Eye of the World')
      await fs.mkdirp(destinationPath)
      const { server, url } = await mockQBittorrent([
        { save_path: sourcePath, content_path: sourcePath, state: 'pausedUP', progress: 1, ratio: 0, seeding_time: 0 }
      ])
      const queueModel = fakeQueueModel()
      const manager = makeManager(
        { serverSettings: { downloadImportEnabled: true, downloadImportCleanupEnabled: true }, downloadImportQueueModel: queueModel },
        recordingNotifier()
      )
      const row = await queueModel.create({
        libraryId: 'lib_1',
        releaseName: 'Some Book',
        sourcePath,
        destinationPath,
        status: DownloadImportStatus.IMPORTED
      })

      const result = await manager.attemptSourceCleanup(row, { clientConfig: { type: 'qbittorrent', url, username: 'u', password: 'p' } })
      expect(result.reason, JSON.stringify(result)).to.equal('removed')
      expect(result.removed).to.equal(true)
      expect(await fs.pathExists(sourcePath)).to.equal(false)
      expect(await fs.pathExists(destinationPath)).to.equal(true)
      expect(row.cleanedUpAt).to.not.equal(null)
      server.close()
    })

    it('holds when no typed client is configured (filesystem-only roots never delete)', async () => {
      const sourcePath = await makeTempSource()
      const queueModel = fakeQueueModel()
      const manager = makeManager(
        { serverSettings: { downloadImportEnabled: true, downloadImportCleanupEnabled: true }, downloadImportQueueModel: queueModel },
        recordingNotifier()
      )
      const row = await queueModel.create({
        libraryId: 'lib_1',
        releaseName: 'Some Book',
        sourcePath,
        status: DownloadImportStatus.IMPORTED
      })

      const result = await manager.attemptSourceCleanup(row, {})
      expect(result.removed).to.equal(false)
      expect(result.reason).to.equal('no_client')
      expect(await fs.pathExists(sourcePath)).to.equal(true)
    })

    it('refuses when the source overlaps the import destination', async () => {
      const sourcePath = await makeTempSource()
      const queueModel = fakeQueueModel()
      const manager = makeManager(
        { serverSettings: { downloadImportEnabled: true, downloadImportCleanupEnabled: true }, downloadImportQueueModel: queueModel },
        recordingNotifier()
      )
      const row = await queueModel.create({
        libraryId: 'lib_1',
        releaseName: 'Some Book',
        sourcePath,
        destinationPath: Path.join(sourcePath, 'The Book'),
        status: DownloadImportStatus.IMPORTED
      })

      const result = await manager.attemptSourceCleanup(row, { clientConfig: { type: 'qbittorrent', url: 'http://127.0.0.1:1' } })
      expect(result.removed).to.equal(false)
      expect(result.reason).to.equal('unsafe_path')
      expect(await fs.pathExists(sourcePath)).to.equal(true)
    })

    it('sweep touches only imported rows without cleanup, confirming each individually', async () => {
      const removableSource = await makeTempSource()
      const untouchedSource = await makeTempSource()
      const { server, url } = await mockQBittorrent(() => [
        { save_path: removableSource, content_path: removableSource, state: 'pausedUP', progress: 1, ratio: 0, seeding_time: 0 },
        { save_path: untouchedSource, content_path: untouchedSource, state: 'stalledUP', progress: 1, ratio: 0.2, seeding_time: 60 }
      ])
      const queueModel = fakeQueueModel()
      const manager = makeManager(
        { serverSettings: { downloadImportEnabled: true, downloadImportCleanupEnabled: true }, downloadImportQueueModel: queueModel },
        recordingNotifier()
      )
      manager.enabledLibraries.set('lib_1', { clientConfig: { type: 'qbittorrent', url, username: 'u', password: 'p' } })

      const importedRow = await queueModel.create({ libraryId: 'lib_1', releaseName: 'Removable', sourcePath: removableSource, status: DownloadImportStatus.IMPORTED })
      const stillSeedingRow = await queueModel.create({ libraryId: 'lib_1', releaseName: 'Still Seeding', sourcePath: untouchedSource, status: DownloadImportStatus.IMPORTED })
      await queueModel.create({ libraryId: 'lib_1', releaseName: 'Detected', sourcePath: '/nonexistent', status: DownloadImportStatus.DETECTED })

      const sweep = await manager.runCleanupSweep()
      expect(sweep.checked).to.equal(2)
      expect(sweep.removed).to.equal(1)
      expect(await fs.pathExists(removableSource)).to.equal(false)
      expect(await fs.pathExists(untouchedSource)).to.equal(true)
      expect(importedRow.cleanedUpAt).to.not.equal(null)
      expect(stillSeedingRow.cleanedUpAt).to.equal(null)
      server.close()
    })
  })

  describe('qBittorrent seed-requirement gate (Web API)', () => {
    const qualifier = new QBittorrentQualifier()

    it('accepts seeding stopped per the client', async () => {
      const { server, url } = await mockQBittorrent([{ save_path: '/data/src', content_path: '/data/src', state: 'pausedUP', progress: 1 }])
      const result = await qualifier.isSourceRemovable({ dirPath: '/data/src', client: { url, username: 'u', password: 'p' } })
      expect(result.removable).to.equal(true)
      expect(result.reason).to.equal('seed_complete')
      server.close()
    })

    it('accepts the 5.x stopped state name', async () => {
      const { server, url } = await mockQBittorrent([{ save_path: '/data/src', content_path: '/data/src', state: 'stoppedUP', progress: 1 }])
      const result = await qualifier.isSourceRemovable({ dirPath: '/data/src', client: { url, username: 'u', password: 'p' } })
      expect(result.removable).to.equal(true)
      server.close()
    })

    it('accepts configured min-ratio thresholds', async () => {
      const { server, url } = await mockQBittorrent([{ save_path: '/data/src', content_path: '/data/src', state: 'stalledUP', progress: 1, ratio: 2.5, seeding_time: 60 }])
      const result = await qualifier.isSourceRemovable({ dirPath: '/data/src', client: { url, username: 'u', password: 'p' }, cleanup: { minRatio: 2 } })
      expect(result.removable).to.equal(true)
      server.close()
    })

    it('refuses while still seeding below thresholds', async () => {
      const { server, url } = await mockQBittorrent([{ save_path: '/data/src', content_path: '/data/src', state: 'stalledUP', progress: 1, ratio: 0.4, seeding_time: 1800 }])
      const result = await qualifier.isSourceRemovable({ dirPath: '/data/src', client: { url, username: 'u', password: 'p' }, cleanup: { minRatio: 1, minSeedHours: 1 } })
      expect(result.removable).to.equal(false)
      expect(result.reason).to.equal('seeding')
      server.close()
    })

    it('refuses an incomplete download even when seeding is stopped', async () => {
      const { server, url } = await mockQBittorrent([{ save_path: '/data/src', content_path: '/data/src', state: 'pausedUP', progress: 0.8 }])
      const result = await qualifier.isSourceRemovable({ dirPath: '/data/src', client: { url, username: 'u', password: 'p' } })
      expect(result.removable).to.equal(false)
      expect(result.reason).to.equal('incomplete')
      server.close()
    })

    it('refuses when the torrent cannot be found', async () => {
      const { server, url } = await mockQBittorrent([])
      const result = await qualifier.isSourceRemovable({ dirPath: '/data/src', client: { url, username: 'u', password: 'p' } })
      expect(result.removable).to.equal(false)
      expect(result.reason).to.equal('not_found')
      server.close()
    })

    it('checkSourceRemovable holds for unknown client types', async () => {
      const held = await checkSourceRemovable({ name: 'x', path: '/data/src' }, { type: 'unset' }, {})
      expect(held.removable).to.equal(false)
      expect(held.reason).to.equal('unknown_client')
      const noClient = await checkSourceRemovable({ name: 'x', path: '/data/src' }, null, {})
      expect(noClient.removable).to.equal(false)
      expect(noClient.reason).to.equal('no_client')
    })
  })

  describe('NZBGet history gate (Web API)', () => {
    const qualifier = new NZBGetQualifier()

    it('accepts a complete, par-clean history entry', async () => {
      const { server, url } = await mockNZBGet([{ NZBName: 'Some Book', DestDir: '/data/src', Status: 'SUCCESS', ParStatus: 'SUCCESS' }])
      const result = await qualifier.isSourceRemovable({ name: 'Some Book', dirPath: '/data/src', client: { url, username: 'u', password: 'p' } })
      expect(result.removable).to.equal(true)
      expect(result.reason).to.equal('complete_history')
      server.close()
    })

    it('refuses when no history entry exists (still queued or deleted)', async () => {
      const { server, url } = await mockNZBGet([])
      const result = await qualifier.isSourceRemovable({ name: 'Some Book', dirPath: '/data/src', client: { url, username: 'u', password: 'p' } })
      expect(result.removable).to.equal(false)
      expect(result.reason).to.equal('not_in_history')
      server.close()
    })

    it('refuses a history entry with failed par verification', async () => {
      const { server, url } = await mockNZBGet([{ NZBName: 'Some Book', DestDir: '/data/src', Status: 'SUCCESS', ParStatus: 'FAILURE' }])
      const result = await qualifier.isSourceRemovable({ name: 'Some Book', dirPath: '/data/src', client: { url, username: 'u', password: 'p' } })
      expect(result.removable).to.equal(false)
      expect(result.reason).to.equal('par_failed')
      server.close()
    })

    it('refuses a failed history status', async () => {
      const { server, url } = await mockNZBGet([{ NZBName: 'Some Book', DestDir: '/data/src', Status: 'FAILED', ParStatus: 'NONE' }])
      const result = await qualifier.isSourceRemovable({ name: 'Some Book', dirPath: '/data/src', client: { url, username: 'u', password: 'p' } })
      expect(result.removable).to.equal(false)
      expect(result.reason).to.equal('failed')
      server.close()
    })
  })

  describe('webhook notifications', () => {
    it('delivers import_success with the flat n8n-mappable payload', async () => {
      const target = mockWebhookTarget()
      const url = await target.ready
      const notifier = new DownloadImportWebhook({ db: { serverSettings: { downloadImportWebhookUrl: url } } })

      const result = await notifier.send(WEBHOOK_EVENTS.IMPORT_SUCCESS, {
        releaseName: 'The Eye of the World',
        libraryId: 'lib_1',
        status: 'imported',
        confidence: 0.96,
        sourcePath: '/downloads/eye',
        destinationPath: '/library/Jordan, Robert/The Eye of the World',
        parsedMetadata: { title: 'The Eye of the World', author: 'Robert Jordan' }
      })

      expect(result.delivered).to.equal(true)
      expect(target.received).to.have.lengthOf(1)
      expect(target.received[0].headers['content-type']).to.equal('application/json')
      const payload = target.received[0].body
      expect(payload.event).to.equal('import_success')
      expect(payload.source).to.equal('audiobookshelf-download-import')
      expect(payload.releaseName).to.equal('The Eye of the World')
      expect(payload.title).to.equal('The Eye of the World')
      expect(payload.author).to.equal('Robert Jordan')
      expect(payload.confidence).to.equal(0.96)
      await target.close()
    })

    it('delivers review-needed and failure events with error fields', async () => {
      const target = mockWebhookTarget()
      const url = await target.ready
      const notifier = new DownloadImportWebhook({ db: { serverSettings: { downloadImportWebhookUrl: url } } })

      await notifier.send(WEBHOOK_EVENTS.IMPORT_REVIEW_NEEDED, { releaseName: 'Low Confidence', status: 'match_review', confidence: 0.4 })
      await notifier.send(WEBHOOK_EVENTS.IMPORT_FAILURE, { releaseName: 'Broken', status: 'error', errorStage: 'match', errorReason: 'no candidates' })

      expect(target.received.map((r) => r.body.event)).to.deep.equal(['import_review_needed', 'import_failure'])
      expect(target.received[0].body.confidence).to.equal(0.4)
      expect(target.received[1].body.errorStage).to.equal('match')
      expect(target.received[1].body.errorReason).to.equal('no candidates')
      await target.close()
    })

    it('reports non-2xx delivery as failed without throwing', async () => {
      const target = mockWebhookTarget(500)
      const url = await target.ready
      const notifier = new DownloadImportWebhook({ db: { serverSettings: { downloadImportWebhookUrl: url } } })

      const result = await notifier.send(WEBHOOK_EVENTS.IMPORT_SUCCESS, { releaseName: 'X' })
      expect(result.delivered).to.equal(false)
      expect(result.error).to.equal('HTTP 500')
      expect(result.status).to.equal(500)
      await target.close()
    })

    it('skips entirely when no URL is configured and rejects unsupported schemes', async () => {
      const unset = new DownloadImportWebhook({ db: { serverSettings: {} } })
      const result = await unset.send(WEBHOOK_EVENTS.IMPORT_SUCCESS, { releaseName: 'X' })
      expect(result.skipped).to.equal(true)
      expect(result.delivered).to.equal(false)

      const bad = new DownloadImportWebhook({ db: { serverSettings: { downloadImportWebhookUrl: 'ftp://elsewhere' } } })
      const blocked = await bad.send(WEBHOOK_EVENTS.IMPORT_SUCCESS, { releaseName: 'X' })
      expect(blocked.skipped).to.equal(true)
      expect(blocked.error).to.equal(null)
    })

    it('rejects unknown event names without sending', async () => {
      const target = mockWebhookTarget()
      const url = await target.ready
      const notifier = new DownloadImportWebhook({ db: { serverSettings: { downloadImportWebhookUrl: url } } })

      const result = await notifier.send('import_afterparty', { releaseName: 'X' })
      expect(result.skipped).to.equal(true)
      expect(target.received).to.have.lengthOf(0)
      await target.close()
    })

    it('buildWebhookPayload is a pure, flat shape', () => {
      const payload = DownloadImportWebhook.buildWebhookPayload(
        WEBHOOK_EVENTS.IMPORT_SUCCESS,
        { releaseName: 'R', libraryId: 'lib_1', status: 'imported', parsedMetadata: { title: 'T', author: 'A' } },
        '2026-09-21T00:00:00.000Z'
      )
      expect(payload).to.deep.equal({
        event: 'import_success',
        timestamp: '2026-09-21T00:00:00.000Z',
        source: 'audiobookshelf-download-import',
        releaseName: 'R',
        title: 'T',
        author: 'A',
        libraryId: 'lib_1',
        status: 'imported',
        confidence: null,
        sourcePath: null,
        destinationPath: null,
        errorStage: null,
        errorReason: null
      })
    })
  })
})
