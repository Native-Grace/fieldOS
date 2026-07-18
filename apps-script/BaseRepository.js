/**
 * BaseRepository.gs
 * Reusable Data Access Object factory mapping directly to the DB layer.
 */

class BaseRepository {
  constructor(tableName, keyColumn, idPrefix) {
    this.tableName = tableName;
    this.keyColumn = keyColumn;
    this.idPrefix = idPrefix;
  }
  
  create(recordObj) {
    // Clone the object to ensure the original parameter object is not mutated
    const record = { ...recordObj };
    if (!record[this.keyColumn]) {
      record[this.keyColumn] = DB.generateId(this.idPrefix);
    }
    return DB.insertRecord(this.tableName, record);
  }
  
  update(id, updates) {
    return DB.updateRecord(this.tableName, this.keyColumn, id, updates);
  }

  findById(id) {
    return DB.findById(this.tableName, this.keyColumn, id);
  }

  findByField(field, value) {
    const results = this.find({ [field]: value });
    return results.length > 0 ? results[0] : null;
  }

  find(conditions) {
    return DB.findWhere(this.tableName, conditions);
  }

  findAll() {
    return DB.findAll(this.tableName);
  }

  findActive() {
    // Note: This method must only be used on repositories where the underlying table contains an 'is_active' column.
    return this.find({ is_active: "TRUE" });
  }

  deleteWhere(conditions) {
    return DB.deleteWhere(this.tableName, conditions);
  }
}