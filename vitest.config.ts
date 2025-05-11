import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        testTimeout: 10000,
        testMatch: ["**/integration/**"], // This will be overridden for unit tests
    },
}); 