-- 490_work_teardown: drop the v1 work-plane schema (orun-work v1 scrapped).
--
-- Context: work
-- Epic: orun-work (v2 supersedes v1) — the v1 work plane (200_work_foundation:
--       event-sourced Initiatives/Epics/Tasks with a stored status projection)
--       was scrapped before any product surface consumed it. Its library code
--       (@saas/db/work) is removed in the same change; this migration drops
--       the schema it owned. The v1 spec is archived in the orun repo at
--       specs/archive/orun-work-v1/; the v2 design (two append-only logs,
--       lifecycle as a derived query, no stored status) lands its own schema
--       under fresh migrations when implementation starts (see the orun repo,
--       specs/orun-work/, and specs/epics/orun-work/ here).
--
-- Safety: the schema has no consumers — no api-edge route, worker, SDK, or
-- console surface ever read or wrote these tables; they hold no production
-- data beyond test fixtures. DROP ... CASCADE is therefore safe.

DROP SCHEMA IF EXISTS work CASCADE;
