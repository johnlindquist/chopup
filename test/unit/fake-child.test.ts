import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeChildProcess } from '../../test/doubles/fake-child'; // Updated path
import { PassThrough } from 'node:stream'; // Actual class for instanceof
import type { PassThrough as PassThroughType } from 'node:stream'; // Type for clarity if needed elsewhere

describe('FakeChildProcess', () => {
    it('should initialize with a random PID if not provided', () => {
        const child = new FakeChildProcess();
        expect(child.pid).toBeGreaterThanOrEqual(1000);
        expect(child.pid).toBeLessThanOrEqual(11000); // Default Math.random()*10000 + 1000
    });

    it('should initialize with a specific PID if provided', () => {
        const specificPid = 12345;
        const child = new FakeChildProcess({ pid: specificPid });
        expect(child.pid).toBe(specificPid);
    });

    it('should have writable stdin, readable stdout, and readable stderr streams', () => {
        const child = new FakeChildProcess();
        expect(child.stdin).toBeInstanceOf(PassThrough);
        expect(child.stdout).toBeInstanceOf(PassThrough);
        expect(child.stderr).toBeInstanceOf(PassThrough);
        expect(child.stdin.writable).toBe(true);
        expect(child.stdout.readable).toBe(true);
        expect(child.stderr.readable).toBe(true);
    });

    it('should allow writing to stdout and data to be read', () => {
        const child = new FakeChildProcess();
        const testData = 'hello stdout';
        return new Promise<void>((resolve) => {
            child.stdout.on('data', (chunk) => {
                expect(chunk.toString()).toBe(testData);
                resolve();
            });
            child.writeToStdout(testData);
        });
    });

    it('should allow writing to stderr and data to be read', () => {
        const child = new FakeChildProcess();
        const testData = 'hello stderr';
        return new Promise<void>((resolve) => {
            child.stderr.on('data', (chunk) => {
                expect(chunk.toString()).toBe(testData);
                resolve();
            });
            child.writeToStderr(testData);
        });
    });

    it('should emit "exit" and "close" events with code and signal when exit() is called', async () => {
        const child = new FakeChildProcess();
        const exitCallback = vi.fn();
        const closeCallback = vi.fn();
        child.on('exit', exitCallback);
        child.on('close', closeCallback);

        const exitCode = 1;
        const signal = 'SIGINT';
        await child.exit(exitCode, signal);

        expect(exitCallback).toHaveBeenCalledWith(exitCode, signal);
        expect(closeCallback).toHaveBeenCalledWith(exitCode, signal);
        expect(child.connected).toBe(false);
        expect(child.killed).toBe(true);
    });

    it('exit() should end stdout and stderr streams', async () => {
        const child = new FakeChildProcess();
        child.writeToStdout('some data'); // Ensure there's data to end
        child.writeToStderr('some error data');

        const stdoutEndPromise = new Promise<void>(resolve => child.stdout.once('end', resolve));
        const stderrEndPromise = new Promise<void>(resolve => child.stderr.once('end', resolve));

        // Pipe to dummy consumers to allow 'end' event to fire
        child.stdout.pipe(new PassThrough());
        child.stderr.pipe(new PassThrough());

        await child.exit();

        await Promise.all([stdoutEndPromise, stderrEndPromise]);

        expect(child.stdout.readableEnded).toBe(true);
        expect(child.stderr.readableEnded).toBe(true);
    });

    it('kill() should call exit with appropriate signal and emit "exit" and "close"', async () => {
        const child = new FakeChildProcess();
        const exitCallback = vi.fn();
        const closeCallback = vi.fn();
        child.on('exit', exitCallback);
        child.on('close', closeCallback);

        await child.kill('SIGTERM');

        expect(exitCallback).toHaveBeenCalledWith(null, 'SIGTERM');
        expect(closeCallback).toHaveBeenCalledWith(null, 'SIGTERM');
        expect(child.killed).toBe(true);

        const child2 = new FakeChildProcess();
        const exitCb2 = vi.fn();
        child2.on('exit', exitCb2)
        await child2.kill();
        expect(exitCb2).toHaveBeenCalledWith(null, 'SIGTERM');
    });

    it('kill() should return true if process was killed, false if already killed', async () => {
        const child = new FakeChildProcess();
        expect(await child.kill()).toBe(true);
        expect(await child.kill()).toBe(false);
    });

    it('disconnect() should emit "disconnect" event and set connected to false', () => {
        const child = new FakeChildProcess();
        const disconnectCallback = vi.fn();
        child.on('disconnect', disconnectCallback);

        child.disconnect();
        expect(disconnectCallback).toHaveBeenCalled();
        expect(child.connected).toBe(false);
    });

    it('disconnect() should do nothing if already disconnected', () => {
        const child = new FakeChildProcess();
        child.disconnect(); // first call

        const disconnectCallback = vi.fn();
        child.on('disconnect', disconnectCallback);
        child.disconnect(); // second call

        expect(disconnectCallback).not.toHaveBeenCalled();
    });

    it('getStdinContent() should resolve with content written to stdin', async () => {
        const child = new FakeChildProcess();
        const testInput = "hello stdin test";
        child.stdin.write(testInput);
        child.stdin.end();

        const content = await child.getStdinContent();
        expect(content).toBe(testInput);
    });

    it('getStdinContent() should resolve with empty string if nothing written to stdin', async () => {
        const child = new FakeChildProcess();
        child.stdin.end(); // End stdin without writing

        const content = await child.getStdinContent();
        expect(content).toBe('');
    });

    it('should remove all listeners after exit', async () => {
        const child = new FakeChildProcess();
        const exitHandler = vi.fn();
        const closeHandler = vi.fn();
        const customHandler = vi.fn();

        child.on('exit', exitHandler);
        child.on('close', closeHandler);
        child.on('custom', customHandler);

        await child.exit(0);

        expect(child.listenerCount('exit')).toBe(0);
        expect(child.listenerCount('close')).toBe(0);
        expect(child.listenerCount('custom')).toBe(0);
    });
}); 