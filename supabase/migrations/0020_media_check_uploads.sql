-- Backs the direct-to-storage upload path for /api/media/claim-check.
--
-- Vercel Functions reject request bodies over ~4.5MB, which meant a shared
-- video/audio file past 4MB (the common case for a real TikTok/Reels clip)
-- silently could not be transcribed for claim checking at all. Files in this
-- bucket are uploaded straight from the client to Supabase Storage using a
-- short-lived signed upload URL (see lib/media/upload.ts), then read and
-- deleted by the service-role backend during the same claim-check request.
-- No RLS policy is added deliberately: the bucket is private (not public),
-- and the only two operations performed against it are (a) the signed
-- upload URL itself, which Supabase authorizes independently of RLS for
-- that one write, and (b) service-role reads/deletes from the API route.
-- Ordinary anon/authenticated API calls have no policy allowing them to
-- list, read, or write this bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'media-check-uploads',
  'media-check-uploads',
  false,
  25165824, -- 24MB: stays under the OpenAI transcription API's 25MB file cap.
  array['video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm', 'audio/ogg', 'audio/x-m4a']
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
