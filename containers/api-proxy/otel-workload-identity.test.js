'use strict';

const mockInitialize = jest.fn().mockResolvedValue(undefined);
const mockGetToken = jest.fn().mockReturnValue('exchanged-token');
const mockShutdown = jest.fn();
const mockGcpOidcTokenProvider = jest.fn().mockImplementation(() => ({
  initialize: mockInitialize,
  getToken: mockGetToken,
  shutdown: mockShutdown,
}));

jest.mock('./gcp-oidc-token-provider', () => ({ GcpOidcTokenProvider: mockGcpOidcTokenProvider }));

const { createOtlpWorkloadIdentity } = require('./otel-workload-identity');

describe('createOtlpWorkloadIdentity', () => {
  const savedEnv = {
    requestUrl: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
    requestToken: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockInitialize.mockResolvedValue(undefined);
    mockGetToken.mockReturnValue('exchanged-token');
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://oidc.example/token';
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'runtime-token';
  });

  afterAll(() => {
    if (savedEnv.requestUrl === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    else process.env.ACTIONS_ID_TOKEN_REQUEST_URL = savedEnv.requestUrl;
    if (savedEnv.requestToken === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    else process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = savedEnv.requestToken;
  });

  it('uses GCP WIF and service account impersonation for OTLP authorization', async () => {
    const identity = createOtlpWorkloadIdentity(JSON.stringify({
      provider: 'gcp',
      audience: 'projects/123/locations/global/workloadIdentityPools/pool/providers/github',
      'service-account': 'telemetry@example.iam.gserviceaccount.com',
    }));

    expect(mockGcpOidcTokenProvider).toHaveBeenCalledWith({
      requestUrl: 'https://oidc.example/token',
      requestToken: 'runtime-token',
      workloadIdentityProvider: 'projects/123/locations/global/workloadIdentityPools/pool/providers/github',
      oidcAudience: 'projects/123/locations/global/workloadIdentityPools/pool/providers/github',
      serviceAccount: 'telemetry@example.iam.gserviceaccount.com',
    });
    expect(await identity.getHeaders()).toEqual({ Authorization: 'Bearer ' + 'exchanged-token' });
    identity.shutdown();
    expect(mockShutdown).toHaveBeenCalled();
  });

  it.each([
    'not-json',
    JSON.stringify({ provider: 'azure', audience: 'audience' }),
    JSON.stringify({ provider: 'gcp' }),
  ])('fails closed for invalid workload identity config: %s', (config) => {
    expect(() => createOtlpWorkloadIdentity(config)).toThrow('OTLP workload identity');
    expect(mockGcpOidcTokenProvider).not.toHaveBeenCalled();
  });

  it('fails export authorization when the exchange does not yield a token', async () => {
    mockGetToken.mockReturnValue(null);
    const identity = createOtlpWorkloadIdentity(JSON.stringify({
      provider: 'google',
      audience: 'projects/123/locations/global/workloadIdentityPools/pool/providers/github',
    }));

    await expect(identity.getHeaders()).rejects.toThrow('OTLP workload identity token is unavailable');
    identity.shutdown();
  });
});
