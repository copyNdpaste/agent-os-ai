import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
        exclude: ['node_modules', 'out', '.vscode-test', '.venv'],
        environment: 'node',
        testTimeout: 10_000,
    },
});
