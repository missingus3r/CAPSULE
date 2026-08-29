import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DropZone } from "./DropZone";

describe("DropZone", () => {
  it("lets a person choose one file", async () => {
    const user = userEvent.setup();
    const onFile = vi.fn();
    render(<DropZone file={null} onFile={onFile} />);

    const file = new File(["contenido"], "recuerdo.txt", {
      type: "text/plain",
    });
    await user.upload(screen.getByLabelText(/Elegí un archivo/u), file);

    expect(onFile).toHaveBeenCalledWith(file);
  });

  it("shows the selected file and can remove it", async () => {
    const user = userEvent.setup();
    const onFile = vi.fn();
    const file = new File(["contenido"], "recuerdo.txt", {
      type: "text/plain",
    });
    render(<DropZone file={file} onFile={onFile} />);

    expect(screen.getByText("recuerdo.txt")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Quitar archivo" }));
    expect(onFile).toHaveBeenCalledWith(null);
  });
});
