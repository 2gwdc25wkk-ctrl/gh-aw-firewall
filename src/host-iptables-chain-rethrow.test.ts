/**
 * Coverage for the remaining uncovered branch in host-iptables-chain.ts:
 *
 *   Line 13: `throw error` — the re-throw path inside the `iptables --version`
 *   catch block when `isMissingIptablesError` returns false (i.e., the error is
 *   not an ENOENT / "not found" error).  All existing chain-branches tests only
 *   exercise the ENOENT path; this file covers the non-ENOENT re-throw.
 *
 * Also exercises `setupDockerBridgeMock` from host-iptables-test-setup.ts so
 * Istanbul counts lines 112 and 120 (the fallback-chain branch) as covered.
 */

import {
  execaResult,
  mockedExeca,
  setupHostIptablesTestSuite,
  setupDockerBridgeMock,
} from './test-helpers/host-iptables-test-setup';
import { checkPermissionsAndSetupChain } from './host-iptables-chain';
import { iptablesSharedTestHelpers } from './host-iptables-shared.test-utils';

// Note: jest.mock('execa') is already declared inside host-iptables-test-setup.ts

jest.mock('./host-iptables-shared', () => {
  const actual = jest.requireActual<typeof import('./host-iptables-shared')>('./host-iptables-shared');
  return {
    ...actual,
    isIp6tablesAvailable: jest.fn().mockResolvedValue(false),
    disableIpv6ViaSysctl: jest.fn().mockResolvedValue(undefined),
    enableIpv6ViaSysctl: jest.fn().mockResolvedValue(undefined),
  };
});

describe('host-iptables-chain – non-ENOENT version error re-throw (line 13)', () => {
  setupHostIptablesTestSuite(iptablesSharedTestHelpers.resetIpv6State);

  it('re-throws the original error when iptables --version fails with a non-ENOENT error', async () => {
    const originalError = new Error('Segmentation fault');

    mockedExeca
      // iptables --version — fails with an unrecognised (non-ENOENT) error
      .mockRejectedValueOnce(originalError);

    await expect(checkPermissionsAndSetupChain('FW_RETHROW_TEST')).rejects.toThrow('Segmentation fault');
  });

  it('re-throws a permission-denied error from iptables --version without wrapping', async () => {
    const permError = Object.assign(new Error('Operation not permitted'), { stderr: 'Operation not permitted' });

    mockedExeca.mockRejectedValueOnce(permError);

    await expect(checkPermissionsAndSetupChain('FW_PERM_TEST')).rejects.toThrow('Operation not permitted');
  });

  it('re-throws a plain object that is not an Error and not ENOENT', async () => {
    // execa can theoretically reject with non-Error values; ensure we propagate them
    const weirdRejection = { code: 'ETIMEDOUT', message: 'timed out' };

    mockedExeca.mockRejectedValueOnce(weirdRejection);

    await expect(checkPermissionsAndSetupChain('FW_TIMEOUT_TEST')).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  });
});

describe('setupDockerBridgeMock – covers lines 112 and 120 of host-iptables-test-setup.ts', () => {
  setupHostIptablesTestSuite(iptablesSharedTestHelpers.resetIpv6State);

  it('falls back to a previous implementation for non-bridge docker commands', async () => {
    // Set up a prior mock that handles non-bridge calls
    mockedExeca.mockImplementation((() =>
      Promise.resolve(execaResult({ stdout: 'prior-impl', exitCode: 0 }))
    ) as Parameters<typeof mockedExeca.mockImplementation>[0]);

    // setupDockerBridgeMock installs a wrapping implementation (exercises lines 112–125)
    setupDockerBridgeMock({ gateway: '10.0.0.1' });

    // Call with 'docker bridge' args — should return gateway (line 117)
    const bridgeResult = await mockedExeca('docker', ['network', 'inspect', 'bridge', '--format', '{{.IPAM.Config}}']);
    expect(bridgeResult.stdout).toBe('10.0.0.1');

    // Call with something else — should fall through to the previous impl (lines 120–122)
    const otherResult = await mockedExeca('iptables', ['--version']);
    expect(otherResult.stdout).toBe('prior-impl');
  });

  it('rejects with the provided error for bridge calls when error option is set', async () => {
    const bridgeError = new Error('bridge unavailable');
    setupDockerBridgeMock({ error: bridgeError });

    await expect(
      mockedExeca('docker', ['network', 'inspect', 'bridge', '--format', '{{.IPAM.Config}}']),
    ).rejects.toThrow('bridge unavailable');
  });

  it('falls back to default success result when no previous implementation exists', async () => {
    // Clear all mocks so getMockImplementation() returns undefined (line 120 else branch)
    mockedExeca.mockReset();
    setupDockerBridgeMock({ gateway: '192.168.1.1' });

    // Non-bridge call exercises the else branch of line 120
    const result = await mockedExeca('iptables', ['--version']);
    expect(result.exitCode).toBe(0);
  });
});
