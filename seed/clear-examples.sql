-- Removes every example pop-up and example account. Real data is untouched.
DELETE FROM votes WHERE popup_id IN (SELECT id FROM popups WHERE is_example = 1) OR user_id LIKE 'ex\_%' ESCAPE '\';
DELETE FROM checkins WHERE popup_id IN (SELECT id FROM popups WHERE is_example = 1) OR user_id LIKE 'ex\_%' ESCAPE '\';
DELETE FROM reports WHERE popup_id IN (SELECT id FROM popups WHERE is_example = 1) OR user_id LIKE 'ex\_%' ESCAPE '\';
DELETE FROM saves WHERE popup_id IN (SELECT id FROM popups WHERE is_example = 1);
DELETE FROM popup_images WHERE popup_id IN (SELECT id FROM popups WHERE is_example = 1);
DELETE FROM karma_log WHERE user_id LIKE 'ex\_%' ESCAPE '\';
DELETE FROM popups WHERE is_example = 1;
DELETE FROM users WHERE id LIKE 'ex\_%' ESCAPE '\' AND id NOT IN (SELECT created_by FROM popups);
