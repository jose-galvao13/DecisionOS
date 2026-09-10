import { describe, it, expect, vi, beforeEach } from "vitest";

const queryMock = vi.fn();
vi.mock("../../src/db/pool.js", () => ({ pool: { query: (...args) => queryMock(...args) } }));
vi.mock("../../src/audit/auditLog.js", () => ({ writeAudit: vi.fn(async () => {}) }));

import { createAction, listActions, updateAction, deleteAction, ActionError } from "../../src/services/decisionActions.js";

function actionRow(overrides = {}) {
  return {
    id: "act-1", decision_id: "dec-1", org_id: "org-A", title: "Enviar email aos clientes",
    owner_id: null, status: "todo", due_date: null, completed_at: null,
    created_by: "u1", created_at: new Date(), updated_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => queryMock.mockReset());

describe("createAction", () => {
  it("requires a title", async () => {
    await expect(createAction("org-A", "dec-1", "u1", {})).rejects.toThrow(ActionError);
  });

  it("404s if the decision doesn't belong to this org", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }); // assertDecisionInOrg
    const err = await createAction("org-A", "dec-1", "u1", { title: "X" }).catch((e) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect(err.status).toBe(404);
  });

  it("validates ownerId belongs to this org before inserting", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: "dec-1" }] }); // assertDecisionInOrg
    queryMock.mockResolvedValueOnce({ rows: [] }); // ownerId lookup — not found
    await expect(
      createAction("org-A", "dec-1", "u1", { title: "X", ownerId: "not-in-org" })
    ).rejects.toThrow(/ownerId must be a user/);
  });

  it("inserts and returns the new action", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: "dec-1" }] }); // assertDecisionInOrg
    queryMock.mockResolvedValueOnce({ rows: [{ id: "u2" }] }); // ownerId lookup ok
    queryMock.mockResolvedValueOnce({ rows: [actionRow({ owner_id: "u2" })] }); // insert
    const a = await createAction("org-A", "dec-1", "u1", { title: "Enviar email aos clientes", ownerId: "u2" });
    expect(a.id).toBe("act-1");
    expect(a.owner_id).toBe("u2");
  });
});

describe("listActions", () => {
  it("404s if the decision doesn't belong to this org", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(listActions("org-A", "dec-1")).rejects.toThrow(ActionError);
  });

  it("returns actions ordered by created_at", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: "dec-1" }] }); // assertDecisionInOrg
    queryMock.mockResolvedValueOnce({ rows: [actionRow(), actionRow({ id: "act-2" })] });
    const list = await listActions("org-A", "dec-1");
    expect(list).toHaveLength(2);
  });
});

describe("updateAction", () => {
  it("rejects an invalid status", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: "dec-1" }] }); // assertDecisionInOrg
    queryMock.mockResolvedValueOnce({ rows: [actionRow()] }); // existing lookup
    await expect(updateAction("org-A", "dec-1", "act-1", "u1", { status: "wontfix" })).rejects.toThrow(/status must be one of/);
  });

  it("404s when the action doesn't exist for this decision/org", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: "dec-1" }] }); // assertDecisionInOrg
    queryMock.mockResolvedValueOnce({ rows: [] }); // existing lookup — nothing
    const err = await updateAction("org-A", "dec-1", "nope", "u1", { status: "done" }).catch((e) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect(err.status).toBe(404);
  });

  it("sets completed_at when moving to 'done', and clears it when moving away from 'done'", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: "dec-1" }] }); // assertDecisionInOrg
    queryMock.mockResolvedValueOnce({ rows: [actionRow({ status: "todo", completed_at: null })] }); // existing
    queryMock.mockResolvedValueOnce({ rows: [actionRow({ status: "done" })] }); // update
    await updateAction("org-A", "dec-1", "act-1", "u1", { status: "done" });
    const [, params] = queryMock.mock.calls[2]; // 0: assertDecisionInOrg, 1: existing lookup, 2: UPDATE
    expect(params[7]).toBeInstanceOf(Date); // completedAt bound param
  });
});

describe("deleteAction", () => {
  it("404s when nothing is deleted", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: "dec-1" }] }); // assertDecisionInOrg
    queryMock.mockResolvedValueOnce({ rows: [] }); // delete — nothing matched
    await expect(deleteAction("org-A", "dec-1", "act-1", "u1")).rejects.toThrow(ActionError);
  });

  it("deletes and returns the removed row", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: "dec-1" }] }); // assertDecisionInOrg
    queryMock.mockResolvedValueOnce({ rows: [actionRow()] }); // delete
    const deleted = await deleteAction("org-A", "dec-1", "act-1", "u1");
    expect(deleted.id).toBe("act-1");
  });
});
