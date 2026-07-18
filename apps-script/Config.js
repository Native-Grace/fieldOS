/**
 * Config.gs
 * Global application configuration and environment variables.
 */

const Config = {
  // Status states for the queue system
  QUEUE_STATUS: {
    QUEUED: "Queued",
    PROCESSING: "Processing",
    COMPLETED: "Completed",
    FAILED: "Failed",
    CANCELLED: "Cancelled"
  },

  /**
   * Safely retrieves a required key from Script Properties.
   */
  get: function(key) {
    const value = PropertiesService.getScriptProperties().getProperty(key);
    if (!value) {
      throw new Error(`Configuration Error: Required script property '${key}' is missing.`);
    }
    return value;
  },

  /**
   * Retrieves an optional key, returning a fallback value if missing.
   */
  getOptional: function(key, fallback) {
    const value = PropertiesService.getScriptProperties().getProperty(key);
    return value || fallback;
  },

  getSpreadsheetId: function() {
    return this.get('SPREADSHEET_ID');
  },

  getWebhookSecret: function() {
    return this.get('WEBHOOK_SECRET');
  }
};