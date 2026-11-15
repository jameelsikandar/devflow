-- Disposable database only, after all committed migrations. Fixtures roll back.
BEGIN;
DO $test$
BEGIN
  INSERT INTO "User" (id,name,email,"passwordHash","updatedAt") VALUES ('ai-u','AI schema','ai-schema@example.com','fixture',NOW());
  INSERT INTO "Workspace" (id,name,"updatedAt") VALUES ('ai-w','AI schema',NOW()), ('ai-foreign-w','Other',NOW());
  INSERT INTO "Project" (id,"workspaceId",name,"updatedAt") VALUES ('ai-p','ai-w','Primary',NOW()), ('ai-foreign-p','ai-foreign-w','Other',NOW());
  BEGIN
    INSERT INTO "AIConversation" (id,"workspaceId","userId","projectId",title,"updatedAt") VALUES ('ai-invalid','ai-w','ai-u','ai-foreign-p','Forbidden',NOW());
    RAISE EXCEPTION 'FAIL: cross-workspace conversation project accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  INSERT INTO "AIConversation" (id,"workspaceId","userId","projectId",title,"updatedAt") VALUES ('ai-c','ai-w','ai-u','ai-p','Conversation',NOW());
  INSERT INTO "AIRun" (id,"conversationId","requestId",prompt,"expiresAt") VALUES ('ai-r','ai-c','request','Question',NOW()+INTERVAL '2 minutes');
  BEGIN
    INSERT INTO "AIRun" (id,"conversationId","requestId",prompt,"expiresAt") VALUES ('ai-r-duplicate','ai-c','request','Question',NOW());
    RAISE EXCEPTION 'FAIL: duplicate idempotency key accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  INSERT INTO "AIProposal" (id,"runId",tool,payload,preview,"previewHash","expiresAt") VALUES ('ai-proposal','ai-r','createTask','{}','{}','test-hash',NOW());
  BEGIN
    INSERT INTO "AIRun" (id,"conversationId","requestId",prompt,"expiresAt") VALUES ('ai-parallel','ai-c','different-request','Concurrent',NOW());
    RAISE EXCEPTION 'FAIL: multiple running turns accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    UPDATE "AIProposal" SET status='APPLIED' WHERE id='ai-proposal';
    RAISE EXCEPTION 'FAIL: applied action without receipt accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT status FROM "AIProposal" WHERE id='ai-proposal') <> 'PENDING' THEN RAISE EXCEPTION 'FAIL: proposal default must be pending'; END IF;
  INSERT INTO "Task" (id,"projectId",title,"updatedAt") VALUES ('ai-t','ai-p','Task',NOW()), ('ai-other-t','ai-foreign-p','Other task',NOW());
  INSERT INTO "Sprint" (id,"projectId",name,goal,"startDate","endDate") VALUES ('ai-s','ai-p','Sprint','Goal','2026-11-01','2026-11-14');
  BEGIN
    INSERT INTO "SprintTask" ("projectId","sprintId","taskId","taskVersion","titleSnapshot","statusSnapshot") VALUES ('ai-p','ai-s','ai-other-t',0,'Wrong task','TODO');
    RAISE EXCEPTION 'FAIL: cross-project sprint task accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "Sprint" (id,"projectId",name,goal,"startDate","endDate") VALUES ('ai-bad-s','ai-p','Sprint','Goal','2026-11-14','2026-11-01');
    RAISE EXCEPTION 'FAIL: reversed sprint dates accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO "ProjectReport" (id,"projectId",title,content,"periodStart","periodEnd",source) VALUES ('ai-report','ai-p','Report','Review required','2026-11-01','2026-11-07','{}');
  DELETE FROM "AIConversation" WHERE id='ai-c';
  IF EXISTS(SELECT 1 FROM "AIRun" WHERE id='ai-r') OR EXISTS(SELECT 1 FROM "AIProposal" WHERE id='ai-proposal') THEN RAISE EXCEPTION 'FAIL: AI history cascade'; END IF;
  RAISE NOTICE 'PASS: AI conversation scope FK, request uniqueness, pending defaults, sprint scope/date checks, report persistence and history cascades';
END;
$test$;
ROLLBACK;
