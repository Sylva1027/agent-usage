import sqlite from 'node:sqlite';
export const DatabaseSync = sqlite.DatabaseSync;
export const StatementSync = sqlite.StatementSync;
export const backup = sqlite.backup;
export const constants = sqlite.constants;
export default sqlite;
