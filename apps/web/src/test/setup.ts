import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest runs without globals here, so Testing Library's own auto-cleanup
// never installs itself: without this, one test's tree is still in the
// document while the next one queries it.
afterEach(() => {
  cleanup();
});
