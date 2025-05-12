import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import type { Mocked } from 'vitest';
import { Chopup, LOGS_CHOPPED, SEND_INPUT_COMMAND, REQUEST_LOGS_COMMAND, INPUT_SENT, INPUT_SEND_ERROR, INPUT_SEND_ERROR_NO_CHILD } from '../../src/chopup';
import type { SpawnFunction } from '../../src/chopup';
import { createServer, createConnection, resetMockIpc } from '../../test/doubles/ipc-mock';
import type { IMockServer } from '../../test/doubles/ipc-mock';
import { FakeChildProcess } from '../../test/doubles/fake-child';
import fs from 'node:fs/promises';
import type { PathLike } from 'node:fs';
import type { MakeDirectoryOptions, Mode } from 'node:fs';

const TEST_SOCKET_PATH = '/tmp/test-chopup-core.sock';
const TEST_LOG_DIR = '/tmp/test-chopup-logs';

let writeFileSpy: Mocked<typeof fs.writeFile>;
let mkdirSpy: Mocked<typeof fs.mkdir>;

function makeChopupWithMocks(fakeChild?: FakeChildProcess) {
    // Use IPC mock for net, and fake child for spawn
    const spawnFn = () => fakeChild || new FakeChildProcess();
    const netModule = { createServer };
    return new Chopup('echo', ['ok'], TEST_LOG_DIR, TEST_SOCKET_PATH, spawnFn as SpawnFunction, netModule);
}

describe('Chopup core logic', () => {
    let chopup: Chopup;
    let fakeChild: FakeChildProcess;

    beforeEach(() => {
        resetMockIpc();
        writeFileSpy = vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
        mkdirSpy = vi.spyOn(fs, 'mkdir').mockResolvedValue(TEST_LOG_DIR);
        fakeChild = new FakeChildProcess();
        chopup = makeChopupWithMocks(fakeChild);
    });

    afterEach(() => {
        resetMockIpc();
        vi.clearAllMocks();
    });

    afterAll(() => {
        vi.restoreAllMocks();
    });

    it('chopLog creates a file and resets buffer', async () => {
        const coreChopup = chopup as Chopup & { logBuffer: any[] };
        coreChopup.logBuffer = [
            { timestamp: Date.now(), type: 'stdout', line: 'line1\n' },
            { timestamp: Date.now(), type: 'stderr', line: 'line2\n' },
        ];
        await coreChopup.chopLog();
        expect(writeFileSpy).toHaveBeenCalledTimes(1);
        expect(coreChopup.logBuffer).toEqual([]);
    });

    it('send-input handler writes to child stdin and responds', async () => {
        await chopup.run();
        const server = (chopup as any).ipcServer as IMockServer;
        if (!server._listeningPath) {
            await new Promise<void>(resolve => server.once('listening', resolve));
        }

        const client = createConnection(TEST_SOCKET_PATH);
        await new Promise<void>(resolve => client.once('connect', resolve));
        const responsePromise = new Promise<string>(resolve => {
            client.on('data', data => resolve(data.toString()));
        });
        client.write(JSON.stringify({ command: SEND_INPUT_COMMAND, input: 'abc' }));
        const response = await Promise.race([
            responsePromise,
            new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]);
        expect(response).toBe(INPUT_SENT);
        fakeChild.stdin.end();
        const stdinContent = await fakeChild.getStdinContent();
        expect(stdinContent).toContain('abc');
        client.destroy();
    }, 10000);

    it('request-logs command triggers chopLog and responds', async () => {
        await chopup.run();
        const coreChopup = chopup as Chopup & { logBuffer: any[] };
        coreChopup.logBuffer.push({ timestamp: Date.now(), type: 'stdout', line: 'test log entry\n' });
        const server = (chopup as any).ipcServer as IMockServer;
        if (!server._listeningPath) {
            await new Promise<void>(resolve => server.once('listening', resolve));
        }

        const client = createConnection(TEST_SOCKET_PATH);
        await new Promise<void>(resolve => client.once('connect', resolve));
        const responsePromise = new Promise<string>(resolve => {
            client.on('data', data => resolve(data.toString()));
        });
        client.write(JSON.stringify({ command: REQUEST_LOGS_COMMAND }));
        const response = await Promise.race([
            responsePromise,
            new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]);
        expect(response).toBe(LOGS_CHOPPED);
        expect(writeFileSpy).toHaveBeenCalled();
        client.destroy();
    }, 10000);

    it('send-input returns error if no child process', async () => {
        await chopup.run();
        (chopup as any).childProcess = null;
        const server = (chopup as any).ipcServer as IMockServer;
        if (!server._listeningPath) {
            await new Promise<void>(resolve => server.once('listening', resolve));
        }

        const client = createConnection(TEST_SOCKET_PATH);
        await new Promise<void>(resolve => client.once('connect', resolve));
        const responsePromise = new Promise<string>(resolve => {
            client.on('data', data => resolve(data.toString()));
        });
        client.write(JSON.stringify({ command: SEND_INPUT_COMMAND, input: 'abc' }));
        const response = await Promise.race([
            responsePromise,
            new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]);
        expect(response).toBe(INPUT_SEND_ERROR_NO_CHILD);
        client.destroy();
    }, 10000);
}); 