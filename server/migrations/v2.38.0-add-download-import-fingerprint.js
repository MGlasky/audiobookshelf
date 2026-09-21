/**
 * @typedef MigrationContext
 * @property {import('sequelize').QueryInterface} queryInterface - a Sequelize QueryInterface object.
 * @property {import('../../Logger')} logger - a Logger object.
 *
 * @typedef MigrationOptions
 * @property {MigrationContext} context - an object containing the migration context.
 */

const migrationVersion = '2.38.0'
const migrationName = `${migrationVersion}-add-download-import-fingerprint`
const loggerPrefix = `[${migrationVersion} migration]`

/**
 * Adds the clientId and fingerprint columns to the downloadImportQueues
 * table (stage-5 duplicate suppression). Fresh databases get the columns
 * from Sequelize sync; this migration upgrades installs that already
 * created the table. Existing rows keep a null fingerprint - suppression
 * treats unknown identity conservatively and rows are fingerprinted again
 * on their next qualification.
 *
 * @param {MigrationOptions} options - an object containing the migration context.
 * @returns {Promise<void>} - A promise that resolves when the migration is complete.
 */
async function up({ context: { queryInterface, logger } }) {
  logger.info(`${loggerPrefix} UPGRADE BEGIN: ${migrationName}`)

  if (await queryInterface.tableExists('downloadImportQueues')) {
    const tableDescription = await queryInterface.describeTable('downloadImportQueues')

    if (!tableDescription.clientId) {
      logger.info(`${loggerPrefix} Adding clientId column to downloadImportQueues table`)
      await queryInterface.addColumn('downloadImportQueues', 'clientId', {
        type: queryInterface.sequelize.Sequelize.DataTypes.STRING,
        allowNull: true
      })
    } else {
      logger.info(`${loggerPrefix} clientId column already exists in downloadImportQueues table`)
    }

    if (!tableDescription.fingerprint) {
      logger.info(`${loggerPrefix} Adding fingerprint column to downloadImportQueues table`)
      await queryInterface.addColumn('downloadImportQueues', 'fingerprint', {
        type: queryInterface.sequelize.Sequelize.DataTypes.STRING,
        allowNull: true
      })
    } else {
      logger.info(`${loggerPrefix} fingerprint column already exists in downloadImportQueues table`)
    }
  } else {
    logger.info(`${loggerPrefix} downloadImportQueues table does not exist - skipping (created by sync with the columns)`)
  }

  logger.info(`${loggerPrefix} UPGRADE END: ${migrationName}`)
}

/**
 * @param {MigrationOptions} options - an object containing the migration context.
 * @returns {Promise<void>} - A promise that resolves when the migration is complete.
 */
async function down({ context: { queryInterface, logger } }) {
  logger.info(`${loggerPrefix} DOWNGRADE BEGIN: ${migrationName}`)

  if (await queryInterface.tableExists('downloadImportQueues')) {
    const tableDescription = await queryInterface.describeTable('downloadImportQueues')

    if (tableDescription.fingerprint) {
      logger.info(`${loggerPrefix} Removing fingerprint column from downloadImportQueues table`)
      await queryInterface.removeColumn('downloadImportQueues', 'fingerprint')
    } else {
      logger.info(`${loggerPrefix} fingerprint column does not exist in downloadImportQueues table`)
    }

    if (tableDescription.clientId) {
      logger.info(`${loggerPrefix} Removing clientId column from downloadImportQueues table`)
      await queryInterface.removeColumn('downloadImportQueues', 'clientId')
    } else {
      logger.info(`${loggerPrefix} clientId column does not exist in downloadImportQueues table`)
    }
  } else {
    logger.info(`${loggerPrefix} downloadImportQueues table does not exist - skipping`)
  }

  logger.info(`${loggerPrefix} DOWNGRADE END: ${migrationName}`)
}

module.exports = { up, down }
