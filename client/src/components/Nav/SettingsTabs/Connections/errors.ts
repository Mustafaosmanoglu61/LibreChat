import axios from 'axios';
import type { TConnectionFlowErrorCode } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';

const errorKeys: Partial<Record<TConnectionFlowErrorCode, TranslationKeys>> = {
  flow_not_found: 'com_ui_connections_error_flow_not_found',
  state_mismatch: 'com_ui_connections_error_state_mismatch',
  invalid_callback: 'com_ui_connections_error_invalid_callback',
  denied: 'com_ui_connections_error_denied',
  exchange_failed: 'com_ui_connections_error_exchange_failed',
};

/** Codes after which the started attempt is gone and the user has to begin again. */
const restartCodes = new Set<string>(['flow_not_found', 'denied', 'exchange_failed']);

function readCode(error: unknown): string | undefined {
  if (!axios.isAxiosError(error)) {
    return undefined;
  }
  const data: unknown = error.response?.data;
  const code = data != null && typeof data === 'object' && 'code' in data ? data.code : null;
  return typeof code === 'string' ? code : undefined;
}

export function getConnectionError(error: unknown): { key: TranslationKeys; restart: boolean } {
  const code = readCode(error);
  const key = (code != null && errorKeys[code as TConnectionFlowErrorCode]) || undefined;
  return {
    key: key ?? 'com_ui_connections_error_generic',
    restart: code != null && restartCodes.has(code),
  };
}
