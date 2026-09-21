const { expect } = require('chai')
const os = require('os')
const Path = require('path')
const fs = require('node:fs/promises')

const { DownloadWatcher, snapshotDirectory, snapshotsAreEqual, waitForDirectoryStability } = require('../../../server/downloadImport/DownloadWatcher')
const { isQualifierType, qualifyCandidate } = require('../../../server/downloadImport/qualifiers')
const { QBittorrentQualifier, normalizePathForCompare } = require('../../../server/downloadImport/qualifiers/QBittorrentQualifier')
const NZBGetQualifier = require('../../../server/downloadImport/qualifiers/NZBGetQualifier')

describe('downloadImport/DownloadWatcher', () => {
  describe('resolveCandidate', () => {
    const root = { path: '/downloads', libraryId: 'lib_1' }
    const watcher = new DownloadWatcher()

    it('maps nested events to the immediate child directory', () => {
      const candidate = watcher.resolveCandidate(root, '/downloads/Some Release/CD01/file.mp3')
      expect(candidate).to.deep.equal({ dirPath: '/downloads/Some Release', releaseName: 'Some Release' })
    })

    it('maps a direct child event to itself', () => {
      const candidate = watcher.resolveCandidate(root, '/downloads/Some Release')
      expect(candidate?.releaseName).to.equal('Some Release')
    })

    it('ignores events for the root itself', () => {
      expect(watcher.resolveCandidate(root, '/downloads')).to.be.null
    })

    it('ignores events outside the root', () => {
      expect(watcher.resolveCandidate(root, '/elsewhere/Some Release')).to.be.null
    })

    it('ignores dotfile candidates', () => {
      expect(watcher.resolveCandidate(root, '/downloads/.hidden/file.mp3')).to.be.null
    })
  })

  describe('event batching', () => {
    it('collapses many events for the same directory into one detection', async () => {
      const watcher = new DownloadWatcher()
      watcher.pendingDelay = 20
      const root = { path: '/downloads', libraryId: 'lib_1' }

      const detections = []
      watcher.on('detected', (detection) => detections.push(detection))

      watcher.onWatchEvent(root, '/downloads/Some Release/file1.mp3')
      watcher.onWatchEvent(root, '/downloads/Some Release/file2.mp3')
      watcher.onWatchEvent(root, '/downloads/Some Release/file3.mp3')

      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(detections).to.have.lengthOf(1)
      expect(detections[0]).to.deep.equal({ rootPath: '/downloads', dirPath: '/downloads/Some Release', releaseName: 'Some Release' })
      watcher.close()
    })

    it('emits detections for distinct directories', async () => {
      const watcher = new DownloadWatcher()
      watcher.pendingDelay = 20
      const root = { path: '/downloads', libraryId: 'lib_1' }

      const detections = []
      watcher.on('detected', (detection) => detections.push(detection.releaseName))

      watcher.onWatchEvent(root, '/downloads/Release A/file.mp3')
      watcher.onWatchEvent(root, '/downloads/Release B/file.mp3')

      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(detections.sort()).to.deep.equal(['Release A', 'Release B'])
      watcher.close()
    })

    it('does not emit after close()', async () => {
      const watcher = new DownloadWatcher()
      watcher.pendingDelay = 20
      const root = { path: '/downloads', libraryId: 'lib_1' }

      const detections = []
      watcher.on('detected', (detection) => detections.push(detection))

      watcher.onWatchEvent(root, '/downloads/Some Release/file.mp3')
      watcher.close()

      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(detections).to.have.lengthOf(0)
    })
  })

  describe('snapshotDirectory', () => {
    let tmpDir

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(Path.join(os.tmpdir(), 'dlwatch-'))
    })

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true })
    })

    it('summarizes file counts, sizes, audio count, and temp artifacts', async () => {
      await fs.writeFile(Path.join(tmpDir, 'book.mp3'), 'a'.repeat(100))
      await fs.writeFile(Path.join(tmpDir, 'book.nfo'), 'x')
      await fs.writeFile(Path.join(tmpDir, 'download.part'), 'partial')
      await fs.mkdir(Path.join(tmpDir, 'nested'))
      await fs.writeFile(Path.join(tmpDir, 'nested', 'track02.flac'), 'b'.repeat(50))

      const snapshot = await snapshotDirectory(tmpDir)
      expect(snapshot.fileCount).to.equal(4)
      expect(snapshot.totalSizeBytes).to.equal(158)
      expect(snapshot.audioFileCount).to.equal(2)
      expect(snapshot.tempFiles).to.have.lengthOf(1)
      expect(snapshot.maxMtimeMs).to.be.greaterThan(0)
    })

    it('ignores dotfiles', async () => {
      await fs.writeFile(Path.join(tmpDir, '.hidden'), 'x')
      const snapshot = await snapshotDirectory(tmpDir)
      expect(snapshot.fileCount).to.equal(0)
    })

    it('returns null for a missing directory', async () => {
      expect(await snapshotDirectory('/does/not/exist')).to.be.null
    })
  })

  describe('waitForDirectoryStability', () => {
    let tmpDir

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(Path.join(os.tmpdir(), 'dlstable-'))
    })

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true })
    })

    it('returns stable immediately for an unchanged directory', async () => {
      await fs.writeFile(Path.join(tmpDir, 'book.mp3'), 'content')
      const result = await waitForDirectoryStability(tmpDir, 0, 10, 5000)
      expect(result.stable).to.be.true
      expect(result.reason).to.equal('stable')
      expect(result.snapshot.audioFileCount).to.equal(1)
    })

    it('reports directory_missing when the directory disappears', async () => {
      const result = await waitForDirectoryStability(Path.join(tmpDir, 'gone'), 0, 10, 2000)
      expect(result.stable).to.be.false
      expect(result.reason).to.equal('directory_missing')
    })

    it('times out while temp artifacts are present', async () => {
      await fs.writeFile(Path.join(tmpDir, 'book.mp3.part'), 'partial')
      const result = await waitForDirectoryStability(tmpDir, 0, 10, 150)
      expect(result.stable).to.be.false
      expect(result.reason).to.equal('temp_artifacts')
    })

    it('waits out a mid-window mutation before reporting stable', async () => {
      await fs.writeFile(Path.join(tmpDir, 'book.mp3'), 'v1')

      // Mutate the directory 30ms in, well inside the 100ms stability window
      const mutateTimer = setTimeout(() => {
        fs.writeFile(Path.join(tmpDir, 'second.mp3'), 'v2').catch(() => {})
      }, 30)

      const result = await waitForDirectoryStability(tmpDir, 100, 10, 5000)
      clearTimeout(mutateTimer)
      expect(result.stable).to.be.true
      expect(result.snapshot.fileCount).to.equal(2)
    }).timeout(10000)
  })

  describe('snapshotsAreEqual', () => {
    it('compares count, size, and newest mtime', () => {
      const base = { fileCount: 2, totalSizeBytes: 10, maxMtimeMs: 100, audioFileCount: 2, tempFiles: [] }
      expect(snapshotsAreEqual(base, { ...base })).to.be.true
      expect(snapshotsAreEqual(base, { ...base, fileCount: 3 })).to.be.false
      expect(snapshotsAreEqual(base, { ...base, maxMtimeMs: 200 })).to.be.false
      expect(snapshotsAreEqual(null, base)).to.be.false
      expect(snapshotsAreEqual(base, null)).to.be.false
    })
  })
})

describe('downloadImport/qualifiers', () => {
  afterEach(() => {
    delete global.fetch
  })

  describe('registry', () => {
    it('knows the D1 client types', () => {
      expect(isQualifierType('qbittorrent')).to.be.true
      expect(isQualifierType('nzbget')).to.be.true
      expect(isQualifierType('sabnzbd')).to.be.false
    })

    it('passes through when no client is configured', async () => {
      const result = await qualifyCandidate({ dirPath: '/x', releaseName: 'x' }, null)
      expect(result.qualified).to.be.true
    })

    it('rejects unknown client types non-transiently', async () => {
      const result = await qualifyCandidate({ dirPath: '/x', releaseName: 'x' }, { type: 'sabnzbd' })
      expect(result.qualified).to.be.false
      expect(result.reason).to.equal('failed')
      expect(result.transient).to.be.false
    })
  })

  describe('qbittorrent', () => {
    const qualifier = new QBittorrentQualifier()

    function mockQBittorrent(torrentStates) {
      global.fetch = async (url) => {
        if (String(url).endsWith('/api/v2/auth/login')) {
          return { ok: true, text: async () => 'Ok.', headers: new Map([['set-cookie', 'SID=abc123']]) }
        }
        if (String(url).endsWith('/api/v2/torrents/info')) {
          return { ok: true, json: async () => torrentStates.map(([name, state, progress, savePath]) => ({ name, state, progress, save_path: savePath, content_path: savePath })) }
        }
        throw new Error(`unexpected url ${url}`)
      }
    }

    it('qualifies a completed torrent', async () => {
      mockQBittorrent([['Other', 'stalledUP', 1, '/other'], ['Some Release', 'pausedUP', 1, '/downloads/Some Release']])
      const result = await qualifier.qualify({ dirPath: '/downloads/Some Release', releaseName: 'Some Release', client: { type: 'qbittorrent', url: 'http://qb:8080', username: 'a', password: 'b' } })
      expect(result.qualified).to.be.true
      expect(result.reason).to.equal('complete')
    })

    it('rejects an in-progress torrent as transient', async () => {
      mockQBittorrent([['Some Release', 'downloading', 0.4, '/downloads/Some Release']])
      const result = await qualifier.qualify({ dirPath: '/downloads/Some Release', releaseName: 'Some Release', client: { type: 'qbittorrent', url: 'http://qb:8080' } })
      expect(result.qualified).to.be.false
      expect(result.reason).to.equal('incomplete')
      expect(result.transient).to.be.true
    })

    it('rejects an errored torrent as terminal', async () => {
      mockQBittorrent([['Some Release', 'error', 0.5, '/downloads/Some Release']])
      const result = await qualifier.qualify({ dirPath: '/downloads/Some Release', releaseName: 'Some Release', client: { type: 'qbittorrent', url: 'http://qb:8080' } })
      expect(result.qualified).to.be.false
      expect(result.reason).to.equal('failed')
      expect(result.transient).to.be.false
    })

    it('reports not_found when no torrent matches', async () => {
      mockQBittorrent([])
      const result = await qualifier.qualify({ dirPath: '/downloads/Some Release', releaseName: 'Some Release', client: { type: 'qbittorrent', url: 'http://qb:8080' } })
      expect(result.qualified).to.be.false
      expect(result.reason).to.equal('not_found')
    })

    it('treats an unreachable client as transient', async () => {
      global.fetch = async () => {
        throw new Error('ECONNREFUSED')
      }
      const result = await qualifier.qualify({ dirPath: '/downloads/Some Release', releaseName: 'Some Release', client: { type: 'qbittorrent', url: 'http://qb:8080' } })
      expect(result.qualified).to.be.false
      expect(result.reason).to.equal('client_unreachable')
      expect(result.transient).to.be.true
    })

    it('normalizes trailing slashes when comparing paths', () => {
      expect(normalizePathForCompare('/downloads/x/')).to.equal('/downloads/x')
      expect(normalizePathForCompare('C:\\downloads\\x')).to.equal('C:/downloads/x')
    })
  })

  describe('nzbget', () => {
    const qualifier = new NZBGetQualifier()

    function mockNZBGet(groups) {
      global.fetch = async (url) => {
        if (String(url).endsWith('/jsonrpc')) {
          return { ok: true, json: async () => ({ result: groups, error: null }) }
        }
        throw new Error(`unexpected url ${url}`)
      }
    }

    it('qualifies a finished group', async () => {
      mockNZBGet([{ NZBName: 'Some Release', DestDir: '/downloads/Some Release', RemainingSizeMB: 0, ActiveDownloads: 0, ParStatus: 'SUCCESS', UnpackStatus: 'SUCCESS', Status: 'SUCCESS' }])
      const result = await qualifier.qualify({ dirPath: '/downloads/Some Release', releaseName: 'Some Release', client: { type: 'nzbget', url: 'http://nzb:6789', username: 'a', password: 'b' } })
      expect(result.qualified).to.be.true
      expect(result.reason).to.equal('complete')
    })

    it('rejects a group still downloading', async () => {
      mockNZBGet([{ NZBName: 'Some Release', DestDir: '/downloads/Some Release', RemainingSizeMB: 30, ActiveDownloads: 1, ParStatus: 'NONE', UnpackStatus: 'NONE' }])
      const result = await qualifier.qualify({ dirPath: '/downloads/Some Release', releaseName: 'Some Release', client: { type: 'nzbget', url: 'http://nzb:6789' } })
      expect(result.qualified).to.be.false
      expect(result.reason).to.equal('incomplete')
      expect(result.transient).to.be.true
    })

    it('rejects a failed unpack as terminal', async () => {
      mockNZBGet([{ NZBName: 'Some Release', DestDir: '/downloads/Some Release', RemainingSizeMB: 0, ActiveDownloads: 0, ParStatus: 'SUCCESS', UnpackStatus: 'FAILURE' }])
      const result = await qualifier.qualify({ dirPath: '/downloads/Some Release', releaseName: 'Some Release', client: { type: 'nzbget', url: 'http://nzb:6789' } })
      expect(result.qualified).to.be.false
      expect(result.reason).to.equal('failed')
      expect(result.transient).to.be.false
    })

    it('matches by NZBName when DestDir differs', async () => {
      mockNZBGet([{ NZBName: 'Some Release', DestDir: '/different/mount/Some Release', RemainingSizeMB: 0, ActiveDownloads: 0, ParStatus: 'SKIPPED', UnpackStatus: 'NONE' }])
      const result = await qualifier.qualify({ dirPath: '/downloads/Some Release', releaseName: 'Some Release', client: { type: 'nzbget', url: 'http://nzb:6789' } })
      expect(result.qualified).to.be.true
    })
  })
})
