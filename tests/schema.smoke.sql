-- Run in a disposable database after the migration. Rolls back all data changes.
BEGIN;
DO $test$
DECLARE
  count_records integer;
BEGIN
  INSERT INTO "User" (id,name,email,"passwordHash","updatedAt") VALUES ('smoke-user','Schema smoke','schema-smoke@example.com','scrypt:test-fixture',NOW());
  INSERT INTO "Workspace" (id,name,"updatedAt") VALUES ('smoke-workspace','Schema workspace',NOW());
  INSERT INTO "WorkspaceMember" (id,"workspaceId","userId",role) VALUES ('smoke-member','smoke-workspace','smoke-user','OWNER');
  BEGIN
    INSERT INTO "WorkspaceMember" (id,"workspaceId","userId") VALUES ('duplicate-member','smoke-workspace','smoke-user');
    RAISE EXCEPTION 'FAIL: duplicate workspace membership accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "Project" (id,"workspaceId",name,"updatedAt") VALUES ('invalid-project','missing-workspace','Invalid',NOW());
    RAISE EXCEPTION 'FAIL: project without workspace accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  INSERT INTO "Project" (id,"workspaceId",name,"updatedAt") VALUES ('smoke-project','smoke-workspace','Schema project',NOW());
  INSERT INTO "Label" (id,"workspaceId",name) VALUES ('smoke-label','smoke-workspace','Feature');
  INSERT INTO "Task" (id,"projectId",title,"assigneeId","updatedAt") VALUES ('smoke-task','smoke-project','Verify constraints','smoke-user',NOW());
  IF (SELECT status FROM "Task" WHERE id='smoke-task') <> 'BACKLOG' THEN RAISE EXCEPTION 'FAIL: task default status'; END IF;
  INSERT INTO "TaskLabel" ("taskId","labelId") VALUES ('smoke-task','smoke-label');
  INSERT INTO "TaskComment" (id,"taskId","authorId",body) VALUES ('smoke-comment','smoke-task','smoke-user','Foreign keys work');
  INSERT INTO "TaskActivity" (id,"workspaceId","taskId","actorId",message) VALUES ('smoke-activity','smoke-workspace','smoke-task','smoke-user','created task');
  UPDATE "Task" SET status='IN_PROGRESS',position=1536,version=version+1 WHERE id='smoke-task' AND version=0;
  GET DIAGNOSTICS count_records=ROW_COUNT;
  IF count_records<>1 THEN RAISE EXCEPTION 'FAIL: task move not persisted'; END IF;
  UPDATE "Task" SET status='DONE' WHERE id='smoke-task' AND version=0;
  GET DIAGNOSTICS count_records=ROW_COUNT;
  IF count_records<>0 THEN RAISE EXCEPTION 'FAIL: stale task update accepted'; END IF;
  IF (SELECT position FROM "Task" WHERE id='smoke-task')<>1536 THEN RAISE EXCEPTION 'FAIL: task position'; END IF;
  DELETE FROM "Task" WHERE id='smoke-task';
  IF EXISTS(SELECT 1 FROM "TaskComment" WHERE "taskId"='smoke-task') THEN RAISE EXCEPTION 'FAIL: comment cascade'; END IF;
  IF EXISTS(SELECT 1 FROM "TaskLabel" WHERE "taskId"='smoke-task') THEN RAISE EXCEPTION 'FAIL: label cascade'; END IF;
  IF (SELECT "taskId" FROM "TaskActivity" WHERE id='smoke-activity') IS NOT NULL THEN RAISE EXCEPTION 'FAIL: activity should retain history with null task'; END IF;
  DELETE FROM "Workspace" WHERE id='smoke-workspace';
  IF EXISTS(SELECT 1 FROM "Project" WHERE id='smoke-project') THEN RAISE EXCEPTION 'FAIL: project cascade'; END IF;
  IF EXISTS(SELECT 1 FROM "WorkspaceMember" WHERE id='smoke-member') THEN RAISE EXCEPTION 'FAIL: membership cascade'; END IF;
  IF EXISTS(SELECT 1 FROM "Label" WHERE id='smoke-label') THEN RAISE EXCEPTION 'FAIL: workspace label cascade'; END IF;
  RAISE NOTICE 'PASS: membership uniqueness, project FK, defaults, task movement, stale writes, comment/label/project/member cascades, retained task history';
END;
$test$;
ROLLBACK;
