export interface SyncMetadata {
  lastSyncTime?: string; // ISO 8601, only set on success
  errors?: string[]; // set when sync fails
}
