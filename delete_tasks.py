#!/usr/bin/env python3
"""
Delete specific tasks from the taskdb database.
Deletes "Muth maro" and "Clean up after muth" tasks created by "sunset" user.
"""

import asyncio
import os
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy import text, select
from sqlalchemy.orm import sessionmaker

# Database configuration from environment
DB_HOST = os.getenv("POSTGRES_HOST", "localhost")
DB_PORT = os.getenv("POSTGRES_PORT", "5432")
DB_USER = os.getenv("POSTGRES_USER", "taskboard")
DB_PASSWORD = os.getenv("POSTGRES_PASSWORD", "taskboard_dev_pw")
DB_NAME = "taskdb"

DATABASE_URL = f"postgresql+asyncpg://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}"

async def main():
    """Delete the specified tasks."""
    engine = create_async_engine(DATABASE_URL, echo=True)
    
    async with engine.begin() as conn:
        # First, find the user_id for "sunset"
        result = await conn.execute(
            text("SELECT user_id FROM user_projection WHERE username = 'sunset'")
        )
        user_row = result.first()
        
        if not user_row:
            print("User 'sunset' not found in user_projection table")
            await engine.dispose()
            return
        
        sunset_user_id = str(user_row[0])
        print(f"Found sunset user_id: {sunset_user_id}")
        
        # Delete task_assignees first (foreign key constraint)
        result = await conn.execute(
            text(
                """
                DELETE FROM task_assignees 
                WHERE task_id IN (
                  SELECT id FROM tasks
                  WHERE sender_id = :user_id
                    AND title IN ('Muth maro', 'Clean up after muth')
                )
                """
            ),
            {"user_id": sunset_user_id},
        )
        print(f"Deleted {result.rowcount} assignee records")
        
        # Delete tasks
        result = await conn.execute(
            text(
                """
                DELETE FROM tasks
                WHERE sender_id = :user_id
                  AND title IN ('Muth maro', 'Clean up after muth')
                """
            ),
            {"user_id": sunset_user_id},
        )
        print(f"Deleted {result.rowcount} task records")
        
        # Clean up outbox events
        result = await conn.execute(
            text(
                """
                DELETE FROM outbox
                WHERE kafka_key IN (
                  SELECT id::text FROM tasks
                  WHERE sender_id = :user_id
                    AND title IN ('Muth maro', 'Clean up after muth')
                )
                """
            ),
            {"user_id": sunset_user_id},
        )
        print(f"Cleaned up {result.rowcount} outbox records")
        
    await engine.dispose()
    print("✓ Deletion complete!")

if __name__ == "__main__":
    asyncio.run(main())
