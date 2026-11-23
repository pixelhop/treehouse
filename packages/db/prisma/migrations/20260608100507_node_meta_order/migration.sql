-- Add custom per-parent display order to node_meta.
-- "order" is a SQL reserved word, hence the quoting.
ALTER TABLE "node_meta" ADD COLUMN "order" INTEGER;
