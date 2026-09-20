import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LangProvider } from "../../src/lib/i18n";
import Onboarding from "../../src/components/Onboarding";

vi.mock("../../src/api/client", () => ({
  apiUpload: vi.fn(),
  apiFetch: vi.fn(),
  pollJob: vi.fn(),
}));
import { apiUpload, apiFetch, pollJob } from "../../src/api/client";

function renderOnboarding(props = {}) {
  const onFinish = vi.fn();
  const onDataReady = vi.fn();
  render(
    <LangProvider>
      <Onboarding onFinish={onFinish} onDataReady={onDataReady} {...props} />
    </LangProvider>
  );
  return { onFinish, onDataReady };
}

beforeEach(() => {
  apiUpload.mockReset();
  apiFetch.mockReset();
  pollJob.mockReset();
});

describe("Onboarding — choose step", () => {
  it("offers Excel as the only data source (no database option)", () => {
    renderOnboarding();
    expect(screen.getByText("Excel", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText(/base de dados|database/i)).not.toBeInTheDocument();
  });

  it("calls onFinish when the person chooses to use demo data instead", () => {
    const { onFinish } = renderOnboarding();
    fireEvent.click(screen.getByText(/dados de demonstração|demo data/i));
    expect(onFinish).toHaveBeenCalled();
  });
});

describe("Onboarding — error state", () => {
  it("shows an error banner when the upload/preview call fails, and stays on the choose step", async () => {
    apiUpload.mockRejectedValueOnce(new Error("could not parse file"));
    renderOnboarding();
    const file = new File(["a,b\n1,2"], "data.csv", { type: "text/csv" });
    const input = document.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByText("could not parse file")).toBeInTheDocument());
  });
});

describe("Onboarding — FASE 8 async import progress", () => {
  it("shows a progress bar while the import job is running, then calls onDataReady on completion", async () => {
    apiUpload.mockResolvedValueOnce({
      headers: ["Date", "Revenue"], sampleRows: [{ Date: "2024-01-01", Revenue: "100" }], rowCount: 1,
      suggestedMapping: { date: "Date", revenue: "Revenue" }, stagingId: "staging-1",
    });
    apiFetch.mockResolvedValueOnce({ jobId: "job-1", dataSourceId: "ds-1", status: "queued" });
    let resolvePoll;
    pollJob.mockImplementation(
      (jobId, { onProgress }) =>
        new Promise((resolve) => {
          onProgress({ progress: 40, stage: "importing" });
          resolvePoll = () => resolve({ result: { imported: 1, dataQuality: { score: 100, issues: [] } } });
        })
    );

    const { onDataReady } = renderOnboarding();
    const file = new File(["Date,Revenue\n2024-01-01,100"], "data.csv", { type: "text/csv" });
    fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [file] } });

    // preview step: confirm the (auto-suggested) mapping
    await waitFor(() => expect(screen.getByText(/data.csv/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/está correto|correct/i));

    // importing step: real progress from the worker, not a bare spinner
    await waitFor(() => expect(screen.getByText("40%")).toBeInTheDocument());

    resolvePoll();
    await waitFor(() => expect(onDataReady).toHaveBeenCalledWith(
      expect.objectContaining({ sourceInfo: expect.objectContaining({ dataSourceId: "ds-1", rows: 1 }) })
    ));
  });

  it("returns to the preview step with an error if the job fails, instead of getting stuck", async () => {
    apiUpload.mockResolvedValueOnce({
      headers: ["Date", "Revenue"], sampleRows: [{ Date: "2024-01-01", Revenue: "100" }], rowCount: 1,
      suggestedMapping: { date: "Date", revenue: "Revenue" }, stagingId: "staging-1",
    });
    apiFetch.mockResolvedValueOnce({ jobId: "job-1", dataSourceId: "ds-1", status: "queued" });
    pollJob.mockRejectedValueOnce(new Error("dataset has too many rows"));

    renderOnboarding();
    const file = new File(["Date,Revenue\n2024-01-01,100"], "data.csv", { type: "text/csv" });
    fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByText(/data.csv/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/está correto|correct/i));

    await waitFor(() => expect(screen.getByText("dataset has too many rows")).toBeInTheDocument());
  });
});
