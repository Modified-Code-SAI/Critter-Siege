import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@critter/shared": path.resolve(__dirname, "shared/src/index.ts"),
    },
  },
  test: {
    include: [
      "shared/test/**/*.test.ts",
      "server/test/**/*.test.ts",
      "client/test/**/*.test.ts",
    ],
    environment: "node",
    testTimeout: 30000,
  },
});
