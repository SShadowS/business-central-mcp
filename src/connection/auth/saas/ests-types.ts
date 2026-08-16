export type EstsStatus = {
  phase: 'signing-in' | 'mfa' | 'finishing' | 'done' | 'error';
  entropy?: string;
  message?: string;
};

export interface SasJson {
  Success?: boolean;
  ResultValue?: string;
  Entropy?: number | string;
  FlowToken?: string;
  Ctx?: string;
  CorrelationId?: string;
  Message?: string;
  Retry?: boolean;
}

export interface DeploymentReady {
  status: string;
  clusterAddress: string;
  runtimeId: string;
  tid: string;
}

export interface FixedEndPointAuth {
  accessToken: string;
  authorizationCode: string;
  homeAccountId: string;
  sharedAuthCookieName: string;
}

/** Desktop Chrome UA. Entra fingerprints non-browser clients. */
export const SAAS_BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const SAAS_PORTAL_ORIGIN = 'https://businesscentral.dynamics.com';
export const SAAS_PORTAL_HOST = 'businesscentral.dynamics.com';

export interface PreparedConnection {
  tabId: string;
  tabBaseUrl: string;
  clusterHost: string;
  runtimeId: string;
  csrfToken: string;
}
