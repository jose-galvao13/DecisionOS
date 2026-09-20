import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { EmptyState, JobProgress, Tooltip, ToastProvider, useToast } from "../../src/components/ui";
import { AlertTriangle } from "lucide-react";

describe("EmptyState", () => {
  it("renders title and description", () => {
    render(<EmptyState icon={AlertTriangle} title="Nothing here" desc="Try again later" />);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(screen.getByText("Try again later")).toBeInTheDocument();
  });

  it("renders without a title (desc-only empty/error states used elsewhere in the app)", () => {
    render(<EmptyState desc="No transactions in this period" />);
    expect(screen.getByText("No transactions in this period")).toBeInTheDocument();
  });

  it("renders an optional action", () => {
    render(<EmptyState desc="Empty" action={<button>Retry</button>} />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("JobProgress", () => {
  it("shows the rounded percentage and stage label", () => {
    render(<JobProgress progress={42.6} stage="importing" stageLabels={{ importing: "Importing rows…" }} />);
    expect(screen.getByText("43%")).toBeInTheDocument();
    expect(screen.getByText("Importing rows…")).toBeInTheDocument();
  });

  it("falls back to the raw stage name when no label is supplied", () => {
    render(<JobProgress progress={0} stage="queued" />);
    expect(screen.getByText("queued")).toBeInTheDocument();
  });

  it("clamps the visual bar width between 4% and 100% even at 0", () => {
    const { container } = render(<JobProgress progress={0} stage="queued" />);
    const bar = container.querySelector("div[style*='width']");
    expect(bar.style.width).toBe("4%");
  });
});

describe("Tooltip", () => {
  it("shows its label on hover and hides it on mouse leave", () => {
    render(<Tooltip label="Explains the metric"><span>Hover me</span></Tooltip>);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByText("Hover me").parentElement);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Explains the metric");
    fireEvent.mouseLeave(screen.getByText("Hover me").parentElement);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("uses the theme's tooltip colors (not charcoal/white, which are the same shade in dark mode)", () => {
    render(<Tooltip label="Some explanation"><span>Hover me</span></Tooltip>);
    fireEvent.mouseEnter(screen.getByText("Hover me").parentElement);
    const bubble = screen.getByRole("tooltip");
    expect(bubble.style.background).toContain("--tooltip-bg");
    expect(bubble.style.color).toContain("--tooltip-fg");
  });

  it("wraps long text inside a capped width, rendered in a portal so no parent can clip it", () => {
    const long = "There is not enough variation in this dataset to fit an elasticity from — using a stated assumption (0.65), not a measured one.";
    const { container } = render(<Tooltip label={long}><span>Hover me</span></Tooltip>);
    fireEvent.mouseEnter(screen.getByText("Hover me").parentElement);
    const bubble = screen.getByRole("tooltip");
    expect(container.contains(bubble)).toBe(false); // portalled to <body>
    expect(bubble.style.maxWidth).toContain("288px");
    expect(bubble.className).not.toContain("whitespace-nowrap");
  });
});

function ToastTrigger() {
  const toast = useToast();
  return (
    <>
      <button onClick={() => toast.success("Imported 10 rows", { duration: 30 })}>fire success</button>
      <button onClick={() => toast.error("Import failed")}>fire error</button>
    </>
  );
}

describe("ToastProvider / useToast", () => {
  it("renders a pushed toast and it disappears after its duration", async () => {
    render(
      <ToastProvider>
        <ToastTrigger />
      </ToastProvider>
    );
    fireEvent.click(screen.getByText("fire success"));
    expect(screen.getByText("Imported 10 rows")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Imported 10 rows")).not.toBeInTheDocument(), { timeout: 1000 });
  });

  it("dismisses a toast immediately on click", () => {
    render(
      <ToastProvider>
        <ToastTrigger />
      </ToastProvider>
    );
    fireEvent.click(screen.getByText("fire error"));
    const toastEl = screen.getByText("Import failed");
    fireEvent.click(toastEl);
    expect(screen.queryByText("Import failed")).not.toBeInTheDocument();
  });

  it("useToast throws outside a ToastProvider — fails loudly, not silently", () => {
    const BadComponent = () => {
      useToast();
      return null;
    };
    // Suppress the expected React error boundary console noise for this assertion.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<BadComponent />)).toThrow();
    spy.mockRestore();
  });
});
