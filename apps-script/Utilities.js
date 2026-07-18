/**
 * Utilities.gs
 * Global helper functions for error handling, JSON responses, and concurrency locking.
 */

const Utils = {
  
  /**
   * Formats a clean stack trace string from an error object.
   */
  getStackTrace: function(error) {
    if (!error) return "Unknown Error";
    return `${error.message || error.toString()}\nStack:\n${error.stack || "No stack trace available."}`;
  },

  /**
   * Generates a standardized HTTP JSON output response.
   */
  createJsonResponse: function(status, action, message, recordId) {
    const response = {
      status: status,
      action: action,
      message: message,
      record_id: recordId || null,
      timestamp: new Date().toISOString()
    };
    
    return ContentService.createTextOutput(JSON.stringify(response))
                         .setMimeType(ContentService.MimeType.JSON);
  },

  /**
   * Wraps an operation in a strict global mutual-exclusion lock.
   * Ensures the lock is only released if it was successfully acquired.
   */
  withLock: function(lockName, timeoutMs, executionFunction) {
    const lock = LockService.getScriptLock();
    let hasLock = false;
    
    try {
      hasLock = lock.tryLock(timeoutMs || 10000);
      if (!hasLock) {
        throw new Error(`Lock Timeout: Could not acquire lock '${lockName}' within ${timeoutMs}ms.`);
      }
      
      // Execute the business logic passed into the helper
      return executionFunction();
      
    } finally {
      if (hasLock) {
        lock.releaseLock();
      }
    }
  }
};