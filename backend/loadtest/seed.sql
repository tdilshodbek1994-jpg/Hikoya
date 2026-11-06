-- Synthetic load dataset (spec 30): 2 000 works, 20 000 chapters, 100 000 accounts, 1 000 000 reading events.
-- Artificial volume for index/pagination checks — NOT a business forecast. Run on an EMPTY, migrated + seeded DB.
BEGIN;
INSERT INTO author_profiles (pen_name, slug, bio, verification_status, publish_policy, editorial_featured, next_release_note, is_demo, search_text, created_at)
SELECT 'Yuklama muallif ' || i, 'load-author-' || i, '', 'none', 'trusted', false, '', true, 'yuklama muallif ' || i, now()
FROM generate_series(1, 200) i;

INSERT INTO works (short_code, slug, title, synopsis, primary_author_id, primary_genre_id, content_language, script, format, editorial_state,
  completion_state, access_policy, visibility, suspended_reason, comments_policy, content_flags, next_release_note, recap_note, is_demo,
  search_text, created_at, updated_at, published_at, last_chapter_published_at, chapters_published, words_published, has_audio,
  likes_count, thanks_count, comments_count, version)
SELECT 'ld' || lpad(i::text, 6, '0'), 'yuklama-' || i, 'Yuklama asari ' || i, 'Sintetik annotatsiya ' || i,
  (SELECT min(id) FROM author_profiles WHERE slug LIKE 'load-author-%') + (i % 200),
  (SELECT min(id) FROM genres) + (i % 15), 'uz', 'latn', CASE WHEN i % 3 = 0 THEN 'novel' ELSE 'short' END, 'published',
  CASE WHEN i % 4 = 0 THEN 'ongoing' ELSE 'completed' END,
  CASE WHEN i % 5 = 0 THEN 'PREMIUM' WHEN i % 17 = 0 THEN 'PURCHASE' ELSE 'FREE' END, 'public', '', 'open', '{}', '', '', true,
  'yuklama asari ' || i || ' sintetik annotatsiya', now(), now(), now() - (i || ' minutes')::interval, now(), 10, 3000, false, 0, 0, 0, 1
FROM generate_series(1, 2000) i;

INSERT INTO work_genres (work_id, genre_id, is_primary) SELECT id, primary_genre_id, true FROM works WHERE short_code LIKE 'ld%';

INSERT INTO chapters (work_id, stable_key, sort_key, title, editorial_state, access_override, preview_blocks, words, has_audio, is_deleted, created_at, updated_at, published_at)
SELECT w.id, md5(w.id::text || '-' || n), n * 1024, n || '-bob', 'published', CASE WHEN n = 1 THEN 'free_sample' ELSE 'inherit' END, 3, 300, false, false, now(), now(), now() - interval '1 day'
FROM works w CROSS JOIN generate_series(1, 10) n WHERE w.short_code LIKE 'ld%';

-- one revision per chapter: 30 paragraphs with stable block ids
INSERT INTO chapter_revisions (chapter_id, content_json, plain_text_for_index, content_hash, change_note, word_count, block_ids, created_at)
SELECT c.id,
  jsonb_build_object('type', 'doc', 'content', (SELECT jsonb_agg(jsonb_build_object('type', 'paragraph', 'attrs', jsonb_build_object('bid', 'b' || lpad(k::text, 9, '0')),
      'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', repeat('Sintetik matn jumlasi. ', 10))))) FROM generate_series(1, 30) k)),
  'sintetik matn jumlasi', md5(c.id::text), '', 300,
  (SELECT jsonb_agg('b' || lpad(k::text, 9, '0')) FROM generate_series(1, 30) k), now()
FROM chapters c JOIN works w ON w.id = c.work_id WHERE w.short_code LIKE 'ld%';
UPDATE chapters c SET published_revision_id = r.id FROM chapter_revisions r WHERE r.chapter_id = c.id AND c.published_revision_id IS NULL;

INSERT INTO users (telegram_user_id, display_name, language, script, status, is_test, onboarding_done, favorite_genre_ids, reader_settings,
  only_completed, bot_started, bot_blocked, bot_messages_allowed, created_at)
SELECT 9000000000 + i, 'Yuklama ' || i, 'uz', 'latn', 'active', false, true, '[]', '{}', false, false, false, false, now()
FROM generate_series(1, 100000) i;
-- known session tokens for the load generator: loadtok-<n>
INSERT INTO sessions (user_id, token_hash, expires_at, device_label, created_at)
SELECT u.id, encode(sha256(convert_to('loadtok-' || (u.telegram_user_id - 9000000000), 'UTF8')), 'hex'), now() + interval '2 days', 'load', now()
FROM users u WHERE u.telegram_user_id > 9000000000 AND u.telegram_user_id <= 9000000000 + 2000;

WITH first_ch AS (SELECT work_id, min(id) AS chapter_id FROM chapters GROUP BY work_id),
     ws AS (SELECT row_number() OVER (ORDER BY w.id) - 1 AS n, w.id AS work_id, f.chapter_id FROM works w JOIN first_ch f ON f.work_id = w.id WHERE w.short_code LIKE 'ld%')
INSERT INTO reading_sessions (public_id, user_id, work_id, chapter_id, device_id, started_at, last_seen_at, active_seconds, blocks_seen, total_blocks, is_preview, qualified, flagged)
SELECT 'ls' || i, u0 + (i % 100000), ws.work_id, ws.chapter_id, 'load', now() - ((i % 30) || ' days')::interval, now(), 60, '[]', 30, false, false, ''
FROM generate_series(1, 100000) i
JOIN ws ON ws.n = i % 2000
CROSS JOIN (SELECT min(id) u0 FROM users WHERE telegram_user_id > 9000000000) x;

INSERT INTO reading_events (event_id, session_id, user_id, sequence, event_type, position, received_at)
SELECT 'le' || i, s0 + (i % 100000), u0 + (i % 100000), i, 'blocks', '{}', now() - ((i % 30) || ' days')::interval
FROM generate_series(1, 1000000) i,
  (SELECT min(id) s0 FROM reading_sessions WHERE public_id LIKE 'ls%') a,
  (SELECT min(id) u0 FROM users WHERE telegram_user_id > 9000000000) b;

INSERT INTO qualified_reads (user_id, work_id, local_date, qualified_at, reason_version, source)
SELECT DISTINCT ON (u, w, d) u, w, d, now(), 'qr-v1', ''
FROM (SELECT u0 + (i % 100000) u, w0 + ((i * 7) % 2000) w, (current_date - (i % 30)) d
      FROM generate_series(1, 300000) i,
      (SELECT min(id) u0 FROM users WHERE telegram_user_id > 9000000000) a,
      (SELECT min(id) w0 FROM works WHERE short_code LIKE 'ld%') b) t;
COMMIT;
ANALYZE;
