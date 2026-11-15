-- Run in a disposable database after both migrations. All fixtures roll back.
BEGIN;
DO $test$
BEGIN
  INSERT INTO "Workspace" (id,name,"updatedAt") VALUES ('roadmap-w','Roadmap checks',NOW());
  INSERT INTO "Project" (id,"workspaceId",name,"updatedAt") VALUES ('roadmap-p','roadmap-w','Primary',NOW()), ('roadmap-other','roadmap-w','Other',NOW());
  INSERT INTO "Task" (id,"projectId",title,"updatedAt") VALUES ('roadmap-a','roadmap-p','A',NOW()), ('roadmap-b','roadmap-p','B',NOW()), ('roadmap-c','roadmap-other','C',NOW());
  IF (SELECT "startDate" IS NOT NULL OR "isMilestone" FROM "Task" WHERE id='roadmap-a') THEN RAISE EXCEPTION 'FAIL: legacy task defaults'; END IF;
  BEGIN
    UPDATE "Task" SET "startDate"='2026-11-03', "dueDate"='2026-11-01' WHERE id='roadmap-a';
    RAISE EXCEPTION 'FAIL: reversed dates accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "Task" SET "isMilestone"=true WHERE id='roadmap-a';
    RAISE EXCEPTION 'FAIL: milestone without dates accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE "Task" SET "isMilestone"=true, "startDate"='2026-11-03 00:00:00', "dueDate"='2026-11-03 23:59:59' WHERE id='roadmap-a';
  BEGIN
    INSERT INTO "TaskDependency" ("projectId","predecessorId","successorId") VALUES ('roadmap-p','roadmap-a','roadmap-a');
    RAISE EXCEPTION 'FAIL: self-edge accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "TaskDependency" ("projectId","predecessorId","successorId") VALUES ('roadmap-p','roadmap-a','roadmap-c');
    RAISE EXCEPTION 'FAIL: cross-project dependency accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  INSERT INTO "TaskDependency" ("projectId","predecessorId","successorId") VALUES ('roadmap-p','roadmap-a','roadmap-b');
  BEGIN
    INSERT INTO "TaskDependency" ("projectId","predecessorId","successorId") VALUES ('roadmap-p','roadmap-a','roadmap-b');
    RAISE EXCEPTION 'FAIL: duplicate dependency accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  DELETE FROM "Task" WHERE id='roadmap-a';
  IF EXISTS(SELECT 1 FROM "TaskDependency" WHERE "projectId"='roadmap-p') THEN RAISE EXCEPTION 'FAIL: dependency cascade'; END IF;
  RAISE NOTICE 'PASS: roadmap defaults, date constraints, milestones, self-edge/cross-project/duplicate rejection, dependency cascade';
END;
$test$;
ROLLBACK;
