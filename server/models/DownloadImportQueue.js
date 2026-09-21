const { DataTypes, Model } = require('sequelize')

const { DownloadImportStatus } = require('../downloadImport/constants')

/**
 * Persistent queue for the download-import engine. One row per detected
 * download directory; survives server restarts (table is created by Sequelize
 * sync on boot - see the Database.buildModels seam).
 */
class DownloadImportQueue extends Model {
  constructor(values, options) {
    super(values, options)

    /** @type {UUIDV4} */
    this.id
    /** @type {string} library this row imports into */
    this.libraryId
    /** @type {string|null} target LibraryFolder id for materialization */
    this.folderId
    /** @type {string} watch root the download was detected under */
    this.watchRoot
    /** @type {string} source directory (never deleted by the engine) */
    this.sourcePath
    /** @type {string} release folder name as detected */
    this.releaseName
    /** @type {DownloadImportStatus} */
    this.status
    /** @type {Object|null} ReleaseInfo from ReleaseParser */
    this.parsedMetadata
    /** @type {Object|null} { candidates, searchTitle, searchAuthor, manual } */
    this.matchData
    /** @type {number|null} match confidence 0..1 (null for manual matches) */
    this.confidence
    /** @type {string|null} destination directory of the import */
    this.destinationPath
    /** @type {Object|null} the import plan (same object dry-run returns) */
    this.importPlan
    /** @type {string|null} pipeline stage that failed, when status = error */
    this.errorStage
    /** @type {string|null} */
    this.errorReason
    /** @type {number} processing attempts */
    this.attempts
    /** @type {Date} */
    this.createdAt
    /** @type {Date} */
    this.updatedAt
  }

  /**
   * Initialize model
   * @param {import('../Database').sequelize} sequelize
   */
  static init(sequelize) {
    super.init(
      {
        id: {
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
          primaryKey: true
        },
        libraryId: DataTypes.UUID,
        folderId: {
          type: DataTypes.UUID,
          allowNull: true
        },
        watchRoot: DataTypes.STRING,
        sourcePath: DataTypes.STRING,
        releaseName: DataTypes.STRING,
        status: {
          type: DataTypes.STRING,
          defaultValue: DownloadImportStatus.DETECTED
        },
        parsedMetadata: DataTypes.JSON,
        matchData: DataTypes.JSON,
        confidence: DataTypes.REAL,
        destinationPath: {
          type: DataTypes.STRING,
          allowNull: true
        },
        importPlan: DataTypes.JSON,
        errorStage: {
          type: DataTypes.STRING,
          allowNull: true
        },
        errorReason: {
          type: DataTypes.STRING,
          allowNull: true
        },
        attempts: {
          type: DataTypes.INTEGER,
          defaultValue: 0
        }
      },
      {
        sequelize,
        modelName: 'downloadImportQueue'
      }
    )
  }
}

module.exports = DownloadImportQueue
