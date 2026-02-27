import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      include: ["src/**/*.ts"],
      exclude: [".claude/**", "src/index.tsx", "src/app.tsx", "src/bot.tsx", "src/onboard.tsx"],
    },
  },
});
