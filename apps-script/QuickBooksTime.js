/**
 * QuickBooksTime.gs
 * Integration engine for QuickBooks Time (formerly TSheets) API.
 * Synchronizes external team directories and custom field dropdown lists natively.
 * 
 * Auto-Resolution: Dynamic 2-step lookup for shortcodes vs internal IDs.
 */

const QuickBooksTimeService = {

  /**
   * Retrieves the current access token from environment configurations.
   * Automatically trims accidental trailing browser spaces or line breaks.
   */
  getAccessToken: function() {
    const token = PropertiesService.getScriptProperties().getProperty('QB_TIME_ACCESS_TOKEN');
    if (!token) {
      throw new Error("QuickBooks Time Integration Error: 'QB_TIME_ACCESS_TOKEN' script property is blank.");
    }
    return token.trim(); 
  },

  /**
   * Safe getter for the spreadsheet instance in standalone script contexts.
   */
  _getSpreadsheet: function() {
    const spreadsheetId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    if (!spreadsheetId) {
      throw new Error("QuickBooks Time Engine Error: 'SPREADSHEET_ID' script property is missing or blank.");
    }
    return SpreadsheetApp.openById(spreadsheetId.trim());
  },

  /**
   * Fetches the complete list of users/team members from QuickBooks Time API.
   */
  fetchUsers: function() {
    const token = this.getAccessToken();
    const url = "https://rest.tsheets.com/api/v1/users"; 

    const options = {
      method: "get",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
        "Content-Type": "application/json"
      },
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(url, options);
    const respCode = response.getResponseCode();
    const respText = response.getContentText();

    if (respCode !== 200) {
      throw new Error(`QuickBooks Time API Fetch Users Failure (${respCode}): ${respText}`);
    }

    const json = JSON.parse(respText);
    if (!json.results || !json.results.users) return [];
    return Object.values(json.results.users);
  },

  /**
   * TWO-STEP LOOKUP ENGINE: Resolves a shortcode to an internal customfield_id
   * and extracts the nested dropdown selections safely.
   */
  fetchTasks: function() {
    const token = this.getAccessToken();
    const options = {
      method: "get",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
        "Content-Type": "application/json"
      },
      muteHttpExceptions: true
    };

    // STEP 1: Query all custom field definitions to locate the real backend ID
    const definitionsUrl = "https://rest.tsheets.com/api/v1/customfields";
    Logger.log("Resolving custom field metadata from QuickBooks Time...");
    
    const defResponse = UrlFetchApp.fetch(definitionsUrl, options);
    if (defResponse.getResponseCode() !== 200) {
      throw new Error(`Failed to fetch custom field definitions: ${defResponse.getContentText()}`);
    }
    
    const defJson = JSON.parse(defResponse.getContentText());
    if (!defJson.results || !defJson.results.customfields) return [];
    
    const customFields = Object.values(defJson.results.customfields);
    
    // Cross-reference by shortcode string or by field name
    const targetField = customFields.find(f => 
      String(f.shortcode) === "42811253" || 
      String(f.id) === "42811253" ||
      String(f.name).toLowerCase() === "task"
    );
    
    if (!targetField) {
      throw new Error("Integration Lookup Error: Could not find any custom field matching shortcode/ID '42811253' or name 'task' in QuickBooks Time.");
    }
    
    const realInternalId = targetField.id;
    Logger.log(`Success: Found Custom Field. Title: "${targetField.name}" | Real Backend ID: ${realInternalId}`);

    // STEP 2: Use the newly discovered real internal database ID to fetch dropdown items
    const itemsUrl = `https://rest.tsheets.com/api/v1/customfielditems?customfield_id=${realInternalId}&active=yes`; 
    const itemsResponse = UrlFetchApp.fetch(itemsUrl, options);

    if (itemsResponse.getResponseCode() !== 200) {
      throw new Error(`QuickBooks Time API Fetch Custom Field Items Failure (${itemsResponse.getResponseCode()}): ${itemsResponse.getContentText()}`);
    }

    const itemsJson = JSON.parse(itemsResponse.getContentText());
    if (!itemsJson.results || !itemsJson.results.customfielditems) return [];
    
    return Object.values(itemsJson.results.customfielditems);
  },

  /**
   * Master Sync Pipeline for Staff Directory.
   */
  syncStaffToTblStaff: function() {
    Logger.log("Starting QuickBooks Time Staff Sync Execution...");
    let usersFetchedCount = 0;
    let recordsCreatedCount = 0;
    let recordsUpdatedCount = 0;

    try {
      const qbUsers = this.fetchUsers();
      usersFetchedCount = qbUsers.length;

      const ss = this._getSpreadsheet();
      const sheet = ss.getSheetByName('tbl_staff');
      if (!sheet) throw new Error("Table 'tbl_staff' not found.");

      const data = sheet.getDataRange().getValues();
      const headers = data.shift();
      
      const qbIdIndex = headers.indexOf('quickbooks_time_user_id');
      if (qbIdIndex === -1) throw new Error("Column 'quickbooks_time_user_id' missing in tbl_staff headers.");

      qbUsers.forEach(user => {
        if (!user.id) return;
        const stringQbId = String(user.id);
        const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
        
        const existingRowOffset = data.findIndex(row => String(row[qbIdIndex]) === stringQbId);

        const targetPayload = {
          staff_name: fullName || "Unnamed QB User",
          email: user.email || "",
          is_active: String(user.active).toUpperCase() === 'TRUE',
          quickbooks_time_user_id: stringQbId
        };

        if (existingRowOffset !== -1) {
          const sheetRowIndex = existingRowOffset + 2;
          headers.forEach((header, i) => {
            if (targetPayload[header] !== undefined) {
              sheet.getRange(sheetRowIndex, i + 1).setValue(targetPayload[header]);
            }
          });
          recordsUpdatedCount++;
        } else {
          targetPayload.staff_id = "STF_" + Utilities.getUuid();
          targetPayload.role = "Field Staff";
          const newRow = headers.map(h => targetPayload[h] !== undefined ? targetPayload[h] : "");
          sheet.appendRow(newRow);
          recordsCreatedCount++;
        }
      });

      return `Staff Sync Complete. Fetched: ${usersFetchedCount} | Created: ${recordsCreatedCount} | Updated: ${recordsUpdatedCount}.`;
    } catch (err) {
      console.error("Critical Staff Sync Error", err);
      throw err;
    }
  },

  /**
   * Master Sync Pipeline for Tasks List. Maps QuickBooks Custom Field Items to tbl_tasks.
   */
  syncTasksToTblTasks: function() {
    Logger.log("Starting QuickBooks Time Custom Field Tasks Sync Execution...");
    let tasksFetchedCount = 0;
    let recordsCreatedCount = 0;
    let recordsUpdatedCount = 0;

    try {
      const qbTasks = this.fetchTasks();
      tasksFetchedCount = qbTasks.length;

      const ss = this._getSpreadsheet();
      const sheet = ss.getSheetByName('tbl_tasks');
      if (!sheet) throw new Error("Table 'tbl_tasks' not found inside your spreadsheet layout.");

      const data = sheet.getDataRange().getValues();
      const headers = data.shift();
      
      const taskNameIndex = headers.indexOf('task_name');
      if (taskNameIndex === -1) throw new Error("Column 'task_name' missing in tbl_tasks headers.");

      let qbJobcodeIdIndex = headers.indexOf('quickbooks_time_jobcode_id');
      if (qbJobcodeIdIndex === -1) {
        sheet.getRange(1, headers.length + 1).setValue('quickbooks_time_jobcode_id')
             .setFontWeight("bold").setBackground("#f3f3f3");
        headers.push('quickbooks_time_jobcode_id');
        qbJobcodeIdIndex = headers.length - 1;
        sheet.autoResizeColumns(headers.length, 1);
      }

      qbTasks.forEach(item => {
        const rawName = item.name || item.value; 
        if (!rawName) return;
        
        const cleanTaskName = String(rawName).trim();
        const stringItemId = String(item.id);

        let existingRowOffset = data.findIndex(row => String(row[qbJobcodeIdIndex]) === stringItemId);
        if (existingRowOffset === -1) {
          existingRowOffset = data.findIndex(row => String(row[taskNameIndex]).toLowerCase() === cleanTaskName.toLowerCase());
        }

        const targetPayload = {
          task_name: cleanTaskName,
          quickbooks_time_jobcode_id: stringItemId 
        };

        if (existingRowOffset !== -1) {
          const sheetRowIndex = existingRowOffset + 2;
          headers.forEach((header, i) => {
            if (targetPayload[header] !== undefined) {
              sheet.getRange(sheetRowIndex, i + 1).setValue(targetPayload[header]);
            }
          });
          recordsUpdatedCount++;
        } else {
          targetPayload.task_id = "TASK_" + Utilities.getUuid().split("-")[0].toUpperCase();
          const newRow = headers.map(h => targetPayload[h] !== undefined ? targetPayload[h] : "");
          sheet.appendRow(newRow);
          recordsCreatedCount++;
        }
      });

      return `Task Sync Complete. Synced Custom Field Tasks: ${tasksFetchedCount} | Created: ${recordsCreatedCount} | Updated: ${recordsUpdatedCount}.`;
    } catch (err) {
      console.error("Critical Task Sync Error", err);
      throw err;
    }
  }
};

/**
 * MANUAL AUTOMATION ENGINE TEST GATEWAYS
 */
function runStaffDirectorySync() {
  Logger.log("Initializing Manual QuickBooks Time Staff Sync...");
  try {
    const output = QuickBooksTimeService.syncStaffToTblStaff();
    Logger.log(output);
  } catch (err) {
    Logger.log("Aborted: " + err.toString());
  }
}

function runTaskListSync() {
  Logger.log("Initializing Manual QuickBooks Time Task List Sync...");
  try {
    const output = QuickBooksTimeService.syncTasksToTblTasks();
    Logger.log(output);
  } catch (err) {
    Logger.log("Aborted: " + err.toString());
  }
}