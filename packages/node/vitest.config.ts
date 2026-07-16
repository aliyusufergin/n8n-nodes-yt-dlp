import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    exclude: ["dist/**", "node_modules/**"],
  },
});
