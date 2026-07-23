-- The original media_uploads table (0009) only stored the public URL, not
-- the storage object's actual path — but deleting an object from Supabase
-- Storage needs the path, not the public URL. Needed for the per-account
-- storage-quota feature: once an account can delete its own uploaded media
-- to free up space, the backend needs a real path to delete, not just a
-- URL to display.
alter table media_uploads add column storage_path text;
