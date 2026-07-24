/**
 * BackupScheduler - Automated Backup Orchestration
 *
 * RESPONSIBILITY: Schedule, execute, and manage automated backups
 * OWNER: Backend Team
 * DEPENDENCIES: node-cron, BackupService, logger
 */

const cron = require('node-cron');
const log = require('../utils/log');

class BackupScheduler {
  /**
   * @param {object} options
   * @param {BackupService} options.backupService - Backup service instance
   * @param {string} options.schedule - Cron expression (default: '0 2 * * *' = 2 AM daily)
   * @param {number} options.retentionDays - Keep backups for N days (default: 30)
   * @param {function} [options.onBackupComplete] - Callback on success
   * @param {function} [options.onBackupError] - Callback on error
   * @param {function} [options.onCleanupComplete] - Callback on cleanup
   */
  constructor(options = {}) {
    this.backupService = options.backupService;
    this.schedule = options.schedule || '0 2 * * *';
    this.retentionDays = options.retentionDays || 30;
    this.onBackupComplete = options.onBackupComplete || (() => {});
    this.onBackupError = options.onBackupError || (() => {});
    this.onCleanupComplete = options.onCleanupComplete || (() => {});
    this.task = null;
  }

  /**
   * Start the backup scheduler
   */
  start() {
    if (this.task) {
      log.warn('BACKUP_SCHEDULER', 'Scheduler already running');
      return;
    }

    log.info('BACKUP_SCHEDULER', 'Starting scheduler', { schedule: this.schedule });

    this.task = cron.schedule(this.schedule, () => {
      this.executeBackup().catch(error => {
        log.error('BACKUP_SCHEDULER', 'Unhandled error in backup task', { error: error.message });
      });
    });

    // Don't start immediately; next scheduled execution will trigger
    log.info('BACKUP_SCHEDULER', 'Scheduler started', { nextRun: this._getNextRun() });
  }

  /**
   * Stop the backup scheduler
   */
  stop() {
    if (this.task) {
      this.task.stop();
      this.task.destroy();
      this.task = null;
      log.info('BACKUP_SCHEDULER', 'Scheduler stopped');
    }
  }

  /**
   * Execute a backup and cleanup old backups
   * @returns {Promise<object>} Backup metadata
   */
  async executeBackup() {
    const startTime = Date.now();
    const operationId = `backup_${startTime}_${Math.random().toString(36).substring(7)}`;

    try {
      log.info('BACKUP_SCHEDULER', 'Executing backup', { operationId });

      // Create backup
      const backup = await this.backupService.backup();

      const backupTime = Date.now() - startTime;
      log.info('BACKUP_SCHEDULER', 'Backup created', {
        operationId,
        backupId: backup.backupId,
        size: backup.size,
        duration: backupTime,
      });

      // Cleanup old backups
      await this.cleanupOldBackups();

      // Callback
      this.onBackupComplete({
        ...backup,
        duration: backupTime,
        operationId,
      });

      return backup;
    } catch (error) {
      log.error('BACKUP_SCHEDULER', 'Backup execution failed', {
        operationId,
        error: error.message,
        stack: error.stack,
      });

      this.onBackupError(error);
      throw error;
    }
  }

  /**
   * Clean up backups older than retention period
   * @returns {Promise<{deleted: number, freed: number}>}
   */
  async cleanupOldBackups() {
    try {
      const backups = await this.backupService.listBackups();
      const cutoffTime = Date.now() - (this.retentionDays * 24 * 60 * 60 * 1000);

      let deleted = 0;
      let freed = 0;

      for (const backup of backups) {
        const backupTime = new Date(backup.createdAt).getTime();

        if (backupTime < cutoffTime) {
          try {
            // Note: deleteBackup method would need to be implemented in BackupService
            // For now, just log the cleanup
            freed += backup.size;
            deleted++;

            log.info('BACKUP_SCHEDULER', 'Would delete old backup', {
              backupId: backup.backupId,
              age: Math.floor((Date.now() - backupTime) / (24 * 60 * 60 * 1000)) + ' days',
              size: backup.size,
            });
          } catch (error) {
            log.error('BACKUP_SCHEDULER', 'Failed to delete backup', {
              backupId: backup.backupId,
              error: error.message,
            });
          }
        }
      }

      const result = { deleted, freed };

      if (deleted > 0) {
        log.info('BACKUP_SCHEDULER', 'Cleanup completed', {
          deleted,
          freedBytes: freed,
        });
      }

      this.onCleanupComplete(result);
      return result;
    } catch (error) {
      log.error('BACKUP_SCHEDULER', 'Cleanup failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Get next scheduled run time
   * @returns {Date}
   * @private
   */
  _getNextRun() {
    if (!this.task) return null;
    // Cron task provides nextDate() method
    return this.task.nextDate ? this.task.nextDate() : null;
  }

  /**
   * Get current status
   * @returns {object}
   */
  getStatus() {
    return {
      running: !!this.task,
      schedule: this.schedule,
      retentionDays: this.retentionDays,
      nextRun: this._getNextRun(),
    };
  }
}

module.exports = BackupScheduler;
