#!/usr/bin/env python3
"""Delete tasks directly from taskdb"""

import psycopg2
from psycopg2.extras import RealDictCursor
import os

# Connection parameters from environment
conn = psycopg2.connect(
    host=os.getenv("POSTGRES_HOST", "localhost"),
    port=os.getenv("POSTGRES_PORT", "5432"),
    user=os.getenv("POSTGRES_USER", "taskboard"),
    password=os.getenv("POSTGRES_PASSWORD", "taskboard_dev_pw"),
    database="taskdb"
)

try:
    cur = conn.cursor(cursor_factory=RealDictCursor)
    
    # Get sunset user
    cur.execute("SELECT user_id FROM user_projection WHERE username = %s", ("sunset",))
    user_row = cur.fetchone()
    
    if not user_row:
        print("✗ User 'sunset' not found")
        conn.close()
        exit(1)
    
    sunset_id = user_row['user_id']
    print(f"✓ Found sunset user: {sunset_id}")
    
    # Delete task_assignees
    cur.execute("""
        DELETE FROM task_assignees 
        WHERE task_id IN (
          SELECT id FROM tasks
          WHERE sender_id = %s
            AND title IN ('Muth maro', 'Clean up after muth')
        )
    """, (sunset_id,))
    deleted_assignees = cur.rowcount
    print(f"✓ Deleted {deleted_assignees} assignee records")
    
    # Delete tasks
    cur.execute("""
        DELETE FROM tasks
        WHERE sender_id = %s
          AND title IN ('Muth maro', 'Clean up after muth')
    """, (sunset_id,))
    deleted_tasks = cur.rowcount
    print(f"✓ Deleted {deleted_tasks} tasks")
    
    conn.commit()
    print("✓ Committed changes")
    
finally:
    conn.close()
