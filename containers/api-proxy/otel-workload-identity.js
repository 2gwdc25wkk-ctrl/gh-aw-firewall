'use strict';

const { GcpOidcTokenProvider } = require('./gcp-oidc-token-provider');

/**
 * Creates an OTLP Authorization header provider from the workflow-generated
 * workload identity configuration. The GitHub Actions runtime credentials stay
 * inside the api-proxy sidecar; only the exchanged token reaches the collector.
 *
 * @param {string} rawConfig
 * @returns {{getHeaders: () => Promise<Record<string, string>>, shutdown: () => void}|null}
 */
function createOtlpWorkloadIdentity(rawConfig) {
  if (!rawConfig) return null;

  let config;
  try {
    config = JSON.parse(rawConfig);
  } catch {
    throw new Error('OTLP workload identity configuration must be valid JSON');
  }

  if (!config || typeof config !== 'object'
    || !['gcp', 'google'].includes(config.provider)
    || typeof config.audience !== 'string' || !config.audience.trim()) {
    throw new Error('OTLP workload identity requires provider "gcp" and a non-empty audience');
  }
  if (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL || !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error('OTLP workload identity requires GitHub Actions OIDC runtime credentials');
  }

  const provider = new GcpOidcTokenProvider({
    requestUrl: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
    requestToken: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    workloadIdentityProvider: config.audience.trim(),
    oidcAudience: config.audience.trim(),
    serviceAccount: typeof config['service-account'] === 'string'
      ? config['service-account'].trim() || undefined
      : undefined,
  });
  const initialized = provider.initialize();

  return {
    async getHeaders() {
      await initialized;
      const token = provider.getToken();
      if (!token) {
        throw new Error('OTLP workload identity token is unavailable');
      }
      return { Authorization: 'Bearer ' + token };
    },
    shutdown() {
      provider.shutdown();
    },
  };
}

module.exports = { createOtlpWorkloadIdentity };
