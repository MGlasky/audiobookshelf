/**
 * @typedef MigrationContext
 * @property {import('sequelize').QueryInterface} queryInterface - a Sequelize QueryInterface object.
 * @property {import('../../Logger')} logger - a Logger object.
 *
 * @typedef MigrationOptions
 * @property {MigrationContext} context - an object containing the migration context.
 */

const migrationVersion = '2.37.0'
const migrationName = `${migrationVersion}-add-download-import-cleanup`
const loggerPrefix = `[${migrationVersion} migration]`

/**
 * Adds the cleanedUpAt column to the downloadImportQueues table (decision D4
 * source cleanup). Fresh databases get the column from Sequelize sync; this
 * migration upgrades installs that already created the table.
 *
 * @param {MigrationOptions} options - an object containing the migration context.
 * @returns {Promise<void>} - A promise that resolves when the migration is complete.
 */
async function up({ context: { queryInterface, logger } }) {
  logger.info(`${loggerPrefix} UPGRADE BEGIN: ${migrationName}`)

  if (await queryInterface.tableExists('downloadImportQueues')) {
    const tableDescription = await queryInterface.describeTable('downloadImportQueues')

    if (!tableDescription.cleanedUpAt) {
      logger.info(`${loggerPrefix} Adding cleanedUpAt column to downloadImportQueues table`)
      await queryInterface.addColumn('downloadImportQueues', 'cleanedUpAt', {
        type: queryInterface.sequelize.Sequelize.DataTypes.DATE,
        allowNull: true
      })
    } else {
      logger.info(`${loggerPrefix} cleanedUpAt column already exists in downloadImportQueues table`)
    }
  } else {
    logger.info(`${loggerPrefix} downloadImportQueues table does not exist - skipping (created by sync with the column)`)
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

    if (tableDescription.cleanedUpAt) {
      logger.info(`${loggerPrefix} Removing cleanedUpAt column from downloadImportQueues table`)
      await queryInterface.removeColumn('downloadImportQueues', 'cleanedUpAt')
    } else {
      logger.info(`${loggerPrefix} cleanedUpAt column does not exist in downloadImportQueues table`)
    }
  } else {
    logger.info(`${loggerPrefix} downloadImportQueues table does not exist - skipping`)
  }

  logger.info(`${loggerPrefix} DOWNGRADE END: ${migrationName}`)
}

module.exports = { up, down }
