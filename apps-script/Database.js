/**
 * Database.gs
 * Generic ORM mapping and Google Sheets I/O.
 * All write operations are protected by LockService.
 */

const DB = {
  
  normalizeBoolean: function(value) {
    if (typeof value === 'boolean') return value ? "TRUE" : "FALSE";
    if (value === 1 || value === '1') return "TRUE";
    if (value === 0 || value === '0') return "FALSE";
    
    if (typeof value === 'string') {
      const upper = value.trim().toUpperCase();
      if (['TRUE', 'YES', 'Y'].includes(upper)) return "TRUE";
      if (['FALSE', 'NO', 'N'].includes(upper)) return "FALSE";
    }
    
    return "FALSE"; 
  },

  generateId: function(prefix) {
    const uuid = Utilities.getUuid().split('-')[0].toUpperCase();
    return prefix ? `${prefix}-${uuid}` : uuid;
  },

  getSheet: function(tableName) {
    const sheet = SpreadsheetApp.openById(Config.getSpreadsheetId()).getSheetByName(tableName);
    if (!sheet) throw new Error(`Database Error: Table '${tableName}' missing.`);
    return sheet;
  },
  
  getHeaders: function(tableName) {
    const sheet = this.getSheet(tableName);
    const lastCol = sheet.getLastColumn();
    if (lastCol === 0) return [];
    return sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  },

  validateColumns: function(headers, obj, tableName) {
    for (const key in obj) {
      if (headers.indexOf(key) === -1) {
        throw new Error(`Schema Error: Field '${key}' does not exist in table '${tableName}'.`);
      }
    }
  },
  
  objectToRow: function(headers, obj) {
    return headers.map(header => {
      if (obj[header] !== undefined) {
        if (typeof obj[header] === 'boolean') return this.normalizeBoolean(obj[header]);
        return obj[header];
      }
      return "";
    });
  },
  
  rowToObject: function(headers, row) {
    const obj = {};
    headers.forEach((header, index) => { 
      if (header) obj[header] = row[index]; 
    });
    return obj;
  },

  insertRecord: function(tableName, recordObj) {
    return Utils.withLock(`INSERT_${tableName}`, 10000, () => {
      const headers = this.getHeaders(tableName);
      this.validateColumns(headers, recordObj, tableName);
      
      const sheet = this.getSheet(tableName);
      const rowData = this.objectToRow(headers, recordObj);
      sheet.appendRow(rowData);
      SpreadsheetApp.flush();
      
      return recordObj;
    });
  },

  updateRecord: function(tableName, keyColumn, keyValue, updateObj) {
    return Utils.withLock(`UPDATE_${tableName}`, 15000, () => {
      const headers = this.getHeaders(tableName);
      this.validateColumns(headers, updateObj, tableName);
      
      const sheet = this.getSheet(tableName);
      const data = sheet.getDataRange().getValues();
      if (data.length <= 1) throw new Error(`Table ${tableName} is empty.`);
      
      const keyIndex = headers.indexOf(keyColumn);
      if (keyIndex === -1) throw new Error(`Key column '${keyColumn}' not found.`);
      
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][keyIndex]) === String(keyValue)) {
          const existingRecord = this.rowToObject(headers, data[i]);
          const mergedRecord = { ...existingRecord, ...updateObj };
          
          sheet.getRange(i + 1, 1, 1, headers.length).setValues([this.objectToRow(headers, mergedRecord)]);
          SpreadsheetApp.flush();
          return mergedRecord;
        }
      }
      throw new Error(`Record with ${keyColumn} = '${keyValue}' not found in ${tableName}.`);
    });
  },

  findAll: function(tableName) {
    const sheet = this.getSheet(tableName);
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) return [];
    
    const headers = data[0];
    return data.slice(1).map(row => this.rowToObject(headers, row));
  },

  findWhere: function(tableName, conditions) {
    const sheet = this.getSheet(tableName);
    const data = sheet.getDataRange().getValues();
    if (data.length === 0) return [];
    
    const headers = data[0];
    this.validateColumns(headers, conditions, tableName);

    if (data.length === 1) return [];
    
    return data.slice(1).reduce((acc, row) => {
      const record = this.rowToObject(headers, row);
      let match = true;
      for (const key in conditions) { 
        if (String(record[key]) !== String(conditions[key])) {
          match = false;
          break;
        }
      }
      if (match) acc.push(record);
      return acc;
    }, []);
  },
  
  findById: function(tableName, keyColumn, id) {
    const conditions = {};
    conditions[keyColumn] = id;
    const results = this.findWhere(tableName, conditions);
    return results.length > 0 ? results[0] : null;
  },

  deleteWhere: function(tableName, conditions) {
    return Utils.withLock(`DELETE_${tableName}`, 15000, () => {
      const sheet = this.getSheet(tableName);
      const data = sheet.getDataRange().getValues();
      if (data.length === 0) return 0;
      
      const headers = data[0];
      this.validateColumns(headers, conditions, tableName);

      if (data.length === 1) return 0;
      
      let deletedCount = 0;
      
      for (let i = data.length - 1; i >= 1; i--) {
        const row = data[i];
        let match = true;
        for (const key in conditions) {
          const colIdx = headers.indexOf(key);
          if (String(row[colIdx]) !== String(conditions[key])) {
            match = false;
            break;
          }
        }
        
        if (match) {
          sheet.deleteRow(i + 1);
          deletedCount++;
        }
      }
      
      if (deletedCount > 0) SpreadsheetApp.flush();
      return deletedCount;
    });
  }
};