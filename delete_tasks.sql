-- Delete specific tasks by title created by "sunset" user
-- This script will delete the task records and their associated assignees

-- First, find the user_id for "sunset" user
-- Then delete the tasks with the specified titles

-- Delete task assignees and tasks
DELETE FROM task_assignees 
WHERE task_id IN (
  SELECT t.id 
  FROM tasks t
  JOIN user_projection u ON t.sender_id = u.user_id
  WHERE u.username = 'sunset'
    AND t.title IN ('Muth maro', 'Clean up after muth')
);

DELETE FROM tasks
WHERE sender_id IN (
  SELECT user_id FROM user_projection WHERE username = 'sunset'
)
AND title IN ('Muth maro', 'Clean up after muth');

-- Also clean up from outbox if these tasks generated events
DELETE FROM outbox
WHERE kafka_key IN (
  SELECT t.id::text
  FROM tasks t
  WHERE t.sender_id IN (
    SELECT user_id FROM user_projection WHERE username = 'sunset'
  )
  AND t.title IN ('Muth maro', 'Clean up after muth')
);
