import { describe, it, expect, vi, beforeEach } from "vitest";

const queryMock = vi.fn();
vi.mock("../../src/db/pool.js", () => ({
  pool: { query: (...args) => queryMock(...args) },
}));

import {
  enqueueJob, claimNextJob, updateJobProgress, completeJob, failJob, getJob, listJobsForSource,
} from "../../src/services/jobQueue.js";

describe("jobQueue", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("enqueueJob inserts a queued job scoped to the org", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: "job-1", status: "queued" }] });
    const job = await enqueueJob({ orgId: "org-1", dataSourceId: "ds-1", type: "import_excel", payload: { a: 1 } });
    expect(job.status).toBe("queued");
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO jobs/);
    expect(params).toContain("org-1");
    expect(params).toContain("ds-1");
    expect(params).toContain("import_excel");
  });

  it("claimNextJob uses FOR UPDATE SKIP LOCKED so two workers can't claim the same job", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: "job-1", status: "running" }] });
    const job = await claimNextJob();
    expect(job.status).toBe("running");
    expect(queryMock.mock.calls[0][0]).toMatch(/FOR UPDATE SKIP LOCKED/);
  });

  it("claimNextJob returns null when the queue is empty", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await claimNextJob()).toBeNull();
  });

  it("getJob is tenant-scoped — passes both id and orgId to the query", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: "job-1", org_id: "org-1" }] });
    await getJob("job-1", "org-1");
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/WHERE id = \$1 AND org_id = \$2/);
    expect(params).toEqual(["job-1", "org-1"]);
  });

  it("getJob returns null when no row matches (wrong org can't read another org's job)", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await getJob("job-1", "some-other-org")).toBeNull();
  });

  it("completeJob and failJob write terminal status", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await completeJob("job-1", { imported: 10 });
    expect(queryMock.mock.calls[0][0]).toMatch(/status = 'completed'/);

    queryMock.mockResolvedValueOnce({ rows: [] });
    await failJob("job-1", new Error("boom"));
    const [sql, params] = queryMock.mock.calls[1];
    expect(sql).toMatch(/status = 'failed'/);
    expect(params).toContain("boom");
  });

  it("updateJobProgress writes stage and progress", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await updateJobProgress("job-1", { stage: "importing", progress: 42 });
    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual(["job-1", "importing", 42]);
  });

  it("listJobsForSource clamps limit to a sane maximum and is tenant-scoped", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: "job-1" }] });
    queryMock.mockResolvedValueOnce({ rows: [{ count: "1" }] });
    const { jobs, total, limit } = await listJobsForSource("org-1", "ds-1", { limit: 9999, offset: -5 });
    expect(limit).toBeLessThanOrEqual(100);
    expect(jobs).toHaveLength(1);
    expect(total).toBe(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(params[0]).toBe("org-1");
    expect(params[1]).toBe("ds-1");
    expect(params[3]).toBe(0); // negative offset clamped to 0
  });
});
