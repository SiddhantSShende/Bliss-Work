#!/bin/bash
# Delete tasks using the internal management endpoint

# Load environment
set -a
source /home/ubuntu/BlissWork/Bliss-Work/.env
set +a

TASK_BASE="${TB_TASK:-http://localhost:8002}"
INTERNAL_TOKEN="${TB_INTERNAL_TOKEN:-dev-internal-token}"

echo "Deleting tasks from: $TASK_BASE"
echo "Using internal token: $INTERNAL_TOKEN"

# Delete "Muth maro"
echo "Deleting task: 'Muth maro'"
curl -X DELETE "$TASK_BASE/api/v1/internal/tasks/by-title/Muth%20maro?username=sunset" \
  -H "X-Internal-Token: $INTERNAL_TOKEN" \
  -H "Content-Type: application/json" \
  -v

echo ""
echo "Deleting task: 'Clean up after muth'"
curl -X DELETE "$TASK_BASE/api/v1/internal/tasks/by-title/Clean%20up%20after%20muth?username=sunset" \
  -H "X-Internal-Token: $INTERNAL_TOKEN" \
  -H "Content-Type: application/json" \
  -v

echo ""
echo "✓ Deletion requests sent"
