ALTER TABLE "project_ops" ADD COLUMN "request_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "project_ops_project_id_request_id_unique" ON "project_ops" USING btree ("project_id","request_id");