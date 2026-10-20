// Hard limits for the CSV migration helper. Each one is enforced (and tested) before any work is done on the content.

export const MAX_CSV_BYTES = 2 * 1024 * 1024;
export const MAX_CSV_ROWS = 500;
export const MAX_CSV_COLUMNS = 50;
export const MAX_CELL_CHARS = 20_000;
/** Most drafts one confirm request creates. A longer file is imported by confirming again (rows already imported are skipped). */
export const MAX_DRAFTS_PER_REQUEST = 200;
export const PREVIEW_ROW_LIMIT = 20;
export const SAMPLE_ROW_LIMIT = 3;
export const EXCERPT_CHARS = 140;
export const PREVIEW_RATE_PER_HOUR = 10;
export const CONFIRM_RATE_PER_HOUR = 5;
