"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("vitest/config");
exports.default = (0, config_1.defineConfig)({
    test: {
        testTimeout: 10000,
        testMatch: ["**/integration/**"], // This will be overridden for unit tests
    },
});
