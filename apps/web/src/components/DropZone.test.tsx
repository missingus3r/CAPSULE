import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { DropZone } from "./DropZone";

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nProvider>{ui}</I18nProvider>);
}

describe("DropZone", () => {
  beforeEach(() => {
    // The provider reads a stored preference first, so the assertions below
    // are about English rather than about whatever language the test host runs
    // in.
    window.localStorage.setItem("capsule.locale", "en");
  });

  it("lets a person choose one file", async () => {
    const user = userEvent.setup();
    const onFile = vi.fn();
    renderWithI18n(<DropZone file={null} onFile={onFile} />);

    const file = new File(["contents"], "keepsake.txt", {
      type: "text/plain",
    });
    await user.upload(screen.getByLabelText(/Choose a file/u), file);

    expect(onFile).toHaveBeenCalledWith(file);
  });

  it("shows the selected file and can remove it", async () => {
    const user = userEvent.setup();
    const onFile = vi.fn();
    const file = new File(["contents"], "keepsake.txt", {
      type: "text/plain",
    });
    renderWithI18n(<DropZone file={file} onFile={onFile} />);

    expect(screen.getByText("keepsake.txt")).toBeInTheDocument();
    expect(screen.getByText(/Plain text/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove file" }));
    expect(onFile).toHaveBeenCalledWith(null);
  });

  it("follows the chosen language", async () => {
    window.localStorage.setItem("capsule.locale", "pt");
    const onFile = vi.fn();
    renderWithI18n(<DropZone file={null} onFile={onFile} />);

    expect(screen.getByText("Escolha um arquivo")).toBeInTheDocument();
  });
});
